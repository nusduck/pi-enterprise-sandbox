import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { useChat } from '../../features/chat/ChatContext';
import { listSkills, setSkillEnabled, uploadSkillDraft, type SkillItem } from '../../shared/api/capabilities';
import {
  listMySkillShareRequests,
  requestSkillShare,
  withdrawSkillShare,
  type SkillShareRequest,
  type ShareRequestStatus,
} from '../../shared/api/skillSharing';
import { splitSkillTiers } from '../../pages/settings/skillHelpers';
import { usePreference, type Preferences } from '../../shared/ui/preferences';
import { getProfile, updateProfile, type Profile } from '../../shared/api/account';
import { ApiError } from '../../shared/api/client';
import {
  buildProfilePatch,
  draftFromProfile,
  emailNotification,
  fieldErrorForProfileCode,
  isDirty,
  type AccountDraft,
  type AccountErrors,
} from './accountDraft';
import s from './settings.module.css';

type Tab = 'account' | 'general' | 'skills';

const MAX_SKILL_BYTES = 50 * 1024 * 1024;

/** 共享申请的状态文案（ADR 0015 §7.1 状态机）。 */
const SHARE_STATUS_ZH: Record<ShareRequestStatus, string> = {
  pending: '待管理员处理',
  approved: '已批准',
  rejected: '已驳回',
  withdrawn: '已撤回',
  superseded: '已被新申请取代',
};

function Seg<V extends string>({ value, options, onChange, label }: {
  value: V;
  options: Array<[V, string]>;
  onChange: (v: V) => void;
  label: string;
}) {
  return (
    <div className={s.seg} role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)}>{text}</button>
      ))}
    </div>
  );
}

function Row({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className={s.row}>
      <div className={s.rowText}>{title}{hint ? <small>{hint}</small> : null}</div>
      {children}
    </div>
  );
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString('zh-CN', { hour12: false });
}

