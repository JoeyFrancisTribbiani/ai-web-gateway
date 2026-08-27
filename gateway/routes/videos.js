import { getModel } from '../lib/config-loader.js'
import { scheduleVideo, scheduleAnalyze, getVideoTask, clearVideoTimer } from '../lib/scheduler.js'
import { updateVideoTask } from '../lib/taskStore.js'
import { getAgent } from '../lib/agentPool.js'
import { formatError } from '../lib/openai-api.js'
import { randomBytes } from 'crypto'

export async function handleVideoGenerate(req, res, body) {
  const model = body.model
  const prompt = body.prompt || ''
  const params = { duration: body.duration, aspect_ratio: body.aspect_ratio, mode: body.mode }

  const modelInfo = getModel(model)
  if (!modelInfo) return json(res, 400, formatError(400, `model not found: ${model}`))
  if (modelInfo.taskType !== 'video') return json(res, 400, formatError(400, `model ${model} is not a video model`))

  const taskId = 'task-' + randomBytes(8).toString('hex')
  const vendor = modelInfo.vendor

  const result = await scheduleVideo(taskId, { vendor, prompt, params })
  if (result.error) return json(res, result.error, formatError(result.error, result.message))

  json(res, 200, { id: taskId, status: result.queued ? 'queued' : 'generating', model })
}

export async function handleVideoAnalyze(req, res, body) {
  const model = body.model
  const prompt = body.prompt || ''
  const inputFiles = body.inputFiles || body.fileIds || []

  const modelInfo = getModel(model)
  if (!modelInfo) return json(res, 400, formatError(400, `model not found: ${model}`))
  if (modelInfo.taskType !== 'analyze') return json(res, 400, formatError(400, `model ${model} is not an analyze model`))

  const taskId = 'task-' + randomBytes(8).toString('hex')
  const vendor = modelInfo.vendor

  const result = await scheduleAnalyze(taskId, { vendor, prompt, inputFiles })
  if (result.error) return json(res, result.error, formatError(result.error, result.message))

  json(res, 200, { id: taskId, status: result.queued ? 'queued' : 'generating', model })
}

export async function handleVideoStatus(req, res, taskId) {
  const task = await getVideoTask(taskId)
  if (!task) return json(res, 404, formatError(404, 'task not found'))

  const response = { id: task.id, status: task.status }
  if (task.status === 'completed') {
    if (task.params && task.params.type === 'analyze' && task.result) {
      response.result = task.result
    } else if (task.videoUrl) {
      response.video = { url: task.videoUrl }
    }
  }
  else if (task.status === 'generating') response.progress = task.progress
  else if (task.status === 'failed') response.error = task.error

  json(res, 200, response)
}

export async function handleVideoCancel(req, res, taskId) {
  const task = await getVideoTask(taskId)
  if (!task) return json(res, 404, formatError(404, 'task not found'))
  if (task.status !== 'queued' && task.status !== 'generating') {
    return json(res, 400, formatError(400, `cannot cancel task in ${task.status} state`))
  }

  clearVideoTimer(taskId)

  if (task.agentId) {
    const agent = getAgent(task.agentId)
    if (agent) agent.send({ type: 'video_cancel', taskId })
  }

  await updateVideoTask(taskId, { status: 'cancelled', updatedAt: Date.now() })
  json(res, 200, { id: taskId, status: 'cancelled' })
}

function json(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}
