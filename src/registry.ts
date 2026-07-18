/**
 * Model Registry — single source of truth for all routable models.
 *
 * Design:
 *  - REGISTRY is the authoritative model catalog. It is frozen at module load
 *    and cannot be mutated at runtime.
 *  - ALIAS_MAP is a flat Map<normalized-alias, ModelEntry> built once at startup.
 *    All lookups are O(1) exact-match. No fuzzy logic. No substring matching.
 *  - Duplicate aliases are detected at startup and throw immediately with a
 *    descriptive error so misconfiguration is caught before serving traffic.
 *
 * To add a new model: add an entry to REGISTRY below. No other file needs
 * changing unless the model requires a new provider implementation.
 */

export type ProviderID = 'openai-compat' | 'gemini'

export type Capability = 'chat' | 'tools' | 'reasoning' | 'vision'

export interface ModelEntry {
    /** Canonical registry key (e.g. "deepseek-v4-flash") — used for circuit-breaker/metrics keys */
    readonly id: string
    /** Human-readable display name used in logs and /v1/models */
    readonly displayName: string
    /** Provider implementation to dispatch to */
    readonly provider: ProviderID
    /** Upstream model identifier sent in the provider request */
    readonly providerModelId: string
    /** Base URL for the provider API (never exposed to clients) */
    readonly providerBaseUrl: string
    /**
     * All client-facing strings that resolve to this model.
     * Matching is case-insensitive exact. Duplicates across models throw at startup.
     */
    readonly aliases: readonly string[]
    /** Declared capabilities — used by the router for capability-aware routing */
    readonly capabilities: readonly Capability[]
    /**
     * Ordered fallback chain: canonical ModelIDs to try on 429 / 5xx.
     * The router walks this list left-to-right until one succeeds.
     */
    readonly fallback?: readonly string[]
}

// ── Canonical model IDs ────────────────────────────────────────────────────────

export const ModelID = {
    DEEPSEEK_V4_PRO:   'deepseek-v4-pro',
    DEEPSEEK_V4_FLASH: 'deepseek-v4-flash',
    KIMI_K2:           'kimi-k2',
    GLM_5_1:           'glm-5.1',
} as const

export type ModelIDValue = typeof ModelID[keyof typeof ModelID]

/**
 * The model used when the incoming model string matches nothing in the registry.
 * Changing this constant is the only thing required to change the global default.
 */
export const DEFAULT_MODEL_ID: string = ModelID.DEEPSEEK_V4_FLASH

// ── Provider base URLs ─────────────────────────────────────────────────────────

const NVIDIA_BASE = 'https://integrate.api.nvidia.com/v1'

// ── Model catalog ──────────────────────────────────────────────────────────────

const _REGISTRY: Record<string, ModelEntry> = {
    [ModelID.DEEPSEEK_V4_PRO]: {
        id:              ModelID.DEEPSEEK_V4_PRO,
        displayName:     'DeepSeek V4 Pro',
        provider:        'openai-compat',
        providerModelId: 'deepseek-ai/deepseek-v4-pro',
        providerBaseUrl: NVIDIA_BASE,
        aliases: [
            'claude opus',
            'claude-opus',
            'claude-opus-4',
            'claude-opus-4-5',
            'deepseek v4 pro',
            'deepseek-v4-pro',
        ],
        capabilities: ['chat', 'tools', 'reasoning'],
        fallback: [ModelID.GLM_5_1],
    },

    [ModelID.DEEPSEEK_V4_FLASH]: {
        id:              ModelID.DEEPSEEK_V4_FLASH,
        displayName:     'DeepSeek V4 Flash',
        provider:        'openai-compat',
        providerModelId: 'deepseek-ai/deepseek-v4-flash',
        providerBaseUrl: NVIDIA_BASE,
        aliases: [
            'claude sonnet',
            'claude-sonnet',
            'claude-sonnet-4',
            'claude-sonnet-4-5',
            'deepseek v4 flash',
            'deepseek-v4-flash',
        ],
        capabilities: ['chat', 'tools'],
        fallback: [ModelID.KIMI_K2],
    },

    [ModelID.KIMI_K2]: {
        id:              ModelID.KIMI_K2,
        displayName:     'Kimi K2.6',
        provider:        'openai-compat',
        providerModelId: 'moonshotai/kimi-k2.6',
        providerBaseUrl: NVIDIA_BASE,
        aliases: [
            'claude haiku',
            'claude-haiku',
            'claude-haiku-4',
            'claude-haiku-4-5',
            'kimi k2',
            'kimi-k2',
            'kimi k2.6',
            'kimi-k2.6',
        ],
        capabilities: ['chat', 'tools'],
    },

    [ModelID.GLM_5_1]: {
        id:              ModelID.GLM_5_1,
        displayName:     'GLM 5.1',
        provider:        'openai-compat',
        providerModelId: 'thudm/glm-5.1',
        providerBaseUrl: NVIDIA_BASE,
        aliases: [
            'glm 5.1',
            'glm-5.1',
            'glm5.1',
        ],
        capabilities: ['chat', 'tools'],
    },
}

