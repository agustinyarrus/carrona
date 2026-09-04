// ─────────────────────────────────────────────────────────────────────────────
//  props.js — Objetos que se mueven: cajas de cartón y sillas de oficina.
//
//  Cada uno es un cluster rígido de partículas en el mismo motor XPBD que los
//  ragdolls: todas las partículas unidas con todas, compliance cero. No hay un
//  segundo motor de cuerpos rígidos; la orientación para dibujarlos se saca de
//  las propias partículas (Gram-Schmidt sobre las aristas). Un zombi que pasa
//  por al lado los empuja porque sus partículas chocan, y listo.
//
//  Sueño: un objeto que se queda quieto y derecho se convierte en un
//  colisionador ESTÁTICO del mundo (caja o cilindro) y sus partículas se
//  congelan. Así, apilar cajas y caminar contra ellas funciona con colisión
//  exacta, y no cuesta nada mientras nadie las toca. Cuando algo se acerca o
//  les pegás un tiro, se despiertan y vuelven a ser partículas.
// ─────────────────────────────────────────────────────────────────────────────

import { CT_DIST } from '../phys/world.js';

let NEXT_GROUP = 1 << 20;   // lejos de los grupos de los ragdolls

export const PR = 0.06;   // radio de partícula: la caja dibujada es la interna + 2·PR

class PropBase {
  constructor(world) {
    this.world = world;
    this.group = NEXT_GROUP++;
    this.p = [];
    this.c = [];
    this.alive = true;
    this.isProp = true;
    this.kind = 'prop';
    this.asleep = false;
    this.restT = 0;
    this.staticObj = null;
    this.savedIw = null;
    this.wakeR = 0.6;
    this._frame = { x: 0, y: 0, z: 0, ex: null, ey: null, ez: null };
  }
  _addP(lx, ly, lz, mass, x, y, z, c, s) {
    const wx = x + lx * c + lz * s, wz = z - lx * s + lz * c;
    const i = this.world.addParticle(wx, y + ly, wz, mass, PR, this.group, 0.9);
    this.world.setOwner(i, this);
    this.p.push(i);
    return i;
  }
  _link(a, b) {
    const w = this.world, p = this.p;
    const dx = w.px[p[b]] - w.px[p[a]], dy = w.py[p[b]] - w.py[p[a]], dz = w.pz[p[b]] - w.pz[p[a]];
    this.c.push(w.addConstraint(p[a], p[b], Math.sqrt(dx * dx + dy * dy + dz * dz), 0, CT_DIST));
  }
  _linkAll(list) {
    for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) this._link(list[a], list[b]);
  }
  remapConstraints(map) {
    for (let k = 0; k < this.c.length; k++) { const n = map.get(this.c[k]); if (n !== undefined) this.c[k] = n; }
  }
  /** Centro aproximado (media de partículas). */
  center(out) {
    const w = this.world; let sx = 0, sy = 0, sz = 0;
    for (const i of this.p) { sx += w.px[i]; sy += w.py[i]; sz += w.pz[i]; }
    const n = this.p.length;
    out.x = sx / n; out.y = sy / n; out.z = sz / n;
    return out;
  }
  get x() { return this.center(this._c || (this._c = {})).x; }
  get z() { return this.center(this._c || (this._c = {})).z; }
  /** Velocidad media (para saber si se está moviendo). */
  speed() {
    const w = this.world; let sx = 0, sy = 0, sz = 0;
    for (const i of this.p) { sx += w.vx[i]; sy += w.vy[i]; sz += w.vz[i]; }
    const n = this.p.length;
    return Math.hypot(sx / n, sy / n, sz / n);
  }
  impulse(ix, iy, iz) {
    const w = this.world, n = this.p.length;
    for (const i of this.p) w.addImpulse(i, ix / n, iy / n, iz / n);
  }
  dispose() {
    const w = this.world;
    if (this.asleep && this.staticObj) { this.staticObj.dead = true; }
    for (const c of this.c) w.breakConstraint(c);
    for (const i of this.p) w.removeParticle(i);
    const k = w.bodies.indexOf(this);
    if (k >= 0) w.bodies.splice(k, 1);
    this.alive = false;
  }
}

