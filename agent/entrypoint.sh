#!/bin/bash
set -e

DISPLAY_NUM="${DISPLAY#:}"
Xvfb :${DISPLAY_NUM} -screen 0 1280x800x24 -ac +extension RANDR &
sleep 1

# x11vnc 由 vnc-manager.js 按需启动 (login_mode 时 spawn, 登录成功后 kill)
# 不在 entrypoint 启动，避免端口冲突

exec node agent.js
