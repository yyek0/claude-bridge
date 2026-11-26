# Рабочий стол Ubuntu VPS

На VPS доступен рабочий стол XFCE с Firefox ESR. Подключение идёт от клиента RDP к локальному порту 13389, затем по SSH к xRDP на внутреннем порту 3389.

| Параметр | Значение |
| --- | --- |
| SSH | Хост, логин и порт из `desktop/.env` |
| Адрес в RDP-клиенте | `127.0.0.1:13389` |
| Пользователь рабочего стола | `bridge-desktop` |
| Тип сессии | Xorg, 32 бита |

Скопируйте `desktop/.env.example` в `desktop/.env` и укажите свой VPS. Для нового компьютера сначала проверьте ключ хоста SSH по отпечатку из консоли VPS, затем выполните первый вход по SSH. Пароль xRDP задаётся на VPS командой `sudo passwd bridge-desktop`. Для туннеля используется отдельная учётная запись SSH.

## macOS

В Terminal из папки проекта выполните:

```sh
./desktop/connect-macos.sh
```

Скрипт откроет SSH-туннель, попросит пароль xRDP получит публичный сертификат xRDP по уже проверенному SSH-туннелю и запустит FreeRDP с проверкой его отпечатка. Если вход по SSH выполняется по паролю, его запрос появится первым. Для Mac с Homebrew команда установки — `brew install freerdp`. [FreeRDP для macOS](https://github.com/FreeRDP/FreeRDP/wiki/PreBuilds)

Если предпочитаете Microsoft Windows App, запустите `./desktop/connect-macos.sh --tunnel-only` и оставьте Terminal открытым. В Windows App добавьте PC `127.0.0.1:13389` без шлюза, оставьте запрос учётных данных при подключении и отключите все перенаправления во вкладке **Devices & Audio**. Войдите как `bridge-desktop`. [Подключение к Remote PC в Windows App](https://learn.microsoft.com/en-us/windows-app/get-started-connect-devices-desktops-apps?pivots=remote-pc&tabs=macos-pc)

## Windows

Из PowerShell в папке проекта выполните:

```powershell
.\desktop\connect-windows.ps1
```

Введите пароль SSH в открывшемся окне. Скрипт дождётся, пока OpenSSH займёт локальный порт, затем запустит стандартный `mstsc.exe` с [профилем подключения](../desktop/Claude-Bridge-Desktop.rdp). В окне xRDP выберите **Xorg** и войдите как `bridge-desktop`. Оставьте окно SSH открытым. [Remote Desktop Connection](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/mstsc)

Если политика PowerShell блокирует скрипт, подставьте адрес, имя пользователя и порт из `desktop/.env` в команду SSH ниже и откройте файл `desktop\Claude-Bridge-Desktop.rdp` двойным щелчком:

```powershell
ssh -N -T -p 22 -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=20 -o ServerAliveCountMax=3 -L 127.0.0.1:13389:127.0.0.1:3389 ubuntu@203.0.113.10
```

Windows App и `mstsc` могут показать предупреждение о самоподписанном сертификате. Откройте сведения о сертификате и сравните показанный отпечаток с выводом команды на VPS. При несовпадении прекратите подключение.

```sh
openssl x509 -in /etc/xrdp/claude-bridge-cert.pem -noout -fingerprint -sha256
openssl x509 -in /etc/xrdp/claude-bridge-cert.pem -noout -fingerprint -sha1
```

## Переход между компьютерами

Закройте окно RDP на первом компьютере без выхода из XFCE. Подключитесь с другого компьютера тем же пользователем. Сохраните режим 32 бита из файла `.rdp`, так как xRDP этой версии учитывает глубину цвета при выборе существующей сессии. Настройка рассчитана на одного пользователя и одну сессию.

Профиль Firefox ESR хранится в `/home/bridge-desktop/.config/mozilla/firefox`. При обычном отключении приложения продолжают работать. При перезапуске VPS открытые процессы завершаются, а профиль Firefox сохраняется. Запустите Firefox из меню XFCE, чтобы продолжить работу с тем же профилем.

xRDP слушает только `127.0.0.1:3389`. Его sesman использует локальный Unix-сокет. Все каналы перенаправления отключены на сервере, включая диски, принтеры, камеру, звук, микрофон и буфер обмена. Профиль клиента также отключает соответствующие функции. [Параметры клиентского профиля RDP](https://learn.microsoft.com/en-us/azure/virtual-desktop/rdp-properties)

## Обслуживание

Исходники установщика находятся в [deploy/desktop](../deploy/desktop/). Для нового сервера скопируйте всю папку и запустите `sudo bash install.sh` в ней. Установщик проверяет наличие старой установки xRDP, а для новой блокирует запуск пакета до настройки loopback. После установки задайте пароль через `sudo passwd bridge-desktop`. Для Windows App и mstsc сравните отпечаток сертификата именно вашего VPS.

```sh
sudo systemctl status xrdp xrdp-sesman
sudo journalctl -u xrdp -u xrdp-sesman -n 60 --no-pager
sudo ss -ltn 'sport = :3389'
sudo passwd bridge-desktop
sudo apt-get update
sudo apt-get install --only-upgrade firefox-esr
```

Firefox ESR получен из подписанного APT-репозитория Mozilla. Дисковый кэш Firefox ограничен 64 МиБ. Профиль и загрузки хранятся на том же диске VPS. [Установка Firefox из репозитория Mozilla](https://support.mozilla.org/en-US/kb/manually-install-firefox-linux)

## Результаты проверок

Проверено 26 ноября 2026 года на Ubuntu 26.04.1 LTS x86_64. На VPS 1 vCPU, 3,8 ГиБ оперативной памяти, диск 9,8 ГиБ. Установлены XFCE 4.20.4, xRDP 0.10.1, xorgxrdp 0.10.2 и Firefox ESR 153.8.0.

| Проверка | Результат |
| --- | --- |
| Запуск скрипта на macOS ARM64 и вход через SSH-туннель | FreeRDP подключился к рабочему столу с закреплённым сертификатом. В журнале сервера TLS 1.3 |
| Переподключение | Второе подключение с другим разрешением экрана вернулось в тот же процесс XFCE и на дисплей `:10` |
| Перенаправление | Тестовый клиент запросил буфер обмена и тестовую папку. Сервер согласовал ноль каналов |
| Публичный доступ | На сервере единственный TCP-слушатель RDP — `127.0.0.1:3389`. Проверка публичного IPv4 на порту 3389 не подключилась |
| Перезагрузка VPS | Boot ID сменился. xRDP, sesman, Claude Bridge, SSH, Docker и tgbot запустились. Контейнер Nginx Proxy Manager поднялся. Claude Bridge ответил через туннель |
| Firefox после перезагрузки | Firefox открыл тот же профиль и прочитал тестовое значение сайта, записанное до перезагрузки |

Клиент Windows и переход именно с macOS на Windows не запускались. Переподключение проверено двумя отдельными подключениями с Mac на одной глубине цвета. После запуска Firefox свободно около 600 МиБ диска. На этом VPS стоит держать немного вкладок и следить за объёмом загрузок. Живые процессы XFCE завершаются при перезагрузке VPS.
