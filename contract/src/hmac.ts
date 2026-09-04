/**
 * Agent -> Exec 内部调用令牌：短时效 HS256，schema 严格封闭。
 *
 * 为什么这份实现放在 contract/、而不是各自在 agent/ 和 exec/ 里各写一份：
 *
 * 在旧架构下（Node Agent + Python Sandbox），这份逻辑必须在两种语言里各写
 * 一遍——`agent/src/infrastructure/sandbox/internal-hmac.js` 与
 * `sandbox/security/internal_auth.py`——靠一份跨语言 golden fixture
 * （`tests/fixtures/contracts/agent-sandbox-internal-hmac-hs256-v1.json`）
 * 互相校验字节级签名一致。两侧都改成 TypeScript 之后，这个"两份实现必须
 * 手动保持同步"的风险就该被消掉：这份模块是两侧唯一共用的实现，那份
 * fixture 的意义从"防止分叉"退化为"防止未来重构不小心改变字节输出"
 * ——所以它必须继续通过。
 *
 * 只接受 HS256、闭合 schema：不接受通用 JWT 库的宽松行为——不认 `alg`
 * 混淆、不识别未声明字段、不做数字隐式转换、不认无 kid 回退到"默认密钥"。
 *
 * 关于 jti 与 ADR 0008 D8：D8 决定去掉的是"防重放 jti 的专用 Redis 实例"
 * （原 `sandbox/security/internal_http_auth.py` 里的 `ReplayStore`，按
 * jti 去重、命中即拒绝）。`jti` 这个字段本身仍然签在 claims 里，
 * 是纯熵值 + 唯一性来源，不是被删掉的东西。这份模块从来就不做去重校验
 * ——去重原本就在 HTTP 适配层的另一个模块里，不在这里——所以这里没有
 * "要去掉的重放逻辑"，port 过来天然就符合 D8。去重校验（如果 exec 侧
 * 还需要）不属于 contract 的职责范围。
 */

