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
  draftSkillRootFor,
  writableSkillRoot,
  isUnderSkillRoot,
} from './paths.js';
import {
  assertSkillArchiveName,
  installSkillArchive,
  uninstallSkill,
  listInstalledSkills,
  describeInstalledSkills,
  SKILL_INSTALL_TIMEOUT_MS,
} from './install.js';
import { SKILL_ARCHIVE_MAX_BYTES } from './archive.js';
import { disableSkillPackage, enableDraftPackage } from './enablement.js';
import { join as joinPath } from 'node:path';
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
 * @param response
 * @returns {Promise<{ bytes: Buffer, sha256: string }>}
 */
export async function readSkillArchiveDownload(response: unknown) {
  if (!response || typeof response !== 'object') {
    throw new Error('Skill archive download returned no response');
  }
  if ('ok' in response && response.ok === false) {
    // @ts-expect-error 遗留JS占位类型object未展开，访问status需收窄，存活代码先用expect-error收敛 —— TS2339: Property 'status' does not exist on type 'object & Record<"o
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
  // @ts-expect-error 遗留JS占位类型object未展开，访问body需收窄，存活代码先用expect-error收敛 —— TS2339: Property 'body' does not exist on type 'object'.
  if (response.body && Symbol.asyncIterator in Object(response.body)) {
    // @ts-expect-error 遗留JS占位类型object未展开，访问body需收窄，存活代码先用expect-error收敛 —— TS2339: Property 'body' does not exist on type 'object'.
    for await (const raw of response.body) {
      const chunk = Buffer.from(raw);
      total += chunk.length;
      if (total > SKILL_ARCHIVE_MAX_BYTES) {
        throw new Error(`Skill archive exceeds ${SKILL_ARCHIVE_MAX_BYTES} bytes`);
      }
      chunks.push(chunk);
    }
  // @ts-expect-error 遗留JS占位类型object未展开，访问arrayBuffer需收窄，存活代码先用expect-error收敛 —— TS2339: Property 'arrayBuffer' does not exist on type 'object'.
  } else if (typeof response.arrayBuffer === 'function') {
    // @ts-expect-error 遗留JS占位类型object未展开，访问arrayBuffer需收窄，存活代码先用expect-error收敛 —— TS2339: Property 'arrayBuffer' does not exist on type 'object'.
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
 * SkillManager 的构造选项。
 *
 * `downloadArchive` / `downloadWorkspaceArchive` 是注入的取字节通道——skill
 * 包的字节全部由 exec 持有，这一层只拿 id 或路径去换。
 */
export interface SkillManagerOptions {
  identity?: { orgId: unknown; userId: unknown } | null;
  skillRoots?: string[];
  userSkillRoot?: string | null;
  /**
   * 该用户的 skill **草稿根**（ADR 0009 D7 / 计划 H6.7）。
   *
   * 上传现在解包到这里，而不是直接写已启用根——上传与模型创建从此是同一个故事：
   * 都落在草稿里，都要人按一下「启用」才进 prompt 与只读挂载。
   * 省略时回退到旧行为（直接装），并在审计里标出来。
   */
  draftSkillRoot?: string | null;
  downloadArchive?:
    | ((input: { attachmentId: string; signal?: AbortSignal }) => Promise<unknown>)
    | null;
  downloadWorkspaceArchive?:
    | ((input: { path: string; signal?: AbortSignal }) => Promise<unknown>)
    | null;
  auditLogPath?: string | null;
  auditSink?: ((event: object) => void) | null;
  getMeta?: () => object;
  getAgentSession?: () => {
    reload?: () => Promise<void>;
    resourceLoader?: {
      getSkills?: () => { skills: unknown[] };
      reload?: () => Promise<void>;
    };
  } | null;
  onAfterReload?: () => Promise<void> | void;
}

export function createSkillManager(options: SkillManagerOptions = {}) {
  const identity = options.identity ?? null;
  const skillRoots = normalizeSkillRoots(
    options.skillRoots || resolveSkillRoots(process.env, identity),
  );
  const skillRoot = primarySkillRoot(skillRoots);
  const userRoot = options.userSkillRoot
    ? normalizeSkillRoots([options.userSkillRoot])[0]
    : writableSkillRoot(skillRoots);
  const draftRoot = options.draftSkillRoot
    ? normalizeSkillRoots([options.draftSkillRoot])[0]
    : null;
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
    const names = new Set<string>();
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
     *
     * Each provenance pins its bytes differently. An attachment is pinned by
     * its id and, when Sandbox supplies the header, by `x-dataset-sha256`. A
     * sandbox path pins nothing on its own — the workspace stays writable while
     * the call waits for approval — so `sourceDigest` is required and checked
     * against what was actually downloaded.
     */
    async install(params) {
      assertWritable('install');
      const sourceType = params?.source === 'sandbox' ? 'sandbox_build' : 'upload';
      const fromSandbox = sourceType === 'sandbox_build';
      const attachmentId = String(params?.attachmentId || '').trim();
      const sourcePath = String(params?.sourcePath || '').trim();
      const sourceDigest = String(params?.sourceDigest || '').trim().toLowerCase();
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
          // Validated here as well as in the tool: the manager is its own API
          // surface, and an unpinned sandbox install must not exist on either.
          if (!/^[0-9a-f]{64}$/.test(sourceDigest)) {
            throw new Error('Skill archive sourceDigest must be a sha256 hex digest');
          }
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
          // 两条分支各自的形状已由上面的守卫保证：fromSandbox 时 sourcePath
          // 非空，否则 attachmentId 非空。fetchArchive 的两个实现各只认自己
          // 那一种，所以这里断言成联合而不是让 JSDoc 去表达"取决于分支"。
          const response = await fetchArchive(
            ((
              fromSandbox
                ? { path: sourcePath, signal: controller.signal }
                : { attachmentId, signal: controller.signal }) as any),
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
        if (fromSandbox && downloaded.sha256 !== sourceDigest) {
          // Do not install "whatever is there now". The user approved one
          // archive; if the path holds different bytes, the safe outcome is to
          // refuse.
          //
          // 2026-08-31（ADR 0009 D7 / 计划 H6.11）：文案里原来写「Call
          // skill_install again with the current digest」——那个工具已经不存在了，
          // 照着做只会得到一个 UNKNOWN_TOOL。现在的正确做法是把包留在草稿根里，
          // 由人在 UI 上重新启用。
          throw new Error(
            `Skill archive at ${sourcePath} does not match the approved ` +
              `source_digest (expected ${sourceDigest}, found ${downloaded.sha256}); ` +
              'nothing was installed. Leave the package in the draft root and ask ' +
              'the user to enable it again.',
          );
        }
        // ADR 0009 D7 / 计划 H6.7：上传解包进**草稿根**，不再直接写已启用根。
        // 上传与模型创建从此是同一个故事——都落在草稿里，都要人按一下「启用」
        // 才进 prompt 与只读挂载。少了这一步，两条路径的语义就不一致：
        // 模型造的包必须经人启用，上传的包不必。
        const destinationRoot = draftRoot ?? userRoot;
        const result = await installSkillArchive({
          archiveBytes: downloaded.bytes,
          archiveName,
          sourceType,
          ...(fromSandbox ? { sourcePath } : { attachmentId }),
          skillRoot: destinationRoot,
          // 草稿根里叫什么名字都行（它不进任何人的上下文）；遮蔽检查在**启用**
          // 那一刻做。但仍然传进去——直接装的回退路径需要它。
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

    // `create` 与 `edit` 已退役（ADR 0009 D7 / 计划 H6.10）：它们只服务于
    // `skill_create` / `skill_edit` 两个工具，而那套工具整体取消了。模型现在
    // 直接用 `write` / `bash` 往草稿根里写，闸门移到 UI 上的「启用」
    // （`skills/enablement.ts`）。这两个方法此前**没有任何生产调用方**——
    // 唯一的通路是 `skillManagerFactory`，而那个端口只喂给已删除的 extension bundle。

    /**
     * 启用一个草稿包（ADR 0009 D7 / 计划 H6.4–H6.7）。
     *
     * **这是整个 skill 面唯一的闸门。** 模型造的包和用户上传的包都停在草稿根里，
     * 走到这里才进 prompt 与只读挂载。它校验结构、把**字节复制**成一份只读的
     * 已发布副本、返回可入库的记录（`user_skill_enablements`）。
     *
     * 复制而不是挂草稿：两份字节之后，模型改草稿动不了已启用的包
     * ——ADR 0006 P1 (B) 那条绕过因此在构造上消失。
     */
    async enable(params) {
      if (!draftRoot) {
        throw new Error('skill enablement requires a draft root (draftSkillRoot)');
      }
      if (!userRoot) {
        throw new Error('skill enablement requires a writable user skill root');
      }
      const name = String(params?.name || '').trim();
      if (!name) throw new Error('skill enablement requires a package name');
      const draftPackageDir = joinPath(draftRoot, name);
      try {
        const record = await enableDraftPackage({
          draftPackageDir,
          publishedRoot: userRoot,
          expectedName: name,
          systemSkillNames: systemSkillNames(),
        });
        audit({
          action: 'enable',
          result: 'success',
          skill_name: record.name,
          source_type: 'draft',
          source: `draft:${name}`,
          summary:
            `enabled ${record.name} digest=${record.contentDigest.slice(0, 16)} ` +
            `files=${record.fileCount} bytes=${record.totalBytes}`,
        });
        return record;
      } catch (error) {
        audit({
          action: 'enable',
          result: 'failure',
          skill_name: name,
          source_type: 'draft',
          source: `draft:${name}`,
          error: error?.message || String(error),
        });
        throw error;
      }
    },

    /** 停用：删掉已发布副本。**草稿不动**——停用不是删除用户的工作成果。 */
    async disable(params) {
      if (!userRoot) {
        throw new Error('skill disablement requires a writable user skill root');
      }
      const name = String(params?.name || '').trim();
      if (!name) throw new Error('skill disablement requires a package name');
      const result = await disableSkillPackage({ publishedRoot: userRoot, name });
      audit({
        action: 'disable',
        result: 'success',
        skill_name: name,
        summary: result.removed ? `disabled ${name}` : `${name} was not enabled`,
      });
      return result;
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
        const loaded =
          session?.resourceLoader?.getSkills?.()?.skills ||
          session?.getSkills?.()?.skills ||
          null;
        if (Array.isArray(loaded)) skillCount = loaded.length;
        const installed = describeInstalledSkills(skillRoots, {
          writableRoot: userRoot,
        }).map((skill) => skill.name);
        // Fail closed. Pi rebuilt the extension runtime inside session.reload()
        // and this manager asserted the loader reported no errors; DSH composes
        // plugins once at boot, so `onAfterReload` is the only post-reload
        // rebuild left. Swallowing its failure would report a successful reload
        // over a projection that was never rebuilt — the caller must see it.
        if (onAfterReload) await onAfterReload();
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
  draftSkillRootFor,
};
