import type { ConfigDiagnostic } from '../../shared/api/agents';
import type { CatalogState } from './agentHelpers';
import type { OrgSkillCandidate, SkillCandidate, SkillPolicyView } from './skillPolicyHelpers';
import s from './agents.module.css';

export type SkillPolicyFieldsProps = {
  /** `null` = 配置里没有这个键（省略 = 当前行为），页面照实显示。 */
  view: SkillPolicyView | null;
  system: CatalogState<SkillCandidate>;
  org: CatalogState<OrgSkillCandidate>;
  max: number;
  errors: ConfigDiagnostic[];
  disabled?: boolean;
  onChange: (next: SkillPolicyView) => void;
};

/** 省略 skillPolicy 时页面用的起点：与服务端缺省语义一致（全部系统 + 用户启用）。 */
const DEFAULT_VIEW: SkillPolicyView = {
  systemMode: 'all',
  systemNames: [],
  org: [],
  user: 'allow',
};

const MODE_LABELS: ReadonlyArray<[SkillPolicyView['systemMode'], string, string]> = [
  ['all', '全部系统技能', '随平台发布更新，不需要重新配置'],
  ['allowlist', '只选这些', '目录更短、误触发面更小'],
  ['none', '不带系统技能', ''],
];

function errorAt(errors: ConfigDiagnostic[], path: string): string | null {
  return errors.find((error) => error.path === path)?.message ?? null;
}

/**
 * 「技能」分类（ADR 0015 D1/D2，design §4.1/§4.2）。
 *
 * 三层各有各的问题，这个组件把它们分开呈现：
 * - **系统层**按名选择。名单里的名字是**保存时**对着当前 release 校验的，所以
 *   release 换掉之后旧版本会拿到 `SKILL_SYSTEM_UNKNOWN`——那只影响**新绑定**，
 *   已钉住的版本照跑（design §12）。这里不做猜测，服务端的报错原样落到字段上。
 * - **org 层**钉摘要而不是跟随最新（ADR 0015 D3）：同一个 AgentVersion 在不同时间
 *   必须行为一致，否则审计回答不了「那次 Run 用的是哪版」。所以选的是一个**版本**。
 * - **用户层**只是一个开关：带不带调用者自己启用的技能。
 */
