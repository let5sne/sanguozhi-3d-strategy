/**
 * 大气与光照系统
 * ---------------------------------------------------------------------------
 * · Preetham 天空散射模型（Sky）+ PMREM 生成的真实环境反射（IBL）
 * · 单一平行太阳光 + PCF 柔和阴影 + 半球补光；阴影相机跟随镜头焦点
 * · 24 小时昼夜循环、四季太阳高度角、晴/阴/雨/雪的辐照度与雾色联动
 * · 输出 env 对象供水体 / 植被 / 天气 / 后处理统一取用
 */
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { CONFIG, SEASONS, WEATHER } from '../config.js';

const c = (hex) => new THREE.Color(hex);
const lerpC = (a, b, t) => a.clone().lerp(b, t);

export class Lighting {
  constructor(scene, renderer, quality) {
    this.scene = scene;
    this.renderer = renderer;
    this.quality = quality;
    this.hour = CONFIG.lighting.startHour;
    this.season = CONFIG.season;
    this.weather = CONFIG.weather;
    this.autoDay = CONFIG.lighting.dayLength > 0;

    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.focus = new THREE.Vector3(0, 0, 0);
    this.env = {
      sunDir: new THREE.Vector3(0, 1, 0),
      sunColor: c(0xffe2b8),
      skyColor: c(0x8fb9d6),
      fogColor: c(0x9fb0b8),
      waterColor: c(0x1b4250),
      cloudColor: c(0xffffff),
      fogDensity: CONFIG.lighting.fogDensity,
      exposure: CONFIG.lighting.exposure,
      night: 0,
      weather: this.weather,
      season: this.season,
      hour: this.hour,
      sunIntensity: 1,
    };

    this.buildSky();
    this.buildLights();
    this.buildStars();
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();
    this.envTimer = 0;
    this.apply(0, true);
  }

