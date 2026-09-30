/**
 * org 层共享 Skill 的**管理员操作面**（ADR 0015 D5/D6/D8，design §7.2）。
 *
 * ## 这一层负责的三件事
 *
 * 1. **鉴权**：只有 `role === 'admin'` 能做这些操作（非 admin 403）。判定沿用既有
 *    机制——`AuthSubjects.role` 由 BFF 服务端写入的 `X-Acting-*` 头解析而来，
 *    不是浏览器能自己声明的（AGENTS.md §1 的纪律）。
 * 2. **作用域**：所有操作都在调用者**当前 org** 内。跨 org 的资源一律**不存在**
 *    ——不是 403 而是 404，存在性本身不能泄漏（AGENTS.md §2）。
 * 3. **语义**：把「发布 / 改当前版本 / 弃用 / 吊销」翻译成仓储调用，并守住状态机
 *    （`revoked` 是终态，见 `OrgSkillRepository`）。
 *
 * ## 为什么不在这里判「名字是否已被别的作者占用」
 *
 * design §7.1 有一条「一个名字在 org 层首次发布后，其后续版本必须来自同一作者的申请
 * 或管理员上传」。那是**申请流程**的规则（P3），而管理员直传的语义是「管理员即作者与
 * 背书人」——管理员之间不需要争作者身份。所以这条留到 P3 的申请/审批路径上实现，
 * 不在这里假装已经实现。
 */
import type {
  OrgSkillNameRow,
  OrgSkillRepository,
  OrgSkillVersionRow,
} from '../infrastructure/mysql/repositories/org-skill-repository.js';
import { OrgSkillError } from '../infrastructure/mysql/repositories/org-skill-repository.js';
import {
  publishOrgSkillArchive,
  type OrgSkillPublishDeps,
} from '../skills/org-publish.js';

/** 与 `AuthSubjects` 兼容的最小形状。 */
export interface AdminActor {
  readonly externalOrgId: string;
  readonly externalUserId: string;
  readonly role: string | null;
}

/** 非 admin 的拒绝。`status` 由 HTTP 层用。 */
export class AdminRequiredError extends Error {
  readonly code = 'ADMIN_REQUIRED';
  readonly status = 403;
  constructor() {
    super('This operation requires an administrator');
    this.name = 'AdminRequiredError';
  }
}

function requireAdmin(actor: AdminActor | null | undefined): AdminActor {
  if (!actor || actor.role !== 'admin') throw new AdminRequiredError();
  if (!String(actor.externalOrgId ?? '').trim()) throw new AdminRequiredError();
  return actor;
}

/** 把仓储的领域错误映射成 HTTP 状态；其余当作 500（真出错了不该伪装成 400）。 */
export function statusForOrgSkillError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof AdminRequiredError) {
    return { status: 403, code: error.code, message: error.message };
  }
  if (error instanceof OrgSkillError) {
    const notFound = error.code === 'SKILL_ORG_VERSION_UNKNOWN';
    return {
      status: notFound ? 404 : 400,
      code: error.code,
      message: error.message,
    };
  }
  const archiveCode = (error as { code?: string } | null)?.code;
  if (typeof archiveCode === 'string' && archiveCode.startsWith('SKILL_')) {
    return { status: 400, code: archiveCode, message: (error as Error).message };
  }
  return {
    status: 400,
    code: 'SKILL_ORG_OPERATION_FAILED',
    message: (error as Error)?.message || 'Org skill operation failed',
  };
}

export interface OrgSkillAdminDeps extends OrgSkillPublishDeps {
  readonly orgSkills: OrgSkillRepository;
  /**
   * 哪些 AgentVersion 钉了这个 (name, digest)——吊销时告诉运维影响面。
   *
   * 省略即「还查不到」：`agent_version_skill_refs` 表属于 P2 的另一块，先让它返回空
   * 数组而不是编一个数字。**不要**在这里改成「扫所有版本」——那既有 O(n) 又会在
   * 未来的分页口径下给出错误答案。
   */
  readonly affectedAgentVersions?: (input: {
    orgId: string;
    name: string;
    contentDigest: string;
  }) => Promise<string[]>;
  /**
   * 回收本 org 的陈旧版本（ADR 0015 §5.4）。返回被删的摘要与被删后复验出的竞态摘要。
   *
   * 作为**注入依赖**而不是在服务里直接调：回收需要盘上的 org 根与账本，而这两样
   * 已经由本服务持有；但它同时也是「可以关掉」的——测试与只读部署不该被回收副作用
   * 牵连。省略即不回收（字节只会多留，不会少删）。
   */
  readonly collectStaleVersions?: (input: { orgId: string }) => Promise<{
    removedCount: number;
    racedDigests: readonly string[];
  }>;
  /**
   * 外部主体 → **内部 ULID**（`organization_external_refs` / `users.external_subject`）。
   *
   * 每张 org 层账本的 `org_id` 都是 `CHAR(26)` 且带 `→ organizations.org_id` 外键，
   * 存的是内部 ULID；Run 期的 `readOrgVersion` 也按内部 ULID 查。把 BFF 投过来的
   * 外部主体（如 `org_bootstrap`）直接写进去，插入会被外键拒绝，而**查**会静默命中
   * 零行——后者更糟：配置保存成功、起 Run 时绑定凭空消失。
   *
   * 省略时按 `db` 现建 `ExternalIdentityResolver`（与 `AdminRunQueryService` 同一条）。
   */
  readonly resolveOwner: (auth: {
    externalOrgId: string;
    externalUserId: string;
    role: string | null;
  }) => Promise<{ orgId: string; userId: string }>;
}

