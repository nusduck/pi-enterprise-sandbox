"""PR-07B batch 2A1: Python tool request-hash v1 tests.

Consumes the same golden fixture as Node:
``packages/contracts/fixtures/sandbox-tool-request-hash-v1.json``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from sandbox.app.domain.tool_request_hash import (
    TOOL_NAME_MAX_LEN,
    TOOL_REQUEST_HASH_VERSION,
    ToolRequestHashError,
    assert_tool_request_tool_name,
    canonical_tool_request_json_v1,
    compute_tool_request_hash_v1,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
FIXTURE_PATH = (
    REPO_ROOT / "packages" / "contracts" / "fixtures" / "sandbox-tool-request-hash-v1.json"
)


def _load_fixture() -> dict[str, Any]:
    with FIXTURE_PATH.open(encoding="utf-8") as f:
        return json.load(f)


def _materialize_value(node: Any) -> Any:
    if not isinstance(node, dict) or "kind" not in node:
        return node
    kind = node["kind"]
    if kind == "float":
        if "decimal" in node:
            return float(node["decimal"])
        return float(node["value"])
    if kind == "intString":
        return int(node["value"])
    if kind == "utf16CodeUnits":
        # Python str is code-point based; surrogate code points are still representable.
        return "".join(chr(u) for u in node["units"])
    if kind == "object":
        out: dict[str, Any] = {}
        for entry in node["entries"]:
            out[entry["key"]] = _materialize_value(entry["value"])
        return out
    raise AssertionError(f"unknown construct kind: {kind}")


def _materialize_input(row: dict[str, Any]) -> tuple[str, Any]:
    tool = row.get("tool", "")
    tc = row.get("toolConstruct")
    if tc:
        if tc["kind"] == "repeat":
            tool = str(tc["char"]) * int(tc["count"])
        else:
            raise AssertionError(f"unknown toolConstruct: {tc}")
    if "argsConstruct" in row:
        args = _materialize_value(row["argsConstruct"])
    else:
        args = row.get("args", {})
    return tool, args


def _applies(row: dict[str, Any], lang: str) -> bool:
    langs = row.get("languages")
    if not langs:
        return True
    return lang in langs


@pytest.fixture(scope="module")
def fixture() -> dict[str, Any]:
    return _load_fixture()


def test_fixture_present(fixture: dict[str, Any]) -> None:
    assert FIXTURE_PATH.is_file()
    assert fixture["version"] == 1
    assert fixture["contract"] == "sandbox-tool-request-hash-v1"
    assert len(fixture["valid"]) >= 8
    assert len(fixture["invalid"]) >= 5


@pytest.mark.parametrize(
    "row",
    _load_fixture()["valid"],
    ids=lambda r: r["id"],
)
def test_valid_vectors_match_canonical_and_hash(row: dict[str, Any]) -> None:
    tool, args = _materialize_input(row)
    out = compute_tool_request_hash_v1(tool_name=tool, args=args)
    assert out["canonicalJson"] == row["canonicalJson"]
    assert out["requestHash"] == row["requestHash"]
    assert out["requestHashVersion"] == TOOL_REQUEST_HASH_VERSION
    assert len(out["requestHash"]) == 64
    assert all(c in "0123456789abcdef" for c in out["requestHash"])
    assert (
        canonical_tool_request_json_v1(tool_name=tool, args=args) == row["canonicalJson"]
    )


def test_no_unicode_normalization(fixture: dict[str, Any]) -> None:
    by_id = {r["id"]: r for r in fixture["valid"]}
    composed = by_id["unicode-composed"]
    decomposed = by_id["unicode-decomposed"]
    assert composed["requestHash"] != decomposed["requestHash"]
    assert composed["canonicalJson"] != decomposed["canonicalJson"]


@pytest.mark.parametrize(
    "row",
    _load_fixture()["invalid"],
    ids=lambda r: r["id"],
)
def test_invalid_vectors_reject(row: dict[str, Any]) -> None:
    if not _applies(row, "python"):
        pytest.skip(f"not for python: {row['id']}")
    tool, args = _materialize_input(row)
    with pytest.raises(ToolRequestHashError) as ei:
        compute_tool_request_hash_v1(tool_name=tool, args=args)
    if row.get("errorCode"):
        assert ei.value.code == row["errorCode"]


def test_rejects_python_float_1_0() -> None:
    with pytest.raises(ToolRequestHashError) as ei:
        compute_tool_request_hash_v1(tool_name="t", args={"x": 1.0})
    assert ei.value.code == "TOOL_REQUEST_HASH_FLOAT"


def test_rejects_bytes_custom_cycle() -> None:
    with pytest.raises(ToolRequestHashError):
        compute_tool_request_hash_v1(tool_name="t", args={"x": b"ab"})

    class Custom:
        pass

    with pytest.raises(ToolRequestHashError):
        compute_tool_request_hash_v1(tool_name="t", args=Custom())  # type: ignore[arg-type]

    with pytest.raises(ToolRequestHashError):
        compute_tool_request_hash_v1(tool_name="t", args={"x": (1, 2)})

    cycle: list[Any] = [1]
    cycle.append(cycle)
    with pytest.raises(ToolRequestHashError) as ei:
        compute_tool_request_hash_v1(tool_name="t", args=cycle)
    assert ei.value.code == "TOOL_REQUEST_HASH_CYCLE"


def test_tool_name_rules() -> None:
    assert assert_tool_request_tool_name("bash") == "bash"
    with pytest.raises(ToolRequestHashError):
        assert_tool_request_tool_name("")
    with pytest.raises(ToolRequestHashError):
        assert_tool_request_tool_name(" x ")
    with pytest.raises(ToolRequestHashError):
        assert_tool_request_tool_name("a" * (TOOL_NAME_MAX_LEN + 1))


def test_omitted_args_defaults_to_empty_object() -> None:
    """Omitted args kwarg → {} (matches Node args === undefined)."""
    out = compute_tool_request_hash_v1(tool_name="bash")
    assert out["canonicalJson"] == '{"args":{},"tool":"bash","v":1}'
    assert out["requestHash"] == (
        "67299dd95ff1e9e856fb845da8ef636af2e7726214ccd61de3f6992ba25064c2"
    )


def test_explicit_none_args_is_canonical_null() -> None:
    """Explicit args=None → JSON null (matches Node args: null)."""
    out = compute_tool_request_hash_v1(tool_name="bash", args=None)
    assert out["canonicalJson"] == '{"args":null,"tool":"bash","v":1}'
    assert out["requestHash"] == (
        "64a85af070139b4b469c22f2489bde65f5659f3f7a1c14a4cfb78d3de028c79c"
    )
    # Distinct from omitted/empty-object default.
    omitted = compute_tool_request_hash_v1(tool_name="bash")
    assert out["requestHash"] != omitted["requestHash"]
