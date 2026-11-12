/**
 * 程序化 PBR 贴图工厂
 * ---------------------------------------------------------------------------
 * 全部贴图在浏览器端用 Canvas 生成，项目开箱即用、不依赖外部图片资源。
 * 若要替换为照片级扫描素材：把 public/assets/textures/ 下的真实贴图放进
 * ASSET_MANIFEST（见 main.js），Terrain / Water 会优先加载它们。
 * 生成的贴图均为可平铺（seamless），并带 mipmap / 各向异性过滤。
 */
import * as THREE from 'three';
import { CONFIG, FACTIONS } from '../config.js';
import { CITIES, RIVERS, PROVINCES } from '../data/map.js';
import { fbm, valueNoise, clamp, smoothstep } from './noise.js';
import {
  RES, MAP_W, MAP_H, heightField, seaMask, riverMask,
  heightAt, slopeAt, texelToWorld, worldToLonLat,
  lonLatToWorld, factionAt, coastLonAt,
} from '../world/geo.js';

const BASE_RES = 640; // 地貌基底计算分辨率（之后无损放大 + 高频细节叠加）

function canvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return { c, ctx: c.getContext('2d', { willReadFrequently: true }) };
}
function toTexture(c, { srgb = false, repeat = null, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  t.anisotropy = aniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  return t;
}

/* -------------------------------------------------------------------------- */
/* 地貌配色：按高度 / 坡度 / 气候带 / 河谷 / 海岸混合自然色                    */
/* -------------------------------------------------------------------------- */
function biomeColor(h, slope, lon, lat, grain) {
  const sea = CONFIG.map.seaLevel;
  if (h < sea) {
    // 浅海 -> 深海
    const d = clamp((sea - h) / 10, 0, 1);
    return [26 + 18 * (1 - d), 48 + 26 * (1 - d), 62 + 34 * (1 - d)];
  }
  const dry = smoothstep(33, 39, lat) * (1 - smoothstep(112, 120, lon) * 0.35); // 西北干旱
  const warm = smoothstep(22, 32, lat);
  const snow = smoothstep(30, 42, h) * 0.8;
  const rock = smoothstep(0.16, 0.48, slope) * 0.85 + smoothstep(20, 36, h) * 0.55;
  const riverWet = clamp(riverAtLL(lon, lat), 0, 1);

  // 草地 / 沃土 / 黄土 / 岩石 / 沙滩
  let r = 96, g = 112, b = 62;
  r += dry * 72; g += dry * 44; b += dry * 4;
  r += warm * -14; g += warm * 6; b += warm * -14;
  r += rock * (106 - r) * 0.72; g += rock * (100 - g) * 0.72; b += rock * (88 - b) * 0.72;
  r += riverWet * -16; g += riverWet * -8; b += riverWet * 10;

  // 微观斑驳，避免大片纯色
  const m = (grain - 0.5) * 74;
  r += m; g += m * 0.92; b += m * 0.7;
  // 裸土 / 耕地斑块：细碎、偏褐，只做色相微调；
  // 幅度过大或偏黄会在 ACES + 分离调色下变成荧光色块，反而失真。
  const soil = smoothstep(0.60, 0.72, fbm(lon * 22, lat * 22, 3, 87))
             * (1 - rock * 0.75) * 0.72;
  r += soil * 30; g += soil * 2; b -= soil * 26;

  // 滩涂/沙洲只出现在海岸线附近；内陆河谷下切虽然也低，但应保持湿土与草色，
  // 否则整条河会被渲染成一条突兀的亮白沙带（写实感与可读性都会受损）。
  const coastal = 1 - smoothstep(0.15, 1.8, Math.abs(lon - coastLonAt(lat)));
  if (h < 1.6) {
    const t = clamp((1.6 - h) / 2.2, 0, 1) * coastal;
    r += (168 - r) * t; g += (154 - g) * t; b += (116 - b) * t;
  }
  // 高海拔积雪（季节 shader 会再叠加动态雪线）
  r += (214 - r) * snow * 0.55; g += (218 - g) * snow * 0.55; b += (220 - b) * snow * 0.55;
  return [r, g, b];
}
function riverAtLL(lon, lat) {
  // 近似：用高度场中记录的下切强度
  const fx = clamp(((lon - 111.5) * CONFIG.map.unitsPerDegree / MAP_W + 0.5) * (RES - 1), 0, RES - 1);
  const fy = clamp(((31.5 - lat) * CONFIG.map.unitsPerDegree / MAP_H + 0.5) * (RES - 1), 0, RES - 1);
  return riverMask[(fy | 0) * RES + (fx | 0)] / 9;
}

/**
 * 高度场烘焙环境光遮蔽（horizon-based AO）
 * ---------------------------------------------------------------------------
 * 借鉴 fable52-fps-repro 的「把 AO 烘进贴图而不是每帧算 SSAO」思路：
 * 对每个 texel 沿 8 个方向做多尺度地平线搜索，山脊/谷壁越高则遮蔽越强；
 * 再叠加局部凹陷（曲率）项。结果写进 ORM 贴图的 R 通道，运行时零 GPU 开销。
 * 返回 0..1 的 Float32Array（1 = 完全开放，越小越暗）。
 */
function bakeTerrainAO(H, N, strength) {
  const ao = new Float32Array(N * N);
  const dirs = [];
  for (let d = 0; d < 8; d++) {
    const a = d * Math.PI / 4;
    dirs.push([Math.cos(a), Math.sin(a)]);
  }
  const steps = [3, 7, 14, 26];
  const worldStep = MAP_W / N; // 每个 texel 的世界尺寸
  const at = (x, y) => H[clamp(y | 0, 0, N - 1) * N + clamp(x | 0, 0, N - 1)];

  for (let py = 0; py < N; py++) {
    for (let px = 0; px < N; px++) {
      const i = py * N + px;
      const h0 = H[i];
      let occ = 0;
      for (const [dx, dy] of dirs) {
        let blocked = 0;
        for (const k of steps) {
          const rise = (at(px + dx * k, py + dy * k) - h0) / (k * worldStep);
          // rise>0 表示那个方向有更高的地形挡住天光
          blocked = Math.max(blocked, Math.min(1, rise * 1.5));
        }
        occ += blocked;
      }
      const horizon = occ / dirs.length;
      // 局部凹陷：邻域平均高度高于本点 => 处在沟壑里
      const avg = (at(px - 5, py) + at(px + 5, py) + at(px, py - 5) + at(px, py + 5)) * 0.25;
      const cavity = Math.max(0, (avg - h0) / (5 * worldStep)) * 1.2;
      ao[i] = clamp(1 - (horizon * 0.72 + Math.min(1, cavity) * 0.28) * strength, 0.52, 1);
    }
  }
  return ao;
}

/** 生成地貌基底（颜色 + ORM 打包贴图） */
function buildBiomeBase() {
  const { c: colC, ctx: colCtx } = canvas(BASE_RES);
  const { c: ormC, ctx: ormCtx } = canvas(BASE_RES);
  const col = colCtx.createImageData(BASE_RES, BASE_RES);
  const orm = ormCtx.createImageData(BASE_RES, BASE_RES);
  const H = new Float32Array(BASE_RES * BASE_RES);
  const roughF = new Float32Array(BASE_RES * BASE_RES);

  // 第一遍：颜色 / 粗糙度 / 高度缓存
  for (let py = 0; py < BASE_RES; py++) {
    for (let px = 0; px < BASE_RES; px++) {
      const { x, z } = texelToWorld(px, py, BASE_RES);
      const { lon, lat } = worldToLonLat(x, z);
      const h = heightAt(x, z);
      const s = slopeAt(x, z);
      const grain = fbm(lon * 7.5, lat * 7.5, 4, 77) * 0.42
              + fbm(lon * 26, lat * 26, 4, 79) * 0.36
              + fbm(lon * 88, lat * 88, 3, 81) * 0.22;
      const [r, g, b] = biomeColor(h, s, lon, lat, grain);
      const idx = py * BASE_RES + px;
      const i = idx * 4;
      H[idx] = h;
      col.data[i] = clamp(r, 0, 255);
      col.data[i + 1] = clamp(g, 0, 255);
      col.data[i + 2] = clamp(b, 0, 255);
      col.data[i + 3] = 255;

      /* 逐像素粗糙度是写实感的第一来源：不同地貌的高光尺度完全不同。
         水面/滩涂光滑，湿地与河谷中等，草地与干黄土粗糙，裸岩最粗糙；
         再叠高频颗粒，让放大后仍有微表面变化（参考 04-fps 的 pbr()）。 */
      let rough;
      if (h < CONFIG.map.seaLevel) rough = 0.10;
      else if (h < 1.8) rough = 0.34;
      else {
        const wetland = clamp(riverAtLL(lon, lat), 0, 1);
        rough = 0.82 + s * 0.10 - wetland * 0.28 - grain * 0.10;
        rough = clamp(rough + (grain - 0.5) * 0.24, 0.34, 0.98);
      }
      roughF[idx] = rough;
    }
  }

  // 第二遍：烘焙 AO -> ORM 的 R 通道
  const ao = bakeTerrainAO(H, BASE_RES, CONFIG.material.aoStrength);
  for (let idx = 0; idx < BASE_RES * BASE_RES; idx++) {
    const i = idx * 4;
    orm.data[i] = Math.round(ao[idx] * 255);          // R = ambient occlusion
    orm.data[i + 1] = Math.round(roughF[idx] * 255);  // G = roughness
    orm.data[i + 2] = 0;                              // B = metalness（自然地表为 0）
    orm.data[i + 3] = 255;
  }
  colCtx.putImageData(col, 0, 0);
  ormCtx.putImageData(orm, 0, 0);
  return { colC, ormC };
}

/** 高频细节图层：可平铺的细颗粒土/草纹理，打散大块平滑色带 */
function detailOverlay(size) {
  const T = 256;
  const { c: tile, ctx: tctx } = canvas(T);
  const img = tctx.createImageData(T, T);
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const n = valueNoise(x / 1.7, y / 1.7, 991) * 0.5
              + valueNoise(x / 5.3, y / 5.3, 993) * 0.3
              + valueNoise(x / 17, y / 17, 997) * 0.2;
      const v = 116 + (n - 0.5) * 150;
      const i = (y * T + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 105;
    }
  }
  tctx.putImageData(img, 0, 0);
  const { c, ctx } = canvas(size);
  ctx.fillStyle = ctx.createPattern(tile, 'repeat');
  ctx.fillRect(0, 0, size, size);
  return c;
}

