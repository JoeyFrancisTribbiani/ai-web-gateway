#!/bin/bash
set -e

# ai-web-gateway 一键安装脚本 (Gateway + Redis)
# 用法: ./install-gateway.sh --api-key=xxx --agent-token=xxx --public-url=http://your-server:26669
# 可选: --image=ghcr.io/owner/repo/gateway:latest  --config-repo=owner/repo

INSTALL_DIR="/opt/ai-web-gateway"
IMAGE="${GATEWAY_IMAGE:-ai-web-gateway:latest}"
API_KEY=""
AGENT_TOKEN=""
PUBLIC_URL=""
CONFIG_REPO=""
REDIS_IMAGE="redis:7-alpine"
BUILD=false
FORCE_CONFIG=false
# 解析参数
for arg in "$@"; do
  case $arg in
    --image=*)        IMAGE="${arg#*=}" ;;
    --api-key=*)      API_KEY="${arg#*=}" ;;
    --agent-token=*)  AGENT_TOKEN="${arg#*=}" ;;
    --public-url=*)   PUBLIC_URL="${arg#*=}" ;;
    --config-repo=*)  CONFIG_REPO="${arg#*=}" ;;
    --dir=*)          INSTALL_DIR="${arg#*=}" ;;
    --build)          BUILD=true ;;
    --force-config)   FORCE_CONFIG=true ;;
  esac
done

if [ -z "$API_KEY" ]; then echo "ERROR: --api-key is required"; exit 1; fi
if [ -z "$AGENT_TOKEN" ]; then echo "ERROR: --agent-token is required"; exit 1; fi
if [ -z "$PUBLIC_URL" ]; then echo "ERROR: --public-url is required (e.g. http://your-server:26669)"; exit 1; fi

# 检查 Docker
if ! command -v docker &>/dev/null; then
  echo "ERROR: Docker is not installed. Install it first: https://docs.docker.com/get-docker/"
  exit 1
fi
if ! docker compose version &>/dev/null 2>&1; then
  if ! command -v docker-compose &>/dev/null; then
    echo "ERROR: Docker Compose is not installed."
    exit 1
  fi
  COMPOSE="docker-compose"
else
  COMPOSE="docker compose"
fi

echo "=== Installing ai-web-gateway to ${INSTALL_DIR} ==="

mkdir -p "${INSTALL_DIR}/config"
cd "${INSTALL_DIR}"

if [ "$BUILD" = true ]; then
  if [ ! -d "./gateway" ]; then
    echo "ERROR: --build mode requires ./gateway source directory in ${INSTALL_DIR}"
    exit 1
  fi
  echo "Building gateway from source..."
fi

# 下载配置文件
if [ -n "$CONFIG_REPO" ]; then
  echo "Downloading config files from ${CONFIG_REPO}..."
  for f in models.yaml vendors.yaml selectors.yaml; do
    if [ -f "config/${f}" ] && [ "$FORCE_CONFIG" = false ]; then
      echo "  Skipping ${f} (already exists, use --force-config to overwrite)"
    else
      curl -sfSL "https://raw.githubusercontent.com/${CONFIG_REPO}/main/config/${f}" -o "config/${f}" 2>/dev/null || true
    fi
  done
fi

# 确保所有配置文件都存在 (--config-repo 下载失败时也触发 fallback)
if [ ! -f config/vendors.yaml ] || [ ! -s config/vendors.yaml ]; then
  echo "  Creating minimal vendors.yaml"
  cat > config/vendors.yaml << 'YAML'
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
YAML
  fi
  if [ ! -f config/models.yaml ] || [ ! -s config/models.yaml ]; then
    echo "  Creating minimal models.yaml"
    cat > config/models.yaml << 'YAML'
models:
  - name: gpt-4o-web
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
  - name: jimeng-image-web
    vendor: jimeng
    taskType: image
  - name: gemini-image-web
    vendor: gemini
    taskType: image
  - name: kling-video-web
    vendor: kling
    taskType: video
  - name: jimeng-video-web
    vendor: jimeng
    taskType: video
YAML
  fi
  if [ ! -f config/selectors.yaml ] || [ ! -s config/selectors.yaml ]; then
    echo "  Creating minimal selectors.yaml"
    cat > config/selectors.yaml << 'YAML'
