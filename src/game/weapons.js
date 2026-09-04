// ─────────────────────────────────────────────────────────────────────────────
//  weapons.js — Armas, munición y el disparo (hitscan contra huesos y paredes).
//
//  Un tiro es un rayo: primero contra los huesos de todos los cuerpos (el
//  motor devuelve en qué hueso pegó y en qué punto del hueso), después contra
//  los estáticos; gana el más cercano. El fusil atraviesa un cuerpo y sigue
//  con menos daño. La escopeta tira nueve perdigones con dispersión y pierde
//  fuerza con la distancia.
// ─────────────────────────────────────────────────────────────────────────────

export const WEAPONS = {
  pistol:  { key: 'pistol',  name: 'PISTOLA',  dmg: 30, rate: 6.5,  auto: false, spread: 0.018, pellets: 1, impulse: 7,  mag: 12, reserve: Infinity, reload: 1.05, range: 45, kick: 0.22, shake: 0.10, pierce: 0, falloff: 0 },
  smg:     { key: 'smg',     name: 'SUBFUSIL', dmg: 17, rate: 13,   auto: true,  spread: 0.05,  pellets: 1, impulse: 4.5, mag: 32, reserve: 96, reload: 1.7,  range: 40, kick: 0.13, shake: 0.07, pierce: 0, falloff: 0 },
  shotgun: { key: 'shotgun', name: 'ESCOPETA', dmg: 14, rate: 1.3,  auto: false, spread: 0.10,  pellets: 9, impulse: 9,  mag: 6,  reserve: 18, reload: 2.3,  range: 24, kick: 0.6,  shake: 0.32, pierce: 0, falloff: 1 },
  rifle:   { key: 'rifle',   name: 'FUSIL',    dmg: 44, rate: 8.5,  auto: true,  spread: 0.028, pellets: 1, impulse: 13, mag: 30, reserve: 90, reload: 2.1,  range: 60, kick: 0.28, shake: 0.12, pierce: 1, falloff: 0 },
};
export const WEAPON_ORDER = ['pistol', 'smg', 'shotgun', 'rifle'];

export class WeaponState {
  constructor(def) {
    this.def = def;
    this.mag = def.mag;
    this.reserve = def.reserve;
    this.reloading = 0;
    this.cool = 0;
    this.trigger = false;    // para armas semiautomáticas: hay que soltar
  }
  get canReload() { return this.reloading <= 0 && this.mag < this.def.mag && this.reserve > 0; }
}

export class Arsenal {
  constructor() {
    this.slots = { pistol: new WeaponState(WEAPONS.pistol) };
    this.current = 'pistol';
    this.switchT = 0;
  }
  get weapon() { return this.slots[this.current]; }
  get def() { return this.weapon.def; }
  has(kind) { return !!this.slots[kind]; }

