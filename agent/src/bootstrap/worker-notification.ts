/**
 * agent-worker 里的 Run 终态邮件通知循环（design T12）。
 *
 * 装配放在这里而不是 container.ts（行数预算）。启动在 schema 核对、深度闸门之后
 * （由 worker-main 的调用位置保证）；停机时由 worker-drain 的 stopBackground 等它
 * 跑完当前这一批。
 *
 * 能力关闭时循环照样跑：认领并结清终态通知行，不让它们在 domain_outbox 里堆积。
 */

import { OutboxRepository } from '../infrastructure/outbox/outbox-repository.js';
import { resolveEmailNotificationConfig } from '../infrastructure/notification/email-config.js';
import { NotificationStore } from '../infrastructure/notification/notification-store.js';
import { NotificationPublisher } from '../infrastructure/notification/notification-publisher.js';
import { createSmtpMailer } from '../infrastructure/notification/smtp-mailer.js';

export function startNotificationLoop(opts: {
  knex: any;
  env: NodeJS.ProcessEnv;
  generateId: () => string;
  now?: () => Date;
  log?: (level: 'info' | 'error', message: string) => void;
}) {
  const log = opts.log ?? ((level, message) =>
    (level === 'error' ? console.error : console.log)(`[agent-worker] ${message}`));
  const config = resolveEmailNotificationConfig(opts.env);
  log(
    'info',
    'reason' in config
      ? `run completion email disabled: ${config.reason}`
      : `run completion email enabled min_duration_ms=${config.minRunDurationMs}`,
  );

  const publisher = new NotificationPublisher({
    outbox: new OutboxRepository(opts.knex, { now: opts.now }),
    store: new NotificationStore(opts.knex, { now: opts.now }),
    mailer: config.enabled ? createSmtpMailer(config) : null,
    config,
    generateId: opts.generateId,
    log: (message) => log('info', message),
  });

  const idleMs = Number(opts.env.AGENT_NOTIFICATION_IDLE_MS) || 2_000;
  const abort = new AbortController();
  const loop = (async () => {
    while (!abort.signal.aborted) {
      let claimed = 0;
      try {
        ({ claimed } = await publisher.publishOnce());
      } catch (err) {
        if (abort.signal.aborted) break;
        log('error', `notification tick failed: ${err instanceof Error ? err.message : 'error'}`);
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
    enabled: config.enabled,
    async stop() {
      abort.abort();
      await loop.catch(() => {});
    },
  };
}
