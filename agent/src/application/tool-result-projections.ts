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

function unwrapSubmittedArtifact(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const root = result as Record<string, unknown>;
  const bags: unknown[] = [root.details, root.value, root];
  const nestedValue = root.value;
  if (nestedValue && typeof nestedValue === 'object' && !Array.isArray(nestedValue)) {
    bags.unshift((nestedValue as Record<string, unknown>).details);
  }
  for (const bag of bags) {
    if (!bag || typeof bag !== 'object' || Array.isArray(bag)) continue;
    const rec = bag as Record<string, unknown>;
    if (
      rec.artifactId != null ||
      rec.artifact_id != null ||
      rec.displayName != null ||
      rec.sha256 != null
    ) {
      return rec;
    }
  }
  return null;
}

export function extractSubmittedArtifact(result) {
  const metadata = unwrapSubmittedArtifact(result);
  if (!metadata) return null;

  const artifactId = normalizeUlid(metadata.artifactId ?? metadata.artifact_id);
  const rawName = metadata.displayName ?? metadata.name;
  const name = typeof rawName === 'string' ? rawName : '';
  const rawMime = metadata.mimeType ?? metadata.mime_type;
  const mimeType =
    typeof rawMime === 'string' && rawMime.trim() !== ''
      ? rawMime
      : 'application/octet-stream';
  const size = metadata.size ?? metadata.sizeBytes ?? metadata.size_bytes;
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

/**
 * `artifact.ready` 事件的负载（design `agent-output-review.md` §4 A1）。
 *
 * 单独成函数是为了让「review 会话多一个 `review_status`」这条规则只有一个写入点：
 * 它同时是前端「已提交审核」卡片与「Run 终态建审核任务」的判据，两个方向都错不得
 * ——多写了 direct 会话会凭空出现审核卡片，少写了 review 会话的交付物会直接当成交付。
 *
 * @param deliveryMode 会话绑定版本的交付模式；缺省 `direct`（漏传只会更保守）。
 */
export function buildArtifactReadyEventData(
  artifact: {
    artifactId: string;
    name: string;
    mimeType: string;
    size: number;
    sha256: string;
    description?: unknown;
  },
  ids: { toolCallId: string; toolExecutionId: string },
  deliveryMode?: string | null,
): Record<string, unknown> {
  return {
    artifactId: artifact.artifactId,
    name: artifact.name,
    mimeType: artifact.mimeType,
    size: artifact.size,
    sha256: artifact.sha256,
    description: artifact.description,
    toolCallId: ids.toolCallId,
    toolExecutionId: ids.toolExecutionId,
    ...(deliveryMode === 'review' ? { review_status: 'pending' } : {}),
  };
}
