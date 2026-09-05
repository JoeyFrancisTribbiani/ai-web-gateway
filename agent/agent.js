import { readFileSync } from 'fs'
import { join } from 'path'
import { parse as parseYaml } from 'yaml'
import { hostname } from 'os'

import * as wsClient from './lib/ws-client.js'
import * as chrome from './lib/chrome.js'
import { init as initSelectors, getSelectors } from './lib/selector-loader.js'
import * as videoPoller from './lib/video-poller.js'
import * as loginChecker from './lib/login-checker.js'
import * as vncManager from './lib/vnc-manager.js'
import { getChromeStats } from './lib/resource-monitor.js'
import { captureAndUpload } from './lib/error-screenshot.js'
import { uploadFile, downloadFile, cleanupLocalFile } from './lib/file-uploader.js'
import * as mediaExtractor from './lib/media-extractor.js'

// ===== 配置 =====
const AGENT_ID = process.env.AGENT_ID || hostname()
const VENDORS_ENV = process.env.VENDORS || 'all'
const CONFIG_DIR = process.env.CONFIG_DIR || '/app/config'
const MAX_TABS = parseInt(process.env.MAX_TABS || '8', 10)
const DISPLAY = process.env.DISPLAY || ':99'

// ===== 状态 =====
let vendors = []
let vendorUrls = {}
let adapters = {}
let loginStatus = {}

// ===== 初始化 =====
async function main() {
  console.log(`[agent] starting, AGENT_ID=${AGENT_ID}`)

  // 1. 加载 vendors.yaml
  const vendorsYaml = parseYaml(readFileSync(join(CONFIG_DIR, 'vendors.yaml'), 'utf-8'))
  const allVendors = vendorsYaml.vendors || {}

  // 确定要加载的厂商
  vendors = VENDORS_ENV === 'all'
    ? Object.keys(allVendors)
    : VENDORS_ENV.split(',').map(s => s.trim()).filter(Boolean)

  for (const v of vendors) {
    const info = allVendors[v]
    if (!info) { console.warn(`[agent] vendor not found in vendors.yaml: ${v}`); continue }
    vendorUrls[v] = info.url
    // 加载适配器
    try {
      const adapter = await import(`./adapters/${info.adapter}`)
      adapters[v] = adapter.default || adapter
      console.log(`[agent] adapter loaded: ${v} → ${info.adapter}`)
    } catch (e) {
      console.error(`[agent] failed to load adapter ${v}: ${e.message}`)
    }
  }

  // 2. 初始化选择器热加载
  initSelectors()

  // 3. Chrome 启动
  await chrome.init(vendors, vendorUrls, AGENT_ID)

  // 4. 登录检测
  loginChecker.init(chrome.getAllSessionTabs(), (vendor, status) => {
    loginStatus[vendor] = status
    // 登录成功时带 vncPort:null 通知 Gateway 清除 VNC 信息
    const extra = status === 'logged_in' ? { vncPort: null, vncHost: null } : {}
    wsClient.send({ type: 'login_status', agentId: AGENT_ID, vendor, status, ...extra })
    console.log(`[agent] login status: ${vendor} → ${status}`)
    if (status === 'logged_in') {
      vncManager.stopVnc()
      console.log('[agent] VNC stopped after successful login')
    }
  })

  // 5. WebSocket 连接
  wsClient.connect(handleMessage, async () => {
    // 重连成功后：先重新注册，再清理视频轮询
    // 顺序很重要：register 必须在 video_failed 之前发送，
    // 否则 Gateway 端 agentId 为 null，video_failed 消息会被丢弃
    registered = false
    heartbeat()  // 发送 register
    videoPoller.stopAllPolling(true, 'Agent 重连')
    console.log('[agent] reconnected, re-registered, video polling cleared')
  })

  // 6. 心跳
  setInterval(heartbeat, 10000)
  heartbeat()  // 立即发送一次

  console.log('[agent] started successfully')
}

