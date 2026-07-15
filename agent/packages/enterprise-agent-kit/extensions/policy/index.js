/**
 * Sandbox security governance helpers + SDK Extension factory.
 *
 * Dual-enforcement model:
 * - Agent layer (Policy + Sandbox Tools Extensions): early policy, approval UX,
 *   write serialization, audit meta injection.
 * - Sandbox layer: independent hard-deny / path / session / approval checks.
 *
 * Extension exceptions are fail-closed (block the tool).
 *
 * Skill tree writes: generic write/edit/bash cannot target skill roots;
 * only dedicated skill_* tools (development mode) may mutate skills.
 */
import {
  DEFAULT_SKILL_ROOTS,
  isUnderSkillRoot,
  commandTouchesSkillRoot,
  isReadonlySkillExecution,
} from '../../../../skills/paths.js';

/** Immutable policy catalog version echoed in audits and approval responses. */
export const POLICY_VERSION = '2026-07-15.1';
export const POLICY_PROFILES = Object.freeze({ STRICT: 'strict', BALANCED: 'balanced' });

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function hasEffectiveBubblewrap(env = process.env) {
  return (
    String(env?.SANDBOX_ISOLATION_BACKEND || '').trim().toLowerCase() === 'bubblewrap' &&
    isTruthy(env?.SANDBOX_ISOLATION_REQUIRED)
  );
}

/** Return the requested profile, rejecting unknown values. */
export function requestedPolicyProfile(env = process.env) {
  const raw = String(env?.SANDBOX_POLICY_PROFILE || 'strict').trim().toLowerCase();
  if (!['strict', 'balanced'].includes(raw)) {
    throw new Error(
      `Invalid SANDBOX_POLICY_PROFILE=${raw || '<empty>'}; expected strict|balanced`,
    );
  }
  return raw;
}

/** Balanced never activates unless the effective Sandbox is required bwrap. */
export function resolvePolicyProfile(env = process.env) {
  const requested = requestedPolicyProfile(env);
  if (requested === POLICY_PROFILES.BALANCED && !hasEffectiveBubblewrap(env)) {
    throw new Error(
      'SANDBOX_POLICY_PROFILE=balanced requires effective SANDBOX_ISOLATION_BACKEND=bubblewrap and SANDBOX_ISOLATION_REQUIRED=true',
    );
  }
  return requested;
}

/** Side-effect classes for concurrency control. */
export const TOOL_SIDE_EFFECT = Object.freeze({
  READ: 'read',
  WRITE: 'write',
});

/** Three-tier policy decisions. */
export const POLICY_DECISION = Object.freeze({
  ALLOW: 'allow',
  APPROVAL_REQUIRED: 'approval_required',
  HARD_DENY: 'hard_deny',
});

/** Known safe-parallel (read-only) tools. */
const READ_TOOLS = new Set([
  'read',
  'read_file',
  'ls',
  'find',
  'grep',
  'list_files',
  'preview_file',
  'view_file',
  'cat',
  'head',
  'tail',
  // Process Manager read/observe tools
  'process_status',
  'process_logs',
  'process_wait',
]);

/** Known write / side-effect tools (serial per workspace). */
const WRITE_TOOLS = new Set([
  'write',
  'write_file',
  'edit',
  'edit_file',
  'apply_patch',
  'bash',
  'command',
  'raw_bash',
  'raw_shell',
  'submit_artifact',
  'delete_file',
  'network_request',
  'package_install',
  'pip_install',
  'npm_install',
  'kill_process',
  'run_python',
  // Process Manager control tools
  'process_start',
  'process_write_stdin',
  'process_signal',
  'process_cancel',
  // Skill management (development mode only; still serial write-class)
  'skill_install',
  'skill_edit',
  'skill_reload',
]);

/** MCP tools are treated as write-class by default (unknown side effects). */
function isMcpTool(toolName) {
  return typeof toolName === 'string' && toolName.startsWith('mcp_');
}

/** Generic tools that must never write the shared skill tree. */
const SKILL_ROOT_BLOCKED_TOOLS = new Set([
  'write',
  'write_file',
  'edit',
  'edit_file',
  'apply_patch',
  'bash',
  'command',
  'raw_bash',
  'raw_shell',
  'submit_artifact',
  'delete_file',
]);

/** Always blocked command prefixes (hard deny; cannot be approved). */
const HARD_DENY_PREFIXES = [
  'sudo',
  'su ',
  'chmod 777',
  'chown ',
  'rm -rf /',
  'rm -rf /*',
  'dd if=',
  'mkfs.',
  'fdisk',
  '> /dev/',
  '< /dev/',
];

