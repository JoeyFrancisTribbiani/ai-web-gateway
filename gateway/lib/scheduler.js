import { findSyncAgent, findVideoAgent, getAgent, setAgentBusy, setAgentIdle, markAgentOffline } from './agentPool.js'
import { isVendorDisabled } from './config-loader.js'
import { saveVideoTask, updateVideoTask, getVideoTask, getGeneratingTasksByAgent } from './taskStore.js'

const AGENT_TIMEOUT = parseInt(process.env.AGENT_TIMEOUT || '180000', 10)
const QUEUE_TIMEOUT = parseInt(process.env.QUEUE_TIMEOUT || '120000', 10)
const VIDEO_QUEUE_TIMEOUT = parseInt(process.env.VIDEO_QUEUE_TIMEOUT || '600000', 10)
const VIDEO_TIMEOUT = parseInt(process.env.VIDEO_TIMEOUT || '1800000', 10)

// requestId → { resolve, reject, onDelta, onDone, onImageResult, onError, onTimeout, timer, queueTimer, agentId, vendor, taskType }
const pendingRequests = new Map()

// vendor → Array<{ requestId, vendor, taskType, prompt, inputFiles, params, resolve, queueTimer }>
const syncQueues = new Map()

// video timeout timers: taskId → setTimeout
const videoTimers = new Map()

// ===== 同步任务调度 =====

export function registerRequest(requestId, callbacks) {
  pendingRequests.set(requestId, {
    ...callbacks,
    timer: null,
    queueTimer: null,
    agentId: null,
    vendor: null,
    taskType: null,
  })
}

export function cancelRequest(requestId) {
  const req = pendingRequests.get(requestId)
  if (!req) return

  // 清理 Agent 超时定时器
  if (req.timer) clearTimeout(req.timer)

  // 清理排队定时器
  if (req.queueTimer) clearTimeout(req.queueTimer)

  // 从同步队列中移除并 resolve（防止 Promise 悬挂）
  if (req.vendor) {
    const q = syncQueues.get(req.vendor)
    if (q) {
      const idx = q.findIndex(item => item.requestId === requestId)
      if (idx >= 0) {
        const [item] = q.splice(idx, 1)
        item.resolve({ error: 503, message: 'cancelled' })
      }
    }
  }

  // 通知 Agent 取消
  if (req.agentId) {
    const agent = getAgent(req.agentId)
    if (agent) agent.send({ type: 'cancel', requestId })
    setAgentIdle(req.agentId)
    // 唤醒排队
    wakeupSyncQueue(req.vendor)
  }

  pendingRequests.delete(requestId)
}

function startAgentTimeout(requestId) {
  const req = pendingRequests.get(requestId)
  if (!req) return
  if (req.timer) clearTimeout(req.timer)
  req.timer = setTimeout(() => {
    if (req.onTimeout) req.onTimeout()
    if (req.agentId) {
      const agent = getAgent(req.agentId)
      if (agent) agent.send({ type: 'cancel', requestId })
      setAgentIdle(req.agentId)
      wakeupSyncQueue(req.vendor)
    }
    pendingRequests.delete(requestId)
  }, AGENT_TIMEOUT)
}

export function scheduleSync(requestId, { vendor, taskType, prompt, inputFiles, params }) {
  if (isVendorDisabled(vendor)) {
    return Promise.resolve({ error: 503, message: `vendor ${vendor} is disabled` })
  }

  return new Promise((resolve) => {
    const dispatch = (agent) => {
      setAgentBusy(agent.agentId, { requestId, vendor, model: taskType })
      const req = pendingRequests.get(requestId)
      if (req) { req.agentId = agent.agentId; req.vendor = vendor; req.taskType = taskType }

      const taskMsg = taskType === 'image'
        ? { type: 'image_task', requestId, prompt, params: params || {}, vendor }
        : { type: 'chat_task', requestId, prompt, vendor, inputFiles: inputFiles || undefined }

      agent.send(taskMsg)
      startAgentTimeout(requestId)
    }

    // 立即尝试
    const agent = findSyncAgent(vendor)
    if (agent) {
      dispatch(agent)
      resolve({ ok: true })
      return
    }

    // 排队
    const queueTimer = setTimeout(() => {
      const q = syncQueues.get(vendor)
      if (q) {
        const idx = q.findIndex(i => i.requestId === requestId)
        if (idx >= 0) q.splice(idx, 1)
      }
      const req = pendingRequests.get(requestId)
      if (req && req.timer) clearTimeout(req.timer)
      pendingRequests.delete(requestId)
      resolve({ error: 503, message: 'queue timeout' })
    }, QUEUE_TIMEOUT)

    if (!syncQueues.has(vendor)) syncQueues.set(vendor, [])
    syncQueues.get(vendor).push({ requestId, vendor, taskType, prompt, inputFiles, params, resolve, queueTimer })

    const req = pendingRequests.get(requestId)
    if (req) { req.queueTimer = queueTimer; req.vendor = vendor }
  })
}

