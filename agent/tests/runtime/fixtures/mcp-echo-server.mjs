/**
 * 一个**真实**的 MCP stdio 服务器，用官方 SDK 实现（`@modelcontextprotocol/sdk`
 * 本来就是 `dsh-mcp-client` 的依赖，所以不引入新依赖）。
 *
 * 存在的理由：H7.8 要证的是「出厂 `dsh-mcp-client` 真的能连上一台 MCP 服务器、
 * 把它的工具注册成 `mcp__<server>__<tool>`、并且调得通」。用假的 transport 桩
 * 证不了这件事——那只能证明我们对协议的想象是自洽的。这台服务器讲的是真协议。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'echo-server', version: '0.0.1' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echo the given text back.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'echo') {
    throw new Error(`unknown tool ${request.params.name}`);
  }
  const text = String(request.params.arguments?.text ?? '');
  return { content: [{ type: 'text', text: `echo:${text}` }] };
});

await server.connect(new StdioServerTransport());
