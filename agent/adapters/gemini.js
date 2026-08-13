// Gemini 对话+图片适配器
// 复用 ai-image-wash worker.js 的 Gemini 逻辑:
// - rich-textarea 输入 (worker.js:714-737)
// - message-content 提取 (worker.js:895-925)
// - Pro 模式切换 (worker.js:690-709)
// - 图片生成模式切换 (worker.js:270-318)
// - 图片 Canvas 提取 (worker.js:930-979)

import * as mediaExtractor from '../lib/media-extractor.js'

export default {
  // ===== 对话 =====
  async navigate(page, selectors) {
    if (!page.url().includes('gemini.google.com')) {
      await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 45000 })
      await page.waitForTimeout(2000)
    }
  },

  async sendPrompt(page, prompt, selectors) {
    // Pro 模式切换
    if (selectors.proModeSwitch) {
      try {
        const modeBtn = page.locator(selectors.proModeButton).first()
        if (await modeBtn.isVisible({ timeout: 3000 })) {
          const text = await modeBtn.textContent()
          if (text && !text.includes('Pro')) {
            await modeBtn.click()
            await page.waitForTimeout(1000)
            const proOption = page.locator(selectors.proModeOption).first()
            if (await proOption.count() > 0) {
              await proOption.click()
              await page.waitForTimeout(2000)
            }
          }
        }
      } catch {}
    }

    const inputSel = selectors.input || 'rich-textarea p'
    const editor = page.locator(inputSel).first()
    await editor.waitFor({ state: 'visible', timeout: 15000 })
    await editor.click()
    await page.keyboard.insertText(prompt)
    await page.waitForTimeout(500)

    const sendBtn = page.locator(selectors.sendButton || "button[aria-label*='Send'], button[aria-label*='发送']").first()
    for (let i = 0; i < 30; i++) {
      try {
        if (await sendBtn.count() > 0 && await sendBtn.isVisible() && !(await sendBtn.isDisabled())) {
          await sendBtn.click()
          return
        }
      } catch {}
      await page.waitForTimeout(500)
    }
    await page.keyboard.press('Enter')
  },

  async streamResponse(page, onChunk, selectors, signal) {
    const assistantSel = selectors.assistantMessage || 'message-content .markdown-main-panel'
    const stopSel = selectors.stopButton || "button[aria-label*='Stop'], button[aria-label*='停止']"
    let lastText = ''
    let stableCount = 0

    // 等待消息容器出现
    await page.waitForSelector('message-content', { timeout: 30000 }).catch(() => {})

    while (!signal?.aborted) {
      try {
        const lastMsg = page.locator(assistantSel).last()
        if (await lastMsg.count() > 0) {
          const text = await lastMsg.innerText()
          if (text.length > lastText.length) {
            onChunk(text.slice(lastText.length))
            lastText = text
            stableCount = 0
          } else {
            stableCount++
          }
        }
      } catch {}

      // 限额检测
      if (selectors.rateLimitIndicators) {
        for (const kw of selectors.rateLimitIndicators) {
          if (lastText.includes(kw)) {
            throw new Error(`[RATE_LIMIT_EXCEEDED] ${lastText.slice(0, 100)}`)
          }
        }
      }

      const stopCount = await page.locator(stopSel).count().catch(() => 0)
      if (stopCount === 0 && stableCount >= 3 && lastText) break
      await page.waitForTimeout(parseInt(process.env.POLL_INTERVAL || '500'))
    }
  },

  // ===== 图片生成 =====
  async setParams(page, params, selectors) {
    // 切换到"制作图片"模式
    if (selectors.imageMode) {
      try {
        const triggerBtn = page.locator(selectors.imageMode.triggerButton).first()
        if (await triggerBtn.isVisible({ timeout: 5000 })) {
          await triggerBtn.click()
          await page.waitForTimeout(2000)
        }
      } catch {}
    }
  },

  async waitForImages(page, selectors) {
    // 等待图片生成
    await page.waitForSelector('message-content', { timeout: 30000 }).catch(() => {})

    const foundImages = []
    const imgFilter = selectors.imageMode?.imgFilter || 'googleusercontent.com, blob:'
    const filters = imgFilter.split(',').map(s => s.trim())

    for (let att = 0; att < 100; att++) {
      await page.waitForTimeout(3000)
      const lastMsg = page.locator('message-content').last()
      const imgs = lastMsg.locator('img')
      const count = await imgs.count()

      for (let i = 0; i < count; i++) {
        const src = await imgs.nth(i).getAttribute('src', { timeout: 2000 }).catch(() => null)
        if (src && filters.some(f => src.includes(f))) {
          if (!foundImages.includes(src)) {
            const rect = await imgs.nth(i).boundingBox({ timeout: 1000 }).catch(() => null)
            const minWidth = selectors.imageMode?.minImgWidth || 100
            if (rect && rect.width > minWidth) {
              foundImages.push(src)
            }
          }
        }
      }

      // 限额检测
      const text = await lastMsg.innerText().catch(() => '')
      if (selectors.rateLimitIndicators) {
        for (const kw of selectors.rateLimitIndicators) {
          if (text.includes(kw)) throw new Error(`[RATE_LIMIT_EXCEEDED] ${kw}`)
        }
      }
      // 安全过滤检测 — 只在有文本且无图片且文本匹配安全关键词时才抛错
      if (foundImages.length === 0 && text.trim().length > 0) {
        const safetyKeywords = [
          '违反安全', '安全策略', '无法生成', 'violated', 'prohibited',
          'safety policy', "can't generate", "can't help", 'cannot help',
          "can't assist", "can't create", "can't provide", 'cannot provide',
          'filtered out'
        ]
        // 规范化弯引号为直引号（Gemini Web UI 渲染的 innerText 使用弯引号）
        const normalizedText = text.replace(/[\u2018\u2019]/g, "'")
        if (safetyKeywords.some(kw => normalizedText.toLowerCase().includes(kw.toLowerCase()))) {
          throw new Error(`内容被安全策略拦截: ${text.trim().slice(0, 50)}`)
        }
      }

      // 检查是否完成
      const isDone = await lastMsg.locator("button[aria-label*='response'], button[aria-label*='回答']").count().then(c => c > 0)
      if (foundImages.length > 0 && isDone) break
    }

    if (foundImages.length === 0) throw new Error('生图等待超时')

    // 提取图片为本地文件
    const localPaths = []
    for (const src of foundImages) {
      let path
      if (src.startsWith('blob:')) {
        path = await mediaExtractor.extractImageViaCanvas(page, src)
      } else {
        path = await mediaExtractor.extractImageViaDownload(src)
      }
      if (path) localPaths.push(path)
    }
    return localPaths
  },

  async checkRateLimit(page, selectors) {
    if (!selectors.rateLimitIndicators) return { limited: false }
    const text = await page.textContent('body').catch(() => '')
    for (const kw of selectors.rateLimitIndicators) {
      if (text?.includes(kw)) return { limited: true, message: kw }
    }
    return { limited: false }
  },
}
