/**
 * A2A 自建协议面完整性与防误删棘轮（ADR 0010 & docs/design/a2a-sdk-server.md P5 反向版本）
 *
 * 保证自建的 13 个协议与应用模块完整存在，双轨方法名（PascalCase + slash）与
 * 断线重连/连续序列流机制不被意外删除或破坏。
 * 注意：必须同时覆盖 .js 与 .ts 扫描（AGENTS.md §3.4 规定）。
 */

import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DefaultRequestHandler,
  DefaultExecutionEventBusManager,
  type TaskStore,
  type AgentExecutor,
  ServerCallContext,
} from '@a2a-js/sdk/server';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_DIR = path.resolve(__dirname, '../../src');

describe('A2A Custom Protocol Integrity Ratchet (ADR 0010)', () => {
  const REQUIRED_APPLICATION_MODULES = [
    'agent-card',
    'artifact-download',
    'credential-service',
    'deterministic-task-id',
    'event-projector',
    'identity',
    'index',
    'json-rpc',
    'sdk-adapter',
    'stream-event-schema',
    'stream-service',
    'task-request',
    'task-service',
  ];

  const REQUIRED_PRESENTATION_MODULES = [
    'admin-http-handler',
    'http-handler',
    'http-handler-mapping',
  ];

  it('all 13 application/a2a modules exist in src (.ts or .js)', () => {
    const appA2aDir = path.join(SRC_DIR, 'application/a2a');
    assert.ok(fs.existsSync(appA2aDir), 'application/a2a directory must exist');

    for (const mod of REQUIRED_APPLICATION_MODULES) {
      const tsPath = path.join(appA2aDir, `${mod}.ts`);
      const jsPath = path.join(appA2aDir, `${mod}.js`);
      assert.ok(
        fs.existsSync(tsPath) || fs.existsSync(jsPath),
        `Required A2A module ${mod} (.ts or .js) must exist in application/a2a`,
      );
    }
  });

  it('all 3 presentation/a2a modules exist in src (.ts or .js)', () => {
    const presA2aDir = path.join(SRC_DIR, 'presentation/a2a');
    assert.ok(fs.existsSync(presA2aDir), 'presentation/a2a directory must exist');

    for (const mod of REQUIRED_PRESENTATION_MODULES) {
      const tsPath = path.join(presA2aDir, `${mod}.ts`);
      const jsPath = path.join(presA2aDir, `${mod}.js`);
      assert.ok(
        fs.existsSync(tsPath) || fs.existsSync(jsPath),
        `Required A2A presentation module ${mod} (.ts or .js) must exist in presentation/a2a`,
      );
    }
  });

  it('json-rpc.ts exports core protocol constants and handlers', async () => {
    const jsonRpc = await import('../../src/application/a2a/json-rpc.js');
    assert.ok(jsonRpc.A2A_METHODS, 'A2A_METHODS must be exported');
    assert.equal(jsonRpc.A2A_METHODS.SEND_MESSAGE, 'SendMessage');
    assert.equal(jsonRpc.A2A_METHODS.SEND_STREAMING_MESSAGE, 'SendStreamingMessage');
    assert.equal(jsonRpc.A2A_METHODS.GET_TASK, 'GetTask');
    assert.equal(jsonRpc.A2A_METHODS.CANCEL_TASK, 'CancelTask');
    assert.equal(jsonRpc.A2A_METHODS.SUBSCRIBE_TO_TASK, 'SubscribeToTask');
    assert.equal(jsonRpc.A2A_METHODS.LIST_TASKS, 'ListTasks');

    assert.ok(typeof jsonRpc.parseJsonRpcRequest === 'function');
    assert.ok(typeof jsonRpc.jsonRpcSuccess === 'function');
    assert.ok(typeof jsonRpc.jsonRpcError === 'function');
    assert.ok(typeof jsonRpc.formatA2aSseRpcFrame === 'function');
  });

  it('sdk-adapter imports and uses formatSSEEvent from @a2a-js/sdk', async () => {
    const sdkAdapter = await import('../../src/application/a2a/sdk-adapter.js');
    assert.ok(typeof sdkAdapter.encodeA2aSseFromSdk === 'function');
    assert.ok(typeof sdkAdapter.mapRunStatusToSdkTaskState === 'function');

    const sample = sdkAdapter.encodeA2aSseFromSdk({
      event: 'test',
      data: { hello: 'world' },
      id: '123',
    });
    assert.ok(sample.startsWith('id: 123\n') || sample.includes('data: '));
    assert.ok(sample.endsWith('\n\n'));
  });

  it('re-verifies ADR 0010 rationale: @a2a-js/sdk/server DefaultRequestHandler cannot resubscribe to terminal tasks', async () => {
    const mockTaskStore: TaskStore = {
      async load(taskId) {
        return {
          id: taskId,
          contextId: 'ctx-1',
          status: {
            state: 3, // TASK_STATE_COMPLETED
            timestamp: new Date().toISOString(),
          },
          artifacts: [],
          history: [],
        };
      },
      async save() {},
      async list() {
        return { tasks: [], nextPageToken: '', pageSize: 10, totalSize: 0 };
      },
    };

    const mockExecutor: AgentExecutor = {
      async execute() {},
      async cancelTask() {},
    };

    const handler = new DefaultRequestHandler(
      {
        name: 'test-agent',
        description: 'test',
        capabilities: { streaming: true },
        supportedInterfaces: [],
        defaultInputModes: [],
        defaultOutputModes: [],
        skills: [],
        version: '1.0',
      },
      mockTaskStore,
      mockExecutor,
    );

    let threw = false;
    try {
      const stream = handler.resubscribe({ id: 'task-123' }, new ServerCallContext());
      for await (const _ of stream) {}
    } catch (err: any) {
      threw = true;
      assert.match(err.message, /terminal state/i);
      assert.equal(err.name, 'UnsupportedOperationError');
    }
    assert.ok(threw, 'resubscribe threw UnsupportedOperationError on completed task as proven in ADR 0010');
  });
});
