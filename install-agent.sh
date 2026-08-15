#!/bin/bash
set -e

# ai-web-gateway Agent 一键安装脚本
# 用法: ./install-agent.sh --gateway=ws://gateway-host:26669/agent --token=agent-secret
# 可选: --image=ghcr.io/owner/repo/agent:latest --config-url=http://gateway-host:26669 --vendors=all --proxy=http://clash:7890 --scale=1 --hostname=agent

INSTALL_DIR="/opt/ai-web-agent"
IMAGE="${AGENT_IMAGE:-ai-web-agent:latest}"
GATEWAY_URL=""
TOKEN=""
CONFIG_URL=""
CONFIG_REPO=""
VENDORS="all"
PROXY=""
SCALE=1
VNC_PORT="${VNC_PORT:-5900}"
AGENT_HOSTNAME="agent"
VNC_HOST=""
BUILD=false
# 解析参数
for arg in "$@"; do
  case $arg in
    --image=*)        IMAGE="${arg#*=}" ;;
    --gateway=*)      GATEWAY_URL="${arg#*=}" ;;
    --token=*)        TOKEN="${arg#*=}" ;;
    --config-url=*)   CONFIG_URL="${arg#*=}" ;;
    --config-repo=*)  CONFIG_REPO="${arg#*=}" ;;
    --vendors=*)      VENDORS="${arg#*=}" ;;
    --proxy=*)        PROXY="${arg#*=}" ;;
    --scale=*)        SCALE="${arg#*=}" ;;
    --vnc-port=*)     VNC_PORT="${arg#*=}" ;;
    --vnc-host=*)     VNC_HOST="${arg#*=}" ;;
    --hostname=*)     AGENT_HOSTNAME="${arg#*=}" ;;
    --dir=*)          INSTALL_DIR="${arg#*=}" ;;
    --build)          BUILD=true ;;
  esac
done

if [ -z "$GATEWAY_URL" ]; then echo "ERROR: --gateway is required (e.g. ws://gateway-host:26669/agent)"; exit 1; fi
if [ -z "$TOKEN" ]; then echo "ERROR: --token is required"; exit 1; fi

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

if [ "$BUILD" = true ]; then
  if [ ! -d "./agent" ]; then
    echo "ERROR: --build mode requires ./agent source directory in ${INSTALL_DIR}"
    exit 1
  fi
  echo "Building agent from source..."
fi

# 下载配置文件 (Gateway API → GitHub fallback → 最小化配置)
echo "Downloading config files..."

download_from_gateway() {
  local f="$1"
  if curl -sfSL "${CONFIG_URL}/admin/config/${f%.yaml}" -H "Authorization: Bearer ${TOKEN}" -o "config/${f}" 2>/dev/null; then
    # admin API 返回 JSON { name, content }，需要提取 content
    if command -v python3 &>/dev/null; then
      python3 -c "import json,sys; d=json.load(open('config/${f}')); open('config/${f}','w').write(d.get('content',''))" 2>/dev/null
      if [ $? -ne 0 ]; then rm -f "config/${f}"; return 1; fi
    elif command -v jq &>/dev/null; then
      jq -r '.content' "config/${f}" > "config/${f}.tmp" && mv "config/${f}.tmp" "config/${f}" 2>/dev/null
      if [ $? -ne 0 ]; then rm -f "config/${f}" "config/${f}.tmp"; return 1; fi
    else
      # 无法解析 JSON，删除文件让 fallback 触发
      rm -f "config/${f}"
      return 1
    fi
    return 0
  fi
  return 1
}

download_from_github() {
  local f="$1"
  if [ -z "$CONFIG_REPO" ]; then return 1; fi
  if curl -sfSL "https://raw.githubusercontent.com/${CONFIG_REPO}/main/config/${f}" -o "config/${f}" 2>/dev/null; then
    return 0
  fi
  return 1
}

for f in vendors.yaml selectors.yaml; do
  if download_from_gateway "$f"; then
    echo "  Downloaded ${f} from Gateway"
  elif download_from_github "$f"; then
    echo "  Downloaded ${f} from GitHub (${CONFIG_REPO})"
  else
    echo "  WARNING: Failed to download ${f}, creating minimal config"
  fi
done

# vendors.yaml fallback (必须存在)
if [ ! -f config/vendors.yaml ] || [ ! -s config/vendors.yaml ]; then
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
  echo "  Created minimal vendors.yaml"
fi

# selectors.yaml fallback
if [ ! -f config/selectors.yaml ] || [ ! -s config/selectors.yaml ]; then
  cat > config/selectors.yaml << 'YAML'
