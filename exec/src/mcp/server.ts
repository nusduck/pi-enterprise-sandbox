/**
 * 独立部署的 Streamable HTTP MCP 应用。移植自 `sandbox/mcp/app.py`。
 *
 * 这是整个系统里唯一对外暴露的进程。它拿到的 `SANDBOX_MCP_INTERNAL_TOKEN`
 * 只够走 `/internal/mcp/v1/*` 那八条窄桥路由，够不到执行面的完整内部面——
 * 这是它单独部署（而不是折进 exec 主进程）的全部理由。
 *
 * ## Model Experience
 * 模型通过 `POST /mcp` 说话，看到六个工具。鉴权失败返回的是固定短句，不区分
 * "token 错"与"token 没配"之外的任何细节（没配是 503，错是 401——运维需要
 * 分得清这两种，攻击者从中得不到别的）。
 *
 * ## Known Limitations and Deferred Work
 * - 无状态模式：每个请求新建一个 `McpServer` + transport。会话恢复
 *   （Last-Event-ID 重放）因此不可用，与 Python 版 `stateless_http=True` 一致。
 */
import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { artifactContentDisposition, artifactFilenameHeader } from './disposition.js';
import { McpFacadeError, type McpFacadeService } from './service.js';
import type { McpSettings } from './settings.js';
import { registerMcpTools } from './tools.js';

const INSTRUCTIONS =
  'Execute Python and manage files in an isolated persistent Sandbox workspace.';

/**
 * 固定 bearer 比对，只用于 MCP 端点。
 *
 * 逐条保留 Python 版的收紧：恰好一个 Authorization 头（多个直接拒）、
 * token 不含空白、非 ASCII 解码失败即拒、比对走定长时间。
 */
function bearerOk(headerValues: string[], expected: string): boolean {
  if (expected === '' || headerValues.length !== 1) return false;
  const raw = headerValues[0] as string;
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/.test(raw)) return false;
  if (!raw.startsWith('Bearer ')) return false;
  const token = raw.slice('Bearer '.length);
  if (token === '' || token !== token.trim() || /\s/.test(token)) return false;
  const a = Buffer.from(token, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 一个 Host/Origin 是否被允许。支持 `host:*` 尾部通配。
 *
 * **为什么自己做而不交给 SDK**：Python 的 `TransportSecuritySettings` 支持
 * `localhost:*` 这类通配；TS SDK 的实现是 `allowedHosts.includes(hostHeader)`
 * ——精确匹配。把 Python 的值原样传过去，`localhost:*` 就是死条目，而
 * `localhost`（不带端口）几乎不会出现在真实 Host 头里，于是**所有**请求都被
 * 403 掉。SDK 自己也把那两个选项标成 `@deprecated: use external middleware`，
 * 所以检查放在这里，SDK 的那套不启用。
 */
export function matchesAllowList(value: string, allowList: readonly string[]): boolean {
  for (const entry of allowList) {
    if (entry === value) return true;
    if (entry.endsWith(':*')) {
      const prefix = entry.slice(0, -1); // 保留冒号
      if (value.startsWith(prefix)) return true;
    }
  }
  return false;
}

/** DNS 重绑定守卫的允许列表，与 Python 的 `_transport_security()` 一致。 */
export function transportSecurity(publicBaseUrl: string): {
  allowedHosts: string[];
  allowedOrigins: string[];
} {
  const hosts = new Set([
    'localhost',
    'localhost:*',
    '127.0.0.1',
    '127.0.0.1:*',
    'sandbox-mcp',
    'sandbox-mcp:*',
  ]);
  const origins = new Set(['http://localhost:*', 'http://127.0.0.1:*']);
  try {
    const parsed = new URL(publicBaseUrl);
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host !== '') {
      hosts.add(parsed.host);
      origins.add(`${parsed.protocol}//${parsed.host}`);
    }
  } catch {
    // 没配或配错 public base url 时只保留本机允许项——与 Python 的 urlparse
    // 在无 scheme 时不添加任何条目等价。
  }
  return { allowedHosts: [...hosts].sort(), allowedOrigins: [...origins].sort() };
}

