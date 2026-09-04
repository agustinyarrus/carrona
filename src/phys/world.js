// ─────────────────────────────────────────────────────────────────────────────
//  world.js — Motor de física XPBD (Extended Position Based Dynamics)
//
//  Diseño:
//   · Todo en Float32Array/Int32Array planos (SoA). Cero objetos por partícula.
//   · Substepping al estilo "Small Steps in Physics Simulation" (Müller 2020):
//     muchos pasos chicos con UNA iteración de restricciones cada uno. Sale
//     mucho más rígido y estable que pocos pasos con muchas iteraciones.
//   · Restricciones de distancia con compliance (rigidez real, no un hack).
//   · Fricción posicional en los contactos → los pies agarran el piso.
//   · Despenetración acotada: un solapamiento profundo se resuelve de a poco en
//     vez de disparar el cuerpo a 100 m/s. Además la energía nunca crece por
//     un contacto.
//   · Broadphase de partículas con hash espacial (tabla chica, no grilla densa).
//   · Broadphase de estáticos con grilla XZ construida una vez por nivel.
//
//  Unidades: metros, segundos, kilos.
// ─────────────────────────────────────────────────────────────────────────────

export const CT_DIST = 0;  // igualdad:  |a-b| == rest
export const CT_MIN  = 1;  // mínimo:    |a-b| >= rest
export const CT_MAX  = 2;  // máximo:    |a-b| <= rest

const MAX_P = 6144;
const MAX_C = 24576;
const MAX_B = 3072;

const HASH_BITS = 14;
const HASH_SIZE = 1 << HASH_BITS;          // 16384 baldes
const HASH_MASK = HASH_SIZE - 1;

// flags de partícula
export const PF_ALIVE  = 1 << 0;
export const PF_GROUND = 1 << 1;  // tocó piso este substep
export const PF_NOCOLL = 1 << 2;  // ignora colisión partícula-partícula
export const PF_HIT    = 1 << 3;  // tocó cualquier cosa este substep

/** Hash espacial de 3 enteros → balde. Math.imul para que sea entero de 32 bits. */
function cellHash(gx, gy, gz) {
  return (Math.imul(gx, 92837111) ^ Math.imul(gy, 689287499) ^ Math.imul(gz, 283923481)) & HASH_MASK;
}

export class PhysWorld {
  constructor() {
    // ── partículas ──────────────────────────────────────────────────────────
    this.px = new Float32Array(MAX_P); this.py = new Float32Array(MAX_P); this.pz = new Float32Array(MAX_P);
    this.vx = new Float32Array(MAX_P); this.vy = new Float32Array(MAX_P); this.vz = new Float32Array(MAX_P);
    this.qx = new Float32Array(MAX_P); this.qy = new Float32Array(MAX_P); this.qz = new Float32Array(MAX_P);
    this.kx = new Float32Array(MAX_P); this.ky = new Float32Array(MAX_P); this.kz = new Float32Array(MAX_P);
    this.iw = new Float32Array(MAX_P);   // masa inversa (0 = estático)
    this.pr = new Float32Array(MAX_P);   // radio de colisión
    this.pg = new Int32Array(MAX_P);     // grupo (id de cuerpo) para filtrar auto-colisión
    this.pf = new Uint8Array(MAX_P);     // flags
    this.pd = new Float32Array(MAX_P);   // drag extra por partícula
    this.pOwner = new Array(MAX_P).fill(null);   // cuerpo dueño (para saber si tiene músculo)
    this.pn = 0;
    this.pFree = [];
    this.maxRadius = 0.2;

    // ── restricciones de distancia ──────────────────────────────────────────
    this.ca = new Int32Array(MAX_C); this.cb = new Int32Array(MAX_C);
    this.crest = new Float32Array(MAX_C);
    this.ccomp = new Float32Array(MAX_C);  // compliance (m/N). 0 = rígido
    this.ctype = new Uint8Array(MAX_C);
    this.calive = new Uint8Array(MAX_C);
    this.cn = 0;
    this.cDead = 0;

    // ── huesos (segmentos con radio: render + raycast) ──────────────────────
    this.bA = new Int32Array(MAX_B); this.bB = new Int32Array(MAX_B);
    this.br = new Float32Array(MAX_B);
    this.bhp = new Float32Array(MAX_B);
    this.bbody = new Array(MAX_B).fill(null);
    this.balive = new Uint8Array(MAX_B);
    this.bmeta = new Int32Array(MAX_B);
    this.bn = 0;
    this.bDead = 0;

    // ── colisionadores estáticos ────────────────────────────────────────────
    this.boxes = [];      // {cx,cy,cz,hx,hy,hz,c,s}  (yaw estilo Three)
    this.cyls = [];       // {cx,cz,r,y0,y1}
    this.groundY = 0;
    this.groundHX = 40;   // media extensión de la losa del lugarcito
    this.groundHZ = 40;
    this.killY = -30;

    // índice XZ de estáticos (se arma una vez por nivel)
    this.sCell = 2.5;
    this.sMinX = 0; this.sMinZ = 0; this.sGW = 1; this.sGD = 1;
    this.sStart = new Int32Array(2);
    this.sItems = new Int32Array(0);
    this.sMargin = 0.42;   // radio máximo de partícula soportado por el índice
    this._staticDirty = false;

    // ── parámetros ──────────────────────────────────────────────────────────
    // Gravedad un poco por encima de la real (9.8): con la escala del muñeco
    // y la cámara lejos, la real se ve flotante. El aire frena poco: un
    // cuerpo lanzado vuela como cuerpo, no como si estuviera bajo el agua.
    this.gravity = -16.0;
    this.substeps = 7;
    this.frictionS = 0.92;
    this.airDrag = 0.10;
    this.maxSpeed = 90;
    this.maxDepen = 0.008;   // despenetración extra permitida por substep (m)
    this.maxGain = 1.0;      // cuánto puede crecer |v| por substep por contacto (m/s), cuerpo activo
    // Un cuerpo SIN músculo (muerto, tirado, caja) no puede ser acelerado por
    // contactos más que esto: si no, un corredor cinemático que pasa por
    // encima de un cuerpo tirado lo dispara a 60 m (fuerza muscular infinita).
    this.maxGainLimp = 0.10;
    this.restitution = 0.0;  // 0 = carne: no rebota

    // ── broadphase de partículas (hash) ─────────────────────────────────────
    this.cell = 0.55;
    this.hCount = new Int32Array(HASH_SIZE + 1);
    this.hItems = new Int32Array(MAX_P);
    this.hKeys = new Int32Array(MAX_P);
    this.hCursor = new Int32Array(HASH_SIZE);
    this._seen = new Int32Array(32);

    this.bodies = [];
    this.stats = { particles: 0, constraints: 0, bones: 0, pairs: 0 };
  }

