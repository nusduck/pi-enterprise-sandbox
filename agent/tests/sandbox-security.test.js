/**
 * SDK Extension security governance: policy matrix, fail-closed, write mutex.
 * Run: node --test agent/tests/sandbox-security.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  POLICY_VERSION,
  POLICY_DECISION,
  classifyToolSideEffect,
  evaluateToolPolicy,
  applyApprovalSwitch,
  preExecuteGate,
  createWriteMutex,
  isHardDenyCommand,
  commandRequiresApproval,
  buildToolAuditEvent,
  createSandboxSecurityExtension,
  resolveApprovalEnabled,
  filterToolResultContent,
  resolvePolicyProfile,
  isBlockedSandboxPath,
} from '../packages/enterprise-agent-kit/extensions/policy/index.js';
import { resolveApprovalEnabled as configResolveApproval } from '../config.js';
import {
  DefaultResourceLoader,
  SettingsManager,
  getAgentDir,
  ExtensionRunner,
  SessionManager,
  AuthStorage,
  ModelRegistry,
} from '@earendil-works/pi-coding-agent';

async function loadRunner(factory) {
  const settingsManager = SettingsManager.create('/tmp', getAgentDir());
  const loader = new DefaultResourceLoader({
    cwd: '/tmp',
    agentDir: getAgentDir(),
    settingsManager,
    skillsOverride: () => ({ skills: [], diagnostics: [] }),
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    promptsOverride: () => ({ prompts: [], diagnostics: [] }),
    extensionFactories: [factory],
  });
  await loader.reload();
  const { extensions, runtime, errors } = loader.getExtensions();
  assert.equal(errors?.length ?? 0, 0, `extension load errors: ${JSON.stringify(errors)}`);
  const sm = SessionManager.inMemory('/tmp');
  const auth = AuthStorage.create();
  const registry = ModelRegistry.create(auth);
  return new ExtensionRunner(extensions, runtime, '/tmp', sm, registry);
}

describe('tool side-effect classification', () => {
  it('classifies read tools as parallel-safe', () => {
    for (const t of ['read', 'ls', 'find', 'grep']) {
      assert.equal(classifyToolSideEffect(t), 'read');
    }
  });

  it('classifies write tools as serial', () => {
    for (const t of ['write', 'edit', 'bash', 'submit_artifact']) {
      assert.equal(classifyToolSideEffect(t), 'write');
    }
  });

  it('treats unknown tools as write', () => {
    assert.equal(classifyToolSideEffect('mystery_tool'), 'write');
    assert.equal(classifyToolSideEffect(''), 'write');
  });
});

describe('policy matrix allow / approval_required / hard_deny', () => {
  it('allows safe read and safe bash', () => {
    const r = evaluateToolPolicy('read', { path: 'a.txt' });
    assert.equal(r.decision, POLICY_DECISION.ALLOW);
    assert.equal(r.policy_version, POLICY_VERSION);

    const b = evaluateToolPolicy('bash', { command: 'echo hello' });
    assert.equal(b.decision, POLICY_DECISION.ALLOW);
    assert.equal(b.risk_level, 'medium');
  });

  it('requires approval for high-risk bash patterns', () => {
    const p = evaluateToolPolicy('bash', { command: 'pip install requests' });
    assert.equal(p.decision, POLICY_DECISION.APPROVAL_REQUIRED);
    assert.equal(p.risk_level, 'high');
    assert.equal(commandRequiresApproval('curl https://x'), true);
  });

  it('balanced relaxes only package-manager approval with effective bwrap', () => {
    const options = {
      policyProfile: 'balanced',
      isolationBackend: 'bubblewrap',
      isolationRequired: true,
    };
    assert.equal(resolvePolicyProfile({
      SANDBOX_POLICY_PROFILE: 'balanced',
      SANDBOX_ISOLATION_BACKEND: 'bubblewrap',
      SANDBOX_ISOLATION_REQUIRED: 'true',
    }), 'balanced');
    assert.equal(evaluateToolPolicy('bash', { command: 'npm install marked' }, options).decision, POLICY_DECISION.ALLOW);
    assert.equal(evaluateToolPolicy('bash', { command: 'timeout 10 npm install marked' }, options).decision, POLICY_DECISION.ALLOW);
    assert.equal(evaluateToolPolicy('bash', { command: "sh -c 'npm install marked && echo done'" }, options).decision, POLICY_DECISION.ALLOW);
    assert.equal(evaluateToolPolicy('bash', { command: 'curl https://x' }, options).decision, POLICY_DECISION.APPROVAL_REQUIRED);
    assert.equal(evaluateToolPolicy('bash', { command: 'nc example.com 80' }, options).decision, POLICY_DECISION.APPROVAL_REQUIRED);
    for (const command of ['wget https://x/file', 'ncat example.com 80']) {
      assert.equal(evaluateToolPolicy('bash', { command }, options).decision, POLICY_DECISION.APPROVAL_REQUIRED);
    }
    assert.throws(
      () => resolvePolicyProfile({ SANDBOX_POLICY_PROFILE: 'balanced' }),
      /requires effective.*bubblewrap/i,
    );
  });

  it('hard-denies blocked prefixes', () => {
    for (const cmd of [
      'sudo ls',
      'rm -rf /',
      'chmod 777 /etc',
      'dd if=/dev/zero',
      'echo ok | sudo id',
      'env -i sudo id',
      "env -S 'sudo id'",
      'timeout 10 /usr/bin/sudo id',
      'timeout --signal KILL 10 sudo id',
      'timeout -s KILL 10 /usr/bin/unshare -Ur true',
      'command /bin/mount /dev/sda /mnt',
      'command -x /bin/mount /dev/sda /mnt',
      'exec /usr/bin/unshare -Ur true',
      'setcap cap_net_raw+ep /usr/bin/ping',
      'sysctl -w kernel.unprivileged_userns_clone=1',
      'ip link add dummy0 type dummy',
      'ip link set dummy0 up',
      'ip netns add escape',
      "sh -c 'sudo id'",
      "bash -c 'unshare -Ur true'",
      'timeout --unknown 10 npm install marked',
      'echo x > /dev/sda',
      'cat /run/secrets/token',
    ]) {
      assert.equal(isHardDenyCommand(cmd), true, cmd);
      const p = evaluateToolPolicy('bash', { command: cmd });
      assert.equal(p.decision, POLICY_DECISION.HARD_DENY, cmd);
    }
  });

  it('hard-denies host paths while retaining logical workspace and skill reads', () => {
    assert.equal(isBlockedSandboxPath('/etc/passwd', 'read'), true);
    assert.equal(isBlockedSandboxPath('/home/sandbox/workspace/a.txt', 'read'), false);
    assert.equal(isBlockedSandboxPath('/home/sandbox/skill/demo/SKILL.md', 'read'), false);
    assert.equal(isBlockedSandboxPath('/home/sandbox/workspace/../other', 'read'), true);
  });

  it('allows container-scoped read-only diagnostics', () => {
    for (const command of ['ip addr', 'ip route show', 'getcap /usr/bin/node', 'sysctl kernel.ostype']) {
      assert.equal(isHardDenyCommand(command), false, command);
    }
  });

  it('hard-denies excessive timeout', () => {
    const p = evaluateToolPolicy('bash', { command: 'echo x', timeout: 600 });
    assert.equal(p.decision, POLICY_DECISION.HARD_DENY);
  });

  it('APPROVAL_ENABLED=false maps approval_required → allow + bypass, keeps hard_deny', () => {
    const risk = evaluateToolPolicy('bash', { command: 'wget http://x' });
    const bypassed = applyApprovalSwitch(risk, false);
    assert.equal(bypassed.decision, POLICY_DECISION.ALLOW);
    assert.equal(bypassed.approval_bypassed, true);

    const deny = evaluateToolPolicy('bash', { command: 'sudo id' });
    const still = applyApprovalSwitch(deny, false);
    assert.equal(still.decision, POLICY_DECISION.HARD_DENY);
    assert.equal(still.approval_bypassed, false);
  });

  it('preExecuteGate fail-closed on hard_deny', () => {
    const g = preExecuteGate({
      toolName: 'bash',
      params: { command: 'sudo rm -rf /' },
      approvalEnabled: true,
    });
    assert.equal(g.ok, false);
    assert.match(g.reason, /blocked/i);
  });
});

describe('write serialization (promise order)', () => {
  it('serializes writes for the same workspace key', async () => {
    const mutex = createWriteMutex();
    const order = [];
    const slow = mutex.runExclusive('ws-a', async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 40));
      order.push('a-end');
      return 1;
    });
    const fast = mutex.runExclusive('ws-a', async () => {
      order.push('b-start');
      order.push('b-end');
      return 2;
    });
    const [ra, rb] = await Promise.all([slow, fast]);
    assert.equal(ra, 1);
    assert.equal(rb, 2);
    assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('allows parallel writes across different workspace keys', async () => {
    const mutex = createWriteMutex();
    let concurrent = 0;
    let maxConcurrent = 0;
    const make = (key) =>
      mutex.runExclusive(key, async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 30));
        concurrent -= 1;
      });
    await Promise.all([make('ws-1'), make('ws-2'), make('ws-3')]);
    assert.ok(maxConcurrent >= 2, `expected parallel, maxConcurrent=${maxConcurrent}`);
  });
});

describe('extension fail-closed', () => {
  it('blocks hard_deny via tool_call extension', async () => {
    const runner = await loadRunner(
      createSandboxSecurityExtension({
        getMeta: () => ({ conversation_id: 'c1', session_id: 's1', trace_id: 't1' }),
        approvalEnabled: true,
      }),
    );
    const blocked = await runner.emitToolCall({
      type: 'tool_call',
      toolName: 'bash',
      toolCallId: 'call_deny',
      input: { command: 'sudo ls' },
    });
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /blocked/i);
  });

  it('does not block allow tools', async () => {
    const runner = await loadRunner(createSandboxSecurityExtension({ approvalEnabled: true }));
    const allowed = await runner.emitToolCall({
      type: 'tool_call',
      toolName: 'read',
      toolCallId: 'call_ok',
      input: { path: 'a.txt' },
    });
    assert.equal(allowed, undefined);
  });

  it('blocks when extension handler throws (fail-closed wrapper)', async () => {
    // Simulate internal failure by wrapping evaluate path with a broken getMeta that throws
    // during audit after policy — use factory that throws inside handler before return.
    const runner = await loadRunner((pi) => {
      const inner = createSandboxSecurityExtension({
        getMeta: () => {
          throw new Error('meta boom');
        },
      });
      // Install our own that throws
      pi.on('tool_call', async () => {
        throw new Error('handler boom');
      });
      // Also register security (won't run if first throws depending on runner order)
      void inner;
    });

    // ExtensionRunner propagates handler errors — AgentSession treats as fail-safe block
    await assert.rejects(
      () =>
        runner.emitToolCall({
          type: 'tool_call',
          toolName: 'write',
          toolCallId: 'call_err',
          input: { path: 'x.txt', content: 'y' },
        }),
      /handler boom/,
    );
  });

  it('createSandboxSecurityExtension catches internal errors and returns block', async () => {
    const runner = await loadRunner(
      createSandboxSecurityExtension({
        getMeta: () => {
          throw new Error('meta boom');
        },
      }),
    );
    // getMeta throws inside try after evaluate — fail-closed via catch
    const out = await runner.emitToolCall({
      type: 'tool_call',
      toolName: 'bash',
      toolCallId: 'c1',
      input: { command: 'echo hi' },
    });
    assert.equal(out?.block, true);
    assert.match(out.reason, /fail-closed|meta boom/i);
  });
});

describe('tool result governance', () => {
  it('redacts secrets and truncates oversized text', () => {
    const filtered = filterToolResultContent([
      { type: 'text', text: `api_key=super-secret ${'x'.repeat(40)}` },
    ], 24);
    assert.equal(filtered.changed, true);
    assert.doesNotMatch(filtered.content[0].text, /super-secret/);
    assert.match(filtered.content[0].text, /truncated/);
  });
});

describe('audit meta injection', () => {
  it('includes user/org/conversation/session/trace/policy version', () => {
    const ev = buildToolAuditEvent({
      toolName: 'bash',
      params: { command: 'echo hi' },
      policy: evaluateToolPolicy('bash', { command: 'echo hi' }),
      meta: {
        user_id: 'u1',
        organization_id: 'o1',
        conversation_id: 'c1',
        session_id: 's1',
        trace_id: 'tr1',
      },
    });
    assert.equal(ev.meta.user_id, 'u1');
    assert.equal(ev.meta.organization_id, 'o1');
    assert.equal(ev.meta.conversation_id, 'c1');
    assert.equal(ev.meta.session_id, 's1');
    assert.equal(ev.meta.trace_id, 'tr1');
    assert.equal(ev.meta.policy_version, POLICY_VERSION);
    assert.ok(!JSON.stringify(ev).includes('password'));
  });
});

describe('APPROVAL_ENABLED config', () => {
  it('defaults true; false only when explicitly false', () => {
    assert.equal(resolveApprovalEnabled({}), true);
    assert.equal(resolveApprovalEnabled({ APPROVAL_ENABLED: 'false' }), false);
    assert.equal(resolveApprovalEnabled({ APPROVAL_ENABLED: 'true' }), true);
    assert.equal(configResolveApproval({}), true);
    assert.equal(configResolveApproval({ APPROVAL_ENABLED: 'false' }), false);
    assert.equal(configResolveApproval({ SANDBOX_APPROVAL_ENABLED: 'false' }), false);
  });
});
