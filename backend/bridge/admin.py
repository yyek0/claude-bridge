import argparse
import json
import os

from .store import Store, default_path


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description="Manage Claude Bridge device credentials.")
    parser.add_argument("--db", default=default_path())
    sub = parser.add_subparsers(dest="action", required=True)
    add = sub.add_parser("add")
    add.add_argument("--account", required=True)
    add.add_argument("--label", required=True)
    sub.add_parser("list")
    revoke = sub.add_parser("revoke")
    revoke.add_argument("device_id")
    args = parser.parse_args()
    store = Store(args.db)
    if args.action == "add":
        device, token = store.add_device(args.account, args.label)
        print(json.dumps({"id": device, "token": token}))
    elif args.action == "revoke":
        if not store.revoke(args.device_id):
            parser.error("Unknown or already revoked device")
    else:
        print(json.dumps(store.devices(), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
