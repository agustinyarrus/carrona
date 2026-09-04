// ─────────────────────────────────────────────────────────────────────────────
//  main.js — Arranque: canvas, renderer, audio, HUD y el bucle.
// ─────────────────────────────────────────────────────────────────────────────

import { Renderer } from './render/renderer.js';
import { GameAudio } from './audio/audio.js';
import { Input } from './core/input.js';
import { Game } from './game/game.js';

const $ = (id) => document.getElementById(id);

// ═══ HUD / pantallas ═════════════════════════════════════════════════════════
class UI {
  constructor() {
    this.el = {
      menu: $('menu'), death: $('death'), pause: $('pause'), hud: $('hud'), announce: $('announce'),
      toast: $('toast'), perf: $('perf'), cross: $('crosshair'), loading: $('loading'),
      hpbar: $('hpbar'), hptxt: $('hptxt'), wave: $('wave'), kills: $('kills'), left: $('left'),
      weapon: $('weapon'), ammo: $('ammo'), reload: $('reload'), slots: $('slots'), flash: $('flash'),
      dstats: $('dstats'), best: $('best'), dbest: $('dbest'),
      qsel: $('q-sel'), vol: $('vol'), shake: $('shake'),
    };
    this.perfVisible = false;
    this._annT = null; this._toastT = null;
    this.onSettings = null;
    this.el.qsel.addEventListener('change', () => this.onSettings && this.onSettings({ quality: this.el.qsel.value }));
    this.el.vol.addEventListener('input', () => this.onSettings && this.onSettings({ volume: this.el.vol.value / 100 }));
    this.el.shake.addEventListener('input', () => this.onSettings && this.onSettings({ shake: this.el.shake.value / 100 }));
  }
  showMenu(best) {
    this.hideAll();
    this.el.menu.classList.add('on');
    this.el.best.textContent = best.wave ? `mejor: oleada ${best.wave} · ${best.kills} bajas` : '';
    document.body.classList.remove('ingame');
  }
  showDeath(st, best) {
    this.el.death.classList.add('on');
    const m = Math.floor(st.time / 60), s = Math.floor(st.time % 60);
    const acc = st.shots ? Math.round(st.hits / st.shots * 100) : 0;
    this.el.dstats.innerHTML =
      `<div><b>${st.wave}</b><span>oleada</span></div><div><b>${st.kills}</b><span>bajas</span></div>` +
      `<div><b>${st.headshots}</b><span>cabezas</span></div><div><b>${st.severs}</b><span>mutilaciones</span></div>` +
      `<div><b>${acc}%</b><span>puntería</span></div><div><b>${m}:${String(s).padStart(2, '0')}</b><span>tiempo</span></div>`;
    this.el.dbest.textContent = `mejor: oleada ${best.wave} · ${best.kills} bajas`;
    document.body.classList.remove('ingame');
  }
  showPause(settings) {
    this.el.pause.classList.add('on');
    this.el.qsel.value = settings.quality;
    this.el.vol.value = Math.round(settings.volume * 100);
    this.el.shake.value = Math.round(settings.shake * 100);
    document.body.classList.remove('ingame');
  }
  hidePause() { this.el.pause.classList.remove('on'); document.body.classList.add('ingame'); }
  hideAll() {
    for (const k of ['menu', 'death', 'pause']) this.el[k].classList.remove('on');
    this.el.hud.classList.add('on');
    document.body.classList.add('ingame');
  }
  announce(big, small = '') {
    const a = this.el.announce;
    a.innerHTML = `<div class="big">${big}</div><div class="small">${small}</div>`;
    a.classList.remove('show'); void a.offsetWidth; a.classList.add('show');
    clearTimeout(this._annT);
    this._annT = setTimeout(() => a.classList.remove('show'), 3200);
  }
  toast(txt) {
    const t = this.el.toast;
    t.textContent = txt;
    t.classList.remove('show'); void t.offsetWidth; t.classList.add('show');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => t.classList.remove('show'), 1800);
  }
  togglePerf() { this.perfVisible = !this.perfVisible; this.el.perf.classList.toggle('on', this.perfVisible); }
  perf(txt) { this.el.perf.textContent = txt; }
  hud(h) {
    const e = this.el;
    const f = Math.max(0, h.hp / h.maxHp);
    e.hpbar.style.width = (f * 100).toFixed(1) + '%';
    e.hpbar.style.background = f > 0.5 ? 'linear-gradient(90deg,#c9d2c4,#e8efe2)' : f > 0.25 ? 'linear-gradient(90deg,#d9a24a,#f0c36a)' : 'linear-gradient(90deg,#b8262a,#ff4a4a)';
    e.hptxt.textContent = Math.ceil(h.hp);
    e.wave.textContent = h.wave ? 'OLEADA ' + h.wave : 'PREPARATE';
    e.kills.textContent = h.kills + ' bajas';
    e.left.textContent = h.left ? h.left + ' vienen' : (h.between ? 'próxima en ' + Math.ceil(h.between) + 's' : '');
    e.weapon.textContent = h.weapon;
    e.ammo.innerHTML = `<b>${h.mag}</b> / ${h.reserve === Infinity ? '∞' : h.reserve}`;
    e.reload.style.width = (h.reloading * 100).toFixed(0) + '%';
    e.reload.parentElement.style.opacity = h.reloading ? 1 : 0;
    if (this._slotsKey !== h.owned.join() + h.current) {
      this._slotsKey = h.owned.join() + h.current;
      const names = { pistol: '1', smg: '2', shotgun: '3', rifle: '4' };
      e.slots.innerHTML = h.owned.map(k => `<span class="${k === h.current ? 'cur' : ''}">${names[k]}</span>`).join('');
    }
    e.flash.classList.toggle('off', !h.flashlight);
  }
  crosshair(x, y, spread, moving) {
    const c = this.el.cross;
    const s = 22 + spread * 260 + moving * 6;
    c.style.transform = `translate(${x}px, ${y}px) translate(-50%,-50%)`;
    c.style.width = c.style.height = s + 'px';
  }
}

// ═══ arranque ════════════════════════════════════════════════════════════════
function boot() {
  const canvas = $('c');
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('carrona.settings') || '{}'); } catch { saved = {}; }
  const quality = saved.quality || (window.devicePixelRatio > 1.4 ? 'medio' : 'medio');
  const renderer = new Renderer(canvas, { quality });
  const audio = new GameAudio();
  const ui = new UI();
  const input = new Input(window);
  const game = new Game(renderer, audio, ui, input);
  if (saved.volume !== undefined) audio.volume = saved.volume;
  if (saved.shake !== undefined) game.settings.shake = saved.shake;
  if (saved.camDist) { renderer.camDistTarget = renderer.camDist = Math.max(12, Math.min(32, saved.camDist)); game.settings.camDist = renderer.camDistTarget; }
  game.settings.volume = audio.volume;
  ui.onSettings = (s) => game.applySettings(s);
  window.carrona = game;   // para depurar desde la consola

  // el audio arranca con el primer gesto
  const unlock = () => { audio.init(); audio.resume(); };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });

  ui.el.loading.classList.add('off');

  let last = performance.now();
  let hidden = false;
  document.addEventListener('visibilitychange', () => { hidden = document.hidden; last = performance.now(); });
  const loop = (now) => {
    const dt = Math.min(1 / 30, Math.max(1 / 240, (now - last) / 1000));
    last = now;
    if (!hidden) game.update(dt);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

boot();
