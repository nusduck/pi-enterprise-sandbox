/**
 * agent-worker 里的**审核循环**（design `agent-output-review.md` §5.3 / §6.2 / §4 A3）。
 *
 * 一个循环、两个消费者，与 `worker-notification.ts` 同一形状（装配放这里而不是
 * `container.ts`，那里是行数棘轮热点）：
 *
 * - `ReviewPublisher`：放行/撤回、材料快照、修订版导入（跨服务调用）。
 * - `ReviewNotificationPublisher`：审核结果的邮件通知（复用投递账本）。
 *
 * **能力关闭时循环照样跑**：审核工作队列与终态邮件无关，不能因为没配 SMTP 就
 * 停止放行产物——那会让「任务已通过、产物却永远不放行」。通知消费者在能力关闭时
 * 直接结清行。
 *
 * exec 客户端凭据缺失时**不启动**循环并明确记一条 error：审核面此时没有可用的
 * 传输，继续跑只会把行反复重试到失败。
 */

import { OutboxRepository } from '../infrastructure/outbox/outbox-repository.js';
import { resolveEmailNotificationConfig } from '../infrastructure/notification/email-config.js';
import { NotificationStore } from '../infrastructure/notification/notification-store.js';
import { ReviewNotificationPublisher } from '../infrastructure/notification/review-notification-publisher.js';
import { createSmtpMailer } from '../infrastructure/notification/smtp-mailer.js';
import { ReviewPublisher } from '../infrastructure/review/review-publisher.js';
import { createReviewTransportFromEnv } from './review-wiring.js';

type Loose = any;

export function startReviewLoop(opts: {
  knex: Loose;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  createRepositories: (db?: Loose) => Loose;
  generateId: () => string;
  now?: () => Date;
  log?: (level: 'info' | 'error', message: string) => void;
}) {
  const log = opts.log ?? ((level, message) =>
    (level === 'error' ? console.error : console.log)(`[agent-worker] ${message}`));
  const transport = createReviewTransportFromEnv(opts.env);
  if (!transport) {
    log('error', 'review loop disabled: SANDBOX_BASE_URL / internal HMAC keyring is not configured');
    return {
      enabled: false,
      async stop() { /* nothing to stop */ },
    };
  }

  const outbox = new OutboxRepository(opts.knex, { now: opts.now });
  const jobs = new ReviewPublisher({
    outbox,
    createRepositories: opts.createRepositories,
    db: opts.knex,
    transport,
    log: (message) => log('info', message),
  });

  const config = resolveEmailNotificationConfig(opts.env as NodeJS.ProcessEnv);
  const notifications = new ReviewNotificationPublisher({
    outbox,
    store: new NotificationStore(opts.knex, { now: opts.now }),
    createRepositories: opts.createRepositories,
    db: opts.knex,
    mailer: config.enabled ? createSmtpMailer(config) : null,
    config,
    generateId: opts.generateId,
    log: (message) => log('info', message),
  });

  const idleMs = Number((opts.env as Record<string, string | undefined>)['AGENT_NOTIFICATION_IDLE_MS']) || 2_000;
  const abort = new AbortController();
  const loop = (async () => {
    while (!abort.signal.aborted) {
      let claimed = 0;
      try {
        // 两个消费者互不认领（不同的 aggregate_type），一个 tick 里都推一次。
        const jobResult = await jobs.publishOnce();
        const noteResult = await notifications.publishOnce();
        claimed = jobResult.claimed + noteResult.claimed;
      } catch (err) {
        if (abort.signal.aborted) break;
        log('error', `review tick failed: ${err instanceof Error ? err.message : 'error'}`);
      }
      if (claimed > 0) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, idleMs);
        abort.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
  })();

  return {
    enabled: true,
    async stop() {
      abort.abort();
      await loop.catch(() => {});
    },
  };
}
