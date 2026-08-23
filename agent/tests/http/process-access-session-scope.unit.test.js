/**
 * The BFF's process control routes reach Sandbox through session-scoped paths.
 *
 * Regression: ProcessAccessService called `/processes/:id/logs|read|signal|…`,
 * a Sandbox surface that no longer exists. Sandbox answered 404, the Agent
 * mapped that to "Process not found", and the browser saw a process it could
 * list and inspect but never read or stop. Every control call must carry the
 * sandboxSessionId recorded on the process row.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProcessAccessService } from '../../src/application/process-access-service.js';
import { OwnerScopedNotFoundError } from '../../src/application/errors.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const PROCESS = '01K0G2PAV8FPMVC9QHJG7JPN5P';
const SESSION = '01K0G2PAV8FPMVC9QHJG7JPN52';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN5H';

const AUTH = Object.freeze({
  provider: 'test',
  externalOrgId: 'org-external',
  externalUserId: 'user-external',
});

function build({ process = null } = {}) {
  const calls = [];
  const sandbox = new Proxy(
    {},
    {
      get: (_target, method) => (...args) => {
        calls.push({ method, args });
        return { ok: true };
      },
    },
  );
  const service = new ProcessAccessService({
    db: {},
    createRepositories: () => ({
      organizations: {
        async getUserByExternalSubject() {
          return { userId: USER };
        },
        async getMembership() {
          return { orgId: ORG, userId: USER, status: 'active' };
        },
      },
      externalRefs: {
        async getOrganizationRef() {
          return { orgId: ORG };
        },
      },
      processExecutions: {
        async getById(processId, scope) {
          assert.equal(scope.orgId, ORG);
          assert.equal(scope.userId, USER);
          if (processId !== PROCESS) return null;
          return (
            process ?? {
              processId: PROCESS,
              orgId: ORG,
              userId: USER,
              sandboxSessionId: SESSION,
              runId: RUN,
              command: 'sleep 10',
              status: 'running',
            }
          );
        },
      },
    }),
    createSandboxClient: () => sandbox,
  });
  return { service, calls };
}

describe('ProcessAccessService session scoping', () => {
  it('passes the process’s sandbox session to every control call', async () => {
    const { service, calls } = build();

    await service.logs({ processId: PROCESS, auth: AUTH, offset: 5, limit: 10 });
    await service.read({ processId: PROCESS, auth: AUTH, cursor: '0-3' });
    await service.stdin({ processId: PROCESS, auth: AUTH, data: 'y\n' });
    await service.signal({ processId: PROCESS, auth: AUTH, signal: 'SIGINT' });
    await service.cancel({ processId: PROCESS, auth: AUTH });

    assert.deepEqual(
      calls.map((call) => call.method),
      [
        'getProcessLogs',
        'readProcess',
        'writeProcessStdin',
        'signalProcess',
        'cancelProcess',
      ],
    );
    for (const call of calls) {
      assert.equal(call.args[0], SESSION, `${call.method} must send the session`);
      assert.equal(call.args[1], PROCESS, `${call.method} must send the process`);
    }
    assert.deepEqual(calls[0].args.slice(2), [5, 10]);
    assert.deepEqual(calls[1].args[2], { stream: 'stdout', cursor: '0-3', limit: 8192 });
    assert.deepEqual(calls[2].args.slice(2), ['y\n', false]);
    assert.equal(calls[3].args[2], 'SIGINT');
  });

  it('never reaches Sandbox for a process the caller does not own', async () => {
    const { service, calls } = build();
    await assert.rejects(
      () => service.signal({ processId: '01K0G2PAV8FPMVC9QHJG7JPN5Q', auth: AUTH }),
      OwnerScopedNotFoundError,
    );
    assert.deepEqual(calls, []);
  });
});
