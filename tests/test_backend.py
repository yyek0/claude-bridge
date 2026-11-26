import asyncio
import contextlib
import json
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch

import httpx
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosedError, InvalidStatus

from bridge.app import context_for
from bridge.providers import AnthropicProvider, Context, OllamaProvider, OpenAIProvider, ProviderError
from bridge.store import Store

ROOT = pathlib.Path(__file__).resolve().parents[1]


class Client:
    def __init__(self, connection):
        self.connection = connection

    async def send(self, kind, **fields):
        await self.connection.send(json.dumps({"type": kind, **fields}, ensure_ascii=False))

    async def until(self, kind, delta=None):
        async with asyncio.timeout(8):
            while True:
                event = json.loads(await self.connection.recv())
                if event["type"] == kind:
                    return event
                if event["type"] == "delta" and delta is not None:
                    delta.append(event["text"])
                if event["type"] == "error" and kind != "error":
                    raise AssertionError(event["message"])


class Server(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.db = pathlib.Path(self.directory.name) / "bridge.sqlite3"
        self.store = Store(self.db)
        self.first_id, self.first = self.store.add_device("owner", "first")
        _, self.second = self.store.add_device("owner", "second")
        _, self.outside = self.store.add_device("elsewhere", "outside")
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            self.port = listener.getsockname()[1]
        self.start()
        self.addCleanup(self.stop)

    def start(self):
        self.process = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "bridge.app:app", "--host", "127.0.0.1", "--port", str(self.port),
             "--ws", "websockets-sansio", "--ws-max-size", "128000", "--ws-per-message-deflate", "false", "--no-access-log"],
            cwd=ROOT / "backend", env={**os.environ, "BRIDGE_DB": str(self.db), "BRIDGE_ENABLE_MOCK": "1",
                                       "ANTHROPIC_MODELS": "", "OPENAI_MODELS": "", "OLLAMA_MODELS": ""},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(150):
            with socket.socket() as probe:
                if probe.connect_ex(("127.0.0.1", self.port)) == 0:
                    return
            if self.process.poll() is not None:
                break
            time.sleep(.02)
        self.fail("Local backend did not start")

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(3)

    def dial(self, token, **options):
        return connect(f"ws://127.0.0.1:{self.port}/ws", additional_headers={"Authorization": "Bearer " + token}, **options)

    @contextlib.asynccontextmanager
    async def session(self, token):
        async with self.dial(token) as websocket:
            client = Client(websocket)
            self.assertEqual((await client.until("ready"))["models"], ["mock:mock"])
            yield client

    async def create(self, client):
        dialog = str(uuid.uuid4())
        await client.send("create", dialog=dialog)
        self.assertEqual((await client.until("history"))["turns"], [])
        return dialog

    async def test_mock_stream_tool_history_restart_and_accounts(self):
        async with self.session(self.first) as client:
            dialog = await self.create(client)
            await client.send("prompt", dialog=dialog, text="/mock [{\"name\":\"list_directory\"}]",
                              model="mock:mock", tools=True, attachments=[{"label": "fixture", "text": "transient attachment"}])
            first_call = await client.until("tool")
            self.assertEqual(first_call["name"], "list_directory")
            await client.send("result", call="wrong_id", text="ignored", error=False)
            await client.send("result", call=first_call["call"], text="example.txt", error=False)
            deltas = []
            await client.until("done", deltas)
            self.assertGreater(len(deltas), 2)
            self.assertIn("example.txt", "".join(deltas))
        self.stop()
        self.start()
        async with self.session(self.second) as second, self.session(self.outside) as outside:
            await second.send("open", dialog=dialog)
            completed = (await second.until("history"))["turns"]
            self.assertEqual(len(completed), 1)
            self.assertNotIn("transient attachment", json.dumps(completed))
            await outside.send("open", dialog=dialog)
            await outside.until("error")
            await outside.send("create", dialog=dialog)
            await outside.until("error")

    async def test_cancel_and_revoke_active_device(self):
        async with self.session(self.first) as client:
            dialog = await self.create(client)
            await client.send("prompt", dialog=dialog, text="/mock [{\"name\":\"read_file\",\"arguments\":{\"path\":\"x\"}}]",
                              model="mock:mock", tools=True)
            await client.until("tool")
            await client.send("cancel")
            await client.until("cancelled")
            await client.send("open", dialog=dialog)
            self.assertEqual((await client.until("history"))["turns"], [])
            self.assertEqual(self.store.revoke(self.first_id), 1)
            with self.assertRaises(ConnectionClosedError) as revoked:
                async with asyncio.timeout(6):
                    await client.connection.recv()
            self.assertEqual(revoked.exception.rcvd.code, 4403)
        with self.assertRaises(InvalidStatus):
            async with self.dial(self.first):
                self.fail("Revoked credential accepted")

    async def test_handshake_validation_limits_and_tool_opt_in(self):
        for credential, options in [("invalid", {}), (self.first, {"origin": "https://example.org"})]:
            with self.assertRaises(InvalidStatus):
                async with self.dial(credential, **options):
                    self.fail("Unauthorized handshake accepted")
        async with self.session(self.first) as client:
            dialog = await self.create(client)
            await client.send("prompt", dialog=dialog, text="invalid", model="mock:mock", tools="true")
            await client.until("error")
            await client.send("prompt", dialog=dialog, text="/mock [{\"name\":\"list_directory\"}]",
                              model="mock:mock", tools=False)
            deltas = []
            await client.until("done", deltas)
            self.assertIn("Инструменты не были вызваны", "".join(deltas))
            with self.assertRaises(ConnectionClosedError) as size:
                await client.connection.send("x" * 130_000)
                async with asyncio.timeout(5):
                    while True:
                        await client.connection.recv()
            self.assertEqual(size.exception.rcvd.code, 1009)

    async def test_frame_rate_limit(self):
        async with self.session(self.first) as client:
            await client.until("dialogs")
            for _ in range(120):
                await client.send("list")
                await client.until("dialogs")
            await client.send("list")
            with self.assertRaises(ConnectionClosedError) as rate:
                await client.connection.recv()
            self.assertEqual(rate.exception.rcvd.code, 4429)


