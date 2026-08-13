import { getAllAgents, getAgent, getLoginStatusMatrix } from '../lib/agentPool.js'
import { getDashboardStats, getTrend } from '../lib/stats.js'
import { getVideoTaskList, getTaskHistory, getAuditLogs, addAuditLog } from '../lib/taskStore.js'
import { getFileList, cleanupFiles } from '../lib/fileStore.js'
import { getActiveAlerts, getAlertHistory } from '../lib/alerts.js'
import * as config from '../lib/config-loader.js'
import { backupSelectors, getSelectorHistory, getSelectorVersion, rollbackSelectors } from '../lib/config-history.js'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { parse as parseYaml } from 'yaml'

const CONFIG_DIR = process.env.CONFIG_DIR || join(process.cwd(), 'config')

export async function handleAdmin(req, res, path, method, body, ip) {
  // 路由分发
  if (path === '/admin' && method === 'GET') return serveAdminPage(res)
  if (path === '/admin/dashboard' && method === 'GET') return adminDashboard(res)
  if (path === '/admin/stats/trend' && method === 'GET') return adminStatsTrend(req, res)
  if (path === '/admin/agents' && method === 'GET') return adminAgents(res)
  if (path.startsWith('/admin/agents/') && method === 'POST' && path.endsWith('/restart')) return adminRestartAgent(res, path)
  if (path === '/admin/login-status' && method === 'GET') return adminLoginStatus(res)
  if (path.startsWith('/admin/login/') && method === 'POST') return adminLogin(req, res, path)
  if (path === '/admin/config/selectors/history' && method === 'GET') return adminSelectorHistory(res)
  if (path.startsWith('/admin/config/selectors/history/') && method === 'GET') return adminSelectorVersion(res, path)
  if (path.startsWith('/admin/config/selectors/rollback/') && method === 'POST') return adminSelectorRollback(res, path, ip)
  if (path.startsWith('/admin/config/') && method === 'GET') return adminGetConfig(res, path)
  if (path.startsWith('/admin/config/') && method === 'PUT') return adminPutConfig(res, path, body, ip)
  if (path === '/admin/tasks' && method === 'GET') return adminTasks(req, res)
  if (path === '/admin/video-tasks' && method === 'GET') return adminVideoTasks(req, res)
  if (path.startsWith('/admin/video-tasks/') && path.endsWith('/cancel') && method === 'POST') return adminVideoCancel(res, path, ip)
  if (path === '/admin/files' && method === 'GET') return adminFiles(res)
  if (path === '/admin/files/cleanup' && method === 'DELETE') return adminFilesCleanup(res, ip)
  if (path === '/admin/logs/gateway' && method === 'GET') return adminGatewayLogs(res)
  if (path.startsWith('/admin/logs/') && method === 'GET') return adminLogs(res, path)
  if (path === '/admin/debug/test' && method === 'POST') return adminDebugTest(res, body)
  if (path === '/admin/vendors' && method === 'GET') return adminVendors(res)
  if (path.startsWith('/admin/vendors/') && path.endsWith('/disable') && method === 'POST') return adminVendorToggle(res, path, false, ip)
  if (path.startsWith('/admin/vendors/') && path.endsWith('/enable') && method === 'POST') return adminVendorToggle(res, path, true, ip)
  if (path === '/admin/alerts' && method === 'GET') return adminAlerts(res)
  if (path === '/admin/alerts/history' && method === 'GET') return adminAlertHistory(res)
  if (path === '/admin/audit' && method === 'GET') return adminAudit(req, res)

  json(res, 404, { error: 'not found' })
}

function serveAdminPage(res) {
  try {
    const html = readFileSync(join(process.cwd(), 'public/admin.html'), 'utf-8')
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(html)
  } catch {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<h1>ai-web-gateway admin</h1><p>admin.html not found</p>')
  }
}

function adminDashboard(res) {
  const agents = getAllAgents()
  const stats = getDashboardStats()
  json(res, 200, {
    agents: { total: agents.length, online: agents.filter(a => a.isOnline).length, idle: agents.filter(a => a.canTakeSyncTask).length },
    stats,
    uptime: process.uptime(),
  })
}

function adminStatsTrend(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const vendor = url.searchParams.get('vendor') || 'chatgpt'
  const range = parseInt(url.searchParams.get('range') || '24', 10)
  json(res, 200, getTrend(vendor, range))
}

function adminAgents(res) {
  const agents = getAllAgents().map(a => ({
    agentId: a.agentId,
    status: a.status,
    isOnline: a.isOnline,
    vendors: a.vendors,
    activeTabs: a.activeTabs,
    videoPolling: a.videoPollingCount,
    taskCount: a.taskCount,
    lastSeen: a.lastSeen,
    currentTask: a.currentTask,
    resources: a.resources,
    loginStatus: a.loginStatus,
  }))
  json(res, 200, agents)
}

function adminRestartAgent(res, path) {
  const agentId = path.split('/')[3]
  const agent = getAgent(agentId)
  if (!agent) return json(res, 404, { error: 'agent not found' })
  agent.send({ type: 'restart' })
  json(res, 200, { ok: true, message: 'restart signal sent' })
}

function adminLoginStatus(res) {
  json(res, 200, getLoginStatusMatrix())
}

function adminLogin(req, res, path) {
  const parts = path.split('/')
  const agentId = parts[3]
  const vendor = parts[4]
  const agent = getAgent(agentId)
  if (!agent) return json(res, 404, { error: 'agent not found' })
  agent.send({ type: 'login_mode', vendor })
  json(res, 200, { ok: true, message: 'login mode activated', agentId, vendor })
}

