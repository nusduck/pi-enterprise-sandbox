/**
 * Pi Agent WebUI — Sandbox file & artifact proxy routes.
 *
 * Proxies file listing / download / artifact queries to the
 * sandbox service so the frontend can browse and retrieve outputs.
 */
import http from "node:http";
import { SANDBOX_URL } from "../config.js";

const SANDBOX = new URL(SANDBOX_URL);

/**
 * GET /api/sessions/:id/files?path=...
 * Proxy to sandbox: GET /sessions/:id/files?path=...
 */
export function handleSessionFiles(req, res, sessionId, subpath) {
  const path = `/sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(subpath)}`;
  proxyGet(res, path);
}

/**
 * GET /api/sessions/:id/files/download?path=...
 * Proxy to sandbox: GET /sessions/:id/files/download?path=...
 * Returns the raw file content as a download.
 */
export function handleSessionFileDownload(req, res, sessionId, filepath) {
  const path = `/sessions/${encodeURIComponent(sessionId)}/files/download?path=${encodeURIComponent(filepath)}`;
  proxyGet(res, path, true);
}

/**
 * GET /api/sessions/:id/artifacts
 * Proxy to sandbox: GET /sessions/:id/artifacts
 */
export function handleSessionArtifacts(req, res, sessionId) {
  const path = `/sessions/${encodeURIComponent(sessionId)}/artifacts`;
  proxyGet(res, path);
}

// ── Internal proxy helper ───────────────────────────────────────────

function proxyGet(res, path, raw = false) {
  const options = {
    hostname: SANDBOX.hostname,
    port: SANDBOX.port,
    path,
    method: "GET",
    headers: { Accept: raw ? "*/*" : "application/json" },
  };

  const proxy = http.request(options, (sandboxRes) => {
    if (raw) {
      // File download — pass through content-type and content-disposition
      res.writeHead(sandboxRes.statusCode, {
        "Content-Type": sandboxRes.headers["content-type"] || "application/octet-stream",
        "Content-Disposition": sandboxRes.headers["content-disposition"] || "attachment",
        "Content-Length": sandboxRes.headers["content-length"] || "",
      });
    } else {
      res.writeHead(sandboxRes.statusCode, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
    }
    sandboxRes.pipe(res);
  });

  proxy.on("error", (err) => {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Sandbox proxy error: ${err.message}` }));
  });

  proxy.end();
}
