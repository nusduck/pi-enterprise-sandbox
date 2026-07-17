"""Target Sandbox Service layout (plan §16.1).

Production modules remain at sandbox/*.py until later PRs migrate.
This file is the sole tracked marker for the target root ``sandbox/app/``.
Nested empty package placeholders are intentionally omitted.

Canonical layer list: packages/contracts → SANDBOX_TARGET_LAYOUT.
"""

SERVICE = "sandbox"
TARGET_ROOT = "sandbox/app"

LAYERS = (
    "api",
    "domain",
    "services",
    "isolation",
    "persistence",
    "security",
    "observability",
)
