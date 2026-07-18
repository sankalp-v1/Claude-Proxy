# Claude-Proxy — Cloudflare Worker AI Gateway

A production-grade Cloudflare Worker that proxies Claude Code (and any Anthropic-compatible client) to NVIDIA NIM endpoints.

Clients talk Anthropic API. The Worker handles everything else:
- Model alias resolution
- Authentication (NVIDIA API key stays in Cloudflare Secrets)
- Circuit breaking per model
- Automatic fallback chains
- Structured JSON logging
- In-memory Prometheus metrics

---

## Quick Start

Plug-and-play: bring an [NVIDIA NIM API key](https://build.nvidia.com/) (free — open any model page and click "Get API Key"), get a live Worker URL back.

### Option A — one-click deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sankalp-v1/claude-proxy)

Clicking this forks the repo into your GitHub, prompts you for `NVIDIA_API_KEY` right in the Cloudflare dashboard, and deploys. No terminal required.

### Option B — CLI

```bash
git clone https://github.com/sankalp-v1/claude-proxy
cd claude-proxy
npm run setup
```

The setup script installs dependencies, prompts for your `NVIDIA_API_KEY`, stores it as a Cloudflare secret, deploys, and prints the export commands below with your real Worker URL filled in.

Prefer doing it by hand?

```bash
npm install
npx wrangler secret put NVIDIA_API_KEY   # paste your NIM key when prompted
npx wrangler dev                          # local dev server
npx wrangler deploy                       # ship it
```

### Point Claude Code at your Worker

```bash
export ANTHROPIC_BASE_URL=https://<your-worker>.workers.dev
export ANTHROPIC_API_KEY=dummy
```

That's the whole integration surface. No provider URLs, no NVIDIA credentials, ever touch the client — only your NVIDIA API key on the Worker side, entered once.

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/messages` | Anthropic Messages API (canonical) |
| `POST` | `/messages` | Alias |
| `POST` | `/` | Alias |
| `POST` | `/openai/<provider_url>/v1/messages` | Legacy backwards-compat |
| `GET`  | `/v1/models` | List available models and aliases |
| `GET`  | `/health` | Gateway health + circuit breaker state |
| `GET`  | `/v1/health` | Same as `/health` |
| `GET`  | `/metrics` | Prometheus text exposition |

---

## Environment Variables

| Name | Where | Description |
|------|-------|-------------|
| `NVIDIA_API_KEY` | Cloudflare Secret | **Required.** NVIDIA NIM API key. Set via `wrangler secret put` (or the one-click deploy prompt). |
| `METRICS_TOKEN` | Cloudflare Secret | Optional. Bearer token required to read `/metrics`. Leave unset to leave it open. |

Only `NVIDIA_API_KEY` is required — everything else has a sane default. See `.dev.vars.example` for local dev.

---

## Model Aliases

The Worker maps Anthropic model strings to NVIDIA NIM model IDs automatically.
All standard `claude-3-5-sonnet-*`, `claude-3-7-sonnet-*`, `claude-opus-4-*`, and
`claude-sonnet-4-*` aliases are supported.

See `src/registry.ts` for the full list.

---

## Running Tests

```bash
npm install
npx vitest run
```

Test files live in `tests/`.

---

## Health Check

```bash
curl https://<your-worker>.workers.dev/health | jq
```

```json
{
  "status": "ok",
  "circuits": {
    "deepseek-v4-flash": {
      "state": "CLOSED",
      "failures": 0,
      "successRate": 1,
      "p50LatencyMs": 412
    }
  },
  "metrics": {
    "uptimeSeconds": "3821.4",
    "models": {
      "deepseek-v4-flash": {
        "requests": 47,
        "errors": 0,
        "errorRate": 0,
        "p50LatencyMs": 412
      }
    }
  }
}
```

---

## Prometheus Metrics

```bash
curl https://<your-worker>.workers.dev/metrics
```

```
# HELP gateway_uptime_seconds Seconds since Worker isolate started
gateway_uptime_seconds 3821.4

# HELP gateway_requests_total Total requests dispatched, by model
gateway_requests_total{model="deepseek-v4-flash"} 47

# HELP gateway_errors_total Total upstream errors, by model
gateway_errors_total{model="deepseek-v4-flash"} 0

# HELP gateway_latency_p50_ms Rolling p50 latency in ms, by model
gateway_latency_p50_ms{model="deepseek-v4-flash"} 412.00
```
