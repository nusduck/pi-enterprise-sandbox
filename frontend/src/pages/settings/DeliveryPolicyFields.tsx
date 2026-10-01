import type { ConfigDiagnostic } from '../../shared/api/agents';
import {
  DELIVERY_POLICY_OPTIONS,
  type DeliveryPolicyMode,
} from './deliveryPolicyHelpers';
import s from './agents.module.css';

/**
 * 「交付策略」分类（design `docs/design/agent-output-review.md` §2 / §8）。
 *
 * 两个单选：直接交付（省略键）或交付物需人工审核（`{ mode: 'review' }`）。选 review
 * 时提示一期的两条限制——不能与委派、A2A 暴露同时用；审核期间发起人看不到工作区文件。
 * 互斥由服务端判（`CONFIG_INVALID`），这里只把话说在前面。
 */
export function DeliveryPolicyFields(props: {
  mode: DeliveryPolicyMode;
  errors: ConfigDiagnostic[];
  disabled?: boolean;
  /** 草稿里是否配了委派；用于把「不能同时用」说清楚。 */
  delegationConfigured?: boolean;
  onChange: (mode: DeliveryPolicyMode) => void;
}) {
  const { mode, errors, disabled, delegationConfigured, onChange } = props;
  const topError =
    errors.find((error) => error.path === 'deliveryPolicy' || error.path.startsWith('deliveryPolicy.'))
      ?.message ?? null;
  const conflict = mode === 'review' && delegationConfigured === true;

  return (
    <>
      <p className={s.hint}>
        这个智能体提交的交付物（<code>submit_artifact</code>）是直接交付给发起人，还是先交给审核员审阅。
        会话在创建时绑定智能体版本，因此这个设置对既有会话不生效。
      </p>
      {topError ? <small className={s.fieldError}>{topError}</small> : null}
      {conflict ? (
        <p className={s.warnBox} role="status">
          当前草稿配了「协作（委派）」。审核模式一期不能与委派同时使用（子智能体在自己的工作区提交产物），
          保存时服务端会拒绝。请先清空委派名单。
        </p>
      ) : null}
      <fieldset className={s.mcpCard} disabled={disabled}>
        <div className={s.mcpHead}>
          <b>交付策略</b>
        </div>
        {DELIVERY_POLICY_OPTIONS.map((option) => (
          <label key={option.mode} className={s.delegRow}>
            <input
              type="radio"
              name="delivery-policy-mode"
              value={option.mode}
              checked={mode === option.mode}
              disabled={disabled}
              onChange={() => onChange(option.mode)}
            />
            <span>
              <b>{option.label}</b>
              <small className={s.hint}>{option.hint}</small>
            </span>
          </label>
        ))}
      </fieldset>
    </>
  );
}
