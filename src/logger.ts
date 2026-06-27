/**
 * Structured JSON logger.
 *
 * Emits single-line JSON objects to console.log / console.error so that
 * Cloudflare Workers' log tail can parse and filter them.
 *
 * Usage:
 *   const log = makeLogger(requestId)
 *   log.request({ method, path, model })
 *   log.response({ status, latencyMs, model })
 *   log.error({ message, error })
 *   log.info('custom message', { extra: 'fields' })
 */

export interface Logger {
    request(fields: Record<string, unknown>): void
    response(fields: Record<string, unknown>): void
    error(fields: Record<string, unknown>): void
    info(message: string, fields?: Record<string, unknown>): void
    warn(message: string, fields?: Record<string, unknown>): void
}

export function makeLogger(requestId: string): Logger {
    const base = { requestId, timestamp: () => new Date().toISOString() }

    function emit(level: string, event: string, fields: Record<string, unknown>): void {
        const entry = {
            level,
            event,
            requestId: base.requestId,
            timestamp: base.timestamp(),
            ...fields,
        }
        if (level === 'error') {
            console.error(JSON.stringify(entry))
        } else {
            console.log(JSON.stringify(entry))
        }
    }

    return {
        request(fields) {
            emit('info', 'request.received', fields)
        },
        response(fields) {
            emit('info', 'request.completed', fields)
        },
        error(fields) {
            const serialised = { ...fields }
            if (serialised.error instanceof Error) {
                serialised.errorMessage = serialised.error.message
                serialised.errorStack   = serialised.error.stack
                delete serialised.error
            }
            emit('error', 'request.failed', serialised)
        },
        info(message, fields = {}) {
            emit('info', 'info', { message, ...fields })
        },
        warn(message, fields = {}) {
            emit('warn', 'warn', { message, ...fields })
        },
    }
}
