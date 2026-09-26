/**
 * MCP「平台参数」的草稿读写与行投影（docs/design/mcp-per-agent-arguments.md §5）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  argumentValueFromInput,
  hostArgumentRows,
  hostArgumentsFor,
  setToolArgument,
  toolArgumentsIssue,
  toolArgumentsOf,
} from '../src/pages/settings/mcpArgumentHelpers.ts';

const constraints = {
  mcpServers: [
    { serverId: 'qa', toolNames: ['ask'], hostArguments: [{ name: 'kb_id', description: '知识库 ID' }, { name: 'app_id' }] },
    { serverId: 'plain', toolNames: ['x'] },
  ],
};

describe('MCP host arguments in the agent editor', () => {
  it('reads declared names from config options only', () => {
    assert.deepEqual(hostArgumentsFor(constraints, 'qa'), [
      { name: 'kb_id', description: '知识库 ID' },
      { name: 'app_id', description: '' },
    ]);
    assert.deepEqual(hostArgumentsFor(constraints, 'plain'), []);
    assert.deepEqual(hostArgumentsFor(undefined, 'qa'), []);
  });

  it('writes one value without touching other servers or the source', () => {
    const source = {
      mcpServers: [
        { serverId: 'qa', enabledTools: ['ask'] },
        { serverId: 'plain', enabledTools: ['x'], toolArguments: { keep: 'me' } },
      ],
    };
    const next = setToolArgument(source, 'qa', 'kb_id', 'hr');
    assert.deepEqual(toolArgumentsOf(next, 'qa'), { kb_id: 'hr' });
    assert.deepEqual(toolArgumentsOf(next, 'plain'), { keep: 'me' });
    assert.equal('toolArguments' in source.mcpServers[0]!, false);
  });

  it('clears a value, then drops the empty object', () => {
    const one = setToolArgument({ mcpServers: [{ serverId: 'qa', toolArguments: { kb_id: 'hr', app_id: 'a' } }] }, 'qa', 'kb_id', undefined);
    assert.deepEqual(toolArgumentsOf(one, 'qa'), { app_id: 'a' });
    const none = setToolArgument(one, 'qa', 'app_id', undefined);
    assert.equal('toolArguments' in (none.mcpServers as Array<Record<string, unknown>>)[0]!, false);
  });

  it('pauses on a malformed toolArguments instead of overwriting it', () => {
    const malformed = { mcpServers: [{ serverId: 'qa', toolArguments: ['hr'] }] };
    assert.match(String(toolArgumentsIssue(malformed, 'qa')), /must be an object/);
    assert.deepEqual(setToolArgument(malformed, 'qa', 'kb_id', 'x'), malformed);
  });

  it('lists declared rows first and keeps undeclared draft keys as stale rows', () => {
    const rows = hostArgumentRows(hostArgumentsFor(constraints, 'qa'), { kb_id: 'hr', legacy: 3 });
    assert.deepEqual(rows.map((r) => [r.name, r.value, r.stale]), [
      ['kb_id', 'hr', false],
      ['app_id', '', false],
      ['legacy', '3', true],
    ]);
  });

  it('keeps an existing number or boolean type when the input still parses', () => {
    assert.equal(argumentValueFromInput('', 'x'), undefined);
    assert.equal(argumentValueFromInput('5', 3), 5);
    assert.equal(argumentValueFromInput('5a', 3), '5a');
    assert.equal(argumentValueFromInput('false', true), false);
    assert.equal(argumentValueFromInput('42', undefined), '42');
  });
});
