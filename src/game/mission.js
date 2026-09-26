// ─────────────────────────────────────────────────────────────────────────────
//  mission.js — La campaña: qué hay que hacer en cada lugar, y el manager que
//  lleva la cuenta de los objetivos mientras el juego corre.
//
//  Una misión es un mapa, un arsenal inicial, una configuración de oleadas y
//  una lista de objetivos EN ORDEN: sobrevivir N oleadas, matar N, aguantar
//  T segundos, juntar N cosas repartidas por el mapa, llegar a un punto. Se
//  cumple el último y la misión termina. El modo infinito es una "misión"
//  sin objetivos con las oleadas clásicas.
// ─────────────────────────────────────────────────────────────────────────────

import { t, fmtTime } from '../core/i18n.js';

/** Las oleadas de siempre (el modo infinito): cada campo es función del número de oleada. */
export const WAVES_CLASSIC = {
  firstDelay: 4.0,                                   // segundos hasta la primera
  between: 9,                                        // respiro entre oleadas
  total: (n) => 5 + n * 4 + Math.floor(n * n * 0.4),
  maxAlive: (n) => Math.min(8 + n * 3, 40),
  interval: (n) => Math.max(0.25, 1.3 - n * 0.08),
  mix: (n, r) => (n >= 4 && r < 0.06 + n * 0.012) ? 'brute' : (r < 0.40 + n * 0.04) ? 'runner' : (r < 0.78 + n * 0.03) ? 'jogger' : 'walker',
  sleepers: (n) => 2 + Math.min(n, 5),
  stampede: { from: 1, first: [14, 22], every: [22, 34], count: (n) => 5 + n },
  rewards: true,                                     // desbloqueos de armas por oleada
};

/** Variante con menos gente, para misiones donde lo importante es moverse. */
export const WAVES_LIGHT = {
  ...WAVES_CLASSIC,
  total: (n) => 4 + n * 3,
  maxAlive: (n) => Math.min(6 + n * 2, 24),
  mix: (n, r) => (n >= 5 && r < 0.05) ? 'brute' : (r < 0.35 + n * 0.03) ? 'runner' : (r < 0.7) ? 'jogger' : 'walker',
  sleepers: (n) => 1 + Math.min(n, 3),
  stampede: { from: 2, first: [20, 30], every: [30, 45], count: (n) => 4 + n },
};

/** Variante pesada: brutos desde la segunda y estampidas seguidas. */
export const WAVES_HEAVY = {
  ...WAVES_CLASSIC,
  total: (n) => 8 + n * 5 + Math.floor(n * n * 0.5),
  maxAlive: (n) => Math.min(12 + n * 3, 44),
  interval: (n) => Math.max(0.2, 1.0 - n * 0.08),
  mix: (n, r) => (n >= 2 && r < 0.08 + n * 0.015) ? 'brute' : (r < 0.5 + n * 0.04) ? 'runner' : (r < 0.85) ? 'jogger' : 'walker',
  stampede: { from: 1, first: [10, 16], every: [16, 26], count: (n) => 7 + n },
};

/** Sin oleadas: sólo lo que la misión pone (y las estampidas, si las pide). */
export const WAVES_NONE = { ...WAVES_LIGHT, enabled: false };

const es_en = (es, en) => ({ es, en });

