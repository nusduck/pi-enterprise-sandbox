/**
 * Run detail timeline for the admin Trace view.
 *
 * The durable trace keeps metadata only (queue / tool / session spans, no
 * model spans and no content), so the waterfall is rebuilt from the run's
 * persisted events: each `message.completed` closes one model round and
 * carries its full content (reasoning, text, tool calls); tool and approval
 * events give their own start/end. The tool ledger (`/api/runs/:id/tools`)
 * fills in risk, source and results by `tool_call_id`. The trace contract is
 * unchanged.
 */
import type { PersistedAgentEvent, ToolExecutionSnapshot } from '../../shared/schemas/events';
import { resultText, subtaskFields } from '../../features/chat/projections/turnFields';

export type NodeKind = 'run' | 'queue' | 'model' | 'tool' | 'sub' | 'wait';
export type NodeStatus = 'ok' | 'error' | 'running' | 'approved' | 'rejected' | 'waiting';

export type TimelineBlock = { title: string; kind: 'text' | 'pre'; body: string };

export type TimelineNode = {
  id: string;
  depth: number;
  kind: NodeKind;
  name: string;
  /** Epoch ms. */
  start: number;
  /** Epoch ms; null while still open. */
  end: number | null;
  status: NodeStatus;
  kv: Array<[string, string]>;
  blocks: TimelineBlock[];
};

export type RunTimeline = {
  nodes: TimelineNode[];
  start: number;
  end: number;
  modelRounds: number;
  toolCalls: number;
  approvals: number;
};

type Json = Record<string, unknown>;

