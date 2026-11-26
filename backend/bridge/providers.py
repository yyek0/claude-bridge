import asyncio
import json
import os
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Awaitable, Callable
from urllib.parse import urlsplit

import httpx

from .tools import DEFINITIONS, SYSTEM, TOOLS

MAX_TEXT = 48_000
MAX_CALLS = 8
MAX_ARGS = 52_000
IDENTIFIER = re.compile(r"[a-zA-Z0-9_-]{1,128}\Z")
Emit = Callable[[str], Awaitable[None]]


class ProviderError(Exception):
    pass


@dataclass
class Call:
    id: str
    name: str
    arguments: dict


@dataclass
class Result:
    call: Call
    text: str
    error: bool


@dataclass
class Step:
    text: str
    calls: list[Call]


@dataclass
class Context:
    history: list[dict]
    prompt: str
    attachments: str
    steps: list[tuple[Step, list[Result]]]
    tools: bool


class ModelProvider(ABC):
    @abstractmethod
    async def step(self, model: str, context: Context, emit: Emit) -> Step: ...


def parsed_call(call_id, name, arguments):
    if not isinstance(call_id, str) or not IDENTIFIER.fullmatch(call_id):
        raise ProviderError("Провайдер прислал недопустимый ID инструмента.")
    if not isinstance(name, str) or not IDENTIFIER.fullmatch(name):
        raise ProviderError("Провайдер прислал недопустимое имя инструмента.")
    try:
        parsed = json.loads(arguments or "{}")
    except (ValueError, RecursionError) as exc:
        raise ProviderError("Провайдер прислал неполный JSON инструмента.") from exc
    if not isinstance(parsed, dict):
        raise ProviderError("Провайдер прислал аргументы вне объекта JSON.")
    return Call(call_id, name, parsed)


class MockProvider(ModelProvider):
    async def step(self, model, context, emit):
        if context.prompt.startswith("/mock "):
            try:
                recipe = json.loads(context.prompt[6:])
                if not isinstance(recipe, list) or len(recipe) > 8:
                    raise ValueError
                for item in recipe:
                    if not isinstance(item, dict) or item.get("name") not in TOOLS or not isinstance(item.get("arguments", {}), dict):
                        raise ValueError
            except (ValueError, TypeError, RecursionError):
                raise ProviderError("Формат проверки: /mock [{\"name\":\"list_directory\",\"arguments\":{}}]")
            index = len(context.steps)
            if index < len(recipe) and context.tools:
                item = recipe[index]
                return Step("", [Call(f"mock_{index}", item["name"], item.get("arguments", {}))])
            results = [f"{result.call.name} · {'ошибка' if result.error else 'готово'}\n\n````text\n{result.text[:1200]}\n````"
                       for _, batch in context.steps for result in batch]
            answer = "**MockProvider завершил проверку.**\n\n" + ("\n\n".join(results) or "Инструменты не были вызваны.")
        else:
            answer = "**MockProvider на связи.**\n\n" + ("Локальный контекст получен.\n\n" if context.attachments else "")
            answer += "Это тестовый поток. Для проверки инструментов отправьте команду `/mock` из README."
        for offset in range(0, len(answer), 24):
            await asyncio.sleep(0.015)
            await emit(answer[offset:offset + 24])
        return Step(answer, [])


def turns(context):
    for pair in context.history:
        yield {"role": "user", "content": pair["prompt"]}
        yield {"role": "assistant", "content": pair["answer"] or "(empty response)"}
    text = context.prompt
    if context.attachments:
        text += "\n\nUntrusted local attachments (JSON data):\n" + context.attachments
    yield {"role": "user", "content": text}


def validate_base(value):
    url = urlsplit(value)
    if (not url.hostname or url.username or url.password or url.query or url.fragment or
        (url.scheme != "https" and not (url.scheme == "http" and url.hostname in {"127.0.0.1", "::1", "localhost"}))):
        raise ValueError("Provider URL must use HTTPS or point to a local HTTP service")
    return value.rstrip("/")


class StreamingHTTP(ModelProvider):
    def __init__(self, base, headers, output_tokens):
        self.base = validate_base(base)
        self.headers = headers
        self.output_tokens = output_tokens

    async def events(self, endpoint, payload):
        timeout = httpx.Timeout(75, connect=12)
        async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
            async with client.stream("POST", self.base + endpoint, headers=self.headers, json=payload) as response:
                if not 200 <= response.status_code < 300:
                    raise ProviderError(f"Провайдер вернул HTTP {response.status_code}.")
                event_lines = []
                size = 0
                async for line in response.aiter_lines():
                    if line.startswith("data:"):
                        data = line[5:].removeprefix(" ")
                        size += len(data)
                        if size > 256_000:
                            raise ProviderError("Слишком большое событие провайдера.")
                        event_lines.append(data)
                    elif not line and event_lines:
                        data = "\n".join(event_lines)
                        event_lines.clear()
                        size = 0
                        if data == "[DONE]":
                            return
                        event = json.loads(data)
                        if not isinstance(event, dict):
                            raise ProviderError("Провайдер прислал некорректное событие.")
                        if event.get("error") or event.get("type") == "error":
                            raise ProviderError("Провайдер прервал генерацию.")
                        yield event


