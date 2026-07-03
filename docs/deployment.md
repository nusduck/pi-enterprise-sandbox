# Deployment Guide

## Docker Compose (Recommended)

### Quick Start

```bash
# 1. Clone
git clone <repo-url>
cd pi-sandbox

# 2. Configure environment
cp .env.example .env
# Edit .env with your settings (API keys, etc.)

# 3. Start all services
docker compose up --build -d

# 4. Verify
curl http://localhost:8083/health
curl http://localhost:3000/api/status
```

### Configuration

All configuration is via environment variables (see `.env.example`).

| Variable | Default | Description |
|---|---|---|
| `SANDBOX_PORT` | `8081` | Sandbox service port |
| `SANDBOX_HOST_PORT` | `8083` | Host port mapped to sandbox |
| `SANDBOX_MCP_PORT` | `8091` | MCP adapter port |
| `SANDBOX_MCP_HOST_PORT` | `8093` | Host port mapped to MCP |
| `SANDBOX_LOG_LEVEL` | `INFO` | Log level (DEBUG, INFO, WARNING) |
| `SANDBOX_DATABASE_URL` | `sqlite:////sandbox/data/sandbox.db` | Database connection |
| `SANDBOX_SESSION_TTL_MINUTES` | `30` | Session idle timeout |
| `SANDBOX_EXECUTION_TIMEOUT_SECONDS` | `120` | Per-command timeout |
| `AGENT_HOST_PORT` | `3000` | WebUI port mapped to host |
| `AGENT_ENV_FILE` | `.env` | Environment file for agent container |

### Volumes

| Volume | Path | Description |
|---|---|---|
| `sandbox_data` | `/sandbox/data` | Persistent database storage |
| `./skills:/sandbox/skills:ro` | Skills (read-only) |
| `./workspaces:/sandbox/workspaces` | Session workspaces |
| `./config/agent/` | Agent config (mounted) |

### Health Checks

```bash
# Sandbox service
curl http://localhost:8083/health
# {"status":"ok","version":"0.1.0","sessions_active":0,...}

# WebUI
curl http://localhost:3000/api/status
# {"status":"ok","conversations":0,"sandbox":{"status":"ok","sessions_active":0}}
```

## Production Deployment

### Recommendations

1. **Use a reverse proxy** (Nginx, Caddy) in front of the WebUI
2. **Enable auth tokens** — set `SANDBOX_AUTH_TOKEN` in the agent container
3. **Configure MCP auth** — set `SANDBOX_MCP_AUTH_TOKENS` for external access
4. **Use persistent volumes** for `sandbox_data` (not bind mounts)
5. **Set resource limits** via Docker compose `deploy.resources`
6. **Enable monitoring** — Prometheus metrics at `/metrics`

### Reverse Proxy Example (Nginx)

```nginx
server {
    listen 443 ssl;
    server_name sandbox.example.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    location /api/ {
        proxy_pass http://localhost:3000;
        proxy_buffering off;  # Required for SSE
    }
}
```

### Scaling

The Sandbox is designed for **single-instance** deployment. For multi-instance:

- Use a shared volume for workspaces (NFS, EFS)
- Use PostgreSQL instead of SQLite (requires code changes)
- Use a reverse proxy with sticky sessions

## Environment Variables Reference

### Sandbox

| Prefix: `SANDBOX_` | Default | Description |
|---|---|---|
| `HOST` | `0.0.0.0` | Bind address |
| `PORT` | `8081` | HTTP port |
| `MCP_HOST` | `0.0.0.0` | MCP bind address |
| `MCP_PORT` | `8091` | MCP port |
| `MCP_ENABLED` | `true` | Enable MCP adapter |
| `LOG_LEVEL` | `INFO` | Logging level |
| `DATABASE_URL` | `sqlite:////sandbox/data/sandbox.db` | DB URL |
| `WORKSPACES_ROOT` | `/sandbox/workspaces` | Workspaces directory |
| `SKILLS_ROOT` | `/sandbox/skills` | Skills directory |
| `EXECUTION_TIMEOUT_SECONDS` | `120` | Command timeout |
| `MAX_OUTPUT_CHARS` | `50000` | Max output chars |
| `SESSION_TTL_MINUTES` | `30` | Session idle TTL |
| `APPROVAL_TIMEOUT_SECONDS` | `300` | Approval wait timeout |
| `IPTABLES_ENABLED` | `true` | Network isolation |

### WebUI / Agent

| Prefix: `AGENT_` or plain | Default | Description |
|---|---|---|
| `AGENT_WEBUI_PORT` | `3000` | WebUI server port |
| `AGENT_WEBUI_DATA_DIR` | `./sandbox/data/webui` | Conversation persistence |
| `SANDBOX_BASE_URL` | `http://sandbox:8081` | Sandbox URL (Docker) |
| `LLMIO_API_KEY` | — | API key for LLM |
| `LLMIO_BASE_URL` | — | LLM API base URL |
| `PI_MODEL` | `deepseek-v4-flash` | Model ID |

## Troubleshooting

### Sandbox container not starting

```bash
# Check logs
docker compose logs sandbox

# Verify config
docker compose config

# Manual test
docker compose run --rm sandbox python -c "import fastapi; print('ok')"
```

### WebUI shows "sandbox: unreachable"

```bash
# Check if sandbox is running
curl http://localhost:8083/health

# Check network connectivity
docker exec pi-enterprise-agent curl -f http://sandbox:8081/health

# Restart services
docker compose restart
```

### Database issues

```bash
# Reset database
docker compose down -v  # WARNING: deletes all data
docker compose up -d

# Backup database
docker exec pi-enterprise-sandbox cp /sandbox/data/sandbox.db /tmp/sandbox-backup.db
```
