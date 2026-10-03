/**
 * `MemberRoleService` 的装配。
 *
 * 单独成模块而不是写在 `container.ts` 里：`container.ts` 是**行数棘轮**盯着的热点
 * （`tests/test_repository_layout.py` 把它的预算钉在现有行数，只能减不能增，AGENTS.md
 * §7）。角色服务的装配是新增职责，按 design §11「新逻辑按职责拆到新模块」放在这里。
 *
 * 部署锁定名单取自**当前进程环境**的 `SANDBOX_AUTH_ADMIN_USERNAMES`：从名单里移除
 * 某人并重启后，他的授予还在库里，但界面解除锁定、可以撤销（design §3.3 / §9）。
 */

import type { Knex } from 'knex';
import { MemberRoleService } from '../application/member-role-service.js';

type DbExecutor = Knex | Knex.Transaction;
// 仓储工厂的形状以消费方 MemberRoleService 的构造签名为准。
type RepositoryFactory = ConstructorParameters<typeof MemberRoleService>[0]['createRepositories'];
type TransactionRunner = { run: <T>(work: (trx: Knex.Transaction) => Promise<T>) => Promise<T> };

export interface MemberRoleServiceWiring {
  readonly env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  readonly db: DbExecutor;
  readonly createRepositories: RepositoryFactory;
  readonly transactionManager: TransactionRunner;
  readonly generateId?: () => string;
}

export function createMemberRoleService(input: MemberRoleServiceWiring): MemberRoleService {
  return new MemberRoleService({
    db: input.db,
    createRepositories: input.createRepositories,
    transactionManager: input.transactionManager,
    pinnedAdminUsernames: String(input.env.SANDBOX_AUTH_ADMIN_USERNAMES || '').split(','),
    generateId: input.generateId,
  });
}
