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
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
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
    await page.waitForSelector(inputSel, { timeout: 60000 })

    // 方式1: + 按钮 → filechooser
    const plusBtnSelectors = [
      'button[data-testid="composer-plus-btn"]',
      'button[aria-label*="Attach"]',
      'button[aria-label*="attach"]',
    ]

    let uploaded = false
    for (const sel of plusBtnSelectors) {
      try {
        if (await page.locator(sel).count() > 0) {
          const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 30000 })
          await page.click(sel, { timeout: 10000 })
          const fileChooser = await fileChooserPromise
          await fileChooser.setFiles(filePath)
          await page.waitForTimeout(3000)
          uploaded = true
          break
        }
      } catch {}
    }

    // 方式2: 直接 setInputFiles
    if (!uploaded) {
      const fileInput = page.locator('input#upload-files, input[type="file"]').first()
      if (await fileInput.count() > 0) {
        try {
          // 记录上传前的 file-tile 数量
          const tilesBefore = await page.evaluate(() => document.querySelectorAll('[class*="file-tile"]').length)
          await fileInput.setInputFiles(filePath)
          await page.waitForTimeout(3000)
          const tilesAfter = await page.evaluate(() => document.querySelectorAll('[class*="file-tile"]').length)
          if (tilesAfter > tilesBefore) {
            uploaded = true
          }
        } catch {}
      }
    }

    // 等待文件上传完成 (file-tile spinner 消失)
    if (uploaded) {
      for (let wait = 0; wait < 900; wait++) { // 最多等15分钟
        const loadingState = await page.evaluate(() => {
          const tiles = document.querySelectorAll('[class*="file-tile"]')
          for (const tile of tiles) {
            const btn = tile.querySelector('button')
            if (btn && btn.className.includes('cursor-wait')) return { loading: true }
            if (tile.className.includes('cursor-wait')) return { loading: true }
          }
          return { loading: false }
        })
        if (!loadingState.loading) {
          break
        }
        await page.waitForTimeout(1000)
      }
    }
  },

  async sendPrompt(page, prompt, selectors) {
    const inputSel = selectors.input || '#prompt-textarea'
    await page.waitForSelector(inputSel, { timeout: 60000, state: 'visible' })
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
            await page.click(sel, { timeout: 10000 })
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

  // 获取最新 assistant 消息文本 (多选择器 fallback, 参考 feedaccount getLastAssistantText)
  // 排除 ChatGPT thinking/reasoning 块，只取实际回复内容
  async getLastAssistantText(page) {
    return await page.evaluate(() => {
      const selectors = [
        '[data-message-author-role="assistant"]',
        'div[class*="markdown"]',
        '[data-testid^="conversation-turn-"]',
      ]
      for (const sel of selectors) {
        const elements = document.querySelectorAll(sel)
        if (elements.length > 0) {
          const el = elements[elements.length - 1]
          // 克隆节点，移除 thinking/reasoning 块后再取 textContent
          const clone = el.cloneNode(true)
          // ChatGPT thinking 块的常见选择器
          const thinkingSelectors = [
            '[data-reasoning]',
            '[class*="thinking"]',
            '[class*="reasoning"]',
            '[data-testid="thinking"]',
            'div[class*="sr-only"]',
            'details summary',
            // ChatGPT 新版 thinking 块: <div> + <button class*="analyze">
            'button[class*="analyze"]',
            'div[class*="whitespace-pre"]',
            // data-part 属性的 thinking 块
            '[data-part="thinking"]',
            '[data-part="analysis"]',
          ]
          for (const ts of thinkingSelectors) {
            clone.querySelectorAll(ts).forEach(n => n.remove())
          }
          // 也排除 <button> 文本（如"复制"、"重新生成"等操作按钮）
          clone.querySelectorAll('button').forEach(n => n.remove())
          let text = clone.textContent || ''
          text = text.trim()
          if (text) return text
          // 如果去掉 thinking 后没内容了，尝试找 markdown 容器
          const md = el.querySelector('div[class*="markdown"], .markdown')
          if (md) return (md.textContent || '').trim()
          // 最后回退到原始 textContent
          return (el.textContent || '').trim()
        }
      }
      return ''
    })
  },

  // 检测 ChatGPT 是否还在生成 (多重检测, 参考 feedaccount isStillGenerating)
  async isStillGenerating(page) {
    return await page.evaluate(() => {
      // 方式1: 标准 stop-button 存在且可见
      const stopBtns = document.querySelectorAll('button[data-testid="stop-button"]')
      for (const btn of stopBtns) { if (btn.offsetParent !== null) return true }

      // 方式2: composer-submit-button 的 aria-label 判断
      const submitBtn = document.querySelector('button[class*="composer-submit-button"]')
      if (submitBtn) {
        const aria = (submitBtn.getAttribute('aria-label') || '').toLowerCase()
        if (aria.includes('停止') || aria.includes('stop') || aria.includes('中断') || aria.includes('cancel')) return true
        if (aria.includes('发送') || aria.includes('send') || aria.includes('语音') || aria.includes('voice')) return false
      }

      // 方式3: 其他 stop 相关按钮
      const allStopLike = document.querySelectorAll('button[class*="stop"], button[data-testid*="stop"]')
      for (const btn of allStopLike) { if (btn.offsetParent !== null) return true }

      return false
    })
  },

  // 检测 ChatGPT 错误提示
  isErrorText(text) {
    if (!text) return false
    const errorKeywords = ['出了点问题', '请重试', 'Something went wrong', 'try again', '网络错误', 'network error']
    const lower = text.toLowerCase()
    return errorKeywords.some(kw => lower.includes(kw.toLowerCase()))
  },

  // 检测 ChatGPT 是否还在 thinking/reasoning（生成前的思考阶段）
  async isThinking(page) {
    return await page.evaluate(() => {
      // ChatGPT thinking 块的 UI 元素（思考中时显示）
      const thinkingSelectors = [
        '[data-reasoning]',
        '[class*="thinking"]',
        '[class*="reasoning"]',
        '[data-testid="thinking"]',
        'button[class*="analyze"]',
      ]
      for (const sel of thinkingSelectors) {
        const els = document.querySelectorAll(sel)
        for (const el of els) {
          if (el.offsetParent !== null) return true  // 可见
        }
      }
      // 也检查页面上是否有 "Thinking" / "思考中" 等文本提示
      const body = document.body.innerText
      if (/^(Thinking|思考中|Reasoning)\b/m.test(body)) return true
      return false
    })
  },

  async streamResponse(page, onChunk, selectors, signal) {
    const pollInterval = parseInt(process.env.POLL_INTERVAL || '500', 10)
    const stableThreshold = 3
    const startTimeout = 60000 // 等待回复开始, 最多 60s

    // 记录发送前的文本
    const preText = await this.getLastAssistantText(page)

    // ===== 阶段0: 等待 thinking 结束 =====
    // ChatGPT 会先 thinking 再输出回复，thinking 期间不要取文本
    const thinkStartTime = Date.now()
    while (Date.now() - thinkStartTime < startTimeout) {
      if (signal?.aborted) return
      const thinking = await this.isThinking(page)
      const generating = await this.isStillGenerating(page)
      // 还在 thinking 或还在生成但文本没变化 → 继续等
      if (thinking) {
        await page.waitForTimeout(pollInterval)
        continue
      }
      // 不在 thinking 了，检查是否开始输出实际文本
      const currentText = await this.getLastAssistantText(page)
      if (currentText && currentText !== preText) break
      if (generating) {
        // 还在生成但没有 thinking 也没有新文本 → 继续等
        await page.waitForTimeout(pollInterval)
        continue
      }
      break
    }

    // ===== 阶段1: 收集回复 + 等待稳定 =====
    let lastText = preText
    let stableCount = 0

    while (!signal?.aborted) {
      const currentText = await this.getLastAssistantText(page)

      // 检测 ChatGPT 错误提示
      if (this.isErrorText(currentText) && currentText !== preText) {
        throw new Error(`[CHATGPT_ERROR] ${currentText.slice(0, 200)}`)
      }

      // 检测增量
      if (currentText.length > lastText.length && currentText !== preText) {
        const delta = currentText.slice(lastText.length)
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
      const stillGenerating = await this.isStillGenerating(page)

      // 生成完成: 不在生成 + 文本稳定 + 有新回复
      if (!stillGenerating && stableCount >= stableThreshold && currentText && currentText !== preText) {
        // 短回复需要更多稳定次数
        if (currentText.length < 100 && stableCount < 10) {
          // 继续等待
        } else {
          break
        }
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
