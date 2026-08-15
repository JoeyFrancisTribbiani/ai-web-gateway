import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, utimesSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// fileStore 在模块加载时读取 FILE_DIR — 但它每次调用时都重新读 process.env.FILE_DIR?
// 实际上 FILE_DIR 是模块级常量, 只在 import 时读取一次。
// 所以我们需要在 import 之前设好环境变量, 并在整个测试套件中共用一个 tmpDir。
// 不同 describe 之间通过清空目录来隔离。
const tmpDir = mkdtempSync(join(tmpdir(), 'gw-filestore-'))
process.env.FILE_DIR = tmpDir

const { cleanupFiles, getFileList } = await import('../lib/fileStore.js')

after(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.FILE_DIR
})

function clearDir() {
  for (const f of readdirSyncSafe(tmpDir)) {
    rmSync(join(tmpDir, f), { force: true })
  }
}

function createFile(name, content = 'test') {
  writeFileSync(join(tmpDir, name), content)
}

function setMtime(name, hoursAgo) {
  const path = join(tmpDir, name)
  const time = new Date(Date.now() - hoursAgo * 60 * 60 * 1000)
  utimesSync(path, time, time)
}

function readdirSyncSafe(dir) {
  try { return readdirSync(dir) } catch { return [] }
}

describe('cleanupFiles', () => {
  test('删除过期的普通文件 (超过 FILE_TTL_HOURS)', () => {
    clearDir()
    process.env.FILE_TTL_HOURS = '24'
    createFile('fresh.txt', 'recent')
    createFile('old.txt', 'expired')
    setMtime('old.txt', 25)  // 25h ago > 24h TTL

    const result = cleanupFiles()
    assert.ok(existsSync(join(tmpDir, 'fresh.txt')))
    assert.ok(!existsSync(join(tmpDir, 'old.txt')))
    assert.equal(result.deleted, 1)
    assert.equal(result.fileCount, 2)  // cleanup 前统计
  })

  test('error- 前缀文件使用 1h TTL', () => {
    clearDir()
    process.env.FILE_TTL_HOURS = '24'
    createFile('error-screenshot.png', 'err')
    createFile('normal.txt', 'normal')
    setMtime('error-screenshot.png', 2)  // 2h ago > 1h screenshot TTL
    setMtime('normal.txt', 2)  // 2h ago < 24h TTL

    const result = cleanupFiles()
    assert.ok(!existsSync(join(tmpDir, 'error-screenshot.png')))
    assert.ok(existsSync(join(tmpDir, 'normal.txt')))
    assert.equal(result.deleted, 1)
  })

  test('未过期的文件不删除', () => {
    clearDir()
    process.env.FILE_TTL_HOURS = '24'
    createFile('a.txt', 'a')
    createFile('b.txt', 'b')
    setMtime('a.txt', 1)
    setMtime('b.txt', 23)

    const result = cleanupFiles()
    assert.equal(result.deleted, 0)
    assert.ok(existsSync(join(tmpDir, 'a.txt')))
    assert.ok(existsSync(join(tmpDir, 'b.txt')))
  })

  test('空目录返回零值', () => {
    clearDir()
    const result = cleanupFiles()
    assert.equal(result.deleted, 0)
    assert.equal(result.fileCount, 0)
    assert.equal(result.totalSizeMB, 0)
  })

  test('返回文件大小统计', () => {
    clearDir()
    // totalSizeMB = Math.round(bytes / 1024 / 1024 * 100) / 100
    // 需要 > 1MB 才能让 totalSizeMB > 0
    createFile('a.txt', 'A'.repeat(600 * 1024))   // 600KB
    createFile('b.txt', 'B'.repeat(600 * 1024))   // 600KB → 总共 1.2MB
    const result = cleanupFiles()
    assert.equal(result.fileCount, 2)
    assert.ok(result.totalSizeMB > 0, `totalSizeMB should be > 0, got ${result.totalSizeMB}`)
  })
})

describe('getFileList', () => {
  test('返回文件列表按 createdAt 降序排列', async () => {
    clearDir()
    createFile('old.txt', 'old')
    await new Promise(r => setTimeout(r, 50))
    createFile('new.txt', 'new')

    const result = getFileList()
    assert.equal(result.count, 2)
    assert.equal(result.files[0].name, 'new.txt')  // 较新的在前
    assert.equal(result.files[1].name, 'old.txt')
    assert.ok(result.count > 0)
  })

  test('文件信息包含 name, sizeKB, createdAt', () => {
    clearDir()
    createFile('test.txt', 'hello world')
    const result = getFileList()
    assert.equal(result.files[0].name, 'test.txt')
    assert.ok(typeof result.files[0].sizeKB === 'number')
    assert.ok(typeof result.files[0].createdAt === 'number')
  })
})
