/**
 * 共享申请的流程服务（ADR 0015 D6，design §7.1/§7.2）。
 *
 * ## 两侧各自的动作
 *
 * - **用户侧**：对自己**已启用**的版本发起申请（钉住该摘要）、看自己的申请、撤回自己的
 *   `pending`。没有「已启用」就没有可分享的字节——申请的是**发布副本的摘要**，不是草稿。
 * - **管理员侧**：审阅（文件清单 + `SKILL.md`）、批准、驳回。管理员作用域是其**当前 org**，
 *   跨 org 一律 404。
 *
 * ## 批准为什么必须复制字节并重算摘要
 *
 * 用户申请时钉的是「当时那一份」。批准时从作者的**已发布版本**复制，再重算摘要：
 * - 复制源是发布副本而不是草稿——草稿模型可写，批准一个会变的目录等于批准移动目标；
 * - 重算后与申请摘要比对，**不等即拒绝**，并把两个摘要都带回去，让人能判断是
 *   「作者改过」还是「申请时看错了」。此时申请**保持 `pending`**，不是 rejected：
 *   作者可以重新发布再申请，而「被拒绝」是管理员的判断，不该由一次竞态代劳。
 *
 * ## 一个名字只能有一个来源
 *
 * design §7.1：一个名字在 org 层首次发布后，其后续版本必须来自**同一作者**的申请，
 * 或管理员直传。所以批准时要检查名字是否已被别的作者占用（`SKILL_ORG_NAME_TAKEN`）——
 * 否则两个用户各自申请同名，先被批准的会静默挡住后来者，而后来者看不到原因。
 */
import { OrgSkillPublishError } from '../skills/org-publish.js';
import type { OrgSkillRepository } from '../infrastructure/mysql/repositories/org-skill-repository.js';
import type {
  ShareRequestRow,
  SkillShareRequestRepository,
} from '../infrastructure/mysql/repositories/skill-share-request-repository.js';
import { ShareRequestError } from '../infrastructure/mysql/repositories/skill-share-request-repository.js';

/** 发起申请的人。 */
export interface RequesterActor {
  readonly externalOrgId: string;
  readonly externalUserId: string;
}

/** 决定申请的人（管理员）。 */
export interface DeciderActor extends RequesterActor {
  readonly role: string | null;
}

/** 非 admin 的拒绝。与 org 层管理员面共用同一个码。 */
export class ShareAdminRequiredError extends Error {
  readonly code = 'ADMIN_REQUIRED';
  readonly status = 403;
  constructor() {
    super('This operation requires an administrator');
    this.name = 'ShareAdminRequiredError';
  }
}

/** 申请流程里的可预期失败。`code` 直接给到 HTTP 层。 */
export class ShareFlowError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = 'ShareFlowError';
    this.status = status;
    this.code = code;
  }
}

