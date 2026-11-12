/**
 * 人物与动物：武将 / 士兵方阵 / 战马 / 山鹿
 * ---------------------------------------------------------------------------
 * 采用写实人体比例（头身比约 1:7）与汉末甲胄形制：兜鍪、山文甲片、护肩、
 * 袍裙、披风、长兵；马匹为椭圆躯干 + 分段四肢 + 鬃尾，非低多边形玩偶。
 *
 * 性能：所有人物部件合并为 5 个 Mesh；士兵方阵与兽群使用 InstancedMesh，
 * 每个势力 / 每种动物仅 1 个 draw call。披风与马尾在顶点着色器里迎风摆动。
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG, FACTIONS } from '../config.js';
import { GENERALS } from '../data/generals.js';
import { CITIES } from '../data/map.js';
import { lonLatToWorld, heightAt, isSea } from './geo.js';
import { makeFabricNormal } from '../utils/textures.js';

const SKIN = 0xc99a72;
const DARK = 0x2a2622;
const IRON = 0x6f7579;
const GOLD = 0xb99a5c;
const WOOD = 0x533b28;

/* ---------------------------- 几何分组构建器 ---------------------------- */
class Builder {
  constructor() {
    this.groups = { metal: [], cloth: [], skin: [], leather: [], horse: [] };
    this.o = [0, 0, 0]; this.yaw = 0; this.s = 1;
  }
  at(x, y, z, yaw = 0, s = 1) { this.o = [x, y, z]; this.yaw = yaw; this.s = s; return this; }
  add(group, geo, hex, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, anim = 0) {
    if (rx) geo.rotateX(rx);
    if (ry) geo.rotateY(ry);
    if (rz) geo.rotateZ(rz);
    geo.translate(x, y, z);
    if (this.yaw) geo.rotateY(this.yaw);
    if (this.s !== 1) geo.scale(this.s, this.s, this.s);
    geo.translate(this.o[0], this.o[1], this.o[2]);
    if (!geo.attributes.uv) {
      geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    }
    const n = geo.attributes.position.count;
    const col = new THREE.Color(hex);
    const ca = new Float32Array(n * 3);
    const aa = new Float32Array(n);
    const uv = geo.attributes.uv;
    for (let i = 0; i < n; i++) {
      ca[i * 3] = col.r; ca[i * 3 + 1] = col.g; ca[i * 3 + 2] = col.b;
      aa[i] = anim === -1 ? uv.getY(i) : anim;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(ca, 3));
    geo.setAttribute('aAnim', new THREE.BufferAttribute(aa, 1));
    this.groups[group].push(geo);
    return geo;
  }
  all() { return Object.values(this.groups).flat(); }
}

