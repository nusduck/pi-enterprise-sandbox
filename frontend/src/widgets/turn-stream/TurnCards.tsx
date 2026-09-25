/**
 * Cards for the linear turn stream. Each renders one TurnItem kind; state and
 * side effects (approve, answer) come from TurnStream through props.
 */
import { useState, type ReactNode } from 'react';
import type {
  ApprovalEntity,
  ArtifactEntity,
  ProcessEntity,
  RunEntity,
  ToolExecutionEntity,
} from '../../entities/types';
import { getArtifactDownloadUrl } from '../../shared/api/client';
import { isDurableArtifactId } from '../../shared/state/runReducer';
import { downloadAttrName, safeApiUrl } from '../../shared/security/url';
import { summarizeToolInput } from '../runtime-timeline/buildTimeline';
import { formatToolInputDisplay, formatToolResultDisplay } from '../message-list/formatToolDisplay';
import { parseTodoFields } from '../runtime-steps/taskStateFields';
import { MarkdownBody } from '../markdown/Markdown';
import {
  formatDurationMs,
  jobFields,
  questionFields,
  subtaskFields,
  summarizeToolGroup,
  toolDurationMs,
  toolVerb,
} from '../../features/chat/projections/turnFields';
import type { ToolStep } from '../../features/chat/projections/turnItems';
import { usePreference } from '../../shared/ui/preferences';
import s from './turnStream.module.css';

export function Chevron() {
  return (
    <svg className={s.chev} viewBox="0 0 10 10" aria-hidden="true">
      <path d="M3 1.5 6.5 5 3 8.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function Spinner() {
  return <span className={s.spin} aria-hidden="true" />;
}

type Tone = 'ok' | 'err' | 'warn' | 'run' | 'mute';

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`${s.pill} ${s[tone]}`}>{children}</span>;
}

function isLive(status: string): boolean {
  return status === 'running' || status === 'prepared';
}

function toolTone(tool: ToolExecutionEntity): { tone: Tone; label: string } {
  if (tool.status === 'waiting_approval') return { tone: 'warn', label: '等待审批' };
  if (isLive(tool.status)) return { tone: 'run', label: '进行中' };
  if (tool.isError || tool.status === 'failed') return { tone: 'err', label: '失败' };
  if (tool.status === 'cancelled') return { tone: 'mute', label: '已取消' };
  return { tone: 'ok', label: '完成' };
}

function clip(value: string, max = 6000): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

// ── thinking ─────────────────────────────────────────────────────────

export function ThinkingItem({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <details className={s.act} open={streaming || undefined}>
      <summary>
        <Chevron />
        {streaming ? <><Spinner />思考中…</> : '思考过程'}
      </summary>
      <div className={`${s.actBody} ${s.thinking}`}>{text}</div>
    </details>
  );
}

// ── ordinary tool groups ─────────────────────────────────────────────

function ToolLine({
  tool,
  process,
  onOpenConsole,
}: {
  tool: ToolExecutionEntity;
  process: ProcessEntity | null;
  onOpenConsole?: (processId: string) => void;
}) {
  const { tone } = toolTone(tool);
  const input = formatToolInputDisplay(tool.input);
  const output = tool.result != null ? formatToolResultDisplay(tool.result) : '';
  return (
    <details className={s.step}>
      <summary>
        <span className={s.verb}>{toolVerb(tool.name)}</span>
        <span className={s.arg}>{summarizeToolInput(tool.input) || tool.name}</span>
        {isLive(tool.status) ? <Spinner /> : null}
        {tone === 'err' ? <span className={s.errText}>失败</span> : null}
        <span className={s.dur}>{formatDurationMs(toolDurationMs([tool]))}</span>
      </summary>
      {input ? (
        <div className={s.io}>
          <div className={s.lbl}>参数</div>
          <pre>{clip(input)}</pre>
        </div>
      ) : null}
      {output ? (
        <div className={s.io}>
          <div className={s.lbl}>{tone === 'err' ? '错误' : '结果'}</div>
          <pre>{clip(output)}</pre>
        </div>
      ) : null}
      {process && onOpenConsole ? (
        <button type="button" className={s.linkBtn} onClick={() => onOpenConsole(process.id)}>
          打开进程控制台
        </button>
      ) : null}
    </details>
  );
}

