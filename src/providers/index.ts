/**
 * Provider registry — maps ProviderID strings to their implementations.
 * To add a new provider: create a file in this directory and register it here.
 */

import { ProviderID } from '../registry'
import { Provider } from '../provider'
import { impl as OpenAICompatImpl } from './openai'
import { impl as GeminiImpl } from './gemini'

const PROVIDERS: Record<ProviderID, Provider> = {
    'openai-compat': new OpenAICompatImpl(),
    'gemini':        new GeminiImpl(),
}

export function getProviderImpl(id: ProviderID): Provider {
    const impl = PROVIDERS[id]
    if (!impl) throw new Error(`Unknown provider: ${id}`)
    return impl
}
