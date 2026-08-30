#!/usr/bin/env node
/**
 * CLI: `npm run migrate:latest|migrate:rollback|migrate:rollback-all|migrate:status`
 *
 * 开发期经 tsx 运行（本文件是 TS，plain node 读不了）；容器里跑的是编译产物
 * `dist/src/infrastructure/mysql/cli-migrate.js`，见 docker-compose 的
 * agent-migrate 服务。
 *
 * Requires knex + mysql2 installed and AGENT_DATABASE_URL or TEST_MYSQL_URL.
 */

import {
  createMysqlKnex,
  destroyMysqlKnex,
} from './client.js';
import {
  migrateLatest,
  migrateRollback,
  migrateRollbackAll,
  migrateStatus,
  resolveMysqlUrl,
} from './migrate.js';
import { MysqlConfigError, MysqlDependencyError } from './errors.js';

async function main() {
  const cmd = process.argv[2] || 'latest';
  let knex;
  try {
    const url = resolveMysqlUrl();
    knex = createMysqlKnex(url);
    if (cmd === 'latest' || cmd === 'up') {
      const [batch, files] = await migrateLatest(knex);
      console.log(JSON.stringify({ ok: true, action: 'latest', batch, files }, null, 2));
    } else if (cmd === 'rollback' || cmd === 'down') {
      const [batch, files] = await migrateRollback(knex);
      console.log(JSON.stringify({ ok: true, action: 'rollback', batch, files }, null, 2));
    } else if (cmd === 'rollback-all') {
      const [batch, files] = await migrateRollbackAll(knex);
      console.log(JSON.stringify({ ok: true, action: 'rollback-all', batch, files }, null, 2));
    } else if (cmd === 'status') {
      const list = await migrateStatus(knex);
      console.log(JSON.stringify({ ok: true, action: 'status', list }, null, 2));
    } else {
      console.error(`Unknown command: ${cmd}`);
      process.exitCode = 2;
    }
  } catch (err) {
    if (err instanceof MysqlConfigError || err instanceof MysqlDependencyError) {
      console.error(err.message);
      process.exitCode = 1;
    } else {
      console.error(err);
      process.exitCode = 1;
    }
  } finally {
    await destroyMysqlKnex(knex);
  }
}

main();
