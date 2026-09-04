// ─────────────────────────────────────────────────────────────────────────────
//  fx.js — Sangre, despojos, casquillos, chispas, humo y manchas.
//
//  Estos no van al motor XPBD: son cosméticos y son muchos. Tienen su propio
//  integrador de 10 líneas y viven en arrays planos. Lo único fino: una gota
//  de sangre que aterriza deja una mancha en el piso, así que la sangre
//  realmente vuela y realmente cae donde la mandaste.
// ─────────────────────────────────────────────────────────────────────────────

import * as THREE from 'three';
import { rnd, clamp01 } from '../core/util.js';

const MAXD = 2400;   // despojos
const MAXG = 900;    // brillos
const MAXK = 700;    // manchas

// tipos de despojo
const D_BLOOD = 0, D_GORE = 1, D_SHELL = 2, D_DEBRIS = 3;

export class FX {
  constructor(scene, world) {
    this.world = world;
    this.scene = scene;

    // ── despojos: sólidos, con física propia ───────────────────────────────
    const dgeo = new THREE.IcosahedronGeometry(1, 0);
    this.debris = new THREE.InstancedMesh(dgeo, new THREE.MeshLambertMaterial({ flatShading: true }), MAXD);
    this.debris.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.debris.castShadow = false;
    this.debris.frustumCulled = false;
    this.debris.count = 0;
    this.debris.setColorAt(0, new THREE.Color());
    scene.add(this.debris);

    this.dx = new Float32Array(MAXD); this.dy = new Float32Array(MAXD); this.dz = new Float32Array(MAXD);
    this.dvx = new Float32Array(MAXD); this.dvy = new Float32Array(MAXD); this.dvz = new Float32Array(MAXD);
    this.dr = new Float32Array(MAXD);       // radio
    this.dl = new Float32Array(MAXD);       // vida restante
    this.dl0 = new Float32Array(MAXD);      // vida inicial
    this.dc = new Float32Array(MAXD * 3);   // color
    this.dt = new Uint8Array(MAXD);         // tipo
    this.dsp = new Float32Array(MAXD);      // giro
    this.dn = 0;

    // ── brillos: aditivos, sin escribir profundidad ────────────────────────
    const ggeo = new THREE.IcosahedronGeometry(1, 0);
    this.glow = new THREE.InstancedMesh(ggeo, new THREE.MeshBasicMaterial({
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 1,
    }), MAXG);
    this.glow.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.glow.frustumCulled = false;
    this.glow.renderOrder = 5;
    this.glow.count = 0;
    this.glow.setColorAt(0, new THREE.Color());
    scene.add(this.glow);

    this.gx = new Float32Array(MAXG); this.gy = new Float32Array(MAXG); this.gz = new Float32Array(MAXG);
    this.gvx = new Float32Array(MAXG); this.gvy = new Float32Array(MAXG); this.gvz = new Float32Array(MAXG);
    this.gr = new Float32Array(MAXG); this.ggr = new Float32Array(MAXG);   // radio, crecimiento
    this.gl = new Float32Array(MAXG); this.gl0 = new Float32Array(MAXG);
    this.gc = new Float32Array(MAXG * 3);
    this.ggrav = new Float32Array(MAXG);
    this.gn = 0;

    // ── manchas en el piso ──────────────────────────────────────────────────
    this.decalTex = makeSplatTexture();
    this.decals = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshLambertMaterial({
        map: this.decalTex, transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      }), MAXK);
    this.decals.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.decals.frustumCulled = false;
    this.decals.renderOrder = 2;
    this.decals.count = 0;
    this.decals.setColorAt(0, new THREE.Color());
    scene.add(this.decals);
    this.kn = 0;
    this.kHead = 0;
    this._kmat = [];
    for (let i = 0; i < MAXK; i++) this._kmat.push(new THREE.Matrix4());
    this.kc = new Float32Array(MAXK * 3);

