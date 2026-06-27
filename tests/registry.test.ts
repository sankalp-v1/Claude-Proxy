import { describe, it, expect } from 'vitest'
import {
    resolveModelEntry,
    REGISTRY,
    DEFAULT_MODEL_ID,
} from '../src/registry'

describe('registry', () => {
    it('DEFAULT_MODEL_ID exists in REGISTRY', () => {
        expect(REGISTRY[DEFAULT_MODEL_ID]).toBeDefined()
    })

    it('every entry has required fields', () => {
        for (const [id, entry] of Object.entries(REGISTRY)) {
            expect(entry.id,               `${id}.id`).toBe(id)
            expect(entry.displayName,      `${id}.displayName`).toBeTruthy()
            expect(entry.provider,         `${id}.provider`).toBeTruthy()
            expect(entry.providerModelId,  `${id}.providerModelId`).toBeTruthy()
            expect(entry.providerBaseUrl,  `${id}.providerBaseUrl`).toBeTruthy()
        }
    })

    it('resolves an exact model ID', () => {
        const entry = resolveModelEntry(DEFAULT_MODEL_ID)
        expect(entry.id).toBe(DEFAULT_MODEL_ID)
    })

    it('resolves a known Anthropic alias (claude-3-5-sonnet-20241022)', () => {
        const entry = resolveModelEntry('claude-3-5-sonnet-20241022')
        expect(entry).toBeDefined()
        expect(entry.providerModelId).toBeTruthy()
    })

    it('falls back to DEFAULT_MODEL_ID for an unknown model string', () => {
        const entry = resolveModelEntry('non-existent-model-xyz-999')
        expect(entry.id).toBe(DEFAULT_MODEL_ID)
    })

    it('resolves empty string to DEFAULT_MODEL_ID', () => {
        const entry = resolveModelEntry('')
        expect(entry.id).toBe(DEFAULT_MODEL_ID)
    })

    it('aliases array on each entry is an array', () => {
        for (const [id, entry] of Object.entries(REGISTRY)) {
            expect(Array.isArray(entry.aliases), `${id}.aliases should be array`).toBe(true)
        }
    })
})
