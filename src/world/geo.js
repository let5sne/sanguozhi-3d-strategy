/**
 * 地理投影 + 程序化高度场 + 空间查询
 * ---------------------------------------------------------------------------
 * 所有 3D 对象（城池、树、人、河、湖、标签）都通过这里与世界对齐：
 *   lonLatToWorld() 经纬度 -> 世界坐标
 *   heightAt()       任意世界点的地面高度（双线性插值）
 *   texelToWorld()   贴图/高度场像素 -> 世界坐标
 * 这样贴图上的州界、河谷与三维起伏严格重合，不会出现"线飘在山上/埋进地里"。
 */
import { CONFIG } from '../config.js';
import { CITIES, RIVERS, LAKES, COAST, MOUNTAINS, PROVINCES } from '../data/map.js';
import { fbm, ridged, valueNoise, smoothstep, clamp } from '../utils/noise.js';

const M = CONFIG.map;
export const MAP_W = (M.lonMax - M.lonMin) * M.unitsPerDegree;
export const MAP_H = (M.latMax - M.latMin) * M.unitsPerDegree;
const LON0 = (M.lonMin + M.lonMax) * 0.5;
const LAT0 = (M.latMin + M.latMax) * 0.5;

export const lonLatToWorld = (lon, lat) => ({
  x: (lon - LON0) * M.unitsPerDegree,
  z: (LAT0 - lat) * M.unitsPerDegree,
});
export const worldToLonLat = (x, z) => ({
  lon: LON0 + x / M.unitsPerDegree,
  lat: LAT0 - z / M.unitsPerDegree,
});
/** 贴图/高度场像素坐标（左上为北西角）-> 世界坐标 */
export const texelToWorld = (px, py, size) => ({
  x: (px / (size - 1) - 0.5) * MAP_W,
  z: (py / (size - 1) - 0.5) * MAP_H,
});

/** 海岸经度：按纬度线性插值（COAST 从上到下按纬度递减排列） */
export function coastLonAt(lat) {
  for (let i = 0; i < COAST.length - 1; i++) {
    const [la, lo] = COAST[i], [lb, lob] = COAST[i + 1];
    if (lat <= la && lat >= lb) {
      const t = (la - lat) / (la - lb);
      return lo + (lob - lo) * t;
    }
  }
  return lat > COAST[0][0] ? COAST[0][1] : COAST[COAST.length - 1][1];
}
export const isSea = (lon, lat) => lon > coastLonAt(lat) - 0.08;

