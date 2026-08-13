// 图片生成适配器基类 — 子类必须实现以下方法
export class BaseImageAdapter {
  async navigate(page, selectors) { throw new Error('not implemented') }
  async uploadReferenceImage(page, filePath, selectors) { throw new Error('not implemented') }
  async setParams(page, params, selectors) { throw new Error('not implemented') }
  async sendPrompt(page, prompt, selectors) { throw new Error('not implemented') }
  async waitForImages(page, selectors) { throw new Error('not implemented') } // → string[] (本地文件路径)
  async checkRateLimit(page, selectors) { return { limited: false } }
}
