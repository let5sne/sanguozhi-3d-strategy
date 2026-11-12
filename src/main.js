/**
 * 《三国志 · 汉末十三州》三维策略舆图原型 —— 应用入口
 * ---------------------------------------------------------------------------
 * 启动顺序（分帧执行，保证载入界面能真实刷新）：
 *   高度场 -> 渲染器/大气/后处理 -> 地形版图 -> 江河湖海 -> 城池 -> 人物 -> 植被 -> HUD
 *
 * 资源替换：把真实贴图 / GLB 模型放入 public/assets/，在 src/data/assets.js
 * 的 ASSET_MANIFEST 中登记路径，各模块会自动异步加载并替换程序化占位资源。
 */
import * as THREE from 'three';
import { CONFIG, FACTIONS, SEASONS, WEATHER } from './config.js';
import { buildHeightField, heightAt } from './world/geo.js';
import { Terrain } from './world/Terrain.js';
import { WaterSystem } from './world/Water.js';
import { Cities } from './world/Cities.js';
import { Characters } from './world/Characters.js';
import { Vegetation } from './world/Vegetation.js';
import { WeatherSystem } from './world/Weather.js';
import { Lighting } from './core/Lighting.js';
import { CameraRig } from './core/CameraRig.js';
import { PostFX } from './core/PostFX.js';
import { Quality } from './core/Quality.js';
import { Picker } from './core/Picker.js';
import { HUD } from './ui/HUD.js';
import { Minimap } from './ui/Minimap.js';
import { ASSET_MANIFEST } from './data/assets.js';

export { ASSET_MANIFEST };

const setLoading = (pct, text) => {
  const bar = document.getElementById('loading-progress');
  const st = document.getElementById('loading-status');
  if (bar) bar.style.width = `${pct}%`;
  if (st && text) st.textContent = text;
};
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

const state = {
  season: CONFIG.season,
  weather: CONFIG.weather,
  hour: CONFIG.lighting.startHour,
  autoDay: CONFIG.lighting.dayLength > 0,
  showLabels: true,
  tier: 'high',
};