  // ═══ partículas ═══════════════════════════════════════════════════════════
  addParticle(x, y, z, mass, radius, group, drag = 0) {
    let i;
    if (this.pFree.length) i = this.pFree.pop();
    else { if (this.pn >= MAX_P) return -1; i = this.pn++; }
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.qx[i] = x; this.qy[i] = y; this.qz[i] = z;
    this.vx[i] = 0; this.vy[i] = 0; this.vz[i] = 0;
    this.iw[i] = mass > 0 ? 1 / mass : 0;
    this.pr[i] = radius; this.pg[i] = group; this.pf[i] = PF_ALIVE; this.pd[i] = drag;
    if (radius > this.maxRadius) this.maxRadius = radius;
    return i;
  }
  removeParticle(i) {
    if (i < 0 || !(this.pf[i] & PF_ALIVE)) return;
    this.pf[i] = 0; this.iw[i] = 0; this.pOwner[i] = null;
    this.pFree.push(i);
  }
  setOwner(i, body) { this.pOwner[i] = body; }
  setMass(i, m) { this.iw[i] = m > 0 ? 1 / m : 0; }
  addImpulse(i, ix, iy, iz) {
    const w = this.iw[i];
    if (w === 0) return;
    this.vx[i] += ix * w; this.vy[i] += iy * w; this.vz[i] += iz * w;
  }
  setPos(i, x, y, z) { this.px[i] = x; this.py[i] = y; this.pz[i] = z; this.qx[i] = x; this.qy[i] = y; this.qz[i] = z; }

  // ═══ restricciones ════════════════════════════════════════════════════════
  addConstraint(a, b, rest, compliance = 0, type = CT_DIST) {
    if (this.cn >= MAX_C) return -1;
    const i = this.cn++;
    this.ca[i] = a; this.cb[i] = b; this.crest[i] = rest;
    this.ccomp[i] = compliance; this.ctype[i] = type; this.calive[i] = 1;
    return i;
  }
  breakConstraint(i) { if (i >= 0 && this.calive[i]) { this.calive[i] = 0; this.cDead++; } }

  // ═══ huesos ═══════════════════════════════════════════════════════════════
  addBone(a, b, radius, hp, body, meta) {
    if (this.bn >= MAX_B) return -1;
    const i = this.bn++;
    this.bA[i] = a; this.bB[i] = b; this.br[i] = radius; this.bhp[i] = hp;
    this.bbody[i] = body; this.bmeta[i] = meta; this.balive[i] = 1;
    return i;
  }
  killBone(i) { if (i >= 0 && this.balive[i]) { this.balive[i] = 0; this.bbody[i] = null; this.bDead++; } }

  // ═══ estáticos ════════════════════════════════════════════════════════════
  /**
   * Caja rotada sólo en Y. Convención de yaw idéntica a la de Three.js: una
   * rotación positiva lleva el +X local a (cos, -sin) en el plano XZ. Sin esto
   * la malla y su colisionador quedan espejados y le errás a las paredes.
   */
  addBox(cx, cy, cz, hx, hy, hz, yaw = 0) {
    this.boxes.push({ cx, cy, cz, hx, hy, hz, c: Math.cos(yaw), s: -Math.sin(yaw) });
    this._staticDirty = true;
    return this.boxes.length - 1;
  }
  addCylinder(cx, cz, r, y0, y1) { this.cyls.push({ cx, cz, r, y0, y1 }); this._staticDirty = true; return this.cyls.length - 1; }
  clearStatics() { this.boxes.length = 0; this.cyls.length = 0; this.sItems = new Int32Array(0); this._staticDirty = false; }

  /**
   * Arma la grilla XZ de estáticos. Llamar UNA vez después de construir el nivel.
   * Cada colisionador se inserta en todas las celdas que toca su AABB dilatada,
   * así una consulta con una sola celda alcanza.
   */
  buildStaticIndex() {
    this._staticDirty = false;
    const n = this.boxes.length + this.cyls.length;
    const m = this.sMargin;
    if (n === 0) { this.sGW = this.sGD = 1; this.sStart = new Int32Array(2); this.sItems = new Int32Array(0); return; }
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const aabb = [];
    for (const B of this.boxes) {
      const ax = Math.abs(B.hx * B.c) + Math.abs(B.hz * B.s) + m;
      const az = Math.abs(B.hx * B.s) + Math.abs(B.hz * B.c) + m;
      aabb.push([B.cx - ax, B.cz - az, B.cx + ax, B.cz + az]);
    }
    for (const C of this.cyls) aabb.push([C.cx - C.r - m, C.cz - C.r - m, C.cx + C.r + m, C.cz + C.r + m]);
    for (const a of aabb) {
      if (a[0] < minX) minX = a[0]; if (a[1] < minZ) minZ = a[1];
      if (a[2] > maxX) maxX = a[2]; if (a[3] > maxZ) maxZ = a[3];
    }
    const cs = this.sCell;
    this.sMinX = minX; this.sMinZ = minZ;
    this.sGW = Math.max(1, Math.ceil((maxX - minX) / cs) + 1);
    this.sGD = Math.max(1, Math.ceil((maxZ - minZ) / cs) + 1);
    const nc = this.sGW * this.sGD;
    const count = new Int32Array(nc + 1);
    const cellOf = (x, z) => {
      const gx = Math.max(0, Math.min(this.sGW - 1, ((x - minX) / cs) | 0));
      const gz = Math.max(0, Math.min(this.sGD - 1, ((z - minZ) / cs) | 0));
      return gz * this.sGW + gx;
    };
    let total = 0;
    for (const a of aabb) {
      const x0 = Math.max(0, Math.min(this.sGW - 1, ((a[0] - minX) / cs) | 0));
      const x1 = Math.max(0, Math.min(this.sGW - 1, ((a[2] - minX) / cs) | 0));
      const z0 = Math.max(0, Math.min(this.sGD - 1, ((a[1] - minZ) / cs) | 0));
      const z1 = Math.max(0, Math.min(this.sGD - 1, ((a[3] - minZ) / cs) | 0));
      for (let gz = z0; gz <= z1; gz++) for (let gx = x0; gx <= x1; gx++) { count[gz * this.sGW + gx + 1]++; total++; }
    }
    for (let k = 0; k < nc; k++) count[k + 1] += count[k];
    const items = new Int32Array(total);
    const cur = count.slice(0, nc);
    for (let i = 0; i < aabb.length; i++) {
      const a = aabb[i];
      const x0 = Math.max(0, Math.min(this.sGW - 1, ((a[0] - minX) / cs) | 0));
      const x1 = Math.max(0, Math.min(this.sGW - 1, ((a[2] - minX) / cs) | 0));
      const z0 = Math.max(0, Math.min(this.sGD - 1, ((a[1] - minZ) / cs) | 0));
      const z1 = Math.max(0, Math.min(this.sGD - 1, ((a[3] - minZ) / cs) | 0));
      for (let gz = z0; gz <= z1; gz++) for (let gx = x0; gx <= x1; gx++) items[cur[gz * this.sGW + gx]++] = i;
    }
    this.sStart = count; this.sItems = items;
    this._cellOf = cellOf;
  }

