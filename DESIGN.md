# ai-web-gateway 设计方案

> 网页端 AI 服务的分布式网关，作为 new-api 的自定义渠道接入。
> 支持对话、图片生成、视频生成三种任务类型，可扩展至任意网页端 AI 厂商。

## 1. 项目定位

ai-web-gateway 是一个部署在服务器上的 AI 服务网关。它管理多个 Chrome 浏览器实例，通过 Playwright 自动化操作各厂商的网页端 AI，对外暴露 OpenAI 兼容的 API 端点。new-api 将其配置为一个自定义渠道，用户的请求经 new-api 路由到此网关，网关调度空闲的 Chrome 实例执行网页操作，将结果返回。

### 支持的任务类型

| 类型 | 模式 | 典型厂商 | 耗时 | API 端点 |
|------|------|---------|------|---------|
| 对话 | 同步 SSE 流式 | ChatGPT / Claude / Gemini / 豆包 | 10-180s | `/v1/chat/completions` |
| 图片生成 | 同步等待 | 即梦 / Gemini | 30-180s | `/v1/images/generations` |
| 视频生成 | 异步提交+轮询 | Kling / 即梦视频 | 3-30min | `/v1/videos/generations` + `/v1/videos/:id` |

### 核心原则

- **同步+异步混合**：对话和图片用同步请求-响应（SSE/长连接），视频用异步提交+轮询。
- **容错交给 new-api**：不做限额调度、不做任务恢复。Agent 限额返回 429、崩溃返回 502、超时返回 504——new-api 自身具备渠道重试、故障切换能力。
- **视频异步不阻塞**：视频生成提交后 Agent 开新标签页后台轮询，不独占 Agent，期间可继续处理对话/图片请求。
- **多厂商共享 Agent**：一个 Agent 加载所有厂商适配器，Chrome 开多个 tab 登录不同厂商。一个 Agent 服务所有厂商，通过 `--scale` 扩展 Agent 数量提升并发。代理分流（如 Clash）解决国内外网络路由。
- **文件 URL 而非 base64**：图片和视频文件通过 HTTP 上传到 Gateway 存储，返回 URL。WebSocket 只传 URL，不传 base64。
- **请求文件传递**：用户请求中的图片/文件由 Gateway 保存为临时文件，Agent 通过 HTTP 下载后用 Playwright 上传到网页端 AI。
- **无状态会话**：每次请求开新对话，不做对话上下文复用。
- **选择器配置化**：各厂商的 DOM 选择器存储在 YAML 配置文件中，Agent 运行时热加载，DOM 变化时无需重新部署代码。
- **适配器按任务类型分层**：对话/图片/视频的操作流程差异巨大，不能用单一接口覆盖。每种类型独立接口，按 vendor 实现。

## 2. 架构总览

```
┌──────────────────────────────────────────────────────────────┐
│                        new-api (自定义渠道)                    │
│   用户请求 → 渠道路由 → 转发到 ai-web-gateway                   │
│   ← SSE 流式 / 图片URL / 视频task_id+轮询 / 错误重试 / 渠道切换  │
└──────────────────────────┬───────────────────────────────────┘
                           │ HTTP (OpenAI 兼容格式)
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                    ai-web-gateway (:26669)                     │
│                                                               │
│  ┌─────────────┐  ┌────────────────┐  ┌───────────────────┐ │
│  │ API 层      │  │ 调度引擎        │  │ 适配器注册表       │ │
│  │             │→ │                │→ │ (在 Agent 侧)     │ │
│  │ /v1/chat    │  │ 模型→vendor路由 │  │ chatgpt (chat)    │ │
│  │ /v1/images  │  │ Agent 选择     │  │ claude  (chat)    │ │
│  │ /v1/videos  │  │ 超时控制       │  │ gemini  (chat+img)│ │
│  │ /v1/models  │  │ 端点匹配校验   │  │ doubao  (chat)    │ │
│  │ /files/*    │  │                │  │ jimeng  (img+vid) │ │
│  │ /health     │  │                │  │ kling   (video)   │ │
│  └─────────────┘  └───────┬────────┘  └───────────────────┘ │
│                           │                                   │
│              ┌────────────┼────────────┐                      │
│              │ Agent 连接池│ 文件存储   │                      │
│              │ (WebSocket)│ + Redis    │                      │
│              └────────────┼────────────┘                      │
│             ┌─────────────┼─────────────┐                      │
└─────────────┼─────────────┼─────────────┼─────────────────────┘
         ┌────┴────┐   ┌────┴────┐   ┌────┴────┐
         │ Agent-1 │   │ Agent-2 │   │ Agent-N │
         │ Chrome  │   │ Chrome  │   │ Chrome  │
         │ ↓代理分流 │   │         │   │         │
         │ Tab:GPT  │   │ Tab:GPT │   │ Tab:GPT │
         │ Tab:Claude│  │ Tab:豆包│   │ Tab:Gemini│
         │ Tab:Gemini│  │Tab:即梦 │   │ Tab:Kling│
         │ Tab:豆包  │  │Tab:Kling│   │         │
         │ Tab:即梦  │  │ 视频tab │   │ 视频tab │
         │ Tab:Kling │  │  (↻)   │   │  (↻)   │
         │ 视频tab  │  │         │   │         │
         │  (↻)    │  │         │   │         │
         └─────────┘   └─────────┘   └─────────┘
```

### 通信协议

```
new-api  ──HTTP POST──→  Gateway  ──WebSocket 推送──→  Agent
new-api  ←──SSE/JSON──  Gateway  ←──WebSocket 流式──  Agent
                              ↑↓
                    Agent ⇄ Gateway HTTP:
                      · Agent 上传图片/视频 → POST /files/upload
                      · Agent 下载请求文件 → GET /files/:filename
```

Gateway 与 Agent 之间有三条通道：
- **WebSocket**：任务分发 + 文本流式回传 + 状态上报。只传文本和 URL，不传二进制文件。
- **HTTP 上传**：Agent 提取图片/视频后上传到 Gateway `/files/upload`，获取文件 URL。
- **HTTP 下载**：Agent 从 Gateway `/files/:filename` 下载用户请求中的文件（参考图等），用于上传到网页端 AI。

### 数据流 — 对话（同步，含文件上传）

```
1. new-api → POST /v1/chat/completions
   { model: "gpt-4o-web", messages: [{
       role: "user",
       content: [
         { type: "text", text: "这张图里是什么？" },
         { type: "image_url", image_url: { url: "data:image/jpeg;base64,..." } }
       ]
   }], stream: true }

2. Gateway:
   a. 校验 model taskType=chat 与端点匹配 ✓
    b. 请求文件预处理: 从 messages 中提取 image_url
       → base64 解码保存为 /data/files/input-xxx.jpg
   c. messages 拼接为 prompt: "这张图里是什么？"
      (图片位置标记 [图片已上传]，通过 inputFiles 传递)
   d. 解析 vendor=chatgpt → 找 idle Agent → WebSocket 推送

3. Agent:
   a. 检查 inputFiles → HTTP 下载 input-xxx.jpg 到本地临时文件
   b. 主标签页(对应 vendor 的 tab) 导航 → 开新对话
   c. 适配器 uploadFile(): 通过 + 按钮 → filechooser → setFiles 上传图片
   d. 适配器 sendPrompt(): 输入 prompt → 发送
   e. 适配器 streamResponse(): 轮询 DOM 检测增量文本

4. Agent → Gateway (WebSocket):
   { type: "delta", requestId, text: "这是一只猫" }
   { type: "done", requestId }

5. Gateway → new-api (SSE):
   data: {"choices":[{"delta":{"content":"这是一只猫"}}]}
   data: [DONE]

异常: 限额→429 / 崩溃→502 / 超时→504
```

### 数据流 — 图片生成（同步）

```
1. new-api → POST /v1/images/generations
   { model: "jimeng-image-web", prompt: "画一只猫", n: 1, size: "1024x1024" }

2. Gateway 校验 + 解析 vendor=jimeng → 找 idle Agent → WebSocket 推送

3. Agent:
   导航(即梦 tab) → 设置参数 → 输入 prompt → 点击生成
   → 等待图片出现 → 提取图片 → 保存本地临时文件
   → HTTP POST /files/upload 上传到 Gateway → 获得文件 URL

4. Agent → Gateway (WebSocket):
   { type: "image_result", requestId, imageUrls: ["${PUBLIC_URL}/files/img-xxx.png"] }

5. Gateway → new-api (JSON):
   { created: 1700000000, data: [{ url: "${PUBLIC_URL}/files/img-xxx.png" }] }

异常: 限额→429 / 崩溃→502 / 超时(180s)→504
```

### 数据流 — 视频生成（异步）

