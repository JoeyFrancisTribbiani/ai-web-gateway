#!/bin/bash
set -e

DISPLAY_NUM="${DISPLAY#:}"
Xvfb :${DISPLAY_NUM} -screen 0 1280x800x24 -ac +extension RANDR &
sleep 1

if [ -n "$VNC_PORT" ]; then
  x11vnc -display :${DISPLAY_NUM} -nopw -listen 0.0.0.0 \
    -rfbport ${VNC_PORT} -forever -shared -noxfixes &
fi

exec node agent.js
