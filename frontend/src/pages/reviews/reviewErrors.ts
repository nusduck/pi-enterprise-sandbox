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

/**
 * 列表页签（T5）。`status` 是服务端接受的**逗号分隔多值**筛选；`null`/空 = 不筛选。
 *
 * 「历史」必须写成 `APPROVED,REJECTED`：以前是 `null`，等于不筛选，于是待领取和
 * 审核中的任务也出现在历史里（2026-10-01 浏览器实测发现）。单值页签行为不变。
 */
export const REVIEW_LIST_FILTERS = [
  { id: 'pending', label: '待领取', status: 'PENDING', mine: false },
  { id: 'mine', label: '我领取的', status: 'IN_REVIEW', mine: true },
  { id: 'history', label: '历史', status: 'APPROVED,REJECTED', mine: false },
] as const;
export type ReviewFilterId = (typeof REVIEW_LIST_FILTERS)[number]['id'];

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

/** 详情是不是 JSON 结构（对象/数组）。宁可少显示，也不把 JSON 丢给用户。 */
function looksLikeJson(text: string): boolean {
  return text.startsWith('{') || text.startsWith('[');
}

function formatCreatedDetail(detail: string): string | null {
  if (!looksLikeJson(detail)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const items = (parsed as Record<string, unknown>).items;
  const materials = (parsed as Record<string, unknown>).materials;
  if (typeof items !== 'number' || !Number.isFinite(items)) return null;
  const parts = [`${items} 件交付物`];
  if (typeof materials === 'number' && Number.isFinite(materials)) parts.push(`${materials} 个附件`);
  return parts.join('，');
}

/**
 * 审计事件的**详情**文案（T4）。
 *
 * `detail` 是服务端按事件类型写的自由文本：`created` 是 `{"items":N,"materials":M}`
 * 这种 JSON、`released_claim` 可能是英文的 `admin released the claim`、`approved` 是
 * 通过备注、`rejected` 是驳回反馈。把 `detail` 原样拼进时间线会在界面上显示一串 JSON
 * （2026-10-01 浏览器实测发现）。
 *
 * 规则：认识的形状翻成一句中文；`revised` 的件数已经由「第 N 件」渲染，这里返回
 * `null` 不重复；**未知结构一律返回 `null`**——宁可不显示详情，也不能把 JSON 或看不懂
 * 的字符串丢给用户。
 */
export function reviewEventDetail(
  event: { event_type?: unknown; detail?: unknown; item_no?: unknown } | null | undefined,
): string | null {
  if (!event || typeof event !== 'object') return null;
  const type = typeof event.event_type === 'string' ? event.event_type : '';
  const detail = typeof event.detail === 'string' ? event.detail.trim() : '';
  if (type === 'revised') return null;
  if (type === 'created') return formatCreatedDetail(detail);
  if (!detail) return null;
  if (type === 'released_claim') {
    return detail === 'admin released the claim' ? '管理员释放了领取' : null;
  }
  if (type === 'approved') return looksLikeJson(detail) ? null : `备注：${detail}`;
  if (type === 'rejected') return looksLikeJson(detail) ? null : `反馈：${detail}`;
  // 未知事件类型：只有确认不是 JSON 结构时才原样显示这段纯文本。
  return looksLikeJson(detail) ? null : detail;
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

/**
 * 列表行的交付物标签（§3.2.1）。
 *
 * 同一发起人的十几行原来只有「N 件」，看不出是哪个任务。现在给首件名，多件时
 * 「首件名 等 N 件」；一件名字都没有时退回「N 件」，没有件数才是「—」。
 */
export function reviewTaskItemLabel(
  task: { first_item_name?: unknown; item_count?: unknown } | null | undefined,
): string {
  const count = Number(task?.item_count);
  const total = Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
  const name =
    typeof task?.first_item_name === 'string' && task.first_item_name.trim()
      ? task.first_item_name.trim()
      : '';
  if (total === 0) return name || '—';
  if (!name) return `${total} 件`;
  return total > 1 ? `${name} 等 ${total} 件` : name;
}

/** 列表行的智能体名；缺了显示「—」，不拿版本号冒充。 */
export function reviewTaskAgentLabel(
  task: { agent_name?: unknown } | null | undefined,
): string {
  const name = task?.agent_name;
  return typeof name === 'string' && name.trim() ? name.trim() : '—';
}

/**
 * 详情标题（§3.2.3）：**绝不拿 ULID 当标题**。
 *
 * 交付物名优先（多件时「首件名 等 N 件」），否则退到「智能体名 · 发起人」。任务 ID
 * 降级为次要信息里可复制的小字。
 */
export function reviewDetailTitle(
  detail: {
    items?: ReadonlyArray<{ name?: unknown }>;
    agent?: { name?: unknown } | null;
    requester?: { display_name?: unknown } | null;
  } | null | undefined,
): string {
  if (!detail) return '审核任务';
  const names = (detail.items ?? [])
    .map((item) => (typeof item?.name === 'string' ? item.name.trim() : ''))
    .filter(Boolean);
  if (names.length === 1) return names[0];
  if (names.length > 1) return `${names[0]} 等 ${names.length} 件`;
  const agentName =
    typeof detail.agent?.name === 'string' && detail.agent.name.trim()
      ? detail.agent.name.trim()
      : '智能体';
  const requester =
    typeof detail.requester?.display_name === 'string' ? detail.requester.display_name.trim() : '';
  return requester ? `${agentName} · ${requester}` : agentName;
}

/** 版本表的上传者（§3.2.4）：修订显示审核员显示名，原件是智能体。 */
export function reviewVersionUploader(
  version: { uploaded_by_kind?: unknown; uploaded_by_display_name?: unknown } | null | undefined,
): string {
  const kind = typeof version?.uploaded_by_kind === 'string' ? version.uploaded_by_kind : 'agent';
  if (kind !== 'reviewer') return '智能体';
  const name =
    typeof version?.uploaded_by_display_name === 'string'
      ? version.uploaded_by_display_name.trim()
      : '';
  return name || '审核员';
}

/** artifact id 的短展示（§3.2.4）：完整 id 收进悬停提示，主列只留版本号。 */
export function shortArtifactId(artifactId: unknown): string {
  const id = typeof artifactId === 'string' ? artifactId.trim() : '';
  if (!id) return '—';
  return id.length <= 16 ? id : `${id.slice(0, 10)}…${id.slice(-4)}`;
}

/**
 * 状态颜色语义（§3.2.5）。
 *
 * 任务状态与交付物状态**共用这一套 tone**：驳回 / 未通过都是警示色，通过 / 已交付
 * 都是成功色。以前交付物标签固定用蓝色，和任务的红色「已驳回」对不上。
 */
export type StatusTone = 'ok' | 'err' | 'warn' | 'mute';

export function reviewStatusTone(status: unknown): StatusTone {
  if (status === 'APPROVED') return 'ok';
  if (status === 'REJECTED') return 'err';
  if (status === 'IN_REVIEW') return 'warn';
  return 'mute';
}

export function deliveryTone(state: DeliveryState): StatusTone {
  if (state === 'released') return 'ok';
  if (state === 'rejected') return 'err';
  return 'warn';
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

/**
 * 选中任务后要不要把详情面板滚进视口。
 *
 * ≤1200px 是单栏布局，详情排在整张列表下面：不滚过去，点了任务看起来什么都没发生
 * （2026-10-01 浏览器复核：1100px 下面板 top=1498、视口高 683）。两栏布局下面板就在
 * 列表右侧、顶部可见，这时不能乱滚。面板顶部不在视口内（下方或上方）就滚。
 */
export function shouldScrollDetailIntoView(input: { top: number; viewportHeight: number }): boolean {
  return input.top >= input.viewportHeight || input.top < 0;
}
