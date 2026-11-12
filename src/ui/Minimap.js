/**
 * 州郡全图（小地图）
 * 复用地形版图贴图缩略图，叠加城池、势力、当前镜头视野框与选中点。
 * 点击小地图可直接把镜头移师到该处，桌面与触屏通用。
 */
import { CONFIG, FACTIONS } from '../config.js';
import { CITIES } from '../data/map.js';
import { MAP_W, MAP_H, lonLatToWorld } from '../world/geo.js';

export class Minimap {
  constructor(canvas, terrain, camera, rig, handlers) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.camera = camera;
    this.rig = rig;
    this.handlers = handlers;
    this.W = canvas.width, this.H = canvas.height;
    this.pad = 8;
    this.innerW = this.W - this.pad * 2;
    this.innerH = this.H - this.pad * 2;
    this.selected = null;

    // 一次性把 2048 版图缩到小地图尺寸，避免每帧缩放巨型 canvas
    this.base = document.createElement('canvas');
    this.base.width = this.innerW; this.base.height = this.innerH;
    this.base.getContext('2d').drawImage(terrain.thumbnail, 0, 0, this.innerW, this.innerH);

    canvas.addEventListener('pointerdown', (e) => {
      const r = canvas.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width * this.W - this.pad;
      const y = (e.clientY - r.top) / r.height * this.H - this.pad;
      const wx = (x / this.innerW - 0.5) * MAP_W;
      const wz = (y / this.innerH - 0.5) * MAP_H;
      handlers.focus(wx, wz);
    });
  }

  w2m(x, z) {
    return [this.pad + (x / MAP_W + 0.5) * this.innerW,
      this.pad + (z / MAP_H + 0.5) * this.innerH];
  }

  setSelected(info) { this.selected = info; }

  update() {
    const ctx = this.ctx, W = this.W, H = this.H;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#17140f'; ctx.fillRect(0, 0, W, H);
    ctx.drawImage(this.base, this.pad, this.pad);
    ctx.save();
    ctx.beginPath(); ctx.rect(this.pad, this.pad, this.innerW, this.innerH); ctx.clip();

    // 城池
    for (const c of CITIES) {
      const p = lonLatToWorld(c.lon, c.lat);
      const [mx, my] = this.w2m(p.x, p.z);
      const f = FACTIONS[c.faction];
      ctx.beginPath();
      ctx.arc(mx, my, c.tier === 1 ? 3.4 : c.tier === 2 ? 2.5 : 1.7, 0, Math.PI * 2);
      ctx.fillStyle = `#${f.color.toString(16).padStart(6, '0')}`;
      ctx.fill();
      if (c.tier === 1) {
        ctx.strokeStyle = '#e8cd93'; ctx.lineWidth = 1; ctx.stroke();
      }
    }

    // 当前视野框（按镜头焦距估算地面覆盖范围）
    const t = this.rig.controls.target;
    const dist = this.camera.position.distanceTo(t);
    const half = Math.min(MAP_W * 0.55, dist * Math.tan(this.camera.fov * Math.PI / 360) * 1.15);
    const dx = this.camera.position.x - t.x, dz = this.camera.position.z - t.z;
    const ang = Math.atan2(dz, dx);
    const corners = [[-half, -half * 0.72], [half, -half * 0.72], [half, half * 0.72], [-half, half * 0.72]];
    const rot = corners.map(([a, b]) => {
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const rx = a * ca - b * sa, rz = a * sa + b * ca;
      return this.w2m(t.x + rx, t.z + rz);
    });
    ctx.beginPath();
    rot.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    ctx.closePath();
    ctx.fillStyle = 'rgba(232,205,147,0.10)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(240,214,154,0.85)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // 选中点
    if (this.selected && this.selected.x !== undefined) {
      const [sx, sy] = this.w2m(this.selected.x, this.selected.z);
      ctx.beginPath(); ctx.arc(sx, sy, 5, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffdf9c'; ctx.lineWidth = 1.4; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(sx - 9, sy); ctx.lineTo(sx + 9, sy);
      ctx.moveTo(sx, sy - 9); ctx.lineTo(sx, sy + 9);
      ctx.strokeStyle = 'rgba(255,223,156,.6)'; ctx.lineWidth = 0.8; ctx.stroke();
    }
    ctx.restore();

    // 外框
    ctx.strokeStyle = 'rgba(201,168,106,.4)';
    ctx.lineWidth = 1;
    ctx.strokeRect(this.pad + .5, this.pad + .5, this.innerW - 1, this.innerH - 1);
  }
}
