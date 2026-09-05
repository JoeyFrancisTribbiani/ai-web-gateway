import json
import websocket
import time

ws = websocket.create_connection("ws://127.0.0.1:9222/devtools/page/49F40D3B5704A77D1ACE9E744078453E")

def cdp(method, params=None, id=1):
    msg = {"id": id, "method": method}
    if params: msg["params"] = params
    ws.send(json.dumps(msg))
    time.sleep(0.5)
    # 读所有消息直到找到匹配的 id
    while True:
        r = json.loads(ws.recv())
        if r.get("id") == id:
            return r

# 先看页面上有什么输入元素
js_inspect = """
(() => {
  // 找所有可能的输入元素
  const textareas = document.querySelectorAll('textarea');
  const editables = document.querySelectorAll('[contenteditable="true"]');
  const buttons = document.querySelectorAll('button[data-testid="send-button"], button[aria-label*="发送"], button[aria-label*="Send"]');
  const allBtns = document.querySelectorAll('button');
  return JSON.stringify({
    textareas: textareas.length,
    textareaIds: [...textareas].map(t => ({id: t.id, className: t.className, tagName: t.tagName})),
    editables: editables.length,
    editableInfo: [...editables].map(e => ({id: e.id, className: (e.className||'').substring(0,50), role: e.getAttribute('role')})),
    sendButtons: buttons.length,
    allBtnCount: allBtns.length,
    btnLabels: [...allBtns].slice(0,10).map(b => b.getAttribute('aria-label') || b.getAttribute('data-testid') || b.textContent?.substring(0,20))
  });
})()
"""

r = cdp("Runtime.evaluate", {"expression": js_inspect, "returnByValue": True}, 1)
value = r.get("result", {}).get("result", {}).get("value", "{}")
print("=== Page elements ===")
print(value)

ws.close()
