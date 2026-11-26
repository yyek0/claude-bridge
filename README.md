# Claude Bridge

Локальный агент для VS Code с backend на собственном VPS. Расширение показывает потоковый чат, историю и действия агента. Оно работает с выбранной рабочей папкой, показывает правки в VS Code Diff и запрашивает подтверждение перед изменением файлов или запуском команды.

- [Руководство пользователя и значения всех значков](docs/guide.md)
- [Расширение VSIX 0.1.0](artifacts/claude-bridge-0.1.0.vsix) · [Архив backend](artifacts/claude-bridge-server-0.1.0.tar.gz)
- [Удалённый рабочий стол XFCE](docs/desktop.md) · [Провайдеры моделей](docs/providers.md) · [Архитектура](docs/architecture.md) · [Результаты тестов](docs/testing.md)

## 1. Установите backend на Ubuntu VPS

Скачайте архив backend, передайте его по SSH на VPS и распакуйте в отдельную папку. Или клонируйте весь репозиторий на VPS и выполните `sudo bash deploy/install.sh` из его корня.

```sh
mkdir -p bridge-release
tar -xzf claude-bridge-server-0.1.0.tar.gz -C bridge-release
cd bridge-release
sudo bash deploy/install.sh
curl http://127.0.0.1:18765/healthz
```

Ожидаемый ответ — `{"status":"ok","protocol":1}`. Backend слушает `127.0.0.1:18765` и настроен на запуск через systemd. Для первого подключения уже включена бесплатная тестовая модель `mock · mock`.

Выпустите токен на VPS и используйте отдельную метку для каждого устройства. Один и тот же `--account` синхронизирует историю между Mac и Windows.

```sh
sudo /opt/claude-bridge/admin add --account personal --label macOS
sudo /opt/claude-bridge/admin add --account personal --label Windows
```

## 2. Укажите адрес своего VPS на компьютере

Скопируйте [desktop/.env.example](desktop/.env.example) в `desktop/.env` и заполните три поля.

```dotenv
BRIDGE_SSH_HOST=203.0.113.10
BRIDGE_SSH_USER=ubuntu
BRIDGE_SSH_PORT=22
```

Замените пример IP на адрес или имя своего VPS. Укажите учётную запись SSH, которой можете входить на сервер. На каждом новом компьютере установите доверие к ключу хоста при первом входе. Сравните отпечаток, показанный OpenSSH, с выводом `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` в доверенной консоли VPS.

## 3. Подключите VS Code

1. В VS Code откройте **Extensions → … → Install from VSIX…** и выберите [VSIX](artifacts/claude-bridge-0.1.0.vsix).
2. Запустите SSH-туннель из корня проекта. Оставьте терминал открытым.

   | ОС | Команда в терминале |
   | --- | --- |
   | macOS | `./desktop/connect-macos.sh --chat` |
   | Windows | `.\desktop\connect-windows.ps1 -Chat` |

3. Откройте панель **Claude Bridge**, нажмите **Подключить** и вставьте значение `token` своего устройства. Адрес расширения по умолчанию — `ws://127.0.0.1:18765/ws`.
4. Выберите `mock · mock` и отправьте `Привет`. Для первого запроса с локальными инструментами следуйте [руководству пользователя](docs/guide.md).

Если PowerShell блокирует запуск скрипта, используйте команду ручного туннеля из [руководства](docs/guide.md). Для входа по SSH-ключу расширение также умеет самостоятельно запускать и восстанавливать туннель.

## Обслуживание

Серверный шаблон [.env.example](.env.example) задаёт параметры backend. Установщик копирует его в `/etc/claude-bridge/backend.env`. Ключи провайдеров добавляются в этот файл на VPS через `sudoedit`, затем нужно перезапустить сервис. Клиентские данные SSH остаются в `desktop/.env`, токены устройств — в VS Code SecretStorage.

Для обновления передайте новый архив, распакуйте его в новую папку и выполните `sudo bash deploy/update.sh`. Скрипт проверяет работоспособность нового выпуска и возвращает предыдущий, если сервис не стартует.

```sh
sudo /opt/claude-bridge/admin list
sudo /opt/claude-bridge/admin revoke ID_УСТРОЙСТВА
sudo systemctl status claude-bridge
sudo journalctl -u claude-bridge -n 50 --no-pager
```

База хранится в `/var/lib/claude-bridge`, выпуски — в `/opt/claude-bridge/releases`. Для переноса SQLite используйте online backup или скопируйте базу при остановленном сервисе.

## Разработка

Для сборки расширения нужен Node.js 22+, для backend — Python 3.11+.

```sh
npm ci --prefix extension
npm run --prefix extension package

python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
PYTHONPATH=backend .venv/bin/python -m unittest discover -s tests -v
```
