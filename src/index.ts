import { routeRequest } from './router'

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

    const pathErr = validatePath(requestUrl)
    if (pathErr) return pathErr

    const { apiKey, mutatedHeaders, err } = extractClientKey(request.headers)
    if (err) return err
    if (!apiKey) return new Response('Missing api key', { status: 401 })

    const upstreamApiKey = env.NVIDIA_API_KEY
    if (!upstreamApiKey) {
        return new Response('Internal server error, missing provider api key configuration', { status: 500 })
    }

    const { response } = await routeRequest(request, mutatedHeaders!, upstreamApiKey, isDev)
    return response
}

/**
 * Accept:
 *   POST /v1/messages               — simplified path (Claude Code default)
 *   POST /messages                  — alternate simplified path
 *   POST /                          — bare root
 *   POST /openai/<url>/v1/messages  — legacy path (backwards compat)
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

    if (parts.length >= 3) {
        const last2 = parts.slice(-2)
        if (last2[0] === 'v1' && last2[1] === 'messages') return null
        return new Response('Path must end with /v1/messages', { status: 404 })
    }

    return new Response(
        'Invalid path. Use POST /v1/messages, or legacy: /{type}/{provider_url}/v1/messages',
        { status: 400 }
    )
}

function extractClientKey(
    headers: Headers
): { apiKey?: string; mutatedHeaders?: Headers; err?: Response } {
    const mutatedHeaders = new Headers(headers)
    let apiKey = headers.get('x-api-key')
    if (apiKey) {
        mutatedHeaders.delete('x-api-key')
    } else {
        apiKey = mutatedHeaders.get('authorization')
        if (apiKey) mutatedHeaders.delete('authorization')
    }
    if (!apiKey) {
        return { err: new Response('Missing x-api-key or authorization header', { status: 401 }) }
    }
    return { apiKey, mutatedHeaders }
}
