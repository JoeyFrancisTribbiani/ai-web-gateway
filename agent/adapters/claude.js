// Claude 对话适配器
export default {
  async navigate(page, selectors) {
    if (!page.url().includes('claude.ai')) {
      await page.goto('https://claude.ai', { waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.waitForTimeout(2000)
    }
    // 新对话
    const newChatBtn = page.locator(selectors.newChatButton || 'button[aria-label="New chat"]').first()
    if (await newChatBtn.count() > 0) {
      await newChatBtn.click().catch(() => {})
      await page.waitForTimeout(1000)
    }
  },

  async sendPrompt(page, prompt, selectors) {
    const inputSel = selectors.input || 'div.ProseMirror[contenteditable="true"]'
    await page.waitForSelector(inputSel, { timeout: 15000 })
    await page.click(inputSel)
    await page.waitForTimeout(200)
    await page.keyboard.insertText(prompt)
    await page.waitForTimeout(500)

    const sendSel = selectors.sendButton || 'button[aria-label="Send Message"]'
    const sendBtn = page.locator(sendSel).first()
    for (let i = 0; i < 10; i++) {
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
    const assistantSel = selectors.assistantMessage || 'div.font-claude-message'
    const stopSel = selectors.stopButton || 'button[aria-label="Stop"]'
    let lastText = ''
    let stableCount = 0

    while (!signal?.aborted) {
      try {
        const elements = await page.locator(assistantSel).all()
        if (elements.length > 0) {
          const text = (await elements[elements.length - 1].textContent()) || ''
          if (text.length > lastText.length) {
            onChunk(text.slice(lastText.length))
            lastText = text
            stableCount = 0
          } else {
            stableCount++
          }
        }
      } catch {}

      const stopCount = await page.locator(stopSel).count().catch(() => 0)
      if (stopCount === 0 && stableCount >= 3 && lastText) break
      await page.waitForTimeout(parseInt(process.env.POLL_INTERVAL || '500'))
    }
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