// ===== 心跳 =====
function heartbeat() {
  if (!wsClient.isConnected()) return

  // 首次连接时发送 register
  if (!registered) {
    wsClient.send({ type: 'register', agentId: AGENT_ID, vendors, maxTabs: MAX_TABS })
    registered = true
    console.log(`[agent] registered: ${AGENT_ID} vendors=[${vendors.join(',')}]`)
  }

  const stats = getChromeStats()
  const activeTabs = chrome.getActiveTabCount()

  let status = 'idle'
  if (currentTask) status = 'busy'
  if (videoPoller.getPollingCount() > 0) status += '+polling'

  wsClient.send({
    type: 'heartbeat',
    agentId: AGENT_ID,
    status,
    activeTabs,
    videoPollingCount: videoPoller.getPollingCount(),
    loginStatus,
    resources: { ...stats, tabCount: activeTabs },
  })
}

// ===== 当前同步任务 =====
let currentTask = null
let currentAbortController = null
let registered = false

// ===== 消息处理 =====
async function handleMessage(msg) {
  switch (msg.type) {
    case 'chat_task':
      return handleChatTask(msg)
    case 'image_task':
      return handleImageTask(msg)
    case 'video_task':
      return handleVideoTask(msg)
    case 'analyze_task':
      return handleAnalyzeTask(msg)
    case 'login_mode':
      return handleLoginMode(msg)
    case 'restart':
      return handleRestart()
    case 'shutdown':
      return handleShutdown()
    case 'cancel':
      if (currentAbortController) currentAbortController.abort()
      break  // currentTask 在 finally 块中清理，不在此处清除
    case 'video_cancel':
      videoPoller.stopPolling(msg.taskId)
      break
    case 'analyze_cancel': {
      const ac = analyzeAborts.get(msg.taskId)
      if (ac) ac.abort()
      break
    }
  }
}

// ===== 对话任务 =====
async function handleChatTask(msg) {
  const { requestId, prompt, vendor, inputFiles } = msg
  console.log(`[chat] requestId=${requestId} vendor=${vendor} files=${inputFiles?.length || 0} prompt=${prompt?.slice(0, 80)}...`)
  if (currentTask) {
    console.log(`[chat] requestId=${requestId} rejected: agent busy (current=${currentTask.requestId})`)
    wsClient.send({ type: 'error', requestId, code: 503, message: 'agent busy' })
    return
  }
  const adapter = adapters[vendor]
  const page = chrome.getSessionTab(vendor)
  if (!adapter || !page) {
    console.log(`[chat] requestId=${requestId} failed: no adapter or page for ${vendor}`)
    wsClient.send({ type: 'error', requestId, code: 500, message: `no adapter or page for ${vendor}` })
    return
  }

  currentTask = { requestId, vendor, model: 'chat' }
  currentAbortController = new AbortController()
  chrome.incrementTaskCount()
  chrome.setBusy(true)
  const selectors = getSelectors(vendor)

  let localFiles = []
  try {
    if (inputFiles && inputFiles.length > 0) {
      for (const f of inputFiles) {
        console.log(`[chat] requestId=${requestId} downloading file: ${f.url?.slice(0, 60)}`)
        const localPath = await downloadFile(f, 'input')
        localFiles.push(localPath)
      }
    }

    console.log(`[chat] requestId=${requestId} navigating to ${vendor}`)
    await adapter.navigate(page, selectors)
    await adapter.dismissModal(page)

    if (localFiles.length > 0 && adapter.uploadFile) {
      for (const f of localFiles) {
        console.log(`[chat] requestId=${requestId} uploading file: ${f}`)
        await adapter.uploadFile(page, f, selectors)
        await adapter.dismissModal(page)
        console.log(`[chat] requestId=${requestId} file uploaded: ${f}`)
      }
      await page.waitForTimeout(3000)
      await adapter.dismissModal(page)
    }

    console.log(`[chat] requestId=${requestId} sending prompt (${prompt?.length || 0} chars)`)
    await adapter.sendPrompt(page, prompt, selectors)
    await adapter.dismissModal(page)
    console.log(`[chat] requestId=${requestId} prompt sent, waiting for response`)

    const responseStartTime = Date.now()
    const response = await adapter.waitForResponse(page, {
      timeout: 300000,
      pollInterval: parseInt(process.env.POLL_INTERVAL || '2000', 10),
      stableCount: 3,
    })
    const fullText = response.text || ''
    console.log(`[chat] requestId=${requestId} response ${response.ok ? 'complete' : 'timeout'}: ${fullText.length} chars, ${Date.now() - responseStartTime}ms`)

    if (!currentAbortController.signal.aborted) {
      if (response.error) {
        throw new Error(`[CHATGPT_ERROR] ${fullText.slice(0, 200)}`)
      }
      if (response.ok && fullText) {
        wsClient.send({ type: 'delta', requestId, text: fullText })
      }
      console.log(`[chat] requestId=${requestId} done`)
      wsClient.send({ type: 'done', requestId })
    } else {
      console.log(`[chat] requestId=${requestId} cancelled`)
      wsClient.send({ type: 'error', requestId, code: 499, message: 'cancelled' })
    }
  } catch (e) {
    console.log(`[chat] requestId=${requestId} error: ${e.message}`)
    const screenshotUrl = await captureAndUpload(page, requestId)
    const code = e.message.includes('RATE_LIMIT') || e.message.includes('限额') || e.message.includes('余额') ? 429 : 500
    wsClient.send({ type: 'error', requestId, code, message: e.message, screenshotUrl })
  } finally {
    currentTask = null
    currentAbortController = null
    chrome.setBusy(false)
    for (const f of localFiles) cleanupLocalFile(f)
    // 检查资源回收
    if (chrome.shouldRestart() && videoPoller.getPollingCount() === 0) {
      await chrome.restart()
      await chrome.reopenSessionTabs(vendors, vendorUrls)
    }
  }
}

