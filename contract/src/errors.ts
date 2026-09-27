/**
 * 契约错误码：复用 DSH `dsh-fs` 的 `FS_*` 错误码，叠加我们自己的传输层
 * （信封 / 认证 / 租户）错误码，并提供一个"把任意 Error 映射成可以上线
 * 的错误对象"的函数。
 *
 * 为什么要单独一层，而不是直接把 `Error.message` 透传出去：
 * - `exec/` 的错误消息里天然会带物理路径（`dsh-fs-local` 的报错原文常见
 *   `ENOENT: /var/lib/dsh-exec/workspaces/<uuid>/...`），设计文档的硬要求
 *   是"错误文本里物理根一律显示成 `<workspace>`"——这是防止内部目录结构
 *   通过错误提示泄漏给模型 / 前端 / 攻击者的最后一道闸门。
 * - `FsError`（dsh-fs 抛出）与我们自己的 `ContractError`（信封/认证失败）
 *   要统一成同一种线上形状，调用方（agent 侧 RPC 客户端）不需要区分"这个
 *   错误来自 DSH 还是来自我们自己的认证层"。
 */

import { FsError } from '@deepseek-ai/dsh-fs';
import type { FsErrorCode } from '@deepseek-ai/dsh-fs';

export type { FsErrorCode };
export { FsError };

/**
 * 我们自己加的传输层错误码：
 * - `AUTH_FAILED`         内部 HMAC 认证失败（签名、schema、时间窗口等，
 *                         具体原因收敛到这一个粗粒度码上线，细粒度诊断码
 *                         见 `hmac.ts` 的 `InternalHmacError.code`）
 * - `ENVELOPE_INVALID`    RPC 信封缺字段或字段格式不对
 * - `TENANT_MISMATCH`     信封携带的租户（org/user）与凭据或路由目标不符
 * - `FENCE_EXPIRED`       execution fence token 已经不是当前 Run 的最新值
 * - `WORKSPACE_NOT_FOUND` 信封里的 workspaceId 找不到对应工作区
 * - `SKILL_PACKAGE_UNAVAILABLE` 清单点名的已发布 Skill 版本缺失或侧车不符
 *                         （design §3.3：拒绝并报出，不静默丢弃）
 * - `SKILL_STORE_UNAVAILABLE`   用户 Skill 存储不可读（挂载掉线、权限、未配置），
 *                         不能当成「没有 Skill」放行
 * - `DATA_SOURCE_UNKNOWN` 清单点名的数据源不在 exec 的目录里（配置漂移或伪造），拒绝执行
 * - `DATA_SOURCE_UNAVAILABLE` 数据源已登记，但启动时取密失败或转发通道建不起来
 * - `INTERNAL_ERROR`      未归类的兜底错误（不应该常态出现；出现说明调用
 *                         方抛出的不是 FsError / ContractError，需要补分类）
 */
export type TransportErrorCode =
  | 'AUTH_FAILED'
  | 'ENVELOPE_INVALID'
  | 'TENANT_MISMATCH'
  | 'FENCE_EXPIRED'
  | 'WORKSPACE_NOT_FOUND'
  | 'SKILL_PACKAGE_UNAVAILABLE'
  | 'SKILL_STORE_UNAVAILABLE'
  | 'DATA_SOURCE_UNKNOWN'
  | 'DATA_SOURCE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

/** 契约错误码 = DSH 的 `FS_*` 错误码 ∪ 我们自己的传输层错误码。 */
export type ContractErrorCode = FsErrorCode | TransportErrorCode;

/** 传输层（信封 / 认证 / 租户 / 工作区路由）失败。 */
export class ContractError extends Error {
  readonly code: TransportErrorCode;

  constructor(code: TransportErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ContractError';
    this.code = code;
  }
}

/** RPC 响应里携带的线上错误对象——没有 stack，没有 cause，只有稳定字段。 */
export interface WireError {
  readonly code: ContractErrorCode;
  readonly message: string;
}

/**
 * 硬编码的物理根前缀兜底——移植自 `sandbox/paths.py` 的
 * `_DEFAULT_PHYSICAL_PREFIXES`。这是最后一道安全网：即使调用方传的
 * `physicalRoots` 不全（配置漂移、漏传某个根），这两个前缀也一定会被
 * 脱敏。它们**永远**参与替换，不需要、也不能由调用方关闭。
 */
const DEFAULT_PHYSICAL_PREFIXES: readonly string[] = Object.freeze([
  '/var/sandbox/workspaces',
  '/sandbox/workspaces',
]);