class ModelFormat(unittest.IsolatedAsyncioTestCase):
    async def run_provider(self, provider, events):
        responses = ["data: " + json.dumps(item) for item in events]
        wire = ("\n\n".join(responses) + "\n\ndata: [DONE]\n\n").encode()
        requests = []

        def handler(request):
            requests.append(request)
            return httpx.Response(200, headers={"Content-Type": "text/event-stream"}, content=wire)

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        seen = []

        async def emit(part):
            seen.append(part)

        with patch("bridge.providers.httpx.AsyncClient", return_value=client):
            result = await provider.step("fixture", Context([], "hello", "", [], True), emit)
        return result, seen, requests[0]

    async def test_anthropic_sse(self):
        step, seen, request = await self.run_provider(AnthropicProvider("https://example.invalid/v1", {}, 1024), [
            {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "hello "}},
            {"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "call_1", "name": "read_file", "input": {}}},
            {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": "{\"path\":"}},
            {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": "\"test.txt\"}"}},
            {"type": "message_delta", "delta": {"stop_reason": "tool_use"}},
            {"type": "message_stop"},
        ])
        self.assertEqual(request.url.path, "/v1/messages")
        self.assertEqual(seen, ["hello "])
        self.assertEqual(step.calls[0].arguments, {"path": "test.txt"})

    async def test_openai_and_ollama_sse(self):
        for provider, expected in [(OpenAIProvider, "max_completion_tokens"), (OllamaProvider, "max_tokens")]:
            events = [
                {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_1", "function": {"name": "read_file", "arguments": "{\"path\":"}}]}}]},
                {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": "\"test.txt\"}"}}]}, "finish_reason": "tool_calls"}]},
            ]
            step, _, request = await self.run_provider(provider("http://127.0.0.1:11434/v1", {}, 1024), events)
            self.assertEqual(request.url.path, "/v1/chat/completions")
            self.assertEqual(json.loads(request.content)[expected], 1024)
            self.assertEqual(step.calls[0].arguments, {"path": "test.txt"})

    async def test_context_budget_keeps_recent_complete_pairs(self):
        log = [{"prompt": "a" * 3000, "answer": "1"}, {"prompt": "b", "answer": "2"}]
        self.assertEqual(context_for(log, "prompt", "", [], False, 150).history, log[1:])
        with self.assertRaises(ProviderError):
            context_for([], "я" * 100, "", [], False, 150)


if __name__ == "__main__":
    unittest.main()
