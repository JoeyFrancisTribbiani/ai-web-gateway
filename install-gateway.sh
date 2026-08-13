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
  esac
done

if [ -z "$API_KEY" ]; then echo "ERROR: --api-key is required"; exit 1; fi
if [ -z "$AGENT_TOKEN" ]; then echo "ERROR: --agent-token is required"; exit 1; fi
if [ -z "$PUBLIC_URL" ]; then echo "ERROR: --public-url is required (e.g. http://your-server:26669)"; exit 1; fi

if [ "$BUILD" = true ]; then
  echo "Building gateway from source..."
fi

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

# 下载配置文件
if [ -n "$CONFIG_REPO" ]; then
  echo "Downloading config files from ${CONFIG_REPO}..."
  for f in models.yaml vendors.yaml selectors.yaml; do
    curl -sSL "https://raw.githubusercontent.com/${CONFIG_REPO}/main/config/${f}" -o "config/${f}" || true
  done
else
  echo "WARNING: No --config-repo specified. Creating minimal config files..."
  if [ ! -f config/vendors.yaml ]; then
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
  if [ ! -f config/models.yaml ]; then
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
  echo "WARNING: selectors.yaml not created. Please add it manually or via --config-repo."
fi

# 生成 .env.gateway
cat > .env.gateway << EOF
API_KEY=${API_KEY}
AGENT_TOKEN=${AGENT_TOKEN}
PUBLIC_URL=${PUBLIC_URL}
REDIS_URL=redis://redis:6379
AGENT_TIMEOUT=180000
QUEUE_TIMEOUT=120000
VIDEO_QUEUE_TIMEOUT=600000
VIDEO_TIMEOUT=1800000
MAX_TABS_PER_AGENT=8
FILE_DIR=/data/files
FILE_TTL_HOURS=24
ALERT_WEBHOOK=
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
