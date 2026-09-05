import { WebSocket } from 'ws'

const GATEWAY_URL = process.env.GATEWAY_URL || 'ws://gateway:26669/agent'
const AGENT_TOKEN = process.env.AGENT_TOKEN || 'agent-secret'
const RECONNECT_INTERVAL = 3000

let ws = null
let connected = false
let onMessageHandler = null
let onReconnectHandler = null
let isFirstConnect = true

export function connect(onMessage, onReconnect) {
  onMessageHandler = onMessage
  onReconnectHandler = onReconnect

  const url = `${GATEWAY_URL}?token=${AGENT_TOKEN}`
  console.log(`[ws] connecting to ${GATEWAY_URL}...`)

  ws = new WebSocket(url)

  ws.on('open', () => {
    connected = true
    console.log('[ws] connected')
    // 重连后重发积压消息
    if (!isFirstConnect) flushPendingMessages()
    if (!isFirstConnect && onReconnectHandler) {
      onReconnectHandler()
    }
    isFirstConnect = false
  })

  ws.on('message', (data) => {
    let msg
    try { msg = JSON.parse(data.toString()) } catch { return }
    if (onMessageHandler) {
      Promise.resolve(onMessageHandler(msg)).catch(e => {
        console.error('[ws] handler error:', e.message)
      })
    }
  })

  let reconnectTimer = null
  ws.on('close', (code, reason) => {
    connected = false
    console.log(`[ws] disconnected: ${code} ${reason}`)
    if (reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect(onMessageHandler, onReconnectHandler)
    }, RECONNECT_INTERVAL)
  })

  ws.on('error', (err) => {
    console.error('[ws] error:', err.message)
  })
}

// 断线期间待发送的消息队列
const pendingMessages = []

export function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
    return true
  }
  console.log(`[ws] send failed (not connected), message queued: ${msg.type}`)
  // WebSocket 断开时，将消息存入待发队列，重连后自动重发
  pendingMessages.push(msg)
  return false
}

// 重连后重发积压消息
function flushPendingMessages() {
  while (pendingMessages.length > 0) {
    const msg = pendingMessages.shift()
    if (ws && ws.readyState === WebSocket.OPEN) {
      console.log(`[ws] flushing queued message: ${msg.type}`)
      ws.send(JSON.stringify(msg))
    } else {
      // 又断了，放回队列
      pendingMessages.unshift(msg)
      break
    }
  }
}

export function isConnected() {
  return connected
}
