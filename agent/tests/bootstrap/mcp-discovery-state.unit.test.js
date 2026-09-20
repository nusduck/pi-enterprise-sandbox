/**
 * K8s 部署评审 K2（docs/reviews/2026-09-19-k8s-deployment）：`McpDiscoveryState`
 * 以前只保存启动期快照，`/ready` 永远看不到 MCP 服务器恢复或掉线。preflight 成功后
 * 每次 `readiness()` 都要重读注册表；给 AgentVersion 校验用的 `inventory()` 在部分
 * 服务器不可用时仍是「清单可知」。
 *
 * 注册表用 `projectMcpReadiness` 的真实投影，只替换「当前注册了哪些工具名」。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { McpDiscoveryState } from '../../src/bootstrap/container-mcp.ts';
import { projectMcpReadiness } from '../../src/runtime/boot.ts';

function registry(initial) {
  const state = { names: initial };
  return {
    state,
    createReader: async () => () => projectMcpReadiness(state.names, ['crm', 'echo']),
  };
}

describe('McpDiscoveryState', () => {
  it('readiness follows the live registry after preflight', async () => {
    const reg = registry(['mcp__echo__echo']);
    const mcp = new McpDiscoveryState({ createReader: reg.createReader });
    await mcp.preflight();

    let r = mcp.readiness();
    assert.equal(r.ready, false);
    assert.equal(r.servers.find((s) => s.server_id === 'crm').connection_status, 'unavailable');

    // crm 恢复：不重启、不再 preflight，/ready 应直接看到。
    reg.state.names = ['mcp__echo__echo', 'mcp__crm__lookup'];
    r = mcp.readiness();
    assert.equal(r.ready, true);
    assert.equal(r.toolCount, 2);

    // echo 重连预算耗尽、工具被注销：同样直接反映。
    reg.state.names = ['mcp__crm__lookup'];
    r = mcp.readiness();
    assert.equal(r.ready, false);
    assert.equal(r.servers.find((s) => s.server_id === 'echo').connection_status, 'unavailable');
  });

  it('inventory stays knowable when only some servers are unavailable', async () => {
    const reg = registry(['mcp__echo__echo']);
    const mcp = new McpDiscoveryState({ createReader: reg.createReader });
    await mcp.preflight();

    const inventory = mcp.inventory();
    assert.equal(inventory.ready, true, '清单可知：健康服务器的引用照常校验');
    const crm = inventory.servers.find((s) => s.server_id === 'crm');
    assert.deepEqual(crm.tools, []);
  });

  it('a failed runtime boot is a failure snapshot, never an empty healthy list', async () => {
    const mcp = new McpDiscoveryState({
      createReader: async () => {
        throw new Error('boot failed');
      },
    });
    await mcp.preflight();
    assert.equal(mcp.readiness().ready, false);
    assert.equal(mcp.inventory().ready, false);
  });

  it('before preflight readiness is not ready', () => {
    const mcp = new McpDiscoveryState({ createReader: async () => () => ({}) });
    assert.equal(mcp.readiness().ready, false);
    assert.equal(mcp.inventory().ready, false);
  });

  it('no MCP configured and none registered is ready', () => {
    const r = projectMcpReadiness(['read', 'write'], []);
    assert.deepEqual(r, { ready: true, serverCount: 0, toolCount: 0, servers: [] });
  });
});
