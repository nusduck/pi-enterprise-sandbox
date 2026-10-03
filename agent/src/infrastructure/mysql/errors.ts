/**
 * Explicit MySQL infrastructure errors (no silent SQLite/memory fallback).
 */

export class MysqlConfigError extends Error {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  code: string;

  constructor(message: string) {
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
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  orphanTables: string[];
  missingMigrations: string[];

  constructor(message: string, meta: { orphanTables?: string[], missingMigrations?: string[] } = {}) {
    super(message);
    this.name = 'MysqlOrphanSchemaError';
    this.code = 'MYSQL_ORPHAN_SCHEMA';
    this.orphanTables = meta.orphanTables ?? [];
    this.missingMigrations = meta.missingMigrations ?? [];
  }
}

export class MysqlDependencyError extends Error {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  code: string;

  constructor(message: string, opts: { cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'MysqlDependencyError';
    this.code = 'MYSQL_DEPENDENCY_ERROR';
  }
}

export class OwnershipError extends Error {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  code: string;
  resource: string | null;
  id: string | null;

  constructor(message: string, meta: { resource?: string, id?: string } = {}) {
    super(message);
    this.name = 'OwnershipError';
    this.code = 'OWNERSHIP_DENIED';
    this.resource = meta.resource ?? null;
    this.id = meta.id ?? null;
  }
}

export class NotFoundError extends Error {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  code: string;
  resource: string | null;
  id: string | null;

  constructor(message: string, meta: { resource?: string, id?: string } = {}) {
    super(message);
    this.name = 'NotFoundError';
    this.code = 'NOT_FOUND';
    this.resource = meta.resource ?? null;
    this.id = meta.id ?? null;
  }
}

export class ConflictError extends Error {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  code: string;
  resource: string | null;
  id: string | null;

  constructor(message: string, meta: { resource?: string, id?: string } = {}) {
    super(message);
    this.name = 'ConflictError';
    this.code = 'CONFLICT';
    this.resource = meta.resource ?? null;
    this.id = meta.id ?? null;
  }
}

export class SequenceAllocationError extends Error {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  code: string;
  runId: string | null;

  constructor(message: string, meta: { runId?: string } = {}) {
    super(message);
    this.name = 'SequenceAllocationError';
    this.code = 'SEQUENCE_ALLOCATION_FAILED';
    this.runId = meta.runId ?? null;
  }
}
