import * as provider from './provider'
import * as gemini from './gemini'
import * as openai from './openai'
import { resolveModel } from './alias'

// Hardcoded upstream provider — clients never need to know this.
const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1'

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        try {
            return await handle(request, env)
        } catch (error) {
            console.error(error)
            return new Response('Internal server error', { status: 500 })
        }
    }
} satisfies ExportedHandler<Env>

async function handle(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 })
    }

    const requestUrl = new URL(request.url)
    const isDev = requestUrl.hostname === 'localhost' || requestUrl.hostname === '127.0.0.1'

    const { typeParam, baseUrl, err: pathErr } = parsePath(requestUrl)
    if (pathErr) {
        return pathErr
    }

    const { apiKey: dummyKey, mutatedHeaders, err: apiKeyErr } = getApiKey(request.headers)
    if (apiKeyErr) {
        return apiKeyErr
    }

    // Require dummy client key
    if (!dummyKey) {
        return new Response('Missing dummy api key', { status: 401 })
    }

    const upstreamApiKey = env.NVIDIA_API_KEY;
    if (!upstreamApiKey) {
        return new Response('Internal server error, missing provider api key configuration', { status: 500 })
    }

    if (!typeParam || !baseUrl) {
        return new Response('Internal server error, missing params', { status: 500 })
    }

    let provider: provider.Provider
    switch (typeParam) {
        case 'gemini':
            provider = new gemini.impl()
            break
        case 'openai':
            provider = new openai.impl()
            break
        default:
            return new Response('Unsupported type', { status: 400 })
    }

    let modifiedRequest = request;
    try {
        const clonedRequest = request.clone();
        const bodyText = await clonedRequest.text();
        if (bodyText) {
            const bodyJson = JSON.parse(bodyText);
            if (bodyJson.model) {
                bodyJson.model = resolveModel(bodyJson.model, isDev);
                modifiedRequest = new Request(request, {
                    body: JSON.stringify(bodyJson),
                    headers: mutatedHeaders
                });
            } else {
                modifiedRequest = new Request(request, { headers: mutatedHeaders });
            }
        } else {
            modifiedRequest = new Request(request, { headers: mutatedHeaders });
        }
    } catch (e) {
        // If JSON parsing fails, just forward the original request with mutated headers
        modifiedRequest = new Request(request, { headers: mutatedHeaders });
    }

    const providerRequest = await provider.convertToProviderRequest(
        modifiedRequest,
        baseUrl,
        upstreamApiKey
    )
    const providerResponse = await fetch(providerRequest)
    return await provider.convertToClaudeResponse(providerResponse)
}

function parsePath(url: URL): { typeParam?: string; baseUrl?: string; err?: Response } {
    const pathParts = url.pathname.split('/').filter(part => part !== '')

    // --- New simplified path: POST /v1/messages or POST / ---
    // Clients using ANTHROPIC_BASE_URL=https://<worker>.workers.dev
    // will hit either /v1/messages directly (Claude Code default).
    if (
        pathParts.length === 0 ||
        (pathParts.length === 2 && pathParts[0] === 'v1' && pathParts[1] === 'messages') ||
        (pathParts.length === 1 && pathParts[0] === 'messages')
    ) {
        return { typeParam: 'openai', baseUrl: NVIDIA_BASE_URL }
    }

    // --- Legacy path (backwards compat): /{type}/{provider_url}/v1/messages ---
    // Still accepted so existing clients continue to work during migration.
    if (pathParts.length < 3) {
        return {
            err: new Response(
                'Invalid path. Use POST /v1/messages, or legacy: /{type}/{provider_url}/v1/messages',
                { status: 400 }
            )
        }
    }
    const lastTwoParts = pathParts.slice(-2)
    if (lastTwoParts[0] !== 'v1' || lastTwoParts[1] !== 'messages') {
        return { err: new Response('Path must end with /v1/messages', { status: 404 }) }
    }

    const typeParam = pathParts[0]
    const providerUrlParts = pathParts.slice(1, -2)

    // [..., 'https:', ...] ==> [..., 'https:/', ...]
    if (pathParts[1] && pathParts[1].startsWith('http')) {
        pathParts[1] = pathParts[1] + '/'
    }

    const baseUrl = providerUrlParts.join('/')
    if (!typeParam || !baseUrl) {
        return { err: new Response('Missing type or provider_url in path', { status: 400 }) }
    }

    return { typeParam, baseUrl }
}

function getApiKey(headers: Headers): { apiKey?: string; mutatedHeaders?: Headers; err?: Response } {
    const mutatedHeaders = new Headers(headers)
    let apiKey = headers.get('x-api-key')
    if (apiKey) {
        mutatedHeaders.delete('x-api-key')
    } else {
        apiKey = mutatedHeaders.get('authorization')
        if (apiKey) {
            mutatedHeaders.delete('authorization')
        }
    }

    if (!apiKey) {
        return { err: new Response('Missing x-api-key or authorization header', { status: 401 }) }
    }

    return { apiKey, mutatedHeaders }
}
