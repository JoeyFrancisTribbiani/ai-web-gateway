// 即梦 图片+视频适配器
import * as mediaExtractor from '../lib/media-extractor.js'

export default {
  // ===== 图片生成 =====
  async navigate(page, selectors) {
    const imgSel = selectors.image
    if (!page.url().includes('jimeng.jianying.com')) {
      await page.goto('https://jimeng.jianying.com/ai-tool/image/generate', { waitUntil: 'domcontentloaded', timeout: 45000 })
      await page.waitForTimeout(3000)
    }
  },

  async setParams(page, params, selectors) {
    const imgSel = selectors.image
    // 比例设置
    if (params.size && imgSel.aspectRatioButton) {
      try {
        const ratioBtn = page.locator(imgSel.aspectRatioButton).first()
        if (await ratioBtn.isVisible({ timeout: 5000 })) {
          await ratioBtn.click()
          await page.waitForTimeout(1000)
          // 选择对应比例
          const ratioMap = { '1:1': '1:1', '16:9': '16:9', '9:16': '9:16', '3:4': '3:4', '4:3': '4:3' }
          const targetRatio = ratioMap[params.size] || '1:1'
          const option = page.locator(`[role='menuitem'], button`).filter({ hasText: targetRatio }).first()
          if (await option.count() > 0) await option.click()
        }
      } catch {}
    }
  },

  async sendPrompt(page, prompt, selectors) {
    const imgSel = selectors.image
    const inputSel = imgSel?.promptInput || 'textarea'
    const textarea = page.locator(inputSel).first()
    await textarea.waitFor({ state: 'visible', timeout: 15000 })
    await textarea.click()
    await page.keyboard.insertText(prompt)
    await page.waitForTimeout(500)

    const genBtn = page.locator(imgSel?.generateButton || "button:has-text('生成')").first()
    await genBtn.click()
  },

  async waitForImages(page, selectors) {
    const imgSel = selectors.image
    const resultTimeout = imgSel?.resultTimeout || 120000
    const startTime = Date.now()

    while (Date.now() - startTime < resultTimeout) {
      await page.waitForTimeout(3000)
      const imgs = page.locator(imgSel?.resultImage || "img[class*='result']")
      const count = await imgs.count()
      if (count > 0) {
        // 提取图片
        const localPaths = []
        for (let i = 0; i < count; i++) {
          const src = await imgs.nth(i).getAttribute('src').catch(() => null)
          if (src) {
            const path = src.startsWith('blob:')
              ? await mediaExtractor.extractImageViaCanvas(page, src)
              : await mediaExtractor.extractImageViaDownload(src)
            if (path) localPaths.push(path)
          }
        }
        if (localPaths.length > 0) return localPaths
      }
      // 限额检测
      const text = await page.textContent('body').catch(() => '')
      if (imgSel.rateLimitIndicators) {
        for (const kw of imgSel.rateLimitIndicators) {
          if (text?.includes(kw)) throw new Error(`[RATE_LIMIT_EXCEEDED] ${kw}`)
        }
      }
    }
    throw new Error('即梦图片生成超时')
  },

  // ===== 视频生成 =====
  async submitGeneration(page, prompt, selectors) {
    const vidSel = selectors.video
    // 导航到视频生成页面
    await page.goto('https://jimeng.jianying.com/ai-tool/video/generate', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})
    await page.waitForTimeout(3000)

    const inputSel = vidSel?.promptInput || 'textarea'
    const textarea = page.locator(inputSel).first()
    await textarea.waitFor({ state: 'visible', timeout: 15000 })
    await textarea.click()
    await page.keyboard.insertText(prompt)
    await page.waitForTimeout(500)

    const genBtn = page.locator(vidSel?.generateButton || "button:has-text('生成视频')").first()
    await genBtn.click()
    await page.waitForTimeout(3000)
  },

  async pollStatus(page, selectors) {
    const vidSel = selectors.video
    const videoEl = page.locator(vidSel?.resultVideo || 'video').first()
    const queueEl = page.locator(vidSel?.queueIndicator || "[class*='queue']").first()
    const progressEl = page.locator(vidSel?.progressIndicator || "[class*='progress']").first()

    // 检查错误/限额
    if (vidSel?.rateLimitIndicators) {
      const bodyText = await page.textContent('body').catch(() => '')
      if (bodyText) {
        for (const kw of vidSel.rateLimitIndicators) {
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
    const vidSel = selectors.video
    // 优先拦截下载
    if (vidSel.downloadButton) {
      const path = await mediaExtractor.extractVideoViaDownload(page, vidSel.downloadButton, vidSel)
      if (path) return path
    }
    // 降级: 从 video src 提取
    return await mediaExtractor.extractVideoFromSrc(page, vidSel)
  },

  async checkRateLimit(page, selectors) {
    const text = await page.textContent('body').catch(() => '')
    const indicators = selectors.image?.rateLimitIndicators || []
    for (const kw of indicators) {
      if (text?.includes(kw)) return { limited: true, message: kw }
    }
    return { limited: false }
  },
}
