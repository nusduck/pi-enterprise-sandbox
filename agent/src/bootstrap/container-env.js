/**
 * Environment and wiring helpers for the service container.
 *
 * Pure resolution of what the process was configured with — Pi agent dir,
 * MySQL/Redis URLs, per-run skill roots, the repository bundle, the worker
 * executor factory — plus the production token assertion that fails closed.
 * No service construction and no I/O beyond ensuring the agent dir exists.
 */

import { OrganizationRepository } from '../infrastructure/mysql/repositories/organization-repository.js';
import { ExternalReferenceRepository } from '../infrastructure/mysql/repositories/external-reference-repository.js';
import { AgentCatalogRepository } from '../infrastructure/mysql/repositories/agent-catalog-repository.js';
import { ConversationRepository } from '../infrastructure/mysql/repositories/conversation-repository.js';
import { AgentSessionRepository } from '../infrastructure/mysql/repositories/agent-session-repository.js';
import { AgentSessionSnapshotRepository } from '../infrastructure/mysql/repositories/agent-session-snapshot-repository.js';
import { MessageRepository } from '../infrastructure/mysql/repositories/message-repository.js';
import { PiSessionJournalRepository } from '../infrastructure/mysql/repositories/pi-session-journal-repository.js';
import { RunRepository } from '../infrastructure/mysql/repositories/run-repository.js';
import { RunEventRepository } from '../infrastructure/mysql/repositories/run-event-repository.js';
import { TraceSpanRepository } from '../infrastructure/mysql/repositories/trace-span-repository.js';
import { IdempotencyRepository } from '../infrastructure/mysql/repositories/idempotency-repository.js';
import { ToolExecutionRepository } from '../infrastructure/mysql/repositories/tool-execution-repository.js';
import { ApprovalRepository } from '../infrastructure/mysql/repositories/approval-repository.js';
import { InteractionRepository } from '../infrastructure/mysql/repositories/interaction-repository.js';
import { TaskStateRepository } from '../infrastructure/mysql/repositories/task-state-repository.js';
import { SandboxAuditEventRepository } from '../infrastructure/mysql/repositories/sandbox-audit-event-repository.js';
import { A2aCredentialRepository } from '../infrastructure/mysql/repositories/a2a-credential-repository.js';
import { A2aTaskRepository } from '../infrastructure/mysql/repositories/a2a-task-repository.js';
import { A2aAuditRepository } from '../infrastructure/mysql/repositories/a2a-audit-repository.js';
import { ArtifactRepository } from '../infrastructure/mysql/repositories/artifact-repository.js';
import { ProcessExecutionRepository } from '../infrastructure/mysql/repositories/process-execution-repository.js';
import { CronJobRepository } from '../infrastructure/mysql/repositories/cron-job-repository.js';
import { OutboxRepository } from '../infrastructure/outbox/outbox-repository.js';
import { createStubRunExecutor } from '../application/run-executor.js';
import { PINNED_PI_SDK_VERSION } from '../infrastructure/pi/pi-runtime-factory.js';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import * as skillPathsModule from '../skills/paths.js';

/**
 * Resolve concrete AGENT_PI_AGENT_DIR for PiRuntimeFactory.create().
 * Local default: `{cwd}/.runtime/agent/pi-agent-home`.
 * Containers set AGENT_PI_AGENT_DIR explicitly to `/app/pi-agent-home`.
 * Empty/missing env is OK only when the default path can be ensured on disk.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function resolveAgentPiAgentDir(env = process.env) {
  const raw = String(env.AGENT_PI_AGENT_DIR || '').trim();
  if (raw) return path.resolve(raw);
  return path.resolve(process.cwd(), '.runtime', 'agent', 'pi-agent-home');
}

/**
 * Ensure agentDir exists and is usable before first Pi runtime create.
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} [env]
 * @returns {string} absolute path
 */
export function ensureAgentPiAgentDir(env = process.env) {
  const dir = resolveAgentPiAgentDir(env);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const e = new Error(
      `AGENT_PI_AGENT_DIR is required and must be creatable (path=${dir}): ${msg}`,
    );
    // @ts-ignore
    e.code = 'PI_AGENT_DIR_REQUIRED';
    throw e;
  }
  return dir;
}

/**
 * Fail-closed: worker Sandbox calls need service API token when not stub.
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} env
 */
export function assertWorkerSandboxServiceToken(env = process.env) {
  const token = String(env.SANDBOX_API_TOKEN || '').trim();
  if (token) return token;
  const deployment = String(
    env.DEPLOYMENT_ENV || env.NODE_ENV || '',
  ).toLowerCase();
  const authOn =
    String(env.SANDBOX_AUTH_ENABLED || '').toLowerCase() === 'true' ||
    String(env.SANDBOX_AUTH_ENABLED || '') === '1';
  if (deployment === 'production' || authOn) {
    const e = new Error(
      'SANDBOX_API_TOKEN is required for agent-worker Sandbox ownership ' +
        '(service X-API-Key + durable X-Acting-* headers). ' +
        'Production must set a strong secret; development compose may use the ' +
        'dev-only placeholder default when SANDBOX_AUTH_ENABLED=true.',
    );
    // @ts-ignore
    e.code = 'SANDBOX_API_TOKEN_REQUIRED';
    throw e;
  }
  return '';
}