function ThinkingStep({ text }: { text: string }) {
  return (
    <details className={s.step}>
      <summary>
        <span className={s.verb}>思考</span>
        <span className={`${s.arg} ${s.thinkArg}`}>{text.replace(/\s+/g, ' ')}</span>
      </summary>
      <div className={s.thinking}>{text}</div>
    </details>
  );
}

export function ToolGroupItem({
  tools,
  steps,
  processesByTool,
  onOpenConsole,
}: {
  tools: ToolExecutionEntity[];
  steps?: ToolStep[];
  processesByTool: Map<string, ProcessEntity>;
  onOpenConsole?: (processId: string) => void;
}) {
  const ordered: ToolStep[] = steps || tools.map((tool) => ({ kind: 'tool', tool }));
  const live = tools.find((t) => isLive(t.status));
  const failed = tools.filter((t) => t.isError || t.status === 'failed').length;
  const [density] = usePreference('density');
  return (
    <details className={s.act} open={density === 'expanded' || undefined}>
      <summary>
        <Chevron />
        {live ? (
          <>
            <Spinner />
            <span>正在{toolVerb(live.name)} <span className={s.inlineArg}>{summarizeToolInput(live.input)}</span></span>
          </>
        ) : (
          <span>{summarizeToolGroup(tools)}</span>
        )}
        {failed ? <span className={s.errText}>· {failed} 个失败</span> : null}
        {!live ? <span className={s.dur}>{formatDurationMs(toolDurationMs(tools))}</span> : null}
      </summary>
      <div className={s.actBody}>
        {ordered.map((step) =>
          step.kind === 'thinking' ? (
            <ThinkingStep key={`think-${step.message.id}`} text={step.message.thinking} />
          ) : (
            <ToolLine
              key={step.tool.id}
              tool={step.tool}
              process={processesByTool.get(step.tool.id) || null}
              onOpenConsole={onOpenConsole}
            />
          ),
        )}
      </div>
    </details>
  );
}

// ── approvals ────────────────────────────────────────────────────────

export function ApprovalCard({
  approval,
  tool,
  busy,
  onDecide,
}: {
  approval: ApprovalEntity;
  tool: ToolExecutionEntity | null;
  busy: boolean;
  onDecide: (id: string, decision: 'approve' | 'reject') => void;
}) {
  const pending = approval.status === 'pending';
  // An approval can arrive before its tool starts; the reducer then keeps the
  // tool name in `command`, which reads better as an action.
  const command = approval.command;
  const what = tool
    ? `${toolVerb(tool.name)} ${summarizeToolInput(tool.input)}`.trim()
    : command && /^[a-z][a-z0-9_]*$/i.test(command) ? toolVerb(command) : command || '工具调用';
  if (!pending) {
    const label = approval.status === 'approved' ? '已批准' : approval.status === 'rejected' ? '已拒绝' : '审批已失效';
    return (
      <div className={s.resolved}>
        <Pill tone={approval.status === 'approved' ? 'ok' : 'mute'}>{label}</Pill>
        <span className={s.arg}>{what}</span>
      </div>
    );
  }
  const args = tool ? formatToolInputDisplay(tool.input) : approval.command || '';
  return (
    <div className={`${s.card} ${s.approval}`} role="group" aria-label="需要你批准">
      <div className={s.cardH}>
        <b>需要你批准</b>
        <span className={s.sp} />
        {approval.risk ? <Pill tone="warn">{approval.risk} 风险</Pill> : null}
      </div>
      <div className={s.cardB}>
        <div>{what}</div>
        {approval.reason ? <div className={s.muted}>{approval.reason}</div> : null}
        {args && args !== what ? <pre className={s.pre}>{clip(args, 2000)}</pre> : null}
      </div>
      <div className={s.actions}>
        <button type="button" className={s.btnPri} disabled={busy} onClick={() => onDecide(approval.id, 'approve')}>
          批准
        </button>
        <button type="button" className={s.btn} disabled={busy} onClick={() => onDecide(approval.id, 'reject')}>
          拒绝
        </button>
        <span className={s.muted}>本轮会等你决定后继续</span>
      </div>
    </div>
  );
}

// ── sub-tasks ────────────────────────────────────────────────────────

