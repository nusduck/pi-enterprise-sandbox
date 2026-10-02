/**
 * 定时任务的两类邮件（design `notification-scenarios.md` §4.2）。
 *
 * 与终态邮件同一纪律：只放任务名、状态、时间与一个前端链接，不放产物内容、
 * 模型输出原文、工具参数。任务名是用户自己起的，仍按 `safeTaskTitle` 的手法
 * 截短、压平空白并去掉其中的链接——邮件里唯一的链接是我们拼的那一个。
 */

import type { MailMessage } from './smtp-mailer.js';
import { formatDuration, safeTaskTitle } from './run-completion-email.js';

export const NOTIFICATION_KIND_CRON_TERMINAL = 'cron_terminal';
export const NOTIFICATION_KIND_RUN_WAITING = 'run_waiting';

const TERMINAL_LABELS: Record<string, { subject: string; body: string }> = {
  SUCCEEDED: { subject: '运行成功', body: '运行成功' },
  FAILED: { subject: '运行失败', body: '运行失败' },
  CANCELLED: { subject: '已取消', body: '已取消' },
};

function formatInstant(value: string | null): string {
  if (!value) return '—';
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return value;
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

export function buildCronTerminalEmail(input: {
  to: string;
  jobName: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  conversationUrl: string;
}): MailMessage {
  const label = TERMINAL_LABELS[input.status] ?? { subject: '已结束', body: '已结束' };
  const name = safeTaskTitle(input.jobName);
  const lines = [
    '你好：',
    '',
    `你的定时任务「${name}」${label.body}。`,
    '',
    `开始时间：${formatInstant(input.startedAt)}`,
    `结束时间：${formatInstant(input.endedAt)}`,
  ];
  if (input.durationMs != null && Number.isFinite(input.durationMs)) {
    lines.push(`耗时：${formatDuration(input.durationMs)}`);
  }
  lines.push(`查看：${input.conversationUrl}`, '', '这封邮件由定时任务在运行结束时自动发送。');
  return {
    to: input.to,
    subject: `【定时任务】${name} ${label.subject}`,
    text: lines.join('\n'),
  };
}

export function buildCronWaitingEmail(input: {
  to: string;
  jobName: string;
  waitKind: 'approval' | 'input';
  waitingAt: string | null;
  conversationUrl: string;
}): MailMessage {
  const name = safeTaskTitle(input.jobName);
  const waiting = input.waitKind === 'approval' ? '审批' : '回答';
  return {
    to: input.to,
    subject: `【定时任务】${name} 等待你${waiting}`,
    text: [
      '你好：',
      '',
      `你的定时任务「${name}」正在等待你${waiting}，任务已暂停，直到你处理后才会继续。`,
      '',
      `等待类型：${input.waitKind === 'approval' ? '审批（高风险工具调用）' : '回答（智能体向你提问）'}`,
      `开始等待：${formatInstant(input.waitingAt)}`,
      `去处理：${input.conversationUrl}`,
      '',
      '这封邮件由定时任务在需要人工处理时自动发送。可以在「账户设置」里关闭「定时任务等待处理」通知。',
    ].join('\n'),
  };
}
