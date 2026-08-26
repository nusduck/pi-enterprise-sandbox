/**
 * Per-user Skill lifecycle manager.
 *
 * System packages are read-only. Every mutation is confined to the calling
 * user's `<orgId>/<userId>` directory and is exposed only through governed
 * Agent tools. There is no development/production mode branch.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import {
  DEFAULT_SKILL_ROOTS,
  SYSTEM_SKILL_ROOT,
  USER_SKILL_ROOT,
  normalizeSkillRoots,
  primarySkillRoot,
  skillRootsForIdentity,
  userSkillRootFor,
  writableSkillRoot,
  isUnderSkillRoot,
} from './paths.js';
import {
  assertSkillArchiveName,
  createGeneratedSkill,
  installSkillArchive,
  uninstallSkill,
  editSkillFile,
  listInstalledSkills,
  describeInstalledSkills,
  SKILL_INSTALL_TIMEOUT_MS,
} from './install.js';
import { SKILL_ARCHIVE_MAX_BYTES } from './archive.js';
import { emitSkillAudit } from './audit.js';

/**
 * Resolve system and user-base mounts. These paths describe storage, not an
 * install source; callers can never submit either path to a lifecycle tool.
 */
export function resolveSkillMountRoots(env = process.env) {
  const system = String(
    env?.SKILLS_ROOT || env?.AGENT_SKILLS_ROOT || SYSTEM_SKILL_ROOT,
  ).trim();
  const userBase = String(
    env?.SKILLS_USER_ROOT || env?.AGENT_SKILLS_USER_ROOT || USER_SKILL_ROOT,
  ).trim();
  return {
    systemRoot: system || SYSTEM_SKILL_ROOT,
    userRootBase: userBase || USER_SKILL_ROOT,
  };
}

/** Skill roots for one caller, in system-then-user precedence order. */
export function resolveSkillRoots(env = process.env, identity = null) {
  const { systemRoot, userRootBase } = resolveSkillMountRoots(env);
  if (identity?.orgId != null && identity?.userId != null) {
    return skillRootsForIdentity(identity, { systemRoot, userRootBase });
  }
  return normalizeSkillRoots([systemRoot, userRootBase]);
}

function responseHeader(response, name) {
  return String(response?.headers?.get?.(name) || '').trim();
}

/**
 * Read an owner-scoped Sandbox attachment response with a hard byte limit and
 * verify the dataset hash when Sandbox provides it.
 *
 * @param {unknown} response
 * @returns {Promise<{ bytes: Buffer, sha256: string }>}
 */
export async function readSkillArchiveDownload(response) {
  if (!response || typeof response !== 'object') {
    throw new Error('Skill archive download returned no response');
  }
  if ('ok' in response && response.ok === false) {
    throw new Error(`Skill archive download failed with status ${response.status || 'unknown'}`);
  }
  const contentType = responseHeader(response, 'content-type')
    .split(';', 1)[0]
    .toLowerCase();
  if (
    contentType &&
    !['application/zip', 'application/x-zip-compressed', 'application/octet-stream'].includes(
      contentType,
    )
  ) {
    throw new Error(`Skill archive response has unsupported content type: ${contentType}`);
  }
  const declared = Number(responseHeader(response, 'content-length'));
  if (Number.isFinite(declared) && declared > SKILL_ARCHIVE_MAX_BYTES) {
    throw new Error(`Skill archive exceeds ${SKILL_ARCHIVE_MAX_BYTES} bytes`);
  }

  const chunks = [];
  let total = 0;
  if (response.body && Symbol.asyncIterator in Object(response.body)) {
    for await (const raw of response.body) {
      const chunk = Buffer.from(raw);
      total += chunk.length;
      if (total > SKILL_ARCHIVE_MAX_BYTES) {
        throw new Error(`Skill archive exceeds ${SKILL_ARCHIVE_MAX_BYTES} bytes`);
      }
      chunks.push(chunk);
    }
  } else if (typeof response.arrayBuffer === 'function') {
    const bytes = Buffer.from(await response.arrayBuffer());
    total = bytes.length;
    if (total > SKILL_ARCHIVE_MAX_BYTES) {
      throw new Error(`Skill archive exceeds ${SKILL_ARCHIVE_MAX_BYTES} bytes`);
    }
    chunks.push(bytes);
  } else {
    throw new Error('Skill archive response body is unreadable');
  }

  const bytes = Buffer.concat(chunks, total);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const expected = responseHeader(response, 'x-dataset-sha256').toLowerCase();
  if (expected && expected !== sha256) {
    throw new Error('Skill archive content hash no longer matches its attachment id');
  }
  return { bytes, sha256 };
}

