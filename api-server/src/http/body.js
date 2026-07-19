import { HttpError } from './errors.js';

export async function readJsonBody(req, { maxBytes = 1024 * 1024 } = {}) {
  const declared = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    req.resume();
    throw new HttpError(413, 'BODY_TOO_LARGE', `JSON body exceeds ${maxBytes} bytes`);
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      req.resume();
      reject(error);
    };
    const onData = (chunk) => {
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
        reject(new HttpError(400, 'INVALID_JSON', 'Request body must be valid JSON'));
      }
    };
    const onError = (error) => fail(error);

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}