export function wakeupSyncQueue(vendor) {
  if (!vendor) return
  const q = syncQueues.get(vendor)
  if (!q || q.length === 0) return

  while (q.length > 0) {
    const agent = findSyncAgent(vendor)
    if (!agent) break

    const item = q.shift()
    clearTimeout(item.queueTimer)

    setAgentBusy(agent.agentId, { requestId: item.requestId, vendor, model: item.taskType })
    const req = pendingRequests.get(item.requestId)
    if (req) { req.agentId = agent.agentId; req.vendor = item.vendor; req.taskType = item.taskType }

    const taskMsg = item.taskType === 'image'
      ? { type: 'image_task', requestId: item.requestId, prompt: item.prompt, params: item.params || {}, vendor: item.vendor }
      : { type: 'chat_task', requestId: item.requestId, prompt: item.prompt, vendor: item.vendor, inputFiles: item.inputFiles || undefined }

    agent.send(taskMsg)
    startAgentTimeout(item.requestId)
    item.resolve({ ok: true })
  }
}

// ===== 视频任务调度 =====

export async function scheduleVideo(taskId, { vendor, prompt, params }) {
  if (isVendorDisabled(vendor)) {
    return { error: 503, message: `vendor ${vendor} is disabled` }
  }

  await saveVideoTask(taskId, { status: 'queued', model: vendor, prompt, params, createdAt: Date.now() })

  const agent = findVideoAgent(vendor)
  if (!agent) {
    // 留在 Redis 队列，设置排队超时
    const queueTimer = setTimeout(async () => {
      const task = await getVideoTask(taskId)
      if (task && task.status === 'queued') {
        await updateVideoTask(taskId, { status: 'failed', error: '排队超时', updatedAt: Date.now() })
      }
      videoTimers.delete(taskId + ':queue')
    }, VIDEO_QUEUE_TIMEOUT)
    videoTimers.set(taskId + ':queue', queueTimer)
    return { ok: false, queued: true }
  }

  // 推送视频任务
  // 临时递增 activeTabs 防止并发调度超过 MAX_TABS
  agent.activeTabs++
  if (!agent.send({ type: 'video_task', taskId, prompt, params: params || {}, vendor })) {
    agent.activeTabs--  // send 失败回滚
    // 任务留在 queued，等下次 wakeup
    const queueTimer = setTimeout(async () => {
      const task = await getVideoTask(taskId)
      if (task && task.status === 'queued') {
        await updateVideoTask(taskId, { status: 'failed', error: '排队超时', updatedAt: Date.now() })
      }
      videoTimers.delete(taskId + ':queue')
    }, VIDEO_QUEUE_TIMEOUT)
    videoTimers.set(taskId + ':queue', queueTimer)
    return { ok: false, queued: true }
  }
  await updateVideoTask(taskId, { status: 'generating', agentId: agent.agentId, updatedAt: Date.now() })

  // 设置视频生成超时
  const timer = setTimeout(async () => {
    const task = await getVideoTask(taskId)
    if (task && (task.status === 'generating' || task.status === 'queued')) {
      await updateVideoTask(taskId, { status: 'failed', error: '视频生成超时', updatedAt: Date.now() })
      const a = getAgent(agent.agentId)
      if (a) a.send({ type: 'video_cancel', taskId })
    }
    videoTimers.delete(taskId)
  }, VIDEO_TIMEOUT)
  videoTimers.set(taskId, timer)

  return { ok: true }
}