const PRIVILEGE_COMMANDS = new Set(['sudo', 'su', 'doas', 'runuser']);
const NAMESPACE_COMMANDS = new Set([
  'bwrap', 'capsh', 'chroot', 'mount', 'newgidmap', 'newuidmap',
  'nsenter', 'pivot_root', 'setns', 'setpriv', 'umount', 'unshare',
]);
const DEVICE_COMMANDS = new Set([
  'blkdiscard', 'blockdev', 'fdisk', 'insmod', 'iptables', 'ip6tables',
  'losetup', 'mknod', 'modprobe', 'nft', 'rmmod', 'swapon', 'swapoff',
]);
const CAPABILITY_COMMANDS = new Set(['setcap']);
const NETWORK_MUTATION_VERBS = new Set([
  'add', 'append', 'change', 'del', 'delete', 'flush', 'prepend', 'remove', 'replace', 'set',
]);
const SAFE_DEVICE_NAMES = new Set([
  'full', 'null', 'random', 'stderr', 'stdin', 'stdout', 'tty', 'urandom', 'zero',
]);
const SENSITIVE_HOST_PATHS = [
  '/etc/shadow',
  '/etc/gshadow',
  '/etc/passwd-',
  '/run/secrets',
  '/var/run/secrets',
  '/var/sandbox/workspaces',
  '/var/sandbox/tmp',
  '/sandbox/workspaces',
  '/sandbox/tmp',
  '/sandbox/data',
  '/var/run/docker.sock',
];
const SENSITIVE_PROC_RE = /\/proc\/\d+\/(?:environ|mem|syscall)(?:\b|\/)/i;
const DANGEROUS_DEVICE_REDIRECT_RE = new RegExp(
  String.raw`(?:>{1,2}|<)\s*(?:/dev/(?!${[...SAFE_DEVICE_NAMES].join('|')}(?:\b|$))[^\s;&|()]+|/proc/(?:sys|kcore|keys)(?:\/|\b)|/sys(?:\/|\b))`,
  'i',
);
const METADATA_DESTINATIONS = [
  '169.254.',
  'metadata.google.internal',
  'metadata.amazonaws.com',
  '169.254.170.2',
];
const POLICY_PARSE_ERROR = '__policy_parse_error__';
const SHELL_WRAPPERS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh']);

/** Bash substrings that elevate to human approval when APPROVAL_ENABLED. */
const APPROVAL_REQUIRED_SUBSTRINGS = [
  'rm -rf',
  'rm -r ',
  'mkfs',
  'dd if=',
  'curl ',
  'wget ',
  'nc ',
  'ncat ',
  'pip install',
  'pip3 install',
  'python -m pip install',
  'python3 -m pip install',
  'npm install',
  'npm i ',
  'npm ci',
  'yarn add',
  'yarn install',
  'pnpm add',
  'pnpm install',
  'chmod ',
  'chown ',
  'kill ',
  'pkill ',
  'eval ',
  'base64 -d',
];

const BALANCED_APPROVAL_SUBSTRINGS = [
  'rm -rf',
  'rm -r ',
  'mkfs',
  'dd if=',
  'chmod ',
  'chown ',
  'kill ',
  'pkill ',
  'eval ',
  'base64 -d',
  'curl ',
  'wget ',
  'nc ',
  'ncat ',
];

/** Tools that are always high-risk (approval_required unless hard-denied). */
const HIGH_RISK_TOOLS = new Set([
  'raw_bash',
  'raw_shell',
  'delete_file',
  'network_request',
  'package_install',
  'pip_install',
  'npm_install',
  'kill_process',
  // Arbitrary signals can be destructive; cancel is a managed lifecycle op (not high-risk).
  'process_signal',
]);

/**
 * Classify tool concurrency class. Unknown tools are treated as write (serial).
 * @param {string} toolName
 * @returns {'read' | 'write'}
 */
export function classifyToolSideEffect(toolName) {
  const name = String(toolName || '').trim();
  if (!name) return TOOL_SIDE_EFFECT.WRITE;
  if (READ_TOOLS.has(name)) return TOOL_SIDE_EFFECT.READ;
  if (WRITE_TOOLS.has(name) || isMcpTool(name)) return TOOL_SIDE_EFFECT.WRITE;
  // Unknown tools default to write (serial + fail-closed approval path)
  return TOOL_SIDE_EFFECT.WRITE;
}

