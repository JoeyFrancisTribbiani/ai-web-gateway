import { chromium } from 'playwright'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { getPollingCount } from './video-poller.js'

let USER_DATA_DIR = ''
const MAX_TASKS_PER_CONTEXT = parseInt(process.env.MAX_TASKS_PER_CONTEXT || '5', 10)
const MAX_TABS = parseInt(process.env.MAX_TABS || '8', 10)
const DISPLAY = process.env.DISPLAY || ':99'
const HTTP_PROXY = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || ''

let context = null
let sessionTabs = {}   // vendor → Page
let taskCount = 0
let restarting = false
let isBusy = false  // 同步任务进行中标志
let savedVendors = []
let savedVendorUrls = {}

const DEFAULT_CHROME_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--mute-audio',
  '--window-size=1280,800',
  '--no-first-run',
  '--no-zygote',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-breakpad',
  '--disable-component-update',
  '--disable-extensions',
  '--disable-hang-monitor',
  '--disable-ipc-flooding-protection',
  '--disable-renderer-backgrounding',
  '--metrics-recording-only',
  '--password-store=basic',
  '--use-mock-keychain',
  '--force-color-profile=srgb',
]

let CHROME_ARGS = process.env.CHROME_ARGS
  ? (process.env.CHROME_ARGS.includes(',') && !process.env.CHROME_ARGS.includes(' ')
      ? process.env.CHROME_ARGS.split(',')
      : process.env.CHROME_ARGS.split(' ')
    ).map(s => s.trim()).filter(Boolean)
  : DEFAULT_CHROME_ARGS
if (CHROME_ARGS.length === 0) CHROME_ARGS = DEFAULT_CHROME_ARGS

export async function init(vendors, vendorUrls, agentId) {
  USER_DATA_DIR = process.env.USER_DATA_DIR || join('/data/chrome', agentId)
  if (!existsSync(USER_DATA_DIR)) mkdirSync(USER_DATA_DIR, { recursive: true })

  savedVendors = vendors
  savedVendorUrls = vendorUrls

  await launchChrome()

  // 为每个 vendor 开一个会话 tab
  for (const vendor of vendors) {
    const page = await context.newPage()
    await page.goto(vendorUrls[vendor] || 'about:blank', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})
    sessionTabs[vendor] = page
    console.log(`[chrome] session tab opened: ${vendor}`)
  }

  // 定时资源回收检查 (每 10 分钟)
  setInterval(maybeRestart, 10 * 60 * 1000)
}

async function launchChrome() {
  const launchOptions = {
    headless: false,
    args: CHROME_ARGS,
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 800 },
  }

  // 代理
  if (HTTP_PROXY) {
    launchOptions.proxy = { server: HTTP_PROXY }
    console.log(`[chrome] proxy: ${HTTP_PROXY}`)
  }

  // Xvfb 显示
  if (DISPLAY) {
    launchOptions.env = { ...process.env, DISPLAY }
  }

  context = await chromium.launchPersistentContext(USER_DATA_DIR, launchOptions)
  console.log(`[chrome] launched, user_data_dir=${USER_DATA_DIR}`)
}

export async function restart() {
  if (restarting) return
  restarting = true
  console.log('[chrome] restarting...')

  try {
    // 关闭所有页面
    for (const [vendor, page] of Object.entries(sessionTabs)) {
      try { await page.close() } catch {}
    }
    sessionTabs = {}

    // 关闭 context
    if (context) {
      await context.close()
      await new Promise(r => setTimeout(r, 2000))
    }

    // 重新启动
    await launchChrome()
    taskCount = 0
    console.log('[chrome] restarted successfully')
  } catch (e) {
    console.error('[chrome] restart failed:', e.message)
  }
  restarting = false
}

export function getSessionTab(vendor) {
  return sessionTabs[vendor] || null
}

export function getAllSessionTabs() {
  return sessionTabs
}

export async function newVideoTab() {
  const currentTabs = getActiveTabCount()
  if (currentTabs >= MAX_TABS) {
    throw new Error(`标签页已达上限 ${MAX_TABS}，无法开新视频标签页`)
  }
  return await context.newPage()
}

export function incrementTaskCount() {
  taskCount++
}

export function getTaskCount() {
  return taskCount
}

export function shouldRestart() {
  return taskCount >= MAX_TASKS_PER_CONTEXT
}

export function setBusy(busy) {
  isBusy = busy
}

async function maybeRestart() {
  if (!shouldRestart() || restarting) return
  if (isBusy) { console.log('[chrome] delaying restart: sync task in progress'); return }
  // 检查是否有视频轮询在进行
  const { getPollingCount } = await import('./video-poller.js')
  if (getPollingCount() > 0 && taskCount < MAX_TASKS_PER_CONTEXT * 10) {
    console.log('[chrome] delaying restart: video polling active')
    return
  }
  console.log(`[chrome] scheduled restart (taskCount=${taskCount})`)
  try {
    await restart()
    await reopenSessionTabs(savedVendors, savedVendorUrls)
  } catch (e) {
    console.error('[chrome] maybeRestart failed:', e.message)
  }
}

export async function reopenSessionTabs(vendors, vendorUrls) {
  for (const vendor of vendors) {
    if (sessionTabs[vendor]) continue
    const page = await context.newPage()
    await page.goto(vendorUrls[vendor] || 'about:blank', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})
    sessionTabs[vendor] = page
    console.log(`[chrome] session tab reopened: ${vendor}`)
  }
}

export function getActiveTabCount() {
  return Object.keys(sessionTabs).length + getPollingCount()
}

export async function close() {
  for (const [vendor, page] of Object.entries(sessionTabs)) {
    try { await page.close() } catch {}
  }
  if (context) await context.close()
}
