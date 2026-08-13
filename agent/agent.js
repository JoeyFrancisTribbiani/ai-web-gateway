import { readFileSync } from 'fs'
import { join } from 'path'
import { parse as parseYaml } from 'yaml'
import { hostname } from 'os'
import { randomBytes } from 'crypto'

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
const AGENT_ID = process.env.AGENT_ID || `agent-${hostname()}-${randomBytes(2).toString('hex')}`
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
  await chrome.init(vendors, vendorUrls)

  // 4. 登录检测
  loginChecker.init(chrome.getAllSessionTabs(), (vendor, status) => {
    loginStatus[vendor] = status
    wsClient.send({ type: 'login_status', agentId: AGENT_ID, vendor, status })
    console.log(`[agent] login status: ${vendor} → ${status}`)
    // 登录成功后关闭 VNC
    if (status === 'logged_in') {
      vncManager.stopVnc()
      console.log('[agent] VNC stopped after successful login')
    }
  })

  // 5. WebSocket 连接
  wsClient.connect(handleMessage, async () => {
    // 重连成功后（WS 已连接）清理视频轮询并通知 Gateway
    videoPoller.stopAllPolling(true, 'Agent 重连')
    registered = false
    console.log('[agent] reconnected, video polling cleared, will re-register')
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
    case 'login_mode':
      return handleLoginMode(msg)
    case 'restart':
      return handleRestart()
    case 'cancel':
      if (currentAbortController) currentAbortController.abort()
      break  // currentTask 在 finally 块中清理，不在此处清除
    case 'video_cancel':
      videoPoller.stopPolling(msg.taskId)
      break
  }
}

// ===== 对话任务 =====
async function handleChatTask(msg) {
  const { requestId, prompt, vendor, inputFiles } = msg
  if (currentTask) {
    wsClient.send({ type: 'error', requestId, code: 503, message: 'agent busy' })
    return
  }
  const adapter = adapters[vendor]
  const page = chrome.getSessionTab(vendor)
  if (!adapter || !page) {
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
    // 下载请求文件
    if (inputFiles && inputFiles.length > 0) {
      for (const f of inputFiles) {
        const localPath = await downloadFile(f, 'input')
        localFiles.push(localPath)
      }
    }

    // 导航到新对话
    await adapter.navigate(page, selectors)

    // 上传文件
    if (localFiles.length > 0 && adapter.uploadFile) {
      for (const f of localFiles) {
        await adapter.uploadFile(page, f, selectors)
      }
    }

    // 发送 prompt
    await adapter.sendPrompt(page, prompt, selectors)

    // 流式获取回复
    await adapter.streamResponse(page, (delta) => {
      wsClient.send({ type: 'delta', requestId, text: delta })
    }, selectors, currentAbortController.signal)

    // 检查是否被 cancel
    if (!currentAbortController.signal.aborted) {
      wsClient.send({ type: 'done', requestId })
    } else {
      wsClient.send({ type: 'error', requestId, code: 499, message: 'cancelled' })
    }
  } catch (e) {
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
  if (currentTask) {
    wsClient.send({ type: 'error', requestId, code: 503, message: 'agent busy' })
    return
  }
  const adapter = adapters[vendor]
  const page = chrome.getSessionTab(vendor)
  if (!adapter || !page) {
    wsClient.send({ type: 'error', requestId, code: 500, message: `no adapter or page for ${vendor}` })
    return
  }

  currentTask = { requestId, vendor, model: 'image' }
  chrome.incrementTaskCount()
  chrome.setBusy(true)
  const selectors = getSelectors(vendor)

  try {
    await adapter.navigate(page, selectors)
    if (adapter.setParams && params) await adapter.setParams(page, params, selectors)
    await adapter.sendPrompt(page, prompt, selectors)

    const localPaths = await adapter.waitForImages(page, selectors)

    // 上传图片到 Gateway
    const imageUrls = []
    for (const p of localPaths) {
      const url = await uploadFile(p, 'img')
      imageUrls.push(url)
      cleanupLocalFile(p)
    }

    wsClient.send({ type: 'image_result', requestId, imageUrls })
  } catch (e) {
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
  const adapter = adapters[vendor]
  if (!adapter) {
    wsClient.send({ type: 'video_failed', taskId, error: `no adapter for ${vendor}` })
    return
  }

  // 开新标签页（在 try 内，异常能回报 Gateway）
  let page
  try {
    page = await chrome.newVideoTab()
  } catch (e) {
    wsClient.send({ type: 'video_failed', taskId, error: e.message })
    return
  }
  const selectors = getSelectors(vendor)

  try {
    // 提交生成
    await adapter.navigate(page, selectors)
    if (adapter.setParams && params) await adapter.setParams(page, params, selectors)
    await adapter.submitGeneration(page, prompt, selectors)

    // 确认提交成功
    wsClient.send({ type: 'video_submitted', requestId: taskId, taskId })

    // 开始后台轮询
    videoPoller.startPolling(taskId, page, adapter, vendor,
      // onDone
      async (taskId, videoPath) => {
        try {
          const videoUrl = await uploadFile(videoPath, 'video')
          wsClient.send({ type: 'video_done', taskId, videoUrl })
          cleanupLocalFile(videoPath)
        } catch (e) {
          wsClient.send({ type: 'video_failed', taskId, error: `视频上传失败: ${e.message}` })
        }
        try { await page.close() } catch {}
      },
      // onFailed
      (taskId, error) => {
        wsClient.send({ type: 'video_failed', taskId, error })
        try { Promise.resolve(page.close()).catch(() => {}) } catch {}
      },
      // onProgress
      (taskId, progress) => {
        wsClient.send({ type: 'video_progress', taskId, progress, status: 'generating' })
      }
    )
  } catch (e) {
    wsClient.send({ type: 'video_failed', taskId, error: e.message })
    try { await page.close() } catch {}
  }
}

// ===== 登录模式 =====
async function handleLoginMode(msg) {
  const { vendor } = msg
  vncManager.setVendor(vendor)

  // 开启 VNC (使用固定端口或动态分配)
  const vncPort = 5900 + (vendors.indexOf(vendor) % 10)
  vncManager.startVnc(DISPLAY.replace(':', ''), vncPort)

  wsClient.send({
    type: 'login_status',
    agentId: AGENT_ID,
    vendor,
    status: 'login_mode',
    vncPort,
  })
}

// ===== 重启 =====
async function handleRestart() {
  console.log('[agent] restart requested')
  // 中止当前同步任务
  if (currentAbortController) currentAbortController.abort()
  currentTask = null
  currentAbortController = null
  chrome.setBusy(false)
  videoPoller.stopAllPolling(true, 'Agent 重启')
  await chrome.restart()
  await chrome.reopenSessionTabs(vendors, vendorUrls)
  // 重新初始化登录检测（包含 VNC 停止逻辑）
  loginChecker.init(chrome.getAllSessionTabs(), (vendor, status) => {
    loginStatus[vendor] = status
    wsClient.send({ type: 'login_status', agentId: AGENT_ID, vendor, status })
    if (status === 'logged_in') {
      vncManager.stopVnc()
      console.log('[agent] VNC stopped after successful login')
    }
  })
}

// ===== 启动 =====
main().catch(err => {
  console.error('[agent] fatal error:', err)
  process.exit(1)
})