// ===== 图片任务 =====
async function handleImageTask(msg) {
  const { requestId, prompt, params, vendor } = msg
  console.log(`[image] requestId=${requestId} vendor=${vendor} prompt=${prompt?.slice(0, 80)}...`)
  if (currentTask) {
    console.log(`[image] requestId=${requestId} rejected: agent busy`)
    wsClient.send({ type: 'error', requestId, code: 503, message: 'agent busy' })
    return
  }
  const adapter = adapters[vendor]
  const page = chrome.getSessionTab(vendor)
  if (!adapter || !page) {
    console.log(`[image] requestId=${requestId} failed: no adapter or page for ${vendor}`)
    wsClient.send({ type: 'error', requestId, code: 500, message: `no adapter or page for ${vendor}` })
    return
  }

  currentTask = { requestId, vendor, model: 'image' }
  chrome.incrementTaskCount()
  chrome.setBusy(true)
  const selectors = getSelectors(vendor)

  try {
    console.log(`[image] requestId=${requestId} navigating to ${vendor}`)
    await adapter.navigate(page, selectors)
    if (adapter.setParams && params) await adapter.setParams(page, params, selectors)
    console.log(`[image] requestId=${requestId} sending prompt`)
    await adapter.sendPrompt(page, prompt, selectors)
    console.log(`[image] requestId=${requestId} prompt sent, waiting for images`)

    const imageStartTime = Date.now()
    const localPaths = await adapter.waitForImages(page, selectors)
    console.log(`[image] requestId=${requestId} images generated: ${localPaths.length}, ${Date.now() - imageStartTime}ms`)

    // 上传图片到 Gateway
    const imageUrls = []
    for (const p of localPaths) {
      const url = await uploadFile(p, 'img')
      imageUrls.push(url)
      cleanupLocalFile(p)
    }
    console.log(`[image] requestId=${requestId} done, ${imageUrls.length} images uploaded`)
    wsClient.send({ type: 'image_result', requestId, imageUrls })
  } catch (e) {
    console.log(`[image] requestId=${requestId} error: ${e.message}`)
    const screenshotUrl = await captureAndUpload(page, requestId)
    const code = e.message.includes('RATE_LIMIT') || e.message.includes('余额') ? 429 : 500
    wsClient.send({ type: 'error', requestId, code, message: e.message, screenshotUrl })
  } finally {
    currentTask = null
    chrome.setBusy(false)
    if (chrome.shouldRestart() && videoPoller.getPollingCount() === 0) {
      await chrome.restart()
      await chrome.reopenSessionTabs(vendors, vendorUrls)
    }
  }
}

