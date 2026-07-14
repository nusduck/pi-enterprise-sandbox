const pendingById = new Map();
const runToInteraction = new Map();

export class InputSuspendedError extends Error {
  constructor(pending) {
    super(`Input suspended: ${pending?.interaction_id || 'unknown'}`);
    this.name = 'InputSuspendedError';
    this.pending = pending;
  }
}

export function registerPendingInput(pending) {
  if (!pending?.interaction_id) throw new Error('interaction_id required');
  pendingById.set(pending.interaction_id, { ...pending });
  if (pending.run_id) runToInteraction.set(pending.run_id, pending.interaction_id);
  return pending;
}

export function getPendingInput(interactionId) {
  return pendingById.get(interactionId) || null;
}

export function getPendingInputForRun(runId) {
  const id = runToInteraction.get(runId);
  return id ? getPendingInput(id) : null;
}

export function clearPendingInput(interactionId) {
  const pending = pendingById.get(interactionId);
  if (pending?.run_id) runToInteraction.delete(pending.run_id);
  pendingById.delete(interactionId);
}

export function _resetPendingInputs() {
  pendingById.clear();
  runToInteraction.clear();
}
