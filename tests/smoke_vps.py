"""Exercise distinct SSH-authorized devices against an installed server."""

import asyncio
import json
import os
import subprocess
from contextlib import AsyncExitStack
from uuid import uuid4

from test_backend import Client
from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus


def remote(*args):
    destination = os.environ["BRIDGE_TEST_SSH_TARGET"]
    control = os.environ["BRIDGE_TEST_SSH_CONTROL"]
    return subprocess.check_output(["ssh", "-S", control, "-o", "BatchMode=yes",
                                    "-o", "StrictHostKeyChecking=yes", "--", destination, *args], text=True)


async def main():
    suffix = uuid4().hex[:12]
    created = []

    def issue(account, label):
        credential = json.loads(remote("/opt/claude-bridge/admin", "add", "--account", account, "--label", label))
        created.append(credential["id"])
        return credential

    def dial(credential):
        return connect(os.getenv("BRIDGE_TEST_WS", "ws://127.0.0.1:18765/ws"),
                       additional_headers={"Authorization": "Bearer " + credential["token"]})

    try:
        a = issue("smoke-" + suffix, "first")
        b = issue("smoke-" + suffix, "second")
        c = issue("outside-" + suffix, "third")
        async with AsyncExitStack() as stack:
            first, second, outside = [Client(await stack.enter_async_context(dial(device))) for device in [a, b, c]]
            for peer in [first, second, outside]:
                await peer.until("ready")
            dialog_a, dialog_b = str(uuid4()), str(uuid4())
            for peer, dialog in [(first, dialog_a), (second, dialog_b)]:
                await peer.send("create", dialog=dialog)
                await peer.until("history")
            await first.send("prompt", dialog=dialog_a, text="/mock [{\"name\":\"list_directory\"}]", model="mock:mock", tools=True)
            await second.send("prompt", dialog=dialog_b, text="/mock [{\"name\":\"get_diagnostics\"}]", model="mock:mock", tools=True)
            call_a, call_b = await first.until("tool"), await second.until("tool")
            assert call_a["dialog"] == dialog_a and call_a["name"] == "list_directory"
            assert call_b["dialog"] == dialog_b and call_b["name"] == "get_diagnostics"
            assert call_a["call"] != call_b["call"]
            await first.send("result", call=call_a["call"], text="device-one", error=False)
            await second.send("result", call=call_b["call"], text="device-two", error=False)
            for peer, dialog in [(first, dialog_a), (second, dialog_b)]:
                assert (await peer.until("done"))["dialog"] == dialog
            await second.send("open", dialog=dialog_a)
            shared = (await second.until("history"))["turns"]
            assert len(shared) == 1 and "device-one" in shared[0]["answer"] and "device-two" not in shared[0]["answer"]
            await outside.send("open", dialog=dialog_a)
            await outside.until("error")
        remote("/opt/claude-bridge/admin", "revoke", a["id"])
        created.remove(a["id"])
        try:
            async with dial(a):
                raise AssertionError("Revoked device authenticated")
        except InvalidStatus:
            pass
        print("VPS: independent concurrent sessions, account-scoped history sharing and revoked-device rejection")
    finally:
        for device_id in created:
            remote("/opt/claude-bridge/admin", "revoke", device_id)


if __name__ == "__main__":
    asyncio.run(main())