export function SkillPolicyFields({
  view,
  system,
  org,
  max,
  errors,
  disabled,
  onChange,
}: SkillPolicyFieldsProps) {
  const policy = view ?? DEFAULT_VIEW;
  const set = (patch: Partial<SkillPolicyView>) => onChange({ ...policy, ...patch });
  const topError = errorAt(errors, 'skillPolicy');
  const modeError = errorAt(errors, 'skillPolicy.system.mode');
  const namesError = errorAt(errors, 'skillPolicy.system.names');
  const userError = errorAt(errors, 'skillPolicy.user');

  const toggleSystemName = (name: string) => {
    const has = policy.systemNames.includes(name);
    set({
      systemNames: has
        ? policy.systemNames.filter((item) => item !== name)
        : [...policy.systemNames, name],
    });
  };

  const toggleOrg = (candidate: OrgSkillCandidate) => {
    const bound = policy.org.find((entry) => entry.name === candidate.name);
    if (bound) {
      set({ org: policy.org.filter((entry) => entry.name !== candidate.name) });
      return;
    }
    // 钉「服务端的当前推荐版本」；没有 current 就取第一个 active。
    const preferred = candidate.versions.find((v) => v.contentDigest === candidate.currentDigest)
      ?? candidate.versions.find((v) => v.status === 'active')
      ?? candidate.versions[0];
    if (!preferred) return;
    set({ org: [...policy.org, { name: candidate.name, contentDigest: preferred.contentDigest }] });
  };

  return (
    <>
      <p className={s.hint}>
        选择这个智能体每次运行带哪些技能。系统技能随平台发布更新；组织共享技能由管理员发布，
        绑定的是<strong>具体版本</strong>——升级要生成新的智能体版本，运行中的会话不受影响。
      </p>
      {topError ? <small className={s.fieldError}>{topError}</small> : null}
      {view === null ? (
        <p className={s.hint}>这个版本没有设置过技能策略，当前行为是「全部系统技能 + 调用者自己启用的技能」。</p>
      ) : null}

      <fieldset className={s.mcpCard} disabled={disabled}>
        <div className={s.mcpHead}>
          <b>系统技能</b>
        </div>
        {MODE_LABELS.map(([mode, label, note]) => (
          <label key={mode} className={s.delegRow}>
            <input
              type="radio"
              name="skill-system-mode"
              checked={policy.systemMode === mode}
              disabled={disabled}
              onChange={() => set({ systemMode: mode })}
            />
            <span>{label}</span>
            {note ? <span className={s.hint}>{note}</span> : null}
          </label>
        ))}
        {modeError ? <small className={`${s.fieldError} ${s.delegError}`}>{modeError}</small> : null}

        {policy.systemMode === 'allowlist' ? (
          <>
            <div className={s.mcpHead}>
              <b>选中的系统技能</b>
              <span className={s.sp} />
              <span className={s.tag}>已选 {policy.systemNames.length} / {max}</span>
            </div>
            {system.loading ? <p className={s.hint}>正在读取…</p> : null}
            {!system.loading && !system.available ? (
              <p className={s.warnBox} role="status">
                系统技能目录暂不可用{system.error ? `（${system.error}）` : ''}。草稿里已有的名字会保留，恢复前不能新增。
              </p>
            ) : null}
            {namesError ? <small className={`${s.fieldError} ${s.delegError}`}>{namesError}</small> : null}
            <div className={s.delegList}>
              {(system.available ? system.items : []).map((candidate) => {
                const index = policy.systemNames.indexOf(candidate.name);
                const checked = index >= 0;
                const fieldError = checked ? errorAt(errors, `skillPolicy.system.names[${index}]`) : null;
                return (
                  <label key={candidate.name} className={s.delegRow}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => toggleSystemName(candidate.name)}
                    />
                    <b>{candidate.name}</b>
                    <small className={s.delegDesc}>{candidate.description}</small>
                    {fieldError ? <small className={s.fieldError}>{fieldError}</small> : null}
                  </label>
                );
              })}
            </div>
            {/* 名单里但目录里已经没有的名字：不静默丢掉，明确标出来。 */}
            {system.available
              ? policy.systemNames
                .filter((name) => !system.items.some((item) => item.name === name))
                .map((name) => (
                  <p key={name} className={s.warnBox} role="status">
                    「{name}」不在当前平台的系统技能里，保存会被拒绝。移除它，或等平台补上这个技能。
                  </p>
                ))
              : null}
          </>
        ) : null}
      </fieldset>

      <fieldset className={s.mcpCard} disabled={disabled}>
        <div className={s.mcpHead}>
          <b>组织共享技能</b>
          <span className={s.sp} />
          <span className={s.tag}>已选 {policy.org.length}</span>
        </div>
        <p className={s.hint}>
          由本组织管理员发布，所有使用这个智能体的人都能用。绑定的是发布时的版本，
          管理员之后发布新版本不会自动改变这个智能体。
        </p>
        {org.loading ? <p className={s.hint}>正在读取…</p> : null}
        {!org.loading && !org.items.length ? <p className={s.hint}>这个组织还没有共享技能。</p> : null}
        <div className={s.delegList}>
          {org.items.map((candidate) => {
            const bound = policy.org.find((entry) => entry.name === candidate.name);
            const boundIndex = policy.org.findIndex((entry) => entry.name === candidate.name);
            const fieldError = boundIndex >= 0
              ? errorAt(errors, `skillPolicy.org[${boundIndex}].contentDigest`)
                ?? errorAt(errors, `skillPolicy.org[${boundIndex}].name`)
              : null;
            return (
              <label key={candidate.name} className={s.delegRow}>
                <input
                  type="checkbox"
                  checked={Boolean(bound)}
                  disabled={disabled}
                  onChange={() => toggleOrg(candidate)}
                />
                <b>{candidate.name}</b>
                <small className={s.delegDesc}>{candidate.description}</small>
                {bound ? (
                  <span className={s.tag} title={bound.contentDigest}>
                    {bound.contentDigest.slice(0, 12)}
                  </span>
                ) : null}
                {fieldError ? <small className={`${s.fieldError} ${s.delegError}`}>{fieldError}</small> : null}
              </label>
            );
          })}
        </div>
      </fieldset>

      <fieldset className={s.mcpCard} disabled={disabled}>
        <div className={s.mcpHead}>
          <b>调用者自己的技能</b>
        </div>
        <label className={s.delegRow}>
          <input
            type="checkbox"
            checked={policy.user === 'allow'}
            disabled={disabled}
            onChange={(event) => set({ user: event.target.checked ? 'allow' : 'deny' })}
          />
          <span>带上使用者在「能力」页自己启用的技能</span>
        </label>
        {userError ? <small className={`${s.fieldError} ${s.delegError}`}>{userError}</small> : null}
      </fieldset>
    </>
  );
}
