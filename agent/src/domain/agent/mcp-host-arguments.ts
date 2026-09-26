/**
 * 宿主参数（docs/design/mcp-per-agent-arguments.md）：同一台 MCP Server 被多个
 * Agent 使用时，某些工具参数由平台按 AgentVersion 填入，模型看不到也改不了。
 *
 * 纯函数，四处共用：
 * - 启动期：`MCP_SERVERS_JSON[].hostArguments` 声明校验（非法即拒绝启动）；
 * - 保存期：`mcpServers[i].toolArguments` 的逐字段诊断；
 * - Run 装配：按工具 schema 求受影响的键、裁剪 schema、缺值隐藏；
 * - 执行 / 审批 / 账本：同一个 `mergeHostArguments`，三处看到同一份参数。
 */

export const HOST_ARGUMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const HOST_ARGUMENTS_MAX = 10;
export const HOST_ARGUMENT_VALUE_MAX_CHARS = 1024;

/**
 * 启发式护栏：宿主参数的值存在 AgentVersion 里（MySQL 明文、管理员可见），
 * 不能拿来传凭据。名字像密钥的声明直接拒绝，凭据走 headerRefs / authTokenRef。
 */
const SECRET_LIKE = /(token|secret|passw(or)?d|api[_-]?key|credential|authorization)/i;

export type HostArgumentSpec = Readonly<Record<string, { readonly description: string }>>;
export type HostArgumentValue = string | number | boolean;
export type HostArgumentValues = Readonly<Record<string, HostArgumentValue>>;

export interface HostArgumentDiagnostic {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export class HostArgumentDeclarationError extends Error {
  readonly code = 'MCP_SERVER_REGISTRY_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'HostArgumentDeclarationError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 一台 Server 的 `hostArguments` 声明。缺省 = 没有宿主参数。 */
export function parseHostArgumentDeclaration(serverId: string, raw: unknown): HostArgumentSpec {
  if (raw === undefined || raw === null) return Object.freeze({});
  const field = `MCP_SERVERS_JSON(${serverId}).hostArguments`;
  if (!isPlainObject(raw)) throw new HostArgumentDeclarationError(`${field} must be an object`);
  const names = Object.keys(raw);
  if (names.length > HOST_ARGUMENTS_MAX) {
    throw new HostArgumentDeclarationError(`${field} declares more than ${HOST_ARGUMENTS_MAX} arguments`);
  }
  const out: Record<string, { description: string }> = {};
  for (const name of names) {
    if (!HOST_ARGUMENT_NAME.test(name)) {
      throw new HostArgumentDeclarationError(`${field}.${name} is not a valid argument name`);
    }
    if (SECRET_LIKE.test(name)) {
      throw new HostArgumentDeclarationError(
        `${field}.${name} looks like a credential; pass credentials through headerRefs/authTokenRef instead`,
      );
    }
    const entry = raw[name];
    if (entry !== undefined && entry !== null && !isPlainObject(entry)) {
      throw new HostArgumentDeclarationError(`${field}.${name} must be an object`);
    }
    const description = isPlainObject(entry) && entry.description != null ? String(entry.description).trim() : '';
    out[name] = Object.freeze({ description: description.slice(0, 200) });
  }
  return Object.freeze(out);
}

/**
 * 从 `MCP_SERVERS_JSON` 的数组求每台**启用**Server 的声明。只返回声明非空的 Server。
 * 声明非法时抛错：调用方在启动期调用，抛出即拒绝启动。
 */
export function readHostArgumentDeclarations(servers: readonly unknown[]): Map<string, HostArgumentSpec> {
  const out = new Map<string, HostArgumentSpec>();
  for (const server of servers) {
    if (!isPlainObject(server) || server.enabled === false) continue;
    const serverId = String(server.id ?? server.serverId ?? '').trim();
    if (!serverId) continue;
    const spec = parseHostArgumentDeclaration(serverId, server.hostArguments);
    if (Object.keys(spec).length > 0) out.set(serverId, spec);
  }
  return out;
}

/**
 * `mcpServers[i].toolArguments` 的解析与诊断。`declared` 为 undefined 时只校验形状
 * （Run 启动期的 binding 不持有登记表）；给出时另校验键已被运维声明。
 * 有任何诊断时 `values` 为 null——调用方不得拿半份值去跑。
 */
export function parseToolArguments(
  raw: unknown,
  path: string,
  declared?: HostArgumentSpec,
): { values: HostArgumentValues | null; errors: HostArgumentDiagnostic[] } {
  const errors: HostArgumentDiagnostic[] = [];
  if (raw === undefined || raw === null) return { values: Object.freeze({}), errors };
  if (!isPlainObject(raw)) {
    errors.push({ path, code: 'CONFIG_TYPE', message: 'toolArguments must be an object' });
    return { values: null, errors };
  }
  const out: Record<string, HostArgumentValue> = {};
  for (const [name, value] of Object.entries(raw)) {
    const keyPath = `${path}.${name}`;
    if (!HOST_ARGUMENT_NAME.test(name) || (declared !== undefined && !Object.hasOwn(declared, name))) {
      errors.push({
        path: keyPath,
        code: 'MCP_ARGUMENT_UNKNOWN',
        message: `"${name}" is not a host argument declared for this MCP server`,
      });
      continue;
    }
    const scalar = typeof value === 'string' || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value));
    if (!scalar || (typeof value === 'string' && value.length > HOST_ARGUMENT_VALUE_MAX_CHARS)) {
      errors.push({
        path: keyPath,
        code: 'MCP_ARGUMENT_INVALID',
        message: `host argument must be a string (≤${HOST_ARGUMENT_VALUE_MAX_CHARS} chars), number or boolean`,
      });
      continue;
    }
    out[name] = value as HostArgumentValue;
  }
  return { values: errors.length ? null : Object.freeze(out), errors };
}

