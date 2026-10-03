/**
 * 普通 Run 的提示词组装（从 `dsh-run-executor.ts` 拆出）。
 *
 * 拆出来的原因有两个，第二个才是重点：
 *
 * 1. `dsh-run-executor.ts` 是行数棘轮热点（预算只减不能增）；
 * 2. 交付物审核的 §5.4 **上下文注入**要插在「触发消息之前」，而它必须与
 *    `appendCurrentTurnAttachmentContext` / `appendNonVisionImageNotice` 保持
 *    同一条顺序——顺序错了注入文本就会落在附件清单之后，模型会读成用户说的话
 *    的一部分。放在同一个函数里，顺序只有一处可写。
 *
 * 注入文本由服务端生成（`review-context-injection.ts`），只进提示词，不进任何消息
 * 行，所以它不会出现在会话界面里，用户也无法伪造。
 */

import {
  appendCurrentTurnAttachmentContext,
  appendNonVisionImageNotice,
  derivePromptFromTriggeringMessage,
  toDshPromptInvocation,
} from './dsh-run-input.js';

type PromptContent = string | Array<{ type: string; text?: string }>;

/**
 * 把平台文本前置到提示词之前。
 *
 * 提示词可能是字符串，也可能是分片数组（多模态）；两种形状都要处理，否则数组形状
 * 会退化成 `"[object Object]"` 或直接丢注入。
 */
export function prependPlatformText(prompt: PromptContent, text: string | null | undefined) {
  const prefix = typeof text === 'string' ? text.trim() : '';
  if (!prefix) return prompt;
  if (typeof prompt === 'string') return `${prefix}\n\n${prompt}`;
  if (Array.isArray(prompt)) {
    return [{ type: 'text', text: prefix }, ...prompt];
  }
  const legacyObj: { text?: unknown } = prompt; // 对象分支兜底：签名只收string|array，直接读text会是never
  if (legacyObj && typeof legacyObj.text === 'string') return { ...legacyObj, text: `${prefix}\n\n${legacyObj.text}` };
  return prompt;
}

export interface TriggeringPromptInput {
  readonly triggering: unknown;
  readonly currentTurnAttachments: readonly unknown[];
  readonly imageAttachments: readonly unknown[];
  readonly modelAcceptsImages: boolean;
  readonly modelId: string;
  /** §5.4 的平台注入文本；`null` = 没有已决任务需要告诉模型。 */
  readonly reviewContext?: string | null;
}

/** 触发消息 → 本次 prompt（含审核上下文注入与附件清单）。 */
export function buildTriggeringPrompt(input: TriggeringPromptInput) {
  const base = prependPlatformText(
    derivePromptFromTriggeringMessage(input.triggering),
    input.reviewContext ?? null,
  );
  return toDshPromptInvocation(
    appendNonVisionImageNotice(
      appendCurrentTurnAttachmentContext(base, [...input.currentTurnAttachments]),
      input.modelAcceptsImages ? [] : [...input.imageAttachments],
      input.modelId,
    ),
  );
}

export interface AttachPromptImagesInput {
  readonly prompt: { text: string; options?: { images?: unknown } };
  readonly imageAttachments: readonly unknown[];
  readonly modelAcceptsImages: boolean;
  readonly loader:
    | ((input: {
        attachments: readonly unknown[];
        sandboxSessionId: unknown;
        workspaceId: unknown;
        scope: unknown;
        traceId: unknown;
        traceState: unknown;
        signal: unknown;
      }) => Promise<unknown>)
    | null
    | undefined;
  readonly sandboxSessionId: unknown;
  readonly workspaceId: unknown;
  readonly scope: unknown;
  readonly traceId: unknown;
  readonly traceState: unknown;
  readonly signal: unknown;
  /** 与调用方同一个脱敏器（`sanitizeStatusReason`）；缺省用固定文案。 */
  readonly sanitizeStatusReason?: (error: unknown) => string | null;
}

/**
 * 把图片附件挂到 prompt 上。
 *
 * @returns `{ ok: false, statusReason }` 时调用方把 Run 判成 FAILED——**不吞掉**：
 * 模型收不到用户发的图却照常回答，比直接失败更糟。
 */
export async function attachPromptImages(
  input: AttachPromptImagesInput,
): Promise<{ ok: true } | { ok: false; statusReason: string }> {
  if (input.imageAttachments.length === 0 || !input.modelAcceptsImages) return { ok: true };
  if (!input.loader) {
    return { ok: false, statusReason: 'image attachments require a configured attachment store' };
  }
  let images: unknown;
  try {
    images = await input.loader({
      attachments: input.imageAttachments,
      sandboxSessionId: input.sandboxSessionId,
      workspaceId: input.workspaceId,
      scope: input.scope,
      traceId: input.traceId,
      traceState: input.traceState,
      signal: input.signal,
    });
  } catch (error) {
    return {
      ok: false,
      statusReason:
        input.sanitizeStatusReason?.(error) ?? 'image attachment resolution failed',
    };
  }
  if (Array.isArray(images) && images.length > 0) {
    input.prompt.options = { ...(input.prompt.options || {}), images };
  }
  return { ok: true };
}
