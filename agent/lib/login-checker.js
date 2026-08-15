import { getSelectors } from './selector-loader.js'

const CHECK_INTERVAL = 5 * 60 * 1000  // 5 分钟

let sessionTabs = {}  // vendor → Page
let onStatusChange = null
let checkInterval = null
let lastStatus = {}  // vendor → last known status

export function init(tabs, callback) {
  // 清理旧 interval
  if (checkInterval) clearInterval(checkInterval)
  sessionTabs = tabs
  onStatusChange = callback
  checkInterval = setInterval(checkAll, CHECK_INTERVAL)
  // 启动后 10s 检查一次
  setTimeout(checkAll, 10000)
}

async function checkAll() {
  for (const [vendor, page] of Object.entries(sessionTabs)) {
    try {
      const selectors = getSelectors(vendor)
      if (!selectors.loginCheck) continue

      const loggedIn = await page.locator(selectors.loginCheck.loggedIn).count()
      const loggedOut = selectors.loginCheck.loggedOut
        ? await page.locator(selectors.loginCheck.loggedOut).count()
        : 0

      let status
      if (loggedOut > 0) status = 'logged_out'
      else if (loggedIn > 0) status = 'logged_in'
      else status = 'unknown'

      // 只在状态变化时回调
      if (status !== lastStatus[vendor]) {
        lastStatus[vendor] = status
        if (onStatusChange) onStatusChange(vendor, status)
      }
    } catch (e) {
      // 页面可能正在导航，忽略
    }
  }
}

export async function checkLogin(vendor, page) {
  const selectors = getSelectors(vendor)
  if (!selectors.loginCheck) return 'unknown'

  try {
    const loggedIn = await page.locator(selectors.loginCheck.loggedIn).count()
    const loggedOut = selectors.loginCheck.loggedOut
      ? await page.locator(selectors.loginCheck.loggedOut).count()
      : 0

    if (loggedOut > 0) return 'logged_out'
    if (loggedIn > 0) return 'logged_in'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}
