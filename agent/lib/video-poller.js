import { getSelectors } from './selector-loader.js'
import { cleanupLocalFile } from './media-extractor.js'

const VIDEO_POLL_INTERVAL = parseInt(process.env.VIDEO_POLL_INTERVAL || '15000', 10)

// taskId → { page, adapter, vendor, timer }
const pollingTasks = new Map()

export function startPolling(taskId, page, adapter, vendor, onDone, onFailed, onProgress) {
  const selectors = getSelectors(vendor)
  const interval = selectors.pollInterval || VIDEO_POLL_INTERVAL
  const resultTimeout = selectors.resultTimeout || 30 * 60 * 1000  // 默认 30 分钟
  const startTime = Date.now()

  let timer = null
  let stopped = false
  let consecutiveErrors = 0

  const poll = async () => {
    if (stopped) return

    // 超时检查
    if (Date.now() - startTime > resultTimeout) {
      stopPolling(taskId)
      onFailed(taskId, '视频生成超时')
      return
    }

    try {
      const result = await adapter.pollStatus(page, selectors)

      if (stopped) return  // pollStatus 返回后再检查一次，防止与 stopAllPolling 竞态

      if (onProgress && result.progress !== undefined) {
        onProgress(taskId, result.progress)
      }

      if (result.status === 'completed') {
        try {
          const videoPath = await adapter.extractVideo(page, selectors)
          if (stopped) {
            if (videoPath) cleanupLocalFile(videoPath)  // 防止文件泄漏
            return
          }
          stopPolling(taskId)
          onDone(taskId, videoPath)
        } catch (e) {
          if (stopped) return
          stopPolling(taskId)
          onFailed(taskId, `视频提取失败: ${e.message}`)
        }
        return
      }

      if (result.status === 'failed') {
        stopPolling(taskId)
        onFailed(taskId, '视频生成失败')
        return
      }

      consecutiveErrors = 0  // 成功调用，重置错误计数
    } catch (e) {
      if (stopped) return  // catch 中也检查，防止 stopAllPolling 期间的错误触发 onFailed
      consecutiveErrors++
      console.error(`[video-poller] poll error for ${taskId} (${consecutiveErrors}):`, e.message)
      if (consecutiveErrors >= 3) {
        stopPolling(taskId)
        onFailed(taskId, `连续 ${consecutiveErrors} 次轮询失败: ${e.message}`)
        return
      }
    }

    // 递归 setTimeout，避免并发
    if (!stopped) {
      timer = setTimeout(poll, interval)
    }
  }

  timer = setTimeout(poll, interval)
  pollingTasks.set(taskId, { page, adapter, vendor, timer, stop: () => { stopped = true; if (timer) clearTimeout(timer) }, onFailed, taskId })
  console.log(`[video-poller] started for ${taskId}, interval=${interval}ms, timeout=${resultTimeout}ms`)
}

export function stopPolling(taskId) {
  const task = pollingTasks.get(taskId)
  if (!task) return
  if (task.stop) task.stop()
  else if (task.timer) clearTimeout(task.timer)
  try { Promise.resolve(task.page.close()).catch(() => {}) } catch {}
  pollingTasks.delete(taskId)
  console.log(`[video-poller] stopped for ${taskId}`)
}

export function getPollingCount() {
  return pollingTasks.size
}

export function stopAllPolling(notifyFailed = false, reason = 'Agent 重启') {
  for (const [taskId, task] of pollingTasks) {
    if (task.stop) task.stop()
    else if (task.timer) clearInterval(task.timer)
    if (notifyFailed && task.onFailed) {
      task.onFailed(taskId, reason)
    }
    try { Promise.resolve(task.page.close()).catch(() => {}) } catch {}
  }
  pollingTasks.clear()
  console.log(`[video-poller] all polling stopped (notifyFailed=${notifyFailed})`)
}