import {
  createHmac,
  randomBytes as cryptoRandomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { TextDecoder } from 'node:util';

export const INTERNAL_TOKEN_ALGORITHM = 'HS256';
export const INTERNAL_TOKEN_TYPE = 'sandbox-internal+jwt';
export const INTERNAL_TOKEN_VERSION = 1;
export const INTERNAL_TOKEN_ISSUER = 'agent-service';
export const INTERNAL_TOKEN_AUDIENCE = 'sandbox-service';
export const INTERNAL_TOKEN_SUBJECT = 'agent-worker';
export const INTERNAL_TOKEN_DEFAULT_TTL_SECONDS = 60;
export const INTERNAL_TOKEN_MAX_TTL_SECONDS = 120;

export const INTERNAL_TOKEN_HEADER_KEYS = Object.freeze([
  'alg',
  'kid',
  'typ',
] as const);

export const INTERNAL_TOKEN_CLAIM_KEYS = Object.freeze([
  'token_version',
  'iss',
  'aud',
  'sub',
  'org_id',
  'user_id',
  'conversation_id',
  'agent_session_id',
  'sandbox_session_id',
  'run_id',
  'tool_execution_id',
  'tool_call_id',
  'tool_name',
  'scope',
  'request_hash',
  'request_hash_version',
  'execution_fence_token',
  'trace_id',
  'htm',
  'htu',
  'body_sha256',
  'iat',
  'nbf',
  'exp',
  'jti',
] as const);

/** 签发者提供的字段；服务身份、版本号、时间戳与 jti 由本模块生成。 */
export const INTERNAL_TOKEN_ISSUE_CLAIM_KEYS = Object.freeze([
  'org_id',
  'user_id',
  'conversation_id',
  'agent_session_id',
  'sandbox_session_id',
  'run_id',
  'tool_execution_id',
  'tool_call_id',
  'tool_name',
  'scope',
  'request_hash',
  'execution_fence_token',
  'trace_id',
  'htm',
  'htu',
  'body_sha256',
] as const);

const MAX_KID_LENGTH = 128;
const MAX_IDENTIFIER_LENGTH = 255;
const MAX_SCOPE_LENGTH = 128;
const MAX_HTU_LENGTH = 2048;
const MAX_KEYRING_KEYS = 32;
const MAX_KEY_BYTES = 4096;
const MAX_KEYRING_JSON_BYTES = 64 * 1024;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const KID_RE = /^[A-Za-z0-9._-]+$/;
const PRINTABLE_ASCII_RE = /^[\x21-\x7e]+$/;
const UTF8_FATAL_DECODER = new TextDecoder('utf-8', { fatal: true });

/** 令牌单元素 scope（本 schema 只允许恰好一个）。 */
export type InternalTokenScope = readonly [string];

/** 调用方提供的签发字段。 */
export interface InternalTokenIssueClaims {
  readonly org_id: string;
  readonly user_id: string;
  readonly conversation_id: string;
  readonly agent_session_id: string;
  readonly sandbox_session_id: string;
  readonly run_id: string | null;
  readonly tool_execution_id: string;
  readonly tool_call_id: string;
  readonly tool_name: string;
  readonly scope: InternalTokenScope;
  readonly request_hash: string;
  readonly execution_fence_token: number | null;
  readonly trace_id: string;
  readonly htm: 'POST';
  readonly htu: string;
  readonly body_sha256: string;
}

/** 签名/验签之后的完整、已校验、按固定顺序排列的最终 claim 集合。 */
export interface InternalTokenClaims extends InternalTokenIssueClaims {
  readonly token_version: 1;
  readonly iss: typeof INTERNAL_TOKEN_ISSUER;
  readonly aud: typeof INTERNAL_TOKEN_AUDIENCE;
  readonly sub: typeof INTERNAL_TOKEN_SUBJECT;
  readonly request_hash_version: 1;
  readonly iat: number;
  readonly nbf: number;
  readonly exp: number;
  readonly jti: string;
}

/** 令牌密钥环：`kid -> base64url 编码的密钥`，可以是对象也可以是其 JSON 字符串形式。 */
export type InternalHmacKeyringInput = Record<string, string> | string;

export type InternalHmacErrorCode =
  | 'INTERNAL_TOKEN_SCHEMA_INVALID'
  | 'INTERNAL_TOKEN_CLAIM_INVALID'
  | 'INTERNAL_TOKEN_BASE64URL_INVALID'
  | 'INTERNAL_TOKEN_KEYRING_INVALID'
  | 'INTERNAL_TOKEN_ACTIVE_KID_UNKNOWN'
  | 'INTERNAL_TOKEN_UNKNOWN_KID'
  | 'INTERNAL_TOKEN_TTL_INVALID'
  | 'INTERNAL_TOKEN_RANDOM_INVALID'
  | 'INTERNAL_TOKEN_MALFORMED'
  | 'INTERNAL_TOKEN_HEADER_INVALID'
  | 'INTERNAL_TOKEN_SIGNATURE_INVALID'
  | 'INTERNAL_TOKEN_NOT_YET_VALID'
  | 'INTERNAL_TOKEN_EXPIRED';

/** 令牌签发/验证失败的类型化错误；`code` 稳定，不携带机密信息。 */
export class InternalHmacError extends Error {
  readonly code: InternalHmacErrorCode;

  constructor(code: InternalHmacErrorCode, message: string) {
    super(message);
    this.name = 'InternalHmacError';
    this.code = code;
  }
}

function fail(code: InternalHmacErrorCode, message: string): never {
  throw new InternalHmacError(code, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * 校验一个值恰好含有 `expected` 中的键（不多不少），返回原对象供后续按
 * 字段读取。字段读取只做一次，所以即便某个键是 getter 也不存在"校验时
 * 与序列化时读到不同值"的问题。
 */
function assertExactObjectKeys<K extends string>(
  value: unknown,
  expected: readonly K[],
  label: string,
): Record<K, unknown> {
  if (!isPlainObject(value)) {
    fail('INTERNAL_TOKEN_SCHEMA_INVALID', `${label} must be a plain object`);
  }
  const actualKeys = Object.keys(value);
  if (
    actualKeys.length !== expected.length ||
    actualKeys.some((key) => !(expected as readonly string[]).includes(key))
  ) {
    fail(
      'INTERNAL_TOKEN_SCHEMA_INVALID',
      `${label} must contain exactly: ${expected.join(',')}`,
    );
  }
  return value as Record<K, unknown>;
}

function assertAsciiIdentifier(
  value: unknown,
  field: string,
  maxLength: number = MAX_IDENTIFIER_LENGTH,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    !PRINTABLE_ASCII_RE.test(value)
  ) {
    fail(
      'INTERNAL_TOKEN_CLAIM_INVALID',
      `${field} must be 1..${maxLength} printable ASCII characters`,
    );
  }
  return value;
}

function assertPositiveSafeInteger(value: unknown, field: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    fail(
      'INTERNAL_TOKEN_CLAIM_INVALID',
      `${field} must be a positive safe integer number`,
    );
  }
  return value;
}

/** 严格的规范化、无填充 base64url 解码器。 */
function decodeCanonicalBase64url(value: unknown, field: string): Buffer {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !BASE64URL_RE.test(value) ||
    value.length % 4 === 1
  ) {
    fail(
      'INTERNAL_TOKEN_BASE64URL_INVALID',
      `${field} must be canonical unpadded base64url`,
    );
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) {
    fail(
      'INTERNAL_TOKEN_BASE64URL_INVALID',
      `${field} must be canonical unpadded base64url`,
    );
  }
  return decoded;
}

