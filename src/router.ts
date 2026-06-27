/**
 * Router — dispatches an incoming Anthropic-format request to the correct
 * provider after resolving the model via the registry.
 *
 * Handles:
 *  - Model resolution (Anthropic aliases → real model IDs)
 *  - Provider selection
 *  - Fallback chain on upstream 5xx errors
 *  - Rewriting the model field to the real providerModelId
 *  - Translating upstream error codes to Anthropic-format JSON
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
    requestId: string
): Promise<RouterResult> {
    const bodyText = await request.clone().text()
    let bodyJson: types.ClaudeRequest | null = null
    try {
        bodyJson = JSON.parse(bodyText) as types.ClaudeRequest
    } catch {
        return {
            response: anthropicError(
                'invalid_request_error',
                'Request body is not valid JSON.',
                400,
                requestId
            ),
            resolvedModel: REGISTRY[Object.keys(REGISTRY)[0]],
        }
    }

    const incomingModel = bodyJson?.model ?? ''
    const entry = resolveModelEntry(incomingModel)

    console.log(`[Router] [${requestId}] ${incomingModel} → ${entry.displayName} (${entry.providerModelId})`)

    const rewrittenBody = JSON.stringify({ ...bodyJson, model: entry.providerModelId })

    const outboundRequest = new Request(request, {
        body:    rewrittenBody,
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

        if (providerResponse.ok) {
            return {
                response: await provider.convertToClaudeResponse(providerResponse),
                resolvedModel: candidate,
            }
        }

        // 4xx (except 429) are client errors — return immediately, no fallback
        if (providerResponse.status < 500 && providerResponse.status !== 429) {
            return {
                response: translateUpstreamError(providerResponse, requestId),
                resolvedModel: candidate,
            }
        }

        // 429 or 5xx — try next in chain
        console.log(
            `[Router] [${requestId}] ${candidate.displayName} returned ${providerResponse.status}, ` +
            `trying fallback…`
        )
        lastResponse = providerResponse
    }

    // All candidates exhausted
    return {
        response: translateUpstreamError(lastResponse!, requestId),
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

// ── Upstream error translation ─────────────────────────────────────────────────────────

function translateUpstreamError(upstream: Response, requestId: string): Response {
    const status = upstream.status
    if (status === 401 || status === 403) {
        return anthropicError('authentication_error', 'Upstream provider authentication failed.', 401, requestId)
    }
    if (status === 429) {
        return anthropicError('rate_limit_error', 'Upstream provider rate limit exceeded.', 429, requestId)
    }
    if (status >= 500) {
        return anthropicError('overloaded_error', 'Upstream provider is currently unavailable.', 529, requestId)
    }
    return anthropicError('invalid_request_error', `Upstream provider returned ${status}.`, status, requestId)
}

function anthropicError(
    type: string,
    message: string,
    status: number,
    requestId?: string
): Response {
    const body: Record<string, unknown> = {
        type:  'error',
        error: { type, message },
    }
    if (requestId) body.request_id = requestId
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json',
            ...(requestId ? { 'x-request-id': requestId } : {}),
        },
    })
}
