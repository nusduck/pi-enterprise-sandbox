/**
 * org 层共享 Skill 的**发布服务**（ADR 0015 D5/D6，design §5.1/§5.3）。
 *
 * ## 这个模块负责把三件事按顺序串对
 *
 * 1. **解包与校验**：复用用户层的归档校验（`installSkillArchive`）——大小、条目数、
 *    路径穿越、符号链接、frontmatter 与系统同名遮蔽都是同一套规则。org 层不该有
 *    第二套更松的校验。
 * 2. **落字节**：复用 `publishDraftVersion` 写 `<base>/<orgId>/_org/<name>/.v/<digest>/`，
 *    布局与用户层完全一致（这就是 ADR 0015 D5「复用按摘要分版本的发布存储」的含义）。
 * 3. **写账本**：摘要与文件数来自**复制后的暂存字节**，不是上传的 zip——zip 里的
 *    目录项顺序、时间戳、压缩方式都不该影响身份。
 *
 * ## 顺序为什么是「先字节、后账本」
 *
 * 与既有启用流程同一条纪律（design §5.3）：任何一步失败，账本里**不会**出现这个版本，
 * 只留下一个没人引用的版本目录，由 GC 回收。反过来（先账本后字节）会留下一个账本
 * 指向不存在字节的版本——那种损坏在 Run 期才发现，而那时已经离「谁写坏的」很远。
 *
 * ## 临时区为什么不在发布存储里
 *
 * 解包中途的目录不能出现在 `<base>/<orgId>/_org/` 下：那个根的每个子目录都会被当成
 * 「这个 org 有一个叫这个名字的包」，一个半成品会被 GC 与列表接口看见。所以用系统
 * 临时目录，并在 `finally` 里无论成败都清掉。
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { installSkillArchive } from './install.js';
import { publishDraftVersion } from './enablement.js';
import { orgSkillRootFor } from './paths.js';
import type { OrgSkillRepository, OrgSkillVersionRow } from '../infrastructure/mysql/repositories/org-skill-repository.js';

/** 发布一个 org 版本需要的外部事实，全部注入，便于测试。 */
export interface OrgSkillPublishDeps {
  readonly orgSkills: OrgSkillRepository;
  /** 当前 release 的系统包名——org 名不得与它们冲突（ADR 0015 D7）。 */
  systemSkillNames(): Promise<readonly string[]>;
  /** 用户层/org 层共用的发布存储基根（`SKILLS_USER_ROOT`）。 */
  readonly publishedBase: string;
  /** 覆盖临时区根目录（测试用）。 */
  readonly tmpRoot?: string;
  readonly now?: () => Date;
}

export interface PublishOrgSkillInput {
  readonly orgId: string;
  readonly archiveBytes: Buffer;
  readonly archiveName: string;
  /** 发布者（管理员）。同时是 org 层的作者。 */
  readonly publishedByUserId: string;
  /** 来自用户申请时填写，用于审计追溯；管理员直传留空。 */
  readonly originKind: 'admin_upload' | 'share_request';
  readonly originUserId?: string;
  readonly originRequestId?: string;
  /** 是否把「当前推荐版本」指到这个版本。 */
  readonly setCurrent?: boolean;
}

/** 发布结果：账本行 + 字节是否被复用（同摘要已发布过）。 */
export interface PublishOrgSkillResult {
  readonly version: OrgSkillVersionRow;
  readonly reused: boolean;
  readonly publishedPath: string;
}

export class OrgSkillPublishError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'OrgSkillPublishError';
    this.code = code;
  }
}

/**
 * 解包一个归档并发布到 org 层。
 *
 * 抛出的形状分两类，调用方据此给不同的 HTTP 状态：
 * - 归档/校验类失败（不是合法 zip、路径穿越、缺 SKILL.md、与系统同名）原样上抛，
 *   由 HTTP 层映射成 400；
 * - 账本类失败是 `OrgSkillError`（`SKILL_ORG_VERSION_REVOKED` 等）。
 */
