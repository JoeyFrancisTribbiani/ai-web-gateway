export function buildPrompt(messages) {
  if (!messages || messages.length === 0) return ''

  // 单条 user message → 直接返回 content（如果是字符串）
  if (messages.length === 1 && messages[0].role === 'user') {
    const content = messages[0].content
    if (typeof content === 'string') return content
    // content 是数组（含 text + image_url）
    return extractText(content)
  }

  // 多条 message → 拼接
  const system = messages.filter(m => m.role === 'system').map(m => extractText(m.content)).join('\n')
  const history = messages.filter(m => m.role !== 'system')

  let prompt = ''
  if (system) {
    prompt += `[系统提示]\n${system}\n\n`
  }

  if (history.length > 0) {
    prompt += `[对话历史]\n`
    for (const msg of history) {
      const text = extractText(msg.content)
      const role = msg.role === 'assistant' ? 'Assistant' : 'User'
      prompt += `${role}: ${text}\n`
    }
    prompt += '\n'
  }

  // 最后一条 user message 作为当前问题
  const lastUser = history.filter(m => m.role === 'user').pop()
  if (lastUser) {
    const text = extractText(lastUser.content)
    prompt += `[当前问题]\n${text}`
  }

  // 截断过长 prompt
  if (prompt.length > 8000) {
    const lastUserText = lastUser ? extractText(lastUser.content) : ''
    const systemText = system ? `[系统提示]\n${system}\n\n` : ''
    prompt = `${systemText}[当前问题]\n${lastUserText}`
    console.log(`[message-builder] prompt truncated to ${prompt.length} chars`)
  }

  return prompt
}

function extractText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  const parts = []
  for (const item of content) {
    if (item.type === 'text') {
      parts.push(item.text)
    } else if (item.type === 'image_url') {
      parts.push('[图片已上传]')
    }
  }
  return parts.join('\n')
}

export function extractImageUrls(messages) {
  const urls = []
  if (!messages) return urls

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const item of msg.content) {
      if (item.type === 'image_url' && item.image_url) {
        urls.push(item.image_url.url)
      }
    }
  }
  return urls
}
