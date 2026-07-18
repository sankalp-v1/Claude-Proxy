# Architecture

## Request Flow

```
Client (Claude Code)
  │
  │  POST /v1/messages
  │  Authorization: Bearer dummy
  ▼
Cloudflare Worker  (src/index.ts)
  ├─ Validate path
  ├─ Extract client key (discarded)
  ├─ Inject env.NVIDIA_API_KEY
  └─ routeRequest()  (src/router.ts)
        ├─ resolveModelEntry()  (src/registry.ts)
        ├─ healthManager.isAvailable()  (src/health.ts)
        ├─ metrics.recordRequest()  (src/metrics.ts)
        ├─ provider.convertToProviderRequest()  (src/providers/openai.ts)
        ├─ fetch() → NVIDIA NIM
        ├─ healthManager.recordSuccess/Failure()
        ├─ metrics.recordLatency()
        ├─ logger.response()  (src/logger.ts)
        └─ provider.convertToClaudeResponse()
  ▼
Client ← Anthropic-format response
```

---

## Module Responsibilities

| Module | Responsibility |
|--------|---------------|
| `index.ts` | Worker entry point; path routing; GET endpoints (`/health`, `/metrics`, `/v1/models`) |
| `router.ts` | Model resolution; circuit-breaker dispatch; fallback chain; logging; metrics |
| `registry.ts` | Single source of truth for all model IDs, aliases, providers, and fallback chains. Also derives each model's `claude-nim-*` discovery ID (`discoveryId()`) for Claude Code's gateway model discovery |
| `health.ts` | Per-model circuit breaker (CLOSED/OPEN/HALF_OPEN), latency p50, success rate |
| `metrics.ts` | In-memory Prometheus-style counters and histograms |
| `logger.ts` | Structured JSON logging bound to a request ID |
| `provider.ts` | `Provider` interface: `convertToProviderRequest` + `convertToClaudeResponse` |
| `providers/openai.ts` | Anthropic ↔ OpenAI-compat translation (used for NVIDIA NIM) |
| `providers/gemini.ts` | Anthropic ↔ Google Gemini translation |
| `providers/index.ts` | Maps `ProviderID` → provider implementation |
| `types.ts` | All shared TypeScript types |
| `utils.ts` | SSE streaming, ID generation (`crypto.randomUUID`), JSON schema cleaning |

---

## Circuit Breaker States

```
       ┌─────────┐
       │ CLOSED │  ←── normal operation
       └───┬───┘
            │ 5 consecutive failures
            ▼
       ┌──────┐
       │ OPEN │  ←── requests short-circuited; 529 returned
       └───┬──┘
            │ backoff elapsed (30 s → 60 s → 120 s, max 300 s)
            ▼
     ┌──────────┐
     │ HALF_OPEN │  ←─ one probe allowed
     └────┬─────┘
        │       │
   success   failure
        │       │
        ▼       ▼
     CLOSED   OPEN (backoff doubled)
```

---

## Adding a New Provider

1. Implement the `Provider` interface in `src/providers/<name>.ts`
2. Register the new `ProviderID` in `src/providers/index.ts`
3. Add model entries to `src/registry.ts` using the new provider ID

No other files need to change.

---

## Adding a New Model

Edit `src/registry.ts` only. Add an entry to `REGISTRY` with:
- A unique `id` (matching the object key — used for circuit-breaker/metrics keys)
- `displayName`, `provider`, `providerModelId`, `providerBaseUrl`
- `aliases`: all Anthropic model strings that should route to this model
- Optional `fallback`: ordered list of model IDs to try if this one fails
- `capabilities`: feature flags (`streaming`, `toolUse`, `vision`)