/* ------------------------------- 人物部件 ------------------------------- */
function addHuman(b, opts) {
  const { cloth = 0x40536b, metal = IRON, plume = 0xa63c31,
    weapon = 'spear', cloak = true, rank = 1 } = opts;
  const S = rank ? 1 : 0.85;

  // 头 / 面 / 颈
  b.add('skin', new THREE.SphereGeometry(0.34 * S, 14, 12), SKIN, 0, 3.18 * S, 0);
  b.add('skin', new THREE.CylinderGeometry(0.135 * S, 0.16 * S, 0.22 * S, 10), SKIN, 0, 2.86 * S, 0);
  // 兜鍪（半球 + 护额 + 顿项 + 盔缨）
  b.add('metal', new THREE.SphereGeometry(0.375 * S, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), metal, 0, 3.22 * S, 0);
  b.add('metal', new THREE.CylinderGeometry(0.39 * S, 0.39 * S, 0.10 * S, 14), GOLD, 0, 3.06 * S, 0);
  b.add('metal', new THREE.CylinderGeometry(0.34 * S, 0.42 * S, 0.30 * S, 12, 1, true), metal, 0, 2.96 * S, 0);
  b.add('cloth', new THREE.ConeGeometry(0.10 * S, 0.55 * S, 8), plume, 0, 3.70 * S, -0.02);

  // 躯干：上宽下窄，肩甲 + 山文甲片
  b.add('cloth', new THREE.CylinderGeometry(0.44 * S, 0.34 * S, 1.22 * S, 12), cloth, 0, 2.22 * S, 0);
  b.add('metal', new THREE.SphereGeometry(0.25 * S, 10, 8), metal, -0.51 * S, 2.72 * S, 0);
  b.add('metal', new THREE.SphereGeometry(0.25 * S, 10, 8), metal, 0.51 * S, 2.72 * S, 0);
  for (let row = 0; row < 3; row++) {
    for (let k = -2; k <= 2; k++) {
      const x = k * 0.16 * S;
      const y = (2.55 - row * 0.28) * S;
      const plate = new THREE.BoxGeometry(0.15 * S, 0.19 * S, 0.055 * S);
      b.add('metal', plate, row === 1 ? GOLD : metal, x, y, 0.37 * S, 0, 0, 0.12);
    }
  }
  // 腰带 / 袍裙
  b.add('leather', new THREE.CylinderGeometry(0.40 * S, 0.40 * S, 0.16 * S, 12), DARK, 0, 1.72 * S, 0);
  b.add('metal', new THREE.BoxGeometry(0.24 * S, 0.18 * S, 0.10 * S), GOLD, 0, 1.72 * S, 0.40 * S);
  b.add('cloth', new THREE.CylinderGeometry(0.38 * S, 0.62 * S, 0.90 * S, 14), cloth, 0, 1.24 * S, 0);

  // 双臂 + 手
  for (const s of [-1, 1]) {
    b.add('cloth', new THREE.CapsuleGeometry(0.135 * S, 0.62 * S, 4, 8), cloth, s * 0.56 * S, 2.20 * S, 0, 0, 0, s * 0.16);
    b.add('skin', new THREE.SphereGeometry(0.14 * S, 8, 8), SKIN, s * 0.64 * S, 1.72 * S, 0.03);
    b.add('leather', new THREE.CylinderGeometry(0.18 * S, 0.15 * S, 0.85 * S, 9), DARK, s * 0.23 * S, 0.62 * S, 0);
    b.add('leather', new THREE.BoxGeometry(0.32 * S, 0.22 * S, 0.52 * S), DARK, s * 0.23 * S, 0.14 * S, 0.10 * S);
  }

  // 披风（顶点摆动）
  if (cloak) {
    const c = new THREE.PlaneGeometry(1.12 * S, 1.72 * S, 6, 5);
    b.add('cloth', c, plume, 0, 2.20 * S, -0.34 * S, 0, 0, 0, -1);
  }

  // 兵器
  const wx = 0.74 * S;
  if (weapon === 'spear') {
    b.add('leather', new THREE.CylinderGeometry(0.045 * S, 0.045 * S, 3.5 * S, 7), WOOD, wx, 1.95 * S, 0.10 * S, 0, 0, -0.10);
    b.add('metal', new THREE.ConeGeometry(0.11 * S, 0.42 * S, 8), IRON, wx + 0.18 * S, 3.92 * S, 0.10 * S, 0, 0, -0.10);
    b.add('cloth', new THREE.PlaneGeometry(0.20 * S, 0.50 * S), plume, wx + 0.24 * S, 3.38 * S, 0.10 * S, 0, 0, 0, -1);
  } else if (weapon === 'sword') {
    b.add('metal', new THREE.BoxGeometry(0.09 * S, 1.5 * S, 0.035 * S), IRON, wx, 1.05 * S, 0.14 * S, 0, 0, -0.25);
    b.add('metal', new THREE.BoxGeometry(0.34 * S, 0.09 * S, 0.10 * S), GOLD, wx + 0.16 * S, 0.42 * S, 0.14 * S);
  } else if (weapon === 'fan') {
    b.add('cloth', new THREE.CircleGeometry(0.48 * S, 16, 0, Math.PI), 0xd9cfb0, wx, 2.50 * S, 0.18 * S, 0, 0, 0.3);
    b.add('leather', new THREE.CylinderGeometry(0.035 * S, 0.035 * S, 0.6 * S, 6), WOOD, wx, 2.16 * S, 0.18 * S);
  } else if (weapon === 'bow') {
    const arc = new THREE.TorusGeometry(0.85 * S, 0.045 * S, 6, 18, Math.PI * 1.1);
    b.add('leather', arc, WOOD, wx, 2.0 * S, 0.12 * S, 0, 0, -Math.PI * 0.5);
  }
  // 盾（步兵）
  if (weapon === 'shield') {
    const sh = new THREE.CylinderGeometry(0.52 * S, 0.52 * S, 0.07 * S, 16);
    b.add('metal', sh, cloth, -0.78 * S, 1.95 * S, 0.24 * S, Math.PI / 2, 0, 0);
    b.add('metal', new THREE.SphereGeometry(0.14 * S, 8, 6), GOLD, -0.78 * S, 1.95 * S, 0.31 * S);
  }
}