// ===== 视频任务 =====
async function handleVideoTask(msg) {
  const { taskId, prompt, params, vendor } = msg
  console.log(`[video] taskId=${taskId} vendor=${vendor} prompt=${prompt?.slice(0, 80)}...`)
  const adapter = adapters[vendor]
  if (!adapter) {
    console.log(`[video] taskId=${taskId} failed: no adapter for ${vendor}`)
    wsClient.send({ type: 'video_failed', taskId, error: `no adapter for ${vendor}` })
    return
  }

  let page
  try {
    page = await chrome.newVideoTab()
    console.log(`[video] taskId=${taskId} new tab opened`)
  } catch (e) {
    console.log(`[video] taskId=${taskId} tab open failed: ${e.message}`)
    wsClient.send({ type: 'video_failed', taskId, error: e.message })
    return
  }
  const selectors = getSelectors(vendor)

  try {
    console.log(`[video] taskId=${taskId} navigating to ${vendor}`)
    await adapter.navigate(page, selectors)
    if (adapter.setParams && params) await adapter.setParams(page, params, selectors)
    console.log(`[video] taskId=${taskId} submitting generation`)
    await adapter.submitGeneration(page, prompt, selectors)
    console.log(`[video] taskId=${taskId} submitted, starting background polling`)

    // 确认提交成功
    wsClient.send({ type: 'video_submitted', requestId: taskId, taskId })

    // 开始后台轮询
    videoPoller.startPolling(taskId, page, adapter, vendor,
      // onDone
      async (taskId, videoPath) => {
        try {
          console.log(`[video] taskId=${taskId} done, uploading video`)
          const videoUrl = await uploadFile(videoPath, 'video')
          console.log(`[video] taskId=${taskId} uploaded: ${videoUrl}`)
          wsClient.send({ type: 'video_done', taskId, videoUrl })
          cleanupLocalFile(videoPath)
        } catch (e) {
          console.log(`[video] taskId=${taskId} upload failed: ${e.message}`)
          wsClient.send({ type: 'video_failed', taskId, error: `视频上传失败: ${e.message}` })
        }
        try { await page.close() } catch {}
      },
      // onFailed
      (taskId, error) => {
        console.log(`[video] taskId=${taskId} failed: ${error}`)
        wsClient.send({ type: 'video_failed', taskId, error })
        try { Promise.resolve(page.close()).catch(() => {}) } catch {}
      },
      // onProgress
      (taskId, progress) => {
        wsClient.send({ type: 'video_progress', taskId, progress, status: 'generating' })
      }
    )
  } catch (e) {
    console.log(`[video] taskId=${taskId} error: ${e.message}`)
    wsClient.send({ type: 'video_failed', taskId, error: e.message })
    try { await page.close() } catch {}
  }
}

// 视频分析任务的 AbortController 映射（用于 analyze_cancel）
const analyzeAborts = new Map()

// ===== 视频分析任务 =====
// 复用 video 任务的 newVideoTab 异步模型（不占用同步 currentTask），
// 但执行 chat 逻辑：下载并上传视频 → 发送 prompt → 流式收集文本回复。
// 回复文本中提取 JSON（参考 feedaccount 分段脚本提取逻辑）。
function extractJsonFromText(text) {
  if (!text) return null
  let jsonStr = null
  // 1. markdown 代码块: ```json ... ```
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim()
  } else if (text.trim().startsWith('{')) {
    // 2. 整个回复就是 JSON
    jsonStr = text.trim()
  } else {
    // 3. 从文本中找第一个 { 到最后一个 }
    const firstBrace = text.indexOf('{')
    const lastBrace = text.lastIndexOf('}')
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      jsonStr = text.substring(firstBrace, lastBrace + 1)
    }
  }
  if (jsonStr) {
    try {
      return JSON.parse(jsonStr)
    } catch {
      return null
    }
  }
  return null
}