// helpers sin alocar
function norm3(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; v[0] /= l; v[1] /= l; v[2] /= l; return v; }
function cross3(a, b, o) { o[0] = a[1] * b[2] - a[2] * b[1]; o[1] = a[2] * b[0] - a[0] * b[2]; o[2] = a[0] * b[1] - a[1] * b[0]; return o; }

// ═════════════════════════════════════════════════════════════════════════════
//  Caja de cartón
// ═════════════════════════════════════════════════════════════════════════════
export class PropBox extends PropBase {
  /**
   * @param w,h,d medidas COMPLETAS de la caja dibujada. `y` es la base.
   */
  constructor(world, x, y, z, w, h, d, yaw = 0, mass = 4, color = 0xc9a56b) {
    super(world);
    this.kind = 'box';
    this.w = w; this.h = h; this.d = d;
    this.color = color;
    const hx = Math.max(0.02, w / 2 - PR), hy = Math.max(0.02, h / 2 - PR), hz = Math.max(0.02, d / 2 - PR);
    this.hx = hx; this.hy = hy; this.hz = hz;
    this.wakeR = Math.hypot(w, d) * 0.5 + 0.55;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const m = mass / 14;
    const cy = y + h / 2;
    for (let k = 0; k < 8; k++) {
      this._addP((k & 1 ? 1 : -1) * hx, (k & 2 ? 1 : -1) * hy, (k & 4 ? 1 : -1) * hz, m, x, cy, z, c, s);
    }
    this._addP(hx, 0, 0, m, x, cy, z, c, s); this._addP(-hx, 0, 0, m, x, cy, z, c, s);
    this._addP(0, hy, 0, m, x, cy, z, c, s); this._addP(0, -hy, 0, m, x, cy, z, c, s);
    this._addP(0, 0, hz, m, x, cy, z, c, s); this._addP(0, 0, -hz, m, x, cy, z, c, s);
    // las 8 esquinas todas con todas (28) ya definen el cuerpo rígido; cada
    // centro de cara se ata a sus 4 esquinas y al centro opuesto (30). 58 en
    // vez de 91: igual de rígido, un tercio más barato.
    this._linkAll([0, 1, 2, 3, 4, 5, 6, 7]);
    const faces = [[8, [1, 3, 5, 7]], [9, [0, 2, 4, 6]], [10, [2, 3, 6, 7]], [11, [0, 1, 4, 5]], [12, [4, 5, 6, 7]], [13, [0, 1, 2, 3]]];
    for (const [f, corners] of faces) for (const k of corners) this._link(f, k);
    this._link(8, 9); this._link(10, 11); this._link(12, 13);
    this._ex = [0, 0, 0]; this._ey = [0, 0, 0]; this._ez = [0, 0, 0];
    world.bodies.push(this);
  }

  /**
   * Marco: centro y ejes ortonormales sacados de las 8 esquinas.
   * out = {x,y,z, ex[3], ey[3], ez[3]}
   */
  frame(out) {
    const w = this.world, p = this.p;
    let cx = 0, cy = 0, cz = 0;
    const ex = this._ex, ey = this._ey, ez = this._ez;
    ex[0] = ex[1] = ex[2] = 0; ey[0] = ey[1] = ey[2] = 0; ez[0] = ez[1] = ez[2] = 0;
    for (let k = 0; k < 8; k++) {
      const i = p[k];
      const px = w.px[i], py = w.py[i], pz = w.pz[i];
      cx += px; cy += py; cz += pz;
      const sx = k & 1 ? 1 : -1, sy = k & 2 ? 1 : -1, sz = k & 4 ? 1 : -1;
      ex[0] += px * sx; ex[1] += py * sx; ex[2] += pz * sx;
      ey[0] += px * sy; ey[1] += py * sy; ey[2] += pz * sy;
      ez[0] += px * sz; ez[1] += py * sz; ez[2] += pz * sz;
    }
    norm3(ex);
    const d = ex[0] * ey[0] + ex[1] * ey[1] + ex[2] * ey[2];
    ey[0] -= ex[0] * d; ey[1] -= ex[1] * d; ey[2] -= ex[2] * d;
    norm3(ey);
    cross3(ex, ey, ez);
    out.x = cx / 8; out.y = cy / 8; out.z = cz / 8;
    out.ex = ex; out.ey = ey; out.ez = ez;
    return out;
  }

