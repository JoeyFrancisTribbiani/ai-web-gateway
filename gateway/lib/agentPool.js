import { WebSocket } from 'ws'

const HEARTBEAT_TIMEOUT = 30 * 1000  // 30s 无心跳 → offline

class AgentInfo {
  constructor(ws, data) {
    this.ws = ws
    this.agentId = data.agentId
    this.vendors = data.vendors || []
    this.status = 'idle'           // idle | busy | idle+polling | busy+polling | offline
    this.activeTabs = 0
    this.videoPollingCount = 0
    this.loginStatus = {}           // { chatgpt: "logged_in", ... }
    this.resources = {}             // { chromeMemoryMB, chromeCpuPercent, tabCount }
    this.lastSeen = Date.now()
    this.lastTaskAt = 0
    this.currentTask = null         // { requestId, vendor, model }
    this.maxTabs = data.maxTabs || 8
    this.taskCount = 0              // 资源回收计数
  }

  get canTakeSyncTask() {
    return (this.status === 'idle' || this.status === 'idle+polling')
  }

  get canTakeVideoTask() {
    if (this.status === 'offline') return false
    return this.activeTabs < this.maxTabs
  }

  get isOnline() {
    return this.status !== 'offline' && (Date.now() - this.lastSeen < HEARTBEAT_TIMEOUT)
  }

  hasVendor(vendor) {
    return this.vendors.includes(vendor)
  }

  isVendorLoggedIn(vendor) {
    return this.loginStatus[vendor] === 'logged_in'
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
      return true
    }
    return false
  }
}

const agents = new Map()       // agentId → AgentInfo
const vendorIndex = new Map()  // vendor → Set<agentId>

function reindexVendor(agent) {
  for (const v of agent.vendors) {
    if (!vendorIndex.has(v)) vendorIndex.set(v, new Set())
    vendorIndex.get(v).add(agent.agentId)
  }
}

function unindexVendor(agent) {
  for (const v of agent.vendors) {
    const set = vendorIndex.get(v)
    if (set) set.delete(agent.agentId)
  }
}

export function registerAgent(ws, data) {
  const agent = new AgentInfo(ws, data)
  const old = agents.get(agent.agentId)
  if (old) {
    unindexVendor(old)
    // 关闭旧 WebSocket 连接，防止 fd 泄漏
    try { old.ws.close(4001, 'replaced by new connection') } catch {}
  }
  agents.set(agent.agentId, agent)
  reindexVendor(agent)
  console.log(`[agentPool] registered: ${agent.agentId} vendors=[${agent.vendors.join(',')}]`)
  return agent
}

export function removeAgent(agentId) {
  const agent = agents.get(agentId)
  if (!agent) return
  unindexVendor(agent)
  agents.delete(agentId)
  console.log(`[agentPool] removed: ${agentId}`)
}

export function getAgent(agentId) {
  return agents.get(agentId)
}

export function getAllAgents() {
  return Array.from(agents.values())
}

export function getOnlineAgents() {
  return getAllAgents().filter(a => a.isOnline)
}

export function findSyncAgent(vendor) {
  const candidates = getAllAgents().filter(a =>
    a.isOnline &&
    a.hasVendor(vendor) &&
    a.canTakeSyncTask &&
    a.isVendorLoggedIn(vendor)
  )
  if (candidates.length === 0) return null
  // 选 lastTaskAt 最早的
  candidates.sort((a, b) => a.lastTaskAt - b.lastTaskAt)
  return candidates[0]
}

export function findVideoAgent(vendor) {
  const candidates = getAllAgents().filter(a =>
    a.isOnline &&
    a.hasVendor(vendor) &&
    a.canTakeVideoTask &&
    a.isVendorLoggedIn(vendor)
  )
  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.lastTaskAt - b.lastTaskAt)
  return candidates[0]
}

export function updateHeartbeat(agentId, data) {
  const agent = agents.get(agentId)
  if (!agent) return
  agent.lastSeen = Date.now()
  if (data.status) agent.status = data.status
  if (data.activeTabs !== undefined) agent.activeTabs = data.activeTabs
  if (data.videoPollingCount !== undefined) agent.videoPollingCount = data.videoPollingCount
  if (data.loginStatus) agent.loginStatus = { ...agent.loginStatus, ...data.loginStatus }
  if (data.resources) agent.resources = data.resources
}

export function setAgentBusy(agentId, task) {
  const agent = agents.get(agentId)
  if (!agent) return
  const wasPolling = agent.status.includes('polling')
  agent.status = wasPolling ? 'busy+polling' : 'busy'
  agent.lastTaskAt = Date.now()
  agent.currentTask = task
  agent.taskCount++
}

export function setAgentIdle(agentId) {
  const agent = agents.get(agentId)
  if (!agent) return
  const wasPolling = agent.status.includes('polling')
  agent.status = wasPolling ? 'idle+polling' : 'idle'
  agent.currentTask = null
}

export function markAgentOffline(agentId) {
  const agent = agents.get(agentId)
  if (!agent) return
  agent.status = 'offline'
  agent.currentTask = null
}

export function getLoginStatusMatrix() {
  const result = {}
  for (const [agentId, agent] of agents) {
    result[agentId] = {
      status: agent.status,
      isOnline: agent.isOnline,
      loginStatus: agent.loginStatus,
      vendors: agent.vendors,
    }
  }
  return result
}

export function checkHeartbeats() {
  const now = Date.now()
  const offline = []
  for (const [agentId, agent] of agents) {
    if (agent.status !== 'offline' && (now - agent.lastSeen > HEARTBEAT_TIMEOUT)) {
      agent.status = 'offline'
      agent.currentTask = null
      offline.push(agentId)
      console.log(`[agentPool] heartbeat timeout: ${agentId}`)
    }
  }
  return offline
}
