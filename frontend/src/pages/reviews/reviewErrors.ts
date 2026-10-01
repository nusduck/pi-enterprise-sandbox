/**
 * 审核工作台的纯逻辑（design `docs/design/agent-output-review.md` §7 / §8）。
 *
 * 抽出来是为了能直接单测：错误码到中文提示、列表三态、状态标签、版本冲突时该不该
 * 刷新。这些正是「把 409 显示成操作失败」或「加载失败渲染成没有待审任务」会悄悄
 * 写错的地方。
 */
import type { ReviewDetail, ReviewItem, ReviewTask } from '../../shared/api/reviews';

/** 服务端错误码 → 可行动的中文提示；未列出的码用服务端 `error` 文案兜底。 */
export const REVIEW_ERROR_ZH: Record<string, string> = {
  REVIEWER_REQUIRED: '需要审核员权限',
  REVIEW_SELF_FORBIDDEN: '不能审核自己发起的任务',
  REVIEW_NOT_ASSIGNEE: '只有当前领取人可以修订或决定',
  REVIEW_ALREADY_CLAIMED: '这个任务已经被领取',
  REVIEW_VERSION_CONFLICT: '任务已被更新，请刷新后重试',
  REVIEW_ALREADY_DECIDED: '这个任务已经决定了',
  REVIEW_FEEDBACK_REQUIRED: '驳回必须填写反馈',
  REVIEW_FILE_INVALID: '修订文件不合法（可能为空或超过 100 MiB）',
  REVIEW_FILE_TOO_LARGE: '文件超过 100 MiB，暂不支持在审核工作台下载',
  REVIEW_INPUT_INVALID: '请求参数不合法',
  NOT_FOUND: '任务不存在，或不属于本组织',
  AUTH_REQUIRED: '登录已失效，请重新登录',
  DEPENDENCY: '审核服务暂时不可用，请稍后重试',
};

export const REVIEW_STATUS_ZH: Record<string, string> = {
  PENDING: '待领取',
  IN_REVIEW: '审核中',
  APPROVED: '已通过',
  REJECTED: '已驳回',
};

export const REVIEW_EVENT_ZH: Record<string, string> = {
  created: '提交审核',
  claimed: '领取',
  released_claim: '释放领取',
  revised: '上传修订',
  approved: '通过',
  rejected: '驳回',
};

export const RUN_STATUS_ZH: Record<string, string> = {
  SUCCEEDED: '成功',
  FAILED: '失败',
  CANCELLED: '已取消',
};

/** 服务端错误码 → 中文。先认 `code`，再用 `error`，最后兜底。 */
export function reviewErrorMessage(error: unknown): string {
  const candidate = error as { code?: unknown; message?: unknown } | null | undefined;
  const code = typeof candidate?.code === 'string' ? candidate.code : null;
  if (code && REVIEW_ERROR_ZH[code]) return REVIEW_ERROR_ZH[code];
  const raw = candidate?.message;
  const message = typeof raw === 'string' ? raw.trim() : '';
  return message || '操作失败';
}

/**
 * 版本冲突要**刷新**：服务端已经变了，继续拿旧 `base_revision` 重试只会再撞一次。
 * 其余错误保持当前状态（尤其是待上传的文件不能丢）。
 */
export function isVersionConflict(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === 'REVIEW_VERSION_CONFLICT' || code === 'REVIEW_ALREADY_CLAIMED' || code === 'REVIEW_ALREADY_DECIDED';
}

/**
 * 动作失败的统一收口。冲突时先刷新（服务端已经变了），**再**写提示：刷新列表会先清空提示，
 * 顺序反了用户就看不到「任务已被更新」。非冲突错误不刷新，保留现状与草稿。
 */
export async function reportActionFailure(
  error: unknown,
  deps: { refresh: () => Promise<void>; setError: (message: string) => void },
): Promise<void> {
  const message = reviewErrorMessage(error);
  if (isVersionConflict(error)) await deps.refresh();
  deps.setError(message);
}

export type ReviewListState = 'loading' | 'error' | 'empty' | 'ready';

/**
 * 列表三态。**错误优先**：加载失败时哪怕上一份数据是空的、哪怕 `loading` 还是
 * true，也算错误态——绝不允许渲染成「没有待审任务」。
 */
export function reviewListState(input: {
  loading: boolean;
  error: string | null | undefined;
  count: number;
}): ReviewListState {
  if (input.error) return 'error';
  if (input.loading) return 'loading';
  if (!Number.isFinite(input.count) || input.count <= 0) return 'empty';
  return 'ready';
}

export function reviewStatusLabel(status: unknown): string {
  const key = typeof status === 'string' ? status : '';
  return REVIEW_STATUS_ZH[key] || key || '—';
}

export function reviewEventLabel(eventType: unknown): string {
  const key = typeof eventType === 'string' ? eventType : '';
  return REVIEW_EVENT_ZH[key] || key || '—';
}

export function runStatusLabel(status: unknown): string {
  const key = typeof status === 'string' ? status : '';
  return RUN_STATUS_ZH[key] || key || '—';
}

/** 交付物卡片上的三态标签（design §8）：待审 / 已交付 / 未通过。 */
export type DeliveryState = 'pending' | 'released' | 'rejected';

/** 审核工作台里交付物的状态只由**任务状态**决定：通过才算已交付，驳回即未通过，其余都还在审。 */
export function deliveryStateForTask(taskStatus: unknown): DeliveryState {
  if (taskStatus === 'APPROVED') return 'released';
  if (taskStatus === 'REJECTED') return 'rejected';
  return 'pending';
}

export function deliveryStateLabel(state: DeliveryState, revised: boolean): string {
  if (state === 'pending') return '已提交审核';
  if (state === 'rejected') return '未通过审核';
  return revised ? '已交付（经审核员修订）' : '已交付';
}

/** 待上传/待编辑的草稿是否要在刷新后保留（design §8：版本冲突时文件不能丢）。 */
export function keepDraftOnError(error: unknown): boolean {
  return !isVersionConflict(error);
}

/** 详情里当前领取人是不是自己。 */
export function isMyAssignment(
  detail: ReviewDetail | null,
  viewer: { id?: unknown; username?: unknown } | null | undefined,
): boolean {
  const assignee = detail?.assignee;
  if (!assignee || !viewer) return false;
  const viewerId = viewer.id == null ? '' : String(viewer.id);
  // assignee.user_id 是内部 ULID，viewer.id 是凭据 id：两个 id 空间不同，id 相等
  // 不能作为判据（`memberRoles.isSelfMember` 记了同一个坑）。这里只按显示名兜底判断
  // 「有没有领取人」，真正的「是不是我」由服务端在动作时判（403 REVIEW_NOT_ASSIGNEE）。
  return Boolean(viewerId) && Boolean(assignee.user_id);
}

/** 一件交付物是否已被修订（当前版本 ≠ 原件）。 */
export function itemRevised(item: ReviewItem): boolean {
  return item.revised || item.current_artifact_id !== item.original_artifact_id;
}

/** 列表行的展示名。 */
export function reviewRequesterLabel(task: ReviewTask | ReviewDetail): string {
  const name = task.requester?.display_name;
  return typeof name === 'string' && name.trim() ? name.trim() : '—';
}

/** 时间戳展示；空值是 em dash，解析不了就原样显示。 */
export function formatReviewTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

export function formatReviewSize(size: unknown): string {
  const value = Number(size);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
