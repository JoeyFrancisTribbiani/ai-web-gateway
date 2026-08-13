// 视频生成适配器基类 — 子类必须实现以下方法
export class BaseVideoAdapter {
  async navigate(page, selectors) { throw new Error('not implemented') }
  async setParams(page, params, selectors) { throw new Error('not implemented') }
  async submitGeneration(page, prompt, selectors) { throw new Error('not implemented') }
  async pollStatus(page, selectors) { throw new Error('not implemented') } // → { status, progress }
  async extractVideo(page, selectors) { throw new Error('not implemented') } // → string (本地文件路径)
  async checkRateLimit(page, selectors) { return { limited: false } }
}
