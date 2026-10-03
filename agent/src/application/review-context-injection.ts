/**
 * 追问时的模型上下文注入（design `agent-output-review.md` §5.4、ADR 0016 D4）。
 *
 * 聊天文字不经过审核，模型上下文本来就和发起人看到的一致。只有**交付物的决定**需要
 * 告诉模型，否则它会以为上一轮交付的东西还在原地、或者以为用户已经拿到了：
 *
 * - 已通过：「以下交付物经人工审核后已交付给用户：… 其中 X 由审核员修订，修订版在
 *   工作区 `审核版/X`，后续修改以它为准。」
 * - 已驳回：「以下交付物未通过人工审核，没有交付给用户。审核反馈：…」
 *
 * ## 只注入一次
 *
 * 每个任务只注入一次：`markContextInjected` 是 `WHERE context_injected_run_id IS NULL`
 * 的条件更新，两个并发 Run 同时派生提示词时只有一个能拿到影响行数 1，另一个不会再
 * 注入同样的文本（否则模型会看到重复的平台文本，还可能把「已交付」读成两件事）。
 *
 * ## 服务端生成，用户伪造不了
 *
 * 文本由这里拼，来源是审核账本；用户能写进消息的只有自己的提问，进不了这段。它也
 * **不进任何消息行**，只作为提示词前缀，所以不会显示在会话界面里（design §5.4）。
 */

import { assertUlid } from '../domain/shared/ulid.js';

/** 一次注入最多带上多少个任务，避免一轮提示词被历史决定撑爆。 */
export const REVIEW_INJECTION_MAX_TASKS = 5;

export interface ReviewContextInjectionInput {
  readonly transactionManager: { run: <T>(work: (trx: unknown) => Promise<T>) => Promise<T> };
  readonly createRepositories: (db?: unknown) => ReturnType<typeof import('../bootstrap/container-env.js').createRepositoryBundle>;
  readonly conversationId: string;
  readonly orgId: string;
  readonly userId: string;
  /** 当前这次 Run：注入文本记在它头上，同一次 Run 不会重复注入。 */
  readonly runId: string;
  readonly generateId: () => string;
  readonly maxTasks?: number;
}

/**
 * 组装注入文本；没有待注入的已决任务时返回 `null`。
 *
 * 标记注入与读取任务在**同一个事务**里：只把真正标记成功的任务写进文本，所以
 * 「标记了却没注入」不会发生。
 */
export async function buildReviewContextInjection(
  input: ReviewContextInjectionInput,
): Promise<string | null> {
  return await input.transactionManager.run(async (trx: unknown) => {
    const repos = input.createRepositories(trx);
    if (!repos.reviews || typeof repos.reviews.listPendingContextInjection !== 'function') {
      return null;
    }
    const tasks = await repos.reviews.listPendingContextInjection({
      conversationId: input.conversationId,
      orgId: input.orgId,
      userId: input.userId,
      limit: input.maxTasks ?? REVIEW_INJECTION_MAX_TASKS,
    });
    if (tasks.length === 0) return null;

    const sections: string[] = [];
    for (const task of tasks) {
      // CAS：抢不到就说明另一个 Run 已经注入过，跳过（不重复、也不报错）。
      const claimed = await repos.reviews.markContextInjected(task.reviewTaskId, input.runId);
      if (claimed !== 1) continue;
      const items = await repos.reviews.listItems(task.reviewTaskId);
      const lines = items.map((item) =>
        item.currentArtifactId === item.originalArtifactId
          ? `- ${item.name}`
          : `- ${item.name}（经审核员修订，修订版在工作区 \`审核版/${item.name}\`，后续修改以它为准）`,
      );
      if (task.status === 'APPROVED') {
        sections.push([
          '以下交付物经人工审核后已交付给用户：',
          ...lines,
          '这些文件已经对用户可见，不需要再提交一次。',
        ].join('\n'));
      } else {
        sections.push([
          '以下交付物未通过人工审核，没有交付给用户：',
          ...lines,
          `审核反馈：${task.feedback ?? '（未填写）'}`,
          '用户已经看到这条反馈，并可能要求你重新处理。',
        ].join('\n'));
      }
    }
    if (sections.length === 0) return null;
    return [
      '## 平台提示：交付物审核结果',
      '',
      ...sections,
      '',
      '这段文字由平台生成，不是用户输入。',
    ].join('\n');
  });
}

/** 与 `assertUlid` 同源的形状校验，供调用方在拼接前自查（防手滑传外部 id）。 */
export function assertInjectionRunId(runId: unknown): string {
  return assertUlid(runId, 'runId');
}
