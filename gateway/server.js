import http from 'http'
import net from 'net'
import { WebSocketServer, WebSocket } from 'ws'
import { URL } from 'url'

import * as config from './lib/config-loader.js'
import * as agentPool from './lib/agentPool.js'
import * as scheduler from './lib/scheduler.js'
import { cleanupOnStartup } from './lib/taskStore.js'
import { startCleanup as startFileCleanup } from './lib/fileStore.js'
import { startAlertEngine } from './lib/alerts.js'
import { checkHeartbeats, getVncInfo, clearVncInfo } from './lib/agentPool.js'

import { handleChat } from './routes/chat.js'
import { handleImages } from './routes/images.js'
import { handleVideoGenerate, handleVideoStatus, handleVideoCancel } from './routes/videos.js'
import { handleModels } from './routes/models.js'
import { handleHealth } from './routes/health.js'
import { handleFileUpload, handleFileDownload } from './routes/files.js'
import { handleAdmin } from './routes/admin.js'

const PORT = parseInt(process.env.PORT || '26669', 10)
const API_KEY = process.env.API_KEY || 'changeme'
const AGENT_TOKEN = process.env.AGENT_TOKEN || 'agent-secret'

// 全局兜底：防止 unhandled rejection 崩溃进程
process.on('unhandledRejection', (reason, promise) => {
  console.error('[gateway] unhandled rejection:', reason?.message || reason)
})
process.on('uncaughtException', (err) => {
  console.error('[gateway] uncaught exception:', err.message)
})

// ===== 初始化 =====
config.init()
// Redis 启动清理，5s 超时防止 Redis 不可用时永久挂起
await Promise.race([
  cleanupOnStartup(),
  new Promise(resolve => setTimeout(resolve, 5000))
])
startFileCleanup()
startAlertEngine()

// 心跳检测
setInterval(() => {
  const offline = checkHeartbeats()
  for (const agentId of offline) {
    scheduler.handleAgentDisconnect(agentId).catch(e => console.error(`[gateway] disconnect cleanup error: ${e.message}`))
  }
}, 15 * 1000)

// ===== HTTP 服务器 =====
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const path = url.pathname
  const method = req.method

  // CORS
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    })
    return res.end()
  }
  res.setHeader('Access-Control-Allow-Origin', '*')

  try {
    // ===== 健康检查（无需鉴权）=====
    if (path === '/health' && method === 'GET') return await handleHealth(req, res)

    // ===== 文件下载（无需鉴权）=====
    if (path.startsWith('/files/') && method === 'GET' && !path.startsWith('/files/upload')) {
      return handleFileDownload(req, res, path.replace('/files/', ''))
    }

    // ===== Agent 文件上传（AGENT_TOKEN 鉴权）=====
    if (path === '/files/upload' && method === 'POST') {
      if (!checkAgentToken(req)) return json(res, 401, { error: 'unauthorized' })
      return await handleFileUpload(req, res)
    }

    // ===== 管理后台页面（API_KEY Cookie 鉴权）=====
    if (path === '/admin' && method === 'GET') {
      return await handleAdmin(req, res, path, method, null, req.socket.remoteAddress)
    }

    // ===== API 端点（API_KEY 鉴权）=====
    if (path.startsWith('/v1/') || path.startsWith('/admin/')) {
      if (!checkApiKey(req)) return json(res, 401, { error: 'unauthorized' })

      // 读取请求体
      let body = {}
      if (method === 'POST' || method === 'PUT') {
        body = await readBody(req)
      }

      // 路由
      if (path === '/v1/chat/completions' && method === 'POST') return await handleChat(req, res, body)
      if (path === '/v1/images/generations' && method === 'POST') return await handleImages(req, res, body)
      if (path === '/v1/videos/generations' && method === 'POST') return await handleVideoGenerate(req, res, body)
      if (path.startsWith('/v1/videos/') && path.endsWith('/cancel') && method === 'POST') {
        const taskId = path.replace('/v1/videos/', '').replace('/cancel', '')
        return await handleVideoCancel(req, res, taskId)
      }
      if (path.startsWith('/v1/videos/') && method === 'GET') return await handleVideoStatus(req, res, path.replace('/v1/videos/', ''))
      if (path === '/v1/models' && method === 'GET') return handleModels(req, res)
      if (path.startsWith('/admin/')) return await handleAdmin(req, res, path, method, body, req.socket.remoteAddress)

      return json(res, 404, { error: 'not found' })
    }

    return json(res, 404, { error: 'not found' })
  } catch (err) {
    console.error('[server] error:', err)
    json(res, 500, { error: err.message })
  }
})

// ===== WebSocket 服务器（Agent 连接）=====
const wss = new WebSocketServer({ server, path: '/agent' })

