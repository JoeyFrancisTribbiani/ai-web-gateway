import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  registerAgent,
  removeAgent,
  getAgent,
  getAllAgents,
  getOnlineAgents,
  findSyncAgent,
  findVideoAgent,
  updateHeartbeat,
  setAgentBusy,
  setAgentIdle,
  markAgentOffline,
  checkHeartbeats,
  getLoginStatusMatrix,
} from '../lib/agentPool.js'

// mock WebSocket (agentPool 只用到 readyState === OPEN 和 send/close)
function mockWs() {
  return {
    readyState: 1, // WebSocket.OPEN
    sent: [],
    send(data) { this.sent.push(data) },
    close() {},
  }
}

let agentCounter = 0

function createAgent(vendors = ['chatgpt'], options = {}) {
  agentCounter++
  const id = `test-agent-${agentCounter}`
  const ws = mockWs()
  registerAgent(ws, {
    agentId: id,
    vendors,
    maxTabs: options.maxTabs || 8,
  })
  return id
}

// 每个测试前清理所有 agent
beforeEach(() => {
  for (const agent of getAllAgents()) {
    removeAgent(agent.agentId)
  }
})

describe('AgentInfo 属性', () => {
  test('注册后属性正确', () => {
    const id = createAgent(['chatgpt', 'claude'])
    const agent = getAgent(id)
    assert.equal(agent.agentId, id)
    assert.deepEqual(agent.vendors, ['chatgpt', 'claude'])
    assert.equal(agent.status, 'idle')
    assert.equal(agent.activeTabs, 0)
    assert.equal(agent.maxTabs, 8)
    assert.equal(agent.taskCount, 0)
    assert.equal(agent.currentTask, null)
  })

  test('canTakeSyncTask — idle 时为 true', () => {
    const id = createAgent()
    assert.equal(getAgent(id).canTakeSyncTask, true)
  })

  test('canTakeSyncTask — busy 时为 false', () => {
    const id = createAgent()
    setAgentBusy(id, { requestId: 'r1', vendor: 'chatgpt' })
    assert.equal(getAgent(id).canTakeSyncTask, false)
  })

  test('canTakeVideoTask — 受 maxTabs 限制', () => {
    const id = createAgent(['kling'], { maxTabs: 2 })
    const agent = getAgent(id)
    assert.equal(agent.canTakeVideoTask, true)
    agent.activeTabs = 2
    assert.equal(agent.canTakeVideoTask, false)
  })

  test('canTakeVideoTask — offline 时为 false', () => {
    const id = createAgent()
    markAgentOffline(id)
    assert.equal(getAgent(id).canTakeVideoTask, false)
  })

  test('isOnline — 新注册 agent 为 true', () => {
    const id = createAgent()
    assert.equal(getAgent(id).isOnline, true)
  })

  test('hasVendor', () => {
    const id = createAgent(['chatgpt', 'claude'])
    const agent = getAgent(id)
    assert.equal(agent.hasVendor('chatgpt'), true)
    assert.equal(agent.hasVendor('claude'), true)
    assert.equal(agent.hasVendor('gemini'), false)
  })

  test('isVendorLoggedIn', () => {
    const id = createAgent(['chatgpt'])
    assert.equal(getAgent(id).isVendorLoggedIn('chatgpt'), false)
    updateHeartbeat(id, { loginStatus: { chatgpt: 'logged_in' } })
    assert.equal(getAgent(id).isVendorLoggedIn('chatgpt'), true)
  })
})

describe('registerAgent', () => {
  test('相同 agentId 替换旧连接', () => {
    const ws1 = mockWs()
    registerAgent(ws1, { agentId: 'dup-id', vendors: ['chatgpt'] })
    const ws2 = mockWs()
    const agent2 = registerAgent(ws2, { agentId: 'dup-id', vendors: ['chatgpt'] })
    assert.equal(getAgent('dup-id'), agent2)
  })

  test('send 方法通过 WebSocket 发送消息', () => {
    const ws = mockWs()
    const agent = registerAgent(ws, { agentId: 'send-test', vendors: ['chatgpt'] })
    agent.send({ type: 'test', data: 'hello' })
    assert.equal(ws.sent.length, 1)
    assert.equal(JSON.parse(ws.sent[0]).data, 'hello')
  })

  test('WebSocket 未连接时 send 返回 false', () => {
    const ws = mockWs()
    ws.readyState = 3 // CLOSED
    const agent = registerAgent(ws, { agentId: 'closed-ws', vendors: ['chatgpt'] })
    assert.equal(agent.send({ type: 'test' }), false)
  })
})