/** 申请一个 Skill 时需要的「作者已启用/已发布」事实。 */
export interface ShareFlowDeps {
  readonly requests: SkillShareRequestRepository;
  readonly orgSkills: OrgSkillRepository;
  /**
   * 作者**已启用**的版本（不是草稿）。返回 `null` 表示没启用过这个名字。
   *
   * 注入而不是直连启用账本：这个服务不该知道账本的表结构，也不该顺手去读草稿根。
   */
  enabledVersionOf(input: {
    orgId: string;
    userId: string;
    name: string;
  }): Promise<{ readonly contentDigest: string } | null>;
  /** 本 org 里已经存在（非吊销）的 org 层名字 → 作者。用于名字占用判定。 */
  orgSkillOwnerOf(input: {
    orgId: string;
    name: string;
  }): Promise<{ readonly originUserId: string } | null>;
  /** 把作者的已发布版本发布到 org 层；实现见 `skills/org-publish.ts`。 */
  publishFromPublished(input: {
    orgId: string;
    requesterUserId: string;
    name: string;
    contentDigest: string;
    originRequestId: string;
    publishedByUserId: string;
    setCurrent?: boolean;
  }): Promise<{ readonly contentDigest: string }>;
  /**
   * 被申请那一版的文件清单与截断的 `SKILL.md`（管理员审阅用）。
   *
   * 注入而不是在这里读盘：需要「作者的 owner 根」这个只有调用方知道的事实。
   * 省略即审阅面不可用（管理员仍可批准/驳回，但看不到内容）。
   */
  manifestOfRequestedVersion?: (input: {
    orgId: string;
    requesterUserId: string;
    name: string;
    contentDigest: string;
  }) => Promise<{
    readonly files: Array<{ path: string; bytes: number }>;
    readonly skillMd: string;
    readonly truncated: boolean;
  } | null>;
  /** 审计：每次状态转换都记一条。省略即不记（测试）。 */
  audit?: (event: {
    action: string;
    result: 'success' | 'failure';
    orgId: string;
    userId: string;
    name: string;
    contentDigest?: string;
    requestId?: string;
    reason?: string;
  }) => void;
  /**
   * 外部主体 → **内部 ULID**（`organization_external_refs` / `users.external_subject`）。
   *
   * 申请书账本的三处 id（`org_id`、`requester_user_id`、`decided_by_user_id`）都按内部
   * ULID 写：`org_id` 带 `→ organizations.org_id` 外键，而 Run 期的 org 身份也是内部
   * ULID。写外部主体（如 `org_bootstrap`）插入会被外键拒绝；更糟的是**查**会静默命中
   * 零行——申请看起来提交成功、队列里却什么也没有。
   *
   * 省略时按 `db` 现建 `ExternalIdentityResolver`（与 `AdminRunQueryService` 同一条）。
   */
  readonly resolveOwner: (auth: {
    externalOrgId: string;
    externalUserId: string;
    role?: string | null;
  }) => Promise<{ orgId: string; userId: string }>;
}

function requireDecider(actor: DeciderActor | null | undefined): DeciderActor {
  if (!actor || actor.role !== 'admin') throw new ShareAdminRequiredError();
  if (!String(actor.externalOrgId ?? '').trim()) throw new ShareAdminRequiredError();
  return actor;
}

/**
 * 把申请流程的错误映射成 HTTP。
 *
 * 单独放在这里（而不是复用 org 层管理员面的映射器）是因为这两个域的错误码不同，
 * 合并会让一个域的新码悄悄落到另一个域的默认分支上。
 */
