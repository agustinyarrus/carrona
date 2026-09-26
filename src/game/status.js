// ─────────────────────────────────────────────────────────────────────────────
//  status.js — Lo que le queda al zombi después del tiro: fuego, frío,
//  electricidad y ácido.
//
//   fuego     daño por segundo mientras dure; el cuerpo se va carbonizando
//   frío      se acumula (0..1): lo frena; lleno, queda congelado un rato y
//             los tiros le hacen 50 % más (se quiebra)
//   choque    se sacude y pierde el control un instante (el relámpago)
//   ácido     daño por segundo y 25 % más de daño de todo lo demás
//
//  Guarda el estado en el zombi (Z.st) y un Set con los afectados: el paso
//  es O(afectados), no O(horda). El daño por tiempo lo hace el juego
//  (callback), así la baja se atribuye al arma que prendió el fuego.
// ─────────────────────────────────────────────────────────────────────────────

import { CHEST, HEAD, HIP, SHL, SHR, HAL, HAR, KNL, KNR } from '../phys/ragdoll.js';

export const STATUS = Object.freeze({
  burn: { dps: 9, tick: 0.25, max: 8 },
  acid: { dps: 7, tick: 0.3, max: 8, vuln: 1.25 },
  freeze: { decay: 0.22, slow: 0.72, frozenT: 2.2, vuln: 1.5 },
  shock: { dur: 0.55, limp: 0.3 },
});
const FX_BONES = Object.freeze([CHEST, HEAD, HIP, SHL, SHR, HAL, HAR, KNL, KNR]);
const CHAR = Object.freeze([0.06, 0.05, 0.045]);      // carbón
const ICE = Object.freeze([0.62, 0.82, 0.95]);

function freshState() {
  return { burn: 0, burnDef: null, burnTick: 0, acid: 0, acidDef: null, acidTick: 0, freeze: 0, frozen: 0, shock: 0, pal0: null, jpal0: null, fxT: 0 };
}

export class StatusBoard {
  /** @param fx ShotFX (o null en las pruebas) */
  constructor(fx = null, rng = Math.random) {
    this.fx = fx; this.rng = rng;
    this.active = new Set();
  }

  /** Estado de un zombi (lo crea la primera vez). */
  _st(Z) { return Z.st || (Z.st = freshState()); }

  /**
   * Aplica un estado. burn/acid: `amount` segundos (se suman con tope);
   * freeze: fracción de congelamiento; shock: intensidad (1 = relámpago).
   */
  apply(Z, kind, amount, def = null) {
    if (!Z || Z.dead) return;
    const s = this._st(Z);
    if (kind === 'burn') { s.burn = Math.min(STATUS.burn.max, s.burn + amount); s.burnDef = def; if (s.freeze > 0) { s.freeze = 0; s.frozen = 0; } }
    else if (kind === 'acid') { s.acid = Math.min(STATUS.acid.max, s.acid + amount); s.acidDef = def; }
    else if (kind === 'freeze') {
      if (s.burn > 0) { s.burn = Math.max(0, s.burn - amount * 20); return; }    // fuego y frío se anulan
      if (!s.pal0 && Z.body.palette) { s.pal0 = Z.body.palette.slice(); s.jpal0 = Z.body.jointPalette ? Z.body.jointPalette.slice() : null; }
      s.freeze = Math.min(1, s.freeze + amount);
      if (s.freeze >= 1 && s.frozen <= 0) s.frozen = STATUS.freeze.frozenT;
    } else if (kind === 'shock') {
      s.shock = Math.max(s.shock, STATUS.shock.dur * amount);
      const B = Z.body;
      if (B.flinch) B.flinch(STATUS.shock.limp * amount);
      B.stagger = Math.min(0.9, (B.stagger || 0) + 0.3 * amount);
    }
    this.active.add(Z);
  }

  /** Multiplicador de daño que recibe (congelado se quiebra, ácido corroe). */
  vulnerability(Z) {
    const s = Z.st;
    if (!s) return 1;
    return (s.frozen > 0 ? STATUS.freeze.vuln : 1) * (s.acid > 0 ? STATUS.acid.vuln : 1);
  }
  isFrozen(Z) { return !!(Z.st && Z.st.frozen > 0); }
  isBurning(Z) { return !!(Z.st && Z.st.burn > 0); }

  /**
   * Paso: daño por tiempo, deshielo, efectos. `damage(Z, dmg, def, kind)`
   * lo aplica el juego. O(afectados).
   */
  update(dt, damage) {
    for (const Z of this.active) {
      const s = Z.st, B = Z.body;
      if (!s || Z.dead || !B.alive) { this._restore(Z); this.active.delete(Z); continue; }
      let busy = false;
      if (s.burn > 0) {
        busy = true; s.burn -= dt; s.burnTick -= dt;
        // un paso largo (pestaña atrás, prueba) cobra todos los tics que pasaron
        while (s.burnTick <= 0 && !Z.dead) { s.burnTick += STATUS.burn.tick; damage(Z, STATUS.burn.dps * STATUS.burn.tick, s.burnDef, 'burn'); }
        this._char(B, dt);
      }
      if (s.acid > 0) {
        busy = true; s.acid -= dt; s.acidTick -= dt;
        while (s.acidTick <= 0 && !Z.dead) { s.acidTick += STATUS.acid.tick; damage(Z, STATUS.acid.dps * STATUS.acid.tick, s.acidDef, 'acid'); }
      }
      if (s.frozen > 0) { busy = true; s.frozen -= dt; if (s.frozen <= 0) s.freeze = 0.6; }
      else if (s.freeze > 0) { busy = true; s.freeze = Math.max(0, s.freeze - STATUS.freeze.decay * dt); }
      if (s.shock > 0) { busy = true; s.shock -= dt; }
      this._tint(B, s);
      if (this.fx) this._fx(Z, s, dt);
      if (!busy) { this._restore(Z); this.active.delete(Z); }
    }
  }

