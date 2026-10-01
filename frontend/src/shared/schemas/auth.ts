/**
 * 登录能力投影（`GET /api/auth/config`）的强类型 DTO 与展示判定。
 *
 * 权威在 Agent（login 能力），BFF 只代理；前端把服务端事实投影成 UI 状态，
 * 不自己生成登录方式。SSO 到 P3 之前都必须是「不可用」：`sso.available` 只有
 * 服务端明确给 true 才成立，字段缺失/模式未知一律按不可用处理（fail-closed），
 * 避免 disabled 的 SSO 出现可点击的假入口。
 */
import { z } from 'zod';

const LocalMethodSchema = z
  .object({
    enabled: z.boolean(),
    registration_enabled: z.boolean().optional().default(false),
  })
  .passthrough();

const SsoMethodSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    // disabled 的 SSO 必须 available=false；这里不预设默认 true。
    available: z.boolean().optional().default(false),
    label: z.string().optional(),
  })
  .passthrough();

/**
 * 契约本体（fail-closed）：
 * - `mode` 必须是非空字符串。未知模式原样保留（`projectLoginCapabilities`
 *   负责诊断），但不能缺失、为空或不是字符串——那说明 DTO 根本不是配置投影。
 * - `methods` 至少要声明一种已识别的登录方式（local / sso）。`{}` 或整个字段
 *   缺失都是坏 DTO，不能投影成「部署没有开放登录方式」。
 * - 字段默认值保持既有规则：省略 registration_enabled / sso.enabled /
 *   sso.available 一律按 false，disabled 的 SSO 不得变成可用入口。
 */
export const AuthConfigSchema = z
  .object({
    mode: z.string().min(1),
    methods: z
      .object({
        local: LocalMethodSchema.optional(),
        sso: SsoMethodSchema.optional(),
      })
      .passthrough()
      .refine((methods) => methods.local !== undefined || methods.sso !== undefined, {
        message: 'methods must declare at least one recognized login method (local/sso)',
      }),
    profile_policy: z
      .object({ editable_fields: z.array(z.string()).optional().default([]) })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type AuthConfig = z.infer<typeof AuthConfigSchema>;
export type AuthMethodConfig = AuthConfig['methods'];

export type LoginCapabilities = {
  /** 部署当前声明的登录模式（缺失/未知时原样透出，供诊断文案使用）。 */
  mode: string | null;
  localEnabled: boolean;
  registrationEnabled: boolean;
  /** enabled && available 同时成立才算可用；否则 UI 不得渲染可用的 SSO 入口。 */
  ssoAvailable: boolean;
  ssoLabel: string;
  /** profile_policy 只是部署默认；个人资料仍以 profile.editable_fields 为准。 */
  defaultEditableFields: string[];
  /** 配置里出现了无法识别的 mode，提示而不是静默当成 local。 */
  modeDiagnosed: boolean;
};

export const KNOWN_AUTH_MODES: readonly string[] = ['local', 'sso', 'hybrid'];

/** 后端未给 label 时的固定文案；不因为缺字段就隐藏「SSO 未开放」的事实。 */
export const DEFAULT_SSO_LABEL = '公司 SSO';

/**
 * 把 config DTO 投影成登录 UI 的能力集合。schema 已经保证 mode 非空、methods
 * 至少声明一种方式；这里仍对每个能力独立判定、不互相回退（local 配置坏了不能
 * 让 SSO 变成可用，反之也一样），并保留未知 mode 供诊断文案使用。
 */
export function projectLoginCapabilities(config: AuthConfig | null): LoginCapabilities {
  const methods = config?.methods;
  const local = methods?.local;
  const sso = methods?.sso;
  const mode = typeof config?.mode === 'string' && config.mode ? config.mode : null;
  return {
    mode,
    localEnabled: local?.enabled === true,
    registrationEnabled: local?.registration_enabled === true,
    ssoAvailable: sso?.enabled === true && sso?.available === true,
    ssoLabel: (typeof sso?.label === 'string' && sso.label) || DEFAULT_SSO_LABEL,
    defaultEditableFields: config?.profile_policy?.editable_fields ?? [],
    modeDiagnosed: mode !== null && !KNOWN_AUTH_MODES.includes(mode),
  };
}

/** 配置已加载但没有任何可用登录方式时的可见文案（不渲染任何表单）。 */
export function noLoginMethodMessage(caps: LoginCapabilities): string | null {
  if (caps.localEnabled || caps.ssoAvailable) return null;
  return caps.modeDiagnosed
    ? `服务端返回了未知登录模式「${caps.mode}」，当前没有可用的登录方式。`
    : '当前部署未开放任何登录方式，请联系管理员。';
}

/** 登录方式展示名；未知来源不猜，显示原始值。 */
export function loginMethodLabel(method: string | null | undefined): string {
  if (method === 'local') return '账号密码';
  if (method === 'sso') return '公司 SSO';
  if (!method) return '—';
  return method;
}
