/** Keep the upstream job tools' schemas, rendering, notices and wake budget, but
 * replace their synchronous executions with awaited exec-backed operations. */
import type { Context } from '@deepseek-ai/cordis';
import type { JobId, JobSnapshot } from '@deepseek-ai/dsh-jobs';
import { apply as applyUpstream } from '@deepseek-ai/dsh-tool-jobs';
import type { Config } from '@deepseek-ai/dsh-tool-jobs';
import { RemoteJobs } from './remote-jobs.js';

export const name = 'remote-job-tools';
export const inject = ['tools', 'jobs', 'systemPrompt'] as const;

function publicJob(snap: JobSnapshot) {
  return {
    id: snap.id, kind: snap.kind, label: snap.label, status: snap.status,
    ...(snap.detail !== undefined ? { detail: snap.detail } : {}),
    startedAt: snap.startedAt,
    ...(snap.finishedAt !== undefined ? { finishedAt: snap.finishedAt } : {}),
  };
}

function jobId(value: unknown): JobId {
  if (typeof value !== 'string' || value.length === 0) throw new Error('invalid job_id');
  return value as JobId;
}

function retainTail(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const marker = '[output truncated]\n';
  const prefix = Buffer.byteLength(marker) < maxBytes ? marker : '';
  let tail = '';
  let used = Buffer.byteLength(prefix);
  for (const char of [...text].reverse()) {
    const size = Buffer.byteLength(char);
    if (used + size > maxBytes) break;
    tail = char + tail;
    used += size;
  }
  return prefix + tail;
}

export function apply(ctx: Context & Record<string, any>, config: Config = {}): void {
  const jobs = ctx.jobs;
  if (!(jobs instanceof RemoteJobs)) throw new Error('remote-job-tools requires RemoteJobs');
  const tools = ctx.tools;
  const register = tools.register.bind(tools);
  const remoteLimits = new WeakMap<object, number>();
  const interceptedTools = new Proxy(tools, {
    get(target, key) {
      if (key === 'register') return (definition: Record<string, any>) => {
        let execute = definition.execute;
        if (definition.name === 'job_list') {
          execute = async (_args: unknown, exec: { agent: any }) =>
            (await jobs.listAuthoritative(exec.agent)).map(publicJob);
        } else if (definition.name === 'job_output') {
          execute = async (args: { job_id: string; wait?: boolean; timeout_ms?: number }, exec: { agent: any; signal?: AbortSignal }) => {
            const id = jobId(args.job_id);
            if (args.wait === true) {
              const cap = config.maxWaitTimeoutMs ?? 600_000;
              const timeout = Math.min(args.timeout_ms ?? config.waitTimeoutMs ?? 30_000, cap);
              await jobs.wait(id, timeout, exec.agent, exec.signal);
            }
            const read = await jobs.readAuthoritative(id, exec.agent);
            if (read.snapshot.outputLimitBytes !== undefined) {
              remoteLimits.set(exec, read.snapshot.outputLimitBytes);
            }
            return { text: read.text, job: publicJob(read.snapshot) };
          };
        } else if (definition.name === 'job_kill') {
          execute = async (args: { job_id: string; reason?: string }, exec: { agent: any }) => {
            const result = await jobs.killAuthoritative(jobId(args.job_id), exec.agent, args.reason);
            if (result.snapshot.outputLimitBytes !== undefined) {
              remoteLimits.set(exec, result.snapshot.outputLimitBytes);
            }
            return {
              outcome: result.outcome === 'requested' ? 'cancellation-requested' : 'already-finished',
              job: publicJob(result.snapshot),
            };
          };
        }
        const finalizeContent = definition.finalizeContent;
        const boundedFinalize = (exec: object, result: any) => {
          const content = finalizeContent?.(exec, result) ?? result.content;
          const maxBytes = remoteLimits.get(exec);
          remoteLimits.delete(exec);
          if (maxBytes === undefined || content?.length !== 1 || content[0]?.type !== 'text') {
            return content;
          }
          return [{ type: 'text', text: retainTail(content[0].text, maxBytes) }];
        };
        const bounded = definition.name === 'job_output' || definition.name === 'job_kill';
        return register({ ...definition, execute, ...(bounded ? { finalizeContent: boundedFinalize } : {}) } as Parameters<typeof register>[0]);
      };
      return Reflect.get(target, key, target);
    },
  });
  const interceptedContext = new Proxy(ctx, {
    get(target, key) {
      if (key === 'tools') return interceptedTools;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  applyUpstream(interceptedContext as Context, config);
}
