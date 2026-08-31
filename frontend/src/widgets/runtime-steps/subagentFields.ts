/**
 * Parse `spawn_subagent` / `check_subagent` tool payloads into display fields.
 *
 * Both tools return a Pi tool-result envelope whose text part is a JSON
 * document (`toolOk(toolResultJson(...))` on the Agent side), so the raw card
 * would otherwise show the model's wire format to the user. A fan-out is the
 * one thing in a run where "what are my children doing" is the whole question,
 * so it gets a real card.
 */

export type SubagentChild = {
  runId: string;
  status: string;
  label: string | null;
  statusReason: string | null;
  resultSummary: string | null;
};

export type SpawnSubagentFields = {
  task: string;
  label: string | null;
  childRunId: string | null;
  errorCode: string | null;
};

export type CheckSubagentFields = {
  allTerminal: boolean;
  children: SubagentChild[];
  errorCode: string | null;
};

/** Terminal Run statuses (plan §10), lowercased for display comparisons. */
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t || null;
}

/**
 * Pull the JSON document out of a Pi tool-result envelope.
 * Accepts the envelope, a bare JSON string, or an already-parsed object.
 */
export function parseToolResultJson(result: unknown): Record<string, unknown> | null {
  if (result == null) return null;
  if (typeof result === 'string') {
    const trimmed = result.trim();
    if (!trimmed.startsWith('{')) return null;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return isPlainObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  if (!isPlainObject(result)) return null;

  const content = result.content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) =>
        isPlainObject(part) && typeof part.text === 'string' ? part.text : '',
      )
      .filter(Boolean)
      .join('\n');
    const fromText = parseToolResultJson(text);
    if (fromText) return fromText;
  }
  // A result that is already the payload object (tests, replayed events).
  if ('childRunId' in result || 'children' in result || 'allTerminal' in result) {
    return result;
  }
  return null;
}

/** Coded failure from a `toolErr` envelope, when the tool refused. */
export function toolErrorCode(result: unknown): string | null {
  if (!isPlainObject(result)) return null;
  const details = result.details;
  if (isPlainObject(details) && typeof details.code === 'string') {
    return details.code.trim() || null;
  }
  return null;
}

export function isSpawnSubagentToolName(name: string | null | undefined): boolean {
  const n = String(name || '').trim();
  // 出厂 `dsh-tool-subagent` 注册的是 `subagent`（ADR 0009 D4，one-shot 形态）。
  // 旧名留着只为历史会话。
  return n === 'subagent' || n === 'spawn_subagent';
}

export function isCheckSubagentToolName(name: string | null | undefined): boolean {
  return String(name || '').trim() === 'check_subagent';
}

export function isSubagentToolName(name: string | null | undefined): boolean {
  return isSpawnSubagentToolName(name) || isCheckSubagentToolName(name);
}

/**
 * @param input `spawn_subagent` arguments
 * @param result the tool result, when it has arrived
 */
export function parseSpawnSubagentFields(
  input: unknown,
  result?: unknown,
): SpawnSubagentFields {
  const args = isPlainObject(input) ? input : {};
  const payload = parseToolResultJson(result) ?? {};
  const details = isPlainObject(result) && isPlainObject(result.details)
    ? result.details
    : {};
  return {
    task: trimmedString(args.task) ?? '',
    // The label can come from the args or be echoed by the durable service.
    label:
      trimmedString(args.label) ??
      trimmedString(payload.label) ??
      trimmedString(details.label),
    childRunId:
      trimmedString(payload.childRunId) ?? trimmedString(details.childRunId),
    errorCode: toolErrorCode(result),
  };
}

/**
 * @param result `check_subagent` result
 */
export function parseCheckSubagentFields(result: unknown): CheckSubagentFields {
  const payload = parseToolResultJson(result) ?? {};
  const rawChildren = Array.isArray(payload.children) ? payload.children : [];
  const children: SubagentChild[] = rawChildren.flatMap((raw) => {
    if (!isPlainObject(raw)) return [];
    const runId = trimmedString(raw.runId);
    if (!runId) return [];
    return [
      {
        runId,
        status: (trimmedString(raw.status) ?? 'unknown').toUpperCase(),
        label: trimmedString(raw.label),
        statusReason: trimmedString(raw.statusReason),
        resultSummary: trimmedString(raw.resultSummary),
      },
    ];
  });
  return {
    // Never infer "all done" from an empty list: a run that spawned nothing
    // must not read as a finished fan-out.
    allTerminal:
      payload.allTerminal === true &&
      children.length > 0 &&
      children.every((child) => TERMINAL.has(child.status.toLowerCase())),
    children,
    errorCode: toolErrorCode(result),
  };
}

/** Compact "2 done · 1 running" line for the card header. */
export function summarizeChildren(children: SubagentChild[]): string {
  if (children.length === 0) return 'no children yet';
  let done = 0;
  let failed = 0;
  let running = 0;
  for (const child of children) {
    const status = child.status.toLowerCase();
    if (status === 'succeeded') done += 1;
    else if (status === 'failed' || status === 'cancelled') failed += 1;
    else running += 1;
  }
  const parts: string[] = [];
  if (done) parts.push(`${done} done`);
  if (failed) parts.push(`${failed} stopped`);
  if (running) parts.push(`${running} running`);
  return parts.join(' · ');
}

/** Status pill class for one child row. */
export function childStatusClass(status: string): string {
  const s = status.toLowerCase();
  if (s === 'succeeded') return 'sa-ok';
  if (s === 'failed') return 'sa-err';
  if (s === 'cancelled') return 'sa-cancel';
  return 'sa-run';
}
