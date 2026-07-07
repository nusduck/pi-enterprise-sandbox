#!/usr/bin/env python3
"""Comprehensive MCP interface test — standalone script, not pytest."""
# Tell pytest to skip this file (standalone script, not a test module)
__test__ = False

import json, sys, time, urllib.request, urllib.error, socket

BASE = "http://localhost:8081"
errors = []

def check(label, ok, detail=""):
    m = f"  {'✅' if ok else '❌'} {label}"
    if detail: m += f" — {detail}"
    print(m)
    if not ok: errors.append(label)

def req(method, path, data=None):
    url = f"{BASE}{path}"
    body = json.dumps(data).encode() if data else None
    r = urllib.request.Request(url, data=body, method=method,
        headers={"Content-Type": "application/json"} if data else {})
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read()
        try:
            return e.code, json.loads(body)
        except:
            return e.code, {"raw": body.decode()}
    except Exception as e:
        return 0, {"error": str(e)}

def call(tool, kwargs, caller="mcp-test"):
    status, data = req("POST", "/mcp/call", {
        "tool_name": tool, "caller_id": caller, "kwargs": kwargs,
    })
    return status, data

def ok(data):
    """Check if response looks successful (no error key)."""
    return isinstance(data, dict) and "error" not in data and "detail" not in data

# ===== 1. Tool Listing =====
print("=" * 60)
print("📋 MCP Tool Listing")
print("=" * 60)

status, data = req("GET", "/mcp/tools")
check("GET /mcp/tools returns 200", status == 200)
tools = data.get("tools", [])
check(f"11 tools listed", len(tools) == 11, f"got {len(tools)}")
EXPECTED = sorted(["create_session","close_session","run_python",
    "run_command_limited","read_file","write_file","preview_file",
    "download_file","list_files","get_artifacts","submit_artifact"])
check("All expected tools present", sorted(tools) == EXPECTED)

# ===== 2. Full Session Lifecycle =====
print()
print("=" * 60)
print("🔧 Session Lifecycle via MCP")
print("=" * 60)

# Create session
s, r = call("create_session", {"agent_session_id":"mcp-v2", "caller_id":"mcp-test"})
# MCP call endpoint always returns 200 (tool-level status, not HTTP status)
check("create_session OK", ok(r), f"status={s}")
sid = r.get("session_id", "")
check("Has session_id", sid.startswith("sandbox_"))
check("Status RUNNING", r.get("status") == "RUNNING")
check("Has workspace_path", bool(r.get("workspace_path")))
print(f"  workspace_path = {r.get('workspace_path')}")

# Write file
s, r = call("write_file", {"session_id": sid, "path": "hello.txt", "content": "Hello MCP!"})
check("write_file OK", ok(r), f"status={s}")
check("Written bytes > 0", isinstance(r.get("size"), (int,float)) and r["size"] > 0, str(r.get("size")))

# Read file
s, r = call("read_file", {"session_id": sid, "path": "hello.txt"})
check("read_file 200", s == 200)
check("Content matches", r.get("content") == "Hello MCP!")

# Preview
s, r = call("preview_file", {"session_id": sid, "path": "hello.txt"})
check("preview_file 200", s == 200)
check("Preview has content", "Hello" in r.get("content", ""))

# Bash
s, r = call("run_command_limited", {"session_id": sid, "command": "echo mcp-cmd-test"})
check("run_command_limited 200", s == 200)
check("Exit code 0", r.get("exit_code") == 0)
check("Stdout has output", "mcp-cmd-test" in r.get("stdout_preview", ""))

# Python
s, r = call("run_python", {"session_id": sid, "code": "print('mcp-py-test')"})
check("run_python 200", s == 200)
check("Exit code 0", r.get("exit_code") == 0)
check("Python output", "mcp-py-test" in r.get("stdout_preview", ""))

# List files
s, r = call("list_files", {"session_id": sid, "path": "."})
check("list_files 200", s == 200)
n = r.get("total", -1)
check(f"Has {n} file(s)", n >= 1, f"files={[f['name'] for f in r.get('files',[])]}")
fnames = [f["name"] for f in r.get("files", [])]
check("hello.txt listed", "hello.txt" in fnames)

