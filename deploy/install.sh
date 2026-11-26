#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"

exec 9>/run/lock/claude-bridge-deploy.lock
flock -x 9
for destination in "$base" "$config_dir" "$state_dir" "$service_path"; do
  if [[ -e "$destination" || -L "$destination" ]]; then
    echo "$destination already exists. Use deploy/update.sh for an existing installation." >&2
    exit 1
  fi
done
if [[ -n "$(ss -ltnH 'sport = :18765')" ]]; then
  echo "TCP port 18765 is occupied." >&2
  exit 1
fi
if getent passwd "$service_user" >/dev/null || getent group "$service_user" >/dev/null; then
  echo "Service account already exists. Review the existing installation." >&2
  exit 1
fi

if ! dpkg-query -W -f='${db:Status-Status}\n' python3-venv curl ca-certificates 2>/dev/null | awk '$0=="installed"{n++} END{exit n!=3}'; then
  apt-get update
  apt-get install --no-install-recommends -y python3-venv curl ca-certificates
fi

release=''
created_account=0
created_unit=0
cleanup() {
  local status=$?
  if (( status != 0 )); then
    if (( created_unit )); then
      systemctl disable --now "$service" || true
      rm -f -- "$service_path"
      systemctl daemon-reload || true
    fi
    if (( created_account )); then
      userdel "$service_user" || true
      if getent group "$service_user" >/dev/null; then
        groupdel "$service_user" || true
      fi
    fi
    rm -rf -- "$base" "$config_dir" "$state_dir"
  fi
}
trap cleanup EXIT

install -d -m 755 "$base" "$base/releases"
install -d -m 700 "$config_dir"
install -m 600 "$source_dir/.env.example" "$config_dir/backend.env"
install -m 755 "$source_dir/deploy/admin.sh" "$base/admin"
new_release
point_current "$release"
useradd --system --user-group --home-dir "$state_dir" --shell /usr/sbin/nologin "$service_user"
created_account=1
install -d -m 700 -o "$service_user" -g "$service_user" "$state_dir"
install -m 644 "$source_dir/deploy/$service" "$service_path"
created_unit=1
systemctl daemon-reload
systemctl enable --now "$service"
ready
printf '%s\n' "Claude Bridge is listening on 127.0.0.1:18765."
