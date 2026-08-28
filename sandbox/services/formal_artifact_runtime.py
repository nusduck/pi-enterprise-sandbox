"""Compatibility import for the Artifact application runtime."""

from sandbox.artifact.application.runtime import *

# Bound here on purpose: tests monkeypatch
# "sandbox.services.formal_artifact_runtime.workspace_manager" by string path,
# which needs the name present in this module's namespace.
from sandbox.artifact.application.runtime import workspace_manager