/**
 * Skill roots one Run may read: the bundled system tier plus that caller's own
 * `<orgId>/<userId>` directory.
 *
 * Resolved per Run rather than once per process — the user tier is per-user, so
 * a process-wide list would put every tenant's installed skills into every
 * prompt. A malformed identity degrades to system-only instead of throwing.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} env
 * @param {{ orgId?: unknown, userId?: unknown } | null} identity
 * @returns {string[]}
 */
export function resolveSkillRootsForRun(env, identity) {
  const {
    SYSTEM_SKILL_ROOT,
    USER_SKILL_ROOT,
    skillRootsForIdentity,
  } = skillPathsModule;
  const systemRoot = String(
    env?.SKILLS_ROOT || env?.AGENT_SKILLS_ROOT || SYSTEM_SKILL_ROOT,
  ).trim();
  const userRootBase = String(
    env?.SKILLS_USER_ROOT || env?.AGENT_SKILLS_USER_ROOT || USER_SKILL_ROOT,
  ).trim();
  try {
    return skillRootsForIdentity(identity, { systemRoot, userRootBase });
  } catch {
    return [systemRoot];
  }
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} [env]
 */
export function resolveMysqlUrlFromEnv(env = process.env) {
  const url =
    env.AGENT_DATABASE_URL ||
    env.MYSQL_URL ||
    env.DATABASE_URL ||
    '';
  return String(url).trim() || null;
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} [env]
 */
export function resolveRedisUrlFromEnv(env = process.env) {
  const url =
    env.AGENT_REDIS_URL ||
    env.REDIS_URL ||
    '';
  return String(url).trim() || null;
}

/**
 * @param {import('knex').Knex | import('knex').Knex.Transaction} db
 * @param {{ now?: () => Date }} [opts]
 */
export function createRepositoryBundle(db, opts = {}) {
  const now = opts.now ?? (() => new Date());
  const traceSpans = new TraceSpanRepository(db, { now });
  return {
    organizations: new OrganizationRepository(db, { now }),
    externalRefs: new ExternalReferenceRepository(db, { now }),
    catalog: new AgentCatalogRepository(db, { now }),
    conversations: new ConversationRepository(db),
    sessions: new AgentSessionRepository(db, { now }),
    /** PR-05 acceleration snapshots (not sole truth). */
    sessionSnapshots: new AgentSessionSnapshotRepository(db, {
      now,
      runtimePiSdkVersion: opts.runtimePiSdkVersion ?? PINNED_PI_SDK_VERSION,
    }),
    messages: new MessageRepository(db),
    /** PR-05 long-term Pi JSONL journal (messages-backed). */
    journal: new PiSessionJournalRepository(db, {
      now,
      generateId: opts.generateId,
    }),
    runs: new RunRepository(db, { now }),
    runEvents: new RunEventRepository(db, { traceSpans }),
    traceSpans,
    idempotency: new IdempotencyRepository(db, { now }),
    /** PR-06 B2: durable tool ledger + policy audit + approvals. */
    toolExecutions: new ToolExecutionRepository(db, { now }),
    approvals: new ApprovalRepository(db, { now }),
    interactions: new InteractionRepository(db, { now }),
    /** Agent working memory: session todo list + owner-scoped note log. */
    taskState: new TaskStateRepository(db, {
      now,
      generateId: opts.generateId,
    }),
    sandboxAudit: new SandboxAuditEventRepository(db, { now }),
    outbox: new OutboxRepository(db, { now }),
    /** PR-12 A2A protocol. */
    a2aCredentials: new A2aCredentialRepository(db, { now }),
    a2aTasks: new A2aTaskRepository(db, { now }),
    a2aAudit: new A2aAuditRepository(db, { now }),
    artifacts: new ArtifactRepository(db),
    processExecutions: new ProcessExecutionRepository(db),
    cronJobs: new CronJobRepository(db, { now }),
  };
}

/**
 * Whether stub RunExecutor is allowed for worker (never production default).
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} env
 * @param {{ runExecutorFactory?: Function|null }} opts
 */
export function resolveWorkerExecutorFactory(env, opts = {}) {
  if (typeof opts.runExecutorFactory === 'function') {
    return opts.runExecutorFactory;
  }
  const allowStub =
    String(env.AGENT_ALLOW_STUB_EXECUTOR || '').toLowerCase() === 'true';
  const deployment = String(
    env.DEPLOYMENT_ENV || env.NODE_ENV || '',
  ).toLowerCase();
  const isProd = deployment === 'production';
  if (allowStub && !isProd) {
    return () => createStubRunExecutor();
  }
  return null;
}
