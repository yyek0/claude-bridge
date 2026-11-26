"""Apply the desktop settings while preserving repeated Xorg parameters."""

import os
import re
import stat
import tempfile
from pathlib import Path

DIRECTORY = Path("/etc/xrdp")
USER_GROUP = "claude-desktop-users"
SESSION_FILE = "sesman.socket"


def configure(path, settings, keep=None):
    lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
    sections = {}
    section = ""
    for line in lines:
        if match := re.fullmatch(r"\s*\[([^]]+)\]\s*", line):
            section = match[1]
        sections.setdefault(section, []).append(line)

    for section, values in settings.items():
        index = {key.casefold(): key for key in values}
        original = sections.get(section, [f"\n[{section}]\n"])
        retained = []
        for line in original:
            key = line.split("=", 1)[0].strip().casefold()
            if key not in index:
                retained.append(line)
        # The section heading precedes all of its settings.
        heading = next(i for i, line in enumerate(retained) if line.strip() == f"[{section}]")
        retained[heading + 1:heading + 1] = [f"{key}={value}\n" for key, value in values.items()]
        sections[section] = retained

    content = "".join(line for name, block in sections.items()
                      if keep is None or name in keep for line in block)
    current = path.stat()
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as output:
        temporary = Path(output.name)
        try:
            os.fchown(output.fileno(), current.st_uid, current.st_gid)
            os.fchmod(output.fileno(), stat.S_IMODE(current.st_mode))
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def main():
    configure(DIRECTORY / "xrdp.ini", {
        "Globals": {
            "port": "tcp://127.0.0.1:3389",
            "security_layer": "tls",
            "ssl_protocols": "TLSv1.2, TLSv1.3",
            "certificate": "/etc/xrdp/claude-bridge-cert.pem",
            "key_file": "/etc/xrdp/claude-bridge-key.pem",
            "allow_channels": "false",
            "autorun": "Xorg",
            "max_bpp": "32",
        },
        "Channels": dict.fromkeys(
            ("rdpdr", "rdpsnd", "drdynvc", "cliprdr", "rail", "xrdpvr", "tcutils"), "false"
        ),
    }, keep={"", "Globals", "Logging", "LoggingPerLogger", "Channels", "Xorg"})
    configure(DIRECTORY / "sesman.ini", {
        "Globals": {
            "ListenPort": SESSION_FILE,
            "EnableUserWindowManager": "false",
        },
        "Security": {
            "AllowRootLogin": "false",
            "MaxLoginRetry": "4",
            "TerminalServerUsers": USER_GROUP,
            "AlwaysGroupCheck": "true",
            "AllowAlternateShell": "false",
            "RestrictInboundClipboard": "all",
            "RestrictOutboundClipboard": "all",
        },
        "Sessions": {
            "MaxSessions": "1",
            "KillDisconnected": "false",
            "DisconnectedTimeLimit": "0",
            "IdleTimeLimit": "0",
            "Policy": "UB",
        },
    })
    if "[Xorg]" not in (DIRECTORY / "xrdp.ini").read_text(encoding="utf-8"):
        raise SystemExit("The installed xrdp package lacks an Xorg session definition.")


if __name__ == "__main__":
    main()
