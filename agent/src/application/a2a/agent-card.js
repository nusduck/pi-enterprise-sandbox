/**
 * A2A Agent Card builder + public base URL policy (plan §20.1).
 *
 * Production: A2A_PUBLIC_BASE_URL required, https only, no userinfo/query/fragment.
 * Development fallback: explicitly gated; only loopback hosts; never trust
 * arbitrary Host / X-Forwarded-Host for credential targets.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ValidationError } from '../errors.js';

/** Cap skill discovery so Agent Card stays lightweight for registry crawlers. */
const MAX_CARD_SKILLS = 64;
const SKILL_MD_READ_BYTES = 4096;

/**
 * Normalize loose skill descriptors into A2A AgentSkill objects.
 * Required fields: id, name, description.
 *
 * @param {unknown} skills
 * @returns {object[]}
 */
export function normalizeAgentSkills(skills) {
  if (!Array.isArray(skills)) return [];
  /** @type {object[]} */
  const out = [];
  const seen = new Set();
  for (const raw of skills) {
    if (out.length >= MAX_CARD_SKILLS) break;
    if (typeof raw === 'string' && raw.trim()) {
      const id = raw.trim().slice(0, 128);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        name: id,
        description: `Skill package: ${id}`,
        tags: ['skill'],
      });
      continue;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const r = /** @type {Record<string, unknown>} */ (raw);
    const idRaw = r.id ?? r.skillId ?? r.name;
    if (typeof idRaw !== 'string' || !idRaw.trim()) continue;
    const id = idRaw.trim().slice(0, 128);
    if (seen.has(id)) continue;
    seen.add(id);
    const name =
      typeof r.name === 'string' && r.name.trim()
        ? r.name.trim().slice(0, 256)
        : id;
    const description =
      typeof r.description === 'string' && r.description.trim()
        ? r.description.trim().slice(0, 1024)
        : `Skill: ${name}`;
    /** @type {Record<string, unknown>} */
    const skill = { id, name, description };
    if (Array.isArray(r.tags)) {
      skill.tags = r.tags
        .filter((t) => typeof t === 'string' && t.trim())
        .map((t) => String(t).trim().slice(0, 64))
        .slice(0, 16);
    }
    if (Array.isArray(r.examples)) {
      skill.examples = r.examples
        .filter((e) => typeof e === 'string' && e.trim())
        .map((e) => String(e).trim().slice(0, 256))
        .slice(0, 8);
    }
    out.push(skill);
  }
  return out;
}

/**
 * Baseline skills advertised when catalog/version does not list any.
 * Keeps discovery UIs from showing an empty capability list.
 * @returns {object[]}
 */
export function defaultAgentSkills() {
  return [
    {
      id: 'enterprise-analysis',
      name: 'Enterprise analysis',
      description:
        'Analyze data, answer questions, and produce reports using sandboxed tools and enterprise skills (documents, spreadsheets, code execution).',
      tags: ['analysis', 'enterprise', 'default'],
      examples: [
        'Summarize this dataset and highlight anomalies',
        'Generate a quarterly report with charts',
      ],
    },
  ];
}

/**
 * Parse YAML-like frontmatter from a SKILL.md (name / description only).
 * Intentionally minimal — avoids pulling a YAML dependency for Agent Card.
 *
 * @param {string} text
 * @returns {{ name?: string, description?: string }}
 */
export function parseSkillMdFrontmatter(text) {
  const src = String(text || '');
  if (!src.startsWith('---')) return {};
  const end = src.indexOf('\n---', 3);
  if (end < 0) return {};
  const block = src.slice(3, end).replace(/^\r?\n/, '');
  /** @type {{ name?: string, description?: string }} */
  const out = {};
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^(name|description)\s*:\s*(.*)$/i);
    if (!m) continue;
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!val) continue;
    if (m[1].toLowerCase() === 'name') out.name = val.slice(0, 256);
    else out.description = val.slice(0, 1024);
  }
  return out;
}

/**
 * List AgentSkill entries from a bundled skill root (directories with SKILL.md).
 * Fail-soft: missing root or unreadable packages are skipped.
 *
 * @param {string | null | undefined} skillRoot
 * @returns {object[]}
 */