/**
 * 解析一个"扁平、键值均为字符串"的 JSON 对象，并拒绝重复键——
 * `JSON.parse` 本身会静默让后一个重复键覆盖前一个，等于悄悄接受了
 * 一份被篡改过的密钥环配置。
 */
function parseJsonKeyring(source: string): Record<string, string> {
  if (Buffer.byteLength(source, 'utf8') > MAX_KEYRING_JSON_BYTES) {
    fail('INTERNAL_TOKEN_KEYRING_INVALID', 'keyring JSON is too large');
  }

  let offset = 0;
  const result: Record<string, string> = Object.create(null);

  const skipWhitespace = (): void => {
    while (
      offset < source.length &&
      (source[offset] === ' ' ||
        source[offset] === '\t' ||
        source[offset] === '\r' ||
        source[offset] === '\n')
    ) {
      offset += 1;
    }
  };

  const parseString = (): string => {
    if (source[offset] !== '"') {
      fail(
        'INTERNAL_TOKEN_KEYRING_INVALID',
        'keyring JSON keys and values must be strings',
      );
    }
    const start = offset;
    offset += 1;
    let escaped = false;
    while (offset < source.length) {
      const code = source.charCodeAt(offset);
      const character = source[offset];
      if (!escaped && character === '"') {
        offset += 1;
        try {
          return JSON.parse(source.slice(start, offset)) as string;
        } catch {
          fail('INTERNAL_TOKEN_KEYRING_INVALID', 'invalid keyring JSON string');
        }
      }
      if (!escaped && code < 0x20) {
        fail('INTERNAL_TOKEN_KEYRING_INVALID', 'invalid keyring JSON string');
      }
      escaped = !escaped && character === '\\';
      offset += 1;
    }
    fail('INTERNAL_TOKEN_KEYRING_INVALID', 'unterminated keyring JSON string');
  };

  skipWhitespace();
  if (source[offset] !== '{') {
    fail('INTERNAL_TOKEN_KEYRING_INVALID', 'keyring JSON must be an object');
  }
  offset += 1;
  skipWhitespace();
  if (source[offset] === '}') {
    offset += 1;
  } else {
    while (offset < source.length) {
      const key = parseString();
      if (Object.hasOwn(result, key)) {
        fail(
          'INTERNAL_TOKEN_KEYRING_INVALID',
          `duplicate keyring kid: ${key}`,
        );
      }
      skipWhitespace();
      if (source[offset] !== ':') {
        fail('INTERNAL_TOKEN_KEYRING_INVALID', 'invalid keyring JSON object');
      }
      offset += 1;
      skipWhitespace();
      const value = parseString();
      result[key] = value;
      skipWhitespace();
      if (source[offset] === '}') {
        offset += 1;
        break;
      }
      if (source[offset] !== ',') {
        fail('INTERNAL_TOKEN_KEYRING_INVALID', 'invalid keyring JSON object');
      }
      offset += 1;
      skipWhitespace();
    }
  }
  skipWhitespace();
  if (offset !== source.length) {
    fail(
      'INTERNAL_TOKEN_KEYRING_INVALID',
      'unexpected data after keyring JSON object',
    );
  }
  return result;
}

