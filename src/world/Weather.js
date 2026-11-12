/**
 * 天气系统：云影层 + GPU 雨雪粒子（无 CPU 逐帧更新）
 * ---------------------------------------------------------------------------
 * 降水粒子全部在顶点着色器里循环，几千个点只占 1 个 draw call；
 * 粒子群跟随相机，永远覆盖视野，移动端自动降低数量。
 */
import * as THREE from 'three';
import { CONFIG, WEATHER } from '../config.js';
import { makeCloudTexture, makeSoftDot } from '../utils/textures.js';

function rainTexture() {
  const c = document.createElement('canvas');
  c.width = 16; c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0, 'rgba(220,235,255,0)');
  g.addColorStop(0.35, 'rgba(220,235,255,0.55)');
  g.addColorStop(0.75, 'rgba(235,245,255,0.9)');
  g.addColorStop(1, 'rgba(220,235,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.roundRect(5, 0, 6, 64, 3); ctx.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const VERT = /* glsl */`
  attribute float aSeed;
  uniform float uTime, uHeight, uSpeed, uSize, uWind, uOpacity;
  varying float vAlpha;
  void main() {
    vec3 p = position;
    float t = uTime * uSpeed;
    p.y = mod(p.y - t + aSeed * uHeight, uHeight);
    p.x += sin(uTime * 0.62 + aSeed * 21.0) * uWind + uTime * uWind * 0.22;
    p.z += cos(uTime * 0.47 + aSeed * 13.0) * uWind * 0.6;
    p.x = mod(p.x + 400.0, 800.0) - 400.0;
    p.z = mod(p.z + 400.0, 800.0) - 400.0;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = clamp(uSize * (260.0 / max(-mv.z, 1.0)), 1.0, 26.0);
    gl_Position = projectionMatrix * mv;
    vAlpha = uOpacity * (0.55 + aSeed * 0.45);
  }
`;
const FRAG = /* glsl */`
  precision mediump float;
  uniform sampler2D uMap;
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    vec4 t = texture2D(uMap, gl_PointCoord);
    gl_FragColor = vec4(uColor, t.a * vAlpha);
    if (gl_FragColor.a < 0.01) discard;
  }
`;

export class WeatherSystem {
  constructor(scene, quality) {
    this.scene = scene;
    this.quality = quality;
    this.weather = CONFIG.weather;
    this.time = 0;
    this.group = new THREE.Group();
    this.group.name = 'weather';
    scene.add(this.group);

    // 云影：两层缓慢漂移的半透明云幕，只做氛围不遮挡版图信息
    const cloudTex = makeCloudTexture(512);
    cloudTex.wrapS = cloudTex.wrapT = THREE.RepeatWrapping;
    this.cloudTex = cloudTex;
    this.clouds = [];
    for (let i = 0; i < 2; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: cloudTex, transparent: true, opacity: 0.0, depthWrite: false,
        color: 0xffffff, side: THREE.DoubleSide, fog: false,
      });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(2600, 2600), mat);
      m.rotation.x = -Math.PI / 2;
      m.position.y = 145 + i * 55;
      m.renderOrder = 6 + i;
      this.group.add(m);
      this.clouds.push(m);
    }

    this.rain = this.makePrecip(quality.isMobile ? 2600 : 7000, {
      map: rainTexture(), color: 0xc9dcf0, speed: 165, size: 13, wind: 5.5, opacity: 0,
    });
    this.snow = this.makePrecip(quality.isMobile ? 1400 : 3600, {
      map: makeSoftDot(), color: 0xf4f7ff, speed: 14, size: 8, wind: 14, opacity: 0,
    });
  }

  makePrecip(count, opt) {
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 800;
      pos[i * 3 + 1] = Math.random() * 240;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 800;
      seed[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 120, 0), 900);
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: {
        uTime: { value: 0 }, uMap: { value: opt.map },
        uColor: { value: new THREE.Color(opt.color) },
        uHeight: { value: 240 }, uSpeed: { value: opt.speed },
        uSize: { value: opt.size }, uWind: { value: opt.wind },
        uOpacity: { value: opt.opacity },
      },
      transparent: true, depthWrite: false, fog: false,
      blending: THREE.NormalBlending,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 10;
    this.group.add(pts);
    return mat;
  }

  setWeather(w) { if (WEATHER[w]) this.weather = w; }

  update(dt, camera, env) {
    this.time += dt;
    const W = WEATHER[this.weather];
    const k = Math.min(1, dt * 1.4);
    this.cloudTex.offset.x = (this.time * 0.0025) % 1;
    this.cloudTex.offset.y = (this.time * 0.0012) % 1;
    for (let i = 0; i < this.clouds.length; i++) {
      const m = this.clouds[i];
      const target = W.cloud * (i === 0 ? 0.20 : 0.13);
      m.material.opacity += (target - m.material.opacity) * k;
      m.material.color.lerp(env.cloudColor, k);
      // 云幕随粒子群整体跟随相机，此处只保留不同的高度层
      m.position.x = i * 40;
      m.position.z = i * -30;
    }
    for (const [mat, type] of [[this.rain, 'rain'], [this.snow, 'snow']]) {
      const target = W.precip === type ? (type === 'rain' ? 0.62 : 0.82) : 0;
      mat.uniforms.uOpacity.value += (target - mat.uniforms.uOpacity.value) * k;
      mat.uniforms.uTime.value = this.time;
      mat.uniforms.uWind.value += ((this.weather === '雪' ? 16 : 5.5) - mat.uniforms.uWind.value) * k * 0.3;
    }
    this.group.position.set(camera.position.x, Math.max(0, camera.position.y - 210), camera.position.z);
  }
}
