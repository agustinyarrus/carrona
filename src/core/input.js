// ─────────────────────────────────────────────────────────────────────────────
//  input.js — Teclado y mouse, con detección de flanco (pressed), rueda y
//  acciones con teclas configurables.
//
//  El juego pregunta por ACCIONES ('fire', 'run', 'reload'…), no por teclas:
//  la tabla `keys` (acción → códigos) viene de los ajustes y se puede cambiar
//  en caliente. Un clic sobre una pantalla del menú (botones, listas,
//  deslizadores) no le llega al juego: el mouse sólo cuenta sobre el canvas.
// ─────────────────────────────────────────────────────────────────────────────

const UI_SELECTOR = '.screen, .ui';
const ALWAYS_PREVENT = new Set(['Space', 'Tab', 'F3']);

export class Input {
  constructor(target = window, keys = {}) {
    this.down = new Set();
    this.pressedSet = new Set();
    this.mouseX = 0; this.mouseY = 0;      // px
    this.nx = 0; this.ny = 0;              // normalizado -1..1 (y arriba)
    this.buttons = 0;
    this.wheel = 0;
    this.capture = null;                   // callback esperando la próxima tecla (rebindeo)
    this.setKeys(keys);
    this._onKeyDown = (e) => {
      if (e.repeat) return;
      if (this.capture) {
        const cb = this.capture; this.capture = null;
        e.preventDefault();
        cb(e.code === 'Escape' ? null : e.code);
        return;
      }
      this.down.add(e.code); this.pressedSet.add(e.code);
      // no frenar las flechas ni el espacio cuando el foco está en un control del menú
      const el = document.activeElement;
      const inControl = el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'BUTTON');
      if (!inControl && (ALWAYS_PREVENT.has(e.code) || this._prevent.has(e.code))) e.preventDefault();
    };
    this._onKeyUp = (e) => { this.down.delete(e.code); };
    this._onMove = (e) => {
      this.mouseX = e.clientX; this.mouseY = e.clientY;
      this.nx = (e.clientX / window.innerWidth) * 2 - 1;
      this.ny = -((e.clientY / window.innerHeight) * 2 - 1);
    };
    this._onDown = (e) => {
      if (this.capture) {
        const cb = this.capture; this.capture = null;
        cb('Mouse' + e.button);
        return;
      }
      if (e.target && e.target.closest && e.target.closest(UI_SELECTOR)) return;   // clic en el menú: no es un tiro
      this.buttons |= (1 << e.button);
      this.pressedSet.add('Mouse' + e.button);
    };
    this._onUp = (e) => { this.buttons &= ~(1 << e.button); };
    this._onWheel = (e) => {
      if (e.target && e.target.closest && e.target.closest(UI_SELECTOR)) return;   // la rueda en un menú hace scroll
      this.wheel += Math.sign(e.deltaY); e.preventDefault();
    };
    this._onBlur = () => { this.down.clear(); this.buttons = 0; };
    target.addEventListener('keydown', this._onKeyDown);
    target.addEventListener('keyup', this._onKeyUp);
    target.addEventListener('mousemove', this._onMove);
    target.addEventListener('mousedown', this._onDown);
    target.addEventListener('mouseup', this._onUp);
    target.addEventListener('wheel', this._onWheel, { passive: false });
    target.addEventListener('blur', this._onBlur);
    target.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Tabla acción → códigos. Las teclas ligadas se frenan en el navegador (nada de scroll con las flechas). */
  setKeys(keys) {
    this.keys = keys || {};
    this._prevent = new Set();
    for (const a in this.keys) for (const c of this.keys[a]) if (!c.startsWith('Mouse')) this._prevent.add(c);
  }

  /** La próxima tecla o botón que se apriete va a `cb(code)` (null si fue esc). */
  captureNext(cb) { this.capture = cb; }
  cancelCapture() { this.capture = null; }

  held(code) { return code.startsWith('Mouse') ? (this.buttons & (1 << +code.slice(5))) !== 0 : this.down.has(code); }
  pressed(code) { return this.pressedSet.has(code); }
  /** ¿Alguna tecla de la acción está apretada? */
  act(name) { const l = this.keys[name]; if (!l) return false; for (const c of l) if (this.held(c)) return true; return false; }
  /** ¿Alguna tecla de la acción se apretó en este frame? */
  actPressed(name) { const l = this.keys[name]; if (!l) return false; for (const c of l) if (this.pressedSet.has(c)) return true; return false; }
  axis(neg, pos) { return (this.act(pos) ? 1 : 0) - (this.act(neg) ? 1 : 0); }
  get fire() { return this.act('fire'); }
  /** Llamar al final del frame: limpia los flancos y la rueda. */
  endFrame() { this.pressedSet.clear(); this.wheel = 0; }
}