describe('findSyncAgent', () => {
  test('找到空闲且已登录的 agent', () => {
    const id = createAgent(['chatgpt'])
    updateHeartbeat(id, { loginStatus: { chatgpt: 'logged_in' } })
    const agent = findSyncAgent('chatgpt')
    assert.ok(agent)
    assert.equal(agent.agentId, id)
  })

  test('无可用 agent 时返回 null', () => {
    assert.equal(findSyncAgent('nonexistent-vendor'), null)
  })

  test('跳过未登录的 agent', () => {
    createAgent(['claude'])
    // 未设置 loginStatus → 未登录
    assert.equal(findSyncAgent('claude'), null)
  })

  test('选择 lastTaskAt 最早的 agent', () => {
    const id1 = createAgent(['chatgpt'])
    updateHeartbeat(id1, { loginStatus: { chatgpt: 'logged_in' } })

    const id2 = createAgent(['chatgpt'])
    updateHeartbeat(id2, { loginStatus: { chatgpt: 'logged_in' } })

    // 让 id1 先执行任务 (lastTaskAt 变为 Date.now())
    // 让 id2 保持刚注册状态 (lastTaskAt = 0)
    setAgentBusy(id1, { requestId: 'r1', vendor: 'chatgpt' })
    setAgentIdle(id1)

    // findSyncAgent 选 lastTaskAt 最早的 → id2 (lastTaskAt=0)
    const agent = findSyncAgent('chatgpt')
    assert.equal(agent.agentId, id2)
  })
})

describe('findVideoAgent', () => {
  test('找到有 tab 容量的已登录 agent', () => {
    const id = createAgent(['kling'])
    updateHeartbeat(id, { loginStatus: { kling: 'logged_in' } })
    const agent = findVideoAgent('kling')
    assert.ok(agent)
    assert.equal(agent.agentId, id)
  })

  test('跳过未登录的 agent', () => {
    createAgent(['kling'])
    assert.equal(findVideoAgent('kling'), null)
  })
})

describe('setAgentBusy / setAgentIdle', () => {
  test('idle → busy → idle 状态转换', () => {
    const id = createAgent()
    setAgentBusy(id, { requestId: 'r1', vendor: 'chatgpt' })
    const busy = getAgent(id)
    assert.equal(busy.status, 'busy')
    assert.equal(busy.currentTask.requestId, 'r1')
    assert.equal(busy.taskCount, 1)

    setAgentIdle(id)
    const idle = getAgent(id)
    assert.equal(idle.status, 'idle')
    assert.equal(idle.currentTask, null)
  })

  test('保留 polling 状态', () => {
    const id = createAgent()
    updateHeartbeat(id, { status: 'idle+polling' })
    setAgentBusy(id, { requestId: 'r1', vendor: 'chatgpt' })
    assert.equal(getAgent(id).status, 'busy+polling')
    setAgentIdle(id)
    assert.equal(getAgent(id).status, 'idle+polling')
  })
})

describe('checkHeartbeats', () => {
  test('心跳超时后标记为 offline', () => {
    const id = createAgent()
    const agent = getAgent(id)
    // 设 lastSeen 为 31 秒前 (HEARTBEAT_TIMEOUT = 30s)
    agent.lastSeen = Date.now() - 31000
    const offline = checkHeartbeats()
    assert.ok(offline.includes(id))
    assert.equal(getAgent(id).status, 'offline')
  })

  test('未超时的 agent 不被标记', () => {
    const id = createAgent()
    // lastSeen 是当前时间 (刚注册)
    const offline = checkHeartbeats()
    assert.ok(!offline.includes(id))
    assert.notEqual(getAgent(id).status, 'offline')
  })
})

describe('updateHeartbeat', () => {
  test('更新 status, activeTabs, loginStatus, resources', () => {
    const id = createAgent()
    updateHeartbeat(id, {
      status: 'busy',
      activeTabs: 3,
      videoPollingCount: 1,
      loginStatus: { chatgpt: 'logged_in' },
      resources: { chromeMemoryMB: 500, chromeCpuPercent: 30, tabCount: 3 },
    })
    const agent = getAgent(id)
    assert.equal(agent.status, 'busy')
    assert.equal(agent.activeTabs, 3)
    assert.equal(agent.videoPollingCount, 1)
    assert.equal(agent.loginStatus.chatgpt, 'logged_in')
    assert.equal(agent.resources.chromeMemoryMB, 500)
  })

  test('loginStatus 是合并而非替换', () => {
    const id = createAgent(['chatgpt', 'claude'])
    updateHeartbeat(id, { loginStatus: { chatgpt: 'logged_in' } })
    updateHeartbeat(id, { loginStatus: { claude: 'logged_in' } })
    const agent = getAgent(id)
    assert.equal(agent.loginStatus.chatgpt, 'logged_in')
    assert.equal(agent.loginStatus.claude, 'logged_in')
  })
})

describe('getLoginStatusMatrix', () => {
  test('返回所有 agent 的登录状态', () => {
    const id = createAgent(['chatgpt'])
    updateHeartbeat(id, { loginStatus: { chatgpt: 'logged_in' } })
    const matrix = getLoginStatusMatrix()
    assert.ok(matrix[id])
    assert.equal(matrix[id].loginStatus.chatgpt, 'logged_in')
    assert.deepEqual(matrix[id].vendors, ['chatgpt'])
    assert.ok(matrix[id].isOnline)
  })
})

describe('removeAgent', () => {
  test('移除后不再可获取', () => {
    const id = createAgent()
    removeAgent(id)
    assert.equal(getAgent(id), undefined)
  })
})
