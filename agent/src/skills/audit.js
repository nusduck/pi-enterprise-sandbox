/**
 * Structured audit log for skill management changes.
 * Emits console JSON lines and optionally appends to a file.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {object} SkillAuditEvent
 * @property {string} action - install | edit | reload | deny
 * @property {string} result - success | failure | denied
 * @property {string} [skill_name]
 * @property {string} [source_type]
 * @property {string} [source]
 * @property {string} [ref]
 * @property {string} [resolved_commit]
 * @property {string} [summary]
 * @property {string} [error]
 * @property {object} [meta]
 */

/**
 * @param {SkillAuditEvent} event
 * @param {{
 *   auditLogPath?: string | null,
 *   sink?: ((ev: object) => void) | null,
 * }} [opts]
 */
export function emitSkillAudit(event, opts = {}) {
  const line = {
    event: 'skill_change',
    ts: new Date().toISOString(),
    action: event.action || 'unknown',
    result: event.result || 'unknown',
    skill_name: event.skill_name ?? null,
    source_type: event.source_type ?? null,
    // Never log credentials; source should already be sanitized
    source: event.source ? String(event.source).slice(0, 500) : null,
    ref: event.ref ?? null,
    resolved_commit: event.resolved_commit ?? null,
    summary: event.summary ? String(event.summary).slice(0, 500) : null,
    error: event.error ? String(event.error).slice(0, 300) : null,
    meta: {
      user_id: event.meta?.user_id ?? event.meta?.userId ?? null,
      organization_id: event.meta?.organization_id ?? event.meta?.orgId ?? null,
      conversation_id: event.meta?.conversation_id ?? event.meta?.conversationId ?? null,
      session_id: event.meta?.session_id ?? event.meta?.sessionId ?? null,
      trace_id: event.meta?.trace_id ?? event.meta?.traceId ?? null,
      actor: event.meta?.actor ?? event.meta?.user_id ?? 'agent',
      skills_mode: event.meta?.skills_mode ?? null,
    },
  };

  if (typeof opts.sink === 'function') {
    try {
      opts.sink(line);
    } catch {
      /* ignore */
    }
  }

  try {
    console.log(`[skill-audit] ${JSON.stringify(line)}`);
  } catch {
    console.log('[skill-audit] <unserializable>');
  }

  const filePath = opts.auditLogPath;
  if (filePath) {
    try {
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(filePath, `${JSON.stringify(line)}\n`, 'utf8');
    } catch (err) {
      console.warn('[skill-audit] failed to write audit file:', err?.message || err);
    }
  }

  return line;
}