function propertiesOf(schema: unknown): Record<string, unknown> {
  return isPlainObject(schema) && isPlainObject(schema.properties) ? schema.properties : {};
}

function requiredOf(schema: unknown): string[] {
  return isPlainObject(schema) && Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === 'string')
    : [];
}

/** 本工具受影响的宿主参数：声明 ∩ schema 顶层属性。 */
export function hostKeysForSchema(schema: unknown, spec: HostArgumentSpec): string[] {
  const properties = propertiesOf(schema);
  return Object.keys(spec).filter((name) => Object.hasOwn(properties, name));
}

/** 对模型的 schema：删掉宿主参数的属性与 required 条目；不改原对象。 */
export function stripHostArguments(schema: unknown, keys: readonly string[]): Record<string, unknown> {
  const next = JSON.parse(JSON.stringify(isPlainObject(schema) ? schema : {})) as Record<string, unknown>;
  if (isPlainObject(next.properties)) {
    for (const key of keys) delete next.properties[key];
  }
  if (Array.isArray(next.required)) {
    next.required = next.required.filter((item) => !keys.includes(String(item)));
  }
  return next;
}

/** schema 要求、但本 Agent 没给值的宿主参数。非空 = 本 Run 里该工具不可用。 */
export function missingRequiredHostArguments(
  schema: unknown,
  keys: readonly string[],
  values: HostArgumentValues,
): string[] {
  const required = requiredOf(schema);
  return keys.filter((key) => required.includes(key) && !Object.hasOwn(values, key));
}

/** 先删掉模型给的宿主参数，再并入宿主值——模型永远不能设置宿主参数。 */
export function mergeHostArguments(
  modelArgs: Record<string, unknown>,
  keys: readonly string[],
  values: HostArgumentValues,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(modelArgs ?? {})) {
    if (!keys.includes(key)) merged[key] = value;
  }
  for (const key of keys) {
    if (Object.hasOwn(values, key)) merged[key] = values[key];
  }
  return merged;
}

function matchesType(type: unknown, value: HostArgumentValue): boolean {
  const types = Array.isArray(type) ? type : [type];
  if (types.length === 0 || types.every((t) => t === undefined)) return true;
  return types.some((t) => {
    if (t === 'string') return typeof value === 'string';
    if (t === 'boolean') return typeof value === 'boolean';
    if (t === 'number') return typeof value === 'number';
    if (t === 'integer') return typeof value === 'number' && Number.isInteger(value);
    return false;
  });
}

/** 宿主值与工具 schema 声明类型不符的键（保存期拿不到 schema，只能在运行期判）。 */
export function hostValueTypeMismatches(
  schema: unknown,
  keys: readonly string[],
  values: HostArgumentValues,
): string[] {
  const properties = propertiesOf(schema);
  return keys.filter((key) => {
    if (!Object.hasOwn(values, key)) return false;
    const property = properties[key];
    return isPlainObject(property) && !matchesType(property.type, values[key]);
  });
}
