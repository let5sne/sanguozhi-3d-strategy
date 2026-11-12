/**
 * 策略地图镜头控制
 * ---------------------------------------------------------------------------
 * 基于 OrbitControls，限制为"俯视沙盘"视角：可绕目标旋转、滚轮/双指缩放、
 * 右键/双指平移，带阻尼；支持键盘、平滑飞行到城池、重置视角。
 * 桌面与移动端手势一致，且不会把镜头翻到地平线以下导致版图变形。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CONFIG } from '../config.js';
import { MAP_W, MAP_H } from '../world/geo.js';

export class CameraRig {
  constructor(camera, dom, quality) {
    this.camera = camera;
    const C = CONFIG.camera;
    camera.position.set(C.start.x, C.start.y, C.start.z);
    this.controls = new OrbitControls(camera, dom);
    const o = this.controls;
    o.target.set(C.target.x, C.target.y, C.target.z);
    o.enableDamping = true;
    o.dampingFactor = C.damping;
    o.minDistance = C.minDistance;
    o.maxDistance = C.maxDistance;
    o.minPolarAngle = C.minPolar;
    o.maxPolarAngle = C.maxPolar;
    o.screenSpacePanning = false;      // 平移始终沿地面，符合看地图的直觉
    o.panSpeed = 0.85;
    o.rotateSpeed = 0.62;
    o.zoomSpeed = 0.95;
    o.enablePan = true;
    o.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN,
    };
    o.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    o.update();

    this.keys = new Set();
    this.flight = null;
    this.isMobile = quality.isMobile;
    this._bindKeys();
  }

  _bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
      this.keys.add(e.key.toLowerCase());
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** 平滑飞行到某城池 / 区域 */
  flyTo(x, z, distance = 130, duration = 1.1) {
    const target = new THREE.Vector3(x, 0, z);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    // 保持当前俯角与方位，只改变焦点与距离
    const dest = target.clone().add(dir.multiplyScalar(distance));
    this.flight = {
      t: 0, duration,
      fromPos: this.camera.position.clone(), toPos: dest,
      fromTgt: this.controls.target.clone(), toTgt: target,
    };
  }

  reset() {
    const C = CONFIG.camera;
    this.flight = {
      t: 0, duration: 1.0,
      fromPos: this.camera.position.clone(),
      toPos: new THREE.Vector3(C.start.x, C.start.y, C.start.z),
      fromTgt: this.controls.target.clone(),
      toTgt: new THREE.Vector3(C.target.x, C.target.y, C.target.z),
    };
  }

  /** 限制焦点不越出版图，避免镜头飞到虚空 */
  clampTarget() {
    const t = this.controls.target;
    t.x = THREE.MathUtils.clamp(t.x, -MAP_W * 0.55, MAP_W * 0.55);
    t.z = THREE.MathUtils.clamp(t.z, -MAP_H * 0.55, MAP_H * 0.55);
    t.y = THREE.MathUtils.clamp(t.y, -8, 60);
  }

  update(dt) {
    const o = this.controls;
    if (this.flight) {
      const f = this.flight;
      f.t += dt / f.duration;
      const k = THREE.MathUtils.smoothstep(Math.min(1, f.t), 0, 1);
      this.camera.position.lerpVectors(f.fromPos, f.toPos, k);
      o.target.lerpVectors(f.fromTgt, f.toTgt, k);
      if (f.t >= 1) this.flight = null;
    } else if (this.keys.size) {
      const speed = (o.getDistance() * 0.75 + 30) * dt;
      const fwd = new THREE.Vector3().subVectors(o.target, this.camera.position).setY(0).normalize();
      const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      const move = new THREE.Vector3();
      if (this.keys.has('w') || this.keys.has('arrowup')) move.add(fwd);
      if (this.keys.has('s') || this.keys.has('arrowdown')) move.sub(fwd);
      if (this.keys.has('d') || this.keys.has('arrowright')) move.add(right);
      if (this.keys.has('a') || this.keys.has('arrowleft')) move.sub(right);
      const Y = new THREE.Vector3(0, 1, 0);
      if (this.keys.has('q')) this.camera.position.sub(o.target).applyAxisAngle(Y, -dt * 0.5).add(o.target);
      if (this.keys.has('e')) this.camera.position.sub(o.target).applyAxisAngle(Y, dt * 0.5).add(o.target);
      if (move.lengthSq() > 0) {
        move.normalize().multiplyScalar(speed);
        this.camera.position.add(move);
        o.target.add(move);
      }
    }
    this.clampTarget();
    o.update();
  }
}
