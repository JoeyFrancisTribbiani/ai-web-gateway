import { execSync } from 'child_process'

let lastCpuTime = 0
let lastCheckTime = 0

export function getChromeStats() {
  try {
    const pids = execSync('pgrep -f "chromium|chrome" 2>/dev/null || true', { encoding: 'utf-8' }).trim().split('\n').filter(Boolean)
    if (pids.length === 0) return { chromeMemoryMB: 0, chromeCpuPercent: 0 }

    let totalMemKB = 0
    let totalCpuJiffies = 0

    for (const pid of pids) {
      try {
        const status = execSync(`cat /proc/${pid}/status 2>/dev/null`, { encoding: 'utf-8' })
        const memLine = status.match(/VmRSS:\s+(\d+)/)
        if (memLine) totalMemKB += parseInt(memLine[1])

        const stat = execSync(`cat /proc/${pid}/stat 2>/dev/null`, { encoding: 'utf-8' }).trim().split(/\s+/)
        if (stat.length > 14) {
          totalCpuJiffies += (parseInt(stat[13]) || 0) + (parseInt(stat[14]) || 0)
        }
      } catch {}
    }

    // CPU 百分比: 两次采样的 CPU jiffies 差值 / 时间差值
    const now = Date.now()
    let cpuPercent = 0
    if (lastCheckTime > 0) {
      const dt = (now - lastCheckTime) / 1000  // 秒
      const dCpu = (totalCpuJiffies - lastCpuTime) / 100  // jiffies → 秒 (100Hz)
      cpuPercent = dt > 0 ? Math.round((dCpu / dt) * 1000) / 10 : 0
    }
    lastCpuTime = totalCpuJiffies
    lastCheckTime = now

    return {
      chromeMemoryMB: Math.round(totalMemKB / 1024),
      chromeCpuPercent: cpuPercent,
    }
  } catch {
    return { chromeMemoryMB: 0, chromeCpuPercent: 0 }
  }
}

