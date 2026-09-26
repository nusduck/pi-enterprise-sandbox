/**
 * 数据源服务（design `sandbox-data-sources.md` §4）：目录 + 启动期取密 + 每次执行的挂载。
 *
 * 一次执行的生命周期：
 *
 *   open(ids)  → 校验清单 → 建 `<socketRoot>/<随机>/<id>/mysql.sock` 并监听
 *              → 返回挂载（bwrap 只读绑定到 `/run/dsh-db/<id>`）与注入的环境变量
 *   close()    → 停止监听、断开在途连接、删除目录（幂等；每条出口都要调）
 *
 * 口令只在进程内存里：不写 `process.env`、不落盘、不打印。
 */

import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { ContractError } from '@dsh/contract/errors.js';
import { fetchDbpmPassword } from '@dsh/contract/dbpm.js';
import { readDbpmSettings } from '@dsh/contract/dbpm-config.js';
import {
  DATA_SOURCE_MOUNT_ROOT,
  dataSourceEnvPrefix,
} from '@dsh/contract/data-sources.js';
import type { DataSourceMount } from '../types.js';
import { DataSourceConfigError, type DataSourceConfig } from './catalog.js';
import {
  DEFAULT_FORWARDER_LIMITS,
  ExecutionForwarder,
  SourceConnectionCounter,
  type ConnectionAuditSink,
  type ExecutionAudit,
  type ForwarderLimits,
} from './forwarder.js';

const SOCKET_NAME = 'mysql.sock';
/** Linux `sockaddr_un.sun_path` 108 字节，含结尾 NUL。 */
const MAX_SOCKET_PATH_BYTES = 107;
/** 执行目录名：12 位 hex，够短，给 socket 路径长度留余量。 */
const EXECUTION_DIR_BYTES = 6;
const LONGEST_ID = 32;

/** 一次执行打开的数据源。 */
export interface DataSourceSession {
  readonly mounts: readonly DataSourceMount[];
  close(): Promise<void>;
}

const EMPTY_SESSION: DataSourceSession = Object.freeze({
  mounts: Object.freeze([]) as readonly DataSourceMount[],
  close: async () => undefined,
});

export interface DataSourceServiceOptions {
  readonly catalog: readonly DataSourceConfig[];
  /** id → 口令；不在其中的数据源视为不可用。 */
  readonly passwords: ReadonlyMap<string, string>;
  /** 每次执行的 socket 目录建在这里（控制面，不在任何工作区之下）。 */
  readonly socketRoot: string;
  readonly limits?: ForwarderLimits;
  readonly audit?: ConnectionAuditSink;
}

export class DataSourceService {
  private readonly byId: ReadonlyMap<string, DataSourceConfig>;
  private readonly counter = new SourceConnectionCounter();
  private readonly limits: ForwarderLimits;
  private readonly sink: ConnectionAuditSink;

  constructor(private readonly opts: DataSourceServiceOptions) {
    this.byId = new Map(opts.catalog.map((cfg) => [cfg.id, cfg]));
    this.limits = opts.limits ?? DEFAULT_FORWARDER_LIMITS;
    this.sink = opts.audit ?? ((record) => process.stdout.write(`${JSON.stringify(record)}\n`));
    const longest = path.join(opts.socketRoot, 'x'.repeat(EXECUTION_DIR_BYTES * 2), 'x'.repeat(LONGEST_ID), SOCKET_NAME);
    if (opts.catalog.length > 0 && Buffer.byteLength(longest) > MAX_SOCKET_PATH_BYTES) {
      throw new DataSourceConfigError(
        `data source socket root is too long for unix socket paths (${Buffer.byteLength(longest)} > ${MAX_SOCKET_PATH_BYTES} bytes)`,
      );
    }
  }

  get configured(): boolean {
    return this.byId.size > 0;
  }

