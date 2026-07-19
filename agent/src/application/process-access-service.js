/** Owner-scoped process history and live-control facade for the BFF. */

import { ExternalIdentityResolver } from './parent/external-identity-resolver.js';
import { OwnerScopedNotFoundError, ValidationError } from './errors.js';

const SIGNALS = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP']);

function boundedInteger(value, field, { min, max, fallback }) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ValidationError(`${field} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

export class ProcessAccessService {
  constructor({ createRepositories, db, createSandboxClient }) {
    if (typeof createRepositories !== 'function') {
      throw new Error('ProcessAccessService requires repositories');
    }
    if (typeof createSandboxClient !== 'function') {
      throw new Error('ProcessAccessService requires Sandbox client');
    }
    this.createRepositories = createRepositories;
    this.db = db;
    this.createSandboxClient = createSandboxClient;
  }

  async #context(auth) {
    const repositories = this.createRepositories(this.db);
    const resolver = new ExternalIdentityResolver({
      organizations: repositories.organizations,
      externalRefs: repositories.externalRefs,
    });
    const owner = await resolver.resolveOwner(auth);
    const sandbox = this.createSandboxClient({
      auth: {
        actingUserId: owner.userId,
        actingOrganizationId: owner.orgId,
        actingRole: auth?.role || 'user',
      },
    });
    return { repositories, owner, sandbox };
  }

  async #owned(processId, auth) {
    const context = await this.#context(auth);
    const process = await context.repositories.processExecutions.getById(
      processId,
      context.owner,
    );
    if (!process) {
      throw new OwnerScopedNotFoundError('Process not found', {
        resource: 'process_executions',
        id: processId,
      });
    }
    return { ...context, process };
  }

  async list({ auth, runId = null, sandboxSessionId = null, status = null, limit = 100 }) {
    const { repositories, owner } = await this.#context(auth);
    return repositories.processExecutions.list(owner, {
      runId,
      sandboxSessionId,
      status,
      limit: boundedInteger(limit, 'limit', { min: 1, max: 500, fallback: 100 }),
    });
  }

  async get({ processId, auth }) {
    return (await this.#owned(processId, auth)).process;
  }

  async logs({ processId, auth, offset = 0, limit = null }) {
    const { sandbox } = await this.#owned(processId, auth);
    return sandbox.getProcessLogs(
      processId,
      boundedInteger(offset, 'offset', { min: 0, max: 2_147_483_647, fallback: 0 }),
      limit == null
        ? null
        : boundedInteger(limit, 'limit', { min: 1, max: 500_000, fallback: null }),
    );
  }

  async read({ processId, auth, stream = 'stdout', cursor = '0-0', limit = 8192 }) {
    if (stream !== 'stdout' && stream !== 'stderr') {
      throw new ValidationError('stream must be stdout or stderr');
    }
    const normalizedCursor = String(cursor ?? '0-0');
    if (!normalizedCursor || normalizedCursor.length > 128) {
      throw new ValidationError('cursor must be a non-empty string of at most 128 characters');
    }
    const { sandbox } = await this.#owned(processId, auth);
    return sandbox.readProcess(processId, {
      stream,
      cursor: normalizedCursor,
      limit: boundedInteger(limit, 'limit', { min: 1, max: 65_536, fallback: 8192 }),
    });
  }

  async stdin({ processId, auth, data = '', eof = false }) {
    if (typeof data !== 'string' || Buffer.byteLength(data, 'utf8') > 65_536) {
      throw new ValidationError('stdin data must be a string of at most 65536 bytes');
    }
    const { sandbox } = await this.#owned(processId, auth);
    return sandbox.writeProcessStdin(processId, data, Boolean(eof));
  }

  async signal({ processId, auth, signal = 'SIGTERM' }) {
    const normalized = String(signal || 'SIGTERM').trim().toUpperCase();
    if (!SIGNALS.has(normalized)) {
      throw new ValidationError('signal must be SIGTERM, SIGKILL, SIGINT, or SIGHUP');
    }
    const { sandbox } = await this.#owned(processId, auth);
    return sandbox.signalProcess(processId, normalized);
  }

  async cancel({ processId, auth }) {
    const { sandbox } = await this.#owned(processId, auth);
    return sandbox.cancelProcess(processId);
  }
}