export function createMcpApp(settings: McpSettings, service: McpFacadeService): Hono {
  const app = new Hono();
  const security = transportSecurity(settings.publicBaseUrl);

  app.get('/health', (c) => c.json({ status: 'ok', service: 'sandbox-mcp' }));

  // 运维常把客户端指到 http://host:8082/ —— MCP 在 /mcp。
  app.on(['GET', 'POST', 'HEAD'], '/', (c) =>
    c.json(
      {
        detail:
          'MCP Streamable HTTP endpoint is POST /mcp ' +
          '(Authorization: Bearer <SANDBOX_MCP_TOKEN>). ' +
          'Use http://<host>:8082/mcp — not the service root.',
        health: '/health',
        mcp: '/mcp',
      },
      404,
    ),
  );

  // 产物下载走签名 URL，不走 bearer：链接本身就是凭证。
  app.get('/artifacts/:artifactId', async (c) => {
    const artifactId = c.req.param('artifactId');
    const token = c.req.query('token') ?? '';
    let metadata: Record<string, unknown> | null;
    try {
      metadata = await service.getArtifact(artifactId, token);
    } catch {
      // Redis / 网络故障不能变成对客户端不透明的 500。
      return c.json({ detail: 'Artifact unavailable' }, 503);
    }
    if (metadata === null) return c.json({ detail: 'Artifact not found' }, 404);

    let upstream: Response;
    try {
      upstream = await service.artifactStream(artifactId, String(metadata['sandbox_session_id'] ?? ''));
    } catch {
      return c.json({ detail: 'Artifact unavailable' }, 503);
    }

    const filename = String(metadata['name'] ?? 'artifact');
    // 显示名是标题；扩展名可能只存在于存储路径里。
    const storedPath = String(metadata['path'] ?? '');
    const mediaType = String(metadata['mime_type'] ?? 'application/octet-stream');
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'content-type': mediaType,
        'content-disposition': artifactContentDisposition(filename, storedPath),
        'x-artifact-filename': artifactFilenameHeader(filename, storedPath),
      },
    });
  });

  app.on(['POST', 'GET', 'DELETE'], '/mcp', async (c) => {
    const authHeaders = c.req.raw.headers.get('authorization');
    // Headers 会把重复的 Authorization 合并成 ", " 分隔的一条；Python 版对
    // "恰好一个头" 的收紧在这里表现为"合并结果里不能含分隔逗号"。
    const values = authHeaders === null ? [] : authHeaders.split(', ');
    if (!bearerOk(values, settings.token)) {
      const configured = settings.token.trim() !== '';
      return c.json(
        {
          detail: configured
            ? 'Invalid or missing MCP authentication'
            : 'MCP service unavailable',
        },
        configured ? 401 : 503,
      );
    }

    // DNS 重绑定守卫，语义同 Python（见 matchesAllowList 的注释）。
    // Host 头缺失也拒——没有它无法判断请求指向谁。
    const host = c.req.header('host') ?? '';
    if (!matchesAllowList(host, security.allowedHosts)) {
      return c.json({ detail: `Invalid Host header: ${host}` }, 403);
    }
    const origin = c.req.header('origin');
    if (origin !== undefined && !matchesAllowList(origin, security.allowedOrigins)) {
      return c.json({ detail: 'Invalid Origin header' }, 403);
    }

    // 无状态：每请求一套 server + transport。
    const server = new McpServer(
      { name: 'Enterprise Sandbox', version: '1.0.0' },
      { instructions: INSTRUCTIONS },
    );
    registerMcpTools(server, service);
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      // 守卫在上面自己做了：SDK 的实现是精确匹配，表达不了 `host:*`。
      enableDnsRebindingProtection: false,
    });
    await server.connect(transport);
    let response: Response;
    try {
      response = await transport.handleRequest(c.req.raw);
    } catch {
      void server.close();
      throw new McpFacadeError('MCP request failed');
    }
    // 无状态模式下每个请求自带一套 server+transport，用完必须关，否则
    // keep-alive 定时器会一直挂着，进程按请求数泄漏。但流式响应（SSE）的
    // body 还没写完，这时关会把响应掐断——那种情况交给 transport 自己在流
    // 结束时收尾。
    const streaming = (response.headers.get('content-type') ?? '').includes('text/event-stream');
    if (!streaming) void server.close();
    return response;
  });

  return app;
}

export { McpFacadeError };
