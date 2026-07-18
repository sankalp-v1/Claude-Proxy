import { routeRequest } from './router'
import { REGISTRY, ModelID, discoveryId } from './registry'
import { healthManager } from './health'
import { metrics } from './metrics'

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const requestId = crypto.randomUUID()
        try {
            return await handle(request, env, requestId)
        } catch (error) {
            console.error('[Worker] Unhandled exception:', error)
            return anthropicError(
                'api_error',
                'An unexpected error occurred.',
                500,
                requestId
            )
        }
    }
} satisfies ExportedHandler<Env>

async function handle(request: Request, env: Env, requestId: string): Promise<Response> {
    const url    = new URL(request.url)
    const method = request.method.toUpperCase()
    const path   = url.pathname

    // ── GET endpoints ──────────────────────────────────────────────────────

    if (method === 'GET') {
        if (path === '/v1/models') {
            return handleModels(requestId)
        }
        if (path === '/metrics') {
            // Optional bearer-token auth: set METRICS_TOKEN in Cloudflare Secrets
            // to restrict scraping. If unset, the endpoint is open (dev-friendly default).
            const metricsToken = (env as Env & { METRICS_TOKEN?: string }).METRICS_TOKEN
            if (metricsToken) {
                const auth = request.headers.get('authorization')
                if (auth !== `Bearer ${metricsToken}`) {
                    return new Response('Unauthorized', { status: 401 })
                }
            }
            return new Response(metrics.toText(), {
                status: 200,
                headers: { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' },
            })
        }
        if (path === '/health' || path === '/v1/health') {
            return handleHealth(requestId)
        }
        return anthropicError('invalid_request_error', `Unknown path: ${path}`, 404, requestId)
    }

    // ── POST only beyond this point ──────────────────────────────────────────

    if (method !== 'POST') {
        return anthropicError(
            'invalid_request_error',
            `Method ${method} not allowed. Use POST.`,
            405,
            requestId
        )
    }

    const pathErr = validatePath(url)
    if (pathErr) return addRequestId(pathErr, requestId)

    const { apiKey, mutatedHeaders, err } = extractClientKey(request.headers)
    if (err) return addRequestId(err, requestId)
    if (!apiKey) {
        return anthropicError(
            'authentication_error',
            'Missing x-api-key or Authorization header.',
            401,
            requestId
        )
    }

    const upstreamApiKey = env.NVIDIA_API_KEY
    if (!upstreamApiKey) {
        console.error('[Worker] env.NVIDIA_API_KEY is not set')
        return anthropicError(
            'api_error',
            'Upstream provider is not configured.',
            500,
            requestId
        )
    }

    const { response } = await routeRequest(request, mutatedHeaders!, upstreamApiKey, requestId)
    return addRequestId(response, requestId)
}

// ── GET /v1/models ──────────────────────────────────────────────────────────

function handleModels(requestId: string): Response {
    // `id` is prefixed for Claude Code's gateway model discovery, which only
    // surfaces /model picker entries whose id starts with "claude"/"anthropic"
    // (see CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY). `canonical_id` is the
    // registry key routing also accepts, kept for anyone reading this by hand.
    const data = Object.values(REGISTRY).map(entry => ({
        id:            discoveryId(entry),
        canonical_id:  entry.id,
        object:        'model',
        display_name:  entry.displayName,
        capabilities:  entry.capabilities,
        provider:      entry.provider,
        aliases:       entry.aliases,
    }))
    return json({ object: 'list', data, request_id: requestId }, 200, requestId)
}

// ── GET /health ─────────────────────────────────────────────────────────────────

function handleHealth(requestId: string): Response {
    const modelIds = healthManager.modelIds()
    const circuits: Record<string, unknown> = {}
    for (const id of modelIds) {
        circuits[id] = healthManager.snapshot(id)
    }

    const metricsSnapshot = metrics.toJson()

    // Overall status: degraded if any model circuit is open.
    // Returns 503 so load balancers and health-check tooling treat it correctly.
    const anyOpen = modelIds.some(id => healthManager.snapshot(id).state === 'OPEN')

    return json({
        status:     anyOpen ? 'degraded' : 'ok',
        request_id: requestId,
        circuits,
        metrics:    metricsSnapshot,
    }, anyOpen ? 503 : 200, requestId)
}

// ── Path validation ──────────────────────────────────────────────────────────────

/**
 * Accept:
 *   POST /v1/messages               — canonical (Claude Code default)
 *   POST /messages                  — alternate simplified path
 *   POST /                          — bare root
 *   POST /openai/<url>/v1/messages  — legacy backwards-compat
 */
function validatePath(url: URL): Response | null {
    const parts = url.pathname.split('/').filter(p => p !== '')

    if (
        parts.length === 0 ||
        (parts.length === 1 && parts[0] === 'messages') ||
        (parts.length === 2 && parts[0] === 'v1' && parts[1] === 'messages')
    ) {
        return null
    }

    // Legacy: /openai/<anything>/v1/messages — last two segments must be v1 + messages
    if (parts.length >= 3) {
        const last2 = parts.slice(-2)
        if (last2[0] === 'v1' && last2[1] === 'messages') return null
        return anthropicError(
            'invalid_request_error',
            'Path must end with /v1/messages.',
            404
        )
    }

    return anthropicError(
        'invalid_request_error',
        'Invalid path. Use POST /v1/messages.',
        400
    )
}

// ── Client key extraction ───────────────────────────────────────────────────────────

function extractClientKey(
    headers: Headers
): { apiKey?: string; mutatedHeaders?: Headers; err?: Response } {
    const mutatedHeaders = new Headers(headers)
    // Strip client-provided request ID to prevent header injection / log poisoning
    mutatedHeaders.delete('x-request-id')

    let apiKey = headers.get('x-api-key')
    if (apiKey) {
        mutatedHeaders.delete('x-api-key')
    } else {
        apiKey = headers.get('authorization')
        if (apiKey) mutatedHeaders.delete('authorization')
    }
    if (!apiKey) {
        return {
            err: anthropicError(
                'authentication_error',
                'Missing x-api-key or Authorization header.',
                401
            )
        }
    }
    return { apiKey, mutatedHeaders }
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

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

function json(data: unknown, status: number, requestId?: string): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            ...(requestId ? { 'x-request-id': requestId } : {}),
        },
    })
}

function addRequestId(response: Response, requestId: string): Response {
    const headers = new Headers(response.headers)
    headers.set('x-request-id', requestId)
    return new Response(response.body, { status: response.status, headers })
}
