/**
 * CIDR 白名单——移植自 `sandbox/security/cidr.py` 的入站 IP 校验。
 *
 * 为什么需要它：exec 的内部面只对 Agent 容器开放，不对外。即使 HMAC 已验，
 * 仍需在网络层再挡一次非预期来源（比如误把 exec 暴露到 0.0.0.0 时，任何能
 * 拼出正确 HMAC 的内部服务也只能从固定网段进来）。这是 D9 保留的
 * "入站 CIDR 白名单"。
 *
 * 设计：纯函数，不读环境，不碰网络。输入是文本 IP + 文本 CIDR 列表，
 * 输出是是否允许。空列表 = 不限制（与 Python 版 `internal_allow_cidr` 为空
 * 时直接放行的语义一致），否则必须命中至少一个 CIDR。
 * IPv4/IPv6 都支持；用 Node 自带 `node:net` 的 isIP 解析。
 */

import { isIP } from 'node:net';

/** 一条已解析的 CIDR。 */
interface ParsedCidr {
  readonly family: 4 | 6;
  readonly base: Uint8Array;
  readonly prefix: number;
}

function parseIpToBytes(ip: string): { family: 4 | 6; bytes: Uint8Array } | null {
  const family = isIP(ip);
  if (family === 4) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
    return { family: 4, bytes: new Uint8Array(parts) };
  }
  if (family === 6) {
    // 展开 :: 缩写，逐段解析为 16 字节。
    const halves = ip.split('::');
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0]!.split(':').filter((s) => s.length > 0) : [];
    const tail = halves[1] ? halves[1]!.split(':').filter((s) => s.length > 0) : [];
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    const groups: string[] = [...head, ...Array(missing).fill('0'), ...tail];
    if (groups.length !== 8) return null;
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 8; i += 1) {
      const val = Number.parseInt(groups[i] as string, 16);
      if (!Number.isInteger(val) || val < 0 || val > 0xffff) return null;
      bytes[i * 2] = (val >> 8) & 0xff;
      bytes[i * 2 + 1] = val & 0xff;
    }
    return { family: 6, bytes };
  }
  return null;
}

function parseCidr(cidr: string): ParsedCidr | null {
  const slash = cidr.lastIndexOf('/');
  if (slash === -1) return null;
  const ipPart = cidr.slice(0, slash);
  const prefixPart = cidr.slice(slash + 1);
  const prefix = Number.parseInt(prefixPart, 10);
  if (!Number.isInteger(prefix) || prefix < 0) return null;
  const ip = parseIpToBytes(ipPart);
  if (!ip) return null;
  if (ip.family === 4 && prefix > 32) return null;
  if (ip.family === 6 && prefix > 128) return null;
  // 将 base 按 prefix 掩码后的网络地址
  const base = new Uint8Array(ip.bytes);
  const fullBytes = Math.floor(prefix / 8);
  const remainBits = prefix % 8;
  for (let i = fullBytes + (remainBits > 0 ? 1 : 0); i < base.length; i += 1) {
    base[i] = 0;
  }
  if (remainBits > 0) {
    const mask = 0xff << (8 - remainBits) & 0xff;
    base[fullBytes] = base[fullBytes]! & mask;
  }
  return { family: ip.family, base, prefix };
}

function ipInCidr(ipBytes: Uint8Array, cidr: ParsedCidr): boolean {
  if (ipBytes.length !== cidr.base.length) return false;
  const fullBytes = Math.floor(cidr.prefix / 8);
  for (let i = 0; i < fullBytes; i += 1) {
    if (ipBytes[i] !== cidr.base[i]) return false;
  }
  const remain = cidr.prefix % 8;
  if (remain > 0) {
    const mask = 0xff << (8 - remain) & 0xff;
    if ((ipBytes[fullBytes]! & mask) !== (cidr.base[fullBytes]! & mask)) return false;
  }
  return true;
}

/** 判断 `ip` 是否命中 `cidrs` 中至少一个。空列表 = 放行。 */
export function isIpAllowed(ip: string, cidrs: readonly string[]): boolean {
  if (cidrs.length === 0) return true;
  const parsedIp = parseIpToBytes(ip);
  if (!parsedIp) return false;
  for (const cidr of cidrs) {
    const parsed = parseCidr(cidr.trim());
    if (!parsed) continue;
    if (parsed.family !== parsedIp.family) continue;
    if (ipInCidr(parsedIp.bytes, parsed)) return true;
  }
  return false;
}

/** 从环境解析 CIDR 白名单：`EXEC_INTERNAL_ALLOW_CIDR` 逗号分隔。 */
export function readInternalAllowCidr(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const raw = env['EXEC_INTERNAL_ALLOW_CIDR'] ?? env['INTERNAL_ALLOW_CIDR'] ?? '';
  if (!raw.trim()) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