function splitShellSegments(command) {
  const segments = [];
  let current = '';
  let quote = null;
  let escaped = false;
  const text = String(command || '');
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && !quote) {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      current += char;
      quote = char;
      continue;
    }
    if (char === ';' || char === '&' || char === '|' || char === '\n') {
      if (char === '&' || char === '|') {
        const next = text[i + 1];
        if (next === char) i += 1;
      }
      segments.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments;
}

function tokenizeShellSegment(segment) {
  const words = [];
  let current = '';
  let quote = null;
  let escaped = false;
  for (const char of String(segment || '')) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && !quote) {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (escaped || quote) return null;
  if (current) words.push(current);
  return words;
}

function shellSegments(command, depth = 0) {
  if (depth > 8) return [[POLICY_PARSE_ERROR]];
  const parsed = [];
  for (const segment of splitShellSegments(command)) {
    const words = tokenizeShellSegment(segment);
    if (!words || words.length === 0) {
      if (words === null) parsed.push([POLICY_PARSE_ERROR]);
      continue;
    }
    while (words.length > 0) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
        words.shift();
        continue;
      }
      const executable = String(words[0]).split('/').pop().toLowerCase();
      if (executable === 'command') {
        words.shift();
        while (words.length > 0 && words[0] !== '--' && words[0].startsWith('-')) {
          if (words.shift() !== '-p') {
            parsed.push([POLICY_PARSE_ERROR]);
            words.length = 0;
            break;
          }
        }
        if (words[0] === '--') words.shift();
        continue;
      }
      if (executable === 'exec') {
        words.shift();
        while (words.length > 0 && words[0] !== '--' && words[0].startsWith('-')) {
          const option = words.shift();
          if (option === '-a') {
            if (words.length === 0) {
              parsed.push([POLICY_PARSE_ERROR]);
              words.length = 0;
              break;
            }
            words.shift();
          } else if (option.startsWith('-a') && option.length > 2) {
            continue;
          } else if (option.startsWith('-') && [...option.slice(1)].every((char) => ['c', 'l'].includes(char))) {
            continue;
          } else {
            parsed.push([POLICY_PARSE_ERROR]);
            words.length = 0;
            break;
          }
        }
        if (words[0] === '--') words.shift();
        continue;
      }
      if (executable === 'env') {
        words.shift();
        while (words.length > 0) {
          if (words[0] === '--') {
            words.shift();
            break;
          }
          if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
            words.shift();
            continue;
          }
          if (!words[0].startsWith('-')) break;
          const option = words.shift();
          if (['-u', '--unset', '-C', '--chdir', '-S', '--split-string'].includes(option)) {
            if (words.length === 0) {
              parsed.push([POLICY_PARSE_ERROR]);
              words.length = 0;
              break;
            }
            const value = words.shift();
            if (['-S', '--split-string'].includes(option)) {
              parsed.push(...shellSegments(value, depth + 1));
            }
          } else if (
            option.startsWith('-u') ||
            option.startsWith('--unset=') ||
            option.startsWith('-C') ||
            option.startsWith('--chdir=')
          ) {
            continue;
          } else if (option.startsWith('-S')) {
            parsed.push(...shellSegments(option.slice(2), depth + 1));
          } else if (option.startsWith('--split-string=')) {
            parsed.push(...shellSegments(option.split('=', 2)[1], depth + 1));
          } else if (['-i', '--ignore-environment', '-0', '--null'].includes(option)) {
            continue;
          } else {
            parsed.push([POLICY_PARSE_ERROR]);
            words.length = 0;
            break;
          }
        }
        continue;
      }
      if (executable === 'timeout') {
        words.shift();
        while (words.length > 0 && words[0] !== '--' && words[0].startsWith('-')) {
          const option = words.shift();
          if (['-k', '-s', '--kill-after', '--signal'].includes(option)) {
            if (words.length === 0) {
              parsed.push([POLICY_PARSE_ERROR]);
              words.length = 0;
              break;
            }
            words.shift();
          } else if (
            option.startsWith('-k') ||
            option.startsWith('-s') ||
            option.startsWith('--kill-after=') ||
            option.startsWith('--signal=')
          ) {
            continue;
          } else if (['--preserve-status', '--foreground', '--verbose'].includes(option)) {
            continue;
          } else {
            parsed.push([POLICY_PARSE_ERROR]);
            words.length = 0;
            break;
          }
        }
        if (words[0] === '--') words.shift();
        if (words.length > 0) words.shift(); // duration, e.g. 10 or 1m
        else parsed.push([POLICY_PARSE_ERROR]);
        continue;
      }
      if (SHELL_WRAPPERS.has(executable)) {
        words.shift();
        let payload = null;
        let shellError = false;
        while (words.length > 0) {
          const option = words.shift();
          if (option === '-c') {
            if (words.length === 0) shellError = true;
            else payload = words.shift();
            break;
          }
          if (option.startsWith('-')) {
            if (['-e', '-i', '-l', '-s', '-u', '-v', '-x', '-f'].includes(option)) continue;
            if (['-o', '+o'].includes(option)) {
              if (words.length === 0) shellError = true;
              else words.shift();
              if (shellError) break;
              continue;
            }
            if (
              option.includes('c') &&
              [...option.slice(1)].every((char) => ['c', 'e', 'i', 'l', 's', 'u', 'v', 'x', 'f'].includes(char))
            ) {
              if (words.length === 0) shellError = true;
              else payload = words.shift();
              break;
            }
            shellError = true;
            break;
          }
          // A script path is opaque to this command-only parser.
          words.unshift(option);
          break;
        }
        if (shellError) parsed.push([POLICY_PARSE_ERROR]);
        else if (payload !== null) parsed.push(...shellSegments(payload, depth + 1));
        words.length = 0;
        break;
      }
      break;
    }
    if (words.length > 0) parsed.push(words);
  }
  return parsed;
}

