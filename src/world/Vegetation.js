/**
 * 植被与山岩：写实树冠（alpha 叶片簇 + PBR 树皮）、草丛、岩石露头
 * ---------------------------------------------------------------------------
 * 全部使用 InstancedMesh：3 种树 × (树干/树冠) = 6 个 draw call，
 * 草地 1 个、山岩 1 个，总计 8 个 draw call 承载上万株植物。
 * 散布遵循海拔 / 坡度 / 河岸 / 城郭避让与南北气候带，不会长在河里或城内。
 */
import * as THREE from 'three';
import { CONFIG, SEASONS } from '../config.js';
import { CITIES, MOUNTAINS } from '../data/map.js';
import {
  MAP_W, MAP_H, heightAt, slopeAt, lonLatToWorld, worldToLonLat,
  isSea, riverDistanceAt,
} from './geo.js';
import { makeBark, makeStone, makeLeafCluster, makeGrassBlade } from '../utils/textures.js';
import { fbm, valueNoise, clamp, smoothstep, rand2 } from '../utils/noise.js';
import { ASSET_MANIFEST, loadOptionalTexture } from '../data/assets.js';

/* ----------------------------- 单株树的几何 ----------------------------- */
function trunkGeometry(type) {
  const parts = [];
  const h = type === 'pine' ? 7.2 : type === 'willow' ? 6.0 : 6.6;
  const trunk = new THREE.CylinderGeometry(0.20, 0.42, h, 9, 3);
  trunk.translate(0, h / 2, 0);
  parts.push(trunk);
  // 主枝分叉（写实树形的关键，避免"棒棒糖"剪影）
  const branchCount = type === 'pine' ? 6 : 5;
  for (let i = 0; i < branchCount; i++) {
    const a = i * 2.399;
    const y = h * (type === 'pine' ? 0.34 + i * 0.10 : 0.56 + (i % 3) * 0.10);
    const len = (type === 'willow' ? 2.5 : 2.0) * (0.75 + (i % 3) * 0.16);
    const br = new THREE.CylinderGeometry(0.075, 0.17, len, 6);
    br.rotateZ(type === 'willow' ? 1.18 : 0.82);
    br.rotateY(a);
    br.translate(Math.cos(a) * len * 0.32, y + len * 0.30, Math.sin(a) * len * 0.32);
    parts.push(br);
  }
  // 根部微微膨大
  const root = new THREE.SphereGeometry(0.52, 9, 6);
  root.scale(1, 0.42, 1);
  root.translate(0, 0.22, 0);
  parts.push(root);
  return { geo: mergeSimple(parts), height: h };
}

/** 合并同属性的基础几何（先展开为无索引，避免丢失三角形） */
function mergeSimple(list) {
  const expanded = list.map((g) => {
    const e = g.index ? g.toNonIndexed() : g;
    if (e !== g) g.dispose();
    if (!e.attributes.normal) e.computeVertexNormals();
    if (!e.attributes.uv) e.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(e.attributes.position.count * 2), 2));
    return e;
  });
  let total = 0;
  for (const g of expanded) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  let o = 0;
  for (const g of expanded) {
    const p = g.attributes.position, n = g.attributes.normal, t = g.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      pos[(o + i) * 3] = p.getX(i); pos[(o + i) * 3 + 1] = p.getY(i); pos[(o + i) * 3 + 2] = p.getZ(i);
      nrm[(o + i) * 3] = n.getX(i); nrm[(o + i) * 3 + 1] = n.getY(i); nrm[(o + i) * 3 + 2] = n.getZ(i);
      uv[(o + i) * 2] = t.getX(i); uv[(o + i) * 2 + 1] = t.getY(i);
    }
    o += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return out;
}

