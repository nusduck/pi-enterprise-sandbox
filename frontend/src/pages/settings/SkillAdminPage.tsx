import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  approveSkillShare,
  getOrgSkillManifest,
  getShareRequestManifest,
  listOrgSkills,
  listSkillShareQueue,
  rejectSkillShare,
  setOrgSkillCurrent,
  setOrgSkillVersionStatus,
  uploadOrgSkill,
  type OrgSkillName,
  type ShareRequestStatus,
  type SkillManifest,
  type SkillShareRequest,
} from '../../shared/api/skillSharing';
import s from './adminPage.module.css';

type Tab = 'queue' | 'org';

const STATUS_ZH: Record<ShareRequestStatus, [string, string]> = {
  pending: ['待处理', s.warn],
  approved: ['已批准', s.ok],
  rejected: ['已驳回', s.err],
  withdrawn: ['已撤回', s.mute],
  superseded: ['已被新申请取代', s.mute],
};

const VERSION_ZH: Record<string, [string, string]> = {
  active: ['可用', s.ok],
  deprecated: ['已弃用', s.warn],
  revoked: ['已吊销', s.err],
};

const MAX_SKILL_BYTES = 50 * 1024 * 1024;

function Pill({ value, table }: { value: string; table: Record<string, [string, string]> }) {
  const [label, cls] = table[value] || [value, s.mute];
  return <span className={`${s.pill} ${cls}`}>{label}</span>;
}

function shortDigest(digest: string): string {
  return digest ? digest.slice(0, 12) : '—';
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString('zh-CN', { hour12: false });
}

/** 文件清单 + 截断的 SKILL.md：批准前唯一能看到的「这个包是什么」。 */
function ManifestView({ manifest }: { manifest: SkillManifest }) {
  return (
    <div className={s.manifest}>
      <div className={s.muted}>
        {manifest.fileCount} 个文件 · {manifest.totalBytes} 字节 · 摘要 {shortDigest(manifest.contentDigest)}
      </div>
      <details>
        <summary>文件清单</summary>
        <ul className={s.files}>
          {manifest.files.map((file) => (
            <li key={file.path}><span className={s.mono}>{file.path}</span> <span className={s.muted}>{file.bytes}</span></li>
          ))}
        </ul>
      </details>
      <details>
        <summary>SKILL.md{manifest.truncated ? '（已截断）' : ''}</summary>
        <pre className={s.pre}>{manifest.skillMd}</pre>
      </details>
    </div>
  );
}

/** 谁的申请：管理员只看得到被申请的那一个版本（design §7.1）。 */
function RequestRow({
  request,
  onChanged,
}: {
  request: SkillShareRequest;
  onChanged: () => Promise<void>;
}) {
  const [manifest, setManifest] = useState<SkillManifest | null>(null);
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
      // 批准失败时申请**保持 pending**（服务端先字节后状态），所以这里只报错、
      // 不把行从队列里拿掉——拿掉会让管理员以为已经处理完了。
      setError((err as Error).message || '操作失败');
    } finally {
      setBusy(null);
    }
  }

  const pending = request.status === 'pending';
  return (
    <div className={s.card}>
      <div className={s.cardHead}>
        <b className={s.mono}>{request.name}</b>
        <Pill value={request.status} table={STATUS_ZH} />
        <span className={s.sp} />
        <span className={s.muted}>{formatDate(request.createdAt)}</span>
      </div>
      <div className={s.muted}>摘要 {shortDigest(request.contentDigest)}</div>
      {request.note ? <p className={s.note}>申请说明：{request.note}</p> : null}
      {request.decisionNote ? <p className={s.note}>决定说明：{request.decisionNote}</p> : null}
      <div className={s.cardActions}>
        <button
          type="button"
          className={s.btn}
          disabled={busy !== null}
          onClick={() => {
            setBusy('manifest');
            setError(null);
            getShareRequestManifest(request.requestId)
              .then(setManifest)
              .catch((err: Error) => setError(err.message || '读取清单失败'))
              .finally(() => setBusy(null));
          }}
        >
          查看清单
        </button>
        {pending ? (
          <>
            <input
              className={s.input}
              placeholder="说明（驳回必填）"
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
            />
            <button type="button" className={s.btnPri} disabled={busy !== null} onClick={() => void decide('approve')}>
              {busy === 'approve' ? '批准中…' : '批准'}
            </button>
            <button
              type="button"
              className={s.btnDanger}
              disabled={busy !== null || note.trim() === ''}
              title={note.trim() === '' ? '驳回必须填写原因' : undefined}
              onClick={() => void decide('reject')}
            >
              {busy === 'reject' ? '驳回中…' : '驳回'}
            </button>
          </>
        ) : null}
      </div>
      {error ? <p className={s.error} role="alert">{error}</p> : null}
      {manifest ? <ManifestView manifest={manifest} /> : null}
    </div>
  );
}

function QueuePane() {
  const [filter, setFilter] = useState<ShareRequestStatus | 'all'>('pending');
  const [items, setItems] = useState<SkillShareRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems(await listSkillShareQueue(filter === 'all' ? undefined : filter));
    } catch (err) {
      // 读取失败**不**显示成空队列：那会让管理员以为没人申请。
      setItems(null);
      setError((err as Error).message || '读取申请队列失败');
    }
  }, [filter]);

  useEffect(() => { void load(); }, [load]);

  return (
    <section>
      <div className={s.seg} role="group" aria-label="申请状态">
        {(['pending', 'all', 'approved', 'rejected'] as const).map((v) => (
          <button key={v} type="button" aria-pressed={filter === v} onClick={() => setFilter(v)}>
            {v === 'all' ? '全部' : STATUS_ZH[v][0]}
          </button>
        ))}
      </div>
      {error ? <p className={s.error} role="alert">{error}</p> : null}
      {items == null ? <p className={s.muted}>{error ? '' : '正在读取…'}</p> : null}
      {items && items.length === 0 ? <p className={s.empty}>没有申请。</p> : null}
      {items?.map((request) => (
        <RequestRow key={request.requestId} request={request} onChanged={load} />
      ))}
    </section>
  );
}