function decodeKeyring(input: unknown): Map<string, Buffer> {
  let object: Record<string, unknown>;
  if (typeof input === 'string') {
    object = parseJsonKeyring(input);
  } else {
    if (!isPlainObject(input)) {
      fail(
        'INTERNAL_TOKEN_KEYRING_INVALID',
        'keyring must be an object or JSON object string',
      );
    }
    object = input;
    // 只接受可枚举的字符串**数据属性**。getter 会在校验和取用之间返回不同的
    // 字节（校验一份、签名另一份），也会在校验期间跑任意代码——密钥来源不能
    // 是一段可执行逻辑。`Reflect.ownKeys` 而不是 `Object.entries`：symbol 键
    // 不会被 entries 看到，但会被后面的序列化路径看到。
    for (const key of Reflect.ownKeys(object)) {
      if (typeof key !== 'string') {
        fail(
          'INTERNAL_TOKEN_KEYRING_INVALID',
          'keyring cannot contain symbol keys',
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value') ||
        typeof descriptor.value !== 'string'
      ) {
        fail(
          'INTERNAL_TOKEN_KEYRING_INVALID',
          'keyring values must be enumerable string data properties',
        );
      }
    }
  }

  const entries = Object.entries(object);
  if (entries.length === 0 || entries.length > MAX_KEYRING_KEYS) {
    fail(
      'INTERNAL_TOKEN_KEYRING_INVALID',
      `keyring must contain 1..${MAX_KEYRING_KEYS} keys`,
    );
  }

  const decoded = new Map<string, Buffer>();
  for (const [kid, encoded] of entries) {
    if (kid.length === 0 || kid.length > MAX_KID_LENGTH || !KID_RE.test(kid)) {
      fail(
        'INTERNAL_TOKEN_KEYRING_INVALID',
        `kid must match ${KID_RE.source} and be at most ${MAX_KID_LENGTH} characters`,
      );
    }
    const key = decodeCanonicalBase64url(encoded, `keyring.${kid}`);
    if (key.length < 32 || key.length > MAX_KEY_BYTES) {
      fail(
        'INTERNAL_TOKEN_KEYRING_INVALID',
        `keyring.${kid} must decode to 32..${MAX_KEY_BYTES} bytes`,
      );
    }
    decoded.set(kid, key);
  }
  return decoded;
}

/** 校验密钥环与当前签名 kid，不做无 kid 回退。 */
export function validateInternalHmacKeyring(
  keyring: InternalHmacKeyringInput,
  activeKid: unknown,
): { readonly activeKid: string; readonly kids: readonly string[] } {
  const decoded = decodeKeyring(keyring);
  const kid = assertAsciiIdentifier(activeKid, 'activeKid', MAX_KID_LENGTH);
  if (!KID_RE.test(kid) || !decoded.has(kid)) {
    fail(
      'INTERNAL_TOKEN_ACTIVE_KID_UNKNOWN',
      'activeKid must identify an existing keyring entry',
    );
  }
  return Object.freeze({
    activeKid: kid,
    kids: Object.freeze([...decoded.keys()]),
  });
}

function assertSha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SHA256_HEX_RE.test(value)) {
    fail(
      'INTERNAL_TOKEN_CLAIM_INVALID',
      `${field} must be 64 lowercase hexadecimal characters`,
    );
  }
  return value;
}

function assertHtu(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_HTU_LENGTH ||
    value[0] !== '/' ||
    !PRINTABLE_ASCII_RE.test(value) ||
    value.includes('?') ||
    value.includes('#')
  ) {
    fail(
      'INTERNAL_TOKEN_CLAIM_INVALID',
      `htu must be an ASCII absolute path without query/fragment and at most ${MAX_HTU_LENGTH} characters`,
    );
  }
  return value;
}

