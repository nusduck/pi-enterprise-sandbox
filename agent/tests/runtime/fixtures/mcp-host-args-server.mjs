/**
 * 真实 MCP stdio 服务器：模拟「智能问答平台」的 `ask(question, kb_id)`，
 * 把收到的参数原样回显，供宿主参数（docs/design/mcp-per-agent-arguments.md）
 * 的端到端断言使用——断言的是**服务器真正收到了什么**。
 *
 * `question` 为 `__crash__` 时进程退出，用来验证断线重连后仍走得通。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'qa-platform-fixture', version: '0.0.1' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'ask',
      description: 'Ask the knowledge base a question.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          kb_id: { type: 'string', description: 'Knowledge base id' },
          top_k: { type: 'integer' },
        },
        required: ['question', 'kb_id'],
      },
    },
    {
      name: 'ping',
      description: 'Liveness check without host arguments.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {};
  if (request.params.name === 'ping') {
    return { content: [{ type: 'text', text: `pong pid=${process.pid}` }] };
  }
  if (request.params.name !== 'ask') throw new Error(`unknown tool ${request.params.name}`);
  if (args.question === '__crash__') process.exit(3);
  return {
    content: [{ type: 'text', text: `RECEIVED ${JSON.stringify(args)} pid=${process.pid}` }],
  };
});

await server.connect(new StdioServerTransport());