    // ── trazadoras ──────────────────────────────────────────────────────────
    this.tracer = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }),
      64);
    this.tracer.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.tracer.frustumCulled = false;
    this.tracer.renderOrder = 6;
    this.tracer.count = 0;
    this.tracer.setColorAt(0, new THREE.Color());
    scene.add(this.tracer);
    this.tr = [];

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._col = new THREE.Color();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  // ═══ altas ════════════════════════════════════════════════════════════════
  _pushD(x, y, z, vx, vy, vz, r, life, cr, cg, cb, type) {
    let i;
    if (this.dn < MAXD) i = this.dn++;
    else { i = (this._dcursor = ((this._dcursor | 0) + 1) % MAXD); }
    this.dx[i] = x; this.dy[i] = y; this.dz[i] = z;
    this.dvx[i] = vx; this.dvy[i] = vy; this.dvz[i] = vz;
    this.dr[i] = r; this.dl[i] = life; this.dl0[i] = life;
    this.dc[i * 3] = cr; this.dc[i * 3 + 1] = cg; this.dc[i * 3 + 2] = cb;
    this.dt[i] = type; this.dsp[i] = (rnd() - 0.5) * 22;
    return i;
  }
  _pushG(x, y, z, vx, vy, vz, r, grow, life, cr, cg, cb, grav = 0) {
    let i;
    if (this.gn < MAXG) i = this.gn++;
    else { i = (this._gcursor = ((this._gcursor | 0) + 1) % MAXG); }
    this.gx[i] = x; this.gy[i] = y; this.gz[i] = z;
    this.gvx[i] = vx; this.gvy[i] = vy; this.gvz[i] = vz;
    this.gr[i] = r; this.ggr[i] = grow; this.gl[i] = life; this.gl0[i] = life;
    this.gc[i * 3] = cr; this.gc[i * 3 + 1] = cg; this.gc[i * 3 + 2] = cb;
    this.ggrav[i] = grav;
    return i;
  }

  /** Mancha en el piso, orientada según la normal de la superficie. */
  splat(x, y, z, radius, cr, cg, cb, nx = 0, ny = 1, nz = 0) {
    const i = this.kHead;
    this.kHead = (this.kHead + 1) % MAXK;
    if (this.kn < MAXK) this.kn++;
    const m = this._kmat[i];
    this._v.set(nx, ny, nz);
    this._q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this._v);
    const spin = new THREE.Quaternion().setFromAxisAngle(this._v, rnd() * Math.PI * 2);
    this._q.premultiply(spin);
    const sx = radius * (0.75 + rnd() * 0.55), sy = radius * (0.75 + rnd() * 0.55);
    m.compose(
      this._v.set(x + nx * 0.014, y + ny * 0.014, z + nz * 0.014),
      this._q, this._s.set(sx, sy, 1)
    );
    this.kc[i * 3] = cr; this.kc[i * 3 + 1] = cg; this.kc[i * 3 + 2] = cb;
    this._kdirty = true;
  }

  // ═══ efectos compuestos ═══════════════════════════════════════════════════
  /** Chorro de sangre en la dirección de entrada del disparo. */
  bloodSpray(x, y, z, dx, dy, dz, power = 1) {
    const n = 6 + (power * 9) | 0;
    for (let i = 0; i < n; i++) {
      const sp = (2.4 + rnd() * 7) * power;
      const j = 0.55;
      this._pushD(x, y, z,
        (dx + (rnd() - 0.5) * j) * sp,
        (dy + (rnd() - 0.5) * j) * sp + rnd() * 2.6,
        (dz + (rnd() - 0.5) * j) * sp,
        0.020 + rnd() * 0.032, 2.6 + rnd() * 1.8,
        0.30 + rnd() * 0.14, 0.014, 0.020, D_BLOOD);
    }
    // niebla roja corta
    for (let i = 0; i < 3; i++) {
      this._pushG(x, y, z, dx * 1.4 + (rnd() - .5), dy * 1.4 + rnd(), dz * 1.4 + (rnd() - .5),
        0.07 + rnd() * 0.08, 1.6, 0.14, 0.30, 0.03, 0.04);
    }
  }

  /** Pedazos de carne cuando se corta un miembro. */
  goreBurst(x, y, z, power = 1) {
    for (let i = 0; i < 16 * power; i++) {
      const a = rnd() * Math.PI * 2, e = rnd() * 1.5;
      const sp = 2 + rnd() * 7;
      this._pushD(x, y, z,
        Math.cos(a) * Math.cos(e) * sp, Math.sin(e) * sp + 2.5, Math.sin(a) * Math.cos(e) * sp,
        0.035 + rnd() * 0.075, 5 + rnd() * 4,
        0.26 + rnd() * 0.16, 0.030 + rnd() * 0.03, 0.030, D_GORE);
    }
    for (let i = 0; i < 8; i++) {
      const a = rnd() * Math.PI * 2;
      this._pushD(x, y, z, Math.cos(a) * 5 * rnd(), rnd() * 5, Math.sin(a) * 5 * rnd(),
        0.018 + rnd() * 0.026, 3, 0.34, 0.02, 0.024, D_BLOOD);
    }
    this.splat(x, 0.001, z, 0.9 + rnd() * 0.7, 0.20, 0.012, 0.016);
  }

  /** Polvo y esquirlas al pegarle a una pared. */
  impact(x, y, z, nx, ny, nz, cr = 0.42, cg = 0.40, cb = 0.37) {
    for (let i = 0; i < 7; i++) {
      const sp = 1.5 + rnd() * 5;
      this._pushD(x, y, z,
        (nx + (rnd() - .5) * 1.3) * sp, (ny + (rnd() - .5) * 1.3) * sp + 1.5, (nz + (rnd() - .5) * 1.3) * sp,
        0.016 + rnd() * 0.03, 1.6 + rnd(), cr, cg, cb, D_DEBRIS);
    }
    for (let i = 0; i < 3; i++) {
      this._pushG(x + nx * .05, y + ny * .05, z + nz * .05,
        nx * 1.2 + (rnd() - .5), ny * 1.2 + rnd() * 0.6, nz * 1.2 + (rnd() - .5),
        0.06, 1.9, 0.22, 0.40, 0.36, 0.30);
    }
    this.splat(x, y, z, 0.16 + rnd() * 0.12, 0.16, 0.15, 0.14, nx, ny, nz);
  }

  /** Chispas: metal, o el fogonazo mismo. */
  sparks(x, y, z, dx, dy, dz, n = 10, cr = 1.0, cg = 0.72, cb = 0.30) {
    for (let i = 0; i < n; i++) {
      const sp = 3 + rnd() * 12;
      this._pushG(x, y, z,
        (dx + (rnd() - .5) * 1.1) * sp, (dy + (rnd() - .5) * 1.1) * sp + 1.6, (dz + (rnd() - .5) * 1.1) * sp,
        0.020 + rnd() * 0.022, -0.6, 0.16 + rnd() * 0.22, cr, cg, cb, 16);
    }
  }

  /** Fogonazo del caño. */
  muzzle(x, y, z, dx, dy, dz, power = 1) {
    this._pushG(x + dx * 0.16, y + dy * 0.16, z + dz * 0.16, dx * 3, dy * 3, dz * 3,
      0.062 * power, -1.4, 0.045, 1.0, 0.82, 0.45);
    this._pushG(x + dx * 0.34, y + dy * 0.34, z + dz * 0.34, dx * 6, dy * 6, dz * 6,
      0.045 * power, 1.6, 0.06, 1.0, 0.62, 0.22);
    this.sparks(x + dx * 0.3, y + dy * 0.3, z + dz * 0.3, dx, dy, dz, 3 + (power * 4) | 0);
    for (let i = 0; i < 2 * power; i++) {
      this._pushG(x + dx * 0.5, y + dy * 0.5, z + dz * 0.5,
        dx * 2.2 + (rnd() - .5), dy * 2 + rnd() * .6, dz * 2.2 + (rnd() - .5),
        0.07, 1.5, 0.34, 0.20, 0.19, 0.18, -0.6);
    }
  }

  /** Casquillo que sale por la ventana de expulsión y tintinea en el piso. */
  shell(x, y, z, dx, dz, size = 1) {
    this._pushD(x, y, z, dx * (2 + rnd() * 2), 2.4 + rnd() * 1.6, dz * (2 + rnd() * 2),
      0.019 * size, 9, 0.62, 0.48, 0.16, D_SHELL);
  }

  /** Trazadora: una línea que dura un suspiro. */
  tracerLine(x0, y0, z0, x1, y1, z1, w = 0.014, cr = 1, cg = 0.86, cb = 0.55) {
    if (this.tr.length >= 60) this.tr.shift();
    this.tr.push({ x0, y0, z0, x1, y1, z1, w, cr, cg, cb, t: 0.055, t0: 0.055 });
  }

  /** Humo persistente (barril, motor). */
  smoke(x, y, z, n = 1, r = 0.2) {
    for (let i = 0; i < n; i++) {
      this._pushG(x + (rnd() - .5) * r, y, z + (rnd() - .5) * r,
        (rnd() - .5) * 0.3, 0.5 + rnd() * 0.6, (rnd() - .5) * 0.3,
        r * 0.9, 0.55, 1.8 + rnd(), 0.09, 0.085, 0.09, -0.35);
    }
  }

  // ═══ paso ═════════════════════════════════════════════════════════════════
  update(dt) {
    const w = this.world;
    const gY = w ? w.groundY : 0;
    const hx = w ? w.groundHX : 60, hz = w ? w.groundHZ : 60;

    // ── despojos ───────────────────────────────────────────────────────────
    for (let i = 0; i < this.dn; i++) {
      if (this.dl[i] <= 0) continue;
      this.dl[i] -= dt;
      if (this.dl[i] <= 0) continue;
      const drag = this.dt[i] === D_BLOOD ? 0.55 : 0.30;
      const k = 1 - drag * dt;
      this.dvx[i] *= k; this.dvz[i] *= k;
      this.dvy[i] = this.dvy[i] * k - 26 * dt;
      this.dx[i] += this.dvx[i] * dt;
      this.dy[i] += this.dvy[i] * dt;
      this.dz[i] += this.dvz[i] * dt;
      const r = this.dr[i];
      if (this.dy[i] - r < gY) {
        const inside = this.dx[i] > -hx && this.dx[i] < hx && this.dz[i] > -hz && this.dz[i] < hz;
        if (inside) {
          if (this.dt[i] === D_BLOOD) {
            // la gota aterriza → mancha, y desaparece
            this.splat(this.dx[i], gY, this.dz[i], 0.10 + r * 7 + rnd() * 0.16,
              this.dc[i * 3] * 0.72, this.dc[i * 3 + 1] * 0.7, this.dc[i * 3 + 2] * 0.7);
            this.dl[i] = 0;
            continue;
          }
          this.dy[i] = gY + r;
          this.dvy[i] = -this.dvy[i] * (this.dt[i] === D_SHELL ? 0.36 : 0.22);
          this.dvx[i] *= 0.62; this.dvz[i] *= 0.62;
          this.dsp[i] *= 0.5;
          if (this.dt[i] === D_GORE && rnd() < 0.5) {
            this.splat(this.dx[i], gY, this.dz[i], 0.16 + rnd() * 0.2, 0.20, 0.014, 0.018);
          }
        } else if (this.dy[i] < gY - 40) { this.dl[i] = 0; }
      }
    }

    // ── brillos ────────────────────────────────────────────────────────────
    for (let i = 0; i < this.gn; i++) {
      if (this.gl[i] <= 0) continue;
      this.gl[i] -= dt;
      if (this.gl[i] <= 0) continue;
      const k = 1 - 2.4 * dt;
      this.gvx[i] *= k; this.gvz[i] *= k;
      this.gvy[i] = this.gvy[i] * k - this.ggrav[i] * dt;
      this.gx[i] += this.gvx[i] * dt;
      this.gy[i] += this.gvy[i] * dt;
      this.gz[i] += this.gvz[i] * dt;
      this.gr[i] = Math.max(0.001, this.gr[i] + this.ggr[i] * dt * this.gr[i]);
    }

    // ── trazadoras ─────────────────────────────────────────────────────────
    for (let i = this.tr.length - 1; i >= 0; i--) {
      this.tr[i].t -= dt;
      if (this.tr[i].t <= 0) this.tr.splice(i, 1);
    }

    this._buildInstances();
  }

  _buildInstances() {
    const m = this._m, q = this._q, e = this._e, v = this._v, s = this._s, col = this._col;

    // despojos
    let n = 0;
    for (let i = 0; i < this.dn; i++) {
      if (this.dl[i] <= 0) continue;
      const t = clamp01(this.dl[i] / this.dl0[i]);
      const grow = this.dt[i] === D_BLOOD ? 1 : (0.35 + t * 0.65);
      const r = this.dr[i] * grow;
      e.set(this.dx[i] * this.dsp[i], this.dy[i] * this.dsp[i], this.dz[i] * this.dsp[i]);
      q.setFromEuler(e);
      const st = this.dt[i] === D_SHELL ? 2.4 : 1;
      m.compose(v.set(this.dx[i], this.dy[i], this.dz[i]), q, s.set(r, r * st, r));
      this.debris.setMatrixAt(n, m);
      const f = this.dt[i] === D_BLOOD ? 1 : (0.55 + t * 0.45);
      col.setRGB(this.dc[i * 3] * f, this.dc[i * 3 + 1] * f, this.dc[i * 3 + 2] * f);
      this.debris.setColorAt(n, col);
      n++;
    }
    this.debris.count = n;
    this.debris.instanceMatrix.needsUpdate = true;
    if (this.debris.instanceColor) this.debris.instanceColor.needsUpdate = true;

    // brillos
    n = 0;
    q.identity();
    for (let i = 0; i < this.gn; i++) {
      if (this.gl[i] <= 0) continue;
      const t = clamp01(this.gl[i] / this.gl0[i]);
      const r = this.gr[i];
      m.compose(v.set(this.gx[i], this.gy[i], this.gz[i]), q, s.set(r, r, r));
      this.glow.setMatrixAt(n, m);
      const f = t * t;
      col.setRGB(this.gc[i * 3] * f, this.gc[i * 3 + 1] * f, this.gc[i * 3 + 2] * f);
      this.glow.setColorAt(n, col);
      n++;
    }
    this.glow.count = n;
    this.glow.instanceMatrix.needsUpdate = true;
    if (this.glow.instanceColor) this.glow.instanceColor.needsUpdate = true;

    // manchas
    if (this._kdirty) {
      for (let i = 0; i < this.kn; i++) {
        this.decals.setMatrixAt(i, this._kmat[i]);
        col.setRGB(this.kc[i * 3], this.kc[i * 3 + 1], this.kc[i * 3 + 2]);
        this.decals.setColorAt(i, col);
      }
      this.decals.count = this.kn;
      this.decals.instanceMatrix.needsUpdate = true;
      if (this.decals.instanceColor) this.decals.instanceColor.needsUpdate = true;
      this._kdirty = false;
    }

    // trazadoras
    n = 0;
    for (const T of this.tr) {
      const dx = T.x1 - T.x0, dy = T.y1 - T.y0, dz = T.z1 - T.z0;
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-4) continue;
      v.set(dx / len, dy / len, dz / len);
      q.setFromUnitVectors(this._up, v);
      const f = T.t / T.t0;
      m.compose(v.set((T.x0 + T.x1) / 2, (T.y0 + T.y1) / 2, (T.z0 + T.z1) / 2), q,
        s.set(T.w * f, len, T.w * f));
      this.tracer.setMatrixAt(n, m);
      col.setRGB(T.cr * f, T.cg * f, T.cb * f);
      this.tracer.setColorAt(n, col);
      n++;
    }
    this.tracer.count = n;
    this.tracer.instanceMatrix.needsUpdate = true;
    if (this.tracer.instanceColor) this.tracer.instanceColor.needsUpdate = true;
  }

  clear() {
    this.dn = 0; this.gn = 0; this.kn = 0; this.kHead = 0;
    this.dl.fill(0); this.gl.fill(0);
    this.tr.length = 0;
    this.debris.count = 0; this.glow.count = 0; this.decals.count = 0; this.tracer.count = 0;
    this._kdirty = true;
  }
}

