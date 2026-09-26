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
import { initPwa, isNative } from './core/pwa.js';
import { TouchControls, coarsePointer } from './core/touch.js';
import { SETTINGS_KEY } from './game/options.js';
import { Armory } from './render/armory.js';
import { WEAPONS, RARITY, SLOTS, weaponTraits } from './game/catalog.js';
import { VERSION } from './core/version.js';
import { SIM } from './core/util.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ═══ HUD / pantallas ═════════════════════════════════════════════════════════
class UI {
  constructor() {
    const ids = ['menu', 'campaign', 'infinite', 'armory', 'options', 'pause', 'death', 'win', 'hud', 'announce', 'toast', 'perf', 'crosshair', 'loading',
      'hpbar', 'hptxt', 'wave', 'kills', 'left', 'objective', 'weapon', 'weapon-sub', 'ammo', 'reload', 'spin', 'slots', 'flash', 'marker', 'prompt',
      'arm-sub', 'arm-filters', 'arm-grid', 'arm-view', 'arm-name', 'arm-meta', 'arm-tag', 'arm-stats', 'arm-traits', 'arm-kills',
      'b-armory', 'b-arm-try', 'b-arm-fire', 'b-arm-back',
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
    this.armory = null;          // la armería (3D) se crea la primera vez que se abre
    this.armSel = null; this.armFilter = 0; this._armCards = null;
    this._wireButtons();
  }

  bind(game) { this.game = game; }

  _click(el, fn) { if (el) el.addEventListener('click', (e) => { e.preventDefault(); fn(); }); }
  _wireButtons() {
    const E = this.el;
    this._click(E.bContinue, () => { const i = this.game.menuInfo(); if (i.next) this.game.startMission(i.next.id); });
    this._click(E.bCampaign, () => this.showCampaign());
    this._click(E.bInfinite, () => this.showInfinite());
    this._click(E.bArmory, () => this.showArmory());
    this._click(E.bArmTry, () => { if (this.armSel) { this._closeArmory(); this.game.startRange(this.armSel); } });
    this._click(E.bArmFire, () => { if (this.armory) this.armory.fireNow(); });
    this._click(E.bArmBack, () => this.back());
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
    for (const k of ['menu', 'campaign', 'infinite', 'armory', 'options', 'pause', 'death', 'win']) this.el[k] && this.el[k].classList.toggle('on', k === name);
    if (name !== 'armory' && this.armory && this.armory.active) this._closeArmory();
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
    else if (this.screen === 'armory') { this._closeArmory(); this.showMenu(this.game.menuInfo()); }
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
    if (this.game && this.game.touch) this.game.touch.relabel(t);
    if (this.screen === 'menu' && this.game) this.showMenu(this.game.menuInfo());
    else if (this.screen === 'options') this._renderOptions();
    else if (this.screen === 'campaign') this.showCampaign();
    else if (this.screen === 'infinite') this.showInfinite();
    else if (this.screen === 'armory') { this._armCards = null; this.showArmory(); }
    this._fullscreenChanged();
  }

  _statsHtml(st) {
    const acc = st.shots ? Math.round(st.hits / st.shots * 100) : 0;
    const cell = (v, k) => `<div><b>${v}</b><span>${t(k)}</span></div>`;
    return cell(st.wave, 'stat.wave') + cell(st.kills, 'stat.kills') + cell(st.headshots, 'stat.headshots') + cell(st.severs, 'stat.severs') +
      cell(acc + '%', 'stat.accuracy') + cell(fmtTime(st.time), 'stat.time');
  }

  /** La leyenda de teclas del menú, a partir de lo configurado (con el dedo, una sola línea). */
  _renderLegend() {
    if (this.game.touchMode) { this.el.keys.innerHTML = `<span class="touchline">${esc(t('keys.touch'))}</span>`; return; }
    const K = this.game.settings.keys;
    const k = (a) => `<b>${esc(keyName(K[a][0]))}</b>`;   // sin tecla muestra un guion
    const rows = [
      [`${k('moveUp')}${k('moveLeft')}${k('moveDown')}${k('moveRight')}`, `${t('keys.move')} · ${k('run')} ${t('keys.run')}`],
      [`<b>${t('keys.mouse')}</b>`, `${t('keys.aim')} · ${k('fire')} ${t('keys.fire')}`],
      [k('reload'), `${t('keys.reload')} · <b>1-5</b> ${t('keys.weapons')}`],
      [k('interact'), t('keys.interact')],
      [k('swap'), t('keys.swap')],
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
      for (const o of OPTIONS.filter(o => o.group === group)) box.appendChild(this._optionRow(o, o.volatile ? o.get(G) : S[o.key]));
      if (group === 'controls') this._renderKeys(box);
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
  toast(txt, color = '') {
    const tt = this.el.toast;
    tt.textContent = txt;
    tt.style.color = color;
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
    if (this._wKey !== h.weapon + h.weaponColor) {
      this._wKey = h.weapon + h.weaponColor;
      e.weapon.textContent = h.weapon;
      e.weapon.style.color = h.weaponColor || '';
      e.weaponSub.textContent = h.weaponSub || '';
    }
    // munición: batería (las de energía) o cargador / reserva
    const ammoKey = h.battery >= 0 ? `b${h.mag}|${h.overheat}|${(h.battery * 50) | 0}` : `m${h.mag}|${h.reserve}`;
    if (this._ammoKey !== ammoKey) {
      this._ammoKey = ammoKey;
      if (h.battery >= 0) e.ammo.innerHTML = `<b>${h.mag}</b><span class="bat"><i style="width:${Math.max(0, Math.min(100, h.battery * 100)).toFixed(0)}%"></i></span>${h.overheat ? `<span class="hot">${t('hud.overheat')}</span>` : ''}`;
      else e.ammo.innerHTML = `<b>${h.mag}</b> / ${h.reserve === Infinity ? '∞' : h.reserve}`;
    }
    e.reload.style.width = (h.reloading * 100).toFixed(0) + '%';
    e.reload.parentElement.style.opacity = h.reloading ? 1 : 0;
    e.spin.style.width = (Math.max(0, h.spin) * 100).toFixed(0) + '%';
    e.spin.parentElement.style.opacity = h.spin > 0.01 ? 1 : 0;
    const slotKey = h.slots.map(s => s ? s.key + (s.cur ? '*' : '') : '-').join();
    if (this._slotsKey !== slotKey) {
      this._slotsKey = slotKey;
      e.slots.innerHTML = h.slots.map((s, i) => s
        ? `<span class="${s.cur ? 'cur' : ''}" style="border-color:${s.cur ? s.color : s.color + '66'};color:${s.cur ? s.color : ''}">${i + 1}</span>`
        : `<span class="empty">${i + 1}</span>`).join('');
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
  /** Cartel "G · CAMBIAR POR X" sobre el arma del piso (null lo esconde). */
  prompt(p, x, y) {
    const el = this.el.prompt;
    if (this.game && this.game.touch && this._swapName !== (p ? p.name : null)) { this._swapName = p ? p.name : null; this.game.touch.setSwap(this._swapName); }
    if (!p) { if (this._promptOn) { el.classList.remove('on'); this._promptOn = false; } return; }
    const key = p.name + p.out + p.key;
    if (this._promptKey !== key) {
      this._promptKey = key;
      el.style.color = p.color;
      el.innerHTML = `<span class="k">${esc(keyName(p.key).toUpperCase())}</span><span class="n">${esc(t('hud.swapFor', { name: p.name }))} · ${esc(p.rarity)}</span>${p.out ? `<span class="o">${esc(t('hud.swapOut', { name: p.out }))}</span>` : ''}`;
    }
    el.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px) translate(-50%, -120%)`;
    if (!this._promptOn) { el.classList.add('on'); this._promptOn = true; }
  }

  // ═══ ARSENAL ═══════════════════════════════════════════════════════════════
  /**
   * La armería: filtros por ranura, grilla de 104 cartas con miniatura 3D
   * (se pintan de a poco) y la ficha del arma elegida con su vista previa
   * disparando. La grilla se arma una vez; los filtros sólo esconden cartas.
   */
  showArmory() {
    this._show('armory');
    this.el.hud.classList.remove('on');
    const G = this.game, E = this.el;
    if (!this.armory) {
      this.armory = G.armory = new Armory(G.R, G.audio);
      this._wireArmoryView();
    }
    const c = G.armoryCounts();
    E.armSub.textContent = t('armory.sub', { found: c.found, total: c.total, fresh: c.fresh });
    if (!this._armCards) this._buildArmoryGrid();
    else this._refreshArmoryFound();
    this.armory.open(E.armView);
    this._selectArmory(this.armSel || G.armoryEntries()[0].key);
  }
  _closeArmory() { if (this.armory && this.armory.active) this.armory.close(); }

  _buildArmoryGrid() {
    const G = this.game, E = this.el;
    // filtros: todas y las cinco ranuras
    E.armFilters.innerHTML = '';
    const mk = (label, i) => { const b = document.createElement('button'); b.className = 'chip' + (this.armFilter === i ? ' on' : ''); b.textContent = label; b.addEventListener('click', () => { this.armFilter = i; for (const x of E.armFilters.children) x.classList.toggle('on', x === b); this._applyArmoryFilter(); }); E.armFilters.appendChild(b); };
    mk(t('armory.all'), 0);
    SLOTS.forEach((s, i) => mk(`${i + 1} · ${tx(s)}`, i + 1));
    E.armGrid.innerHTML = '';
    this._armCards = new Map();
    for (const it of G.armoryEntries()) {
      const d = it.def, R = RARITY[d.rarity];
      const card = document.createElement('div');
      card.className = 'card';
      card.style.setProperty('--rc', R.color);
      card.dataset.slot = d.slot;
      const cv = document.createElement('canvas'); cv.width = 256; cv.height = 128;
      card.appendChild(cv);
      card.insertAdjacentHTML('beforeend', `<div class="nm">${esc(it.name)}</div><div class="fm">${esc(tx(d.familyName).toLowerCase())}</div><div class="rb"></div>${it.found ? '<div class="ck">✓</div>' : ''}`);
      card.addEventListener('click', () => this._selectArmory(it.key));
      E.armGrid.appendChild(card);
      this._armCards.set(it.key, card);
      this.armory.requestThumb(it.key, cv);
    }
    this._applyArmoryFilter();
  }
  _refreshArmoryFound() {
    for (const it of this.game.armoryEntries()) {
      const card = this._armCards.get(it.key);
      if (card && it.found && !card.querySelector('.ck')) card.insertAdjacentHTML('beforeend', '<div class="ck">✓</div>');
    }
  }
  _applyArmoryFilter() {
    for (const [, card] of this._armCards) card.style.display = !this.armFilter || +card.dataset.slot === this.armFilter ? '' : 'none';
  }

  /** La ficha: nombre en el color de la rareza, familia, lema, barras, rasgos, bajas y la vista previa. */
  _selectArmory(key) {
    const G = this.game, E = this.el, d = WEAPONS[key];
    if (!d) return;
    this.armSel = key;
    for (const [k, card] of this._armCards) card.classList.toggle('sel', k === key);
    const sel = this._armCards.get(key);
    if (sel) sel.scrollIntoView({ block: 'nearest' });
    const R = RARITY[d.rarity];
    E.armName.textContent = G.weaponLabel(d);
    E.armName.style.color = R.color;
    E.armMeta.textContent = `${tx(d.familyName).toLowerCase()} · ${tx(R.name)} · ${t('armory.slot', { n: d.slot })}`;
    E.armTag.textContent = tx(d.tag);
    const st = armoryStats(d);
    E.armStats.style.setProperty('--rc', R.color);
    E.armStats.innerHTML = st.map(([k, v, label]) => `<div class="st">${t('armory.stat.' + k)}<b>${esc(label)}</b><div class="bar"><i style="width:${(v * 100).toFixed(0)}%"></i></div></div>`).join('');
    E.armTraits.innerHTML = weaponTraits(d).map(tr => `<span>${esc(t('trait.' + tr))}</span>`).join('');
    const it = G.armoryEntries().find(x => x.key === key);
    E.armKills.textContent = it && it.found ? (it.kills ? t('armory.kills', { n: it.kills }) : t('armory.found')) : t('armory.notFound');
    this.armory.select(key);
  }

  /** Arrastrar para girar y rueda para acercar la vista previa. */
  _wireArmoryView() {
    const v = this.el.armView;
    let drag = null;
    v.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; v.setPointerCapture(e.pointerId); });
    v.addEventListener('pointermove', (e) => { if (!drag) return; this.armory.orbit(e.clientX - drag.x, e.clientY - drag.y); drag.x = e.clientX; drag.y = e.clientY; });
    v.addEventListener('pointerup', () => { drag = null; });
    v.addEventListener('wheel', (e) => { e.preventDefault(); this.armory.zoomBy(e.deltaY > 0 ? 1.08 : 0.93); }, { passive: false });
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

/**
 * Barras de la ficha (0..1) con su valor legible. Daño por disparo (todos
 * los perdigones, la ráfaga o la explosión), cadencia, alcance, precisión,
 * cargador y velocidad de recarga; raíz en el daño para que las pesadas no
 * aplasten al resto.
 */
function armoryStats(d) {
  const P = d.shot.proj;
  const per = d.shot.kind === 'proj' ? (P.radius > 0 ? P.blast : P.dmg) * Math.max(1, d.pellets) : d.dmg * d.pellets * (d.burst || 1);
  const rate = d.burst ? d.rate * d.burst : d.rate;
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  return [
    ['dmg', clamp01(Math.sqrt(per / 300)), Math.round(per) + ''],
    ['rate', clamp01(rate / 22), (Math.round(rate * 10) / 10) + '/s'],
    ['range', clamp01(d.range / 95), Math.round(d.range) + ' m'],
    ['acc', clamp01(1 - d.spread / 0.13), Math.round(clamp01(1 - d.spread / 0.13) * 100) + '%'],
    ['mag', clamp01(Math.log(d.mag + 1) / Math.log(301)), d.regen ? d.mag + ' ⚡' : d.mag + (d.reserve === Infinity ? ' · ∞' : '')],
    ['reload', clamp01(1 - d.reload / 6), d.reload.toFixed(1) + ' s'],
  ];
}

// ═══ arranque ════════════════════════════════════════════════════════════════
function boot() {
  const canvas = $('c');
  const settings = loadSettings();
  // primera vez en un teléfono o en la app: calidad móvil (después el jugador elige)
  let fresh = false;
  try { fresh = localStorage.getItem(SETTINGS_KEY) === null; } catch { /* sin almacenamiento */ }
  if (fresh && (coarsePointer() || isNative())) settings.quality = 'movil';
  const renderer = new Renderer(canvas, { quality: settings.quality });
  const audio = new GameAudio();
  const ui = new UI();
  const input = new Input(window, settings.keys);
  const game = new Game(renderer, audio, ui, input, settings);
  ui.bind(game);
  game.touch = new TouchControls(input, { t });     // la capa táctil (se prende según la opción)
  if (isNative()) document.body.classList.add('native');
  game.applyAllSettings();
  game.startMenu();
  window.carrona = game;   // para depurar desde la consola (y el botón ATRÁS de Android: carrona.backButton())

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
    if (hidden) { game.pause(); if (game.touch) game.touch.releaseAll(); }   // la pestaña se fue atrás: pausa (si estaba jugando)
  });
  let errCount = 0;
  const loop = (now) => {
    // tope de cuadro = SIM.step × SIM.maxSteps: hasta ahí la simulación se parte en pasos y sigue a tiempo real
    const dt = Math.min(SIM.step * SIM.maxSteps, Math.max(1 / 240, (now - last) / 1000));
    last = now;
    // un error en un frame no puede matar el bucle (el juego quedaría congelado
    // con el HUD vivo): se registra y se sigue
    if (!hidden) { try { game.update(dt); } catch (e) { if (errCount++ < 5) console.error('frame:', e); } }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

boot();
