import { readFileSync, existsSync } from 'fs'
import { resolve, join } from 'path'
import { parse as parseYaml } from 'yaml'

const CONFIG_DIR = process.env.CONFIG_DIR || join(process.cwd(), 'config')

let models = []
let vendors = {}
let selectors = {}
let modelsByName = {}
let vendorDisabled = new Set()

function loadYaml(filename) {
  const p = join(CONFIG_DIR, filename)
  if (!existsSync(p)) return null
  return parseYaml(readFileSync(p, 'utf-8'))
}

function reloadModels() {
  const data = loadYaml('models.yaml')
  if (!data || !data.models) return
  models = data.models
  modelsByName = {}
  for (const m of models) {
    modelsByName[m.name] = m
  }
  console.log(`[config] models loaded: ${models.length}`)
}

function reloadVendors() {
  const data = loadYaml('vendors.yaml')
  if (!data || !data.vendors) return
  vendors = data.vendors
  console.log(`[config] vendors loaded: ${Object.keys(vendors).length}`)
}

function reloadSelectors() {
  const data = loadYaml('selectors.yaml')
  if (!data) return
  selectors = data
  console.log(`[config] selectors loaded: ${Object.keys(selectors).length} vendors`)
}

export function init() {
  reloadModels()
  reloadVendors()
  reloadSelectors()

  // selectors.yaml 热加载 (Agent 侧每 60s 重读, Gateway 侧不需要)
  // models.yaml 热加载 (管理后台修改后调用 reloadModels)
  // vendors.yaml 需重启 Agent
}

export function getModel(name) {
  const m = modelsByName[name]
  if (!m) return null
  if (vendorDisabled.has(m.vendor)) return null
  return m
}

export function getVendor(name) {
  return vendors[name] || null
}

export function getAllModels() {
  return models.filter(m => !vendorDisabled.has(m.vendor))
}

export function getSelectors(vendor) {
  if (!vendor) return selectors
  return selectors[vendor] || {}
}

export function disableVendor(vendor) {
  vendorDisabled.add(vendor)
  console.log(`[config] vendor disabled: ${vendor}`)
}

export function enableVendor(vendor) {
  vendorDisabled.delete(vendor)
  console.log(`[config] vendor enabled: ${vendor}`)
}

export function isVendorDisabled(vendor) {
  return vendorDisabled.has(vendor)
}

export function getVendorStatus() {
  const result = {}
  for (const name of Object.keys(vendors)) {
    result[name] = vendorDisabled.has(name) ? 'disabled' : 'enabled'
  }
  return result
}

export function reloadAll() {
  reloadModels()
  reloadVendors()
  reloadSelectors()
}

export function getModelsYamlPath() {
  return join(CONFIG_DIR, 'models.yaml')
}

export function getVendorsYamlPath() {
  return join(CONFIG_DIR, 'vendors.yaml')
}

export function getSelectorsYamlPath() {
  return join(CONFIG_DIR, 'selectors.yaml')
}

export function getSelectorsForAgent(vendor) {
  return selectors[vendor] || {}
}