function isCapabilityOrNetworkMutation(executable, args) {
  if (executable === 'setcap') return true;
  if (['ip', 'ip6'].includes(executable)) {
    return args.includes('netns') || args.some((arg) => NETWORK_MUTATION_VERBS.has(arg));
  }
  if (executable === 'sysctl') {
    return args.some(
      (arg) =>
        ['-w', '--write', '-p', '--system'].includes(arg) ||
        arg.startsWith('--write=') ||
        arg.includes('='),
    );
  }
  return false;
}

/** @param {string} command */
export function isHardDenyCommand(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return false;
  const lower = cmd.toLowerCase();
  if (HARD_DENY_PREFIXES.some((p) => lower.startsWith(p) || cmd.startsWith(p))) return true;
  if (SENSITIVE_HOST_PATHS.some((path) => lower.includes(path))) return true;
  if (SENSITIVE_PROC_RE.test(lower) || DANGEROUS_DEVICE_REDIRECT_RE.test(cmd)) return true;
  if (METADATA_DESTINATIONS.some((destination) => lower.includes(destination))) return true;

  for (const words of shellSegments(cmd)) {
    if (words[0] === POLICY_PARSE_ERROR) return true;
    const executable = String(words[0]).split('/').pop().toLowerCase();
    const args = words.slice(1).map((word) => word.toLowerCase());
    if (PRIVILEGE_COMMANDS.has(executable) || NAMESPACE_COMMANDS.has(executable)) return true;
    if (DEVICE_COMMANDS.has(executable) || CAPABILITY_COMMANDS.has(executable)) return true;
    if (isCapabilityOrNetworkMutation(executable, args)) return true;
    if (executable === 'chmod' && args.includes('777')) return true;
    if (executable === 'chown') return true;
    if (executable === 'dd' && args.some((arg) => arg.startsWith('if='))) return true;
    if (executable === 'mkfs' || executable.startsWith('mkfs.') || ['fdisk', 'parted'].includes(executable)) {
      return true;
    }
    if (executable === 'rm') {
      const recursive = args.some((arg) => arg.startsWith('-') && arg.includes('r'));
      const rootTarget = args.some((arg) => ['/', '/*', '--no-preserve-root'].includes(arg));
      if (recursive && rootTarget) return true;
    }
  }
  return false;
}

/**
 * @param {string} command
 * @param {string} [profile]
 * @returns {boolean}
 */
export function commandRequiresApproval(command, profile = resolvePolicyProfile()) {
  const cmd = String(command || '').toLowerCase();
  if (!cmd) return false;
  const patterns = profile === POLICY_PROFILES.BALANCED
    ? BALANCED_APPROVAL_SUBSTRINGS
    : APPROVAL_REQUIRED_SUBSTRINGS;
  return patterns.some((s) => cmd.includes(s));
}

/**
 * @param {unknown} value
 * @param {string} [toolName]
 * @returns {boolean}
 */
