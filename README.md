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
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
```

That's the whole integration surface. No provider URLs, no NVIDIA credentials, ever touch the client — only your NVIDIA API key on the Worker side, entered once.

The third line turns on Claude Code's [gateway model discovery](https://code.claude.com/docs/en/llm-gateway-protocol.md#model-discovery) (requires Claude Code v2.1.129+): on startup it hits `GET /v1/models` on your Worker and adds every model returned there to the `/model` picker, labeled "From gateway." Run `/model` inside Claude Code and every model in `src/registry.ts` — DeepSeek V4 Pro, DeepSeek V4 Flash, Kimi K2.6, GLM 5.1 — shows up by name, no per-model env vars, no client-side config. Add a model to the registry and it appears in the picker on the next Claude Code startup, nothing else to wire up.

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/messages` | Anthropic Messages API (canonical) |
| `POST` | `/messages` | Alias |
| `POST` | `/` | Alias |
| `POST` | `/openai/<provider_url>/v1/messages` | Legacy backwards-compat |
| `GET`  | `/v1/models` | List available models and aliases. Shape matches Claude Code's [gateway model discovery](https://code.claude.com/docs/en/llm-gateway-protocol.md#model-discovery) contract — `id` is prefixed `claude-nim-*` so Claude Code's `/model` picker doesn't filter it out. |
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
`claude-sonnet-4-*` aliases are supported, alongside each model's own name
(`deepseek-v4-pro`, `kimi-k2`, ...) and its `claude-nim-*` discovery ID (see
above) — all resolve to the same `ModelEntry`.

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
