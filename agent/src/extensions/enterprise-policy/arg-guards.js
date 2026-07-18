/**
 * Argument-level policy guards for local tools (deny, not approval).
 */

import { SENSITIVE_ENV_KEY } from '../sandbox-bridge/constants.js';
import {
  commandLooksLikeHostEscape,
  normalizeLogicalPath,
  normalizeWritePath,
} from '../sandbox-bridge/path-guards.js';
import { makePolicyDecision } from './policy-decision.js';

/**
 * @param {string} toolName
 * @param {unknown} args
 * @returns {import('./policy-decision.js').PolicyDecision | null} deny decision or null if ok
 */
export function evaluateLocalArgGuards(toolName, args) {
  const a = args && typeof args === 'object' ? /** @type {Record<string, unknown>} */ (args) : {};

  if (toolName === 'read') {
    const n = normalizeLogicalPath(a.path, { allowSkillRead: true });
    if (!n.ok) {
      return makePolicyDecision({
        decision: 'deny',
        reasonCode: n.code,
        reason: n.reason,
        policyId: 'platform:path-guard',
        riskLevel: 'high',
      });
    }
    return null;
  }

  if (toolName === 'write' || toolName === 'edit' || toolName === 'submit_artifact') {
    const n = normalizeWritePath(a.path);
    if (!n.ok) {
      return makePolicyDecision({
        decision: 'deny',
        reasonCode: n.code,
        reason: n.reason,
        policyId: 'platform:path-guard',
        riskLevel: 'high',
      });
    }
    return null;
  }

  if (toolName === 'bash' || toolName === 'process_start') {
    const command = String(a.command ?? '');
    if (commandLooksLikeHostEscape(command)) {
      return makePolicyDecision({
        decision: 'deny',
        reasonCode: 'HOST_ESCAPE_DENIED',
        reason: 'command appears to target host escape paths or privileged tools',
        policyId: 'platform:host-escape',
        riskLevel: 'critical',
      });
    }
    // skill write via shell
    if (/\/home\/sandbox\/skill\//.test(command) && /\b(?:rm|mv|cp|tee|dd|install|chmod|chown|:\s*>|>>)\b/.test(command)) {
      return makePolicyDecision({
        decision: 'deny',
        reasonCode: 'PATH_SKILL_WRITE_DENIED',
        reason: 'shell mutation of skill directory denied',
        policyId: 'platform:path-guard',
        riskLevel: 'high',
      });
    }
    const env = a.env;
    if (env && typeof env === 'object' && !Array.isArray(env)) {
      for (const key of Object.keys(env)) {
        if (SENSITIVE_ENV_KEY.test(key)) {
          return makePolicyDecision({
            decision: 'deny',
            reasonCode: 'ENV_SENSITIVE_KEY_DENIED',
            reason: `sensitive env key denied: ${key}`,
            policyId: 'platform:env-guard',
            riskLevel: 'critical',
          });
        }
      }
    }
    return null;
  }

  if (toolName === 'python') {
    const code = String(a.code ?? '');
    if (commandLooksLikeHostEscape(code)) {
      return makePolicyDecision({
        decision: 'deny',
        reasonCode: 'HOST_ESCAPE_DENIED',
        reason: 'python code appears to target host escape',
        policyId: 'platform:host-escape',
        riskLevel: 'critical',
      });
    }
    return null;
  }

  return null;
}
