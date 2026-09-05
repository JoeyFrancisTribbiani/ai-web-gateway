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

# 导航到视频分析对话（很可能有 thinking）
r = cdp("Page.navigate", {"url": "https://chatgpt.com/c/6a7dc1da-7334-83ea-950d-084154d44a69"}, 1)
print("Navigating to 视频内容分析与分段...")
time.sleep(8)

# 抓最后一条 assistant 回复的完整 HTML
js_dom = """
(() => {
  const turns = document.querySelectorAll('[data-message-author-role="assistant"]');
  if (!turns.length) return 'no turns';
  const last = turns[turns.length - 1];
  return last.outerHTML.substring(0, 8000);
})()
"""
r = cdp("Runtime.evaluate", {"expression": js_dom, "returnByValue": True}, 2)
value = r.get("result", {}).get("result", {}).get("value", "no result")
print("=== Assistant HTML ===")
print(value[:8000])

ws.close()
