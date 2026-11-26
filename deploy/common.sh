#!/usr/bin/env bash
set -Eeuo pipefail
umask 022

base=/opt/claude-bridge
config_dir=/etc/claude-bridge
state_dir=/var/lib/claude-bridge
service=claude-bridge.service
service_user=claude-bridge
service_path=/etc/systemd/system/$service
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"

if [[ "$EUID" != 0 ]]; then
  echo "Run with sudo or as root." >&2
  exit 1
fi
if [[ ! -f "$source_dir/backend/requirements.txt" || ! -d "$source_dir/backend/bridge" ]]; then
  echo "The deployment archive must include backend/ and deploy/." >&2
  exit 1
fi

new_release() {
  release="$(mktemp -d "$base/releases/release-XXXXXXXX")"
  chmod 755 "$release"
  install -m 644 "$source_dir/backend/requirements.txt" "$release/requirements.txt"
  install -d -m 755 "$release/bridge"
  install -m 644 "$source_dir"/backend/bridge/*.py "$release/bridge/"
  python3 -m venv "$release/.venv"
  "$release/.venv/bin/python" -m pip --disable-pip-version-check install --no-cache-dir --only-binary=:all: -r "$release/requirements.txt"
  "$release/.venv/bin/python" -m pip check
  (
    cd "$release"
    "$release/.venv/bin/python" -c 'from bridge.app import app; assert app is not None'
  )
}

point_current() {
  if [[ -e "$base/.next" || -L "$base/.next" ]]; then
    echo "Unexpected deployment link: $base/.next" >&2
    return 1
  fi
  ln -s "$1" "$base/.next"
  mv -Tf "$base/.next" "$base/current"
}

ready() {
  local attempt
  for attempt in {1..25}; do
    if systemctl is-active --quiet "$service" &&
        curl --silent --fail --max-time 1 --noproxy '*' http://127.0.0.1:18765/healthz |
          "$base/current/.venv/bin/python" -c 'import json,sys; assert json.load(sys.stdin) == {"status":"ok","protocol":1}' 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  journalctl -u "$service" -n 20 --no-pager >&2
  return 1
}