export class OrgSkillAdminService {
  private readonly resolveOwner: OrgSkillAdminDeps['resolveOwner'];

  constructor(private readonly deps: OrgSkillAdminDeps) {
    this.resolveOwner = deps.resolveOwner;
  }

  /**
   * 把外部主体换成内部 ULID 后再交给业务逻辑。
   *
   * **所有账本读写都必须用返回后的 `externalOrgId`/`externalUserId`**（名字沿用调用方
   * 的形状，值已经是内部 ULID）。判定顺序是「先鉴权、再解析」：不认得的身份不该拿到
   * 「这个 org 存不存在」这个信息。
   */
  async #admin(input: AdminActor | null | undefined): Promise<AdminActor> {
    const actor = requireAdmin(input);
    const owner = await this.resolveOwner({
      externalOrgId: actor.externalOrgId,
      externalUserId: actor.externalUserId,
      role: actor.role,
    });
    return { role: actor.role, externalOrgId: owner.orgId, externalUserId: owner.userId };
  }

  /** 管理员直接上传归档并发布到本 org 的 org 层。 */
  async upload(input: {
    actor: AdminActor | null;
    archiveBytes: Buffer;
    archiveName: string;
    setCurrent?: boolean;
  }): Promise<{ name: string; contentDigest: string; reused: boolean; status: string }> {
    const actor = await this.#admin(input.actor);
    const result = await publishOrgSkillArchive(this.deps, {
      orgId: actor.externalOrgId,
      archiveBytes: input.archiveBytes,
      archiveName: input.archiveName,
      publishedByUserId: actor.externalUserId,
      originKind: 'admin_upload',
      ...(input.setCurrent !== undefined ? { setCurrent: input.setCurrent } : {}),
    });
    await this.#collect(actor.externalOrgId);
    return {
      name: result.version.name,
      contentDigest: result.version.contentDigest,
      reused: result.reused,
      status: result.version.status,
    };
  }

  /**
   * 跑一次回收，并把**竞态**喊出来。
   *
   * 竞态指的是「算完保留集合之后、删之前有人把 current 指到了候选版本上」——那种删除
   * 不可逆（字节没了而账本还指着它）。不能静默：调用方至少要在日志里看到。
   */
  async #collect(orgId: string): Promise<void> {
    if (typeof this.deps.collectStaleVersions !== 'function') return;
    const result = await this.deps.collectStaleVersions({ orgId });
    if (result.racedDigests.length > 0) {
      console.warn(
        `[org-skills] GC raced with a concurrent publish for org ${orgId}: `
        + `${result.racedDigests.join(', ')} were deleted while referenced or current. `
        + 'Republish those digests; the ledger still points at them.',
      );
    }
  }

  /** 本 org 的 org 层列表（每名的版本与状态、当前指针）。 */
  async list(input: { actor: AdminActor | null }): Promise<{ skills: OrgSkillNameRow[] }> {
    const actor = await this.#admin(input.actor);
    return { skills: await this.deps.orgSkills.listForOrg({ orgId: actor.externalOrgId }) };
  }

  /**
   * 取某个版本的文件清单与截断的 SKILL.md。
   *
   * **只列文件，不返回内容**（除 SKILL.md 的截断文本）：管理员审阅要能看到「这个包有
   * 哪些文件」，但把整个包的内容塞进 API 既没必要又会放大泄漏面。
   */
  async manifest(input: {
    actor: AdminActor | null;
    name: string;
    contentDigest: string;
  }): Promise<{
    name: string;
    contentDigest: string;
    fileCount: number;
    totalBytes: number;
    files: Array<{ path: string; bytes: number }>;
    skillMd: string;
    truncated: boolean;
    affectedAgentVersionIds: string[];
  }> {
    const actor = await this.#admin(input.actor);
    const version = await this.deps.orgSkills.getVersion({
      orgId: actor.externalOrgId,
      name: input.name,
      contentDigest: input.contentDigest,
    });
    // 跨 org / 不存在的版本：404（不泄漏存在性）。
    if (!version) {
      throw new OrgSkillError(
        `org skill "${input.name}" has no version ${input.contentDigest}`,
        'SKILL_ORG_VERSION_UNKNOWN',
      );
    }
    const { readPublishedVersionManifest } = await import('../skills/enablement.js');
    const listing = await readPublishedVersionManifest(
      this.orgRoot(actor.externalOrgId),
      input.name,
      input.contentDigest,
    );
    if (!listing.ok) {
      // 账本说存在、盘上没有：这是存储损坏，不是「没找到」。
      const reason = (listing as { reason: string }).reason;
      throw new OrgSkillError(
        `published bytes for ${input.name}@${input.contentDigest} are ${reason}`,
        'SKILL_ORG_BYTES_MISSING',
      );
    }
    const ok = listing as {
      files: Array<{ path: string; bytes: number }>;
      skillMd: string;
      truncated: boolean;
    };
    const affectedAgentVersionIds = typeof this.deps.affectedAgentVersions === 'function'
      ? await this.deps.affectedAgentVersions({
        orgId: actor.externalOrgId,
        name: input.name,
        contentDigest: input.contentDigest,
      })
      : [];
    return {
      name: version.name,
      contentDigest: version.contentDigest,
      fileCount: version.fileCount,
      totalBytes: version.totalBytes,
      files: ok.files,
      skillMd: ok.skillMd,
      truncated: ok.truncated,
      affectedAgentVersionIds,
    };
  }

  /** 改「当前推荐版本」。不影响任何已钉住的 AgentVersion。 */
  async setCurrent(input: {
    actor: AdminActor | null;
    name: string;
    contentDigest: string;
  }): Promise<void> {
    const actor = await this.#admin(input.actor);
    const version = await this.deps.orgSkills.getVersion({
      orgId: actor.externalOrgId,
      name: input.name,
      contentDigest: input.contentDigest,
    });
    if (!version) {
      throw new OrgSkillError(
        `org skill "${input.name}" has no version ${input.contentDigest}`,
        'SKILL_ORG_VERSION_UNKNOWN',
      );
    }
    await this.deps.orgSkills.setCurrent({
      orgId: actor.externalOrgId,
      name: input.name,
      contentDigest: input.contentDigest,
      updatedByUserId: actor.externalUserId,
    });
    // 指针移开之后，**原来那个 current** 可能就只剩宽限期保护了——不跑回收它会一直留着。
    await this.#collect(actor.externalOrgId);
  }

  /**
   * 弃用 / 吊销。
   *
   * 响应带**受影响的 AgentVersion 列表**：吊销是安全动作，运维要能立刻知道哪些
   * Agent 的下一个 Run 会因此丢挂载（design §7.2）。
   */
  async setStatus(input: {
    actor: AdminActor | null;
    name: string;
    contentDigest: string;
    status: 'deprecated' | 'revoked';
    reason: string;
  }): Promise<{ version: OrgSkillVersionRow; affectedAgentVersionIds: string[] }> {
    const actor = await this.#admin(input.actor);
    const version = await this.deps.orgSkills.setStatus({
      orgId: actor.externalOrgId,
      name: input.name,
      contentDigest: input.contentDigest,
      status: input.status,
      reason: input.reason,
      changedByUserId: actor.externalUserId,
    });
    const affectedAgentVersionIds = typeof this.deps.affectedAgentVersions === 'function'
      ? await this.deps.affectedAgentVersions({
        orgId: actor.externalOrgId,
        name: input.name,
        contentDigest: input.contentDigest,
      })
      : [];
    // 吊销/弃用之后跑回收：被吊销且没人引用的版本，到了宽限期就该回收（design §5.4）。
    await this.#collect(actor.externalOrgId);
    return { version, affectedAgentVersionIds };
  }

  /** org 层 owner 根：`<base>/<orgId>/_org`。 */
  private orgRoot(orgId: string): string {
    return `${this.deps.publishedBase.replace(/\/+$/, '')}/${orgId}/_org`;
  }
}

