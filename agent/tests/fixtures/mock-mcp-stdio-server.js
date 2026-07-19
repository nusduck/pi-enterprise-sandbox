#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

const server = new McpServer({
  name: 'pi-enterprise-mock-mcp',
  version: '1.0.0',
});

server.registerTool(
  'echo',
  {
    description: 'Echo a value through a real MCP stdio transport',
    inputSchema: {
      value: z.string(),
    },
  },
  async ({ value }) => ({
    content: [{ type: 'text', text: `mock:${value}` }],
  }),
);

await server.connect(new StdioServerTransport());

