/**
 * 古风 HUD：势力图例、时辰 / 四季 / 天气控制、信息志、城池名签、帧率
 * ---------------------------------------------------------------------------
 * 名签用 HTML 覆盖层（而非 3D 文字）：任何缩放级别都清晰锐利，且天然参与
 * 无障碍与点击。每帧做投影 + 网格占位去重，避免标签互相堆叠影响版图可读性。
 */
import * as THREE from 'three';
import { CONFIG, FACTIONS, SEASONS, WEATHER } from '../config.js';
import { CITIES } from '../data/map.js';
import { FACTION_LORE } from '../data/generals.js';
import { lonLatToWorld, heightAt } from '../world/geo.js';

const SHICHEN = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
const num = (n) => n.toLocaleString('zh-CN');
const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;

export class HUD {
  constructor(opts) {
    this.state = opts.state;
    this.handlers = opts.handlers;
    this.refs = opts.refs;
    this.labels = [];
    this._tmp = new THREE.Vector3();
    this._frames = 0; this._fpsTime = 0; this._fps = 60;
    this.buildControls();
    this.buildLegend();
    this.buildLabels();
    this.setInfo(null);
    this.bindGlobalHint();
  }

  /* ------------------------------ 载入遮罩 ------------------------------ */
  setLoading(pct, text) {
    const bar = document.getElementById('loading-progress');
    const st = document.getElementById('loading-status');
    if (bar) bar.style.width = `${Math.round(pct)}%`;
    if (st && text) st.textContent = text;
  }
  hideLoading() {
    const el = document.getElementById('loading');
    if (el) { el.classList.add('hidden'); setTimeout(() => el.remove(), 1100); }
  }

  /* ------------------------------ 控件构建 ------------------------------ */
  buildControls() {
    const S = this.state;
    const seasonBox = document.getElementById('season-btns');
    Object.keys(SEASONS).forEach((s) => {
      const b = document.createElement('button');
      b.className = 'ctl-btn' + (S.season === s ? ' active' : '');
      b.textContent = s; b.dataset.key = s;
      b.title = SEASONS[s].label;
      b.onclick = () => this.handlers.season(s);
      seasonBox.appendChild(b);
    });
    const weatherBox = document.getElementById('weather-btns');
    Object.keys(WEATHER).forEach((w) => {
      const b = document.createElement('button');
      b.className = 'ctl-btn' + (S.weather === w ? ' active' : '');
      b.textContent = w; b.dataset.key = w;
      b.title = WEATHER[w].label;
      b.onclick = () => this.handlers.weather(w);
      weatherBox.appendChild(b);
    });
    const slider = document.getElementById('hour-slider');
    slider.addEventListener('input', () => {
      this.handlers.hour(parseFloat(slider.value));
      this.handlers.auto(false);
    });
    this.slider = slider;

    this.qualityBtn = document.getElementById('quality-btn');
    this.qualityBtn.onclick = () => this.handlers.quality();
    this.autoBtn = document.getElementById('auto-btn');
    this.autoBtn.onclick = () => this.handlers.auto(!S.autoDay);
    this.labelBtn = document.getElementById('label-btn');
    this.labelBtn.onclick = () => this.handlers.labels();
    document.getElementById('reset-btn').onclick = () => this.handlers.reset();
    document.getElementById('info-close').onclick = () => {
      document.getElementById('info-panel').classList.toggle('collapsed');
    };
    this.setQualityLabel(CONFIG.post[S.tier] ? S.tier : 'high');
    this.setAutoToggle(S.autoDay);
    this.setLabelToggle(S.showLabels);
  }

  syncButtons() {
    document.querySelectorAll('#season-btns .ctl-btn').forEach((b) => b.classList.toggle('active', b.dataset.key === this.state.season));
    document.querySelectorAll('#weather-btns .ctl-btn').forEach((b) => b.classList.toggle('active', b.dataset.key === this.state.weather));
  }
  setQualityLabel(tier) {
    const map = { high: '高', medium: '中', low: '省' };
    this.qualityBtn.textContent = map[tier] || '高';
    this.qualityBtn.title = `画质：${map[tier] || tier}（点击切换）`;
  }
  setAutoToggle(on) { this.autoBtn.classList.toggle('toggled', on); }
  setLabelToggle(on) { this.labelBtn.classList.toggle('toggled', on); }

  buildLegend() {
    const box = document.getElementById('faction-legend');
    box.innerHTML = Object.entries(FACTIONS).map(([k, f]) => {
      const n = CITIES.filter((c) => c.faction === k).length;
      return `<div class="faction-item" data-faction="${k}" style="--fc:${hex(f.color)}">
        <i class="faction-flag"></i><span class="faction-name">${f.name}</span>
        <span class="faction-meta">${n} 城</span></div>`;
    }).join('');
    box.querySelectorAll('.faction-item').forEach((el) => {
      el.onclick = () => {
        el.classList.toggle('off');
        this.handlers.factionToggle?.(el.dataset.faction, !el.classList.contains('off'));
      };
    });
  }