export const CAMPAIGN = [
  {
    id: 'm1', mapId: 'office',
    name: es_en('HORAS EXTRA', 'OVERTIME'),
    brief: es_en('Tres oleadas. Aprendé a moverte antes de que te muerdan.', 'Three waves. Learn to move before they bite.'),
    start: { weapons: ['pistol'] }, sleepers: 9, waves: WAVES_CLASSIC,
    objectives: [{ type: 'waves', n: 3 }],
  },
  {
    id: 'm2', mapId: 'parking',
    name: es_en('EL SUBSUELO', 'THE BASEMENT'),
    brief: es_en('Juntá tres bidones de nafta entre los autos y subí por la rampa.', 'Grab three fuel cans among the cars and climb the ramp.'),
    start: { weapons: ['pistol', 'smg'] }, sleepers: 10, waves: WAVES_LIGHT,
    objectives: [
      { type: 'collect', n: 3, item: 'item.fuel', points: ['obj1', 'obj2', 'obj3'] },
      { type: 'reach', point: 'exit', place: 'place.ramp', r: 1.8 },
    ],
  },
  {
    id: 'm3', mapId: 'super',
    name: es_en('LISTA DE COMPRAS', 'SHOPPING LIST'),
    brief: es_en('Cuatro bolsas de comida, un minuto aguantando en la caja y afuera.', 'Four bags of food, a minute holding the checkout, and out.'),
    start: { weapons: ['pistol', 'smg'] }, sleepers: 12, waves: WAVES_CLASSIC,
    objectives: [
      { type: 'collect', n: 4, item: 'item.food', points: ['obj1', 'obj2', 'obj3', 'obj4'] },
      { type: 'survive', sec: 60 },
      { type: 'reach', point: 'exit', place: 'place.exit', r: 1.8 },
    ],
  },
  {
    id: 'm4', mapId: 'subte',
    name: es_en('ÚLTIMO TREN', 'LAST TRAIN'),
    brief: es_en('Cuatro oleadas en el andén y subite al vagón.', 'Four waves on the platform, then board the car.'),
    start: { weapons: ['pistol', 'shotgun'] }, sleepers: 12, waves: WAVES_HEAVY,
    objectives: [
      { type: 'waves', n: 4 },
      { type: 'reach', point: 'exit', place: 'place.train', r: 1.8 },
    ],
  },
  {
    id: 'm5', mapId: 'hospital',
    name: es_en('TURNO NOCHE', 'NIGHT SHIFT'),
    brief: es_en('Sesenta bajas, tres cajas de remedios y salí por la guardia.', 'Sixty kills, three boxes of meds, and out through the ER.'),
    start: { weapons: ['pistol', 'shotgun'] }, sleepers: 14, waves: WAVES_CLASSIC,
    objectives: [
      { type: 'kill', n: 60 },
      { type: 'collect', n: 3, item: 'item.meds', points: ['obj1', 'obj2', 'obj3', 'obj4'] },
      { type: 'reach', point: 'exit', place: 'place.ambulance', r: 1.8 },
    ],
  },
  {
    id: 'm6', mapId: 'office',
    name: es_en('DE VUELTA A LA OFICINA', 'BACK TO THE OFFICE'),
    brief: es_en('Cinco oleadas. Los brutos llegan desde la segunda.', 'Five waves. Brutes arrive from the second one.'),
    start: { weapons: ['pistol', 'shotgun', 'rifle'] }, sleepers: 10, waves: WAVES_HEAVY,
    objectives: [{ type: 'waves', n: 5 }],
  },
  {
    id: 'm7', mapId: 'parking',
    name: es_en('LA ESTAMPIDA', 'THE STAMPEDE'),
    brief: es_en('Tres minutos con los corredores entrando por todas las puertas. Después, la rampa.', 'Three minutes with runners pouring through every door. Then the ramp.'),
    start: { weapons: ['pistol', 'smg', 'rifle'] }, sleepers: 6,
    waves: { ...WAVES_LIGHT, stampede: { from: 1, first: [6, 9], every: [11, 16], count: (n) => 8 + n } },
    objectives: [
      { type: 'survive', sec: 180 },
      { type: 'reach', point: 'exit', place: 'place.ramp', r: 1.8 },
    ],
  },
  {
    id: 'm8', mapId: 'subte',
    name: es_en('EL FIN DEL VIAJE', 'END OF THE LINE'),
    brief: es_en('Seis oleadas, treinta más de yapa y el último vagón.', 'Six waves, thirty more for good measure, and the last car.'),
    start: { weapons: ['pistol', 'smg', 'shotgun', 'rifle'] }, sleepers: 14, waves: WAVES_HEAVY,
    objectives: [
      { type: 'waves', n: 6 },
      { type: 'kill', n: 30 },
      { type: 'reach', point: 'exit', place: 'place.train', r: 1.8 },
    ],
  },
];

export function missionById(id) { return CAMPAIGN.find(m => m.id === id) || null; }

/** El modo infinito en un mapa: oleadas clásicas y ningún objetivo. */
export function infiniteMission(mapId) {
  return { id: 'inf_' + mapId, mapId, infinite: true, name: es_en('INFINITO', 'ENDLESS'), brief: es_en('Oleadas sin fin.', 'Endless waves.'),
    start: { weapons: ['pistol'] }, sleepers: 9, waves: WAVES_CLASSIC, objectives: [] };
}

/**
 * El polígono (desde la armería): el arma elegida en la mano, la pistola de
 * respaldo, la oficina con horda liviana y sin premios; no cuenta para nada.
 */
export function rangeMission(key) {
  const weapons = key === 'pistol' ? ['pistol'] : ['pistol', key];
  return {
    id: 'range_' + key, mapId: 'office', practice: true, name: es_en('POLÍGONO', 'RANGE'),
    brief: es_en('Probá el arma todo lo que quieras.', 'Try the weapon as long as you like.'),
    start: { weapons, hold: key }, sleepers: 8,
    waves: { ...WAVES_LIGHT, rewards: false, firstDelay: 3, stampede: { from: 3, first: [40, 60], every: [50, 70], count: (n) => 4 + n } },
    objectives: [],
  };
}

/** Objetos que se juntan en las misiones: color del brillo y nombre corto. */
export const ITEM_STYLE = {
  'item.fuel': { color: 0xff7a2a },
  'item.food': { color: 0x7ad04a },
  'item.meds': { color: 0x4ad0ff },
  'item.keys': { color: 0xffd24a },
  'item.files': { color: 0xe8e2d2 },
};

/**
 * Lleva los objetivos de una misión. El juego le avisa las bajas y las
 * cosas juntadas, y le pregunta el texto del HUD y adónde apuntar el marcador.
 */