async function boot() {
  /* ---------------- 1. 地形高度场 ---------------- */
  setLoading(6, '推演九州山川…');
  await nextFrame();
  buildHeightField();
  setLoading(18, '山川形胜已具，正设舆图…');
  await nextFrame();

  /* ---------------- 2. 渲染器 / 大气 / 镜头 ---------------- */
  const container = document.getElementById('viewport');
  const renderer = new THREE.WebGLRenderer({
    antialias: false,          // 后处理链负责抗锯齿/色调映射，避免重复开销
    powerPreference: 'high-performance',
    stencil: false, alpha: false,
    logarithmicDepthBuffer: false,
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x0e1620);
  renderer.shadowMap.enabled = true;
  // three r187 起 PCFSoftShadowMap 已并入 PCFShadowMap（由 shadow.radius 控制软化）
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // 阴影贴图由主循环按档位分频驱动：high 每帧、medium/low 隔帧，
  // 静态地形 + 缓慢移动的太阳不需要每帧重烘焙（见 04-fps 的性能策略）。
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = CONFIG.lighting.exposure;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  const quality = new Quality(renderer);

  /* 调试 / 低配设备 URL 参数：?tier=low&lite=1&hour=18&season=冬&weather=雨
     tier 支持 high/medium/low；lite=1 把实例数量压到 15%，便于弱机与自动化冒烟测试 */
  const Q = new URLSearchParams(location.search);
  if (Q.has('tier') && CONFIG.post[Q.get('tier')]) {
    quality.setTier(Q.get('tier'));
  }
  if (Q.get('lite') === '1') {
    for (const k of Object.keys(CONFIG.population)) {
      if (Array.isArray(CONFIG.population[k])) {
        CONFIG.population[k] = CONFIG.population[k].map((v) => Math.max(40, Math.round(v * 0.15)));
      } else CONFIG.population[k] *= 0.15;
    }
  }
  state.tier = quality.tier;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    CONFIG.camera.fov, window.innerWidth / window.innerHeight,
    CONFIG.camera.near, CONFIG.camera.far
  );
  const rig = new CameraRig(camera, renderer.domElement, quality);
  const lighting = new Lighting(scene, renderer, quality);
  const postfx = new PostFX(renderer, scene, camera, quality);
  setLoading(28, '设晷影、定晨昏…');
  await nextFrame();

  /* ---------------- 3. 地形 + 州郡版图 ---------------- */
  const terrain = new Terrain(scene, quality);
  setLoading(50, '绘十三州郡、正疆界…');
  await nextFrame();

  /* ---------------- 4. 水体 ---------------- */
  const water = new WaterSystem(scene, quality, lighting);
  setLoading(60, '疏江河、注湖海…');
  await nextFrame();

  /* ---------------- 5. 点选 / 城池 ---------------- */
  const picker = new Picker(camera, renderer.domElement, scene, terrain);
  const cities = new Cities(scene, picker, quality);
  setLoading(72, '筑城垣、树旌旗…');
  await nextFrame();

  /* ---------------- 6. 人物 / 战马 / 军团 ---------------- */
  const characters = new Characters(scene, picker, quality);
  setLoading(82, '点将校、列阵牧马…');
  await nextFrame();

  /* ---------------- 7. 植被 / 天气 ---------------- */
  const vegetation = new Vegetation(scene, quality);
  const weather = new WeatherSystem(scene, quality);
  setLoading(92, '生草木、聚云气…');
  await nextFrame();

  /* ---------------- 8. HUD ---------------- */
  const handlers = {
    season(s) {
      state.season = s; lighting.setSeason(s);
      hud.syncButtons();
      // 冬季自动转雪、春季转晴，仅作为氛围建议，仍可手动覆盖
      if (s === '冬') handlers.weather('雪');
      else if (state.weather === '雪') handlers.weather('晴');
    },
    weather(w) { state.weather = w; lighting.setWeather(w); weather.setWeather(w); hud.syncButtons(); },
    hour(h) { state.hour = h; lighting.setHour(h); },
    auto(v) { state.autoDay = v; lighting.setAutoDay(v); hud.setAutoToggle(v); },
    quality() {
      const order = ['high', 'medium', 'low'];
      const next = order[(order.indexOf(quality.tier) + 1) % order.length];
      quality.setTier(next); state.tier = next;
      postfx.applyQuality(); postfx.setSize(window.innerWidth, window.innerHeight);
      hud.setQualityLabel(next);
    },
    reset() { rig.reset(); },
    labels() { state.showLabels = !state.showLabels; hud.setLabelToggle(state.showLabels); },
    focus(x, z) { rig.flyTo(x, z, 235); },
    select(info) {
      info.point = new THREE.Vector3(info.x, info.y, info.z);
      picker.select(info);
      if (info.type === 'general') rig.flyTo(info.x, info.z, 105);
      else if (info.type === 'city') rig.flyTo(info.x, info.z, 145);
      else if (info.type === 'army' || info.type === 'animal') rig.flyTo(info.x, info.z, 175);
    },
    factionToggle(faction, visible) { hud.setFactionVisible(faction, visible); },
  };

  const hud = new HUD({
    state,
    handlers,
    refs: { camera, picker, cities, characters, lighting, quality, terrain },
  });
  hud.setQualityLabel(quality.tier);
  // URL 初始视图参数（便于分享特定时刻 / 自动化测试）
  if (Q.get('noauto') === '1') handlers.auto(false);
  if (Q.has('hour')) { const h = parseFloat(Q.get('hour')); if (!Number.isNaN(h)) handlers.hour(h); }
  if (Q.has('season')) handlers.season(Q.get('season'));
  if (Q.has('weather')) handlers.weather(Q.get('weather'));
  const minimap = new Minimap(document.getElementById('minimap'), terrain, camera, rig, handlers);
  picker.onSelect = (info) => { hud.setInfo(info); minimap.setSelected(info); };

  /* ---------------- 9. 尺寸 / 快捷键 ---------------- */
  const onResize = () => {
    const w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // 像素预算随视口尺寸变化，先重算画质再用新 DPR 设置尺寸
    quality.apply();
    renderer.setSize(w, h);
    postfx.setSize(w, h);
  };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(onResize, 220));
  window.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
    const k = e.key.toLowerCase();
    if (k === 'r') rig.reset();
    if (k === 'l') handlers.labels();
    if (k === ' ') { e.preventDefault(); handlers.auto(!state.autoDay); }
    if (k === '1') handlers.season('春');
    if (k === '2') handlers.season('夏');
    if (k === '3') handlers.season('秋');
    if (k === '4') handlers.season('冬');
  });

  /* ---------------- 10. 主循环 ---------------- */
  let t = 0, last = performance.now(), frame = 0;
  function animate() {
    requestAnimationFrame(animate);
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    t += dt;
    frame++;
    if (frame % (state.tier === 'high' ? 1 : 2) === 0) {
      renderer.shadowMap.needsUpdate = true;
    }

    rig.update(dt);
    lighting.update(dt);
    lighting.updateShadowFocus(rig.controls.target);
    const env = lighting.env;

    weather.update(dt, camera, env);
    terrain.updateSeason(state.season, state.weather, dt, env);
    water.update(dt, env);
    cities.update(dt, env);
    characters.update(dt, env);
    vegetation.update(dt, env, state.season);
    picker.update(dt, t);
    hud.update(dt, env);
    minimap.update();
    postfx.update(dt, rig.controls.target);

    const newTier = quality.tick(dt);
    if (newTier) {
      state.tier = newTier;
      postfx.applyQuality();
      postfx.setSize(window.innerWidth, window.innerHeight);
      hud.setQualityLabel(newTier);
    }
    postfx.render(dt);
  }

  setLoading(96, '预编译着色器…');
  await nextFrame();
  // 预热：首帧前编译所有 shader program 并上传贴图，避免切换昼夜/首次点选时卡顿
  try { renderer.compile(scene, camera); } catch (e) {
    console.warn('[三国志] 着色器预热跳过', e);
  }
  setLoading(100, '舆图既成，请主公观览');
  await nextFrame();
  hud.hideLoading();
  animate();

  // 便于在控制台调试 / 二次开发
  window.SANGUO = { scene, camera, renderer, lighting, terrain, water, cities, characters, vegetation, weather, picker, rig, quality, postfx, hud, state, CONFIG, ASSET_MANIFEST };
}

boot().catch((err) => {
  console.error('[三国志] 初始化失败', err);
  setLoading(100, `初始化失败：${err.message}`);
  const st = document.getElementById('loading-status');
  if (st) st.style.color = '#d66a5a';
});