  /* ------------------------------ 城池名签 ------------------------------ */
  buildLabels() {
    const layer = document.getElementById('labels');
    const add = (info, text, cls) => {
      const el = document.createElement('div');
      el.className = `city-label ${cls}`;
      el.textContent = text;
      el.style.setProperty('--fc', hex(FACTIONS[info.faction]?.color || 0xc9a86a));
      el.onclick = (e) => { e.stopPropagation(); this.handlers.select(info); };
      layer.appendChild(el);
      this.labels.push({ el, info });
    };
    for (const c of this.refs.cities.positions) {
      add({ type: 'city', city: c, x: c.x, y: c.y, z: c.z, faction: c.faction },
        c.name, `tier${c.tier}`);
    }
    for (const g of this.refs.characters.generalPositions) {
      add({ type: 'general', general: g.general, x: g.x, y: g.y, z: g.z, faction: g.general.faction },
        `${g.general.name}`, 'general-label');
    }
  }

  /* ------------------------------ 信息志 ------------------------------ */
  setInfo(info) {
    const body = document.getElementById('info-body');
    if (!info) {
      body.innerHTML = `<div class="info-empty">
        <strong>汉末十三州 · 天下三分</strong><br/>
        建安之季，曹氏据中原河北，刘氏保益州汉中，孙氏有江东荆扬。
        山川形胜、州郡城邑皆具于此舆图。<br/><br/>
        单击<strong>城池</strong>可考其兵粮关隘，单击<strong>武将</strong>可阅其列传五维，
        单击<strong>山水</strong>可辨州郡归属。<br/><br/>
        底部可推演时辰、更迭四时、调动云雨；拖曳舆图以观其全。
      </div>`;
      return;
    }
    const F = info.faction ? FACTIONS[info.faction] : null;
    const color = F ? hex(F.color) : '#c9a86a';
    const badge = F ? `<span class="info-badge" style="--fc:${color}">${F.name} · ${F.lord}</span>` : '';
    let html = '';

    if (info.type === 'city') {
      const c = info.city;
      html = `<div class="info-head"><span class="info-name">${c.name}</span><span class="info-zi">${c.province}</span></div>
        ${badge}
        <div class="info-desc">${c.desc}</div>
        <div class="kv"><span>州 部</span><b>${c.province}</b></div>
        <div class="kv"><span>城 等</span><b>${['', '帝都', '州治重镇', '郡城', '关隘要地'][c.tier]}</b></div>
        <div class="kv"><span>经 纬</span><b>东经 ${c.lon.toFixed(2)}° · 北纬 ${c.lat.toFixed(2)}°</b></div>
        <div class="kv"><span>守 军</span><b>${num(c.troops)} 人</b></div>
        <div class="kv"><span>仓 谷</span><b>${num(c.grain)} 斛</b></div>
        <div class="relate">驻守要员：<b>${this.generalsIn(c.name)}</b></div>`;
    } else if (info.type === 'general') {
      const g = info.general;
      const bars = [['统', g.lead], ['武', g.force], ['智', g.intel], ['政', g.pol], ['魅', g.charm]]
        .map(([n, v]) => `<div class="bar-row"><span>${n}</span><i style="--w:${v}%"></i><b>${v}</b></div>`).join('');
      html = `<div class="info-head"><span class="info-name">${g.name}</span><span class="info-zi">字 ${g.zi}</span></div>
        ${badge}
        <div class="kv"><span>官 爵</span><b>${g.title}</b></div>
        <div class="kv"><span>屯 驻</span><b>${g.city}</b></div>
        <div class="kv"><span>部 曲</span><b>${g.unit}</b></div>
        <div class="kv"><span>坐 骑</span><b>${g.horse}</b></div>
        <div class="info-desc">${g.bio}</div>
        <div class="stat-grid">
          <div class="stat-cell"><b>${g.lead}</b><span>统率</span></div>
          <div class="stat-cell"><b>${g.intel}</b><span>智力</span></div>
          <div class="stat-cell"><b>${g.force}</b><span>武力</span></div>
        </div>${bars}`;
    } else if (info.type === 'region') {
      html = `<div class="info-head"><span class="info-name">${info.name}</span><span class="info-zi">州郡</span></div>
        ${badge}
        <div class="info-desc">${info.desc}</div>
        <div class="kv"><span>州 治</span><b>${info.seat}</b></div>
        <div class="kv"><span>经 纬</span><b>东经 ${info.lon.toFixed(2)}° · 北纬 ${info.lat.toFixed(2)}°</b></div>
        <div class="kv"><span>近 邑</span><b>${info.nearest ? info.nearest.name : '—'}</b></div>
        <div class="relate">${FACTION_LORE[info.faction] || ''}</div>`;
    } else if (info.type === 'army' || info.type === 'animal') {
      html = `<div class="info-head"><span class="info-name">${info.name}</span><span class="info-zi">${info.type === 'army' ? '军阵' : '牧苑'}</span></div>
        ${badge}
        <div class="info-desc">${info.desc || '按汉制结阵而屯，旌旗甲仗依势力而殊。'}</div>
        ${info.troops ? `<div class="kv"><span>兵 员</span><b>${num(info.troops)} 人</b></div>` : ''}
        ${info.city ? `<div class="kv"><span>隶 属</span><b>${info.city}</b></div>` : ''}
        <div class="kv"><span>经 纬</span><b>${this.coordOf(info.x, info.z)}</b></div>`;
    }
    body.innerHTML = html;
    body.scrollTop = 0;
  }

