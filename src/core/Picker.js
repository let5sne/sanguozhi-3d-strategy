/**
 * 点选系统：城池 / 武将 / 军团 / 州郡区域
 * ---------------------------------------------------------------------------
 * 每个可选对象挂一个"不可见但可被射线命中"的代理盒（material.visible=false，
 * 不产生 draw call）。区域点选则直接对地形做射线检测后反算经纬度。
 * 拖拽超过阈值视为镜头操作，不误触选中；桌面与触屏统一用 Pointer Events。
 */
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { provinceAt, factionAt, worldToLonLat, heightAt } from '../world/geo.js';
import { CITIES } from '../data/map.js';
import { makeSoftDot } from '../utils/textures.js';

const invisible = new THREE.MeshBasicMaterial({ visible: false });

export class Picker {
  constructor(camera, dom, scene, terrain) {
    this.camera = camera;
    this.dom = dom;
    this.scene = scene;
    this.terrain = terrain;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.picks = [terrain.mesh];
    this.onSelect = () => {};
    this.selected = null;
    this.down = null;
    this.lastHover = 0;

    this.buildHighlight();
    dom.addEventListener('pointerdown', (e) => this.pointerDown(e));
    dom.addEventListener('pointerup', (e) => this.pointerUp(e));
    dom.addEventListener('pointercancel', () => { this.down = null; });
    dom.addEventListener('pointermove', (e) => this.hover(e));
  }

  /** 注册一个可选代理盒 */
  addProxy(x, y, z, size, info) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), invisible);
    m.position.set(x, y, z);
    m.userData.pickInfo = info;
    this.scene.add(m);
    this.picks.push(m);
    return m;
  }

  buildHighlight() {
    const g = new THREE.Group();
    g.visible = false;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(8.4, 9.2, 64),
      new THREE.MeshBasicMaterial({ color: 0xf3d38c, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false, fog: false })
    );
    ring.rotation.x = -Math.PI / 2;
    const ring2 = new THREE.Mesh(
      new THREE.RingGeometry(11.0, 11.25, 64, 1, 0, Math.PI * 1.55),
      new THREE.MeshBasicMaterial({ color: 0xf3d38c, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, fog: false })
    );
    ring2.rotation.x = -Math.PI / 2;
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeSoftDot(), color: 0xffdf9c, transparent: true,
      opacity: 0.28, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    }));
    glow.scale.set(34, 34, 1);
    glow.position.y = 2;
    g.add(ring, ring2, glow);
    g.renderOrder = 20;
    this.scene.add(g);
    this.highlight = g;
    this.highlightRing = ring2;
  }

  setPointer(e) {
    const r = this.dom.getBoundingClientRect();
    this.pointer.set(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1
    );
  }

  pointerDown(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    this.down = { x: e.clientX, y: e.clientY, t: performance.now() };
  }

  pointerUp(e) {
    if (!this.down) return;
    const d = Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y);
    const elapsed = performance.now() - this.down.t;
    this.down = null;
    if (d > CONFIG.interaction.pickTolerancePx || elapsed > 700) return; // 拖拽 / 长按手势
    this.setPointer(e);
    const info = this.cast();
    if (info) this.select(info);
  }

  hover(e) {
    if (e.pointerType === 'touch') return;
    const now = performance.now();
    if (now - this.lastHover < 90) return;
    this.lastHover = now;
    this.setPointer(e);
    const hits = this.raycaster.intersectObjects(this.picks, false);
    this.dom.style.cursor = hits.length ? 'pointer' : 'grab';
  }

  /** 返回被选中对象的信息；地形命中则解析为州郡 / 势力 / 最近城池 */
  cast() {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.picks, false);
    if (!hits.length) return null;
    for (const h of hits) {
      const info = h.object.userData.pickInfo;
      if (info) return { ...info, point: h.point.clone() };
      if (h.object === this.terrain.mesh) {
        const { lon, lat } = worldToLonLat(h.point.x, h.point.z);
        const province = provinceAt(lon, lat);
        const f = factionAt(lon, lat);
        let nearest = null, nd = 1e9;
        for (const c of CITIES) {
          const d = Math.hypot((c.lon - lon) * 0.86, c.lat - lat);
          if (d < nd) { nd = d; nearest = c; }
        }
        return {
          type: 'region', name: province ? province.name : '域外',
          province: province ? province.name : '化外之地',
          seat: province ? province.seat : '—',
          desc: province ? province.desc : '汉末版图之外的山川。',
          faction: f.faction, nearest, nd,
          lon, lat, point: h.point.clone(),
        };
      }
    }
    return null;
  }

  select(info) {
    this.selected = info;
    const p = info.point || new THREE.Vector3(0, 0, 0);
    const y = heightAt(p.x, p.z);
    this.highlight.position.set(p.x, y + 1.2, p.z);
    this.highlight.visible = true;
    const scale = info.type === 'region' ? 0.7 : 1.0;
    this.highlight.scale.setScalar(scale);
    this.onSelect(info);
  }

  clear() {
    this.selected = null;
    this.highlight.visible = false;
  }

  update(dt, t) {
    if (!this.highlight.visible) return;
    this.highlightRing.rotation.z += dt * 0.55;
    const pulse = 0.82 + Math.sin(t * 2.4) * 0.16;
    this.highlight.children[0].material.opacity = pulse;
    this.highlight.children[2].material.opacity = 0.20 + Math.sin(t * 1.7) * 0.08;
  }
}
