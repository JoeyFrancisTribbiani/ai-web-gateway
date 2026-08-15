#!/bin/bash
# 在服务器上执行: bash setup_proxy.sh

set -e

echo "=== 1. 启动 mihomo ==="
pkill mihomo 2>/dev/null || true
sleep 1

# 直接前台测试启动
echo "测试配置..."
mihomo -t -d /etc/mihomo 2>&1 || { echo "配置错误"; exit 1; }

echo "启动 mihomo..."
nohup mihomo -d /etc/mihomo > /var/log/mihomo.log 2>&1 &
sleep 3

echo "日志:"
tail -20 /var/log/mihomo.log

echo ""
echo "=== 2. 测试代理 ==="
curl -s --proxy http://127.0.0.1:7890 --connect-timeout 10 https://api.github.com/zen 2>&1 || echo "代理测试失败"

echo ""
echo "=== 3. Docker 代理配置 ==="
cat /etc/systemd/system/docker.service.d/proxy.conf
echo ""
echo "重启 Docker..."
systemctl daemon-reload
systemctl restart docker
sleep 3
docker info 2>&1 | grep -i proxy

echo ""
echo "=== 4. 拉取 Agent 镜像 ==="
docker pull ghcr.io/joeyfrancistribbiani/ai-web-gateway/agent:latest 2>&1

echo ""
echo "=== 5. 启动服务 ==="
cd /opt/ai-web-gateway
docker compose up -d 2>&1
sleep 15

echo ""
echo "=== 6. 检查 ==="
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
echo ""
curl -s http://localhost:26669/health 2>&1 || echo "health check failed"
echo ""
docker logs ai-web-gateway --tail 5 2>&1
echo ""
docker logs ai-web-agent --tail 5 2>&1
