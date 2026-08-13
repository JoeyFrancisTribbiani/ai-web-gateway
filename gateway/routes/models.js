import { getAllModels } from '../lib/config-loader.js'
import { formatModels } from '../lib/openai-api.js'

export function handleModels(req, res) {
  const models = getAllModels()
  const body = JSON.stringify(formatModels(models))
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}
