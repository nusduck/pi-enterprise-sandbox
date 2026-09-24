/**
 * Parse ask_user tool input / pendingInput into display fields.
 */

export type AskUserFields = {
  title: string;
  message: string | null;
  placeholder: string | null;
  interactionType: 'input' | 'select' | 'confirm' | string;
  options: string[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseAskUserFields(
  input: unknown,
  pending?: {
    title?: string;
    message?: string | null;
    interactionType?: string;
    options?: string[];
    placeholder?: string | null;
  } | null,
): AskUserFields {
  const fromTool = isPlainObject(input) ? input : {};
  const title =
    (pending?.title && String(pending.title).trim()) ||
    (typeof fromTool.title === 'string' && fromTool.title.trim()) ||
    'Input required';
  const messageRaw =
    pending?.message !== undefined
      ? pending.message
      : fromTool.message != null
        ? String(fromTool.message)
        : null;
  const message =
    messageRaw != null && String(messageRaw).trim()
      ? String(messageRaw).trim()
      : null;
  const placeholderRaw =
    pending?.placeholder !== undefined
      ? pending.placeholder
      : fromTool.placeholder != null
        ? String(fromTool.placeholder)
        : null;
  const placeholder =
    placeholderRaw != null && String(placeholderRaw).trim()
      ? String(placeholderRaw).trim()
      : null;
  const interactionType = String(
    pending?.interactionType ||
      fromTool.interaction_type ||
      fromTool.interactionType ||
      'input',
  );
  const options = Array.isArray(pending?.options)
    ? pending!.options.map(String).filter(Boolean)
    : Array.isArray(fromTool.options)
      ? fromTool.options.map(String).filter(Boolean)
      : [];
  return { title, message, placeholder, interactionType, options };
}

/** Summarize a resolved interaction response for the card footer. */
export function summarizeInteractionResult(result: unknown): string | null {
  if (result == null) return null;
  if (typeof result === 'string') {
    const t = result.trim();
    return t || null;
  }
  if (typeof result === 'boolean') return result ? 'Confirmed' : 'Declined';
  if (typeof result === 'number') return String(result);
  if (isPlainObject(result)) {
    if (typeof result.response === 'string') return result.response;
    if (typeof result.text === 'string') return result.text;
    if (typeof result.value === 'string' || typeof result.value === 'boolean') {
      return String(result.value);
    }
    if (Array.isArray(result.content)) {
      const text = result.content
        .map((part) =>
          isPlainObject(part) && typeof part.text === 'string' ? part.text : '',
        )
        .filter(Boolean)
        .join('\n')
        .trim();
      if (text) return text;
    }
    try {
      return JSON.stringify(result);
    } catch {
      return null;
    }
  }
  return String(result);
}

export function isAskUserToolName(name: string | null | undefined): boolean {
  const n = String(name || '').trim();
  // 出厂 `dsh-tool-ask-user` 注册的是 `ask_user_question`（ADR 0009 D4）。
  // 旧名留着只为历史会话——过去的 Run 里有 `ask_user` 的记录。
  return n === 'ask_user_question' || n === 'ask_user';
}
