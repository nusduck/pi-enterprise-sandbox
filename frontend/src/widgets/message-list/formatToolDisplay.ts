/**
 * Human-readable formatting for tool input/result in chat ToolPill popovers.
 * Sandbox bash/python results often arrive as a JSON string nested inside
 * `{ content: [{ type: 'text', text: '{"stdout":...}' }] }` — surface stdout
 * instead of raw wire JSON so tools look successful in the UI.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** Prefer stdout/stderr/exitCode when present on a sandbox execution envelope. */
function formatExecutionEnvelope(obj: Record<string, unknown>): string | null {
  const hasExecKeys =
    'stdout' in obj ||
    'stderr' in obj ||
    'exitCode' in obj ||
    'exit_code' in obj;
  if (!hasExecKeys) return null;

  const exitCode = obj.exitCode ?? obj.exit_code;
  const stdout = obj.stdout != null ? String(obj.stdout) : '';
  const stderr = obj.stderr != null ? String(obj.stderr) : '';
  const lines: string[] = [];
  if (exitCode != null && exitCode !== '') {
    lines.push(`exit ${exitCode}`);
  }
  if (stdout) {
    lines.push(stdout.replace(/\n$/, ''));
  }
  if (stderr.trim()) {
    lines.push(`stderr:\n${stderr.replace(/\n$/, '')}`);
  }
  if (!lines.length) return '(empty output)';
  return lines.join('\n');
}

/**
 * Unwrap Pi / platform tool result bags into display text.
 */
export function formatToolResultDisplay(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') {
    const parsed = tryParseJson(result);
    if (parsed != null) return formatToolResultDisplay(parsed);
    return result;
  }
  if (Array.isArray(result)) {
    return result.map((item) => formatToolResultDisplay(item)).filter(Boolean).join('\n');
  }
  if (!isPlainObject(result)) {
    return String(result);
  }

  // Error tool results: { content: [{ text: "Error [CODE]: ..." }], details: { code } }
  if (result.details && isPlainObject(result.details) && result.details.code) {
    const code = String(result.details.code);
    const contentText = extractContentText(result);
    if (contentText) return contentText;
    return `Error [${code}]`;
  }

  const fromEnvelope = formatExecutionEnvelope(result);
  if (fromEnvelope != null) return fromEnvelope;

  // Pi ToolResult: { content: [{ type: 'text', text: '...' }] }
  const contentText = extractContentText(result);
  if (contentText) {
    const nested = tryParseJson(contentText);
    if (nested != null) {
      const nestedDisplay = formatToolResultDisplay(nested);
      if (nestedDisplay) return nestedDisplay;
    }
    return contentText;
  }

  // UnknownOutcome marker
  if (result.unknown === true || result.reason === 'TOOL_OUTCOME_UNKNOWN') {
    return `unknown outcome${result.reason ? `: ${String(result.reason)}` : ''}`;
  }

  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

function extractContentText(result: Record<string, unknown>): string {
  const content = result.content;
  if (!Array.isArray(content)) {
    if (typeof result.text === 'string') return result.text;
    return '';
  }
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (isPlainObject(part) && typeof part.text === 'string') return part.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export function formatToolInputDisplay(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (isPlainObject(input)) {
    if (typeof input.command === 'string') return `$ ${input.command}`;
    if (typeof input.code === 'string') {
      const code = input.code;
      return code.length > 400 ? `${code.slice(0, 400)}…` : code;
    }
    if (typeof input.path === 'string') return input.path;
  }
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}
