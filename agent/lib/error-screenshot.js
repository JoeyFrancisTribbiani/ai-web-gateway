import { uploadFile } from './file-uploader.js'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { mkdirSync, unlinkSync } from 'fs'

const TEMP_DIR = '/tmp/agent-screenshots'
try { mkdirSync(TEMP_DIR, { recursive: true }) } catch {}

export async function captureAndUpload(page, requestId) {
  try {
    const filename = `error-${Date.now()}-${randomBytes(3).toString('hex')}.png`
    const localPath = join(TEMP_DIR, filename)
    await page.screenshot({ path: localPath, fullPage: true, timeout: 5000 })
    const url = await uploadFile(localPath, 'error')
    try { unlinkSync(localPath) } catch {}
    return url
  } catch (e) {
    console.error('[error-screenshot] capture failed:', e.message)
    return null
  }
}
