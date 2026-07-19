#!/usr/bin/env node
/**
 * Live Sandbox release gates.
 *
 * This is deliberately outside the normal unit-test command.  It exercises
 * the formal MySQL claim path, the HMAC internal plane, a real Sandbox HTTP
 * process, real child isolation/process execution, Dataset streaming, and
 * owner-scoped Artifact byte delivery.
 *
 * Required environment:
 *   SANDBOX_GATE_MYSQL_URL=mysql://.../<dedicated pi_gate_* schema>
 *   SANDBOX_GATE_BASE_URL=http://127.0.0.1:<sandbox-port>
 *   SANDBOX_GATE_HMAC_KEYRING='{"gate-v1":"<base64url key>"}'
 *   SANDBOX_GATE_HMAC_ACTIVE_KID=gate-v1
 *   SANDBOX_GATE_INTERNAL_TOKEN_LEEWAY_SECONDS=5  # bounded clock skew only
 *
 * The optional managed-container mode is useful for a repeatable Linux gate:
 *   SANDBOX_GATE_MANAGED_CONTAINER=1
 *   SANDBOX_GATE_DOCKER_NETWORK=pi-refactor-gate-backend-internal
 *   SANDBOX_GATE_IMAGE=enterprise-sandbox:latest
 *   SANDBOX_GATE_HARD_KILL=1       # destructive service SIGKILL/restart gate
 *
 * The database name must start with pi_gate_ or sandbox_gate_.  The gate rolls
 * the dedicated schema back in finally, so do not point it at a shared schema.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import process from 'node:process';

import {
  ulid,
} from '../../agent/src/domain/shared/ulid.js';
import {
  computeToolRequestHashV1,
} from '../../agent/src/domain/tool/tool-request-hash.js';
import {
  createMysqlKnex,
  destroyMysqlKnex,
  migrateLatest,
  migrateRollbackAll,
} from '../../agent/src/infrastructure/mysql/index.js';
import {
  OrganizationRepository,
  ConversationRepository,
  MessageRepository,
  AgentSessionRepository,
  RunRepository,
} from '../../agent/src/infrastructure/mysql/index.js';
import {
  createInternalSessionProvisioner,
} from '../../agent/src/infrastructure/sandbox/internal-session-http.js';
import {
  createInternalExecutionTransport,
} from '../../agent/src/infrastructure/sandbox/internal-execution-http.js';
import {
  createInternalProcessTransport,
} from '../../agent/src/infrastructure/sandbox/internal-process-http.js';
import {
  createInternalArtifactSubmitTransport,
} from '../../agent/src/infrastructure/sandbox/internal-artifact-submit-http.js';
import {
  createInternalArtifactDownloadTransport,
} from '../../agent/src/infrastructure/sandbox/internal-artifact-download-http.js';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const GATE_PREFIX = /^(?:pi_gate_|sandbox_gate_)/;
const DEFAULT_KEYRING = JSON.stringify({
  'gate-v1': Buffer.from('pi-enterprise-sandbox-release-gate-key-32b', 'utf8').toString('base64url'),
});
const DEFAULT_KID = 'gate-v1';
const DEFAULT_API_TOKEN = 'pi-enterprise-sandbox-release-gate-api-token-32b';
const DEFAULT_JWT_SECRET = 'pi-enterprise-sandbox-release-gate-jwt-secret-64-bytes-0123456789abcdef';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function required(name, fallback = '') {
  const value = String(process.env[name] || fallback).trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseMysqlUrl(value) {
  const raw = String(value || '').trim().replace(/^mysql2?:/, 'mysql:');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('SANDBOX_GATE_MYSQL_URL must be a valid mysql:// URL');
  }
  if (parsed.protocol !== 'mysql:' || !parsed.hostname || !parsed.pathname || parsed.pathname === '/') {
    throw new Error('SANDBOX_GATE_MYSQL_URL must use mysql://user:pass@host:port/<database>');
  }
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!GATE_PREFIX.test(database)) {
    throw new Error(`refusing non-dedicated database ${database}; use a pi_gate_* or sandbox_gate_* schema`);
  }
  return { raw, parsed, database };
}

function randomTrace() {
  return randomBytes(16).toString('hex');
}

async function waitHttp(url, { timeoutMs = 45_000, accept = (response) => response.ok } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (accept(response)) return response;
      lastError = new Error(`${url} -> HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw lastError || new Error(`timed out waiting for ${url}`);
}

function jsonHeaders(identity) {
  return {
    'Content-Type': 'application/json',
    'X-API-Key': API_TOKEN,
    'X-Acting-User-Id': identity.userId,
    'X-Acting-Organization-Id': identity.orgId,
  };
}

function identityOf(fixture) {
  return {
    orgId: fixture.orgId,
    userId: fixture.userId,
    conversationId: fixture.conversationId,
    agentSessionId: fixture.agentSessionId,
    runId: fixture.runId,
    sandboxSessionId: fixture.sandboxSessionId,
    traceId: fixture.traceId,
    executionFenceToken: 1,
  };
}

function hashFor(toolName, args) {
  return computeToolRequestHashV1({ toolName, args });
}

function assertHttpError(error, expectedStatus, label) {
  const actual = Number(error?.httpStatus);
  assert.equal(actual, expectedStatus, `${label}: expected HTTP ${expectedStatus}, got ${actual} (${error?.code || error})`);
}

function sampleContainerRssKiB(container) {
  if (!container) return null;
  try {
    // Pass the target argv token through the container environment so the
    // probe's own shell command line cannot match itself.
    const output = execFileSync(
      'docker',
      [
        'exec',
        '--env',
        'SANDBOX_GATE_RSS_ARG=sandbox.main:app',
        container,
        'sh',
        '-lc',
        'target="${SANDBOX_GATE_RSS_ARG:?}"; self="$$"; for p in /proc/[0-9]*; do [ "${p##*/}" = "$self" ] && continue; [ -r "$p/cmdline" ] || continue; if tr "\\0" "\\n" < "$p/cmdline" | grep -Fxq "$target"; then awk "/VmRSS:/ {print \\$2; exit}" "$p/status"; exit 0; fi; done; exit 1',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 },
    );
    const value = Number.parseInt(String(output).trim(), 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

async function sampleRssDuring(promise, container) {
  let peak = sampleContainerRssKiB(container);
  const baseline = peak;
  let timer;
  if (container) {
    timer = setInterval(() => {
      const current = sampleContainerRssKiB(container);
      if (current != null && (peak == null || current > peak)) peak = current;
    }, 250);
    timer.unref?.();
  }
  let value;
  try {
    value = await promise;
  } finally {
    if (timer) clearInterval(timer);
    const final = sampleContainerRssKiB(container);
    if (final != null && (peak == null || final > peak)) peak = final;
  }
  return { value, baseline, peak };
}

function startManagedSandbox({ mysql, keyring, activeKid, hardKill = false }) {
  const container = `pi-sandbox-release-gate-${process.pid}`;
  const network = process.env.SANDBOX_GATE_DOCKER_NETWORK || 'pi-refactor-gate-backend-internal';
  const ingressNetwork = process.env.SANDBOX_GATE_DOCKER_INGRESS_NETWORK || network.replace(/backend-internal$/, 'dev-ingress');
  const image = process.env.SANDBOX_GATE_IMAGE || 'enterprise-sandbox:latest';
  const tokenLeeway = String(process.env.SANDBOX_GATE_INTERNAL_TOKEN_LEEWAY_SECONDS || '5').trim();
  if (!/^\d+$/.test(tokenLeeway) || Number(tokenLeeway) > 5) {
    throw new Error('SANDBOX_GATE_INTERNAL_TOKEN_LEEWAY_SECONDS must be an integer from 0 through 5');
  }
  const maxProcessCount = String(process.env.SANDBOX_GATE_MAX_PROCESS_COUNT || '20').trim();
  if (!/^\d+$/.test(maxProcessCount) || Number(maxProcessCount) < 1) {
    throw new Error('SANDBOX_GATE_MAX_PROCESS_COUNT must be a positive integer');
  }
  const privileged = /^(1|true|yes)$/i.test(String(process.env.SANDBOX_GATE_DOCKER_PRIVILEGED || ''));
  const defaultDatasetLimitMb = Math.max(
    1024,
    Math.ceil(DATASET_BYTES / (1024 * 1024)) + 128,
  );
  const maxFileSizeMb = String(process.env.SANDBOX_GATE_MAX_FILE_SIZE_MB || defaultDatasetLimitMb).trim();
  const workspaceQuotaMb = String(process.env.SANDBOX_GATE_WORKSPACE_QUOTA_MB || defaultDatasetLimitMb).trim();
  const tempQuotaMb = String(process.env.SANDBOX_GATE_TEMP_QUOTA_MB || defaultDatasetLimitMb).trim();
  for (const [name, value] of [['SANDBOX_GATE_MAX_FILE_SIZE_MB', maxFileSizeMb], ['SANDBOX_GATE_WORKSPACE_QUOTA_MB', workspaceQuotaMb], ['SANDBOX_GATE_TEMP_QUOTA_MB', tempQuotaMb]]) {
    if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error(`${name} must be a positive integer`);
  }
  const root = `${ROOT}/.release-gate-${process.pid}`;
  const dirs = ['workspaces', 'tmp', 'artifacts', 'control'].map((name) => `${root}/${name}`);
  for (const dir of dirs) execFileSync('mkdir', ['-p', dir]);

  const parsed = mysql.parsed;
  const dbHost = process.env.SANDBOX_GATE_CONTAINER_DB_HOST || 'pi-refactor-gate-mysql';
  const containerMysqlUrl = process.env.SANDBOX_GATE_CONTAINER_MYSQL_URL ||
    `mysql+pymysql://${encodeURIComponent(decodeURIComponent(parsed.username))}:${encodeURIComponent(decodeURIComponent(parsed.password))}@${dbHost}:3306/${mysql.database}`;
  const replayUrl = process.env.SANDBOX_GATE_CONTAINER_REPLAY_REDIS_URL ||
    'redis://:redis_dev_only@pi-refactor-gate-redis:6379/0';
  const args = [
    'create', '--init', '--name', container,
    '--network', ingressNetwork,
    '--security-opt', `seccomp=${ROOT}/sandbox/seccomp-bubblewrap.json`,
    '--security-opt', 'apparmor=unconfined',
    '--security-opt', 'systempaths=unconfined',
    '--cap-drop', 'ALL',
    '--cap-add', 'CHOWN',
    '--cap-add', 'FOWNER',
    '--cap-add', 'SETUID',
    '--cap-add', 'SETGID',
    // CAP_KILL: restart recovery must signal Bubblewrap orphans created by a
    // previous service process (foreign user namespace). Matches compose sandbox.
    '--cap-add', 'KILL',
    '-p', '127.0.0.1::8081',
    '-v', `${dirs[0]}:/var/sandbox/workspaces`,
    '-v', `${dirs[1]}:/var/sandbox/tmp`,
    '-v', `${dirs[2]}:/var/sandbox/artifacts`,
    '-v', `${dirs[3]}:/var/sandbox/control`,
    '-v', `${ROOT}/skills:/home/sandbox/skill:ro`,
    '-e', 'DEPLOYMENT_ENV=development',
    '-e', 'SANDBOX_BIND_HOST=0.0.0.0',
    '-e', 'SANDBOX_PORT=8081',
    '-e', `SANDBOX_DATABASE_URL=${containerMysqlUrl}`,
    '-e', 'SANDBOX_AUTH_ENABLED=true',
    '-e', `SANDBOX_API_TOKEN=${API_TOKEN}`,
    '-e', `SANDBOX_JWT_SECRET=${JWT_SECRET}`,
    '-e', 'SANDBOX_JWT_ISSUER=pi-enterprise-sandbox',
    '-e', 'SANDBOX_JWT_AUDIENCE=pi-enterprise-sandbox',
    '-e', 'SANDBOX_AUTH_ALLOW_PUBLIC_REGISTER=false',
    '-e', 'SANDBOX_INTERNAL_PLANE_ENABLED=true',
    '-e', `SANDBOX_INTERNAL_REDIS_URL=${replayUrl}`,
    '-e', `SANDBOX_INTERNAL_HMAC_KEYRING=${keyring}`,
    '-e', `SANDBOX_INTERNAL_HMAC_ACTIVE_KID=${activeKid}`,
    '-e', `SANDBOX_INTERNAL_TOKEN_LEEWAY_SECONDS=${tokenLeeway}`,
    '-e', 'SANDBOX_INTERNAL_MAX_CONCURRENCY=64',
    '-e', 'SANDBOX_INTERNAL_DRAIN_TIMEOUT_SECONDS=30',
    '-e', 'SANDBOX_WORKSPACES_ROOT=/var/sandbox/workspaces',
    '-e', 'SANDBOX_TEMP_ROOT=/var/sandbox/tmp',
    '-e', 'SANDBOX_ARTIFACTS_ROOT=/var/sandbox/artifacts',
    '-e', 'SANDBOX_CONTROL_ROOT=/var/sandbox/control',
    '-e', 'SANDBOX_SKILLS_ROOT=/home/sandbox/skill',
    '-e', 'SANDBOX_ISOLATION_BACKEND=bubblewrap',
    '-e', 'SANDBOX_ISOLATION_REQUIRED=true',
    '-e', 'SANDBOX_NETWORK_MODE=disabled',
    '-e', 'SANDBOX_POLICY_PROFILE=balanced',
    '-e', `SANDBOX_MAX_FILE_SIZE_MB=${maxFileSizeMb}`,
    '-e', `SANDBOX_MAX_PROCESS_COUNT=${maxProcessCount}`,
    '-e', `SANDBOX_WORKSPACE_QUOTA_MB=${workspaceQuotaMb}`,
    '-e', `SANDBOX_TEMP_QUOTA_MB=${tempQuotaMb}`,
    '-e', 'SANDBOX_WORKSPACE_CHILD_QUOTA_ENFORCEMENT=true',
    '-e', 'SANDBOX_WORKSPACE_QUOTA_HARD_BACKEND_ASSERTED=false',
    '-e', 'SANDBOX_ALLOWED_CLIENT_CIDRS=127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16',
    ...(hardKill ? [
      '-e', 'SANDBOX_GATE_SERVICE_SUPERVISOR=true',
      '-e', `SANDBOX_GATE_RESTART_DELAY_SECONDS=${process.env.SANDBOX_GATE_RESTART_DELAY_SECONDS || '10'}`,
    ] : []),
    '-e', 'AGENT_REDIS_URL=',
    '-e', 'REDIS_URL=',
    ...(privileged ? ['--privileged'] : []),
    image,
  ];
  let created = false;
  try {
    const output = execFileSync('docker', args, { encoding: 'utf8' }).trim();
    if (!output) throw new Error('docker create did not return a container id');
    created = true;
    if (network !== ingressNetwork) {
      execFileSync('docker', ['network', 'connect', network, container], { stdio: 'ignore' });
    }
    execFileSync('docker', ['start', container], { stdio: 'ignore' });
    const portOutput = execFileSync('docker', ['port', container, '8081/tcp'], { encoding: 'utf8' }).trim();
    const match = portOutput.match(/127\.0\.0\.1:(\d+)/);
    if (!match) throw new Error(`could not resolve managed Sandbox port: ${portOutput}`);
    return {
      container,
      port: Number(match[1]),
      root,
      privileged,
      maxProcessCount: Number(maxProcessCount),
      maxFileSizeMb: Number(maxFileSizeMb),
      workspaceQuotaMb: Number(workspaceQuotaMb),
      tempQuotaMb: Number(tempQuotaMb),
      hardKill,
      tokenLeewaySeconds: Number(tokenLeeway),
    };
  } catch (error) {
    if (created) {
      try { execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' }); } catch { /* best effort */ }
    }
    try { execFileSync('rm', ['-rf', root], { stdio: 'ignore' }); } catch { /* best effort */ }
    throw error;
  }
}

function stopManagedSandbox(managed) {
  if (!managed) return null;
  if (/^(1|true|yes)$/i.test(String(process.env.SANDBOX_GATE_KEEP_CONTAINER || ''))) {
    console.error(`[release-gate] keeping managed container ${managed.container} for diagnosis`);
    return { kept: true, container: managed.container, root: managed.root };
  }
  try { execFileSync('docker', ['rm', '-f', managed.container], { stdio: 'ignore' }); } catch { /* already stopped */ }
  try { execFileSync('rm', ['-rf', managed.root], { stdio: 'ignore' }); } catch { /* best effort */ }
  let containerRemoved = false;
  try { execFileSync('docker', ['inspect', managed.container], { stdio: 'ignore' }); } catch { containerRemoved = true; }
  return { kept: false, container: managed.container, containerRemoved, root: managed.root, rootRemoved: !existsSync(managed.root) };
}

async function seedFixture(knex, count) {
  const orgs = [ulid(), ulid()];
  const users = [ulid(), ulid()];
  const agents = [ulid(), ulid()];
  const versions = [ulid(), ulid()];
  const now = new Date();
  const organizations = new OrganizationRepository(knex);
  const conversations = new ConversationRepository(knex);
  const sessions = new AgentSessionRepository(knex);
  const messages = new MessageRepository(knex);
  const runs = new RunRepository(knex);

  for (let i = 0; i < 2; i += 1) {
    await organizations.createOrganization({ orgId: orgs[i], name: `Release Gate ${i}`, status: 'active', createdAt: now });
    await organizations.createUser({ userId: users[i], externalSubject: `release-gate:${process.pid}:${i}:${users[i]}`, displayName: `Gate ${i}`, status: 'active', createdAt: now });
    await organizations.addMembership({ orgId: orgs[i], userId: users[i], role: 'member', status: 'active', createdAt: now });
    await knex('agent_definitions').insert({ agent_id: agents[i], org_id: orgs[i], name: `gate-${i}`, description: null, status: 'active', active_version_id: versions[i], created_by: users[i], created_at: knex.fn.now(3), updated_at: knex.fn.now(3) });
    await knex('agent_versions').insert({ agent_version_id: versions[i], agent_id: agents[i], version_no: 1, config_json: JSON.stringify({ modelPolicy: {} }), config_hash: 'a'.repeat(64), pi_sdk_version: '0.80.3', status: 'active', created_by: users[i], created_at: knex.fn.now(3) });
  }

  const fixtures = [];
  for (let i = 0; i < count; i += 1) {
    // First two are same-user/same-tenant sessions; the remaining rows belong
    // to the second tenant so both isolation dimensions are exercised.
    const tenant = i < 2 ? 0 : 1;
    const fixture = {
      index: i,
      orgId: orgs[tenant],
      userId: users[tenant],
      agentId: agents[tenant],
      agentVersionId: versions[tenant],
      conversationId: ulid(),
      agentSessionId: ulid(),
      sandboxSessionId: ulid(),
      workspaceId: ulid(),
      runId: ulid(),
      messageId: ulid(),
      traceId: randomTrace(),
    };
    await conversations.create({ conversationId: fixture.conversationId, orgId: fixture.orgId, userId: fixture.userId, agentId: fixture.agentId, title: `release-gate-${i}`, status: 'active', currentAgentSessionId: fixture.agentSessionId, createdAt: now });
    await sessions.create({ agentSessionId: fixture.agentSessionId, orgId: fixture.orgId, userId: fixture.userId, conversationId: fixture.conversationId, agentVersionId: fixture.agentVersionId, sandboxSessionId: fixture.sandboxSessionId, workspaceId: fixture.workspaceId, status: 'ACTIVE', executionFenceToken: 1, createdAt: now });
    await knex('sandbox_sessions').insert({ sandbox_session_id: fixture.sandboxSessionId, org_id: fixture.orgId, user_id: fixture.userId, agent_session_id: fixture.agentSessionId, workspace_id: fixture.workspaceId, status: 'ACTIVE', created_at: knex.fn.now(3), updated_at: knex.fn.now(3), closed_at: null });
    await messages.append({ messageId: fixture.messageId, conversationId: fixture.conversationId, orgId: fixture.orgId, userId: fixture.userId, agentSessionId: fixture.agentSessionId, role: 'user', messageType: 'text', contentJson: { text: 'release gate' }, createdAt: now });
    await runs.create({ runId: fixture.runId, orgId: fixture.orgId, userId: fixture.userId, conversationId: fixture.conversationId, agentSessionId: fixture.agentSessionId, agentVersionId: fixture.agentVersionId, triggeringMessageId: fixture.messageId, source: 'web', status: 'RUNNING', queueName: 'release-gate', traceId: fixture.traceId, createdAt: now });
    fixtures.push(fixture);
  }
  return { fixtures, orgs, users, agents, versions };
}

async function insertToolRow(knex, fixture, toolName, args, label = toolName) {
  const hash = hashFor(toolName, args);
  const toolExecutionId = ulid();
  const toolCallId = `release-gate-${fixture.index}-${label}-${toolExecutionId}`;
  await knex('tool_executions').insert({
    tool_execution_id: toolExecutionId,
    run_id: fixture.runId,
    agent_session_id: fixture.agentSessionId,
    tool_call_id: toolCallId,
    tool_name: toolName,
    tool_source: 'sandbox',
    risk_level: 'low',
    arguments_json: JSON.stringify(args),
    result_json: null,
    status: 'RUNNING',
    error_code: null,
    trace_id: fixture.traceId,
    request_hash: hash.requestHash,
    request_hash_version: hash.requestHashVersion,
    execution_fence_token: 1,
    started_at: knex.fn.now(3),
    completed_at: null,
    created_at: knex.fn.now(3),
  });
  return { toolExecutionId, toolCallId, requestHash: hash.requestHash, requestHashVersion: hash.requestHashVersion };
}

function executionPayload(fixture, tool, args, claim) {
  return {
    ...args,
    identity: identityOf(fixture),
    toolExecutionId: claim.toolExecutionId,
    toolCallId: claim.toolCallId,
    requestHash: claim.requestHash,
    requestHashVersion: claim.requestHashVersion,
  };
}

function processPayload(fixture, tool, args, claim) {
  return executionPayload(fixture, tool, args, claim);
}

async function executePython(executionTransport, knex, fixture, code, label) {
  const args = { code, args: [], timeoutSeconds: 120 };
  const claim = await insertToolRow(knex, fixture, 'python', args, label);
  const response = await executionTransport.python(executionPayload(fixture, 'python', args, claim));
  assert.equal(response.exitCode, 0, `${label} Python failed: ${response.stderr}`);
  return response;
}

async function executeBash(executionTransport, knex, fixture, command, label, timeoutSeconds = 30) {
  const args = { command, env: {}, timeoutSeconds };
  const claim = await insertToolRow(knex, fixture, 'bash', args, label);
  const response = await executionTransport.bash(executionPayload(fixture, 'bash', args, claim));
  assert.equal(response.exitCode, 0, `${label} Bash failed: ${response.stderr}`);
  return response;
}

async function startProcess(processTransport, knex, fixture, command, label, timeoutSeconds = 30) {
  const started = await startProcessWithClaim(processTransport, knex, fixture, command, label, timeoutSeconds);
  return started.processId;
}

async function startProcessWithClaim(processTransport, knex, fixture, command, label, timeoutSeconds = 30) {
  const args = { command, env: {}, timeoutSeconds };
  const claim = await insertToolRow(knex, fixture, 'process_start', args, label);
  const response = await processTransport.processStart(processPayload(fixture, 'process_start', args, claim));
  assert.ok(response.processId, `${label} did not return processId`);
  return { processId: response.processId, claim, args, response };
}

async function processStatus(processTransport, knex, fixture, processId, label) {
  const args = { processId };
  const claim = await insertToolRow(knex, fixture, 'process_status', args, label);
  return processTransport.processStatus(processPayload(fixture, 'process_status', args, claim));
}

async function processRead(processTransport, knex, fixture, processId, label) {
  const args = { processId, stream: 'stdout', cursor: '0-0', limit: 65_536 };
  const claim = await insertToolRow(knex, fixture, 'process_read', args, label);
  return processTransport.processRead(processPayload(fixture, 'process_read', args, claim));
}

async function processKill(processTransport, knex, fixture, processId, label) {
  const args = { processId, signal: 'TERM' };
  const claim = await insertToolRow(knex, fixture, 'process_kill', args, label);
  return processTransport.processKill(processPayload(fixture, 'process_kill', args, claim));
}

function managedServicePid(container) {
  const output = execFileSync('docker', ['exec', container, 'sh', '-lc',
    'self="$$"; for p in /proc/[0-9]*; do [ "${p##*/}" = "$self" ] && continue; [ -r "$p/cmdline" ] || continue; if tr "\\0" " " < "$p/cmdline" | grep -Fq "uvicorn sandbox.main:app"; then echo "${p##*/}"; exit 0; fi; done; exit 1'],
  { encoding: 'utf8', timeout: 5000 }).trim();
  const pid = Number.parseInt(output, 10);
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error(`invalid managed uvicorn pid: ${output}`);
  return pid;
}

function managedProcessSnapshot(container) {
  try {
    return execFileSync('docker', ['exec', container, 'sh', '-lc',
      'for p in /proc/[0-9]*; do [ -r "$p/cmdline" ] || continue; cmd=$(tr "\\0" " " < "$p/cmdline"); case "$cmd" in *bwrap*|*uvicorn*) echo "${p##*/}:$cmd";; esac; done'],
    { encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return '';
  }
}

function managedPidAlive(container, pid) {
  try {
    // The managed container drops CAP_KILL. A root docker-exec process can
    // therefore receive EPERM from kill(0) against the sandbox uid even while
    // the PID exists. /proc membership is a readonly liveness probe.
    execFileSync('docker', ['exec', container, 'sh', '-lc', `test -d /proc/${Number(pid)}`], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function managedPidRunning(container, pid) {
  try {
    const state = execFileSync('docker', ['exec', container, 'sh', '-lc', `awk '{print $3}' /proc/${Number(pid)}/stat`], { encoding: 'utf8', timeout: 3000 }).trim();
    return state !== '' && state !== 'Z';
  } catch {
    return false;
  }
}

async function runHardKillRecoveryGate({ managed, knex, processTransport, executionTransport, fixture }) {
  if (!managed?.hardKill) throw new Error('hard-kill gate requires SANDBOX_GATE_HARD_KILL=1 with managed container mode');
  const processFixture = fixture;
  // Embed a stable argv marker the host can observe in `ps` after service death
  // (tool labels alone do not appear in process command lines).
  const orphanCommand = 'sleep 120 # hardkill-orphan-process; printf should-not-complete';
  const started = await startProcessWithClaim(processTransport, knex, processFixture, orphanCommand, 'hard-kill-orphan-process', 180);
  const processId = started.processId;
  const processRowBefore = await knex('process_executions').where({ process_id: processId }).first();
  assert.equal(String(processRowBefore?.status).toLowerCase(), 'running', 'long process must be durable RUNNING before kill');
  const processPidBeforeKill = Number(processRowBefore?.pid);
  assert.ok(Number.isSafeInteger(processPidBeforeKill) && processPidBeforeKill > 1, 'long process must persist a formal PID');
  const processPidAliveBeforeKill = managedPidAlive(managed.container, processPidBeforeKill);
  assert.equal(processPidAliveBeforeKill, true, 'formal process PID must exist before service hard kill');

  const bashArgs = { command: 'sleep 120; printf should-not-complete', env: {}, timeoutSeconds: 180 };
  const bashClaim = await insertToolRow(knex, processFixture, 'bash', bashArgs, 'hard-kill-running-execution');
  const pending = executionTransport.bash(executionPayload(processFixture, 'bash', bashArgs, bashClaim)).catch((error) => ({ rejected: true, code: error?.code || error?.message }));
  const runningDeadline = Date.now() + 20_000;
  let sandboxRowBefore;
  while (Date.now() < runningDeadline) {
    sandboxRowBefore = await knex('sandbox_executions').where({ tool_execution_id: bashClaim.toolExecutionId }).first();
    if (String(sandboxRowBefore?.status).toLowerCase() === 'running') break;
    await sleep(200);
  }
  assert.equal(String(sandboxRowBefore?.status).toLowerCase(), 'running', 'long execution must be durable RUNNING before kill');
  const beforeSnapshot = managedProcessSnapshot(managed.container);
  assert.match(beforeSnapshot, /hardkill-orphan-process/, 'managed container must expose the long orphan process before kill');
  const servicePid = managedServicePid(managed.container);
  // The image drops CAP_KILL and uvicorn runs as `sandbox`; signal it from the
  // same uid instead of relying on a privileged docker-exec root.
  execFileSync(
    'docker',
    ['exec', '--user', 'sandbox', managed.container, 'sh', '-lc', `kill -KILL ${servicePid}`],
    { stdio: 'ignore' },
  );
  await sleep(1000);
  const processPidAliveBeforeRestart = managedPidAlive(managed.container, processPidBeforeKill);
  assert.equal(processPidAliveBeforeRestart, true, 'Bubblewrap child must remain alive while the service supervisor is between restart attempts');
  const pendingBeforeRestart = await knex('sandbox_executions').where({ tool_execution_id: bashClaim.toolExecutionId }).first();
  assert.equal(String(pendingBeforeRestart?.status).toLowerCase(), 'running', 'durable RUNNING claim must remain before startup recovery');
  assert.equal((await knex('sandbox_executions').where({ tool_execution_id: bashClaim.toolExecutionId })).length, 1, 'hard kill must not duplicate execution');

  await waitHttp(`http://127.0.0.1:${managed.port}/ready`, { timeoutMs: 90_000 });
  const recoveredSandbox = await knex('sandbox_executions').where({ tool_execution_id: bashClaim.toolExecutionId }).first();
  const recoveredProcess = await knex('process_executions').where({ process_id: processId }).first();
  assert.equal(String(recoveredSandbox?.status).toLowerCase(), 'unknown', 'restart recovery must make claim UNKNOWN');
  assert.equal(recoveredSandbox?.error_code, 'CRASH_RECOVERY_UNKNOWN', 'UNKNOWN claim must carry CRASH_RECOVERY_UNKNOWN');
  assert.equal(String(recoveredProcess?.status).toLowerCase(), 'lost', 'restart recovery must mark orphan process LOST');
  const orphanDeadline = Date.now() + 10_000;
  while (Date.now() < orphanDeadline && /hardkill-orphan-process/.test(managedProcessSnapshot(managed.container))) {
    await sleep(250);
  }
  assert.doesNotMatch(managedProcessSnapshot(managed.container), /hardkill-orphan-process/, 'recovered orphan process must be gone after restart');
  assert.equal((await knex('sandbox_executions').where({ tool_execution_id: bashClaim.toolExecutionId })).length, 1, 'UNKNOWN recovery must not auto-replay');
  const outcome = await pending;
  return {
    status: 'PASS',
    servicePid,
    processId,
    processStatusBefore: processRowBefore.status,
    processStatusAfter: recoveredProcess.status,
    processPidBeforeKill,
    processPidAliveBeforeKill,
    processPidAliveBeforeRestart,
    processPidAliveAfterRestart: false,
    sandboxExecutionStatusBefore: pendingBeforeRestart.status,
    sandboxExecutionStatusAfter: recoveredSandbox.status,
    sandboxExecutionErrorAfter: recoveredSandbox.error_code,
    beforeSnapshot,
    requestResultAfterKill: outcome,
    duplicateExecutionCount: 1,
    automaticReplay: false,
  };
}

async function uploadStreamingDataset(baseUrl, fixture, bytes, container) {
  if (!container) {
    throw new Error('bounded-memory gate requires SANDBOX_GATE_MANAGED_CONTAINER=1 or SANDBOX_GATE_CONTAINER');
  }
  const boundary = `----pi-release-gate-${randomBytes(12).toString('hex')}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="large-gate.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const chunk = Buffer.alloc(1024 * 1024, 0x5a);
  const digest = createHash('sha256');
  async function* body() {
    yield head;
    let remaining = bytes;
    let count = 0;
    while (remaining > 0) {
      const next = Math.min(remaining, chunk.length);
      const value = next === chunk.length ? chunk : chunk.subarray(0, next);
      digest.update(value);
      yield value;
      remaining -= next;
      count += 1;
      if ((count & 15) === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    yield tail;
  }
  const stream = Readable.from(body());
  const rss = await sampleRssDuring(
    fetch(`${baseUrl}/sessions/${fixture.sandboxSessionId}/datasets`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Idempotency-Key': `release-gate-${fixture.runId}-${bytes}`,
        'X-API-Key': API_TOKEN,
        'X-Acting-User-Id': fixture.userId,
        'X-Acting-Organization-Id': fixture.orgId,
      },
      body: stream,
      duplex: 'half',
    }).then(async (response) => {
      const text = await response.text();
      if (!response.ok) throw new Error(`Dataset upload failed HTTP ${response.status}: ${text.slice(0, 500)}`);
      return JSON.parse(text);
    }),
    container,
  );
  const dataset = rss.value;
  if (rss.baseline == null || rss.peak == null) {
    throw new Error('bounded-memory gate could not sample Sandbox uvicorn RSS');
  }
  const rssDeltaKiB = rss.peak - rss.baseline;
  assert.ok(
    rssDeltaKiB <= MAX_DATASET_RSS_DELTA_KIB,
    `Dataset upload RSS delta exceeded bound (delta=${rssDeltaKiB}KiB, limit=${MAX_DATASET_RSS_DELTA_KIB}KiB)`,
  );
  const expectedSha = digest.digest('hex');
  assert.equal(dataset.status, 'ready');
  assert.equal(Number(dataset.size_bytes ?? dataset.size), bytes);
  assert.equal(String(dataset.sha256).toLowerCase(), expectedSha);
  assert.match(String(dataset.path), /^datasets\/[0-9A-HJKMNP-TV-Z]{26}\/large-gate\.bin$/i);
  return { dataset, expectedSha, baselineRssKiB: rss.baseline, peakRssKiB: rss.peak, rssDeltaKiB };
}

async function collectStream(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    if (item.value) {
      chunks.push(Buffer.from(item.value));
      total += item.value.byteLength;
    }
  }
  return Buffer.concat(chunks, total);
}

async function runIsolationGate({ fixtures, knex, executionTransport, processTransport, artifactDownloadTransport, artifactSubmitTransport }) {
  const a = fixtures[0];
  const a2 = fixtures[1];
  const b = fixtures[2];
  await executePython(executionTransport, knex, a, `from pathlib import Path\nPath("marker.txt").write_text("TENANT_A_SESSION_A")`, 'isolation-a-write');
  await executePython(executionTransport, knex, a2, `from pathlib import Path\nPath("marker.txt").write_text("TENANT_A_SESSION_B")`, 'isolation-a2-write');
  await executePython(executionTransport, knex, b, `from pathlib import Path\nPath("marker.txt").write_text("TENANT_B")`, 'isolation-b-write');
  const own = await executePython(executionTransport, knex, a, 'from pathlib import Path\np=Path("marker.txt")\nprint(p.read_text())\nprint(Path("../' + a2.workspaceId + '/marker.txt").exists())\nprint(Path("/var/sandbox/workspaces/' + b.workspaceId + '/marker.txt").exists())', 'isolation-a-read');
  assert.match(own.stdout, /TENANT_A_SESSION_A/);
  assert.doesNotMatch(own.stdout, /TENANT_A_SESSION_B|TENANT_B/);
  assert.match(own.stdout, /False/);

  // Full foreign-tenant identity must be owner-masked before tool-row lookup.
  const foreign = { ...b, orgId: a.orgId, userId: a.userId };
  const foreignArgs = { code: 'print("must-not-run")', args: [], timeoutSeconds: 5 };
  const foreignClaim = {
    toolExecutionId: ulid(),
    toolCallId: `release-gate-foreign-${ulid()}`,
    ...hashFor('python', foreignArgs),
  };
  try {
    await executionTransport.python(executionPayload(foreign, 'python', foreignArgs, foreignClaim));
    throw new Error('foreign-tenant execution unexpectedly succeeded');
  } catch (error) {
    assertHttpError(error, 404, 'foreign-tenant execution');
  }

  // Start a long process in B, then ask for it through A's owner/session.
  const processId = await startProcess(processTransport, knex, b, 'sleep 10; printf TENANT_B_PROCESS', 'isolation-process-b', 30);
  const forgedArgs = { processId };
  const forgedClaim = await insertToolRow(knex, a, 'process_status', forgedArgs, 'isolation-forged-process-status');
  try {
    await processTransport.processStatus(processPayload(a, 'process_status', forgedArgs, forgedClaim));
    throw new Error('cross-session process status unexpectedly succeeded');
  } catch (error) {
    assertHttpError(error, 404, 'cross-session process status');
  }
  await processKill(processTransport, knex, b, processId, 'isolation-process-b-kill');

  // Submit an artifact in B and require both tenant and session bindings on download.
  await executePython(executionTransport, knex, b, 'from pathlib import Path\nPath("deliver.txt").write_text("B-ONLY-DELIVERY")', 'isolation-artifact-write');
  const artifactArgs = { path: '/home/sandbox/workspace/deliver.txt' };
  const artifactClaim = await insertToolRow(knex, b, 'submit_artifact', artifactArgs, 'isolation-artifact-submit');
  const artifact = await artifactSubmitTransport.submitArtifact({ path: artifactArgs.path, identity: identityOf(b), toolExecutionId: artifactClaim.toolExecutionId, toolCallId: artifactClaim.toolCallId, requestHash: artifactClaim.requestHash, requestHashVersion: artifactClaim.requestHashVersion });
  const expected = { artifactId: artifact.artifactId, expectedSizeBytes: artifact.size, expectedSha256: artifact.sha256 };
  for (const [label, owner] of [['cross-tenant artifact', foreign], ['cross-session artifact', a2]]) {
    try {
      await artifactDownloadTransport.downloadArtifact({ ...expected, identity: identityOf(owner) });
      throw new Error(`${label} download unexpectedly succeeded`);
    } catch (error) {
      assertHttpError(error, 404, label);
    }
  }
  const ownDownload = await artifactDownloadTransport.downloadArtifact({ ...expected, identity: identityOf(b) });
  const bytes = await collectStream(ownDownload.body);
  assert.equal(bytes.toString('utf8'), 'B-ONLY-DELIVERY');
  const ownDownloadSha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(ownDownloadSha256, expected.expectedSha256);
  return {
    status: 'PASS',
    artifactId: artifact.artifactId,
    foreignExecutionHttpStatus: 404,
    crossSessionProcessHttpStatus: 404,
    crossTenantArtifactHttpStatus: 404,
    crossSessionArtifactHttpStatus: 404,
    ownArtifactDownloadSha256: ownDownloadSha256,
  };
}

async function runConcurrencyGate({ fixtures, knex, executionTransport }) {
  const selected = fixtures.slice(0, 20);
  assert.equal(selected.length, 20, '20 Sandbox execution fixtures required');
  const delay = Number.parseInt(process.env.SANDBOX_GATE_EXECUTION_DELAY_SECONDS || '1', 10);
  const commandArgs = selected.map((fixture) => ({ command: `sleep ${delay}; printf gate-${fixture.index}`, env: {}, timeoutSeconds: Math.max(delay + 20, 30) }));
  const started = Date.now();
  const responses = await Promise.all(commandArgs.map(async (args, index) => {
    const fixture = selected[index];
    const claim = await insertToolRow(knex, fixture, 'bash', args, `concurrency-${index}`);
    return executionTransport.bash(executionPayload(fixture, 'bash', args, claim));
  }));
  const elapsedMs = Date.now() - started;
  for (const [index, response] of responses.entries()) {
    assert.equal(response.exitCode, 0, `concurrent execution ${index} failed: ${response.stderr}`);
    assert.match(response.stdout, new RegExp(`gate-${index}`));
  }
  const sumChildMs = responses.reduce((sum, response) => sum + Number(response.durationMs || 0), 0);
  // A serial per-process implementation would approach sumChildMs.  Require
  // at least a 2x overlap while leaving headroom for container startup jitter.
  assert.ok(elapsedMs * 2 < sumChildMs + 2_000, `20 executions did not overlap enough (elapsed=${elapsedMs}ms, child-sum=${sumChildMs}ms)`);
  return { status: 'PASS', count: responses.length, elapsedMs, sumChildMs, overlapFactor: sumChildMs / Math.max(elapsedMs, 1) };
}

async function runDatasetArtifactGate({ fixture, knex, executionTransport, processTransport, artifactSubmitTransport, artifactDownloadTransport, baseUrl, datasetBytes, container }) {
  const upload = await uploadStreamingDataset(baseUrl, fixture, datasetBytes, container);
  const datasetPath = upload.dataset.path;
  const code = [
    'from pathlib import Path',
    'import hashlib',
    `src = Path(${JSON.stringify(datasetPath)})`,
    'digest = hashlib.sha256()',
    'total = 0',
    'with src.open("rb") as handle:',
    '    while True:',
    '        chunk = handle.read(1024 * 1024)',
    '        if not chunk:',
    '            break',
    '        total += len(chunk)',
    '        digest.update(chunk)',
    'out = Path("out/result.txt")',
    'out.parent.mkdir(parents=True, exist_ok=True)',
    'out.write_text(f"dataset-bytes={total}\\nsha256={digest.hexdigest()}\\n")',
  ].join('\n');
  const python = await executePython(executionTransport, knex, fixture, code, 'dataset-python');
  assert.equal(python.exitCode, 0);

  const processId = await startProcess(processTransport, knex, fixture, '/app/.venv/bin/python -c "from pathlib import Path; p=Path(\'out/result.txt\'); p.write_text(p.read_text()+\'process-ok\\n\')"', 'dataset-process', 30);
  const deadline = Date.now() + 30_000;
  let status;
  while (Date.now() < deadline) {
    status = await processStatus(processTransport, knex, fixture, processId, 'dataset-process-status');
    if (['completed', 'failed', 'timeout', 'cancelled', 'lost', 'orphaned'].includes(String(status.status))) break;
    await sleep(100);
  }
  assert.equal(status?.status, 'completed', `dataset process did not complete: ${JSON.stringify(status)}`);
  const read = await processRead(processTransport, knex, fixture, processId, 'dataset-process-read');
  assert.equal(read.status, 'completed');

  const artifactArgs = { path: '/home/sandbox/workspace/out/result.txt' };
  const claim = await insertToolRow(knex, fixture, 'submit_artifact', artifactArgs, 'dataset-artifact-submit');
  const artifact = await artifactSubmitTransport.submitArtifact({ path: artifactArgs.path, identity: identityOf(fixture), toolExecutionId: claim.toolExecutionId, toolCallId: claim.toolCallId, requestHash: claim.requestHash, requestHashVersion: claim.requestHashVersion });
  assert.equal(artifact.status, 'ready');
  const downloaded = await artifactDownloadTransport.downloadArtifact({ artifactId: artifact.artifactId, identity: identityOf(fixture), expectedSizeBytes: artifact.size, expectedSha256: artifact.sha256 });
  const bytes = await collectStream(downloaded.body);
  const text = bytes.toString('utf8');
  assert.match(text, new RegExp(`dataset-bytes=${datasetBytes}`));
  assert.match(text, /process-ok/);
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest, artifact.sha256);
  return {
    status: 'PASS',
    datasetId: upload.dataset.dataset_id,
    datasetSha256: upload.expectedSha,
    artifactId: artifact.artifactId,
    artifactSha256: artifact.sha256,
    downloadSha256: digest,
    downloadSha256Matches: digest === artifact.sha256,
    sizeBytes: datasetBytes,
    baselineRssKiB: upload.baselineRssKiB,
    peakRssKiB: upload.peakRssKiB,
    rssDeltaKiB: upload.rssDeltaKiB,
    rssDeltaLimitKiB: MAX_DATASET_RSS_DELTA_KIB,
  };
}

async function cleanupFixture(knex) {
  // Dedicated schema cleanup is intentionally a rollback, not a best-effort
  // DELETE: messages are append-only and reject direct DELETE triggers.
  await migrateRollbackAll(knex);
}

const MYSQL = parseMysqlUrl(required('SANDBOX_GATE_MYSQL_URL'));
const KEYRING = required('SANDBOX_GATE_HMAC_KEYRING', DEFAULT_KEYRING);
const ACTIVE_KID = required('SANDBOX_GATE_HMAC_ACTIVE_KID', DEFAULT_KID);
const API_TOKEN = required('SANDBOX_GATE_API_TOKEN', DEFAULT_API_TOKEN);
const JWT_SECRET = required('SANDBOX_GATE_JWT_SECRET', DEFAULT_JWT_SECRET);
const DATASET_BYTES = Number.parseInt(process.env.SANDBOX_GATE_DATASET_BYTES || String(256 * 1024 * 1024), 10);
const MAX_DATASET_RSS_DELTA_KIB = Number.parseInt(process.env.SANDBOX_GATE_MAX_RSS_DELTA_KIB || String(128 * 1024), 10);
const CONCURRENCY = 20;
const HARD_KILL_ENABLED = /^(1|true|yes)$/i.test(String(process.env.SANDBOX_GATE_HARD_KILL || ''));
if (!Number.isSafeInteger(DATASET_BYTES) || DATASET_BYTES < 16 * 1024 * 1024) throw new Error('SANDBOX_GATE_DATASET_BYTES must be an integer >= 16 MiB');
if (!Number.isSafeInteger(MAX_DATASET_RSS_DELTA_KIB) || MAX_DATASET_RSS_DELTA_KIB <= 0) throw new Error('SANDBOX_GATE_MAX_RSS_DELTA_KIB must be a positive integer');

let managed = null;
let knex = null;
let fixture = null;

async function main() {
  const managedEnabled = /^(1|true|yes)$/i.test(String(process.env.SANDBOX_GATE_MANAGED_CONTAINER || ''));
  knex = createMysqlKnex(MYSQL.raw, { pool: { min: 0, max: 64 } });
  await knex.raw('SELECT 1');
  await migrateLatest(knex);
  if (managedEnabled) {
    managed = startManagedSandbox({ mysql: MYSQL, keyring: KEYRING, activeKid: ACTIVE_KID, hardKill: HARD_KILL_ENABLED });
    process.env.SANDBOX_GATE_BASE_URL = `http://127.0.0.1:${managed.port}`;
  }
  if (HARD_KILL_ENABLED && !managed) {
    throw new Error('SANDBOX_GATE_HARD_KILL=1 requires SANDBOX_GATE_MANAGED_CONTAINER=1');
  }
  const baseUrl = required('SANDBOX_GATE_BASE_URL');
  await waitHttp(`${baseUrl}/health`);
  await waitHttp(`${baseUrl}/ready`);

  const seeded = await seedFixture(knex, CONCURRENCY);
  fixture = seeded;

  const transportOptions = { baseUrl, keyring: KEYRING, activeKid: ACTIVE_KID, allowInsecureHttp: true, timeoutMs: 180_000 };
  const sessionProvisioner = createInternalSessionProvisioner(transportOptions);
  const first = seeded.fixtures[0];
  const provisioned = await sessionProvisioner.ensure({ orgId: first.orgId, userId: first.userId, conversationId: first.conversationId, agentSessionId: first.agentSessionId, sandboxSessionId: first.sandboxSessionId, workspaceId: first.workspaceId, traceId: first.traceId });
  assert.equal(provisioned.status, 'ACTIVE');
  const executionTransport = createInternalExecutionTransport(transportOptions);
  const processTransport = createInternalProcessTransport(transportOptions);
  const artifactSubmitTransport = createInternalArtifactSubmitTransport(transportOptions);
  const artifactDownloadTransport = createInternalArtifactDownloadTransport(transportOptions);

  const isolation = await runIsolationGate({ fixtures: seeded.fixtures, knex, executionTransport, processTransport, artifactDownloadTransport, artifactSubmitTransport });
  const concurrency = await runConcurrencyGate({ fixtures: seeded.fixtures, knex, executionTransport });
  const datasetArtifact = await runDatasetArtifactGate({ fixture: first, knex, executionTransport, processTransport, artifactSubmitTransport, artifactDownloadTransport, baseUrl, datasetBytes: DATASET_BYTES, container: managed?.container || process.env.SANDBOX_GATE_CONTAINER || null });
  const hardKillRecovery = HARD_KILL_ENABLED
    ? await runHardKillRecoveryGate({ managed, knex, processTransport, executionTransport, fixture: first })
    : null;

  const report = {
    status: 'PASS',
    gate: 'sandbox-live-release-gates',
    timestamp: new Date().toISOString(),
    database: MYSQL.database,
    sandboxBaseUrl: baseUrl,
    managedSandbox: managed
      ? {
          container: managed.container,
          privileged: managed.privileged,
          maxProcessCount: managed.maxProcessCount,
          maxFileSizeMb: managed.maxFileSizeMb,
          workspaceQuotaMb: managed.workspaceQuotaMb,
          tempQuotaMb: managed.tempQuotaMb,
          hardKill: managed.hardKill,
          tokenLeewaySeconds: managed.tokenLeewaySeconds,
        }
      : null,
    isolation,
    concurrency,
    datasetArtifact,
    hardKillRecovery,
  };
  console.log(JSON.stringify(report, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(JSON.stringify({ status: 'FAIL', gate: 'sandbox-live-release-gates', error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  // Stop the managed service before rolling back its schema: shutdown hooks
  // may still reconcile sessions and tool executions during termination.
  const managedCleanup = stopManagedSandbox(managed);
  let schemaRolledBack = false;
  let mysqlClosed = false;
  if (knex) {
    try { await cleanupFixture(knex); schemaRolledBack = true; } catch (error) { console.error(`[release-gate] cleanup failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
    try { await destroyMysqlKnex(knex); mysqlClosed = true; } catch (error) { console.error(`[release-gate] knex close failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
  }
  console.error(JSON.stringify({ gate: 'sandbox-live-release-gates-cleanup', managed: managedCleanup, schemaRolledBack, mysqlClosed }, null, 2));
}
