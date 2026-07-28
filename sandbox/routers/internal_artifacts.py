"""Compatibility HMAC adapter for the Artifact domain."""

import sys

from sandbox.artifact.api import internal as _implementation

sys.modules[__name__] = _implementation
