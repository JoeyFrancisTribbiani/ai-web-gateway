// Kling 视频适配器
import * as mediaExtractor from '../lib/media-extractor.js'

export default {
  async navigate(page, selectors) {
    if (!page.url().includes('kling.kuaishou.com')) {
      await page.goto('https://kling.kuaishou.com', { waitUntil: 'domcontentloaded', timeout: 45000 })
      await page.waitForTimeout(3000)
    }
  },

  async setParams(page, params, selectors) {
    // 时长
    if (params.duration && selectors.durationButton) {
      try {
        const durationBtn = page.locator(selectors.durationButton).first()
        if (await durationBtn.isVisible({ timeout: 5000 })) {
          await durationBtn.click()
        }
      } catch {}
    }
    // 比例
    if (params.aspect_ratio && selectors.aspectRatioButton) {
      try {
        const ratioBtn = page.locator(selectors.aspectRatioButton).first()
        if (await ratioBtn.isVisible({ timeout: 5000 })) {
          await ratioBtn.click()
          await page.waitForTimeout(1000)
          const option = page.locator(`[role='menuitem'], button`).filter({ hasText: params.aspect_ratio }).first()
          if (await option.count() > 0) await option.click()
        }
      } catch {}
    }
  },

  async submitGeneration(page, prompt, selectors) {
    const inputSel = selectors.promptInput || 'textarea'
    const textarea = page.locator(inputSel).first()
    await textarea.waitFor({ state: 'visible', timeout: 15000 })
    await textarea.click()
    await page.keyboard.insertText(prompt)
    await page.waitForTimeout(500)

    const genBtn = page.locator(selectors.generateButton || "button:has-text('Generate'), button:has-text('生成')").first()
    await genBtn.click()
    await page.waitForTimeout(3000)
  },

  async pollStatus(page, selectors) {
    const videoEl = page.locator(selectors.resultVideo || 'video').first()
    const queueEl = page.locator(selectors.queueIndicator || "[class*='queue']").first()
    const progressEl = page.locator(selectors.progressIndicator || "[class*='progress']").first()

    // 检查错误/限额
    if (selectors.rateLimitIndicators) {
      const bodyText = await page.textContent('body').catch(() => '')
      if (bodyText) {
        for (const kw of selectors.rateLimitIndicators) {
          if (bodyText.includes(kw)) return { status: 'failed', progress: 0 }
        }
      }
    }

    if (await videoEl.isVisible().catch(() => false)) {
      return { status: 'completed', progress: 100 }
    }
    if (await queueEl.isVisible().catch(() => false)) {
      return { status: 'generating', progress: 0 }
    }
    if (await progressEl.isVisible().catch(() => false)) {
      return { status: 'generating', progress: 50 }
    }
    return { status: 'generating', progress: 30 }
  },

  async extractVideo(page, selectors) {
    if (selectors.downloadButton) {
      const path = await mediaExtractor.extractVideoViaDownload(page, selectors.downloadButton, selectors)
      if (path) return path
    }
    return await mediaExtractor.extractVideoFromSrc(page, selectors)
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