function assertScope(value: unknown): InternalTokenScope {
  if (!Array.isArray(value) || value.length !== 1) {
    fail('INTERNAL_TOKEN_CLAIM_INVALID', 'scope must contain exactly one element');
  }
  // "恰好一个元素"要连自有属性一起算：`['x']` 上再挂一个 `.extra` 仍然
  // `length === 1`，但它已经不是那个被约束住的一元 scope 了。允许的自有键
  // 只有下标 "0" 和 "length"。
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== 2 || !ownKeys.includes('0') || !ownKeys.includes('length')) {
    fail('INTERNAL_TOKEN_CLAIM_INVALID', 'scope must not carry extra own properties');
  }
  const first: unknown = value[0];
  return Object.freeze([
    assertAsciiIdentifier(first, 'scope[0]', MAX_SCOPE_LENGTH),
  ]) as InternalTokenScope;
}

/** 判断这是不是 `session.ensure` 的特例（此时 run_id / fence 允许为 null）。 */
function isPreRunSessionEnsureProfile(fields: {
  readonly toolName: string;
  readonly scope: InternalTokenScope;
  readonly htu: unknown;
  readonly runId: unknown;
  readonly executionFenceToken: unknown;
}): boolean {
  return (
    fields.toolName === 'session.ensure' &&
    fields.scope[0] === 'sandbox.sessions.ensure' &&
    fields.htu === '/internal/v1/sessions/ensure' &&
    fields.runId === null &&
    fields.executionFenceToken === null
  );
}

/** 校验并拷贝出最终 claim 集合，字段按固定顺序排列。 */
export function validateInternalTokenClaims(input: unknown): InternalTokenClaims {
  const claims = assertExactObjectKeys(
    input,
    INTERNAL_TOKEN_CLAIM_KEYS,
    'claims',
  );

  if (claims.token_version !== INTERNAL_TOKEN_VERSION) {
    fail('INTERNAL_TOKEN_CLAIM_INVALID', `token_version must equal ${INTERNAL_TOKEN_VERSION}`);
  }
  if (claims.request_hash_version !== 1) {
    fail('INTERNAL_TOKEN_CLAIM_INVALID', 'request_hash_version must equal 1');
  }
  if (claims.iss !== INTERNAL_TOKEN_ISSUER) {
    fail('INTERNAL_TOKEN_CLAIM_INVALID', 'iss is invalid');
  }
  if (claims.aud !== INTERNAL_TOKEN_AUDIENCE) {
    fail('INTERNAL_TOKEN_CLAIM_INVALID', 'aud is invalid');
  }
  if (claims.sub !== INTERNAL_TOKEN_SUBJECT) {
    fail('INTERNAL_TOKEN_CLAIM_INVALID', 'sub is invalid');
  }

  const toolName = assertAsciiIdentifier(claims.tool_name, 'tool_name');
  const scope = assertScope(claims.scope);
  const preRun = isPreRunSessionEnsureProfile({
    toolName,
    scope,
    htu: claims.htu,
    runId: claims.run_id,
    executionFenceToken: claims.execution_fence_token,
  });

  const htm = claims.htm;
  if (htm !== 'POST') {
    fail('INTERNAL_TOKEN_CLAIM_INVALID', 'htm must equal POST');
  }

  const iat = assertPositiveSafeInteger(claims.iat, 'iat');
  const nbf = assertPositiveSafeInteger(claims.nbf, 'nbf');
  const exp = assertPositiveSafeInteger(claims.exp, 'exp');
  if (nbf !== iat) {
    fail('INTERNAL_TOKEN_CLAIM_INVALID', 'nbf must equal iat');
  }
  const ttl = exp - iat;
  if (ttl <= 0 || ttl > INTERNAL_TOKEN_MAX_TTL_SECONDS) {
    fail(
      'INTERNAL_TOKEN_CLAIM_INVALID',
      `exp-iat must be in 1..${INTERNAL_TOKEN_MAX_TTL_SECONDS}`,
    );
  }

  const jti = assertAsciiIdentifier(claims.jti, 'jti');
  const jtiBytes = decodeCanonicalBase64url(jti, 'jti');
  if (jtiBytes.length !== 16) {
    fail('INTERNAL_TOKEN_CLAIM_INVALID', 'jti must encode exactly 128 bits');
  }

  const normalized: InternalTokenClaims = {
    token_version: INTERNAL_TOKEN_VERSION,
    iss: INTERNAL_TOKEN_ISSUER,
    aud: INTERNAL_TOKEN_AUDIENCE,
    sub: INTERNAL_TOKEN_SUBJECT,
    org_id: assertAsciiIdentifier(claims.org_id, 'org_id'),
    user_id: assertAsciiIdentifier(claims.user_id, 'user_id'),
    conversation_id: assertAsciiIdentifier(claims.conversation_id, 'conversation_id'),
    agent_session_id: assertAsciiIdentifier(claims.agent_session_id, 'agent_session_id'),
    sandbox_session_id: assertAsciiIdentifier(claims.sandbox_session_id, 'sandbox_session_id'),
    run_id: preRun ? null : assertAsciiIdentifier(claims.run_id, 'run_id'),
    tool_execution_id: assertAsciiIdentifier(claims.tool_execution_id, 'tool_execution_id'),
    tool_call_id: assertAsciiIdentifier(claims.tool_call_id, 'tool_call_id'),
    tool_name: toolName,
    scope,
    request_hash: assertSha256(claims.request_hash, 'request_hash'),
    request_hash_version: 1,
    execution_fence_token: preRun
      ? null
      : assertPositiveSafeInteger(claims.execution_fence_token, 'execution_fence_token'),
    trace_id: assertAsciiIdentifier(claims.trace_id, 'trace_id'),
    htm: 'POST',
    htu: assertHtu(claims.htu),
    body_sha256: assertSha256(claims.body_sha256, 'body_sha256'),
    iat,
    nbf,
    exp,
    jti,
  };

  return Object.freeze(normalized);
}

