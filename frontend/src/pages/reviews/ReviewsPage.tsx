/**
 * 审核工作台（`/reviews`，design `docs/design/agent-output-review.md` §6 / §8）。
 *
 * 放在 `AppShell` 而不是 admin 控制台：`reviewer` 不一定是 `admin`（design §8 明确）。
 * 导航项只在持有 `reviewer` 时出现，但**真正的判定在服务端**——这里没有权限时页面
 * 显示的是服务端返回的 403 提示，而不是自己猜一个空列表。
 *
 * 三态纪律（照 `MembersPage`）：加载失败必须显示错误态与重试，绝不渲染成
 * 「没有待审任务」；版本冲突（409）刷新任务并**保留已选择的待上传文件**。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '../../features/chat/ChatContext';
import {
  approveReview,
  claimReview,
  getReview,
  listReviews,
  rejectReview,
  releaseReview,
  reviewArtifactUrl,
  reviewMaterialUrl,
  uploadReviewRevision,
  type ReviewDetail,
  type ReviewItem,
  type ReviewTask,
} from '../../shared/api/reviews';
import {
  deliveryStateLabel,
  formatReviewSize,
  formatReviewTimestamp,
  isVersionConflict,
  itemRevised,
  reviewErrorMessage,
  reviewEventLabel,
  reviewListState,
  reviewRequesterLabel,
  reviewStatusLabel,
  runStatusLabel,
} from './reviewErrors';
import a from '../settings/adminPage.module.css';
import s from './reviews.module.css';

const PAGE_SIZE = 20;

const FILTERS = [
  { id: 'pending', label: '待领取', status: 'PENDING', mine: false },
  { id: 'mine', label: '我领取的', status: 'IN_REVIEW', mine: true },
  { id: 'history', label: '历史', status: null, mine: false },
] as const;
type FilterId = (typeof FILTERS)[number]['id'];

export function ReviewsPage() {
  const { state } = useChat();
  const [filter, setFilter] = useState<FilterId>('pending');
  const [tasks, setTasks] = useState<ReviewTask[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectFeedback, setRejectFeedback] = useState('');
  const [approveNote, setApproveNote] = useState('');
  /** 已选择的修订文件：版本冲突后必须保留（design §8）。 */
  const [revisionFile, setRevisionFile] = useState<File | null>(null);
  const [revisionItemNo, setRevisionItemNo] = useState<number | null>(null);
  const loadGeneration = useRef(0);

  const activeFilter = useMemo(() => FILTERS.find((f) => f.id === filter) ?? FILTERS[0], [filter]);

  const load = useCallback(
    async (opts: { cursor?: string | null; append?: boolean } = {}) => {
      const generation = ++loadGeneration.current;
      if (opts.append) setLoadingMore(true);
      else {
        setLoading(true);
        setLoadError(null);
      }
      setActionError(null);
      try {
        const page = await listReviews({
          status: activeFilter.status,
          mine: activeFilter.mine,
          cursor: opts.cursor ?? null,
          limit: PAGE_SIZE,
        });
        // 过期响应（筛选已变）直接丢弃，别覆盖新结果。
        if (generation !== loadGeneration.current) return;
        setTasks((prev) => (opts.append && prev ? [...prev, ...page.tasks] : page.tasks));
        setNextCursor(page.next_cursor);
      } catch (err) {
        if (generation !== loadGeneration.current) return;
        const message = reviewErrorMessage(err);
        if (opts.append) setActionError(message);
        else {
          // 读取失败不能清成空列表：那看起来像「没有待审任务」。
          setTasks(null);
          setLoadError(message);
        }
      } finally {
        if (generation === loadGeneration.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [activeFilter],
  );

  useEffect(() => {
    void load({ cursor: null });
  }, [load]);

  const openDetail = useCallback(async (reviewTaskId: string) => {
    setSelectedId(reviewTaskId);
    setDetailLoading(true);
    setDetailError(null);
    setNotice(null);
    try {
      setDetail(await getReview(reviewTaskId));
    } catch (err) {
      setDetail(null);
      setDetailError(reviewErrorMessage(err));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const refreshDetail = useCallback(async () => {
    if (!selectedId) return;
    try {
      setDetail(await getReview(selectedId));
      setDetailError(null);
    } catch (err) {
      setDetailError(reviewErrorMessage(err));
    }
  }, [selectedId]);

  /**
   * 一个动作的统一收口：成功后刷新列表与详情；失败时按错误码决定要不要刷新。
   * **冲突必须刷新**（服务端已经变了），其余错误保持现状——尤其不能清掉草稿。
   */
  const runAction = useCallback(
    async (key: string, action: () => Promise<ReviewDetail>, successMessage: string) => {
      setBusy(key);
      setActionError(null);
      setNotice(null);
      try {
        const next = await action();
        setDetail(next);
        setNotice(successMessage);
        setRejectOpen(false);
        setRejectFeedback('');
        setApproveNote('');
        setRevisionFile(null);
        setRevisionItemNo(null);
        await load({ cursor: null });
      } catch (err) {
        setActionError(reviewErrorMessage(err));
        if (isVersionConflict(err)) {
          // 版本冲突：刷新任务，但**保留**已选择的待上传文件（design §8）。
          await refreshDetail();
          await load({ cursor: null });
        }
      } finally {
        setBusy(null);
      }
    },
    [load, refreshDetail],
  );

  const listState = reviewListState({ loading, error: loadError, count: tasks?.length ?? 0 });
  const canAct = detail?.status === 'IN_REVIEW';

  return (
    <div className={a.page}>
      <div className={a.head}>
        <div>
          <h1>交付物审核</h1>
          <p>
            智能体按版本配置「交付物需人工审核」时，它在会话里提交的交付物先进入这里。
            通过前发起人看不到也下载不了；通过后出现在原会话与产物库里。审核员只能看到
            用户提问与上传的文件，看不到发起人的工作区。
          </p>
        </div>
        <span className={a.sp} />
        <button type="button" className={a.btn} onClick={() => void load({ cursor: null })} disabled={loading}>
          {loading ? '刷新中…' : '刷新'}
        </button>
      </div>

      <div className={a.toolbar}>
        <div className={a.seg} role="group" aria-label="审核筛选">
          {FILTERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={a.btn}
              aria-pressed={filter === entry.id}
              onClick={() => setFilter(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      {notice ? <p className={a.notice} role="status">{notice}</p> : null}
      {actionError ? <p className={a.error} role="alert">{actionError}</p> : null}

      <div className={s.layout}>
        <div className={s.listPane}>
          {listState === 'error' ? (
            <div className={a.error} role="alert">
              <b>读取审核队列失败</b>
              <p style={{ margin: 0 }}>{loadError}</p>
              <div className={a.cardActions}>
                <button type="button" className={a.btn} onClick={() => void load({ cursor: null })}>
                  重试
                </button>
              </div>
            </div>
          ) : null}
          {listState === 'loading' ? <p className={a.muted}>正在读取…</p> : null}
          {listState === 'empty' ? (
            <p className={a.empty}>
              {filter === 'pending' ? '没有待领取的审核任务。' : filter === 'mine' ? '你没有正在审核的任务。' : '还没有历史任务。'}
            </p>
          ) : null}
          {listState === 'ready' ? (
            <table className={a.table}>
              <thead>
                <tr>
                  <th>发起人</th>
                  <th>交付物</th>
                  <th>状态</th>
                  <th>Run</th>
                  <th>提交时间</th>
                </tr>
              </thead>
              <tbody>
                {tasks!.map((task) => (
                  <tr
                    key={task.review_task_id}
                    className={task.review_task_id === selectedId ? s.rowActive : undefined}
                    onClick={() => void openDetail(task.review_task_id)}
                  >
                    <td>{reviewRequesterLabel(task)}</td>
                    <td>{task.item_count ?? 0} 件</td>
                    <td>
                      <span className={`${a.pill} ${statusClass(task.status, a)}`}>{reviewStatusLabel(task.status)}</span>
                    </td>
                    <td>{runStatusLabel(task.run_status)}</td>
                    <td className={a.muted}>{formatReviewTimestamp(task.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {nextCursor && listState === 'ready' ? (
            <div className={a.cardActions}>
              <button
                type="button"
                className={a.btn}
                disabled={loadingMore}
                onClick={() => void load({ cursor: nextCursor, append: true })}
              >
                {loadingMore ? '正在加载…' : '加载更多'}
              </button>
            </div>
          ) : null}
        </div>

        <div className={s.detailPane}>
          {!selectedId ? <p className={a.muted}>从左侧选择一个任务查看详情。</p> : null}
          {selectedId && detailLoading ? <p className={a.muted}>正在读取详情…</p> : null}
          {selectedId && detailError ? (
            <div className={a.error} role="alert">
              <b>读取任务详情失败</b>
              <p style={{ margin: 0 }}>{detailError}</p>
              <div className={a.cardActions}>
                <button type="button" className={a.btn} onClick={() => void refreshDetail()}>
                  重试
                </button>
              </div>
            </div>
          ) : null}
          {detail && !detailLoading ? (
            <ReviewDetailPane
              detail={detail}
              busy={busy}
              approveNote={approveNote}
              onApproveNote={setApproveNote}
              rejectFeedback={rejectFeedback}
              onRejectFeedback={setRejectFeedback}
              rejectOpen={rejectOpen}
              onRejectOpen={setRejectOpen}
              revisionFile={revisionFile}
              revisionItemNo={revisionItemNo}
              onPickRevision={(itemNo, file) => {
                setRevisionItemNo(itemNo);
                setRevisionFile(file);
              }}
              canAct={canAct}
              onClaim={() => void runAction('claim', () => claimReview(detail.review_task_id), '已领取')}
              onRelease={() => void runAction('release', () => releaseReview(detail.review_task_id), '已释放领取')}
              onApprove={() =>
                void runAction(
                  'approve',
                  () => approveReview(detail.review_task_id, { baseRevision: detail.revision, note: approveNote }),
                  '已通过，正在发布',
                )
              }
              onReject={() =>
                void runAction(
                  'reject',
                  () => rejectReview(detail.review_task_id, { baseRevision: detail.revision, feedback: rejectFeedback }),
                  '已驳回',
                )
              }
              onUploadRevision={(itemNo) =>
                void runAction(
                  `revision:${itemNo}`,
                  () => {
                    if (!revisionFile) throw new Error('请先选择修订文件');
                    return uploadReviewRevision(detail.review_task_id, itemNo, {
                      baseRevision: detail.revision,
                      file: revisionFile,
                      filename: revisionFile.name,
                    });
                  },
                  '已上传修订版',
                )
              }
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function statusClass(status: string, styles: Record<string, string>): string {
  if (status === 'APPROVED') return styles.ok ?? '';
  if (status === 'REJECTED') return styles.err ?? '';
  if (status === 'IN_REVIEW') return styles.warn ?? '';
  return styles.mute ?? '';
}

function ReviewDetailPane(props: {
  detail: ReviewDetail;
  busy: string | null;
  canAct: boolean;
  approveNote: string;
  onApproveNote: (value: string) => void;
  rejectFeedback: string;
  onRejectFeedback: (value: string) => void;
  rejectOpen: boolean;
  onRejectOpen: (open: boolean) => void;
  revisionFile: File | null;
  revisionItemNo: number | null;
  onPickRevision: (itemNo: number, file: File) => void;
  onClaim: () => void;
  onRelease: () => void;
  onApprove: () => void;
  onReject: () => void;
  onUploadRevision: (itemNo: number) => void;
}) {
  const { detail, busy, canAct } = props;
  const decided = detail.status === 'APPROVED' || detail.status === 'REJECTED';
  return (
    <div>
      <div className={a.card}>
        <div className={a.cardHead}>
          <b>任务 {detail.review_task_id}</b>
          <span className={a.sp} />
          <span className={`${a.pill} ${statusClass(detail.status, a)}`}>{reviewStatusLabel(detail.status)}</span>
        </div>
        <p className={a.muted}>
          发起人：{reviewRequesterLabel(detail)} · 智能体版本：{detail.agent?.version_no ?? '—'} · Run 状态：
          {runStatusLabel(detail.run_status)} · 提交于 {formatReviewTimestamp(detail.created_at)}
          {detail.assignee ? ` · 领取人：${detail.assignee.display_name || detail.assignee.user_id}` : ''}
        </p>
        {detail.feedback ? <p className={a.note}>审核意见：{detail.feedback}</p> : null}
        <div className={a.cardActions}>
          {detail.status === 'PENDING' ? (
            <button type="button" className={a.btnPri} disabled={busy !== null} onClick={props.onClaim}>
              {busy === 'claim' ? '领取中…' : '领取'}
            </button>
          ) : null}
          {detail.status === 'IN_REVIEW' ? (
            <button type="button" className={a.btn} disabled={busy !== null} onClick={props.onRelease}>
              {busy === 'release' ? '释放中…' : '释放领取'}
            </button>
          ) : null}
        </div>
      </div>

      <div className={a.card}>
        <div className={a.cardHead}>
          <b>用户提问</b>
        </div>
        {detail.questions.length === 0 ? (
          <p className={a.muted}>这次 Run 之前没有用户消息。</p>
        ) : (
          <ol className={s.questions}>
            {detail.questions.map((question) => (
              <li key={question.message_id}>
                <div className={a.muted}>{formatReviewTimestamp(question.created_at)}</div>
                <div className={s.questionText}>{question.text || '（无文字）'}</div>
                {question.attachments.length > 0 ? (
                  <ul className={s.attachList}>
                    {question.attachments.map((attachment) => (
                      <li key={attachment.attachment_id}>
                        {attachment.filename}
                        <span className={a.muted}> · {formatReviewSize(attachment.size)}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className={a.card}>
        <div className={a.cardHead}>
          <b>上传的文件（快照）</b>
        </div>
        {detail.materials.length === 0 ? (
          <p className={a.muted}>这次任务没有附件。</p>
        ) : (
          <table className={a.table}>
            <thead>
              <tr>
                <th>文件名</th>
                <th>大小</th>
                <th>快照</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {detail.materials.map((material) => (
                <tr key={material.material_id}>
                  <td>{material.filename}</td>
                  <td className={a.muted}>{formatReviewSize(material.size)}</td>
                  <td>
                    {material.snapshot_status === 'ready' ? (
                      '可用'
                    ) : (
                      <span className={`${a.pill} ${a.err}`}>快照不可用</span>
                    )}
                  </td>
                  <td>
                    {material.snapshot_status === 'ready' ? (
                      <a
                        className={a.btn}
                        href={reviewMaterialUrl(detail.review_task_id, material.material_id)}
                        download={material.filename}
                      >
                        下载
                      </a>
                    ) : (
                      <span className={a.muted}>—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className={a.card}>
        <div className={a.cardHead}>
          <b>交付物</b>
        </div>
        {detail.items.length === 0 ? (
          <p className={a.muted}>这次任务没有交付物。</p>
        ) : (
          detail.items.map((item) => (
            <ItemBlock
              key={item.item_no}
              item={item}
              reviewTaskId={detail.review_task_id}
              canAct={canAct}
              busy={busy}
              revisionFile={props.revisionItemNo === item.item_no ? props.revisionFile : null}
              onPickRevision={props.onPickRevision}
              onUploadRevision={props.onUploadRevision}
            />
          ))
        )}
      </div>

      {canAct ? (
        <div className={a.card}>
          <div className={a.cardHead}>
            <b>决定</b>
          </div>
          <label className={a.note}>
            通过备注（可选）
            <input
              className={a.input}
              value={props.approveNote}
              onChange={(e) => props.onApproveNote(e.target.value)}
              disabled={busy !== null}
            />
          </label>
          <div className={a.cardActions}>
            <button type="button" className={a.btnPri} disabled={busy !== null} onClick={props.onApprove}>
              {busy === 'approve' ? '提交中…' : '通过并交付'}
            </button>
            <button type="button" className={a.btnDanger} disabled={busy !== null} onClick={() => props.onRejectOpen(true)}>
              驳回
            </button>
          </div>
        </div>
      ) : null}

      {decided ? (
        <div className={a.card}>
          <p className={a.muted}>
            {detail.status === 'APPROVED'
              ? '已通过：交付物正在发布，发起人的会话里会出现「已交付」卡片。'
              : '已驳回：交付物已撤回，发起人看到的是反馈卡片。'}
          </p>
        </div>
      ) : null}

      {props.rejectOpen ? (
        <div className={a.card} role="dialog" aria-label="驳回">
          <div className={a.cardHead}>
            <b>驳回交付物</b>
          </div>
          <p className={a.muted}>反馈会显示给发起人，必须填写。</p>
          <textarea
            className={a.input}
            value={props.rejectFeedback}
            onChange={(e) => props.onRejectFeedback(e.target.value)}
            disabled={busy !== null}
            rows={3}
            placeholder="说明哪里不合格、需要怎么改"
          />
          <div className={a.cardActions}>
            <button
              type="button"
              className={a.btnDanger}
              disabled={busy !== null || props.rejectFeedback.trim() === ''}
              title={props.rejectFeedback.trim() === '' ? '驳回必须填写原因' : undefined}
              onClick={props.onReject}
            >
              {busy === 'reject' ? '提交中…' : '确认驳回'}
            </button>
            <button type="button" className={a.btn} disabled={busy !== null} onClick={() => props.onRejectOpen(false)}>
              取消
            </button>
          </div>
        </div>
      ) : null}

      <div className={a.card}>
        <div className={a.cardHead}>
          <b>审计时间线</b>
        </div>
        {detail.events.length === 0 ? (
          <p className={a.muted}>没有审计事件。</p>
        ) : (
          <ul className={s.timeline}>
            {detail.events.map((event) => (
              <li key={event.event_id}>
                <span className={a.mono}>{formatReviewTimestamp(event.created_at)}</span>{' '}
                <b>{reviewEventLabel(event.event_type)}</b>
                {event.item_no != null ? <span className={a.muted}> · 第 {event.item_no} 件</span> : null}
                {event.detail ? <span className={a.muted}> · {event.detail}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ItemBlock(props: {
  item: ReviewItem;
  reviewTaskId: string;
  canAct: boolean;
  busy: string | null;
  revisionFile: File | null;
  onPickRevision: (itemNo: number, file: File) => void;
  onUploadRevision: (itemNo: number) => void;
}) {
  const { item } = props;
  const revised = itemRevised(item);
  return (
    <div className={s.item}>
      <div className={a.cardHead}>
        <b>{item.name}</b>
        <span className={a.sp} />
        <span className={`${a.pill} ${revised ? a.info : a.mute}`}>
          {deliveryStateLabel(props.canAct ? 'pending' : 'released', revised)}
        </span>
      </div>
      <p className={a.muted}>
        {[item.mime_type, formatReviewSize(item.size)].filter(Boolean).join(' · ') || '交付物'}
      </p>
      <table className={a.table}>
        <thead>
          <tr>
            <th>版本</th>
            <th>artifact</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(item.versions.length > 0
            ? item.versions
            : [{ artifact_id: item.current_artifact_id, current: true, revision: 0 }]
          ).map((version) => (
            <tr key={version.artifact_id}>
              <td>{version.revision === 0 ? '原件' : `修订 ${version.revision}`}{version.current ? '（当前）' : ''}</td>
              <td className={a.mono}>{version.artifact_id}</td>
              <td>
                <a
                  className={a.btn}
                  href={reviewArtifactUrl(props.reviewTaskId, version.artifact_id)}
                  download={item.name}
                >
                  下载
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {props.canAct ? (
        <div className={a.cardActions}>
          <input
            type="file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) props.onPickRevision(item.item_no, file);
            }}
            disabled={props.busy !== null}
            aria-label={`为 ${item.name} 选择修订文件`}
          />
          <button
            type="button"
            className={a.btn}
            disabled={props.busy !== null || !props.revisionFile}
            onClick={() => props.onUploadRevision(item.item_no)}
          >
            {props.busy === `revision:${item.item_no}` ? '上传中…' : '上传修订版'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