```
1. new-api → POST /v1/videos/generations
   { model: "kling-video-web", prompt: "日落延时摄影", duration: 5 }

2. Gateway 校验 + 生成 taskId → Redis 存 { status: "queued" }
   → 找 Agent → WebSocket 推送 { type: "video_task", taskId, prompt, params }

3. Agent (约 30-60s):
   开新标签页 → 导航到 Kling → 设置参数 → 输入 prompt → 点击生成
   → 确认"排队中/生成中" → 立即返回

4. Agent → Gateway: { type: "video_submitted", requestId, taskId }
   Gateway → new-api: { id: taskId, status: "generating" }

5. Agent 后台轮询 (每 15-30s，不独占 Agent):
   { type: "video_progress", taskId, progress: 30 }
   ...
   完成时: Agent 提取视频 → HTTP 上传 → 获得文件 URL
   { type: "video_done", taskId, videoUrl: "${PUBLIC_URL}/files/video-xxx.mp4" }

6. new-api 轮询: GET /v1/videos/task-xxx
   Gateway 从 Redis 返回: { id, status: "completed", video: { url } }

异常: Agent崩溃→Redis标记failed / 超时(30min)→failed
```

## 3. 各层详细设计

### 3.1 API 层

#### 端点

| 方法 | 路径 | 说明 | 鉴权 | 模式 |
|------|------|------|------|------|
| POST | `/v1/chat/completions` | 文本对话，支持 `stream: true` | API_KEY | 同步 SSE |
| POST | `/v1/images/generations` | 图片生成 | API_KEY | 同步等待 |
| POST | `/v1/videos/generations` | 视频生成，提交任务 | API_KEY | 异步 |
| GET | `/v1/videos/:taskId` | 查询视频任务状态 | API_KEY | 异步轮询 |
| GET | `/v1/models` | 返回可用模型列表 | API_KEY | — |
| POST | `/files/upload` | Agent 上传生成的图片/视频 | AGENT_TOKEN | — |
| GET | `/files/:filename` | 文件下载（生成结果 + 请求文件） | 无* | — |
| GET | `/health` | 健康检查 | 无 | — |
| WS | `/agent` | Agent 连接端点 | AGENT_TOKEN | — |

> *文件下载端点不做鉴权。URL 中的随机 ID 不可猜测，作为隐式鉴权。

#### 鉴权

两种鉴权令牌，互不通用：

- **API_KEY**：调用方（new-api）使用，通过 `Authorization: Bearer <API_KEY>` 校验。
- **AGENT_TOKEN**：Agent 进程使用，WebSocket 连接时通过 URL 参数 `ws://gateway:26669/agent?token=<AGENT_TOKEN>` 校验，HTTP 文件上传时通过 `Authorization: Bearer <AGENT_TOKEN>` 校验。

#### 外部访问地址（PUBLIC_URL）

文件 URL 必须使用外部可访问的地址，而非 Docker 内部地址。通过 `PUBLIC_URL` 环境变量配置：

```
PUBLIC_URL=http://your-server.com:26669
→ 文件 URL = http://your-server.com:26669/files/img-xxx.png
```

如果 Gateway 前面有 Nginx 反向代理，`PUBLIC_URL` 填代理后的地址。

#### 模型-端点匹配校验

Gateway 收到请求后，先查 models.yaml 获取 model 的 `taskType`，再校验与请求端点是否匹配：

| 请求端点 | 允许的 taskType | 不匹配返回 |
|---------|---------------|-----------|
| `/v1/chat/completions` | chat | 400 |
| `/v1/images/generations` | image | 400 |
| `/v1/videos/generations` | video | 400 |

未知的 model 名返回 400。

#### 请求文件预处理

对话请求的 `messages` 中可能包含图片/文件（OpenAI `image_url` 格式）。Gateway 在调度前预处理：

1. 遍历 messages 中所有 content，提取 `type: "image_url"` 的条目
2. 如果 `url` 是 `data:image/...;base64,...`：解码保存为 `/data/files/input-{timestamp}-{random6}.{ext}`，inputFiles 放文件名
3. 如果 `url` 是 HTTP(S) URL：直接放入 inputFiles（Agent 直接下载外部 URL，不经 Gateway 中转）
4. 生成 inputFiles 列表（文件名和 URL 混合），通过 WebSocket 任务消息传递给 Agent
5. messages 拼接为 prompt 时，图片位置替换为 `[图片已上传]` 文本标记

Agent 收到 inputFiles 后判断格式：含 `://` 的是外部 URL 直接下载，否则是文件名，用 `GATEWAY_URL` 拼接内部地址下载。

```
输入 messages:
  [{ role: "user", content: [
    { type: "text", text: "分析这张图" },
    { type: "image_url", image_url: { url: "data:image/jpeg;base64,..." } }
  ]}]

处理后:
  prompt = "分析这张图\n[图片已上传]"
  inputFiles = ["input-xxx.jpg"]    # 文件名, Agent 用 GATEWAY_URL 拼接内部地址下载
```

Agent 收到任务后，用 Gateway 的 Docker 内部地址（从 `GATEWAY_URL` 提取，如 `http://gateway:26669`）拼接 `inputFiles` 中的文件名下载。`PUBLIC_URL` 只用于返回给调用方的文件 URL。

#### 模型路由表

```yaml
# config/models.yaml
models:
  # ===== 对话 =====
  - name: gpt-4o-web
    vendor: chatgpt
    taskType: chat
  - name: gpt-4o-mini-web
    vendor: chatgpt
    taskType: chat
  - name: claude-sonnet-web
    vendor: claude
    taskType: chat
  - name: gemini-pro-web
    vendor: gemini
    taskType: chat
  - name: doubao-pro-web
    vendor: doubao
    taskType: chat

  # ===== 图片生成 =====
  - name: jimeng-image-web
    vendor: jimeng
    taskType: image
  - name: gemini-image-web
    vendor: gemini
    taskType: image

  # ===== 视频生成 =====
  - name: kling-video-web
    vendor: kling
    taskType: video
  - name: jimeng-video-web
    vendor: jimeng
    taskType: video
```

#### messages 拼接策略（仅对话类型）

网页端 AI 只有一个输入框，messages 数组拼接为单条文本：

```
[系统提示]
你是一个翻译助手

[对话历史]
User: 翻译：hello
Assistant: 你好

[当前问题]
翻译：world
```

单条 user message 时直接发送 content，不拼接。拼接后超过 8000 字时只保留 system + 最近 2 轮对话。

#### stream=false 处理

Gateway 等待 Agent 的 `done` 消息后，将完整文本组装成标准 OpenAI JSON 一次性返回。

#### 视频生成 API 规格

```
POST /v1/videos/generations
请求:
  { "model": "kling-video-web", "prompt": "日落延时摄影",
    "duration": 5, "aspect_ratio": "16:9", "mode": "standard" }
  (duration/aspect_ratio/mode 均可选)
响应:
  { "id": "task-xxx", "status": "generating", "model": "kling-video-web" }

GET /v1/videos/:taskId
响应(排队中):   { "id": "task-xxx", "status": "queued", "progress": 0 }
响应(生成中):   { "id": "task-xxx", "status": "generating", "progress": 30 }
响应(完成):     { "id": "task-xxx", "status": "completed", "video": { "url": "..." } }
响应(失败):     { "id": "task-xxx", "status": "failed", "error": "..." }
```

#### 图片生成参数处理

- `size`：映射到网页端最接近的比例选项（如 `1024x1024` → 1:1）
- `n>1`：Agent 串行多次提交，返回多张 URL
- `response_format`：只支持 `url`，忽略 `b64_json`
- 不支持的参数静默忽略

### 3.2 调度引擎

#### Agent 注册与能力上报

Agent 启动时加载 `VENDORS` 环境变量指定的厂商列表（默认 all = vendors.yaml 中全部），为每个 vendor 开一个 Chrome 会话 tab。注册时上报：

```
{ type: "register", agentId, vendors: ["chatgpt","claude","gemini","doubao","jimeng","kling"] }
```

Gateway 的 Agent 池按 vendor 建立索引，调度时按 vendor 查找可用 Agent。

#### 同步任务调度（对话/图片）

```
请求到达 → 端点匹配校验 → model 解析 → { vendor, taskType: chat|image }
  → 请求文件预处理（如有 image_url）
  ↓
从 Agent 池筛选: vendors 包含该 vendor
  && 可接同步任务 (idle 或 idle+polling)
  && 该 vendor 登录态正常 (loginStatus[vendor] == "logged_in")
  ↓
有空闲 Agent?
  ├─ 是 → 选中 (选 lastTaskAt 最早的) → 标记 busy → WebSocket 推送
  │       { type: "chat_task", requestId, prompt, vendor, inputFiles?: [...] }
  └─ 否 → 等待队列 (vendor 维度) → Agent 回 idle 时唤醒
          → 超过 QUEUE_TIMEOUT (120s) → 返回 503
```