function SubtaskRow({ tool, remote }: { tool: ToolExecutionEntity; remote?: boolean }) {
  const f = subtaskFields(tool);
  const { tone, label } = toolTone(tool);
  const who = remote
    ? `远程委派 → ${f.agent || '外部智能体'}`
    : f.agent
      ? `委派 → @${f.agent}`
      : '子代理 · 同一智能体';
  return (
    <details className={s.sub}>
      <summary>
        <Chevron />
        <span className={s.subTitle}>
          {f.title}
          <span className={s.who}>
            {who}
            {remote ? <span className={s.tag}>A2A</span> : null}
          </span>
        </span>
        <Pill tone={f.rejected ? 'mute' : tone}>{f.rejected ? '已拒绝' : label}</Pill>
        <span className={s.dur}>{formatDurationMs(toolDurationMs([tool]))}</span>
      </summary>
      <div className={s.subBody}>
        {f.prompt ? <div className={s.brief}>{clip(f.prompt, 400)}</div> : null}
        {f.conclusion ? (
          <div className={s.result}>
            <b>结论</b>
            <MarkdownBody text={clip(f.conclusion, 8000)} />
          </div>
        ) : null}
        {f.error ? <div className={s.errText}>{f.error}</div> : null}
        {f.childRunId ? <div className={s.muted}>子 Run · <code>{f.childRunId}</code></div> : null}
      </div>
    </details>
  );
}

export function SubtaskCard({ tools, remote }: { tools: ToolExecutionEntity[]; remote?: boolean }) {
  const live = tools.filter((t) => isLive(t.status) || t.status === 'waiting_approval').length;
  const failed = tools.filter((t) => t.isError || t.status === 'failed').length;
  const kind = remote ? '远程委派' : tools.length > 1 ? '并行子任务' : '子任务';
  return (
    <div className={s.card}>
      <div className={s.cardH}>
        <span className={s.kind}>{kind}</span>
        <span className={s.sp} />
        {live ? (
          <Pill tone="run">{live} 个进行中</Pill>
        ) : failed ? (
          <Pill tone="err">{failed} 个失败</Pill>
        ) : (
          <Pill tone="ok">{tools.length > 1 ? `${tools.length} 个全部完成` : '完成'}</Pill>
        )}
      </div>
      {tools.map((tool) => (
        <SubtaskRow key={tool.id} tool={tool} remote={remote} />
      ))}
    </div>
  );
}

// ── todo list ────────────────────────────────────────────────────────

