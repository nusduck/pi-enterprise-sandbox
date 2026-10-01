/**
 * `ReviewService` 的装配（design `agent-output-review.md` §6/§7）。
 *
 * 单独成模块而不是写在 `container.ts` 里：`container.ts` 是**行数棘轮**盯着的热点
 * （`tests/test_repository_layout.py` 的预算只能减不能增）。审核面是新增职责，
 * 按 RBAC 一期 `member-role-wiring.ts` 的同一理由放这里。
 *
 * exec 客户端（`internal-review-http`）的凭据从进程环境读：`SANDBOX_BASE_URL` 与
 * 内部面 HMAC 密钥环。**两者缺失时返回的 service 仍然可用**（列表/详情不碰 exec），
 * 但任何要读字节或上传修订的调用会得到 503 `DEPENDENCY`——这是刻意的：审核面
 * 不能"看得到任务却读不了材料"地半可用。
 */

import { ReviewService } from '../application/review-service.js';
import {
  createInternalReviewTransport,
  type InternalReviewTransport,
} from '../infrastructure/sandbox/internal-review-http.js';
import { readExecRpcFromEnv } from '../runtime/providers/exec-rpc.js';

/** 过渡期宽松类型：容器里的多数依赖还是 JS 类，形状由各自的模块负责。 */
type Loose = any;

export interface ReviewServiceWiring {
  readonly env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  readonly db: Loose;
  readonly createRepositories: (db?: Loose) => Loose;
  readonly transactionManager: { run: <T>(work: (trx: Loose) => Promise<T>) => Promise<T> };
  readonly generateId?: () => string;
  readonly now?: () => Date;
  /** 测试注入缝：给一个现成的 exec 客户端替身。 */
  readonly reviewTransport?: InternalReviewTransport | null;
  readonly fetchImpl?: typeof fetch;
}

/** 从环境装配 exec 审核面客户端；缺凭据返回 `null`（fail-closed，不是降级放行）。 */
export function createReviewTransportFromEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  fetchImpl?: typeof fetch,
): InternalReviewTransport | null {
  let rpc: { baseUrl?: string; keyring?: unknown; activeKid?: string } | null = null;
  try {
    // `readExecRpcFromEnv` 在密钥环缺失时**抛错**（那是给 Run 执行面用的 fail-closed
    // 启动检查）。审核面在 HTTP 进程里是可选的：没有凭据就没有 exec 客户端，
    // 需要字节的调用会得到 503，而不是让整个 HTTP 进程起不来。
    rpc = readExecRpcFromEnv(env as NodeJS.ProcessEnv);
  } catch {
    return null;
  }
  if (!rpc?.baseUrl || !rpc?.keyring || !rpc?.activeKid) return null;
  return createInternalReviewTransport({
    baseUrl: rpc.baseUrl,
    keyring: rpc.keyring,
    activeKid: rpc.activeKid,
    // 与既有两个 exec 传输（sessions/ensure、artifacts/download）同一口径：compose 里
    // 的 sandbox 是内网明文 HTTP，`http://sandbox:8081` 不是字面 loopback。漏传这一项
    // 会在启动期抛 `http baseUrl rejected unless loopback or allowInsecureHttp=true`，
    // 让整个 agent HTTP 进程起不来（2026-10-01 真机重建时踩到过）。
    allowInsecureHttp: true,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

export function createReviewService(input: ReviewServiceWiring): ReviewService {
  const transport = input.reviewTransport !== undefined
    ? input.reviewTransport
    : createReviewTransportFromEnv(input.env, input.fetchImpl);
  return new ReviewService({
    db: input.db,
    createRepositories: input.createRepositories,
    transactionManager: input.transactionManager,
    generateId: input.generateId,
    now: input.now,
    reviewTransport: transport ?? null,
  });
}
