import { copyFileSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'

const CONFIG_DIR = process.env.CONFIG_DIR || join(process.cwd(), 'config')
const HISTORY_DIR = process.env.HISTORY_DIR || '/data/config-history'
const MAX_VERSIONS = 20

try { mkdirSync(HISTORY_DIR, { recursive: true }) } catch {}

export function backupSelectors() {
  const src = join(CONFIG_DIR, 'selectors.yaml')
  if (!existsSync(src)) return null

  const d = new Date()
  const ts = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`
  const dest = join(HISTORY_DIR, `selectors-${ts}.yaml`)
  copyFileSync(src, dest)
  cleanupOldVersions()
  return dest
}

export function getSelectorHistory() {
  if (!existsSync(HISTORY_DIR)) return []
  const files = readdirSync(HISTORY_DIR)
    .filter(f => f.startsWith('selectors-') && f.endsWith('.yaml'))
    .sort()
    .reverse()
    .slice(0, MAX_VERSIONS)

  return files.map(f => {
    const ts = f.replace('selectors-', '').replace('.yaml', '')
    return { version: f, timestamp: ts, date: ts }
  })
}

export function getSelectorVersion(version) {
  const path = join(HISTORY_DIR, version)
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf-8')
}

export function rollbackSelectors(version) {
  const versionPath = join(HISTORY_DIR, version)
  if (!existsSync(versionPath)) return false

  // 先备份当前版本
  backupSelectors()

  // 用历史版本覆盖
  const content = readFileSync(versionPath, 'utf-8')
  const dest = join(CONFIG_DIR, 'selectors.yaml')
  writeFileSync(dest, content)
  return true
}

function cleanupOldVersions() {
  if (!existsSync(HISTORY_DIR)) return
  const files = readdirSync(HISTORY_DIR)
    .filter(f => f.startsWith('selectors-') && f.endsWith('.yaml'))
    .sort()

  while (files.length > MAX_VERSIONS) {
    const oldest = files.shift()
    try { unlinkSync(join(HISTORY_DIR, oldest)) } catch (e) { /* ignore */ }
  }
}
