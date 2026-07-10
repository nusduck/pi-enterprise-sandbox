# Implementation plan

- [x] Add regression tests for JWT route exposure, exact public paths and service-token bypass.
- [x] Add conversation workspace traversal tests.
- [x] Add artifact traversal, symlink, missing-file and cross-session download tests.
- [x] Add invalid-UTF-8/NUL binary round-trip and quota/partial-write tests.
- [x] Implement centralized public-route matching and correct middleware usage.
- [x] Validate conversation IDs and resolved workspace location.
- [x] Add session-scoped artifact repository/manager lookup and safe path resolution at register/submit/download.
- [x] Add atomic binary write support and bounded upload handling.
- [x] Run targeted auth/path/artifact/file/isolation tests.
- [x] Run full pytest and review API compatibility/error semantics.

## Validation commands

```bash
uv run pytest tests/test_auth.py tests/test_auth_foundation.py -v
uv run pytest tests/test_path_validation.py tests/test_artifact_manager.py tests/test_isolation_and_delivery.py -v
uv run pytest tests/test_integration.py tests/test_webui_api.py -v
uv run pytest tests/ -q --tb=short
```