/**
 * 把错误文本中出现的物理根路径替换成 `<workspace>`。
 *
 * `contract/` 本身不知道任何一次调用实际用的物理根是什么——那是 exec 侧
 * `writableRoots()` 的产物（§5.1）。**`physicalRoots` 是必填参数，故意
 * 不给默认值**：设计文档"一个物理根都不许漏"是硬要求，如果这里给
 * `= []` 之类的默认值，调用方忘了传就会静默地什么都不脱敏——那是
 * fail-open，此处必须 fail-closed。TypeScript strict 下漏传这个参数会
 * 直接编译不过，而不是运行时悄悄放行。
 *
 * 处理顺序（对齐 `sandbox/paths.py:219-271` 的 `sanitize_path_error`，
 * `LEGACY_AGENT_WORKSPACE_PATH` 那条 旧引擎时代兼容逻辑本次不迁移）：
 * 1. 把调用方传入的 roots 与 {@link DEFAULT_PHYSICAL_PREFIXES} 合并；
 * 2. 每个 root 去掉尾部 `/` 再去重——否则带尾斜杠的 root 匹配不上
 *    文本里不带尾斜杠的路径；
 * 3. 按长度从长到短替换，避免一个根是另一个根前缀时被替换了一半
 *    （比如 `/a/b` 和 `/a/b/c` 都传入时，先替换更长的 `/a/b/c`）；
 * 4. 折叠意外产生的连续 `<workspace>` 重复 token——嵌套根替换后可能
 *    出现 `<workspace><workspace>` 这种串联,统一收成一个。
 */
export function redactPhysicalPaths(
  text: string,
  physicalRoots: readonly string[],
): string {
  const normalized = new Set<string>();
  for (const root of [...physicalRoots, ...DEFAULT_PHYSICAL_PREFIXES]) {
    const trimmed = root.replace(/\/+$/, '');
    if (trimmed.length > 0) {
      normalized.add(trimmed);
    }
  }
  const roots = [...normalized].sort((a, b) => b.length - a.length);

  let redacted = text;
  for (const root of roots) {
    redacted = redacted.replaceAll(root, '<workspace>');
  }
  // 折叠连续重复的 <workspace> token（嵌套根替换的副产物）。
  redacted = redacted.replaceAll(/(?:<workspace>){2,}/g, '<workspace>');
  return redacted;
}

/**
 * dsh-fs 的全部 `FS_*` 错误码。写成 `Record<FsErrorCode, true>`：dsh-fs 增删错误码时
 * 这里编译不过，而不是悄悄把新码当成 INTERNAL_ERROR。
 */
const FS_ERROR_CODES: Readonly<Record<FsErrorCode, true>> = Object.freeze({
  FS_ABORTED: true,
  FS_AMBIGUOUS_EDIT: true,
  FS_EDIT_NOT_FOUND: true,
  FS_IO_ERROR: true,
  FS_NOT_DIRECTORY: true,
  FS_NOT_FOUND: true,
  FS_NOT_OBSERVED: true,
  FS_NOT_REGULAR_FILE: true,
  FS_NOT_TEXT: true,
  FS_PERMISSION_DENIED: true,
  FS_SANDBOX_DENIED: true,
  FS_STALE_VERSION: true,
  FS_TOO_LARGE: true,
});

/**
 * 不能只靠 `instanceof`：exec / agent 与 contract 各自安装一份 `@deepseek-ai/dsh-fs`，
 * 调用方抛出的 FsError 对这里导入的类做 `instanceof` 为假，2026-09-14 之前因此全部
 * 降级成 INTERNAL_ERROR。结构判断只认 dsh-fs 声明过的错误码，任意 `code` 不会被透传。
 */
function isFsError(value: unknown): value is FsError {
  if (value instanceof FsError) return true;
  if (!(value instanceof Error)) return false;
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' && Object.hasOwn(FS_ERROR_CODES, code);
}

function isContractError(value: unknown): value is ContractError {
  return value instanceof ContractError;
}

export interface ToWireErrorOptions {
  /**
   * 当次请求实际用到的物理根路径（工作区根、会话私有 `/tmp` 等）；
   * 命中的会被替换成 `<workspace>`。必填，理由同 {@link redactPhysicalPaths}
   * ——不给默认值是为了让"忘了传"在编译期就失败，而不是在运行时泄漏
   * 物理路径。没有额外的根要传就显式传 `[]`（{@link DEFAULT_PHYSICAL_PREFIXES}
   * 仍然会兜底生效）。
   */
  readonly physicalRoots: readonly string[];
}

/**
 * 把任意抛出物映射成可以放进 `RpcResult` 的线上错误对象，并脱敏物理路径。
 *
 * 分类顺序：`ContractError`（传输层）> `FsError`（dsh-fs 结构化错误）>
 * 普通 `Error` > 其它任意抛出物（兜底成 `INTERNAL_ERROR`，用 `String()`
 * 兜底取文本，同样过脱敏）。
 */
export function toWireError(error: unknown, options: ToWireErrorOptions): WireError {
  const roots = options.physicalRoots;
  if (isContractError(error)) {
    return { code: error.code, message: redactPhysicalPaths(error.message, roots) };
  }
  if (isFsError(error)) {
    return { code: error.code, message: redactPhysicalPaths(error.message, roots) };
  }
  if (error instanceof Error) {
    return { code: 'INTERNAL_ERROR', message: redactPhysicalPaths(error.message, roots) };
  }
  return { code: 'INTERNAL_ERROR', message: redactPhysicalPaths(String(error), roots) };
}