export function isBlockedSandboxPath(value, toolName = '') {
  const raw = String(value || '').trim().replaceAll('\\', '/');
  if (!raw || raw.includes('\0') || raw.startsWith('~')) return true;
  if (/^[A-Za-z]:\//.test(raw) || raw.split('/').includes('..')) return true;
  if (!raw.startsWith('/')) return false;
  if (['/home/sandbox/workspace', '/tmp'].some((root) => raw === root || raw.startsWith(`${root}/`))) {
    return false;
  }
  if (
    ['read', 'read_file', 'list_files', 'preview_file', 'view_file', 'cat', 'head', 'tail'].includes(toolName) &&
    ['/home/sandbox/skill', '/sandbox/skills', '/app/.pi/skills'].some(
      (root) => raw === root || raw.startsWith(`${root}/`),
    )
  ) {
    return false;
  }
  return true;
}

/**
 * Three-tier local policy evaluation (mirrors Sandbox ToolPolicyChecker).
 * @param {string} toolName
 * @param {{ command?: string, path?: string, timeout?: number, file_size?: number }} [params]
 * @param {{ skillRoots?: string[] }} [options]
 * @returns {{ decision: string, reason: string, risk_level: string, side_effect: string, policy_version: string }}
 */
export function evaluateToolPolicy(toolName, params = {}, options = {}) {
  const name = String(toolName || '').trim() || 'unknown';
  const side_effect = classifyToolSideEffect(name);
  const base = { side_effect, policy_version: POLICY_VERSION };
  const skillRoots = options.skillRoots || DEFAULT_SKILL_ROOTS;
  const policyEnv = {
    ...process.env,
    ...(options.policyEnv || {}),
  };
  if (options.policyProfile != null) {
    policyEnv.SANDBOX_POLICY_PROFILE = String(options.policyProfile);
  }
  if (options.isolationBackend != null) {
    policyEnv.SANDBOX_ISOLATION_BACKEND = String(options.isolationBackend);
  }
  if (options.isolationRequired != null) {
    policyEnv.SANDBOX_ISOLATION_REQUIRED = String(options.isolationRequired);
  }

  try {
    const policyProfile = resolvePolicyProfile(policyEnv);
    if (params.path && isBlockedSandboxPath(params.path, name)) {
      return {
        ...base,
        decision: POLICY_DECISION.HARD_DENY,
        reason: 'blocked path: outside the session sandbox roots',
        risk_level: 'high',
      };
    }

    // Skill root path policy: generic tools cannot mutate shared skills
    if (SKILL_ROOT_BLOCKED_TOOLS.has(name)) {
      if (params.path && isUnderSkillRoot(params.path, skillRoots)) {
        return {
          ...base,
          decision: POLICY_DECISION.HARD_DENY,
          reason:
            'blocked: skill root is not writable via generic tools; use skill_install/skill_edit in development mode',
          risk_level: 'high',
        };
      }
      if (
        params.command &&
        ['bash', 'command', 'raw_bash', 'raw_shell'].includes(name) &&
        commandTouchesSkillRoot(params.command, skillRoots) &&
        !isReadonlySkillExecution(params.command, skillRoots)
      ) {
        return {
          ...base,
          decision: POLICY_DECISION.HARD_DENY,
          reason:
            'blocked: bash must not target skill root; use skill_install/skill_edit in development mode',
          risk_level: 'high',
        };
      }
    }

    if (HIGH_RISK_TOOLS.has(name) && !params.command) {
      return {
        ...base,
        decision: POLICY_DECISION.APPROVAL_REQUIRED,
        reason: 'high risk tool, requires human approval',
        risk_level: 'high',
      };
    }

    const commandTools = [
      'bash',
      'command',
      'raw_bash',
      'raw_shell',
      'process_start',
    ];
    if (params.command && commandTools.includes(name)) {
      if (isHardDenyCommand(params.command)) {
        const token = String(params.command).trim().split(/\s+/)[0] || 'command';
        return {
          ...base,
          decision: POLICY_DECISION.HARD_DENY,
          reason: `blocked command: ${token}`,
          risk_level: 'high',
        };
      }
      if (commandRequiresApproval(params.command, policyProfile)) {
        return {
          ...base,
          decision: POLICY_DECISION.APPROVAL_REQUIRED,
          reason: 'high risk tool/command, requires human approval',
          risk_level: 'high',
        };
      }
    }

    if (params.command && isHardDenyCommand(params.command)) {
      const token = String(params.command).trim().split(/\s+/)[0] || 'command';
      return {
        ...base,
        decision: POLICY_DECISION.HARD_DENY,
        reason: `blocked command prefix: ${token}`,
        risk_level: 'medium',
      };
    }

    // Sync bash max 300s; managed processes may run longer (timeout is optional TTL).
    if (
      params.timeout != null &&
      Number(params.timeout) > 300 &&
      !name.startsWith('process_')
    ) {
      return {
        ...base,
        decision: POLICY_DECISION.HARD_DENY,
        reason: 'timeout exceeds maximum allowed (300s)',
        risk_level: 'medium',
      };
    }

    if (params.file_size != null && Number(params.file_size) > 50 * 1024 * 1024) {
      return {
        ...base,
        decision: POLICY_DECISION.HARD_DENY,
        reason: 'file size exceeds 50MB limit',
        risk_level: 'medium',
      };
    }

    if (side_effect === TOOL_SIDE_EFFECT.READ || READ_TOOLS.has(name)) {
      return {
        ...base,
        decision: POLICY_DECISION.ALLOW,
        reason: 'low risk tool, auto-allowed',
        risk_level: 'low',
      };
    }

    // write/edit/submit_artifact/bash(safe) — medium, auto-allow with constraints
    return {
      ...base,
      decision: POLICY_DECISION.ALLOW,
      reason: 'medium risk tool, allowed with constraints',
      risk_level: 'medium',
    };
  } catch (err) {
    // Fail-closed on evaluation bugs
    return {
      ...base,
      decision: POLICY_DECISION.HARD_DENY,
      reason: `policy evaluation failed: ${err?.message || String(err)}`,
      risk_level: 'high',
    };
  }
}

/**
 * Map policy decision through APPROVAL_ENABLED.
 * When approval is off, approval_required becomes allow + bypass flag.
 * hard_deny is never overridden.
 *
 * @param {{ decision: string, reason: string, risk_level: string, side_effect?: string, policy_version?: string }} policy
 * @param {boolean} approvalEnabled
 */
export function applyApprovalSwitch(policy, approvalEnabled = true) {
  if (policy.decision === POLICY_DECISION.HARD_DENY) {
    return { ...policy, approval_bypassed: false };
  }
  if (policy.decision === POLICY_DECISION.APPROVAL_REQUIRED && !approvalEnabled) {
    return {
      ...policy,
      decision: POLICY_DECISION.ALLOW,
      reason: `${policy.reason} (approval bypassed: APPROVAL_ENABLED=false)`,
      approval_bypassed: true,
    };
  }
  return { ...policy, approval_bypassed: false };
}

/**
 * Build a redacted audit event for a tool call. Never includes secrets or full body.
 * @param {object} opts
 */
export function buildToolAuditEvent(opts = {}) {
  const {
    toolName,
    toolCallId = null,
    params = {},
    policy = null,
    phase = 'tool_call',
    durationMs = null,
    isError = null,
    resultSummary = null,
    error = null,
    meta = {},
  } = opts;

  const paramSummary = summarizeParams(toolName, params);
  return {
    event: phase,
    tool_name: toolName,
    tool_call_id: toolCallId,
    params_summary: paramSummary,
    decision: policy?.decision ?? null,
    risk_level: policy?.risk_level ?? null,
    reason: policy?.reason ?? null,
    approval_bypassed: Boolean(policy?.approval_bypassed),
    policy_version: policy?.policy_version || POLICY_VERSION,
    side_effect: policy?.side_effect || classifyToolSideEffect(toolName),
    duration_ms: durationMs,
    is_error: isError,
    result_summary: resultSummary,
    error: error ? String(error).slice(0, 200) : null,
    meta: {
      user_id: meta.user_id ?? meta.userId ?? null,
      organization_id: meta.organization_id ?? meta.orgId ?? null,
      conversation_id: meta.conversation_id ?? meta.conversationId ?? null,
      session_id: meta.session_id ?? meta.sessionId ?? null,
      trace_id: meta.trace_id ?? meta.traceId ?? null,
      workspace_key: meta.workspace_key ?? meta.workspaceKey ?? null,
      policy_version: policy?.policy_version || POLICY_VERSION,
    },
  };
}

/**
 * @param {string} toolName
 * @param {object} params
 */
function summarizeParams(toolName, params) {
  if (!params || typeof params !== 'object') return {};
  const out = {};
  if (params.path != null) out.path = String(params.path).slice(0, 200);
  if (params.command != null) {
    const cmd = String(params.command);
    out.command = cmd.length > 120 ? `${cmd.slice(0, 120)}…` : cmd;
  }
  if (params.timeout != null) out.timeout = params.timeout;
  if (params.name != null) out.name = String(params.name).slice(0, 100);
  if (params.content != null) out.content_bytes = String(params.content).length;
  if (params.old_string != null) out.old_string_len = String(params.old_string).length;
  if (params.new_string != null) out.new_string_len = String(params.new_string).length;
  if (toolName) out.tool = toolName;
  return out;
}

/**
 * Emit audit to stdout as structured JSON (no secrets).
 * @param {object} event
 * @param {((ev: object) => void) | null} [sink]
 */
export function emitToolAudit(event, sink = null) {
  const line = { ...event, ts: new Date().toISOString() };
  if (typeof sink === 'function') {
    try {
      sink(line);
    } catch {
      /* ignore sink errors */
    }
  }
  try {
    console.log(`[security-audit] ${JSON.stringify(line)}`);
  } catch {
    console.log('[security-audit] <unserializable>');
  }
}

const SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /\b(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?)?:?\/\/[^\s/@:]+:[^\s/@]+@[^\s]+/gi,
];

