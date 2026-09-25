import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { useChat } from '../../features/chat/ChatContext';
import { listSkills, setSkillEnabled, uploadSkillDraft, type SkillItem } from '../../shared/api/capabilities';
import { splitSkillTiers } from '../../pages/settings/skillHelpers';
import { usePreference, type Preferences } from '../../shared/ui/preferences';
import { getProfile, updateProfile, type Profile } from '../../shared/api/account';
import s from './settings.module.css';

type Tab = 'account' | 'general' | 'skills';

const MAX_SKILL_BYTES = 50 * 1024 * 1024;

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

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function AccountPane({ active, onLogout }: { active: boolean; onLogout: () => void }) {
  const { state } = useChat();
  const fallback = state.authUser;
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ display_name: '', email: '' });
  const [fieldError, setFieldError] = useState<{ display_name?: string; email?: string }>({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const adopt = useCallback((p: Profile) => {
    setProfile(p);
    setDraft({ display_name: p.display_name || '', email: p.email || '' });
  }, []);

  useEffect(() => {
    if (!active || profile) return;
    getProfile().then(adopt).catch((err: Error) => setLoadError(err.message || '读取账户信息失败'));
  }, [active, profile, adopt]);

  const username = profile?.username || String(fallback?.username || '');
  const isAdmin = String(profile?.role || fallback?.role || '').toLowerCase() === 'admin';
  const name = (profile?.display_name || '') || username;
  const editable = new Set(profile?.editable_fields || []);
  const dirty = Boolean(profile) && (
    draft.display_name.trim() !== (profile?.display_name || '') || draft.email.trim() !== (profile?.email || '')
  );

  async function save() {
    if (!profile) return;
    const errors: { display_name?: string; email?: string } = {};
    const displayName = draft.display_name.trim();
    const email = draft.email.trim();
    if (!displayName) errors.display_name = '显示名称不能为空';
    else if (displayName.length > 255) errors.display_name = '最多 255 个字符';
    if (email && (email.length > 320 || !EMAIL.test(email))) errors.email = '邮箱格式不正确';
    setFieldError(errors);
    if (Object.keys(errors).length) return;
    const patch: { display_name?: string; email?: string | null } = {};
    if (displayName !== (profile.display_name || '')) patch.display_name = displayName;
    if (email !== (profile.email || '')) patch.email = email || null;
    setSaving(true);
    setNotice(null);
    try {
      adopt(await updateProfile(patch));
      setNotice('已保存。侧栏里的名称在下次打开页面时更新。');
    } catch (err) {
      // The server re-validates; keep the draft so nothing typed is lost.
      setNotice((err as Error).message || '保存失败');
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const res = await listSkills();
    if (!res.available) setError(res.error || 'Skill 列表暂时不可用');
    setItems(res.items);
  }, []);

  useEffect(() => {
    if (active && items == null) void load();
  }, [active, items, load]);

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
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
    void run('upload', () => uploadSkillDraft(file));
  }

  const tiers = splitSkillTiers(items || []);
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
      {tiers.user.map((skill) => (
        <div key={`u-${skill.name}`} className={s.skill}>
          <span className={s.skillName}>
            {skill.name}
            {tiers.publishedFromDraft.has(skill.name) ? <span className={s.tag}>来自草稿</span> : null}
          </span>
          <button type="button" className={s.btn} disabled={busy === skill.name} onClick={() => void run(String(skill.name), () => setSkillEnabled(String(skill.name), false))}>停用</button>
          {skill.description ? <small>{skill.description}</small> : null}
        </div>
      ))}
      <p className={s.muted}>要重新发布改过的草稿，先停用，草稿会回到上面的列表。</p>
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
