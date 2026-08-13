#!/bin/bash
set -e

# ai-web-gateway Agent 一键安装脚本
# 用法: ./install-agent.sh --gateway=ws://gateway-host:26669/agent --token=agent-secret
# 可选: --image=ghcr.io/owner/repo/agent:latest --config-url=http://gateway-host:26669 --vendors=all --proxy=http://clash:7890 --scale=1

INSTALL_DIR="/opt/ai-web-agent"
IMAGE="${AGENT_IMAGE:-ai-web-agent:latest}"
GATEWAY_URL=""
TOKEN=""
CONFIG_URL=""
VENDORS="all"
PROXY=""
SCALE=1
BUILD=false
# 解析参数
for arg in "$@"; do
  case $arg in
    --image=*)      IMAGE="${arg#*=}" ;;
    --gateway=*)    GATEWAY_URL="${arg#*=}" ;;
    --token=*)      TOKEN="${arg#*=}" ;;
    --config-url=*) CONFIG_URL="${arg#*=}" ;;
    --vendors=*)    VENDORS="${arg#*=}" ;;
    --proxy=*)      PROXY="${arg#*=}" ;;
    --scale=*)       SCALE="${arg#*=}" ;;
    --dir=*)        INSTALL_DIR="${arg#*=}" ;;
    --build)        BUILD=true ;;
  esac
done

if [ -z "$GATEWAY_URL" ]; then echo "ERROR: --gateway is required (e.g. ws://gateway-host:26669/agent)"; exit 1; fi
if [ -z "$TOKEN" ]; then echo "ERROR: --token is required"; exit 1; fi

if [ "$BUILD" = true ]; then
  echo "Building agent from source..."
fi

# 从 GATEWAY_URL 提取 CONFIG_URL（如果未指定）
if [ -z "$CONFIG_URL" ]; then
  CONFIG_URL=$(echo "$GATEWAY_URL" | sed 's|ws://|http://|; s|wss://|https://|; s|/agent||')
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

echo "=== Installing ai-web-agent to ${INSTALL_DIR} ==="
echo "Gateway: ${GATEWAY_URL}"
echo "Image:   ${IMAGE}"
echo "Vendors: ${VENDORS}"

mkdir -p "${INSTALL_DIR}/config"
cd "${INSTALL_DIR}"

# 下载配置文件
echo "Downloading config files from ${CONFIG_URL}..."
for f in vendors.yaml selectors.yaml; do
  if curl -sfSL "${CONFIG_URL}/admin/config/${f%.yaml}" -H "Authorization: Bearer ${TOKEN}" -o "config/${f}" 2>/dev/null; then
    # admin API 返回 JSON { name, content }，需要提取 content
    if command -v python3 &>/dev/null; then
      python3 -c "import json,sys; d=json.load(open('config/${f}')); open('config/${f}','w').write(d.get('content',''))" 2>/dev/null || true
    elif command -v jq &>/dev/null; then
      jq -r '.content' "config/${f}" > "config/${f}.tmp" && mv "config/${f}.tmp" "config/${f}" 2>/dev/null || true
    fi
    echo "  Downloaded ${f}"
  else
    echo "  WARNING: Failed to download ${f}. Please copy it manually to config/${f}"
  fi
done

if [ ! -f config/vendors.yaml ]; then
  echo "ERROR: config/vendors.yaml is missing. Cannot start Agent."
  exit 1
fi

# 生成 .env.agent
cat > .env.agent << EOF
GATEWAY_URL=${GATEWAY_URL}
AGENT_TOKEN=${TOKEN}
VENDORS=${VENDORS}
MAX_TASKS_PER_CONTEXT=5
MAX_TABS=8
DISPLAY=:99
POLL_INTERVAL=500
STABLE_COUNT=3
HTTP_PROXY=${PROXY}
HTTPS_PROXY=${PROXY}
CHROME_ARGS=--disable-blink-features=AutomationControlled,--no-sandbox,--disable-setuid-sandbox,--disable-gpu,--disable-dev-shm-usage,--mute-audio,--window-size=1280,800,--no-first-run,--no-zygote
VNC_PORT=5900
EOF

# 生成 docker-compose.yml
if [ "$BUILD" = true ]; then
  echo "Building from source..."
  cat > docker-compose.yml << EOF
version: '3.8'
services:
  agent:
    build: ./agent
    env_file: .env.agent
    shm_size: '2gb'
    deploy:
      resources:
        limits:
          memory: 2G
    volumes:
      - chrome_data:/data/chrome
      - ./config:/app/config
    restart: always

volumes:
  chrome_data:
EOF
else
  echo "Using image: ${IMAGE}"
  cat > docker-compose.yml << EOF
version: '3.8'
services:
  agent:
    image: ${IMAGE}
    env_file: .env.agent
    shm_size: '2gb'
    deploy:
      resources:
        limits:
          memory: 2G
    volumes:
      - chrome_data:/data/chrome
      - ./config:/app/config
    restart: always

volumes:
  chrome_data:
EOF
fi

echo "Starting Agent (scale=${SCALE})..."
$COMPOSE up -d --scale agent=${SCALE}

echo ""
echo "=== Agent installation complete ==="
echo "Instances: ${SCALE}"
echo ""
echo "Next steps:"
echo "  1. Open ${CONFIG_URL}/admin and login"
echo "  2. Go to 'Account Management' and login to each AI vendor"
echo "  3. To add more instances: docker compose up -d --scale agent=N"
echo "  4. To enable VNC for first login, edit docker-compose.yml and add ports + VNC_PORT"
echo "     Then: docker compose up -d"