> **排队保活**：对话 `stream=true` 每 5s 推送 SSE 注释 `: queued\n\n` 保活。图片依赖 `QUEUE_TIMEOUT(120s) < new-api 超时(200s)`。

#### 异步任务调度（视频）

```
请求到达 → 端点匹配校验 → model 解析 → { vendor, taskType: video }
  ↓
生成 taskId → Redis 存 { status: "queued" }
  ↓
从 Agent 池筛选: vendors 包含该 vendor
  && 可接视频任务 (标签页数 < MAX_TABS)
  && 该 vendor 登录态正常
  ↓
有可用 Agent?
  ├─ 是 → WebSocket 推送 { type: "video_task", taskId, prompt, params, vendor }
  │       Agent 开新标签页提交 → 返回 { type: "video_submitted" }
  │       Gateway 更新 Redis { status: "generating", agentId }
  │       → 返回 { id: taskId, status: "generating" }
  └─ 否 → Redis 队列等待 → Agent 空闲后领取
          → 超过 VIDEO_QUEUE_TIMEOUT (600s) → failed
```

#### Agent 状态

```
idle              — 无同步任务，可接任何任务
busy              — 正在处理同步任务（对话/图片），不接新同步任务
                  — 但标签页未满时可接视频任务
idle+polling      — 无同步任务，有后台视频轮询，可接任何任务
busy+polling      — 正在处理同步任务，同时有视频轮询

标签页管理:
  会话 tab — 每个厂商一个，常驻不关闭（保持登录态）
  视频轮询 tab — 视频生成提交后打开，完成后关闭
  上限 — MAX_TABS (默认 8): 6 会话 tab + 2 视频轮询 tab
```

#### 并发规则

| Agent 状态 | 可接同步任务? | 可接视频任务? |
|-----------|-------------|-------------|
| idle | 是 | 是 |
| busy | 否 | 是（标签页未满） |
| idle+polling | 是 | 是 |
| busy+polling | 否 | 是（标签页未满） |
| offline | 否 | 否 |

同步任务并发 = Agent 数量。视频轮询并发 = Agent 数量 × (MAX_TABS - 会话 tab 数)。

#### Agent 重连处理

Agent 断线重连后，放弃所有之前的视频任务：

```
Agent WebSocket 断开
  → Gateway 将该 Agent 名下所有 generating 视频任务标记 failed
  → Agent 侧关闭所有视频轮询 tab
  → Agent 重新连接 → register → 状态 idle
  → 会话 tab 保持（Chrome 未重启，登录态在）
  → 之前的视频任务不恢复，调用者重新提交
```

### 3.3 Agent 设计

#### Agent 进程结构

```
Agent 进程
├── Chrome (launchPersistentContext, 有头+Xvfb, 代理分流)
│   ├── 会话 tab: chatgpt (常驻, 保持 ChatGPT 登录态)
│   ├── 会话 tab: claude (常驻)
│   ├── 会话 tab: gemini (常驻)
│   ├── 会话 tab: doubao (常驻)
│   ├── 会话 tab: jimeng (常驻)
│   ├── 会话 tab: kling (常驻)
│   └── 视频轮询 tab 1..N (动态开闭)
├── WebSocket Client (连接 Gateway, 带 AGENT_TOKEN)
├── HTTP Client (上传结果文件 / 下载请求文件)
├── 适配器管理器
│   └── 按 vendor 加载所有适配器 (chatgpt.js, claude.js, ...)
├── 登录检测器 (每 5 分钟检查各会话 tab 登录状态)
├── VNC 管理器 (按需启停 x11vnc, 登录引导用)
├── 视频轮询调度器 (每 15-30s 逐个检查视频 tab)
├── 心跳上报 (每 10s, 含登录状态)
└── 资源回收 (每 N 请求重启 Chrome / 每 10min 定时检查)
```

#### 多厂商加载

Agent 启动流程：

1. 读取 `VENDORS` 环境变量（默认 `all`），从 `vendors.yaml` 确定要加载的厂商列表
2. 为每个厂商加载对应适配器文件（如 `adapters/chatgpt.js`）
3. Chrome 启动（`launchPersistentContext`，持久化目录保存登录态）
4. 为每个厂商开一个会话 tab，导航到对应 URL
5. 检查登录态（首次启动未登录时 tab 会停留在登录页，需 VNC 手动登录）
6. 连接 Gateway WebSocket，注册 agentId + vendors 列表

`VENDORS` 环境变量示例：
```
VENDORS=all                    # 加载所有厂商（默认）
VENDORS=chatgpt,claude,gemini  # 只加载指定厂商
```

#### Agent 标识

agentId 默认使用容器 hostname，也可通过 `AGENT_ID` 环境变量指定。

#### 网络代理

Chrome 配置一个代理地址（`--proxy-server`），由外部代理服务器（如 Clash）按域名分流：

```yaml
# Clash 代理规则示例
proxy-rules:
  - DOMAIN-SUFFIX,openai.com,代理线路
  - DOMAIN-SUFFIX,claude.ai,代理线路
  - DOMAIN-SUFFIX,google.com,代理线路
  - DOMAIN-SUFFIX,doubao.com,DIRECT
  - DOMAIN-SUFFIX,jianying.com,DIRECT
  - DOMAIN-SUFFIX,kuaishou.com,DIRECT
  - MATCH,代理线路
```

Agent 环境变量：
```
HTTP_PROXY=http://clash:7890
HTTPS_PROXY=http://clash:7890
```

未配置代理时 Chrome 直连。代理分流配置在 Agent 之外，Agent 不关心路由规则。

#### 同步任务执行流程

```
Agent 收到 { type: "chat_task", vendor: "chatgpt", prompt, inputFiles }
  1. 如有 inputFiles → HTTP 下载到本地临时目录
  2. 找到 chatgpt 的会话 tab (Page 对象)
  3. 适配器 navigate(): 导航到新对话页面
  4. 如有 inputFiles → 适配器 uploadFile(): 上传文件到网页端
  5. 适配器 sendPrompt(): 输入并发送 prompt
  6. 适配器 streamResponse(): 轮询 DOM，增量回传
  7. 清理本地临时文件
```

图片任务类似，但结果需要上传到 Gateway。

#### Agent 与 Gateway 的 WebSocket 协议

```
Agent → Gateway:
  { type: "register", agentId, vendors: ["chatgpt","claude",...] }
  { type: "heartbeat", agentId, status, activeTabs, videoPollingCount, loginStatus: { chatgpt: "logged_in", ... }, resources: { chromeMemoryMB, chromeCpuPercent, tabCount } }
  { type: "delta", requestId, text }
  { type: "done", requestId }
  { type: "image_result", requestId, imageUrls: ["${PUBLIC_URL}/files/xxx.png"] }
  { type: "video_submitted", requestId, taskId }
  { type: "video_progress", taskId, progress, status }
  { type: "video_done", taskId, videoUrl: "${PUBLIC_URL}/files/xxx.mp4" }
  { type: "video_failed", taskId, error }
  { type: "login_status", agentId, vendor, status: "logged_in"|"logged_out", vncPort?: 5901 }
  { type: "error", requestId, code, message, screenshotUrl?: "${PUBLIC_URL}/files/error-xxx.png" }

Gateway → Agent:
  { type: "chat_task", requestId, prompt, vendor, inputFiles?: ["input-xxx.jpg"] }
  { type: "image_task", requestId, prompt, params, vendor }
  { type: "video_task", taskId, prompt, params, vendor }
  { type: "login_mode", vendor }          // 开启该 vendor 的 VNC 登录引导
  { type: "restart" }                      // 重启 Agent (关闭 Chrome → 重新启动)
  { type: "cancel", requestId }
  { type: "video_cancel", taskId }
```

> `inputFiles` 仅在对话请求包含图片时存在。Agent 下载后通过适配器上传到网页端 AI。

#### 文件上传流程（Agent → Gateway，生成结果）

```
Agent 提取图片/视频 → 保存本地临时文件
  → HTTP POST ${GATEWAY_URL}/files/upload
    Headers: { Authorization: Bearer <AGENT_TOKEN> }
    Body: multipart/form-data { file: <binary> }
  ← Gateway 返回 { url: "${PUBLIC_URL}/files/img-xxx.png" }
  → Agent 删本地临时文件
  → WebSocket 发送 URL 给 Gateway
```

#### 文件下载流程（Gateway → Agent，请求文件）

