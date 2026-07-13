"""Container-only Bubblewrap smoke test.

Run this inside the built Sandbox image with the Compose seccomp/systempaths
security options. It verifies the real kernel/mount behavior that unit tests
cannot exercise on a macOS host.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from sandbox.isolation import LaunchSpec
from sandbox.isolation.bubblewrap import BubblewrapIsolationBackend
from sandbox.services.execution_context import SandboxExecutionContext


def main() -> None:
    workspace = Path("/var/sandbox/workspaces/conv_bwrap_smoke")
    temp = Path("/var/sandbox/tmp/tmp_conv_bwrap_smoke")
    workspace.mkdir(parents=True, exist_ok=True)
    temp.mkdir(parents=True, exist_ok=True)

    context = SandboxExecutionContext(
        session_id="sandbox_bwrap_smoke",
        workspace_id="conv_bwrap_smoke",
        temp_id="tmp_conv_bwrap_smoke",
        physical_workspace=workspace,
        physical_temp=temp,
    )
    backend = BubblewrapIsolationBackend(
        executable="/usr/bin/bwrap",
        skills_root=Path("/home/sandbox/skill"),
    )
    backend.preflight()

    command = "\n".join(
        (
            "set -eu",
            'test "$PWD" = /home/sandbox/workspace',
            "printf workspace-ok > result.txt",
            "printf temp-ok > /tmp/cache.txt",
            "test -r /home/sandbox/skill",
            "test ! -e /var/sandbox/workspaces",
            "test ! -e /var/sandbox/tmp",
            "test ! -e /app/sandbox",
            "if touch /home/sandbox/skill/_must_fail 2>/dev/null; then exit 21; fi",
        )
    )
    prepared = backend.prepare(
        LaunchSpec(
            context=context,
            argv=["/bin/bash", "-c", command],
            network_mode="disabled",
        )
    )
    subprocess.run(
        prepared.argv,
        cwd=prepared.cwd,
        env=prepared.env,
        check=True,
        timeout=20,
    )

    assert (workspace / "result.txt").read_text() == "workspace-ok"
    assert (temp / "cache.txt").read_text() == "temp-ok"

    second = backend.prepare(
        LaunchSpec(
            context=context,
            argv=["/bin/bash", "-c", "cat result.txt /tmp/cache.txt"],
            network_mode="disabled",
        )
    )
    result = subprocess.run(
        second.argv,
        cwd=second.cwd,
        env=second.env,
        check=True,
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert result.stdout == "workspace-oktemp-ok"
    print("bubblewrap container smoke: ok")


if __name__ == "__main__":
    main()