wss.on('connection', (ws, req) => {
  // 鉴权
  const url = new URL(req.url, 'http://localhost')
  const token = url.searchParams.get('token')
  if (token !== AGENT_TOKEN) {
    ws.close(4001, 'unauthorized')
    return
  }

  let agentId = null

  ws.on('message', (data) => {
    let msg
    try { msg = JSON.parse(data.toString()) } catch { return }

    switch (msg.type) {
      case 'register': {
        agentId = msg.agentId
        const agent = agentPool.registerAgent(ws, msg)
        console.log(`[ws] agent registered: ${agentId}`)
        break
      }
      case 'heartbeat': {
        if (agentId) agentPool.updateHeartbeat(agentId, msg)
        break
      }
      case 'login_status': {
        // Agent 上报登录状态变化 + VNC 连接信息
        console.log(`[ws] login_status: ${msg.agentId} ${msg.vendor} ${msg.status} vncPort=${msg.vncPort || 'N/A'}`)
        if (agentId) {
          if (msg.vncPort && msg.vncHost) {
            agentPool.setVncInfo(agentId, msg.vncHost, msg.vncPort)
          } else {
            clearVncInfo(agentId)
          }
        }
        break
      }
      default: {
        // 任务相关消息 → 路由到 scheduler
        if (agentId) scheduler.handleAgentMessage(agentId, msg)
      }
    }
  })

  ws.on('close', () => {
    if (agentId) {
      // 校验：当前 agentPool 中的 ws 是否还是这个连接
      // 如果 agent 已用新 ws 重连，旧 ws 的 close 事件应忽略
      const currentAgent = agentPool.getAgent(agentId)
      if (currentAgent && currentAgent.ws !== ws) {
        console.log(`[ws] ignoring stale close for ${agentId} (already reconnected)`)
        return
      }
      console.log(`[ws] agent disconnected: ${agentId}`)
      scheduler.handleAgentDisconnect(agentId).catch(e => console.error(`[gateway] disconnect error: ${e.message}`))
    }
  })

  ws.on('error', (err) => {
    console.error(`[ws] agent ${agentId} error:`, err.message)
  })
})

// ===== noVNC WebSocket 代理（浏览器 → Gateway → Agent VNC）=====
const novncWss = new WebSocketServer({ server, path: '/novnc' })

novncWss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost')
  const token = url.searchParams.get('token')
  const agentId = url.searchParams.get('agent')

  // API_KEY 鉴权
  if (token !== API_KEY) {
    ws.close(4001, 'unauthorized')
    return
  }

  const vnc = getVncInfo(agentId)
  if (!vnc) {
    ws.close(4002, 'vnc not available')
    return
  }

  // 连接 Agent 的 VNC (RFB) 端口
  const vncSocket = net.connect(vnc.port, vnc.host, () => {
    console.log(`[novnc] connected to ${vnc.host}:${vnc.port} for ${agentId}`)
  })

  vncSocket.on('error', (err) => {
    console.error(`[novnc] tcp error: ${err.message}`)
    ws.close(4003, 'vnc connection failed')
  })

  // VNC → 浏览器
  vncSocket.on('data', (data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data)
  })

  vncSocket.on('close', () => {
    if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'vnc closed')
  })

  // 浏览器 → VNC
  ws.on('message', (data) => {
    if (!vncSocket.destroyed) vncSocket.write(data)
  })

  ws.on('close', () => {
    if (!vncSocket.destroyed) vncSocket.destroy()
    console.log(`[novnc] session closed for ${agentId}`)
  })
})

// ===== 启动 =====
server.listen(PORT, () => {
  console.log(`[gateway] listening on :${PORT}`)
  console.log(`[gateway] API_KEY: ${API_KEY ? 'set' : 'NOT SET'}`)
  console.log(`[gateway] AGENT_TOKEN: ${AGENT_TOKEN ? 'set' : 'NOT SET'}`)
  console.log(`[gateway] PUBLIC_URL: ${process.env.PUBLIC_URL || 'http://localhost:26669'}`)
})

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('[gateway] SIGTERM received, shutting down...')
  server.close(() => { console.log('[gateway] closed'); process.exit(0) })
  setTimeout(() => process.exit(0), 5000)  // 5s 强制退出
})
process.on('SIGINT', () => {
  console.log('[gateway] SIGINT received, shutting down...')
  server.close(() => { console.log('[gateway] closed'); process.exit(0) })
  setTimeout(() => process.exit(0), 5000)
})

// ===== 工具函数 =====
function checkApiKey(req) {
  const auth = req.headers.authorization || ''
  const token = auth.replace('Bearer ', '')
  return token === API_KEY
}

function checkAgentToken(req) {
  const auth = req.headers.authorization || ''
  const token = auth.replace('Bearer ', '')
  return token === AGENT_TOKEN
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    const MAX_BODY = 50 * 1024 * 1024  // 50MB
    req.on('data', c => {
      size += c.length
      if (size > MAX_BODY) { req.destroy(); resolve({}); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')) }
      catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

function json(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}
