#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

desktop_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
settings="$desktop_dir/.env"
if [[ ! -f "$settings" ]]; then
  printf '%s\n' 'Copy desktop/.env.example to desktop/.env and set your VPS address.' >&2
  exit 1
fi

ssh_host=''
ssh_user=''
ssh_port=22
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%$'\r'}"
  case "$line" in
    ''|'#'*) ;;
    BRIDGE_SSH_HOST=*) ssh_host="${line#*=}" ;;
    BRIDGE_SSH_USER=*) ssh_user="${line#*=}" ;;
    BRIDGE_SSH_PORT=*) ssh_port="${line#*=}" ;;
    *) printf '%s\n' 'Unexpected entry in desktop/.env.' >&2; exit 1 ;;
  esac
done < "$settings"
host_pattern='^[a-zA-Z0-9][a-zA-Z0-9.-]*$|^[0-9a-fA-F]*:[0-9a-fA-F:]+$'
if [[ ! "$ssh_host" =~ $host_pattern || "$ssh_host" == '203.0.113.10' ||
    ! "$ssh_user" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$ || ! "$ssh_port" =~ ^[0-9]{1,5}$ ]] ||
    (( 10#$ssh_port < 1 || 10#$ssh_port > 65535 )); then
  printf '%s\n' 'Set BRIDGE_SSH_HOST, BRIDGE_SSH_USER and a valid BRIDGE_SSH_PORT in desktop/.env.' >&2
  exit 1
fi

server="$ssh_user@$ssh_host"
ssh_options=(-T -p "$ssh_port" -o StrictHostKeyChecking=yes -o UpdateHostKeys=no
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=20 -o ServerAliveCountMax=3)
rdp_forward=(-L 127.0.0.1:13389:127.0.0.1:3389)

case "${1:-}" in
  --chat)
    printf '%s\n' 'Keep this terminal open while using Claude Bridge in VS Code.'
    exec /usr/bin/ssh -N "${ssh_options[@]}" -L 127.0.0.1:18765:127.0.0.1:18765 "$server"
    ;;
  --tunnel-only)
    printf '%s\n' 'Open Claude-Bridge-Desktop.rdp after the SSH tunnel starts.'
    exec /usr/bin/ssh -N "${ssh_options[@]}" "${rdp_forward[@]}" "$server"
    ;;
  '') ;;
  *)
    printf 'Usage: %s [--chat | --tunnel-only]\n' "$0" >&2
    exit 2
    ;;
esac

if ! command -v sdl-freerdp >/dev/null 2>&1; then
  printf '%s\n' 'Install FreeRDP with brew install freerdp, or use --tunnel-only with Windows App.' >&2
  exit 1
fi

control_dir="$(mktemp -d /tmp/bridge-rdp.XXXXXXXX)"
control="$control_dir/ssh"
cleanup() {
  /usr/bin/ssh -p "$ssh_port" -S "$control" -O exit "$server" >/dev/null 2>&1 || true
  rmdir "$control_dir" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
/usr/bin/ssh -f -M -S "$control" -N "${ssh_options[@]}" "${rdp_forward[@]}" "$server"

# Fetch the public RDP certificate through the already authenticated SSH connection.
digest="$(
  /usr/bin/ssh -S "$control" -o BatchMode=yes "${ssh_options[@]}" "$server"     'cat /etc/xrdp/claude-bridge-cert.pem' |
  /usr/bin/openssl x509 -outform DER | /usr/bin/shasum -a 256 | awk '{print $1}'
)"
if [[ ! "$digest" =~ ^[a-f0-9]{64}$ ]]; then
  printf '%s\n' 'Invalid RDP server certificate.' >&2
  exit 1
fi
IFS= read -r -s -p 'xRDP password: ' password </dev/tty
printf '\n'
if [[ -z "$password" ]]; then exit 1; fi
# Keep the password out of process arguments.
printf '%s\n' "$desktop_dir/Claude-Bridge-Desktop.rdp" /u:bridge-desktop "/p:$password" \
  /sec:tls "/cert:fingerprint:sha256:$digest" -clipboard /audio-mode:2 |
  sdl-freerdp /args-from:stdin