export function statusForShareError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof ShareAdminRequiredError) {
    return { status: 403, code: error.code, message: error.message };
  }
  if (error instanceof ShareFlowError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  if (error instanceof ShareRequestError) {
    const notFound = error.code === 'SKILL_SHARE_REQUEST_UNKNOWN';
    // 已决定是状态冲突（并发的撤回/批准/驳回），与服务层同码同状态：409。
    const conflict = error.code === 'SKILL_SHARE_REQUEST_DECIDED';
    return {
      status: notFound ? 404 : conflict ? 409 : 400,
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof OrgSkillPublishError) {
    // 摘要不一致 / 源缺失 / 已撤销，都是**可以解释给管理员看**的业务结果。
    return { status: 400, code: error.code, message: error.message };
  }
  return {
    status: 400,
    code: 'SKILL_SHARE_OPERATION_FAILED',
    message: (error as Error)?.message || 'Share operation failed',
  };
}

export class SkillShareService {
  private readonly resolveOwner: ShareFlowDeps['resolveOwner'];

  constructor(private readonly deps: ShareFlowDeps) {
    this.resolveOwner = deps.resolveOwner;
  }

  /**
   * 把外部主体换成内部 ULID 后再交给业务逻辑。
   *
   * 返回对象沿用 `external*` 字段名（调用方与仓储的参数名都是它），但**值已经是内部
   * ULID**——所有账本读写都必须经过这里，不能有第二条路。
   */
  async #actor<T extends RequesterActor>(actor: T): Promise<T> {
    const owner = await this.resolveOwner({
      externalOrgId: actor.externalOrgId,
      externalUserId: actor.externalUserId,
      role: 'role' in actor ? (actor.role as string | null) : null,
    });
    return { ...actor, externalOrgId: owner.orgId, externalUserId: owner.userId };
  }

  /**
   * 用户对**自己已启用**的版本发起申请。
   *
   * 未启用 → 409 `SKILL_NOT_ENABLED`（design §7.2 明写这个码）。用 409 而不是 400：
   * 请求本身合法，是当前状态不允许——作者可以先启用再来。
   */
  async requestShare(input: {
    actor: RequesterActor;
    name: string;
    note?: string;
  }): Promise<ShareRequestRow> {
    const actor = await this.#actor(input.actor);
    const enabled = await this.deps.enabledVersionOf({
      orgId: actor.externalOrgId,
      userId: actor.externalUserId,
      name: input.name,
    });
    if (!enabled) {
      throw new ShareFlowError(
        `"${input.name}" is not enabled for this user; enable it before requesting a share`,
        'SKILL_NOT_ENABLED',
        409,
      );
    }
    const row = await this.deps.requests.create({
      orgId: actor.externalOrgId,
      requesterUserId: actor.externalUserId,
      name: input.name,
      contentDigest: enabled.contentDigest,
      ...(input.note !== undefined ? { note: input.note } : {}),
    });
    this.#audit({
      action: 'share_request', result: 'success',
      orgId: actor.externalOrgId, userId: actor.externalUserId,
      name: input.name, contentDigest: enabled.contentDigest, requestId: row.requestId,
    });
    return row;
  }

  /** 本人的申请列表。 */
  async listMine(input: { actor: RequesterActor }): Promise<ShareRequestRow[]> {
    const actor = await this.#actor(input.actor);
    return this.deps.requests.listForRequester({
      orgId: actor.externalOrgId,
      requesterUserId: actor.externalUserId,
    });
  }

  /** 撤回本人的 pending 申请。 */
  async withdraw(input: { actor: RequesterActor; requestId: string }): Promise<ShareRequestRow> {
    const actor = await this.#actor(input.actor);
    const row = await this.deps.requests.withdraw({
      requestId: input.requestId,
      requesterUserId: actor.externalUserId,
    });
    this.#audit({
      action: 'share_withdraw', result: 'success',
      orgId: input.actor.externalOrgId, userId: input.actor.externalUserId,
      name: row.name, requestId: row.requestId,
    });
    return row;
  }

  /**
   * 管理员列表（本 org）。
   *
   * 按 org 过滤**在这里**做：仓储的 `listForOrg` 要 orgId，而 orgId 来自服务端解析出的
   * 调用者身份——不信任任何请求参数。
   */
  async listForAdmin(input: {
    actor: DeciderActor | null;
    status?: 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'superseded';
  }): Promise<ShareRequestRow[]> {
    const actor = await this.#actor(requireDecider(input.actor));
    return this.deps.requests.listForOrg({
      orgId: actor.externalOrgId,
      ...(input.status ? { status: input.status } : {}),
    });
  }

  /**
   * 批准：复制作者的已发布字节到 org 层，并把申请迁到 `approved`。
   *
   * **顺序是先状态后字节，字节失败再退回**：
   * - 先在行锁里把 `pending` 迁到 `approved`：与作者的撤回互斥。反过来（先字节）时，
   *   发布过程中作者撤回会成功，而他的 Skill 已进了 org 层——同意被撤回了，字节却在；
   * - 字节失败（摘要不一致、源缺失）→ 申请退回 **`pending`**（`reopenApproval`），
   *   把原因带回去，作者可以重新发布再申请，不会留下「已批准但 org 层没有这个版本」。
   */
  async approve(input: {
    actor: DeciderActor | null;
    requestId: string;
    setCurrent?: boolean;
    note?: string;
  }): Promise<{ request: ShareRequestRow; contentDigest: string }> {
    const actor = await this.#actor(requireDecider(input.actor));
    const request = await this.#requirePendingInOrg(input.requestId, actor.externalOrgId);

    // 名字占用：一个名字在 org 层首次发布后，后续版本必须来自同一作者（design §7.1）。
    const owner = await this.deps.orgSkillOwnerOf({ orgId: actor.externalOrgId, name: request.name });
    if (owner && owner.originUserId !== request.requesterUserId) {
      throw new ShareFlowError(
        `org skill "${request.name}" was published by another author and cannot be taken over by this request`,
        'SKILL_ORG_NAME_TAKEN',
        409,
      );
    }

    // 先在行锁里迁到 approved，再发字节。反过来（先字节后状态）时，发布过程中作者
    // 撤回会成功，随后 decide 失败——作者撤回了同意，他的 Skill 却已经进了 org 层
    // （setCurrent 时还是推荐版本）。先迁状态让撤回与批准互斥；字节失败时退回 pending，
    // 所以也不会留下「已批准但 org 层没有这个版本」。
    let decided: ShareRequestRow;
    try {
      decided = await this.deps.requests.decide({
        requestId: request.requestId,
        status: 'approved',
        decidedByUserId: actor.externalUserId,
        ...(input.note !== undefined ? { note: input.note } : {}),
      });
    } catch (error) {
      // 并发撤回/批准已经改掉了状态：原样抛出（`statusForShareError` 映射成 409）。
      throw error;
    }

    let published: { contentDigest: string };
    try {
      published = await this.deps.publishFromPublished({
        orgId: actor.externalOrgId,
        requesterUserId: request.requesterUserId,
        name: request.name,
        contentDigest: request.contentDigest,
        originRequestId: request.requestId,
        publishedByUserId: actor.externalUserId,
        ...(input.setCurrent !== undefined ? { setCurrent: input.setCurrent } : {}),
      });
    } catch (error) {
      await this.deps.requests.reopenApproval({
        requestId: request.requestId,
        decidedByUserId: actor.externalUserId,
      }).catch(() => false);
      this.#audit({
        action: 'share_approve', result: 'failure',
        orgId: actor.externalOrgId, userId: actor.externalUserId,
        name: request.name, contentDigest: request.contentDigest,
        requestId: request.requestId, reason: (error as Error)?.message,
      });
      throw error;
    }

    this.#audit({
      action: 'share_approve', result: 'success',
      orgId: actor.externalOrgId, userId: actor.externalUserId,
      name: request.name, contentDigest: published.contentDigest,
      requestId: request.requestId,
    });
    return { request: decided, contentDigest: published.contentDigest };
  }

  /**
   * 管理员审阅：被申请版本的**文件清单**与截断的 `SKILL.md`。
   *
   * design §7.1 原话：管理员只能看到**被申请的那一个版本**，不能浏览作者的其他 Skill。
   * 所以这个入口只按 `(requester, name, digest)` 取，没有「列出该作者的所有包」这种形状。
   */
  async reviewManifest(input: {
    actor: DeciderActor | null;
    requestId: string;
  }): Promise<{
    request: ShareRequestRow;
    files: Array<{ path: string; bytes: number }>;
    skillMd: string;
    truncated: boolean;
  }> {
    const actor = await this.#actor(requireDecider(input.actor));
    const request = await this.#requirePendingInOrg(input.requestId, actor.externalOrgId);
    const manifest = this.deps.manifestOfRequestedVersion
      ? await this.deps.manifestOfRequestedVersion({
        orgId: actor.externalOrgId,
        requesterUserId: request.requesterUserId,
        name: request.name,
        contentDigest: request.contentDigest,
      })
      : null;
    if (!manifest) {
      // 账本说这一版存在、盘上没有（或部署没接审阅面）：这是**存储问题**，不是「没找到」。
      throw new ShareFlowError(
        `requested version ${request.contentDigest} of "${request.name}" is not available for review`,
        'SKILL_SHARE_SOURCE_MISSING',
        400,
      );
    }
    return {
      request,
      files: manifest.files,
      skillMd: manifest.skillMd,
      truncated: manifest.truncated,
    };
  }

  /** 驳回：只改状态，不碰 org 层（没有字节落地）。 */
  async reject(input: {
    actor: DeciderActor | null;
    requestId: string;
    note: string;
  }): Promise<ShareRequestRow> {
    const actor = await this.#actor(requireDecider(input.actor));
    const request = await this.#requirePendingInOrg(input.requestId, actor.externalOrgId);
    const decided = await this.deps.requests.decide({
      requestId: request.requestId,
      status: 'rejected',
      decidedByUserId: actor.externalUserId,
      note: input.note,
    });
    this.#audit({
      action: 'share_reject', result: 'success',
      orgId: actor.externalOrgId, userId: actor.externalUserId,
      name: request.name, requestId: request.requestId, reason: input.note,
    });
    return decided;
  }

  /**
   * 取一条**本 org 的、仍 pending**的申请；否则 404 / 409。
   *
   * 跨 org 走 404 而不是 403：存在性本身不能泄漏（AGENTS.md §2）。所以这里先按
   * requestId 取行、再比 org，跨 org 时**报成不存在**。
   */
  async #requirePendingInOrg(requestId: string, orgId: string): Promise<ShareRequestRow> {
    const row = await this.deps.requests.get(requestId);
    if (!row || row.orgId !== orgId) {
      throw new ShareFlowError(
        `share request ${requestId} does not exist`,
        'SKILL_SHARE_REQUEST_UNKNOWN',
        404,
      );
    }
    if (row.status !== 'pending') {
      throw new ShareFlowError(
        `share request ${requestId} is already ${row.status}`,
        'SKILL_SHARE_REQUEST_DECIDED',
        409,
      );
    }
    return row;
  }

  #audit(event: Parameters<NonNullable<ShareFlowDeps['audit']>>[0]): void {
    this.deps.audit?.(event);
  }
}

