import json
import websocket
import time

ws = websocket.create_connection("ws://127.0.0.1:9222/devtools/page/49F40D3B5704A77D1ACE9E744078453E")

def cdp(method, params=None, id=1):
    msg = {"id": id, "method": method}
    if params: msg["params"] = params
    ws.send(json.dumps(msg))
    time.sleep(0.5)
    return json.loads(ws.recv())

# 找到输入框并输入文字
js_type = """
(() => {
  const textarea = document.querySelector('#prompt-textarea') || document.querySelector('textarea');
  if (!textarea) return 'no textarea';
  textarea.focus();
  // 用 React 兼容方式设值
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'value')?.set;
  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(textarea, '你好');
  } else {
    textarea.value = '你好';
  }
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  return 'typed';
})()
"""

r = cdp("Runtime.evaluate", {"expression": js_type, "returnByValue": True}, 1)
print("Type:", r.get("result", {}).get("result", {}).get("value", "no result"))

time.sleep(2)

# 按 Enter 发送
js_enter = """
(() => {
  const textarea = document.querySelector('#prompt-textarea') || document.querySelector('textarea');
  if (!textarea) return 'no textarea';
  textarea.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true}));
  return 'sent';
})()
"""

r = cdp("Runtime.evaluate", {"expression": js_enter, "returnByValue": True}, 2)
print("Send:", r.get("result", {}).get("result", {}).get("value", "no result"))

# 等 30 秒让 ChatGPT 回复
print("Waiting 30s for response...")
time.sleep(30)

# 抓 DOM
js_dom = """
(() => {
  const turns = document.querySelectorAll('[data-message-author-role="assistant"]');
  if (!turns.length) return 'no assistant turns';
  const last = turns[turns.length - 1];
  return last.outerHTML.substring(0, 5000);
})()
"""

r = cdp("Runtime.evaluate", {"expression": js_dom, "returnByValue": True}, 3)
value = r.get("result", {}).get("result", {}).get("value", "no result")
print("=== Assistant HTML ===")
print(value[:5000])

ws.close()