function adminGetConfig(res, path) {
  const name = path.split('/').pop()
  const validFiles = ['models', 'vendors', 'selectors']
  if (!validFiles.includes(name)) return json(res, 400, { error: 'invalid config name' })
  try {
    const content = readFileSync(join(CONFIG_DIR, `${name}.yaml`), 'utf-8')
    json(res, 200, { name, content })
  } catch {
    json(res, 404, { error: 'config file not found' })
  }
}

function adminPutConfig(res, path, body, ip) {
  const name = path.split('/').pop()
  const validFiles = ['models', 'vendors', 'selectors']
  if (!validFiles.includes(name)) return json(res, 400, { error: 'invalid config name' })
  if (!body.content) return json(res, 400, { error: 'missing content' })

  // 先验证 YAML 格式，再写盘
  try {
    parseYaml(body.content)
  } catch (e) {
    return json(res, 400, { error: `YAML 解析失败: ${e.message}` })
  }

  if (name === 'selectors') backupSelectors()

  try {
    writeFileSync(join(CONFIG_DIR, `${name}.yaml`), body.content, 'utf-8')
    if (name === 'models') config.reloadAll()
    addAuditLog({ action: `修改配置 ${name}.yaml`, ip, ts: Date.now() })
    json(res, 200, { ok: true, message: name === 'vendors' ? '需重启 Agent 生效' : '已热加载' })
  } catch (e) {
    json(res, 500, { error: e.message })
  }
}

function adminSelectorHistory(res) {
  json(res, 200, getSelectorHistory())
}

function adminSelectorVersion(res, path) {
  const version = path.split('/').pop()
  const content = getSelectorVersion(version)
  if (!content) return json(res, 404, { error: 'version not found' })
  json(res, 200, { version, content })
}

function adminSelectorRollback(res, path, ip) {
  const version = path.split('/').pop()
  const ok = rollbackSelectors(version)
  if (!ok) return json(res, 404, { error: 'version not found' })
  addAuditLog({ action: `回滚选择器到 ${version}`, ip, ts: Date.now() })
  json(res, 200, { ok: true, message: '已回滚，Agent 60s 内热加载' })
}

async function adminTasks(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const page = parseInt(url.searchParams.get('page') || '1', 10)
  const pageSize = parseInt(url.searchParams.get('pageSize') || '20', 10)
  const tasks = await getTaskHistory(page, pageSize)
  json(res, 200, tasks)
}

async function adminVideoTasks(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const status = url.searchParams.get('status') || undefined
  const vendor = url.searchParams.get('vendor') || undefined
  const page = parseInt(url.searchParams.get('page') || '1', 10)
  const pageSize = parseInt(url.searchParams.get('pageSize') || '20', 10)
  const tasks = await getVideoTaskList({ status, vendor, page, pageSize })
  json(res, 200, tasks)
}

async function adminVideoCancel(res, path, ip) {
  const taskId = path.split('/')[3]
  const { getVideoTask, updateVideoTask } = await import('../lib/taskStore.js')
  const { clearVideoTimer } = await import('../lib/scheduler.js')
  const task = await getVideoTask(taskId)
  if (!task) return json(res, 404, { error: 'task not found' })
  if (task.status !== 'queued' && task.status !== 'generating') {
    return json(res, 400, { error: `cannot cancel task in ${task.status} state` })
  }
  clearVideoTimer(taskId)
  if (task.agentId) {
    const agent = getAgent(task.agentId)
    if (agent) agent.send({ type: 'video_cancel', taskId })
  }
  await updateVideoTask(taskId, { status: 'cancelled', updatedAt: Date.now() })
  addAuditLog({ action: `取消视频任务 ${taskId}`, ip, ts: Date.now() })
  json(res, 200, { ok: true, id: taskId, status: 'cancelled' })
}

function adminFiles(res) {
  json(res, 200, getFileList())
}

function adminFilesCleanup(res, ip) {
  const result = cleanupFiles()
  addAuditLog({ action: '清理过期文件', ip, ts: Date.now() })
  json(res, 200, result)
}

function adminLogs(res, path) {
  const agentId = path.split('/').pop()
  // TODO: 从内存缓存或 Agent 获取日志
  json(res, 200, { agentId, logs: '(日志功能待实现)' })
}

function adminGatewayLogs(res) {
  // 返回最近的 console 输出
  json(res, 200, { logs: '(Gateway 日志待实现)' })
}

async function adminDebugTest(res, body) {
  // 调试测试 — 走正常的调度流程
  const { handleChat } = await import('./chat.js')
  // 这里简化处理，实际应该调用 handleChat 并捕获响应
  json(res, 200, { ok: true, message: 'debug test endpoint - TODO' })
}

function adminVendors(res) {
  json(res, 200, config.getVendorStatus())
}

function adminVendorToggle(res, path, enable, ip) {
  const vendor = path.split('/')[3]
  if (enable) config.enableVendor(vendor)
  else config.disableVendor(vendor)
  addAuditLog({ action: `${enable ? '启用' : '禁用'}厂商 ${vendor}`, ip, ts: Date.now() })
  json(res, 200, { ok: true, vendor, enabled: enable })
}

function adminAlerts(res) {
  json(res, 200, getActiveAlerts())
}

function adminAlertHistory(res) {
  json(res, 200, getAlertHistory())
}

async function adminAudit(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const page = parseInt(url.searchParams.get('page') || '1', 10)
  const pageSize = parseInt(url.searchParams.get('pageSize') || '50', 10)
  const logs = await getAuditLogs(page, pageSize)
  json(res, 200, logs)
}

function json(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}
