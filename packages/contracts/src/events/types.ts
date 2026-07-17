/**
 * Platform event type catalog (plan §15.2).
 *
 * Frontend, A2A, and audit project from these types — not Pi private events.
 */

export const PLATFORM_EVENT_TYPES = [
  // Run lifecycle
  'run.accepted',
  'run.queued',
  'run.started',
  'run.status.changed',
  'run.completed',
  'run.failed',
  'run.cancelled',

  // Messages
  'message.created',
  'message.delta',
  'message.completed',

  // Model
  'model.request.started',
  'model.request.completed',
  'model.request.failed',

  // Tools
  'tool.call.proposed',
  'tool.execution.started',
  'tool.execution.progress',
  'tool.execution.completed',
  'tool.execution.failed',

  // Process
  'process.started',
  'process.output',
  'process.completed',
  'process.failed',
  'process.cancelled',

  // Approval
  'approval.requested',
  'approval.resolved',

  // Dataset
  'dataset.upload.started',
  'dataset.upload.progress',
  'dataset.ready',
  'dataset.failed',

  // Artifact
  'artifact.ready',

  // Session
  'session.snapshot.saved',
  'session.compacted',

  // Errors
  'error.occurred',
] as const;

export type PlatformEventType = (typeof PLATFORM_EVENT_TYPES)[number];

export function isPlatformEventType(value: unknown): value is PlatformEventType {
  return (
    typeof value === 'string' &&
    (PLATFORM_EVENT_TYPES as readonly string[]).includes(value)
  );
}

/** Group helpers for reducers and projectors. */
export const PLATFORM_EVENT_GROUPS = {
  run: PLATFORM_EVENT_TYPES.filter((t) => t.startsWith('run.')),
  message: PLATFORM_EVENT_TYPES.filter((t) => t.startsWith('message.')),
  model: PLATFORM_EVENT_TYPES.filter((t) => t.startsWith('model.')),
  tool: PLATFORM_EVENT_TYPES.filter((t) => t.startsWith('tool.')),
  process: PLATFORM_EVENT_TYPES.filter((t) => t.startsWith('process.')),
  approval: PLATFORM_EVENT_TYPES.filter((t) => t.startsWith('approval.')),
  dataset: PLATFORM_EVENT_TYPES.filter((t) => t.startsWith('dataset.')),
  artifact: PLATFORM_EVENT_TYPES.filter((t) => t.startsWith('artifact.')),
  session: PLATFORM_EVENT_TYPES.filter((t) => t.startsWith('session.')),
  error: PLATFORM_EVENT_TYPES.filter((t) => t.startsWith('error.')),
} as const;