chatgpt:
  loginCheck:
    loggedIn: "button[data-testid='account-menu-button']"
    loggedOut: "button[data-testid='login-button'], button[data-testid='signup-button'], a[href*='login']"
claude:
  loginCheck:
    loggedIn: "div.ProseMirror[contenteditable='true']"
    loggedOut: "button:has-text('Log in'), a[href*='login']"
gemini:
  loginCheck:
    loggedIn: "rich-textarea"
    loggedOut: "a[href*='accounts.google.com/ServiceLogin']"
doubao:
  loginCheck:
    loggedIn: "textarea[data-testid='chat_input'], textarea[placeholder*='输入']"
    loggedOut: "button:has-text('登录'), [class*='login-modal']"
jimeng:
  loginCheck:
    loggedIn: "textarea[placeholder*='描述'], textarea"
    loggedOut: "button:has-text('登录'), [class*='login']"
kling:
  loginCheck:
    loggedIn: "textarea[placeholder*='描述'], textarea"
    loggedOut: "button:has-text('Sign in'), button:has-text('登录'), a[href*='login']"
YAML
  echo "  Created minimal selectors.yaml (login check only — re-run install-agent.sh after Gateway is ready, or use --config-repo, or manually copy selectors.yaml)"
fi

# 生成 .env.agent (备份已有文件, 未设 --proxy 时保留旧代理配置)
if [ -f .env.agent ]; then
  cp .env.agent .env.agent.bak
  echo "WARNING: Existing .env.agent backed up to .env.agent.bak"
  if [ -z "$PROXY" ]; then
    EXISTING_PROXY=$(grep "^HTTP_PROXY=" .env.agent.bak 2>/dev/null | cut -d'=' -f2- || echo "")
    if [ -n "$EXISTING_PROXY" ]; then
      PROXY="$EXISTING_PROXY"
      echo "  Preserved HTTP_PROXY from previous install"
    fi
  fi
fi
cat > .env.agent << EOF
GATEWAY_URL=${GATEWAY_URL}
AGENT_TOKEN=${TOKEN}
VENDORS=${VENDORS}
MAX_TASKS_PER_CONTEXT=5
MAX_TABS=12
DISPLAY=:99
POLL_INTERVAL=500
STABLE_COUNT=3
HTTP_PROXY=${PROXY}
HTTPS_PROXY=${PROXY}
VNC_PORT=5900
# VNC_HOST: Gateway 连接 Agent VNC 的地址
# 单机部署: 用容器名 (默认 = hostname)
# 分布式部署: 用 Agent 服务器 IP (必须从 Gateway 可达)
VNC_HOST=${VNC_HOST:-${AGENT_HOSTNAME}}
EOF

# VNC 端口映射策略: SCALE=1 固定端口, SCALE>1 动态端口避免冲突
if [ "$SCALE" -le 1 ]; then
  VNC_PORT_MAPPING="127.0.0.1:${VNC_PORT}:5900"
else
  VNC_PORT_MAPPING="127.0.0.1::5900"
fi

# 生成 docker-compose.yml
if [ "$BUILD" = true ]; then
  echo "Building from source..."
  cat > docker-compose.yml << EOF
version: '3.8'
services:
  agent:
    build: ./agent
    hostname: ${AGENT_HOSTNAME}
    env_file: .env.agent
    ports:
      - "${VNC_PORT_MAPPING}"
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
    hostname: ${AGENT_HOSTNAME}
    env_file: .env.agent
    ports:
      - "${VNC_PORT_MAPPING}"
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
echo "Hostname:  ${AGENT_HOSTNAME}"
echo "Profile:  /data/chrome/${AGENT_HOSTNAME} (Chrome 登录态持久化路径)"
if [ "$SCALE" -le 1 ]; then
  echo "VNC:      127.0.0.1:${VNC_PORT} (for first login)"
else
  echo "VNC:      dynamic ports (run 'docker compose ps' to see mappings)"
  echo "WARNING:  --scale > 1 with same hostname will cause profile conflicts."
  echo "          For multi-instance, use separate service definitions with different --hostname."
fi
echo ""
echo "Next steps:"
echo "  1. Open ${CONFIG_URL}/admin and login"
echo "  2. Go to 'Account Management' and login to each AI vendor via VNC"
if [ "$SCALE" -gt 1 ]; then
  echo "  3. VNC port per instance: docker compose ps --format 'table {{.Name}}\t{{.Ports}}'"
fi
echo "  4. docker compose restart 可保留登录态; docker compose down/up 会重建容器但 hostname 固定, profile 保留"
echo "  5. For multi-instance: re-run install-agent.sh with --hostname=agent-02 on the same or different server"