async function handleAnalyzeTask(msg) {
  const { taskId, prompt, vendor, inputFiles } = msg
  console.log(`[analyze] taskId=${taskId} vendor=${vendor} files=${inputFiles?.length || 0} prompt=${prompt?.slice(0, 80)}...`)
  const adapter = adapters[vendor]
  if (!adapter) {
    console.log(`[analyze] taskId=${taskId} failed: no adapter for ${vendor}`)
    wsClient.send({ type: 'analyze_failed', taskId, error: `no adapter for ${vendor}` })
    return
  }

  let page
  try {
    page = await chrome.newVideoTab()
    console.log(`[analyze] taskId=${taskId} new tab opened`)
  } catch (e) {
    console.log(`[analyze] taskId=${taskId} tab open failed: ${e.message}`)
    wsClient.send({ type: 'analyze_failed', taskId, error: e.message })
    return
  }
  const selectors = getSelectors(vendor)
  const abortController = new AbortController()
  analyzeAborts.set(taskId, abortController)

  let localFiles = []
  try {
    if (inputFiles && inputFiles.length > 0) {
      for (const f of inputFiles) {
        console.log(`[analyze] taskId=${taskId} downloading file: ${f.url?.slice(0, 60)}`)
        const localPath = await downloadFile(f, 'input')
        localFiles.push(localPath)
      }
      console.log(`[analyze] taskId=${taskId} ${localFiles.length} files downloaded`)
    }

    console.log(`[analyze] taskId=${taskId} navigating to ${vendor}`)
    await adapter.navigate(page, selectors)
    await adapter.dismissModal(page)

    if (localFiles.length > 0 && adapter.uploadFile) {
      for (const f of localFiles) {
        console.log(`[analyze] taskId=${taskId} uploading file: ${f}`)
        await adapter.uploadFile(page, f, selectors)
        await adapter.dismissModal(page)
        console.log(`[analyze] taskId=${taskId} file uploaded: ${f}`)
      }
      // 上传后等待 3s + 清理弹窗
      await page.waitForTimeout(3000)
      await adapter.dismissModal(page)
    }

    console.log(`[analyze] taskId=${taskId} sending prompt (${prompt?.length || 0} chars)`)
    await adapter.sendPrompt(page, prompt, selectors)
    console.log(`[analyze] taskId=${taskId} prompt sent, waiting for response`)

    const responseStartTime = Date.now()
    // 分析任务: 期望 JSON 回复, 最小长度 200, 稳定 5 次, 轮询 3s
    const response = await adapter.waitForResponse(page, {
      timeout: 1800000,  // 30 分钟 (视频分析可能很久)
      pollInterval: 3000,
      stableCount: 5,
      minResponseLength: 200,
      expectJson: true,
    })
    const fullText = response.text || ''
    console.log(`[analyze] taskId=${taskId} response ${response.ok ? 'complete' : 'timeout'}: ${fullText.length} chars, ${Date.now() - responseStartTime}ms`)

    if (!abortController.signal.aborted) {
      if (response.error) {
        throw new Error(`[CHATGPT_ERROR] ${fullText.slice(0, 200)}`)
      }
      // 提取 JSON (参考 feedaccount 分段脚本提取逻辑)
      const jsonData = extractJsonFromText(fullText)
      console.log(`[analyze] taskId=${taskId} done, json=${jsonData ? 'extracted' : 'null'}`)
      wsClient.send({ type: 'analyze_done', taskId, text: fullText, json: jsonData })
    } else {
      console.log(`[analyze] taskId=${taskId} cancelled`)
      wsClient.send({ type: 'analyze_failed', taskId, error: 'cancelled' })
    }
  } catch (e) {
    console.log(`[analyze] taskId=${taskId} error: ${e.message}`)
    try { await captureAndUpload(page, taskId) } catch {}
    wsClient.send({ type: 'analyze_failed', taskId, error: e.message })
  } finally {
    analyzeAborts.delete(taskId)
    for (const f of localFiles) cleanupLocalFile(f)
    try { await page.close() } catch {}
    if (chrome.shouldRestart() && videoPoller.getPollingCount() === 0) {
      await chrome.restart()
      await chrome.reopenSessionTabs(vendors, vendorUrls)
    }
  }
}

