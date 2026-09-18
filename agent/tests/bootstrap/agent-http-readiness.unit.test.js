/**
 * Agent HTTP `/ready` 的 data plane 判定（2026-09-18 K8s 演练发现）：此前只看 MySQL / Redis 客户端
 * 对象是否已建，依赖中断时仍报就绪，与 deployment.md「data plane 不可用即 503」不一致。
 * 现在与 Worker 探针共用 `pingDependencies`：`SELECT 1` 与 `PING` 各自超时。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isDataPlaneReachable } from '../../src/bootstrap/worker-probe.js';

function fakeContainer({ started = true, mysql = async () => [[{}]], redis = async () => 'PONG' } = {}) {
  return {
    knex: { raw: mysql },
    redis: { ping: redis },
    isDataPlaneReady() {
      return started;
    },
  };
}

describe('isDataPlaneReachable', () => {
  it('is reachable only when both pings succeed', async () => {
    assert.equal(await isDataPlaneReachable(fakeContainer()), true);
  });

  it('is not reachable before the container has started, without pinging', async () => {
    let pinged = false;
    const container = fakeContainer({
      started: false,
      mysql: async () => {
        pinged = true;
        return [[{}]];
      },
    });
    assert.equal(await isDataPlaneReachable(container), false);
    assert.equal(pinged, false);
  });

  it('is not reachable when Redis rejects', async () => {
    const container = fakeContainer({ redis: async () => Promise.reject(new Error('ECONNREFUSED')) });
    assert.equal(await isDataPlaneReachable(container), false);
  });

  it('is not reachable when MySQL hangs past the timeout', async () => {
    const container = fakeContainer({ mysql: () => new Promise(() => {}) });
    const startedAt = Date.now();
    assert.equal(await isDataPlaneReachable(container, 50), false);
    assert.ok(Date.now() - startedAt < 1_000);
  });
});