// ===== 视频分析任务调度 =====
// 复用 video 任务的 Redis 存储与 tab 容量调度，但让 Agent 执行
// "上传视频 + prompt → 等待 ChatGPT 文本回复" 而非视频生成。
export async function scheduleAnalyze(taskId, { vendor, prompt, inputFiles }) {
  if (isVendorDisabled(vendor)) {
    return { error: 503, message: `vendor ${vendor} is disabled` }
  }

  await saveVideoTask(taskId, { status: 'queued', model: vendor, prompt, params: { type: 'analyze', inputFiles: inputFiles || [] }, createdAt: Date.now() })

  const agent = findVideoAgent(vendor)
  if (!agent) {
    const queueTimer = setTimeout(async () => {
      const task = await getVideoTask(taskId)
      if (task && task.status === 'queued') {
        await updateVideoTask(taskId, { status: 'failed', error: '排队超时', updatedAt: Date.now() })
      }
      videoTimers.delete(taskId + ':queue')
    }, VIDEO_QUEUE_TIMEOUT)
    videoTimers.set(taskId + ':queue', queueTimer)
    return { ok: false, queued: true }
  }

  agent.activeTabs++
  if (!agent.send({ type: 'analyze_task', taskId, prompt, inputFiles: inputFiles || [], vendor })) {
    agent.activeTabs--
    const queueTimer = setTimeout(async () => {
      const task = await getVideoTask(taskId)
      if (task && task.status === 'queued') {
        await updateVideoTask(taskId, { status: 'failed', error: '排队超时', updatedAt: Date.now() })
      }
      videoTimers.delete(taskId + ':queue')
    }, VIDEO_QUEUE_TIMEOUT)
    videoTimers.set(taskId + ':queue', queueTimer)
    return { ok: false, queued: true }
  }
  await updateVideoTask(taskId, { status: 'generating', agentId: agent.agentId, updatedAt: Date.now() })

  const timer = setTimeout(async () => {
    const task = await getVideoTask(taskId)
    if (task && (task.status === 'generating' || task.status === 'queued')) {
      await updateVideoTask(taskId, { status: 'failed', error: '视频分析超时', updatedAt: Date.now() })
      const a = getAgent(agent.agentId)
      if (a) a.send({ type: 'analyze_cancel', taskId })
    }
    videoTimers.delete(taskId)
  }, VIDEO_TIMEOUT)
  videoTimers.set(taskId, timer)

  return { ok: true }
}

// 视频排队唤醒 — Agent 完成任务后检查 Redis 队列
// video wakeup 锁：防止同一 vendor 的并发 wakeup 重复领取任务
const wakeupLocks = new Set()

export async function wakeupVideoQueue(vendor) {
  if (!vendor || wakeupLocks.has(vendor)) return
  wakeupLocks.add(vendor)
  try {
    const queuedTasks = await getVideoTaskList({ status: 'queued', vendor, page: 1, pageSize: 10 })
    for (const task of queuedTasks) {
      if (task.params && task.params.type === 'analyze') continue
      const agent = findVideoAgent(vendor)
      if (!agent) break

      agent.activeTabs++
      if (!agent.send({ type: 'video_task', taskId: task.id, prompt: task.prompt, params: task.params || {}, vendor })) {
        agent.activeTabs--  // send 失败，回滚
        break
      }
      await updateVideoTask(task.id, { status: 'generating', agentId: agent.agentId, updatedAt: Date.now() })

      const timer = setTimeout(async () => {
        const t = await getVideoTask(task.id)
        if (t && (t.status === 'generating' || t.status === 'queued')) {
          await updateVideoTask(task.id, { status: 'failed', error: '视频生成超时', updatedAt: Date.now() })
          const a = getAgent(agent.agentId)
          if (a) a.send({ type: 'video_cancel', taskId: task.id })
        }
        videoTimers.delete(task.id)
      }, VIDEO_TIMEOUT)
      videoTimers.set(task.id, timer)

      const qTimer = videoTimers.get(task.id + ':queue')
      if (qTimer) { clearTimeout(qTimer); videoTimers.delete(task.id + ':queue') }
    }
  } finally {
    wakeupLocks.delete(vendor)
  }
}

// 视频分析排队唤醒（独立锁，不与 video 互阻）
const analyzeWakeupLocks = new Set()

