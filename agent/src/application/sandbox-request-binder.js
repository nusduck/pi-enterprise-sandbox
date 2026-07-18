/**
 * SandboxRequestBinder (PR-07B batch 2B).
 *
 * Binds an immutable request-hash contract to an existing RUNNING sandbox
 * ToolExecution ledger row inside the Agent transaction abstraction, before
 * any Sandbox transport call.
 *
 * Reuses ToolExecutionRepository.bindSandboxRequest semantics:
 * session FOR SHARE → run FOR SHARE → tool FOR UPDATE (direct), ACTIVE session
 * fence + conversation + sandboxSession match, exact toolName, RUNNING
 * sandbox source, NULL→set CAS or exact-same idempotent.
 */

import { assertUlid } from '../domain/shared/ulid.js';
import {
  TOOL_REQUEST_HASH_VERSION,
  computeToolRequestHashV1,
} from '../domain/tool/tool-request-hash.js';
import { assertPositiveSafeInt } from '../infrastructure/mysql/repositories/tool-execution-repository.js';

const REQUEST_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * @param {unknown} hash
 * @returns {string}
 */
function assertRequestHash(hash) {
  if (typeof hash !== 'string' || !REQUEST_HASH_RE.test(hash)) {
    throw new Error('requestHash must be 64 lowercase hex chars');
  }
  return hash;
}

/**
 * @param {unknown} toolCallId
 * @returns {string}
 */
function assertToolCallId(toolCallId) {
  if (typeof toolCallId !== 'string' || !toolCallId || toolCallId !== toolCallId.trim()) {
    throw new Error('toolCallId must be a non-empty already-trimmed string');
  }
  if (toolCallId.length > 255) {
    throw new Error('toolCallId exceeds max length 255');
  }
  return toolCallId;
}

/**
 * @param {unknown} toolName
 * @returns {string}
 */
function assertToolName(toolName) {
  if (typeof toolName !== 'string' || !toolName || toolName !== toolName.trim()) {
    throw new Error('toolName must be a non-empty already-trimmed string');
  }
  if (toolName.length > 255) {
    throw new Error('toolName exceeds max length 255');
  }
  return toolName;
}

/**
 * Compute v1 request hash from tool name + post-normalization args.
 *
 * @param {{ toolName: string, args?: unknown }} input
 * @returns {{ requestHash: string, requestHashVersion: number, canonicalJson: string }}
 */
export function computeSandboxToolRequestHash(input) {
  return computeToolRequestHashV1({
    toolName: input.toolName,
    args: input.args === undefined ? {} : input.args,
  });
}

export class SandboxRequestBinder {
  /**
   * @param {{
   *   transactionManager: { run: (fn: (trx: any) => Promise<any>) => Promise<any> },
   *   createRepositories: (db: any) => any,
   *   context: {
   *     orgId: string,
   *     userId: string,
   *     conversationId: string,
   *     agentSessionId: string,
   *     runId: string,
   *     sandboxSessionId: string,
   *     traceId?: string,
   *   },
   *   executionFenceToken: number,
   * }} deps
   */
  constructor(deps) {
    if (!deps?.transactionManager?.run) {
      throw new Error('SandboxRequestBinder requires transactionManager');
    }
    if (typeof deps.createRepositories !== 'function') {
      throw new Error('SandboxRequestBinder requires createRepositories');
    }
    if (!deps.context?.runId || !deps.context?.agentSessionId) {
      throw new Error('SandboxRequestBinder requires run context with runId and agentSessionId');
    }
    if (
      deps.context.conversationId == null ||
      !String(deps.context.conversationId).trim()
    ) {
      throw new Error('SandboxRequestBinder requires context.conversationId');
    }
    if (
      deps.context.sandboxSessionId == null ||
      !String(deps.context.sandboxSessionId).trim()
    ) {
      throw new Error('SandboxRequestBinder requires context.sandboxSessionId');
    }
    this.tx = deps.transactionManager;
    this.createRepositories = deps.createRepositories;
    this.context = Object.freeze({ ...deps.context });
    this.executionFenceToken = assertPositiveSafeInt(
      deps.executionFenceToken,
      'executionFenceToken',
    );
  }

  /**
   * Bind request hash to the existing RUNNING ToolExecution for this run+toolCall.
   *
   * @param {{
   *   toolCallId: string,
   *   toolName: string,
   *   requestHash: string,
   *   requestHashVersion?: number,
   *   toolExecutionId?: string,
   * }} input
   * @returns {Promise<{
   *   toolExecutionId: string,
   *   requestHash: string,
   *   requestHashVersion: number,
   *   bound: boolean,
   *   toolExecution: object,
   * }>}
   */
  async bindSandboxRequest(input) {
    const toolCallId = assertToolCallId(input.toolCallId);
    const toolName = assertToolName(input.toolName);
    const requestHash = assertRequestHash(input.requestHash);
    const requestHashVersion = assertPositiveSafeInt(
      input.requestHashVersion ?? TOOL_REQUEST_HASH_VERSION,
      'requestHashVersion',
    );
    const runId = assertUlid(this.context.runId, 'runId');
    const agentSessionId = assertUlid(
      this.context.agentSessionId,
      'agentSessionId',
    );
    const conversationId = assertUlid(
      this.context.conversationId,
      'conversationId',
    );
    const sandboxSessionId = assertUlid(
      this.context.sandboxSessionId,
      'sandboxSessionId',
    );

    /** @type {any} */
    let out = null;

    await this.tx.run(async (trx) => {
      const repos = this.createRepositories(trx);
      if (!repos?.toolExecutions?.bindSandboxRequest) {
        throw new Error(
          'createRepositories must wire toolExecutions.bindSandboxRequest',
        );
      }

      /** @type {Record<string, unknown>} */
      const bindInput = {
        runId,
        toolCallId,
        toolName,
        agentSessionId,
        conversationId,
        sandboxSessionId,
        requestHash,
        requestHashVersion,
        executionFenceToken: this.executionFenceToken,
        orgId: this.context.orgId,
        userId: this.context.userId,
      };
      if (
        input.toolExecutionId != null &&
        String(input.toolExecutionId).trim() !== ''
      ) {
        bindInput.toolExecutionId = assertUlid(
          input.toolExecutionId,
          'toolExecutionId',
        );
      }

      const result = await repos.toolExecutions.bindSandboxRequest(bindInput);
      out = {
        toolExecutionId: String(result.toolExecution.toolExecutionId),
        requestHash,
        requestHashVersion,
        bound: Boolean(result.bound),
        toolExecution: result.toolExecution,
      };
    });

    return out;
  }
}

/**
 * Build a binder port from a FencedToolGovernanceRecorder (or compatible).
 *
 * @param {{ bindSandboxRequest: Function }} recorder
 * @returns {{ bindSandboxRequest: Function }}
 */
export function binderPortFromRecorder(recorder) {
  if (!recorder || typeof recorder.bindSandboxRequest !== 'function') {
    throw new Error('binderPortFromRecorder requires bindSandboxRequest');
  }
  return {
    bindSandboxRequest: (input) => recorder.bindSandboxRequest(input),
  };
}
