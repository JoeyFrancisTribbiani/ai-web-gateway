// 内存中的时序统计，不持久化，重启清零
// 每 5 分钟一个数据点，保留 24h (288 个)

const INTERVAL = 5 * 60 * 1000  // 5 min
const MAX_POINTS = 288          // 24h

// vendor → Array<{ ts, total, success, failed, latencies: [] }>
const stats = new Map()

function ensureVendor(vendor) {
  if (!stats.has(vendor)) {
    stats.set(vendor, { current: { ts: Date.now(), total: 0, success: 0, failed: 0, latencies: [] }, history: [] })
  }
  return stats.get(vendor)
}

export function recordRequest(vendor, success, latencyMs) {
  const s = ensureVendor(vendor)
  s.current.total++
  if (success) {
    s.current.success++
    s.current.latencies.push(latencyMs)
  } else {
    s.current.failed++
  }
}

function rollIfNeeded(vendor) {
  const s = ensureVendor(vendor)
  // 循环滚动，处理多个 INTERVAL 未查询的情况
  while (Date.now() - s.current.ts >= INTERVAL) {
    const lats = s.current.latencies.sort((a, b) => a - b)
    const p95 = lats.length > 0 ? lats[Math.floor(lats.length * 0.95)] : 0
    const avg = lats.length > 0 ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : 0

    s.history.push({
      ts: s.current.ts,
      total: s.current.total,
      success: s.current.success,
      failed: s.current.failed,
      avgLatency: avg,
      p95Latency: p95,
    })
    if (s.history.length > MAX_POINTS) s.history.shift()
    s.current = { ts: s.current.ts + INTERVAL, total: 0, success: 0, failed: 0, latencies: [] }
  }
}

export function getTrend(vendor, rangeHours = 24) {
  const s = ensureVendor(vendor)
  rollIfNeeded(vendor)
  const cutoff = Date.now() - rangeHours * 60 * 60 * 1000
  return s.history.filter(p => p.ts >= cutoff)
}

export function getDashboardStats() {
  const result = {}
  for (const [vendor, s] of stats) {
    rollIfNeeded(vendor)
    const recent = s.history.slice(-12)  // 最近 1h
    const total = recent.reduce((a, b) => a + b.total, 0)
    const success = recent.reduce((a, b) => a + b.success, 0)
    const failed = recent.reduce((a, b) => a + b.failed, 0)
    const avgLatency = recent.length > 0
      ? Math.round(recent.reduce((a, b) => a + b.avgLatency, 0) / recent.length)
      : 0
    const successRate = total > 0 ? Math.round((success / total) * 1000) / 10 : 100

    result[vendor] = {
      total, success, failed, avgLatency, successRate,
      current: s.current,
    }
  }
  return result
}

export function getErrorRate(vendor) {
  const s = ensureVendor(vendor)
  rollIfNeeded(vendor)
  // 优先用最近的已滚动数据点
  const recent = s.history.slice(-1)
  if (recent.length > 0 && recent[0].total > 0) {
    return recent[0].failed / recent[0].total
  }
  // 如果没有已滚动数据，用当前桶
  if (s.current.total > 0) {
    return s.current.failed / s.current.total
  }
  return 0
}
