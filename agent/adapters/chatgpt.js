// ChatGPT 对话适配器
// 复用 chrome-cdp-daemon server.mjs 的核心逻辑:
// - 剪贴板粘贴 (server.mjs:259-271)
// - 发送按钮轮询 (server.mjs:274-312)
// - 停止按钮检测 (server.mjs:471-485)
// - 文件上传 filechooser (server.mjs:321-445)

import * as mediaExtractor from '../lib/media-extractor.js'

export default {
  async navigate(page, selectors) {
    const url = 'https://chatgpt.com'
    if (!page.url().includes('chatgpt.com')) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.waitForTimeout(2000)
    }
    // 点击新对话
    const newChatBtn = page.locator(selectors.newChatButton || "a[href='/']").first()
    if (await newChatBtn.count() > 0) {
      await newChatBtn.click().catch(() => {})
      await page.waitForTimeout(1000)
    }
  },

  async uploadFile(page, filePath, selectors) {
    const inputSel = selectors.input || '#prompt-textarea'
    await page.waitForSelector(inputSel, { timeout: 15000 })

    // 方式1: + 按钮 → filechooser
    const plusBtnSelectors = [
      'button[data-testid="composer-plus-btn"]',
      'button[aria-label*="Attach"]',
      'button[aria-label*="attach"]',
    ]

    for (const sel of plusBtnSelectors) {
      try {
        if (await page.locator(sel).count() > 0) {
          const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 10000 })
          await page.click(sel, { timeout: 5000 })
          const fileChooser = await fileChooserPromise
          await fileChooser.setFiles(filePath)
          await page.waitForTimeout(2000)
          return
        }
      } catch {}
    }

    // 方式2: 直接 setInputFiles
    const fileInput = page.locator('input#upload-files, input[type="file"]').first()
    if (await fileInput.count() > 0) {
      await fileInput.setInputFiles(filePath)
      await page.waitForTimeout(2000)
    }
  },

  async sendPrompt(page, prompt, selectors) {
    const inputSel = selectors.input || '#prompt-textarea'
    await page.waitForSelector(inputSel, { timeout: 15000, state: 'visible' })
    await page.click(inputSel)
    await page.waitForTimeout(200)

    // 清空
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(100)

    // 剪贴板粘贴 (解决中文 + React 状态更新)
    await page.evaluate((text) => navigator.clipboard.writeText(text), prompt)
    await page.click(inputSel)
    await page.waitForTimeout(100)
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(100)
    await page.keyboard.press('Control+v')
    await page.waitForTimeout(800)

    // 轮询发送按钮状态
    const sendSelectors = selectors.sendButton
      ? selectors.sendButton.split(',').map(s => s.trim())
      : ['button[data-testid="send-button"]', 'button[aria-label="Send"]', 'button[aria-label="发送提示"]']

    let sent = false
    for (let attempt = 0; attempt < 15; attempt++) {
      for (const sel of sendSelectors) {
        try {
          const state = await page.evaluate((selector) => {
            const btn = document.querySelector(selector)
            if (btn) return { found: true, disabled: btn.disabled, visible: btn.offsetParent !== null }
            return { found: false }
          }, sel)

          if (state.found && !state.disabled && state.visible) {
            await page.click(sel, { timeout: 5000 })
            sent = true
            break
          }
        } catch {}
      }
      if (sent) break
      await page.waitForTimeout(500)
    }

    if (!sent) {
      await page.click(inputSel)
      await page.keyboard.press('Enter')
    }
  },

  async streamResponse(page, onChunk, selectors, signal) {
    const assistantSel = selectors.assistantMessage || '[data-message-author-role="assistant"]'
    const stopSelectors = selectors.stopButton
      ? selectors.stopButton.split(',').map(s => s.trim())
      : ['button[data-testid="stop-button"]', 'button[aria-label="Stop"]']

    // 记录发送前的文本
    let preText = ''
    try {
      const elements = await page.locator(assistantSel).all()
      if (elements.length > 0) {
        preText = (await elements[elements.length - 1].textContent()) || ''
      }
    } catch {}

    // 等待新回复开始
    let lastText = preText
    let stableCount = 0
    const stableThreshold = 3
    const pollInterval = parseInt(process.env.POLL_INTERVAL || '500', 10)

    while (!signal?.aborted) {
      // 获取最新 assistant 消息
      let currentText = ''
      try {
        const elements = await page.locator(assistantSel).all()
        if (elements.length > 0) {
          currentText = (await elements[elements.length - 1].textContent()) || ''
        }
      } catch {}

      // 检测增量
      if (currentText.length > lastText.length && currentText !== preText) {
        const delta = currentText.slice(lastText.length === preText.length ? preText.length : lastText.length)
        if (delta) onChunk(delta)
        lastText = currentText
        stableCount = 0
      } else if (currentText === lastText) {
        stableCount++
      } else {
        lastText = currentText
        stableCount = 0
      }

      // 检查是否还在生成
      let stillGenerating = false
      for (const sel of stopSelectors) {
        try {
          const count = await page.locator(sel).count()
          if (count > 0) { stillGenerating = true; break }
        } catch {}
      }

      // 生成完成: 停止按钮消失 + 文本稳定
      if (!stillGenerating && stableCount >= stableThreshold && currentText && currentText !== preText) {
        break
      }

      // 检查限额
      if (selectors.rateLimitIndicators) {
        for (const keyword of selectors.rateLimitIndicators) {
          if (currentText.toLowerCase().includes(keyword.toLowerCase())) {
            throw new Error(`[RATE_LIMIT_EXCEEDED] ${currentText.slice(0, 100)}`)
          }
        }
      }

      await page.waitForTimeout(pollInterval)
    }
  },

  async checkRateLimit(page, selectors) {
    if (!selectors.rateLimitIndicators) return { limited: false }
    const text = await page.textContent('body').catch(() => '')
    for (const keyword of selectors.rateLimitIndicators) {
      if (text?.toLowerCase().includes(keyword.toLowerCase())) {
        return { limited: true, message: keyword }
      }
    }
    return { limited: false }
  },
}
