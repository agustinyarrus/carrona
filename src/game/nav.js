// ─────────────────────────────────────────────────────────────────────────────
//  nav.js — Campo de flujo: cómo llega una horda entera hasta el jugador.
//
//  En vez de correr A* por cada zombi (caro y todos van al mismo lugar), se
//  hace UN Dijkstra desde el jugador sobre una grilla del lugarcito y cada
//  celda guarda hacia dónde bajar. Un zombi lee la dirección de su celda y
//  listo: cien zombis cuestan lo mismo que uno. Se recalcula unas veces por
//  segundo, cuando el jugador se movió lo suficiente.
//
//  La grilla se rasteriza desde los colisionadores del mundo: cajas rotadas y
//  cilindros, dilatados por el medio ancho de un zombi. Las cosas bajas
//  (alfombras, cables) se pisan; el borde de la losa se bloquea para que nadie
//  se caiga al vacío persiguiéndote.
// ─────────────────────────────────────────────────────────────────────────────

const SQ2 = Math.SQRT2;
// vecinos: dx, dz, costo
const NB8 = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQ2], [-1, 1, SQ2], [1, -1, SQ2], [-1, -1, SQ2],
];

export class NavGrid {
  constructor(world, opt = {}) {
    this.world = world;
    this.cell = opt.cell ?? 0.4;
    this.margin = opt.margin ?? 0.30;    // medio ancho de un zombi
    this.minTop = opt.minTop ?? 0.32;    // más bajo que esto se pisa
    this.maxBottom = opt.maxBottom ?? 1.9; // más alto que esto se pasa por debajo
    this.vaultTop = opt.vaultTop ?? 0;   // hasta esta altura de tapa se TREPA (escritorios, mesas)
    this.targetX = NaN; this.targetZ = NaN;
    this.version = 0;
    this.build();
  }

  gx(x) { return Math.max(0, Math.min(this.W - 1, Math.floor((x - this.minX) / this.cell))); }
  gz(z) { return Math.max(0, Math.min(this.D - 1, Math.floor((z - this.minZ) / this.cell))); }
  cellAt(x, z) {
    const gx = Math.floor((x - this.minX) / this.cell), gz = Math.floor((z - this.minZ) / this.cell);
    if (gx < 0 || gz < 0 || gx >= this.W || gz >= this.D) return -1;
    return gz * this.W + gx;
  }
  cx(i) { return this.minX + ((i % this.W) + 0.5) * this.cell; }
  cz(i) { return this.minZ + (Math.floor(i / this.W) + 0.5) * this.cell; }

  /** Rasteriza los estáticos del mundo. Llamar tras construir el nivel. */
  build() {
    const w = this.world, cs = this.cell, m = this.margin;
    this.minX = -w.groundHX; this.minZ = -w.groundHZ;
    this.W = Math.max(1, Math.ceil(w.groundHX * 2 / cs));
    this.D = Math.max(1, Math.ceil(w.groundHZ * 2 / cs));
    const N = this.W * this.D;
    this.N = N;
    this.walk = new Uint8Array(N).fill(1);
    this.dist = new Float32Array(N).fill(Infinity);
    this.dirX = new Float32Array(N);
    this.dirZ = new Float32Array(N);
    this._hIdx = new Int32Array(N * 8 + 16);
    this._hKey = new Float32Array(N * 8 + 16);

    // borde de la losa
    const edge = Math.max(1, Math.ceil((m + 0.25) / cs));
    for (let gz = 0; gz < this.D; gz++) for (let gx = 0; gx < this.W; gx++) {
      if (gx < edge || gz < edge || gx >= this.W - edge || gz >= this.D - edge) this.walk[gz * this.W + gx] = 0;
    }

    for (const B of w.boxes) {
      if (B.cy + B.hy < this.minTop) continue;
      if (B.cy - B.hy > this.maxBottom) continue;
      // muebles bajos: la horda los trepa, así que no cortan el camino
      if (this.vaultTop > 0 && B.cy + B.hy <= this.vaultTop && B.hy < 0.6) continue;
      const ax = Math.abs(B.hx * B.c) + Math.abs(B.hz * B.s) + m;
      const az = Math.abs(B.hx * B.s) + Math.abs(B.hz * B.c) + m;
      const x0 = this.gx(B.cx - ax), x1 = this.gx(B.cx + ax);
      const z0 = this.gz(B.cz - az), z1 = this.gz(B.cz + az);
      const ex = B.hx + m, ez = B.hz + m;
      for (let gz = z0; gz <= z1; gz++) {
        for (let gx = x0; gx <= x1; gx++) {
          const px = this.minX + (gx + 0.5) * cs, pz = this.minZ + (gz + 0.5) * cs;
          const rx = px - B.cx, rz = pz - B.cz;
          const lx = rx * B.c + rz * B.s, lz = -rx * B.s + rz * B.c;
          if (lx > -ex && lx < ex && lz > -ez && lz < ez) this.walk[gz * this.W + gx] = 0;
        }
      }
    }
    for (const C of w.cyls) {
      if (C.y1 < this.minTop || C.y0 > this.maxBottom) continue;
      const rr = C.r + m;
      const x0 = this.gx(C.cx - rr), x1 = this.gx(C.cx + rr);
      const z0 = this.gz(C.cz - rr), z1 = this.gz(C.cz + rr);
      for (let gz = z0; gz <= z1; gz++) {
        for (let gx = x0; gx <= x1; gx++) {
          const px = this.minX + (gx + 0.5) * cs, pz = this.minZ + (gz + 0.5) * cs;
          const dx = px - C.cx, dz = pz - C.cz;
          if (dx * dx + dz * dz < rr * rr) this.walk[gz * this.W + gx] = 0;
        }
      }
    }
    let n = 0;
    for (let i = 0; i < N; i++) n += this.walk[i];
    this.walkableCount = n;
    this.version++;
  }

