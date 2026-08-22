/**
 * subagent-spawn Extension.
 *
 * Registers `spawn_subagent`: creates a durable child Run (source='subagent',
 * parent_run_id = this Run) through the injected spawnPort and returns its
 * runId immediately — the child executes on the same BullMQ queue/worker fleet
 * as any other Run. The parent then polls with `check_subagent` until its
 * children reach a terminal state, so one parent can fan out several children
 * and aggregate their results.
 *
 * Design notes:
 * - The extension never touches MySQL/BullMQ directly; `deps.spawnPort` is the
 *   same port pattern the rest of the bundle uses (recorder, governance).
 * - Depth and concurrency are checked here for a fast, model-readable refusal,
 *   but the port is the authority: it re-checks both inside the spawning
 *   transaction, where a concurrent sibling cannot slip past the count.
 * - Children inherit the parent's org/user identity and trace id through the
 *   port, so ownership scoping and trace correlation are automatic. They do
 *   NOT inherit the parent's AgentSession: a Run holds that session's
 *   execution lock for its whole life, so a child sharing it could never start.
 * - Every tool returns a Pi AgentToolResult (`content` + `details`) built with
 *   the shared sandbox-bridge helpers; a bare object is not a tool result the
 *   SDK can render or hand to the model.
 */

import { Type } from 'typebox';
import { TERMINAL_RUN_STATUS_SET } from '../../domain/run/run-status.js';
import { toolErr, toolOk, toolResultJson } from '../sandbox-bridge/result.js';
import {
  MAX_CONCURRENT_CHILDREN,
  MAX_SUBAGENT_DEPTH,
  SUBAGENT_TOOL_NAMES,
} from './constants.js';

export { SUBAGENT_TOOL_NAMES, MAX_SUBAGENT_DEPTH, MAX_CONCURRENT_CHILDREN };

const MAX_TASK_PROMPT = 16_000;

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 */
function boundedInt(value, fallback, min) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min ? n : fallback;
}

/**
 * @param {{
 *   runContext: { runId: string, orgId: string, userId: string, agentSessionId: string, subagentDepth?: number },
 *   deps?: {
 *     spawnPort?: {
 *       spawn?: Function,
 *       getStatuses?: Function,
 *     } | null,
 *     maxDepth?: number,
 *     maxConcurrent?: number,
 *   },
 * }} options
 */
export function createSubagentSpawnExtension(options) {
  const runContext = options?.runContext;
  const deps = options?.deps ?? {};
  const port = deps.spawnPort ?? null;
  const maxDepth = boundedInt(deps.maxDepth, MAX_SUBAGENT_DEPTH, 0);
  const maxConcurrent = boundedInt(
    deps.maxConcurrent,
    MAX_CONCURRENT_CHILDREN,
    1,
  );
  const depth = boundedInt(runContext?.subagentDepth, 0, 0);

  /**
   * @param {'spawn' | 'getStatuses'} method
   */
  function portFor(method) {
    return port && typeof port[method] === 'function' ? port[method] : null;
  }

  /**
   * Coded refusal for a port that was never injected. Fail closed and say why:
   * a silent "no children" would read to the model as a completed fan-out.
   * @param {'spawn' | 'getStatuses'} method
   */
  function portUnavailable(method) {
    return toolErr(
      'SUBAGENT_PORT_UNAVAILABLE',
      `durable ${method} port is required for sub-agent runs`,
    );
  }

  /**
   * @param {unknown} error
   * @param {string} fallbackCode
   */
  function portError(error, fallbackCode) {
    const code = String(
      /** @type {{ code?: string }} */ (error)?.code || fallbackCode,
    );
    const message =
      error instanceof Error ? error.message : String(error ?? 'failed');
    return toolErr(code, message);
  }

  /**
   * @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi
   */
  function subagentSpawnExtension(pi) {
    pi.registerTool({
      name: 'spawn_subagent',
      label: 'Spawn sub-agent',
      description:
        'Create a child agent run that executes a self-contained task on the same durable run infrastructure. Returns the child run id immediately; poll with check_subagent.',
      promptSnippet:
        'Fan out independent subtasks to parallel child runs instead of doing everything inline',
      promptGuidelines: [
        'Each child must be fully self-contained: it cannot see this conversation and starts in its own empty workspace, so include every requirement, input and expected output in the task prompt.',
        `At most ${maxConcurrent} children may be running at once; use check_subagent to wait for completion before spawning more or aggregating.`,
      ],
      parameters: Type.Object({
        task: Type.String({ minLength: 1, maxLength: MAX_TASK_PROMPT }),
        label: Type.Optional(Type.String({ maxLength: 128 })),
      }),
      async execute(toolCallId, input) {
        const spawn = portFor('spawn');
        if (!spawn) return portUnavailable('spawn');
        if (depth >= maxDepth) {
          return toolErr(
            'SUBAGENT_DEPTH_LIMIT',
            `sub-agent nesting is capped at depth ${maxDepth}; this run is already at depth ${depth}`,
          );
        }
        const label = input.label?.trim() || null;
        try {
          const child = await spawn({
            toolCallId,
            parentRunId: runContext.runId,
            orgId: runContext.orgId,
            userId: runContext.userId,
            agentSessionId: runContext.agentSessionId,
            task: input.task.trim(),
            label,
            depth,
            maxDepth,
            maxConcurrent,
          });
          return toolOk(
            toolResultJson({
              childRunId: child.runId,
              label,
              replayed: child.replayed === true,
              summary:
                'child run accepted; poll check_subagent for terminal status and result',
            }),
            { childRunId: child.runId, ...(label ? { label } : {}) },
          );
        } catch (error) {
          return portError(error, 'SUBAGENT_SPAWN_FAILED');
        }
      },
    });

    pi.registerTool({
      name: 'check_subagent',
      label: 'Check sub-agents',
      description:
        'Report the status of this run’s child runs. Pass no ids to check all children.',
      promptSnippet: 'Poll spawned child runs until they reach a terminal state',
      promptGuidelines: [
        'Call check_subagent after spawning; when allTerminal is true, read each child result summary and continue the parent task.',
      ],
      parameters: Type.Object({
        child_run_ids: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 26 }), {
            maxItems: maxConcurrent,
          }),
        ),
      }),
      async execute(_toolCallId, input) {
        const getStatuses = portFor('getStatuses');
        if (!getStatuses) return portUnavailable('getStatuses');
        try {
          const statuses = await getStatuses({
            parentRunId: runContext.runId,
            orgId: runContext.orgId,
            userId: runContext.userId,
            childRunIds: input.child_run_ids ?? null,
          });
          const children = statuses.map((child) => ({
            runId: String(child.runId),
            status: String(child.status),
            ...(child.statusReason ? { statusReason: child.statusReason } : {}),
            ...(child.label ? { label: child.label } : {}),
            ...(child.resultSummary != null
              ? { resultSummary: child.resultSummary }
              : {}),
          }));
          // No children is *not* "all terminal": a model that spawned nothing
          // must not read an empty list as a finished fan-out.
          const allTerminal =
            children.length > 0 &&
            children.every((child) => TERMINAL_RUN_STATUS_SET.has(child.status));
          return toolOk(
            toolResultJson({ allTerminal, count: children.length, children }),
            { allTerminal, count: children.length },
          );
        } catch (error) {
          return portError(error, 'SUBAGENT_STATUS_FAILED');
        }
      },
    });
  }

  subagentSpawnExtension.extensionName = 'subagent-spawn';
  subagentSpawnExtension.toolNames = SUBAGENT_TOOL_NAMES;
  return subagentSpawnExtension;
}
