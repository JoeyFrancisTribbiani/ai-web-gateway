import { createReadStream, existsSync, statSync, copyFileSync, unlinkSync } from 'fs'
import { join, basename } from 'path'
import { randomBytes } from 'crypto'
import formidable from 'formidable'

const FILE_DIR = process.env.FILE_DIR || '/data/files'
const PUBLIC_URL = process.env.PUBLIC_URL || 'http://localhost:26669'

export async function handleFileUpload(req, res) {
  const form = formidable({})
  try {
    const [fields, files] = await form.parse(req)
    const file = files.file?.[0]
    if (!file) return json(res, 400, { error: 'no file provided' })

    const ext = file.originalFilename?.split('.').pop() || 'bin'
    const prefix = fields.prefix?.[0] || 'file'
    const filename = `${prefix}-${Date.now()}-${randomBytes(3).toString('hex')}.${ext}`
    const destPath = join(FILE_DIR, filename)

    // 跨文件系统安全复制 (formidable 临时目录可能在不同挂载点)
    copyFileSync(file.filepath, destPath)
    try { unlinkSync(file.filepath) } catch {}

    json(res, 200, { url: `${PUBLIC_URL}/files/${filename}` })
  } catch (e) {
    json(res, 500, { error: e.message })
  }
}

export function handleFileDownload(req, res, filename) {
  const safe = basename(filename)
  const filepath = join(FILE_DIR, safe)
  if (!existsSync(filepath)) return json(res, 404, { error: 'file not found' })

  const stat = statSync(filepath)
  const ext = safe.split('.').pop()?.toLowerCase()
  const mimeTypes = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm',
  }
  const contentType = mimeTypes[ext] || 'application/octet-stream'

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Cache-Control': 'public, max-age=86400',
  })
  const stream = createReadStream(filepath)
  stream.on('error', () => { try { res.end() } catch {} })
  stream.pipe(res)
}

function json(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