```
Gateway 预处理请求中的 image_url → 保存为 /data/files/input-xxx.jpg
  → WebSocket 推送任务时携带 inputFiles: ["input-xxx.jpg"]  (文件名)

Agent 收到任务:
  → HTTP GET http://gateway:26669/files/input-xxx.jpg (从 GATEWAY_URL 提取内部地址)
  → 保存到本地临时目录
  → 适配器 uploadFile(): Playwright filechooser → setFiles(本地路径)
  → 删除本地临时文件
```

#### 资源回收

```
同步任务完成 → Agent 状态回 idle
  → 检查 taskCount >= MAX_TASKS_PER_CONTEXT?
    ├─ 否 → 等待下一个任务
    └─ 是 → 检查是否有视频 tab 在轮询
            ├─ 有 → 延迟回收 (超过 MAX_TASKS_PER_CONTEXT × 10 → 强制回收)
            └─ 无 → 关闭 Chrome → sleep 2s → 重启
                    → 重新打开所有会话 tab → 导航到各厂商 URL
                    → 等待 tab 加载完成 → taskCount=0

定时检查 (每 10 分钟):
  → 同上逻辑，解决视频 Agent 长期无同步任务时内存泄漏
```

Chrome 重启后会话 tab 需要重新打开，但登录态保留在 `USER_DATA_DIR` 中，无需重新登录。

### 3.4 适配器设计

适配器按任务类型分三层接口，每个 vendor 按需实现。

#### 适配器接口定义

```typescript
// ===== 对话适配器 =====
interface IChatAdapter {
  navigate(page: Page): Promise<void>;
  uploadFile?(page: Page, filePath: string): Promise<void>;
  sendPrompt(page: Page, prompt: string): Promise<void>;
  streamResponse(
    page: Page,
    onChunk: (delta: string) => void,
    signal: AbortSignal
  ): Promise<string>;
  checkRateLimit(page: Page): Promise<{ limited: boolean; message?: string }>;
}

// ===== 图片生成适配器 =====
interface IImageAdapter {
  navigate(page: Page): Promise<void>;
  uploadReferenceImage?(page: Page, filePath: string): Promise<void>;
  setParams(page: Page, params: ImageParams): Promise<void>;
  sendPrompt(page: Page, prompt: string): Promise<void>;
  waitForImages(
    page: Page,
    signal: AbortSignal
  ): Promise<string[]>;  // 返回本地临时文件路径数组
  checkRateLimit(page: Page): Promise<{ limited: boolean; message?: string }>;
}

// ===== 视频生成适配器 =====
interface IVideoAdapter {
  navigate(page: Page): Promise<void>;
  setParams(page: Page, params: VideoParams): Promise<void>;
  submitGeneration(page: Page, prompt: string): Promise<void>;
  pollStatus(page: Page): Promise<{
    status: 'queued' | 'generating' | 'completed' | 'failed';
    progress: number;
  }>;
  extractVideo(page: Page): Promise<string>;  // 返回本地临时文件路径
  checkRateLimit(page: Page): Promise<{ limited: boolean; message?: string }>;
}
```

- `uploadFile` / `uploadReferenceImage` 是可选方法（`?` 标记）。不支持文件上传的厂商不实现。
- 图片和视频适配器的结果方法返回**本地临时文件路径**，Agent 主进程负责上传到 Gateway。
- 适配器不关心文件传输，只负责网页端操作。

#### 适配器注册表

```yaml
# config/vendors.yaml
vendors:
  chatgpt:
    url: https://chatgpt.com
    capabilities: [chat]
    adapter: chatgpt.js

  claude:
    url: https://claude.ai
    capabilities: [chat]
    adapter: claude.js

  gemini:
    url: https://gemini.google.com/app
    capabilities: [chat, image]
    adapter: gemini.js

  doubao:
    url: https://www.doubao.com/chat
    capabilities: [chat]
    adapter: doubao.js

  jimeng:
    url: https://jimeng.jianying.com/ai-tool/image/generate
    capabilities: [image, video]
    adapter: jimeng.js

  kling:
    url: https://kling.kuaishou.com
    capabilities: [video]
    adapter: kling.js
```

一个 vendor 可支持多种能力（如 gemini = chat + image，即梦 = image + video）。一个适配器文件可同时实现多个接口。

#### 适配器实现来源

| 适配器 | 类型 | 代码来源 | 关键复用点 |
|--------|------|---------|------------|
| ChatGPT | chat | chrome-cdp-daemon `server.mjs` | 剪贴板粘贴、停止按钮检测、发送按钮轮询、文件上传(filechooser) |
| Gemini | chat+image | ai-image-wash `worker.js` | rich-textarea 输入、message-content 提取、Pro 模式切换、图片 Canvas 提取、参考图上传 |
| Claude | chat | 新写 | ProseMirror 输入、流式检测 |
| 豆包 | chat | 新写 | 国产 AI 通用模式 |
| 即梦 | image+video | 新写 | 参数面板交互、图片/视频结果提取 |
| Kling | video | 新写 | 视频生成提交、排队状态轮询、视频下载 |

#### ChatGPT 对话适配器关键逻辑（复用 chrome-cdp-daemon）

文件上传（复用 `server.mjs:321-445` 的 chatgptUploadFile）：
1. 点击 + 按钮 → 等待 filechooser 事件
2. `fileChooser.setFiles(filePath)`
3. 检查文件是否挂载成功（`[class*="file-tile"]` 出现）
4. 后备：直接 `setInputFiles` 到隐藏的 `input#upload-files`

发送消息（`server.mjs:244-316`）：
1. 剪贴板粘贴（`navigator.clipboard.writeText` → `Ctrl+V`）
2. 轮询发送按钮状态 → click
3. 后备：Enter 键

流式检测（`server.mjs:471-485`）：
1. 轮询 `[data-message-author-role="assistant"]` 的 textContent
2. 差值通过 onChunk 推送
3. 停止按钮消失 + 文本稳定 3 次 → done

#### Gemini 适配器关键逻辑（复用 ai-image-wash）

图片生成复用 `worker.js:257-385`：
1. 切换"制作图片"模式
2. 上传参考图（filechooser 方式）
3. 发送 prompt
4. 等待图片（检测 `googleusercontent.com` 或 `blob:` URL）
5. Canvas 提取保存为本地文件

#### 视频适配器通用模式

```
submitGeneration():
  导航 → 设置参数 → 输入 prompt → 点击生成 → 确认"排队中" → 返回

pollStatus():
  检查"排队中"/"生成中"文字 → generating
  检查进度条宽度 → progress
  检查视频播放器出现 → completed
  检查错误提示 → failed

extractVideo():
  方案A: 拦截下载事件 (page.waitForEvent('download'))
  方案B: video 标签 src 属性提取
  方案C: page.evaluate 获取 blob URL → fetch → 保存本地文件
  → 返回本地文件路径
```

#### 选择器热加载

选择器配置见 `config/selectors.yaml`。Agent 每 60s 重读此文件，修改后无需重启即生效。

### 3.5 文件管理

#### 文件分类

Gateway `/data/files/` 目录存储两类文件：

| 类别 | 来源 | 命名 | 清理 |
|------|------|------|------|
| 请求文件 | 用户请求中的 image_url/base64 | `input-{ts}-{random6}.{ext}` | 用完即删（任务完成后） |
| 生成文件 | Agent 上传的图片/视频结果 | `{type}-{ts}-{random6}.{ext}` | 24h 后自动清理 |

#### 文件上传端点（Agent → Gateway）

```
POST /files/upload
Headers: Authorization: Bearer <AGENT_TOKEN>
Body: multipart/form-data { file: <binary> }
Response: { url: "${PUBLIC_URL}/files/img-xxx.png" }
```

#### 文件下载端点（Gateway → Agent / 用户）

```
GET /files/:filename
无需鉴权（随机 ID 不可猜测）
直接返回文件内容，带正确 Content-Type
```

Agent 下载请求文件和用户访问生成结果都走这个端点。

#### 文件清理

Gateway 定时任务（每 1 小时）：
1. 扫描 `/data/files/`，删除创建时间超过 24h 的文件（生成文件）
2. 扫描 `/data/files/`，删除创建时间超过 1h 的 `error-` 前缀文件（错误截图）
3. 清理 Redis 中已过期的视频任务记录

请求文件（`input-` 前缀）在任务完成后立即删除，不走定时清理。

### 3.6 异步任务状态管理

视频任务用 Redis 存储状态。不做任务恢复——进程崩溃则任务失败。

#### Redis 配置

```
maxmemory 256mb
maxmemory-policy volatile-lru
```

#### Redis 数据结构

```
# 任务状态 (TTL 24h)
video:task:{taskId} → Hash {
  status: "queued|generating|completed|failed|cancelled",
  model, prompt, params, progress, agentId,
  videoUrl, thumbnailUrl, error,
  createdAt, updatedAt
}

# 按状态索引 (TTL 24h)
video:status:queued → Set { taskId... }
video:status:generating → Set { taskId... }
```