chatgpt:
  input: "#prompt-textarea"
  sendButton: "button[data-testid='send-button']"
  stopButton: "button[data-testid='stop-button']"
  assistantMessage: "[data-message-author-role='assistant']"
  newChatButton: "a[href='/']"
  rateLimitIndicators: ["You've reached", "rate limit"]
  sendStrategy: clipboard
  loginCheck:
    loggedIn: "button[data-testid='account-menu-button']"
    loggedOut: "button[data-testid='login-button'], button[data-testid='signup-button'], a[href*='login']"

claude:
  input: "div.ProseMirror[contenteditable='true']"
  sendButton: "button[aria-label='Send Message']"
  stopButton: "button[aria-label='Stop']"
  assistantMessage: "div.font-claude-message"
  newChatButton: "button[aria-label='New chat']"
  rateLimitIndicators: ["You've reached your limit"]
  sendStrategy: insert
  loginCheck:
    loggedIn: "div.ProseMirror[contenteditable='true']"
    loggedOut: "button:has-text('Log in'), a[href*='login']"

gemini:
  input: "rich-textarea p"
  sendButton: "button[aria-label*='Send'], button[aria-label*='发送']"
  stopButton: "button[aria-label*='Stop'], button[aria-label*='停止']"
  assistantMessage: "message-content .markdown-main-panel"
  newChatButton: "a[href='/app']"
  rateLimitIndicators: ["今天"]
  sendStrategy: insert
  loginCheck:
    loggedIn: "rich-textarea"
    loggedOut: "a[href*='accounts.google.com/ServiceLogin']"
  proModeSwitch: true
  proModeButton: "button[data-test-id='bard-mode-menu-button'], button.input-area-switch"
  proModeOption: "button[data-test-id='bard-mode-option-pro'], button[role='menuitemradio']:has-text('Pro')"
  imageMode:
    triggerButton: "button.card-zero-state, button[aria-label*='制作图片']"
    toolsDrawerButton: "button.toolbox-drawer-button"
    activeTag: ".toolbox-drawer-item-deselect-button"
    imgFilter: "googleusercontent.com, blob:"
    minImgWidth: 100

doubao:
  input: "textarea[data-testid='chat_input'], textarea[placeholder*='输入']"
  sendButton: "button[data-testid='chat_send'], button[aria-label*='发送']"
  stopButton: "button[data-testid='stop'], button[aria-label*='停止']"
  assistantMessage: "[data-testid='receive_message'], div[class*='message-content']"
  newChatButton: "a[href='/chat'], button[aria-label*='新对话']"
  rateLimitIndicators: ["频率过高", "稍后再试", "请求过于频繁"]
  sendStrategy: insert
  loginCheck:
    loggedIn: "textarea[data-testid='chat_input'], textarea[placeholder*='输入']"
    loggedOut: "button:has-text('登录'), [class*='login-modal']"

jimeng:
  loginCheck:
    loggedIn: "textarea[placeholder*='描述'], textarea"
    loggedOut: "button:has-text('登录'), [class*='login']"
  image:
    promptInput: "textarea[placeholder*='描述'], textarea"
    generateButton: "button:has-text('生成'), button:has-text('立即生成')"
    resultImage: "img[class*='result'], img[class*='generated']"
    aspectRatioButton: "button[aria-label*='比例'], [class*='ratio']"
    downloadButton: "button[aria-label*='下载'], button:has-text('下载')"
    rateLimitIndicators: ["余额不足", "频率限制", "积分不足"]
    resultTimeout: 120000
  video:
    promptInput: "textarea[placeholder*='描述'], textarea"
    generateButton: "button:has-text('生成视频'), button:has-text('生成')"
    progressIndicator: "[class*='progress'], [class*='generating'], [class*='排队']"
    queueIndicator: "[class*='queue'], [class*='pending']"
    resultVideo: "video"
    downloadButton: "button[aria-label*='下载'], button:has-text('下载')"
    rateLimitIndicators: ["余额不足", "积分不足"]
    pollInterval: 20000
    resultTimeout: 1800000

