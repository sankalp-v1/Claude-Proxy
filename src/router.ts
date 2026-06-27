/**
 * Router — dispatches an incoming Anthropic-format request to the correct
 * provider after resolving the model via the registry.
 *
 * Handles:
 *  - Model resolution (Anthropic aliases → real model IDs)
 *  - Provider selection
 *  - Circuit-breaker guard (CLOSED / OPEN / HALF_OPEN per model)
 *  - Fallback chain on upstream 5xx / 429 errors
 *  - Rewriting the model field to the real providerModelId
 *  - Translating upstream error codes to Anthropic-format JSON
 *  - Structured JSON logging and in-memory metrics
 */

import { resolveModelEntry, REGISTRY, ModelEntry } from './registry'
import { getProviderImpl } from './providers/index'
import { healthManager } from './health'
import { metrics } from './metrics'
import { makeLogger } from './logger'
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
    const log = makeLogger(requestId)

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

    log.request({
        method: request.method,
        model:  incomingModel,
        resolved: entry.displayName,
        providerModelId: entry.providerModelId,
    })

    const rewrittenBody = JSON.stringify({ ...bodyJson, model: entry.providerModelId })

    const outboundRequest = new Request(request, {
        body:    rewrittenBody,
        headers: mutatedHeaders,
    })

    const chain = buildDispatchChain(entry)
    let lastResponse: Response | null = null

    for (const candidate of chain) {
        // ── Circuit breaker check ───────────────────────────────────────
        if (!healthManager.isAvailable(candidate.id)) {
            const snap = healthManager.snapshot(candidate.id)
            log.warn('circuit open, skipping model', {
                model:   candidate.id,
                circuit: snap.state,
            })
            continue
        }

        const provider = getProviderImpl(candidate.provider)
        const providerRequest = await provider.convertToProviderRequest(
            outboundRequest.clone(),
            candidate.providerBaseUrl,
            upstreamApiKey
        )

        const startMs = Date.now()
        metrics.recordRequest(candidate.id)

        let providerResponse: Response
        try {
            providerResponse = await fetch(providerRequest)
        } catch (fetchErr) {
            const latencyMs = Date.now() - startMs
            healthManager.recordFailure(candidate.id)
            metrics.recordError(candidate.id)
            log.error({
                model: candidate.id,
                latencyMs,
                error: fetchErr,
                message: 'fetch threw — network error'
            })
            lastResponse = new Response('upstream unreachable', { status: 503 })
            continue
        }

        const latencyMs = Date.now() - startMs

        if (providerResponse.ok) {
            healthManager.recordSuccess(candidate.id, latencyMs)
            metrics.recordLatency(candidate.id, latencyMs)
            log.response({
                model:     candidate.id,
                status:    providerResponse.status,
                latencyMs,
            })
            return {
                response: await provider.convertToClaudeResponse(providerResponse),
                resolvedModel: candidate,
            }
        }

        // 4xx (except 429) are client errors — return immediately, no fallback
        if (providerResponse.status < 500 && providerResponse.status !== 429) {
            metrics.recordError(candidate.id)
            log.warn('upstream client error, not retrying', {
                model:  candidate.id,
                status: providerResponse.status,
            })
            return {
                response: translateUpstreamError(providerResponse, requestId),
                resolvedModel: candidate,
            }
        }

        // 429 or 5xx — record failure, try next in chain
        healthManager.recordFailure(candidate.id)
        metrics.recordError(candidate.id)
        log.warn('upstream retryable error, trying fallback', {
            model:  candidate.id,
            status: providerResponse.status,
        })
        lastResponse = providerResponse
    }

    // All candidates exhausted
    return {
        response: translateUpstreamError(lastResponse ?? new Response(null, { status: 503 }), requestId),
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

// ── Upstream error translation ────────────────────────────────────────────────────

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
