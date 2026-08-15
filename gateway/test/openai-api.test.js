import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatChatCompletionChunk,
  formatChatCompletionDone,
  formatChatCompletion,
  formatImageResponse,
  formatModels,
  formatError,
  formatSSE,
  formatSSEDone,
  formatSSEComment,
} from '../lib/openai-api.js'

describe('formatChatCompletionChunk', () => {
  test('返回正确的 SSE chunk 结构', () => {
    const chunk = formatChatCompletionChunk('req-1', 'gpt-4o', 'Hello')
    assert.equal(chunk.id, 'req-1')
    assert.equal(chunk.object, 'chat.completion.chunk')
    assert.equal(chunk.model, 'gpt-4o')
    assert.ok(chunk.created > 0)
    assert.equal(chunk.choices[0].index, 0)
    assert.equal(chunk.choices[0].delta.content, 'Hello')
    assert.equal(chunk.choices[0].finish_reason, null)
  })
})

describe('formatChatCompletionDone', () => {
  test('返回 finish_reason: stop', () => {
    const done = formatChatCompletionDone('req-1', 'gpt-4o')
    assert.equal(done.id, 'req-1')
    assert.equal(done.object, 'chat.completion.chunk')
    assert.equal(done.choices[0].finish_reason, 'stop')
    assert.deepEqual(done.choices[0].delta, {})
  })
})

describe('formatChatCompletion', () => {
  test('返回完整的 chat completion 对象', () => {
    const result = formatChatCompletion('gpt-4o', 'Hello world')
    assert.equal(result.object, 'chat.completion')
    assert.ok(result.id.startsWith('chatcmpl-'))
    assert.ok(result.created > 0)
    assert.equal(result.model, 'gpt-4o')
    assert.equal(result.choices[0].message.role, 'assistant')
    assert.equal(result.choices[0].message.content, 'Hello world')
    assert.equal(result.choices[0].finish_reason, 'stop')
    assert.ok(result.usage)
    assert.ok('prompt_tokens' in result.usage)
    assert.ok('completion_tokens' in result.usage)
    assert.ok('total_tokens' in result.usage)
  })

  test('每次调用生成不同 id', () => {
    const a = formatChatCompletion('m', 'x')
    const b = formatChatCompletion('m', 'x')
    assert.notEqual(a.id, b.id)
  })
})

describe('formatImageResponse', () => {
  test('将 url 数组映射为 data 数组', () => {
    const result = formatImageResponse(['http://a.com/1.png', 'http://a.com/2.png'])
    assert.ok(result.created > 0)
    assert.equal(result.data.length, 2)
    assert.equal(result.data[0].url, 'http://a.com/1.png')
    assert.equal(result.data[1].url, 'http://a.com/2.png')
  })

  test('空数组', () => {
    const result = formatImageResponse([])
    assert.deepEqual(result.data, [])
  })
})

describe('formatModels', () => {
  test('将模型列表映射为 OpenAI list 格式', () => {
    const models = [
      { name: 'gpt-4o-web', vendor: 'chatgpt' },
      { name: 'claude-web', vendor: 'claude' },
    ]
    const result = formatModels(models)
    assert.equal(result.object, 'list')
    assert.equal(result.data.length, 2)
    assert.equal(result.data[0].id, 'gpt-4o-web')
    assert.equal(result.data[0].object, 'model')
    assert.equal(result.data[0].owned_by, 'chatgpt')
    assert.equal(result.data[1].id, 'claude-web')
    assert.equal(result.data[1].owned_by, 'claude')
  })
})

describe('formatError', () => {
  test('正确映射状态码到 error type', () => {
    assert.equal(formatError(400, 'bad').error.type, 'invalid_request_error')
    assert.equal(formatError(401, 'no auth').error.type, 'authentication_error')
    assert.equal(formatError(429, 'slow down').error.type, 'rate_limit_exceeded')
    assert.equal(formatError(500, 'oops').error.type, 'internal_error')
    assert.equal(formatError(502, 'bad gw').error.type, 'bad_gateway')
    assert.equal(formatError(503, 'unavailable').error.type, 'service_unavailable')
    assert.equal(formatError(504, 'timeout').error.type, 'gateway_timeout')
  })

  test('未知状态码回退到 internal_error', () => {
    assert.equal(formatError(999, 'unknown').error.type, 'internal_error')
  })

  test('error.code 是字符串', () => {
    assert.equal(formatError(429, 'slow').error.code, '429')
  })
})

describe('SSE 格式化', () => {
  test('formatSSE', () => {
    const data = { hello: 'world' }
    const result = formatSSE(data)
    assert.equal(result, `data: ${JSON.stringify(data)}\n\n`)
  })

  test('formatSSEDone', () => {
    assert.equal(formatSSEDone(), 'data: [DONE]\n\n')
  })

  test('formatSSEComment', () => {
    assert.equal(formatSSEComment('keepalive'), ': keepalive\n\n')
  })
})
