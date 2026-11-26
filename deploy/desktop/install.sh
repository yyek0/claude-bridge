#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
export LC_ALL=C
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=l

if [[ "$EUID" != 0 ]]; then
  echo "Run with sudo or as root." >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
desktop_user=bridge-desktop
desktop_group=claude-desktop-users
home_dir=/home/$desktop_user
state=/var/lib/claude-bridge-desktop
mozilla_key=/etc/apt/keyrings/claude-desktop-mozilla.asc
mozilla_source=/etc/apt/sources.list.d/claude-desktop-mozilla.sources
mozilla_pin=/etc/apt/preferences.d/claude-desktop-mozilla
cert=/etc/xrdp/claude-bridge-cert.pem
key=/etc/xrdp/claude-bridge-key.pem
browser_policy=/etc/firefox/policies/policies.json

exec 9>/run/lock/claude-bridge-desktop.lock
flock -x 9
if [[ ! -f "$state/install-owned" ]]; then
  if dpkg-query -W -f='${db:Status-Status}' xrdp 2>/dev/null | grep -qx installed ||
      getent passwd "$desktop_user" >/dev/null || getent group "$desktop_group" >/dev/null ||
      [[ -e "$home_dir" || -n "$(ss -Hltn 'sport = :3389')" ]]; then
    echo "Existing user, xrdp package or RDP listener. Review before installing." >&2
    exit 1
  fi
  free_kib="$(df -Pk / | awk 'END { print $4 }')"
  if (( free_kib < 850 * 1024 )); then
    echo "At least 850 MiB available on / is required for a fresh desktop installation." >&2
    exit 1
  fi
  for file in "$mozilla_key" "$mozilla_source" "$mozilla_pin"; do
    if [[ -e "$file" || -L "$file" ]]; then
      echo "Existing APT configuration at $file." >&2
      exit 1
    fi
  done
  install -d -m 700 "$state"
  install -m 600 /dev/null "$state/install-owned"
fi

# The package's default configuration listens publicly. Mask it until loopback is configured.
systemctl stop xrdp.service xrdp-sesman.service 2>/dev/null || true
systemctl mask xrdp.service xrdp-sesman.service
key_download="$(mktemp -d)"
trap 'rm -rf -- "$key_download"' EXIT
curl --fail --silent --show-error --location \
  https://packages.mozilla.org/apt/repo-signing-key.gpg -o "$key_download/mozilla.asc"
fingerprint="$(gpg --batch --homedir "$key_download" --with-colons --show-keys \
  "$key_download/mozilla.asc" | awk -F: '$1 == "pub" {primary=1} $1 == "sub" {primary=0} $1 == "fpr" && primary {print $10; primary=0}')"
if [[ "$fingerprint" != "35BAA0B33E9EB396F59CA838C0BA5CE6DC6315A3" ]]; then
  echo "Mozilla APT signature key fingerprint mismatch." >&2
  exit 1
fi
install -d -m 755 /etc/apt/keyrings
install -m 644 "$key_download/mozilla.asc" "$mozilla_key"
cat >"$key_download/mozilla.sources" <<SOURCE
Types: deb
URIs: https://packages.mozilla.org/apt
Suites: mozilla
Components: main
Signed-By: $mozilla_key
SOURCE
cat >"$key_download/mozilla.pin" <<'PIN'
Package: firefox-esr
Pin: origin packages.mozilla.org
Pin-Priority: 990
PIN
install -m 644 "$key_download/mozilla.sources" "$mozilla_source"
install -m 644 "$key_download/mozilla.pin" "$mozilla_pin"

apt-get -o DPkg::Lock::Timeout=90 update
apt-get -o DPkg::Lock::Timeout=90 install -y --no-install-recommends \
  xfce4-session xfce4-panel xfwm4 xfce4-settings xfdesktop4 xfce4-appfinder \
  thunar xfce4-terminal dbus-x11 xauth xorgxrdp xrdp \
  fonts-dejavu-core adwaita-icon-theme x11-utils firefox-esr
apt-get -o DPkg::Lock::Timeout=90 clean

if [[ -L "$browser_policy" ]] ||
    { [[ -e "$browser_policy" ]] && ! cmp -s "$script_dir/firefox-policies.json" "$browser_policy"; }; then
  echo "Existing Firefox policy at $browser_policy." >&2
  exit 1
fi
install -d -m 755 /etc/firefox/policies
install -m 644 "$script_dir/firefox-policies.json" "$browser_policy"

getent group "$desktop_group" >/dev/null || groupadd --system "$desktop_group"
if ! id "$desktop_user" >/dev/null 2>&1; then
  useradd --user-group --create-home --shell /usr/sbin/nologin --groups "$desktop_group" "$desktop_user"
fi
[[ "$(getent passwd "$desktop_user" | cut -d: -f6)" == "$home_dir" ]]
chmod 700 "$home_dir"
cat >"$key_download/xsession" <<'SESSION'
#!/bin/sh
export SHELL=/bin/bash
export XDG_SESSION_TYPE=x11
export XDG_CURRENT_DESKTOP=XFCE
exec startxfce4
SESSION
install -m 700 -o "$desktop_user" -g "$desktop_user" "$key_download/xsession" "$home_dir/.xsession"

if [[ ! -s "$cert" || ! -s "$key" ]]; then
  openssl req -x509 -newkey rsa:3072 -noenc -sha256 -days 825 \
    -subj /CN=127.0.0.1 -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" \
    -addext "basicConstraints=critical,CA:FALSE" -addext "extendedKeyUsage=serverAuth" \
    -keyout "$key_download/rdp.key" -out "$key_download/rdp.crt" 2>/dev/null
  install -m 644 "$key_download/rdp.crt" "$cert"
  install -m 640 -o root -g xrdp "$key_download/rdp.key" "$key"
fi
for name in xrdp.ini sesman.ini; do
  backup="$state/$name.original"
  if [[ ! -f "$backup" ]]; then
    install -m 600 "/etc/xrdp/$name" "$backup"
  fi
done
python3 "$script_dir/configure.py"
systemctl unmask xrdp-sesman.service xrdp.service
systemctl enable --now xrdp-sesman.service xrdp.service
for attempt in {1..20}; do
  listeners="$(ss -Hltn 'sport = :3389' | awk '{print $4}')"
  if [[ "$listeners" == "127.0.0.1:3389" ]]; then break; fi
  if [[ -n "$listeners" ]]; then
    systemctl stop xrdp.service
    echo "xrdp bound to an unexpected address." >&2
    exit 1
  fi
  sleep 0.5
done
[[ "$listeners" == "127.0.0.1:3389" ]]
for service in xrdp.service xrdp-sesman.service; do
  systemctl is-active --quiet "$service"
done

if ! passwd -S "$desktop_user" | awk '$2 == "P" {has_password=1} END {exit !has_password}'; then
  printf 'Set the desktop password with: sudo passwd %s\n' "$desktop_user"
fi
openssl x509 -in "$cert" -noout -fingerprint -sha256
