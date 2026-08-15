import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildPrompt, extractImageUrls } from '../lib/message-builder.js'

describe('buildPrompt', () => {
  test('单条 user message (string content) → 直接返回 content', () => {
    const result = buildPrompt([{ role: 'user', content: '你好' }])
    assert.equal(result, '你好')
  })

  test('单条 user message (array content: text + image_url)', () => {
    const result = buildPrompt([{
      role: 'user',
      content: [
        { type: 'text', text: '这是什么？' },
        { type: 'image_url', image_url: { url: 'http://example.com/img.png' } },
      ],
    }])
    assert.equal(result, '这是什么？\n[图片已上传]')
  })

  test('system + user 消息', () => {
    const result = buildPrompt([
      { role: 'system', content: '你是一个助手' },
      { role: 'user', content: '你好' },
    ])
    assert.ok(result.includes('[系统提示]'))
    assert.ok(result.includes('你是一个助手'))
    assert.ok(result.includes('[当前问题]'))
    assert.ok(result.includes('你好'))
  })

  test('多轮对话历史', () => {
    const result = buildPrompt([
      { role: 'user', content: '1+1=?' },
      { role: 'assistant', content: '2' },
      { role: 'user', content: '2+2=?' },
    ])
    assert.ok(result.includes('[对话历史]'))
    assert.ok(result.includes('User: 1+1=?'))
    assert.ok(result.includes('Assistant: 2'))
    assert.ok(result.includes('[当前问题]'))
    assert.ok(result.includes('2+2=?'))
  })

  test('空 messages 返回空字符串', () => {
    assert.equal(buildPrompt([]), '')
    assert.equal(buildPrompt(null), '')
    assert.equal(buildPrompt(undefined), '')
  })

  test('超过 8000 字符时截断为 system + 当前问题', () => {
    const longText = 'A'.repeat(8001)
    const result = buildPrompt([
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: longText },
      { role: 'user', content: 'Q2' },
    ])
    assert.ok(result.length < 8001, 'prompt 应被截断')
    assert.ok(result.includes('[当前问题]'))
    assert.ok(result.includes('Q2'))
    // 截断后不包含对话历史
    assert.ok(!result.includes('[对话历史]'))
  })

  test('assistant 角色映射为 Assistant', () => {
    const result = buildPrompt([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'bye' },
    ])
    assert.ok(result.includes('Assistant: hello'))
    assert.ok(result.includes('User: hi'))
    assert.ok(result.includes('User: bye'))
  })
})

describe('extractImageUrls', () => {
  test('从 array content 中提取 image_url', () => {
    const urls = extractImageUrls([
      {
        role: 'user',
        content: [
          { type: 'text', text: '看这张图' },
          { type: 'image_url', image_url: { url: 'http://a.com/1.png' } },
          { type: 'image_url', image_url: { url: 'http://a.com/2.png' } },
        ],
      },
      { role: 'assistant', content: '好的' },
    ])
    assert.deepEqual(urls, ['http://a.com/1.png', 'http://a.com/2.png'])
  })

  test('string content 返回空数组', () => {
    assert.deepEqual(extractImageUrls([{ role: 'user', content: 'hello' }]), [])
  })

  test('null 返回空数组', () => {
    assert.deepEqual(extractImageUrls(null), [])
  })

  test('空数组返回空数组', () => {
    assert.deepEqual(extractImageUrls([]), [])
  })
})