// ===== 登录模式 =====
async function handleLoginMode(msg) {
  const { vendor } = msg
  const isVncViewer = vendor === '__vnc_viewer__'
  if (!isVncViewer) vncManager.setVendor(vendor)

  // 开启 VNC (固定端口，同一时间只登录一个厂商)
  const vncPort = parseInt(process.env.VNC_PORT || '5900', 10)
  const ok = await vncManager.startVnc(DISPLAY.replace(':', ''), vncPort)

  wsClient.send({
    type: 'login_status',
    agentId: AGENT_ID,
    vendor,
    status: ok ? 'login_mode' : 'vnc_failed',
    vncPort: ok ? vncPort : null,
    vncHost: ok ? (process.env.VNC_HOST || AGENT_ID) : null,
    vncPassword: ok ? (process.env.VNC_PASSWORD || '') : null,
  })

  // 启动登录检测快速轮询 (VNC 期间每 10s 检查一次，检测到登录成功立即关 VNC)
  // VNC 查看模式不启动登录检测，用户只是看画面
  if (ok && !isVncViewer) startLoginWatch(vendor)
}

// VNC 登录期间的快速检测定时器
let loginWatchTimer = null

function startLoginWatch(vendor) {
  stopLoginWatch()
  loginWatchTimer = setInterval(async () => {
    const page = chrome.getSessionTab(vendor)
    if (!page) return
    const status = await loginChecker.checkLogin(vendor, page)
    if (status === 'logged_in') {
      stopLoginWatch()
      loginStatus[vendor] = 'logged_in'
      wsClient.send({ type: 'login_status', agentId: AGENT_ID, vendor, status: 'logged_in', vncPort: null, vncHost: null })
      vncManager.stopVnc()
      console.log(`[agent] login detected for ${vendor}, VNC stopped`)
    }
  }, 10000)
}

function stopLoginWatch() {
  if (loginWatchTimer) { clearInterval(loginWatchTimer); loginWatchTimer = null }
}

// ===== 重启 =====
async function handleRestart() {
  console.log('[agent] restart requested')
  // 中止当前同步任务
  if (currentAbortController) currentAbortController.abort()
  currentTask = null
  currentAbortController = null
  for (const ac of analyzeAborts.values()) ac.abort()
  chrome.setBusy(false)
  videoPoller.stopAllPolling(true, 'Agent 重启')
  await chrome.restart()
  await chrome.reopenSessionTabs(vendors, vendorUrls)
  // 重新初始化登录检测（包含 VNC 停止逻辑）
  loginChecker.init(chrome.getAllSessionTabs(), (vendor, status) => {
    loginStatus[vendor] = status
    const extra = status === 'logged_in' ? { vncPort: null, vncHost: null } : {}
    wsClient.send({ type: 'login_status', agentId: AGENT_ID, vendor, status, ...extra })
    if (status === 'logged_in') {
      vncManager.stopVnc()
      console.log('[agent] VNC stopped after successful login')
    }
  })
}

// ===== 优雅退出（被 Gateway 卸载）=====
async function handleShutdown() {
  console.log('[agent] shutdown requested')
  // 中止当前同步任务
  if (currentAbortController) currentAbortController.abort()
  currentTask = null
  currentAbortController = null
  for (const ac of analyzeAborts.values()) ac.abort()
  // 停止登录检测快速轮询
  stopLoginWatch()
  // 停止视频轮询（不通知 Gateway，Gateway 侧已自行标记 failed）
  videoPoller.stopAllPolling(false)
  // 停止 VNC
  vncManager.stopVnc()
  // 关闭 Chrome
  await chrome.close()
  console.log('[agent] shutdown complete, exiting')
  process.exit(0)
}

// ===== 启动 =====
main().catch(err => {
  console.error('[agent] fatal error:', err)
  process.exit(1)
})