/** `presentation/http/skill-routes.ts` 传进来的形状（不引 HTTP 类型，保持方向）。 */
export interface OrgSkillAdminRequest {
  readonly method: string | undefined;
  readonly path: string;
  readonly auth: AdminActor;
  readonly query: { get(name: string): string | null };
  readonly readBody: () => Promise<Buffer>;
  readonly headers: Record<string, string | string[] | undefined>;
}

export interface OrgSkillAdminResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

function decodeSegment(raw: string | undefined): string {
  return raw === undefined ? '' : decodeURIComponent(raw);
}

function headerString(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string {
  const value = headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return '';
}

/**
 * 把 HTTP 请求翻译成服务调用，并返回**已经映射好**的状态码与响应体。
 *
 * 返回 `null` 表示「这个路径不归我管」，由调用方继续尝试别的路由——这样新增
 * 子路径不会静默吞掉既有路由。
 *
 * 路径（design §7.2）：
 * - `POST   /internal/skills/org`                                  管理员直传归档
 * - `GET    /internal/skills/org`                                  本 org 列表
 * - `GET    /internal/skills/org/:name/versions/:digest/manifest`  文件清单
 * - `POST   /internal/skills/org/:name/current`                    改当前推荐版本
 * - `POST   /internal/skills/org/:name/versions/:digest/deprecate` 弃用
 * - `POST   /internal/skills/org/:name/versions/:digest/revoke`    吊销
 */
export function createOrgSkillAdminHandler(
  service: OrgSkillAdminService,
): (input: OrgSkillAdminRequest) => Promise<OrgSkillAdminResponse | null> {
  return async (input) => {
    const { method, path, auth } = input;
    try {
      if (path === '/internal/skills/org') {
        if (method === 'GET') {
          return { status: 200, body: await service.list({ actor: auth }) };
        }
        if (method === 'POST') {
          const filename = headerString(input.headers, 'x-filename')
            || input.query.get('filename')
            || 'skill.zip';
          // 归档本体就是请求体，所以元数据走 query / 头（与既有草稿上传同一种形态）。
          // 用 `set_current=true` 而不是自定义头：query 更容易在日志与 curl 里看清。
          const setCurrent = ['1', 'true'].includes(String(input.query.get('set_current') ?? ''));
          const archiveBytes = await input.readBody();
          const result = await service.upload({
            actor: auth,
            archiveBytes,
            archiveName: filename,
            setCurrent,
          });
          return { status: 201, body: result };
        }
        return null;
      }

      const manifestMatch = path.match(
        /^\/internal\/skills\/org\/([^/]+)\/versions\/([^/]+)\/manifest$/,
      );
      if (method === 'GET' && manifestMatch) {
        return {
          status: 200,
          body: await service.manifest({
            actor: auth,
            name: decodeSegment(manifestMatch[1]),
            contentDigest: decodeSegment(manifestMatch[2]),
          }),
        };
      }

      const currentMatch = path.match(/^\/internal\/skills\/org\/([^/]+)\/current$/);
      if (method === 'POST' && currentMatch) {
        const payload = JSON.parse(String(await input.readBody() || '{}')) as {
          contentDigest?: unknown;
        };
        const contentDigest = typeof payload?.contentDigest === 'string' ? payload.contentDigest : '';
        if (!contentDigest) {
          return {
            status: 400,
            body: { error: 'contentDigest is required', code: 'SKILL_ORG_DIGEST_REQUIRED' },
          };
        }
        await service.setCurrent({
          actor: auth,
          name: decodeSegment(currentMatch[1]),
          contentDigest,
        });
        return { status: 200, body: { ok: true } };
      }

      const statusMatch = path.match(
        /^\/internal\/skills\/org\/([^/]+)\/versions\/([^/]+)\/(deprecate|revoke)$/,
      );
      if (method === 'POST' && statusMatch) {
        const payload = JSON.parse(String(await input.readBody() || '{}')) as { reason?: unknown };
        const result = await service.setStatus({
          actor: auth,
          name: decodeSegment(statusMatch[1]),
          contentDigest: decodeSegment(statusMatch[2]),
          status: statusMatch[3] === 'revoke' ? 'revoked' : 'deprecated',
          reason: typeof payload?.reason === 'string' ? payload.reason : '',
        });
        return {
          status: 200,
          body: {
            ok: true,
            status: result.version.status,
            affectedAgentVersionIds: result.affectedAgentVersionIds,
          },
        };
      }

      return null;
    } catch (error) {
      const mapped = statusForOrgSkillError(error);
      return {
        status: mapped.status,
        body: { error: mapped.message, code: mapped.code },
      };
    }
  };
}