/* ------------------------------- 战马部件 ------------------------------- */
function addHorse(b, coat = 0x53402f, saddle = 0x8a3c30, tailAnim = true) {
  const C = coat, MANE = 0x241d18;
  // 躯干（拉长椭球，更接近真实马体而非方块）
  const body = new THREE.SphereGeometry(0.86, 18, 14);
  body.scale(1.62, 0.92, 0.82);
  b.add('horse', body, C, 0, 1.62, 0);
  // 胸 / 臀
  const chest = new THREE.SphereGeometry(0.62, 14, 12);
  chest.scale(0.9, 1.0, 1.0);
  b.add('horse', chest, C, 0.94, 1.68, 0);
  b.add('horse', new THREE.SphereGeometry(0.60, 14, 12), C, -0.96, 1.66, 0);
  // 颈（前倾）+ 头
  const neck = new THREE.CylinderGeometry(0.30, 0.46, 1.12, 12);
  b.add('horse', neck, C, 1.12, 2.14, 0, 0, 0, -0.52);
  const head = new THREE.SphereGeometry(0.30, 12, 10);
  head.scale(1.42, 0.92, 0.86);
  b.add('horse', head, C, 1.62, 2.46, 0, 0, 0, -0.32);
  b.add('horse', new THREE.SphereGeometry(0.17, 10, 8), 0x3a2c22, 2.05, 2.30, 0, 0, 0, -0.32);
  for (const s of [-1, 1]) {
    b.add('horse', new THREE.ConeGeometry(0.085, 0.28, 7), C, 1.46, 2.82, s * 0.17);
  }
  // 鬃毛
  for (let i = 0; i < 8; i++) {
    const t = i / 7;
    b.add('horse', new THREE.ConeGeometry(0.10, 0.34, 6), MANE,
      1.46 - t * 0.85, 2.70 - t * 0.52, 0, 0, 0, -0.55);
  }
  // 四肢（上下两段，带关节）
  for (const fx of [0.78, -0.82]) for (const fz of [-0.42, 0.42]) {
    b.add('horse', new THREE.CylinderGeometry(0.16, 0.115, 0.92, 8), C, fx, 1.10, fz, 0, 0, 0.06);
    b.add('horse', new THREE.SphereGeometry(0.14, 8, 6), C, fx + 0.05, 0.66, fz);
    b.add('horse', new THREE.CylinderGeometry(0.105, 0.085, 0.66, 8), C, fx + 0.05, 0.33, fz);
    b.add('horse', new THREE.BoxGeometry(0.26, 0.13, 0.32), 0x201a16, fx + 0.06, 0.07, fz);
  }
  // 马尾（摆动）
  const tail = new THREE.ConeGeometry(0.20, 0.95, 9);
  b.add('horse', tail, MANE, -1.62, 1.62, 0, 0, 0, 2.25, tailAnim ? -1 : 0);
  // 鞍具 + 障泥
  b.add('leather', new THREE.BoxGeometry(0.92, 0.16, 0.78), 0x3b2b1e, 0.05, 2.22, 0);
  b.add('cloth', new THREE.BoxGeometry(0.80, 0.06, 0.90), saddle, 0.05, 2.32, 0);
  b.add('cloth', new THREE.BoxGeometry(1.10, 0.58, 0.045), saddle, 0.0, 1.86, 0.44, 0, 0, 0, -1);
  b.add('cloth', new THREE.BoxGeometry(1.10, 0.58, 0.045), saddle, 0.0, 1.86, -0.44, 0, 0, 0, -1);
  // 缰绳
  b.add('leather', new THREE.CylinderGeometry(0.022, 0.022, 1.6, 6), 0x2a211a, 1.18, 2.26, 0.18, 0, 0, -0.95);
}

