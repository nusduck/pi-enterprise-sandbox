import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  approveSkillShare,
  getOrgSkillManifest,
  getShareRequestManifest,
  listOrgSkills,
  listSkillShareQueue,
  listSkillShareQueuePage,
  rejectSkillShare,
  setOrgSkillCurrent,
  setOrgSkillVersionStatus,
  uploadOrgSkill,
  type OrgSkillName,
  type ShareRequestStatus,
  type SkillManifest,
  type SkillShareRequest,
} from '../../shared/api/skillSharing';
import { PageHeader } from '../../shared/ui/PageHeader';
import { StatusBadge } from '../../shared/ui/StatusBadge';
import { Pager, useCursorPagination } from '../../shared/ui/Pager';
import a from './adminPage.module.css';
import s from './skillAdmin.module.css';

type Tab = 'queue' | 'org';

const STATUS_ZH: Record<ShareRequestStatus, [string, string]> = {
  pending: ['待处理', a.warn],
  approved: ['已批准', a.ok],
  rejected: ['已驳回', a.err],
  withdrawn: ['已撤回', a.mute],
  superseded: ['已被新申请取代', a.mute],
};

const VERSION_ZH: Record<string, [string, string]> = {
  active: ['可用', a.ok],
  deprecated: ['已弃用', a.warn],
  revoked: ['已吊销', a.err],
};

const MAX_SKILL_BYTES = 50 * 1024 * 1024;

function Pill({ value, table }: { value: string; table: Record<string, [string, string]> }) {
  const [label] = table[value] || [value, a.mute];
  return <StatusBadge status={value} label={label} />;
}

