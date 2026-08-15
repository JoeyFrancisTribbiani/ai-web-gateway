import { test, describe, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// config-loader 在模块加载时读取 CONFIG_DIR，必须在 import 之前设置
const TMP_CONFIG = mkdtempSync(join(tmpdir(), 'gw-config-'))
process.env.CONFIG_DIR = TMP_CONFIG

const config = await import('../lib/config-loader.js')

after(() => {
  rmSync(TMP_CONFIG, { recursive: true, force: true })
  delete process.env.CONFIG_DIR
})

beforeEach(() => {
  // 清空目录 + 重置 vendorDisabled 状态
  for (const f of readdirSync(TMP_CONFIG)) {
    rmSync(join(TMP_CONFIG, f), { recursive: true, force: true })
  }
})

describe('init / getModel / getAllModels', () => {
  test('加载 models.yaml 后 getModel 返回模型信息', () => {
    writeFileSync(join(TMP_CONFIG, 'models.yaml'), `models:
  - name: gpt-4o-web
    vendor: chatgpt
    taskType: chat
  - name: jimeng-image-web
    vendor: jimeng
    taskType: image`)
    writeFileSync(join(TMP_CONFIG, 'vendors.yaml'), 'vendors:\n  chatgpt:\n    url: https://chatgpt.com\n    capabilities: [chat]\n    adapter: chatgpt.js')
    writeFileSync(join(TMP_CONFIG, 'selectors.yaml'), 'chatgpt:\n  input: "#prompt-textarea"')

    config.init()

    const m = config.getModel('gpt-4o-web')
    assert.ok(m)
    assert.equal(m.vendor, 'chatgpt')
    assert.equal(m.taskType, 'chat')

    const img = config.getModel('jimeng-image-web')
    assert.equal(img.taskType, 'image')
  })

  test('getModel 返回 null for 未知模型', () => {
    config.init()
    assert.equal(config.getModel('nonexistent'), null)
  })

  test('getAllModels 返回模型列表', () => {
    writeFileSync(join(TMP_CONFIG, 'models.yaml'), `models:
  - name: a-web
    vendor: va
    taskType: chat
  - name: b-web
    vendor: vb
    taskType: image`)
    writeFileSync(join(TMP_CONFIG, 'vendors.yaml'), 'vendors:\n  va:\n    url: http://a\n    capabilities: [chat]\n  vb:\n    url: http://b\n    capabilities: [image]')
    config.init()
    const all = config.getAllModels()
    assert.equal(all.length, 2)
  })
})

describe('disableVendor / enableVendor', () => {
  test('禁用厂商后 getModel 返回 null', () => {
    writeFileSync(join(TMP_CONFIG, 'models.yaml'), `models:
  - name: gpt-4o-web
    vendor: chatgpt
    taskType: chat`)
    writeFileSync(join(TMP_CONFIG, 'vendors.yaml'), 'vendors:\n  chatgpt:\n    url: https://chatgpt.com\n    capabilities: [chat]')
    config.init()

    assert.ok(config.getModel('gpt-4o-web'))
    config.disableVendor('chatgpt')
    assert.equal(config.getModel('gpt-4o-web'), null)
    assert.ok(config.isVendorDisabled('chatgpt'))

    config.enableVendor('chatgpt')
    assert.ok(config.getModel('gpt-4o-web'))
    assert.ok(!config.isVendorDisabled('chatgpt'))
  })

  test('禁用厂商后 getAllModels 过滤该厂商', () => {
    writeFileSync(join(TMP_CONFIG, 'models.yaml'), `models:
  - name: a-web
    vendor: va
    taskType: chat
  - name: b-web
    vendor: vb
    taskType: chat`)
    writeFileSync(join(TMP_CONFIG, 'vendors.yaml'), 'vendors:\n  va:\n    url: http://a\n    capabilities: [chat]\n  vb:\n    url: http://b\n    capabilities: [chat]')
    config.init()

    config.disableVendor('va')
    const all = config.getAllModels()
    assert.equal(all.length, 1)
    assert.equal(all[0].vendor, 'vb')
    // 清理
    config.enableVendor('va')
  })

  test('getVendorStatus 返回所有厂商状态', () => {
    writeFileSync(join(TMP_CONFIG, 'vendors.yaml'), 'vendors:\n  va:\n    url: http://a\n    capabilities: [chat]\n  vb:\n    url: http://b\n    capabilities: [chat]')
    config.init()

    config.disableVendor('va')
    const status = config.getVendorStatus()
    assert.equal(status.va, 'disabled')
    assert.equal(status.vb, 'enabled')
    // 清理
    config.enableVendor('va')
  })
})

describe('getVendor', () => {
  test('返回厂商信息', () => {
    writeFileSync(join(TMP_CONFIG, 'vendors.yaml'), 'vendors:\n  chatgpt:\n    url: https://chatgpt.com\n    capabilities: [chat]\n    adapter: chatgpt.js')
    config.init()

    const v = config.getVendor('chatgpt')
    assert.ok(v)
    assert.equal(v.url, 'https://chatgpt.com')
    assert.deepEqual(v.capabilities, ['chat'])
  })

  test('未知厂商返回 null', () => {
    config.init()
    assert.equal(config.getVendor('unknown'), null)
  })
})

describe('getSelectors', () => {
  test('返回指定厂商选择器', () => {
    writeFileSync(join(TMP_CONFIG, 'selectors.yaml'), `chatgpt:
  input: "#prompt-textarea"
  sendButton: "button[data-testid='send-button']"
claude:
  input: "div.ProseMirror"`)
    config.init()

    const s = config.getSelectors('chatgpt')
    assert.equal(s.input, '#prompt-textarea')
    assert.ok(s.sendButton)

    const c = config.getSelectors('claude')
    assert.equal(c.input, 'div.ProseMirror')
  })

  test('无参数返回全部选择器', () => {
    writeFileSync(join(TMP_CONFIG, 'selectors.yaml'), `chatgpt:
  input: "#x"`)
    config.init()

    const all = config.getSelectors()
    assert.ok(all.chatgpt)
  })

  test('未知厂商返回空对象', () => {
    config.init()
    assert.deepEqual(config.getSelectors('unknown'), {})
  })
})

describe('getModelsYamlPath / getVendorsYamlPath / getSelectorsYamlPath', () => {
  test('返回正确的配置文件路径', () => {
    writeFileSync(join(TMP_CONFIG, 'models.yaml'), 'models: []')
    writeFileSync(join(TMP_CONFIG, 'vendors.yaml'), 'vendors: {}')
    writeFileSync(join(TMP_CONFIG, 'selectors.yaml'), '{}')
    config.init()

    assert.ok(config.getModelsYamlPath().endsWith('models.yaml'))
    assert.ok(config.getVendorsYamlPath().endsWith('vendors.yaml'))
    assert.ok(config.getSelectorsYamlPath().endsWith('selectors.yaml'))
  })
})