/** 势力覆盖层 + 疆界线（低分辨率计算，放大时形成柔和晕染） */
function buildFactionLayers() {
  const N = CONFIG.terrain.overlaySize;
  const { c: fillC, ctx: fillCtx } = canvas(N);
  const { c: edgeC, ctx: edgeCtx } = canvas(N);
  const fill = fillCtx.createImageData(N, N);
  const edge = edgeCtx.createImageData(N, N);
  const owners = new Uint8Array(N * N);
  const order = ['群', '魏', '蜀', '吴'];

  for (let py = 0; py < N; py++) {
    for (let px = 0; px < N; px++) {
      const { x, z } = texelToWorld(px, py, N);
      const { lon, lat } = worldToLonLat(x, z);
      const info = factionAt(lon, lat);
      const idx = py * N + px;
      const fi = order.indexOf(info.faction);
      owners[idx] = fi < 0 ? 0 : fi;
      const hex = FACTIONS[info.faction].color;
      const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
      const i = idx * 4;
      // 越靠近边界着色越淡，避免疆界像硬色块
      const a = 46 + 24 * (1 - info.contrast);
      fill.data[i] = r; fill.data[i + 1] = g; fill.data[i + 2] = b; fill.data[i + 3] = a;
    }
  }
  for (let py = 0; py < N; py++) {
    for (let px = 0; px < N; px++) {
      const idx = py * N + px;
      const o = owners[idx];
      const diff = (px + 1 < N && owners[idx + 1] !== o) ||
                   (py + 1 < N && owners[idx + N] !== o) ||
                   (px > 0 && owners[idx - 1] !== o) ||
                   (py > 0 && owners[idx - N] !== o);
      const i = idx * 4;
      edge.data[i] = 255; edge.data[i + 1] = 235; edge.data[i + 2] = 178;
      edge.data[i + 3] = diff ? 210 : 0;
    }
  }
  fillCtx.putImageData(fill, 0, 0);
  edgeCtx.putImageData(edge, 0, 0);
  return { fillC, edgeC };
}