export function TodoCard({ tool }: { tool: ToolExecutionEntity }) {
  const { todos } = parseTodoFields(tool.input, tool.result);
  if (!todos.length) return null;
  const done = todos.filter((t) => t.status === 'completed').length;
  return (
    <div className={s.card}>
      <div className={s.cardH}>
        <span className={s.kind}>任务清单</span>
        <span className={s.sp} />
        <span className={s.muted}>{done} / {todos.length}</span>
      </div>
      <ul className={s.todo}>
        {todos.map((t) => (
          <li key={t.position} className={t.status === 'completed' ? s.done : t.status === 'in_progress' ? s.doing : undefined}>
            <span className={s.box} aria-hidden="true">{t.status === 'completed' ? '✓' : ''}</span>
            {t.content}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── ask_user_question ────────────────────────────────────────────────

export function QuestionCard({
  tool,
  pending,
  onRespond,
}: {
  tool: ToolExecutionEntity;
  pending: RunEntity['pendingInput'];
  onRespond: (response: unknown) => Promise<boolean>;
}) {
  const waiting = Boolean(pending) && isLive(tool.status);
  const parsed = questionFields(tool, waiting ? pending : null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  // Run events do not carry the answer (only the tool ledger does), so keep
  // what this card sent until a refresh restores it from the ledger.
  const [sent, setSent] = useState<string | null>(null);
  const f = { ...parsed, answer: parsed.answer ?? sent };

  async function submit(value: string) {
    if (busy || !value) return;
    setBusy(true);
    try {
      if (await onRespond(value)) {
        setDraft('');
        setSent(value);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`${s.card}${waiting ? ` ${s.approval}` : ''}`} role="group" aria-label={f.question}>
      <div className={s.cardH}>
        <span className={s.kind}>{waiting ? '需要你回答' : '提问'}</span>
        {f.header ? <b>{f.header}</b> : null}
        <span className={s.sp} />
        {!waiting && f.answer ? <Pill tone="ok">已回答</Pill> : null}
      </div>
      <div className={s.cardB}>{f.question}</div>
      {f.options.length ? (
        <div className={s.options}>
          {f.options.map((o) => (
            <button
              key={o.label}
              type="button"
              className={`${s.option}${f.answer === o.label ? ` ${s.selected}` : ''}`}
              disabled={!waiting || busy}
              onClick={() => void submit(o.label)}
            >
              <span>{o.label}</span>
              {o.description ? <small>{o.description}</small> : null}
            </button>
          ))}
        </div>
      ) : null}
      {waiting ? (
        <div className={s.actions}>
          <input
            className={s.input}
            value={draft}
            placeholder={f.options.length ? '或者输入其他回答…' : '输入你的回答…'}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && draft.trim()) {
                e.preventDefault();
                void submit(draft.trim());
              }
            }}
          />
          <button type="button" className={s.btnPri} disabled={busy || !draft.trim()} onClick={() => void submit(draft.trim())}>
            提交
          </button>
        </div>
      ) : f.answer && !f.options.some((o) => o.label === f.answer) ? (
        <div className={s.cardB}><span className={s.muted}>回答：</span>{f.answer}</div>
      ) : null}
    </div>
  );
}

// ── background jobs ──────────────────────────────────────────────────

export function JobCard({
  tool,
  related,
  jobId,
  runActive,
  process,
  onOpenConsole,
}: {
  tool: ToolExecutionEntity;
  related: ToolExecutionEntity[];
  jobId: string | null;
  runActive: boolean;
  /** The sandbox process behind this job, matched by command, when listed. */
  process: ProcessEntity | null;
  onOpenConsole?: (processId: string) => void;
}) {
  const f = jobFields(tool, related);
  // Prefer the sandbox's own process state; job_output is only a snapshot the
  // model happened to take. Without either, all we know is that it started.
  const running = process
    ? process.status === 'running' || process.status === 'created' || process.status === 'waiting_input'
    : f.running;
  const tail = f.outputTail || (process ? [process.stdout, process.stderr].filter(Boolean).join('\n').trim().split('\n').slice(-6).join('\n') : null);
  return (
    <div className={s.card}>
      <div className={s.cardH}>
        <span className={s.kind}>后台任务</span>
        <span className={s.arg}>{f.description || f.command || jobId || 'bash'}</span>
        <span className={s.sp} />
        {running && runActive ? (
          <Pill tone="run"><Spinner />运行中</Pill>
        ) : running === false ? (
          <Pill tone="mute">已结束</Pill>
        ) : running == null ? (
          <Pill tone="mute">已在后台启动</Pill>
        ) : (
          <Pill tone="run">运行中</Pill>
        )}
        {process && onOpenConsole ? (
          <button type="button" className={s.linkBtn} onClick={() => onOpenConsole(process.id)}>控制台</button>
        ) : null}
      </div>
      {f.command ? <pre className={s.pre}>{clip(f.command, 1000)}</pre> : null}
      {tail ? <pre className={`${s.pre} ${s.tail}`}>{tail}</pre> : null}
    </div>
  );
}

// ── artifacts ────────────────────────────────────────────────────────

function formatSize(n: number | null): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function extLabel(name: string, mime: string | null): string {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1];
  if (ext) return ext.toUpperCase();
  return mime?.split('/')[1]?.slice(0, 4).toUpperCase() || 'FILE';
}

export function ArtifactCard({
  artifact,
  sessionId,
}: {
  artifact: ArtifactEntity;
  sessionId: string | null;
}) {
  const sid = sessionId || artifact.sessionId;
  const durable = isDurableArtifactId(artifact.id, artifact.runId || '');
  const url = safeApiUrl(sid && durable ? getArtifactDownloadUrl(sid, artifact.id) : null);
  const name = artifact.name || artifact.path || '产物';
  const isImage = Boolean(url && artifact.mimeType?.startsWith('image/') && artifact.mimeType !== 'image/svg+xml');
  return (
    <div className={s.artWrap}>
      {isImage && url ? (
        <a className={s.imgLink} href={url} target="_blank" rel="noopener noreferrer">
          <img src={url} alt={name} loading="lazy" />
        </a>
      ) : null}
      <div className={s.art}>
        <span className={s.artIc}>{extLabel(name, artifact.mimeType)}</span>
        <span className={s.artName}>
          {name}
          <small>{[artifact.mimeType, formatSize(artifact.size)].filter(Boolean).join(' · ') || '交付物'}</small>
        </span>
        {url ? (
          <a className={s.btn} href={url} download={downloadAttrName(artifact.name, artifact.path)}>
            下载
          </a>
        ) : null}
      </div>
    </div>
  );
}
