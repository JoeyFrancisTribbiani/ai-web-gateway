import { readdirSync, statSync, unlinkSync, existsSync } from 'fs'
import { join } from 'path'

const FILE_DIR = process.env.FILE_DIR || '/data/files'
const FILE_TTL_HOURS = parseInt(process.env.FILE_TTL_HOURS || '24', 10)
const SCREENSHOT_TTL_HOURS = 1  // 错误截图 1h 清理

let cleanupTimer = null

export function startCleanup() {
  if (cleanupTimer) clearInterval(cleanupTimer)
  cleanupTimer = setInterval(cleanupFiles, 60 * 60 * 1000)  // 每 1 小时
  cleanupFiles()  // 启动时执行一次
}

export function cleanupFiles() {
  if (!existsSync(FILE_DIR)) return { deleted: 0, fileCount: 0, totalSizeMB: 0 }
  const now = Date.now()
  const fileTtlMs = FILE_TTL_HOURS * 60 * 60 * 1000
  const screenshotTtlMs = SCREENSHOT_TTL_HOURS * 60 * 60 * 1000

  let deleted = 0
  let totalSize = 0
  let fileCount = 0

  for (const filename of readdirSync(FILE_DIR)) {
    try {
      const filepath = join(FILE_DIR, filename)
      const stat = statSync(filepath)
      totalSize += stat.size
      fileCount++

      const age = now - stat.mtimeMs
      const ttl = filename.startsWith('error-') ? screenshotTtlMs : fileTtlMs

      if (age > ttl) {
        try { unlinkSync(filepath); deleted++ } catch {}
      }
    } catch {}
  }

  if (deleted > 0) {
    console.log(`[fileStore] cleaned ${deleted} expired files`)
  }
  return { deleted, fileCount, totalSizeMB: Math.round(totalSize / 1024 / 1024 * 100) / 100 }
}

export function getFileList() {
  if (!existsSync(FILE_DIR)) return { files: [], totalSizeMB: 0, count: 0 }
  const files = []
  let totalSize = 0

  for (const filename of readdirSync(FILE_DIR)) {
    try {
      const filepath = join(FILE_DIR, filename)
      const stat = statSync(filepath)
      totalSize += stat.size
      files.push({ name: filename, sizeKB: Math.round(stat.size / 1024), createdAt: stat.mtimeMs })
    } catch {}
  }

  files.sort((a, b) => b.createdAt - a.createdAt)
  return {
    files,
    totalSizeMB: Math.round(totalSize / 1024 / 1024 * 100) / 100,
    count: files.length,
  }
}
