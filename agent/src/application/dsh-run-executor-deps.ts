/**
 * PiRunExecutor 的依赖面与三个纯判定。
 *
 * 这三个方法原本是 PiRunExecutor 的私有方法，但**一个都不读 `this`**——
 * 它们只对传进来的参数做判断。留在那个 1600 行的类里，既看不出它们可以
 * 单测，也让类的可变状态看起来比实际更多。
 */

import { RUN_STATUS } from '../domain/run/run-status.js';
import type { PlatformEventProjector } from '../infrastructure/dsh/event-projector.js';
import type { SessionRecoveryService } from './session-recovery-service.js';
import { sanitizeStatusReason } from './sanitize-status-reason.js';

/**
 * PiRunExecutor 的依赖面。
 *
 * 抽成具名类型是因为它原本被写了两遍——构造器一份、`createPiRunExecutorFactory`
 * 一份——而工厂那份已经漂移成更弱的版本：transactionManager / sessionLockManager /
 * piRuntimeFactory / sessionAdapter 退化成 `any`，toolBudget 少了
 * runDeadlineMs。工厂只是把 opts 原样转给构造器，两份声明本就该是同一份。
 */
export interface DshRunExecutorDeps {
  transactionManager: { run: (fn: (trx: any) => Promise<any>) => Promise<any> };
  createRepositories: (db: any) => any;
  sessionLockManager: {
    acquire: (agentSessionId: string, ownerToken: string) => Promise<boolean>;
    renew: (agentSessionId: string, ownerToken: string) => Promise<boolean>;
    release: (agentSessionId: string, ownerToken: string) => Promise<boolean>;
    renewIntervalMs?: number;
  };
  piRuntimeFactory: { create: (input: Record<string, any>) => Promise<any> };
  sessionAdapter?: { captureSnapshotPayload: Function; dispose?: Function };
  modelResolver: (
    agentVersion: Record<string, any>,
    selection?: { modelId?: string | null },
  ) => Record<string, any> | Promise<Record<string, any>>;
  promptImageLoader?: (
    input: Record<string, any>,
  ) => Promise<Array<{ type: 'image'; data: string; mimeType: string }>>;
  requestAuthResolver?: (
    model: Record<string, any>,
    agentVersion: Record<string, any>,
  ) => Record<string, any> | Promise<Record<string, any>>;
  workspaceResolver: (agentSession: Record<string, any>) => string | Promise<string>;
  sandboxSessionProvisioner?: {
    ensure: (input: Record<string, any>) => Promise<Record<string, any>>;
  };
  generateId: () => string;
  now?: () => Date;
  projector?: PlatformEventProjector;
  recoveryService?: SessionRecoveryService;
  sessionLockRenewIntervalMs?: number;
  skillRootsForRun?: (identity: Record<string, any>) => string[];
  /**
   * 运维层风险表（`config/agent/tool-risk.json` / `TOOL_RISK_POLICY_*` 经
   * `resolveToolRiskPolicy` 解析）。2026-08-31 之前这个字段被设在这里，
   * 而 `runtime-factory` 读的是**它自己的** opts——两边不是同一个对象，
   * 于是整张表零效果且无人报错（计划 H8）。现在由 executor 合并租户层之后
   * 按 Run 传进 `create()`。
   */
  riskOverrides?: unknown;
  /** 子 Agent 的 durable 面（ADR 0009 D6 / 计划 H5）。 */
  subagentSpawnPort?: {
    spawn: (input: Record<string, unknown>) => Promise<unknown>;
    getStatuses: (input: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
  };
  eventProjectionMode?: 'session-subscribe' | 'observability' | 'both';
  steerPollIntervalMs?: number;
  toolBudget?: {
    maxToolCalls?: number;
    maxIdenticalToolCalls?: number;
    maxModelTurns?: number;
    runDeadlineMs?: number;
  };
}

export type PiRunExecutorDeps = DshRunExecutorDeps;

/** 工厂比构造器多收一个 extensionFactories，其余完全一致。 */
export type DshRunExecutorFactoryOptions = DshRunExecutorDeps & {
  extensionFactories?: unknown[];
};

export type PiRunExecutorFactoryOptions = DshRunExecutorFactoryOptions;

export function looksLikeUncertainSideEffect(err: unknown) {
  const msg = String((err as Error)?.message || err || '');
  return /side.?effect|tool.*uncertain|partial.*tool|mid-tool/i.test(msg);
}

/**
 * Pi reports some terminal runtime failures in an assistant entry instead
 * of rejecting `session.prompt()`. Convert those terminal markers into the
 * RunExecutor contract before ExecuteRunService commits the Run status.
 *
 * Only the **last** new assistant message for this prompt decides the
 * outcome. Intermediate `stopReason=error` entries are common when the
 * provider hits a transient "Connection error" and Pi retries within the
 * same prompt — those must not poison a later successful turn that ends
 * with `stop` / `toolUse` / etc.
 *
 * @param payload
 * @param priorEntryIds
 * @returns {import('./run-executor.js').RunExecutorResult | null}
 */
export function terminalOutcomeFromNewAssistantEntries(payload: { entries?: Record<string, any>[] }, priorEntryIds: Set<string>) {
  const prior = priorEntryIds instanceof Set ? priorEntryIds : new Set();
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];

  let lastNewAssistant: { stopReason: string, message: Record<string, unknown> } | null = null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.type !== 'message') continue;
    if (typeof entry.id !== 'string' || !entry.id || prior.has(entry.id)) {
      continue;
    }
    const message = entry.message;
    if (!message || message.role !== 'assistant') continue;

    lastNewAssistant = {
      stopReason: String(message.stopReason ?? '')
        .trim()
        .toLowerCase(),
      message: (message as Record<string, unknown>),
    };
    // First hit walking reverse = latest new assistant for this prompt.
    break;
  }

  if (!lastNewAssistant) return null;

  const { stopReason, message } = lastNewAssistant;
  if (stopReason === 'error') {
    const runtimeDetail = sanitizeStatusReason(
      message.errorMessage ??
        (message.error as { message?: unknown })?.message ??
        message.error,
    );
    return {
      outcome: RUN_STATUS.FAILED,
      statusReason: runtimeDetail
        ? `Pi runtime completed with assistant stopReason=error: ${runtimeDetail}`
        : 'Pi runtime completed with assistant stopReason=error',
    };
  }
  if (
    stopReason === 'aborted' ||
    stopReason === 'interrupted' ||
    stopReason === 'cancelled' ||
    stopReason === 'canceled'
  ) {
    return {
      outcome: RUN_STATUS.CANCELLED,
      statusReason: `Pi runtime completed with assistant stopReason=${stopReason}`,
    };
  }

  return null;
}

/**
 * Fail closed unless triggering message is owned by this run/conversation/session.
 * conversationId, agentSessionId, and runId must all be present and strictly equal.
 * @param triggering
 * @param run
 */
export function assertTriggeringMessageBinding(triggering: Record<string, any> | null, run: Record<string, any>) {
  if (!triggering) {
    throw new Error('triggering message is required');
  }
  if (
    triggering.conversationId == null ||
    triggering.conversationId !== run.conversationId
  ) {
    throw new Error('triggering message conversationId does not match run');
  }
  if (
    triggering.agentSessionId == null ||
    triggering.agentSessionId !== run.agentSessionId
  ) {
    throw new Error('triggering message agentSessionId does not match run');
  }
  if (triggering.runId == null || triggering.runId !== run.runId) {
    throw new Error('triggering message runId does not match run');
  }
}
