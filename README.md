# ai-web-gateway

网页端 AI 服务的分布式网关。通过 Playwright 自动化操作各厂商网页端 AI（ChatGPT、Claude、Gemini、豆包、即梦、Kling 等），对外暴露 OpenAI 兼容 API。作为 [new-api](https://github.com/Calcium-Ion/new-api) 的自定义渠道接入。

## 功能特性

- **三种任务类型**：对话（SSE 流式）、图片生成（同步）、视频生成（异步提交+轮询）
- **多厂商共享 Agent**：一个 Chrome 实例开多个 tab 登录不同厂商，`--scale` 扩展并发
- **文件上传**：用户请求中的图片由 Gateway 保存为临时文件，Agent 下载后通过 Playwright 上传到网页端 AI
- **选择器热加载**：DOM 选择器存储在 YAML 中，修改后 60s 自动生效，无需重新部署
- **管理后台**：仪表盘、Agent 监控、登录状态矩阵、配置在线编辑、选择器版本回滚、告警通知
- **代理分流**：Chrome 配置一个代理地址，由 Clash 等代理服务器按域名分流国内外网络

## 架构

```
用户 → new-api → ai-web-gateway → Agent(Chrome) → 网页端 AI
                    ↓                         ↑
                 Redis              文件上传回 Gateway
```

| 组件 | 说明 |
|------|------|
| **Gateway** (:26669) | HTTP API + WebSocket 服务，调度引擎，文件存储，Redis 任务状态，管理后台 |
| **Agent** | Chrome + Playwright 自动化，多厂商多 tab，WebSocket 连接 Gateway |
| **Redis** | 视频任务状态存储，审计日志，TTL 24h 自动过期 |

## 快速开始

### 单机部署

```bash
# 1. 克隆项目
git clone <repo-url> ai-web-gateway
cd ai-web-gateway

# 2. 一键安装 Gateway + Redis
./install-gateway.sh \
  --api-key=your-api-key \
  --agent-token=your-agent-token \
  --public-url=http://your-server:26669

# 3. 一键安装 Agent（同一台机器）
./install-agent.sh \
  --gateway=ws://gateway:26669/agent \
  --token=your-agent-token \
  --config-url=http://gateway:26669

# 4. 打开管理后台登录各厂商账号
# 浏览器访问 http://your-server:26669/admin
```

### 从源码构建

```bash
# 不使用预构建镜像，从源码构建
./install-gateway.sh \
  --api-key=your-api-key \
  --agent-token=your-agent-token \
  --public-url=http://your-server:26669 \
  --build

./install-agent.sh \
  --gateway=ws://gateway:26669/agent \
  --token=your-agent-token \
  --build
```

### 分布式部署

```bash
# 服务器 A：Gateway + Redis
./install-gateway.sh \
  --api-key=xxx \
  --agent-token=xxx \
  --public-url=http://serverA:26669

# 服务器 B：Agent (3 实例，国外厂商)
./install-agent.sh \
  --gateway=ws://serverA:26669/agent \
  --token=xxx \
  --vendors=chatgpt,claude,gemini \
  --proxy=http://clash:7890 \
  --scale=3

# 服务器 C：Agent (2 实例，国内厂商)
./install-agent.sh \
  --gateway=ws://serverA:26669/agent \
  --token=xxx \
  --vendors=doubao,jimeng,kling \
  --scale=2
```

### 扩缩容

```bash
cd /opt/ai-web-agent
docker compose up -d --scale agent=5   # 扩展到 5 个实例
docker compose up -d --scale agent=2   # 缩容到 2 个
```

## 首次登录

部署后需要通过管理后台登录各 AI 厂商账号：

1. 浏览器打开 `http://your-server:26669/admin`，输入 API_KEY
2. 进入「账号管理」页面，看到登录状态矩阵（红=未登录，绿=已登录）
3. 点击红色格子「登录」按钮 → Gateway 指示 Agent 开启 VNC
4. 在 VNC 中手动登录对应厂商
5. Agent 检测到登录成功 → 矩阵变绿 → 自动关闭 VNC

登录态保存在 Docker volume 中，重启后自动恢复。Cookie 过期后矩阵再次变红。

## new-api 集成

### 1. 添加自定义渠道类型

在 new-api 源码中新增渠道类型 "Web AI"，relay 逻辑为原样透传：

| 文件 | 修改内容 |
|------|---------|
| `constant/channel_type.go` | 添加 `WebAI` 常量 |
| `relay/relay.go` | 添加路由，支持 `/v1/chat/completions`、`/v1/images/generations`、`/v1/videos/generations`、`/v1/videos/:id` |
| `relay/webai/` | 新增透传 relay 逻辑 |
| 前端渠道配置页 | 添加 WebAI 选项 |

### 2. 配置渠道

```
类型:       Web AI
Base URL:   http://ai-web-gateway:26669
密钥:       <与 API_KEY 一致>
模型:       gpt-4o-web,gpt-4o-mini-web,claude-sonnet-web,gemini-pro-web,doubao-pro-web,
            jimeng-image-web,gemini-image-web,kling-video-web,jimeng-video-web
```

一个渠道覆盖所有模型和任务类型。

## API 端点

### 对话

```bash
curl http://your-server:26669/v1/chat/completions \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-web",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

支持 `image_url` 类型的 content（图片上传到网页端 AI）：

```json
{
  "model": "gpt-4o-web",
  "messages": [{
    "role": "user",
    "content": [
      {"type": "text", "text": "这张图里是什么？"},
      {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,..."}}
    ]
  }]
}
```

### 图片生成

```bash
curl http://your-server:26669/v1/images/generations \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"model": "jimeng-image-web", "prompt": "画一只猫", "size": "1024x1024"}'
```

### 视频生成（异步）

```bash
# 提交
curl http://your-server:26669/v1/videos/generations \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"model": "kling-video-web", "prompt": "日落延时摄影", "duration": 5}'

# 轮询
curl http://your-server:26669/v1/videos/task-xxx \
  -H "Authorization: Bearer your-api-key"

# 取消
curl -X POST http://your-server:26669/v1/videos/task-xxx/cancel \
  -H "Authorization: Bearer your-api-key"
```

## 管理后台

浏览器访问 `http://your-server:26669/admin`：

| 页面 | 功能 |
|------|------|
| 仪表盘 | Agent 在线数、各厂商请求数/成功率/耗时、视频队列 |
| Agent | 每个 Agent 的状态、标签页、内存、当前任务，可重启 |
| 账号管理 | Agent × 厂商登录状态矩阵，点击登录开启 VNC 引导 |
| 配置编辑 | 在线编辑 YAML（selectors/models/vendors），选择器版本回滚 |
| 任务历史 | 最近 100 条同步任务 |
| 视频任务 | 视频任务列表，可手动取消 |

### 告警

通过 Webhook 推送告警（企业微信/钉钉/Slack）：

```env
ALERT_WEBHOOK=https://qyapi.weixin.com/cgi-bin/webhook/send?key=xxx
```

| 告警条件 | 级别 |
|---------|------|
| Agent 离线 | 严重 |
| 厂商登录态全部过期 | 严重 |
| 5 分钟内错误率 > 50% | 严重 |
| 5 分钟内错误率 > 30% | 警告 |
| Agent 内存 > 800MB | 警告 |
| 视频任务排队 > 5 个 | 警告 |

## 配置文件

### config/models.yaml — 模型路由表

```yaml
models:
  - name: gpt-4o-web
    vendor: chatgpt
    taskType: chat
    rateLimit:
      qps: 0.5
      concurrency: 3

  - name: kling-video-web
    vendor: kling
    taskType: video
    rateLimit:
      qps: 0.1
      concurrency: 4
```

### config/vendors.yaml — 厂商能力声明

```yaml
vendors:
  chatgpt:
    url: https://chatgpt.com
    capabilities: [chat]
    adapter: chatgpt.js
  # ...
```

### config/selectors.yaml — DOM 选择器（热加载）

```yaml
chatgpt:
  input: "#prompt-textarea"
  sendButton: "button[data-testid='send-button']"
  stopButton: "button[data-testid='stop-button']"
  loginCheck:
    loggedIn: "#prompt-textarea"
    loggedOut: "button[data-testid='login-button']"
  rateLimitIndicators: ["You've reached", "rate limit"]
```

## 新增厂商

1. `config/models.yaml` 添加模型（name + vendor + taskType）
2. `config/vendors.yaml` 添加厂商（url + capabilities + adapter）
3. `config/selectors.yaml` 添加 DOM 选择器（含 loginCheck）
4. 编写 `agent/adapters/newvendor.js`（实现 navigate/sendPrompt/streamResponse 等方法）
5. 重启 Agent

适配器接口按任务类型分三层：

```javascript
// 对话
export default {
  async navigate(page, selectors) { /* 导航到新对话 */ },
  async uploadFile(page, filePath, selectors) { /* 上传文件到网页端 */ },
  async sendPrompt(page, prompt, selectors) { /* 输入并发送 */ },
  async streamResponse(page, onChunk, selectors, signal) { /* 轮询 DOM 增量文本 */ },
  async checkRateLimit(page, selectors) { /* 检测限额 */ },
}
```

## 环境变量

### Gateway (.env.gateway)

| 变量 | 默认值 | 说明 |
|------|--------|------|
| API_KEY | changeme | 调用方鉴权密钥 |
| AGENT_TOKEN | agent-secret | Agent 鉴权令牌 |
| PUBLIC_URL | http://localhost:26669 | 外部可访问地址（文件 URL） |
| REDIS_URL | redis://redis:6379 | Redis 连接地址 |
| AGENT_TIMEOUT | 180000 | 同步请求超时（ms） |
| QUEUE_TIMEOUT | 120000 | 同步排队超时（ms） |
| VIDEO_QUEUE_TIMEOUT | 600000 | 视频排队超时（ms） |
| VIDEO_TIMEOUT | 1800000 | 视频生成超时（ms） |
| ALERT_WEBHOOK | | 告警 Webhook 地址 |

### Agent (.env.agent)

| 变量 | 默认值 | 说明 |
|------|--------|------|
| GATEWAY_URL | ws://gateway:26669/agent | Gateway WebSocket 地址 |
| AGENT_TOKEN | agent-secret | 鉴权令牌（与 Gateway 一致） |
| VENDORS | all | 加载的厂商列表 |
| MAX_TASKS_PER_CONTEXT | 5 | 资源回收周期（每 N 请求重启 Chrome） |
| MAX_TABS | 8 | 最大标签页数 |
| HTTP_PROXY | | 代理地址（Clash 分流） |

## 项目结构

```
ai-web-gateway/
├── gateway/                    # 网关服务
│   ├── server.js               # HTTP + WebSocket 主入口
│   ├── public/admin.html       # 管理后台单页应用
│   ├── lib/                    # 12 个模块（调度/连接池/Redis/文件/统计/告警/...）
│   └── routes/                 # 7 个路由（chat/images/videos/models/files/health/admin）
├── agent/                      # Agent 服务
│   ├── agent.js                # 主入口（多厂商加载/任务分发/心跳）
│   ├── adapters/               # 9 个适配器（3 基类 + 6 厂商）
│   └── lib/                    # 12 个模块（Chrome/WS/文件/轮询/登录/VNC/...）
├── config/                     # YAML 配置（热加载）
├── install-gateway.sh          # Gateway 一键安装
├── install-agent.sh            # Agent 一键安装
├── docker-compose.yml          # 单机部署
├── docker-compose.gateway.yml  # 仅 Gateway（分布式）
├── docker-compose.agent.yml    # 仅 Agent（分布式）
└── .github/workflows/build.yml # CI/CD 构建推送镜像
```

## 技术栈

- **Gateway**: Node.js 20 + ws (WebSocket) + ioredis + formidable
- **Agent**: Node.js 20 + Playwright (Chromium) + ws
- **浏览器**: Chrome 有头模式 + Xvfb 虚拟显示 + x11vnc 远程登录
- **存储**: Redis（视频任务状态，TTL 24h）
- **部署**: Docker Compose，支持 `--scale` 水平扩展

## 性能预期

| 指标 | 对话 | 图片 | 视频 |
|------|------|------|------|
| 耗时 | 10-180s | 30-180s | 3-30min |
| 单 Agent 并发 | 1 同步 | 1 同步 | 1 同步 + 2 视频轮询 |
| Agent 内存 | 500MB-1G | 500MB-1G | 500MB-1G |
| 资源回收 | 每 5 请求 | 每 5 请求 | 每 5 请求 |

3 个 Agent（~3GB 内存）= 3 个同步并发 + 6 个视频轮询并发。

## License

MIT
