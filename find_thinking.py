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

# 搜索页面上所有包含 "Thinking" 或 "thinking" 的元素
js = """
(() => {
  const results = [];
  const all = document.querySelectorAll('*');
  for (const el of all) {
    const text = (el.textContent || '').trim();
    if (text.length < 50 && /think/i.test(text)) {
      results.push({
        tag: el.tagName,
        className: (el.className || '').substring(0, 80),
        text: text.substring(0, 50),
        testid: el.getAttribute('data-testid'),
        role: el.getAttribute('role')
      });
    }
    if (results.length > 20) break;
  }
  return JSON.stringify(results);
})()
"""
r = cdp("Runtime.evaluate", {"expression": js, "returnByValue": True}, 1)
value = r.get("result", {}).get("result", {}).get("value", "[]")
print("=== Elements with 'thinking' ===")
print(value)

ws.close()
