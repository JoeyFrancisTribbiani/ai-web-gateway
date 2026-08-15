#!/bin/bash
set -e

DISPLAY_NUM="${DISPLAY#:}"
# 清理可能残留的 Xvfb 锁文件 (容器重启时不会自动清理)
rm -f /tmp/.X${DISPLAY_NUM}-lock /tmp/.X11-unix/X${DISPLAY_NUM}
Xvfb :${DISPLAY_NUM} -screen 0 1280x800x24 -ac +extension RANDR &
sleep 1

# x11vnc 由 vnc-manager.js 按需启动 (login_mode 时 spawn, 登录成功后 kill)
# 不在 entrypoint 启动，避免端口冲突

exec node agent.js