#### 状态流转

```
POST /v1/videos/generations → Redis: queued
  → Agent 领取: generating
  → video_progress → 更新 progress
  → video_done → completed, videoUrl
  → video_failed → failed, error
  → 手动取消 → cancelled
  → Agent 崩溃 → Gateway 标记 failed
```

#### Gateway 启动清理

Gateway 启动时扫描 Redis 中所有 `generating` 和 `queued` 任务，全部标记 failed。因为 Gateway 重启意味着所有 Agent 断线。

### 3.7 错误处理策略

| 场景 | Gateway 返回 | new-api 行为 |
|------|-------------|-------------|
| 对话/图片限额 | 429 | 重试/切换渠道 |
| 视频限额 | Redis→failed | 轮询到 failed，重试 |
| Chrome 崩溃 | 同步→502 / 视频→Redis failed | 重试 |
| 同步超时 | 504 | 重试 |
| 视频超时(30min) | Redis→failed | 轮询到 failed |
| 选择器失效 | 500 | 重试 |
| 无可用 Agent | 503 | 排队/切换渠道 |
| 视频排队超时 | Redis→failed | 重新提交 |
| 模型端点不匹配 | 400 | 调用方修正 |
| Agent 鉴权失败 | 401 | — |

### 3.8 管理后台

Gateway 内嵌一个轻量 Web 管理后台（静态 HTML + REST API），提供运维所需的配置、监控、账号管理能力。无需额外前端构建工具，HTML 文件由 Gateway 直接托管。

