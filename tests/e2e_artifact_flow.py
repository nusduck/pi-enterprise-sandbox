#!/usr/bin/env python3
"""E2E agent interaction test — runs inside sandbox container."""
import json, sys, urllib.request, urllib.error

BASE = "http://localhost:8081"

def check(label, cond, detail=""):
    print(f"  {'✅' if cond else '❌'} {label}" + (f" — {detail}" if detail else ""))

def req(method, path, data=None):
    url = f"{BASE}{path}"
    body = json.dumps(data).encode() if data else None
    r = urllib.request.Request(url, data=body, method=method,
        headers={"Content-Type": "application/json"} if data else {})
    try:
        with urllib.request.urlopen(r) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}: {e.read().decode()}")

# === Test 1: Session + Write + No Auto-Scan ===
print("--- Test 1: No auto-scan after write ---")
s = req("POST", "/sessions", {"caller_id": "e2e-test"})
sid = s["session_id"]
check("Session created", sid.startswith("sandbox_"))
check("Status RUNNING", s["status"] == "RUNNING")

# Write a file
req("POST", f"/sessions/{sid}/files/write", {"path": "report.txt", "content": "report data"})
check("File written", True)

# Artifact list should be EMPTY — no auto-registration
al = req("GET", f"/sessions/{sid}/artifacts")
check("Artifact list EMPTY (no auto-scan)", al["total"] == 0)

# === Test 2: Explicit submit (bash-created file) ===
print()
print("--- Test 2: Explicit artifact submit ---")
req("POST", f"/sessions/{sid}/executions/command", {"command": "echo 'chart data' > chart.png"})
check("Bash file created", True)

# Submit explicitly
sar = req("POST", f"/sessions/{sid}/artifacts/submit",
          {"name": "chart.png", "path": "chart.png", "mime_type": "image/png"})
check("Submit artifact OK", sar["artifact_id"].startswith("art_"), sar["name"])
check("Size > 0", sar["size"] > 0, f"{sar['size']} bytes")

# List shows only submitted artifact
al2 = req("GET", f"/sessions/{sid}/artifacts")
check("Artifact count = 1 (only submitted)", al2["total"] == 1)
check("chart.png in artifacts", any(a["path"] == "chart.png" for a in al2["artifacts"]))

# === Test 3: Register other file (old endpoint) ===
print()
print("--- Test 3: Old register endpoint still works ---")
ar = req("POST", f"/sessions/{sid}/artifacts/register",
         {"name": "report.txt", "path": "report.txt", "mime_type": "text/plain"})
check("Register endpoint OK", ar["artifact_id"].startswith("art_"))

al3 = req("GET", f"/sessions/{sid}/artifacts")
check("Both files now registered", al3["total"] == 2)
paths = sorted(a["path"] for a in al3["artifacts"])
check("Paths in list", paths == ["chart.png", "report.txt"])

# === Test 4: Download artifact ===
print()
print("--- Test 4: Download submitted artifact ---")
arth = req("GET", f"/sessions/{sid}/artifacts")
aid = arth["artifacts"][0]["artifact_id"]
# Download returns binary FileResponse — verify HTTP 200
import urllib.request
dl_req = urllib.request.Request(f"{BASE}/sessions/{sid}/artifacts/{aid}/download")
with urllib.request.urlopen(dl_req) as resp:
    dl_data = resp.read()
    dl_ok = resp.status == 200 and len(dl_data) > 0
check("Download artifact works", dl_ok, f"{len(dl_data)} bytes received")

# Cleanup
req("DELETE", f"/sessions/{sid}")
check("Session cleaned up", True)

print()
print("=== ALL E2E TESTS PASSED ✅ ===")