  /** Da un arma (o munición si ya la tiene). Devuelve true si es nueva. */
  give(kind) {
    if (this.slots[kind]) { this.addAmmo(kind, WEAPONS[kind].mag * 2); return false; }
    this.slots[kind] = new WeaponState(WEAPONS[kind]);
    this.switchTo(kind);
    return true;
  }
  addAmmo(kind, n) {
    const s = this.slots[kind];
    if (!s || s.reserve === Infinity) return;
    s.reserve = Math.min(s.reserve + n, s.def.mag * 6);
  }
  /** Munición para todo lo que tenga. */
  ammoAll(f = 1) {
    for (const k in this.slots) this.addAmmo(k, Math.round(this.slots[k].def.mag * 2 * f));
  }
  switchTo(kind) {
    if (!this.slots[kind] || kind === this.current) return false;
    this.weapon.reloading = 0;
    this.current = kind;
    this.switchT = 0.35;
    return true;
  }
  cycle(d) {
    const owned = WEAPON_ORDER.filter(k => this.slots[k]);
    const i = owned.indexOf(this.current);
    return this.switchTo(owned[(i + d + owned.length) % owned.length]);
  }
  startReload() {
    const s = this.weapon;
    if (!s.canReload || this.switchT > 0) return false;
    s.reloading = s.def.reload;
    return true;
  }
  update(dt) {
    if (this.switchT > 0) this.switchT -= dt;
    for (const k in this.slots) {
      const s = this.slots[k];
      if (s.cool > 0) s.cool -= dt;
      if (s.reloading > 0) {
        s.reloading -= dt;
        if (s.reloading <= 0) {
          const need = s.def.mag - s.mag;
          const take = s.reserve === Infinity ? need : Math.min(need, s.reserve);
          s.mag += take;
          if (s.reserve !== Infinity) s.reserve -= take;
          s.reloading = 0;
        }
      }
    }
  }
  /**
   * ¿Dispara? `held` = gatillo apretado este frame. Devuelve la definición
   * del arma si sale un tiro, 'empty' si hizo clic en vacío, null si nada.
   */
  tryFire(held) {
    const s = this.weapon, d = s.def;
    if (!held) { s.trigger = false; return null; }
    if (this.switchT > 0 || s.reloading > 0 || s.cool > 0) return null;
    if (!d.auto && s.trigger) return null;
    s.trigger = true;
    if (s.mag <= 0) { s.cool = 0.25; return 'empty'; }
    s.mag--;
    s.cool = 1 / d.rate;
    return d;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  Hitscan
// ═════════════════════════════════════════════════════════════════════════════
const _b = {}, _s = {};

/**
 * Dispara desde (ox,oy,oz) hacia (dx,dy,dz) (normalizado) con un arma.
 * Llena `hits` (array reutilizable) con un objeto por perdigón:
 *   {kind:'body'|'static'|'none', x,y,z, nx,ny,nz, body, bone, s, dmg, dirx,diry,dirz, t, pierced}
 * Devuelve la cantidad de impactos escritos.
 */
export function fireHitscan(world, ox, oy, oz, dx, dy, dz, def, skipBody, rng, hits) {
  let n = 0;
  const take = () => {
    if (!hits[n]) hits[n] = {};
    return hits[n++];
  };
  for (let p = 0; p < def.pellets; p++) {
    // dispersión: un cono gaussiano-ish
    const sp = def.spread;
    let ddx = dx + (rng() + rng() - 1) * sp + (rng() + rng() - 1) * sp * 0.5;
    let ddy = dy + (rng() + rng() - 1) * sp * 0.6;
    let ddz = dz + (rng() + rng() - 1) * sp + (rng() + rng() - 1) * sp * 0.5;
    const l = Math.hypot(ddx, ddy, ddz) || 1;
    ddx /= l; ddy /= l; ddz /= l;

    let sx = ox, sy = oy, sz = oz;
    let remaining = def.range;
    let skip = skipBody;
    let dmgMul = 1;
    let pierced = 0;
    for (let hop = 0; hop < 1 + def.pierce; hop++) {
      const hitB = world.raycastBones(sx, sy, sz, ddx, ddy, ddz, remaining, _b, skip);
      const tS = world.raycastStatic(sx, sy, sz, ddx, ddy, ddz, remaining, _s);
      const H = take();
      H.dirx = ddx; H.diry = ddy; H.dirz = ddz; H.pierced = pierced;
      H.ox = sx; H.oy = sy; H.oz = sz;
      if (hitB && (tS < 0 || _b.t < tS)) {
        const dist = (def.range - remaining) + _b.t;
        let dmg = def.dmg * dmgMul;
        if (def.falloff) dmg *= Math.max(0.25, 1 - dist / def.range);
        H.kind = 'body'; H.x = _b.x; H.y = _b.y; H.z = _b.z; H.nx = _b.nx; H.ny = _b.ny; H.nz = _b.nz;
        H.body = _b.body; H.bone = _b.bone; H.s = _b.s; H.t = _b.t; H.dmg = dmg;
        // seguir de largo (fusil)
        remaining -= _b.t + 0.08;
        sx = _b.x + ddx * 0.08; sy = _b.y + ddy * 0.08; sz = _b.z + ddz * 0.08;
        skip = _b.body;
        dmgMul *= 0.6;
        pierced++;
        if (remaining <= 0) break;
        continue;
      }
      if (tS >= 0) {
        H.kind = 'static'; H.x = _s.x; H.y = _s.y; H.z = _s.z; H.nx = _s.nx; H.ny = _s.ny; H.nz = _s.nz;
        H.body = null; H.bone = -1; H.t = tS; H.dmg = 0; H.obj = _s.box || null;
      } else {
        H.kind = 'none'; H.x = sx + ddx * remaining; H.y = sy + ddy * remaining; H.z = sz + ddz * remaining;
        H.body = null; H.bone = -1; H.t = remaining; H.dmg = 0;
      }
      break;
    }
  }
  return n;
}
