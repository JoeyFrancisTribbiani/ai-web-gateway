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

# 1. 聚焦 contenteditable 输入框
js_focus = """
(() => {
  const el = document.querySelector('#prompt-textarea');
  if (!el) return 'no input';
  el.focus();
  return 'focused';
})()
"""
r = cdp("Runtime.evaluate", {"expression": js_focus, "returnByValue": True}, 1)
print("Focus:", r.get("result", {}).get("result", {}).get("value"))

time.sleep(1)

# 2. 用 CDP Input.insertText 输入文字
r = cdp("Input.insertText", {"text": "你好"}, 2)
print("Insert:", r)

time.sleep(1)

# 3. 模拟 Enter 键发送
r = cdp("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "nativeVirtualKeyCode": 13}, 3)
r2 = cdp("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "nativeVirtualKeyCode": 13}, 4)
print("Enter sent")

# 4. 等 40 秒让 ChatGPT 回复
print("Waiting 40s for response...")
time.sleep(40)

# 5. 抓最后一条 assistant 回复的 HTML
js_dom = """
(() => {
  const turns = document.querySelectorAll('[data-message-author-role="assistant"]');
  if (!turns.length) return 'no assistant turns';
  const last = turns[turns.length - 1];
  return last.outerHTML.substring(0, 5000);
})()
"""
r = cdp("Runtime.evaluate", {"expression": js_dom, "returnByValue": True}, 5)
value = r.get("result", {}).get("result", {}).get("value", "no result")
print("=== Assistant HTML ===")
print(value[:5000])

ws.close()
