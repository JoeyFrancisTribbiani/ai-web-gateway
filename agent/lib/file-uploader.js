import { readFileSync, createReadStream, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { tmpdir } from 'os'

const GATEWAY_HTTP_URL = (process.env.GATEWAY_URL || 'ws://gateway:26669/agent').replace('ws://', 'http://').replace('wss://', 'https://').replace('/agent', '')
const AGENT_TOKEN = process.env.AGENT_TOKEN || 'agent-secret'
const TEMP_DIR = join(tmpdir(), 'agent-files')
try { mkdirSync(TEMP_DIR, { recursive: true }) } catch {}

export async function uploadFile(localPath, prefix = 'file') {
  const FormData = (await import('form-data')).default
  const form = new FormData()
  form.append('file', createReadStream(localPath))
  form.append('prefix', prefix)

  const response = await fetch(`${GATEWAY_HTTP_URL}/files/upload`, {
    method: 'POST',
    headers: {
      ...form.getHeaders(),
      'Authorization': `Bearer ${AGENT_TOKEN}`,
    },
    body: form,
  })

  if (!response.ok) {
    throw new Error(`upload failed: ${response.status}`)
  }

  const result = await response.json()
  return result.url
}

export async function downloadFile(urlOrFilename, prefix = 'file') {
  let url
  if (urlOrFilename.startsWith('http://') || urlOrFilename.startsWith('https://')) {
    // 外部 URL，直接下载
    url = urlOrFilename
  } else {
    // Gateway 内部文件名，拼接内部地址
    url = `${GATEWAY_HTTP_URL}/files/${urlOrFilename}`
  }

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`download failed: ${response.status}`)
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  // 从 URL 或文件名中提取扩展名
  const basename = urlOrFilename.split('/').pop().split('?')[0]
  const extMatch = basename.match(/\.([a-zA-Z0-9]+)$/)
  const ext = extMatch ? extMatch[1] : 'bin'
  const localPath = join(TEMP_DIR, `${prefix}-${Date.now()}-${randomBytes(3).toString('hex')}.${ext}`)
  writeFileSync(localPath, buffer)
  return localPath
}

export function cleanupLocalFile(localPath) {
  if (localPath && existsSync(localPath)) {
    try { unlinkSync(localPath) } catch {}
  }
}
