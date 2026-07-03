"""Agent entry point — CLI wrapper for EnterpriseToolAdapter.

This is a placeholder entry point for the agent container.
In production, Pi Agent would import and use EnterpriseToolAdapter
directly — this module exists so the agent container has a CMD target.
"""

from __future__ import annotations

import os
import time

from agent.sandbox_client import SandboxClient


def main() -> None:
    base_url = os.environ.get("SANDBOX_BASE_URL", "http://localhost:8081")
    client = SandboxClient(base_url=base_url)

    print(f"[agent] Connected to Sandbox at {base_url}")
    print("[agent] Enterprise Tool Adapter ready")

    # Health check
    try:
        health = client.health()
        print(f"[agent] Sandbox health: {health['status']}")
        print(f"[agent] Runtimes: {health['runtimes']}")
    except Exception as exc:
        print(f"[agent] Sandbox health check failed: {exc}")

    # Wait loop (production would run Pi Agent instead)
    try:
        while True:
            time.sleep(60)
    except KeyboardInterrupt:
        print("[agent] Shutting down")
        client.close()


if __name__ == "__main__":
    main()
