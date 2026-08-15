import { getModel } from '../lib/config-loader.js'
import { buildPrompt, extractImageUrls } from '../lib/message-builder.js'
import { processRequestFiles, deleteFile } from '../lib/request-files.js'
import { scheduleSync, registerRequest, cancelRequest } from '../lib/scheduler.js'
import { formatChatCompletion, formatChatCompletionChunk, formatChatCompletionDone, formatError, formatSSE, formatSSEDone, formatSSEComment } from '../lib/openai-api.js'
import { recordRequest } from '../lib/stats.js'
import { addTaskHistory } from '../lib/taskStore.js'
import { randomBytes } from 'crypto'

const AGENT_TIMEOUT = parseInt(process.env.AGENT_TIMEOUT || '180000', 10)

export async function handleChat(req, res, body) {
  const model = body.model
  const messages = body.messages || []
  const stream = body.stream !== false

  const modelInfo = getModel(model)
  if (!modelInfo) return json(res, 400, formatError(400, `model not found: ${model}`))
  if (modelInfo.taskType !== 'chat') return json(res, 400, formatError(400, `model ${model} is not a chat model`))

  const imageUrls = extractImageUrls(messages)
  const inputFiles = processRequestFiles(imageUrls)
  const prompt = buildPrompt(messages)
  const requestId = 'req-' + randomBytes(8).toString('hex')
  const chatId = 'chatcmpl-' + randomBytes(8).toString('hex')
  const vendor = modelInfo.vendor
  const startTime = Date.now()

  const cleanupFiles = () => {
    for (const f of inputFiles) if (!f.startsWith('http')) deleteFile(f)
  }

  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })

    let ended = false
    let queued = true
    const keepAlive = setInterval(() => {
      if (queued && !ended) res.write(formatSSEComment('queued'))
    }, 5000)

    const finish = (writer) => {
      if (ended) return
      ended = true
      clearInterval(keepAlive)
      try { writer() } catch {}
      try { res.end() } catch {}
    }

    // 客户端断开处理
    const onClose = () => {
      if (!ended) {
        cancelRequest(requestId)
        cleanupFiles()
        finish(() => {})
      }
    }
    req.on('close', onClose)

    registerRequest(requestId, {
      onDelta: (text) => {
        if (queued) { queued = false }
        if (!ended) res.write(formatSSE(formatChatCompletionChunk(chatId, model, text)))
      },
      onDone: () => {
        if (queued) { queued = false }
        finish(() => {
          res.write(formatSSE(formatChatCompletionDone(chatId, model)))
          res.write(formatSSEDone())
        })
        const latency = Date.now() - startTime
        recordRequest(vendor, true, latency)
        addTaskHistory({ requestId, model, vendor, taskType: 'chat', status: 'success', latency, ts: Date.now() })
        cleanupFiles()
      },
      onError: (code, message, screenshotUrl) => {
        if (queued) { queued = false }
        finish(() => {
          res.write(formatSSE(formatError(code, message)))
          res.write(formatSSEDone())
        })
        recordRequest(vendor, false, Date.now() - startTime)
        addTaskHistory({ requestId, model, vendor, taskType: 'chat', status: 'failed', error: message, latency: Date.now() - startTime, ts: Date.now() })
        cleanupFiles()
      },
      onTimeout: () => {
        finish(() => {
          res.write(formatSSE(formatError(504, '请求超时')))
          res.write(formatSSEDone())
        })
        recordRequest(vendor, false, Date.now() - startTime)
        cleanupFiles()
      },
    })

    const result = await scheduleSync(requestId, { vendor, taskType: 'chat', prompt, inputFiles })
    if (result.error) {
      cancelRequest(requestId)
      finish(() => {
        res.write(formatSSE(formatError(result.error, result.message)))
        res.write(formatSSEDone())
      })
      cleanupFiles()
    }
  } else {
    let fullText = ''
    let settled = false
    let errorResult = null

    registerRequest(requestId, {
      onDelta: (text) => { fullText += text },
      onDone: () => { settled = true },
      onError: (code, message) => { settled = true; errorResult = { code, message } },
      onTimeout: () => { settled = true; errorResult = { code: 504, message: '请求超时' } },
    })

    let clientDisconnected = false
    req.on('close', () => {
      clientDisconnected = true
      cancelRequest(requestId)
    })

    const result = await scheduleSync(requestId, { vendor, taskType: 'chat', prompt, inputFiles })
    if (result.error) {
      cancelRequest(requestId)
      cleanupFiles()
      if (!clientDisconnected) {
        json(res, result.error, formatError(result.error, result.message))
      }
      recordRequest(vendor, false, Date.now() - startTime)
      addTaskHistory({ requestId, model, vendor, taskType: 'chat', status: 'failed', error: result.message, latency: Date.now() - startTime, ts: Date.now() })
      return
    }

    if (clientDisconnected) {
      cancelRequest(requestId)
      cleanupFiles()
      return
    }

    // 等待 Agent 回传
    await new Promise(resolve => {
      const checkSettled = setInterval(() => {
        if (settled || clientDisconnected) { clearInterval(checkSettled); resolve() }
      }, 100)
      setTimeout(() => { clearInterval(checkSettled); resolve() }, AGENT_TIMEOUT + 5000)
    })

    if (clientDisconnected) {
      cleanupFiles()
      return
    }

    // 只在未完成时取消（兜底超时场景，scheduler 已处理 done/error/timeout）
    if (!settled) cancelRequest(requestId)
    cleanupFiles()

    if (errorResult) {
      json(res, errorResult.code, formatError(errorResult.code, errorResult.message))
      recordRequest(vendor, false, Date.now() - startTime)
      addTaskHistory({ requestId, model, vendor, taskType: 'chat', status: 'failed', error: errorResult.message, latency: Date.now() - startTime, ts: Date.now() })
    } else if (fullText) {
      json(res, 200, formatChatCompletion(model, fullText))
      const latency = Date.now() - startTime
      recordRequest(vendor, true, latency)
      addTaskHistory({ requestId, model, vendor, taskType: 'chat', status: 'success', latency, ts: Date.now() })
    } else {
      json(res, 500, formatError(500, '无回复内容'))
      recordRequest(vendor, false, Date.now() - startTime)
      addTaskHistory({ requestId, model, vendor, taskType: 'chat', status: 'failed', error: '无回复', latency: Date.now() - startTime, ts: Date.now() })
    }
  }
}

function json(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}