/** 树冠：多个交叉面片 + 叶片 alpha 贴图（SpeedTree 式做法，非多边形球） */
function canopyGeometry(type) {
  const quads = [];
  const h = type === 'pine' ? 7.2 : 6.4;
  if (type === 'pine') {
    // 针叶：多层递减的锥形冠幅
    for (let layer = 0; layer < 4; layer++) {
      const t = layer / 3;
      const w = 4.4 * (1 - t * 0.62) + 0.7;
      const y = 2.4 + t * 5.1;
      for (let k = 0; k < 3; k++) {
        const q = new THREE.PlaneGeometry(w, 2.3 + (1 - t) * 0.8);
        q.rotateY(k * Math.PI / 3);
        q.translate(0, y, 0);
        quads.push(q);
      }
    }
  } else if (type === 'willow') {
    for (let i = 0; i < 9; i++) {
      const a = i * 2.399;
      const q = new THREE.PlaneGeometry(2.9, 3.4);
      q.rotateY(a);
      q.rotateZ(0.12);
      q.translate(Math.cos(a) * 1.55, 5.1 - (i % 3) * 0.45, Math.sin(a) * 1.55);
      quads.push(q);
    }
    // 垂柳条
    for (let i = 0; i < 6; i++) {
      const a = i * Math.PI / 3;
      const q = new THREE.PlaneGeometry(0.9, 3.6);
      q.rotateY(a);
      q.translate(Math.cos(a) * 2.3, 4.0, Math.sin(a) * 2.3);
      quads.push(q);
    }
  } else {
    // 阔叶：错落的叶簇团
    for (let i = 0; i < 8; i++) {
      const a = i * 2.399;
      const r = 1.15 + (i % 3) * 0.55;
      const q = new THREE.PlaneGeometry(3.3 + (i % 3) * 0.6, 3.3 + (i % 2) * 0.7);
      q.rotateY(a);
      q.translate(Math.cos(a) * r, 4.5 + (i % 4) * 0.58, Math.sin(a) * r);
      quads.push(q);
    }
  }
  return mergeSimple(quads);
}

/** 草丛：两片交叉面 + 自定义 aSway 权重 */
function grassGeometry() {
  const a = new THREE.PlaneGeometry(1.15, 1.25, 1, 2);
  a.translate(0, 0.625, 0);
  const b = a.clone(); b.rotateY(Math.PI / 2);
  const geo = mergeSimple([a, b]);
  const n = geo.attributes.position.count;
  const sway = new Float32Array(n);
  const uv = geo.attributes.uv;
  for (let i = 0; i < n; i++) sway[i] = uv.getY(i);
  geo.setAttribute('aSway', new THREE.BufferAttribute(sway, 1));
  return geo;
}

/* ================================= 主类 ================================= */
export class Vegetation {
  constructor(scene, quality) {
    this.scene = scene;
    this.quality = quality;
    this.group = new THREE.Group();
    this.group.name = 'vegetation';
    scene.add(this.group);
    this.time = { value: 0 };
    this.seasonUniforms = {
      uSeasonColor: { value: new THREE.Color(0x86b963) },
      uSeasonStrength: { value: 0.35 },
    };
    this.buildTrees();
    this.buildGrass();
    this.buildRocks();
    this.setSeason(CONFIG.season, true);
  }

