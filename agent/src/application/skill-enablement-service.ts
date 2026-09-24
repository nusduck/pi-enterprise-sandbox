import { OwnerScopedNotFoundError } from './errors.js';

/** 已发布旧版本的回收宽限期默认值（design §3.3 S1-Q2）：覆盖后台进程与等待审批后续跑。 */
export const DEFAULT_SKILL_VERSION_GC_GRACE_MS = 24 * 60 * 60 * 1000;

/** `SKILL_VERSION_GC_GRACE_MS`：非负整数毫秒；缺省或非法取默认值。 */
export function resolveSkillVersionGcGraceMs(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): number {
  const raw = String(env?.SKILL_VERSION_GC_GRACE_MS ?? '').trim();
  if (raw === '') return DEFAULT_SKILL_VERSION_GC_GRACE_MS;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_SKILL_VERSION_GC_GRACE_MS;
}

type Owner = { orgId: string; userId: string };

interface SkillLedger {
  lockOwner: (owner: Owner) => Promise<boolean>;
  get: (name: string, owner: Owner) => Promise<{ contentDigest: string } | null>;
  upsert: (input: Record<string, any>) => Promise<void>;
  remove: (name: string, owner: Owner) => Promise<void>;
}

interface SkillPublisher {
  enable: (input: { name: string }) => Promise<{ contentDigest: string } & Record<string, any>>;
  disable: (input: { name: string }) => Promise<unknown>;
  collectVersions: (input: { name: string; keepDigests: string[]; graceMs: number }) => Promise<unknown>;
}

/**
 * 启用 / 停用一个用户 Skill（design §3.3 第 4、5 条）。
 *
 * 全部在一个 MySQL 事务里：先锁 owner 的 membership 行，读出事务前的启用行，再写字节
 * 与账本，最后在同一把锁内回收旧版本。账本是启用权威，字节是派生物：
 * - 启用：发布按摘要分版本（同摘要复用），upsert 账本行；
 * - 停用：只删账本行，**不删字节**——仍在运行、清单里点着它的 Run 还在用；
 * - 回收保留「事务前引用的摘要 + 本次写入的摘要」，所以即使事务随后回滚，账本也不会
 *   指向已被删除的字节；commit 前崩溃只留下未被引用的版本目录，由后续回收处理。
 *
 * `transactionManager.run` 遇到锁冲突会整体重试；发布对同一摘要是幂等的。
 */
export async function mutateSkillWithLedger(input: {
  action: 'enable' | 'disable';
  name: string;
  owner: Owner;
  manager: SkillPublisher;
  transactionManager: { run: <T>(work: (trx: any) => Promise<T>) => Promise<T> };
  ledgerFor: (trx: any) => SkillLedger;
  graceMs: number;
}) {
  return input.transactionManager.run(async (trx) => {
    const ledger = input.ledgerFor(trx);
    if (!(await ledger.lockOwner(input.owner))) {
      throw new OwnerScopedNotFoundError('Membership not found', {
        resource: 'organization_memberships',
        id: `${input.owner.orgId}/${input.owner.userId}`,
      });
    }
    const previous = await ledger.get(input.name, input.owner);
    const keepDigests = previous ? [previous.contentDigest] : [];

    if (input.action === 'disable') {
      await input.manager.disable({ name: input.name });
      await ledger.remove(input.name, input.owner);
      await input.manager.collectVersions({ name: input.name, keepDigests, graceMs: input.graceMs });
      return { name: input.name, removed: previous !== null };
    }

    const record = await input.manager.enable({ name: input.name });
    await ledger.upsert({
      ...input.owner,
      ...record,
      enabledByUserId: input.owner.userId,
    });
    await input.manager.collectVersions({
      name: input.name,
      keepDigests: [...keepDigests, record.contentDigest],
      graceMs: input.graceMs,
    });
    return record;
  });
}
