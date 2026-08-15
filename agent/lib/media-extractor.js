import { writeFileSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { tmpdir } from 'os'

const TEMP_DIR = join(tmpdir(), 'agent-media')
try { mkdirSync(TEMP_DIR, { recursive: true }) } catch {}

export async function extractImageViaCanvas(page, imgUrl) {
  // 方案1: Canvas 读取 blob URL → base64 → 保存文件
  const base64Str = await page.evaluate(async (url) => {
    const img = document.querySelector(`img[src="${url}"]`)
    if (!img) return null
    if (!img.complete) {
      await new Promise(r => { img.onload = img.onerror = r })
    }
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth || img.width
    canvas.height = img.naturalHeight || img.height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0)
    return canvas.toDataURL('image/png')
  }, imgUrl)

  if (!base64Str) return null
  return saveBase64ToFile(base64Str, 'png')
}

export async function extractImageViaDownload(url) {
  // 方案2: 直接下载远程图片 URL
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  })
  if (!response.ok) return null
  const buffer = Buffer.from(await response.arrayBuffer())
  const ext = url.includes('.jpg') || url.includes('.jpeg') ? 'jpg' : 'png'
  const localPath = join(TEMP_DIR, `img-${Date.now()}-${randomBytes(3).toString('hex')}.${ext}`)
  writeFileSync(localPath, buffer)
  return localPath
}

export async function extractVideoViaDownload(page, downloadBtnSelector, selectors) {
  // 方案A: 拦截下载事件
  try {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.click(downloadBtnSelector),
    ])
    const localPath = join(TEMP_DIR, `video-${Date.now()}-${randomBytes(3).toString('hex')}.mp4`)
    await download.saveAs(localPath)
    return localPath
  } catch (e) {
    // 降级到方案B
  }

  // 方案B: 从 video 标签 src 提取
  return extractVideoFromSrc(page, selectors)
}

export async function extractVideoFromSrc(page, selectors) {
  const videoSelector = selectors.resultVideo || 'video'
  const src = await page.evaluate((sel) => {
    const video = document.querySelector(sel)
    return video?.src || video?.querySelector('source')?.src || null
  }, videoSelector)

  if (!src) return null

  if (src.startsWith('blob:')) {
    // blob URL → 通过 page.evaluate fetch 获取 (分块处理避免调用栈溢出)
    const base64 = await page.evaluate(async (url) => {
      const resp = await fetch(url)
      const ab = await resp.arrayBuffer()
      const bytes = new Uint8Array(ab)
      let binary = ''
      const chunkSize = 8192
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize))
      }
      return btoa(binary)
    }, src)
    const localPath = join(TEMP_DIR, `video-${Date.now()}-${randomBytes(3).toString('hex')}.mp4`)
    writeFileSync(localPath, Buffer.from(base64, 'base64'))
    return localPath
  } else if (src.startsWith('http')) {
    const response = await fetch(src)
    const buffer = Buffer.from(await response.arrayBuffer())
    const localPath = join(TEMP_DIR, `video-${Date.now()}-${randomBytes(3).toString('hex')}.mp4`)
    writeFileSync(localPath, buffer)
    return localPath
  }

  return null
}

function saveBase64ToFile(base64Str, ext) {
  const match = base64Str.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) return null
  const buffer = Buffer.from(match[2], 'base64')
  const localPath = join(TEMP_DIR, `img-${Date.now()}-${randomBytes(3).toString('hex')}.${ext}`)
  writeFileSync(localPath, buffer)
  return localPath
}

export function cleanupLocalFile(localPath) {
  if (localPath) {
    try { unlinkSync(localPath) } catch {}
  }
}
