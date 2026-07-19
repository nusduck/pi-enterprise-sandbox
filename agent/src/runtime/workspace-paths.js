import path from 'node:path';

import { config } from '../../config.js';

const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalize a model-supplied workspace path to the relative path required by
 * the Sandbox REST API.
 *
 * Pi exposes a stable logical cwd to the model. Models may therefore return
 * either `notes/a.txt` or `/home/sandbox/workspace/notes/a.txt`. Both identify
 * the same file. Persistent conversation temp paths use `/tmp/...` and remain
 * absolute. Other absolute paths and parent escapes remain forbidden.
 *
 * @param {unknown} userPath
 * @param {{ logicalRoot?: string, tempRoot?: string, defaultPath?: string }} [options]
 * @returns {string}
 */
export function normalizeWorkspacePath(userPath, options = {}) {
  const logicalRoot = String(
    options.logicalRoot || config.SESSION_WORKSPACE_CWD || '/home/sandbox/workspace',
  ).replace(/\/+$/, '');
  const tempRoot = String(options.tempRoot || '/tmp').replace(/\/+$/, '');
  const defaultPath = options.defaultPath;
  let raw = userPath == null ? defaultPath : String(userPath);

  if (raw == null || !raw.trim()) {
    throw new Error('Workspace path is required');
  }
  if (raw.includes('\0')) {
    throw new Error('Workspace path contains a null byte');
  }

  raw = raw.trim().replace(/\\/g, '/');
  let prefix = '';
  if (raw === logicalRoot) {
    return '.';
  }
  if (raw.startsWith(`${logicalRoot}/`)) {
    raw = raw.slice(logicalRoot.length + 1);
  } else if (raw === tempRoot) {
    return tempRoot;
  } else if (raw.startsWith(`${tempRoot}/`)) {
    raw = raw.slice(tempRoot.length + 1);
    prefix = tempRoot;
  } else if (path.posix.isAbsolute(raw) || WINDOWS_ABSOLUTE_PATH.test(raw)) {
    throw new Error(
      `Absolute path is outside the sandbox roots; use ${logicalRoot}/..., ${tempRoot}/..., or a relative path`,
    );
  }

  // A doubled slash after the logical root must not turn back into an
  // absolute path after prefix removal.
  if (path.posix.isAbsolute(raw) || WINDOWS_ABSOLUTE_PATH.test(raw)) {
    throw new Error('Workspace path escapes the session workspace');
  }

  if (raw.split('/').filter(Boolean).includes('..')) {
    throw new Error('Path escapes its sandbox root');
  }
  const normalized = path.posix.normalize(raw);
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error('Path escapes its sandbox root');
  }
  if (prefix) {
    return normalized === '' || normalized === '.' ? prefix : `${prefix}/${normalized}`;
  }
  return normalized === '' ? '.' : normalized;
}

/**
 * Map the stable logical cwd used in model-visible shell commands to `.`.
 * The Sandbox executes the command with the physical workspace as cwd, so the
 * relative spelling reaches the same file without exposing a host path.
 *
 * @param {unknown} command
 * @param {{ logicalRoot?: string }} [options]
 */
export function normalizeWorkspaceCommand(command, options = {}) {
  const value = String(command ?? '');
  const logicalRoot = String(
    options.logicalRoot || config.SESSION_WORKSPACE_CWD || '/home/sandbox/workspace',
  ).replace(/\/+$/, '');
  if (!value || !logicalRoot) return value;

  const rootPattern = new RegExp(
    `${escapeRegExp(logicalRoot)}(?=$|[/\\s'"\`;&|()<>])`,
    'g',
  );
  return value.replace(rootPattern, '.');
}

/**
 * Normalize path-bearing tool parameters without touching Skill absolute paths.
 * @param {string} toolName
 * @param {object | null | undefined} params
 * @param {{ isSkillPath?: (value: string) => boolean, logicalRoot?: string, tempRoot?: string }} [options]
 */
export function normalizeWorkspaceToolParams(toolName, params, options = {}) {
  const next = { ...(params || {}) };
  const pathTools = new Set([
    'read',
    'write',
    'edit',
    'apply_patch',
    'submit_artifact',
    'ls',
    'find',
    'grep',
  ]);

  if (pathTools.has(toolName)) {
    const value = next.path;
    // Preserve Skill paths so the existing read dispatcher / write hard-deny
    // policy remains authoritative for that separate filesystem boundary.
    const isSkillPath =
      typeof value === 'string' && options.isSkillPath?.(value);
    if (!isSkillPath) {
      next.path = normalizeWorkspacePath(value, {
        logicalRoot: options.logicalRoot,
        tempRoot: options.tempRoot,
        defaultPath: ['ls', 'find', 'grep'].includes(toolName) ? '.' : undefined,
      });
    }
  }

  if (toolName === 'process_start' && next.cwd != null) {
    next.cwd = normalizeWorkspacePath(next.cwd, {
      logicalRoot: options.logicalRoot,
      tempRoot: options.tempRoot,
      defaultPath: '.',
    });
  }
  if (['bash', 'process_start'].includes(toolName) && next.command != null) {
    next.command = normalizeWorkspaceCommand(next.command, {
      logicalRoot: options.logicalRoot,
    });
  }
  return next;
}
