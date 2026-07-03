# WebUI Guide

## Overview

The WebUI provides a ChatGPT-style chat interface for interacting with the Pi Agent through the Sandbox. It consists of a Node.js backend server and a vanilla JavaScript frontend.

## Architecture

```
Browser (ES modules)          Node.js Server            Sandbox Service
┌─────────────────┐    HTTP    ┌────────────────┐   HTTP   ┌────────────────┐
│  js/app.js       │◄─────────►│  server.js      │◄────────►│  FastAPI        │
│  js/chat.js      │  SSE      │  routes/        │          │  (port 8081)    │
│  js/api.js       │           │  services/      │          └────────────────┘
│  js/utils.js     │           │  config.js      │
│  js/conversations.js│        └────────────────┘
│  index.html       │
│  style.css        │
└─────────────────┘
```

### Server-Side Modules

| Module | Purpose |
|---|---|
| `server.js` | HTTP server, routing, startup/shutdown |
| `config.js` | All configuration constants (env-based) |
| `services/sandbox-client.js` | HTTP client for Sandbox API |
| `services/conversation-manager.js` | Conversation CRUD, persistence |
| `services/agent-factory.js` | Pi Agent creation, tool definitions |
| `routes/status.js` | `GET /api/status` handler |
| `routes/conversations.js` | Conversation CRUD handlers |
| `routes/chat.js` | SSE chat streaming handler |
| `routes/static.js` | Static file serving |

### Client-Side Modules

| Module | Purpose |
|---|---|
| `js/app.js` | Main entry, state management, event handlers |
| `js/api.js` | HTTP client for WebUI API |
| `js/chat.js` | Message rendering, streaming, tool indicators |
| `js/conversations.js` | Sidebar conversation list |
| `js/utils.js` | Markdown rendering, HTML escape, clipboard |

## Theming

The UI supports **dark** (default) and **light** themes.

- Toggle via the theme button in the sidebar footer
- Theme is persisted in `localStorage`
- Light theme is activated by `data-theme="light"` on `<html>`

### CSS Custom Properties

All colors are driven by CSS custom properties on `:root` / `[data-theme="light"]`:

- `--bg`, `--bg2` — background colors
- `--text`, `--text2`, `--text3` — text colors
- `--sidebar-bg`, `--sidebar-hover`, `--sidebar-active` — sidebar colors
- `--accent`, `--accent2` — primary accent (green)
- `--card`, `--border` — card and border colors
- `--danger` — error/danger color

## SSE Event Stream

The chat endpoint uses Server-Sent Events (SSE) for real-time communication.

### Event Types

```javascript
// Turn started
{ type: "turn_start", trace_id: "trace_abc123" }

// Token stream (text delta)
{ type: "token", text: "Hello" }

// Tool execution started
{ type: "tool_start", toolName: "bash", args: {command: "ls -la"} }

// Tool execution ended
{ type: "tool_end", toolName: "bash", isError: false }

// Error occurred
{ type: "error", text: "Something went wrong" }

// Conversation turn complete
{ type: "done" }
```

### Client-Side Consumption

```javascript
// In js/api.js
async function streamChat(convId, message, signal, callbacks) {
  const resp = await fetch(`/api/conversations/${convId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
    signal,
  });

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value);
    for (const line of chunk.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const data = JSON.parse(line.slice(6));

      switch (data.type) {
        case "token": callbacks.onToken?.(data.text); break;
        case "tool_start": callbacks.onToolStart?.(data); break;
        case "tool_end": callbacks.onToolEnd?.(data); break;
        case "done": callbacks.onDone?.(); break;
        case "error": callbacks.onError?.(data.text); break;
      }
    }
  }
}
```

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Enter` | Send message |
| `Shift+Enter` | New line in input |
| `Ctrl+Shift+C` (on code block) | Copy code |

## Extending the WebUI

### Adding a New Route

1. Create `webui/routes/my-route.js`
2. Export handler function(s)
3. Import and register in `webui/server.js`

```javascript
// webui/routes/my-route.js
export async function handleMyRoute(req, res) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ data: "hello" }));
}

// In server.js
import { handleMyRoute } from "./routes/my-route.js";

// In the router:
if (pathname === "/api/my-route") {
  return handleMyRoute(req, res);
}
```

### Adding a New Frontend Feature

1. Add logic in the appropriate `webui/js/*.js` module
2. Or create a new module and import it in `app.js`
3. Update `webui/style.css` as needed

### Changing the System Prompt

Edit the `SYSTEM_PROMPT` constant in `webui/config.js`. The prompt is injected into every new conversation's Pi Agent.

## Data Persistence

Conversations are persisted to `sandbox/data/webui/conversations.json`:

- Written after every conversation change
- Loaded on server startup
- Each conversation includes: id, title, createdAt, sandboxSessionId, messages[]
- Messages include role, content, trace_id, timestamp

Sandbox sessions are **not** persisted — they're recreated if the server restarts (conversations with `sandboxSessionId` attempt to restore).