  reset() {
    this.pn = 0; this.cn = 0; this.bn = 0;
    this.pFree.length = 0; this.cDead = 0; this.bDead = 0;
    this.bodies.length = 0;
    this.pf.fill(0); this.calive.fill(0); this.balive.fill(0);
    this.bbody.fill(null);
    this.maxRadius = 0.2;
    this.clearStatics();
  }

  // ═══ bucle principal ══════════════════════════════════════════════════════
  step(dt) {
    const S = this.substeps;
    const h = dt / S;
    const g = this.gravity;

    if (this._staticDirty) this.buildStaticIndex();
    this._buildGrid();

    for (let s = 0; s < S; s++) {
      // — integración —
      const dragK = 1 - this.airDrag * h;
      for (let i = 0; i < this.pn; i++) {
        if (!(this.pf[i] & PF_ALIVE) || this.iw[i] === 0) continue;
        let vx = this.vx[i], vy = this.vy[i], vz = this.vz[i];
        vy += g * h;
        const k = dragK - this.pd[i] * h;
        vx *= k; vy *= k; vz *= k;
        const sp2 = vx * vx + vy * vy + vz * vz;
        const mx = this.maxSpeed;
        if (sp2 > mx * mx) { const f = mx / Math.sqrt(sp2); vx *= f; vy *= f; vz *= f; }
        this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
        this.qx[i] = this.px[i]; this.qy[i] = this.py[i]; this.qz[i] = this.pz[i];
        this.px[i] += vx * h; this.py[i] += vy * h; this.pz[i] += vz * h;
        this.kx[i] = 0; this.ky[i] = 0; this.kz[i] = 0;
        this.pf[i] &= ~(PF_GROUND | PF_HIT);
      }

      // — motores de los cuerpos. Va DESPUES de integrar a propósito: en PBD la
      //   velocidad sale de (p - q)/h, así que una corrección aplicada antes de
      //   fijar q se pierde y la gravedad acumula caída sin nada que la frene.
      for (let bi = 0; bi < this.bodies.length; bi++) {
        const b = this.bodies[bi];
        if (b.preSolve) b.preSolve(h, this);
      }

      this._solveConstraints(h);

      for (let bi = 0; bi < this.bodies.length; bi++) {
        const b = this.bodies[bi];
        if (b.solve) b.solve(h, this);
      }

      // Las dos pasadas de colisión entre cuerpos se alternan por substep:
      // cada una corre a 240 Hz, que sobra para contactos posicionales, y
      // juntas cuestan la mitad. Piso y paredes van en todos los substeps.
      if (!(s & 1)) this._solveParticleCollisions();
      this._solveBoneParticles(s & 1);
      this._solveWorld();
      this._solveBoneWorld();
      this._clampDepenetration(h);

      // — velocidad desde el desplazamiento real, sin ganar energía —
      const invH = 1 / h;
      const gainA = this.maxGain, gainL = this.maxGainLimp;
      const pOwner = this.pOwner;
      for (let i = 0; i < this.pn; i++) {
        if (!(this.pf[i] & PF_ALIVE) || this.iw[i] === 0) continue;
        const own = pOwner[i];
        // sin dueño (pruebas, partículas sueltas) = activo; prop = intermedio
        // (una caja pateada sí sale volando); ragdoll sin músculo = inerte
        const active = !own || own.isProp || own.muscleGlobal > 0.05;
        const gain = !own ? gainA : own.isProp ? 0.3 : (own.muscleGlobal > 0.05 ? gainA : gainL);
        const ovx = this.vx[i], ovy = this.vy[i], ovz = this.vz[i];
        let nvx = (this.px[i] - this.qx[i]) * invH;
        let nvy = (this.py[i] - this.qy[i]) * invH;
        let nvz = (this.pz[i] - this.qz[i]) * invH;
        if (this.pf[i] & PF_HIT) {
          // Contacto inelástico. Frenar una caída SÍ debe cambiar la velocidad
          // (la corrección deshace el movimiento del substep), pero despegar dos
          // cuerpos ya solapados NO debe empujarlos: si no, cada substep suma
          // velocidad y termina disparándolos. Se anula la componente positiva
          // a lo largo de la corrección; la tangencial queda intacta.
          const kx = this.kx[i], ky = this.ky[i], kz = this.kz[i];
          const k2 = kx * kx + ky * ky + kz * kz;
          if (k2 > 1e-12) {
            const ik = 1 / Math.sqrt(k2);
            const nx = kx * ik, ny = ky * ik, nz = kz * ik;
            const vn = nvx * nx + nvy * ny + nvz * nz;
            if (vn > 0) {
              const e = vn * (1 - this.restitution);
              nvx -= nx * e; nvy -= ny * e; nvz -= nz * e;
            }
          }
          // red de contención: un contacto nunca amplifica la energía
          const oldSp = Math.sqrt(ovx * ovx + ovy * ovy + ovz * ovz);
          const newSp2 = nvx * nvx + nvy * nvy + nvz * nvz;
          const lim = oldSp + gain;
          if (newSp2 > lim * lim) {
            const f = lim / Math.sqrt(newSp2);
            nvx *= f; nvy *= f; nvz *= f;
          }
        }
        // un cuerpo sin músculo nunca va a más de 9 m/s: red de contención
        // contra el "bulldozer" (un cuerpo cinemático empujando a uno inerte)
        if (!active) {
          const sp2 = nvx * nvx + nvy * nvy + nvz * nvz;
          if (sp2 > 81) { const f = 9 / Math.sqrt(sp2); nvx *= f; nvy *= f; nvz *= f; }
        }
        this.vx[i] = nvx; this.vy[i] = nvy; this.vz[i] = nvz;
      }

      // — los cuerpos con músculo amortiguan su velocidad (PD, no resorte) —
      for (let bi = 0; bi < this.bodies.length; bi++) {
        const b = this.bodies[bi];
        if (b.postVelocity) b.postVelocity(h, this);
      }
    }

    for (let i = 0; i < this.pn; i++) {
      if ((this.pf[i] & PF_ALIVE) && this.py[i] < this.killY) this.pf[i] &= ~PF_ALIVE;
    }

    if (this.cDead > 512) this._compactConstraints();
    if (this.bDead > 256) this._compactBones();

    this.stats.particles = this.pn - this.pFree.length;
    this.stats.constraints = this.cn;
    this.stats.bones = this.bn;
  }