/**
 * @param {{
 *   identity?: { orgId: unknown, userId: unknown } | null,
 *   skillRoots?: string[],
 *   userSkillRoot?: string | null,
 *   downloadArchive?: ((input: { attachmentId: string }) => Promise<unknown>) | null,
 *   downloadWorkspaceArchive?: ((input: { path: string }) => Promise<unknown>) | null,
 *   auditLogPath?: string | null,
 *   auditSink?: ((event: object) => void) | null,
 *   getMeta?: () => object,
 *   getAgentSession?: () => { reload?: () => Promise<void>, resourceLoader?: { getSkills?: () => { skills: unknown[] }, reload?: () => Promise<void> } } | null,
 *   onAfterReload?: () => Promise<void>|void,
 * }} [options]
 */
export function createSkillManager(options = {}) {
  const identity = options.identity ?? null;
  const skillRoots = normalizeSkillRoots(
    options.skillRoots || resolveSkillRoots(process.env, identity),
  );
  const skillRoot = primarySkillRoot(skillRoots);
  const userRoot = options.userSkillRoot
    ? normalizeSkillRoots([options.userSkillRoot])[0]
    : writableSkillRoot(skillRoots);
  const downloadArchive =
    typeof options.downloadArchive === 'function' ? options.downloadArchive : null;
  const downloadWorkspaceArchive =
    typeof options.downloadWorkspaceArchive === 'function'
      ? options.downloadWorkspaceArchive
      : null;
  const auditLogPath = options.auditLogPath ?? process.env.SKILLS_AUDIT_LOG ?? null;
  const auditSink = options.auditSink || null;
  const getMeta = typeof options.getMeta === 'function' ? options.getMeta : () => ({});
  const getAgentSession =
    typeof options.getAgentSession === 'function' ? options.getAgentSession : () => null;
  const onAfterReload =
    typeof options.onAfterReload === 'function' ? options.onAfterReload : null;

  function audit(partial) {
    return emitSkillAudit(
      {
        ...partial,
        meta: {
          orgId: identity?.orgId ?? null,
          userId: identity?.userId ?? null,
          ...getMeta(),
          ...(partial.meta || {}),
        },
      },
      { auditLogPath, sink: auditSink },
    );
  }

  function assertWritable(action) {
    if (!userRoot) {
      const error = new Error(
        `Skill ${action} denied: no per-user Skill directory resolved ` +
          '(requires orgId, userId and a writable SKILLS_USER_ROOT mount)',
      );
      audit({ action, result: 'denied', error: error.message });
      throw error;
    }
    fs.mkdirSync(userRoot, { recursive: true, mode: 0o700 });
  }

  function systemSkillNames() {
    const names = new Set();
    for (const root of skillRoots) {
      if (userRoot && root === userRoot) continue;
      for (const name of listInstalledSkills(root)) names.add(name);
    }
    return names;
  }

  const manager = {
    skillRoot,
    skillRoots,
    userSkillRoot: userRoot,
    identity,
    isUnderSkillRoot: (candidate) => isUnderSkillRoot(candidate, skillRoots),
    listInstalled: () =>
      describeInstalledSkills(skillRoots, { writableRoot: userRoot }).map(
        (skill) => skill.name,
      ),
    describeInstalled: () =>
      describeInstalledSkills(skillRoots, { writableRoot: userRoot }),

    /**
     * Install one Skill from a ZIP, from either provenance.
     *
     * `source: 'sandbox'` installs a package the model built in this session's
     * workspace or `/tmp`; anything else installs a ZIP the user attached in
     * the current turn (the extension verifies that binding). Both are fetched
     * owner-scoped, size-capped and hashed here, then handed to the same
     * `installSkillArchive` — the sandbox provenance adds a way to *reach* an
     * archive, never a second way to write into the Skill root.
     */
    async install(params) {
      assertWritable('install');
      const sourceType = params?.source === 'sandbox' ? 'sandbox_build' : 'upload';
      const fromSandbox = sourceType === 'sandbox_build';
      const attachmentId = String(params?.attachmentId || '').trim();
      const sourcePath = String(params?.sourcePath || '').trim();
      const auditSource = fromSandbox
        ? sourcePath && `sandbox:${sourcePath}`
        : attachmentId && `attachment:${attachmentId}`;
      try {
        const fetchArchive = fromSandbox ? downloadWorkspaceArchive : downloadArchive;
        if (!fetchArchive) {
          throw new Error(
            fromSandbox
              ? 'Sandbox archive download is not configured'
              : 'Skill archive download is not configured',
          );
        }
        if (fromSandbox) {
          if (!sourcePath) throw new Error('Skill archive sandbox path is required');
        } else if (!attachmentId) {
          throw new Error('Skill archive attachment_id is required');
        }
        const archiveName = assertSkillArchiveName(params?.archiveName, sourceType);
        // Only an attachment declares its size up front; a sandbox file is
        // capped by the streaming reader instead.
        if (Number(params?.declaredSize) > SKILL_ARCHIVE_MAX_BYTES) {
          throw new Error(`Skill archive exceeds ${SKILL_ARCHIVE_MAX_BYTES} bytes`);
        }
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, SKILL_INSTALL_TIMEOUT_MS);
        let downloaded;
        try {
          const response = await fetchArchive(
            fromSandbox
              ? { path: sourcePath, signal: controller.signal }
              : { attachmentId, signal: controller.signal },
          );
          downloaded = await readSkillArchiveDownload(response);
        } catch (error) {
          if (timedOut || error?.name === 'AbortError') {
            throw new Error(
              `Skill archive download timed out after ${SKILL_INSTALL_TIMEOUT_MS}ms`,
            );
          }
          throw error;
        } finally {
          clearTimeout(timer);
        }
        const result = await installSkillArchive({
          archiveBytes: downloaded.bytes,
          archiveName,
          sourceType,
          ...(fromSandbox ? { sourcePath } : { attachmentId }),
          skillRoot: userRoot,
          systemSkillNames: systemSkillNames(),
        });
        audit({
          action: 'install',
          result: 'success',
          skill_name: result.name,
          source_type: sourceType,
          source: auditSource || null,
          summary: `${result.summary} archive_sha256=${downloaded.sha256}`,
        });
        return { ...result, archive_sha256: downloaded.sha256 };
      } catch (error) {
        audit({
          action: 'install',
          result: 'failure',
          source_type: sourceType,
          source: auditSource || null,
          error: error?.message || String(error),
        });
        throw error;
      }
    },

    /** Create a package generated by the Agent; this is an install operation. */
    async create(params) {
      assertWritable('create');
      try {
        const result = await createGeneratedSkill({
          name: params.name,
          description: params.description,
          instructions: params.instructions,
          files: params.files,
          skillRoot: userRoot,
          systemSkillNames: systemSkillNames(),
        });
        audit({
          action: 'create',
          result: 'success',
          skill_name: result.name,
          source_type: 'agent_generated',
          source: 'agent',
          summary: result.summary,
        });
        return result;
      } catch (error) {
        audit({
          action: 'create',
          result: 'failure',
          skill_name: params?.name,
          source_type: 'agent_generated',
          source: 'agent',
          error: error?.message || String(error),
        });
        throw error;
      }
    },

    async uninstall(params) {
      assertWritable('uninstall');
      try {
        const result = await uninstallSkill({ name: params.name, skillRoot: userRoot });
        audit({
          action: 'uninstall',
          result: 'success',
          skill_name: result.name,
          summary: result.summary,
        });
        return result;
      } catch (error) {
        audit({
          action: 'uninstall',
          result: 'failure',
          skill_name: params?.name,
          error: error?.message || String(error),
        });
        throw error;
      }
    },

    async edit(params) {
      assertWritable('edit');
      try {
        const result = await editSkillFile({
          skillRoot: userRoot,
          path: params.path,
          content: params.content,
        });
        audit({
          action: 'edit',
          result: 'success',
          skill_name: String(result.path || '').split('/')[0] || null,
          summary: `edited ${result.path} (${result.bytes} bytes)`,
        });
        return result;
      } catch (error) {
        audit({
          action: 'edit',
          result: 'failure',
          error: error?.message || String(error),
          summary: params?.path,
        });
        throw error;
      }
    },

    /** Internal post-mutation reload; not exposed as a user tool. */
    async reload() {
      try {
        const session = getAgentSession();
        let skillCount = null;
        if (session && typeof session.reload === 'function') {
          await session.reload();
        } else if (session?.resourceLoader?.reload) {
          await session.resourceLoader.reload();
        }
        if (session?.resourceLoader) {
          const { assertExtensionsLoadedClean } = await import(
            '../infrastructure/pi/pi-runtime-factory.js'
          );
          assertExtensionsLoadedClean({ resourceLoader: session.resourceLoader }, session);
        }
        const loaded =
          session?.resourceLoader?.getSkills?.()?.skills ||
          session?.getSkills?.()?.skills ||
          null;
        if (Array.isArray(loaded)) skillCount = loaded.length;
        const installed = describeInstalledSkills(skillRoots, {
          writableRoot: userRoot,
        }).map((skill) => skill.name);
        if (onAfterReload) {
          try {
            await onAfterReload();
          } catch (error) {
            console.warn('[skills] onAfterReload failed:', error?.message || error);
          }
        }
        const summary = skillCount != null
          ? `reloaded loader skills=${skillCount} installed=${installed.length}`
          : `reload marked; installed=${installed.length}`;
        audit({ action: 'reload', result: 'success', summary });
        return {
          reloaded: Boolean(session),
          installed,
          skill_count: skillCount,
          summary,
        };
      } catch (error) {
        audit({
          action: 'reload',
          result: 'failure',
          error: error?.message || String(error),
        });
        throw error;
      }
    },
  };
  return manager;
}

export {
  DEFAULT_SKILL_ROOTS,
  SYSTEM_SKILL_ROOT,
  USER_SKILL_ROOT,
  skillRootsForIdentity,
  userSkillRootFor,
};
