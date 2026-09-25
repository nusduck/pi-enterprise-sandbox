/**
 * Display fields for the linear turn stream: Chinese action summaries for tool
 * groups, and parsers for the tool payloads that get their own cards.
 *
 * Shapes follow what the Agent actually stores (tbl_agsvc_tool_executions):
 * results arrive as `{ value, content, isError }`, and the DSH tools use
 * `prompt`/`description` (subagent), `questions[]` (ask_user_question) and
 * `run_in_background` + `jobId` (bash jobs).
 */
import type { ToolExecutionEntity } from '../../../entities/types';

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Joined text parts of a DSH tool-result envelope (`content[].text`). */
export function resultText(result: unknown): string | null {
  const outer = record(result);
  const parts = Array.isArray(outer?.content) ? outer!.content : null;
  if (!parts) return typeof result === 'string' ? text(result) : null;
  const joined = parts
    .map((p) => (typeof p === 'string' ? p : text(record(p)?.text) || ''))
    .filter(Boolean)
    .join('\n');
  return text(joined);
}

function resultValue(result: unknown): Record<string, unknown> | null {
  const outer = record(result);
  return record(outer?.value) || outer;
}

// ── tool group summary ───────────────────────────────────────────────

type Category = { verb: string; unit: string };

const CATEGORY: Record<string, Category> = {
  read: { verb: '读取', unit: '个文件' },
  write: { verb: '写入', unit: '个文件' },
  edit: { verb: '修改', unit: '个文件' },
  glob: { verb: '查找', unit: '次文件' },
  grep: { verb: '搜索', unit: '次内容' },
  bash: { verb: '运行', unit: '条命令' },
  read_image: { verb: '查看', unit: '张图片' },
  skill: { verb: '调用', unit: '个 Skill' },
};

/** Short verb for one tool line ("读取", "运行", "调用 exa.web_search_exa"). */
export function toolVerb(name: string): string {
  const known = CATEGORY[name];
  if (known) return known.verb;
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  if (mcp) return `调用 ${mcp[1]}.${mcp[2]}`;
  return `调用 ${name}`;
}

/** "读取 1 个文件，运行 2 条命令" — categories in order of first appearance. */
export function summarizeToolGroup(tools: readonly Pick<ToolExecutionEntity, 'name'>[]): string {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    const key = CATEGORY[tool.name] ? tool.name : tool.name.startsWith('mcp__') ? 'mcp' : 'other';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const parts: string[] = [];
  for (const [key, n] of counts) {
    if (key === 'mcp') parts.push(`调用 ${n} 次外部工具`);
    else if (key === 'other') parts.push(`调用 ${n} 个工具`);
    else parts.push(`${CATEGORY[key].verb} ${n} ${CATEGORY[key].unit}`);
  }
  return parts.join('，');
}

/** Wall time between first and last update, in milliseconds. */
export function toolDurationMs(tools: readonly Pick<ToolExecutionEntity, 'createdAt' | 'updatedAt'>[]): number | null {
  let start = Infinity;
  let end = -Infinity;
  for (const t of tools) {
    const a = Date.parse(String(t.createdAt || ''));
    const b = Date.parse(String(t.updatedAt || t.createdAt || ''));
    if (Number.isFinite(a)) start = Math.min(start, a);
    if (Number.isFinite(b)) end = Math.max(end, b);
  }
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

export function formatDurationMs(ms: number | null): string {
  if (ms == null) return '';
  if (ms < 1000) return `${Math.max(ms, 0)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}分${String(Math.round(s % 60)).padStart(2, '0')}秒`;
}

// ── sub-tasks (subagent / delegate_to_agent / delegate_to_remote_agent) ─

export type SubtaskFields = {
  title: string;
  /** Target agent for delegations; null for a same-agent sub-agent. */
  agent: string | null;
  prompt: string | null;
  childRunId: string | null;
  conclusion: string | null;
  error: string | null;
  /** Remote delegation rejected at the approval gate. */
  rejected: boolean;
};

export function subtaskFields(tool: Pick<ToolExecutionEntity, 'input' | 'result' | 'isError'>): SubtaskFields {
  const args = record(tool.input) || {};
  const value = resultValue(tool.result);
  const output = Array.isArray(value?.output)
    ? value!.output.map((p) => text(record(p)?.text) || '').filter(Boolean).join('\n')
    : null;
  const errorMsg = text(record(record(tool.result)?.error)?.message) || text(record(value?.error)?.message);
  const rejected = value?.decision === 'reject';
  const prompt = text(args.prompt) || text(args.task);
  return {
    title: text(args.description) || text(args.label) || (prompt ? prompt.split('\n')[0].slice(0, 60) : '子任务'),
    agent: text(args.agent),
    prompt,
    childRunId: text(value?.runId) || text(value?.childRunId),
    conclusion: text(output) || (tool.isError || rejected ? null : resultText(tool.result)),
    error: rejected ? '审批被拒绝' : errorMsg || (tool.isError ? resultText(tool.result) : null),
    rejected,
  };
}

// ── ask_user_question ────────────────────────────────────────────────

export type QuestionOption = { label: string; description: string | null };

export type QuestionFields = {
  header: string | null;
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
  /** Free-text / chosen answer once resolved. */
  answer: string | null;
};

export function questionFields(
  tool: Pick<ToolExecutionEntity, 'input' | 'result'>,
  pending?: { title?: string; message?: string | null; options?: string[] } | null,
): QuestionFields {
  const args = record(tool.input) || {};
  const first = Array.isArray(args.questions) ? record(args.questions[0]) : null;
  const rawOptions = Array.isArray(first?.options) ? first!.options : Array.isArray(args.options) ? args.options : [];
  const options: QuestionOption[] = rawOptions
    .map((o) => {
      const r = record(o);
      const label = r ? text(r.label) : text(o);
      return label ? { label, description: r ? text(r.description) : null } : null;
    })
    .filter((o): o is QuestionOption => o != null);
  if (!options.length && pending?.options?.length) {
    for (const label of pending.options) options.push({ label, description: null });
  }
  const value = resultValue(tool.result);
  return {
    header: text(first?.header) || null,
    question:
      text(first?.question) || text(pending?.message) || text(args.message)
      || text(pending?.title) || text(args.title) || '需要你的回答',
    options,
    multiSelect: first?.multi_select === true || first?.multiSelect === true,
    answer: text(value?.response) || text(value?.answer) || null,
  };
}

// ── background jobs ──────────────────────────────────────────────────

export type JobFields = {
  command: string | null;
  description: string | null;
  /** null when no job_output / job_kill has reported the job's state yet. */
  running: boolean | null;
  outputTail: string | null;
};

/** Last lines of the newest job_output result, if any. */
export function jobFields(
  tool: Pick<ToolExecutionEntity, 'input'>,
  related: readonly Pick<ToolExecutionEntity, 'name' | 'result' | 'isError'>[],
  maxLines = 6,
): JobFields {
  const args = record(tool.input) || {};
  let outputTail: string | null = null;
  let running: boolean | null = null;
  for (const r of related) {
    if (r.name === 'job_kill' && !r.isError) running = false;
    if (r.isError) continue;
    // job_output → { value: { job: { id, status, … }, text } }
    const value = resultValue(r.result);
    const state = text(record(value?.job)?.status);
    if (state) running = state === 'running';
    if (r.name !== 'job_output') continue;
    const out = typeof value?.text === 'string' ? value.text.replace(/\n+$/, '') : null;
    if (out) outputTail = out.split('\n').slice(-maxLines).join('\n');
  }
  return {
    command: text(args.command),
    description: text(args.description),
    running,
    outputTail,
  };
}
