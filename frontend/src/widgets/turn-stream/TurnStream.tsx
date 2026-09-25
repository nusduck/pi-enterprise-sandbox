/**
 * Linear rendering of one Run: thinking, text segments and tool activity in
 * event order (projectTurnItems). Replaces the collapsed step tree that used
 * to sit above a merged answer bubble.
 */
import { useMemo, useState } from 'react';
import type {
  ApprovalEntity,
  ArtifactEntity,
  ProcessEntity,
  ToolExecutionEntity,
} from '../../entities/types';
import { isTerminalRunStatus } from '../../entities';
import { useChat } from '../../features/chat/ChatContext';
import { useWorkbenchSelection } from '../../app/layout/WorkbenchSelectionContext';
import { projectTurnItems, runHasTurnEntities, type TurnItem } from '../../features/chat/projections/turnItems';

export { runHasTurnEntities };
import { MarkdownBody } from '../markdown/Markdown';
import {
  ApprovalCard,
  ArtifactCard,
  JobCard,
  QuestionCard,
  SubtaskCard,
  ThinkingItem,
  TodoCard,
  ToolGroupItem,
} from './TurnCards';
import s from './turnStream.module.css';

function itemTools(item: TurnItem): ToolExecutionEntity[] {
  switch (item.kind) {
    case 'tools':
    case 'subtasks':
      return item.tools;
    case 'remote':
    case 'question':
    case 'artifact':
    case 'todo':
      return [item.tool];
    case 'job':
      return [item.tool, ...item.related];
    default:
      return [];
  }
}

function balanceMarkdown(text: string): string {
  // A streaming chunk can end inside **bold**; close it so the rest of the
  // segment does not render as one bold run until the next token arrives.
  const stars = (text.match(/\*\*/g) || []).length;
  return stars % 2 === 1 ? `${text}**` : text;
}

