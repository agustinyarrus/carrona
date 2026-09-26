// ─────────────────────────────────────────────────────────────────────────────
//  touch.js — Los controles táctiles: dos sticks flotantes (izquierda mueve,
//  derecha apunta y dispara al empujar) y los botones (recargar, trepar,
//  agacharse, linterna, cámara, pausa, agarrar, fuego opcional). Todo DOM sobre
//  el lienzo, sin tocar el juego: lo único que hace es escribir en la capa
//  virtual de Input (setMove, setAim, setVirtual, tapVirtual). El juego sigue
//  preguntando por acciones, como con el teclado.
//
//  El stick es FLOTANTE: aparece donde apoya el dedo, dentro de su mitad de
//  pantalla, así nunca hay que mirar dónde está. Cada dedo se sigue por su
//  pointerId: dos sticks y un botón a la vez sin mezclarse. Los eventos de
//  puntero llevan preventDefault: si no, el navegador fabrica un mousedown
//  por cada toque y el arma disparaba sola.
// ─────────────────────────────────────────────────────────────────────────────

import { STICK, stickVector, followOrigin, Latch } from './sticks.js';

/** Botones: acción de Input, texto (clave i18n), grupo de posición y si es "mantener" o "tocar". */
const BUTTONS = Object.freeze([
  { id: 'pause', act: 'pause', t: 'touch.pause', pos: 'top-right', hold: false },
  { id: 'cam-l', act: 'camLeft', t: 'touch.camL', pos: 'top-center-l', hold: false },
  { id: 'cam-r', act: 'camRight', t: 'touch.camR', pos: 'top-center-r', hold: false },
  { id: 'reload', act: 'reload', t: 'touch.reload', pos: 'right-1', hold: false },
  { id: 'vault', act: 'interact', t: 'touch.vault', pos: 'right-2', hold: false },
  { id: 'crouch', act: 'crouch', t: 'touch.crouch', pos: 'right-3', hold: true, also: 'roll' },
  { id: 'flash', act: 'flashlight', t: 'touch.flash', pos: 'left-1', hold: false },
  { id: 'swap', act: 'swap', t: 'touch.swap', pos: 'center-bottom', hold: false, contextual: true },
  { id: 'fire', act: 'fire', t: 'touch.fire', pos: 'fire', hold: true, fireButton: true },
]);

export class TouchControls {
  /**
   * @param {Input} input        la entrada del juego (capa virtual)
   * @param {object} o           { t: función de traducción, root: document }
   */
  constructor(input, { t = (k) => k, root = document } = {}) {
    this.input = input; this.t = t; this.doc = root;
    this.enabled = false;
    this.fireMode = 'stick';         // 'stick' (empujar el derecho dispara) | 'boton'
    this.lefty = false;              // zurdo: la mitad derecha mueve y la izquierda apunta; los botones se espejan
    this.size = 1; this.alpha = 0.55;
    this.pointers = new Map();       // pointerId → { kind: 'left'|'right'|'btn', ox, oy, btn, latch }
    this.runLatch = new Latch(STICK.runOn, STICK.runOff);
    this.fireLatch = new Latch(STICK.fireOn, STICK.fireOff);
    this._build();
    this._onDown = (e) => this._down(e);
    this._onMove = (e) => this._move(e);
    this._onUp = (e) => this._up(e);
  }

  // ── DOM ───────────────────────────────────────────────────────────────────
  _build() {
    const d = this.doc;
    const layer = this.el = d.createElement('div');
    layer.id = 'touch';
    layer.innerHTML = `
      <div class="tzone left"></div><div class="tzone right"></div>
      <div class="tstick" id="t-stick-l"><div class="knob"></div></div>
      <div class="tstick" id="t-stick-r"><div class="knob"></div></div>`;
    this.stick = { left: layer.querySelector('#t-stick-l'), right: layer.querySelector('#t-stick-r') };
    this.buttons = new Map();
    for (const B of BUTTONS) {
      const b = d.createElement('div');
      b.className = `tbtn pos-${B.pos}` + (B.contextual ? ' hidden' : '') + (B.fireButton ? ' fire' : '');
      b.dataset.act = B.act;
      b.textContent = this.t(B.t);
      layer.appendChild(b);
      this.buttons.set(B.id, { el: b, def: B });
    }
    d.body.appendChild(layer);
    this._applyStyle();
  }
  _applyStyle() {
    // en :root, no en la capa: el HUD del juego (body.touch .tl / .br) también se corre con --tsize
    const root = this.doc.documentElement.style;
    root.setProperty('--tsize', String(this.size));
    root.setProperty('--talpha', String(this.alpha));
    this.el.classList.toggle('firebtn', this.fireMode === 'boton');
  }
  /** Cambió el idioma. */
  relabel(t) { if (t) this.t = t; for (const { el, def } of this.buttons.values()) el.textContent = this.t(def.t); }