function validateIssueClaims(input: unknown): InternalTokenIssueClaims {
  const claims = assertExactObjectKeys(
    input,
    INTERNAL_TOKEN_ISSUE_CLAIM_KEYS,
    'issue claims',
  );
  const toolName = assertAsciiIdentifier(claims.tool_name, 'tool_name');
  const scope = assertScope(claims.scope);
  const preRun = isPreRunSessionEnsureProfile({
    toolName,
    scope,
    htu: claims.htu,
    runId: claims.run_id,
    executionFenceToken: claims.execution_fence_token,
  });
  if (claims.htm !== 'POST') {
    fail('INTERNAL_TOKEN_CLAIM_INVALID', 'htm must equal POST');
  }
  return Object.freeze({
    org_id: assertAsciiIdentifier(claims.org_id, 'org_id'),
    user_id: assertAsciiIdentifier(claims.user_id, 'user_id'),
    conversation_id: assertAsciiIdentifier(claims.conversation_id, 'conversation_id'),
    agent_session_id: assertAsciiIdentifier(claims.agent_session_id, 'agent_session_id'),
    sandbox_session_id: assertAsciiIdentifier(claims.sandbox_session_id, 'sandbox_session_id'),
    run_id: preRun ? null : assertAsciiIdentifier(claims.run_id, 'run_id'),
    tool_execution_id: assertAsciiIdentifier(claims.tool_execution_id, 'tool_execution_id'),
    tool_call_id: assertAsciiIdentifier(claims.tool_call_id, 'tool_call_id'),
    tool_name: toolName,
    scope,
    request_hash: assertSha256(claims.request_hash, 'request_hash'),
    execution_fence_token: preRun
      ? null
      : assertPositiveSafeInteger(claims.execution_fence_token, 'execution_fence_token'),
    trace_id: assertAsciiIdentifier(claims.trace_id, 'trace_id'),
    htm: 'POST',
    htu: assertHtu(claims.htu),
    body_sha256: assertSha256(claims.body_sha256, 'body_sha256'),
  });
}

function assertClockSeconds(now: unknown): number {
  return assertPositiveSafeInteger(now, 'clock result');
}

function encodeBase64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