// ── Immutable registry ─────────────────────────────────────────────────────────

/**
 * Frozen model catalog. No module may add, remove, or mutate entries at runtime.
 * Read-only access via canonical model ID (e.g. ModelID.DEEPSEEK_V4_FLASH).
 */
export const REGISTRY: Readonly<Record<string, ModelEntry>> = Object.freeze(_REGISTRY)

/**
 * ID exposed via GET /v1/models for Claude Code's gateway model discovery
 * (CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1). Claude Code only adds an
 * entry to its /model picker when `id` begins with "claude" or "anthropic",
 * so the raw canonical ID (e.g. "deepseek-v4-pro") would be silently
 * dropped. This ID is also registered as a routable alias below, so
 * selecting it in the picker round-trips back to the same ModelEntry.
 */
export function discoveryId(entry: Pick<ModelEntry, 'id'>): string {
    return `claude-nim-${entry.id}`
}

// ── Alias map — built once at module load ──────────────────────────────────────

/**
 * Flat lookup table: normalized alias string → ModelEntry.
 * Built at startup. Throws on duplicate aliases so misconfiguration is caught
 * immediately rather than silently resolving to the wrong model.
 */
const ALIAS_MAP: Map<string, ModelEntry> = new Map()

for (const [modelId, entry] of Object.entries(_REGISTRY)) {
    for (const alias of [...entry.aliases, discoveryId(entry)]) {
        const key = alias.toLowerCase()
        if (ALIAS_MAP.has(key)) {
            const existing = [...ALIAS_MAP.entries()].find(([, e]) => e === ALIAS_MAP.get(key))
            throw new Error(
                `[Registry] Duplicate alias "${alias}" in model "${modelId}" ` +
                `conflicts with "${existing?.[0] ?? 'unknown'}". ` +
                `Each alias must be unique across all models.`
            )
        }
        ALIAS_MAP.set(key, entry)
    }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Resolve any incoming model string to a registry entry.
 *
 * Resolution order:
 *  1. Exact match against canonical model ID (case-insensitive)
 *  2. Exact match against alias table (case-insensitive)
 *  3. Default model (DEFAULT_MODEL_ID)
 *
 * All lookups are O(1). No substring matching. No ambiguity.
 */
export function resolveModelEntry(model: string): ModelEntry {
    const key = model.trim().toLowerCase()

    // 1. Canonical ID match (e.g. "deepseek-v4-flash")
    if (REGISTRY[key]) return REGISTRY[key]

    // 2. Alias match (e.g. "claude-sonnet-4-5" → DeepSeek V4 Flash)
    const byAlias = ALIAS_MAP.get(key)
    if (byAlias) return byAlias

    // 3. Default fallback
    return REGISTRY[DEFAULT_MODEL_ID]
}