  // ── ajustes ───────────────────────────────────────────────────────────────
  enable(on) {
    on = !!on;
    if (on === this.enabled) return;
    this.enabled = on;
    const L = this.el;
    if (on) {
      L.addEventListener('pointerdown', this._onDown);
      L.addEventListener('pointermove', this._onMove);
      L.addEventListener('pointerup', this._onUp);
      L.addEventListener('pointercancel', this._onUp);
      L.addEventListener('lostpointercapture', this._onUp);
    } else {
      L.removeEventListener('pointerdown', this._onDown);
      L.removeEventListener('pointermove', this._onMove);
      L.removeEventListener('pointerup', this._onUp);
      L.removeEventListener('pointercancel', this._onUp);
      L.removeEventListener('lostpointercapture', this._onUp);
      this.releaseAll();
    }
  }
  setFireMode(m) { this.fireMode = m === 'boton' ? 'boton' : 'stick'; this._applyStyle(); if (this.fireMode === 'boton') { this.fireLatch.reset(); this.input.setVirtual('fire', false); } }
  setSize(s) { this.size = Math.max(0.6, Math.min(1.6, +s || 1)); this._applyStyle(); }
  setLefty(v) { this.lefty = !!v; this.el.classList.toggle('lefty', this.lefty); this.doc.body.classList.toggle('lefty', this.lefty); this.releaseAll(); }
  setOpacity(a) { this.alpha = Math.max(0.1, Math.min(1, +a || 0.55)); this._applyStyle(); }
  /** El cartel de agarrar: el botón AGARRAR aparece con el nombre del arma del piso. */
  setSwap(name) {
    const b = this.buttons.get('swap');
    b.el.classList.toggle('hidden', !name);
    if (name) b.el.textContent = `${this.t('touch.swap')} ${name}`;
  }
  get radius() { return STICK.radius * this.size; }

  /** Suelta todo (se apagó, cambió de pantalla, se fue la app atrás). */
  releaseAll() {
    for (const id of [...this.pointers.keys()]) this._end(id);
    this.pointers.clear();
    this.input.setMove(0, 0, false, false);
    this.input.setAim(0, 0, false);
    for (const { def } of this.buttons.values()) { this.input.setVirtual(def.act, false); if (def.also) this.input.setVirtual(def.also, false); }
    this.runLatch.reset(); this.fireLatch.reset();
    this._showStick('left', false); this._showStick('right', false);
  }

  // ── punteros ──────────────────────────────────────────────────────────────
  _down(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    const btnEl = e.target.closest ? e.target.closest('.tbtn') : null;
    if (btnEl && !btnEl.classList.contains('hidden')) {
      const entry = [...this.buttons.values()].find(b => b.el === btnEl);
      if (!entry) return;
      this.el.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { kind: 'btn', btn: entry });
      btnEl.classList.add('down');
      const { def } = entry;
      if (def.hold) { this.input.setVirtual(def.act, true); if (def.also) this.input.tapVirtual(def.also); }
      else this.input.tapVirtual(def.act);
      return;
    }
    // 'left' es el stick de MOVER y 'right' el de APUNTAR, estén del lado que estén (zurdo = espejado)
    const leftHalf = e.clientX < this.el.clientWidth * 0.5;
    const kind = (leftHalf !== this.lefty) ? 'left' : 'right';
    // un stick por lado: el segundo dedo en la misma mitad no arranca otro
    for (const p of this.pointers.values()) if (p.kind === kind) return;
    this.el.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { kind, ox: e.clientX, oy: e.clientY });
    this._showStick(kind, true, e.clientX, e.clientY, 0, 0);
    this._apply(kind, 0, 0);
  }
  _move(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p || p.kind === 'btn') return;
    e.preventDefault();
    // el stick de mover sigue al dedo: pasado el borde, el origen se arrastra detrás y un cambio de
    // dirección es inmediato (sin volver al centro). El de apuntar no: su origen quieto es la precisión
    if (p.kind === 'left') { const f = followOrigin(p.ox, p.oy, e.clientX, e.clientY, this.radius); p.ox = f.ox; p.oy = f.oy; }
    const v = stickVector(e.clientX - p.ox, e.clientY - p.oy, this.radius);
    // el nudillo se dibuja donde está el dedo, acotado al radio
    const kx = v.x * this.radius, ky = -v.y * this.radius;
    this._showStick(p.kind, true, p.ox, p.oy, kx, ky);
    this._apply(p.kind, v.x, v.y, v.mag);
  }
  _up(e) {
    if (!this.pointers.has(e.pointerId)) return;
    if (e.cancelable) e.preventDefault();
    this._end(e.pointerId);
    this.pointers.delete(e.pointerId);
  }
  _end(id) {
    const p = this.pointers.get(id);
    if (!p) return;
    if (p.kind === 'btn') {
      p.btn.el.classList.remove('down');
      if (p.btn.def.hold) { this.input.setVirtual(p.btn.def.act, false); if (p.btn.def.also) this.input.setVirtual(p.btn.def.also, false); }
      return;
    }
    this._showStick(p.kind, false);
    if (p.kind === 'left') { this.input.setMove(0, 0, false, false); this.runLatch.reset(); }
    else { this.input.setAim(0, 0, false); if (this.fireMode === 'stick') { this.fireLatch.reset(); this.input.setVirtual('fire', false); } }
  }
  _apply(kind, x, y, mag = Math.hypot(x, y)) {
    if (kind === 'left') this.input.setMove(x, y, true, this.runLatch.update(mag));
    else {
      this.input.setAim(x, y, true);
      if (this.fireMode === 'stick') this.input.setVirtual('fire', this.fireLatch.update(mag));
    }
  }
  _showStick(kind, on, x = 0, y = 0, kx = 0, ky = 0) {
    const s = this.stick[kind];
    s.classList.toggle('on', on);
    if (!on) return;
    s.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px) translate(-50%, -50%)`;
    s.firstElementChild.style.transform = `translate(${kx.toFixed(0)}px, ${ky.toFixed(0)}px)`;
  }
}

/**
 * ¿Este aparato se maneja con el dedo? Puntero grueso como principal
 * (teléfonos, tablets), o la app nativa. Un portátil con pantalla táctil y
 * mouse dice que no: su puntero principal es fino.
 */
export function coarsePointer() {
  try { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); } catch { return false; }
}
