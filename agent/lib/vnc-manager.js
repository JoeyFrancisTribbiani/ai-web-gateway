import { spawn } from 'child_process'
import { createConnection } from 'net'

let vncProcess = null
let currentVendor = null

export async function startVnc(displayNum, port) {
  if (vncProcess) return true  // 已在运行

  return new Promise((resolve) => {
    let resolved = false
    const done = (ok) => { if (!resolved) { resolved = true; resolve(ok) } }

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
        done(false)
      })

      vncProcess.on('exit', (code) => {
        console.log(`[vnc] process exited with code ${code}`)
        vncProcess = null
        done(false)
      })

      // 轮询等待端口就绪 (最多等 5s)
      let attempts = 0
      const checkPort = () => {
        if (!vncProcess) return  // 进程已退出
        const sock = createConnection(port, '127.0.0.1', () => {
          sock.destroy()
          console.log(`[vnc] ready on port ${port}`)
          done(true)
        })
        sock.on('error', () => {
          attempts++
          if (attempts > 50) {
            console.error('[vnc] port not ready after 5s')
            done(false)
          } else {
            setTimeout(checkPort, 100)
          }
        })
      }
      setTimeout(checkPort, 200)
    } catch (e) {
      console.error('[vnc] start error:', e.message)
      done(false)
    }
  })
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