/** 州界折线 + 州名 + 主要官道，全部绘制在全分辨率贴图上保证锐利 */
function drawCartography(ctx, size) {
  const S = size;
  const uv = (lon, lat) => {
    const p = lonLatToWorld(lon, lat);
    return [((p.x / MAP_W) + 0.5) * S, ((p.z / MAP_H) + 0.5) * S];
  };

  // 官道：相邻城池之间的细淡连线（先画，压在州界之下）
  ctx.save();
  ctx.lineWidth = Math.max(1.2, S / 1500);
  ctx.strokeStyle = 'rgba(232, 214, 172, 0.20)';
  ctx.setLineDash([]);
  for (let i = 0; i < CITIES.length; i++) {
    for (let j = i + 1; j < CITIES.length; j++) {
      const a = CITIES[i], b = CITIES[j];
      const d = Math.hypot(a.lon - b.lon, a.lat - b.lat);
      if (d > 3.3 || d < 0.9 || a.faction !== b.faction) continue;
      const [x1, y1] = uv(a.lon, a.lat), [x2, y2] = uv(b.lon, b.lat);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
  }
  ctx.restore();

  // 州界：墨色细实线 + 外侧淡金光晕
  ctx.save();
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  for (const p of PROVINCES) {
    ctx.beginPath();
    p.poly.forEach(([lo, la], k) => {
      const [x, y] = uv(lo, la);
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.strokeStyle = 'rgba(18, 24, 22, 0.50)';
    ctx.lineWidth = Math.max(2, S / 620);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(222, 196, 132, 0.42)';
    ctx.lineWidth = Math.max(0.8, S / 1800);
    ctx.setLineDash([S / 110, S / 150]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();

  // 州名：绢帛底 + 墨字，仿古地图题注
  ctx.save();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const fs = Math.round(S / 46);
  ctx.font = `bold ${fs}px "Songti SC", "STSong", "SimSun", serif`;
  for (const p of PROVINCES) {
    const [x, y] = uv(p.center[0], p.center[1]);
    ctx.shadowColor = 'rgba(0,0,0,0.65)'; ctx.shadowBlur = fs * 0.55;
    ctx.fillStyle = 'rgba(246, 232, 196, 0.88)';
    ctx.fillText(p.name, x, y);
    ctx.font = `${Math.round(fs * 0.45)}px "Songti SC", "STSong", serif`;
    ctx.fillStyle = 'rgba(236, 218, 176, 0.58)';
    ctx.fillText(p.seat, x, y + fs * 0.78);
    ctx.font = `bold ${fs}px "Songti SC", "STSong", "SimSun", serif`;
  }
  ctx.restore();
}

/** 主入口：生成地形三张 PBR 贴图 + HUD 小地图用的版图缩略图
 *  ormMap 为 ORM 打包贴图（R=AO / G=roughness / B=metalness），
 *  同一张贴图同时绑定 aoMap、roughnessMap、metalnessMap —— 参考项目 stdMat() 的做法。 */
export function buildTerrainTextures() {
  const S = CONFIG.terrain.textureSize;
  const { colC, ormC } = buildBiomeBase();
  const { c: main, ctx } = canvas(S);

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(colC, 0, 0, S, S);

  // 高频颗粒：以 256px 无缝纹理平铺到 2048，保证近景有土粒 / 草茎级细节
  ctx.save();
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = 0.48;
  ctx.drawImage(detailOverlay(S), 0, 0);
  ctx.restore();

  // 势力淡彩
  const { fillC, edgeC } = buildFactionLayers();
  ctx.save();
  ctx.globalAlpha = 0.92;
  ctx.drawImage(fillC, 0, 0, S, S);
  ctx.restore();

  // 疆界：金线 + 光晕
  const { c: gold, ctx: gctx } = canvas(S);
  gctx.drawImage(edgeC, 0, 0, S, S);
  gctx.globalCompositeOperation = 'source-in';
  gctx.fillStyle = '#f0d191';
  gctx.fillRect(0, 0, S, S);
  ctx.save();
  ctx.shadowColor = 'rgba(255, 214, 130, 0.85)';
  ctx.shadowBlur = S / 180;
  ctx.globalAlpha = 0.88;
  ctx.drawImage(gold, 0, 0);
  ctx.restore();

  drawCartography(ctx, S);

  // ORM 放大；法线改用高频可平铺微表面，避免高度场法线造成的大面积光照色带
  const { c: ormBig, ctx: octx } = canvas(S);
  // 数据贴图必须保持线性（不设 sRGB），否则 AO/粗糙度会被 gamma 破坏
  octx.drawImage(ormC, 0, 0, S, S);
  const ormMap = toTexture(ormBig, { aniso: 8 });

  return {
    map: toTexture(main, { srgb: true, aniso: 16 }),
    normalMap: makeDetailNormal(),
    ormMap,
    roughnessMap: ormMap, // 兼容旧字段名（G 通道即粗糙度）
    thumbnail: main,      // 供小地图复用
  };
}

/** 高频微表面法线：256px 无缝 tile，平铺 9×9，给近景土粒 / 草茎提供细法线 */
function makeDetailNormal() {
  const T = 256;
  const { c, ctx } = canvas(T);
  const img = ctx.createImageData(T, T);
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const n = valueNoise(x / 2.1, y / 2.1, 991) * 0.48
              + valueNoise(x / 6.7, y / 6.7, 993) * 0.32
              + valueNoise(x / 19, y / 19, 997) * 0.20;
      const v = 128 + (n - 0.5) * 150;
      const i = (y * T + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = makeBumpNormal(img.data, T, CONFIG.terrain.normalStrength);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(9, 9);
  return t;
}

/* -------------------------------------------------------------------------- */
/* 各类可平铺细节贴图                                                          */
/* -------------------------------------------------------------------------- */

/** 周期性正弦和 -> 无缝水面法线（waterNormals，供 Water / 河流 shader 使用） */
export function makeWaterNormals(size = 256) {
  const { c, ctx } = canvas(size);
  const img = ctx.createImageData(size, size);
  const waves = [
    [7, 3, 1.0, 0.3], [13, 9, 0.6, 1.1], [23, 17, 0.35, 2.2],
    [3, 21, 0.5, 0.8], [31, 29, 0.18, 3.0],
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size * Math.PI * 2, v = y / size * Math.PI * 2;
      let dx = 0, dy = 0;
      for (const [fx, fy, a, p] of waves) {
        dx += a * fx * Math.cos(fx * u + fy * v + p);
        dy += a * fy * Math.cos(fx * u + fy * v + p);
      }
      const k = 0.012;
      const nx = -dx * k, ny = -dy * k, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      const i = (y * size + x) * 4;
      img.data[i] = (nx / l * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny / l * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz / l * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(c, { repeat: [1, 1] });
}

/** 织物法线（盔甲布面 / 旗帜 / 披风） */
export function makeFabricNormal(size = 128) {
  const { c, ctx } = canvas(size);
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const weave = Math.sin(x * Math.PI / 3) * Math.sin(y * Math.PI / 3);
      const n = valueNoise(x / 4, y / 4, 5) * 0.4;
      const i = (y * size + x) * 4;
      img.data[i] = (0.5 + weave * 0.10 + n * 0.10) * 255;
      img.data[i + 1] = (0.5 + weave * 0.09 - n * 0.10) * 255;
      img.data[i + 2] = 245;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(c, { repeat: [3, 3] });
}

/** 树皮：竖向裂纹 */
export function makeBark(size = 256) {
  const { c, ctx } = canvas(size);
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const streak = fbm(x / 9, y / 42, 4, 61);
      const crack = Math.pow(fbm(x / 22, y / 18, 3, 63), 3);
      const v = 62 + streak * 76 - crack * 52;
      const i = (y * size + x) * 4;
      img.data[i] = v * 1.02; img.data[i + 1] = v * 0.88; img.data[i + 2] = v * 0.68;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const n = makeBumpNormal(img.data, size, 2.2);
  return {
    map: toTexture(c, { srgb: true }), normalMap: n,
    orm: buildORM(img.data, size, { baseRough: 0.94, roughRange: 0.22, aoFromLum: 0.55 }),
  };
}

/** 岩石：斑驳灰岩 */
export function makeStone(size = 256) {
  const { c, ctx } = canvas(size);
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x / 24, y / 24, 5, 71);
      const grain = valueNoise(x / 3, y / 3, 73);
      const v = 74 + n * 92 + (grain - 0.5) * 28;
      const i = (y * size + x) * 4;
      img.data[i] = v * 1.02; img.data[i + 1] = v * 1.00; img.data[i + 2] = v * 0.95;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return {
    map: toTexture(c, { srgb: true }), normalMap: makeBumpNormal(img.data, size, 3.0),
    orm: buildORM(img.data, size, { baseRough: 0.93, roughRange: 0.20, aoFromLum: 0.48 }),
  };
}

/**
 * ORM 打包贴图（参考 fable52-fps-repro 的 pbr()/stdMat()）
 * ---------------------------------------------------------------------------
 * 由已有 albedo 的明暗反推材质参数，生成一张线性数据贴图：
 *   R = 烘焙 AO（缝隙/凹坑更暗）、G = 逐像素粗糙度、B = 金属度
 * 同一张贴图可同时绑定 aoMap / roughnessMap / metalnessMap（three r187 的
 * aomap_fragment 与 roughnessmap_fragment 注释明确支持 ORM 布局）。
 * 逐像素 roughness 差异是「塑料感」与「真实材质」的分水岭。
 */
export function buildORM(data, size, {
  baseRough = 0.86, roughRange = 0.24, metal = 0, aoFromLum = 0.5,
  repeat = [1, 1],
} = {}) {
  const { c, ctx } = canvas(size);
  const out = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const lum = (data[i] * 0.30 + data[i + 1] * 0.59 + data[i + 2] * 0.11) / 255;
      const ao = clamp(1 - (1 - lum) * aoFromLum, 0.35, 1);
      const rough = clamp(baseRough + (0.5 - lum) * roughRange, 0.06, 1);
      out.data[i] = ao * 255;
      out.data[i + 1] = rough * 255;
      out.data[i + 2] = metal * 255;
      out.data[i + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return toTexture(c, { repeat });
}

/** 由灰度生成法线贴图 */
function makeBumpNormal(data, size, strength) {
  const { c, ctx } = canvas(size);
  const img = ctx.createImageData(size, size);
  const lum = (x, y) => data[(((y + size) % size) * size + ((x + size) % size)) * 4] / 255;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (lum(x + 1, y) - lum(x - 1, y)) * strength;
      const dy = (lum(x, y + 1) - lum(x, y - 1)) * strength;
      const nx = -dx, ny = -dy, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      const i = (y * size + x) * 4;
      img.data[i] = (nx / l * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny / l * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz / l * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(c);
}

/** 木构：竖向年轮 / 节疤 / 干裂，配套法线与 ORM（参考 02-materials 的 genWood） */
export function makeTimber(size = 256) {
  const { c, ctx } = canvas(size);
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const warp = fbm(x / 24, y / 70, 3, 91) * 1.7;
      const rings = Math.sin((x / size * 13 + warp) * Math.PI * 2);
      const fiber = fbm(x / 2.4, y / 36, 3, 93) - 0.5;
      const crack = Math.pow(Math.max(0, fbm(x / 9, y / 46, 3, 95) - 0.62), 1.4) * 3.4;
      const v = 104 + rings * 15 + fiber * 44 - crack * 34;
      const i = (y * size + x) * 4;
      img.data[i] = clamp(v * 1.12, 0, 255);
      img.data[i + 1] = clamp(v * 0.84, 0, 255);
      img.data[i + 2] = clamp(v * 0.60, 0, 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const map = toTexture(c, { srgb: true });
  const normalMap = makeBumpNormal(img.data, size, 2.4);
  const orm = buildORM(img.data, size,
    { baseRough: 0.84, roughRange: 0.26, aoFromLum: 0.55 });
  for (const t of [map, normalMap, orm]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1.5, 1.5);
  }
  return { map, normalMap, orm };
}

/** 青瓦：中式筒瓦行列 */
export function makeRoofTile(size = 256) {
  const { c, ctx } = canvas(size);
  ctx.fillStyle = '#34383a'; ctx.fillRect(0, 0, size, size);
  const rows = 8, cols = 10;
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < cols; k++) {
      const x = k * size / cols, y = r * size / rows;
      const w = size / cols, h = size / rows;
      const g = ctx.createLinearGradient(x, y, x + w, y);
      g.addColorStop(0, '#20272b'); g.addColorStop(0.42, '#596267');
      g.addColorStop(0.72, '#3d464b'); g.addColorStop(1, '#1a2024');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.roundRect(x + w * 0.06, y + h * 0.08, w * 0.88, h * 0.80, w * 0.4);
      ctx.fill();
      ctx.strokeStyle = 'rgba(12,16,18,0.7)'; ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  // 尘埃与苔痕
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = `rgba(${20 + Math.random() * 40},${30 + Math.random() * 40},${28 + Math.random() * 30},${Math.random() * 0.28})`;
    ctx.fillRect(Math.random() * size, Math.random() * size, 1 + Math.random() * 3, 1 + Math.random() * 2);
  }
  const orm = buildORM(ctx.getImageData(0, 0, size, size).data, size,
    { baseRough: 0.62, roughRange: 0.34, metal: 0.06, aoFromLum: 0.62, repeat: [2, 2] });
  return {
    map: toTexture(c, { srgb: true, repeat: [2, 2] }),
    orm, // 瓦沟深处更暗更粗糙，瓦面凸起处略光滑并带微弱金属感（釉面）
  };
}

/** 夯土 / 城砖 */
export function makeBrick(size = 256) {
  const { c, ctx } = canvas(size);
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const row = Math.floor(y / 26);
      const off = row % 2 ? 24 : 0;
      const bx = (x + off) % 48, by = y % 26;
      const joint = bx < 2 || by < 2;
      const n = fbm(x / 18, y / 18, 4, 83);
      const v = joint ? 78 : 112 + n * 58;
      const i = (y * size + x) * 4;
      img.data[i] = v * 1.10; img.data[i + 1] = v * 0.98; img.data[i + 2] = v * 0.82;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return {
    map: toTexture(c, { srgb: true, repeat: [3, 3] }),
    normalMap: makeBumpNormal(img.data, size, 2.5),
    orm: buildORM(img.data, size,
      { baseRough: 0.89, roughRange: 0.30, aoFromLum: 0.66, repeat: [3, 3] }),
  };
}

/** 叶片簇 alpha 贴图（写实树冠用交叉面片，远看不是多边形球） */
export function makeLeafCluster(size = 256) {
  const { c, ctx } = canvas(size);
  ctx.clearRect(0, 0, size, size);
  const cx = size / 2, cy = size / 2;
  for (let i = 0; i < 150; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.pow(Math.random(), 0.62) * size * 0.44;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r * 0.86;
    const L = 9 + Math.random() * 17, W = 4 + Math.random() * 8;
    const hue = 74 + Math.random() * 32, sat = 24 + Math.random() * 28, lit = 16 + Math.random() * 30;
    ctx.save();
    ctx.translate(x, y); ctx.rotate(a + (Math.random() - 0.5) * 1.2);
    const g = ctx.createLinearGradient(0, -L / 2, 0, L / 2);
    g.addColorStop(0, `hsla(${hue},${sat + 12}%,${lit + 18}%,0.95)`);
    g.addColorStop(1, `hsla(${hue - 8},${sat}%,${lit}%,0.88)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, -L / 2);
    ctx.quadraticCurveTo(W, 0, 0, L / 2);
    ctx.quadraticCurveTo(-W, 0, 0, -L / 2);
    ctx.fill();
    ctx.restore();
  }
  return toTexture(c, { srgb: true });
}

/** 草叶 alpha 贴图 */
export function makeGrassBlade(size = 128) {
  const { c, ctx } = canvas(size);
  ctx.clearRect(0, 0, size, size);
  for (let i = 0; i < 26; i++) {
    const x = 4 + Math.random() * (size - 8);
    const h = size * (0.42 + Math.random() * 0.55);
    const w = 2 + Math.random() * 3.4;
    const g = ctx.createLinearGradient(0, size - h, 0, size);
    g.addColorStop(0, `hsla(${68 + Math.random() * 34},48%,${38 + Math.random() * 22}%,0.95)`);
    g.addColorStop(1, `hsla(${72 + Math.random() * 26},40%,${20 + Math.random() * 12}%,0.95)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x, size);
    ctx.quadraticCurveTo(x + w, size - h * 0.55, x + (Math.random() - 0.5) * 18, size - h);
    ctx.quadraticCurveTo(x - w, size - h * 0.55, x, size);
    ctx.fill();
  }
  return toTexture(c, { srgb: true });
}

/** 云层：柔和噪声 alpha，贴在天空下的大平面上 */
export function makeCloudTexture(size = 512) {
  const { c, ctx } = canvas(size);
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x / 62, y / 62, 5, 101) * 0.7 + fbm(x / 18, y / 18, 3, 103) * 0.3;
      const a = Math.pow(smoothstep(0.40, 0.78, n), 1.4) * 210;
      const i = (y * size + x) * 4;
      img.data[i] = 236; img.data[i + 1] = 238; img.data[i + 2] = 240; img.data[i + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(c, { srgb: true });
}

/** 圆形柔光贴图：雨雪粒子 / 地标光晕 */
export function makeSoftDot(size = 64) {
  const { c, ctx } = canvas(size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.65)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  return toTexture(c, { srgb: true });
}