  /** Bloquea a mano una zona (para vanos que no queremos que use la IA, etc). */
  blockRect(x0, z0, x1, z1) {
    for (let gz = this.gz(z0); gz <= this.gz(z1); gz++)
      for (let gx = this.gx(x0); gx <= this.gx(x1); gx++) this.walk[gz * this.W + gx] = 0;
  }

  walkable(x, z) { const i = this.cellAt(x, z); return i >= 0 && this.walk[i] === 1; }

  /** La celda transitable más cercana, en espiral. -1 si no hay. */
  nearestWalkable(x, z, maxR = 8) {
    const gx0 = this.gx(x), gz0 = this.gz(z);
    if (this.walk[gz0 * this.W + gx0]) return gz0 * this.W + gx0;
    let best = -1, bestD = Infinity;
    for (let r = 1; r <= maxR; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          const gx = gx0 + dx, gz = gz0 + dz;
          if (gx < 0 || gz < 0 || gx >= this.W || gz >= this.D) continue;
          const i = gz * this.W + gx;
          if (!this.walk[i]) continue;
          const px = this.cx(i) - x, pz = this.cz(i) - z;
          const d = px * px + pz * pz;
          if (d < bestD) { bestD = d; best = i; }
        }
      }
      if (best >= 0) return best;
    }
    return best;
  }

  // ═══ Dijkstra desde el objetivo ═══════════════════════════════════════════
  computeFlow(tx, tz) {
    const W = this.W, D = this.D, walk = this.walk, dist = this.dist;
    dist.fill(Infinity);
    let start = this.cellAt(tx, tz);
    if (start < 0 || !walk[start]) start = this.nearestWalkable(tx, tz);
    if (start < 0) return false;
    this.targetX = tx; this.targetZ = tz;

    const hIdx = this._hIdx, hKey = this._hKey;
    let hn = 0;
    const push = (i, k) => {
      let c = hn++;
      while (c > 0) {
        const p = (c - 1) >> 1;
        if (hKey[p] <= k) break;
        hIdx[c] = hIdx[p]; hKey[c] = hKey[p]; c = p;
      }
      hIdx[c] = i; hKey[c] = k;
    };
    const pop = () => {
      const top = hIdx[0];
      hn--;
      if (hn > 0) {
        const i = hIdx[hn], k = hKey[hn];
        let c = 0;
        for (;;) {
          const l = c * 2 + 1;
          if (l >= hn) break;
          const r = l + 1;
          const s = (r < hn && hKey[r] < hKey[l]) ? r : l;
          if (hKey[s] >= k) break;
          hIdx[c] = hIdx[s]; hKey[c] = hKey[s]; c = s;
        }
        hIdx[c] = i; hKey[c] = k;
      }
      return top;
    };

    dist[start] = 0;
    push(start, 0);
    const cs = this.cell;
    while (hn > 0) {
      const k = hKey[0];
      const i = pop();
      if (k > dist[i]) continue;            // entrada vieja
      const gx = i % W, gz = (i - gx) / W;
      for (let n = 0; n < 8; n++) {
        const nb = NB8[n];
        const nx = gx + nb[0], nz = gz + nb[1];
        if (nx < 0 || nz < 0 || nx >= W || nz >= D) continue;
        const j = nz * W + nx;
        if (!walk[j]) continue;
        if (n >= 4) {
          // diagonal: no cortar esquinas
          if (!walk[gz * W + nx] || !walk[nz * W + gx]) continue;
        }
        const nd = k + nb[2] * cs;
        if (nd < dist[j]) { dist[j] = nd; push(j, nd); }
      }
    }

    // dirección por celda: hacia el vecino con menor distancia
    const dirX = this.dirX, dirZ = this.dirZ;
    for (let i = 0; i < this.N; i++) {
      dirX[i] = 0; dirZ[i] = 0;
      if (!walk[i] || dist[i] === Infinity || i === start) continue;
      const gx = i % W, gz = (i - gx) / W;
      let best = dist[i], bx = 0, bz = 0;
      for (let n = 0; n < 8; n++) {
        const nb = NB8[n];
        const nx = gx + nb[0], nz = gz + nb[1];
        if (nx < 0 || nz < 0 || nx >= W || nz >= D) continue;
        const j = nz * W + nx;
        if (!walk[j]) continue;
        if (n >= 4 && (!walk[gz * W + nx] || !walk[nz * W + gx])) continue;
        if (dist[j] < best) { best = dist[j]; bx = nb[0]; bz = nb[1]; }
      }
      const L = Math.hypot(bx, bz) || 1;
      dirX[i] = bx / L; dirZ[i] = bz / L;
    }
    this.version++;
    return true;
  }

  distAt(x, z) { const i = this.cellAt(x, z); return i < 0 ? Infinity : this.dist[i]; }
  reachable(x, z) { return this.distAt(x, z) < Infinity; }

  /**
   * Dirección de flujo en un punto, mezclando las 4 celdas vecinas. Devuelve
   * false si el punto está fuera o rodeado de celdas sin camino.
   */
  dirAt(x, z, out) {
    const cs = this.cell;
    const fx = (x - this.minX) / cs - 0.5, fz = (z - this.minZ) / cs - 0.5;
    const gx0 = Math.floor(fx), gz0 = Math.floor(fz);
    const tx = fx - gx0, tz = fz - gz0;
    let sx = 0, sz = 0, sw = 0;
    for (let dz = 0; dz < 2; dz++) {
      for (let dx = 0; dx < 2; dx++) {
        const gx = gx0 + dx, gz = gz0 + dz;
        if (gx < 0 || gz < 0 || gx >= this.W || gz >= this.D) continue;
        const i = gz * this.W + gx;
        if (!this.walk[i] || this.dist[i] === Infinity) continue;
        const wgt = (dx ? tx : 1 - tx) * (dz ? tz : 1 - tz);
        sx += this.dirX[i] * wgt; sz += this.dirZ[i] * wgt; sw += wgt;
      }
    }
    if (sw < 1e-4) { out.x = 0; out.z = 0; return false; }
    const L = Math.hypot(sx, sz);
    if (L < 1e-4) { out.x = 0; out.z = 0; return true; }   // llegamos
    out.x = sx / L; out.z = sz / L;
    return true;
  }

  /** Punto transitable (y con camino hasta el objetivo) a cierta distancia de (x,z). */
  randomReachable(rng, x, z, rMin, rMax, tries = 40) {
    for (let t = 0; t < tries; t++) {
      const a = rng() * Math.PI * 2, d = rMin + rng() * (rMax - rMin);
      const px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
      const i = this.cellAt(px, pz);
      if (i >= 0 && this.walk[i] && this.dist[i] < Infinity) return { x: px, z: pz };
    }
    return null;
  }

  /** Cualquier punto transitable del nivel. */
  randomWalkable(rng, tries = 100) {
    for (let t = 0; t < tries; t++) {
      const i = Math.floor(rng() * this.N);
      if (this.walk[i]) return { x: this.cx(i), z: this.cz(i) };
    }
    return null;
  }
}
