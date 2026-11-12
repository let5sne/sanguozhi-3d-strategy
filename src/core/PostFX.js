/**
 * 后处理链（线性 HDR 工作流）
 * ---------------------------------------------------------------------------
 * RenderPass -> SSAO -> 景深 -> 泛光 -> SMAA -> OutputPass -> FilmGrade
 *
 * 借鉴 fable52-fps-repro/demos/04-fps 与 02-materials 的色彩科学做法：
 *  1. 全链使用 HalfFloat RT（EffectComposer 默认），HDR 亮度 >1 不被截断；
 *     泛光阈值才可设在 1.0 以上，只让真正的超亮光源（灯火/水面日照高光）起辉。
 *  2. OutputPass 统一做 ACES + sRGB，是唯一的色彩空间转换点。
 *  3. FilmGrade 位于 OutputPass 之后，工作在「显示参考空间」，做 split-toning /
 *     S 曲线 / 暗角 / 胶片颗粒 / 极轻色差 —— 把「干净的渲染」变成「镜头成像」。
 *     本项目 HUD 是 DOM 覆盖层，不经过后处理，因此调色不会干扰文字可读性。
 *  4. SMAA 必须位于 OutputPass 之前（three 要求线性空间输入）。
 *
 * URL 参数 ?film=0 可关闭调色层做 A/B 对比；低画质档自动关闭颗粒与色差。
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

/* 显示参考空间调色：输入/output 都是已经过 ACES+sRGB 的 0..1 值，不再做 gamma 转换 */
const FilmGradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uEnabled: { value: 1 },
    uCA: { value: 0.10 },        // 径向色差（策略视图只留极轻微镜头感）
    uGrain: { value: 0.014 },    // 胶片颗粒，暗部加权
    uVignette: { value: 0.32 },  // 暗角
    uSplit: { value: 1.0 },      // 分离调色强度：暗部冷青 / 亮部暖金
    uContrast: { value: 0.38 },  // S 曲线对比（照片与「游戏截图」的分水岭）
    uSaturation: { value: 1.08 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uTime, uEnabled, uCA, uGrain, uVignette, uSplit, uContrast, uSaturation;
    varying vec2 vUv;

    float hash(vec2 p) {
      vec3 q = fract(vec3(p.xyx) * 0.1031);
      q += dot(q, q.yzx + 33.33);
      return fract((q.x + q.y) * q.z);
    }

    void main() {
      vec3 src = texture2D(tDiffuse, vUv).rgb;
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);

      // 镜头色差：只在画面边缘出现，中心保持锐利
      vec2 o = c * r2 * uCA * 0.022;
      vec3 col = vec3(
        texture2D(tDiffuse, vUv + o).r,
        src.g,
        texture2D(tDiffuse, vUv - o).b
      );

      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      // split-toning：暗部偏冷青（山水阴影），亮部偏暖金（绢帛 / 日光）
      col = mix(col, col * vec3(0.90, 1.00, 1.10), (1.0 - l) * 0.48 * uSplit);
      col = mix(col, col * vec3(1.07, 1.00, 0.92), l * 0.48 * uSplit);
      // 饱和度微调 + 柔和 S 曲线（避免高光硬切，模拟胶片肩部）
      col = mix(vec3(l), col, uSaturation);
      col = mix(col, col * col * (3.0 - 2.0 * col), uContrast);
      // 暗角
      col *= 1.0 - smoothstep(0.16, 0.82, r2) * uVignette;
      // 胶片颗粒：暗部更明显，随时间抖动
      col += (hash(gl_FragCoord.xy + fract(uTime) * 917.0) - 0.5) * uGrain * (1.0 - l * 0.6);

      gl_FragColor = vec4(mix(src, clamp(col, 0.0, 1.0), uEnabled), 1.0);
    }
  `,
};

export class PostFX {
  constructor(renderer, scene, camera, quality) {
    this.renderer = renderer;
    this.camera = camera;
    this.quality = quality;
    const w = window.innerWidth, h = window.innerHeight;

    // 显式 HalfFloat RT：保证 HDR 亮度在整条链上不被 8bit 截断
    const pr = quality.pixelRatio;
    const target = new THREE.WebGLRenderTarget(
      Math.max(2, Math.floor(w * pr)), Math.max(2, Math.floor(h * pr)),
      { type: THREE.HalfFloatType }
    );
    target.texture.name = 'Sanguo.HDR';
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));

    this.ssao = new SSAOPass(scene, camera, w, h);
    // 大地图尺度下用更大的采样半径，城池/山体才有落地感
    this.ssao.kernelRadius = 14;
    this.ssao.minDistance = 0.0015;
    this.ssao.maxDistance = 0.10;
    this.composer.addPass(this.ssao);

    this.bokeh = new BokehPass(scene, camera, {
      focus: 320, aperture: 0.000028, maxblur: 0.0036,
      width: w, height: h,
    });
    this.composer.addPass(this.bokeh);

    // 阈值 1.0：只有 HDR 超亮像素（灯火、水面日照高光）才起辉，白天不再整片发白
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.38, 0.72, 1.0);
    this.composer.addPass(this.bloom);

    this.smaa = new SMAAPass();
    this.composer.addPass(this.smaa);

    this.composer.addPass(new OutputPass());

    this.film = new ShaderPass(FilmGradeShader);
    this.film.material.depthTest = false;
    this.film.material.depthWrite = false;
    this.composer.addPass(this.film);

    // A/B 对比开关
    const Q = new URLSearchParams(location.search);
    this.filmOff = Q.get('film') === '0';
    this.applyQuality();
  }

  applyQuality() {
    const s = this.quality.settings;
    this.ssao.enabled = s.ssao;
    this.bokeh.enabled = s.dof;
    this.bloom.enabled = s.bloom;
    this.smaa.enabled = s.smaa !== false;
    const u = this.film.uniforms;
    u.uEnabled.value = this.filmOff ? 0 : 1;
    // 移动端去掉逐帧抖动颗粒与色差，避免细密地名字迹被噪声干扰
    u.uGrain.value = this.quality.isMobile ? 0.006 : 0.014;
    u.uCA.value = this.quality.isMobile ? 0.0 : 0.10;
    u.uVignette.value = this.quality.isMobile ? 0.20 : 0.30;
  }

  /** 景深焦点跟着镜头目标走，策略地图主体始终清晰 */
  update(dt, target) {
    this.film.uniforms.uTime.value += dt;
    if (this.bokeh.enabled && this.bokeh.uniforms) {
      const d = this.camera.position.distanceTo(target);
      const f = this.bokeh.uniforms['focus'];
      if (f) f.value += (d - f.value) * Math.min(1, dt * 2.5);
      const a = this.bokeh.uniforms['aperture'];
      // 策略地图要求主体始终锐利，景深只做远处极轻的空气感虚化
      if (a) a.value = 0.000020 + Math.min(0.000012, d * 0.00000002);
    }
    if (this.bloom.enabled) {
      // 夜间略强、正午略弱的辉光；基于 HalfFloat，只有 HDR 像素参与
      const night = THREE.MathUtils.clamp(1.0 - this.renderer.toneMappingExposure, 0, 1);
      this.bloom.strength = 0.32 + night * 0.16;
    }
  }

  setSize(w, h) {
    this.composer.setPixelRatio(this.quality.pixelRatio);
    this.composer.setSize(w, h);
  }

  render(dt) { this.composer.render(dt); }
}
