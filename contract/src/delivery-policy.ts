/**
 * 交付策略（design `agent-output-review.md` §2、ADR 0016 D3）。
 *
 * AgentVersion 的 `deliveryPolicy.mode` 决定这个版本的会话里
 * `submit_artifact` 提交的产物是**直接交付**还是**先进入人工审核**。
 * 它跨越 agent / exec 两侧，因此解析规则放在 contract：
 *
 * - agent 写配置面（`AgentConfigValidator`）与绑定期
 *   （`bindAgentVersionConfig`）都用这里的 `parseDeliveryPolicy`；
 * - agent 在 `POST /internal/v1/sessions/ensure` 时把生效模式压成
 *   `delivery: 'review'` 传给 exec（见 `sessionDeliveryField`）；
 * - exec 用它校验请求体里的 `delivery`，并据此写工作区策略。
 *
 * **默认是 direct。** 省略键 = 现有行为，这条对既有版本不可回退：审核模式
 * 只可能被显式配置，不可能被"字段读错/丢失"意外打开。
 */

/** 交付模式。`direct` 是默认值，省略 `deliveryPolicy` 即它。 */
export const DELIVERY_POLICY_MODES = Object.freeze(['direct', 'review'] as const);

export type DeliveryPolicyMode = (typeof DELIVERY_POLICY_MODES)[number];

/** 省略配置时的模式。 */
export const DEFAULT_DELIVERY_POLICY_MODE: DeliveryPolicyMode = 'direct';

/** AgentVersion 配置里的顶层键（`agent-config-key-vocabulary.ts` 的同名常量）。 */
export const DELIVERY_POLICY_KEY = 'deliveryPolicy';

/** `deliveryPolicy` 里唯一被识别的子键。 */
export const DELIVERY_POLICY_FIELDS = Object.freeze(['mode'] as const);

/**
 * 会话确保请求里的字段名。**只在 review 时才传**：缺席即 direct，
 * 服务端不接受用它把策略改回 direct（策略只能设置、不能撤销）。
 */
export const SESSION_DELIVERY_FIELD = 'delivery';

export interface DeliveryPolicy {
  readonly mode: DeliveryPolicyMode;
}

export interface DeliveryPolicyDiagnostic {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface DeliveryPolicyParseResult {
  /** 解析失败时为 `null`——调用方不得拿半个策略去跑（fail-closed）。 */
  readonly policy: DeliveryPolicy | null;
  readonly errors: readonly DeliveryPolicyDiagnostic[];
}

export const DEFAULT_DELIVERY_POLICY: DeliveryPolicy = Object.freeze({
  mode: DEFAULT_DELIVERY_POLICY_MODE,
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 解析 `configJson.deliveryPolicy`。
 *
 * 省略 / `null` → 默认 direct；形状或取值非法 → `policy: null` + 诊断，
 * 绝不回落到 direct（"配置写错了但按直接交付放行"正是这个功能要防的事）。
 */
export function parseDeliveryPolicy(raw: unknown): DeliveryPolicyParseResult {
  if (raw === undefined || raw === null) {
    return { policy: DEFAULT_DELIVERY_POLICY, errors: [] };
  }
  if (!isPlainObject(raw)) {
    return {
      policy: null,
      errors: [{
        path: DELIVERY_POLICY_KEY,
        code: 'CONFIG_TYPE',
        message: 'deliveryPolicy must be an object',
      }],
    };
  }

  const errors: DeliveryPolicyDiagnostic[] = [];
  for (const key of Object.keys(raw)) {
    if ((DELIVERY_POLICY_FIELDS as readonly string[]).includes(key)) continue;
    errors.push({
      path: `${DELIVERY_POLICY_KEY}.${key}`,
      code: 'CONFIG_UNKNOWN_FIELD',
      message: `Unknown field "${DELIVERY_POLICY_KEY}.${key}"`,
    });
  }

  const rawMode = raw.mode;
  if (rawMode === undefined || rawMode === null || rawMode === '') {
    // 只给了空对象 `{}`：语义等同省略，取默认。
    return errors.length > 0 ? { policy: null, errors } : { policy: DEFAULT_DELIVERY_POLICY, errors };
  }
  if (typeof rawMode !== 'string') {
    errors.push({
      path: `${DELIVERY_POLICY_KEY}.mode`,
      code: 'CONFIG_TYPE',
      message: 'deliveryPolicy.mode must be a string',
    });
    return { policy: null, errors };
  }
  const mode = rawMode.trim().toLowerCase();
  if (!(DELIVERY_POLICY_MODES as readonly string[]).includes(mode)) {
    errors.push({
      path: `${DELIVERY_POLICY_KEY}.mode`,
      code: 'CONFIG_INVALID',
      message: `deliveryPolicy.mode must be ${DELIVERY_POLICY_MODES.join('|')}`,
    });
    return { policy: null, errors };
  }
  if (errors.length > 0) return { policy: null, errors };
  return { policy: Object.freeze({ mode: mode as DeliveryPolicyMode }), errors };
}

/** 规范化后写回配置的形状；direct（默认）返回 `undefined`，即整个键省略。 */
export function normalizedDeliveryPolicy(policy: DeliveryPolicy): Record<string, unknown> | undefined {
  return policy.mode === 'direct' ? undefined : { mode: policy.mode };
}

/**
 * 会话确保请求体里的 `delivery` 字段取值。
 *
 * 只有 review 需要告诉 exec（exec 的写入是 `INSERT IGNORE`，只能设置）。
 * direct 返回 `null` = 不带这个字段。
 */
export function sessionDeliveryField(mode: DeliveryPolicyMode): 'review' | null {
  return mode === 'review' ? 'review' : null;
}

/**
 * 解析 exec 收到的 `delivery` 字段。
 *
 * 返回 `null` 表示"这次请求没有声明策略"（direct 或旧版 Agent），
 * 不表示错误；非法取值抛 `ContractError`。
 */
export function parseSessionDelivery(raw: unknown): 'review' | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') {
    throw new DeliveryPolicyError('delivery must be a string');
  }
  const value = raw.trim().toLowerCase();
  if (value === 'direct') return null;
  if (value !== 'review') {
    throw new DeliveryPolicyError(`delivery must be review (got "${raw}")`);
  }
  return 'review';
}

/**
 * 审核面单件文件的传输上限（修订上传、审核员下载交付物与附件快照）：100 MiB。
 *
 * agent ↔ exec 的内部面是 JSON + HMAC（签名覆盖 `body_sha256`），文件以 base64 放在 JSON 里，
 * 两侧都要整件进内存。Node 22 单个字符串上限约 2^29-24 个字符，超过约 384 MiB 的文件
 * 编码时直接抛 `ERR_STRING_TOO_LONG`（2026-10-01 实测 390 MiB 失败）。100 MiB 远在其下，
 * 也把每次传输的内存峰值限制在几百 MiB 以内。更大的交付物需要流式通道（二期）。
 */
export const REVIEW_TRANSFER_MAX_BYTES = 100 * 1024 * 1024;

/** 交付策略的契约错误；调用方映射成 400 `CONFIG_INVALID`。 */
export class DeliveryPolicyError extends Error {
  readonly code = 'CONFIG_INVALID';
  override name = 'DeliveryPolicyError';
  constructor(message: string) {
    super(message);
  }
}