  /**
   * Frena a los afectados: se llama DESPUÉS de la IA (que eligió la
   * velocidad) y ANTES de la física (que la usa). Congelado = quieto.
   */
  applySlows() {
    for (const Z of this.active) {
      const s = Z.st, B = Z.body;
      if (!s || Z.dead) continue;
      if (s.frozen > 0) { B.wantSpeed = 0; continue; }
      if (s.freeze > 0) B.wantSpeed *= 1 - STATUS.freeze.slow * s.freeze;
      if (s.shock > 0) B.wantSpeed *= 0.3;
    }
  }

  /** El fuego oscurece el color de a poco (y no vuelve: quedó quemado). */
  _char(B, dt) {
    const p = B.palette, jp = B.jointPalette, k = Math.min(1, dt * 0.35);
    if (p) for (let i = 0; i < p.length; i += 3) { p[i] += (CHAR[0] - p[i]) * k; p[i + 1] += (CHAR[1] - p[i + 1]) * k; p[i + 2] += (CHAR[2] - p[i + 2]) * k; }
    if (jp) for (let i = 0; i < jp.length; i += 3) { jp[i] += (CHAR[0] - jp[i]) * k; jp[i + 1] += (CHAR[1] - jp[i + 1]) * k; jp[i + 2] += (CHAR[2] - jp[i + 2]) * k; }
  }
  /** El frío tiñe de celeste según cuánto está congelado (vuelve al color guardado al deshelarse). */
  _tint(B, s) {
    if (!s.pal0 || !B.palette) return;
    const f = s.frozen > 0 ? 0.62 : s.freeze * 0.45;
    const p = B.palette, p0 = s.pal0;
    for (let i = 0; i < p.length; i += 3) for (let c = 0; c < 3; c++) p[i + c] = p0[i + c] + (ICE[c] - p0[i + c]) * f;
    if (s.jpal0 && B.jointPalette) { const jp = B.jointPalette, j0 = s.jpal0; for (let i = 0; i < jp.length; i += 3) for (let c = 0; c < 3; c++) jp[i + c] = j0[i + c] + (ICE[c] - j0[i + c]) * f; }
  }
  _restore(Z) {
    const s = Z.st, B = Z.body;
    if (s && s.pal0 && B.palette && s.freeze <= 0 && s.frozen <= 0) {
      // si además se quemó, conserva lo quemado: sólo se saca el celeste
      if (!(s.burn > 0)) { B.palette.set(s.pal0); if (s.jpal0 && B.jointPalette) B.jointPalette.set(s.jpal0); }
      s.pal0 = null; s.jpal0 = null;
    }
  }

  _fx(Z, s, dt) {
    const fx = this.fx, B = Z.body, R = this.rng;
    s.fxT -= dt;
    const bone = FX_BONES[Math.floor(R() * FX_BONES.length)];
    const x = B.px(bone), y = B.py(bone), z = B.pz(bone);
    if (s.burn > 0) {
      for (let k = 0; k < 2; k++) fx.flame(x + (R() - 0.5) * 0.12, y, z + (R() - 0.5) * 0.12, (R() - 0.5) * 0.4, 1.4 + R() * 0.8, (R() - 0.5) * 0.4, 0.35 + R() * 0.2, 0.05 + R() * 0.03);
      if (R() < 0.1) fx.puff(x, y + 0.2, z, 0, 0.8, 0, 0.1, 1.2, 0x2a2b2f, 0.35);
    }
    if ((s.freeze > 0.2 || s.frozen > 0) && R() < 0.35) fx.mote(x, y, z, (R() - 0.5) * 0.3, 0.2, (R() - 0.5) * 0.3, 0.035, '#e8f7ff', 2.2, 0.6, { cell: 14, drag: 2, rotV: 2 });
    if (s.acid > 0 && R() < 0.5) fx.bubble(x, y, z, 0.03, '#b5f25a');
    if (s.shock > 0 && s.fxT <= 0) {
      s.fxT = 0.07;
      const b2 = FX_BONES[Math.floor(R() * FX_BONES.length)];
      fx.arc(x, y, z, B.px(b2), B.py(b2), B.pz(b2), '#b4f0ff', 0.008, 0.07);
    }
  }

  clear() { for (const Z of this.active) this._restore(Z); this.active.clear(); }
  get count() { return this.active.size; }
}