  /** 季节着色注入：用叶簇明度重建色相，避免简单相乘导致发黑 */
  withSeason(mat, strength) {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uSeasonColor = this.seasonUniforms.uSeasonColor;
      shader.uniforms.uSeasonStrength = { value: strength };
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform vec3 uSeasonColor;
          uniform float uSeasonStrength;`)
        .replace('#include <map_fragment>', `#include <map_fragment>
          vec3 seasonal = uSeasonColor * (0.48 + diffuseColor.g * 0.95);
          diffuseColor.rgb = mix(diffuseColor.rgb, seasonal, uSeasonStrength);`);
    };
    mat.customProgramCacheKey = () => `veg-season-${strength}`;
    return mat;
  }

  /** 采样合法的植被落点 */
  scatter(count, filter) {
    const out = [];
    let guard = count * 26;
    const cityPts = CITIES.map((c) => lonLatToWorld(c.lon, c.lat));
    while (out.length < count && guard-- > 0) {
      const lon = CONFIG.map.lonMin + 0.4 + Math.random() * (CONFIG.map.lonMax - CONFIG.map.lonMin - 0.8);
      const lat = CONFIG.map.latMin + 0.4 + Math.random() * (CONFIG.map.latMax - CONFIG.map.latMin - 0.8);
      if (isSea(lon, lat)) continue;
      const p = lonLatToWorld(lon, lat);
      const y = heightAt(p.x, p.z);
      if (y < CONFIG.map.seaLevel + 1.4 || y > 40) continue;
      const slope = slopeAt(p.x, p.z);
      if (!filter({ lon, lat, y, slope, p })) continue;
      let blocked = false;
      for (const cp of cityPts) {
        if (Math.abs(cp.x - p.x) < 11 && Math.abs(cp.z - p.z) < 11) { blocked = true; break; }
      }
      if (blocked) continue;
      out.push({ x: p.x, y, z: p.z, lon, lat, slope });
    }
    return out;
  }

  buildTrees() {
    const count = CONFIG.population.trees[this.quality.populationIndex];
    const bark = makeBark();
    const leaf = makeLeafCluster();
    const leafPine = makeLeafCluster();
    leaf.anisotropy = leafPine.anisotropy = 8;

    const trunkMat = new THREE.MeshStandardMaterial({
      map: bark.map, normalMap: bark.normalMap, color: 0xbfb0a0,
      roughness: 0.94, metalness: 0.0,
    });
    loadOptionalTexture(ASSET_MANIFEST.bark, { srgb: true },
      (t) => { trunkMat.map = t; trunkMat.needsUpdate = true; });
    const leafMat = this.withSeason(new THREE.MeshStandardMaterial({
      map: leaf, alphaTest: 0.42, transparent: false, side: THREE.DoubleSide,
      roughness: 0.90, metalness: 0.0, depthWrite: true,
    }), 0.55);
    const pineMat = this.withSeason(new THREE.MeshStandardMaterial({
      map: leafPine, alphaTest: 0.42, transparent: false, side: THREE.DoubleSide,
      color: 0x8fae8c, roughness: 0.92, metalness: 0, depthWrite: true,
    }), 0.42);
    // 真实叶片图谱替换（加载失败则继续用程序化叶簇）
    loadOptionalTexture(ASSET_MANIFEST.leafAtlas, { srgb: true, aniso: 8 }, (t) => {
      for (const m of [leafMat, pineMat]) { m.map = t; m.needsUpdate = true; }
    });

    const species = [
      { id: 'broad', trunkMat, leafMat: leafMat, prob: (lat) => smoothstep(27, 36, lat) * 0.55 + 0.25 },
      { id: 'pine', trunkMat, leafMat: pineMat, prob: (lat) => 1 - smoothstep(28, 39, lat) * 0.35 },
      { id: 'willow', trunkMat, leafMat, prob: (lat) => 0.35 },
    ];

    // 先按气候带分配目标数量
    const groups = { broad: [], pine: [], willow: [] };
    const sites = this.scatter(count, ({ lon, lat, y, slope }) => {
      if (slope > 0.52) return false;
      if (riverDistanceAt(lon, lat) < 0.16) return false;
      const forest = fbm(lon * 0.9, lat * 0.9, 4, 151);
      const south = smoothstep(24, 34, lat);
      return Math.random() < (0.14 + forest * 0.72) * (0.5 + south * 0.7);
    });
    for (const s of sites) {
      const r = Math.random();
      const nearWater = riverDistanceAt(s.lon, s.lat) < 0.62;
      const type = nearWater && r < 0.45 ? 'willow' : s.lat > 33 ? (r < 0.58 ? 'pine' : 'broad') : (r < 0.42 ? 'pine' : 'broad');
      groups[type].push(s);
    }

    const dummy = new THREE.Object3D();
    for (const spec of species) {
      const list = groups[spec.id];
      if (!list.length) continue;
      const tr = trunkGeometry(spec.id);
      const cr = canopyGeometry(spec.id);
      const trunks = new THREE.InstancedMesh(tr.geo, spec.trunkMat, list.length);
      const crowns = new THREE.InstancedMesh(cr, spec.leafMat, list.length);
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        const scale = 0.72 + Math.random() * 0.72;
        dummy.position.set(s.x, s.y - 0.25, s.z);
        dummy.rotation.set(0, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.045);
        dummy.scale.set(scale, scale * (0.88 + Math.random() * 0.3), scale);
        dummy.updateMatrix();
        trunks.setMatrixAt(i, dummy.matrix);
        crowns.setMatrixAt(i, dummy.matrix);
        const tint = 0.78 + rand2(i, 3, spec.id.length) * 0.35;
        crowns.setColorAt(i, new THREE.Color().setRGB(tint, tint * (0.96 + Math.random() * 0.08), tint));
      }
      trunks.instanceMatrix.needsUpdate = true;
      crowns.instanceMatrix.needsUpdate = true;
      if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
      trunks.castShadow = crowns.castShadow = !this.quality.isMobile;
      crowns.receiveShadow = true;
      trunks.receiveShadow = true;
      trunks.frustumCulled = crowns.frustumCulled = false;
      this.group.add(trunks, crowns);
    }
  }

  buildGrass() {
    const count = CONFIG.population.grass[this.quality.populationIndex];
    const geo = grassGeometry();
    const mat = this.withSeason(new THREE.MeshStandardMaterial({
      map: makeGrassBlade(), alphaTest: 0.36, side: THREE.DoubleSide,
      roughness: 0.98, metalness: 0.0, depthWrite: true,
    }), 0.45);
    mat.onBeforeCompile = ((orig) => (shader, renderer) => {
      orig(shader, renderer);
      shader.uniforms.uVegTime = this.time;
      shader.vertexShader = `attribute float aSway;\nuniform float uVegTime;\n` +
        shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
          #ifdef USE_INSTANCING
            float ph = instanceMatrix[3].x * 0.21 + instanceMatrix[3].z * 0.17;
            transformed.x += sin(uVegTime * 1.7 + ph + aSway * 2.0) * 0.16 * aSway;
            transformed.z += cos(uVegTime * 1.3 + ph) * 0.09 * aSway;
          #endif
        `);
    })(mat.onBeforeCompile);
    mat.customProgramCacheKey = () => 'grass-sway-v1';

    const sites = this.scatter(count, ({ lon, lat, y, slope }) => {
      if (slope > 0.42 || y > 30) return false;
      if (riverDistanceAt(lon, lat) < 0.10) return false;
      const meadow = fbm(lon * 1.6, lat * 1.6, 4, 211);
      return Math.random() < 0.24 + meadow * 0.72;
    });
    const inst = new THREE.InstancedMesh(geo, mat, sites.length);
    const dummy = new THREE.Object3D();
    sites.forEach((s, i) => {
      dummy.position.set(s.x, s.y - 0.12, s.z);
      dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
      const sc = 0.75 + Math.random() * 1.25;
      dummy.scale.set(sc, sc * (0.8 + Math.random() * 0.7), sc);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
      const t = 0.72 + Math.random() * 0.5;
      inst.setColorAt(i, new THREE.Color().setRGB(t, t, t * 0.92));
    });
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.frustumCulled = false;
    inst.receiveShadow = true;
    inst.name = 'grasslands';
    this.group.add(inst);
  }

  buildRocks() {
    const count = CONFIG.population.rocks[this.quality.populationIndex];
    const stone = makeStone(256);
    const mat = new THREE.MeshStandardMaterial({
      map: stone.map, normalMap: stone.normalMap, color: 0x9a958d,
      roughness: 0.96, metalness: 0.0,
    });
    const geo = new THREE.IcosahedronGeometry(1, 1);
    // 扰动顶点，形成不规则岩块
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const n = valueNoise(p.getX(i) * 2.1 + 3, p.getZ(i) * 2.1 + 7, 233);
      const k = 0.76 + n * 0.55;
      p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.72, p.getZ(i) * k);
    }
    p.needsUpdate = true;
    geo.computeVertexNormals();

    const sites = this.scatter(count, ({ lon, lat, y, slope }) => {
      if (y < 8) return false;
      return slope > 0.20 || y > 27;
    });
    // 沿主要山脉额外补一列裸岩
    for (const m of MOUNTAINS) {
      for (let i = 0; i < 12; i++) {
        const t = i / 11;
        const seg = Math.floor(t * (m.points.length - 1));
        const a = m.points[seg], b = m.points[Math.min(seg + 1, m.points.length - 1)];
        const f = t * (m.points.length - 1) - seg;
        const lon = a[0] + (b[0] - a[0]) * f + (Math.random() - 0.5) * 0.7;
        const lat = a[1] + (b[1] - a[1]) * f + (Math.random() - 0.5) * 0.55;
        const q = lonLatToWorld(lon, lat);
        sites.push({ x: q.x, y: heightAt(q.x, q.z), z: q.z, lon, lat });
      }
    }
    const inst = new THREE.InstancedMesh(geo, mat, sites.length);
    const dummy = new THREE.Object3D();
    sites.forEach((s, i) => {
      const sc = 1.2 + Math.random() * 3.4;
      dummy.position.set(s.x, s.y + sc * 0.16, s.z);
      dummy.rotation.set(Math.random() * 0.5, Math.random() * 6.28, Math.random() * 0.5);
      dummy.scale.set(sc * 1.3, sc * 0.8, sc);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
      const t = 0.68 + Math.random() * 0.5;
      inst.setColorAt(i, new THREE.Color().setRGB(t, t * 0.98, t * 0.93));
    });
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.castShadow = !this.quality.isMobile;
    inst.receiveShadow = true;
    inst.frustumCulled = false;
    inst.name = 'mountain-rocks';
    this.group.add(inst);
  }

  setSeason(season, immediate = false) {
    const colors = {
      春: 0x9ecb72, 夏: 0x6da457, 秋: 0xc89242, 冬: 0xa9b3ac,
    };
    this._seasonTarget = new THREE.Color(colors[season]);
    if (immediate) this.seasonUniforms.uSeasonColor.value.copy(this._seasonTarget);
  }

  update(dt, env, season) {
    this.time.value += dt;
    this.setSeason(season);
    this.seasonUniforms.uSeasonColor.value.lerp(this._seasonTarget, Math.min(1, dt * 1.1));
    // 雨天叶片稍暗、冬季带雪白
    const wet = env.weather === '雨' ? 0.78 : 1;
    this.seasonUniforms.uSeasonStrength.value = (season === '冬' ? 0.68 : 0.48) * wet;
  }
}
