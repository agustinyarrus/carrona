// ─────────────────────────────────────────────────────────────────────────────
//  weapons.js — El arsenal del jugador y el hitscan.
//
//  Las 104 armas viven en catalog.js (datos puros). Acá está lo que cambia
//  mientras se juega: cuántas balas quedan, la recarga, la cadencia, las
//  ráfagas, el giro previo de las rotativas, la carga del riel y las
//  baterías que se regeneran y se recalientan.
//
//  El jugador lleva UNA arma por ranura (1 de mano · 2 subfusiles · 3
//  escopetas · 4 fusiles · 5 pesadas). Agarrar una de una ranura ocupada
//  suelta la anterior CON su munición: el juego la deja en el piso.
//
//  Un tiro es un rayo: primero contra los huesos de todos los cuerpos (el
//  motor devuelve en qué hueso pegó y en qué punto del hueso), después contra
//  los estáticos; gana el más cercano. El fusil atraviesa un cuerpo y sigue
//  con menos daño. La escopeta tira nueve perdigones con dispersión y pierde
//  fuerza con la distancia. Lo demás (proyectiles, rayos, relámpagos) está
//  en ballistics.js.
// ─────────────────────────────────────────────────────────────────────────────

import { WEAPONS, WEAPON_ORDER, SLOT_COUNT } from './catalog.js';

export { WEAPONS, WEAPON_ORDER };

const EMPTY_CLICK_COOL = 0.25;      // clic en vacío: no repite a 60 Hz
const SWITCH_TIME = 0.35;           // sacar un arma
const REGEN_DELAY = 0.35;           // la batería empieza a cargar un rato después del último tiro
const RESERVE_CAP_MAGS = 6;         // tope de reserva: seis cargadores (tres si el cargador es enorme)
const CARRY_MAX = 0.034;            // resto de enfriamiento que se arrastra entre cuadros (dos cuadros a 60 fps)

export class WeaponState {
  /** @param ammo {mag, reserve} opcional: el arma levantada del piso trae lo que le quedaba */
  constructor(def, ammo = null) {
    this.def = def;
    this.mag = ammo ? Math.min(def.mag, ammo.mag) : def.mag;
    this.reserve = ammo ? ammo.reserve : def.reserve;
    this.reloading = 0;
    this.cool = 0;
    this.trigger = false;    // para armas semiautomáticas: hay que soltar
    this.burstLeft = 0;      // tiros que le debe la ráfaga en curso
    this.spin = 0;           // 0..1: giro de la rotativa o carga del riel
    this.overheat = 0;       // batería vacía: segundos hasta que vuelve llena
    this.sinceShot = 99;
  }
  get canReload() { return !this.def.regen && this.reloading <= 0 && this.mag < this.def.mag && this.reserve > 0; }
  get ammo() { return { mag: this.mag, reserve: this.reserve }; }
  get reserveCap() { return this.def.mag * (this.def.mag > 90 ? 3 : RESERVE_CAP_MAGS); }
}

export class Arsenal {
  constructor() {
    this.slots = new Array(SLOT_COUNT).fill(null);
    this.slots[0] = new WeaponState(WEAPONS.pistol);
    this.current = 'pistol';
    this.switchT = 0;
    this.dropped = null;     // lo último que soltó un cambio (el juego lo tira al piso)
  }
  /** Ranura (0..4) de un arma del catálogo. O(1). */
  slotOf(kind) { return WEAPONS[kind].slot - 1; }
  get weapon() { return this.slots[this.slotOf(this.current)]; }
  get def() { return this.weapon.def; }
  has(kind) { const s = WEAPONS[kind] && this.slots[this.slotOf(kind)]; return !!s && s.def.key === kind; }
  /** ¿Se puede levantar sin soltar nada? (ya la tiene: munición; o la ranura está libre) */
  canTake(kind) { return this.has(kind) || !this.slots[this.slotOf(kind)]; }
  /** Las que lleva, en orden de ranura. */
  owned() { const o = []; for (const s of this.slots) if (s) o.push(s.def.key); return o; }
  /** Lo que ocupa una ranura (o null). */
  inSlot(i) { return this.slots[i] ? this.slots[i].def.key : null; }