管理端点汇总见 [§3.13](#313-管理端点汇总)。

#### 仪表盘

```
┌─────────────────────────────────────────────────┐
│  ai-web-gateway 管理后台                         │
├─────────────────────────────────────────────────┤
│                                                 │
│  Agent: 3 在线 / 3 总数    视频 queue: 2        │
│  同步并发: 3               文件存储: 1.2 GB     │
│                                                 │
│  ┌──────────┬──────┬──────┬──────┬──────┐      │
│  │ 厂商     │ 请求数│ 成功率│ 均耗时│ 状态  │      │
│  ├──────────┼──────┼──────┼──────┼──────┤      │
│  │ chatgpt  │  156 │ 98.7%│  42s  │ ●在线 │      │
│  │ claude   │   43 │100.0%│  28s  │ ●在线 │      │
│  │ gemini   │   89 │ 95.5%│  35s  │ ●在线 │      │
│  │ doubao   │   12 │100.0%│  15s  │ ●在线 │      │
│  │ jimeng   │   34 │ 91.2%│  85s  │ ●在线 │      │
│  │ kling    │    8 │ 87.5%│ 8.3min│ ●在线 │      │
│  └──────────┴──────┴──────┴──────┴──────┘      │
│                                                 │
│  [Agent详情]  [账号管理]  [配置编辑]  [任务历史] │
└─────────────────────────────────────────────────┘
```

#### Agent 详情

每个 Agent 显示：

| 字段 | 说明 |
|------|------|
| agentId | 容器 hostname 或 AGENT_ID |
| status | idle / busy / idle+polling / busy+polling / offline |
| vendors | 支持的厂商列表 |
| activeTabs | 当前打开的标签页数 |
| videoPolling | 正在轮询的视频任务数 |
| taskCount | 自上次资源回收以来的任务数 |
| lastSeen | 最后心跳时间 |
| 当前任务 | 如 busy，显示 requestId + vendor + model |

操作：重启 Agent（通过 WebSocket 发送 restart 指令，Agent 关闭 Chrome 后重新启动）。

#### 配置在线编辑

管理后台提供 YAML 在线编辑器，修改后热加载：

| 配置文件 | 热加载方式 | 生效时间 |
|---------|-----------|---------|
| `selectors.yaml` | Agent 每 60s 重读 | 1 分钟内 |
| `models.yaml` | Gateway 内存重载 | 立即 |
| `vendors.yaml` | 需重启 Agent | 手动触发 |

selectors.yaml 是最高频修改的配置（网页端改版导致选择器失效），热加载确保修改后 1 分钟内生效，无需重启任何服务。

### 3.9 账号管理

#### 登录状态检测

Agent 每 5 分钟检查每个会话 tab 的登录状态，通过 `selectors.yaml` 中的 `loginCheck` 配置判断：

```yaml
chatgpt:
  loginCheck:
    loggedIn: "#prompt-textarea"                          # 存在 → 已登录
    loggedOut: "button[data-testid='login-button']"       # 存在 → 未登录
```

检测结果通过心跳上报 Gateway：

```
{ type: "heartbeat", agentId, status, loginStatus: {
  chatgpt: "logged_in",
  claude: "logged_in",
  gemini: "logged_out",    // Cookie 过期
  doubao: "logged_in",
  jimeng: "logged_in",
  kling: "logged_in"
}}
```

#### 登录状态矩阵

管理后台展示所有 Agent × 厂商的登录状态：

```
         chatgpt  claude  gemini  doubao  jimeng  kling
Agent-1    ✓绿     ✓绿     ✗红     ✓绿     ✓绿    ✓绿
Agent-2    ✓绿     ✓绿     ✓绿     ✓绿     ✓绿    ✓绿
Agent-3    ✓绿     ✗红     ✓绿     ✓绿     ✓绿    ✓绿
```

红色格子（未登录/已过期）显示"登录"按钮。

#### 登录引导流程

```
1. 管理员点击红色格子的"登录"按钮
   → POST /admin/login/:agentId/:vendor

2. Gateway 通过 WebSocket 指示 Agent:
   { type: "login_mode", vendor: "gemini" }

3. Agent:
   a. 切换到该 vendor 的会话 tab
   b. 确保 x11vnc 在指定端口运行（如未运行则启动）
   c. 上报 VNC 端口号给 Gateway

4. Gateway 返回 VNC 连接信息:
   { vncUrl: "ws://your-server:5901", agentId: "agent-1" }

5. 管理后台内嵌 noVNC（Web 版 VNC 客户端）或提供 VNC 地址
   → 管理员在浏览器中看到 Chrome 界面
   → 在对应厂商的 tab 中手动登录

6. Agent 持续检测登录状态:
   → 检测到 loggedIn 选择器出现 → 登录成功
   → 上报 { type: "login_status", vendor, status: "logged_in" }

7. 管理后台更新矩阵为绿色
   → Agent 关闭 x11vnc（安全考虑，不长期开放 VNC）
```

#### --scale 多实例登录

每个 Agent 容器有独立的 `chrome_data` volume，登录态独立。`--scale 3` 时需要分别在 3 个 Agent 上登录。

管理后台的登录状态矩阵展示所有实例，管理员逐个点击红色格子完成登录。Agent 数量通常不多（2-5 个），手动登录可接受。

> **未来优化**（v2）：登录态导出/导入——在一个 Agent 上登录后，导出 Cookie + localStorage，其他 Agent 导入。但 Chrome 登录态涉及多种存储（Cookie、localStorage、IndexedDB、Service Worker），导出导入复杂度高，v1 不做。

#### 登录态过期处理

Agent 检测到登录态过期时：
1. 心跳中上报 `loginStatus[vendor]: "logged_out"`
2. 管理后台矩阵变红
3. 该 Agent 不再被分配该 vendor 的任务（调度引擎跳过）
4. 其他 Agent 如果仍登录正常，请求路由到其他 Agent
  5. 如果所有 Agent 的该 vendor 都过期，请求返回 503

### 3.10 日志与调试

#### 日志查看

管理后台提供实时日志流（WebSocket 推送）和历史日志搜索：

```
GET  /admin/logs/:agentId          # 获取 Agent 历史日志 (最近 2000 行)
GET  /admin/logs/:agentId/stream   # 实时日志流 (WebSocket)
GET  /admin/logs/gateway           # Gateway 自身日志
GET  /admin/logs/:agentId?level=error&search=timeout  # 按级别/关键词过滤
```

Agent 日志通过心跳通道旁路传输（不占用任务 WebSocket 通道），Gateway 缓存最近 2000 行在内存中。历史日志超出 2000 行时从 Agent 容器的日志文件读取。

#### 错误截图

任务失败时 Agent 自动截图保存，通过 HTTP 上传到 Gateway：

```
任务执行失败
  → Agent page.screenshot() → 保存本地临时文件
  → HTTP POST /files/upload → 上传到 Gateway
  → WebSocket: { type: "error", requestId, code, message, screenshotUrl: "${PUBLIC_URL}/files/error-xxx.png" }
```

管理后台任务历史中，失败任务旁边显示截图缩略图，点击放大。这是排查选择器失效的头号工具——看到截图就知道页面长什么样、哪一步出错了。

截图文件 1h 后自动清理（比生成结果的 24h 更短，因为只用于排查）。

#### 在线调试测试

管理后台提供"调试"页面，直接向指定厂商/模型发送测试请求：

```
┌──────────────────────────────────────────┐
│  调试测试                                 │
│                                          │
│  厂商: [chatgpt ▼]  模型: [gpt-4o-web ▼] │
│  任务类型: [对话 ▼]                       │
│                                          │
│  Prompt:                                 │
│  ┌──────────────────────────────────┐    │
│  │ 你好，请简短回复                    │    │
│  └──────────────────────────────────┘    │
│                                          │
│  [上传测试图片] (可选)                     │
│                                          │
│  [发送测试]                               │
│                                          │
│  ── 响应 ──                              │
│  Agent: agent-1                          │
│  耗时: 3.2s 首字 / 12.5s 完成             │
│  回复: 你好！有什么可以帮你的吗？          │
│                                          │
│  [查看错误截图] (仅失败时)                 │
└──────────────────────────────────────────┘
```

调试请求走正常的调度流程（选 Agent → 推送任务 → 等待响应），但在管理后台展示完整的执行细节（耗时、Agent、错误截图）。用于验证选择器修改后是否生效。

#### 选择器版本管理

每次通过管理后台修改 `selectors.yaml` 时自动保存历史版本：

```
/data/config-history/
  selectors-20260812-143000.yaml   # 修改前备份
  selectors-20260812-150000.yaml
  selectors-20260812-162000.yaml
  ...（保留最近 20 个版本）
```

管理后台提供：
- 版本列表（时间 + 修改人 IP）
- 版本 diff 对比
- 一键回滚到指定版本

```
GET  /admin/config/selectors/history        # 版本列表
GET  /admin/config/selectors/history/:ver   # 获取指定版本内容
POST /admin/config/selectors/rollback/:ver  # 回滚到指定版本
```

这是热加载的安全网——修改选择器后如果导致更多失败，一键回滚。

### 3.11 监控与告警

#### 请求统计时序

Gateway 在内存中维护各厂商的时序统计（不持久化，重启清零）：

```
每个厂商每 5 分钟一个数据点:
{
  vendor: "chatgpt",
  timestamp: 1700000000,
  total: 12,        // 5 分钟内总请求数
  success: 11,      // 成功数
  failed: 1,        // 失败数
  avgLatency: 4200, // 平均耗时(ms)
  p95Latency: 8500, // P95 耗时
}

保留最近 24h (288 个数据点)，用于管理后台展示趋势图。
```

```
GET /admin/stats/trend?vendor=chatgpt&range=24h
→ [{ timestamp, total, success, failed, avgLatency }, ...]
```

管理后台用简单 SVG 折线图展示（不依赖 Chart.js 等库）。

#### Agent 资源监控

Agent 心跳中增加资源信息：

```
{ type: "heartbeat", agentId, status, ...,
  resources: { chromeMemoryMB: 487, chromeCpuPercent: 12.3, tabCount: 6 }
}
```

Agent 通过 `process.memoryUsage()` 和 `/proc` 读取 Chrome 子进程的内存和 CPU。

管理后台 Agent 详情页展示：
- 当前 Chrome 内存占用（MB）
- 内存趋势（最近 1h 折线图）
- 资源回收剩余计数（`MAX_TASKS_PER_CONTEXT - taskCount`）

内存超过阈值（如 800MB）时管理后台标黄预警，提示管理员扩容或检查内存泄漏。

#### 告警规则

Gateway 内置告警引擎，检测以下条件并触发通知：

| 告警条件 | 级别 | 说明 |
|---------|------|------|
| Agent 离线（心跳超 30s） | 严重 | Agent 崩溃或网络断开 |
| 厂商登录态全部过期 | 严重 | 该厂商完全不可用 |
| 5 分钟内错误率 > 50% | 严重 | 大面积选择器失效或网站故障 |
| 5 分钟内错误率 > 30% | 警告 | 可能选择器部分失效 |
| Agent 内存 > 800MB | 警告 | Chrome 内存泄漏，需资源回收 |
| 视频任务排队 > 5 个 | 警告 | 视频并发不足，需扩容 |
| 视频任务排队超时 | 警告 | 单个任务排队超 600s |

#### 告警通知

通过 Webhook 发送告警通知：

```yaml
# .env 中配置
ALERT_WEBHOOK=https://qyapi.weixin.com/cgi-bin/webhook/send?key=xxx
# 支持企业微信/钉钉/Slack/飞书（Webhook 格式兼容）
```

告警消息格式：
```
[严重] Agent 离线
Agent: agent-3
最后心跳: 2026-08-12 14:32:01
当前任务: chatgpt 对话 (requestId: req-xxx)
请检查 Agent 容器状态
```

同一告警 5 分钟内不重复发送（去重）。告警恢复时发送恢复通知。

```
GET  /admin/alerts          # 当前活跃告警列表
GET  /admin/alerts/history  # 告警历史 (最近 100 条)
```

#### 健康检查增强

```
GET /health
→ {
  gateway: "ok",
  redis: "ok",
  agents: { total: 3, online: 3, idle: 2, busy: 1 },
  loginSummary: { chatgpt: "ok", claude: "ok", gemini: "degraded", ... },
  videoQueue: 2,
  fileStorage: { usedMB: 1234, fileCount: 56 },
  uptime: 86400
}
```

用于外部监控（如 Uptime Robot）和 Docker healthcheck。

### 3.12 运维操作

#### 厂商启用/禁用

管理后台可手动禁用某个厂商（网站故障或选择器大面积失效时隔离）：

```
POST /admin/vendors/:vendor/disable    # 禁用
POST /admin/vendors/:vendor/enable     # 启用
```

禁用后：
- 调度引擎跳过该 vendor（等同于所有 Agent 该 vendor 未登录）
- 已有的视频轮询任务继续完成（不中断）
- 新请求返回 503（vendor 不可用）
- 管理后台厂商状态显示"已禁用"

#### 限流配置

防止短时间内大量请求打垮网页端 AI 账号：

```yaml
# config/models.yaml 中增加限流配置
models:
  - name: gpt-4o-web
    vendor: chatgpt
    taskType: chat
    rateLimit:
      qps: 0.5          # 每秒最多 0.5 个请求 (即每 2 秒 1 个)
      concurrency: 3    # 最大并发 3 (受 Agent 数量限制)

  - name: kling-video-web
    vendor: kling
    taskType: video
    rateLimit:
      qps: 0.1          # 每 10 秒最多 1 个视频提交
      concurrency: 4    # 最大 4 个视频同时轮询
```

Gateway 在调度引擎中实现令牌桶限流。超限时请求排队等待（而非直接拒绝），同步任务超过 `QUEUE_TIMEOUT` 返回 503，视频任务超过 `VIDEO_QUEUE_TIMEOUT` 标记 failed。

限流配置通过管理后台在线编辑 `models.yaml`，热加载生效。

#### 视频任务管理

管理后台提供视频任务列表和操作：

```
GET  /admin/video-tasks                    # 视频任务列表
     ?status=generating                    # 按状态筛选
     ?vendor=kling                         # 按厂商筛选
     ?page=1&pageSize=20                   # 分页

POST /admin/video-tasks/:taskId/cancel     # 手动取消
```

任务列表展示：

| taskId | 厂商 | 状态 | 进度 | Agent | 耗时 | 操作 |
|--------|------|------|------|-------|------|------|
| task-xxx | kling | generating | 45% | agent-2 | 3m12s | [取消] |
| task-yyy | jimeng | completed | 100% | agent-1 | 8m45s | [查看视频] |
| task-zzz | kling | failed | — | agent-3 | 5m01s | [查看错误] |

手动取消：Gateway 发送 `{ type: "video_cancel", taskId }` 给 Agent → Agent 关闭视频标签页 → Redis 更新 `status: "cancelled"`。

#### 操作审计

管理后台的所有写操作记录审计日志：

```
POST /admin/agents/:id/restart       → 记录: 重启 Agent, 操作者 IP, 时间
PUT  /admin/config/selectors         → 记录: 修改选择器, 操作者 IP, 时间
POST /admin/vendors/:vendor/disable  → 记录: 禁用厂商, 操作者 IP, 时间
POST /admin/video-tasks/:id/cancel   → 记录: 取消视频任务, 操作者 IP, 时间
```

```
GET /admin/audit?page=1&pageSize=50   # 审计日志列表
```

审计日志存储在 Redis（`audit:log` List，TTL 7 天），不持久化到文件。仅用于追溯运维操作，不需要长期保留。

### 3.13 管理端点汇总

完整的管理 API 端点：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin` | 管理后台 Web 页面 |
| GET | `/admin/dashboard` | 仪表盘数据 |
| GET | `/admin/stats/trend` | 请求统计趋势 |
| GET | `/admin/agents` | Agent 列表+状态 |
| POST | `/admin/agents/:id/restart` | 重启 Agent |
| GET | `/admin/login-status` | 登录状态矩阵 |
| POST | `/admin/login/:agentId/:vendor` | 开启 VNC 登录引导 |
| GET | `/admin/config/:name` | 获取配置文件 |
| PUT | `/admin/config/:name` | 更新配置文件 |
| GET | `/admin/config/selectors/history` | 选择器版本历史 |
| POST | `/admin/config/selectors/rollback/:ver` | 选择器回滚 |
| GET | `/admin/tasks` | 同步任务历史 |
| GET | `/admin/video-tasks` | 视频任务列表 |
| POST | `/admin/video-tasks/:taskId/cancel` | 取消视频任务 |
| GET | `/admin/files` | 文件列表 |
| DELETE | `/admin/files/cleanup` | 清理过期文件 |
| GET | `/admin/logs/:agentId` | Agent 日志 |
| GET | `/admin/logs/:agentId/stream` | 实时日志流 (WebSocket) |
| GET | `/admin/logs/gateway` | Gateway 日志 |
| POST | `/admin/debug/test` | 调试测试请求 |
| GET | `/admin/vendors` | 厂商列表+启用状态 |
| POST | `/admin/vendors/:vendor/disable` | 禁用厂商 |
| POST | `/admin/vendors/:vendor/enable` | 启用厂商 |
| GET | `/admin/alerts` | 当前告警 |
| GET | `/admin/alerts/history` | 告警历史 |
| GET | `/admin/audit` | 审计日志 |

#### 管理数据存储

| 数据 | 存储位置 | TTL | 说明 |
|------|---------|-----|------|
| 请求统计时序 | Gateway 内存 | 24h | 重启清零，不持久化 |
| 同步任务历史 | Redis `task:history` List | 24h | 最近 100 条 |
| 视频任务状态 | Redis `video:task:*` | 24h | 见 §3.6 |
| 告警记录 | Redis `alert:*` | 7d | 当前活跃 + 历史 100 条 |
| 审计日志 | Redis `audit:log` List | 7d | 管理操作记录 |
| 选择器版本历史 | `/data/config-history/` | 最近 20 个版本 | 文件系统存储 |
| Agent 日志 | Gateway 内存 + Agent 容器 stdout | 2000 行 | 实时流 + 历史 |

## 4. 部署方案

### 4.1 Docker Compose 一键部署

```yaml
# docker-compose.yml
version: '3.8'

services:
  gateway:
    build: ./gateway
    container_name: ai-web-gateway
    ports:
      - "26669:26669"
    environment:
      - API_KEY=${API_KEY:-changeme}
      - AGENT_TOKEN=${AGENT_TOKEN:-agent-secret}
      - PUBLIC_URL=${PUBLIC_URL:-http://localhost:26669}
      - REDIS_URL=redis://redis:6379
      - AGENT_TIMEOUT=180000
      - QUEUE_TIMEOUT=120000
      - VIDEO_QUEUE_TIMEOUT=600000
      - VIDEO_TIMEOUT=1800000
      - MAX_TABS_PER_AGENT=8
      - FILE_DIR=/data/files
      - FILE_TTL_HOURS=24
      - ALERT_WEBHOOK=${ALERT_WEBHOOK:-}
      - ALERT_DEDUP_SECONDS=300
    volumes:
      - ./config:/app/config          # 管理后台需要在线编辑配置
      - files_data:/data/files
      - config_history:/data/config-history
    restart: always
    depends_on:
      - redis

  redis:
    image: redis:7-alpine
    container_name: ai-web-redis
    command: redis-server --maxmemory 256mb --maxmemory-policy volatile-lru
    volumes:
      - redis_data:/data
    restart: always

  # ===== Agent (统一服务, --scale 扩展) =====
  agent:
    build: ./agent
    environment:
      - GATEWAY_URL=ws://gateway:26669/agent
      - AGENT_TOKEN=${AGENT_TOKEN:-agent-secret}
      - VENDORS=${VENDORS:-all}
      - MAX_TASKS_PER_CONTEXT=5
      - MAX_TABS=8
      - DISPLAY=:99
      - POLL_INTERVAL=500
      - STABLE_COUNT=3
      - HTTP_PROXY=${HTTP_PROXY:-}
      - HTTPS_PROXY=${HTTPS_PROXY:-}
    shm_size: '2gb'
    deploy:
      resources:
        limits:
          memory: 2G
    volumes:
      - chrome_data:/data/chrome
      - ./config:/app/config

    restart: always
    depends_on:
      - gateway

volumes:
  redis_data:
  files_data:
  config_history:
  chrome_data:
```

### 4.2 水平扩展

**扩容**（增加并发能力）：

```bash
# 启动 3 个 Agent 实例，每个都能服务所有厂商
docker-compose up --scale agent=3
```

每个 Agent 容器有独立的 Xvfb + Chrome，互不干扰。3 个 Agent = 3 个同步并发 + 6 个视频轮询并发。

**指定厂商子集**（如只需对话，不要视频）：

```bash
# .env 中设置
VENDORS=chatgpt,claude,gemini,doubao
```

### 4.3 新增厂商

1. `config/models.yaml` 添加模型（name + vendor + taskType）
2. `config/vendors.yaml` 添加厂商（url + capabilities + adapter）
3. `config/selectors.yaml` 添加 DOM 选择器
4. 编写 `agent/adapters/newvendor.js`
5. 重启 Agent（热加载 vendors.yaml 后自动加载新厂商，开新 tab）

> 如果 Agent 已经在运行，修改 `vendors.yaml` 后重启 Agent 即可，不需要重新构建镜像。

### 4.4 Agent Dockerfile

```dockerfile
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb xauth x11vnc \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libpango-1.0-0 libcairo2 libasound2 fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --production
RUN npx playwright install chromium && npx playwright install-deps chromium

COPY . .
RUN chmod +x entrypoint.sh

ENTRYPOINT ["./entrypoint.sh"]
```

```bash
#!/bin/bash
# agent/entrypoint.sh
DISPLAY_NUM="${DISPLAY#:}"
Xvfb :${DISPLAY_NUM} -screen 0 1280x800x24 -ac +extension RANDR &
sleep 1

if [ -n "$VNC_PORT" ]; then
  x11vnc -display :${DISPLAY_NUM} -nopw -listen 0.0.0.0 \
    -rfbport ${VNC_PORT} -forever -shared -noxfixes &
fi

exec node agent.js
```

### 4.5 首次登录

首次部署时所有 Agent 的所有厂商都未登录。通过管理后台完成：

1. `docker-compose up -d` 启动所有服务
2. 浏览器打开 `http://your-server:26669/admin`（输入 API_KEY 登录）
3. 进入"账号管理"页面，看到登录状态矩阵全红
4. 逐个点击红色格子的"登录"按钮：
   a. Gateway 指示对应 Agent 开启 x11vnc
   b. 管理后台内嵌 noVNC 或提供 VNC 地址
   c. 在 VNC 中手动登录该厂商
   d. Agent 检测到登录成功 → 矩阵变绿
5. 所有格子变绿后系统即可正常服务

登录态保存在 `chrome_data` volume，后续 Agent 重启自动恢复。Cookie 过期后矩阵再次变红，重复上述流程。

> `--scale N` 时每个 Agent 容器独立登录。Agent 数量通常 2-5 个，手动登录可接受。

### 4.6 Gateway Dockerfile

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
RUN mkdir -p /data/files
EXPOSE 26669
CMD ["node", "server.js"]
```

## 5. new-api 集成

### 5.1 自定义渠道类型

在 new-api 中新增渠道类型 **"Web AI"**（参考 Midjourney 渠道类型）。relay 逻辑为原样透传——根据请求端点路径直接转发到 Gateway，不做格式转换。

需要修改的 new-api 文件：

| 文件 | 修改内容 |
|------|---------|
| `constant/channel_type.go` | 添加 `WebAI` 渠道类型常量 |
| `relay/relay.go` | 添加 WebAI 渠道路由，支持 `/v1/chat/completions`、`/v1/images/generations`、`/v1/videos/generations`、`/v1/videos/:id` |
| `relay/webai/` | 新增目录，透传 relay 逻辑 |
| 前端渠道配置页 | 添加 WebAI 渠道类型选项 |

### 5.2 渠道配置

```
类型:       Web AI
Base URL:   http://ai-web-gateway:26669
密钥:       <与 Gateway API_KEY 一致>
模型:       gpt-4o-web,gpt-4o-mini-web,claude-sonnet-web,gemini-pro-web,doubao-pro-web,
            jimeng-image-web,gemini-image-web,
            kling-video-web,jimeng-video-web
```

**一个渠道覆盖所有模型和所有任务类型。**

### 5.3 端点转发映射

| 用户请求 | 转发到 Gateway | 响应格式 |
|---------|---------------|---------|
| `POST /v1/chat/completions` | 同 | SSE 或 JSON |
| `POST /v1/images/generations` | 同 | JSON `{ data: [{ url }] }` |
| `POST /v1/videos/generations` | 同 | JSON `{ id, status }` |
| `GET /v1/videos/:id` | 同 | JSON `{ id, status, video? }` |

### 5.4 计费配置

| 模型类型 | 计费方式 | 说明 |
|---------|---------|------|
| 对话 (gpt-4o-web 等) | 按 token | 倍率与对应 API 模型相同 |
| 图片 (jimeng-image-web 等) | 按次 | 自行定价 |
| 视频 (kling-video-web 等) | 按次 | 自行定价 |

### 5.5 new-api 侧容错

- 重试次数: 3
- 超时时间: 200s（对话/图片）
- 多渠道备选: 配置其他 API 渠道作为兜底

## 6. 项目结构

```
ai-web-gateway/
├── DESIGN.md
├── docker-compose.yml
├── .env.example
│
├── config/
│   ├── models.yaml            # 模型→厂商→任务类型路由表
│   ├── vendors.yaml           # 厂商能力声明
│   └── selectors.yaml         # 各厂商 DOM 选择器
│
├── gateway/
│   ├── Dockerfile
│   ├── package.json
│   ├── server.js
│   ├── public/                   # 管理后台静态文件
│   │   └── admin.html            # 管理后台单页应用
│   ├── lib/
│   │   ├── scheduler.js          # 调度引擎
│   │   ├── agentPool.js          # Agent 连接池管理
│   │   ├── taskStore.js          # Redis 异步任务状态
│   │   ├── fileStore.js          # 文件存储+清理
│   │   ├── request-files.js      # 请求文件预处理 (image_url→文件)
│   │   ├── openai-api.js         # OpenAI 兼容响应格式化
│   │   ├── message-builder.js    # messages → prompt 拼接
│   │   ├── config-loader.js      # 配置热加载
│   │   ├── stats.js              # 请求统计 (时序数据, 内存)
│   │   ├── alerts.js             # 告警引擎 (规则检测+Webhook)
│   │   ├── audit.js              # 审计日志 (Redis, 7天TTL)
│   │   └── config-history.js     # 选择器版本管理 (备份/diff/回滚)
│   └── routes/
│       ├── chat.js
│       ├── images.js
│       ├── videos.js
│       ├── models.js
│       ├── files.js
│       ├── health.js
│       └── admin.js              # 管理后台 API (全部管理端点)
│
├── agent/
│   ├── Dockerfile
│   ├── entrypoint.sh
│   ├── package.json
│   ├── agent.js
│   ├── adapters/
│   │   ├── base-chat.js
│   │   ├── base-image.js
│   │   ├── base-video.js
│   │   ├── chatgpt.js
│   │   ├── claude.js
│   │   ├── gemini.js
│   │   ├── doubao.js
│   │   ├── jimeng.js
│   │   └── kling.js
│   ├── lib/
│   │   ├── chrome.js          # Chrome 启动+多 tab 管理+资源回收
│   │   ├── ws-client.js
│   │   ├── file-uploader.js   # HTTP 上传生成文件到 Gateway
│   │   ├── file-downloader.js # HTTP 下载请求文件到本地
│   │   ├── video-poller.js
│   │   ├── login-checker.js   # 登录状态检测 (每 5 分钟)
│   │   ├── vnc-manager.js     # VNC 按需启停 (登录引导)
│   │   ├── resource-monitor.js # Chrome 内存/CPU 监控 (心跳上报)
│   │   ├── error-screenshot.js # 任务失败时自动截图+上传
│   │   ├── selector-loader.js
│   │   └── media-extractor.js
│   └── chrome-session/        # 持久化登录态
│
└── docs/
```

## 7. 与已有项目的关系

| 已有项目 | 复用内容 | 改造点 |
|---------|---------|--------|
| chrome-cdp-daemon `server.mjs` | ChatGPT 适配器（剪贴板输入、停止按钮检测、文件上传 filechooser） | HTTP→WebSocket；整段→流式 |
| ai-image-wash `worker.js` | Gemini 适配器（rich-textarea、图片 Canvas 提取、参考图上传） | 轮询拉取→被推送 |
| ai-image-wash `deploy.yml` | Xvfb + Chrome 部署经验 | PM2→Docker |
| ai-image-wash `workerRegistry.ts` | 心跳检测思路 | 去掉限额调度 |

### 不复用的内容

| 已有功能 | 不复用原因 |
|---------|-----------|
| 限额调度 | new-api 自带重试和切换 |
| 任务恢复 | 崩溃即失败，调用者重试 |
| 数据库队列 | Redis 轻量存储 |
| Prisma + MySQL | YAML 配置 + Redis |

## 8. 关键设计决策记录

### 为什么多厂商共享 Agent？

一个 Chrome 实例可以在不同 tab 中登录不同厂商。如果每个厂商独占一个 Agent，6 个厂商需要 6 个 Chrome 实例（2-4GB 内存），但大部分时间 Chrome 空闲。改为多厂商共享后，1 个 Agent 开 6 个会话 tab，覆盖所有厂商，`--scale 3` 即 3 个并发实例。资源利用率提升数倍。

### 为什么同步+异步混合？

对话（10-180s）和图片（30-180s）可以同步覆盖。视频生成 3-30 分钟，HTTP 连接不可能挂这么久。异步提交+轮询是唯一可行方案。

### 为什么视频不独占 Agent？

视频提交后 Agent 只需每 15-30s 检查页面状态。改为开标签页后台轮询，Agent 在轮询间隙可处理对话/图片请求。

### 为什么文件走 HTTP 而非 WebSocket 传 base64？

base64 膨胀 33%、大消息阻塞 WebSocket 通道、消息大小有上限。HTTP 是成熟的二进制传输方案，不阻塞 WebSocket。

### 为什么用两种鉴权令牌？

API_KEY 给调用方，AGENT_TOKEN 给 Agent。泄露 API_KEY 不会导致恶意 Agent 注入，泄露 AGENT_TOKEN 不能调用 AI 服务。

### 为什么不做限额调度？

new-api 自带渠道重试和切换。网关返回 429，new-api 自动处理。视频限额 Redis 标记 failed，调用者重新提交。

### 为什么不做任务恢复？

同步任务无持久化队列。视频任务崩溃即失败——Chrome 关了网页状态不一致，强行恢复不如重新提交。

### 为什么请求文件由 Gateway 预处理而非直接传给 Agent？

用户请求中的 `image_url` 可能是 base64（几 MB）或外部 URL。如果直接通过 WebSocket 传给 Agent，base64 会阻塞通道。Gateway 预处理为文件后，Agent 通过 HTTP 下载，不阻塞 WebSocket。同时 Gateway 可以统一管理文件的生命周期。

### 为什么 Redis 用 volatile-lru？

allkeys-lru 可能驱逐正在进行的任务状态。volatile-lru 只驱逐有 TTL 的 key，正在进行的任务（也有 TTL）不会被误驱逐，因为它们近期被访问过（LRU）。

### 为什么适配器按任务类型分层？

对话/图片/视频的操作流程差异巨大。分层后每种类型接口干净明确，新增厂商只需实现支持的类型。

### 为什么每次请求开新对话？

会话复用需要维护映射、过期清理、上下文截断、并发冲突。每次开新对话多花 2-3 秒导航，但简单可靠。

## 9. 性能预期

| 指标 | 对话 | 图片 | 视频 |
|------|------|------|------|
| 提交延迟 | 5-15s 首字 | 5-10s 提交 | 5-15s 提交 |
| 总耗时 | 10-180s | 30-180s | 3-30min |
| 流式速率 | 10-50 tok/s | — | — |
| Agent 占用 | 独占同步 | 独占同步 | 标签页(非独占) |
| 超时 | 180s | 180s | 30min |
| 排队超时 | 120s | 120s | 600s |
| 单 Agent 并发 | 1 同步 | 1 同步 | 1 同步 + 2 视频轮询 |
| Agent 内存 | 500MB-1G | 500MB-1G | 500MB-1G |
| 资源回收 | 每5请求 | 每5请求 | 每5请求 |
| 文件清理 | 用完即删 | 24h | 24h |

> Agent 内存比单厂商设计高（多 tab 常驻），但总实例数大幅减少，整体内存消耗更低。3 个多厂商 Agent（~3GB）替代 6 个单厂商 Agent（~3-4GB），并发能力相同。