  buildSky() {
    this.sky = new Sky();
    this.sky.scale.setScalar(4200);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 6.0;
    u.rayleigh.value = 2.1;
    u.mieCoefficient.value = 0.006;
    u.mieDirectionalG.value = 0.82;
    // r187 的 Sky 自带体积感云层，交给天气系统控制
    u.cloudCoverage.value = 0.10;
    u.cloudDensity.value = 0.30;
    u.cloudScale.value = 0.00022;
    u.cloudElevation.value = 0.55;
    this.sky.material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        'gl_FragColor = vec4( texColor, 1.0 );',
        'gl_FragColor = vec4( texColor * 0.052 * vec3(0.74, 0.90, 1.26), 1.0 );'
      );
    };
    this.sky.material.customProgramCacheKey = () => 'sky-gain-v3';
    this.scene.add(this.sky);
    this.scene.fog = new THREE.FogExp2(this.env.fogColor.clone(), this.env.fogDensity);

    // IBL 用等距柱状渐变贴图（比每帧渲染 Sky 立方图稳定且便宜），节流刷新
    this.envCanvas = document.createElement('canvas');
    this.envCanvas.width = 512; this.envCanvas.height = 256;
    this.envTex = new THREE.CanvasTexture(this.envCanvas);
    this.envTex.mapping = THREE.EquirectangularReflectionMapping;
    this.envTex.colorSpace = THREE.SRGBColorSpace;
  }

  buildLights() {
    this.sun = new THREE.DirectionalLight(0xffe4bd, 2.1);
    this.sun.castShadow = true;
    const s = this.quality.isMobile ? 1024 : CONFIG.lighting.shadowMapSize;
    this.sun.shadow.mapSize.set(s, s);
    const span = this.quality.isMobile ? 150 : 205;
    const cam = this.sun.shadow.camera;
    cam.left = -span; cam.right = span; cam.top = span; cam.bottom = -span;
    cam.near = 1; cam.far = 1600;
    this.sun.shadow.bias = -0.00035;
    // 参考 fable52-fps-repro/03-models：normalBias 必须随场景包围盒尺度线性缩放，
    // 写死数值在大跨度地图上会出现 shadow acne 或 peter-panning。
    this.sun.shadow.normalBias = span * 0.0027;
    this.sun.shadow.radius = CONFIG.lighting.shadowRadius;
    this.sun.shadow.blurSamples = 8;
    this.sun.target = new THREE.Object3D();
    this.scene.add(this.sun, this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xbcd4ea, 0x50412c, 0.62);
    this.scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(0x6a7d92, 0.16);
    this.scene.add(this.ambient);
    // 月光：不带阴影的冷色补光，保证夜间的山形与城郭仍可辨识（策略地图可读性）
    this.moonLight = new THREE.DirectionalLight(0x9db6dc, 0);
    this.moonLight.castShadow = false;
    this.scene.add(this.moonLight);
  }

  buildStars() {
    const n = 1600;
    const pos = new Float32Array(n * 3);
    const size = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const y = 0.06 + Math.random() * 0.94;
      const r = Math.sqrt(1 - y * y);
      pos[i * 3] = Math.cos(a) * r * 2600;
      pos[i * 3 + 1] = y * 2600;
      pos[i * 3 + 2] = Math.sin(a) * r * 2600;
      size[i] = 1 + Math.random() * 2.4;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({
      color: 0xe8eeff, size: 2.0, sizeAttenuation: false,
      transparent: true, opacity: 0, depthWrite: false, fog: false,
    });
    this.stars = new THREE.Points(g, m);
    this.scene.add(this.stars);

    // 月亮（夜间柔和冷光，非写实天文位置，仅为氛围）
    this.moon = new THREE.Mesh(
      new THREE.SphereGeometry(20, 24, 16),
      new THREE.MeshBasicMaterial({ color: 0xe9ecdf, fog: false, transparent: true, opacity: 0 })
    );
    this.scene.add(this.moon);
  }

  /** 绘制 IBL 用的等距柱状天空：天顶 -> 地平线 -> 地面 + 太阳光斑 */
  paintEnvMap(sky, sun, dir, day, cloud) {
    const cv = this.envCanvas, ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    const css = (col) => `rgb(${Math.round(col.r * 255)},${Math.round(col.g * 255)},${Math.round(col.b * 255)})`;
    const zenith = sky.clone().multiplyScalar(0.52 + cloud * 0.25);
    const horizon = sky.clone().lerp(new THREE.Color(0xd8d4c4), 0.22 + cloud * 0.2);
    const ground = new THREE.Color(0x4a4034).lerp(sky, 0.18);
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, css(zenith));
    g.addColorStop(0.47, css(horizon));
    g.addColorStop(0.54, css(horizon.clone().multiplyScalar(0.82)));
    g.addColorStop(1, css(ground));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    if (day > 0.02) {
      const u = Math.atan2(dir.z, dir.x) / (Math.PI * 2) + 0.5;
      const v = 0.5 - Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)) / Math.PI;
      const sx = u * W, sy = v * H;
      for (const [rad, alpha] of [[110, 0.10], [52, 0.28], [16, 0.9]]) {
        const rg = ctx.createRadialGradient(sx, sy, 0, sx, sy, rad);
        rg.addColorStop(0, `rgba(255,246,220,${alpha * day * (1 - cloud * 0.7)})`);
        rg.addColorStop(1, 'rgba(255,240,205,0)');
        ctx.fillStyle = rg; ctx.fillRect(sx - rad, sy - rad, rad * 2, rad * 2);
      }
    }
  }

  /** 阴影相机跟随镜头焦点，保证近处城池/人物始终有高精度阴影 */
  updateShadowFocus(target) {
    this.focus.set(target.x, 0, target.z);
  }

  setHour(h) { this.hour = ((h % 24) + 24) % 24; this.apply(0, true); }
  setSeason(s) { if (SEASONS[s]) { this.season = s; this.apply(0, true); } }
  setWeather(w) { if (WEATHER[w]) { this.weather = w; this.apply(0, true); } }
  setAutoDay(v) { this.autoDay = !!v; }

  update(dt) {
    if (this.autoDay) {
      this.hour = (this.hour + (24 / CONFIG.lighting.dayLength) * dt) % 24;
    }
    this.apply(dt, false);
  }

  /** 计算并平滑应用本帧全部光照参数 */
  apply(dt, immediate) {
    const S = SEASONS[this.season], W = WEATHER[this.weather];
    // 太阳高度：正午最高，四季改变最大高度角
    const phase = (this.hour - 6) / 12 * Math.PI;
    const rawElev = Math.sin(phase) * 0.92 * S.sunHeight;
    const elev = Math.max(-0.34, rawElev);
    const azim = ((this.hour - 6) / 24) * Math.PI * 2 + 0.65;
    const dir = new THREE.Vector3(Math.cos(azim) * Math.cos(elev), Math.sin(elev), Math.sin(azim) * Math.cos(elev)).normalize();
    this.sunDir.copy(dir);

    const day = THREE.MathUtils.smoothstep(rawElev, -0.12, 0.30);  // 0 夜 / 1 昼
    const dusk = 1 - THREE.MathUtils.smoothstep(rawElev, 0.02, 0.42); // 日出日落权重
    const night = 1 - day;
    this.env.night = night;
    this.env.hour = this.hour;
    this.env.weather = this.weather;
    this.env.season = this.season;

    /* ---- 天空 / 太阳色 ---- */
    const noonSun = c(0xfff0d4), duskSun = c(0xff9a54), nightSun = c(0x6f8fc4);
    let sunColor = lerpC(duskSun, noonSun, THREE.MathUtils.smoothstep(rawElev, 0.05, 0.55));
    sunColor = lerpC(sunColor, nightSun, night * 0.55);
    const skyDay = c(0x87b6d9), skyDusk = c(0xd08a68), skyNight = c(0x0d1a32);
    let skyColor = lerpC(skyDusk, skyDay, THREE.MathUtils.smoothstep(rawElev, 0.02, 0.5));
    skyColor = lerpC(skyColor, skyNight, night * 0.90);
    // 云量越大天空越灰、越亮（阴天散射）
    const gray = c(0x9aa5ab);
    skyColor.lerp(gray, W.cloud * 0.58);

    const fogBase = lerpC(c(0xc6cfd0), c(0x2b3a4e), night);
    fogBase.lerp(skyColor, 0.42);
    fogBase.lerp(c(0x8e9ba0), W.cloud * 0.24); // 阴雨雾色不宜过亮，否则整图发白
    const fogDensity = CONFIG.lighting.fogDensity * S.fog * W.fog * (1 + night * 0.10);
    // 夜间保持较高曝光下限：版图信息在任何时辰都要读得清
    const exposure = (0.84 + day * 0.34) * CONFIG.lighting.exposure * (1 - W.cloud * 0.12);

    /* ---- 灯光 ---- */
    const sunIntensity = Math.max(0, rawElev + 0.12) * 3.0 * W.sun * (1 - W.cloud * 0.25);
    this.sun.color.copy(sunColor);
    this.sun.intensity = sunIntensity;
    this.sun.position.copy(dir).multiplyScalar(720).add(this.focus);
    this.sun.target.position.copy(this.focus);
    this.sun.target.updateMatrixWorld();
    this.sun.shadow.camera.updateProjectionMatrix();

    this.hemi.color.copy(skyColor).lerp(c(0xffffff), 0.35);
    this.hemi.groundColor.copy(lerpC(c(0x544735), c(0x14202c), night));
    this.hemi.intensity = 0.46 + day * 0.44 * (1 - W.cloud * 0.42);
    this.ambient.color.copy(lerpC(c(0x7d92ad), c(0x5a6f92), night));
    this.ambient.intensity = 0.22 + night * 0.26;
    this.moonLight.intensity = night * 0.72 * (1 - W.cloud * 0.55);
    this.moonLight.position.copy(dir).multiplyScalar(-620).add(this.focus);

    /* ---- 天空 / 雾 / 曝光 ---- */
    const su = this.sky.material.uniforms;
    su.sunPosition.value.copy(dir);
    su.turbidity.value = 3.2 + W.cloud * 6.0;
    su.rayleigh.value = 2.1 + dusk * 2.0 + W.cloud * 0.5;
    su.mieCoefficient.value = 0.005 + W.cloud * 0.010;
    su.cloudCoverage.value = 0.02 + W.cloud * 0.72;
    su.cloudDensity.value = 0.22 + W.cloud * 0.55;
    su.time.value += dt * 60.0;
    su.showSunDisc.value = 1 - W.cloud * 0.9;
    this.scene.fog.color.copy(fogBase);
    this.scene.fog.density = fogDensity;
    this.renderer.toneMappingExposure = exposure;

    /* ---- 星空 / 月亮 ---- */
    this.stars.material.opacity = Math.pow(night, 1.6) * (1 - W.cloud * 0.85) * 0.92;
    this.stars.position.copy(this.focus);
    this.moon.material.opacity = Math.pow(night, 1.3) * (1 - W.cloud * 0.9) * 0.85;
    this.moon.position.copy(dir).multiplyScalar(-1).multiplyScalar(1900).add(this.focus);
    this.moon.lookAt(this.focus);

    /* ---- 导出给其它系统 ---- */
    const E = this.env;
    E.sunDir.copy(dir);
    E.sunColor.copy(sunColor);
    E.skyColor.copy(skyColor);
    E.fogColor.copy(fogBase);
    E.cloudColor.copy(lerpC(c(0xffffff), c(0x5b6675), W.cloud * 0.65 + night * 0.3));
    E.waterColor.copy(lerpC(c(0x1b4250), c(0x0a1726), night * 0.7)).lerp(c(0x3d4e55), W.cloud * 0.3);
    E.fogDensity = fogDensity;
    E.exposure = exposure;
    E.sunIntensity = sunIntensity;

    /* ---- IBL 环境贴图：渐变天空 + 太阳光斑，节流更新 PMREM ---- */
    this.envTimer += dt;
    if (immediate || this.envTimer > 2.4) {
      this.envTimer = 0;
      this.paintEnvMap(skyColor, sunColor, dir, day, W.cloud);
      this.envTex.needsUpdate = true;
      const target = this.pmrem.fromEquirectangular(this.envTex);
      if (this.envRT) this.envRT.dispose();
      this.envRT = target;
      this.scene.environment = target.texture;
    }
    this.scene.environmentIntensity = 0.55 + day * 0.45;
  }
}
