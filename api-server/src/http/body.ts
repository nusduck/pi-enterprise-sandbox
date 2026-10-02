import type { IncomingMessage } from 'node:http';
import { HttpError } from './errors.js';

export interface ReadJsonBodyOptions {
  maxBytes?: number;
  /**
   * JSON 解析失败时的状态码与错误码。默认 400 + `INVALID_JSON`；
   * 审核面（reviews）沿用既有契约 422 + `REVIEW_INPUT_INVALID`。
   */
  invalidJsonStatus?: number;
  invalidJsonCode?: string;
}

export async function readJsonBody(
  req: IncomingMessage,
  { maxBytes = 1024 * 1024, invalidJsonStatus = 400, invalidJsonCode = 'INVALID_JSON' }: ReadJsonBodyOptions = {},
): Promise<any> {
  const declared = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    req.resume();
    throw new HttpError(413, 'BODY_TOO_LARGE', `JSON body exceeds ${maxBytes} bytes`);
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      req.resume();
      reject(error);
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        fail(new HttpError(413, 'BODY_TOO_LARGE', `JSON body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(invalidJsonStatus, invalidJsonCode, 'Request body must be valid JSON'));
      }
    };
    const onError = (error: Error) => fail(error);

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

