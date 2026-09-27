/**
 * 宿主参数纯函数（docs/design/mcp-per-agent-arguments.md D1–D4）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOST_ARGUMENTS_MAX,
  hostKeysForSchema,
  hostValueTypeMismatches,
  mergeHostArguments,
  missingRequiredHostArguments,
  parseHostArgumentDeclaration,
  parseToolArguments,
  readHostArgumentDeclarations,
  stripHostArguments,
} from '../../src/domain/agent/mcp-host-arguments.ts';

const schema = {
  type: 'object',
  properties: { question: { type: 'string' }, kb_id: { type: 'string' }, top_k: { type: 'integer' } },
  required: ['question', 'kb_id'],
};

describe('hostArguments declaration (MCP_SERVERS_JSON)', () => {
  it('accepts names with descriptions and treats absence as none', () => {
    assert.deepEqual(parseHostArgumentDeclaration('qa', undefined), {});
    assert.deepEqual(
      parseHostArgumentDeclaration('qa', { kb_id: { description: ' 知识库 ID ' }, app_id: {} }),
      { kb_id: { description: '知识库 ID' }, app_id: { description: '' } },
    );
  });

  it('rejects bad shapes, bad names, too many entries and credential-looking names', () => {
    assert.throws(() => parseHostArgumentDeclaration('qa', ['kb_id']), /must be an object/);
    assert.throws(() => parseHostArgumentDeclaration('qa', { 'kb-id': {} }), /not a valid argument name/);
    assert.throws(() => parseHostArgumentDeclaration('qa', { kb_id: 'x' }), /must be an object/);
    const many = Object.fromEntries(Array.from({ length: HOST_ARGUMENTS_MAX + 1 }, (_, i) => [`a${i}`, {}]));
    assert.throws(() => parseHostArgumentDeclaration('qa', many), /more than/);
    for (const name of ['api_key', 'accessToken', 'client_secret', 'password', 'Authorization', 'credential_id']) {
      assert.throws(() => parseHostArgumentDeclaration('qa', { [name]: {} }), /looks like a credential/, name);
    }
  });

  it('only reads enabled servers that declare something', () => {
    const map = readHostArgumentDeclarations([
      { id: 'qa', hostArguments: { kb_id: {} } },
      { serverId: 'plain', url: 'http://x' },
      { id: 'off', enabled: false, hostArguments: { 'bad-name': {} } },
    ]);
    assert.deepEqual([...map.keys()], ['qa']);
    assert.throws(() => readHostArgumentDeclarations([{ id: 'qa', hostArguments: { api_key: {} } }]));
  });
});

describe('toolArguments (AgentVersion)', () => {
  const declared = parseHostArgumentDeclaration('qa', { kb_id: {}, app_id: {} });

  it('accepts declared scalar values', () => {
    const { values, errors } = parseToolArguments({ kb_id: 'hr', app_id: 7 }, 'mcpServers[0].toolArguments', declared);
    assert.deepEqual(errors, []);
    assert.deepEqual(values, { kb_id: 'hr', app_id: 7 });
    assert.deepEqual(parseToolArguments(undefined, 'p', declared), { values: {}, errors: [] });
  });

  it('diagnoses each bad field and withholds partial values', () => {
    const { values, errors } = parseToolArguments(
      { kb_id: { nested: true }, other: 'x', app_id: 'y'.repeat(1025) },
      'mcpServers[0].toolArguments',
      declared,
    );
    assert.equal(values, null);
    assert.deepEqual(errors.map((e) => [e.path, e.code]), [
      ['mcpServers[0].toolArguments.kb_id', 'MCP_ARGUMENT_INVALID'],
      ['mcpServers[0].toolArguments.other', 'MCP_ARGUMENT_UNKNOWN'],
      ['mcpServers[0].toolArguments.app_id', 'MCP_ARGUMENT_INVALID'],
    ]);
    assert.equal(parseToolArguments(['x'], 'p', declared).errors[0]?.code, 'CONFIG_TYPE');
  });

  it('checks shape only when no declaration is given (Run-time binding)', () => {
    assert.deepEqual(parseToolArguments({ anything: 'x' }, 'p').errors, []);
    assert.equal(parseToolArguments({ 'bad-name': 'x' }, 'p').errors[0]?.code, 'MCP_ARGUMENT_UNKNOWN');
  });
});

describe('schema projection and merging', () => {
  const spec = parseHostArgumentDeclaration('qa', { kb_id: {}, app_id: {} });

  it('affects only declared keys the tool actually has', () => {
    assert.deepEqual(hostKeysForSchema(schema, spec), ['kb_id']);
    assert.deepEqual(hostKeysForSchema({ type: 'object', properties: {} }, spec), []);
  });

  it('strips properties and required entries without touching the source', () => {
    const stripped = stripHostArguments(schema, ['kb_id']);
    assert.deepEqual(Object.keys(stripped.properties as object), ['question', 'top_k']);
    assert.deepEqual(stripped.required, ['question']);
    assert.deepEqual(schema.required, ['question', 'kb_id']);
    assert.ok('kb_id' in schema.properties);
  });

  it('reports required host arguments with no value', () => {
    assert.deepEqual(missingRequiredHostArguments(schema, ['kb_id'], {}), ['kb_id']);
    assert.deepEqual(missingRequiredHostArguments(schema, ['kb_id'], { kb_id: 'hr' }), []);
    assert.deepEqual(missingRequiredHostArguments({ properties: { kb_id: {} } }, ['kb_id'], {}), []);
  });

  it('drops model-supplied host arguments and applies host values', () => {
    assert.deepEqual(
      mergeHostArguments({ question: 'q', kb_id: 'finance' }, ['kb_id'], { kb_id: 'hr' }),
      { question: 'q', kb_id: 'hr' },
    );
    // No host value for an optional host argument: the model still cannot set it.
    assert.deepEqual(mergeHostArguments({ question: 'q', kb_id: 'finance' }, ['kb_id'], {}), { question: 'q' });
  });

  it('flags host values whose type contradicts the tool schema', () => {
    const typed = { properties: { kb_id: { type: 'string' }, top_k: { type: 'integer' }, flag: { type: ['boolean', 'null'] } } };
    assert.deepEqual(hostValueTypeMismatches(typed, ['kb_id', 'top_k', 'flag'], { kb_id: 3, top_k: 1.5, flag: true }), ['kb_id', 'top_k']);
    assert.deepEqual(hostValueTypeMismatches(typed, ['kb_id'], { kb_id: 'hr' }), []);
  });
});
