import { execSync, spawn } from 'child_process'

let vncProcess = null
let currentVendor = null

export function startVnc(displayNum, port) {
  if (vncProcess) return true  // 已在运行

  try {
    vncProcess = spawn('x11vnc', [
      '-display', `:${displayNum}`,
      '-nopw', '-listen', '0.0.0.0',
      '-rfbport', String(port),
      '-forever', '-shared', '-noxfixes',
    ], { stdio: 'ignore' })

    vncProcess.on('error', (e) => {
      console.error('[vnc] failed to start:', e.message)
      vncProcess = null
    })

    vncProcess.on('exit', (code) => {
      console.log(`[vnc] process exited with code ${code}`)
      vncProcess = null
    })

    console.log(`[vnc] started on port ${port}`)
    return true
  } catch (e) {
    console.error('[vnc] start error:', e.message)
    return false
  }
}

export function stopVnc() {
  if (vncProcess) {
    try { vncProcess.kill() } catch {}
    vncProcess = null
    console.log('[vnc] stopped')
  }
}

export function isVncRunning() {
  return vncProcess !== null
}

export function setVendor(vendor) {
  currentVendor = vendor
}

export function getVendor() {
  return currentVendor
}
