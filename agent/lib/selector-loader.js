import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { parse as parseYaml } from 'yaml'

const CONFIG_DIR = process.env.CONFIG_DIR || '/app/config'
const RELOAD_INTERVAL = 60 * 1000  // 60s

let selectors = {}
let lastLoadTime = 0

export function init() {
  loadSelectors()
  setInterval(loadSelectors, RELOAD_INTERVAL)
}

function loadSelectors() {
  const p = join(CONFIG_DIR, 'selectors.yaml')
  if (!existsSync(p)) return
  try {
    const data = parseYaml(readFileSync(p, 'utf-8'))
    selectors = data || {}
    lastLoadTime = Date.now()
  } catch (e) {
    console.error('[selector-loader] failed to load:', e.message)
  }
}

export function getSelectors(vendor) {
  return selectors[vendor] || {}
}

export function getLastLoadTime() {
  return lastLoadTime
}