function shortDigest(digest: string): string {
  return digest ? digest.slice(0, 12) : '—';
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString('zh-CN', { hour12: false });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function CopyBtn({ text, label = '复制' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button type="button" className={s.copyBtn} onClick={copy} title="复制到剪贴板">
      {copied ? '已复制' : label}
    </button>
  );
}

/**
 * 展示受影响或引用当前 Skill 版本的 AgentVersion 列表（ADR 0015 D8 验收要求）。
 * 服务端返回完整引用集合；支持搜索过滤、分页浏览（每页 10 条）与一键复制。
 */
function AffectedVersionsView({
  ids,
  title = '受影响的智能体版本',
  description,
}: {
  ids: string[];
  title?: string;
  description?: string;
}) {
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 10;

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return ids;
    return ids.filter((id) => id.toLowerCase().includes(q));
  }, [ids, filter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageItems = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }, [filtered, currentPage, pageSize]);

  return (
    <div className={s.affectedSection}>
      <div className={s.affectedHeader}>
        <span>
          {title}（共 {ids.length} 个{filtered.length !== ids.length ? `，筛选出 ${filtered.length} 个` : ''}）
        </span>
        {ids.length > 0 ? (
          <CopyBtn text={ids.join('\n')} label={`复制全部 (${ids.length})`} />
        ) : null}
      </div>

      {description ? (
        <p className={a.muted} style={{ margin: 0, fontSize: '12.5px' }}>
          {description}
        </p>
      ) : null}

      {ids.length > 5 ? (
        <input
          type="search"
          className={a.input}
          style={{ fontSize: '12px', padding: '4px 8px' }}
          placeholder="搜索版本 ID…"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setPage(1);
          }}
        />
      ) : null}

      {filtered.length > 0 ? (
        <>
          <div className={s.affectedList}>
            {pageItems.map((id) => (
              <div key={id} className={s.affectedItem}>
                <span style={{ wordBreak: 'break-all' }}>{id}</span>
                <CopyBtn text={id} />
              </div>
            ))}
          </div>

          {totalPages > 1 ? (
            <div className={s.pagination}>
              <span className={a.muted} style={{ fontSize: '12px' }}>
                第 {currentPage} / {totalPages} 页
              </span>
              <button
                type="button"
                className={a.btn}
                style={{ padding: '2px 8px', fontSize: '12px' }}
                disabled={currentPage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                上一页
              </button>
              <button
                type="button"
                className={a.btn}
                style={{ padding: '2px 8px', fontSize: '12px' }}
                disabled={currentPage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                下一页
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <p className={a.muted} style={{ margin: '4px 0 0', fontSize: '12.5px' }}>
          {ids.length === 0 ? '当前没有智能体版本绑定此版本。' : '没有匹配的版本 ID。'}
        </p>
      )}
    </div>
  );
}

/**
 * 清单详情弹窗（Manifest Modal）：
 * 展示包摘要、文件清单、SKILL.md 预览，以及引用此版本的 AgentVersion（ADR 0015）。
 * 原生 <dialog.showModal()> 管理键盘焦点与 Esc / 背景点击关闭。
 */
function ManifestModal({
  manifest,
  onClose,
}: {
  manifest: SkillManifest;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const affected = manifest.affectedAgentVersionIds;

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (!d.open) d.showModal();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className={`${s.dialog} ${s.dialogWide}`}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-label="版本清单"
    >
      <div className={s.dialogContent}>
        <div className={s.modalHead}>
          <h3 className={s.modalTitle}>
            <span className={a.mono}>{manifest.name}</span>
            <span className={a.muted}>版本清单</span>
          </h3>
          <button type="button" className={s.closeBtn} onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className={s.modalBody}>
          <div className={s.metaPills}>
            <span className={s.metaChip}>{manifest.fileCount} 个文件</span>
            <span className={s.metaChip}>{formatBytes(manifest.totalBytes)}</span>
            <span className={s.metaChip}>
              摘要: {shortDigest(manifest.contentDigest)}
              <span style={{ marginLeft: 6 }}>
                <CopyBtn text={manifest.contentDigest} label="复制完整摘要" />
              </span>
            </span>
          </div>

          {/* ADR 0015：展示引用此版本的 AgentVersion 清单 */}
          {affected !== undefined ? (
            <AffectedVersionsView
              ids={affected}
              title="引用此版本的智能体版本"
              description="引用了此 Skill 版本的 AgentVersion。当组织层该版本被吊销或更新时，将影响这些智能体。"
            />
          ) : null}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontWeight: 500, fontSize: '13px' }}>文件列表</span>
            <div className={s.fileListContainer}>
              <table className={s.fileListTable}>
                <thead>
                  <tr>
                    <th>路径</th>
                    <th style={{ width: 90, textAlign: 'right' }}>大小</th>
                  </tr>
                </thead>
                <tbody>
                  {manifest.files.map((file) => (
                    <tr key={file.path}>
                      <td className={a.mono}>{file.path}</td>
                      <td className={a.num} style={{ textAlign: 'right', color: 'var(--color-text-muted)' }}>
                        {formatBytes(file.bytes)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontWeight: 500, fontSize: '13px' }}>
                SKILL.md{manifest.truncated ? '（已截断）' : ''}
              </span>
              <CopyBtn text={manifest.skillMd} label="复制 SKILL.md" />
            </div>
            <pre className={a.pre} style={{ margin: 0, maxHeight: 220 }}>{manifest.skillMd}</pre>
          </div>
        </div>
        <div className={s.modalFoot}>
          <button type="button" className={a.btn} onClick={onClose}>关闭</button>
        </div>
      </div>
    </dialog>
  );
}

/**
 * 吊销确认弹窗：强制填写原因，提示安全动作不可逆。
 * 使用原生 <dialog.showModal()> 限制键盘焦点在弹窗内，并在弹窗内直接显示错误与保留草稿。
 */
function RevokeDialog({
  skillName,
  digest,
  onConfirm,
  onClose,
}: {
  skillName: string;
  digest: string;
  onConfirm: (reason: string) => Promise<void>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (!d.open) d.showModal();
  }, []);

  async function handleSubmit() {
    if (!reason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
    } catch (err) {
      setError((err as Error).message || '吊销失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className={s.dialog}
      onClose={onClose}
      onCancel={(e) => {
        if (busy) e.preventDefault();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
      aria-label="吊销组织共享 Skill 版本"
    >
      <div className={s.dialogContent}>
        <div className={s.modalHead}>
          <h3 className={s.modalTitle} style={{ color: 'var(--color-danger-text)' }}>
            吊销组织共享 Skill 版本
          </h3>
          <button type="button" className={s.closeBtn} onClick={onClose} disabled={busy} aria-label="关闭">×</button>
        </div>
        <div className={s.modalBody}>
          <div className={s.alertDanger}>
            <b>安全操作警告：</b>
            吊销是不可逆的安全动作。提交后，任何 Run 在解析时将立即排除此版本并记录诊断日志。
          </div>
          <div>
            <b>目标 Skill：</b> <span className={a.mono}>{skillName}</span>
            <span style={{ margin: '0 8px', color: 'var(--color-text-muted)' }}>·</span>
            <b>版本摘要：</b> <span className={a.mono}>{shortDigest(digest)}</span>
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontWeight: 500 }}>吊销原因（必填）</span>
            <textarea
              className={s.textarea}
              rows={3}
              placeholder="请详细说明吊销原因（如：存在安全隐患、泄露机密、严重缺陷等）…"
              value={reason}
              maxLength={500}
              disabled={busy}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          {error ? (
            <div className={s.alertDanger} role="alert">
              <b>吊销失败：</b>{error}
            </div>
          ) : null}
        </div>
        <div className={s.modalFoot}>
          <button type="button" className={a.btn} onClick={onClose} disabled={busy}>取消</button>
          <button
            type="button"
            className={a.btnDanger}
            disabled={busy || !reason.trim()}
            onClick={() => void handleSubmit()}
          >
            {busy ? '正在吊销…' : '确认吊销'}
          </button>
        </div>
      </div>
    </dialog>
  );
}

/** 吊销结果与影响面展示弹窗（ADR 0015 D8 验收要求） */
function RevokeResultModal({
  skillName,
  digest,
  affectedAgentVersionIds,
  onClose,
}: {
  skillName: string;
  digest: string;
  affectedAgentVersionIds: string[];
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (!d.open) d.showModal();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className={s.dialog}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-label="吊销成功"
    >
      <div className={s.dialogContent}>
        <div className={s.modalHead}>
          <h3 className={s.modalTitle}>
            <span style={{ color: 'var(--color-success-text)' }}>✓</span> 吊销成功
          </h3>
          <button type="button" className={s.closeBtn} onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className={s.modalBody}>
          <div className={s.alertSuccess}>
            已成功吊销 <span className={a.mono}>{skillName}</span>（{shortDigest(digest)}）。新创建的 Run 将立即排除此版本。
          </div>
          <AffectedVersionsView
            ids={affectedAgentVersionIds}
            title="受影响的智能体版本"
            description="以下智能体版本绑定了已吊销的 Skill 版本。这些 Agent 下次运行时将不再挂载该技能，并记录 revoked 诊断日志："
          />
        </div>
        <div className={s.modalFoot}>
          <button type="button" className={a.btnPri} onClick={onClose}>完成</button>
        </div>
      </div>
    </dialog>
  );
}

/** 谁的申请：管理员只看得到被申请的那一个版本（design §7.1）。 */
function RequestRow({
  request,
  onChanged,
  onInspectManifest,
}: {
  request: SkillShareRequest;
  onChanged: () => Promise<void>;
  onInspectManifest: (manifest: SkillManifest) => void;
}) {
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function decide(action: 'approve' | 'reject') {
    setBusy(action);
    setError(null);
    try {
      if (action === 'approve') await approveSkillShare(request.requestId, { setCurrent: true, note });
      else await rejectSkillShare(request.requestId, note.trim());
      await onChanged();
    } catch (err) {
      // 批准失败时申请保持 pending（服务端先字节后状态），所以这里只报错、
      // 不把行从队列里拿掉——拿掉会让管理员以为已经处理完了。
      setError((err as Error).message || '操作失败');
      // 若是并发冲突（如已被处理），刷新列表以同步最新状态
      if (String((err as Error).message || '').includes('already')) {
        void onChanged();
      }
    } finally {
      setBusy(null);
    }
  }

  const pending = request.status === 'pending';
  return (
    <div className={s.requestCard}>
      <div className={a.cardHead}>
        <b className={a.mono} style={{ fontSize: '14px' }}>{request.name}</b>
        <Pill value={request.status} table={STATUS_ZH} />
        <span className={a.sp} />
        <span className={a.muted}>{formatDate(request.createdAt)}</span>
      </div>
      <div className={a.muted} style={{ fontSize: '12.5px' }}>
        请求摘要 <span className={a.mono}>{shortDigest(request.contentDigest)}</span>
      </div>
      {request.note ? (
        <div className={s.requestNoteBox}>
          <b>申请说明：</b>{request.note}
        </div>
      ) : null}
      {request.decisionNote ? (
        <div className={s.decisionNoteBox}>
          <b>审批决定说明：</b>{request.decisionNote}
        </div>
      ) : null}
      <div className={a.cardActions} style={{ marginTop: 4 }}>
        <button
          type="button"
          className={a.btn}
          disabled={busy !== null}
          onClick={() => {
            setBusy('manifest');
            setError(null);
            getShareRequestManifest(request.requestId)
              .then(onInspectManifest)
              .catch((err: Error) => setError(err.message || '读取清单失败'))
              .finally(() => setBusy(null));
          }}
        >
          查看清单
        </button>
      </div>
      {pending ? (
        <div className={s.actionForm}>
          <input
            className={a.input}
            style={{ flex: 1, minWidth: 220 }}
            placeholder="说明（驳回必填，批准可选）"
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
          />
          <button
            type="button"
            className={a.btnPri}
            disabled={busy !== null}
            onClick={() => void decide('approve')}
          >
            {busy === 'approve' ? '批准中…' : '批准'}
          </button>
          <button
            type="button"
            className={a.btnDanger}
            disabled={busy !== null || note.trim() === ''}
            title={note.trim() === '' ? '驳回必须填写原因' : undefined}
            onClick={() => void decide('reject')}
          >
            {busy === 'reject' ? '驳回中…' : '驳回'}
          </button>
        </div>
      ) : null}
      {error ? (
        <div className={s.alertDanger} style={{ marginTop: 4 }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

function QueuePane({ onInspectManifest }: { onInspectManifest: (manifest: SkillManifest) => void }) {
  const [filter, setFilter] = useState<ShareRequestStatus | 'all'>('pending');
  const pagination = useCursorPagination({ initialPageSize: 20 });
  const [items, setItems] = useState<SkillShareRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const page = await listSkillShareQueuePage({
        status: filter === 'all' ? undefined : filter,
        limit: pagination.pageSize,
        cursor: pagination.currentCursor,
      });
      setItems(page.requests);
      pagination.setPageData(page.next_cursor);
    } catch (err) {
      // 读取失败不显示成空队列：那会让管理员以为没人申请。
      setItems(null);
      pagination.setPageData(null);
      setError((err as Error).message || '读取申请队列失败');
    } finally {
      setLoading(false);
    }
  }, [filter, pagination.pageSize, pagination.currentCursor, pagination.setPageData]);

  useEffect(() => { void load(); }, [load]);

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className={a.seg} role="group" aria-label="申请状态">
        {(['pending', 'all', 'approved', 'rejected'] as const).map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={filter === v}
            onClick={() => {
              setFilter(v);
              pagination.reset();
            }}
          >
            {v === 'all' ? '全部' : STATUS_ZH[v][0]}
          </button>
        ))}
      </div>
      {error ? <p className={a.error} role="alert">{error}</p> : null}
      {items == null ? <p className={a.muted}>{error ? '' : '正在读取…'}</p> : null}
      {items && items.length === 0 ? <p className={a.empty}>没有申请。</p> : null}
      {items && items.length > 0 ? (
        <div className={a.tableCard}>
          {items.map((request) => (
            <RequestRow
              key={request.requestId}
              request={request}
              onChanged={load}
              onInspectManifest={onInspectManifest}
            />
          ))}
          <Pager
            page={pagination.page}
            count={items.length}
            pageSize={pagination.pageSize}
            onPageSizeChange={pagination.setPageSize}
            onPrev={pagination.goToPrevPage}
            onNext={pagination.goToNextPage}
            hasPrev={pagination.hasPrev}
            hasNext={pagination.hasNext}
            loading={loading}
          />
        </div>
      ) : null}
    </section>
  );
}

function OrgPane({ onInspectManifest }: { onInspectManifest: (manifest: SkillManifest) => void }) {
  const [items, setItems] = useState<OrgSkillName[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [uploadCurrent, setUploadCurrent] = useState(false);
  const [revokingTarget, setRevokingTarget] = useState<{ name: string; digest: string } | null>(null);
  const [revokeResult, setRevokeResult] = useState<{
    name: string;
    digest: string;
    affectedAgentVersionIds: string[];
  } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems(await listOrgSkills());
    } catch (err) {
      setItems(null);
      setError((err as Error).message || '读取组织 Skill 失败');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError((err as Error).message || '操作失败');
    } finally {
      setBusy(null);
    }
  }

  function upload(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    if (!/\.(zip|skill)$/i.test(file.name)) return setError('只支持 .zip 或 .skill 包');
    if (file.size > MAX_SKILL_BYTES) return setError('单个包不能超过 50 MB');
    void run('upload', async () => {
      const result = await uploadOrgSkill(file, file.name, uploadCurrent);
      setNotice(`已发布 ${result.name}。要让智能体用上它，去「智能体」页把版本引到这一版。`);
    });
  }

  async function handleConfirmRevoke(reason: string) {
    if (!revokingTarget) return;
    const target = revokingTarget;
    // 不在此处 catch：让网络或业务异常向上抛出给 RevokeDialog 并在弹窗内部展示，保持草稿不丢失。
    const result = await setOrgSkillVersionStatus(
      target.name,
      target.digest,
      'revoke',
      reason,
    );
    setRevokingTarget(null);
    await load();
    // ADR 0015 D8：吊销后展示受影响的 AgentVersion 列表
    setRevokeResult({
      name: target.name,
      digest: target.digest,
      affectedAgentVersionIds: result.affectedAgentVersionIds || [],
    });
  }

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className={a.card}>
        <div className={a.cardHead}>
          <b>发布组织共享 Skill</b>
        </div>
        <p className={a.muted}>
          管理员上传即背书。发布后需要在「智能体」的版本配置里引用具体版本，否则没有 Agent 会带上它。
        </p>
        <div className={a.cardActions}>
          <button type="button" className={a.btnPri} disabled={busy === 'upload'} onClick={() => fileInput.current?.click()}>
            {busy === 'upload' ? '上传中…' : '选择归档'}
          </button>
          <label className={a.check}>
            <input type="checkbox" checked={uploadCurrent} onChange={(e) => setUploadCurrent(e.target.checked)} />
            <span>同时设为当前推荐版本</span>
          </label>
          <input
            ref={fileInput}
            type="file"
            accept=".zip,.skill"
            hidden
            onChange={(e: ChangeEvent<HTMLInputElement>) => { upload(e.target.files); e.target.value = ''; }}
          />
        </div>
      </div>
      {notice ? <p className={a.muted} role="status">{notice}</p> : null}
      {error ? <p className={a.error} role="alert">{error}</p> : null}
      {items == null ? <p className={a.muted}>{error ? '' : '正在读取…'}</p> : null}
      {items && items.length === 0 ? <p className={a.empty}>组织共享层还是空的。</p> : null}
      {items?.map((skill) => (
        <div key={skill.name} className={a.card}>
          <div className={a.cardHead}>
            <b className={a.mono} style={{ fontSize: '14.5px' }}>{skill.name}</b>
            <span className={a.sp} />
            <span className={a.muted}>
              当前推荐 <span className={a.mono}>{shortDigest(skill.currentDigest)}</span>
            </span>
          </div>
          <table className={a.table}>
            <thead>
              <tr>
                <th>版本</th>
                <th>状态</th>
                <th>发布时间</th>
                <th className={a.right}>操作</th>
              </tr>
            </thead>
            <tbody>
              {skill.versions.map((version) => {
                const versionKey = `${skill.name}/${version.contentDigest}`;
                const isCurrent = version.contentDigest === skill.currentDigest;
                return (
                  <tr key={version.contentDigest}>
                    <td className={a.mono}>
                      {shortDigest(version.contentDigest)}
                      {isCurrent ? <span className={`${a.pill} ${a.info}`} style={{ marginLeft: 6 }}>当前</span> : null}
                    </td>
                    <td><Pill value={version.status} table={VERSION_ZH} /></td>
                    <td className={a.num}>{formatDate(version.publishedAt)}</td>
                    <td className={a.right}>
                      <div className={s.actionsGroup}>
                        <button
                          type="button"
                          className={`${a.btn} ${s.tableActionBtn}`}
                          disabled={busy !== null}
                          onClick={() => {
                            setBusy(`m-${versionKey}`);
                            setError(null);
                            getOrgSkillManifest(skill.name, version.contentDigest)
                              .then(onInspectManifest)
                              .catch((err: Error) => setError(err.message || '读取清单失败'))
                              .finally(() => setBusy(null));
                          }}
                        >
                          清单
                        </button>
                        {!isCurrent && version.status === 'active' ? (
                          <button
                            type="button"
                            className={`${a.btn} ${s.tableActionBtn}`}
                            disabled={busy !== null}
                            onClick={() => void run(`c-${versionKey}`, () => setOrgSkillCurrent(skill.name, version.contentDigest))}
                          >
                            设为当前
                          </button>
                        ) : null}
                        {version.status === 'active' ? (
                          <button
                            type="button"
                            className={`${a.btn} ${s.tableActionBtn}`}
                            disabled={busy !== null}
                            onClick={() => void run(`d-${versionKey}`, () => setOrgSkillVersionStatus(skill.name, version.contentDigest, 'deprecate', ''))}
                          >
                            弃用
                          </button>
                        ) : null}
                        {version.status !== 'revoked' ? (
                          <button
                            type="button"
                            className={`${a.btnDanger} ${s.tableActionBtn}`}
                            disabled={busy !== null}
                            onClick={() => setRevokingTarget({ name: skill.name, digest: version.contentDigest })}
                          >
                            吊销
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}

      {/* 吊销确认弹窗 */}
      {revokingTarget ? (
        <RevokeDialog
          skillName={revokingTarget.name}
          digest={revokingTarget.digest}
          onConfirm={handleConfirmRevoke}
          onClose={() => setRevokingTarget(null)}
        />
      ) : null}

      {/* 吊销结果与影响面展示（ADR 0015 D8） */}
      {revokeResult ? (
        <RevokeResultModal
          skillName={revokeResult.name}
          digest={revokeResult.digest}
          affectedAgentVersionIds={revokeResult.affectedAgentVersionIds}
          onClose={() => setRevokeResult(null)}
        />
      ) : null}
    </section>
  );
}

/**
 * 组织共享 Skill：申请队列与 org 层版本管理（ADR 0015 §7.1/§7.2）。
 * 角色与作用域由 agent 判定；这个页面进不来的人拿到的是 403，不是空数据。
 */
export function SkillAdminPage() {
  const [tab, setTab] = useState<Tab>('queue');
  const [inspectingManifest, setInspectingManifest] = useState<SkillManifest | null>(null);
  const tabs = useMemo<Array<[Tab, string]>>(() => [['queue', '共享申请'], ['org', '组织共享层']], []);

  return (
    <div className={a.page}>
      <PageHeader
        title="Skill 共享"
        description="用户申请把自研 Skill 提升到组织共享层；批准后字节复制到组织层，与作者的草稿再无关系。版本一旦被某个智能体引用就不会被回收。"
      />
      <div className={a.tabs} role="tablist" aria-label="Skill 共享分类">
        {tabs.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      {tab === 'queue' ? (
        <QueuePane onInspectManifest={setInspectingManifest} />
      ) : (
        <OrgPane onInspectManifest={setInspectingManifest} />
      )}
      {inspectingManifest ? (
        <ManifestModal
          manifest={inspectingManifest}
          onClose={() => setInspectingManifest(null)}
        />
      ) : null}
    </div>
  );
}
