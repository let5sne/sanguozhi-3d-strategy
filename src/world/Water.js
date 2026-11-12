/**
 * 水体系统：海面平面反射 + 流动河道 / 湖泊
 * ---------------------------------------------------------------------------
 * 高画质档位使用 three.js Water（真实平面镜反射，会额外渲染一遍场景）；
 * 移动 / 低画质档位自动降级为同一套轻量水面 shader，保证帧率。
 * 河道几何沿 Catmull-Rom 平滑曲线生成，水面高度取自下切后的河床。
 */
import * as THREE from 'three';
import { Water as WaterAddon } from 'three/addons/objects/Water.js';
import { CONFIG } from '../config.js';
import { RIVERS, LAKES } from '../data/map.js';
import { MAP_W, MAP_H, lonLatToWorld, heightAt, isSea, worldToLonLat } from './geo.js';
import { makeWaterNormals } from '../utils/textures.js';
import { ASSET_MANIFEST, loadOptionalTexture } from '../data/assets.js';

const FLOW_VERT = /* glsl */`
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FLOW_FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D uNormals;
  uniform float uTime, uFlow, uAlpha, uShape, uFogDensity;
  uniform vec3 uSunDir, uSunColor, uSkyColor, uDeepColor, uFogColor;
  varying vec2 vUv;
  varying vec3 vWorld;

  void main() {
    // 两层不同速度 / 不同缩放的法线滚动 -> 流动的水纹
    vec2 a = vUv * vec2(uFlow * 1.0, uFlow * 2.2) + vec2(uTime * 0.017, -uTime * 0.030);
    vec2 b = vUv * vec2(uFlow * 2.3, uFlow * 1.4) + vec2(-uTime * 0.024, uTime * 0.012);
    vec3 n1 = texture2D(uNormals, a).xyz * 2.0 - 1.0;
    vec3 n2 = texture2D(uNormals, b).xyz * 2.0 - 1.0;
    vec3 N = normalize(vec3((n1.x + n2.x) * 0.62, 3.0, (n1.y + n2.y) * 0.62));

    vec3 V = normalize(cameraPosition - vWorld);
    vec3 L = normalize(uSunDir);
    float NoV = clamp(dot(N, V), 0.0, 1.0);
    // Schlick 菲涅尔：F0 = 0.02（水的物理值），掠射角才强反射
    float fres = 0.02 + 0.98 * pow(1.0 - NoV, 5.0);
    vec3 H = normalize(L + V);
    float NoH = max(dot(N, H), 0.0);
    // HDR 日照高光（>1）穿过泛光阈值形成水面碎金，同时钳制防止爆白
    float spec = min(pow(NoH, 260.0) * 5.2, 3.6);
    float glint = pow(NoH, 28.0) * 0.16;

    // 反射天空按天顶/地平线渐变，比单一混色更有空气感
    vec3 R = reflect(-V, N);
    vec3 skyRefl = mix(uSkyColor * 0.72, uSkyColor * 1.18, clamp(R.y * 0.8 + 0.2, 0.0, 1.0));
    vec3 col = mix(uDeepColor, skyRefl, clamp(fres * 1.25, 0.0, 0.92));
    col += uSunColor * (spec + glint);
    // 顺流而下的细碎白沫：用波峰的「法线倾斜度」而非 z 分量
    // （解码后 n.z 恒接近 1，若拿它当阈值会让整条河均匀泛白，夜间尤其明显）；
    // 再随实际日照衰减，夜河不该自发亮。
    float ripple = length(vec2(n1.x + n2.x, n1.y + n2.y));
    float daylight = clamp(uSunColor.g, 0.0, 1.0);
    float foam = smoothstep(0.42, 1.05, ripple) * 0.11 * (0.22 + 0.78 * daylight);
    col += vec3(foam);

    float alpha = uAlpha;
    float shore = 0.0;
    if (uShape < 0.5) {
      // 河流：横向羽化 + 岸边浅水提亮（水越浅越显底泥）
      float edge = abs(vUv.y - 0.5);
      alpha *= 1.0 - smoothstep(0.36, 0.50, edge);
      shore = smoothstep(0.26, 0.46, edge);
    } else if (uShape < 1.5) {
      float d = length(vUv - 0.5) * 2.0;
      alpha *= 1.0 - smoothstep(0.76, 1.0, d);
      shore = smoothstep(0.55, 0.95, d);
    }
    col = mix(col, uDeepColor * 1.55 + vec3(0.045, 0.040, 0.025), shore * 0.45);

    float dist = length(cameraPosition - vWorld);
    col = mix(col, uFogColor, clamp(dist * uFogDensity * 0.65, 0.0, 0.80));
    // 输出线性 HDR：色调映射与 sRGB 转换统一交给 EffectComposer / OutputPass
    gl_FragColor = vec4(col, alpha);
  }
`;