export interface SignInternalTokenOptions {
  readonly keyring: InternalHmacKeyringInput;
  readonly activeKid: string;
  /** 已经是完整、待校验的最终 claim 集合（一般不要直接调用，走 issueInternalToken）。 */
  readonly claims: unknown;
}

/** 对一份已经完整、经过严格校验的 claim 集合确定性签名。 */
export function signInternalToken(options: SignInternalTokenOptions): string {
  const decoded = decodeKeyring(options.keyring);
  const activeKid = assertAsciiIdentifier(options.activeKid, 'activeKid', MAX_KID_LENGTH);
  const key = decoded.get(activeKid);
  if (!KID_RE.test(activeKid) || key === undefined) {
    fail(
      'INTERNAL_TOKEN_ACTIVE_KID_UNKNOWN',
      'activeKid must identify an existing keyring entry',
    );
  }
  const claims = validateInternalTokenClaims(options.claims);
  const header = {
    alg: INTERNAL_TOKEN_ALGORITHM,
    kid: activeKid,
    typ: INTERNAL_TOKEN_TYPE,
  };
  const signingInput =
    `${encodeBase64url(Buffer.from(JSON.stringify(header), 'utf8'))}.` +
    encodeBase64url(Buffer.from(JSON.stringify(claims), 'utf8'));
  const signature = createHmac('sha256', key).update(signingInput, 'ascii').digest();
  return `${signingInput}.${encodeBase64url(signature)}`;
}

export interface IssueInternalTokenOptions {
  readonly keyring: InternalHmacKeyringInput;
  readonly activeKid: string;
  readonly claims: unknown;
  readonly ttlSeconds?: number;
  /** 注入的时钟（Unix 秒），供测试用；省略则用系统时钟。 */
  readonly clock?: () => number;
  /** 注入的随机源，供测试用；省略则用 crypto.randomBytes。 */
  readonly randomBytes?: (size: number) => Uint8Array;
}

/** 签发一个短时效令牌；时钟与随机源可注入以便得到确定性结果。 */
export function issueInternalToken(options: IssueInternalTokenOptions): string {
  const ttl = options.ttlSeconds ?? INTERNAL_TOKEN_DEFAULT_TTL_SECONDS;
  if (
    typeof ttl !== 'number' ||
    !Number.isSafeInteger(ttl) ||
    ttl <= 0 ||
    ttl > INTERNAL_TOKEN_MAX_TTL_SECONDS
  ) {
    fail(
      'INTERNAL_TOKEN_TTL_INVALID',
      `ttlSeconds must be a safe integer in 1..${INTERNAL_TOKEN_MAX_TTL_SECONDS}`,
    );
  }
  const now = assertClockSeconds((options.clock ?? (() => Math.floor(Date.now() / 1000)))());
  if (!Number.isSafeInteger(now + ttl)) {
    fail('INTERNAL_TOKEN_TTL_INVALID', 'token expiry is not a safe integer');
  }
  const randomSource = options.randomBytes ?? cryptoRandomBytes;
  const random = randomSource(16);
  if (!(random instanceof Uint8Array) || random.byteLength !== 16) {
    fail('INTERNAL_TOKEN_RANDOM_INVALID', 'randomBytes must return exactly 16 bytes');
  }
  const input = validateIssueClaims(options.claims);
  const claims: Record<string, unknown> = {
    token_version: INTERNAL_TOKEN_VERSION,
    iss: INTERNAL_TOKEN_ISSUER,
    aud: INTERNAL_TOKEN_AUDIENCE,
    sub: INTERNAL_TOKEN_SUBJECT,
    ...input,
    request_hash_version: 1,
    iat: now,
    nbf: now,
    exp: now + ttl,
    jti: encodeBase64url(Buffer.from(random)),
  };
  // 签名前重建成唯一权威顺序。
  const orderedClaims = Object.fromEntries(
    INTERNAL_TOKEN_CLAIM_KEYS.map((key) => [key, claims[key]]),
  );
  return signInternalToken({
    keyring: options.keyring,
    activeKid: options.activeKid,
    claims: orderedClaims,
  });
}