export async function publishOrgSkillArchive(
  deps: OrgSkillPublishDeps,
  input: PublishOrgSkillInput,
): Promise<PublishOrgSkillResult> {
  const orgRoot = orgSkillRootFor({ orgId: input.orgId }, deps.publishedBase);
  const systemNames = await deps.systemSkillNames();
  const tmpBase = deps.tmpRoot ?? os.tmpdir();
  const stagingRoot = await fsp.mkdtemp(path.join(tmpBase, 'dsh-org-skill-'));
  try {
    // 1) 解包到这个临时根，它**不在**发布存储里（见模块说明）。
    const installed = await installSkillArchive({
      archiveBytes: input.archiveBytes,
      archiveName: input.archiveName,
      sourceType: 'upload',
      skillRoot: stagingRoot,
      systemSkillNames: systemNames,
    });
    // 2) 复制字节到 org owner 根。摘要按复制后的暂存字节算。
    const published = await publishDraftVersion({
      draftPackageDir: path.join(stagingRoot, installed.name),
      publishedRoot: orgRoot,
      expectedName: installed.name,
      systemSkillNames: systemNames,
      ...(deps.now ? { now: deps.now } : {}),
    });
    // 3) 最后写账本：这一步失败只会留下一个没人引用的版本目录（由 GC 回收）。
    const version = await deps.orgSkills.publishVersion({
      orgId: input.orgId,
      name: published.name,
      contentDigest: published.contentDigest,
      fileCount: published.fileCount,
      totalBytes: published.totalBytes,
      description: published.description,
      originKind: input.originKind,
      originUserId: input.originUserId ?? input.publishedByUserId,
      originRequestId: input.originRequestId ?? '',
      publishedByUserId: input.publishedByUserId,
      ...(input.setCurrent !== undefined ? { setCurrent: input.setCurrent } : {}),
    });
    return { version, reused: published.reused, publishedPath: published.publishedPath };
  } finally {
    await fsp.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * 从用户**已发布**的版本复制字节发布到 org 层（design §5.3 的批准路径）。
 *
 * 三点是这个函数的全部意义：
 * - 复制源是作者的**已发布版本**，不是草稿——草稿归作者所有，模型可写，批准一个
 *   会变的目录等于批准一个移动目标；
 * - 复制后**重算摘要**并与申请时钉住的摘要比对，不等即拒绝（design §5.3 原话）；
 * - 不等时**不改申请状态**，把两个摘要都带回去，让人能判断是「作者改过」还是
 *   「申请时看错了」。
 */
export async function publishOrgSkillFromPublishedVersion(
  deps: OrgSkillPublishDeps & {
    /** 读作者已发布版本的字节目录；由调用方注入（需要 owner 根与核对）。 */
    resolvePublishedPackageDir(input: {
      requesterUserId: string;
      name: string;
      contentDigest: string;
    }): Promise<{ readonly packageDir: string } | null>;
  },
  input: {
    readonly orgId: string;
    readonly requesterUserId: string;
    readonly name: string;
    readonly contentDigest: string;
    readonly originRequestId: string;
    readonly publishedByUserId: string;
    readonly setCurrent?: boolean;
    /**
     * 批准的是谁的申请就传谁：`publishVersion` 在名字锁内判定来源一致，
     * 两位作者同名申请被同时批准时第二个被拒（`SKILL_ORG_NAME_TAKEN`）。
     */
    readonly expectedOriginUserId?: string;
  },
): Promise<PublishOrgSkillResult> {
  const resolved = await deps.resolvePublishedPackageDir({
    requesterUserId: input.requesterUserId,
    name: input.name,
    contentDigest: input.contentDigest,
  });
  if (!resolved) {
    throw new OrgSkillPublishError(
      `requester has no published version ${input.contentDigest} of "${input.name}"`,
      'SKILL_SHARE_SOURCE_MISSING',
    );
  }
  const orgRoot = orgSkillRootFor({ orgId: input.orgId }, deps.publishedBase);
  const systemNames = await deps.systemSkillNames();
  const published = await publishDraftVersion({
    draftPackageDir: resolved.packageDir,
    publishedRoot: orgRoot,
    expectedName: input.name,
    systemSkillNames: systemNames,
    ...(deps.now ? { now: deps.now } : {}),
  });
  if (published.contentDigest !== input.contentDigest) {
    // 复制出来的字节与申请时钉住的不是同一份：拒绝，保持申请 pending，
    // 并把两个摘要都带回去。
    throw new OrgSkillPublishError(
      `digest mismatch: the request pinned ${input.contentDigest} but the published copy hashes to ${published.contentDigest}`,
      'SKILL_SHARE_DIGEST_MISMATCH',
    );
  }
  const version = await deps.orgSkills.publishVersion({
    orgId: input.orgId,
    name: published.name,
    contentDigest: published.contentDigest,
    fileCount: published.fileCount,
    totalBytes: published.totalBytes,
    description: published.description,
    originKind: 'share_request',
    originUserId: input.requesterUserId,
    originRequestId: input.originRequestId,
    publishedByUserId: input.publishedByUserId,
    ...(input.setCurrent !== undefined ? { setCurrent: input.setCurrent } : {}),
    ...(input.expectedOriginUserId !== undefined
      ? { expectedOriginUserId: input.expectedOriginUserId }
      : {}),
  });
  return { version, reused: published.reused, publishedPath: published.publishedPath };
}