export async function wakeupAnalyzeQueue(vendor) {
  if (!vendor || analyzeWakeupLocks.has(vendor)) return
  analyzeWakeupLocks.add(vendor)
  try {
    const queuedTasks = await getVideoTaskList({ status: 'queued', vendor, page: 1, pageSize: 10 })
    for (const task of queuedTasks) {
      if (!task.params || task.params.type !== 'analyze') continue
      const agent = findVideoAgent(vendor)
      if (!agent) break

      agent.activeTabs++
      if (!agent.send({ type: 'analyze_task', taskId: task.id, prompt: task.prompt, inputFiles: task.params.inputFiles || [], vendor })) {
        agent.activeTabs--
        break
      }
      await updateVideoTask(task.id, { status: 'generating', agentId: agent.agentId, updatedAt: Date.now() })

      const timer = setTimeout(async () => {
        const t = await getVideoTask(task.id)
        if (t && (t.status === 'generating' || t.status === 'queued')) {
          await updateVideoTask(task.id, { status: 'failed', error: '视频分析超时', updatedAt: Date.now() })
          const a = getAgent(agent.agentId)
          if (a) a.send({ type: 'analyze_cancel', taskId: task.id })
        }
        videoTimers.delete(task.id)
      }, VIDEO_TIMEOUT)
      videoTimers.set(task.id, timer)

      const qTimer = videoTimers.get(task.id + ':queue')
      if (qTimer) { clearTimeout(qTimer); videoTimers.delete(task.id + ':queue') }
    }
  } finally {
    analyzeWakeupLocks.delete(vendor)
  }
}

export function clearVideoTimer(taskId) {
  const t1 = videoTimers.get(taskId)
  if (t1) { clearTimeout(t1); videoTimers.delete(taskId) }
  const t2 = videoTimers.get(taskId + ':queue')
  if (t2) { clearTimeout(t2); videoTimers.delete(taskId + ':queue') }
}

// ===== Agent 消息路由 =====