  /**
   * Un solapamiento profundo (spawn adentro de una pared, pila de cuerpos) no
   * puede resolverse de golpe: eso convierte metros de corrección en decenas de
   * m/s. Se permite deshacer el movimiento propio del substep + un extra chico.
   */
  _clampDepenetration(h) {
    const extra = this.maxDepen;
    for (let i = 0; i < this.pn; i++) {
      if (!(this.pf[i] & PF_HIT) || this.iw[i] === 0) continue;
      const kx = this.kx[i], ky = this.ky[i], kz = this.kz[i];
      const k2 = kx * kx + ky * ky + kz * kz;
      if (k2 < 1e-12) continue;
      // Tope = cuánto se movió la partícula ESTE substep antes de chocar (por
      // velocidad, por restricciones o por músculo) + un extra chico. Antes se
      // usaba la velocidad vieja: una partícula ya frenada contra la pared
      // sólo podía corregirse 8 mm por substep mientras sus vecinas la
      // arrastraban 3 cm, y en dos cuadros atravesaba la pared.
      const mx = (this.px[i] - kx) - this.qx[i], my = (this.py[i] - ky) - this.qy[i], mz = (this.pz[i] - kz) - this.qz[i];
      const maxK = Math.sqrt(mx * mx + my * my + mz * mz) + extra;
      if (k2 <= maxK * maxK) continue;
      const f = 1 - maxK / Math.sqrt(k2);
      this.px[i] -= kx * f; this.py[i] -= ky * f; this.pz[i] -= kz * f;
    }
  }

