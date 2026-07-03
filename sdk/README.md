# Pi Enterprise Sandbox SDK

> **Node.js SDK** for external frontend developers to interact with the Pi Enterprise Sandbox API.

Pure ESM — no external dependencies. Uses native `fetch()` (Node 18+).

---

## Installation

```bash
npm install pi-enterprise-sandbox-sdk
```

If you're working in the monorepo, or want to use it locally:

```bash
npm link /path/to/sdk
# or
npm install /path/to/sdk
```

---

## Quick Start

```js
import { SandboxClient } from 'pi-enterprise-sandbox-sdk';

const client = new SandboxClient({ sandboxUrl: 'http://localhost:8083' });

// Create a sandbox session
const session = await client.createSession('my-app');
console.log('Session:', session.session_id);

// Run a command
const result = await client.executeCommand(session.session_id, 'echo hello');
console.log('Output:', result.stdout_preview);

// Clean up
await client.deleteSession(session.session_id);
```

---

## API Reference

### `SandboxClient(options)`

| Option         | Type     | Required | Description                            |
|----------------|----------|----------|----------------------------------------|
| `sandboxUrl`   | `string` | ✅       | Base URL of the Sandbox API            |
| `llmioApiKey`  | `string` | ❌       | llm.io API key for proxied requests    |
| `modelId`      | `string` | ❌       | Model ID for proxied requests          |

---

### Session Lifecycle

| Method                     | HTTP Method | Endpoint                    |
|----------------------------|-------------|-----------------------------|
| `createSession(callerId?)` | `POST`      | `/sessions`                 |
| `getSession(id)`           | `GET`       | `/sessions/:id`             |
| `deleteSession(id)`        | `DELETE`    | `/sessions/:id`             |

### Execution

| Method                                   | HTTP Method | Endpoint                                    |
|------------------------------------------|-------------|---------------------------------------------|
| `executeCommand(sessionId, command, timeout?)`  | `POST`      | `/sessions/:id/executions/command` |
| `executePython(sessionId, code, timeout?)`      | `POST`      | `/sessions/:id/executions/python`  |

### File Operations

| Method                                           | HTTP Method | Endpoint                             |
|--------------------------------------------------|-------------|--------------------------------------|
| `readFile(sessionId, path, offset?, limit?)`     | `GET`       | `/sessions/:id/files/read`           |
| `writeFile(sessionId, path, content)`            | `POST`      | `/sessions/:id/files/write`          |
| `listFiles(sessionId, path?)`                    | `GET`       | `/sessions/:id/files`                |

### Artifacts

| Method                         | HTTP Method | Endpoint                       |
|--------------------------------|-------------|--------------------------------|
| `listArtifacts(sessionId)`     | `GET`       | `/sessions/:id/artifacts`      |

### Monitoring

| Method     | HTTP Method | Endpoint   |
|------------|-------------|------------|
| `health()` | `GET`       | `/health`  |

---

## Error Handling

All methods throw a `SandboxError` on non-2xx responses or network failures.

```js
import { SandboxClient, SandboxError } from 'pi-enterprise-sandbox-sdk';

try {
  await client.getSession('nonexistent');
} catch (err) {
  if (err instanceof SandboxError) {
    console.error(`HTTP ${err.statusCode}: ${err.message}`);
    console.error('Response body:', err.body);
  } else {
    console.error('Unexpected error:', err);
  }
}
```

### `SandboxError` Properties

| Property     | Type     | Description                     |
|--------------|----------|---------------------------------|
| `statusCode` | `number` | HTTP status code (`0` for network errors) |
| `message`    | `string` | Error description               |
| `body`       | `object` | Optional parsed response body   |

---

## Architecture: Sandbox API Proxy Pattern

```
┌──────────────────┐
│   Frontend App   │
│  (your code)     │
└────────┬─────────┘
         │  HTTP (client SDK)
         ▼
┌──────────────────┐
│  Pi Agent        │  ← llm.io proxy (optional)
│  Sandbox API     │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Sandbox Runtime │  ← isolated workspace per session
│  (commands,      │
│   files, python) │
└──────────────────┘
```

The SDK talks directly to the Pi Enterprise Sandbox API. In production deployments, requests may route through the Pi Agent (via llm.io), which handles authentication, approval workflows, and policy enforcement. When routing through the proxy, pass the `llmioApiKey` and `modelId` options and the proxy will forward them as headers.

---

## TypeScript / JSDoc Support

The SDK includes JSDoc type definitions in `types.js`. For editors that support JSDoc import (VS Code, WebStorm):

```js
/** @type {import('pi-enterprise-sandbox-sdk/types').SessionResponse} */
const session = await client.createSession('demo');
```

---

## Development

```bash
# No build step required — just import the .js files directly
node examples/basic.js
```