function AccountPane({ active, onLogout }: { active: boolean; onLogout: () => void }) {
  const { state } = useChat();
  const fallback = state.authUser;
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<AccountDraft>({ display_name: '', email: '', notify_run_complete: false });
  const [fieldError, setFieldError] = useState<AccountErrors>({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const adopt = useCallback((p: Profile) => {
    setProfile(p);
    setDraft(draftFromProfile(p));
    setFieldError({});
  }, []);

  useEffect(() => {
    if (!active || profile) return;
    getProfile().then(adopt).catch((err: Error) => setLoadError(err.message || '读取账户信息失败'));
  }, [active, profile, adopt]);

  const username = profile?.username || String(fallback?.username || '');
  const isAdmin = String(profile?.role || fallback?.role || '').toLowerCase() === 'admin';
  const name = (profile?.display_name || '') || username;
  const editable = new Set(profile?.editable_fields || []);
  const dirty = isDirty(profile, draft);
  const mail = emailNotification(profile);
  // 已经打开的开关总能关掉，即使部署后来撤掉了邮件配置。
  const canToggleNotify = Boolean(profile) && editable.has('notify_run_complete')
    && (mail.available || profile?.notify_run_complete === true);

  async function save() {
    if (!profile) return;
    const { patch, errors } = buildProfilePatch(profile, draft);
    setFieldError(errors);
    if (Object.keys(errors).length) return;
    setSaving(true);
    setNotice(null);
    try {
      adopt(await updateProfile(patch));
      setNotice('已保存。侧栏里的名称在下次打开页面时更新。');
    } catch (err) {
      // The server re-validates; keep the draft so nothing typed is lost.
      const fieldErrors = err instanceof ApiError ? fieldErrorForProfileCode(err.code) : null;
      if (fieldErrors) setFieldError(fieldErrors);
      else setNotice((err as Error).message || '保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <div className={s.profile}>
        <span className={s.avatar} aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
        <div className={s.rowText}>
          <b>{name}</b>
          <small>{username} · {isAdmin ? '管理员' : '普通用户'}</small>
        </div>
        <button type="button" className={s.btn} onClick={onLogout}>退出登录</button>
      </div>
      {loadError ? <p className={s.error} role="alert">{loadError}</p> : null}
      <form
        className={s.form}
        onSubmit={(e) => { e.preventDefault(); void save(); }}
        aria-label="账户资料"
      >
        <label className={s.field}>
          <span>显示名称</span>
          <input
            value={draft.display_name}
            maxLength={255}
            disabled={!profile || !editable.has('display_name') || saving}
            onChange={(e) => setDraft((d) => ({ ...d, display_name: e.target.value }))}
            aria-invalid={Boolean(fieldError.display_name)}
          />
          {fieldError.display_name ? <small className={s.fieldError}>{fieldError.display_name}</small> : null}
        </label>
        <label className={s.field}>
          <span>邮箱</span>
          <input
            type="email"
            value={draft.email}
            maxLength={320}
            placeholder="用于运行完成通知"
            disabled={!profile || !editable.has('email') || saving}
            onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))}
            aria-invalid={Boolean(fieldError.email)}
          />
          {fieldError.email ? <small className={s.fieldError}>{fieldError.email}</small> : <small>留空表示不设置</small>}
        </label>
        <label className={s.check}>
          <input
            type="checkbox"
            checked={draft.notify_run_complete}
            disabled={!canToggleNotify || saving}
            onChange={(e) => setDraft((d) => ({ ...d, notify_run_complete: e.target.checked }))}
            aria-invalid={Boolean(fieldError.notify_run_complete)}
          />
          <span>
            长任务完成邮件通知
            {fieldError.notify_run_complete
              ? <small className={s.fieldError}>{fieldError.notify_run_complete}</small>
              : <small>{!profile
                ? '—'
                : mail.available
                  ? `运行超过 ${mail.threshold ?? '0 秒'}的任务结束（完成、失败或取消）时发邮件到上面的邮箱`
                  : '部署未配置邮件发送，暂不可用'}</small>}
          </span>
        </label>
        <div className={s.formActions}>
          {notice ? <span className={s.muted} role="status">{notice}</span> : null}
          <span className={s.sp} />
          <button type="button" className={s.btn} disabled={!dirty || saving} onClick={() => profile && adopt(profile)}>还原</button>
          <button type="submit" className={s.btnPri} disabled={!dirty || saving}>{saving ? '保存中…' : '保存'}</button>
        </div>
      </form>
      <dl className={s.kv}>
        <dt>用户名</dt><dd>{username || '—'}</dd>
        <dt>机构</dt><dd>{profile?.organization_name || '—'}</dd>
        <dt>用户类型</dt><dd>{isAdmin ? '管理员' : '普通用户'}<span className={s.muted}> · 由管理员设置</span></dd>
        <dt>登录方式</dt><dd>账号密码</dd>
        <dt>账户状态</dt><dd>{profile ? (profile.status === 'active' ? '正常' : '已停用') : '—'}</dd>
        <dt>注册时间</dt><dd>{formatDate(profile?.created_at)}</dd>
        <dt>最近登录</dt><dd>{formatDate(profile?.last_login_at)}</dd>
      </dl>
    </section>
  );
}

function GeneralPane() {
  const [theme, setTheme] = usePreference('theme');
  const [density, setDensity] = usePreference('density');
  const [enter, setEnter] = usePreference('enterWhileRunning');
  return (
    <section>
      <Row title="外观">
        <Seg<Preferences['theme']> label="外观" value={theme} onChange={setTheme}
          options={[['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']]} />
      </Row>
      <Row title="对话显示" hint="已完成轮次里的工具过程">
        <Seg<Preferences['density']> label="对话显示" value={density} onChange={setDensity}
          options={[['compact', '紧凑'], ['expanded', '展开']]} />
      </Row>
      <Row title="运行中按 Enter" hint="⌘Enter / Ctrl+Enter 执行另一种">
        <Seg<Preferences['enterWhileRunning']> label="运行中按 Enter" value={enter} onChange={setEnter}
          options={[['queue', '排队追问'], ['steer', '立即改向']]} />
      </Row>
    </section>
  );
}

function SkillsPane({ active }: { active: boolean }) {
  const [items, setItems] = useState<SkillItem[] | null>(null);
  const [requests, setRequests] = useState<SkillShareRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const res = await listSkills();
    if (!res.available) setError(res.error || 'Skill 列表暂时不可用');
    setItems(res.items);
  }, []);

  const loadRequests = useCallback(async () => {
    try {
      setRequests(await listMySkillShareRequests());
    } catch {
      // 申请列表读不到不该把「我能用哪些 Skill」也一起弄没：退化成「未知」，
      // 而不是显示成「没有申请」——后者会让人以为申请丢了。
      setRequests(null);
    }
  }, []);

  useEffect(() => {
    if (active && items == null) void load();
    if (active && requests == null) void loadRequests();
  }, [active, items, requests, load, loadRequests]);

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
      await Promise.all([load(), loadRequests()]);
    } catch (err) {
      const api = err as { code?: string | null };
      if (api.code === 'SKILL_NAME_RESERVED_BY_ORG') {
        setError('这个名字已被组织共享层占用，不能启用同名的个人 Skill。');
      } else if (api.code === 'SKILL_NOT_ENABLED') {
        setError('只有已启用的版本才能申请共享。');
      } else {
        setError((err as Error).message || '操作失败');
      }
    } finally {
      setBusy(null);
    }
  }

  function upload(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    if (!/\.(zip|skill)$/i.test(file.name)) return setError('只支持 .zip 或 .skill 包');
    if (file.size > MAX_SKILL_BYTES) return setError('单个包不能超过 50 MB');
    void run('upload', () => uploadSkillDraft(file));
  }

  const tiers = splitSkillTiers(items || []);
  // 同名已有一条 pending 时按钮换成「申请中」：重复点会 supersede 掉旧申请，
  // 那会让「我上次写了什么说明」无声消失。
  const pendingNames = new Set(
    (requests || []).filter((r) => r.status === 'pending').map((r) => r.name),
  );
  const myPending = (requests || []).filter((r) => r.status === 'pending');

  return (
    <section>
      <div
        className={`${s.drop}${dragging ? ` ${s.dropOn}` : ''}`}
        onDragOver={(e: DragEvent) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e: DragEvent) => { e.preventDefault(); setDragging(false); upload(e.dataTransfer.files); }}
      >
        把 .zip 或 .skill 包拖到这里，或
        <button type="button" className={s.btn} disabled={busy === 'upload'} onClick={() => input.current?.click()}>
          {busy === 'upload' ? '上传中…' : '选择文件'}
        </button>
        <small>上传后进入草稿，启用后才会被智能体使用 · 单包 50 MB 以内</small>
        <input
          ref={input}
          type="file"
          accept=".zip,.skill"
          hidden
          onChange={(e: ChangeEvent<HTMLInputElement>) => { upload(e.target.files); e.target.value = ''; }}
        />
      </div>
      {error ? <p className={s.err} role="alert">{error}</p> : null}
      {notice ? <p className={s.muted} role="status">{notice}</p> : null}
      {items == null ? <p className={s.muted}>正在读取…</p> : null}

      <h3 className={s.sub}>草稿</h3>
      {tiers.drafts.length === 0 && items ? <p className={s.muted}>没有待启用的草稿</p> : null}
      {tiers.drafts.map((skill) => (
        <div key={`d-${skill.name}`} className={s.skill}>
          <span className={s.skillName}>{skill.name}</span>
          <button type="button" className={s.btnPri} disabled={busy === skill.name} onClick={() => void run(String(skill.name), () => setSkillEnabled(String(skill.name), true))}>启用</button>
          {skill.description ? <small>{skill.description}</small> : null}
        </div>
      ))}

      <h3 className={s.sub}>已启用</h3>
      {tiers.user.length === 0 && items ? <p className={s.muted}>还没有启用自己的 Skill</p> : null}
      {tiers.user.map((skill) => {
        const name = String(skill.name || '');
        const requested = pendingNames.has(name);
        return (
          <div key={`u-${name}`} className={s.skill}>
            <span className={s.skillName}>
              {name}
              {tiers.publishedFromDraft.has(name) ? <span className={s.tag}>来自草稿</span> : null}
            </span>
            <button
              type="button"
              className={s.btn}
              disabled={busy !== null || requested}
              title={requested ? '已有一条待处理的申请' : '把这个版本提升到组织共享层'}
              onClick={() => void run(`share-${name}`, async () => {
                await requestSkillShare(name);
                setNotice(`已提交「${name}」的共享申请，等管理员处理。`);
              })}
            >
              {requested ? '申请中' : '申请共享'}
            </button>
            <button type="button" className={s.btn} disabled={busy === name} onClick={() => void run(name, () => setSkillEnabled(name, false))}>停用</button>
            {skill.description ? <small>{skill.description}</small> : null}
          </div>
        );
      })}
      <p className={s.muted}>要重新发布改过的草稿，先停用，草稿会回到上面的列表。</p>

      <h3 className={s.sub}>我的共享申请</h3>
      {requests == null ? <p className={s.muted}>申请列表现不可用</p> : null}
      {requests && requests.length === 0 ? <p className={s.muted}>还没有提交过共享申请</p> : null}
      {requests?.map((request) => (
        <div key={request.requestId} className={s.skill}>
          <span className={s.skillName}>{request.name}</span>
          <span className={s.tag}>{SHARE_STATUS_ZH[request.status] || request.status}</span>
          {request.status === 'pending' ? (
            <button
              type="button"
              className={s.btn}
              disabled={busy === request.requestId}
              onClick={() => void run(request.requestId, async () => {
                await withdrawSkillShare(request.requestId);
                setNotice(`已撤回「${request.name}」的共享申请。`);
              })}
            >
              撤回
            </button>
          ) : null}
          {request.decisionNote ? <small>管理员说明：{request.decisionNote}</small> : null}
        </div>
      ))}
      {myPending.length > 0 ? <p className={s.muted}>申请由本组织管理员审批；批准后进入组织共享层，与你的草稿不再联动。</p> : null}
    </section>
  );
}

/**
 * Personal settings in a modal: account, general preferences and the user's
 * own Skills. Deployment-wide configuration lives in the admin console.
 */
export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { logout } = useChat();
  const [tab, setTab] = useState<Tab>('account');

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const tabs: Array<[Tab, string]> = [['account', '账户'], ['general', '通用'], ['skills', '我的 Skills']];
  return (
    <dialog ref={ref} className={s.dialog} onClose={onClose} aria-label="设置">
      <div className={s.layout}>
        <nav className={s.nav} role="tablist" aria-label="设置分类">
          <h2>设置</h2>
          {tabs.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>
          ))}
        </nav>
        <div className={s.main}>
          <div className={s.close}>
            <button type="button" className={s.btn} onClick={onClose}>关闭</button>
          </div>
          <div hidden={tab !== 'account'}><AccountPane active={open && tab === 'account'} onLogout={() => { onClose(); void logout(); }} /></div>
          <div hidden={tab !== 'general'}><GeneralPane /></div>
          <div hidden={tab !== 'skills'}><SkillsPane active={open && tab === 'skills'} /></div>
        </div>
      </div>
    </dialog>
  );
}