/** `presentation/http/skill-routes.ts` 传进来的形状（不引 HTTP 类型，保持方向）。 */
export interface ShareHttpRequest {
  readonly method: string | undefined;
  readonly path: string;
  readonly auth: { externalOrgId: string; externalUserId: string; role: string | null };
  readonly query: { get(name: string): string | null };
  readonly readBody: () => Promise<Buffer>;
}

export interface ShareHttpResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

function decodeSegment(raw: string | undefined): string {
  return raw === undefined ? '' : decodeURIComponent(raw);
}

async function readJsonObject(read: () => Promise<Buffer>): Promise<Record<string, unknown>> {
  const raw = String(await read() || '').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // 非法 JSON 当成空对象会让「note 丢了」静默通过；这里显式拒绝。
    throw new ShareFlowError('request body is not valid JSON', 'SKILL_SHARE_BODY_INVALID', 400);
  }
}

/**
 * 把 HTTP 请求翻译成共享申请流程的调用。
 *
 * 返回 `null` 表示「这个路径不归我管」，让调用方继续尝试别的路由。
 *
 * 路径（design §7.2）：
 * - 用户侧：`POST /internal/skills/share-requests`（对已启用版本发起申请）、
 *   `GET /internal/skills/share-requests`（本人列表）、
 *   `POST /internal/skills/share-requests/:id/withdraw`
 * - 管理员：`GET /internal/skills/share-requests?scope=org&status=`（本 org 列表）、
 *   `GET /internal/skills/share-requests/:id/manifest`、
 *   `POST /internal/skills/share-requests/:id/approve` / `/reject`
 *
 * 用户侧与管理员的 `GET` 共用同一个路径，靠 `scope=org` 区分：管理员要看全 org 的队列，
 * 用户只会看自己的。**权限判定不靠这个参数**——`scope=org` 仍要过 admin 检查。
 */
