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

# 导航到历史对话
r = cdp("Page.navigate", {"url": "https://chatgpt.com/c/6a9c0a9c-21fc-83ea-b8f2-c2c5cb5b789f"}, 1)
print("Navigating...")
time.sleep(8)

# 抓最后一条 assistant 回复的 HTML
js_dom = """
(() => {
  const turns = document.querySelectorAll('[data-message-author-role="assistant"]');
  if (!turns.length) {
    // 试试其他选择器
    const turns2 = document.querySelectorAll('[data-testid^="conversation-turn-"]');
    if (!turns2.length) return 'no turns found at all';
    const last = turns2[turns2.length - 1];
    return 'via conversation-turn: ' + last.outerHTML.substring(0, 5000);
  }
  const last = turns[turns.length - 1];
  return last.outerHTML.substring(0, 5000);
})()
"""
r = cdp("Runtime.evaluate", {"expression": js_dom, "returnByValue": True}, 2)
value = r.get("result", {}).get("result", {}).get("value", "no result")
print("=== Assistant HTML ===")
print(value[:5000])

ws.close()