# ===== 3. Artifact Pipeline =====
print()
print("=" * 60)
print("📦 Artifact Pipeline via MCP")
print("=" * 60)

# Create chart.png via bash
s, r = call("run_command_limited", {"session_id": sid, "command": "echo 'chart data' > chart.png"})
check("Bash creates chart.png", s == 200 and r.get("exit_code") == 0)

# No auto-artifact
s, r = call("get_artifacts", {"session_id": sid})
check("No artifacts before explicit submit", ok(r) and r.get("total", 0) == 0)

# Explicit submit
s, r = call("submit_artifact", {"session_id": sid, "path": "chart.png", "name": "chart.png", "mime_type": "image/png"})
check("submit_artifact OK", ok(r) and r.get("artifact_id","").startswith("art_"))
aid = r.get("artifact_id", "")
check("Has artifact_id", aid.startswith("art_"))
check("Size > 0", r.get("size", 0) > 0, f"{r['size']} bytes")

# Now 1 artifact
s, r = call("get_artifacts", {"session_id": sid})
check("1 artifact after submit", ok(r) and r.get("total") == 1)
check("chart.png in list", "chart.png" in [a["path"] for a in r.get("artifacts", [])])

# Submit hello.txt too
s, r = call("submit_artifact", {"session_id": sid, "path": "hello.txt"})
check("Submit hello.txt OK", ok(r) and r.get("artifact_id","").startswith("art_"))

# Both artifacts
s, r = call("get_artifacts", {"session_id": sid})
check("Both artifacts present", ok(r) and r.get("total") == 2)

# Download artifact info
s, r = call("download_file", {"session_id": sid, "path": "chart.png"})
check("download_file 200", s == 200)
check("Has size > 0", r.get("size", 0) > 0)
check("Has name", r.get("name") == "chart.png")

# ===== 4. Error Handling =====
print()
print("=" * 60)
print("⚠️  Error Handling (expected errors)")
print("=" * 60)

# Unknown tool → 404
s, r = call("nonexistent_tool", {})
check("Unknown tool → 404", s == 404, f"detail={r.get('detail','')}")

# Invalid session
s, r = call("read_file", {"session_id": "bad-session", "path": "x"})
check("Invalid session → error", "not found" in str(r).lower())

# Blocked command → 403
s, r = call("run_command_limited", {"session_id": sid, "command": "sudo rm -rf /"})
check("Blocked command → 403", s == 403, f"detail={r.get('detail','')}")

# Path escape → MCP returns error dict (not HTTP error)
s, r = call("read_file", {"session_id": sid, "path": "../etc/passwd"})
check("Path escape blocked", "Path escape detected" in str(r), r.get("error","")[:60])

# Missing file submit (size=0, still registered)
s, r = call("submit_artifact", {"session_id": sid, "path": "missing.txt"})
check("Submit missing file (size=0)", ok(r) and r.get("size") == 0, f"size={r.get('size')}")

# Close non-existent
s, r = call("close_session", {"session_id": "no-such-session"})
check("Close non-existent → error", "not found" in str(r).lower())

# ===== 5. Cleanup =====
print()
print("=" * 60)
print("🧹 Cleanup")
print("=" * 60)

s, r = call("close_session", {"session_id": sid})
check("close_session OK", ok(r) and r.get("status") == "closed")

# Verify deleted
s, r = req("GET", f"/sessions/{sid}")
check("Session gone after close", s == 404)

# ===== 6. FastMCP SSE Transport =====
print()
print("=" * 60)
print("🔄 FastMCP SSE Transport Check")
print("=" * 60)

# Check if FastMCP process is running (separate SSE server — not auto-started)
try:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(3)
    rc = sock.connect_ex(("localhost", 8091))
    sock.close()
    if rc == 0:
        check("FastMCP port 8091 reachable", True, "(SSE server available)")
    else:
        check("FastMCP port 8091 (not running)", rc != 0,
              "SSE server not started — MCP available via REST /mcp/*")
except Exception as e:
    check("FastMCP socket check", False, str(e)[:60])

# ===== Summary =====
print()
if errors:
    print(f"❌ {len(errors)} tests FAILED:")
    for e in errors: print(f"   - {e}")
    sys.exit(1)
else:
    print("✅ ALL MCP INTERFACE TESTS PASSED")
