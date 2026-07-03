# Deployment Guide

> Production deployment for Pi Enterprise Sandbox — multi-container, Nginx reverse proxy, SSL, resource limits, and persistent storage.

## Quick Start

```bash
# 1. Configure
cp .env.example .env
# Edit .env with your API keys and domain

# 2. Build & start (development)
docker compose up --build -d

# 3. Verify
curl http://localhost:8083/health
curl http://localhost:3000/api/status
```

## Production Deployment

```bash
# 1. Build & start with production overlay
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d

# 2. Open browser
open https://localhost    # self-signed cert warning in dev

# 3. Check everything is healthy
curl -sf https://localhost/api/status
curl -sf https://localhost/nginx/status
```

## Architecture

```
                         ┌───────────────────────┐
                         │   Nginx (443/80)       │
                         │   TLS + Rate Limit     │
                         └──────┬────────────────┘
                                │
                   ┌────────────▼──────────────┐
                   │   pi-agent:3000 BFF        │
                   │   Frontend + API proxy     │
                   │   LLM proxy (/api/proxy)   │
                   └────────────┬──────────────┘
                                │
                   ┌────────────▼──────────────┐
                   │   sandbox:8081             │
                   │   Execution · Files · Auth  │
                   │   SQLite / PostgreSQL      │
                   └───────────────────────────┘
```

## Configuration

### Environment Variables

#### Auth

| Variable | Default | Description |
|----------|---------|-------------|
| `SANDBOX_API_TOKEN` | — | API token for sandbox auth. Generate: `openssl rand -hex 32`. All API calls require `X-API-Key` header. |
| `SANDBOX_MCP_AUTH_TOKENS` | — | Comma-separated tokens for MCP endpoint auth. |

#### LLM Provider

| Variable | Default | Description |
|----------|---------|-------------|
| `LLMIO_BASE_URL` | — | **Required** — LLM API base URL |
| `LLMIO_API_KEY` | — | **Required** — LLM API key |
| `PI_MODEL` | `deepseek-v4-flash` | Model ID |

#### Domain & SSL

| Variable | Default | Description |
|----------|---------|-------------|
| `DOMAIN` | `localhost` | Domain for nginx SSL cert. For production, set to your real domain and use Let's Encrypt. |
| `NGINX_HTTP_PORT` | `80` | HTTP port |
| `NGINX_HTTPS_PORT` | `443` | HTTPS port |

#### Database

| Variable | Default | Description |
|----------|---------|-------------|
| `SANDBOX_DATABASE_URL` | `sqlite:////sandbox/data/sandbox.db` | SQLite (dev) or PostgreSQL (prod) |

**Development (SQLite):** No additional setup needed.

**Production (PostgreSQL):**
```yaml
# Add to docker-compose.yml:
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: sandbox
      POSTGRES_PASSWORD: <secure-password>
      POSTGRES_DB: sandbox
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U sandbox"]
    restart: always

volumes:
  postgres_data:
```

Then set:
```env
SANDBOX_DATABASE_URL=postgresql://sandbox:<password>@postgres:5432/sandbox
```

The sandbox already supports PostgreSQL via `psycopg2-binary` (pre-installed in the container).

#### Resource Limits

Configured via `docker-compose.prod.yml`:

| Variable | Default | Description |
|----------|---------|-------------|
| `SANDBOX_CPU_LIMIT` | `2` | Max CPU cores for sandbox |
| `SANDBOX_MEM_LIMIT` | `1g` | Max memory for sandbox |
| `AGENT_CPU_LIMIT` | `1` | Max CPU cores for pi-agent |
| `AGENT_MEM_LIMIT` | `512m` | Max memory for pi-agent |

#### Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `SANDBOX_LOG_LEVEL` | `INFO` | Log level (DEBUG, INFO, WARNING) |

Production logging config (in docker-compose.prod.yml):
- Driver: `json-file`
- Max size: `10m` per file
- Max files: `3`

## Auth (API Token)

When `SANDBOX_API_TOKEN` is set, the sandbox service requires all API calls (except health checks) to include:

```
X-API-Key: <your-token>
```

**How it works:**
1. Nginx → `pi-agent` BFF → `sandbox` service
2. The BFF automatically adds the `X-API-Key` header to all sandbox requests
3. Direct API calls (bypassing the BFF) also need the token

**To generate a token:**
```bash
openssl rand -hex 32
```

**To call the API directly:**
```bash
curl -H "X-API-Key: <token>" http://localhost:8083/health          # OK (exempt)
curl -H "X-API-Key: <token>" http://localhost:8083/sessions         # OK
curl http://localhost:8083/sessions                                  # 401
```

**Exempt endpoints:** `/health`, `/ready`, `/metrics`, `/docs`, `/openapi`, `/redoc`