/* -------------------------------------------------------------------------- */
/* 折线距离工具（度空间；经度乘 0.86 近似换算为同尺度）                        */
/* -------------------------------------------------------------------------- */
const LON_SCALE = 0.86;
function segmentsFrom(points) {
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [a, b] = [points[i], points[i + 1]];
    out.push([a[0] * LON_SCALE, a[1], b[0] * LON_SCALE, b[1]]);
  }
  return out;
}
function distToSegments(lon, lat, segs) {
  const x = lon * LON_SCALE;
  let best = 1e9;
  for (let i = 0; i < segs.length; i++) {
    const [ax, ay, bx, by] = segs[i];
    const dx = bx - ax, dy = by - ay;
    const denom = dx * dx + dy * dy || 1;
    const t = clamp(((x - ax) * dx + (lat - ay) * dy) / denom, 0, 1);
    const ddx = x - (ax + t * dx), ddy = lat - (ay + t * dy);
    const d2 = ddx * ddx + ddy * ddy;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}
const RIVER_SEGS = RIVERS.map((r) => ({ ...r, segs: segmentsFrom(r.points) }));
const MOUNTAIN_SEGS = MOUNTAINS.map((m) => ({ ...m, segs: segmentsFrom(m.points) }));

/** 河谷下切量：河流经过之处地形被压成 U 形谷 */
function riverCarve(lon, lat) {
  let carve = 0, near = 1e9;
  for (const r of RIVER_SEGS) {
    const d = distToSegments(lon, lat, r.segs);
    if (d < 1.6) {
      const w = 0.24 + r.width * 0.055;
      carve = Math.max(carve, Math.exp(-((d / w) ** 2)) * (5.5 + r.width * 1.15));
      near = Math.min(near, d);
    }
  }
  return { carve, near };
}

/** 湖盆下切 */
function lakeDepth(lon, lat) {
  let depth = 0;
  for (const l of LAKES) {
    const dx = (lon - l.lon) / l.rx, dy = (lat - l.lat) / l.ry;
    const r = Math.sqrt(dx * dx + dy * dy);
    const wobble = 1 + 0.13 * Math.sin(Math.atan2(dy, dx) * 5 + l.seed) + 0.07 * Math.sin(Math.atan2(dy, dx) * 9 - l.seed);
    if (r < 1.35 * wobble) depth = Math.max(depth, (1 - smoothstep(0.35 * wobble, 1.22 * wobble, r)) * 7.5);
  }
  return depth;
}

/** 到最近河流的距离（度），供植被 / 岩石散布排除河滩 */
export function riverDistanceAt(lon, lat) {
  let best = 1e9;
  for (const r of RIVER_SEGS) best = Math.min(best, distToSegments(lon, lat, r.segs));
  return best;
}

/** 山脉抬升 */
function mountainLift(lon, lat) {
  let lift = 0;
  for (const m of MOUNTAIN_SEGS) {
    const d = distToSegments(lon, lat, m.segs);
    if (d > m.width * 2.6) continue;
    const falloff = Math.exp(-((d / m.width) ** 2) * 1.7);
    const rough = 0.58 + 0.42 * ridged(lon * 3.1, lat * 3.1, 4, 17);
    lift = Math.max(lift, m.height * falloff * rough);
  }
  return lift;
}

/**
 * 连续高度函数（度空间）。
 * 组合：大尺度起伏 + 山脉脊线 + 河谷/湖盆下切 + 平原削平 + 海岸沉降。
 */
export function heightFnLL(lon, lat) {
  const coast = coastLonAt(lat);
  const intoSea = lon - coast;
  if (intoSea > 0) {
    // 海底缓慢加深，避免边界突变
    return CONFIG.map.seaLevel - 3.5 - Math.min(9, intoSea * 1.5) - fbm(lon * 0.7, lat * 0.7, 3, 91) * 2;
  }
  const { carve } = riverCarve(lon, lat);
  const base = fbm(lon * 0.62, lat * 0.62, 6, 7);
  const detail = fbm(lon * 4.3, lat * 4.3, 4, 31);
  const ridg = ridged(lon * 1.55, lat * 1.55, 4, 53);
  let h = 3.2 + base * 6.2 + detail * 1.2 + ridg * 3.2;

  h += mountainLift(lon, lat) * CONFIG.terrain.maxHeight * 0.80;

  // 华北 / 江汉平原：削弱起伏，让战略要地可读
  const northPlain = smoothstep(0, 1, (lat - 32) / 3) * (1 - smoothstep(39, 41, lat)) *
                      smoothstep(112, 115, lon) * (1 - smoothstep(119, 122, lon));
  const sichuanBasin = Math.exp(-((((lon - 105.3) / 2.6) ** 2) + (((lat - 30.2) / 1.8) ** 2)));
  h = h * (1 - northPlain * 0.58 - sichuanBasin * 0.32) + northPlain * 1.4 + sichuanBasin * 2.2;

  h -= carve;
  h -= lakeDepth(lon, lat);

  // 海岸线附近陆地缓降至海平面
  const shore = clamp(-intoSea / 1.5, 0, 1);
  h = h * (0.18 + 0.82 * shore) + (1 - shore) * (CONFIG.map.seaLevel + 0.4);

  // 地图四周边缘轻微沉入雾中，避免看见地形截面
  const edge = Math.min(lon - M.lonMin, M.lonMax - lon, lat - M.latMin, M.latMax - lat);
  if (edge < 1.2) h -= (1.2 - edge) * 5;

  return h;
}

/* -------------------------------------------------------------------------- */
/* 高度场（一次性预计算，之后所有查询都是 O(1) 双线性插值）                     */
/* -------------------------------------------------------------------------- */
export const RES = CONFIG.terrain.heightRes;
export const heightField = new Float32Array(RES * RES);
export const seaMask = new Uint8Array(RES * RES);
export const riverMask = new Float32Array(RES * RES);

export function buildHeightField() {
  // 城址台地：把每座城周围削平为缓坡平台，避免城墙插进山体 / 悬在峭壁上。
  // 台地高度取城址原高度并夹在合理区间，半径 18 世界单位（略大于最大城郭）。
  const pads = CITIES.map((c) => {
    const p = lonLatToWorld(c.lon, c.lat);
    // 取城址周边五点均高，避免台地明显高于 / 低于四周形成环形峭壁
    const offs = [[0, 0], [0.55, 0], [-0.55, 0], [0, 0.55], [0, -0.55]];
    let sum = 0;
    for (const [dx, dy] of offs) sum += clamp(heightFnLL(c.lon + dx, c.lat + dy), 2.5, 16);
    return { x: p.x, z: p.z, h: sum / offs.length };
  });
  for (let iy = 0; iy < RES; iy++) {
    for (let ix = 0; ix < RES; ix++) {
      const { x, z } = texelToWorld(ix, iy, RES);
      const { lon, lat } = worldToLonLat(x, z);
      let h = heightFnLL(lon, lat);
      let w = 0, target = h;
      for (const pad of pads) {
        const d = Math.hypot(x - pad.x, z - pad.z);
        if (d > 27) continue;
        const ww = 1 - smoothstep(6.5, 27, d);
        if (ww > w) { w = ww; target = pad.h; }
      }
      if (w > 0) h = h * (1 - w * 0.88) + target * (w * 0.88);
      const idx = iy * RES + ix;
      heightField[idx] = h;
      seaMask[idx] = isSea(lon, lat) ? 1 : 0;
      riverMask[idx] = riverCarve(lon, lat).carve;
    }
  }
}

export function heightAt(x, z) {
  const fx = clamp((x / MAP_W + 0.5) * (RES - 1), 0, RES - 1.001);
  const fy = clamp((z / MAP_H + 0.5) * (RES - 1), 0, RES - 1.001);
  const ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy;
  const a = heightField[iy * RES + ix];
  const b = heightField[iy * RES + ix + 1];
  const c = heightField[(iy + 1) * RES + ix];
  const d = heightField[(iy + 1) * RES + ix + 1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/** 地形坡度 [0,1]，用于植被/岩石散布与地表材质混合 */
export function slopeAt(x, z) {
  const e = MAP_W / RES * 1.6;
  const dx = heightAt(x + e, z) - heightAt(x - e, z);
  const dz = heightAt(x, z + e) - heightAt(x, z - e);
  return clamp(Math.hypot(dx, dz) / (e * 2.6), 0, 1);
}

/* -------------------------------------------------------------------------- */
/* 势力归属：带扰动的城池 Voronoi，生成自然而非棋盘的疆界                     */
/* -------------------------------------------------------------------------- */
const CITY_POINTS = CITIES.map((c) => ({ lon: c.lon, lat: c.lat, f: c.faction }));
const FACTION_IDS = ['魏', '蜀', '吴', '群'];

export function factionAt(lon, lat) {
  // 边界扰动：低频噪声让疆界顺着山川走，而非笔直分割
  const nx = (valueNoise(lon * 1.7, lat * 1.7, 301) - 0.5) * 0.85
           + (valueNoise(lon * 5.1, lat * 5.1, 307) - 0.5) * 0.22;
  const ny = (valueNoise(lon * 1.7, lat * 1.7, 311) - 0.5) * 0.85
           + (valueNoise(lon * 5.1, lat * 5.1, 313) - 0.5) * 0.22;
  const px = lon + nx, py = lat + ny;
  let best = 1e9, faction = '群', second = 1e9, secondF = '群';
  for (const c of CITY_POINTS) {
    const dx = (px - c.lon) * 0.86, dy = py - c.lat;
    // 都城 / 重镇辐射范围更大
    const weight = 1;
    const d = (dx * dx + dy * dy) * weight;
    if (d < best) { second = best; secondF = faction; best = d; faction = c.f; }
    else if (d < second) { second = d; secondF = c.f; }
  }
  return { faction, adjacent: secondF, contrast: clamp((second - best) / (best + 0.8), 0, 1) };
}

/** 点是否在多边形内 */
function inPoly(lon, lat, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** 区域点选：返回州数据；多边形重叠时取重心最近者 */
export function provinceAt(lon, lat) {
  let best = null, bestD = 1e9;
  for (const p of PROVINCES) {
    if (!inPoly(lon, lat, p.poly)) continue;
    const d = Math.hypot(lon - p.center[0], lat - p.center[1]);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

/** 州界折线（去重后的独立线段），供贴图绘制 */
export const PROVINCE_EDGES = PROVINCES.map((p) => ({ id: p.id, poly: p.poly }));

export const FACTION_ORDER = FACTION_IDS;