// ── textura de salpicadura, dibujada a mano en un canvas ─────────────────────
function makeSplatTexture(size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.clearRect(0, 0, size, size);
  const cx = size / 2, cy = size / 2;

  const blob = (x, y, r, a) => {
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, `rgba(255,255,255,${a})`);
    grd.addColorStop(0.55, `rgba(255,255,255,${a * 0.85})`);
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.beginPath();
    // borde irregular: un círculo con ruido angular
    const N = 22;
    for (let i = 0; i <= N; i++) {
      const t = (i / N) * Math.PI * 2;
      const rr = r * (0.62 + Math.random() * 0.42);
      const px = x + Math.cos(t) * rr, py = y + Math.sin(t) * rr;
      if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.closePath();
    g.fill();
  };

  blob(cx, cy, size * 0.30, 0.95);
  for (let i = 0; i < 9; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = size * (0.16 + Math.random() * 0.26);
    blob(cx + Math.cos(a) * d, cy + Math.sin(a) * d, size * (0.04 + Math.random() * 0.11), 0.8);
  }
  for (let i = 0; i < 22; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = size * (0.24 + Math.random() * 0.24);
    g.fillStyle = `rgba(255,255,255,${0.5 + Math.random() * 0.4})`;
    g.beginPath();
    g.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, size * (0.006 + Math.random() * 0.02), 0, 7);
    g.fill();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
