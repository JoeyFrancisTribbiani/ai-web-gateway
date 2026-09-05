// ChatGPT 对话适配器
// 对齐 feedaccount chrome-cdp-daemon/server.mjs 的核心逻辑:
// - sendPrompt: insertText → fill → 剪贴板三层 fallback (server.mjs:333-470)
// - 发送按钮轮询: 等 disabled/visible 状态 (server.mjs:375-440)
// - uploadFile: setInputFiles → DataTransfer → plus菜单filechooser, 等 cursor-wait (server.mjs:480-640)
// - dismissModal: 每步操作后清理弹窗 (server.mjs:837-852)
// - isStillGenerating: stop-button + composer aria-label (server.mjs:684-707)
// - streamResponse: 非流式, 等稳定后一次性取全文 (server.mjs:708-840)

import * as mediaExtractor from '../lib/media-extractor.js'
import { existsSync, statSync, readFileSync } from 'fs'

export default {
  // 清理 ChatGPT 弹窗 (参考 feedaccount dismissModal)
  async dismissModal(page) {
    try {
      await page.evaluate(() => {
        const modals = document.querySelectorAll('[role="dialog"], [aria-modal="true"], [class*="modal"], [class*="popover"]')
        for (const modal of modals) {
          if (modal.offsetParent === null) continue
          const btns = modal.querySelectorAll('button')
          for (const btn of btns) {
            const text = btn.textContent?.trim() || ''
            if (['确定', 'OK', '好的', 'Close', '关闭'].includes(text) || text.length <= 3) { btn.click(); return true }
          }
        }
        return false
      })
    } catch {}
  },

  async navigate(page, selectors) {
    const url = 'https://chatgpt.com'
    if (!page.url().includes('chatgpt.com')) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 300000 })
      await page.waitForTimeout(3000)
    }
    // 清理弹窗 ×3
    for (let i = 0; i < 3; i++) { await this.dismissModal(page); await page.waitForTimeout(500) }

    // 点击新对话
    const newChatBtn = page.locator(selectors.newChatButton || "a[href='/'], a:has-text('新聊天'), button:has-text('新聊天')").first()
    if (await newChatBtn.count() > 0) {
      await newChatBtn.click({ timeout: 5000, force: true }).catch(() => {})
      await page.waitForTimeout(2000)
    }
    await this.dismissModal(page)
  },

  async uploadFile(page, filePath, selectors) {
    if (!existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`)
    await this.dismissModal(page)

    // 记录上传前的 file-tile 数量
    const tilesBefore = await page.evaluate(() => document.querySelectorAll('[class*="file-tile"]').length).catch(() => 0)

    // 方式1: 直接 setInputFiles (小文件有效)
    let uploaded = false
    try {
      const fileInput = page.locator('input#upload-files, input[type="file"]').first()
      if (await fileInput.count() > 0) {
        try {
          await fileInput.setInputFiles(filePath)
          await page.waitForTimeout(3000)
          const tilesAfter = await page.evaluate(() => document.querySelectorAll('[class*="file-tile"]').length)
          if (tilesAfter > tilesBefore) {
            uploaded = true
          }
        } catch (sizeErr) {
          const errMsg = sizeErr.message.substring(0, 120)
          const isTimeout = errMsg.includes('Timeout')
          if (isTimeout) {
            const tilesAfter = await page.evaluate(() => document.querySelectorAll('[class*="file-tile"]').length)
            if (tilesAfter > tilesBefore) uploaded = true
          } else {
            // 大文件: DataTransfer base64 方式
            let uploadFilePath = filePath
            const fileSize = statSync(filePath).size
            if (fileSize > 50 * 1024 * 1024) {
              // 压缩到 50MB 以下
              const { execFileSync } = await import('child_process')
              const compressedPath = '/tmp/compressed_' + Date.now() + '.mp4'
              try {
                execFileSync('ffmpeg', ['-err_detect', 'ignore_err', '-y', '-i', filePath,
                  '-c:v', 'libx264', '-crf', '28', '-preset', 'fast', '-vf', 'scale=-2:1920',
                  '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', compressedPath],
                  { stdio: 'pipe', timeout: 300000 })
                uploadFilePath = compressedPath
              } catch {}
            }
            const fileName = filePath.split(/[/\\]/).pop()
            const fileBuffer = readFileSync(uploadFilePath)
            const base64 = fileBuffer.toString('base64')
            await page.evaluate(async ({ b64, name }) => {
              const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
              const blob = new Blob([bytes], { type: 'video/mp4' })
              const file = new File([blob], name, { type: 'video/mp4' })
              const dt = new DataTransfer()
              dt.items.add(file)
              const input = document.querySelector('input#upload-files')
              if (input) {
                input.files = dt.files
                input.dispatchEvent(new Event('change', { bubbles: true }))
                input.dispatchEvent(new Event('input', { bubbles: true }))
              }
            }, { b64: base64, name: fileName })
            await page.waitForTimeout(3000)
            const tilesAfterDt = await page.evaluate(() => document.querySelectorAll('[class*="file-tile"]').length)
            if (tilesAfterDt > tilesBefore) uploaded = true
          }
        }
      }
    } catch {}

    // 方式2: + 按钮 → filechooser
    if (!uploaded) {
      const plusBtnSelectors = [
        'button[data-testid="composer-plus-btn"]',
        'button[aria-label*="Attach"]',
        'button[aria-label*="attach"]',
      ]
      for (const sel of plusBtnSelectors) {
        try {
          if (await page.locator(sel).count() > 0) {
            const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 30000 })
            await page.click(sel, { timeout: 10000 })
            await page.waitForTimeout(1000)
            // 匹配"添加照片和文件"菜单项
            const menuItem = page.locator('div[class*="__menu-item"]').filter({ hasText: '添加照片和文件' }).first()
            if (await menuItem.count() > 0) {
              await menuItem.click({ timeout: 5000 })
            }
            const fileChooser = await fileChooserPromise
            await fileChooser.setFiles(filePath)
            await page.waitForTimeout(3000)
            const attached = await page.evaluate(() => document.querySelectorAll('[class*="file-tile"]').length > 0)
            if (attached) { uploaded = true; break }
          }
        } catch {}
      }
    }

    // 等待文件上传完成 (file-tile spinner 消失, 最多 15 分钟)
    if (uploaded) {
      for (let wait = 0; wait < 900; wait++) {
        const loadingState = await page.evaluate(() => {
          const tiles = document.querySelectorAll('[class*="file-tile"]')
          for (const tile of tiles) {
            const btn = tile.querySelector('button')
            if (btn && btn.className.includes('cursor-wait')) return { loading: true }
            if (tile.className.includes('cursor-wait')) return { loading: true }
          }
          return { loading: false }
        })
        if (!loadingState.loading) break
        await page.waitForTimeout(1000)
      }
    }

    await this.dismissModal(page)
  },

  async sendPrompt(page, prompt, selectors) {
    const inputSel = selectors.input || '#prompt-textarea'
    await page.waitForSelector(inputSel, { timeout: 60000, state: 'visible' })
    await page.click(inputSel)
    await page.waitForTimeout(200)

    // 清空已有内容
    await page.keyboard.press('Control+a')
    await page.waitForTimeout(50)
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(100)

    // 方式1: insertText (ProseMirror contenteditable 兼容, 瞬间完成)
    let filled = false
    try {
      filled = await page.evaluate((content) => {
        const editor = document.querySelector('#prompt-textarea')
        if (!editor) return false
        editor.focus()
        const sel = window.getSelection()
        sel.selectAllChildren(editor)
        sel.deleteFromDocument()
        return document.execCommand('insertText', false, content)
      }, prompt)
    } catch {}

    // 方式2: page.fill
    if (!filled) {
      try {
        await page.click(inputSel)
        await page.waitForTimeout(100)
        await page.fill(inputSel, prompt)
        filled = true
      } catch {}
    }

    // 方式3: 剪贴板粘贴 (最后回退)
    if (!filled) {
      await page.click(inputSel)
      await page.keyboard.press('Control+a')
      await page.keyboard.press('Backspace')
      await page.waitForTimeout(100)
      await page.evaluate((t) => navigator.clipboard.writeText(t), prompt)
      await page.click(inputSel)
      await page.waitForTimeout(100)
      await page.keyboard.press('Control+v')
    }

    await page.waitForTimeout(500)

    // 轮询发送按钮 (最多等 10 分钟, 每秒检测 disabled/visible)
    const sendSelectors = selectors.sendButton
      ? selectors.sendButton.split(',').map(s => s.trim())
      : ['button[aria-label="发送提示"]', 'button[aria-label="Send"]', 'button[aria-label="发送"]', 'button[data-testid="send-button"]']

    let sent = false
    for (let attempt = 0; attempt < 600; attempt++) {
      const state = await page.evaluate(() => {
        // 先用 aria-label 匹配
        const selectors = ['button[aria-label="发送提示"]', 'button[aria-label="Send"]', 'button[aria-label="发送"]', 'button[data-testid="send-button"]']
        for (const sel of selectors) {
          const btn = document.querySelector(sel)
          if (btn) return { found: true, disabled: btn.disabled, visible: btn.offsetParent !== null }
        }
        // 再用 composer-submit-button class 匹配 (排除 stop-button)
        const submitBtns = document.querySelectorAll('button[class*="composer-submit-button"]')
        for (const btn of submitBtns) {
          if (btn.dataset.testid === 'stop-button') continue
          if (btn.offsetParent !== null) return { found: true, disabled: btn.disabled, visible: true }
        }
        return { found: false }
      })

      if (state.found && !state.disabled && state.visible) {
        // Playwright click
        let clickSel = null
        for (const sel of sendSelectors) {
          if (await page.locator(sel).count() > 0) { clickSel = sel; break }
        }
        if (!clickSel) {
          const classBtns = page.locator('button[class*="composer-submit-button"]').filter({ hasNot: page.locator('[data-testid="stop-button"]') })
          if (await classBtns.count() > 0) clickSel = 'button[class*="composer-submit-button"]'
        }
        if (clickSel) {
          try {
            await page.click(clickSel, { timeout: 5000, force: true })
            sent = true
            break
          } catch {
            // Playwright click 失败, 回退到 DOM click
            await page.evaluate(() => {
              const selectors = ['button[aria-label="发送提示"]', 'button[aria-label="Send"]', 'button[aria-label="发送"]', 'button[data-testid="send-button"]']
              for (const sel of selectors) {
                const btn = document.querySelector(sel)
                if (btn && !btn.disabled) { btn.click(); return }
              }
              const submitBtns = document.querySelectorAll('button[class*="composer-submit-button"]')
              for (const btn of submitBtns) {
                if (btn.dataset.testid === 'stop-button') continue
                if (btn.offsetParent !== null && !btn.disabled) { btn.click(); return }
              }
            })
            sent = true
            break
          }
        }
      } else if (state.found && state.disabled) {
        // 按钮存在但 disabled (文件可能还在上传)
        await page.waitForTimeout(1000)
      } else {
        // 按钮还没渲染
        await page.waitForTimeout(1000)
      }
    }

    // 后备: Ctrl+Enter → Enter
    if (!sent) {
      await page.click(inputSel)
      await page.waitForTimeout(100)
      await page.keyboard.press('Control+Enter')
      await page.waitForTimeout(500)
      const stillGenerating = await this.isStillGenerating(page).catch(() => false)
      if (!stillGenerating) {
        await page.keyboard.press('Enter')
      }
    }
  },

  // 获取最新 assistant 消息文本 (多选择器 fallback, 参考 feedaccount getLastAssistantText)
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
          const thinkingSelectors = [
            '[data-reasoning]',
            '[class*="thinking"]',
            '[class*="reasoning"]',
            '[data-testid="thinking"]',
            'div[class*="sr-only"]',
            'details summary',
            'button[class*="analyze"]',
            'div[class*="whitespace-pre"]',
            '[data-part="thinking"]',
            '[data-part="analysis"]',
          ]
          for (const ts of thinkingSelectors) {
            clone.querySelectorAll(ts).forEach(n => n.remove())
          }
          // 排除按钮文本
          clone.querySelectorAll('button').forEach(n => n.remove())
          let text = clone.textContent || ''
          text = text.trim()
          if (text) return text
          // 尝试找 markdown 容器
          const md = el.querySelector('div[class*="markdown"], .markdown')
          if (md) return (md.textContent || '').trim()
          return (el.textContent || '').trim()
        }
      }
      return ''
    })
  },

  // 检测 ChatGPT 是否还在生成 (参考 feedaccount isStillGenerating)
  async isStillGenerating(page) {
    return await page.evaluate(() => {
      const stopBtns = document.querySelectorAll('button[data-testid="stop-button"]')
      for (const btn of stopBtns) { if (btn.offsetParent !== null) return true }

      const submitBtn = document.querySelector('button[class*="composer-submit-button"]')
      if (submitBtn) {
        const aria = (submitBtn.getAttribute('aria-label') || '').toLowerCase()
        if (aria.includes('停止') || aria.includes('stop') || aria.includes('中断') || aria.includes('cancel')) return true
        if (aria.includes('发送') || aria.includes('send') || aria.includes('语音') || aria.includes('voice')) return false
      }

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

  // 等待回复稳定后一次性取全文 (对齐 feedaccount chatgptWaitForResponse)
  // opts: { timeout, pollInterval, stableCount, minResponseLength, expectJson }
  async waitForResponse(page, opts = {}) {
    const timeout = opts.timeout || 300000
    const pollInterval = opts.pollInterval || 2000
    const stableCount = opts.stableCount || 3
    const minResponseLength = opts.minResponseLength || 0
    const expectJson = opts.expectJson || false

    const preText = await this.getLastAssistantText(page)

    // 阶段1: 等待新回复开始
    const startTime = Date.now()
    let responseStarted = false
    while (Date.now() - startTime < 60000) {
      const currentText = await this.getLastAssistantText(page)
      if (currentText && currentText !== preText) { responseStarted = true; break }
      if (await this.isStillGenerating(page)) { responseStarted = true; break }
      await page.waitForTimeout(pollInterval)
    }

    // 阶段2: 轮询等待文本稳定
    let lastText = ''
    let stableIterations = 0

    while (Date.now() - startTime < timeout) {
      const currentText = await this.getLastAssistantText(page)
      const stillGenerating = await this.isStillGenerating(page)

      // 检测错误
      if (currentText && (currentText.includes('出了点问题') || currentText.includes('请重试') || currentText.includes('Something went wrong') || currentText.includes('try again'))) {
        return { ok: false, text: currentText, error: true, reason: 'chatgpt_error', duration: Date.now() - startTime }
      }

      // 文本稳定判断
      if (currentText === lastText) {
        if (!stillGenerating) {
          // 检查最小长度
          if (minResponseLength > 0 && currentText.length < minResponseLength) {
            // 响应过短, 继续等待
          } else if (expectJson && !currentText.includes('{')) {
            // 期望 JSON 但回复不含 { → 继续等
          } else {
            stableIterations++
            const requiredStable = (minResponseLength > 0 && (currentText.length < minResponseLength || (expectJson && !currentText.includes('{')))) ? 999 : (currentText.length < 100 ? 10 : stableCount)
            if (stableIterations >= requiredStable) {
              return { ok: true, text: currentText, duration: Date.now() - startTime }
            }
          }
        } else {
          stableIterations = 0
        }
      } else {
        stableIterations = 0
        lastText = currentText
      }

      await page.waitForTimeout(pollInterval)
    }

    // 超时, 返回部分文本
    return { ok: false, text: lastText, timeout: true, duration: Date.now() - startTime }
  },

  // 兼容旧接口: streamResponse → waitForResponse + onChunk
  async streamResponse(page, onChunk, selectors, signal) {
    const result = await this.waitForResponse(page, {
      timeout: 300000,
      pollInterval: parseInt(process.env.POLL_INTERVAL || '2000', 10),
      stableCount: 3,
      minResponseLength: 0,
      expectJson: false,
    })

    if (signal?.aborted) return

    if (result.ok && result.text) {
      onChunk(result.text)
    } else if (result.text) {
      // 超时但有部分文本
      onChunk(result.text)
    } else if (result.error) {
      throw new Error(`[CHATGPT_ERROR] ${result.text.slice(0, 200)}`)
    }

    // 检查限额
    if (selectors.rateLimitIndicators) {
      for (const keyword of selectors.rateLimitIndicators) {
        if (result.text.toLowerCase().includes(keyword.toLowerCase())) {
          throw new Error(`[RATE_LIMIT_EXCEEDED] ${result.text.slice(0, 100)}`)
        }
      }
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
