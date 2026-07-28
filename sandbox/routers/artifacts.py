"""Compatibility HTTP adapter for the Artifact domain."""

import sys

from sandbox.artifact.api import public as _implementation

sys.modules[__name__] = _implementation
