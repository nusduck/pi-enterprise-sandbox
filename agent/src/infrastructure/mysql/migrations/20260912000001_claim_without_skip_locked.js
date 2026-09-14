/**
 * Claim-then-read 抢占所需的列与回读索引（ADR 0011 D3 / design §5）。
 *
 * UPDRDB（UPSQL 5.7 内核）没有 `SKIP LOCKED`，outbox 与 cron 的抢占改为
 * 「条件 UPDATE 打批次 token → 按 token 回读」。两处都需要一个**非唯一**的
 * claim_token 索引：回读发生在同一事务内，走索引避免全表扫描；不能建唯一索引，
 * 因为同一批次的多行共享同一个 token。
 *
 * `cron_jobs.claim_token` 是**事务内批次标记**，不是持久租约：claimDue 的事务
 * 结束前必须清空，因此没有配套的过期回收器。崩溃时整个事务回滚，token 随之消失。
 *
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.alterTable('cron_jobs', (t) => {
    t.specificType('claim_token', 'CHAR(26)').nullable();
  });

  await knex.schema.alterTable('cron_jobs', (t) => {
    t.index(['claim_token'], 'idx_cron_jobs_claim_token');
  });

  await knex.schema.alterTable('domain_outbox', (t) => {
    t.index(['claim_token'], 'idx_outbox_claim_token');
  });
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.alterTable('domain_outbox', (t) => {
    t.dropIndex(['claim_token'], 'idx_outbox_claim_token');
  });

  await knex.schema.alterTable('cron_jobs', (t) => {
    t.dropIndex(['claim_token'], 'idx_cron_jobs_claim_token');
  });

  await knex.schema.alterTable('cron_jobs', (t) => {
    t.dropColumn('claim_token');
  });
}
