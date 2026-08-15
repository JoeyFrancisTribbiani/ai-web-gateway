import { execSync } from 'child_process'

let lastCpuTime = 0
let lastCheckTime = 0

const isWin = process.platform === 'win32'

export function getChromeStats() {
  try {
    if (isWin) return getChromeStatsWindows()
    return getChromeStatsLinux()
  } catch {
    return { chromeMemoryMB: 0, chromeCpuPercent: 0 }
  }
}

function getChromeStatsLinux() {
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

  const now = Date.now()
  let cpuPercent = 0
  if (lastCheckTime > 0) {
    const dt = (now - lastCheckTime) / 1000
    const dCpu = (totalCpuJiffies - lastCpuTime) / 100
    cpuPercent = dt > 0 ? Math.round((dCpu / dt) * 1000) / 10 : 0
  }
  lastCpuTime = totalCpuJiffies
  lastCheckTime = now

  return {
    chromeMemoryMB: Math.round(totalMemKB / 1024),
    chromeCpuPercent: cpuPercent,
  }
}

function getChromeStatsWindows() {
  let output
  try {
    output = execSync('tasklist /FO CSV /NH | findstr /I "chrome.exe chromium.exe"', { encoding: 'utf-8' })
  } catch {
    return { chromeMemoryMB: 0, chromeCpuPercent: 0 }
  }
  const lines = output.trim().split('\n').filter(Boolean)

  let totalMemKB = 0
  for (const line of lines) {
    const match = line.match(/"([\d,]+)\s*K"/i)
    if (match) {
      totalMemKB += parseInt(match[1].replace(/,/g, ''))
    }
  }

  return {
    chromeMemoryMB: Math.round(totalMemKB / 1024),
    chromeCpuPercent: 0,
  }
}

