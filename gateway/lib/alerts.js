import { getAllAgents, getAgent } from './agentPool.js'
import { getErrorRate } from './stats.js'
import { getVideoTaskList } from './taskStore.js'

const WEBHOOK = process.env.ALERT_WEBHOOK || ''
const DEDUP_SECONDS = parseInt(process.env.ALERT_DEDUP_SECONDS || '300', 10)

// 活跃告警: key → { message, level, firstAt, lastAt }
const activeAlerts = new Map()
const alertHistory = []
const lastTriggerTime = new Map()  // key → timestamp (用于 DEDUP)

let checkTimer = null

export function startAlertEngine() {
  if (checkTimer) clearInterval(checkTimer)
  checkTimer = setInterval(() => {
    checkAlerts().catch(e => console.error('[alerts] check error:', e.message))
  }, 30 * 1000)
  checkAlerts().catch(e => console.error('[alerts] check error:', e.message))
}

async function checkAlerts() {
  // 1. Agent 离线检测
  for (const agent of getAllAgents()) {
    if (agent.status !== 'offline' && !agent.isOnline) {
      triggerAlert(`agent_offline:${agent.agentId}`, '严重', `Agent 离线: ${agent.agentId}`, {
        agentId: agent.agentId,
        lastSeen: new Date(agent.lastSeen).toISOString(),
        currentTask: agent.currentTask,
      })
    } else if (agent.isOnline) {
      resolveAlert(`agent_offline:${agent.agentId}`)
    }
  }

  // 2. 厂商登录态全部过期
  const vendors = new Set()
  for (const agent of getAllAgents()) {
    if (agent.isOnline) {
      for (const v of agent.vendors) vendors.add(v)
    }
  }
  for (const vendor of vendors) {
    const agents = getAllAgents().filter(a => a.isOnline && a.hasVendor(vendor))
    const allLoggedOut = agents.length > 0 && agents.every(a => !a.isVendorLoggedIn(vendor))
    if (allLoggedOut) {
      triggerAlert(`login_expired:${vendor}`, '严重', `厂商 ${vendor} 登录态全部过期`, { vendor })
    } else {
      resolveAlert(`login_expired:${vendor}`)
    }
  }

  // 3. 错误率检测
  for (const vendor of vendors) {
    const rate = getErrorRate(vendor)
    if (rate > 0.5) {
      triggerAlert(`error_rate:${vendor}`, '严重', `厂商 ${vendor} 5分钟内错误率 ${(rate * 100).toFixed(1)}%`, { vendor, rate })
    } else if (rate > 0.3) {
      triggerAlert(`error_rate:${vendor}`, '警告', `厂商 ${vendor} 5分钟内错误率 ${(rate * 100).toFixed(1)}%`, { vendor, rate })
    } else {
      resolveAlert(`error_rate:${vendor}`)
    }
  }

  // 4. Agent 内存检测
  for (const agent of getAllAgents()) {
    if (!agent.isOnline) continue
    const mem = agent.resources?.chromeMemoryMB || 0
    if (mem > 800) {
      triggerAlert(`memory:${agent.agentId}`, '警告', `Agent ${agent.agentId} Chrome 内存 ${mem}MB`, { agentId: agent.agentId, memoryMB: mem })
    } else {
      resolveAlert(`memory:${agent.agentId}`)
    }
  }

  // 5. 视频任务排队
  const queueTasks = await getVideoTaskList({ status: 'queued' })
  if (queueTasks.length > 5) {
    triggerAlert('video_queue', '警告', `视频任务排队 ${queueTasks.length} 个`, { count: queueTasks.length })
  } else {
    resolveAlert('video_queue')
  }
}

function triggerAlert(key, level, message, details) {
  const now = Date.now()

  // DEDUP: 检查距离上次触发是否超过 DEDUP_SECONDS
  const lastTrigger = lastTriggerTime.get(key)
  if (lastTrigger && (now - lastTrigger < DEDUP_SECONDS * 1000)) {
    return  // 在去重窗口内，不重复发送
  }

  const existing = activeAlerts.get(key)
  if (existing) {
    existing.lastAt = now
    return  // 已存在，不重复发送
  }

  lastTriggerTime.set(key, now)
  const alert = { key, level, message, details, firstAt: now, lastAt: now }
  activeAlerts.set(key, alert)
  alertHistory.push({ ...alert })
  if (alertHistory.length > 100) alertHistory.shift()

  console.log(`[alert] ${level} ${message}`)
  sendWebhook(alert)
}

function resolveAlert(key) {
  const alert = activeAlerts.get(key)
  if (!alert) return
  activeAlerts.delete(key)
  lastTriggerTime.delete(key)  // 清理 DEDUP 时间，允许恢复后重新触发
  console.log(`[alert] resolved: ${alert.message}`)
  sendWebhook({ ...alert, resolved: true, resolvedAt: Date.now() })
}

async function sendWebhook(alert) {
  if (!WEBHOOK) return
  try {
    const text = alert.resolved
      ? `[恢复] ${alert.message}`
      : `[${alert.level}] ${alert.message}`

    // 企业微信/钉钉通用格式
    const body = JSON.stringify({
      msgtype: 'text',
      text: { content: text },
    })

    await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
  } catch (e) {
    console.error(`[alert] webhook failed: ${e.message}`)
  }
}

export function getActiveAlerts() {
  return Array.from(activeAlerts.values())
}

export function getAlertHistory() {
  return alertHistory.slice(-100)
}