export function listSkillsFromRoot(skillRoot) {
  if (typeof skillRoot !== 'string' || !skillRoot.trim()) return [];
  const root = path.resolve(skillRoot.trim());
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  /** @type {object[]} */
  const skills = [];
  for (const ent of entries) {
    if (skills.length >= MAX_CARD_SKILLS) break;
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
    const skillMd = path.join(root, ent.name, 'SKILL.md');
    let text = '';
    try {
      const fd = fs.openSync(skillMd, 'r');
      try {
        const buf = Buffer.alloc(SKILL_MD_READ_BYTES);
        const n = fs.readSync(fd, buf, 0, SKILL_MD_READ_BYTES, 0);
        text = buf.subarray(0, n).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue;
    }
    const meta = parseSkillMdFrontmatter(text);
    const id = (meta.name || ent.name).trim().slice(0, 128);
    skills.push({
      id,
      name: (meta.name || ent.name).trim().slice(0, 256),
      description:
        (meta.description || `Bundled skill package: ${ent.name}`).slice(
          0,
          1024,
        ),
      tags: ['skill', 'bundled'],
    });
  }
  return skills;
}

/**
 * Merge catalog/config skills with bundled packages; ensure non-empty card.
 *
 * @param {{
 *   configured?: unknown,
 *   skillRoot?: string | null,
 * }} [opts]
 * @returns {object[]}
 */
export function resolveAgentCardSkills(opts = {}) {
  const configured = normalizeAgentSkills(opts.configured);
  const bundled = listSkillsFromRoot(opts.skillRoot);
  if (configured.length === 0 && bundled.length === 0) {
    return defaultAgentSkills();
  }
  return normalizeAgentSkills([...configured, ...bundled]);
}

/** MIME modes this agent accepts as input (text parts only). */
export const A2A_SUPPORTED_INPUT_MODES = Object.freeze(['text/plain']);

/** MIME modes this agent may produce as outputs / artifacts. */
export const A2A_SUPPORTED_OUTPUT_MODES = Object.freeze([
  'text/plain',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

/** Stable extension URI for enterprise tenant fields on task metadata. */
export const A2A_ENTERPRISE_EXTENSION_URI =
  'https://pi-enterprise.local/a2a/extensions/enterprise/v1';

/**
 * @param {{
 *   agentId?: string,
 *   rpcPath?: string,
 *   name?: string | null,
 *   description?: string | null,
 *   baseUrl: string,
 *   version?: string,
 *   skills?: object[],
 *   skillRoot?: string | null,
 * }} input
 */
export function buildAgentCard(input) {
  const agentId = String(input.agentId || '').trim();
  const base = String(input.baseUrl || '').replace(/\/$/, '');
  if (!input.rpcPath && !agentId) {
    throw new ValidationError('Agent Card requires agentId or rpcPath');
  }
  const rpcPath = input.rpcPath || `/a2a/agents/${agentId}`;
  if (
    typeof rpcPath !== 'string' ||
    !/^\/(?!\/)/.test(rpcPath) ||
    /[?#]/.test(rpcPath)
  ) {
    throw new ValidationError(
      'Agent Card rpcPath must be an origin-relative path without query or fragment',
    );
  }
  const url = `${base}${rpcPath}`;
  const description =
    (typeof input.description === 'string' && input.description.trim()) ||
    'Enterprise data analysis agent (Pi Enterprise Sandbox)';
  const skills = resolveAgentCardSkills({
    configured: input.skills,
    skillRoot: input.skillRoot,
  });
  // Strict A2A v0.3 Agent Card — MIME types only, no v1 mixed fields.
  return {
    name:
      (typeof input.name === 'string' && input.name.trim()) ||
      'Enterprise Analysis Agent',
    description,
    url,
    version: input.version || '1.0.0',
    protocolVersion: '0.3',
    preferredTransport: 'JSONRPC',
    additionalInterfaces: [
      {
        url,
        transport: 'JSONRPC',
      },
    ],
    capabilities: {
      streaming: true,
      pushNotifications: false,
    },
    defaultInputModes: [...A2A_SUPPORTED_INPUT_MODES],
    defaultOutputModes: [...A2A_SUPPORTED_OUTPUT_MODES],
    skills,
    securitySchemes: {
      bearer: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'API Credential',
        description:
          'Bearer API credential bound to org_id, agent_id, client_id, and scopes',
      },
    },
    security: [{ bearer: [] }],
    supportsAuthenticatedExtendedCard: false,
    // Enterprise extension surface (org/client audit metadata on tasks).
    extensions: [
      {
        uri: A2A_ENTERPRISE_EXTENSION_URI,
        description:
          'Enterprise tenant metadata (org_id, client_id, budget) on task metadata',
        required: false,
      },
    ],
  };
}

/**
 * Strict public base URL validation for Agent Card / download links.
 *
 * @param {unknown} raw
 * @param {{ requireHttps?: boolean }} [opts]
 * @returns {string} origin without trailing slash
 */
export function assertPublicBaseUrl(raw, opts = {}) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new ValidationError('A2A_PUBLIC_BASE_URL is required');
  }
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ValidationError('A2A_PUBLIC_BASE_URL is not a valid URL');
  }
  const requireHttps = opts.requireHttps !== false;
  if (requireHttps && url.protocol !== 'https:') {
    throw new ValidationError('A2A_PUBLIC_BASE_URL must use https');
  }
  if (!requireHttps && url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ValidationError('A2A_PUBLIC_BASE_URL must use http or https');
  }
  if (url.username || url.password) {
    throw new ValidationError('A2A_PUBLIC_BASE_URL must not include userinfo');
  }
  if (url.search || raw.includes('?')) {
    throw new ValidationError('A2A_PUBLIC_BASE_URL must not include query');
  }
  if (url.hash || raw.includes('#')) {
    throw new ValidationError('A2A_PUBLIC_BASE_URL must not include fragment');
  }
  if (!url.hostname) {
    throw new ValidationError('A2A_PUBLIC_BASE_URL must include a hostname');
  }
  // Origin only (no path) for stable agent card URL composition.
  if (url.pathname && url.pathname !== '/') {
    throw new ValidationError(
      'A2A_PUBLIC_BASE_URL must be origin-only (no path)',
    );
  }
  return url.origin;
}

