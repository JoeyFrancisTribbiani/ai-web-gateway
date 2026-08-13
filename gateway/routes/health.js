import { getAllAgents } from '../lib/agentPool.js'
import { getDashboardStats } from '../lib/stats.js'
import { getVideoTaskList } from '../lib/taskStore.js'
import redis from '../lib/taskStore.js'
import { getFileList } from '../lib/fileStore.js'

export async function handleHealth(req, res) {
  const agents = getAllAgents()
  const onlineAgents = agents.filter(a => a.isOnline)
  const idleAgents = onlineAgents.filter(a => a.canTakeSyncTask)

  // 登录态汇总
  const loginSummary = {}
  for (const agent of onlineAgents) {
    for (const v of agent.vendors) {
      if (!loginSummary[v]) loginSummary[v] = 'ok'
      if (!agent.isVendorLoggedIn(v)) loginSummary[v] = 'degraded'
    }
  }

  const queueTasks = await getVideoTaskList({ status: 'queued' })
  const files = getFileList()

  const data = {
    gateway: 'ok',
    redis: redis.status === 'ready' ? 'ok' : 'error',
    agents: {
      total: agents.length,
      online: onlineAgents.length,
      idle: idleAgents.length,
      busy: onlineAgents.length - idleAgents.length,
    },
    loginSummary,
    videoQueue: queueTasks.length,
    fileStorage: { usedMB: files.totalSizeMB, fileCount: files.count },
    uptime: process.uptime(),
  }

  const body = JSON.stringify(data)
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}
