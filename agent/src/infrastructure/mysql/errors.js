/**
 * Explicit MySQL infrastructure errors (no silent SQLite/memory fallback).
 */

export class MysqlConfigError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'MysqlConfigError';
    this.code = 'MYSQL_CONFIG_ERROR';
  }
}

/**
 * Residual half-migration / orphan schema (MySQL non-transactional DDL).
 * Fail closed — operators must follow the recovery runbook.
 */
export class MysqlOrphanSchemaError extends MysqlConfigError {
  /**
   * @param {string} message
   * @param {{ orphanTables?: string[], missingMigrations?: string[] }} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'MysqlOrphanSchemaError';
    this.code = 'MYSQL_ORPHAN_SCHEMA';
    this.orphanTables = meta.orphanTables ?? [];
    this.missingMigrations = meta.missingMigrations ?? [];
  }
}

export class MysqlDependencyError extends Error {
  /**
   * @param {string} message
   * @param {{ cause?: unknown }} [opts]
   */
  constructor(message, opts = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'MysqlDependencyError';
    this.code = 'MYSQL_DEPENDENCY_ERROR';
  }
}

export class OwnershipError extends Error {
  /**
   * @param {string} message
   * @param {{ resource?: string, id?: string }} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'OwnershipError';
    this.code = 'OWNERSHIP_DENIED';
    this.resource = meta.resource ?? null;
    this.id = meta.id ?? null;
  }
}

export class NotFoundError extends Error {
  /**
   * @param {string} message
   * @param {{ resource?: string, id?: string }} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'NotFoundError';
    this.code = 'NOT_FOUND';
    this.resource = meta.resource ?? null;
    this.id = meta.id ?? null;
  }
}

export class ConflictError extends Error {
  /**
   * @param {string} message
   * @param {{ resource?: string, id?: string }} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'ConflictError';
    this.code = 'CONFLICT';
    this.resource = meta.resource ?? null;
    this.id = meta.id ?? null;
  }
}

export class SequenceAllocationError extends Error {
  /**
   * @param {string} message
   * @param {{ runId?: string }} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'SequenceAllocationError';
    this.code = 'SEQUENCE_ALLOCATION_FAILED';
    this.runId = meta.runId ?? null;
  }
}
