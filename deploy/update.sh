#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"

exec 9>/run/lock/claude-bridge-deploy.lock
flock -x 9
previous="$(readlink -f "$base/current")"
if [[ "$previous" != "$base/releases/"* || ! -d "$previous" || ! -f "$service_path" || ! -f "$config_dir/backend.env" ]]; then
  echo "Install Claude Bridge first." >&2
  exit 1
fi

release=''
switched=0
restore() {
  local status=$?
  if (( status == 0 )); then return; fi
  if (( switched )); then
    if ! point_current "$previous" || ! systemctl restart "$service" || ! ready; then
      echo "Automatic rollback failed. Inspect $service." >&2
      return
    fi
  fi
  if [[ -n "$release" && "$release" == "$base/releases/"* ]]; then
    rm -rf -- "$release"
  fi
}
trap restore EXIT

new_release
point_current "$release"
switched=1
systemctl restart "$service"
ready
# Keep the current release and one previous release to fit small VPS disks.
for entry in "$base"/releases/release-*; do
  if [[ -d "$entry" && ! -L "$entry" && "$entry" != "$release" && "$entry" != "$previous" ]]; then
    rm -rf -- "$entry"
  fi
done
printf '%s\n' "Claude Bridge updated. Previous release: $previous"