  /**
   * Da un arma. Si ya la tiene, suma munición y devuelve false. Si la ranura
   * está ocupada por otra, la reemplaza y deja la vieja en `dropped` (con su
   * munición). Devuelve true si el arma es nueva en la mano.
   */
  give(kind, ammo = null) {
    const def = WEAPONS[kind];
    if (!def) return false;
    this.dropped = null;
    if (this.has(kind)) { this.addAmmo(kind, ammo ? ammo.mag + (ammo.reserve === Infinity ? 0 : ammo.reserve) : def.mag * 2); return false; }
    const i = this.slotOf(kind);
    const prev = this.slots[i];
    if (prev) this.dropped = prev;
    this.slots[i] = new WeaponState(def, ammo);
    if (prev && this.current === prev.def.key) this.current = kind;      // la que tenía en la mano ya no está
    this.switchTo(kind, true);
    return true;
  }
  addAmmo(kind, n) {
    const s = this.slots[this.slotOf(kind)];
    if (!s || s.def.key !== kind || s.reserve === Infinity) return;
    s.reserve = Math.min(s.reserve + n, s.reserveCap);
  }
  /** Munición para todo lo que tenga. */
  ammoAll(f = 1) {
    for (const s of this.slots) if (s) this.addAmmo(s.def.key, Math.round(s.def.mag * 2 * f));
  }
  switchTo(kind, force = false) {
    if (!this.has(kind) || (kind === this.current && !force)) return false;
    const cur = this.slots[this.slotOf(this.current)];
    if (cur) { cur.reloading = 0; cur.burstLeft = 0; }
    this.current = kind;
    this.switchT = SWITCH_TIME;
    return true;
  }
  /** Tecla de ranura: saca lo que haya en la ranura i (0..4). */
  switchSlot(i) { const s = this.slots[i]; return s ? this.switchTo(s.def.key) : false; }
  cycle(d) {
    const owned = this.owned();
    const i = owned.indexOf(this.current);
    return this.switchTo(owned[(i + d + owned.length) % owned.length]);
  }
  startReload() {
    const s = this.weapon;
    if (!s.canReload || this.switchT > 0) return false;
    s.reloading = s.def.reload;
    s.burstLeft = 0;
    return true;
  }
  update(dt) {
    if (this.switchT > 0) this.switchT -= dt;
    for (const s of this.slots) {
      if (!s) continue;
      const d = s.def;
      if (s.cool > 0) s.cool -= dt;
      s.sinceShot += dt;
      if (s.reloading > 0) {
        s.reloading -= dt;
        if (s.reloading <= 0) {
          const need = d.mag - s.mag;
          const take = s.reserve === Infinity ? need : Math.min(need, s.reserve);
          s.mag += take;
          if (s.reserve !== Infinity) s.reserve -= take;
          s.reloading = 0;
        }
      }
      if (d.regen) {
        // batería: vacía se recalienta un rato y vuelve llena; si no, carga sola tras el último tiro
        if (s.overheat > 0) { s.overheat -= dt; if (s.overheat <= 0) { s.overheat = 0; s.mag = d.mag; } }
        else if (s.sinceShot > REGEN_DELAY && s.mag < d.mag) s.mag = Math.min(d.mag, s.mag + d.regen * dt);
      }
    }
  }
  /** Progreso de recarga o recalentamiento (0..1, para el HUD). */
  get busy() {
    const s = this.weapon;
    if (s.reloading > 0) return 1 - s.reloading / s.def.reload;
    if (s.overheat > 0) return 1 - s.overheat / s.def.reload;
    return 0;
  }
  /**
   * ¿Dispara? `held` = gatillo apretado este frame, `dt` para el giro previo.
   * Devuelve la definición del arma si sale un tiro, 'empty' si hizo clic
   * en vacío, null si nada. Máquina de estados chica: ráfaga en curso >
   * gatillo suelto > bloqueos (cambio, recarga, cadencia, recalentado) >
   * giro/carga > tiro.
   */
  tryFire(held, dt = 0) {
    const s = this.weapon, d = s.def;
    if (d.windup) {
      if (held && this.switchT <= 0 && s.reloading <= 0 && s.overheat <= 0 && s.mag >= 1) s.spin = Math.min(1, s.spin + dt / d.windup);
      else s.spin = Math.max(0, s.spin - dt / (d.windup * 1.6));
    }
    if (s.burstLeft > 0) {
      if (this.switchT > 0 || s.reloading > 0 || s.cool > 0) return null;
      if (s.mag < 1) { s.burstLeft = 0; s.cool = EMPTY_CLICK_COOL; return 'empty'; }
      s.burstLeft--;
      return this._shoot(s, d, s.burstLeft > 0 ? 1 / d.burstRate : 1 / d.rate);
    }
    if (!held) { s.trigger = false; return null; }
    if (this.switchT > 0 || s.reloading > 0 || s.cool > 0 || s.overheat > 0) return null;
    if (!d.auto && s.trigger) return null;
    if (d.windup && s.spin < 1) return null;
    s.trigger = true;
    if (s.mag < 1) { s.cool = EMPTY_CLICK_COOL; return 'empty'; }
    if (d.burst) { s.burstLeft = d.burst - 1; return this._shoot(s, d, 1 / d.burstRate); }
    if (d.windup && !d.auto) s.spin = 0;          // el riel: cada tiro vuelve a cargar
    return this._shoot(s, d, 1 / d.rate);
  }
  _shoot(s, d, cooldown) {
    s.mag--;
    // el resto negativo del cuadro anterior se arrastra (hasta dos cuadros): a 60 fps una
    // cadencia de 26/s daba 20/s porque el enfriamiento se redondeaba a 3 cuadros
    s.cool = (s.cool < 0 && s.cool > -CARRY_MAX ? s.cool : 0) + cooldown;
    s.sinceShot = 0;
    if (d.regen && s.mag < 1) { s.mag = 0; s.overheat = d.reload; s.burstLeft = 0; }
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
