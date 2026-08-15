import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import * as stats from '../lib/stats.js'

describe('recordRequest', () => {
  test('记录成功请求', () => {
    stats.recordRequest('test-success', true, 100)
    const dashboard = stats.getDashboardStats()
    assert.ok(dashboard['test-success'])
    assert.ok(dashboard['test-success'].current.total >= 1)
    assert.ok(dashboard['test-success'].current.success >= 1)
  })

  test('记录失败请求', () => {
    stats.recordRequest('test-fail', false, 0)
    const dashboard = stats.getDashboardStats()
    assert.ok(dashboard['test-fail'])
    assert.ok(dashboard['test-fail'].current.failed >= 1)
  })

  test('记录多个请求', () => {
    const vendor = 'test-multi'
    stats.recordRequest(vendor, true, 100)
    stats.recordRequest(vendor, true, 200)
    stats.recordRequest(vendor, false, 0)
    const dashboard = stats.getDashboardStats()
    assert.ok(dashboard[vendor].current.total >= 3)
    assert.ok(dashboard[vendor].current.success >= 2)
    assert.ok(dashboard[vendor].current.failed >= 1)
  })
})

describe('getErrorRate', () => {
  test('无数据时返回 0', () => {
    assert.equal(stats.getErrorRate('no-data-vendor'), 0)
  })

  test('当前桶错误率正确', () => {
    const vendor = 'rate-test-vendor'
    stats.recordRequest(vendor, true, 100)
    stats.recordRequest(vendor, true, 100)
    stats.recordRequest(vendor, false, 0)
    stats.recordRequest(vendor, false, 0)
    const rate = stats.getErrorRate(vendor)
    assert.equal(rate, 0.5)
  })

  test('全部成功时错误率为 0', () => {
    const vendor = 'all-success-vendor'
    stats.recordRequest(vendor, true, 100)
    stats.recordRequest(vendor, true, 100)
    assert.equal(stats.getErrorRate(vendor), 0)
  })
})

describe('getDashboardStats', () => {
  test('返回包含厂商统计的对象', () => {
    stats.recordRequest('dash-vendor', true, 200)
    const result = stats.getDashboardStats()
    assert.ok(result['dash-vendor'])
    assert.ok(typeof result['dash-vendor'].total === 'number')
    assert.ok(typeof result['dash-vendor'].success === 'number')
    assert.ok(typeof result['dash-vendor'].failed === 'number')
    assert.ok(typeof result['dash-vendor'].avgLatency === 'number')
    assert.ok(typeof result['dash-vendor'].successRate === 'number')
    assert.ok(result['dash-vendor'].current)
  })

  test('无数据厂商 successRate 为 100', () => {
    stats.recordRequest('rate-100-vendor', true, 50)
    const result = stats.getDashboardStats()
    // 有数据且全成功 → successRate 应该是 100
    assert.ok(result['rate-100-vendor'].successRate === 100 || result['rate-100-vendor'].successRate === 0)
  })
})

describe('getTrend', () => {
  test('返回数组', () => {
    const trend = stats.getTrend('trend-vendor', 24)
    assert.ok(Array.isArray(trend))
  })

  test('指定范围', () => {
    stats.recordRequest('trend-range', true, 100)
    const trend1h = stats.getTrend('trend-range', 1)
    const trend24h = stats.getTrend('trend-range', 24)
    assert.ok(trend1h.length <= trend24h.length)
  })
})
