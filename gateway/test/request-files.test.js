import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// request-files 在模块加载时读取 FILE_DIR
const tmpDir = mkdtempSync(join(tmpdir(), 'gw-files-'))
process.env.FILE_DIR = tmpDir

const {
  saveBase64AsFile,
  deleteFile,
  processRequestFiles,
} = await import('../lib/request-files.js')

after(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.FILE_DIR
})

describe('saveBase64AsFile', () => {
  test('保存 base64 数据为文件并返回文件名', () => {
    const filename = saveBase64AsFile('aGVsbG8=', 'image/png')  // "hello" in base64
    assert.ok(filename.startsWith('input-'))
    assert.ok(filename.endsWith('.png'))
    assert.ok(existsSync(join(tmpDir, filename)))
    const content = readFileSync(join(tmpDir, filename), 'utf-8')
    assert.equal(content, 'hello')
  })

  test('不同 mimeType 生成不同扩展名', () => {
    const png = saveBase64AsFile('aGVsbG8=', 'image/png')
    assert.ok(png.endsWith('.png'))
    const jpg = saveBase64AsFile('aGVsbG8=', 'image/jpeg')
    assert.ok(jpg.endsWith('.jpg'))
    const gif = saveBase64AsFile('aGVsbG8=', 'image/gif')
    assert.ok(gif.endsWith('.gif'))
    const webp = saveBase64AsFile('aGVsbG8=', 'image/webp')
    assert.ok(webp.endsWith('.webp'))
    const mp4 = saveBase64AsFile('aGVsbG8=', 'video/mp4')
    assert.ok(mp4.endsWith('.mp4'))
  })

  test('未知 mimeType 回退到 .bin', () => {
    const filename = saveBase64AsFile('aGVsbG8=', 'application/octet-stream')
    assert.ok(filename.endsWith('.bin'))
  })

  test('文件名包含时间戳和随机 hex 后缀', () => {
    const f1 = saveBase64AsFile('aGVsbG8=', 'image/png')
    const f2 = saveBase64AsFile('aGVsbG8=', 'image/png')
    assert.notEqual(f1, f2)  // 文件名不重复
  })
})

describe('deleteFile', () => {
  test('删除已存在的文件', () => {
    const filename = saveBase64AsFile('aGVsbG8=', 'image/png')
    assert.ok(existsSync(join(tmpDir, filename)))
    deleteFile(filename)
    assert.ok(!existsSync(join(tmpDir, filename)))
  })

  test('删除不存在的文件不报错', () => {
    // 不应抛异常
    assert.doesNotThrow(() => deleteFile('nonexistent.png'))
  })
})

describe('processRequestFiles', () => {
  test('data URI → 解码保存为文件，返回文件名', () => {
    const urls = ['data:image/png;base64,aGVsbG8=']
    const result = processRequestFiles(urls)
    assert.equal(result.length, 1)
    assert.ok(result[0].startsWith('input-'))
    assert.ok(result[0].endsWith('.png'))
    assert.ok(existsSync(join(tmpDir, result[0])))
  })

  test('http(s) URL → 原样返回', () => {
    const urls = [
      'http://example.com/image.png',
      'https://example.com/image.jpg',
    ]
    const result = processRequestFiles(urls)
    assert.deepEqual(result, urls)
  })

  test('混合 data URI 和 URL', () => {
    const urls = [
      'data:image/jpeg;base64,aGVsbG8=',
      'https://example.com/img.png',
    ]
    const result = processRequestFiles(urls)
    assert.equal(result.length, 2)
    assert.ok(result[0].startsWith('input-'))
    assert.ok(result[0].endsWith('.jpg'))
    assert.equal(result[1], 'https://example.com/img.png')
  })

  test('无效 data URI 被跳过', () => {
    const urls = ['data:invalid-data-uri']
    const result = processRequestFiles(urls)
    assert.equal(result.length, 0)
  })

  test('空数组返回空数组', () => {
    assert.deepEqual(processRequestFiles([]), [])
  })

  test('非 URL 非 data URI 的字符串被跳过', () => {
    const result = processRequestFiles(['just-a-string'])
    assert.equal(result.length, 0)
  })
})