kling:
  loginCheck:
    loggedIn: "textarea[placeholder*='描述'], textarea"
    loggedOut: "button:has-text('Sign in'), button:has-text('登录'), a[href*='login']"
  promptInput: "textarea[placeholder*='描述'], textarea"
  generateButton: "button:has-text('Generate'), button:has-text('生成')"
  durationButton: "button:has-text('5s'), button:has-text('10s')"
  aspectRatioButton: "button[aria-label*='ratio'], button[aria-label*='比例']"
  modeButton: "button[aria-label*='mode'], button[aria-label*='模式']"
  queueIndicator: "[class*='queue'], [class*='pending'], [class*='等待']"
  progressIndicator: "[class*='progress'], [class*='generating'], [class*='创作中']"
  resultVideo: "video"
  downloadButton: "button[aria-label*='download'], button[aria-label*='下载']"
  rateLimitIndicators: ["credits", "额度", "insufficient"]
  pollInterval: 15000
  resultTimeout: 1800000
YAML
  fi

# 生成 .env.gateway (备份已有文件, 保留用户自定义的 ALERT_WEBHOOK)
if [ -f .env.gateway ]; then
  cp .env.gateway .env.gateway.bak
  echo "WARNING: Existing .env.gateway backed up to .env.gateway.bak"
  # 提取用户自定义的 ALERT_WEBHOOK (脚本不覆盖)
  EXISTING_WEBHOOK=$(grep "^ALERT_WEBHOOK=" .env.gateway.bak 2>/dev/null | cut -d'=' -f2- || echo "")
fi
cat > .env.gateway << EOF
API_KEY=${API_KEY}
AGENT_TOKEN=${AGENT_TOKEN}
PUBLIC_URL=${PUBLIC_URL}
REDIS_URL=redis://redis:6379
AGENT_TIMEOUT=180000
QUEUE_TIMEOUT=120000
VIDEO_QUEUE_TIMEOUT=600000
VIDEO_TIMEOUT=1800000
MAX_TABS_PER_AGENT=12
FILE_DIR=/data/files
FILE_TTL_HOURS=24
ALERT_WEBHOOK=${EXISTING_WEBHOOK:-}
ALERT_DEDUP_SECONDS=300
EOF

# 生成 docker-compose.yml
if [ "$BUILD" = true ]; then
  echo "Building from source..."
  cat > docker-compose.yml << EOF
version: '3.8'
services:
  gateway:
    build: ./gateway
    container_name: ai-web-gateway
    ports:
      - "26669:26669"
    env_file: .env.gateway
    environment:
      - PORT=26669
    volumes:
      - ./config:/app/config
      - files_data:/data/files
      - config_history:/data/config-history
    restart: always
    depends_on:
      - redis

  redis:
    image: ${REDIS_IMAGE}
    container_name: ai-web-redis
    command: redis-server --maxmemory 256mb --maxmemory-policy volatile-lru
    volumes:
      - redis_data:/data
    restart: always

volumes:
  redis_data:
  files_data:
  config_history:
EOF
else
  echo "Using image: ${IMAGE}"
  cat > docker-compose.yml << EOF
version: '3.8'
services:
  gateway:
    image: ${IMAGE}
    container_name: ai-web-gateway
    ports:
      - "26669:26669"
    env_file: .env.gateway
    environment:
      - PORT=26669
    volumes:
      - ./config:/app/config
      - files_data:/data/files
      - config_history:/data/config-history
    restart: always
    depends_on:
      - redis

  redis:
    image: ${REDIS_IMAGE}
    container_name: ai-web-redis
    command: redis-server --maxmemory 256mb --maxmemory-policy volatile-lru
    volumes:
      - redis_data:/data
    restart: always

volumes:
  redis_data:
  files_data:
  config_history:
EOF
fi

echo "Starting Gateway + Redis..."
$COMPOSE up -d

echo ""
echo "=== Installation complete ==="
echo "Gateway: ${PUBLIC_URL}"
echo "Admin:   ${PUBLIC_URL}/admin"
echo "Health:  ${PUBLIC_URL}/health"
echo ""
echo "Next steps:"
echo "  1. Open ${PUBLIC_URL}/admin and login with API_KEY"
echo "  2. Deploy Agent servers using install-agent.sh"
echo "  3. Login to each AI vendor via the admin panel"
