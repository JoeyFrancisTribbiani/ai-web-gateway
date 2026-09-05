import json
import websocket
import time

ws = websocket.create_connection("ws://127.0.0.1:9222/devtools/page/49F40D3B5704A77D1ACE9E744078453E")

def cdp(method, params=None, id=1):
    msg = {"id": id, "method": method}
    if params: msg["params"] = params
    ws.send(json.dumps(msg))
    time.sleep(0.5)
    while True:
        r = json.loads(ws.recv())
        if r.get("id") == id:
            return r

# 看侧边栏历史对话列表
js_sidebar = """
(() => {
  const links = document.querySelectorAll('a[href*="/c/"]');
  const items = [];
  for (const a of links) {
    items.push({href: a.getAttribute('href'), text: (a.textContent || '').trim().substring(0, 50)});
  }
  return JSON.stringify(items.slice(0, 20));
})()
"""
r = cdp("Runtime.evaluate", {"expression": js_sidebar, "returnByValue": True}, 1)
value = r.get("result", {}).get("result", {}).get("value", "[]")
print("=== History links ===")
print(value)

ws.close()
