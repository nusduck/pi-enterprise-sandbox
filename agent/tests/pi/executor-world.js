/**
 * Shared world for PiRunExecutor tests: the durable rows an executed Run
 * expects to already exist (organization, membership, conversation, agent
 * session, sandbox session, agent version, run and triggering message), plus
 * the ids and model that identify them.
 *
 * Extracted so more than one suite can drive a real executor against the fake
 * knex without duplicating the seed.
 */

import { PINNED_PI_SDK_VERSION } from '../../src/infrastructure/pi/pi-runtime-factory.js';

export const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
export const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
export const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
export const SESS = '01K0G2PAV8FPMVC9QHJG7JPN52';
export const VER = '01K0G2PAV8FPMVC9QHJG7JPN5E';
export const WSP = '01K0G2PAV8FPMVC9QHJG7JPN5G';
export const RUN = '01K0G2PAV8FPMVC9QHJG7JPN5H';
export const SBX = '01K0G2PAV8FPMVC9QHJG7JPN5F';
export const TRIG = '01K0G2PAV8FPMVC9QHJG7JPN5J';
export const DEF = '01K0G2PAV8FPMVC9QHJG7JPN5D';

export const fullModel = {
  id: 'test-model',
  name: 'Test',
  api: 'openai-completions',
  provider: 'test',
  baseUrl: 'http://localhost',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
};

export function seedExecutorWorld(state) {
  state.tables.conversations = [
    {
      conversation_id: CONV,
      org_id: ORG,
      user_id: USER,
      agent_id: DEF,
      title: null,
      status: 'active',
      current_agent_session_id: SESS,
      created_at: '2026-07-18 00:00:00.000',
      updated_at: '2026-07-18 00:00:00.000',
      archived_at: null,
    },
  ];
  state.tables.agent_sessions = [
    {
      agent_session_id: SESS,
      org_id: ORG,
      user_id: USER,
      conversation_id: CONV,
      agent_version_id: VER,
      sandbox_session_id: SBX,
      workspace_id: WSP,
      status: 'ACTIVE',
      pi_session_version: 0,
      last_run_id: null,
      execution_fence_token: 0,
      recovery_reason_code: null,
      created_at: '2026-07-18 00:00:00.000',
      updated_at: '2026-07-18 00:00:00.000',
      closed_at: null,
    },
  ];
  state.tables.agent_session_snapshots = [];
  state.tables.agent_definitions = [
    {
      agent_id: DEF,
      org_id: ORG,
      name: 'default',
      description: null,
      status: 'active',
      active_version_id: VER,
      created_by: USER,
      created_at: '2026-07-18 00:00:00.000',
      updated_at: '2026-07-18 00:00:00.000',
    },
  ];
  state.tables.agent_versions = [
    {
      agent_version_id: VER,
      agent_id: DEF,
      version_no: 1,
      config_json: JSON.stringify({ systemPrompt: 'hi' }),
      config_hash: 'a'.repeat(64),
      pi_sdk_version: PINNED_PI_SDK_VERSION,
      status: 'active',
      created_by: USER,
      created_at: '2026-07-18 00:00:00.000',
    },
  ];
  state.tables.messages = [
    {
      message_id: TRIG,
      conversation_id: CONV,
      agent_session_id: SESS,
      run_id: RUN,
      role: 'user',
      message_type: 'text',
      content_json: JSON.stringify({
        messages: [{ role: 'user', content: 'hello world' }],
      }),
      sequence_no: 1,
      pi_entry_id: null,
      pi_entry_kind: null,
      created_at: '2026-07-18 00:00:00.000',
    },
  ];
  state.tables.runs = [
    {
      run_id: RUN,
      org_id: ORG,
      user_id: USER,
      conversation_id: CONV,
      agent_session_id: SESS,
      agent_version_id: VER,
      triggering_message_id: TRIG,
      source: 'api',
      status: 'RUNNING',
      status_reason: null,
      queue_name: 'runs',
      attempt: 1,
      trace_id: 'b'.repeat(32),
      next_event_sequence: 0,
      cancel_requested_at: null,
      cancel_reason: null,
      started_at: '2026-07-18 00:00:00.000',
      completed_at: null,
      created_at: '2026-07-18 00:00:00.000',
      updated_at: '2026-07-18 00:00:00.000',
    },
  ];
  state.tables.run_events = [];
  state.tables.domain_outbox = [];
}
