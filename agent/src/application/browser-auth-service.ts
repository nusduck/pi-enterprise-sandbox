import {
  createHmac,
  pbkdf2 as pbkdf2Callback,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const pbkdf2 = promisify(pbkdf2Callback);
const USERNAME = /^[A-Za-z0-9_./@+-]{2,64}$/;
const BOOTSTRAP_ORG_ID = 'org_bootstrap';
const PASSWORD_ITERATIONS = 120_000;

type Credential = {
  id: string;
  username: string;
  passwordHash: string;
  email: string | null;
  displayName: string | null;
  role: string;
  organizationId: string;
  isActive: boolean;
};

type CredentialStore = {
  create(input: Record<string, unknown>): Promise<Credential | null>;
  getByUsername(username: string): Promise<Credential | null>;
  getByExternalUserId(id: string): Promise<Credential | null>;
  setRole(id: string, role: string): Promise<void>;
  touchLogin(id: string): Promise<void>;
};

export class BrowserAuthError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'BrowserAuthError';
    this.status = status;
    this.code = code;
  }
}

function base64urlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function safeText(value: unknown, field: string, max: number): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > max) {
    throw new BrowserAuthError(422, 'AUTH_INPUT_INVALID', `${field} is invalid`);
  }
  return value;
}

export async function hashPassword(password: string, salt = randomBytes(16).toString('hex')) {
  const digest = await pbkdf2(password, salt, PASSWORD_ITERATIONS, 32, 'sha256');
  return `pbkdf2_sha256$${salt}$${digest.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [algorithm, salt, digestHex, ...rest] = String(stored).split('$');
  if (algorithm !== 'pbkdf2_sha256' || !salt || !digestHex || rest.length) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(digestHex, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== 32 || expected.toString('hex') !== digestHex.toLowerCase()) return false;
  const actual = await pbkdf2(password, salt, PASSWORD_ITERATIONS, 32, 'sha256');
  return timingSafeEqual(actual, expected);
}

export class BrowserAuthService {
  credentials: CredentialStore;
  secret: string;
  issuer: string;
  audience: string;
  ttlSeconds: number;
  allowPublicRegister: boolean;
  adminUsernames: Set<string>;
  now: () => Date;

  constructor(input: {
    credentials: CredentialStore;
    secret?: string;
    issuer?: string;
    audience?: string;
    ttlSeconds?: number;
    allowPublicRegister?: boolean;
    adminUsernames?: string[];
    now?: () => Date;
  }) {
    this.credentials = input.credentials;
    this.secret = String(input.secret || '').trim();
    this.issuer = String(input.issuer || 'pi-enterprise-sandbox');
    this.audience = String(input.audience || 'pi-enterprise-sandbox');
    this.ttlSeconds = Math.min(604_800, Math.max(60, Number(input.ttlSeconds) || 86_400));
    this.allowPublicRegister = input.allowPublicRegister !== false;
    this.adminUsernames = new Set(
      (input.adminUsernames || []).map((name) => name.trim().toLowerCase()).filter(Boolean),
    );
    this.now = input.now || (() => new Date());
  }

  private requireSecret() {
    if (!this.secret) {
      throw new BrowserAuthError(503, 'AUTH_CONFIG_UNAVAILABLE', 'Authentication unavailable');
    }
  }

  private roleFor(username: string) {
    return this.adminUsernames.has(username.toLowerCase()) ? 'admin' : 'user';
  }

  private publicUser(entry: Credential) {
    return {
      id: entry.id,
      username: entry.username,
      email: entry.email,
      display_name: entry.displayName,
      role: entry.role || 'user',
      organization_id: entry.organizationId || BOOTSTRAP_ORG_ID,
    };
  }

  private createToken(entry: Credential) {
    this.requireSecret();
    const now = Math.floor(this.now().getTime() / 1000);
    const header = base64urlJson({ alg: 'HS256', typ: 'JWT' });
    const payload = base64urlJson({
      sub: entry.id,
      username: entry.username,
      role: entry.role || 'user',
      organization_id: entry.organizationId || BOOTSTRAP_ORG_ID,
      iat: now,
      exp: now + this.ttlSeconds,
      iss: this.issuer,
      aud: this.audience,
    });
    const signature = createHmac('sha256', this.secret)
      .update(`${header}.${payload}`)
      .digest('base64url');
    return `${header}.${payload}.${signature}`;
  }

  private verifyToken(token: string): Record<string, unknown> | null {
    this.requireSecret();
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, signature] = parts as [string, string, string];
    const expected = createHmac('sha256', this.secret)
      .update(`${header}.${payload}`)
      .digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(signature, 'base64url');
    } catch {
      return null;
    }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    try {
      const parsedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
      const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      const now = Math.floor(this.now().getTime() / 1000);
      if (
        parsedHeader?.alg !== 'HS256' ||
        parsedHeader?.typ !== 'JWT' ||
        typeof parsed?.sub !== 'string' ||
        !Number.isFinite(parsed?.exp) ||
        parsed.exp < now ||
        parsed.iss !== this.issuer ||
        parsed.aud !== this.audience
      ) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private async reconcileRole(entry: Credential) {
    const desired = this.roleFor(entry.username);
    if (entry.role === desired) return entry;
    await this.credentials.setRole(entry.id, desired);
    return { ...entry, role: desired };
  }

  async register(body: Record<string, unknown>) {
    this.requireSecret();
    if (!this.allowPublicRegister) {
      throw new BrowserAuthError(403, 'REGISTRATION_DISABLED', 'Public registration is disabled');
    }
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!USERNAME.test(username)) {
      throw new BrowserAuthError(422, 'AUTH_INPUT_INVALID', 'Username must be 2–64 valid characters');
    }
    if (password.length < 6 || password.length > 128) {
      throw new BrowserAuthError(422, 'AUTH_INPUT_INVALID', 'Password must be 6–128 characters');
    }
    if (await this.credentials.getByUsername(username)) {
      throw new BrowserAuthError(409, 'USERNAME_EXISTS', 'Username already exists');
    }
    try {
      const entry = await this.credentials.create({
        username,
        passwordHash: await hashPassword(password),
        externalUserId: `user_${randomBytes(8).toString('hex')}`,
        externalOrgId: BOOTSTRAP_ORG_ID,
        email: safeText(body.email, 'email', 320),
        displayName: safeText(body.display_name, 'display_name', 255),
        role: this.roleFor(username),
      });
      if (!entry) throw new Error('credential insert did not persist');
      return { token: this.createToken(entry), user: this.publicUser(entry) };
    } catch (error) {
      if (error instanceof BrowserAuthError) throw error;
      if (/duplicate|unique/i.test(String((error as Error)?.message || ''))) {
        throw new BrowserAuthError(409, 'USERNAME_EXISTS', 'Username already exists');
      }
      throw new BrowserAuthError(503, 'AUTH_STORE_UNAVAILABLE', 'Authentication unavailable');
    }
  }

  async login(body: Record<string, unknown>) {
    this.requireSecret();
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || password.length > 128) {
      throw new BrowserAuthError(422, 'AUTH_INPUT_INVALID', 'Username and password are required');
    }
    let entry: Credential | null;
    try {
      entry = await this.credentials.getByUsername(username);
    } catch {
      throw new BrowserAuthError(503, 'AUTH_STORE_UNAVAILABLE', 'Authentication unavailable');
    }
    if (!entry?.isActive || !(await verifyPassword(password, entry.passwordHash))) {
      throw new BrowserAuthError(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
    }
    try {
      entry = await this.reconcileRole(entry);
      await this.credentials.touchLogin(entry.id);
    } catch {
      throw new BrowserAuthError(503, 'AUTH_STORE_UNAVAILABLE', 'Authentication unavailable');
    }
    return { token: this.createToken(entry), user: this.publicUser(entry) };
  }

  async me(authorization: string | undefined) {
    const match = /^Bearer\s+(.+)$/i.exec(String(authorization || ''));
    const payload = match ? this.verifyToken(match[1] as string) : null;
    if (!payload) {
      throw new BrowserAuthError(401, 'INVALID_TOKEN', 'Invalid or expired token');
    }
    let entry: Credential | null;
    try {
      entry = await this.credentials.getByExternalUserId(String(payload.sub));
      if (entry?.isActive) entry = await this.reconcileRole(entry);
    } catch {
      throw new BrowserAuthError(503, 'AUTH_STORE_UNAVAILABLE', 'Authentication unavailable');
    }
    if (!entry?.isActive) {
      throw new BrowserAuthError(401, 'INVALID_TOKEN', 'Invalid or expired token');
    }
    return this.publicUser(entry);
  }
}

