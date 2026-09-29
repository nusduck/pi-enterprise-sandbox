/**
 * 长任务完成邮件的正文（design T11）。
 *
 * 只有：任务标题、结束状态、耗时、前端链接。不放产物、模型回答、工具参数。
 * 会话标题可能是模型按首条提问生成的，所以截短、压平空白并去掉其中的链接——
 * 邮件里唯一的链接是我们拼的那一个，进入后照常走登录与租户校验。
 */

import type { MailMessage } from './smtp-mailer.js';

const STATUS_LABELS: Record<string, { subject: string; body: string }> = {
  SUCCEEDED: { subject: '已完成', body: '已完成' },
  FAILED: { subject: '失败', body: '运行失败' },
  CANCELLED: { subject: '已取消', body: '已取消' },
};

const MAX_TITLE_CHARS = 80;

export function safeTaskTitle(title: string | null | undefined) {
  const cleaned = String(title ?? '')
    .replace(/\b(?:https?|ftp):\/\/\S+/gi, '…')
    .replace(/\bwww\.\S+/gi, '…')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '未命名任务';
  const chars = Array.from(cleaned);
  return chars.length > MAX_TITLE_CHARS ? `${chars.slice(0, MAX_TITLE_CHARS - 1).join('')}…` : cleaned;
}

export function formatDuration(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}

export function buildRunCompletionEmail(input: {
  to: string;
  status: string;
  title: string | null;
  displayName: string | null;
  durationMs: number;
  conversationUrl: string;
}): MailMessage {
  const label = STATUS_LABELS[input.status] ?? { subject: '已结束', body: '已结束' };
  const title = safeTaskTitle(input.title);
  const greeting = input.displayName ? `${safeTaskTitle(input.displayName)}，你好：` : '你好：';
  return {
    to: input.to,
    subject: `[任务${label.subject}] ${title}`,
    text: [
      greeting,
      '',
      `你发起的任务「${title}」${label.body}。`,
      '',
      `耗时：${formatDuration(input.durationMs)}`,
      `查看：${input.conversationUrl}`,
      '',
      '这封邮件在任务结束时自动发送。可以在「账户设置」里关闭「长任务完成邮件通知」。',
    ].join('\n'),
  };
}