export function filterToolResultContent(content, maxChars = 50_000) {
  let changed = false;
  const filtered = (content || []).map((part) => {
    if (part?.type !== 'text') return part;
    let text = String(part.text || '');
    for (const pattern of SECRET_PATTERNS) {
      const next = text.replace(pattern, (match, key) =>
        key ? `${key}=[REDACTED]` : '[REDACTED]',
      );
      changed ||= next !== text;
      text = next;
    }
    if (text.length > maxChars) {
      text = `${text.slice(0, maxChars)}\n...[tool result truncated]`;
      changed = true;
    }
    return text === part.text ? part : { ...part, text };
  });
  return { content: filtered, changed };
}

/**
 * Per-workspace write mutex. Read tools may run in parallel; write tools serialize
 * per key (conversation_id or workspace id). Different keys run in parallel.
 */
export function createWriteMutex() {
  /** @type {Map<string, Promise<unknown>>} */
  const tails = new Map();

  /**
   * @template T
   * @param {string} key
   * @param {() => Promise<T> | T} fn
   * @returns {Promise<T>}
   */
  async function runExclusive(key, fn) {
    const k = String(key || 'default');
    const prev = tails.get(k) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    // Chain so the next waiter awaits our gate even if we throw
    const chained = prev.catch(() => {}).then(() => gate);
    tails.set(k, chained);

    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      // Opportunistic cleanup when this is still the tail
      if (tails.get(k) === chained) {
        // Keep resolved promise so concurrent joiners still order correctly
        tails.set(
          k,
          chained.then(() => undefined),
        );
      }
    }
  }

  return { runExclusive };
}

