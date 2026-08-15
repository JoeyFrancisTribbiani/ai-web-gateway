import { getModel } from '../lib/config-loader.js'
import { scheduleSync, registerRequest, cancelRequest } from '../lib/scheduler.js'
import { formatImageResponse, formatError } from '../lib/openai-api.js'
import { recordRequest } from '../lib/stats.js'
import { addTaskHistory } from '../lib/taskStore.js'
import { randomBytes } from 'crypto'

const AGENT_TIMEOUT = parseInt(process.env.AGENT_TIMEOUT || '180000', 10)

export async function handleImages(req, res, body) {
  const model = body.model
  const prompt = body.prompt || ''
  const n = body.n || 1
  const size = body.size

  const modelInfo = getModel(model)
  if (!modelInfo) return json(res, 400, formatError(400, `model not found: ${model}`))
  if (modelInfo.taskType !== 'image') return json(res, 400, formatError(400, `model ${model} is not an image model`))

  const vendor = modelInfo.vendor
  const requestId = 'req-' + randomBytes(8).toString('hex')
  const startTime = Date.now()

  const params = { n }
  if (size) params.size = mapSize(size)

  let settled = false
  let resultUrls = null
  let errorMsg = null

  registerRequest(requestId, {
    onImageResult: (imageUrls) => { settled = true; resultUrls = imageUrls },
    onError: (code, message) => { settled = true; errorMsg = { code, message } },
    onTimeout: () => { settled = true; errorMsg = { code: 504, message: '请求超时' } },
  })

  let clientDisconnected = false
  req.on('close', () => {
    clientDisconnected = true
    cancelRequest(requestId)
  })

  const dispatchResult = await scheduleSync(requestId, { vendor, taskType: 'image', prompt, params })
  if (dispatchResult.error) {
    cancelRequest(requestId)
    if (!clientDisconnected) {
      return json(res, dispatchResult.error, formatError(dispatchResult.error, dispatchResult.message))
    }
    return
  }

  if (clientDisconnected) {
    cancelRequest(requestId)
    return
  }

  // 等待 Agent 回传

  await new Promise(resolve => {
    const check = setInterval(() => {
      if (settled || clientDisconnected) { clearInterval(check); resolve() }
    }, 100)
    setTimeout(() => { clearInterval(check); resolve() }, AGENT_TIMEOUT + 5000)
  })

  if (clientDisconnected) return

  // 只在未完成时取消（兜底超时场景，scheduler 已处理 done/error/timeout）
  if (!settled) cancelRequest(requestId)

  if (errorMsg) {
    json(res, errorMsg.code, formatError(errorMsg.code, errorMsg.message))
    recordRequest(vendor, false, Date.now() - startTime)
    addTaskHistory({ requestId, model, vendor, taskType: 'image', status: 'failed', error: errorMsg.message, latency: Date.now() - startTime, ts: Date.now() })
  } else if (resultUrls) {
    json(res, 200, formatImageResponse(resultUrls))
    const latency = Date.now() - startTime
    recordRequest(vendor, true, latency)
    addTaskHistory({ requestId, model, vendor, taskType: 'image', status: 'success', latency, ts: Date.now() })
  } else {
    json(res, 500, formatError(500, '无图片结果'))
    recordRequest(vendor, false, Date.now() - startTime)
  }
}

function mapSize(size) {
  const map = {
    '1024x1024': '1:1', '1024x1792': '9:16', '1792x1024': '16:9',
    '512x512': '1:1', '256x256': '1:1',
  }
  return map[size] || '1:1'
}

function json(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}
