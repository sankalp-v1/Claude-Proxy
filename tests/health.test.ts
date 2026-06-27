import { describe, it, expect, beforeEach } from 'vitest'
import { HealthManager } from '../src/health'

// Use a fresh HealthManager per test — we don't touch the singleton.
describe('HealthManager', () => {
    let hm: HealthManager

    beforeEach(() => {
        hm = new HealthManager()
    })

    it('starts CLOSED and available', () => {
        expect(hm.isAvailable('m1')).toBe(true)
        expect(hm.snapshot('m1').state).toBe('CLOSED')
    })

    it('opens circuit after 5 consecutive failures', () => {
        for (let i = 0; i < 5; i++) hm.recordFailure('m1')
        expect(hm.snapshot('m1').state).toBe('OPEN')
        expect(hm.isAvailable('m1')).toBe(false)
    })

    it('does not open on fewer than 5 failures', () => {
        for (let i = 0; i < 4; i++) hm.recordFailure('m1')
        expect(hm.snapshot('m1').state).toBe('CLOSED')
    })

    it('resets failure count on success', () => {
        for (let i = 0; i < 3; i++) hm.recordFailure('m1')
        hm.recordSuccess('m1', 100)
        expect(hm.snapshot('m1').failures).toBe(0)
        expect(hm.snapshot('m1').state).toBe('CLOSED')
    })

    it('transitions OPEN -> HALF_OPEN after backoff via isAvailable()', () => {
        for (let i = 0; i < 5; i++) hm.recordFailure('m1')
        // Manually rewind the lastFailureAt to simulate elapsed backoff time
        const s = (hm as any).models.get('m1')
        s.lastFailureAt = Date.now() - 60_000  // 60 s ago > 30 s base backoff

        expect(hm.isAvailable('m1')).toBe(true)  // triggers HALF_OPEN + probe
        expect(hm.snapshot('m1').state).toBe('HALF_OPEN')
    })

    it('transitions HALF_OPEN -> CLOSED on success', () => {
        for (let i = 0; i < 5; i++) hm.recordFailure('m1')
        const s = (hm as any).models.get('m1')
        s.lastFailureAt = Date.now() - 60_000
        hm.isAvailable('m1')  // moves to HALF_OPEN

        hm.recordSuccess('m1', 50)
        expect(hm.snapshot('m1').state).toBe('CLOSED')
    })

    it('transitions HALF_OPEN -> OPEN on failure', () => {
        for (let i = 0; i < 5; i++) hm.recordFailure('m1')
        const s = (hm as any).models.get('m1')
        s.lastFailureAt = Date.now() - 60_000
        hm.isAvailable('m1')  // moves to HALF_OPEN

        hm.recordFailure('m1')
        expect(hm.snapshot('m1').state).toBe('OPEN')
    })

    it('blocks second probe while one is in flight (HALF_OPEN)', () => {
        for (let i = 0; i < 5; i++) hm.recordFailure('m1')
        const s = (hm as any).models.get('m1')
        s.lastFailureAt = Date.now() - 60_000
        hm.isAvailable('m1')  // first probe granted
        expect(hm.isAvailable('m1')).toBe(false)  // second blocked
    })

    it('computes p50 latency correctly', () => {
        hm.recordSuccess('m1', 10)
        hm.recordSuccess('m1', 20)
        hm.recordSuccess('m1', 30)
        hm.recordSuccess('m1', 40)
        hm.recordSuccess('m1', 50)
        const snap = hm.snapshot('m1')
        // Sorted: [10,20,30,40,50] — p50 = 30
        expect(snap.p50LatencyMs).toBe(30)
    })

    it('returns p50 = 0 with no data', () => {
        expect(hm.snapshot('m1').p50LatencyMs).toBe(0)
    })

    it('success rate is 1.0 with no outcomes recorded', () => {
        expect(hm.snapshot('m1').successRate).toBe(1.0)
    })

    it('success rate reflects mixed outcomes', () => {
        hm.recordSuccess('m1', 10)
        hm.recordSuccess('m1', 10)
        hm.recordFailure('m1')
        hm.recordFailure('m1')
        // 2 success, 2 failure — but recordFailure doesn’t reset failures until threshold
        // successes were pushed via recordSuccess, failures via recordFailure — both push outcome
        const snap = hm.snapshot('m1')
        expect(snap.successRate).toBeCloseTo(0.5, 2)
    })

    it('isolates state between model IDs', () => {
        for (let i = 0; i < 5; i++) hm.recordFailure('m1')
        expect(hm.snapshot('m2').state).toBe('CLOSED')
        expect(hm.isAvailable('m2')).toBe(true)
    })
})