  /** ¿Puede dormirse como caja estática? Sólo si está derecha o boca abajo, etc. */
  _sleepShape(w) {
    const f = this.frame(this._frame);
    // eje vertical: el que más apunta arriba
    const ay = Math.abs(f.ey[1]), ax = Math.abs(f.ex[1]), az = Math.abs(f.ez[1]);
    let up, a, b, hu, ha, hb;
    if (ay >= ax && ay >= az) { up = f.ey; a = f.ex; b = f.ez; hu = this.hy; ha = this.hx; hb = this.hz; }
    else if (ax >= az) { up = f.ex; a = f.ey; b = f.ez; hu = this.hx; ha = this.hy; hb = this.hz; }
    else { up = f.ez; a = f.ex; b = f.ey; hu = this.hz; ha = this.hx; hb = this.hy; }
    if (Math.abs(up[1]) < 0.985) return null;   // inclinada: sigue dinámica
    const yaw = Math.atan2(-a[2], a[0]);
    const idx = w.addBox(f.x, f.y, f.z, ha + PR, hu + PR, hb + PR, yaw);
    return w.boxes[idx];
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  Silla de oficina: asiento, respaldo y 5 patas con ruedas.
//  Partículas: 4 esquinas del asiento, 2 puntas del respaldo, 5 puntas de pata.
// ═════════════════════════════════════════════════════════════════════════════
export const CHAIR_SEAT_Y = 0.47;
export const CHAIR_LEG_R = 0.30;
export const CHAIR_LEG_Y = 0.05;

export class PropChair extends PropBase {
  constructor(world, x, z, yaw = 0, color = 0x5b8fd6, mass = 9) {
    super(world);
    this.kind = 'chair';
    this.color = color;
    this.wakeR = 0.95;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const SY = CHAIR_SEAT_Y;
    // asiento (frente = +Z local)
    this._addP(-0.23, SY, 0.22, 1.4, x, 0, z, c, s);
    this._addP(0.23, SY, 0.22, 1.4, x, 0, z, c, s);
    this._addP(0.23, SY, -0.22, 1.4, x, 0, z, c, s);
    this._addP(-0.23, SY, -0.22, 1.4, x, 0, z, c, s);
    // respaldo
    this._addP(-0.22, 0.98, -0.24, 0.5, x, 0, z, c, s);
    this._addP(0.22, 0.98, -0.24, 0.5, x, 0, z, c, s);
    // patas
    for (let k = 0; k < 5; k++) {
      const a = k * (Math.PI * 2 / 5) + 0.3;
      this._addP(Math.cos(a) * CHAIR_LEG_R, CHAIR_LEG_Y, Math.sin(a) * CHAIR_LEG_R, (mass - 6.6) / 5, x, 0, z, c, s);
    }
    // asiento rígido (6), respaldo atado al asiento (9), cada pata a las 4
    // esquinas del asiento (20) y en anillo (5): 40 en vez de 55
    this._linkAll([0, 1, 2, 3]);
    for (const b of [4, 5]) for (const k of [0, 1, 2, 3]) this._link(b, k);
    this._link(4, 5);
    for (let k = 6; k < 11; k++) { for (const q of [0, 1, 2, 3]) this._link(k, q); this._link(k, k === 10 ? 6 : k + 1); }
    this._ex = [0, 0, 0]; this._ey = [0, 0, 0]; this._ez = [0, 0, 0];
    world.bodies.push(this);
  }

  /** Marco con origen en el PISO bajo el centro del asiento. */
  frame(out) {
    const w = this.world, p = this.p;
    const ex = this._ex, ey = this._ey, ez = this._ez;
    ex[0] = (w.px[p[1]] - w.px[p[0]]) + (w.px[p[2]] - w.px[p[3]]);
    ex[1] = (w.py[p[1]] - w.py[p[0]]) + (w.py[p[2]] - w.py[p[3]]);
    ex[2] = (w.pz[p[1]] - w.pz[p[0]]) + (w.pz[p[2]] - w.pz[p[3]]);
    norm3(ex);
    let sx = 0, sy = 0, sz = 0, lx = 0, ly = 0, lz = 0;
    for (let k = 0; k < 4; k++) { sx += w.px[p[k]]; sy += w.py[p[k]]; sz += w.pz[p[k]]; }
    for (let k = 6; k < 11; k++) { lx += w.px[p[k]]; ly += w.py[p[k]]; lz += w.pz[p[k]]; }
    sx /= 4; sy /= 4; sz /= 4; lx /= 5; ly /= 5; lz /= 5;
    ey[0] = sx - lx; ey[1] = sy - ly; ey[2] = sz - lz;
    const d = ex[0] * ey[0] + ex[1] * ey[1] + ex[2] * ey[2];
    ey[0] -= ex[0] * d; ey[1] -= ex[1] * d; ey[2] -= ex[2] * d;
    norm3(ey);
    cross3(ex, ey, ez);
    out.x = sx - ey[0] * CHAIR_SEAT_Y; out.y = sy - ey[1] * CHAIR_SEAT_Y; out.z = sz - ey[2] * CHAIR_SEAT_Y;
    out.ex = ex; out.ey = ey; out.ez = ez;
    return out;
  }

  /** ¿Está parada? (el eje "arriba" apunta arriba) */
  get upright() {
    const f = this.frame(this._frame);
    return f.ey[1] > 0.7;
  }

  _sleepShape(w) {
    const f = this.frame(this._frame);
    if (f.ey[1] < 0.985) return null;
    const idx = w.addCylinder(f.x, f.z, 0.31, f.y, f.y + 0.96);
    return w.cyls[idx];
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  Sistema: altas, sueño y despertar
// ═════════════════════════════════════════════════════════════════════════════
export class PropSystem {
  constructor(world) {
    this.world = world;
    this.props = [];
    this._dirty = false;
    this.sleepAfter = 0.7;
    this._tmp = { x: 0, y: 0, z: 0 };
  }

  addBox(x, y, z, w, h, d, yaw, mass, color) {
    const P = new PropBox(this.world, x, y, z, w, h, d, yaw, mass, color);
    this.props.push(P);
    return P;
  }
  addChair(x, z, yaw, color) {
    const P = new PropChair(this.world, x, z, yaw, color);
    this.props.push(P);
    return P;
  }

  /** ¿Hay algún cuerpo despierto (ragdoll o prop) cerca del prop? */
  _someoneNear(P, cx, cy, cz) {
    const bodies = this.world.bodies;
    const r = P.wakeR;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (b === P) continue;
      let bx, bz, br;
      if (b.isProp) {
        // un prop despierto sólo despierta a otro si viene rápido Y a la misma
        // altura (un empujón de costado). Una caja que cae desde arriba NO lo
        // despierta: aterriza sobre su colisionador estático, que es la gracia.
        if (b.asleep || b.speed() < 0.9) continue;
        const c = b.center(this._tmp);
        if (Math.abs(c.y - cy) > 0.3) continue;
        bx = c.x; bz = c.z; br = Math.max(0.1, b.wakeR - 0.35);
      } else if (b.p) {
        bx = b.x; bz = b.z; br = 0.45;      // ragdoll: la cadera
        if (b.dead && b.deadT > 3) continue; // un muerto quieto no despierta a nadie
      } else continue;
      const dx = bx - cx, dz = bz - cz, rr = r + br;
      if (dx * dx + dz * dz < rr * rr) return true;
    }
    return false;
  }

  sleep(P) {
    const w = this.world;
    const shape = P._sleepShape(w);
    if (!shape) { P.restT = 0; return false; }
    P.staticObj = shape;
    P.asleep = true;
    P.savedIw = P.savedIw || new Float32Array(P.p.length);
    for (let k = 0; k < P.p.length; k++) {
      const i = P.p[k];
      P.savedIw[k] = w.iw[i];
      w.iw[i] = 0; w.vx[i] = 0; w.vy[i] = 0; w.vz[i] = 0;
    }
    return true;
  }

  wake(P, ix = 0, iy = 0, iz = 0) {
    if (!P.asleep) return;
    const w = this.world;
    P.asleep = false; P.restT = 0;
    if (P.staticObj) { P.staticObj.dead = true; P.staticObj = null; this._dirty = true; }
    for (let k = 0; k < P.p.length; k++) w.iw[P.p[k]] = P.savedIw[k];
    if (ix || iy || iz) P.impulse(ix, iy, iz);
    // lo que estaba apilado encima se despierta también (si no, flotaría)
    const c = P.center(this._tmp);
    const cx = c.x, cy = c.y, cz = c.z;
    for (const O of this.props) {
      if (O === P || !O.alive || !O.asleep) continue;
      const oc = O.center(this._tmp);
      if (oc.y < cy + 0.05) continue;
      const dx = oc.x - cx, dz = oc.z - cz, rr = P.wakeR + 0.1;
      if (dx * dx + dz * dz < rr * rr) this.wake(O);
    }
  }

  /** Despierta todo lo que haya en un radio (explosión, disparo, empujón). */
  wakeNear(x, z, r, ix = 0, iy = 0, iz = 0) {
    for (const P of this.props) {
      if (!P.alive || !P.asleep) continue;
      const c = P.center(this._tmp);
      const dx = c.x - x, dz = c.z - z, rr = r + P.wakeR;
      if (dx * dx + dz * dz < rr * rr) this.wake(P, ix, iy, iz);
    }
  }

  /** El prop que contiene un colisionador estático (para saber a qué le pegó un tiro). */
  propOfStatic(obj) {
    for (const P of this.props) if (P.asleep && P.staticObj === obj) return P;
    return null;
  }

  update(dt) {
    const w = this.world;
    for (const P of this.props) {
      if (!P.alive) continue;
      const c = P.center(this._tmp);
      if (P.asleep) {
        if (this._someoneNear(P, c.x, c.y, c.z)) this.wake(P);
        continue;
      }
      if (c.y < w.killY + 1) { P.dispose(); continue; }
      if (P.speed() < 0.06) P.restT += dt; else P.restT = 0;
      if (P.restT > this.sleepAfter && !this._someoneNear(P, c.x, c.y, c.z)) this.sleep(P);
    }
    if (this._dirty) {
      w.boxes = w.boxes.filter(b => !b.dead);
      w.cyls = w.cyls.filter(cy => !cy.dead);
      w._staticDirty = true;
      this._dirty = false;
    }
  }

  get awakeCount() { let n = 0; for (const P of this.props) if (P.alive && !P.asleep) n++; return n; }

  clear() {
    for (const P of this.props) if (P.alive) P.dispose();
    this.props.length = 0;
    this.world.boxes = this.world.boxes.filter(b => !b.dead);
    this.world.cyls = this.world.cyls.filter(c => !c.dead);
    this.world._staticDirty = true;
  }
}