function rec(value: unknown): Json | null {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function ts(value: string | null | undefined): number | null {
  if (!value) return null;
  const n = Date.parse(value);
  return Number.isNaN(n) ? null : n;
}

/** Event body: current events wrap it in `payload.data`, older ones are flat. */
function dataOf(ev: PersistedAgentEvent): Json {
  const payload = rec(ev.payload) || {};
  return rec(payload.data) || payload;
}

function pretty(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const SUB_TOOLS = new Set(['subagent', 'delegate_to_agent', 'delegate_to_remote_agent']);

/** Short node label: `bash · ls -la`, `read · report.md`, `subagent · 标题`. */
export function toolLabel(name: string, args: Json | null): string {
  const a = args || {};
  const hint =
    str(a.description) ||
    str(a.command) ||
    str(a.path) ||
    str(a.file_path) ||
    str(a.pattern) ||
    str(a.query) ||
    str(a.displayName) ||
    (Array.isArray(a.todos) ? `${a.todos.length} 项` : null);
  if (!hint) return name;
  const oneLine = hint.split('\n')[0];
  return `${name} · ${oneLine.length > 48 ? `${oneLine.slice(0, 48)}…` : oneLine}`;
}

function toolBlocks(name: string, args: Json | null, result: unknown, isError: boolean): TimelineBlock[] {
  const blocks: TimelineBlock[] = [];
  if (SUB_TOOLS.has(name)) {
    const f = subtaskFields({ input: args, result, isError });
    if (f.agent) blocks.push({ title: '目标智能体', kind: 'text', body: f.agent });
    if (f.prompt) blocks.push({ title: '完整 prompt', kind: 'pre', body: f.prompt });
    if (f.conclusion) blocks.push({ title: '结论', kind: 'text', body: f.conclusion });
    if (f.error) blocks.push({ title: '错误', kind: 'pre', body: f.error });
    return blocks;
  }
  if (name === 'bash' && args && str(args.command)) {
    blocks.push({ title: '命令', kind: 'pre', body: String(args.command) });
  } else if (args && Object.keys(args).length) {
    blocks.push({ title: '参数', kind: 'pre', body: pretty(args) });
  }
  if (result === undefined) return blocks;
  const value = rec(rec(result)?.value);
  const stdout = str(rec(value?.stdout)?.text);
  const stderr = str(rec(value?.stderr)?.text);
  if (stdout || stderr) {
    if (stdout) blocks.push({ title: 'stdout', kind: 'pre', body: stdout });
    if (stderr) blocks.push({ title: 'stderr', kind: 'pre', body: stderr });
    return blocks;
  }
  const text = resultText(result);
  blocks.push({ title: isError ? '错误' : '结果', kind: 'pre', body: text || pretty(value ?? result) });
  return blocks;
}

/**
 * Content of one model round. Persisted `message.completed` keeps text but
 * strips tool-call parts to `{type}` and may truncate reasoning, so the full
 * reasoning comes from `thinking.completed` and the calls from the
 * `tool.execution.started` events that follow the round.
 */
function modelBlocks(message: Json | null, fallbackText: string | null, thinking: string[], calls: string[]): TimelineBlock[] {
  const blocks: TimelineBlock[] = [];
  const parts = Array.isArray(message?.content) ? (message!.content as unknown[]) : [];
  const reasoning: string[] = [];
  const text: string[] = [];
  let bareCalls = 0;
  for (const raw of parts) {
    const p = rec(raw);
    if (!p) continue;
    if (p.type === 'reasoning' && str(p.text)) reasoning.push(String(p.text));
    else if (p.type === 'text' && str(p.text)) text.push(String(p.text));
    else if (p.type === 'tool-call') bareCalls += 1;
  }
  if (!parts.length && fallbackText) text.push(fallbackText);
  const thought = thinking.length ? thinking : reasoning;
  if (thought.length) blocks.push({ title: '思考', kind: 'text', body: thought.join('\n\n') });
  if (text.length) blocks.push({ title: '输出', kind: 'text', body: text.join('\n\n') });
  if (calls.length) blocks.push({ title: '工具调用', kind: 'pre', body: calls.join('\n') });
  else if (bareCalls) blocks.push({ title: '工具调用', kind: 'text', body: `${bareCalls} 次（参数未持久化）` });
  return blocks;
}

const TERMINAL_EVENTS = new Set(['run.completed', 'run.failed', 'run.cancelled']);
const MODEL_OUTPUT_EVENTS = new Set(['thinking.started', 'thinking.delta', 'message.started', 'message.delta']);

export function buildRunTimeline(input: {
  runId: string;
  events: readonly PersistedAgentEvent[];
  tools?: readonly ToolExecutionSnapshot[];
  runLabel?: string;
  userInput?: string | null;
  runKv?: Array<[string, string]>;
  /** Fallbacks when the run has no persisted events yet. */
  startedAt?: string | null;
  finishedAt?: string | null;
  now?: number;
}): RunTimeline {
  const now = input.now ?? Date.now();
  const events = input.events
    .filter((e) => e.run_id === input.runId)
    .slice()
    .sort((a, b) => a.sequence - b.sequence);
  const ledger = new Map<string, ToolExecutionSnapshot>();
  for (const t of input.tools || []) ledger.set(t.tool_call_id, t);

  const firstTs = events.length ? ts(events[0].created_at) : null;
  const start = firstTs ?? ts(input.startedAt) ?? now;
  const terminal = events.find((e) => TERMINAL_EVENTS.has(e.type));
  const end = (terminal && ts(terminal.created_at)) ?? ts(input.finishedAt) ?? now;

  const root: TimelineNode = {
    id: 'run',
    depth: 0,
    kind: 'run',
    name: input.runLabel || '运行',
    start,
    end: terminal || input.finishedAt ? end : null,
    status: terminal?.type === 'run.completed' ? 'ok' : terminal ? 'error' : input.finishedAt ? 'ok' : 'running',
    kv: input.runKv || [],
    blocks: input.userInput ? [{ title: '用户输入', kind: 'text', body: input.userInput }] : [],
  };
  const nodes: TimelineNode[] = [root];

  let running: number | null = null;
  let round: TimelineNode | null = null;
  let roundThinking: string[] = [];
  /**
   * The round that owns tool starts: the open one, else the last closed one.
   * DSH emits `tool.execution.started` just before the round's
   * `message.completed`, so an open round can already have calls.
   */
  let caller: { node: TimelineNode; message: Json | null; text: string | null; thinking: string[]; calls: string[] } | null = null;
  let rounds = 0;
  let lastBoundary = start;
  const toolByCall = new Map<string, TimelineNode>();
  const toolNameByCall = new Map<string, string>();
  const toolArgsByCall = new Map<string, Json | null>();
  const waitByApproval = new Map<string, TimelineNode>();
  let approvals = 0;

  for (const ev of events) {
    const at = ts(ev.created_at) ?? lastBoundary;
    const data = dataOf(ev);
    if (ev.type === 'run.status.changed' && data.to === 'RUNNING' && running == null) {
      running = at;
      if (at - start >= 1) {
        nodes.push({ id: 'queue', depth: 1, kind: 'queue', name: '排队等待', start, end: at, status: 'ok', kv: [], blocks: [] });
      }
      lastBoundary = at;
    } else if (MODEL_OUTPUT_EVENTS.has(ev.type)) {
      if (!round) {
        rounds += 1;
        // A round starts when the model was asked, i.e. right after the previous
        // boundary (run start / tool result), not at its first streamed token.
        round = {
          id: `model-${rounds}`,
          depth: 1,
          kind: 'model',
          name: `模型 · 第 ${rounds} 轮`,
          start: lastBoundary,
          end: null,
          status: 'running',
          kv: [['首个输出', `+${((at - lastBoundary) / 1000).toFixed(1)}s`]],
          blocks: [],
        };
        nodes.push(round);
        caller = { node: round, message: null, text: null, thinking: [], calls: [] };
      }
    } else if (ev.type === 'thinking.completed') {
      if (str(data.text)) roundThinking.push(String(data.text));
    } else if (ev.type === 'message.completed') {
      if (!round) {
        rounds += 1;
        round = { id: `model-${rounds}`, depth: 1, kind: 'model', name: `模型 · 第 ${rounds} 轮`, start: lastBoundary, end: null, status: 'running', kv: [], blocks: [] };
        nodes.push(round);
        caller = { node: round, message: null, text: null, thinking: [], calls: [] };
      }
      const message = rec(data.message);
      round.end = at;
      round.status = 'ok';
      const calls: string[] = caller?.node === round ? caller.calls : [];
      caller = { node: round, message, text: str(data.text), thinking: roundThinking, calls };
      round.blocks = modelBlocks(message, caller.text, caller.thinking, calls);
      roundThinking = [];
      const stop = str(message?.stopReason);
      if (stop) round.kv.push(['结束原因', stop]);
      lastBoundary = at;
      round = null;
    } else if (ev.type === 'tool.execution.started') {
      const callId = str(data.toolCallId) || `tool-${ev.sequence}`;
      const name = str(data.toolName) || 'tool';
      const args = rec(data.args) || rec(data.arguments);
      const row = ledger.get(callId);
      const kv: Array<[string, string]> = [['toolCallId', callId]];
      const risk = str((row as Json | undefined)?.risk_level);
      const source = str((row as Json | undefined)?.tool_source);
      if (risk) kv.push(['风险', risk]);
      if (source) kv.push(['来源', source]);
      const node: TimelineNode = {
        id: `tool-${callId}`,
        depth: 2,
        kind: SUB_TOOLS.has(name) ? 'sub' : 'tool',
        name: toolLabel(name, args || rec(row?.arguments)),
        start: at,
        end: null,
        status: 'running',
        kv,
        blocks: toolBlocks(name, args || rec(row?.arguments), undefined, false),
      };
      toolByCall.set(callId, node);
      toolNameByCall.set(callId, name);
      if (caller) {
        const callArgs = args || rec(row?.arguments);
        caller.calls.push(`${name}(${callArgs ? JSON.stringify(callArgs) : ''})`);
        caller.node.blocks = modelBlocks(caller.message, caller.text, caller.thinking, caller.calls);
      }
      toolArgsByCall.set(callId, args || rec(row?.arguments));
      nodes.push(node);
    } else if (ev.type === 'tool.execution.completed' || ev.type === 'tool.execution.failed') {
      const callId = str(data.toolCallId) || '';
      const node = toolByCall.get(callId);
      if (!node) continue;
      const row = ledger.get(callId);
      const name = toolNameByCall.get(callId) || 'tool';
      const result = data.result ?? row?.result_json;
      const isError = ev.type === 'tool.execution.failed' || rec(result)?.isError === true || data.isError === true;
      node.end = at;
      node.status = isError ? 'error' : 'ok';
      const exitCode = rec(rec(result)?.value)?.exitCode;
      if (typeof exitCode === 'number') node.kv.push(['退出码', String(exitCode)]);
      node.blocks = toolBlocks(name, toolArgsByCall.get(callId) ?? null, result, isError);
      lastBoundary = at;
    } else if (ev.type === 'approval.requested') {
      approvals += 1;
      const id = str(data.approvalId) || `approval-${ev.sequence}`;
      const toolName = str(data.toolName) || '工具';
      const node: TimelineNode = {
        id: `wait-${id}`,
        depth: 2,
        kind: 'wait',
        name: `审批等待 · ${toolName}`,
        start: at,
        end: null,
        status: 'waiting',
        kv: [['审批 ID', id], ...(str(data.riskLevel) ? [['风险', String(data.riskLevel)] as [string, string]] : [])],
        blocks: [],
      };
      const call = str(data.toolCallId);
      const tool = call ? toolByCall.get(call) : null;
      if (tool) node.blocks = tool.blocks.slice(0, 1);
      waitByApproval.set(id, node);
      nodes.push(node);
    } else if (ev.type === 'approval.resolved') {
      const node = waitByApproval.get(str(data.approvalId) || '');
      if (!node) continue;
      const approved = data.decision === 'approve' || data.status === 'APPROVED';
      node.end = at;
      node.status = approved ? 'approved' : 'rejected';
      node.kv.push(['决定', approved ? '批准' : '拒绝'], ['等待', `${((at - node.start) / 1000).toFixed(1)}s`]);
      if (str(data.decisionBy)) node.kv.push(['决定人', String(data.decisionBy)]);
      if (str(data.reason)) node.blocks.push({ title: '理由', kind: 'text', body: String(data.reason) });
      lastBoundary = at;
    }
  }

  // The last round that called no tools is the final answer.
  const lastModel = [...nodes].reverse().find((n) => n.kind === 'model');
  if (lastModel && lastModel.status === 'ok' && !lastModel.blocks.some((b) => b.title === '工具调用')) {
    lastModel.name += '（最终回答）';
  }

  return {
    nodes,
    start,
    end: Math.max(end, ...nodes.map((n) => n.end ?? n.start)),
    modelRounds: rounds,
    toolCalls: toolByCall.size,
    approvals,
  };
}

export function formatSpan(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(Math.round(s % 60)).padStart(2, '0')}s`;
}
