/**
 * ASCII 安全的 `Content-Disposition`（RFC 5987）。移植自 `sandbox/mcp/disposition.py`。
 *
 * Node 的 `ServerResponse.setHeader` 会拒绝非 latin-1 的头部值（Starlette 是同样
 * 的约束），而用户可见的产物名常含中日韩字符，所以它绝不能原样出现在
 * `filename="..."` 里。那个参数留作保守的 ASCII 兜底（并保留原扩展名），
 * 净化后的原名放进 `filename*`。
 *
 * ## Model Experience
 * 模型看不到这里。影响的是 `sandbox_artifact_submit` 返回的下载链接最终存盘时
 * 的文件名——名字对了，用户拿到的文件才打得开。
 *
 * ## Known Limitations and Deferred Work
 * - 扩展名只认 `.<1..8 个字母数字>`。多段扩展名（`.tar.gz`）只保留最后一段。
 *   与 Python 版行为一致，不在本次改。
 */

const ASCII_EXT_RE = /\.([A-Za-z0-9]{1,8})$/;

/**
 * Python 的 `urllib.parse.quote(value, safe='')`。
 *
 * `encodeURIComponent` 额外把 `!'()*` 当作安全字符不编码，Python 会编码它们。
 * 产物名里出现这五个字符时两边的头部就会不同，所以这里补齐而不是将就。
 */
function quoteAll(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** 取 basename，去掉换行/引号/控制字符，截到 200 字符。 */
export function safeContentDispositionFilename(name: string): string {
  const raw = name || 'artifact';
  // basename：POSIX 与 Windows 分隔符都切，避免 `a\b.txt` 整段留下来。
  const base = raw.split(/[/\\]/).pop() ?? 'artifact';
  const cleaned = base
    .replace(/[\r\n]/g, '')
    .replace(/["\\;]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim();
  return (cleaned || 'artifact').slice(0, 200);
}

/**
 * 净化后的显示名，扩展名从存储路径借。
 *
 * `submit_artifact` 的 name 是用户可见的标题（`随机 Markdown 文档`），扩展名
 * 往往只存在于工作区路径里。原样下载标题会存出一个没有应用打得开的文件，
 * 所以名字本身没有扩展名时，从路径补一个。
 */
export function withPathExtension(name: string, fallbackPath?: string | null): string {
  const filename = safeContentDispositionFilename(name);
  if (ASCII_EXT_RE.test(filename) || !fallbackPath) return filename;
  const pathBase = String(fallbackPath).split('/').pop() ?? '';
  const matched = ASCII_EXT_RE.exec(pathBase);
  if (!matched) return filename;
  const ext = matched[0];
  return `${filename.slice(0, 200 - ext.length)}${ext}`;
}

/** latin-1 的 `filename=` 值，仍然带一个可用的扩展名。 */
export function asciiFilenameFallback(name: string): string {
  const filename = safeContentDispositionFilename(name);
  const matched = ASCII_EXT_RE.exec(filename);
  const ext = matched ? matched[0].toLowerCase() : '';
  const body = matched ? filename.slice(0, matched.index) : filename;
  let asciiBody = '';
  for (const char of body) {
    const code = char.codePointAt(0) ?? 0;
    asciiBody += code >= 0x20 && code <= 0x7e ? char : '_';
  }
  asciiBody = asciiBody.replace(/[_\s.]+/g, '_').replace(/^[._]+|[._]+$/g, '');
  return `${asciiBody || 'download'}${ext}`.slice(0, 200);
}

export function artifactContentDisposition(name: string, fallbackPath?: string | null): string {
  const filename = withPathExtension(name, fallbackPath);
  const asciiFallback = asciiFilenameFallback(filename);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${quoteAll(filename)}`;
}

/** `X-Artifact-Filename` 用的百分号编码 basename（latin-1 安全）。 */
export function artifactFilenameHeader(name: string, fallbackPath?: string | null): string {
  return quoteAll(withPathExtension(name, fallbackPath));
}