const LOOPBACK_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
]);

/**
 * Resolve public base URL for Agent Card links.
 *
 * @param {import('node:http').IncomingMessage | null} req
 * @param {{
 *   publicBaseUrl?: string | null,
 *   deploymentEnv?: string,
 *   allowDevHostFallback?: boolean,
 * }} [config]
 * @returns {string}
 */
export function resolvePublicBaseUrl(req, config = {}) {
  const envName = String(
    config.deploymentEnv || process.env.DEPLOYMENT_ENV || process.env.NODE_ENV || '',
  ).toLowerCase();
  const isProd = envName === 'production';

  if (config.publicBaseUrl && String(config.publicBaseUrl).trim()) {
    return assertPublicBaseUrl(config.publicBaseUrl, {
      requireHttps: isProd,
    });
  }

  if (isProd) {
    throw new ValidationError(
      'A2A_PUBLIC_BASE_URL is required in production (https origin, no userinfo/query/fragment)',
    );
  }

  // Dev-only gated fallback — never trust arbitrary X-Forwarded-Host.
  const allow =
    config.allowDevHostFallback === true ||
    String(process.env.A2A_ALLOW_DEV_HOST_FALLBACK || '').toLowerCase() ===
      'true';
  if (!allow) {
    throw new ValidationError(
      'A2A_PUBLIC_BASE_URL is required (set A2A_ALLOW_DEV_HOST_FALLBACK=true only for local loopback)',
    );
  }

  const hostHeader =
    typeof req?.headers?.host === 'string' ? req.headers.host.trim() : '';
  // Explicitly ignore X-Forwarded-Host (host injection surface).
  if (!hostHeader) {
    throw new ValidationError(
      'A2A_PUBLIC_BASE_URL missing and Host header unavailable for dev fallback',
    );
  }
  // Strip port for host check
  const hostname = hostHeader.replace(/^\[/, '').includes(']:')
    ? hostHeader
    : hostHeader.split(':')[0];
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (!LOOPBACK_HOSTS.has(hostname) && !LOOPBACK_HOSTS.has(bare)) {
    throw new ValidationError(
      'Dev host fallback only allows loopback Host (localhost / 127.0.0.1)',
    );
  }
  return `http://${hostHeader}`;
}
