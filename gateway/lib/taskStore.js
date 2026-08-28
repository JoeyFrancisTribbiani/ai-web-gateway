import Redis from 'ioredis'

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379')

const TASK_PREFIX = 'video:task:'
const STATUS_PREFIX = 'video:status:'
const TTL = 24 * 60 * 60  // 24h

export async function saveVideoTask(taskId, data) {
  const key = TASK_PREFIX + taskId
  await redis.hset(key, {
    status: data.status || 'queued',
    model: data.model || '',
    prompt: data.prompt || '',
    params: JSON.stringify(data.params || {}),
    progress: 0,
    agentId: data.agentId || '',
    videoUrl: '',
    thumbnailUrl: '',
    result: '',
    error: '',
    createdAt: data.createdAt || Date.now(),
    updatedAt: Date.now(),
  })
  await redis.expire(key, TTL)

  // 状态索引
  const statusKey = STATUS_PREFIX + data.status
  await redis.sadd(statusKey, taskId)
  await redis.expire(statusKey, TTL)
}

export async function updateVideoTask(taskId, updates) {
  const key = TASK_PREFIX + taskId
  const oldData = await redis.hgetall(key)
  if (!oldData || !oldData.status) return null

  // 状态转换守卫：不允许从终态转为其他状态
  const terminalStates = ['completed', 'failed', 'cancelled']
  if (updates.status && oldData.status && terminalStates.includes(oldData.status) && oldData.status !== updates.status) {
    return null  // 当前已是终态，拒绝覆盖
  }

  // 状态变更时更新索引
  if (updates.status && updates.status !== oldData.status) {
    const oldStatusKey = STATUS_PREFIX + oldData.status
    await redis.srem(oldStatusKey, taskId)
    const newStatusKey = STATUS_PREFIX + updates.status
    await redis.sadd(newStatusKey, taskId)
    await redis.expire(newStatusKey, TTL)
  }

  const flatUpdates = {}
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined || v === null) continue
    flatUpdates[k] = typeof v === 'object' ? JSON.stringify(v) : String(v)
  }
  flatUpdates.updatedAt = String(Date.now())
  await redis.hset(key, flatUpdates)

  return { ...oldData, ...updates }
}

export async function getVideoTask(taskId) {
  const key = TASK_PREFIX + taskId
  const data = await redis.hgetall(key)
  if (!data || !data.status) return null
  return {
    id: taskId,
    status: data.status,
    model: data.model,
    prompt: data.prompt,
    params: safeJsonParse(data.params, {}),
    progress: parseInt(data.progress || '0', 10),
    agentId: data.agentId,
    videoUrl: data.videoUrl || undefined,
    thumbnailUrl: data.thumbnailUrl || undefined,
    result: data.result || undefined,
    json: data.json ? safeJsonParse(data.json, null) : undefined,
    error: data.error || undefined,
    createdAt: parseInt(data.createdAt || '0', 10),
    updatedAt: parseInt(data.updatedAt || '0', 10),
  }
}

export async function getGeneratingTasksByAgent(agentId) {
  const generatingKey = STATUS_PREFIX + 'generating'
  const taskIds = await redis.smembers(generatingKey)
  const result = []
  for (const taskId of taskIds) {
    const task = await getVideoTask(taskId)
    if (task && task.agentId === agentId) {
      result.push(taskId)
    }
  }
  return result
}

export async function getVideoTaskList({ status, vendor, page = 1, pageSize = 20 } = {}) {
  let taskIds = []
  if (status) {
    taskIds = await redis.smembers(STATUS_PREFIX + status)
  } else {
    // 扫描所有状态
    for (const s of ['queued', 'generating', 'completed', 'failed', 'cancelled']) {
      const ids = await redis.smembers(STATUS_PREFIX + s)
      taskIds = taskIds.concat(ids)
    }
  }

  const tasks = []
  for (const taskId of taskIds) {
    const task = await getVideoTask(taskId)
    if (!task) continue
    if (vendor && task.model !== vendor) continue
    tasks.push(task)
  }

  tasks.sort((a, b) => b.createdAt - a.createdAt)
  const start = (page - 1) * pageSize
  return tasks.slice(start, start + pageSize)
}

export async function cleanupOnStartup() {
  // Gateway 启动时，将所有 queued 和 generating 任务标记为 failed
  let count = 0
  for (const status of ['queued', 'generating']) {
    const taskIds = await redis.smembers(STATUS_PREFIX + status)
    for (const taskId of taskIds) {
      await updateVideoTask(taskId, { status: 'failed', error: 'Gateway重启' })
      count++
    }
  }
  if (count > 0) {
    console.log(`[taskStore] startup cleanup: ${count} tasks marked failed`)
  }
  return count
}

// ===== 同步任务历史 (Redis List, 最近 100 条, TTL 24h) =====
const TASK_HISTORY_KEY = 'task:history'
const TASK_HISTORY_MAX = 100

export async function addTaskHistory(record) {
  await redis.lpush(TASK_HISTORY_KEY, JSON.stringify(record))
  await redis.ltrim(TASK_HISTORY_KEY, 0, TASK_HISTORY_MAX - 1)
  await redis.expire(TASK_HISTORY_KEY, TTL)
}

export async function getTaskHistory(page = 1, pageSize = 20) {
  const start = (page - 1) * pageSize
  const end = start + pageSize - 1
  const items = await redis.lrange(TASK_HISTORY_KEY, start, end)
  return items.map(s => { try { return JSON.parse(s) } catch { return null } }).filter(Boolean)
}

// ===== 审计日志 (Redis List, TTL 7d) =====
const AUDIT_KEY = 'audit:log'
const AUDIT_MAX = 500

export async function addAuditLog(record) {
  await redis.lpush(AUDIT_KEY, JSON.stringify(record))
  await redis.ltrim(AUDIT_KEY, 0, AUDIT_MAX - 1)
  await redis.expire(AUDIT_KEY, 7 * 24 * 60 * 60)
}

export async function getAuditLogs(page = 1, pageSize = 50) {
  const start = (page - 1) * pageSize
  const end = start + pageSize - 1
  const items = await redis.lrange(AUDIT_KEY, start, end)
  return items.map(s => { try { return JSON.parse(s) } catch { return null } }).filter(Boolean)
}

export default redis

function safeJsonParse(str, fallback) {
  try { return JSON.parse(str) } catch { return fallback }
}
