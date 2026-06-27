/**
 * In-memory metrics counters.
 *
 * Tracks per-model request counts, error counts, and latency histograms.
 * Serialised to a simple text format at GET /metrics.
 *
 * Note: Cloudflare Workers may spawn multiple isolates; counters reset on
 * isolate eviction. For persistent metrics, forward to an external sink
 * (Prometheus push gateway, Cloudflare Analytics Engine, etc.).
 */

interface ModelMetrics {
    requests: number
    errors:   number
    latencies: number[]   // ring-buffer capped at LATENCY_CAP entries
}

/** Maximum latency samples retained per model. Prevents unbounded memory growth. */
const LATENCY_CAP = 1_000

class MetricsRegistry {
    private readonly data = new Map<string, ModelMetrics>()
    private readonly startTime = Date.now()

    private get(modelId: string): ModelMetrics {
        let m = this.data.get(modelId)
        if (!m) { m = { requests: 0, errors: 0, latencies: [] }; this.data.set(modelId, m) }
        return m
    }

    recordRequest(modelId: string): void {
        this.get(modelId).requests += 1
    }

    recordError(modelId: string): void {
        // NOTE: do NOT increment requests here — recordRequest() is always
        // called before the fetch, so incrementing again would double-count.
        this.get(modelId).errors += 1
    }

    recordLatency(modelId: string, ms: number): void {
        const m = this.get(modelId)
        // Ring-buffer: drop the oldest sample once the cap is reached
        if (m.latencies.length >= LATENCY_CAP) m.latencies.shift()
        m.latencies.push(ms)
    }

    /** Serialise to Prometheus-compatible text exposition format. */
    toText(): string {
        const lines: string[] = [
            `# HELP gateway_uptime_seconds Seconds since Worker isolate started`,
            `# TYPE gateway_uptime_seconds gauge`,
            `gateway_uptime_seconds ${((Date.now() - this.startTime) / 1000).toFixed(1)}`,
            '',
            `# HELP gateway_requests_total Total requests dispatched, by model`,
            `# TYPE gateway_requests_total counter`,
        ]

        for (const [model, m] of this.data) {
            const label = `model="${model}"`
            lines.push(`gateway_requests_total{${label}} ${m.requests}`)
        }

        lines.push('')
        lines.push(`# HELP gateway_errors_total Total upstream errors, by model`)
        lines.push(`# TYPE gateway_errors_total counter`)
        for (const [model, m] of this.data) {
            const label = `model="${model}"`
            lines.push(`gateway_errors_total{${label}} ${m.errors}`)
        }

        lines.push('')
        lines.push(`# HELP gateway_latency_p50_ms Rolling p50 latency in ms, by model`)
        lines.push(`# TYPE gateway_latency_p50_ms gauge`)
        for (const [model, m] of this.data) {
            const label = `model="${model}"`
            lines.push(`gateway_latency_p50_ms{${label}} ${computeP50(m.latencies).toFixed(2)}`)
        }

        lines.push('')
        return lines.join('\n')
    }

    /** JSON snapshot for the enhanced /health endpoint. */
    toJson(): Record<string, unknown> {
        const models: Record<string, unknown> = {}
        for (const [model, m] of this.data) {
            models[model] = {
                requests:   m.requests,
                errors:     m.errors,
                errorRate:  m.requests === 0 ? 0 : m.errors / m.requests,
                p50LatencyMs: computeP50(m.latencies),
            }
        }
        return {
            uptimeSeconds: ((Date.now() - this.startTime) / 1000).toFixed(1),
            models,
        }
    }
}

function computeP50(values: number[]): number {
    if (values.length === 0) return 0
    const sorted = [...values].sort((a, b) => a - b)
    const mid    = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid]
}

/** Singleton instance — shared across all requests in the same Worker isolate. */
export const metrics = new MetricsRegistry()
