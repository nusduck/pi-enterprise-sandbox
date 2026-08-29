/**
 * 归属校验——移植自 Python 版 `sandbox/services/process_owner_access.py`
 * 的核心不变量："不是你的"和"不存在"必须是同一个答案。
 *
 * 这是什么：一个薄封装，不是新逻辑。真正的 owner 过滤已经在
 * `JobStore.getById()` 里做了（查询条件里就带 org/user/workspace），
 * 这个文件只负责把"查不到"统一成一个语义清晰的错误类型，供
 * `job-registry.ts` 的每个 owner-scoped 方法复用，避免每个方法各自拼一句
 * "not found or not yours" 的错误文本、格式各不相同。
 *
 * 为什么单独开一个文件而不是散在 `job-registry.ts` 里：这条不变量是安全
 * 边界（Python 版注释原话："Not-yours and not-there are deliberately the
 * same answer"），值得有一个不会被裹进其它逻辑、一眼能看到全貌的地方。
 */
import type { JobOwnerScope, JobRecord, JobStore } from './job-types.js';

/**
 * 作业不存在，或者存在但不属于调用者——两种情况在这里永远无法区分，
 * 这是故意的：区分开会向调用者泄漏"这个 id 其实存在，只是不是你的"，
 * 那是一次信息泄漏（id 空间可预测时尤其危险，参见上游 `dsh-jobs` README
 * "Ids such as bash-1 are predictable, so this fence is the boundary"）。
 */
export class JobNotFoundError extends Error {
  readonly code = 'JOB_NOT_FOUND' as const;
  constructor(id: string) {
    super(`job not found: ${id}`);
    this.name = 'JobNotFoundError';
  }
}

/**
 * 作业存在、属于调用者，但这个 Worker 进程里没有它的活句柄——最常见的
 *原因是 Worker 在它还是非终态时重启过。信号/stdin 写入这类需要活句柄的
 * 操作在这种情况下必须拒绝，绝不能拿存档里的 pid/元数据裸操作
 * （对齐 Python 版 `signal_process_owned`/`write_stdin_owned` 的同一条注释：
 * "No live Popen/start identity is available after restart. Never signal a
 * PID using processId/formal metadata alone."）。
 *
 * 注意这**不是**孤儿回收的路径——非终态作业在 Worker 重启后会被
 * `recoverOrphans()` 在服务接受任何用户请求之前就地终结并标记终态
 * （见 `job-registry.ts`），所以这个错误理论上只应该出现在
 * `recoverOrphans()` 完成之前的极短窗口，或者调用方在同一进程内对一个
 * 已经被清理掉活句柄的作业发起控制类操作的竞态场景。
 */
export class JobControlUnavailableError extends Error {
  readonly code = 'JOB_CONTROL_UNAVAILABLE' as const;
  constructor(id: string) {
    super(`job ${id} has no live process handle in this worker`);
    this.name = 'JobControlUnavailableError';
  }
}

/** 读取一条记录，owner 不匹配或不存在时统一抛 {@link JobNotFoundError}。 */
export async function requireOwnedRecord(
  store: JobStore,
  id: string,
  owner: JobOwnerScope,
): Promise<JobRecord> {
  const record = await store.getById(id, owner);
  if (record === null) {
    throw new JobNotFoundError(id);
  }
  return record;
}
