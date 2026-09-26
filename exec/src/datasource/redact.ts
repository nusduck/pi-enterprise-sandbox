/**
 * 数据源口令的输出脱敏（design `sandbox-data-sources.md` §4.6）。
 *
 * 子进程能读到自己的环境变量，`print(os.environ[...])` 会把口令带进工具结果、对话与
 * 账本。这里对 stdout/stderr 做**已知口令的精确替换**——挡住误打印；刻意编码后外带
 * 挡不住，那要靠只读账号与二期的「口令不进沙箱」。
 */

export const SECRET_MASK = '***';

function usable(secrets: readonly string[]): string[] {
  // 长的先替换：一个口令是另一个口令的子串时，不留下半截。
  return [...new Set(secrets.filter((s) => s.length > 0))].sort((a, b) => b.length - a.length);
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of usable(secrets)) {
    if (out.includes(secret)) out = out.split(secret).join(SECRET_MASK);
  }
  return out;
}

/**
 * 增量输出的脱敏：口令可能被切在两次读取之间。每次只放出「后面再来什么也不会让它
 * 变成口令一部分」的前缀，尾部最多扣住 `最长口令长度 - 1` 个字符，流结束时全部放出。
 */
export class StreamSecretRedactor {
  private readonly secrets: string[];
  private readonly holdback: number;
  private pending = '';

  constructor(secrets: readonly string[]) {
    this.secrets = usable(secrets);
    this.holdback = this.secrets.length === 0 ? 0 : this.secrets[0]!.length - 1;
  }

  push(delta: string, final: boolean): string {
    if (this.secrets.length === 0) return delta;
    const buf = this.pending + delta;
    if (final) {
      this.pending = '';
      return redactSecrets(buf, this.secrets);
    }
    let cut = Math.max(0, buf.length - this.holdback);
    // 跨过切点的完整口令整段放出（它已经完整地在缓冲里）。
    for (let moved = true; moved; ) {
      moved = false;
      for (const secret of this.secrets) {
        let at = buf.indexOf(secret, Math.max(0, cut - secret.length + 1));
        while (at !== -1 && at < cut) {
          if (at + secret.length > cut) {
            cut = at + secret.length;
            moved = true;
          }
          at = buf.indexOf(secret, at + 1);
        }
      }
    }
    this.pending = buf.slice(cut);
    return redactSecrets(buf.slice(0, cut), this.secrets);
  }
}
