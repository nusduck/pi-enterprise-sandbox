/**
 * 输出上限——移植自 `sandbox/utils/resource_limits.py` 的 `BoundedTextCapture`。
 *
 * 语义（与现有 Python 版逐字对齐，见 `sandbox/services/execution_manager.py`
 * 里 `settings.max_output_chars` 的用法）：每个流（stdout / stderr）保留
 * **前缀**——一旦累计保留字符数达到上限，后续文本只计数、不保留、不转发。
 * 这不是"保留尾部"（tail），是"保留头部"（prefix）：与 Node 的 `Buffer`
 * 截断习惯相反，移植时容易搞反，这里专门强调。
 *
 * 字符计数按 JS 字符串的 UTF-16 code unit 计（`string.length`），与
 * Python `len(str)` 按 code point 计不完全一致（超出 BMP 的字符在 JS 里
 * 占两个 unit，Python 里占一个）——这是移植中的一处已知不一致，详见
 * `run()`/`start()` 顶部注释里的说明；对绝大多数命令输出（ASCII 为主）
 * 没有实际影响，只在极端场景下上限会略微偏严格。
 *
 * `feed()` 用 `TextDecoder` 增量解码（`stream: true`），对应 Python 版的
 * `codecs.getincrementaldecoder('utf-8')('replace')`——半个多字节 UTF-8
 * 序列如果恰好跨在两次 chunk 之间，不会被拆成替换字符，会等到下一个
 * chunk 补全后再解码。
 */

const DEFAULT_MAX_CHARS = 50_000;

/** 与 `execution_manager.py` 的 50K 字符上限保持一致的默认值。 */
export const DEFAULT_OUTPUT_CAP_CHARS = DEFAULT_MAX_CHARS;

export interface BoundedCaptureStats {
  readonly maxChars: number;
  readonly retainedChars: number;
  readonly totalSeenChars: number;
  readonly truncated: boolean;
}

/**
 * 单个流的前缀保留捕获器。构造后反复 `feedBytes()`，随时 `getValue()`。
 */
export class BoundedTextCapture {
  readonly maxChars: number;
  private readonly parts: string[] = [];
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });
  private retained = 0;
  private totalSeen = 0;
  private truncatedFlag = false;

  constructor(maxChars: number) {
    this.maxChars = Math.max(0, Math.trunc(maxChars));
  }

  /** 喂入原始字节（子进程管道读到的 chunk），返回本次新增的、真正被保留
   * 并应当转发给增量输出回调的文本片段（已经在这次调用里应用了截断）。 */
  feedBytes(chunk: Uint8Array): string {
    const text = this.decoder.decode(chunk, { stream: true });
    return this.feedText(text);
  }

  /** 流结束时调用一次，冲刷解码器里残留的尾部字节（`stream: false`）。 */
  flush(): string {
    const tail = this.decoder.decode();
    return tail ? this.feedText(tail) : '';
  }

  private feedText(text: string): string {
    if (!text) return '';
    this.totalSeen += text.length;
    if (this.retained >= this.maxChars) {
      this.truncatedFlag = true;
      return '';
    }
    const remaining = this.maxChars - this.retained;
    if (text.length <= remaining) {
      this.parts.push(text);
      this.retained += text.length;
      return text;
    }
    const piece = text.slice(0, remaining);
    this.parts.push(piece);
    this.retained += piece.length;
    this.truncatedFlag = true;
    return piece;
  }

  getValue(): string {
    return this.parts.join('');
  }

  get truncated(): boolean {
    return this.truncatedFlag;
  }

  stats(): BoundedCaptureStats {
    return {
      maxChars: this.maxChars,
      retainedChars: this.retained,
      totalSeenChars: this.totalSeen,
      truncated: this.truncatedFlag,
    };
  }
}

/** `ShellRunResult.stdout`/`stderr` 的形状（`CollectedOutput`，来自
 * `@deepseek-ai/dsh-subprocess`，经 `dsh-shell` 重新导出）——这里不导入
 * 那个类型只是为了不给这个纯工具文件添加包依赖，形状保持结构兼容。 */
export interface CollectedOutputLike {
  readonly text: string;
  readonly truncated: boolean;
}

export function finalizeCapture(capture: BoundedTextCapture): CollectedOutputLike {
  capture.flush();
  return { text: capture.getValue(), truncated: capture.truncated };
}

/**
 * 后台进程增量读取的跟踪器——支撑 `ShellProcess.readOutput()` 的"连续读
 * 不重复返回"契约（dsh-shell README）。stdout / stderr 各自仍然只保留
 * 前 `maxChars` 个字符（同一份 `BoundedTextCapture` 语义），"增量"指的是
 * "这次读到上次读之间，从已保留前缀里新增的那一段"，不是"整个流的增量"——
 * 一旦某个流被截断，继续读只会不断收到空增量、并持续报告 `lossy: true`。
 */
export class LiveOutputTracker {
  readonly stdout: BoundedTextCapture;
  readonly stderr: BoundedTextCapture;
  private deliveredStdout = 0;
  private deliveredStderr = 0;

  constructor(maxChars: number = DEFAULT_OUTPUT_CAP_CHARS) {
    this.stdout = new BoundedTextCapture(maxChars);
    this.stderr = new BoundedTextCapture(maxChars);
  }

  /** 读取自上次 `read()` 以来的增量。`delta` 把 stdout 与 stderr 合并成
   * 一段模型可读文本，约定与 `dsh-bash-local` 一致：stderr 部分前面加一个
   * `[stderr]` 标记行，方便消费方（`dsh-tool-bash` 之类）区分两路。 */
  read(): { delta: string; lossy: boolean } {
    const outFull = this.stdout.getValue();
    const errFull = this.stderr.getValue();
    const outDelta = outFull.slice(this.deliveredStdout);
    const errDelta = errFull.slice(this.deliveredStderr);
    this.deliveredStdout = outFull.length;
    this.deliveredStderr = errFull.length;

    const separator = outDelta.length > 0 && !outDelta.endsWith('\n') ? '\n' : '';
    const delta = outDelta + (errDelta.length > 0 ? `${separator}[stderr]\n${errDelta}` : '');
    // 一旦任一流已经截断，此后每次读都如实报告 lossy——截断意味着"从这里
    // 开始，这个流已经有数据既没被保留、也不会再出现在任何一次增量里"。
    const lossy = this.stdout.truncated || this.stderr.truncated;
    return { delta, lossy };
  }
}
