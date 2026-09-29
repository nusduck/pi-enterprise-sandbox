/**
 * SMTP 发信（nodemailer）。每封信一条连接：通知量是「每个结束的长任务一封」，
 * 不值得维护连接池，也省掉池里连接挂死的恢复逻辑。
 *
 * 所有出站调用有界（AGENTS.md §2）：连接、问候、套接字三段各自超时，外面再套一层
 * 总期限，到期关掉传输并以瞬时错误返回。
 */

import nodemailer from 'nodemailer';

export type MailMessage = { to: string; subject: string; text: string };

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** 重试也不会成功的错误：收件地址被拒、信件被拒。 */
export class PermanentMailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentMailError';
  }
}

export function isPermanentMailError(err: unknown): boolean {
  if (err instanceof PermanentMailError) return true;
  const e = err as { responseCode?: unknown; code?: unknown } | null;
  if (!e || typeof e !== 'object') return false;
  // 认证失败（535）是部署问题，修好配置后应能补发，按瞬时处理交给退避重试。
  if (e.code === 'EAUTH') return false;
  if (e.code === 'EENVELOPE') return true;
  const status = Number(e.responseCode);
  return Number.isInteger(status) && status >= 500 && status < 600;
}

export function createSmtpMailer(config: {
  smtp: { host: string; port: number; secure: boolean; auth: { user: string; pass: string } | null };
  from: string;
  timeoutMs: number;
}): Mailer {
  return {
    async send(message) {
      const transport = nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        ...(config.smtp.auth ? { auth: config.smtp.auth } : {}),
        connectionTimeout: config.timeoutMs,
        greetingTimeout: config.timeoutMs,
        socketTimeout: config.timeoutMs,
      });
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`SMTP send exceeded ${config.timeoutMs}ms`));
        }, config.timeoutMs);
      });
      try {
        await Promise.race([
          transport.sendMail({
            from: config.from,
            to: message.to,
            subject: message.subject,
            text: message.text,
          }),
          deadline,
        ]);
      } finally {
        clearTimeout(timer);
        transport.close();
      }
    },
  };
}
