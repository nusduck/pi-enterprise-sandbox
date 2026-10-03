/**
 * 九个 MCP 工具的注册。移植自已退役的 Python 执行面（旧 `sandbox/mcp/app.py`，现为本模块）的 `@mcp.tool` 段。
 *
 * ## Model Experience
 * 工具名与描述**逐字**沿用 Python 版：外部客户端（UPAgent、Dify 等）的提示词
 * 里已经缓存了这些字面量，改一个字就是一次静默的行为变更，且会作废对端的
 * KV cache。`sandbox_artifact_submit` 的长描述尤其不能删——它是模型唯一能
 * 学到"要复用之前的 context_id"的地方，之前把它省掉导致过一批 FILE_NOT_FOUND。
 *
 * ## Known Limitations and Deferred Work
 * - 工具结果按 MCP 的 structuredContent 返回；没有 outputSchema，因此客户端
 *   拿到的是自由形状的 JSON，与 Python 版一致。
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpFacadeService } from './service.js';

type Json = Record<string, unknown>;

/** MCP 要求工具返回 content；同时给出 structuredContent 供结构化客户端使用。 */
function ok(data: Json): { content: [{ type: 'text'; text: string }]; structuredContent: Json } {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

export function registerMcpTools(server: McpServer, service: McpFacadeService): void {
  server.registerTool(
    'sandbox_python_execute',
    {
      description: "Execute Python in the context's isolated persistent workspace.",
      inputSchema: {
        code: z.string(),
        context_id: z.string().nullable().optional(),
        timeout_seconds: z.number().int().default(120),
      },
    },
    async ({ code, context_id, timeout_seconds }) =>
      ok(
        await service.executePython({
          contextId: context_id ?? null,
          code,
          timeoutSeconds: timeout_seconds,
        }),
      ),
  );

  server.registerTool(
    'sandbox_shell_execute',
    {
      description:
        "Execute a bash command in the context's isolated persistent workspace. Network access is disabled.",
      inputSchema: {
        command: z.string(),
        context_id: z.string().nullable().optional(),
        timeout_seconds: z.number().int().default(120),
      },
    },
    async ({ command, context_id, timeout_seconds }) =>
      ok(
        await service.executeShell({
          contextId: context_id ?? null,
          command,
          timeoutSeconds: timeout_seconds,
        }),
      ),
  );

  server.registerTool(
    'sandbox_file_write',
    {
      description: 'Write UTF-8 text to a file in the persistent Sandbox workspace.',
      inputSchema: {
        path: z.string(),
        content: z.string(),
        context_id: z.string().nullable().optional(),
        mode: z.string().default('overwrite'),
      },
    },
    async ({ path, content, context_id, mode }) =>
      ok(await service.fileWrite({ contextId: context_id ?? null, path, content, mode })),
  );

  server.registerTool(
    'sandbox_file_read',
    {
      description: 'Read a text file from the persistent Sandbox workspace.',
      inputSchema: {
        path: z.string(),
        context_id: z.string().nullable().optional(),
        offset: z.number().int().nullable().optional(),
        limit: z.number().int().nullable().optional(),
      },
    },
    async ({ path, context_id, offset, limit }) =>
      ok(
        await service.fileRead({
          contextId: context_id ?? null,
          path,
          offset: offset ?? null,
          limit: limit ?? null,
        }),
      ),
  );

  server.registerTool(
    'sandbox_file_list',
    {
      description: 'List files under a persistent Sandbox workspace path.',
      inputSchema: {
        context_id: z.string().nullable().optional(),
        path: z.string().default('.'),
        depth: z.number().int().default(1),
      },
    },
    async ({ context_id, path, depth }) =>
      ok(await service.fileList({ contextId: context_id ?? null, path, depth })),
  );

  server.registerTool(
    'sandbox_artifact_submit',
    {
      description:
        'Snapshot a generated workspace file and return a temporary download URL. ' +
        'source_path must be a relative path that already exists in the workspace. ' +
        'Pass the same context_id used by prior sandbox_file_write / sandbox_python_execute ' +
        'calls; omitting it creates a new empty workspace and will fail with FILE_NOT_FOUND.',
      inputSchema: {
        source_path: z.string(),
        context_id: z.string().nullable().optional(),
        name: z.string().nullable().optional(),
        mime_type: z.string().nullable().optional(),
      },
    },
    async ({ source_path, context_id, name, mime_type }) =>
      ok(
        await service.artifactSubmit({
          contextId: context_id ?? null,
          sourcePath: source_path,
          name: name ?? null,
          mimeType: mime_type ?? null,
        }),
      ),
  );

  server.registerTool(
    'sandbox_file_delete',
    {
      description:
        'Delete a file in the persistent Sandbox workspace. ' +
        'Deleting a directory requires recursive=true; the workspace root cannot be deleted.',
      inputSchema: {
        path: z.string(),
        context_id: z.string().nullable().optional(),
        recursive: z.boolean().default(false),
      },
    },
    async ({ path, context_id, recursive }) =>
      ok(await service.fileDelete({ contextId: context_id ?? null, path, recursive })),
  );

  server.registerTool(
    'sandbox_file_upload',
    {
      description:
        'Upload a binary file to the persistent Sandbox workspace. ' +
        'Content is standard base64; parent directories are created automatically.',
      inputSchema: {
        path: z.string(),
        content_base64: z.string(),
        context_id: z.string().nullable().optional(),
        overwrite: z.boolean().default(true),
      },
    },
    async ({ path, content_base64, context_id, overwrite }) =>
      ok(
        await service.fileUpload({
          contextId: context_id ?? null,
          path,
          contentBase64: content_base64,
          overwrite,
        }),
      ),
  );

  server.registerTool(
    'sandbox_file_search',
    {
      description:
        'Search file names by glob pattern and/or file contents by text query ' +
        'under a persistent Sandbox workspace path.',
      inputSchema: {
        context_id: z.string().nullable().optional(),
        path: z.string().default('.'),
        pattern: z.string().nullable().optional(),
        query: z.string().nullable().optional(),
        max_results: z.number().int().default(100),
      },
    },
    async ({ context_id, path, pattern, query, max_results }) =>
      ok(
        await service.fileSearch({
          contextId: context_id ?? null,
          path,
          pattern: pattern ?? null,
          query: query ?? null,
          maxResults: max_results,
        }),
      ),
  );
}