/* -------------------------------- 山鹿 -------------------------------- */
function addDeer(b, coat = 0x8a6a45) {
  const body = new THREE.SphereGeometry(0.50, 12, 10);
  body.scale(1.5, 0.8, 0.72);
  b.add('horse', body, coat, 0, 0.95, 0);
  b.add('horse', new THREE.CylinderGeometry(0.13, 0.19, 0.72, 8), coat, 0.62, 1.40, 0, 0, 0, -0.55);
  b.add('horse', new THREE.SphereGeometry(0.19, 10, 8), coat, 0.88, 1.70, 0);
  for (const s of [-1, 1]) {
    b.add('horse', new THREE.ConeGeometry(0.05, 0.20, 6), 0x5a4630, 0.80, 1.88, s * 0.13);
  }
  for (const fx of [0.42, -0.44]) for (const fz of [-0.28, 0.28]) {
    b.add('horse', new THREE.CylinderGeometry(0.055, 0.038, 0.88, 6), coat, fx, 0.44, fz);
  }
  // 角
  for (const s of [-1, 1]) {
    b.add('leather', new THREE.CylinderGeometry(0.035, 0.055, 0.62, 6), 0x6b563a, 0.80, 2.12, s * 0.13, 0, 0, s * 0.35);
    b.add('leather', new THREE.CylinderGeometry(0.022, 0.035, 0.38, 5), 0x6b563a, 0.98, 2.36, s * 0.28, 0, 0, -0.6);
  }
}

/* ================================ 主类 ================================ */
export class Characters {
  constructor(scene, picker, quality) {
    this.scene = scene;
    this.picker = picker;
    this.quality = quality;
    this.group = new THREE.Group();
    this.group.name = 'characters';
    scene.add(this.group);
    this.animTime = { value: 0 };
    this.instances = [];
    this.fabric = makeFabricNormal(128);
    this.buildGenerals();
    this.buildArmies();
    this.buildWildlife();
  }

