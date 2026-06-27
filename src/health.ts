/**
 * Health Manager — per-model circuit breaker with rolling latency tracking.
 *
 * Circuit states:
 *   CLOSED    — normal operation, all requests pass through
 *   OPEN      — upstream failed too many times; requests are short-circuited
 *   HALF_OPEN — probe period: one request allowed to test recovery
 *
 * Thresholds (conservative production defaults, easily overridden):
 *   Open after  : 5 consecutive failures
 *   Reset after : 30 s (exponential backoff: 30 s → 60 s → 120 s, capped 300 s)
 *   Half-open   : 1 probe; success → CLOSED, failure → OPEN (backoff doubled)
 *
 * NOTE: Each Cloudflare Worker isolate has its own HealthManager singleton.
 * Under high concurrency Cloudflare may spawn multiple isolates, so circuit
 * state is not shared across them. This is a fundamental constraint of the
 * stateless isolate model — a true global circuit breaker requires Durable
 * Objects or KV-backed state.
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export interface ModelHealth {
    state: CircuitState
    failures: number
    lastFailureTime: number   // epoch ms; 0 if never
    successRate: number       // 0.0 – 1.0 rolling window
    p50LatencyMs: number      // rolling median, 0 if no data
}

const FAILURE_THRESHOLD    = 5
const BASE_RESET_MS        = 30_000
const MAX_RESET_MS         = 300_000
const LATENCY_WINDOW_SIZE  = 1_000  // ring-buffer capacity

interface ModelState {
    circuit:       CircuitState
    failures:      number
    probeInFlight: boolean
    resetBackoff:  number           // current backoff ms
    lastFailureAt: number           // epoch ms
    // rolling success window (last 100 outcomes)
    outcomes:      boolean[]        // true = success
    // latency ring buffer
    latencies:     number[]         // ms
    latencyHead:   number           // write pointer
    latencyFull:   boolean          // true once ring is full
}

function makeState(): ModelState {
    return {
        circuit:       'CLOSED',
        failures:      0,
        probeInFlight: false,
        resetBackoff:  BASE_RESET_MS,
        lastFailureAt: 0,
        outcomes:      [],
        latencies:     new Array(LATENCY_WINDOW_SIZE).fill(0),
        latencyHead:   0,
        latencyFull:   false,
    }
}

export class HealthManager {
    private readonly models = new Map<string, ModelState>()

    private get(modelId: string): ModelState {
        let s = this.models.get(modelId)
        if (!s) { s = makeState(); this.models.set(modelId, s) }
        return s
    }

    // ── Query ──────────────────────────────────────────────────────────────

    /** Returns true when the request should be allowed through. */
    isAvailable(modelId: string): boolean {
        const s = this.get(modelId)
        if (s.circuit === 'CLOSED') return true
        if (s.circuit === 'OPEN') {
            const elapsed = Date.now() - s.lastFailureAt
            if (elapsed >= s.resetBackoff) {
                s.circuit       = 'HALF_OPEN'
                s.probeInFlight = false
            } else {
                return false
            }
        }
        // HALF_OPEN: allow exactly one probe at a time
        if (s.probeInFlight) return false
        s.probeInFlight = true
        return true
    }

    /** Snapshot health for a model (safe to call at any time). */
    snapshot(modelId: string): ModelHealth {
        const s = this.get(modelId)
        return {
            state:           s.circuit,
            failures:        s.failures,
            lastFailureTime: s.lastFailureAt,
            successRate:     this.computeSuccessRate(s),
            p50LatencyMs:    this.computeP50(s),
        }
    }

    /** All model IDs that have any recorded state. */
    modelIds(): string[] {
        return [...this.models.keys()]
    }

    // ── Record outcomes ────────────────────────────────────────────────────

    recordSuccess(modelId: string, latencyMs: number): void {
        const s = this.get(modelId)
        this.pushLatency(s, latencyMs)
        this.pushOutcome(s, true)

        s.failures = 0
        if (s.circuit === 'HALF_OPEN') {
            s.circuit       = 'CLOSED'
            s.probeInFlight = false
            s.resetBackoff  = BASE_RESET_MS   // reset backoff on recovery
        }
    }

    recordFailure(modelId: string): void {
        const s = this.get(modelId)
        this.pushOutcome(s, false)

        // Capture whether the circuit was already open BEFORE this failure
        const wasOpen = s.circuit === 'OPEN'

        s.failures     += 1
        s.lastFailureAt = Date.now()
        s.probeInFlight = false

        if (s.circuit === 'HALF_OPEN' || s.failures >= FAILURE_THRESHOLD) {
            s.circuit = 'OPEN'
            // Double the backoff only when re-opening after a failed HALF_OPEN
            // probe, not on the initial CLOSED → OPEN transition.
            if (wasOpen) {
                s.resetBackoff = Math.min(s.resetBackoff * 2, MAX_RESET_MS)
            }
        }
    }

    // ── Private helpers ────────────────────────────────────────────────────

    private pushLatency(s: ModelState, ms: number): void {
        s.latencies[s.latencyHead] = ms
        s.latencyHead = (s.latencyHead + 1) % LATENCY_WINDOW_SIZE
        if (!s.latencyFull && s.latencyHead === 0) s.latencyFull = true
    }

    private computeP50(s: ModelState): number {
        const count = s.latencyFull ? LATENCY_WINDOW_SIZE : s.latencyHead
        if (count === 0) return 0
        const sorted = s.latencies.slice(0, count).sort((a, b) => a - b)
        const mid    = Math.floor(sorted.length / 2)
        return sorted.length % 2 === 0
            ? (sorted[mid - 1] + sorted[mid]) / 2
            : sorted[mid]
    }

    private pushOutcome(s: ModelState, success: boolean): void {
        s.outcomes.push(success)
        if (s.outcomes.length > 100) s.outcomes.shift()
    }

    private computeSuccessRate(s: ModelState): number {
        if (s.outcomes.length === 0) return 1.0
        const successes = s.outcomes.filter(Boolean).length
        return successes / s.outcomes.length
    }
}

/** Singleton instance — shared across all requests in the same Worker isolate. */
export const healthManager = new HealthManager()
