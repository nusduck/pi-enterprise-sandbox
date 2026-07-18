/**
 * Agent MySQL infrastructure (PR-02 T1+T2).
 *
 * Platform fact store for Conversation / Message / Run / RunEvent / Session.
 * No SQLite or in-memory fallback.
 */

export {
  createMysqlKnex,
  destroyMysqlKnex,
  assertMysqlConnectionUrl,
  assertMysql2Installed,
  loadKnexModule,
  migrationsDirectory,
} from './client.js';

export {
  migrateLatest,
  migrateRollback,
  migrateRollbackAll,
  migrateStatus,
  migrateLatestFromUrl,
  resolveMysqlUrl,
  runMigrateLatestFromUrl,
} from './migrate.js';

export { TransactionManager } from './transaction-manager.js';

export {
  MysqlConfigError,
  MysqlOrphanSchemaError,
  MysqlDependencyError,
  OwnershipError,
  NotFoundError,
  ConflictError,
  SequenceAllocationError,
} from './errors.js';

export {
  createPartialDdlTracker,
  withPartialDdlCleanup,
  diagnosePrimaryConstraintArg,
} from './migration-partial-ddl.js';

export {
  assertNoOrphanPartialSchema,
  inspectOrphanPartialSchema,
  CORE_MIGRATION_NAME,
  CREATE_TABLE_MIGRATION_SENTINELS,
} from './migrate-orphan-gate.js';

export {
  assertMysqlTriggerMigrationCapability,
  inspectMysqlTriggerMigrationCapability,
  evaluateTriggerMigrationCapability,
  coerceMysqlBool,
  extractFirstRow,
  MysqlTriggerCapabilityError,
  MYSQL_TRIGGER_BINLOG_BLOCKED,
} from './migrate-trigger-preflight.js';

export { requireOwnerScope, applyOwnerScope } from './ownership.js';

export {
  OrganizationRepository,
  ConversationRepository,
  MessageRepository,
  AgentSessionRepository,
  AgentSessionSnapshotRepository,
  RunRepository,
  RunEventRepository,
  parseLastInsertId,
} from './repositories/index.js';

export {
  CORE_TABLES_CREATE_ORDER,
  CORE_TABLES_DROP_ORDER,
  SANDBOX_EXECUTION_DOMAIN_TABLES,
  A2A_TABLES,
} from './schema-tables.js';

export {
  MESSAGES_FORBID_UPDATE_TRIGGER,
  MESSAGES_FORBID_DELETE_TRIGGER,
} from './migrations/20260718000001_core_platform_schema.js';

export {
  SNAPSHOTS_FORBID_UPDATE_TRIGGER,
  SNAPSHOTS_FORBID_DELETE_TRIGGER,
} from './migrations/20260718000006_agent_session_snapshot_fencing.js';
