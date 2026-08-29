/**
 * 搜索响应类型。字段名与 Python 版 `sandbox/models.py` 的
 * `FileSearchResponse` / `GrepResponse` **逐字段一致**——BFF 与前端按这些
 * 名字取值，改名就是破坏公共契约。
 */
import type { EntryType } from './limits.js';

export interface FileSearchItem {
  readonly path: string;
  readonly name: string;
  readonly type: EntryType;
  readonly size: number;
}

export interface FileSearchSkipped {
  readonly path: string;
  readonly reason: string;
}

/**
 * 六个字段**全部必填**：Python 的 `FileSearchStats` 每个字段都有默认值 0，
 * 所以它序列化出来永远是六个键。少发一个键就不是"逐字节不变"了。
 */
export interface FileSearchStats {
  readonly examined: number;
  readonly matched: number;
  readonly skipped: number;
  readonly bytes_scanned: number;
  readonly duration_ms: number;
  readonly depth_reached: number;
}

export interface FileSearchResponse {
  readonly items: FileSearchItem[];
  readonly skipped: FileSearchSkipped[];
  readonly stats: FileSearchStats;
  readonly truncated: boolean;
  readonly stop_reason: string | null;
}

export interface GrepMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  text: string;
  before: string[];
  after: string[];
  readonly count?: number;
}

export interface GrepResponse {
  readonly matches: GrepMatch[];
  readonly skipped: FileSearchSkipped[];
  readonly stats: FileSearchStats;
  readonly truncated: boolean;
  readonly stop_reason: string | null;
}

/** 一次搜索的物理根与展示前缀。`publicPrefix` 为 `/tmp` 时结果路径带该前缀。 */
export interface SearchRoot {
  readonly root: string;
  readonly start: string;
  readonly publicPrefix: string | null;
}
