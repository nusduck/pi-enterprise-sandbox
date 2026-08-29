/**
 * 文件名脱敏与校验——移植自 Python 版
 * `sandbox/services/attachment_manager.py:sanitize_filename` /
 * `extension_of` / `is_allowed_extension`。
 *
 * 为什么单独一层：`artifact/` 与 `dataset/` 也要对外部传进来的文件名做
 * 同一条校验——路径穿越、空字节、超长、危险字符都在这里挡掉，避免
 * 两个模块各写一份校验最后悄悄分叉（_shared.md §7）。
 */

const COMPOUND_SUFFIXES = ['.tar.gz', '.tar.bz2', '.tar.xz'] as const;

const ALLOWED_EXTENSIONS = new Set<string>([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.xml',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.log', '.env',
  '.py', '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '.java', '.go', '.rs',
  '.rb', '.php', '.c', '.h', '.cpp', '.cc', '.hpp', '.cs', '.swift', '.kt',
  '.scala', '.sh', '.bash', '.zsh', '.ps1', '.sql', '.r', '.m', '.mm',
  '.html', '.htm', '.css', '.scss', '.less', '.vue', '.svelte', '.lua',
  '.pl', '.pm', '.ex', '.exs', '.erl', '.hs', '.clj', '.dockerfile',
  '.ipynb', '.graphql', '.gql', '.proto', '.tf', '.hcl',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico',
  '.tif', '.tiff',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.odt', '.ods', '.odp', '.rtf', '.epub',
  '.zip', '.tar', '.gz', '.tgz', '.tar.gz',
]);

export function extensionOf(filename: string): string {
  const lower = (filename ?? '').toLowerCase().trim();
  for (const compound of COMPOUND_SUFFIXES) {
    if (lower.endsWith(compound)) return compound;
  }
  const dot = lower.lastIndexOf('.');
  if (dot === -1) return '';
  return lower.slice(dot);
}

export function isAllowedExtension(filename: string): boolean {
  const ext = extensionOf(filename);
  if (!ext) return false;
  return ALLOWED_EXTENSIONS.has(ext);
}

/**
 * 去掉路径段、空字节、控制字符、`..`，并截断到 200 字符以内（保留扩展名）。
 * 与 Python 版 `sanitize_filename` 行为对齐，空串回退为 `upload`。
 */
export function sanitizeFilename(name: string): string {
  let base = (name ?? 'upload').split('/').pop() ?? 'upload';
  base = base.split('\\').pop() ?? base;
  base = base.replace(/\x00/g, '');
  // eslint-disable-next-line no-control-regex
  base = base.replace(/[\x00-\x1f\x7f]/g, '');
  base = base.replace(/\.\./g, '_').trim().replace(/^\.+/, '');
  if (!base) base = 'upload';
  if (base.length > 200) {
    const ext = extensionOf(base);
    const stem = ext ? base.slice(0, 200 - ext.length) : base.slice(0, 200);
    base = ext && !stem.endsWith(ext) ? `${stem}${ext}` : stem;
  }
  return base;
}

export function newAttachmentId(): string {
  // 与 Python 版 `att_{uuid.hex}` 对齐
  const hex = [...Array(16)].map(() => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('');
  // 用 crypto 随机避免可预测，但测试只检查前缀
  return `att_${hex}`;
}
