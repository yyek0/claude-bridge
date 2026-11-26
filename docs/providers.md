# Провайдеры моделей

Модели включаются в `/etc/claude-bridge/backend.env` на VPS. Измените файл с правами администратора через `sudoedit /etc/claude-bridge/backend.env`, затем выполните `sudo systemctl restart claude-bridge`. Расширение получит список заново после восстановления связи. Значения `*_MODELS` принимают один ID или несколько через запятую.

## Anthropic Messages API

Для этого backend нужен API-ключ Claude Console. Для первого платного теста укажите ID модели, доступной вашему workspace Claude Console. Настройки хранятся только на сервере.

```dotenv
ANTHROPIC_MODELS=claude-sonnet-5-5
ANTHROPIC_API_KEY=
ANTHROPIC_BASE_URL=https://api.anthropic.com/v1
# Укажите ID workspace, если он нужен для выбранного ключа.
ANTHROPIC_WORKSPACE_ID=
```

Вставьте реальный ключ после `ANTHROPIC_API_KEY=` в серверном файле. Адрес по умолчанию и формат SSE описаны в документации. [Ключ Claude API](https://platform.claude.com/docs/en/get-api-key) · [Messages API и поток](https://platform.claude.com/docs/en/build-with-claude/streaming)

По официальным материалам Anthropic, проверенным 26 ноября 2026 года:

- Pro и Max поддерживают вход в официальный Claude Code. Anthropic описывает обычное индивидуальное использование Claude Agent SDK и `claude -p` после входа по подписке. [Claude Code и подписки](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-max-or-ultra-plan) · [Agent SDK и подписки](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- Для отдельного приложения и маршрутизации запросов пользователей Anthropic предписывает Claude Console API key или поддерживаемого облачного провайдера. Поэтому в Claude Bridge используется Messages API. Вход через claude.ai в это расширение не предусмотрен. [Правила аутентификации Claude Code](https://code.claude.com/docs/en/legal-and-compliance)
- В актуальные условия Max входят ежемесячные API-кредиты через привязанную организацию Claude Console. Их можно использовать с ключом этой организации для Claude API. Pro отсутствует в перечне планов с этими кредитами. Проверьте условия доступности и лимиты для своего аккаунта перед оплатой. [API-кредиты по подписке](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers)

## OpenAI-совместимый endpoint

```dotenv
OPENAI_MODELS=
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MAX_TOKENS_FIELD=max_completion_tokens
```

Укажите действующий model ID и ключ вашего endpoint. Требуется Chat Completions с поддержкой SSE и `tool_calls` для работы агента. Для совместимых endpoint, принимающих прежний параметр `max_tokens`, задайте `OPENAI_MAX_TOKENS_FIELD=max_tokens`. Для удалённых адресов нужен HTTPS с доверенным сертификатом. [Chat Completions](https://developers.openai.com/api/reference/resources/chat)

## Ollama

```dotenv
OLLAMA_MODELS=
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
```

Укажите установленный в Ollama ID модели с поддержкой tool calling. Адрес `127.0.0.1` здесь означает VPS. Ollama можно запустить отдельно на другом компьютере и предоставить backend доступ к его endpoint через защищённое соединение. Минимальная серверная установка подразумевает внешний провайдер или Mock. [OpenAI-совместимость Ollama](https://docs.ollama.com/api/openai-compatibility)

## MockProvider

`BRIDGE_ENABLE_MOCK=1` включает тестовую модель `mock:mock`. Для воспроизводимых проверок она принимает `/mock` с JSON-массивом инструментов. Логику реального планирования выполняет выбранная модель Anthropic, OpenAI или Ollama. Установите `BRIDGE_ENABLE_MOCK=0`, если хотите скрыть тестовую модель после настройки другого провайдера.
