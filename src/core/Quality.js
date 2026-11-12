/**
 * 设备能力检测 + 自适应画质
 * ---------------------------------------------------------------------------
 * 启动时按 UA / 屏幕 / 硬件线程数选档；运行中若持续掉帧则自动降档并降低
 * 像素比，保证桌面与移动端都有稳定帧率。用户也可在 HUD 里手动锁定档位。
 */
import { CONFIG } from '../config.js';

export class Quality {
  constructor(renderer) {
    this.renderer = renderer;
    const ua = navigator.userAgent;
    const small = Math.min(window.innerWidth, window.innerHeight) < 820;
    const touch = navigator.maxTouchPoints > 1;
    this.isMobile = /Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(ua) || (small && touch);
    this.tier = this.isMobile ? 'low' : (navigator.hardwareConcurrency || 4) >= 8 ? 'high' : 'medium';
    this.originalTier = this.tier;
    this.locked = false;
    this.maxAnisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
    this._lowFpsTime = 0;
    this._sampleTime = 0;
    this._frames = 0;
    this.apply();
  }

  get settings() { return CONFIG.post[this.tier]; }
  get populationIndex() { return this.tier === 'low' ? 1 : 0; }
  get pixelRatio() {
    const cap = this.settings.maxPixelRatio;
    // 按总像素预算自适应：4K 屏上自动降采样，避免后处理链（HalfFloat + SSAO + SMAA）
    // 把填充率吃满。参考 fable52-fps-repro/04-fps 的 sqrt(2.9e6/(w*h)) 策略。
    const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
    const budgetCap = Math.max(0.75, Math.sqrt(CONFIG.post.pixelBudget / (w * h)));
    return Math.min(window.devicePixelRatio || 1, cap, budgetCap);
  }

  apply() {
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.shadowMap.needsUpdate = true;
  }

  setTier(tier) {
    if (!CONFIG.post[tier]) return;
    this.tier = tier;
    this.locked = true;
    this.apply();
  }

  /** 每帧采样；连续 2.5s 低于 40fps 则降一档（仅在未手动锁定时） */
  tick(dt) {
    if (this.locked || dt <= 0) return;
    this._frames++;
    this._sampleTime += dt;
    if (this._sampleTime >= 0.5) {
      const fps = this._frames / this._sampleTime;
      this._frames = 0; this._sampleTime = 0;
      this._lowFpsTime = fps < 40 ? this._lowFpsTime + 0.5 : Math.max(0, this._lowFpsTime - 0.5);
      if (this._lowFpsTime >= 2.5) {
        this._lowFpsTime = 0;
        if (this.tier === 'high') { this.tier = 'medium'; this.apply(); return 'medium'; }
        if (this.tier === 'medium') { this.tier = 'low'; this.apply(); return 'low'; }
      }
    }
    return null;
  }
}