export function createSkillShareHandler(
  service: SkillShareService,
): (input: ShareHttpRequest) => Promise<ShareHttpResponse | null> {
  return async (input) => {
    const { method, path, auth } = input;
    try {
      if (!path.startsWith('/internal/skills/share-requests')) return null;

      if (path === '/internal/skills/share-requests') {
        if (method === 'GET') {
          // `scope=org` 走管理员列表（内部仍要过 admin），否则是本人列表。
          if (String(input.query.get('scope') ?? '') === 'org') {
            const status = String(input.query.get('status') ?? '').trim();
            const allowed = ['pending', 'approved', 'rejected', 'withdrawn', 'superseded'];
            return {
              status: 200,
              body: {
                requests: await service.listForAdmin({
                  actor: auth,
                  ...(allowed.includes(status) ? { status: status as 'pending' } : {}),
                }),
              },
            };
          }
          return { status: 200, body: { requests: await service.listMine({ actor: auth }) } };
        }
        if (method === 'POST') {
          const payload = await readJsonObject(input.readBody);
          const name = typeof payload.name === 'string' ? payload.name : '';
          if (!name) {
            return {
              status: 400,
              body: { error: 'name is required', code: 'SKILL_SHARE_NAME_REQUIRED' },
            };
          }
          const row = await service.requestShare({
            actor: auth,
            name,
            ...(typeof payload.note === 'string' ? { note: payload.note } : {}),
          });
          return { status: 201, body: { request: row } };
        }
        return null;
      }

      const withdrawMatch = path.match(/^\/internal\/skills\/share-requests\/([^/]+)\/withdraw$/);
      if (method === 'POST' && withdrawMatch) {
        return {
          status: 200,
          body: {
            request: await service.withdraw({
              actor: auth,
              requestId: decodeSegment(withdrawMatch[1]),
            }),
          },
        };
      }

      const manifestMatch = path.match(/^\/internal\/skills\/share-requests\/([^/]+)\/manifest$/);
      if (method === 'GET' && manifestMatch) {
        const review = await service.reviewManifest({
          actor: auth,
          requestId: decodeSegment(manifestMatch[1]),
        });
        return {
          status: 200,
          body: {
            request: review.request,
            files: review.files,
            skillMd: review.skillMd,
            truncated: review.truncated,
          },
        };
      }

      const decideMatch = path.match(
        /^\/internal\/skills\/share-requests\/([^/]+)\/(approve|reject)$/,
      );
      if (method === 'POST' && decideMatch) {
        const requestId = decodeSegment(decideMatch[1]);
        const payload = await readJsonObject(input.readBody);
        if (decideMatch[2] === 'approve') {
          const result = await service.approve({
            actor: auth,
            requestId,
            ...(typeof payload.setCurrent === 'boolean' ? { setCurrent: payload.setCurrent } : {}),
            ...(typeof payload.note === 'string' ? { note: payload.note } : {}),
          });
          return {
            status: 200,
            body: {
              request: result.request,
              contentDigest: result.contentDigest,
            },
          };
        }
        // 驳回必须带原因：没有原因的驳回在审计里等于没解释。
        const note = typeof payload.note === 'string' ? payload.note.trim() : '';
        if (!note) {
          return {
            status: 400,
            body: { error: 'note is required when rejecting', code: 'SKILL_SHARE_NOTE_REQUIRED' },
          };
        }
        return {
          status: 200,
          body: { request: await service.reject({ actor: auth, requestId, note }) },
        };
      }

      return null;
    } catch (error) {
      const mapped = statusForShareError(error);
      return {
        status: mapped.status,
        body: { error: mapped.message, code: mapped.code },
      };
    }
  };
}