/** Process-wide default mutex (shared across chat turns in this process). */
export const workspaceWriteMutex = createWriteMutex();

/**
 * Resolve whether APPROVAL_ENABLED is on (default true).
 * @param {NodeJS.ProcessEnv | { APPROVAL_ENABLED?: string|boolean }} [env]
 */
export function resolveApprovalEnabled(env = process.env) {
  const raw = env?.APPROVAL_ENABLED;
  if (raw == null || String(raw).trim() === '') return true;
  if (typeof raw === 'boolean') return raw;
  return String(raw).toLowerCase() !== 'false';
}

/**
 * Create a pi-coding-agent Extension factory that enforces hard_deny on tool_call.
 * Durable approval suspension is coordinated by the Sandbox Tools Extension.
 *
 * @param {{
 *   getMeta?: () => object,
 *   approvalEnabled?: boolean | (() => boolean),
 *   auditSink?: (ev: object) => void,
 *   onHardDeny?: (info: object) => void,
 * }} [ctx]
 * @returns {(pi: any) => void}
 */
export function createSandboxSecurityExtension(ctx = {}) {
  const getMeta = typeof ctx.getMeta === 'function' ? ctx.getMeta : () => ({});
  const auditSink = typeof ctx.auditSink === 'function' ? ctx.auditSink : null;
  const onHardDeny = typeof ctx.onHardDeny === 'function' ? ctx.onHardDeny : null;

  return function sandboxSecurityExtension(pi) {
    pi.on('tool_call', async (event) => {
      try {
        const toolName = event.toolName || event.name || 'unknown';
        const input = event.input || event.params || {};
        const approvalEnabled =
          typeof ctx.approvalEnabled === 'function'
            ? Boolean(ctx.approvalEnabled())
            : ctx.approvalEnabled !== false;

        let policy = evaluateToolPolicy(toolName, input);
        policy = applyApprovalSwitch(policy, approvalEnabled);

        const meta = getMeta() || {};
        emitToolAudit(
          buildToolAuditEvent({
            toolName,
            toolCallId: event.toolCallId || event.id || null,
            params: input,
            policy,
            phase: 'tool_call',
            meta,
          }),
          auditSink,
        );

        if (policy.decision === POLICY_DECISION.HARD_DENY) {
          if (onHardDeny) {
            try {
              onHardDeny({ toolName, reason: policy.reason, policy });
            } catch {
              /* ignore */
            }
          }
          return { block: true, reason: policy.reason };
        }
        return undefined;
      } catch (err) {
        // Fail-closed: any extension error blocks the tool
        const reason = `Security extension error (fail-closed): ${err?.message || String(err)}`;
        let safeMeta = {};
        try {
          safeMeta = typeof getMeta === 'function' ? getMeta() || {} : {};
        } catch {
          safeMeta = {};
        }
        try {
          emitToolAudit(
            buildToolAuditEvent({
              toolName: event?.toolName || 'unknown',
              toolCallId: event?.toolCallId || null,
              params: event?.input || {},
              policy: {
                decision: POLICY_DECISION.HARD_DENY,
                reason,
                risk_level: 'high',
                policy_version: POLICY_VERSION,
                side_effect: 'write',
              },
              phase: 'tool_call',
              error: reason,
              meta: safeMeta,
            }),
            auditSink,
          );
        } catch {
          /* audit must not break fail-closed block */
        }
        return { block: true, reason };
      }
    });

    pi.on('tool_result', async (event) => {
      let filtered = null;
      try {
        const toolName = event.toolName || 'unknown';
        const meta = getMeta() || {};
        const contentText =
          Array.isArray(event.content) && event.content[0]?.text
            ? String(event.content[0].text).slice(0, 160)
            : null;
        emitToolAudit(
          buildToolAuditEvent({
            toolName,
            toolCallId: event.toolCallId || null,
            params: event.input || {},
            policy: {
              decision: null,
              reason: null,
              risk_level: null,
              policy_version: POLICY_VERSION,
              side_effect: classifyToolSideEffect(toolName),
            },
            phase: 'tool_result',
            isError: Boolean(event.isError),
            resultSummary: contentText,
            meta,
          }),
          auditSink,
        );
        filtered = filterToolResultContent(event.content);
      } catch {
        // tool_result audit failures must not rewrite results or throw
      }
      return filtered?.changed ? { content: filtered.content } : undefined;
    });
  };
}