  /** 势力图例开关：暂时只影响名签可读性，不改版图着色 */
  setFactionVisible(faction, visible) {
    for (const L of this.labels) {
      if (L.info.faction === faction) L.factionHidden = !visible;
    }
  }

  generalsIn(city) {
    const list = this.refs.characters.generalPositions.filter((g) => g.general.city === city);
    return list.length ? list.map((g) => g.general.name).join('、') : '未详';
  }
  coordOf(x, z) {
    const LON0 = (CONFIG.map.lonMin + CONFIG.map.lonMax) / 2;
    const LAT0 = (CONFIG.map.latMin + CONFIG.map.latMax) / 2;
    return `东经 ${(LON0 + x / CONFIG.map.unitsPerDegree).toFixed(1)}° · 北纬 ${(LAT0 - z / CONFIG.map.unitsPerDegree).toFixed(1)}°`;
  }

  /** 每帧：时辰显示、名签投影去重、FPS */
  update(dt, env) {
    const h = env.hour;
    const hh = Math.floor(h).toString().padStart(2, '0');
    const mm = Math.floor((h % 1) * 60).toString().padStart(2, '0');
    document.getElementById('hour-value').textContent = `${hh}:${mm}`;
    const sc = SHICHEN[Math.floor(((h + 1) % 24) / 2)];
    document.getElementById('clock-label').textContent = `${sc}時 · ${this.state.weather}`;
    if (document.activeElement !== this.slider && this.state.autoDay) {
      this.slider.value = h;
    }
    document.getElementById('mini-coord').textContent = `${hh}:${mm} ${sc}時`;

    this._frames++; this._fpsTime += dt;
    if (this._fpsTime >= 0.6) {
      this._fps = Math.round(this._frames / this._fpsTime);
      this._frames = 0; this._fpsTime = 0;
      const el = document.getElementById('fps');
      if (el) el.textContent = `${this._fps} FPS · ${this.state.tier.toUpperCase()}`;
    }

    // 名签：投影 + 距离过滤 + 网格占位去重
    const cam = this.refs.camera;
    const w = window.innerWidth, hgt = window.innerHeight;
    const occupied = new Set();
    const cell = 78;
    const show = this.state.showLabels;
    let shown = 0;
    for (const L of this.labels) {
      const i = L.info;
      const dist = cam.position.distanceTo(this._tmp.set(i.x, i.y, i.z));
      const isCity = i.type === 'city';
      const limit = isCity ? (i.city.tier <= 2 ? CONFIG.interaction.labelFadeDistance : 340) : 220;
      if (!show || L.factionHidden || dist > limit || shown > 46) { L.el.classList.add('hidden'); continue; }
      const p = this._tmp.set(i.x, i.y + (isCity ? 9 : 7.5), i.z).project(cam);
      if (p.z > 1 || p.z < -1 || Math.abs(p.x) > 1.02 || Math.abs(p.y) > 1.02) {
        L.el.classList.add('hidden'); continue;
      }
      const sx = (p.x * 0.5 + 0.5) * w, sy = (-p.y * 0.5 + 0.5) * hgt;
      const key = `${Math.round(sx / cell)}:${Math.round(sy / 26)}`;
      if (occupied.has(key)) { L.el.classList.add('hidden'); continue; }
      occupied.add(key);
      L.el.classList.remove('hidden');
      L.el.style.left = `${sx}px`;
      L.el.style.top = `${sy}px`;
      shown++;
    }
  }

  bindGlobalHint() {
    const hint = document.getElementById('hint');
    const gone = () => hint.classList.add('gone');
    setTimeout(gone, 8000);
    window.addEventListener('pointerdown', gone, { once: true });
  }
}
