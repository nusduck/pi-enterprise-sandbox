/**
 * Pi Agent WebUI — Static file server
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { MIME } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** WebUI root — one level up from routes/ */
const WEBUI_ROOT = path.resolve(__dirname, "..");

/**
 * Serve static files from the webui directory.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
export function serveStatic(req, res) {
  let filePath = req.url === "/" ? "/index.html" : req.url;
  filePath = path.join(WEBUI_ROOT, filePath);

  if (!filePath.startsWith(WEBUI_ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  const ext = path.extname(filePath);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const content = fs.readFileSync(filePath);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  res.end(content);
}