  material(kind) {
    const base = {
      metal: { roughness: 0.36, metalness: 0.72 },
      cloth: { roughness: 0.86, metalness: 0.02 },
      skin: { roughness: 0.70, metalness: 0.0 },
      leather: { roughness: 0.78, metalness: 0.02 },
      horse: { roughness: 0.80, metalness: 0.0 },
    }[kind];
    const m = new THREE.MeshStandardMaterial({
      vertexColors: true, side: kind === 'cloth' ? THREE.DoubleSide : THREE.FrontSide,
      ...base,
    });
    if (kind === 'cloth' || kind === 'leather') {
      m.normalMap = this.fabric;
      m.normalScale = new THREE.Vector2(0.35, 0.35);
    }
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uCharTime = this.animTime;
      shader.vertexShader = `attribute float aAnim;\nuniform float uCharTime;\n` +
        shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
          float aw = aAnim;
          transformed.x += sin(uCharTime * 1.8 + position.z * 0.42) * 0.18 * aw;
          transformed.z += cos(uCharTime * 2.1 + position.x * 0.37) * 0.14 * aw;
        `);
    };
    m.customProgramCacheKey = () => `character-${kind}-v1`;
    return m;
  }

  /** 13 位武将：各自带坐骑 / 仪仗，按材质合批 */
  buildGenerals() {
    const b = new Builder();
    this.generalPositions = [];
    GENERALS.forEach((g, i) => {
      const city = CITIES.find((c) => c.name === g.city);
      if (!city) return;
      const p = lonLatToWorld(city.lon, city.lat);
      const a = i * 2.399;
      const x = p.x + Math.cos(a) * 15.5;
      const z = p.z + Math.sin(a) * 15.5;
      const y = heightAt(x, z) + 0.2;
      const f = FACTIONS[g.faction];
      const mounted = g.unit === '骑兵' || g.horse === '赤兔' || g.horse === '的卢';
      const yaw = (i * 1.13) % (Math.PI * 2);
      const color = g.color || f.color;

      if (mounted) {
        b.at(x, y, z, yaw, 1.0);
        addHorse(b, [0x4a3226, 0x201d1b, 0xb0432e, 0xd8cdb4][i % 4], f.deep);
        b.at(x, y + 2.22, z, yaw, 1.0);
        addHuman(b, {
          cloth: color, metal: f.silk, plume: f.color,
          weapon: g.name === '诸葛亮' ? 'fan' : g.unit === '水军' ? 'sword' : 'spear',
          cloak: true,
        });
      } else {
        b.at(x, y, z, yaw, 1.05);
        addHuman(b, {
          cloth: color, metal: f.silk, plume: f.color,
          weapon: g.name === '诸葛亮' ? 'fan' : g.unit === '水军' ? 'bow' : 'spear',
          cloak: true,
        });
        b.at(x + Math.cos(yaw + 1.6) * 3.6, y, z + Math.sin(yaw + 1.6) * 3.6, yaw + 0.4, 0.92);
        addHorse(b, [0x4a3226, 0x2b2622, 0xd8cdb4][i % 3], f.deep);
      }
      // 帅旗（高点，便于远看定位）
      b.at(x, y, z, yaw, 1.0);
      b.add('leather', new THREE.CylinderGeometry(0.06, 0.07, 5.4, 6), WOOD, -2.6, 2.7, -1.2);
      b.add('cloth', new THREE.PlaneGeometry(1.25, 1.75, 5, 4), color, -1.95, 4.35, -1.2, 0, 0, 0, -1);

      this.generalPositions.push({ general: g, x, y, z });
      this.picker.addProxy(x, y + 2.2, z, [7.5, 7.0, 7.5], {
        type: 'general', general: g, city, x, y, z,
      });
    });

    for (const [kind, list] of Object.entries(b.groups)) {
      if (!list.length) continue;
      const merged = mergeGeometries(list, false);
      const mesh = new THREE.Mesh(merged, this.material(kind));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      list.forEach((g) => g.dispose());
    }
  }

  /** 士兵方阵：每个势力 1 个 InstancedMesh */
  buildArmies() {
    const formations = [
      { city: '汉中', faction: '蜀', cols: 10, rows: 7, type: '弩兵' },
      { city: '合肥', faction: '魏', cols: 9, rows: 7, type: '步兵' },
      { city: '襄阳', faction: '魏', cols: 8, rows: 6, type: '骑兵' },
      { city: '柴桑', faction: '吴', cols: 9, rows: 7, type: '水军' },
      { city: '江陵', faction: '吴', cols: 8, rows: 6, type: '步兵' },
      { city: '邺城', faction: '魏', cols: 9, rows: 6, type: '步兵' },
      { city: '成都', faction: '蜀', cols: 8, rows: 6, type: '步兵' },
      { city: '建业', faction: '吴', cols: 8, rows: 6, type: '弩兵' },
      { city: '代郡', faction: '群', cols: 6, rows: 5, type: '骑兵' },
    ];
    const cap = CONFIG.population.soldiers[this.quality.populationIndex];
    const perFaction = { 魏: [], 蜀: [], 吴: [], 群: [] };

    formations.forEach((f, fi) => {
      const city = CITIES.find((c) => c.name === f.city);
      if (!city) return;
      const p = lonLatToWorld(city.lon, city.lat);
      const angle = fi * 1.7;
      const cx = p.x + Math.cos(angle) * 25;
      const cz = p.z + Math.sin(angle) * 25;
      const yaw = fi * 0.42;
      const spacing = 2.05;
      const total = f.cols * f.rows;
      for (let i = 0; i < total; i++) {
        if (perFaction[f.faction].length >= cap / 4) break;
        const col = i % f.cols, row = Math.floor(i / f.cols);
        const lx = (col - (f.cols - 1) / 2) * spacing;
        const lz = (row - (f.rows - 1) / 2) * spacing * 1.15;
        const x = cx + lx * Math.cos(yaw) - lz * Math.sin(yaw);
        const z = cz + lx * Math.sin(yaw) + lz * Math.cos(yaw);
        perFaction[f.faction].push({ x, z, y: heightAt(x, z), yaw, scale: 0.80 + (i % 5) * 0.012 });
      }
      this.picker.addProxy(cx, heightAt(cx, cz) + 2.2, cz, [f.cols * spacing + 4, 7, f.rows * spacing * 1.15 + 4], {
        type: 'army', name: `${f.city} ${f.type}营`, faction: f.faction,
        troops: total * 120, city: f.city, x: cx, y: heightAt(cx, cz), z: cz,
      });
    });

    const dummy = new THREE.Object3D();
    for (const [faction, list] of Object.entries(perFaction)) {
      if (!list.length) continue;
      const sb = new Builder();
      sb.at(0, 0, 0, 0, 1);
      addHuman(sb, {
        cloth: FACTIONS[faction].color,
        metal: FACTIONS[faction].silk,
        plume: FACTIONS[faction].deep,
        weapon: faction === '吴' ? 'shield' : 'spear',
        cloak: false, rank: 0,
      });
      const geo = mergeGeometries(sb.all(), false);
      sb.all().forEach((g) => g.dispose());
      const mat = this.material('cloth');
      mat.metalness = 0.22; mat.roughness = 0.68;
      const inst = new THREE.InstancedMesh(geo, mat, list.length);
      inst.castShadow = true;
      inst.receiveShadow = true;
      list.forEach((s, i) => {
        dummy.position.set(s.x, s.y, s.z);
        dummy.rotation.set(0, s.yaw + (i % 3 - 1) * 0.035, 0);
        dummy.scale.setScalar(s.scale);
        dummy.updateMatrix();
        inst.setMatrixAt(i, dummy.matrix);
      });
      inst.instanceMatrix.needsUpdate = true;
      inst.name = `army-${faction}`;
      this.group.add(inst);
      this.instances.push(inst);
    }
  }

  /** 战马群（北方牧场）+ 山鹿（林区），InstancedMesh 各 1 个 draw call */
  buildWildlife() {
    const dummy = new THREE.Object3D();
    const isMobile = this.quality.populationIndex === 1;
    const horseCount = isMobile ? 18 : 52;
    const deerCount = isMobile ? 20 : 64;

    const hb = new Builder();
    hb.at(0, 0, 0, 0, 1);
    addHorse(hb, 0xffffff, 0xffffff, true);
    // 用顶点色做基础，实例颜色再乘出不同毛色
    const horseGeo = mergeGeometries(hb.all(), false);
    hb.all().forEach((g) => g.dispose());
    const horseMat = this.material('horse');
    const horses = new THREE.InstancedMesh(horseGeo, horseMat, horseCount);
    horses.castShadow = true;
    const coats = [0x6b4a30, 0x352a22, 0xb9a17c, 0x8a6241, 0x4a3a2c, 0xd8cbb0];
    const pastures = [
      [103.5, 38.2], [106.7, 40.4], [115.2, 40.2], [108.0, 36.8], [112.4, 38.4], [104.4, 32.2],
    ];
    for (let i = 0; i < horseCount; i++) {
      const [lo, la] = pastures[i % pastures.length];
      const p = lonLatToWorld(lo + (Math.random() - 0.5) * 3.2, la + (Math.random() - 0.5) * 2.2);
      dummy.position.set(p.x, heightAt(p.x, p.z), p.z);
      dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
      dummy.scale.setScalar(0.86 + Math.random() * 0.28);
      dummy.updateMatrix();
      horses.setMatrixAt(i, dummy.matrix);
      horses.setColorAt(i, new THREE.Color(coats[i % coats.length]));
    }
    horses.instanceMatrix.needsUpdate = true;
    if (horses.instanceColor) horses.instanceColor.needsUpdate = true;
    horses.name = 'wild-horses';
    this.group.add(horses);
    this.instances.push(horses);

    const db = new Builder();
    db.at(0, 0, 0, 0, 1);
    addDeer(db, 0xffffff);
    const deerGeo = mergeGeometries(db.all(), false);
    db.all().forEach((g) => g.dispose());
    const deer = new THREE.InstancedMesh(deerGeo, this.material('horse'), deerCount);
    deer.castShadow = true;
    const woods = [[110.0, 31.8], [105.0, 29.5], [117.8, 27.4], [112.2, 26.3], [115.6, 32.0]];
    for (let i = 0; i < deerCount; i++) {
      const [lo, la] = woods[i % woods.length];
      const p = lonLatToWorld(lo + (Math.random() - 0.5) * 4.0, la + (Math.random() - 0.5) * 3.0);
      dummy.position.set(p.x, heightAt(p.x, p.z), p.z);
      dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
      dummy.scale.setScalar(0.8 + Math.random() * 0.4);
      dummy.updateMatrix();
      deer.setMatrixAt(i, dummy.matrix);
      deer.setColorAt(i, new THREE.Color(0x9a7850));
    }
    deer.instanceMatrix.needsUpdate = true;
    if (deer.instanceColor) deer.instanceColor.needsUpdate = true;
    deer.name = 'wild-deer';
    this.group.add(deer);
    this.instances.push(deer);

    // 牧场 / 兽群也可点选查看
    const pc = lonLatToWorld(103.5, 38.2);
    this.picker.addProxy(pc.x, heightAt(pc.x, pc.z) + 2, pc.z, [90, 8, 55], {
      type: 'animal', name: '河西牧场', faction: '魏',
      desc: '凉州、并州、幽州边郡所产良马，为汉末骑战之本。',
      x: pc.x, y: heightAt(pc.x, pc.z), z: pc.z,
    });
  }

  update(dt, env) {
    this.animTime.value += dt;
  }
}