function OrgPane() {
  const [items, setItems] = useState<OrgSkillName[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reason, setReason] = useState<Record<string, string>>({});
  const [manifest, setManifest] = useState<SkillManifest | null>(null);
  const [uploadCurrent, setUploadCurrent] = useState(false);
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

  return (
    <section>
      <div className={s.card}>
        <div className={s.cardHead}>
          <b>发布组织共享 Skill</b>
        </div>
        <p className={s.muted}>
          管理员上传即背书。发布后需要在「智能体」的版本配置里引用具体版本，否则没有 Agent 会带上它。
        </p>
        <div className={s.cardActions}>
          <button type="button" className={s.btnPri} disabled={busy === 'upload'} onClick={() => fileInput.current?.click()}>
            {busy === 'upload' ? '上传中…' : '选择归档'}
          </button>
          <label className={s.check}>
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
      {notice ? <p className={s.muted} role="status">{notice}</p> : null}
      {error ? <p className={s.error} role="alert">{error}</p> : null}
      {items == null ? <p className={s.muted}>{error ? '' : '正在读取…'}</p> : null}
      {items && items.length === 0 ? <p className={s.empty}>组织共享层还是空的。</p> : null}
      {items?.map((skill) => (
        <div key={skill.name} className={s.card}>
          <div className={s.cardHead}>
            <b className={s.mono}>{skill.name}</b>
            <span className={s.sp} />
            <span className={s.muted}>当前推荐 {shortDigest(skill.currentDigest)}</span>
          </div>
          <table className={s.table}>
            <thead><tr><th>版本</th><th>状态</th><th>发布</th><th className={s.right}>操作</th></tr></thead>
            <tbody>
              {skill.versions.map((version) => {
                const versionKey = `${skill.name}/${version.contentDigest}`;
                const isCurrent = version.contentDigest === skill.currentDigest;
                return (
                  <tr key={version.contentDigest}>
                    <td className={s.mono}>
                      {shortDigest(version.contentDigest)}
                      {isCurrent ? <span className={`${s.pill} ${s.info}`} style={{ marginLeft: 6 }}>当前</span> : null}
                    </td>
                    <td><Pill value={version.status} table={VERSION_ZH} /></td>
                    <td className={s.num}>{formatDate(version.publishedAt)}</td>
                    <td className={s.right}>
                      <button
                        type="button"
                        className={s.btn}
                        disabled={busy !== null}
                        onClick={() => {
                          setBusy(`m-${versionKey}`);
                          setError(null);
                          getOrgSkillManifest(skill.name, version.contentDigest)
                            .then(setManifest)
                            .catch((err: Error) => setError(err.message || '读取清单失败'))
                            .finally(() => setBusy(null));
                        }}
                      >
                        清单
                      </button>
                      {!isCurrent && version.status === 'active' ? (
                        <button
                          type="button"
                          className={s.btn}
                          disabled={busy !== null}
                          onClick={() => void run(`c-${versionKey}`, () => setOrgSkillCurrent(skill.name, version.contentDigest))}
                        >
                          设为当前
                        </button>
                      ) : null}
                      {version.status === 'active' ? (
                        <button
                          type="button"
                          className={s.btn}
                          disabled={busy !== null}
                          onClick={() => void run(`d-${versionKey}`, () => setOrgSkillVersionStatus(skill.name, version.contentDigest, 'deprecate', reason[versionKey] || ''))}
                        >
                          弃用
                        </button>
                      ) : null}
                      {version.status !== 'revoked' ? (
                        <button
                          type="button"
                          className={s.btnDanger}
                          disabled={busy !== null}
                          title={!reason[versionKey]?.trim() ? '吊销是安全动作，请先填写原因' : undefined}
                          onClick={() => void run(`r-${versionKey}`, () => setOrgSkillVersionStatus(skill.name, version.contentDigest, 'revoke', reason[versionKey] || ''))}
                        >
                          吊销
                        </button>
                      ) : null}
                      <input
                        className={s.input}
                        placeholder="原因"
                        value={reason[versionKey] || ''}
                        maxLength={500}
                        onChange={(e) => setReason((prev) => ({ ...prev, [versionKey]: e.target.value }))}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
      {manifest ? (
        <div className={s.card}>
          <div className={s.cardHead}><b className={s.mono}>{manifest.name}</b><span className={s.sp} /><button type="button" className={s.btn} onClick={() => setManifest(null)}>关闭</button></div>
          <ManifestView manifest={manifest} />
        </div>
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
  const tabs = useMemo<Array<[Tab, string]>>(() => [['queue', '共享申请'], ['org', '组织共享层']], []);
  return (
    <div className={s.page}>
      <div className={s.head}>
        <div>
          <h1>Skill 共享</h1>
          <p>用户申请把自研 Skill 提升到组织共享层；批准后字节复制到组织层，与作者的草稿再无关系。版本一旦被某个智能体引用就不会被回收。</p>
        </div>
      </div>
      <div className={s.tabs} role="tablist" aria-label="Skill 共享分类">
        {tabs.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      {tab === 'queue' ? <QueuePane /> : <OrgPane />}
    </div>
  );
}
