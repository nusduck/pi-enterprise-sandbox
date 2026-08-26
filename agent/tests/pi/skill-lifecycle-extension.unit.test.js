/** Governed uploaded/generated Skill lifecycle tools. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createEnterpriseExtensionBundle,
  createSkillLifecycleExtension,
  extensionFactoryNames,
  REQUIRED_EXTENSION_NAMES,
  SKILL_LIFECYCLE_TOOL_NAMES,
} from '../../src/extensions/index.js';
import { classifyTool } from '../../src/extensions/enterprise-policy/tool-risk-classifier.js';
import { createPolicyEngine } from '../../src/extensions/enterprise-policy/policy-engine.js';

const RUN_CTX = Object.freeze({
  orgId: '01K0G2PAV8FPMVC9QHJG7JPN4Z',
  userId: '01K0G2PAV8FPMVC9QHJG7JPN50',
  conversationId: '01K0G2PAV8FPMVC9QHJG7JPN51',
  agentSessionId: '01K0G2PAV8FPMVC9QHJG7JPN52',
  runId: '01K0G2PAV8FPMVC9QHJG7JPN5H',
  sandboxSessionId: '01K0G2PAV8FPMVC9QHJG7JPN5F',
  traceId: 'b'.repeat(32),
  executionFenceToken: 3,
});

const ZIP_ATTACHMENT = Object.freeze({
  attachmentId: 'dataset-skill-1',
  filename: 'uploaded-skill.zip',
  mimeType: 'application/zip',
  size: 123,
});

function fakeSkillManager(overrides = {}) {
  return {
    identity: { orgId: RUN_CTX.orgId, userId: RUN_CTX.userId },
    userSkillRoot: `/home/sandbox/skill-user/${RUN_CTX.orgId}/${RUN_CTX.userId}`,
    skillRoots: [
      '/home/sandbox/skill',
      `/home/sandbox/skill-user/${RUN_CTX.orgId}/${RUN_CTX.userId}`,
    ],
    install: async () => ({ name: 'uploaded', summary: 'installed uploaded' }),
    create: async () => ({ name: 'generated', summary: 'installed generated' }),
    uninstall: async () => ({ name: 'x', summary: 'uninstalled x' }),
    edit: async () => ({ path: 'x/SKILL.md', bytes: 1 }),
    reload: async () => ({ reloaded: true, installed: ['x'] }),
    describeInstalled: () => [{ name: 'x', tier: 'user' }],
    listInstalled: () => ['x'],
    ...overrides,
  };
}

function collectTools(factory) {
  const tools = new Map();
  factory({
    registerTool: (definition) => tools.set(definition.name, definition),
    on: () => {},
  });
  return tools;
}

function extension(manager = fakeSkillManager(), attachments = [ZIP_ATTACHMENT]) {
  return createSkillLifecycleExtension({
    runContext: RUN_CTX,
    deps: { skillManager: manager, currentTurnAttachments: attachments },
  });
}

describe('skill-lifecycle extension', () => {
  it('registers only the supported user lifecycle tools', () => {
    const tools = collectTools(extension());
    assert.deepEqual([...tools.keys()].sort(), [...SKILL_LIFECYCLE_TOOL_NAMES].sort());
  });

  it('requires a complete manager and per-user directory', () => {
    assert.throws(
      () => createSkillLifecycleExtension({ runContext: RUN_CTX, deps: {} }),
      /SKILL_MANAGER_REQUIRED/,
    );
    assert.throws(
      () => extension(fakeSkillManager({ create: undefined })),
      /SKILL_MANAGER_REQUIRED/,
    );
    assert.throws(
      () => extension(fakeSkillManager({ userSkillRoot: null })),
      /SKILL_USER_ROOT_REQUIRED/,
    );
  });

  it('installs a package the model built in the sandbox', async () => {
    const calls = [];
    const tools = collectTools(
      extension(fakeSkillManager({
        install: async (input) => {
          calls.push(input);
          return { name: 'built-skill', summary: 'installed built-skill' };
        },
      })),
    );

    // Workspace-relative, /tmp and logical workspace paths all resolve to the
    // same logical form the file tools use.
    for (const [given, expected] of [
      ['dist/built-skill.zip', '/home/sandbox/workspace/dist/built-skill.zip'],
      ['/tmp/built-skill.skill', '/tmp/built-skill.skill'],
      ['/home/sandbox/workspace/built-skill.zip', '/home/sandbox/workspace/built-skill.zip'],
    ]) {
      await tools.get('skill_install').execute('call-install', {
        source: 'sandbox',
        path: given,
      });
      assert.deepEqual(calls.at(-1), {
        source: 'sandbox',
        sourcePath: expected,
        archiveName: expected.split('/').pop(),
      });
    }

    // The sandbox branch never consults the current-turn attachment block.
    assert.equal(
      calls.some((call) => 'attachmentId' in call),
      false,
    );
  });

  it('refuses to install from the read-only Skill root', async () => {
    const tools = collectTools(
      extension(fakeSkillManager({
        install: async () => assert.fail('install must not be reached'),
      })),
    );
    for (const path of [
      '/home/sandbox/skill/pdf/pdf.zip',
      '/home/sandbox/skill-user/anything.zip',
    ]) {
      await assert.rejects(
        tools.get('skill_install').execute('call-install', { source: 'sandbox', path }),
        /cannot be installed from the Skill root/,
      );
    }
    await assert.rejects(
      tools
        .get('skill_install')
        .execute('call-install', { source: 'sandbox', path: '/etc/passwd' }),
      /must be under workspace/,
    );
  });

  it('installs only a ZIP attached in the current turn and reloads', async () => {
    let installed;
    let reloads = 0;
    const tools = collectTools(
      extension(fakeSkillManager({
        install: async (input) => {
          installed = input;
          return { name: 'uploaded-skill', summary: 'installed uploaded-skill' };
        },
        reload: async () => {
          reloads += 1;
          return { reloaded: true, installed: ['uploaded-skill'] };
        },
      })),
    );
    const result = await tools.get('skill_install').execute('call-install', {
      attachment_id: ZIP_ATTACHMENT.attachmentId,
      filename: ZIP_ATTACHMENT.filename,
    });
    assert.deepEqual(installed, {
      attachmentId: ZIP_ATTACHMENT.attachmentId,
      archiveName: ZIP_ATTACHMENT.filename,
      declaredSize: ZIP_ATTACHMENT.size,
    });
    assert.equal(reloads, 1);
    assert.equal(result.details?.name, 'uploaded-skill');
    assert.equal(result.details?.reload?.reloaded, true);
  });

  it('rejects non-current, renamed and non-ZIP attachment inputs', async () => {
    const tools = collectTools(extension());
    await assert.rejects(
      tools.get('skill_install').execute('call-install', {
        attachment_id: 'older-dataset',
        filename: 'uploaded-skill.zip',
      }),
      /current user turn/,
    );
    await assert.rejects(
      tools.get('skill_install').execute('call-install', {
        attachment_id: ZIP_ATTACHMENT.attachmentId,
        filename: 'renamed.zip',
      }),
      /does not match/,
    );
    const textTools = collectTools(extension(fakeSkillManager(), [{
      attachmentId: 'dataset-text',
      filename: 'notes.txt',
      mimeType: 'text/plain',
      size: 5,
    }]));
    await assert.rejects(
      textTools.get('skill_install').execute('call-install', {
        attachment_id: 'dataset-text',
        filename: 'notes.txt',
      }),
      /\.zip attachments only/,
    );
  });

  it('creates an Agent-generated Skill as one approved atomic mutation', async () => {
    let generated;
    const tools = collectTools(extension(fakeSkillManager({
      create: async (input) => {
        generated = input;
        return { name: input.name, summary: `installed ${input.name}` };
      },
    })));
    const input = {
      name: 'generated-skill',
      description: 'Generated with the user.',
      instructions: '# Workflow\n\nDo the work.',
      files: [{ path: 'references/guide.md', content: '# Guide' }],
    };
    const result = await tools.get('skill_create').execute('call-create', input);
    assert.deepEqual(generated, input);
    assert.equal(result.details?.name, 'generated-skill');
    assert.equal(result.details?.reload?.reloaded, true);
  });

  it('preserves a successful mutation when reload reports an error', async () => {
    const tools = collectTools(extension(fakeSkillManager({
      reload: async () => {
        throw new Error('loader exploded');
      },
    })));
    const result = await tools.get('skill_create').execute('call-create', {
      name: 'generated',
      description: 'Generated.',
      instructions: 'Instructions.',
    });
    assert.equal(result.details?.name, 'generated');
    assert.equal(result.details?.reload?.reloaded, false);
    assert.match(result.details?.reload?.error ?? '', /loader exploded/);
  });

  it('lists system and user tiers in AgentToolResult shape', async () => {
    const tools = collectTools(extension(fakeSkillManager({
      describeInstalled: () => [
        {
          name: 'pdf',
          tier: 'system',
          editable: false,
          path: '/home/sandbox/skill/pdf',
          root: '/home/sandbox/skill',
          description: 'System PDF Skill',
        },
        {
          name: 'mine',
          tier: 'user',
          editable: true,
          path: `${fakeSkillManager().userSkillRoot}/mine`,
          root: fakeSkillManager().userSkillRoot,
          description: 'User Skill',
        },
      ],
    })));
    const result = await tools.get('skill_list').execute('call-list', {});
    assert.ok(Array.isArray(result.content));
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.counts.system, 1);
    assert.equal(body.counts.user, 1);
    assert.equal(body.system_skills[0].editable, false);
    assert.equal(body.user_skills[0].editable, true);
  });

  it('loads by default with a per-run manager and stays absent without one', () => {
    assert.deepEqual(
      extensionFactoryNames(createEnterpriseExtensionBundle(RUN_CTX, {
        skillManager: fakeSkillManager(),
      })),
      [...REQUIRED_EXTENSION_NAMES, 'skill-lifecycle'],
    );

    const seen = [];
    const session = { reload: async () => {} };
    const getAgentSession = () => session;
    assert.deepEqual(
      extensionFactoryNames(createEnterpriseExtensionBundle(RUN_CTX, {
        getAgentSession,
        skillManagerFactory: (runContext, lifecycleDeps) => {
          seen.push([
            runContext.orgId,
            runContext.userId,
            lifecycleDeps?.getAgentSession?.(),
          ]);
          return fakeSkillManager();
        },
      })),
      [...REQUIRED_EXTENSION_NAMES, 'skill-lifecycle'],
    );
    assert.deepEqual(seen, [[RUN_CTX.orgId, RUN_CTX.userId, session]]);
    assert.deepEqual(
      extensionFactoryNames(createEnterpriseExtensionBundle(RUN_CTX)),
      [...REQUIRED_EXTENSION_NAMES],
    );
    assert.deepEqual(
      extensionFactoryNames(createEnterpriseExtensionBundle(RUN_CTX, {
        skillManagerFactory: () => null,
      })),
      [...REQUIRED_EXTENSION_NAMES],
    );
  });

  it('keeps an explicit AgentVersion extension list authoritative', () => {
    assert.throws(
      () => createEnterpriseExtensionBundle(RUN_CTX, {
        extensions: [...REQUIRED_EXTENSION_NAMES, 'skill-lifecycle'],
      }),
      /SKILL_MANAGER_REQUIRED/,
    );
    assert.deepEqual(
      extensionFactoryNames(createEnterpriseExtensionBundle(RUN_CTX, {
        extensions: [...REQUIRED_EXTENSION_NAMES],
        skillManager: fakeSkillManager(),
      })),
      [...REQUIRED_EXTENSION_NAMES],
    );
  });

  it('requires approval for every mutation and allows listing', async () => {
    for (const name of SKILL_LIFECYCLE_TOOL_NAMES) {
      assert.equal(classifyTool(name).class, 'local_low', name);
    }
    const mutationNames = ['skill_install', 'skill_create', 'skill_edit', 'skill_uninstall'];
    const engine = createPolicyEngine({
      auditSink: async () => {},
      toolRiskPolicy: {
        tools: {
          skill_list: 'low',
          ...Object.fromEntries(mutationNames.map((name) => [name, 'high'])),
        },
      },
    });
    for (const toolName of mutationNames) {
      const decision = await engine.evaluateToolCall({
        toolName,
        args: {},
        runContext: { ...RUN_CTX },
      });
      assert.equal(decision.decision, 'require_approval', toolName);
    }
    const list = await engine.evaluateToolCall({
      toolName: 'skill_list',
      args: {},
      runContext: { ...RUN_CTX },
    });
    assert.equal(list.decision, 'allow');
  });
});
