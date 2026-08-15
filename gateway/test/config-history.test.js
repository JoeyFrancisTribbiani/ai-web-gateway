import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// config-history 在模块加载时读取 CONFIG_DIR 和 HISTORY_DIR
const configDir = mkdtempSync(join(tmpdir(), 'gw-cfg-'))
const historyDir = mkdtempSync(join(tmpdir(), 'gw-hist-'))
process.env.CONFIG_DIR = configDir
process.env.HISTORY_DIR = historyDir

const {
  backupSelectors,
  getSelectorHistory,
  getSelectorVersion,
  rollbackSelectors,
} = await import('../lib/config-history.js')

after(() => {
  rmSync(configDir, { recursive: true, force: true })
  rmSync(historyDir, { recursive: true, force: true })
  delete process.env.CONFIG_DIR
  delete process.env.HISTORY_DIR
})

function writeSelectors(content) {
  writeFileSync(join(configDir, 'selectors.yaml'), content)
}

function ensureHistoryDir() {
  if (!existsSync(historyDir)) mkdirSync(historyDir, { recursive: true })
}

describe('backupSelectors', () => {
  test('备份当前 selectors.yaml 到历史目录', () => {
    ensureHistoryDir()
    writeSelectors('chatgpt:\n  input: "#test"')
    const dest = backupSelectors()
    assert.ok(dest)
    assert.ok(dest.includes('selectors-'))
    assert.ok(dest.endsWith('.yaml'))
    assert.ok(existsSync(dest))
    const content = readFileSync(dest, 'utf-8')
    assert.equal(content, 'chatgpt:\n  input: "#test"')
  })

  test('selectors.yaml 不存在时返回 null', () => {
    rmSync(join(configDir, 'selectors.yaml'), { force: true })
    const dest = backupSelectors()
    assert.equal(dest, null)
  })

  test('备份文件名包含时间戳', () => {
    ensureHistoryDir()
    writeSelectors('test: value')
    const dest = backupSelectors()
    const filename = dest.split(/[\\/]/).pop()
    // 格式: selectors-YYYYMMDD-HHMMSS.yaml
    assert.ok(/^selectors-\d{8}-\d{6}\.yaml$/.test(filename), `filename: ${filename}`)
  })
})

describe('getSelectorHistory', () => {
  test('返回历史版本列表（按时间降序）', async () => {
    ensureHistoryDir()
    writeSelectors('v1')
    backupSelectors()
    // 等待 1.1s 确保时间戳不同 (文件名含秒级时间戳)
    await new Promise(r => setTimeout(r, 1100))
    writeSelectors('v2')
    backupSelectors()

    const history = getSelectorHistory()
    assert.ok(history.length >= 2)
    // 最新的在前
    assert.ok(history[0].version >= history[1].version)
  })

  test('每个历史记录包含 version, timestamp, date', () => {
    ensureHistoryDir()
    writeSelectors('test')
    backupSelectors()
    const history = getSelectorHistory()
    assert.ok(history[0].version)
    assert.ok(history[0].timestamp)
    assert.ok(history[0].date)
  })

  test('历史目录不存在时返回空数组', () => {
    rmSync(historyDir, { recursive: true, force: true })
    const history = getSelectorHistory()
    assert.deepEqual(history, [])
  })
})

describe('getSelectorVersion', () => {
  test('返回指定版本的文件内容', () => {
    // 重建 history 目录和 selectors.yaml
    ensureHistoryDir()
    writeSelectors('original content')
    backupSelectors()
    const history = getSelectorHistory()
    const content = getSelectorVersion(history[0].version)
    assert.equal(content, 'original content')
  })

  test('版本不存在时返回 null', () => {
    assert.equal(getSelectorVersion('nonexistent.yaml'), null)
  })
})

describe('rollbackSelectors', () => {
  test('回滚到历史版本', async () => {
    ensureHistoryDir()
    // v1
    writeSelectors('v1-content')
    backupSelectors()
    const history = getSelectorHistory()
    const v1Version = history[0].version

    // 等待 1.1s 确保回滚备份的时间戳不同
    await new Promise(r => setTimeout(r, 1100))

    // v2
    writeSelectors('v2-content')
    assert.equal(readFileSync(join(configDir, 'selectors.yaml'), 'utf-8'), 'v2-content')

    // 回滚到 v1
    const result = rollbackSelectors(v1Version)
    assert.equal(result, true)
    assert.equal(readFileSync(join(configDir, 'selectors.yaml'), 'utf-8'), 'v1-content')
  })

  test('回滚前先备份当前版本', () => {
    ensureHistoryDir()
    writeSelectors('v1')
    backupSelectors()
    const history = getSelectorHistory()
    const v1Version = history[0].version

    writeSelectors('v2')
    rollbackSelectors(v1Version)

    // v2 应该被备份了
    const newHistory = getSelectorHistory()
    const v2Exists = newHistory.some(h => {
      const content = getSelectorVersion(h.version)
      return content === 'v2'
    })
    assert.ok(v2Exists, '回滚前应备份当前 v2 版本')
  })

  test('版本不存在时返回 false', () => {
    ensureHistoryDir()
    writeSelectors('current')
    const result = rollbackSelectors('nonexistent.yaml')
    assert.equal(result, false)
    // 原文件不受影响
    assert.equal(readFileSync(join(configDir, 'selectors.yaml'), 'utf-8'), 'current')
  })
})