export function TurnStream({ runId }: { runId: string }) {
  const { entityStore, resolveApproval, respondInteraction, activeSessionId } = useChat();
  const { openProcessConsole } = useWorkbenchSelection();
  const [busyApproval, setBusyApproval] = useState<string | null>(null);

  const run = entityStore.runsById[runId];
  const runActive = Boolean(run && !isTerminalRunStatus(String(run.status)));
  const items = useMemo(() => projectTurnItems(entityStore, runId), [entityStore, runId]);

  const related = useMemo(() => {
    const approvals: ApprovalEntity[] = [];
    const processesByTool = new Map<string, ProcessEntity>();
    const loneProcesses: ProcessEntity[] = [];
    const artifacts: ArtifactEntity[] = [];
    for (const a of Object.values(entityStore.approvalsById)) if (a.runId === runId) approvals.push(a);
    for (const p of Object.values(entityStore.processesById)) {
      if (p.runId !== runId) continue;
      if (p.toolExecutionId && entityStore.toolExecutionsById[p.toolExecutionId]) processesByTool.set(p.toolExecutionId, p);
      else loneProcesses.push(p);
    }
    for (const a of Object.values(entityStore.artifactsById)) if (a.runId === runId) artifacts.push(a);
    return { approvals, processesByTool, loneProcesses, artifacts };
  }, [entityStore, runId]);

  async function decide(id: string, decision: 'approve' | 'reject') {
    setBusyApproval(id);
    try {
      await resolveApproval(id, decision);
    } finally {
      setBusyApproval(null);
    }
  }

  // Attach each approval to the item whose tool it gates; the rest trail the turn.
  const approvalsByItem = new Map<number, ApprovalEntity[]>();
  const placed = new Set<string>();
  items.forEach((item, idx) => {
    for (const tool of itemTools(item)) {
      for (const a of related.approvals) {
        if (placed.has(a.id)) continue;
        if (a.toolExecutionId === tool.id || tool.approvalId === a.id) {
          approvalsByItem.set(idx, [...(approvalsByItem.get(idx) || []), a]);
          placed.add(a.id);
        }
      }
    }
  });
  const loneApprovals = related.approvals.filter((a) => !placed.has(a.id));

  // Match each submit_artifact call to its artifact (by id, else by name);
  // artifacts no call claims trail the turn.
  const artifactByItem = new Map<number, ArtifactEntity>();
  const claimed = new Set<string>();
  items.forEach((item, idx) => {
    if (item.kind !== 'artifact') return;
    const input = item.tool.input as Record<string, unknown> | null;
    const name = typeof input?.name === 'string' ? input.name : null;
    const match = (item.artifactId && entityStore.artifactsById[item.artifactId])
      || related.artifacts.find((a) => !claimed.has(a.id) && name != null && a.name === name);
    if (match) {
      artifactByItem.set(idx, match);
      claimed.add(match.id);
    }
  });
  const trailingArtifacts = related.artifacts.filter((a) => !claimed.has(a.id));

  // Background jobs also show up as sandbox processes (no tool link); pair
  // them by command so the job card carries the real state and console.
  const processByJob = new Map<number, ProcessEntity>();
  const pairedProcesses = new Set<string>();
  items.forEach((item, idx) => {
    if (item.kind !== 'job') return;
    const command = (item.tool.input as Record<string, unknown> | null)?.command;
    const match = related.loneProcesses.find((p) => !pairedProcesses.has(p.id) && p.command === command);
    if (match) {
      processByJob.set(idx, match);
      pairedProcesses.add(match.id);
    }
  });

  function approvalCards(list: ApprovalEntity[] | undefined) {
    return (list || []).map((a) => (
      <ApprovalCard
        key={a.id}
        approval={a}
        tool={a.toolExecutionId ? entityStore.toolExecutionsById[a.toolExecutionId] || null : null}
        busy={busyApproval === a.id}
        onDecide={(id, decision) => void decide(id, decision)}
      />
    ));
  }

  function render(item: TurnItem, idx: number) {
    switch (item.kind) {
      case 'thinking':
        return <ThinkingItem text={item.message.thinking} streaming={item.message.thinkingStatus === 'streaming'} />;
      case 'text':
        return <MarkdownBody text={balanceMarkdown(item.message.text)} />;
      case 'tools':
        return (
          <ToolGroupItem
            tools={item.tools}
            steps={item.steps}
            processesByTool={related.processesByTool}
            onOpenConsole={openProcessConsole}
          />
        );
      case 'subtasks':
        return <SubtaskCard tools={item.tools} />;
      case 'remote':
        return <SubtaskCard tools={[item.tool]} remote />;
      case 'todo':
        return <TodoCard tool={item.tool} />;
      case 'question':
        return <QuestionCard tool={item.tool} pending={run?.pendingInput ?? null} onRespond={respondInteraction} />;
      case 'job':
        return (
          <JobCard
            tool={item.tool}
            related={item.related}
            jobId={item.jobId}
            runActive={runActive}
            process={processByJob.get(idx) || null}
            onOpenConsole={openProcessConsole}
          />
        );
      case 'artifact': {
        const artifact = artifactByItem.get(idx);
        if (!artifact) return <ToolGroupItem tools={[item.tool]} processesByTool={related.processesByTool} />;
        return <ArtifactCard artifact={artifact} sessionId={activeSessionId} />;
      }
      default:
        return null;
    }
  }

  const rendered = items.map((item, idx) => (
    <div key={`${item.kind}-${item.seq ?? 'x'}-${idx}`} className={s.item}>
      {render(item, idx)}
      {approvalCards(approvalsByItem.get(idx))}
    </div>
  ));

  return (
    <div className={s.stream}>
      {rendered}
      {related.loneProcesses.filter((p) => !pairedProcesses.has(p.id)).map((p) => (
        <div key={p.id} className={s.item}>
          <div className={s.card}>
            <div className={s.cardH}>
              <span className={s.kind}>进程</span>
              <span className={s.arg}>{p.command || p.id}</span>
              <span className={s.sp} />
              <button type="button" className={s.linkBtn} onClick={() => openProcessConsole(p.id)}>控制台</button>
            </div>
          </div>
        </div>
      ))}
      {loneApprovals.length ? <div className={s.item}>{approvalCards(loneApprovals)}</div> : null}
      {run?.status === 'waiting_approval' && related.approvals.length === 0 ? (
        <div className={s.item}>
          <div className={`${s.card} ${s.approval}`} role="status">
            <div className={s.cardH}><b>等待审批</b></div>
            <div className={s.cardB}>这次运行在等待审批，但审批详情还没有加载。刷新页面后可以在这里处理。</div>
          </div>
        </div>
      ) : null}
      {trailingArtifacts.map((a) => (
        <div key={a.id} className={s.item}>
          <ArtifactCard artifact={a} sessionId={activeSessionId} />
        </div>
      ))}
      {runActive && !items.length ? (
        <div className={s.live}><span className={s.spin} aria-hidden="true" />正在思考…</div>
      ) : null}
    </div>
  );
}
