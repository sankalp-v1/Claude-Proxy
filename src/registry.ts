/**
 * Model Registry — single source of truth for all routable models.
 *
 * To add a new model: add an entry to REGISTRY. No other file needs changing
 * unless the model requires a new provider implementation.
 */

export type ProviderID = 'openai-compat' | 'gemini'

export type Capability = 'chat' | 'tools' | 'reasoning' | 'vision'

export interface ModelEntry {
    /** Human-readable display name shown in logs */
    displayName: string
    /** Provider implementation to use */
    provider: ProviderID
    /** Upstream model identifier sent to the provider */
    providerModelId: string
    /** Base URL for the provider API */
    providerBaseUrl: string
    /** All client-facing names that resolve to this model (case-insensitive) */
    aliases: string[]
    /** Declared capabilities of this model */
    capabilities: Capability[]
    /**
     * Optional ordered fallback chain.
     * Each entry is a canonical ModelID to try if this model fails (5xx).
     */
    fallback?: string[]
}

/** Canonical model IDs used internally by the router */
export const ModelID = {
    DEEPSEEK_V4_PRO:   'deepseek-v4-pro',
    DEEPSEEK_V4_FLASH: 'deepseek-v4-flash',
    KIMI_K2:           'kimi-k2',
    GLM_5_1:           'glm-5.1',
} as const

export type ModelIDValue = typeof ModelID[keyof typeof ModelID]

const NVIDIA_BASE = 'https://integrate.api.nvidia.com/v1'

export const REGISTRY: Record<string, ModelEntry> = {
    [ModelID.DEEPSEEK_V4_PRO]: {
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

/**
 * Resolve any incoming model string to a registry entry.
 * Checks canonical IDs first, then aliases (case-insensitive).
 * Falls back to DeepSeek V4 Flash if nothing matches.
 */
export function resolveModelEntry(model: string): ModelEntry {
    const normalized = model.trim().toLowerCase()

    if (REGISTRY[normalized]) return REGISTRY[normalized]

    for (const entry of Object.values(REGISTRY)) {
        if (entry.aliases.some(a => normalized.includes(a) || a.includes(normalized))) {
            return entry
        }
    }

    return REGISTRY[ModelID.DEEPSEEK_V4_FLASH]
}