  // ── solver de distancia con compliance (XPBD) ────────────────────────────
  _solveConstraints(h) {
    const px = this.px, py = this.py, pz = this.pz, iw = this.iw;
    const h2 = h * h;
    for (let i = 0; i < this.cn; i++) {
      if (!this.calive[i]) continue;
      const a = this.ca[i], b = this.cb[i];
      const wa = iw[a], wb = iw[b];
      const w = wa + wb;
      if (w === 0) continue;
      const dx = px[b] - px[a], dy = py[b] - py[a], dz = pz[b] - pz[a];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < 1e-7) continue;
      const rest = this.crest[i];
      const t = this.ctype[i];
      const C = d - rest;
      if (t === CT_MIN) { if (C >= 0) continue; }
      else if (t === CT_MAX) { if (C <= 0) continue; }
      const alpha = this.ccomp[i] / h2;
      const lam = -C / (w + alpha);
      const s = lam / d;
      px[a] -= dx * s * wa; py[a] -= dy * s * wa; pz[a] -= dz * s * wa;
      px[b] += dx * s * wb; py[b] += dy * s * wb; pz[b] += dz * s * wb;
    }
  }

  // ── broadphase de partículas: hash espacial + counting sort ─────────────
  _buildGrid() {
    const inv = 1 / this.cell;
    const cc = this.hCount;
    cc.fill(0);
    const keys = this.hKeys;
    for (let i = 0; i < this.pn; i++) {
      if (!(this.pf[i] & PF_ALIVE) || (this.pf[i] & PF_NOCOLL) || this.iw[i] === 0) { keys[i] = -1; continue; }
      const k = cellHash(Math.floor(this.px[i] * inv), Math.floor(this.py[i] * inv), Math.floor(this.pz[i] * inv));
      keys[i] = k; cc[k + 1]++;
    }
    for (let k = 0; k < HASH_SIZE; k++) cc[k + 1] += cc[k];
    const cur = this.hCursor;
    cur.set(cc.subarray(0, HASH_SIZE));
    for (let i = 0; i < this.pn; i++) {
      const k = keys[i];
      if (k >= 0) this.hItems[cur[k]++] = i;
    }
  }

  _solveParticleCollisions() {
    const inv = 1 / this.cell;
    const cc = this.hCount, items = this.hItems;
    const px = this.px, py = this.py, pz = this.pz;
    const kx = this.kx, ky = this.ky, kz = this.kz;
    const iw = this.iw, pr = this.pr, pg = this.pg;
    const reach = this.maxRadius;
    const seen = this._seen;
    let pairs = 0;

    for (let i = 0; i < this.pn; i++) {
      if (this.hKeys[i] < 0) continue;
      const xi = px[i], yi = py[i], zi = pz[i];
      const ri = pr[i], wi = iw[i], gi = pg[i];
      const rr0 = ri + reach;                 // alcance máximo con cualquier vecino
      const x0 = Math.floor((xi - rr0) * inv), x1 = Math.floor((xi + rr0) * inv);
      const y0 = Math.floor((yi - rr0) * inv), y1 = Math.floor((yi + rr0) * inv);
      const z0 = Math.floor((zi - rr0) * inv), z1 = Math.floor((zi + rr0) * inv);
      let nseen = 0;
      for (let gy = y0; gy <= y1; gy++) {
        for (let gz = z0; gz <= z1; gz++) {
          for (let gx = x0; gx <= x1; gx++) {
            const k = cellHash(gx, gy, gz);
            // dos celdas distintas pueden caer en el mismo balde: no repetir
            let dup = false;
            for (let q = 0; q < nseen; q++) if (seen[q] === k) { dup = true; break; }
            if (dup) continue;
            if (nseen < seen.length) seen[nseen++] = k;
            const s0 = cc[k], s1 = cc[k + 1];
            for (let n = s0; n < s1; n++) {
              const j = items[n];
              if (j <= i) continue;
              if (pg[j] === gi) continue;
              const rr = ri + pr[j];
              const ex = px[j] - px[i], ey = py[j] - py[i], ez = pz[j] - pz[i];
              const d2 = ex * ex + ey * ey + ez * ez;
              if (d2 >= rr * rr || d2 < 1e-9) continue;
              const d = Math.sqrt(d2);
              const wj = iw[j], w = wi + wj;
              if (w === 0) continue;
              const corr = (rr - d) / d / w * 0.65;
              const ax = ex * corr * wi, ay = ey * corr * wi, az = ez * corr * wi;
              const bx = ex * corr * wj, by = ey * corr * wj, bz = ez * corr * wj;
              px[i] -= ax; py[i] -= ay; pz[i] -= az;
              px[j] += bx; py[j] += by; pz[j] += bz;
              kx[i] -= ax; ky[i] -= ay; kz[i] -= az;
              kx[j] += bx; ky[j] += by; kz[j] += bz;
              this.pf[i] |= PF_HIT; this.pf[j] |= PF_HIT;
              pairs++;
            }
          }
        }
      }
    }
    this.stats.pairs = pairs;
  }

  // ── huesos largos contra partículas ajenas (cápsula vs esfera) ──────────
  //  Las partículas de un cuerpo están a ~40 cm: una caja, una silla o el
  //  brazo de otro zombi se colaban entre la rodilla y el pie. Acá cada hueso
  //  largo busca partículas de OTROS grupos en la grilla y las aparta de su
  //  segmento, repartiendo la corrección entre sus dos extremos según dónde
  //  pegó. Con esto una pierna empuja una caja, un brazo se apoya en un
  //  torso, y un cuerpo que cae sobre otro no lo atraviesa.
  _solveBoneParticles(oddSubstep = 0) {
    const inv = 1 / this.cell;
    const cc = this.hCount, items = this.hItems;
    const px = this.px, py = this.py, pz = this.pz;
    const kx = this.kx, ky = this.ky, kz = this.kz;
    const iw = this.iw, pr = this.pr, pg = this.pg, pf = this.pf;
    const seen = this._seen;
    const reachP = this.maxRadius;
    for (let i = 0; i < this.bn; i++) {
      if (!this.balive[i]) continue;
      const body = this.bbody[i];
      // cerca del jugador: todos los substeps (una pierna tiene que poder
      // patear una caja antes de meterse adentro); más lejos: uno de cada dos;
      // muy lejos: nada
      if (body && body.lod > 0 && (body.lod > 1 || oddSubstep)) continue;
      const a = this.bA[i], b = this.bB[i];
      if (!(pf[a] & PF_ALIVE) || !(pf[b] & PF_ALIVE)) continue;
      const wa = iw[a], wb = iw[b];
      const ax = px[a], ay = py[a], az = pz[a];
      const ux = px[b] - ax, uy = py[b] - ay, uz = pz[b] - az;
      const len2 = ux * ux + uy * uy + uz * uz;
      if (len2 < 0.0625) continue;                 // < 25 cm: los extremos alcanzan
      const r = this.br[i] * 0.9;
      const ga = pg[a];
      // celdas que cubre la caja envolvente del segmento (no un cubo alrededor
      // del centro: un hueso vertical toca la mitad de celdas)
      const rr0 = r + reachP;
      const bx = px[b], by = py[b], bz = pz[b];
      const x0 = Math.floor(((ax < bx ? ax : bx) - rr0) * inv), x1 = Math.floor(((ax > bx ? ax : bx) + rr0) * inv);
      const y0 = Math.floor(((ay < by ? ay : by) - rr0) * inv), y1 = Math.floor(((ay > by ? ay : by) + rr0) * inv);
      const z0 = Math.floor(((az < bz ? az : bz) - rr0) * inv), z1 = Math.floor(((az > bz ? az : bz) + rr0) * inv);
      let nseen = 0;
      for (let gy = y0; gy <= y1; gy++) {
        for (let gz = z0; gz <= z1; gz++) {
          for (let gx = x0; gx <= x1; gx++) {
            const k = cellHash(gx, gy, gz);
            let dup = false;
            for (let q = 0; q < nseen; q++) if (seen[q] === k) { dup = true; break; }
            if (dup) continue;
            if (nseen < seen.length) seen[nseen++] = k;
            const s0 = cc[k], s1 = cc[k + 1];
            for (let n = s0; n < s1; n++) {
              const j = items[n];
              if (pg[j] === ga) continue;
              // punto del segmento más cercano a la partícula (sin los extremos:
              // de eso ya se ocupan las partículas del propio hueso)
              const wx = px[j] - ax, wy = py[j] - ay, wz = pz[j] - az;
              let t = (wx * ux + wy * uy + wz * uz) / len2;
              if (t < 0.15) t = 0.15; else if (t > 0.85) t = 0.85;
              const cx = ax + ux * t, cy = ay + uy * t, cz = az + uz * t;
              const ex = px[j] - cx, ey = py[j] - cy, ez = pz[j] - cz;
              const d2 = ex * ex + ey * ey + ez * ez;
              const rr = r + pr[j];
              if (d2 >= rr * rr || d2 < 1e-9) continue;
              const d = Math.sqrt(d2);
              const wj = iw[j];
              const wbone = wa * (1 - t) * (1 - t) + wb * t * t;
              const w = wj + wbone;
              if (w === 0) continue;
              const lam = (rr - d) * 0.9 / w / d;
              const nx = ex * lam, ny = ey * lam, nz = ez * lam;
              if (wj > 0) {
                px[j] += nx * wj; py[j] += ny * wj; pz[j] += nz * wj;
                kx[j] += nx * wj; ky[j] += ny * wj; kz[j] += nz * wj;
                pf[j] |= PF_HIT;
              }
              if (wa > 0) {
                const f = wa * (1 - t);
                px[a] -= nx * f; py[a] -= ny * f; pz[a] -= nz * f;
                kx[a] -= nx * f; ky[a] -= ny * f; kz[a] -= nz * f;
                pf[a] |= PF_HIT;
              }
              if (wb > 0) {
                const f = wb * t;
                px[b] -= nx * f; py[b] -= ny * f; pz[b] -= nz * f;
                kx[b] -= nx * f; ky[b] -= ny * f; kz[b] -= nz * f;
                pf[b] |= PF_HIT;
              }
            }
          }
        }
      }
    }
  }

  // ── colisión de UN punto (radio r) contra piso, cajas y cilindros ────────
  //  Escribe en `o` la posición corregida, la corrección acumulada (k*), si
  //  tocó algo, si está apoyado sobre algo y con qué profundidad (gm, para la
  //  fricción). La usan las partículas y también el punto medio de cada hueso.
  _collidePoint(x, y, z, r, o) {
    const boxes = this.boxes, cyls = this.cyls, nbox = boxes.length;
    const gY = this.groundY, ghx = this.groundHX, ghz = this.groundHZ;
    let kx = 0, ky = 0, kz = 0, hit = false, ground = false, gm = 0;

    // — piso del lugarcito (losa finita: afuera se cae al vacío) —
    if (y - r < gY && x > -ghx && x < ghx && z > -ghz && z < ghz) {
      const d = gY + r - y;
      y = gY + r; ky += d; gm += d;
      hit = true; ground = true;
    }

    // — candidatos estáticos de la celda XZ —
    const sItems = this.sItems;
    if (sItems.length > 0) {
      const cs = this.sCell;
      const fx = (x - this.sMinX) / cs, fz = (z - this.sMinZ) / cs;
      if (fx >= 0 && fz >= 0 && fx < this.sGW && fz < this.sGD) {
        const c = (fz | 0) * this.sGW + (fx | 0);
        const it0 = this.sStart[c], it1 = this.sStart[c + 1];
        for (let it = it0; it < it1; it++) {
          const id = sItems[it];
          if (id < nbox) {
            // ── caja orientada en Y ──
            const B = boxes[id];
            const rx = x - B.cx, rz = z - B.cz;
            let lx = rx * B.c + rz * B.s;
            let lz = -rx * B.s + rz * B.c;
            let ly = y - B.cy;
            const ex = B.hx + r, ey = B.hy + r, ez = B.hz + r;
            if (lx <= -ex || lx >= ex || ly <= -ey || ly >= ey || lz <= -ez || lz >= ez) continue;
            const dxp = ex - lx, dxn = lx + ex;
            const dyp = ey - ly, dyn = ly + ey;
            const dzp = ez - lz, dzn = lz + ez;
            let m = dxp, ax = 0, sg = 1;
            if (dxn < m) { m = dxn; ax = 0; sg = -1; }
            if (dyp < m) { m = dyp; ax = 1; sg = 1; }
            if (dyn < m) { m = dyn; ax = 1; sg = -1; }
            if (dzp < m) { m = dzp; ax = 2; sg = 1; }
            if (dzn < m) { m = dzn; ax = 2; sg = -1; }
            if (ax === 0) lx = sg > 0 ? ex : -ex;
            else if (ax === 1) { ly = sg > 0 ? ey : -ey; if (sg > 0) { ground = true; gm += m; } }
            else lz = sg > 0 ? ez : -ez;
            const nx2 = B.cx + lx * B.c - lz * B.s;
            const nz2 = B.cz + lx * B.s + lz * B.c;
            const ny2 = B.cy + ly;
            kx += nx2 - x; ky += ny2 - y; kz += nz2 - z;
            x = nx2; y = ny2; z = nz2;
            hit = true;
          } else {
            // ── cilindro vertical ──
            const C = cyls[id - nbox];
            if (y < C.y0 - r || y > C.y1 + r) continue;
            const ex = x - C.cx, ez = z - C.cz;
            const rr = C.r + r;
            const d2 = ex * ex + ez * ez;
            if (d2 >= rr * rr) continue;
            const d = Math.sqrt(d2);
            if (d < 1e-6) { kx += rr; x = C.cx + rr; hit = true; continue; }
            const sideDepth = rr - d;
            const topDepth = (C.y1 + r) - y;
            if (topDepth < sideDepth) { ky += topDepth; y = C.y1 + r; ground = true; gm += topDepth; }
            else {
              const k = rr / d;
              const nx2 = C.cx + ex * k, nz2 = C.cz + ez * k;
              kx += nx2 - x; kz += nz2 - z;
              x = nx2; z = nz2;
            }
            hit = true;
          }
        }
      }
    }
    o.x = x; o.y = y; o.z = z; o.kx = kx; o.ky = ky; o.kz = kz;
    o.hit = hit; o.ground = ground; o.gm = gm;
  }

  // ── partículas contra el mundo, con fricción posicional ─────────────────
  _solveWorld() {
    const o = this._co || (this._co = { x: 0, y: 0, z: 0, kx: 0, ky: 0, kz: 0, hit: false, ground: false, gm: 0 });
    const px = this.px, py = this.py, pz = this.pz, qx = this.qx, qz = this.qz;
    const muS = this.frictionS;
    for (let i = 0; i < this.pn; i++) {
      if (!(this.pf[i] & PF_ALIVE) || this.iw[i] === 0) continue;
      this._collidePoint(px[i], py[i], pz[i], this.pr[i], o);
      if (!o.hit) continue;
      let x = o.x, z = o.z;
      this.kx[i] += o.kx; this.ky[i] += o.ky; this.kz[i] += o.kz;
      this.pf[i] |= PF_HIT;
      if (o.ground) {
        this.pf[i] |= PF_GROUND;
        const tx = x - qx[i], tz = z - qz[i];
        const tl = Math.sqrt(tx * tx + tz * tz);
        if (tl > 1e-6) { const f = Math.min(1, muS * o.gm / tl); x -= tx * f; z -= tz * f; }
      }
      px[i] = x; py[i] = o.y; pz[i] = z;
    }
  }

  // ── huesos contra el mundo: el punto medio de cada hueso también choca ───
  //  Sin esto un muslo cruza el borde de un escritorio entre sus dos
  //  partículas. La corrección del punto medio se reparte entre los extremos
  //  según su masa, así un cuerpo tirado sobre una mesa queda colgado de
  //  verdad y un zombi que se estrella contra una pared la siente en todo el
  //  brazo, no sólo en la mano.
  _solveBoneWorld() {
    const o = this._co2 || (this._co2 = { x: 0, y: 0, z: 0, kx: 0, ky: 0, kz: 0, hit: false, ground: false, gm: 0 });
    const px = this.px, py = this.py, pz = this.pz, qx = this.qx, qz = this.qz;
    const iw = this.iw, pf = this.pf, muS = this.frictionS;
    for (let i = 0; i < this.bn; i++) {
      if (!this.balive[i]) continue;
      const body = this.bbody[i];
      if (body && body.lod > 1) continue;           // muy lejos: alcanza con las partículas
      const a = this.bA[i], b = this.bB[i];
      if (!(pf[a] & PF_ALIVE) || !(pf[b] & PF_ALIVE)) continue;
      const wa = iw[a], wb = iw[b], w = wa + wb;
      if (w === 0) continue;
      const mx = (px[a] + px[b]) * 0.5, my = (py[a] + py[b]) * 0.5, mz = (pz[a] + pz[b]) * 0.5;
      this._collidePoint(mx, my, mz, this.br[i] * 0.85, o);
      if (!o.hit) continue;
      let cx = o.kx, cy = o.ky, cz = o.kz;
      if (o.ground) {
        const tx = (mx + cx) - (qx[a] + qx[b]) * 0.5, tz = (mz + cz) - (qz[a] + qz[b]) * 0.5;
        const tl = Math.sqrt(tx * tx + tz * tz);
        if (tl > 1e-6) { const f = Math.min(1, muS * o.gm / tl); cx -= tx * f; cz -= tz * f; }
      }
      // mover cada extremo el doble de su fracción de masa: el punto medio se
      // desplaza exactamente la corrección
      const fa = 2 * wa / w, fb = 2 * wb / w;
      if (fa > 0) {
        px[a] += cx * fa; py[a] += cy * fa; pz[a] += cz * fa;
        this.kx[a] += cx * fa; this.ky[a] += cy * fa; this.kz[a] += cz * fa;
        pf[a] |= PF_HIT; if (o.ground) pf[a] |= PF_GROUND;
      }
      if (fb > 0) {
        px[b] += cx * fb; py[b] += cy * fb; pz[b] += cz * fb;
        this.kx[b] += cx * fb; this.ky[b] += cy * fb; this.kz[b] += cz * fb;
        pf[b] |= PF_HIT; if (o.ground) pf[b] |= PF_GROUND;
      }
    }
  }

  // ── compactación diferida ────────────────────────────────────────────────
  //  Los cuerpos guardan índices de sus restricciones y huesos. Al compactar,
  //  esos índices cambian: se les pasa UN mapa viejo→nuevo a cada cuerpo, que
  //  lo aplica de una sola pasada. Sin esto, tras borrar unos cuantos cadáveres
  //  un `sever` rompería la restricción de OTRO cuerpo.
  _compactConstraints() {
    const map = new Map();
    let w = 0;
    for (let i = 0; i < this.cn; i++) {
      if (!this.calive[i]) continue;
      if (w !== i) {
        this.ca[w] = this.ca[i]; this.cb[w] = this.cb[i];
        this.crest[w] = this.crest[i]; this.ccomp[w] = this.ccomp[i];
        this.ctype[w] = this.ctype[i]; this.calive[w] = 1;
        map.set(i, w);
      }
      w++;
    }
    for (let i = w; i < this.cn; i++) this.calive[i] = 0;
    this.cn = w; this.cDead = 0;
    if (map.size) for (const b of this.bodies) if (b.remapConstraints) b.remapConstraints(map);
  }
  _compactBones() {
    const map = new Map();
    let w = 0;
    for (let i = 0; i < this.bn; i++) {
      if (!this.balive[i]) continue;
      if (w !== i) {
        this.bA[w] = this.bA[i]; this.bB[w] = this.bB[i]; this.br[w] = this.br[i];
        this.bhp[w] = this.bhp[i]; this.bbody[w] = this.bbody[i];
        this.bmeta[w] = this.bmeta[i]; this.balive[w] = 1;
        map.set(i, w);
      }
      w++;
    }
    for (let i = w; i < this.bn; i++) { this.balive[i] = 0; this.bbody[i] = null; }
    this.bn = w; this.bDead = 0;
    if (map.size) for (const b of this.bodies) if (b.remapBones) b.remapBones(map);
  }

  /** Fuerza la compactación (para pruebas y para el cambio de nivel). */
  compact() { this._compactConstraints(); this._compactBones(); }

  /** Cantidad de partículas vivas de un grupo dentro de un radio (consulta barata para la IA). */
  countNear(x, z, r, group = -1) {
    let n = 0;
    const r2 = r * r;
    for (let i = 0; i < this.pn; i++) {
      if (!(this.pf[i] & PF_ALIVE)) continue;
      if (group >= 0 && this.pg[i] !== group) continue;
      const dx = this.px[i] - x, dz = this.pz[i] - z;
      if (dx * dx + dz * dz < r2) n++;
    }
    return n;
  }

  // ═══ raycast contra huesos (cápsulas) ═════════════════════════════════════
  //  `out.s` es la posición a lo largo del hueso (0..1): con eso repartimos el
  //  impulso entre sus 2 partículas y el disparo se siente donde pegó.
  raycastBones(ox, oy, oz, dx, dy, dz, maxT, out, skipBody = null) {
    let best = maxT, found = false;
    const px = this.px, py = this.py, pz = this.pz;
    const A = dx * dx + dy * dy + dz * dz;
    const invSqrtA = 1 / Math.sqrt(A);
    for (let i = 0; i < this.bn; i++) {
      if (!this.balive[i]) continue;
      const body = this.bbody[i];
      if (body === skipBody) continue;
      const a = this.bA[i], b = this.bB[i];
      const ax = px[a], ay = py[a], az = pz[a];
      const ux = px[b] - ax, uy = py[b] - ay, uz = pz[b] - az;
      const wx = ox - ax, wy = oy - ay, wz = oz - az;
      const Bd = dx * ux + dy * uy + dz * uz;
      const Cc = ux * ux + uy * uy + uz * uz;
      const D = dx * wx + dy * wy + dz * wz;
      const E = ux * wx + uy * wy + uz * wz;
      const den = A * Cc - Bd * Bd;
      let s = Math.abs(den) < 1e-9 ? 0 : (A * E - Bd * D) / den;
      if (s < 0) s = 0; else if (s > 1) s = 1;
      const t = (Bd * s - D) / A;
      if (t < 0 || t > best) continue;
      const nx = (ox + dx * t) - (ax + ux * s);
      const ny = (oy + dy * t) - (ay + uy * s);
      const nz = (oz + dz * t) - (az + uz * s);
      const d2 = nx * nx + ny * ny + nz * nz;
      const r = this.br[i];
      if (d2 > r * r) continue;
      const back = Math.sqrt(Math.max(0, r * r - d2)) * invSqrtA;
      const te = Math.max(0, t - back);
      if (te > best) continue;
      best = te; found = true;
      out.t = te; out.s = s; out.bone = i; out.body = body;
      out.x = ox + dx * te; out.y = oy + dy * te; out.z = oz + dz * te;
      const dd = Math.sqrt(d2);
      const invd = dd > 1e-6 ? 1 / dd : 0;
      out.nx = nx * invd; out.ny = ny * invd; out.nz = nz * invd;
    }
    return found;
  }

  raycastStatic(ox, oy, oz, dx, dy, dz, maxT, out) {
    let best = maxT, found = false;
    if (dy < -1e-6) {
      const t = (this.groundY - oy) / dy;
      if (t > 0 && t < best) {
        const hxp = ox + dx * t, hzp = oz + dz * t;
        if (Math.abs(hxp) < this.groundHX && Math.abs(hzp) < this.groundHZ) {
          best = t; found = true;
          out.t = t; out.x = hxp; out.y = this.groundY; out.z = hzp; out.box = null;
          out.nx = 0; out.ny = 1; out.nz = 0;
        }
      }
    }
    const o = this._ro || (this._ro = [0, 0, 0]);
    const d = this._rd || (this._rd = [0, 0, 0]);
    const e = this._re || (this._re = [0, 0, 0]);
    for (let i = 0; i < this.boxes.length; i++) {
      const B = this.boxes[i];
      const rx = ox - B.cx, rz = oz - B.cz;
      o[0] = rx * B.c + rz * B.s; o[1] = oy - B.cy; o[2] = -rx * B.s + rz * B.c;
      d[0] = dx * B.c + dz * B.s; d[1] = dy;        d[2] = -dx * B.s + dz * B.c;
      e[0] = B.hx; e[1] = B.hy; e[2] = B.hz;
      let tmin = 0, tmax = best, axis = -1, asg = 1, ok = true;
      for (let k = 0; k < 3; k++) {
        if (Math.abs(d[k]) < 1e-9) { if (o[k] < -e[k] || o[k] > e[k]) { ok = false; break; } continue; }
        const inv = 1 / d[k];
        let t1 = (-e[k] - o[k]) * inv, t2 = (e[k] - o[k]) * inv;
        let sg = -1;
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; sg = 1; }
        if (t1 > tmin) { tmin = t1; axis = k; asg = sg; }
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) { ok = false; break; }
      }
      if (!ok || tmin <= 0 || tmin >= best) continue;
      best = tmin; found = true;
      out.t = tmin; out.box = B;
      out.x = ox + dx * tmin; out.y = oy + dy * tmin; out.z = oz + dz * tmin;
      let n0 = 0, n1 = 0, n2 = 0;
      if (axis === 0) n0 = asg; else if (axis === 1) n1 = asg; else n2 = asg;
      out.nx = n0 * B.c - n2 * B.s; out.ny = n1; out.nz = n0 * B.s + n2 * B.c;
    }
    return found ? best : -1;
  }

  lineOfSight(ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (L < 1e-5) return true;
    const out = this._losOut || (this._losOut = {});
    return this.raycastStatic(ax, ay, az, dx / L, dy / L, dz / L, L - 0.1, out) < 0;
  }

  /** Onda expansiva: impulso radial con caída cuadrática y un empujón hacia arriba. */
  explode(x, y, z, radius, force) {
    const r2 = radius * radius;
    for (let i = 0; i < this.pn; i++) {
      if (!(this.pf[i] & PF_ALIVE) || this.iw[i] === 0) continue;
      const dx = this.px[i] - x, dy = this.py[i] - y, dz = this.pz[i] - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      const d = Math.sqrt(d2) + 0.25;
      const f = force * (1 - d2 / r2) / d * this.iw[i];
      this.vx[i] += dx * f;
      this.vy[i] += (dy + 0.6 * d) * f;
      this.vz[i] += dz * f;
    }
  }
}