  /**
   * 为一次执行打开清单里的数据源。清单为空时不建任何东西。
   * 未登记 → `DATA_SOURCE_UNKNOWN`；已登记但无口令或建不起 socket → `DATA_SOURCE_UNAVAILABLE`。
   * 这两种都在 spawn 之前抛出：宁可不执行，也不让模型以为库不存在。
   */
  async open(ids: readonly string[], audit: ExecutionAudit): Promise<DataSourceSession> {
    if (ids.length === 0) return EMPTY_SESSION;
    const targets = ids.map((id) => {
      const cfg = this.byId.get(id);
      if (cfg === undefined) throw new ContractError('DATA_SOURCE_UNKNOWN', `data source is not configured: ${id}`);
      const password = this.opts.passwords.get(id);
      if (password === undefined) {
        throw new ContractError('DATA_SOURCE_UNAVAILABLE', `data source is unavailable: ${id}`);
      }
      return { cfg, password };
    });

    const dir = path.join(this.opts.socketRoot, randomBytes(EXECUTION_DIR_BYTES).toString('hex'));
    const forwarder = new ExecutionForwarder(this.limits, this.counter, audit, this.sink);
    let closed = false;
    // 不抛：它挂在后台作业的 `done` 上，而 `done` 按约定不 reject。清理失败只告警，
    // 残留目录由下次启动的 `removeStaleSockets()` 收口。
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      try {
        await forwarder.close();
        await rm(dir, { recursive: true, force: true });
      } catch {
        process.stderr.write('exec WARNING: data source socket cleanup failed\n');
      }
    };
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const mounts: DataSourceMount[] = [];
      for (const { cfg, password } of targets) {
        const hostDir = path.join(dir, cfg.id);
        await mkdir(hostDir, { mode: 0o700 });
        await forwarder.listen(path.join(hostDir, SOCKET_NAME), cfg);
        mounts.push(Object.freeze({ id: cfg.id, hostDir, env: envFor(cfg, password), secret: password }));
      }
      return { mounts: Object.freeze(mounts), close };
    } catch (err) {
      await close().catch(() => undefined);
      if (err instanceof ContractError) throw err;
      throw new ContractError('DATA_SOURCE_UNAVAILABLE', 'data source forwarding could not be set up');
    }
  }

  /** 启动期清掉上一轮进程留下的 socket 目录（进程被杀时 close 没机会跑）。 */
  async removeStaleSockets(): Promise<void> {
    await rm(this.opts.socketRoot, { recursive: true, force: true });
    if (this.configured) await mkdir(this.opts.socketRoot, { recursive: true, mode: 0o700 });
  }
}

function envFor(cfg: DataSourceConfig, password: string): Readonly<Record<string, string>> {
  const prefix = dataSourceEnvPrefix(cfg.id);
  return Object.freeze({
    [`${prefix}ENGINE`]: cfg.engine,
    [`${prefix}SOCKET`]: `${DATA_SOURCE_MOUNT_ROOT}/${cfg.id}/${SOCKET_NAME}`,
    [`${prefix}DATABASE`]: cfg.database,
    [`${prefix}USER`]: cfg.userName,
    [`${prefix}PASSWORD`]: password,
  });
}

export interface FetchDataSourcePasswordsOptions {
  /** 仅测试：替换单次取密实现。 */
  readonly fetchPassword?: typeof fetchDbpmPassword;
  readonly log?: (line: string) => void;
}

/**
 * 启动时逐个向 DBPM 取口令。单个数据源失败只让它不可用，不阻止 exec 启动——平台本身
 * 不依赖业务库；失败原因只记类别，不记条目以外的信息。
 */
export async function fetchDataSourcePasswords(
  catalog: readonly DataSourceConfig[],
  env: Readonly<Record<string, string | undefined>>,
  opts: FetchDataSourcePasswordsOptions = {},
): Promise<ReadonlyMap<string, string>> {
  const passwords = new Map<string, string>();
  if (catalog.length === 0) return passwords;
  // 端点配置错是部署错误：抛出，由 main.ts 拒绝启动。
  const { endpoints } = readDbpmSettings(env, []);
  const fetchPassword = opts.fetchPassword ?? fetchDbpmPassword;
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  for (const cfg of catalog) {
    try {
      const password = await fetchPassword(
        endpoints,
        { dbName: cfg.dbpmDbName, userName: cfg.userName },
        { role: `exec-data-source-${cfg.id}` },
      );
      passwords.set(cfg.id, password);
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      log(`exec WARNING: data source ${cfg.id} is unavailable (DBPM ${typeof code === 'string' ? code : 'error'})`);
    }
  }
  return passwords;
}
