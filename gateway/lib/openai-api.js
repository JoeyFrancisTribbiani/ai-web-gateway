import { randomBytes } from 'crypto'

export function formatChatCompletionChunk(id, model, content) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  }
}

export function formatChatCompletionDone(id, model) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  }
}

export function formatChatCompletion(model, content) {
  return {
    id: 'chatcmpl-' + randomBytes(8).toString('hex'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
}

export function formatImageResponse(urls) {
  return {
    created: Math.floor(Date.now() / 1000),
    data: urls.map(url => ({ url })),
  }
}

export function formatModels(models) {
  return {
    object: 'list',
    data: models.map(m => ({
      id: m.name,
      object: 'model',
      created: 1700000000,
      owned_by: m.vendor,
    })),
  }
}

export function formatError(code, message) {
  const statusMap = {
    400: 'invalid_request_error',
    401: 'authentication_error',
    429: 'rate_limit_exceeded',
    500: 'internal_error',
    502: 'bad_gateway',
    503: 'service_unavailable',
    504: 'gateway_timeout',
  }
  return {
    error: {
      message,
      type: statusMap[code] || 'internal_error',
      code: String(code),
    },
  }
}

export function formatSSE(data) {
  return `data: ${JSON.stringify(data)}\n\n`
}

export function formatSSEDone() {
  return 'data: [DONE]\n\n'
}

export function formatSSEComment(text) {
  return `: ${text}\n\n`
}