export class WaterSystem {
  constructor(scene, quality, lighting) {
    this.scene = scene;
    this.quality = quality;
    this.lighting = lighting;
    this.normals = makeWaterNormals(256);
    this.normals.wrapS = this.normals.wrapT = THREE.RepeatWrapping;
    this.materials = [];
    this.group = new THREE.Group();
    this.group.name = 'water';
    scene.add(this.group);

    this.shared = {
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(0xffe0b0) },
      uSkyColor: { value: new THREE.Color(0x8fb9d6) },
      uFogColor: { value: new THREE.Color(0xa9b6bd) },
      uDeepColor: { value: new THREE.Color(0x1d4550) },
      uFogDensity: { value: CONFIG.lighting.fogDensity },
    };
    // 若登记了真实水面法线，加载后统一替换所有河 / 湖 / 海材质里的采样贴图
    loadOptionalTexture(ASSET_MANIFEST.waterNormals, {}, (t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      this.normals = t;
      for (const m of this.materials) m.uniforms.uNormals.value = t;
      if (this.reflector) this.reflector.material.uniforms.normalSampler.value = t;
    });
    this.buildSea();
    this.buildRivers();
    this.buildLakes();
  }

  makeMaterial({ flow, alpha, shape, deep }) {
    const m = new THREE.ShaderMaterial({
      vertexShader: FLOW_VERT,
      fragmentShader: FLOW_FRAG,
      uniforms: {
        ...this.shared,
        uNormals: { value: this.normals },
        uFlow: { value: flow },
        uAlpha: { value: alpha },
        uShape: { value: shape },
        uDeepColor: { value: new THREE.Color(deep) },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    m.userData.baseDeep = new THREE.Color(deep);
    this.materials.push(m);
    return m;
  }

  /** 海面：高/中画质用真实平面反射，低画质 / 移动端用轻量 shader；运行中可热切换 */
  buildSea() {
    const geo = () => new THREE.PlaneGeometry(MAP_W * 1.02, MAP_H * 1.02, 1, 1);
    const mat = this.makeMaterial({ flow: 9, alpha: 0.95, shape: 2, deep: 0x173c48 });
    mat.depthWrite = true;
    this.seaFallback = new THREE.Mesh(geo(), mat);
    this.seaFallback.rotation.x = -Math.PI / 2;
    this.seaFallback.position.y = CONFIG.map.seaLevel;
    this.seaFallback.renderOrder = 1;
    this.group.add(this.seaFallback);
    this.reflector = null;
    this.sea = this.seaFallback;
    this.ensureReflection();
    this.applySeaQuality();
  }

  /** 惰性创建平面反射体（画质提升时不用重建整个水体系统） */
  ensureReflection() {
    if (this.reflector || this.quality.isMobile || this.quality.tier === 'low') return;
    try {
      const w = new WaterAddon(new THREE.PlaneGeometry(MAP_W * 1.02, MAP_H * 1.02, 1, 1), {
        textureWidth: 512,
        textureHeight: 512,
        waterNormals: this.normals,
        sunDirection: new THREE.Vector3(0, 1, 0),
        sunColor: 0xffe3b8,
        waterColor: 0x173c48,
        distortionScale: 2.6,
        alpha: 0.94,
        fog: true,
      });
      w.rotation.x = -Math.PI / 2;
      w.position.y = CONFIG.map.seaLevel;
      w.material.uniforms.size.value = 2.4;
      this.group.add(w);
      this.reflector = w;
    } catch (e) {
      console.warn('[Water] 平面反射不可用，保持轻量水面', e);
    }
  }

  applySeaQuality() {
    const useReflector = !!this.reflector && this.quality.tier !== 'low' && !this.quality.isMobile;
    if (this.reflector) this.reflector.visible = useReflector;
    this.seaFallback.visible = !useReflector;
    this.sea = useReflector ? this.reflector : this.seaFallback;
  }

  /** 沿经纬度折线生成贴地河道带 */
  buildRivers() {
    for (const r of RIVERS) {
      const pts = r.points.map(([lo, la]) => {
        const p = lonLatToWorld(lo, la);
        return new THREE.Vector3(p.x, 0, p.z);
      });
      if (pts.length < 3) continue;
      const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.4);
      const N = Math.max(48, r.points.length * 14);
      const samples = curve.getPoints(N);
      const verts = [], uvs = [], indices = [];
      const half = r.width * 0.68;
      let travelled = 0;
      for (let i = 0; i <= N; i++) {
        const p = samples[i];
        const prev = samples[Math.max(0, i - 1)], next = samples[Math.min(N, i + 1)];
        const t = new THREE.Vector3().subVectors(next, prev).normalize();
        const side = new THREE.Vector3(-t.z, 0, t.x).normalize();
        if (i > 0) travelled += p.distanceTo(samples[i - 1]);
        // 河面随河床缓缓下降；加微小抬升使其高于下切河床而不被地形吞没
        const y = heightAt(p.x, p.z) + 2.15;
        for (let s = 0; s < 2; s++) {
          const sign = s === 0 ? -1 : 1;
          verts.push(p.x + side.x * half * sign, y, p.z + side.z * half * sign);
          uvs.push(travelled / 14, s);
        }
        if (i < N) {
          const a = i * 2;
          indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geo.setIndex(indices);
      geo.computeVertexNormals();
      const mat = this.makeMaterial({
        flow: 2.0 + r.width * 0.35,
        alpha: 0.93,
        shape: 0,
        deep: r.color === 0xb9a06a ? 0x5a6048 : 0x204a58,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 2;
      mesh.userData = { kind: 'river', name: r.name };
      this.group.add(mesh);
    }
  }

  /** 湖泊：带扰动边缘的椭圆面片，水面固定在湖盆上方 */
  buildLakes() {
    for (const l of LAKES) {
      const c = lonLatToWorld(l.lon, l.lat);
      const cx = c.x, cz = c.z;
      const y = heightAt(cx, cz) + 2.45;
      const rings = 10, slices = 48;
      const verts = [], uvs = [], indices = [];
      const rx = l.rx * CONFIG.map.unitsPerDegree * 1.22;
      const rz = l.ry * CONFIG.map.unitsPerDegree * 1.22;
      for (let ri = 0; ri <= rings; ri++) {
        const t = ri / rings;
        for (let si = 0; si <= slices; si++) {
          const a = si / slices * Math.PI * 2;
          const wob = 1 + 0.14 * Math.sin(a * 5 + l.seed) + 0.07 * Math.sin(a * 9 - l.seed);
          verts.push(cx + Math.cos(a) * rx * wob * t, y, cz + Math.sin(a) * rz * wob * t);
          uvs.push(0.5 + Math.cos(a) * 0.5 * t, 0.5 + Math.sin(a) * 0.5 * t);
          if (ri < rings && si < slices) {
            const k = ri * (slices + 1) + si;
            indices.push(k, k + slices + 1, k + 1, k + 1, k + slices + 1, k + slices + 2);
          }
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geo.setIndex(indices);
      const mat = this.makeMaterial({ flow: 1.2, alpha: 0.92, shape: 1, deep: 0x25505a });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 2;
      mesh.userData = { kind: 'lake', name: l.name };
      this.group.add(mesh);
    }
  }

  /** 每帧：推进水纹、同步太阳/天空/雾色，供昼夜与天气联动 */
  update(dt, env) {
    this.shared.uTime.value += dt;
    this.ensureReflection();
    this.applySeaQuality();
    if (this.reflector && this.reflector.visible) {
      const u = this.reflector.material.uniforms;
      u.time.value += dt * 0.42;
      u.sunDirection.value.copy(env.sunDir).normalize();
      u.sunColor.value.copy(env.sunColor);
      u.waterColor.value.copy(env.waterColor);
      u.distortionScale.value = env.weather === '雨' ? 4.4 : env.weather === '雪' ? 1.6 : 2.6;
    }
    this.shared.uSunDir.value.copy(env.sunDir);
    // 高光强度跟随实际日照：夜间/雨雪天不出现不合时宜的白色碎金
    const sunGain = 0.20 + 0.80 * Math.min(1, Math.max(0, env.sunIntensity / 3.0));
    const overcast = env.weather === '雨' ? 0.38 : env.weather === '雪' ? 0.55
                   : env.weather === '阴' ? 0.62 : 1.0;
    this.shared.uSunColor.value.copy(env.sunColor).multiplyScalar(sunGain * overcast);
    this.shared.uSkyColor.value.copy(env.skyColor).multiplyScalar(0.82 + 0.18 * overcast);
    this.shared.uFogColor.value.copy(env.fogColor);
    this.shared.uFogDensity.value = env.fogDensity;
    for (const m of this.materials) {
      // 保留黄河浊水 / 湖水 / 海面的固有色差异，仅按天气做微弱偏移
      const target = m.userData.baseDeep.clone().lerp(env.waterColor, 0.28);
      m.uniforms.uDeepColor.value.lerp(target, Math.min(1, dt * 0.7));
    }
  }

  /** 某点是否为开阔海域（供植被/岩石散布排除） */
  static isSeaAt(x, z) {
    const { lon, lat } = worldToLonLat(x, z);
    return isSea(lon, lat);
  }
}