## Volumes

| Volume | Path | Description |
|--------|------|-------------|
| `sandbox_data` | `/sandbox/data` | SQLite database, audit logs |
| `nginx_ssl` | `/etc/nginx/ssl` | SSL certificates |
| `nginx_certbot` | `/var/www/certbot` | Let's Encrypt ACME challenge |
| `./skills` | `/sandbox/skills:ro` | Built-in skills (read-only) |
| `./workspaces` | `/sandbox/workspaces` | Session workspaces |
| `./config/agent/` | Agent config | Mounted read-only |

## Health Checks

```bash
# Nginx
curl -f http://localhost:80/nginx/status

# WebUI status
curl -f http://localhost:3000/api/status
# {"status":"ok","sandbox":{"status":"ok",...},"conversations":0,...}

# Sandbox health
curl -f http://localhost:8083/health
# {"status":"ok","version":"0.1.0","sessions_active":0,...}

# Prometheus metrics
curl http://localhost:8083/metrics
```

## Backup

```bash
# Full backup
bash scripts/backup.sh
# Output: ./backups/sandbox-backup-20260401_120000.db
# ./backups/sandbox-backup-20260401_120000.env
# ./backups/sandbox-backup-20260401_120000-workspaces.tar.gz

# Restore
bash scripts/restore.sh ./backups/sandbox-backup-20260401_120000
```

## Monitoring

### Prometheus Metrics

The sandbox exposes metrics at `/metrics`:

| Metric | Type | Description |
|--------|------|-------------|
| `sandbox_execution_total` | Counter | Total executions by status |
| `sandbox_execution_failed_total` | Counter | Failed executions |
| `sandbox_execution_timeout_total` | Counter | Timed out executions |
| `sandbox_active_sessions` | Gauge | Active sessions |
| `sandbox_workspace_bytes` | Gauge | Workspace disk usage |
| `sandbox_rate_limited_total` | Counter | Rate limited requests |

### Container Monitoring

```bash
# Resource usage
docker stats pi-enterprise-sandbox pi-enterprise-agent

# Logs
docker compose logs -f --tail=100 sandbox
docker compose logs -f --tail=100 pi-agent

# Production logs (with nginx)
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f nginx
```

## Let's Encrypt (Production SSL)

For production with a real domain, use Certbot:

```bash
# Install certbot
apt-get install certbot

# Generate certificate
certbot certonly --webroot -w /var/www/certbot -d your-domain.com

# Copy to nginx volume
docker cp /etc/letsencrypt/live/your-domain.com/fullchain.pem nginx:/etc/nginx/ssl/
docker cp /etc/letsencrypt/live/your-domain.com/privkey.pem nginx:/etc/nginx/ssl/

# Reload nginx
docker exec nginx nginx -s reload
```

For automated renewal, add a cron job:

```bash
# /etc/cron.d/certbot-renew
0 3 * * * root certbot renew --quiet && docker exec pi-enterprise-nginx nginx -s reload
```

## Scaling

| Scenario | Recommendation |
|----------|---------------|
| Single-instance | SQLite + Docker Compose (default) |
| Multi-instance | PostgreSQL + shared workspace storage (NFS/EFS) |
| High availability | Add load balancer + PostgreSQL replication |

## Troubleshooting

### Sandbox container not starting

```bash
docker compose logs sandbox
docker compose run --rm sandbox python -c "import fastapi; print('ok')"
```

### WebUI shows "sandbox: unreachable"

```bash
# Check sandbox health
curl http://localhost:8083/health

# Check BFF→sandbox communication
docker exec pi-enterprise-agent curl -f http://sandbox:8081/health

# Restart services
docker compose restart
```

### API Token auth errors

```bash
# Check if token is set in sandbox
docker exec pi-enterprise-sandbox env | grep SANDBOX_API_TOKEN

# Check if BFF is passing the token
docker exec pi-enterprise-agent env | grep SANDBOX_API_TOKEN

# Test directly
curl -H "X-API-Key: <token>" http://localhost:8083/sessions
```

### Database issues

```bash
# Reset database
docker compose down -v  # WARNING: deletes all data
docker compose up -d

# Backup database
docker exec pi-enterprise-sandbox cp /sandbox/data/sandbox.db /tmp/sandbox-backup.db

# Run SQL queries
docker exec -it pi-enterprise-sandbox sqlite3 /sandbox/data/sandbox.db
```

## Docker Commands Reference

```bash
# Development
docker compose up --build -d            # Start all services
docker compose logs -f                  # Follow logs
docker compose down                     # Stop all services
docker compose restart                  # Restart all services

# Production
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d

# Rebuild single service
docker compose build sandbox
docker compose up -d sandbox

# Clean up
docker compose down -v                  # Remove volumes (destroys data!)
```
