// ─────────────────────────────────────────────────────────────────────────────
//  main.js — Arranque: canvas, renderer, audio, las pantallas y el bucle.
//
//  La UI es DOM puro sobre el canvas: menú con botones, campaña, infinito,
//  opciones generadas desde el registro (options.js), pausa, muerte y
//  victoria. Nada de acá simula: le pide todo al juego y le avisa qué tocó
//  el jugador.
// ─────────────────────────────────────────────────────────────────────────────

import { Renderer } from './render/renderer.js';
import { GameAudio } from './audio/audio.js';
import { Input } from './core/input.js';
import { Game } from './game/game.js';
import { OPTIONS, OPTION_GROUPS, ACTION_ORDER, loadSettings } from './game/options.js';
import { t, tx, fmtTime, keyName, applyDom, getLang } from './core/i18n.js';
import { initPwa } from './core/pwa.js';
import { VERSION } from './core/version.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ═══ HUD / pantallas ═════════════════════════════════════════════════════════
class UI {
  constructor() {
    const ids = ['menu', 'campaign', 'infinite', 'options', 'pause', 'death', 'win', 'hud', 'announce', 'toast', 'perf', 'crosshair', 'loading',
      'hpbar', 'hptxt', 'wave', 'kills', 'left', 'objective', 'weapon', 'ammo', 'reload', 'slots', 'flash', 'marker',
      'dstats', 'wstats', 'best', 'dbest', 'wbest', 'menu-sub', 'death-sub', 'win-sub', 'progress-line', 'keys', 'version',
      'mission-list', 'map-list', 'opts',
      'b-continue', 'b-campaign', 'b-infinite', 'b-options', 'b-fullscreen', 'b-install', 'b-campaign-back', 'b-infinite-back',
      'b-options-reset', 'b-options-back', 'b-resume', 'b-pause-options', 'b-restart', 'b-pause-menu', 'b-retry', 'b-death-menu',
      'b-next', 'b-again', 'b-win-menu'];
    this.el = {};
    for (const id of ids) {
      const e = $(id);
      if (!e) console.warn('falta #' + id + ' en index.html');
      this.el[id.replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = e;
    }
    this.game = null;
    this.screen = null;          // qué pantalla está en primer plano
    this.optionsFrom = 'menu';   // desde dónde se abrieron las opciones
    this._annT = null; this._toastT = null;
    this._installPrompt = null;
    this._wireButtons();
  }

  bind(game) { this.game = game; }

  _click(el, fn) { if (el) el.addEventListener('click', (e) => { e.preventDefault(); fn(); }); }
  _wireButtons() {
    const E = this.el;
    this._click(E.bContinue, () => { const i = this.game.menuInfo(); if (i.next) this.game.startMission(i.next.id); });
    this._click(E.bCampaign, () => this.showCampaign());
    this._click(E.bInfinite, () => this.showInfinite());
    this._click(E.bOptions, () => this.showOptions('menu'));
    this._click(E.bFullscreen, () => this.game.setFullscreen(!document.fullscreenElement));
    this._click(E.bInstall, () => { if (this._installPrompt) this._installPrompt(); });
    this._click(E.bCampaignBack, () => this.showMenu(this.game.menuInfo()));
    this._click(E.bInfiniteBack, () => this.showMenu(this.game.menuInfo()));
    this._click(E.bOptionsBack, () => this.back());
    this._click(E.bOptionsReset, () => { this.game.resetSettings(); this._renderOptions(); });
    this._click(E.bResume, () => this.game.resume());
    this._click(E.bPauseOptions, () => this.showOptions('pause'));
    this._click(E.bRestart, () => this.game.retry());
    this._click(E.bPauseMenu, () => this.game.quitToMenu());
    this._click(E.bRetry, () => this.game.retry());
    this._click(E.bDeathMenu, () => this.game.startMenu());
    this._click(E.bNext, () => this.game.nextMission());
    this._click(E.bAgain, () => this.game.retry());
    this._click(E.bWinMenu, () => this.game.startMenu());
    document.addEventListener('fullscreenchange', () => this._fullscreenChanged());
  }

  // ── pantallas ──
  _show(name) {
    for (const k of ['menu', 'campaign', 'infinite', 'options', 'pause', 'death', 'win']) this.el[k] && this.el[k].classList.toggle('on', k === name);
    this.screen = name;
    if (name) document.body.classList.remove('ingame');
  }
  get optionsOpen() { return this.screen === 'options'; }
  get endScreenOn() { return this.screen === 'death' || this.screen === 'win'; }

  showMenu(info) {
    this._show('menu');
    this.el.hud.classList.remove('on');
    const E = this.el;
    // el subtítulo del mapa está en castellano; en otro idioma va el genérico
    E.menuSub.textContent = info.map && info.map.sub && getLang() === 'es' ? info.map.sub : t('menu.sub');
    E.bContinue.classList.toggle('hidden', !info.next);
    if (info.next) E.bContinue.textContent = t('menu.continue', { name: info.next.name });
    E.progressLine.textContent = t('menu.progress', { done: info.done, total: info.total });
    E.best.textContent = info.best.wave ? t('menu.best', { wave: info.best.wave, kills: info.best.kills }) : '';
    E.version.textContent = t('menu.version', { version: VERSION });
    this._fullscreenChanged();
    this._renderLegend();
  }
  showCampaign() {
    this._show('campaign');
    const list = this.el.missionList;
    list.innerHTML = '';
    this.game.campaignEntries().forEach((m, i) => {
      const b = document.createElement('button');
      b.className = 'item' + (m.unlocked ? '' : ' locked') + (m.done ? ' done' : '');
      b.disabled = !m.unlocked;
      const status = !m.unlocked ? t('campaign.locked') : m.done ? t('campaign.done', { time: fmtTime(m.bestTime || 0) }) : (m.attempts ? t('campaign.attempts', { n: m.attempts }) : t('campaign.new'));
      b.innerHTML = `<div class="num">${m.done ? '✓' : i + 1}</div><div><div class="name">${esc(m.name)} <span style="color:var(--dim);letter-spacing:.14em">· ${esc(m.map)}</span></div><div class="brief">${esc(m.brief)}</div></div><div class="status">${esc(status)}</div>`;
      if (m.unlocked) b.addEventListener('click', () => this.game.startMission(m.id));
      list.appendChild(b);
    });
  }
  showInfinite() {
    this._show('infinite');
    const list = this.el.mapList;
    list.innerHTML = '';
    for (const m of this.game.infiniteEntries()) {
      const b = document.createElement('button');
      b.className = 'item' + (m.unlocked ? '' : ' locked');
      b.disabled = !m.unlocked;
      const status = !m.unlocked ? t('infinite.locked') : m.best ? t('infinite.best', { wave: m.best.wave, kills: m.best.kills }) : t('infinite.none');
      b.innerHTML = `<div class="num">∞</div><div><div class="name">${esc(m.name)}</div><div class="brief">${esc(m.sub)}</div></div><div class="status">${esc(status)}</div>`;
      if (m.unlocked) b.addEventListener('click', () => this.game.startInfinite(m.mapId));
      list.appendChild(b);
    }
  }
  showOptions(from) {
    this.optionsFrom = from;
    this._show('options');
    this._renderOptions();
  }
  showPause() {
    this._show('pause');
  }
  showDeath(st, best, ctx) {
    this._show('death');
    this.el.hud.classList.remove('on');
    this.el.deathSub.textContent = ctx.map && ctx.map.texts && getLang() === 'es' ? ctx.map.texts.death : t('death.sub');
    this.el.dstats.innerHTML = this._statsHtml(st);
    this.el.dbest.textContent = t('death.best', { wave: best.wave, kills: best.kills });
  }
  showWin(st, ctx) {
    this._show('win');
    this.el.hud.classList.remove('on');
    this.el.winSub.textContent = t('win.sub', { name: tx(ctx.mission.name), map: ctx.map.name });
    this.el.wstats.innerHTML = this._statsHtml(st);
    this.el.bNext.classList.toggle('hidden', !ctx.hasNext);
    this.el.wbest.textContent = ctx.campaignDone ? t('win.campaignDone') : (ctx.bestTime ? t('win.best', { time: fmtTime(ctx.bestTime) }) : '');
  }
  hideAll() {
    this._show(null);
    this.el.hud.classList.add('on');
    document.body.classList.add('ingame');
  }
  /** Esc: cierra la pantalla que esté encima (opciones → de donde vino; listas → menú). */
  back() {
    if (this.screen === 'options') {
      if (this.game.input) this.game.input.cancelCapture();
      if (this.optionsFrom === 'pause') this.showPause(); else this.showMenu(this.game.menuInfo());
    } else if (this.screen === 'campaign' || this.screen === 'infinite') this.showMenu(this.game.menuInfo());
  }
  _fullscreenChanged() {
    const fs = !!document.fullscreenElement;
    if (this.el.bFullscreen) this.el.bFullscreen.textContent = t(fs ? 'menu.windowed' : 'menu.fullscreen');
    if (this.screen === 'options') this._renderOptions();
  }
  /** El navegador ofrece instalar el juego como app: aparece el botón. */
  setInstallable(promptFn) {
    this._installPrompt = promptFn;
    if (this.el.bInstall) this.el.bInstall.classList.toggle('hidden', !promptFn);
  }
  /** Cambió el idioma: se rehace todo lo que tiene texto. */
  relabel() {
    applyDom(document);
    if (this.screen === 'menu' && this.game) this.showMenu(this.game.menuInfo());
    else if (this.screen === 'options') this._renderOptions();
    else if (this.screen === 'campaign') this.showCampaign();
    else if (this.screen === 'infinite') this.showInfinite();
    this._fullscreenChanged();
  }

  _statsHtml(st) {
    const acc = st.shots ? Math.round(st.hits / st.shots * 100) : 0;
    const cell = (v, k) => `<div><b>${v}</b><span>${t(k)}</span></div>`;
    return cell(st.wave, 'stat.wave') + cell(st.kills, 'stat.kills') + cell(st.headshots, 'stat.headshots') + cell(st.severs, 'stat.severs') +
      cell(acc + '%', 'stat.accuracy') + cell(fmtTime(st.time), 'stat.time');
  }

  /** La leyenda de teclas del menú, a partir de lo configurado. */
  _renderLegend() {
    const K = this.game.settings.keys;
    const k = (a) => `<b>${esc(keyName(K[a][0]))}</b>`;   // sin tecla muestra un guion
    const rows = [
      [`${k('moveUp')}${k('moveLeft')}${k('moveDown')}${k('moveRight')}`, `${t('keys.move')} · ${k('run')} ${t('keys.run')}`],
      [`<b>${t('keys.mouse')}</b>`, `${t('keys.aim')} · ${k('fire')} ${t('keys.fire')}`],
      [k('reload'), `${t('keys.reload')} · <b>1-4</b> ${t('keys.weapons')}`],
      [k('interact'), t('keys.interact')],
      [k('crouch'), `${t('keys.crouch')} · ${k('roll')} ${t('keys.roll')}`],
      [`${k('camLeft')} / ${k('camRight')}`, `${t('keys.cam')} · <b>${t('keys.wheel')}</b> ${t('keys.zoom')}`],
      [k('flashlight'), `${t('keys.flashlight')} · ${k('pause')} ${t('keys.pause')}`],
    ];
    this.el.keys.innerHTML = rows.map(([a, b]) => `<span>${a}</span><span>${b}</span>`).join('');
  }

  /** La pantalla de opciones, generada desde el registro. */
  _renderOptions() {
    const G = this.game, S = G.settings, root = this.el.opts;
    root.innerHTML = '';
    for (const group of OPTION_GROUPS) {
      const box = document.createElement('div');
      box.className = 'ogroup';
      box.innerHTML = `<h3>${t('options.group.' + group)}</h3>`;
      if (group === 'controls') this._renderKeys(box);
      else for (const o of OPTIONS.filter(o => o.group === group)) box.appendChild(this._optionRow(o, o.volatile ? o.get(G) : S[o.key]));
      root.appendChild(box);
    }
  }
  _optionRow(o, value) {
    const G = this.game;
    const row = document.createElement('div');
    row.className = 'orow';
    row.innerHTML = `<span>${t('options.' + o.key)}</span><span class="ctl"></span>`;
    const ctl = row.lastElementChild;
    if (o.type === 'select') {
      const sel = document.createElement('select');
      for (const v of o.values) {
        const op = document.createElement('option');
        op.value = v; op.textContent = t('options.' + o.key + '.' + v);
        sel.appendChild(op);
      }
      sel.value = value;
      sel.addEventListener('change', () => G.applySettings({ [o.key]: sel.value }));
      ctl.appendChild(sel);
    } else if (o.type === 'range') {
      const inp = document.createElement('input');
      inp.type = 'range'; inp.min = o.min; inp.max = o.max; inp.step = o.step; inp.value = value;
      const val = document.createElement('span'); val.className = 'val'; val.textContent = o.fmt(value);
      inp.addEventListener('input', () => { const v = parseFloat(inp.value); val.textContent = o.fmt(v); G.applySettings({ [o.key]: v }); });
      ctl.appendChild(inp); ctl.appendChild(val);
    } else if (o.type === 'toggle') {
      const b = document.createElement('button');
      b.className = 'btn small';
      b.textContent = t(value ? 'options.yes' : 'options.no');
      b.addEventListener('click', () => {
        const nv = !(o.volatile ? o.get(G) : G.settings[o.key]);
        G.applySettings({ [o.key]: nv });
        b.textContent = t(nv ? 'options.yes' : 'options.no');
      });
      ctl.appendChild(b);
    }
    return row;
  }
  _renderKeys(box) {
    const G = this.game;
    const hint = document.createElement('div');
    hint.className = 'okeys-hint'; hint.textContent = t('options.keys.hint');
    box.appendChild(hint);
    for (const a of ACTION_ORDER) {
      const row = document.createElement('div');
      row.className = 'orow';
      row.innerHTML = `<span>${t('action.' + a)}</span><span class="ctl"></span>`;
      const b = document.createElement('button');
      b.className = 'btn small key';
      const label = () => { b.textContent = G.settings.keys[a].length ? G.settings.keys[a].map(keyName).join(' / ') : '—'; b.classList.remove('waiting'); };
      label();
      b.addEventListener('click', () => {
        if (b.classList.contains('waiting')) return;
        b.classList.add('waiting'); b.textContent = t('options.keys.press');
        G.input.captureNext((code) => { if (code) G.rebindKey(a, code); this._renderOptions(); });
      });
      row.lastElementChild.appendChild(b);
      box.appendChild(row);
    }
    const reset = document.createElement('div');
    reset.className = 'row';
    const rb = document.createElement('button');
    rb.className = 'btn small'; rb.textContent = t('options.keys.reset');
    rb.addEventListener('click', () => { G.resetKeys(); this._renderOptions(); });
    reset.appendChild(rb);
    box.appendChild(reset);
  }

  // ── HUD ──
  announce(big, small = '') {
    const a = this.el.announce;
    a.innerHTML = `<div class="big">${esc(big)}</div><div class="small">${esc(small)}</div>`;
    a.classList.remove('show'); void a.offsetWidth; a.classList.add('show');
    clearTimeout(this._annT);
    this._annT = setTimeout(() => a.classList.remove('show'), 3200);
  }
  toast(txt) {
    const tt = this.el.toast;
    tt.textContent = txt;
    tt.classList.remove('show'); void tt.offsetWidth; tt.classList.add('show');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => tt.classList.remove('show'), 1800);
  }
  setPerf(on) { this.el.perf.classList.toggle('on', !!on); }
  perf(txt) { this.el.perf.textContent = txt; }
  hud(h) {
    const e = this.el;
    const f = Math.max(0, h.hp / h.maxHp);
    e.hpbar.style.width = (f * 100).toFixed(1) + '%';
    e.hpbar.style.background = f > 0.5 ? 'linear-gradient(90deg,#c9d2c4,#e8efe2)' : f > 0.25 ? 'linear-gradient(90deg,#d9a24a,#f0c36a)' : 'linear-gradient(90deg,#b8262a,#ff4a4a)';
    e.hptxt.textContent = Math.ceil(h.hp);
    e.wave.textContent = h.wave ? t('hud.wave', { n: h.wave }) : t('hud.ready');
    e.kills.textContent = t('hud.kills', { n: h.kills });
    e.left.textContent = h.left ? t('hud.coming', { n: h.left }) : (h.between ? t('hud.next', { s: Math.ceil(h.between) }) : '');
    if (this._objKey !== h.objective + '|' + h.progress) {
      this._objKey = h.objective + '|' + h.progress;
      e.objective.classList.toggle('off', !h.objective);
      if (h.objective) e.objective.innerHTML = `<small>${t('hud.objective')}</small>${esc(h.objective)}${h.progress ? `<span class="prog">· ${esc(h.progress)}</span>` : ''}`;
    }
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
    if (this._flashKey !== h.flashKey) { this._flashKey = h.flashKey; e.flash.textContent = t('hud.flashlight', { key: keyName(h.flashKey).toUpperCase() }); }
  }
  crosshair(x, y, spread, moving) {
    const c = this.el.crosshair;
    const s = 22 + spread * 260 + moving * 6;
    c.style.transform = `translate(${x}px, ${y}px) translate(-50%,-50%)`;
    c.style.width = c.style.height = s + 'px';
  }
  /** Marcador del objetivo en pantalla; si queda afuera, pegado al borde. */
  marker(x, y, visible, txt) {
    const m = this.el.marker;
    if (!visible && !(x || y)) { m.classList.remove('on'); return; }
    const W = window.innerWidth, H = window.innerHeight, pad = 46;
    if (!visible) { x = W - x; y = H - y; }   // detrás de la cámara: del lado opuesto
    x = Math.max(pad, Math.min(W - pad, x)); y = Math.max(pad, Math.min(H - pad, y));
    m.classList.add('on');
    m.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px) translate(-50%,-50%)`;
    if (this._markerTxt !== txt) { this._markerTxt = txt; m.lastElementChild.textContent = txt; }
  }
}

// ═══ arranque ════════════════════════════════════════════════════════════════
function boot() {
  const canvas = $('c');
  const settings = loadSettings();
  const renderer = new Renderer(canvas, { quality: settings.quality });
  const audio = new GameAudio();
  const ui = new UI();
  const input = new Input(window, settings.keys);
  const game = new Game(renderer, audio, ui, input, settings);
  ui.bind(game);
  game.applyAllSettings();
  game.startMenu();
  window.carrona = game;   // para depurar desde la consola

  // el audio arranca con el primer gesto
  const unlock = () => { audio.init(); audio.resume(); };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });

  // app instalable (sólo en el build servido; en desarrollo no se registra nada)
  initPwa({ onInstallable: (prompt) => ui.setInstallable(prompt), onInstalled: () => ui.setInstallable(null) });

  ui.el.loading.classList.add('off');

  let last = performance.now();
  let hidden = false;
  document.addEventListener('visibilitychange', () => {
    hidden = document.hidden; last = performance.now();
    if (hidden) game.pause();   // la pestaña se fue atrás: pausa (si estaba jugando)
  });
  let errCount = 0;
  const loop = (now) => {
    const dt = Math.min(1 / 30, Math.max(1 / 240, (now - last) / 1000));
    last = now;
    // un error en un frame no puede matar el bucle (el juego quedaría congelado
    // con el HUD vivo): se registra y se sigue
    if (!hidden) { try { game.update(dt); } catch (e) { if (errCount++ < 5) console.error('frame:', e); } }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

boot();