export function handleAgentMessage(agentId, msg) {
  switch (msg.type) {
    case 'delta': {
      const req = pendingRequests.get(msg.requestId)
      if (req && req.onDelta) req.onDelta(msg.text)
      break
    }
    case 'done': {
      const req = pendingRequests.get(msg.requestId)
      if (req) {
        if (req.timer) clearTimeout(req.timer)
        if (req.onDone) req.onDone()
        if (req.agentId) {
          setAgentIdle(req.agentId)
          wakeupSyncQueue(req.vendor)
          wakeupVideoQueue(req.vendor).catch(() => {})
        }
        pendingRequests.delete(msg.requestId)
      }
      break
    }
    case 'image_result': {
      const req = pendingRequests.get(msg.requestId)
      if (req) {
        if (req.timer) clearTimeout(req.timer)
        if (req.onImageResult) req.onImageResult(msg.imageUrls)
        if (req.agentId) {
          setAgentIdle(req.agentId)
          wakeupSyncQueue(req.vendor)
          wakeupVideoQueue(req.vendor).catch(() => {})
        }
        pendingRequests.delete(msg.requestId)
      }
      break
    }
    case 'error': {
      const req = pendingRequests.get(msg.requestId)
      if (req) {
        if (req.timer) clearTimeout(req.timer)
        if (req.onError) req.onError(msg.code, msg.message, msg.screenshotUrl)
        if (req.agentId) {
          setAgentIdle(req.agentId)
          wakeupSyncQueue(req.vendor)
          wakeupVideoQueue(req.vendor).catch(() => {})
        }
        pendingRequests.delete(msg.requestId)
      }
      break
    }
    case 'video_submitted': {
      console.log(`[video] taskId=${msg.taskId} submitted by agent`)
      break
    }
    case 'video_progress': {
      updateVideoTask(msg.taskId, { progress: msg.progress, status: 'generating', updatedAt: Date.now() }).catch(() => {})
      break
    }
    case 'video_done': {
      console.log(`[video] taskId=${msg.taskId} done, videoUrl=${msg.videoUrl?.slice(0, 80)}`)
      clearVideoTimer(msg.taskId)
      getVideoTask(msg.taskId).then(async task => {
        if (!task || task.status === 'cancelled') return
        // 即使 task 被断线标记为 failed，也允许 Agent 重发的结果覆盖
        await updateVideoTask(msg.taskId, { status: 'completed', videoUrl: msg.videoUrl, updatedAt: Date.now() })
        console.log(`[video] taskId=${msg.taskId} result saved (was ${task.status})`)
        if (task.model) {
          await wakeupVideoQueue(task.model)
          wakeupAnalyzeQueue(task.model).catch(() => {})
        }
      }).catch(() => {})
      break
    }
    case 'video_failed': {
      console.log(`[video] taskId=${msg.taskId} failed: ${msg.error}`)
      clearVideoTimer(msg.taskId)
      getVideoTask(msg.taskId).then(async task => {
        if (!task || task.status === 'cancelled' || task.status === 'completed' || task.status === 'failed') return
        await updateVideoTask(msg.taskId, { status: 'failed', error: msg.error, updatedAt: Date.now() })
        if (task.model) {
          await wakeupVideoQueue(task.model)
          wakeupAnalyzeQueue(task.model).catch(() => {})
        }
      }).catch(() => {})
      break
    }
    case 'analyze_progress': {
      updateVideoTask(msg.taskId, { progress: msg.progress, status: 'generating', updatedAt: Date.now() }).catch(() => {})
      break
    }
    case 'analyze_done': {
      console.log(`[analyze] taskId=${msg.taskId} done, text=${msg.text?.length || 0} chars, json=${msg.json ? 'yes' : 'no'}`)
      clearVideoTimer(msg.taskId)
      getVideoTask(msg.taskId).then(async task => {
        if (!task || task.status === 'cancelled') return
        // 即使 task 被断线标记为 failed，也允许 Agent 重发的结果覆盖
        await updateVideoTask(msg.taskId, { status: 'completed', result: msg.text, json: msg.json, updatedAt: Date.now() })
        console.log(`[analyze] taskId=${msg.taskId} result saved (was ${task.status})`)
        if (task.model) {
          await wakeupAnalyzeQueue(task.model)
          wakeupVideoQueue(task.model).catch(() => {})
        }
      }).catch(() => {})
      break
    }
    case 'analyze_failed': {
      console.log(`[analyze] taskId=${msg.taskId} failed: ${msg.error}`)
      clearVideoTimer(msg.taskId)
      getVideoTask(msg.taskId).then(async task => {
        if (!task || task.status === 'cancelled' || task.status === 'completed' || task.status === 'failed') return
        await updateVideoTask(msg.taskId, { status: 'failed', error: msg.error, updatedAt: Date.now() })
        if (task.model) {
          await wakeupAnalyzeQueue(task.model)
          wakeupVideoQueue(task.model).catch(() => {})
        }
      }).catch(() => {})
      break
    }
  }
}

export async function handleAgentDisconnect(agentId) {
  markAgentOffline(agentId)

  // 获取 agent 的 vendor 列表（用于唤醒排队）
  const agent = getAgent(agentId)
  const vendors = agent ? [...agent.vendors] : []

  // 取消该 Agent 正在处理的同步请求
  for (const [requestId, req] of pendingRequests) {
    if (req.agentId === agentId) {
      if (req.timer) clearTimeout(req.timer)
      if (req.onError) req.onError(502, 'Agent 离线')
      pendingRequests.delete(requestId)
    }
  }

  // 标记该 Agent 名下所有 generating 视频任务为 failed
  const tasks = await getGeneratingTasksByAgent(agentId)

  // 检查 agent 是否在 await 期间重连
  const agentAfter = getAgent(agentId)
  if (agentAfter && agentAfter.status !== 'offline') {
    console.log(`[scheduler] agent ${agentId} reconnected during disconnect cleanup, skipping task failure`)
    return
  }

  for (const taskId of tasks) {
    clearVideoTimer(taskId)
    await updateVideoTask(taskId, { status: 'failed', error: 'Agent离线', updatedAt: Date.now() })
  }

  // 唤醒排队中的任务（同 vendor 可能有其他在线 agent）
  for (const v of vendors) {
    wakeupSyncQueue(v)
    wakeupVideoQueue(v).catch(() => {})
    wakeupAnalyzeQueue(v).catch(() => {})
  }
}

export { getVideoTask }
