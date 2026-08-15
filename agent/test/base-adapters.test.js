import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { BaseChatAdapter } from '../adapters/base-chat.js'
import { BaseImageAdapter } from '../adapters/base-image.js'
import { BaseVideoAdapter } from '../adapters/base-video.js'

// mock page object (只用到方法调用验证)
function mockPage() {
  return {
    _calls: [],
    goto(url, opts) { this._calls.push({ method: 'goto', url, opts }) },
    locator(sel) {
      return {
        _calls: this._calls,
        count() { return Promise.resolve(0) },
        click() { return Promise.resolve() },
        textContent() { return Promise.resolve('') },
        all() { return Promise.resolve([]) },
        first() { return this },
        setInputFiles() { return Promise.resolve() },
      }
    },
    waitForSelector() { return Promise.resolve() },
    click() { return Promise.resolve() },
    waitForTimeout(ms) { return Promise.resolve() },
    waitForEvent() { return Promise.resolve({ setFiles() {} }) },
    keyboard: {
      press() { return Promise.resolve() },
    },
    evaluate(fn, ...args) {
      if (typeof fn === 'string') return Promise.resolve()
      return Promise.resolve(fn?.(null, ...args) ?? null)
    },
    textContent() { return Promise.resolve('') },
    screenshot() { return Promise.resolve() },
    url() { return 'about:blank' },
  }
}

const selectors = {
  input: '#prompt-textarea',
  sendButton: 'button[data-testid="send-button"]',
  stopButton: 'button[data-testid="stop-button"]',
  assistantMessage: '[data-message-author-role="assistant"]',
}

describe('BaseChatAdapter', () => {
  test('navigate 抛出 not implemented', async () => {
    const adapter = new BaseChatAdapter()
    await assert.rejects(() => adapter.navigate(mockPage(), selectors), /not implemented/)
  })

  test('uploadFile 抛出 not implemented', async () => {
    const adapter = new BaseChatAdapter()
    await assert.rejects(() => adapter.uploadFile(mockPage(), '/tmp/test.png', selectors), /not implemented/)
  })

  test('sendPrompt 抛出 not implemented', async () => {
    const adapter = new BaseChatAdapter()
    await assert.rejects(() => adapter.sendPrompt(mockPage(), 'hello', selectors), /not implemented/)
  })

  test('streamResponse 抛出 not implemented', async () => {
    const adapter = new BaseChatAdapter()
    await assert.rejects(
      () => adapter.streamResponse(mockPage(), () => {}, selectors, {}),
      /not implemented/
    )
  })

  test('checkRateLimit 默认返回 { limited: false }', async () => {
    const adapter = new BaseChatAdapter()
    const result = await adapter.checkRateLimit(mockPage(), selectors)
    assert.deepEqual(result, { limited: false })
  })
})

describe('BaseImageAdapter', () => {
  test('navigate 抛出 not implemented', async () => {
    const adapter = new BaseImageAdapter()
    await assert.rejects(() => adapter.navigate(mockPage(), selectors), /not implemented/)
  })

  test('uploadReferenceImage 抛出 not implemented', async () => {
    const adapter = new BaseImageAdapter()
    await assert.rejects(
      () => adapter.uploadReferenceImage(mockPage(), '/tmp/ref.png', selectors),
      /not implemented/
    )
  })

  test('setParams 抛出 not implemented', async () => {
    const adapter = new BaseImageAdapter()
    await assert.rejects(() => adapter.setParams(mockPage(), {}, selectors), /not implemented/)
  })

  test('sendPrompt 抛出 not implemented', async () => {
    const adapter = new BaseImageAdapter()
    await assert.rejects(() => adapter.sendPrompt(mockPage(), 'draw a cat', selectors), /not implemented/)
  })

  test('waitForImages 抛出 not implemented', async () => {
    const adapter = new BaseImageAdapter()
    await assert.rejects(() => adapter.waitForImages(mockPage(), selectors), /not implemented/)
  })

  test('checkRateLimit 默认返回 { limited: false }', async () => {
    const adapter = new BaseImageAdapter()
    const result = await adapter.checkRateLimit(mockPage(), selectors)
    assert.deepEqual(result, { limited: false })
  })
})

describe('BaseVideoAdapter', () => {
  test('navigate 抛出 not implemented', async () => {
    const adapter = new BaseVideoAdapter()
    await assert.rejects(() => adapter.navigate(mockPage(), selectors), /not implemented/)
  })

  test('setParams 抛出 not implemented', async () => {
    const adapter = new BaseVideoAdapter()
    await assert.rejects(() => adapter.setParams(mockPage(), {}, selectors), /not implemented/)
  })

  test('submitGeneration 抛出 not implemented', async () => {
    const adapter = new BaseVideoAdapter()
    await assert.rejects(
      () => adapter.submitGeneration(mockPage(), 'make a video', selectors),
      /not implemented/
    )
  })

  test('pollStatus 抛出 not implemented', async () => {
    const adapter = new BaseVideoAdapter()
    await assert.rejects(() => adapter.pollStatus(mockPage(), selectors), /not implemented/)
  })

  test('extractVideo 抛出 not implemented', async () => {
    const adapter = new BaseVideoAdapter()
    await assert.rejects(() => adapter.extractVideo(mockPage(), selectors), /not implemented/)
  })

  test('checkRateLimit 默认返回 { limited: false }', async () => {
    const adapter = new BaseVideoAdapter()
    const result = await adapter.checkRateLimit(mockPage(), selectors)
    assert.deepEqual(result, { limited: false })
  })
})

describe('ChatGPT 适配器接口契约', () => {
  test('chatgpt.js 导出所有必需方法', async () => {
    const chatgpt = (await import('../adapters/chatgpt.js')).default
    assert.ok(typeof chatgpt.navigate === 'function')
    assert.ok(typeof chatgpt.uploadFile === 'function')
    assert.ok(typeof chatgpt.sendPrompt === 'function')
    assert.ok(typeof chatgpt.streamResponse === 'function')
    assert.ok(typeof chatgpt.checkRateLimit === 'function')
  })
})

describe('所有适配器文件可加载', () => {
  const adapters = ['chatgpt', 'claude', 'gemini', 'doubao', 'jimeng', 'kling']

  for (const name of adapters) {
    test(`${name}..js 可正常 import`, async () => {
      const mod = await import(`../adapters/${name}.js`)
      assert.ok(mod.default, `${name}.js 应有 default 导出`)
    })
  }
})