export class MissionManager {
  /**
   * @param def  definición de la misión
   * @param host {points, kills(), wavesCleared(), playerPos(), spawnObjective(x,z,item), announce(big,small), toast(txt), onWon()}
   */
  constructor(def, host) {
    this.def = def;
    this.host = host;
    this.idx = -1;
    this.done = false;
    this.k = 0;              // progreso del objetivo actual (bajas, cosas, oleadas)
    this.t = 0;              // segundos en el objetivo actual
    this.base = 0;           // bajas u oleadas al empezar el objetivo
    this.items = [];         // pickups de objetivo vivos: {x, z, taken}
    this.startedAt = 0;
  }

  get current() { return this.idx >= 0 && this.idx < this.def.objectives.length ? this.def.objectives[this.idx] : null; }
  get total() { return this.def.objectives.length; }

  start() {
    if (this.def.infinite || !this.def.objectives.length) return;
    this._next(false);
  }

  _next(announceDone) {
    const H = this.host;
    if (announceDone) H.announce(t('ann.objectiveDone'), this.describe());
    this.idx++;
    this.k = 0; this.t = 0; this.items = [];
    const o = this.current;
    if (!o) { this.done = true; H.onWon(); return; }
    if (o.type === 'kill') this.base = H.kills();
    if (o.type === 'waves') this.base = H.wavesCleared();
    if (o.type === 'collect') {
      const pts = (o.points || []).map(n => H.points[n]).filter(Boolean);
      for (let i = 0; i < o.n; i++) {
        const p = pts[i] || H.randomSpot();
        if (!p) continue;
        this.items.push({ x: p.x, z: p.z, taken: false });
        H.spawnObjective(p.x, p.z, o.item);
      }
    }
    const last = this.idx === this.total - 1;
    // el anuncio anterior (el nombre de la misión, o el "listo") tiene prioridad un instante
    const say = () => H.announce(t(last && this.total > 1 ? 'ann.lastObjective' : 'ann.objective'), this.describe());
    H.later(say, announceDone ? 2.2 : 3.4);
  }

  update(dt) {
    const o = this.current;
    if (!o || this.done) return;
    this.t += dt;
    const H = this.host;
    let ok = false;
    switch (o.type) {
      case 'waves': this.k = H.wavesCleared() - this.base; ok = this.k >= o.n; break;
      case 'kill': this.k = H.kills() - this.base; ok = this.k >= o.n; break;
      case 'survive': ok = this.t >= o.sec; break;
      case 'collect': ok = this.k >= o.n; break;
      case 'reach': {
        const p = H.points[o.point], P = H.playerPos();
        ok = !!p && Math.hypot(P.x - p.x, P.z - p.z) < (o.r || 1.8);
        break;
      }
    }
    if (ok) this._next(true);
  }

  /** Se juntó una cosa de objetivo (el juego lo llama al levantar un pickup 'objective'). */
  onPickup(item) {
    const o = this.current;
    if (!o || o.type !== 'collect') return;
    this.k++;
    const it = this.items.find(i => !i.taken && Math.hypot(i.x - item.x, i.z - item.z) < 0.01) || this.items.find(i => !i.taken);
    if (it) it.taken = true;
    this.host.toast(t('toast.objectiveItem', { what: t(o.item + '.one'), k: this.k, n: o.n }));
  }

  /** Descripción del objetivo actual (línea del HUD). */
  describe(o = this.current) {
    if (!o) return '';
    switch (o.type) {
      case 'waves': return t('obj.waves', { n: o.n });
      case 'kill': return t('obj.kill', { n: o.n });
      case 'survive': return t('obj.survive', { t: fmtTime(o.sec) });
      case 'reach': return t('obj.reach', { place: t(o.place || 'place.exit') });
      case 'collect': return t('obj.collect', { n: o.n, what: t(o.item) });
    }
    return '';
  }

  /** Progreso corto ("2/5", "faltan 0:40", "12 m"). */
  progress() {
    const o = this.current;
    if (!o) return '';
    switch (o.type) {
      case 'waves': return t('obj.waves.p', { k: Math.min(o.n, this.host.wavesCleared() - this.base + (this.host.waveActive() ? 1 : 0)), n: o.n });
      case 'kill': return t('obj.kill.p', { k: Math.min(o.n, this.k), n: o.n });
      case 'survive': return t('obj.survive.p', { t: fmtTime(Math.ceil(Math.max(0, o.sec - this.t))) });   // cuenta regresiva: 0:00 sólo al final
      case 'collect': return t('obj.collect.p', { k: this.k, n: o.n });
      case 'reach': {
        const tg = this.target();
        if (!tg) return '';
        const P = this.host.playerPos();
        return t('obj.reach.p', { d: Math.round(Math.hypot(P.x - tg.x, P.z - tg.z)) });
      }
    }
    return '';
  }

  /** Adónde apunta el marcador: el punto a alcanzar o la cosa más cercana que falta juntar. */
  target() {
    const o = this.current;
    if (!o) return null;
    if (o.type === 'reach') return this.host.points[o.point] || null;
    if (o.type === 'collect') {
      const P = this.host.playerPos();
      let best = null, bd = Infinity;
      for (const it of this.items) {
        if (it.taken) continue;
        const d = Math.hypot(it.x - P.x, it.z - P.z);
        if (d < bd) { bd = d; best = it; }
      }
      return best;
    }
    return null;
  }
}
