/**
 * 城池系统：汉末夯土砖城 + 庑殿顶门楼 + 角楼 + 垛口 + 势力旌旗
 * ---------------------------------------------------------------------------
 * 全图约 50 座城池，按材质合并为 5 个 Mesh（砖 / 瓦 / 木 / 石 / 灯），
 * 旌旗按势力合并为 4 个 Mesh 并在 GPU 顶点着色器里迎风摆动 —— 总 draw call
 * 维持在个位数。每座城另有不可见代理盒用于点选。
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG, FACTIONS } from '../config.js';
import { CITIES } from '../data/map.js';
import { lonLatToWorld, heightAt, slopeAt } from './geo.js';
import { makeBrick, makeRoofTile, makeStone, makeTimber } from '../utils/textures.js';
import { ASSET_MANIFEST, loadOptionalTexture } from '../data/assets.js';

/* ---------------------------- 几何构造小工具 ---------------------------- */

/**
 * 顶点色伪 AO（参考 fable52-fps-repro/03-models 的 Kit.shade）
 * 每个建筑部件底部略暗、顶部略亮，并按部件类别给整体明度差。
 * 零 GPU 开销，却能让「很多相同材质的小方块」立刻有体积与前后层次。
 */
function withShade(geo, base) {
  const p = geo.attributes.position;
  const n = p.count;
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const y = p.getY(i);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const span = Math.max(0.001, maxY - minY);
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = (p.getY(i) - minY) / span;
    const v = base * (0.86 + 0.14 * t);
    col[i * 3] = v; col[i * 3 + 1] = v * 0.992; col[i * 3 + 2] = v * 0.972;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

function box(w, h, d, x, y, z, ry = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return g;
}

/** 庑殿顶（四坡 + 起翘檐角），非低多边形棱锥，带可平铺青瓦 UV */
function hipRoof(w, d, h, x, y, z, ry = 0) {
  const hw = w / 2, hd = d / 2, rl = w * 0.27, lift = h * 0.16;
  const A = [-hw, lift, -hd], B = [hw, lift, -hd], C = [hw, lift, hd], D = [-hw, lift, hd];
  const R1 = [-rl, h, 0], R2 = [rl, h, 0];
  // 檐口中点略低，让四角自然上翘
  const Mf = [0, 0, -hd], Mb = [0, 0, hd], Ml = [-hw, 0, 0], Mr = [hw, 0, 0];
  const tris = [
    [A, Mf, R1], [Mf, B, R1], [B, Mf, R2], [Mf, R1, R2],
    [C, Mb, R2], [Mb, D, R2], [D, Mb, R1], [Mb, R2, R1],
    [D, Ml, R1], [Ml, A, R1],
    [B, Mr, R2], [Mr, C, R2],
  ];
  const pos = [], uv = [];
  for (const t of tris) {
    for (const p of t) {
      pos.push(p[0], p[1], p[2]);
      uv.push((p[0] + hw) / 4.2, (p[2] + hd) / 4.2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return g;
}

/** 势力旌旗贴图：绢帛底 + 竖排大字 + 织纹磨损 */
function bannerTexture(faction) {
  const F = FACTIONS[faction];
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 192;
  const ctx = cv.getContext('2d');
  const base = `#${F.color.toString(16).padStart(6, '0')}`;
  const deep = `#${F.deep.toString(16).padStart(6, '0')}`;
  const g = ctx.createLinearGradient(0, 0, 128, 192);
  g.addColorStop(0, base); g.addColorStop(0.55, deep); g.addColorStop(1, base);
  ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 192);
  ctx.strokeStyle = 'rgba(238,214,158,0.85)'; ctx.lineWidth = 3;
  ctx.strokeRect(6, 6, 116, 180);
  ctx.strokeStyle = 'rgba(238,214,158,0.35)'; ctx.lineWidth = 1;
  ctx.strokeRect(12, 12, 104, 168);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#f3e2b6';
  ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 6;
  ctx.font = 'bold 76px "Songti SC", "STSong", "SimSun", serif';
  ctx.fillText(faction, 64, 92);
  ctx.shadowBlur = 0;
  ctx.font = '18px "Songti SC", "STSong", serif';
  ctx.fillStyle = 'rgba(238,222,184,0.8)';
  ctx.fillText('漢', 64, 158);
  // 布面磨损 / 纤维
  for (let i = 0; i < 700; i++) {
    ctx.fillStyle = `rgba(${Math.random() > 0.5 ? '255,240,210' : '20,16,12'},${Math.random() * 0.09})`;
    ctx.fillRect(Math.random() * 128, Math.random() * 192, 1, 1 + Math.random() * 3);
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Cities {
  constructor(scene, picker, quality) {
    this.scene = scene;
    this.picker = picker;
    this.quality = quality;
    this.group = new THREE.Group();
    this.group.name = 'cities';
    scene.add(this.group);
    this.flagTime = { value: 0 };
    this.lanternMat = null;
    this.positions = [];
    this.build();
  }

  build() {
    const brick = makeBrick();
    const roofTile = makeRoofTile();
    const stone = makeStone(256);
    const timber = makeTimber();
    // ORM 三图：同一张线性贴图同时驱动 AO / roughness / metalness
    // （R=烘焙 AO，缝隙更暗；G=逐像素粗糙度，砖面与灰缝高光不同；B=金属度）
    const orm = (tex, intensity = 0.7) => ({
      aoMap: tex, roughnessMap: tex, metalnessMap: tex,
      aoMapIntensity: intensity, roughness: 1.0, metalness: 1.0,
    });
    const mats = {
      brick: new THREE.MeshStandardMaterial({
        map: brick.map, normalMap: brick.normalMap, color: 0xb9a98c,
        vertexColors: true, ...orm(brick.orm, 0.8),
      }),
      roof: new THREE.MeshStandardMaterial({
        map: roofTile.map, color: 0x9aa2a6,
        vertexColors: true, ...orm(roofTile.orm, 0.7),
        side: THREE.DoubleSide,
      }),
      wood: new THREE.MeshStandardMaterial({
        map: timber.map, normalMap: timber.normalMap,
        ...orm(timber.orm, 0.65), vertexColors: true,
      }),
      stone: new THREE.MeshStandardMaterial({
        map: stone.map, normalMap: stone.normalMap, color: 0x8c8272,
        vertexColors: true, ...orm(stone.orm, 0.7),
      }),
      // HDR 灯火：夜间 emissiveIntensity > 1，配合阈值 1.0 的泛光才形成真实光晕；
      // 白天归零，不会把整张地图提亮。
      lantern: new THREE.MeshStandardMaterial({
        color: 0xffc46a, emissive: 0xff8a34, emissiveIntensity: 0.0,
        roughness: 0.5, vertexColors: true,
      }),
    };
    this.lanternMat = mats.lantern;
    loadOptionalTexture(ASSET_MANIFEST.roofTile, { srgb: true, repeat: [2, 2] },
      (t) => { mats.roof.map = t; mats.roof.needsUpdate = true; });
    const parts = { brick: [], roof: [], wood: [], stone: [], lantern: [] };
    const flags = { 魏: [], 蜀: [], 吴: [], 群: [] };

    for (const city of CITIES) {
      const p = lonLatToWorld(city.lon, city.lat);
      const gy = heightAt(p.x, p.z);
      const slope = slopeAt(p.x, p.z);
      const y = gy + 0.35 + Math.min(1.4, slope * 3.0); // 略微垫高，避免坡地穿模
      const s = [0.72, 1.5, 1.24, 1.0][city.tier] ?? 0.8;
      const w = 12.6 * s, half = w / 2;
      const wallH = 3.15 * s, wallT = 0.95 * s;
      this.positions.push({ ...city, x: p.x, y, z: p.z });

      // 台基
      parts.stone.push(box(w + 2.0 * s, 1.05 * s, w + 2.0 * s, p.x, y - 0.25 * s, p.z));
      // 四面城墙（南面正中留门洞）
      const addWall = (cx, cz, ww, dd, ry) => {
        parts.brick.push(box(ww, wallH, dd, p.x + cx, y + wallH / 2, p.z + cz, ry));
      };
      addWall(0, -half, w, wallT, 0); // 北
      // 南墙分两段，中间留 2.4*s 的门
      const gateW = 2.6 * s, seg = (w - gateW) / 2;
      addWall(-(gateW + seg) / 2, half, seg, wallT, 0);
      addWall((gateW + seg) / 2, half, seg, wallT, 0);
      addWall(-half, 0, w, wallT, Math.PI / 2); // 西
      addWall(half, 0, w, wallT, Math.PI / 2);  // 东
      // 门洞上方横梁 + 朱漆门扇
      parts.wood.push(box(gateW, wallH * 0.62, wallT * 1.1, p.x, y + wallH * 0.31, p.z + half));
      parts.brick.push(box(gateW + 0.9 * s, 0.55 * s, wallT * 1.25, p.x, y + wallH * 0.78, p.z + half));

      // 垛口：沿四墙均匀排列
      const crenel = 0.62 * s, gap = crenel * 1.9;
      const addCrenels = (cx, cz, along, ry) => {
        const n = Math.floor(along / gap);
        for (let i = 0; i < n; i++) {
          const t = -along / 2 + (i + 0.5) * along / n;
          const gx = cx + (ry ? 0 : t), gz = cz + (ry ? t : 0);
          parts.brick.push(box(crenel, 0.72 * s, wallT * 1.25,
            p.x + gx, y + wallH + 0.36 * s, p.z + gz, ry));
        }
      };
      addCrenels(0, -half, w, 0); addCrenels(0, half, w, 0);
      addCrenels(-half, 0, w, Math.PI / 2); addCrenels(half, 0, w, Math.PI / 2);

      // 四角角楼
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const cx = p.x + sx * half, cz = p.z + sz * half;
        parts.brick.push(box(2.5 * s, wallH * 1.45, 2.5 * s, cx, y + wallH * 0.72, cz));
        parts.roof.push(hipRoof(3.5 * s, 3.5 * s, 1.5 * s, cx, y + wallH * 1.45, cz));
        parts.lantern.push(box(0.42 * s, 0.42 * s, 0.42 * s, cx, y + wallH * 1.1, cz + 1.3 * s));
      }

      // 南门城楼（重檐意象：下层大屋顶 + 上层小阁）
      const gy2 = y + wallH;
      parts.wood.push(box(gateW * 2.1, 1.9 * s, 2.5 * s, p.x, gy2 + 1.0 * s, p.z + half));
      parts.roof.push(hipRoof(gateW * 2.9, 4.2 * s, 1.55 * s, p.x, gy2 + 1.9 * s, p.z + half));
      if (city.tier <= 2) {
        parts.wood.push(box(gateW * 1.1, 1.2 * s, 1.7 * s, p.x, gy2 + 3.0 * s, p.z + half));
        parts.roof.push(hipRoof(gateW * 1.8, 2.8 * s, 1.1 * s, p.x, gy2 + 3.6 * s, p.z + half));
      }

      // 城内院落：中轴正殿 + 两侧厢房
      const houseCount = city.tier === 1 ? 7 : city.tier === 2 ? 5 : 3;
      for (let i = 0; i < houseCount; i++) {
        const row = Math.floor(i / 3), col = i % 3;
        const hx = p.x + (col - 1) * 3.1 * s + (row % 2 ? 0.6 * s : 0);
        const hz = p.z - 2.3 * s + row * 2.8 * s;
        if (Math.abs(hz - p.z) > half - 1.2 * s) continue;
        const hw = (i === 1 ? 3.5 : 2.3) * s, hd = 2.0 * s, hh = (i === 1 ? 2.1 : 1.45) * s;
        parts.brick.push(box(hw, hh, hd, hx, y + hh / 2 + 0.4 * s, hz));
        parts.roof.push(hipRoof(hw * 1.32, hd * 1.55, 0.95 * s, hx, y + hh + 0.4 * s, hz));
        parts.lantern.push(box(0.3 * s, 0.3 * s, 0.3 * s, hx, y + hh * 0.55, hz + hd / 2 + 0.05));
      }
      // 主要都城额外加高台与华表
      if (city.tier === 1) {
        parts.stone.push(box(5.6 * s, 0.9 * s, 4.2 * s, p.x, y + 0.4 * s, p.z - 3.4 * s));
        for (const sx of [-1, 1]) {
          parts.stone.push(box(0.42 * s, 3.4 * s, 0.42 * s, p.x + sx * 3.4 * s, y + 1.7 * s, p.z + half - 0.6 * s));
        }
      }

      // 旗杆与旌旗（每个势力单独合批）
      const poleH = (6.6 + city.tier * 0.5) * s;
      const poleX = p.x + half - 0.4 * s, poleZ = p.z - half + 0.4 * s;
      parts.wood.push(box(0.16 * s, poleH, 0.16 * s, poleX, y + poleH / 2, poleZ));
      for (let k = 0; k < (city.tier <= 2 ? 2 : 1); k++) {
        const fw = 2.5 * s, fh = 3.4 * s;
        const fg = new THREE.PlaneGeometry(fw, fh, 8, 5);
        fg.translate(fw / 2, 0, 0); // 左缘贴旗杆
        const uv = fg.attributes.uv;
        const arr = new Float32Array(uv.count * 2);
        const phase = Math.random() * Math.PI * 2;
        for (let vi = 0; vi < uv.count; vi++) {
          arr[vi * 2] = uv.getX(vi);
          arr[vi * 2 + 1] = phase;
        }
        fg.setAttribute('aFlag', new THREE.BufferAttribute(arr, 2));
        fg.rotateY(Math.PI * 0.25 + k * 0.35);
        fg.translate(poleX, y + poleH - 0.8 * s - k * 2.0 * s, poleZ);
        flags[city.faction].push(fg);
      }

      // 点选代理盒（不可见但不参与渲染）
      this.picker.addProxy(p.x, y + wallH * 0.7, p.z,
        [w + 3 * s, wallH * 2.4 + poleH, w + 3 * s],
        { type: 'city', city, x: p.x, y, z: p.z });
    }

    // 按材质合批，并写入顶点色伪 AO
    const SHADE = { brick: 0.95, roof: 1.0, wood: 0.76, stone: 0.84, lantern: 1.0 };
    for (const [key, list] of Object.entries(parts)) {
      if (!list.length) continue;
      const shaded = list.map((g) => withShade(g, SHADE[key] ?? 1));
      const merged = mergeGeometries(shaded, false);
      if (!merged) { console.warn('[Cities] 合批失败:', key); continue; }
      const mesh = new THREE.Mesh(merged, mats[key]);
      mesh.castShadow = key !== 'lantern';
      mesh.receiveShadow = true;
      mesh.name = `city-${key}`;
      this.group.add(mesh);
      list.forEach((g) => g.dispose());
    }

    // 旌旗：四势力各一个 Mesh，GPU 顶点摆动
    for (const [faction, list] of Object.entries(flags)) {
      if (!list.length) continue;
      const geo = mergeGeometries(list, false);
      const mat = new THREE.MeshStandardMaterial({
        map: bannerTexture(faction), color: 0xffffff,
        roughness: 0.88, metalness: 0.0, side: THREE.DoubleSide,
      });
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uFlagTime = this.flagTime;
        shader.vertexShader = `
          attribute vec2 aFlag;
          uniform float uFlagTime;
        ` + shader.vertexShader.replace('#include <begin_vertex>', `
          #include <begin_vertex>
          float ff = aFlag.x;
          transformed.z += sin(uFlagTime * 2.7 + aFlag.y + ff * 6.2) * 0.62 * ff;
          transformed.y += sin(uFlagTime * 3.3 + aFlag.y + ff * 4.4) * 0.18 * ff;
        `);
      };
      mat.customProgramCacheKey = () => 'waving-banner-v1';
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `banners-${faction}`;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      list.forEach((g) => g.dispose());
    }
  }

  update(dt, env) {
    this.flagTime.value += dt;
    if (this.lanternMat) {
      // HDR 超亮灯火（>1）才会穿过 threshold=1.0 的泛光阈值
      const target = env.night > 0.35 ? 7.2 * env.night : 0;
      this.lanternMat.emissiveIntensity += (target - this.lanternMat.emissiveIntensity) * Math.min(1, dt * 2.2);
    }
  }
}