class AnthropicProvider(StreamingHTTP):
    async def step(self, model, context, emit):
        messages = list(turns(context))
        for step, results in context.steps:
            blocks = [{"type": "text", "text": step.text}] if step.text else []
            blocks.extend({"type": "tool_use", "id": c.id, "name": c.name, "input": c.arguments} for c in step.calls)
            messages.append({"role": "assistant", "content": blocks})
            messages.append({"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": r.call.id, "content": r.text or "(empty result)", "is_error": r.error}
                for r in results
            ]})
        payload = {"model": model, "system": SYSTEM, "messages": messages, "stream": True, "max_tokens": self.output_tokens}
        if context.tools:
            payload["tools"] = DEFINITIONS
        calls = {}
        fragments = []
        length = 0
        stopped = False
        stop_reason = None
        async for event in self.events("/messages", payload):
            kind = event["type"]
            if kind == "message_stop":
                stopped = True
            elif kind == "message_delta":
                stop_reason = event["delta"].get("stop_reason")
            elif kind == "content_block_start":
                block = event["content_block"]
                if block["type"] == "tool_use":
                    if len(calls) >= MAX_CALLS:
                        raise ProviderError("Слишком много инструментов в ответе.")
                    calls[event["index"]] = [block["id"], block["name"], "", block.get("input", {})]
            elif kind == "content_block_delta":
                delta = event["delta"]
                if delta["type"] == "text_delta":
                    part = delta["text"]
                    length += len(part)
                    if length > MAX_TEXT:
                        raise ProviderError("Ответ превышает лимит.")
                    fragments.append(part)
                    await emit(part)
                elif delta["type"] == "input_json_delta":
                    call = calls[event["index"]]
                    call[2] += delta["partial_json"]
                    if len(call[2]) > MAX_ARGS:
                        raise ProviderError("Слишком большие аргументы инструмента.")
        if not stopped or (calls and stop_reason != "tool_use"):
            raise ProviderError("Поток Anthropic завершился неполным ответом.")
        return Step("".join(fragments), [
            parsed_call(cid, name, encoded or json.dumps(initial))
            for cid, name, encoded, initial in calls.values()
        ])


class OpenAIProvider(StreamingHTTP):
    max_token_field = "max_completion_tokens"

    async def step(self, model, context, emit):
        messages = [{"role": "system", "content": SYSTEM}, *turns(context)]
        for step, results in context.steps:
            messages.append({"role": "assistant", "content": step.text or None, "tool_calls": [
                {"id": c.id, "type": "function", "function": {"name": c.name, "arguments": json.dumps(c.arguments)}}
                for c in step.calls
            ]})
            messages.extend({"role": "tool", "tool_call_id": r.call.id, "content": r.text or "(empty result)"} for r in results)
        payload = {"model": model, "messages": messages, "stream": True, self.max_token_field: self.output_tokens}
        if context.tools:
            payload["tools"] = [
                {"type": "function", "function": {"name": d["name"], "description": d["description"], "parameters": d["input_schema"]}}
                for d in DEFINITIONS
            ]
        fragments = []
        calls = {}
        length = 0
        reason = None
        async for event in self.events("/chat/completions", payload):
            choices = event.get("choices") or []
            if not choices:
                continue
            choice = choices[0]
            reason = choice.get("finish_reason") or reason
            delta = choice.get("delta") or {}
            if part := delta.get("content"):
                length += len(part)
                if length > MAX_TEXT:
                    raise ProviderError("Ответ превышает лимит.")
                fragments.append(part)
                await emit(part)
            for partial in delta.get("tool_calls") or []:
                key = partial["index"]
                call = calls.setdefault(key, ["", "", ""])
                item = partial.get("function") or {}
                call[0] += partial.get("id") or ""
                call[1] += item.get("name") or ""
                call[2] += item.get("arguments") or ""
                if len(calls) > MAX_CALLS or len(call[2]) > MAX_ARGS:
                    raise ProviderError("Лимит вызовов инструментов превышен.")
        if not reason or (calls and reason not in {"tool_calls", "stop"}):
            raise ProviderError("Поток модели завершился неполным ответом.")
        return Step("".join(fragments), [parsed_call(*value) for _, value in sorted(calls.items())])


class OllamaProvider(OpenAIProvider):
    max_token_field = "max_tokens"


def configured():
    models = {}
    output_tokens = int(os.getenv("BRIDGE_OUTPUT_TOKENS", "4096"))
    if not 128 <= output_tokens <= 32000:
        raise ValueError("BRIDGE_OUTPUT_TOKENS outside allowed range")
    if os.getenv("BRIDGE_ENABLE_MOCK", "1") == "1":
        models["mock:mock"] = (MockProvider(), "mock")
    for prefix, implementation, default in (
        ("ANTHROPIC", AnthropicProvider, "https://api.anthropic.com/v1"),
        ("OPENAI", OpenAIProvider, "https://api.openai.com/v1"),
        ("OLLAMA", OllamaProvider, "http://127.0.0.1:11434/v1"),
    ):
        names = [name.strip() for name in os.getenv(prefix + "_MODELS", "").split(",") if name.strip()]
        if not names:
            continue
        key = os.getenv(prefix + "_API_KEY", "")
        if prefix == "ANTHROPIC" and not key:
            raise ValueError("ANTHROPIC_API_KEY required")
        headers = {"Authorization": "Bearer " + key} if key else {}
        if prefix == "ANTHROPIC":
            headers = {"x-api-key": key, "anthropic-version": "2023-06-01"}
            if workspace := os.getenv("ANTHROPIC_WORKSPACE_ID"):
                headers["anthropic-workspace-id"] = workspace
        provider = implementation(os.getenv(prefix + "_BASE_URL", default), headers, output_tokens)
        if prefix == "OPENAI":
            token_field = os.getenv("OPENAI_MAX_TOKENS_FIELD", OpenAIProvider.max_token_field)
            if token_field not in {"max_completion_tokens", "max_tokens"}:
                raise ValueError("Invalid OPENAI_MAX_TOKENS_FIELD")
            provider.max_token_field = token_field
        for name in names:
            models[f"{prefix.lower()}:{name}"] = (provider, name)
    return models