/**
 * Pre-execute gate used by Sandbox tool definitions.
 * Combines local hard_deny, write-class fail-closed policy, and optional remote check.
 *
 * @param {object} opts
 * @param {string} opts.toolName
 * @param {object} [opts.params]
 * @param {boolean} [opts.approvalEnabled]
 * @param {object} [opts.meta]
 * @param {(ev: object) => void} [opts.auditSink]
 * @returns {{ ok: boolean, reason?: string, policy: object, approval_bypassed?: boolean }}
 */
export function preExecuteGate({
  toolName,
  params = {},
  approvalEnabled = true,
  meta = {},
  auditSink = null,
} = {}) {
  try {
    let policy = evaluateToolPolicy(toolName, params);
    policy = applyApprovalSwitch(policy, approvalEnabled);
    emitToolAudit(
      buildToolAuditEvent({
        toolName,
        params,
        policy,
        phase: 'pre_execute',
        meta,
      }),
      auditSink,
    );
    if (policy.decision === POLICY_DECISION.HARD_DENY) {
      return { ok: false, reason: policy.reason, policy, approval_bypassed: false };
    }
    return {
      ok: true,
      policy,
      approval_bypassed: Boolean(policy.approval_bypassed),
      // Still needs remote approval when decision remains approval_required
      needs_approval: policy.decision === POLICY_DECISION.APPROVAL_REQUIRED,
    };
  } catch (err) {
    const reason = `pre-execute gate failed (fail-closed): ${err?.message || String(err)}`;
    const policy = {
      decision: POLICY_DECISION.HARD_DENY,
      reason,
      risk_level: 'high',
      policy_version: POLICY_VERSION,
      side_effect: classifyToolSideEffect(toolName),
    };
    emitToolAudit(
      buildToolAuditEvent({
        toolName,
        params,
        policy,
        phase: 'pre_execute',
        error: reason,
        meta,
      }),
      auditSink,
    );
    return { ok: false, reason, policy, approval_bypassed: false };
  }
}
