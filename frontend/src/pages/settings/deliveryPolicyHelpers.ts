/**
 * 「交付策略」分类的纯函数：读写 AgentVersion 配置的 `deliveryPolicy` 键
 * （design `docs/design/agent-output-review.md` §2 / §8）。
 *
 * 服务端仍是语义权威（`contract/src/delivery-policy.ts` 的 `parseDeliveryPolicy`）。
 * 这里只保证两件事：
 *
 * 1. **`direct` 时删掉整个键**——contract 的「省略即 direct」是既有版本
 *    `config_hash` 不变的保证，写回 `{ mode: 'direct' }` 会平白改掉哈希；
 * 2. 结构不对（`deliveryPolicy` 不是对象、`mode` 不是字符串）时**暂停这个分类**，
 *    让用户去 JSON 里修，而不是覆盖掉原值。
 */
import { cloneAgentConfig } from './agentHelpers';

/** 与 `contract/src/delivery-policy.ts` 的 `DELIVERY_POLICY_KEY` 一致。 */
export const DELIVERY_POLICY_KEY = 'deliveryPolicy';

export type DeliveryPolicyMode = 'direct' | 'review';

export const DELIVERY_POLICY_OPTIONS: ReadonlyArray<{
  mode: DeliveryPolicyMode;
  label: string;
  hint: string;
}> = [
  {
    mode: 'direct',
    label: '直接交付',
    hint: '智能体提交的交付物直接出现在会话与产物库里（既有行为）。',
  },
  {
    mode: 'review',
    label: '交付物需人工审核',
    hint:
      '交付物先进入审核池，审核员通过后发起人才能看到。一期不能与「协作（委派）」或 A2A 暴露同时使用；' +
      '审核期间发起人看不到工作区文件。',
  },
];

function plainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 读草稿里的模式；省略或结构不对时按 `direct` 展示（服务端也会拒绝非法值）。 */
export function deliveryPolicyOf(config: Record<string, unknown>): DeliveryPolicyMode {
  const policy = plainObject(config[DELIVERY_POLICY_KEY]);
  const mode = policy?.mode;
  return mode === 'review' ? 'review' : 'direct';
}

/** 结构不对时暂停「交付策略」分类。 */
export function deliveryPolicyStructureIssues(config: Record<string, unknown>): string[] {
  const raw = config[DELIVERY_POLICY_KEY];
  if (raw == null) return [];
  const policy = plainObject(raw);
  if (!policy) return ['deliveryPolicy must be an object'];
  const mode = policy.mode;
  if (mode != null && mode !== '' && typeof mode !== 'string') {
    return ['deliveryPolicy.mode must be a string'];
  }
  return [];
}

/**
 * 写入模式。`direct` 删掉整个键（省略即默认），未知子键原样保留，由服务端报
 * `CONFIG_UNKNOWN_FIELD`。
 */
export function setDeliveryPolicyMode(
  config: Record<string, unknown>,
  mode: DeliveryPolicyMode,
): Record<string, unknown> {
  if (deliveryPolicyStructureIssues(config).length) return cloneAgentConfig(config);
  const next = cloneAgentConfig(config);
  if (mode === 'direct') {
    delete next[DELIVERY_POLICY_KEY];
    return next;
  }
  next[DELIVERY_POLICY_KEY] = { ...(plainObject(next[DELIVERY_POLICY_KEY]) ?? {}), mode };
  return next;
}

/** 这个草稿是不是 review 模式（用于提示与「不能与委派同时用」的联动提示）。 */
export function deliveryPolicyIsReview(config: Record<string, unknown>): boolean {
  return deliveryPolicyOf(config) === 'review';
}
