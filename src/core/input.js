// ─────────────────────────────────────────────────────────────────────────────
//  input.js — Teclado y mouse, con detección de flanco (pressed) y rueda.
// ─────────────────────────────────────────────────────────────────────────────

export class Input {
  constructor(target = window) {
    this.down = new Set();
    this.pressedSet = new Set();
    this.mouseX = 0; this.mouseY = 0;      // px
    this.nx = 0; this.ny = 0;              // normalizado -1..1 (y arriba)
    this.buttons = 0;
    this.wheel = 0;
    this.locked = false;
    this._onKeyDown = (e) => {
      if (e.repeat) return;
      this.down.add(e.code); this.pressedSet.add(e.code);
      if (['Space', 'Tab', 'F3'].includes(e.code) || e.code.startsWith('Arrow')) e.preventDefault();
    };
    this._onKeyUp = (e) => { this.down.delete(e.code); };
    this._onMove = (e) => {
      this.mouseX = e.clientX; this.mouseY = e.clientY;
      this.nx = (e.clientX / window.innerWidth) * 2 - 1;
      this.ny = -((e.clientY / window.innerHeight) * 2 - 1);
    };
    this._onDown = (e) => { this.buttons |= (1 << e.button); if (e.button === 0) this.pressedSet.add('Mouse0'); if (e.button === 2) this.pressedSet.add('Mouse2'); };
    this._onUp = (e) => { this.buttons &= ~(1 << e.button); };
    this._onWheel = (e) => { this.wheel += Math.sign(e.deltaY); e.preventDefault(); };
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
  held(code) { return this.down.has(code); }
  pressed(code) { return this.pressedSet.has(code); }
  get fire() { return (this.buttons & 1) !== 0; }
  get altFire() { return (this.buttons & 4) !== 0; }
  /** Llamar al final del frame: limpia los flancos y la rueda. */
  endFrame() { this.pressedSet.clear(); this.wheel = 0; }
  axis(neg, pos) { return (this.held(pos) ? 1 : 0) - (this.held(neg) ? 1 : 0); }
}
