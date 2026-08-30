/**
 * Pure projections from a tool result onto durable event payload fields.
 *
 * Kept out of the governance recorder so its transactional/fencing logic stays
 * readable. These only inspect the structured `details` a bridge tool returns,
 * never the model-visible text, which is not a durable contract.
 */

import { normalizeUlid } from '../domain/shared/ulid.js';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

/**
 * Extract only the structured result produced by the formal submit_artifact
 * bridge. Never inspect tool text, which is model-visible and not a durable
 * artifact contract.
 *
 * @param {unknown} result
 * @returns {{ artifactId: string, name: string, mimeType: string, size: number, sha256: string, description: string | null } | null}
 */
/**
 * Managed-process handle from a successful `process_start` result.
 * The process console is reachable only if the durable completed event carries
 * this id, so it is projected next to the tool result rather than left inside
 * the model-facing text.
 * @param result
 * @returns {string | null}
 */
export function extractStartedProcessId(result: unknown) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const details = (result as Record<string, unknown>).details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  return normalizeUlid((details as Record<string, unknown>).processId);
}

export function extractSubmittedArtifact(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const details = (result as Record<string, unknown>).details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;

  const metadata = (details as Record<string, unknown>);
  const artifactId = normalizeUlid(metadata.artifactId);
  const rawName = metadata.displayName ?? metadata.name;
  const name = typeof rawName === 'string' ? rawName : '';
  const mimeType =
    typeof metadata.mimeType === 'string' ? metadata.mimeType : '';
  const size = metadata.size;
  const sha256 = metadata.sha256;
  const rawDescription = metadata.description;

  if (
    !artifactId ||
    !name ||
    name !== name.trim() ||
    name.length > 256 ||
    CONTROL_CHARACTER_PATTERN.test(name) ||
    !mimeType ||
    mimeType !== mimeType.trim() ||
    mimeType.length > 255 ||
    CONTROL_CHARACTER_PATTERN.test(mimeType) ||
    !Number.isSafeInteger(size) ||
    Number(size) < 0 ||
    typeof sha256 !== 'string' ||
    !SHA256_PATTERN.test(sha256) ||
    (rawDescription != null &&
      (typeof rawDescription !== 'string' ||
        !rawDescription ||
        rawDescription !== rawDescription.trim() ||
        rawDescription.length > 1024 ||
        CONTROL_CHARACTER_PATTERN.test(rawDescription)))
  ) {
    return null;
  }

  return {
    artifactId,
    name,
    mimeType,
    size: Number(size),
    sha256,
    description: rawDescription == null ? null : rawDescription,
  };
}
