import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'

const FILE_DIR = process.env.FILE_DIR || '/data/files'
try { mkdirSync(FILE_DIR, { recursive: true }) } catch {}

export function saveBase64AsFile(base64Data, mimeType) {
  const ext = mimeTypeToExt(mimeType)
  const filename = `input-${Date.now()}-${randomBytes(3).toString('hex')}.${ext}`
  const filepath = join(FILE_DIR, filename)
  const buffer = Buffer.from(base64Data, 'base64')
  writeFileSync(filepath, buffer)
  return filename
}

export function deleteFile(filename) {
  const filepath = join(FILE_DIR, filename)
  if (existsSync(filepath)) {
    try { unlinkSync(filepath) } catch (e) { /* ignore */ }
  }
}

export function processRequestFiles(imageUrls) {
  const inputFiles = []
  for (const url of imageUrls) {
    if (url.startsWith('data:')) {
      // base64 data URI → 解码保存
      const match = url.match(/^data:([^;]+);base64,(.+)$/)
      if (match) {
        const mimeType = match[1]
        const base64 = match[2]
        const filename = saveBase64AsFile(base64, mimeType)
        inputFiles.push(filename)  // 文件名
      }
    } else if (url.startsWith('http://') || url.startsWith('https://')) {
      // 外部 URL → 直接传递，Agent 自行下载
      inputFiles.push(url)
    }
  }
  return inputFiles
}

function mimeTypeToExt(mime) {
  const map = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
  }
  return map[mime] || 'bin'
}
