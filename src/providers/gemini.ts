import * as types from '../types'
import * as provider from '../provider'
import * as utils from '../utils'

export class impl implements provider.Provider {
    async convertToProviderRequest(request: Request, baseUrl: string, apiKey: string): Promise<Request> {
        const claudeRequest = (await request.json()) as types.ClaudeRequest
        const geminiRequest = this.convertToGeminiRequestBody(claudeRequest)

        const finalUrl = utils.buildUrl(baseUrl, `models/${claudeRequest.model}:generateContent?key=${apiKey}`)

        const headers = new Headers(request.headers)
        headers.set('Content-Type', 'application/json')
        headers.delete('Authorization')
        headers.delete('x-api-key')

        return new Request(finalUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(geminiRequest)
        })
    }

    async convertToClaudeResponse(geminiResponse: Response): Promise<Response> {
        if (!geminiResponse.ok) return geminiResponse

        const contentType = geminiResponse.headers.get('content-type') || ''
        return contentType.includes('text/event-stream')
            ? this.convertStreamResponse(geminiResponse)
            : this.convertNormalResponse(geminiResponse)
    }

    private convertToGeminiRequestBody(claudeRequest: types.ClaudeRequest): types.GeminiRequest {
        const geminiRequest: types.GeminiRequest = {
            contents: this.convertMessages(claudeRequest.messages)
        }

        if (claudeRequest.tools && claudeRequest.tools.length > 0) {
            geminiRequest.tools = [{
                functionDeclarations: claudeRequest.tools.map(tool => ({
                    name: tool.name,
                    description: tool.description,
                    parameters: utils.cleanJsonSchema(tool.input_schema)
                }))
            }]
        }

        if (claudeRequest.temperature !== undefined || claudeRequest.max_tokens !== undefined) {
            geminiRequest.generationConfig = {}
            if (claudeRequest.temperature !== undefined) geminiRequest.generationConfig.temperature = claudeRequest.temperature
            if (claudeRequest.max_tokens !== undefined) geminiRequest.generationConfig.maxOutputTokens = claudeRequest.max_tokens
        }

        return geminiRequest
    }

    private convertMessages(claudeMessages: types.ClaudeMessage[]): types.GeminiContent[] {
        const geminiContents: types.GeminiContent[] = []

        for (const message of claudeMessages) {
            if (typeof message.content === 'string') {
                geminiContents.push({
                    parts: [{ text: message.content }],
                    role: message.role === 'assistant' ? 'model' : 'user'
                })
                continue
            }

            const parts: types.GeminiPart[] = []
            const toolResults: types.GeminiContent[] = []

            for (const content of message.content) {
                switch (content.type) {
                    case 'text':
                        parts.push({ text: content.text })
                        break
                    case 'tool_use':
                        parts.push({ functionCall: { name: content.name, args: content.input } })
                        break
                    case 'tool_result':
                        toolResults.push({
                            parts: [{ functionResponse: { name: content.tool_use_id, response: { content: content.content } } }],
                            role: 'tool'
                        })
                        break
                }
            }

            if (parts.length > 0) {
                geminiContents.push({ parts, role: message.role === 'assistant' ? 'model' : 'user' })
            }
            geminiContents.push(...toolResults)
        }

        return geminiContents
    }

    private async convertNormalResponse(geminiResponse: Response): Promise<Response> {
        const geminiData = (await geminiResponse.json()) as types.GeminiResponse

        const claudeResponse: types.ClaudeResponse = {
            id: utils.generateId(),
            type: 'message',
            role: 'assistant',
            content: []
        }

        if (geminiData.candidates && geminiData.candidates.length > 0) {
            const candidate = geminiData.candidates[0]

            for (const part of candidate.content.parts) {
                if ('text' in part) {
                    claudeResponse.content.push({ type: 'text', text: part.text })
                } else if ('functionCall' in part) {
                    claudeResponse.content.push({
                        type: 'tool_use',
                        id: utils.generateId(),
                        name: part.functionCall.name,
                        input: part.functionCall.args
                    })
                    claudeResponse.stop_reason = 'tool_use'
                }
            }

            if (!claudeResponse.stop_reason) {
                claudeResponse.stop_reason = candidate.finishReason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn'
            }
        }

        if (geminiData.usageMetadata) {
            claudeResponse.usage = {
                input_tokens: geminiData.usageMetadata.promptTokenCount,
                output_tokens: geminiData.usageMetadata.candidatesTokenCount
            }
        }

        return new Response(JSON.stringify(claudeResponse), {
            status: geminiResponse.status,
            headers: { 'Content-Type': 'application/json' }
        })
    }

    private async convertStreamResponse(geminiResponse: Response): Promise<Response> {
        return utils.processProviderStream(geminiResponse, (jsonStr, textBlockIndex, toolUseBlockIndex) => {
            const geminiData = JSON.parse(jsonStr) as types.GeminiResponse
            if (!geminiData.candidates || geminiData.candidates.length === 0) return null

            const candidate = geminiData.candidates[0]
            const events: string[] = []
            let currentTextIndex = textBlockIndex
            let currentToolIndex = toolUseBlockIndex

            for (const part of candidate.content.parts) {
                if ('text' in part) {
                    events.push(...utils.processTextPart(part.text, currentTextIndex))
                    currentTextIndex++
                } else if ('functionCall' in part) {
                    events.push(
                        ...utils.processToolUsePart(
                            { name: part.functionCall.name, args: part.functionCall.args },
                            currentToolIndex
                        )
                    )
                    currentToolIndex++
                }
            }

            return { events, textBlockIndex: currentTextIndex, toolUseBlockIndex: currentToolIndex }
        })
    }
}
