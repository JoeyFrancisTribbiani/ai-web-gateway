// 对话适配器基类 — 子类必须实现以下方法
export class BaseChatAdapter {
  async navigate(page, selectors) { throw new Error('not implemented') }
  async uploadFile(page, filePath, selectors) { throw new Error('not implemented') }
  async sendPrompt(page, prompt, selectors) { throw new Error('not implemented') }
  async streamResponse(page, onChunk, selectors, signal) { throw new Error('not implemented') }
  async checkRateLimit(page, selectors) { return { limited: false } }
}
