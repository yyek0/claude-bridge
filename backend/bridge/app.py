import asyncio
import contextlib
import json
import logging
import os
import sqlite3
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from typing import Annotated, Literal
from uuid import UUID, uuid4

import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, TypeAdapter, ValidationError

from .providers import Context, ProviderError, Result, configured
from .store import Store, default_path
from .tools import TOOLS

MAX_FRAME = 128_000
MAX_TOOL_OUTPUT = 16_000
LOG = logging.getLogger("bridge")


class Message(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


Identifier = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$")]


class ListDialogs(Message):
    type: Literal["list"]


class DialogRequest(Message):
    type: Literal["create", "open"]
    dialog: Identifier


class Attachment(Message):
    label: str = Field(min_length=1, max_length=300)
    text: str = Field(max_length=16_000)


class Prompt(Message):
    type: Literal["prompt"]
    dialog: Identifier
    text: str = Field(min_length=1, max_length=12_000)
    model: str = Field(min_length=1, max_length=144)
    tools: bool = False
    attachments: list[Attachment] = Field(default_factory=list, max_length=8)


class Cancel(Message):
    type: Literal["cancel"]


class ToolResult(Message):
    type: Literal["result"]
    call: str = Field(min_length=1, max_length=128)
    text: str = Field(max_length=MAX_TOOL_OUTPUT)
    error: bool


Protocol = TypeAdapter(Annotated[ListDialogs | DialogRequest | Prompt | Cancel | ToolResult, Field(discriminator="type")])


def byte_count(value):
    return len(value.encode("utf-8", errors="replace"))


def valid_call(call):
    if call.name not in TOOLS:
        return False
    _, fields, required = TOOLS[call.name]
    if set(call.arguments) - set(fields) or not set(required).issubset(call.arguments):
        return False
    expected = {"string": str, "integer": int, "boolean": bool}
    for name, value in call.arguments.items():
        field = fields[name]
        if type(value) is not expected[field["type"]] or (type(value) is int and not 1 <= value <= 1_000_000):
            return False
    return len(json.dumps(call.arguments, ensure_ascii=True)) <= 110_000


def context_for(history, prompt, attachments, steps, tools, budget):
    kept = []
    spent = byte_count(prompt) + byte_count(attachments)
    for step, results in steps:
        spent += byte_count(step.text)
        spent += sum(byte_count(json.dumps(call.arguments, ensure_ascii=False)) + 100 for call in step.calls)
        spent += sum(byte_count(result.text) + 100 for result in results)
    if spent > budget:
        raise ProviderError("Контекст заполнен. Сократите вложения или разделите задачу на несколько запросов.")
    for turn in reversed(history):
        spent += byte_count(turn["prompt"]) + byte_count(turn["answer"]) + 50
        if spent > budget:
            break
        kept.append(turn)
    return Context(list(reversed(kept)), prompt, attachments, steps, tools)


class Runtime:
    def __init__(self):
        self.store = Store(default_path())
        self.models = configured()
        self.budget = int(os.getenv("BRIDGE_CONTEXT_BYTES", "56000"))
        if not 4_000 <= self.budget <= 300_000 or not self.models:
            raise ValueError("Invalid context budget or no enabled models")
        self.connections = defaultdict(set)
        self.rate = {}
        self.busy = set()
        self.sockets = 0

    def allow(self, identity, category, limit, window):
        now = time.monotonic()
        if len(self.rate) > 512:
            self.rate = {key: queue for key, queue in self.rate.items() if queue and now - queue[-1] < 60}
        key = (identity, category)
        if len(self.rate) >= 1024 and key not in self.rate:
            return False
        queue = self.rate.setdefault(key, deque())
        while queue and now - queue[0] >= window:
            queue.popleft()
        if len(queue) >= limit:
            return False
        queue.append(now)
        return True

    async def changed(self, account):
        for connection in tuple(self.connections.get(account, ())):
            if not self.store.active(connection.device):
                continue
            with contextlib.suppress(RuntimeError, WebSocketDisconnect, TimeoutError):
                await connection.send("changed")


@asynccontextmanager
async def lifespan(app):
    os.umask(0o077)
    app.state.runtime = Runtime()
    yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/healthz")
async def health():
    return {"status": "ok", "protocol": 1}


class Connection:
    def __init__(self, ws, runtime, device):
        self.ws = ws
        self.runtime = runtime
        self.store = runtime.store
        self.account = device["account"]
        self.device = device["id"]
        self.turn = None
        self.turn_dialog = None
        self.pending = None
        self.lock = asyncio.Lock()

    async def send(self, event, **fields):
        async with asyncio.timeout(5):
            async with self.lock:
                await self.ws.send_json({"type": event, **fields})

    async def denied(self, message, dialog=None):
        await self.send("error", message=message, dialog=dialog)

    async def watchdog(self):
        try:
            while True:
                await asyncio.sleep(3)
                if not self.store.active(self.device):
                    if self.turn:
                        self.turn.cancel()
                    async with self.lock:
                        await self.ws.close(4403)
                    return
        except (RuntimeError, WebSocketDisconnect):
            return

    async def handle(self, message):
        if isinstance(message, ListDialogs):
            await self.send("dialogs", dialogs=self.store.dialogs(self.account))
        elif isinstance(message, DialogRequest):
            dialog = str(UUID(message.dialog))
            if message.type == "create":
                if not self.store.create(self.account, dialog):
                    await self.denied("Диалог недоступен или достигнут лимит диалогов.")
                    return
            history = self.store.history(self.account, dialog)
            if history is None:
                await self.denied("Диалог недоступен.")
                return
            # Keep the recent history payload below 1 MB for clients.
            recent = []
            size = 0
            for turn in reversed(history):
                size += byte_count(json.dumps(turn, ensure_ascii=False))
                if size > 700_000:
                    break
                recent.append(turn)
            await self.send("history", dialog=dialog, turns=list(reversed(recent)))
            if message.type == "create":
                await self.runtime.changed(self.account)
        elif isinstance(message, Cancel):
            if self.turn and not self.turn.done() and not self.turn.cancelling():
                self.turn.cancel()
                await asyncio.gather(self.turn, return_exceptions=True)
                await self.send("cancelled", dialog=self.turn_dialog)
        elif isinstance(message, ToolResult):
            if self.pending and self.pending[0] == message.call and not self.pending[1].done():
                self.pending[1].set_result(message)
        elif isinstance(message, Prompt):
            if self.turn and not self.turn.done():
                await self.denied("Запрос уже выполняется.", message.dialog)
            elif message.dialog in self.runtime.busy or len(self.runtime.busy) >= 12:
                await self.denied("Диалог занят или сервер перегружен.", message.dialog)
            elif not self.runtime.allow(self.device, "prompt", 12, 60):
                await self.denied("Слишком много запросов. Повторите через минуту.", message.dialog)
            elif message.model not in self.runtime.models or not message.text.strip():
                await self.denied("Пустой запрос или недоступная модель.", message.dialog)
            else:
                self.runtime.busy.add(message.dialog)
                self.turn_dialog = message.dialog
                self.turn = asyncio.create_task(self.run_turn(message))
                self.turn.add_done_callback(lambda task: self.finish_task(task, message.dialog))

    def finish_task(self, task, dialog):
        self.runtime.busy.discard(dialog)
        if not task.cancelled() and task.exception():
            LOG.warning("Turn transport error (%s)", type(task.exception()).__name__)

    async def use_tool(self, dialog, call):
        if not self.store.active(self.device):
            raise ProviderError("Доступ устройства отозван.")
        if not valid_call(call):
            return Result(call, "Invalid tool name or arguments.", True)
        future = asyncio.get_running_loop().create_future()
        request_id = uuid4().hex
        self.pending = (request_id, future)
        try:
            await self.send("tool", dialog=dialog, call=request_id, name=call.name, arguments=call.arguments)
            result = await asyncio.wait_for(future, timeout=180)
            # Treat success and failure payloads as untrusted data, even if they resemble protocol messages.
            content = json.dumps({"untrusted_local_output": result.text[:6000], "error": result.error}, ensure_ascii=False)
            return Result(call, content, result.error)
        except TimeoutError:
            await self.send("tool_end", dialog=dialog, call=request_id)
            return Result(call, "The local tool timed out.", True)
        finally:
            self.pending = None

    async def run_turn(self, message):
        dialog = message.dialog
        try:
            history = self.store.history(self.account, dialog, limit=20)
            if history is None:
                raise ProviderError("Диалог недоступен.")
            attachments = json.dumps([item.model_dump() for item in message.attachments], ensure_ascii=False) if message.attachments else ""
            provider, model = self.runtime.models[message.model]
            steps = []
            answer = []
            total = 0
            call_count = 0

            async def emit(fragment):
                nonlocal total
                total += len(fragment)
                if total > 48_000:
                    raise ProviderError("Ответ превышает лимит.")
                await self.send("delta", dialog=dialog, text=fragment)

            await self.send("started", dialog=dialog)
            async with asyncio.timeout(600):
                for _ in range(9):
                    context = context_for(history, message.text, attachments, steps, message.tools, self.runtime.budget)
                    step = await provider.step(model, context, emit)
                    answer.append(step.text)
                    if not step.calls:
                        break
                    if not message.tools or call_count + len(step.calls) > 8:
                        raise ProviderError("Инструменты отключены или достигнут лимит вызовов.")
                    if len({call.id for call in step.calls}) != len(step.calls):
                        raise ProviderError("Дублирующиеся ID вызовов.")
                    call_count += len(step.calls)
                    if step.text:
                        await emit("\n\n")
                        answer.append("\n\n")
                    results = [await self.use_tool(dialog, call) for call in step.calls]
                    steps.append((step, results))
                else:
                    raise ProviderError("Достигнут лимит шагов агента.")
            if not self.store.append(self.account, self.device, dialog, message.text, "".join(answer)):
                raise ProviderError("Сессия больше недоступна.")
            await self.send("done", dialog=dialog)
            await self.runtime.changed(self.account)
        except ProviderError as exc:
            await self.denied(str(exc), dialog)
        except sqlite3.Error as exc:
            LOG.warning("History storage failed (%s)", type(exc).__name__)
            await self.denied("Не удалось сохранить диалог. Проверьте размер и доступность базы данных.", dialog)
        except (httpx.HTTPError, TimeoutError, ValueError, TypeError, KeyError, IndexError, RecursionError) as exc:
            LOG.warning("Provider request failed (%s)", type(exc).__name__)
            await self.denied("Запрос к модели прерван или истёк тайм-аут.", dialog)

    async def run(self):
        watcher = asyncio.create_task(self.watchdog())
        self.runtime.connections[self.account].add(self)
        try:
            await self.send("ready", protocol=1, models=list(self.runtime.models), device=self.device)
            await self.handle(ListDialogs(type="list"))
            while True:
                packet = await self.ws.receive()
                if packet["type"] == "websocket.disconnect":
                    return
                raw = packet.get("text")
                if not raw or byte_count(raw) > MAX_FRAME:
                    await self.ws.close(1009)
                    return
                if not self.store.active(self.device):
                    await self.ws.close(4403)
                    return
                if not self.runtime.allow(self.device, "frame", 120, 20):
                    await self.ws.close(4429)
                    return
                try:
                    message = Protocol.validate_json(raw)
                except ValidationError:
                    await self.denied("Некорректное сообщение.")
                    continue
                await self.handle(message)
        finally:
            group = self.runtime.connections[self.account]
            group.discard(self)
            if not group:
                self.runtime.connections.pop(self.account, None)
            watcher.cancel()
            if self.turn:
                if not self.turn.cancelling():
                    self.turn.cancel()
                await asyncio.gather(self.turn, return_exceptions=True)
            await asyncio.gather(watcher, return_exceptions=True)


@app.websocket("/ws")
async def websocket(ws: WebSocket):
    runtime = ws.app.state.runtime
    # Extension host clients do not send an Origin. Disallow browser socket handshakes.
    address = ws.client.host if ws.client else "local"
    if ws.headers.get("origin") or runtime.sockets >= 32 or not runtime.allow(address, "handshake", 120, 60):
        await ws.close()
        return
    device = runtime.store.authenticate(ws.headers.get("authorization", ""))
    if not device:
        await ws.close()
        return
    await ws.accept()
    runtime.sockets += 1
    try:
        await Connection(ws, runtime, device).run()
    except (RuntimeError, WebSocketDisconnect, TimeoutError):
        pass
    finally:
        runtime.sockets -= 1
