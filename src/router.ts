/**
 * Router — dispatches an incoming Anthropic-format request to the correct
 * provider after resolving the model via the registry.
 *
 * Handles:
 *  - Model resolution (Anthropic aliases → real model IDs)
 *  - Provider selection
 *  - Fallback chain on upstream 5xx errors
 *  - Rewriting the model field to the real providerModelId
 */

import { resolveModelEntry, REGISTRY, ModelEntry } from './registry'
import { getProviderImpl } from './providers/index'
import * as types from './types'

export interface RouterResult {
    response: Response
    resolvedModel: ModelEntry
}

export async function routeRequest(
    request: Request,
    mutatedHeaders: Headers,
    upstreamApiKey: string,
    isDev: boolean
): Promise<RouterResult> {
    const bodyText = await request.clone().text()
    let bodyJson: types.ClaudeRequest | null = null
    try {
        bodyJson = JSON.parse(bodyText) as types.ClaudeRequest
    } catch {
        // Malformed body — forward as-is; provider will reject with 4xx
    }

    const incomingModel = bodyJson?.model ?? ''
    const entry = resolveModelEntry(incomingModel)

    if (isDev) {
        console.log(`[Router] ${incomingModel} → ${entry.displayName} (${entry.providerModelId})`)
    }

    const rewrittenBody = bodyJson
        ? JSON.stringify({ ...bodyJson, model: entry.providerModelId })
        : bodyText

    const outboundRequest = new Request(request, {
        body: rewrittenBody,
        headers: mutatedHeaders,
    })

    const chain = buildDispatchChain(entry)
    let lastResponse: Response | null = null

    for (const candidate of chain) {
        const provider = getProviderImpl(candidate.provider)
        const providerRequest = await provider.convertToProviderRequest(
            outboundRequest.clone(),
            candidate.providerBaseUrl,
            upstreamApiKey
        )

        const providerResponse = await fetch(providerRequest)

        // Only fall back on 5xx — 4xx are client mistakes, return immediately
        if (providerResponse.ok || providerResponse.status < 500) {
            return {
                response: await provider.convertToClaudeResponse(providerResponse),
                resolvedModel: candidate,
            }
        }

        if (isDev) {
            console.log(`[Router] ${candidate.displayName} returned ${providerResponse.status}, trying fallback…`)
        }
        lastResponse = providerResponse
    }

    const lastProvider = getProviderImpl(chain[chain.length - 1].provider)
    return {
        response: await lastProvider.convertToClaudeResponse(lastResponse!),
        resolvedModel: chain[chain.length - 1],
    }
}

function buildDispatchChain(primary: ModelEntry): ModelEntry[] {
    const chain: ModelEntry[] = [primary]
    for (const fallbackId of primary.fallback ?? []) {
        const fallbackEntry = REGISTRY[fallbackId]
        if (fallbackEntry) chain.push(fallbackEntry)
    }
    return chain
}