function decodeJwtJsonSegment(segment: string, field: string): { text: string; value: unknown } {
  const bytes = decodeCanonicalBase64url(segment, field);
  let text: string;
  try {
    text = UTF8_FATAL_DECODER.decode(bytes);
  } catch {
    fail('INTERNAL_TOKEN_MALFORMED', `${field} is not valid UTF-8`);
  }
  try {
    return { text, value: JSON.parse(text) as unknown };
  } catch {
    fail('INTERNAL_TOKEN_MALFORMED', `${field} is not valid JSON`);
  }
}

export interface VerifyInternalTokenOptions {
  readonly keyring: InternalHmacKeyringInput;
  /** 注入的时钟（Unix 秒），供测试用；省略则用系统时钟。 */
  readonly clock?: () => number;
}

/**
 * 校验签名、精确 schema、规范紧凑序列化、固定 iss/aud/sub 以及严格的时间窗口。
 *
 * 本函数只验证令牌自身；请求体摘要绑定（`body_sha256` 与实际收到的原始字节
 * 是否一致）由调用方在拿到 `body_sha256` claim 后自行比较——这里不解析、
 * 不接触 HTTP 层。
 */
export function verifyInternalToken(
  token: unknown,
  options: VerifyInternalTokenOptions,
): InternalTokenClaims {
  if (typeof token !== 'string' || token.length > 16 * 1024) {
    fail('INTERNAL_TOKEN_MALFORMED', 'token must be a bounded string');
  }
  const segments = token.split('.');
  if (segments.length !== 3 || segments.some((part) => part.length === 0)) {
    fail('INTERNAL_TOKEN_MALFORMED', 'token must contain exactly three compact segments');
  }
  const headerSegment = segments[0] as string;
  const payloadSegment = segments[1] as string;
  const signatureSegment = segments[2] as string;

  const headerDecoded = decodeJwtJsonSegment(headerSegment, 'header');
  const header = assertExactObjectKeys(headerDecoded.value, INTERNAL_TOKEN_HEADER_KEYS, 'header');
  if (header.alg !== INTERNAL_TOKEN_ALGORITHM || header.typ !== INTERNAL_TOKEN_TYPE) {
    fail('INTERNAL_TOKEN_HEADER_INVALID', 'unsupported token header');
  }
  const kid = assertAsciiIdentifier(header.kid, 'header.kid', MAX_KID_LENGTH);
  if (!KID_RE.test(kid)) {
    fail('INTERNAL_TOKEN_HEADER_INVALID', 'invalid header kid');
  }
  const canonicalHeader = JSON.stringify({
    alg: INTERNAL_TOKEN_ALGORITHM,
    kid,
    typ: INTERNAL_TOKEN_TYPE,
  });
  if (headerDecoded.text !== canonicalHeader) {
    fail('INTERNAL_TOKEN_HEADER_INVALID', 'header must use deterministic compact serialization');
  }

  const decoded = decodeKeyring(options.keyring);
  const key = decoded.get(kid);
  if (key === undefined) {
    fail('INTERNAL_TOKEN_UNKNOWN_KID', 'token kid is not present in the keyring');
  }

  const suppliedSignature = decodeCanonicalBase64url(signatureSegment, 'signature');
  const expectedSignature = createHmac('sha256', key)
    .update(`${headerSegment}.${payloadSegment}`, 'ascii')
    .digest();
  if (
    suppliedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    fail('INTERNAL_TOKEN_SIGNATURE_INVALID', 'invalid token signature');
  }

  const claimsDecoded = decodeJwtJsonSegment(payloadSegment, 'claims');
  const claims = validateInternalTokenClaims(claimsDecoded.value);
  if (claimsDecoded.text !== JSON.stringify(claims)) {
    fail('INTERNAL_TOKEN_CLAIM_INVALID', 'claims must use deterministic compact serialization');
  }

  const now = assertClockSeconds((options.clock ?? (() => Math.floor(Date.now() / 1000)))());
  if (now < claims.nbf) {
    fail('INTERNAL_TOKEN_NOT_YET_VALID', 'token is not yet valid');
  }
  if (now >= claims.exp) {
    fail('INTERNAL_TOKEN_EXPIRED', 'token has expired');
  }
  return claims;
}
