#!/usr/bin/env bash
set -euo pipefail
cd /opt/claude-bridge/current
exec runuser -u claude-bridge -- .venv/bin/python -m bridge.admin --db /var/lib/claude-bridge/bridge.sqlite3 "$@"
