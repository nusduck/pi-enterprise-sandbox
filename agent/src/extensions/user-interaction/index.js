/**
 * user-interaction Extension.
 *
 * Registers `ask_user`: a durable pause that persists an interaction request
 * and then rejects the active Pi turn so the executor can checkpoint and
 * return WAITING_INPUT.
 *
 * This lived inside enterprise-policy only because the production bundle was
 * pinned to exactly three extensions. The registry now supports additional
 * first-party extensions, so it sits on its own boundary: policy enforcement
 * and user interaction are unrelated concerns.
 *
 * `ask_user` is still classified by enterprise-policy's tool-risk-classifier
 * (`internal_interaction`) and intercepted by its `tool_call` handler —
 * `tool_call` is a global Pi event, so moving the registration here does not
 * move it outside policy enforcement.
 *
 * A sub-agent Run (`runContext.subagentDepth > 0`) does NOT get the tool. Its
 * task prompt is contractually self-contained, its conversation is deliberately
 * kept out of the owner's list, and nothing routes a child's question to the
 * person who started the parent — so a child that called `ask_user` would park
 * in WAITING_INPUT waiting for an answer nobody can see it asking for. Leaving
 * the tool unregistered makes the model decide or fail instead of hanging; the
 * extension itself still loads, because the registry validates the AgentVersion
 * extension list exactly.
 */

import { Type } from 'typebox';

/**
 * @param {{
 *   runContext: object,
 *   deps?: {
 *     governanceRecorder?: { requestInteraction?: Function } | null,
 *     runSuspensionPort?: {
 *       onDurableInteractionPending?: (signal: object) => Promise<void> | void,
 *     } | null,
 *   },
 * }} options
 */
export function createUserInteractionExtension(options) {
  const runContext = options?.runContext;
  const deps = options?.deps ?? {};
  const governance = deps.governanceRecorder ?? null;
  const suspension = deps.runSuspensionPort ?? null;
  // Depth is written by the executor and frozen into the run context by the
  // bundle; anything above 0 is a child Run.
  const isSubagentRun = Number(runContext?.subagentDepth ?? 0) > 0;

  /**
   * @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi
   */
  function userInteractionExtension(pi) {
    if (isSubagentRun) return;
    pi.registerTool({
      name: 'ask_user',
      label: 'Ask user',
      description:
        'Pause the current run and request required input, confirmation, or a selection from the user.',
      promptSnippet: 'Request user input durably when the task cannot continue without it',
      promptGuidelines: [
        'Use ask_user only when a missing fact or choice would make the rest of the work useless or unsafe if guessed; do not block on niceties.',
      ],
      parameters: Type.Object({
        interaction_type: Type.Union([
          Type.Literal('input'),
          Type.Literal('select'),
          Type.Literal('confirm'),
        ]),
        title: Type.String({ minLength: 1, maxLength: 512 }),
        message: Type.Optional(Type.String({ maxLength: 4000 })),
        options: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
            maxItems: 20,
          }),
        ),
        placeholder: Type.Optional(Type.String({ maxLength: 512 })),
      }),
      async execute(toolCallId, input) {
        if (!governance || typeof governance.requestInteraction !== 'function') {
          throw Object.assign(
            new Error('INTERACTION_DATA_PLANE_UNAVAILABLE: durable interaction recorder is required'),
            { code: 'INTERACTION_DATA_PLANE_UNAVAILABLE' },
          );
        }
        const pending = await governance.requestInteraction({
          toolCallId,
          toolName: 'ask_user',
          args: input,
          interactionType: input.interaction_type,
          title: input.title,
          message: input.message ?? null,
          options: input.options ?? [],
          placeholder: input.placeholder ?? null,
        });
        const durablePending = pending?.durablePending;
        if (!durablePending) {
          throw Object.assign(
            new Error('INTERACTION_PERSIST_FAILED: no durable interaction signal'),
            { code: 'INTERACTION_PERSIST_FAILED' },
          );
        }
        try {
          await suspension?.onDurableInteractionPending?.(durablePending);
        } finally {
          // Reject the active Pi turn after the transaction commits. The
          // executor recognizes the captured durable signal and checkpoints
          // the resulting tool placeholder before returning WAITING_INPUT.
          throw Object.assign(
            new Error(`User interaction pending: ${durablePending.interactionId}`),
            {
              code: 'DURABLE_INTERACTION_PENDING',
              durablePending,
            },
          );
        }
      },
    });

    void runContext;
  }

  userInteractionExtension.extensionName = 'user-interaction';
  userInteractionExtension.extensionMetadata = Object.freeze({
    name: 'user-interaction',
    role: 'durable-user-interaction',
    failClosed: true,
    toolsRegistered: !isSubagentRun,
    durableInteractionPending: !isSubagentRun,
    claimsRunWaitingInput: !isSubagentRun,
  });
  return userInteractionExtension;
}
