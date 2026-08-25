/**
 * Standard A2A v0.3 JSON-RPC client (simulates a2a-python / a2a-js).
 *
 * Wire rules this client enforces:
 * - Methods: message/send, message/stream, tasks/get, tasks/cancel, tasks/resubscribe
 * - Header A2A-Version: 0.3
 * - SSE `data:` lines are JSON-RPC 2.0; discriminate on result.kind
 * - Stream grammar §3.1.2 (Task then status-update|artifact-update)
 */

import {
  A2A_PROTOCOL_VERSION,
} from '../../src/application/a2a/json-rpc.js';
import {
  assertA2aStreamResult,
  assertOfficialStreamGrammar,
} from '../../src/application/a2a/stream-event-schema.js';

export class StandardA2aClient {
  /**
   * @param {{
   *   baseUrl: string,
   *   token: string,
   *   agentId: string,
   *   fetchImpl?: typeof fetch,
   *   configuration?: Record<string, unknown> | null,
   * }} opts
   */
  constructor(opts) {
    this.baseUrl = String(opts.baseUrl).replace(/\/$/, '');
    this.token = opts.token;
    this.agentId = opts.agentId;
    this.fetchImpl = opts.fetchImpl || fetch;
    this.rpcPath = `${this.baseUrl}/a2a/agents/${this.agentId}`;
    this.nextId = 1;
    // a2a-python's ClientFactory always attaches a MessageSendConfiguration,
    // and ClientConfig.accepted_output_modes defaults to an empty list. Send
    // the same thing so the simulator exercises the real wire shape.
    this.configuration = opts.configuration ?? {
      acceptedOutputModes: [],
      blocking: false,
    };
  }

  /**
   * @returns {Promise<object>}
   */
  async getAgentCard() {
    const res = await this.fetchImpl(
      `${this.rpcPath}/.well-known/agent-card.json`,
      { headers: this.#headers() },
    );
    const card = await res.json();
    if (res.status !== 200) {
      throw new StandardA2aClientError('agent card request failed', {
        status: res.status,
        body: card,
      });
    }
    if (card.protocolVersion !== A2A_PROTOCOL_VERSION) {
      throw new StandardA2aClientError('unsupported agent protocolVersion', {
        protocolVersion: card.protocolVersion,
      });
    }
    if (card.capabilities?.streaming !== true) {
      throw new StandardA2aClientError('agent does not advertise streaming');
    }
    return card;
  }

  /**
   * @param {{ text: string, messageId?: string, contextId?: string, taskId?: string }} input
   * @returns {Promise<object>} Task
   */
  async sendMessage(input) {
    const rpc = await this.#rpc('message/send', {
      message: this.#userMessage(input),
      configuration: this.configuration,
      metadata: null,
    });
    assertA2aStreamResult(rpc.result);
    if (rpc.result.kind !== 'task') {
      throw new StandardA2aClientError('message/send expected Task', {
        kind: rpc.result.kind,
      });
    }
    return rpc.result;
  }

  /**
   * @param {{ text: string, messageId?: string, contextId?: string, taskId?: string }} input
   * @returns {Promise<object[]>} official StreamResponse results
   */
  async sendStreamingMessage(input) {
    const results = await this.#rpcStream('message/stream', {
      message: this.#userMessage(input),
      configuration: this.configuration,
      metadata: null,
    });
    return assertOfficialStreamGrammar(results);
  }

  /**
   * @param {string} taskId
   * @param {{ historyLength?: number }} [opts]
   */
  async getTask(taskId, opts = {}) {
    /** @type {Record<string, unknown>} */
    const params = { id: taskId };
    if (opts.historyLength != null) params.historyLength = opts.historyLength;
    const rpc = await this.#rpc('tasks/get', params);
    assertA2aStreamResult(rpc.result);
    return rpc.result;
  }

  /**
   * @param {string} taskId
   */
  async cancelTask(taskId) {
    const rpc = await this.#rpc('tasks/cancel', { id: taskId });
    assertA2aStreamResult(rpc.result);
    return rpc.result;
  }

  /**
   * @param {string} taskId
   * @returns {Promise<object[]>}
   */
  async resubscribe(taskId) {
    const results = await this.#rpcStream('tasks/resubscribe', { id: taskId });
    return assertOfficialStreamGrammar(results);
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} params
   */
  async #rpc(method, params) {
    const id = this.nextId;
    this.nextId += 1;
    const res = await this.fetchImpl(this.rpcPath, {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params,
      }),
    });
    const body = await res.json();
    if (body?.error) {
      throw new StandardA2aClientError(body.error.message || 'rpc error', {
        status: res.status,
        error: body.error,
      });
    }
    if (body?.jsonrpc !== '2.0' || body?.result == null) {
      throw new StandardA2aClientError('invalid JSON-RPC response', {
        status: res.status,
        body,
      });
    }
    return body;
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} params
   * @returns {Promise<object[]>}
   */
  async #rpcStream(method, params) {
    const id = this.nextId;
    this.nextId += 1;
    const res = await this.fetchImpl(this.rpcPath, {
      method: 'POST',
      headers: {
        ...this.#headers(),
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params,
      }),
    });
    const contentType = String(res.headers.get('content-type') || '');
    const text = await res.text();
    if (!contentType.includes('text/event-stream')) {
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      throw new StandardA2aClientError('expected text/event-stream', {
        status: res.status,
        contentType,
        body: parsed,
      });
    }
    return parseOfficialJsonRpcSse(text);
  }

  /**
   * @param {{ text: string, messageId?: string, contextId?: string, taskId?: string }} input
   */
  #userMessage(input) {
    /** @type {Record<string, unknown>} */
    const message = {
      kind: 'message',
      role: 'user',
      messageId: input.messageId || `msg-${this.nextId}`,
      parts: [{ kind: 'text', text: input.text }],
    };
    if (input.contextId) message.contextId = input.contextId;
    if (input.taskId) message.taskId = input.taskId;
    return message;
  }

  #headers() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.token}`,
      'A2A-Version': A2A_PROTOCOL_VERSION,
    };
  }
}

export class StandardA2aClientError extends Error {
  /**
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'StandardA2aClientError';
    this.details = details;
  }
}

/**
 * Parse official JSON-RPC SSE (`data:` lines only; ignore comments / event:).
 *
 * @param {string} text
 * @returns {object[]}
 */
export function parseOfficialJsonRpcSse(text) {
  const results = [];
  const blocks = String(text || '').split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.replace(/^data:\s?/, ''))
      .join('\n');
    if (!data.trim()) continue;
    let rpc;
    try {
      rpc = JSON.parse(data);
    } catch (err) {
      throw new StandardA2aClientError('SSE data is not JSON', {
        data,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
    if (rpc.jsonrpc !== '2.0') {
      throw new StandardA2aClientError('SSE frame is not JSON-RPC 2.0', { rpc });
    }
    if (rpc.error) {
      throw new StandardA2aClientError(rpc.error.message || 'stream rpc error', {
        error: rpc.error,
      });
    }
    assertA2aStreamResult(rpc.result);
    results.push(rpc.result);
  }
  return results;
}
