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

```bash
# Install deps
npm install

# Set your NVIDIA API key as a Cloudflare secret
npx wrangler secret put NVIDIA_API_KEY

# Dev server
npx wrangler dev

# Deploy
npx wrangler deploy
```

Then point Claude Code at your Worker:

```bash
export ANTHROPIC_BASE_URL=https://<your-worker>.workers.dev
export ANTHROPIC_API_KEY=dummy
```

No provider URLs. No NVIDIA credentials on the client.

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
| `NVIDIA_API_KEY` | Cloudflare Secret | NVIDIA NIM API key. Set via `wrangler secret put`. |

No other env vars are needed.

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
    "nvidia-llama-3.1-70b": {
      "state": "CLOSED",
      "failures": 0,
      "successRate": 1,
      "p50LatencyMs": 412
    }
  },
  "metrics": {
    "uptimeSeconds": "3821.4",
    "models": {
      "nvidia-llama-3.1-70b": {
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
gateway_requests_total{model="nvidia-llama-3.1-70b"} 47

# HELP gateway_errors_total Total upstream errors, by model
gateway_errors_total{model="nvidia-llama-3.1-70b"} 0

# HELP gateway_latency_p50_ms Rolling p50 latency in ms, by model
gateway_latency_p50_ms{model="nvidia-llama-3.1-70b"} 412.00
```
