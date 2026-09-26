// ─────────────────────────────────────────────────────────────────────────────
//  catalog.js — El arsenal completo: las 4 clásicas y las 100 nuevas.
//
//  Sólo datos (sin Three ni DOM: se prueba en Node). Cada arma se escribe
//  como la DIFERENCIA con la plantilla de su familia: números, forma del
//  modelo, paleta, cómo se ve y suena el tiro. `build()` mezcla, congela y
//  valida TODO una vez al cargar (el contrato vive acá, en la frontera): si
//  un arma está mal escrita, el juego no arranca y dice cuál y por qué.
//
//  Los nombres son de acá: aves de presa para las pistolas, gauchos para los
//  revólveres, víboras e insectos para los subfusiles, bichos grandes para
//  las escopetas, felinos y ciervos para los fusiles, cerros para los
//  francotiradores, vientos para las ametralladoras, volcanes para los
//  lanzadores, estrellas del sur para las de energía y mitos del monte para
//  las exóticas.
//
//  Ranuras (teclas 1–5): 1 de mano · 2 subfusiles · 3 escopetas · 4 fusiles ·
//  5 pesadas. El jugador lleva una por ranura.
// ─────────────────────────────────────────────────────────────────────────────

const es_en = (es, en) => Object.freeze({ es, en });

// ═════════════════════════════════════════════════════════════════════════════
//  Rarezas (colores Catppuccin: se leen sobre el negro del HUD)
// ═════════════════════════════════════════════════════════════════════════════
export const RARITY = Object.freeze([
  Object.freeze({ id: 0, key: 'common', color: '#bac2de', name: es_en('común', 'common'), weight: 1.0 }),
  Object.freeze({ id: 1, key: 'uncommon', color: '#a6e3a1', name: es_en('poco común', 'uncommon'), weight: 0.62 }),
  Object.freeze({ id: 2, key: 'rare', color: '#89b4fa', name: es_en('rara', 'rare'), weight: 0.34 }),
  Object.freeze({ id: 3, key: 'epic', color: '#cba6f7', name: es_en('épica', 'epic'), weight: 0.16 }),
  Object.freeze({ id: 4, key: 'legendary', color: '#f9e2af', name: es_en('legendaria', 'legendary'), weight: 0.06 }),
]);

export const SLOTS = Object.freeze([
  es_en('DE MANO', 'SIDEARMS'), es_en('SUBFUSILES', 'SMGS'), es_en('ESCOPETAS', 'SHOTGUNS'),
  es_en('FUSILES', 'RIFLES'), es_en('PESADAS', 'HEAVY'),
]);
export const SLOT_COUNT = 5;

// colores de trazadora / luz
const C = Object.freeze({
  warm: '#ffd79a', hot: '#ffb36b', green: '#a6e3a1', red: '#f38ba8', blue: '#89b4fa', violet: '#cba6f7',
  teal: '#94e2d5', gold: '#f9e2af', white: '#f5f7ff', orange: '#fab387', ice: '#b8e6ff', acid: '#b5f25a',
  sky: '#89dceb', pink: '#f5c2e7', lav: '#b4befe',
});

// ═════════════════════════════════════════════════════════════════════════════
//  Familias: la plantilla de cada tipo
// ═════════════════════════════════════════════════════════════════════════════
const BASE_STATS = Object.freeze({
  dmg: 30, rate: 6, auto: false, burst: 0, burstRate: 14, windup: 0, spread: 0.02, pellets: 1, impulse: 7,
  mag: 12, reserve: 60, reload: 1.2, regen: 0, range: 45, kick: 0.22, shake: 0.1, pierce: 0, falloff: 0,
});

export const FAMILIES = Object.freeze({
  pistol: {
    slot: 1, name: es_en('PISTOLA', 'PISTOL'), hold: 'pistol',
    stats: { dmg: 28, rate: 6.5, spread: 0.018, impulse: 7, mag: 13, reserve: Infinity, reload: 1.1 },
    shot: { kind: 'bullet', tracer: C.warm, width: 0.013, flash: 'std', casing: 'pistol', sound: 'pistol' },
    model: { b: 'pistol' },
  },
  revolver: {
    slot: 1, name: es_en('REVÓLVER', 'REVOLVER'), hold: 'pistol',
    stats: { dmg: 62, rate: 2.7, spread: 0.012, impulse: 13, mag: 6, reserve: 36, reload: 2.4, range: 52, kick: 0.5, shake: 0.2 },
    shot: { kind: 'bullet', tracer: C.hot, width: 0.018, flash: 'big', casing: 'none', sound: 'magnum', smoke: 1 },
    model: { b: 'revolver' },
  },
  mpistol: {
    slot: 1, name: es_en('PISTOLA AMETRALLADORA', 'MACHINE PISTOL'), hold: 'pistol',
    stats: { dmg: 14, rate: 15, auto: true, spread: 0.06, impulse: 4.5, mag: 30, reserve: 120, reload: 1.4, range: 34, kick: 0.14, shake: 0.07 },
    shot: { kind: 'bullet', tracer: C.warm, width: 0.012, flash: 'std', casing: 'pistol', sound: 'smg_light' },
    model: { b: 'mpistol' },
  },
  smg: {
    slot: 2, name: es_en('SUBFUSIL', 'SMG'), hold: 'rifle',
    stats: { dmg: 17, rate: 13, auto: true, spread: 0.05, impulse: 4.5, mag: 32, reserve: 128, reload: 1.8, range: 40, kick: 0.13, shake: 0.07 },
    shot: { kind: 'bullet', tracer: C.warm, width: 0.013, flash: 'std', casing: 'pistol', sound: 'smg' },
    model: { b: 'smg' },
  },
  shotgun: {
    slot: 3, name: es_en('ESCOPETA', 'SHOTGUN'), hold: 'rifle',
    stats: { dmg: 14, rate: 1.3, spread: 0.1, pellets: 9, impulse: 9, mag: 6, reserve: 24, reload: 2.4, range: 24, kick: 0.6, shake: 0.32, falloff: 1 },
    shot: { kind: 'bullet', tracer: C.warm, width: 0.009, flash: 'shotgun', casing: 'shell', sound: 'shotgun', smoke: 1 },
    model: { b: 'pump' },
  },
  autoshot: {
    slot: 3, name: es_en('ESCOPETA AUTOMÁTICA', 'AUTO SHOTGUN'), hold: 'rifle',
    stats: { dmg: 11, rate: 3.6, auto: false, spread: 0.11, pellets: 8, impulse: 8, mag: 10, reserve: 40, reload: 2.7, range: 22, kick: 0.5, shake: 0.26, falloff: 1 },
    shot: { kind: 'bullet', tracer: C.warm, width: 0.009, flash: 'shotgun', casing: 'shell', sound: 'shotgun_auto', smoke: 1 },
    model: { b: 'autoshot' },
  },
  assault: {
    slot: 4, name: es_en('FUSIL DE ASALTO', 'ASSAULT RIFLE'), hold: 'rifle',
    stats: { dmg: 32, rate: 10, auto: true, spread: 0.028, impulse: 11, mag: 30, reserve: 120, reload: 2.2, range: 58, kick: 0.26, shake: 0.12 },
    shot: { kind: 'bullet', tracer: C.warm, width: 0.015, flash: 'std', casing: 'rifle', sound: 'rifle' },
    model: { b: 'rifle' },
  },
  battle: {
    slot: 4, name: es_en('FUSIL DE BATALLA', 'BATTLE RIFLE'), hold: 'rifle',
    stats: { dmg: 62, rate: 4.5, spread: 0.014, impulse: 15, mag: 20, reserve: 80, reload: 2.6, range: 66, kick: 0.42, shake: 0.18, pierce: 1 },
    shot: { kind: 'bullet', tracer: C.warm, width: 0.018, flash: 'brake', casing: 'rifle', sound: 'battle', scope: 0.3 },
    model: { b: 'battle' },
  },
  sniper: {
    slot: 4, name: es_en('FRANCOTIRADOR', 'SNIPER RIFLE'), hold: 'rifle',
    stats: { dmg: 140, rate: 1.05, spread: 0.004, impulse: 24, mag: 5, reserve: 30, reload: 3.0, range: 95, kick: 0.9, shake: 0.35, pierce: 2 },
    shot: { kind: 'bullet', tracer: C.white, width: 0.024, flash: 'brake', casing: 'rifle', sound: 'sniper', trail: 1, scope: 0.85, smoke: 1 },
    model: { b: 'sniper' },
  },
  lmg: {
    slot: 5, name: es_en('AMETRALLADORA', 'MACHINE GUN'), hold: 'heavy',
    stats: { dmg: 30, rate: 11, auto: true, spread: 0.042, impulse: 12, mag: 100, reserve: 200, reload: 4.2, range: 60, kick: 0.22, shake: 0.11, pierce: 1 },
    shot: { kind: 'bullet', tracer: C.warm, width: 0.016, flash: 'std', casing: 'link', sound: 'lmg' },
    model: { b: 'lmg' },
  },
  rotary: {
    slot: 5, name: es_en('ROTATIVA', 'MINIGUN'), hold: 'heavy',
    stats: { dmg: 18, rate: 26, auto: true, windup: 0.5, spread: 0.06, impulse: 6, mag: 300, reserve: 300, reload: 5.5, range: 55, kick: 0.07, shake: 0.05 },
    shot: { kind: 'bullet', tracer: C.warm, width: 0.013, flash: 'mini', casing: 'link', sound: 'minigun' },
    model: { b: 'rotary' },
  },
  launcher: {
    slot: 5, name: es_en('LANZADOR', 'LAUNCHER'), hold: 'shoulder',
    stats: { dmg: 0, rate: 1, spread: 0.01, impulse: 0, mag: 1, reserve: 10, reload: 1.6, range: 60, kick: 0.7, shake: 0.4 },
    shot: { kind: 'proj', flash: 'launch', casing: 'none', sound: 'gl' },
    model: { b: 'launcher' },
  },
  energy: {
    slot: 4, name: es_en('ENERGÍA', 'ENERGY'), hold: 'rifle',
    stats: { dmg: 30, rate: 6, spread: 0.008, impulse: 8, mag: 30, reserve: Infinity, reload: 2.4, regen: 4, range: 60, kick: 0.12, shake: 0.08 },
    shot: { kind: 'beam', tracer: C.blue, width: 0.02, flash: 'energy', casing: 'none', sound: 'laser' },
    model: { b: 'energy' },
  },
  exotic: {
    slot: 5, name: es_en('EXÓTICA', 'EXOTIC'), hold: 'rifle',
    stats: { dmg: 40, rate: 1.2, spread: 0.01, impulse: 10, mag: 5, reserve: 30, reload: 2.2, range: 40, kick: 0.3, shake: 0.16 },
    shot: { kind: 'proj', flash: 'none', casing: 'none', sound: 'bow' },
    model: { b: 'exotic' },
  },
});

// proyectiles: plantillas por aspecto (el arma ajusta lo que quiera). `aim`:
// 'lob' cae en el piso bajo el mouse; si no está, 'direct' (llega al torso).
const PROJ = Object.freeze({
  grenade: { look: 'grenade', aim: 'lob', speed: 21, grav: 13, drag: 0.02, bounce: 0.34, fuse: 1.4, radius: 3.2, blast: 150, force: 26, contact: true, trail: 'smoke' },
  rocket: { look: 'rocket', speed: 16, accel: 46, maxSpeed: 58, grav: 0, radius: 4.0, blast: 230, force: 34, contact: true, trail: 'rocket' },
  mini: { look: 'mini', speed: 22, accel: 30, maxSpeed: 44, grav: 0, radius: 2.2, blast: 85, force: 20, contact: true, trail: 'rocket', homing: 3.2 },
  orb: { look: 'orb', speed: 30, grav: 0, radius: 0, dmg: 40, contact: true, trail: 'glow' },
  bolt: { look: 'bolt', speed: 58, grav: 3, radius: 0, dmg: 150, contact: true, stick: true, trail: 'none', pierce: 1 },
  nail: { look: 'nail', speed: 85, grav: 1, radius: 0, dmg: 22, contact: true, stick: true, trail: 'none' },
  disc: { look: 'disc', speed: 24, grav: 0, radius: 0, dmg: 60, contact: true, bounce: 0.95, bounces: 3, pierce: 6, trail: 'sparks' },
  flare: { look: 'flare', speed: 26, grav: 6, radius: 0, dmg: 40, contact: true, stick: true, trail: 'flare', burn: 5 },
  glob: { look: 'glob', aim: 'lob', speed: 17, grav: 12, radius: 2.2, blast: 30, force: 6, contact: true, trail: 'drip', acid: 5, pool: 4 },
  harpoon: { look: 'harpoon', speed: 40, grav: 4, radius: 0, dmg: 180, contact: true, stick: true, pierce: 2, trail: 'none' },
  sticky: { look: 'sticky', aim: 'lob', speed: 20, grav: 10, radius: 3.0, blast: 160, force: 28, stickAll: true, fuse: 1.1, trail: 'blink' },
  vortex: { look: 'vortex', aim: 'lob', speed: 18, grav: 9, radius: 3.0, blast: 120, force: 26, fuse: 0.9, pull: 5.5, pullT: 1.2, contact: true, trail: 'glow' },
  ion: { look: 'ion', speed: 13, grav: 0, radius: 3.6, blast: 190, force: 30, contact: true, trail: 'glow', shock: 1 },
  cluster: { look: 'grenade', aim: 'lob', speed: 20, grav: 13, drag: 0.02, bounce: 0.3, fuse: 1.0, radius: 2.6, blast: 110, force: 22, contact: true, trail: 'smoke', split: 5 },
});

// ═════════════════════════════════════════════════════════════════════════════
//  Las armas
//   k clave · f familia · r rareza · n nombre · t lema (es, en)
//   s números · m modelo · l paleta · x tiro (visual/sonido/efectos)
//   fx efectos al pegar: burn freeze shock acid he ricochet lifesteal hs sever
// ═════════════════════════════════════════════════════════════════════════════
const W = [];
const w = (o) => W.push(o);

// ── CLÁSICAS (los números no se tocan: las misiones y las pruebas los usan) ──
w({ k: 'pistol', f: 'pistol', r: 0, n: null, classic: true, t: es_en('La de siempre. Munición infinita.', 'The old reliable. Infinite ammo.'),
  s: { dmg: 30, rate: 6.5, spread: 0.018, impulse: 7, mag: 12, reserve: Infinity, reload: 1.05, range: 45, kick: 0.22, shake: 0.10 },
  m: { len: 0.19 }, l: { body: 'polymer:#22242a', body2: 'brushed:#b6bcc4', grip: 'stipple:#1f2025' } });
w({ k: 'smg', f: 'smg', r: 0, n: null, classic: true, t: es_en('Mucho plomo, poco pulso.', 'Lots of lead, little aim.'),
  s: { dmg: 17, rate: 13, auto: true, spread: 0.05, impulse: 4.5, mag: 32, reserve: 96, reload: 1.7, range: 40, kick: 0.13, shake: 0.07 },
  m: { style: 'mac', stock: 'fold', mag: 'box', hl: 0.06, bl: 0.08 }, l: { body: 'polymer:#17181c', hg: 'polymer:#1c1d21' } });
w({ k: 'shotgun', f: 'shotgun', r: 0, n: null, classic: true, t: es_en('Nueve perdigones de sentido común.', 'Nine pellets of common sense.'),
  s: { dmg: 14, rate: 1.3, spread: 0.10, pellets: 9, impulse: 9, mag: 6, reserve: 18, reload: 2.3, range: 24, kick: 0.6, shake: 0.32, falloff: 1 },
  m: { bl: 0.5 }, l: { body: 'parkerized:#23252a', pump: 'wood:#6d452a/#33200f', stock: 'wood:#6d452a/#33200f' } });
w({ k: 'rifle', f: 'assault', r: 0, n: null, classic: true, t: es_en('Atraviesa uno y sigue.', 'Goes through one and keeps going.'),
  s: { dmg: 44, rate: 8.5, auto: true, spread: 0.028, impulse: 13, mag: 30, reserve: 90, reload: 2.1, range: 60, kick: 0.28, shake: 0.12, pierce: 1 },
  m: { hg: 'wood', gas: true, mag: 'curved', magCurve: 0.9, stock: 'fixed', md: 'brake', drop: 0.03, hl: 0.2, bl: 0.2 },
  l: { body: 'polymer:#6a6a3c', hg: 'wood:#6d452a/#33200f', stock: 'wood:#6d452a/#33200f', mag: 'parkerized:#2a2c30' } });

// ── PISTOLAS: aves de presa y pájaros de ciudad ──────────────────────────────
w({ k: 'chimango', f: 'pistol', r: 0, n: 'CHIMANGO', t: es_en('Compacta y noble: la primera que agarrás.', 'Compact and honest: the first one you grab.'),
  s: { dmg: 26, rate: 7.5, mag: 15, spread: 0.02 }, m: { len: 0.175, sh: 0.031 },
  l: { body: 'polymer:#25272c', body2: 'parkerized:#2f3237' } });
w({ k: 'benteveo', f: 'pistol', r: 0, n: 'BENTEVEO', t: es_en('Dos tonos, un solo grito.', 'Two tones, one shout.'),
  s: { dmg: 31, rate: 6.3, mag: 13 }, m: { len: 0.195, hammer: true },
  l: { body: 'polymer:#5d6142', body2: 'brushed:#aab1ba', glow: C.gold } });
w({ k: 'hornero', f: 'pistol', r: 1, n: 'HORNERO', t: es_en('Compensador de fábrica: casi no salta.', 'Factory comp: it barely jumps.'),
  s: { dmg: 30, rate: 7.2, mag: 15, spread: 0.015, kick: 0.15 }, m: { len: 0.2, comp: true, cuts: true },
  l: { body: 'polymer:#2a2c31', body2: 'cerakote:#6c7380', glow: C.orange } });
w({ k: 'calandria', f: 'pistol', r: 1, n: 'CALANDRIA', t: es_en('Canta bajito. Nadie se da vuelta.', 'Sings softly. Nobody turns around.'),
  s: { dmg: 28, rate: 6.2, mag: 14 }, m: { len: 0.19, sup: 0.15 },
  l: { body: 'polymer:#1f2024', body2: 'parkerized:#2c2e33', sup: 'cerakote:#8f7b5a' }, x: { flash: 'sup', sound: 'pistol', fx: { silenced: true } } });
w({ k: 'zorzal', f: 'pistol', r: 1, n: 'ZORZAL', t: es_en('Punto rojo y láser: no hay excusa.', 'Red dot and laser: no excuses.'),
  s: { dmg: 32, rate: 6.5, mag: 13, spread: 0.014 }, m: { len: 0.19, dot: true, laser: true },
  l: { body: 'cerakote:#8fa88a', body2: 'parkerized:#2a2c31', glow: C.red }, x: { fx: { laser: C.red } } });
w({ k: 'gavilan', f: 'pistol', r: 2, n: 'GAVILÁN', t: es_en('Calibre .45: cada tiro empuja.', '.45 caliber: every shot shoves.'),
  s: { dmg: 42, rate: 5.2, mag: 9, impulse: 10.5, kick: 0.3 }, m: { len: 0.215, sh: 0.034, hammer: true, gripA: 0.2 },
  l: { body: 'brushed:#aeb4bc', body2: 'brushed:#b8bec6', grip: 'wood:#7a4a2a/#3a2213', metal: 'brushed:#9aa1aa' }, x: { sound: 'heavypistol', tracer: C.hot } });
w({ k: 'aguilucho', f: 'pistol', r: 2, n: 'AGUILUCHO', t: es_en('Pistola de carrera: cargador largo y caño dorado.', 'Race gun: long mag, golden barrel.'),
  s: { dmg: 30, rate: 8.4, mag: 24, spread: 0.014, kick: 0.14 }, m: { len: 0.22, comp: true, cuts: true, dot: true, ext: 0.035 },
  l: { body: 'cerakote:#9f8cc7', body2: 'parkerized:#26282c', metal: 'gold', glow: C.pink } });
w({ k: 'cernicalo', f: 'pistol', r: 3, n: 'CERNÍCALO', t: es_en('Balas incendiarias: prende lo que toca.', 'Incendiary rounds: sets alight what it hits.'),
  s: { dmg: 30, rate: 6.8, mag: 14 }, m: { len: 0.2, cuts: true },
  l: { body: 'polymer:#26282c', body2: 'brass:#b8733d/#6b3d20', glow: C.orange }, x: { tracer: C.orange, width: 0.016, fx: { burn: 3 } } });
w({ k: 'halcon', f: 'pistol', r: 4, n: 'HALCÓN', t: es_en('Oro grabado y cachas de marfil. Cabeza por cuatro y medio.', 'Engraved gold, ivory grips. Headshots ×4.5.'),
  s: { dmg: 48, rate: 5.8, mag: 9, impulse: 12, spread: 0.012, kick: 0.3 }, m: { len: 0.215, hammer: true, gripA: 0.2 },
  l: { body: 'gold', body2: 'gold', grip: 'ivory', metal: 'gold', glow: C.gold }, x: { tracer: C.gold, width: 0.018, sound: 'heavypistol', fx: { hs: 1.12 } } });

// ── REVÓLVERES: gente de campo ───────────────────────────────────────────────
w({ k: 'baqueano', f: 'revolver', r: 0, n: 'BAQUEANO', t: es_en('Cañón corto: conoce todos los atajos.', 'Snub nose: knows every shortcut.'),
  s: { dmg: 52, rate: 3.2, mag: 5, spread: 0.018, range: 38 }, m: { bl: 0.055, cylR: 0.022, gripL: 0.085 },
  l: { body: 'blued', metal: 'blued', grip: 'wood:#8a5a32/#3f2512' } });
w({ k: 'matrero', f: 'revolver', r: 1, n: 'MATRERO', t: es_en('Seis pulgadas de acero inoxidable.', 'Six inches of stainless steel.'),
  s: { dmg: 64, rate: 2.8 }, m: { bl: 0.15, lug: 'full' },
  l: { body: 'brushed:#b3b9c1', metal: 'brushed:#b9bfc7', grip: 'rubber:#1d1e22' } });
w({ k: 'payador', f: 'revolver', r: 1, n: 'PAYADOR', t: es_en('Largo, con mira: contesta de lejos.', 'Long and scoped: answers from afar.'),
  s: { dmg: 72, rate: 2.4, spread: 0.008, range: 62 }, m: { bl: 0.21, scope: true, lug: 'half' },
  l: { body: 'blued', metal: 'blued', grip: 'wood:#6e4326/#352012', body2: 'parkerized:#23252a' }, x: { scope: 0.35 } });
w({ k: 'cimarron', f: 'revolver', r: 2, n: 'CIMARRÓN', t: es_en('Acción simple a abanico: seis tiros en un parpadeo.', 'Single action fanning: six shots in a blink.'),
  s: { dmg: 56, rate: 4.8, spread: 0.03, reload: 2.8 }, m: { bl: 0.19, sa: true, rib: false, gripL: 0.11 },
  l: { body: 'blued:#1f2533/#5b4a70', metal: 'blued', grip: 'ivory' } });
w({ k: 'cuatrero', f: 'revolver', r: 3, n: 'CUATRERO', t: es_en('Calibre .500: arranca brazos.', '.500 caliber: rips arms off.'),
  s: { dmg: 115, rate: 1.8, mag: 5, impulse: 22, kick: 0.85, shake: 0.3, pierce: 1 }, m: { bl: 0.2, cylR: 0.03, cylL: 0.05, lug: 'full', brake: true },
  l: { body: 'parkerized:#26282c', metal: 'parkerized:#2d3036', grip: 'rubber:#1d1e22', glow: C.red }, x: { sound: 'magnum_heavy', width: 0.022, fx: { sever: 1.6 } } });
w({ k: 'rastreador', f: 'revolver', r: 4, n: 'RASTREADOR', t: es_en('Balas explosivas. El rastro lo deja él.', 'Explosive rounds. It leaves the trail.'),
  s: { dmg: 70, rate: 2.3 }, m: { bl: 0.16, lug: 'full' },
  l: { body: 'chrome', metal: 'chrome', grip: 'polymer:#1f2024', glow: C.violet }, x: { tracer: C.violet, width: 0.02, fx: { he: { r: 1.4, dmg: 42, force: 12 } } } });

// ── PISTOLAS AMETRALLADORAS: bichos chicos y rápidos ─────────────────────────
w({ k: 'laucha', f: 'mpistol', r: 0, n: 'LAUCHA', t: es_en('Automática de bolsillo con cargador largo.', 'Pocket full-auto with a long mag.'),
  s: { dmg: 13, rate: 17, mag: 33 }, m: { len: 0.185, ext: 0.075 }, l: { body: 'polymer:#222328', body2: 'parkerized:#2c2f34' } });
w({ k: 'cuis', f: 'mpistol', r: 0, n: 'CUIS', t: es_en('Ráfagas de tres: corto y al pecho.', 'Three-round bursts: short, center mass.'),
  s: { dmg: 18, rate: 4.5, auto: false, burst: 3, burstRate: 18, mag: 21, spread: 0.03 }, m: { len: 0.19, ext: 0.045 },
  l: { body: 'polymer:#5e636b', body2: 'parkerized:#2a2c31' } });
w({ k: 'huron', f: 'mpistol', r: 1, n: 'HURÓN', t: es_en('Ráfaga, culatín y agarradera: una pistola que quiere ser subfusil.', 'Burst, brace and foregrip: a pistol that wants to be an SMG.'),
  s: { dmg: 17, rate: 4.2, auto: false, burst: 3, burstRate: 20, mag: 24, spread: 0.026 }, m: { len: 0.21, ext: 0.06, fg: true, stub: true },
  l: { body: 'polymer:#b09a74', body2: 'parkerized:#2a2c31', grip: 'stipple:#9c8664' }, hold: 'rifle' });
w({ k: 'comadreja', f: 'mpistol', r: 2, n: 'COMADREJA', t: es_en('Silenciada y con láser: entra y sale sin ruido.', 'Suppressed with a laser: in and out, no noise.'),
  s: { dmg: 15, rate: 16, mag: 30, spread: 0.05 }, m: { len: 0.19, ext: 0.06, sup: 0.12, laser: true },
  l: { body: 'cerakote:#d9a07a', body2: 'parkerized:#26282c', glow: C.red }, x: { flash: 'sup', fx: { silenced: true, laser: C.red } } });
w({ k: 'zorrino', f: 'mpistol', r: 3, n: 'ZORRINO', t: es_en('Munición ácida: lo que no mata, lo derrite.', 'Acid rounds: what does not kill, melts.'),
  s: { dmg: 13, rate: 16, mag: 30 }, m: { len: 0.19, ext: 0.07, stub: true },
  l: { body: 'polymer:#1c1d21', body2: 'enamel:#e8ebef', glow: C.acid }, x: { tracer: C.acid, fx: { acid: 3 } } });

// ── SUBFUSILES: insectos y víboras ───────────────────────────────────────────
w({ k: 'jejen', f: 'smg', r: 0, n: 'JEJÉN', t: es_en('Cargador arriba y cincuenta picaduras.', 'Top-loaded, fifty bites.'),
  s: { dmg: 12, rate: 16, mag: 50, reserve: 150, spread: 0.055 }, m: { style: 'bullpup', sight: 'dot' },
  l: { body: 'polymer:#b09a74', grip: 'stipple:#26282c', lens: '#4a3f2c' } });
w({ k: 'tabano', f: 'smg', r: 0, n: 'TÁBANO', t: es_en('El clásico de las fuerzas especiales.', 'The special forces classic.'),
  s: { dmg: 17, rate: 12.5, spread: 0.04 }, m: { style: 'box', stock: 'tube', mag: 'curved', magCurve: 0.55, md: 'none' },
  l: { body: 'polymer:#1f2024', hg: 'polymer:#222327' } });
w({ k: 'camoati', f: 'smg', r: 1, n: 'CAMOATÍ', t: es_en('Supresor integral: zumba, no truena.', 'Integral suppressor: it buzzes, not booms.'),
  s: { dmg: 16, rate: 12 }, m: { style: 'box', sup: 0.18, stock: 'fold', mag: 'curved', magCurve: 0.5 },
  l: { body: 'polymer:#5d6142', hg: 'polymer:#5d6142', sup: 'parkerized:#2a2c31' }, x: { flash: 'sup', fx: { silenced: true } } });
w({ k: 'moscardon', f: 'smg', r: 1, n: 'MOSCARDÓN', t: es_en('Tambor de cincuenta y madera de la buena.', 'Fifty-round drum and good wood.'),
  s: { dmg: 18, rate: 11, mag: 50, reserve: 150, reload: 2.6 }, m: { style: 'tube', hg: 'vented', hl: 0.1, mag: 'drum', drumR: 0.066, stock: 'wood', fg: 'vert' },
  l: { body: 'blued', stock: 'wood:#7a4a2a/#3a2213', grip: 'wood:#7a4a2a/#3a2213', mag: 'blued', hg: 'blued' }, x: { sound: 'smg_heavy' } });
w({ k: 'cigarra', f: 'smg', r: 2, n: 'CIGARRA', t: es_en('Veinte tiros por segundo y no se levanta.', 'Twenty rounds a second and it stays flat.'),
  s: { dmg: 15, rate: 20, mag: 33, kick: 0.07, spread: 0.045 }, m: { style: 'vector', mag: 'box', stock: 'skeleton', sight: 'dot', hl: 0.06 },
  l: { body: 'enamel:#dde1e6', hg: 'enamel:#dde1e6', stock: 'polymer:#2a2c31', glow: C.sky }, x: { tracer: C.sky } });
w({ k: 'yarara', f: 'smg', r: 2, n: 'YARARÁ', t: es_en('Silenciosa, rayada y con láser.', 'Silent, striped and laser-sighted.'),
  s: { dmg: 19, rate: 13 }, m: { style: 'box', sup: 0.16, laser: true, mag: 'curved', magCurve: 0.6, stock: 'tube' },
  l: { body: 'tiger:#6b6a45/#1e1f18/#8a7f55', hg: 'tiger:#6b6a45/#1e1f18/#8a7f55', glow: C.green }, x: { flash: 'sup', fx: { silenced: true, laser: C.green } } });
w({ k: 'cascabel', f: 'smg', r: 3, n: 'CASCABEL', t: es_en('Balas de choque: el zombi se sacude y contagia al de al lado.', 'Shock rounds: the zombie jolts and passes it on.'),
  s: { dmg: 18, rate: 14 }, m: { style: 'box', hg: 'vented', sight: 'holo', stock: 'skeleton' },
  l: { body: { f: 'circuit', glowColor: C.violet, glowIntensity: 1.2 }, hg: 'polymer:#1c1d22', glow: C.violet }, x: { tracer: C.violet, fx: { shock: 0.35 } } });
w({ k: 'coral', f: 'smg', r: 3, n: 'CORAL', t: es_en('Rojo, negro y amarillo: incendiaria.', 'Red, black and yellow: incendiary.'),
  s: { dmg: 16, rate: 14.5 }, m: { style: 'mac', stock: 'fold', mag: 'box', hl: 0.07, bl: 0.07 },
  l: { body: 'hazard:#c9412f/#1b1c1f/#e3b341', glow: C.orange }, x: { tracer: C.orange, fx: { burn: 2.5 } } });
w({ k: 'lampalagua', f: 'smg', r: 4, n: 'LAMPALAGUA', t: es_en('Sesenta tiros, atraviesa y cada baja te cura.', 'Sixty rounds, pierces, and every kill heals you.'),
  s: { dmg: 21, rate: 18, mag: 60, reserve: 180, pierce: 1 }, m: { style: 'box', rl: 0.3, mag: 'drum', drumR: 0.06, sight: 'holo', laser: true, stock: 'tube' },
  l: { body: 'blued:#15171d/#2c3446', hg: 'blued:#15171d/#2c3446', mag: 'chrome', glow: C.green }, x: { tracer: C.green, fx: { lifesteal: 4, laser: C.green } } });

// ── ESCOPETAS: bichos grandes ────────────────────────────────────────────────
w({ k: 'carpincho', f: 'shotgun', r: 0, n: 'CARPINCHO', t: es_en('Policial, pesada y tranquila.', 'Police issue, heavy and calm.'),
  s: { dmg: 13, pellets: 8, mag: 7 }, m: { bl: 0.46, stock: 'tac', light: true },
  l: { body: 'polymer:#222328', pump: 'polymer:#26282c', stock: 'polymer:#26282c' } });
w({ k: 'jabali', f: 'shotgun', r: 0, n: 'JABALÍ', t: es_en('Sin culata, cañón corto: para abrir puertas.', 'No stock, short barrel: a door opener.'),
  s: { dmg: 14, pellets: 9, spread: 0.13, rate: 1.5, mag: 5, range: 18 }, m: { bl: 0.3, stock: 'pistol', tubeFrac: 0.9, md: 'hider' },
  l: { body: 'polymer:#5d6142', pump: 'polymer:#4c5037' } });
w({ k: 'pecari', f: 'shotgun', r: 1, n: 'PECARÍ', t: es_en('Cartuchos a mano, linterna y punto rojo.', 'Side-saddle shells, light and red dot.'),
  s: { dmg: 14, pellets: 9, mag: 8, reload: 2.2 }, m: { bl: 0.46, shells: true, shield: true, stock: 'tac', light: true, sight: 'dot' },
  l: { body: 'polymer:#b09a74', pump: 'polymer:#2a2c31', stock: 'polymer:#b09a74', body2: 'parkerized:#2a2c31' } });
w({ k: 'anta', f: 'shotgun', r: 1, n: 'ANTA', t: es_en('Posta única y cañón estriado: una escopeta que apunta.', 'Slug and rifled barrel: a shotgun that aims.'),
  s: { dmg: 95, pellets: 1, spread: 0.01, pierce: 1, impulse: 18, falloff: 0, range: 50, mag: 5 }, m: { bl: 0.52, sight: 'scope', md: 'none' },
  l: { body: 'blued', stock: 'wood:#9a6a3c/#5a3a1e', pump: 'wood:#9a6a3c/#5a3a1e', body2: 'parkerized:#23252a' }, x: { width: 0.02, casing: 'shell', scope: 0.3, sound: 'shotgun_slug' } });
w({ k: 'bagual', f: 'shotgun', r: 2, n: 'BAGUAL', t: es_en('Dos caños, dos tiros seguidos, cero paciencia.', 'Two barrels, two quick shots, zero patience.'),
  s: { dmg: 15, pellets: 10, rate: 4, mag: 2, reload: 1.8, reserve: 24 }, m: { b: 'double', bl: 0.52 },
  l: { body2: 'damascus', metal: 'blued', stock: 'wood:#6e4326/#352012', pump: 'wood:#6e4326/#352012' }, x: { casing: 'none' } });
w({ k: 'toro', f: 'shotgun', r: 3, n: 'TORO', t: es_en('Aliento de dragón: cartuchos incendiarios.', 'Dragon\'s breath: incendiary shells.'),
  s: { dmg: 11, pellets: 10, mag: 6 }, m: { bl: 0.44, shells: true, stock: 'tac', md: 'brake' },
  l: { body: 'parkerized:#1f2024', pump: 'polymer:#2a2c31', stock: 'polymer:#2a2c31', shell: 'brass', glow: C.orange }, x: { tracer: C.orange, fx: { burn: 3.5 }, flash: 'dragon' } });
w({ k: 'quebracho', f: 'shotgun', r: 4, n: 'QUEBRACHO', t: es_en('Doce dardos que atraviesan de a dos. Madera que rompe hachas.', 'Twelve flechettes that pierce two each. Axe-breaking wood.'),
  s: { dmg: 12, pellets: 12, spread: 0.08, pierce: 2, falloff: 0.5, range: 30, mag: 7 }, m: { bl: 0.5, shield: true },
  l: { body: 'chrome', stock: 'wood:#7d2f22/#3f150f', pump: 'wood:#7d2f22/#3f150f', body2: 'chrome', glow: C.teal }, x: { tracer: C.teal, width: 0.008 } });

// ── ESCOPETAS AUTOMÁTICAS: temporales ────────────────────────────────────────
w({ k: 'granizo', f: 'autoshot', r: 0, n: 'GRANIZO', t: es_en('Semiautomática: piedra, piedra, piedra.', 'Semi-auto: stone, stone, stone.'),
  s: { dmg: 12, pellets: 8, rate: 3.2, mag: 7 }, m: { mag: 'tube', stock: 'fixed', md: 'none' },
  l: { body: 'polymer:#232428', stock: 'polymer:#b09a74', hg: 'polymer:#b09a74' } });
w({ k: 'pedrada', f: 'autoshot', r: 1, n: 'PEDRADA', t: es_en('Cargador de caja, freno y punto rojo.', 'Box mag, brake and red dot.'),
  s: { dmg: 11, pellets: 8, rate: 3.8, mag: 10 }, m: { mag: 'box', stock: 'skeleton', md: 'brake', sight: 'dot' },
  l: { body: 'polymer:#1f2024', hg: 'polymer:#26282c', stock: 'polymer:#26282c' } });
w({ k: 'alud', f: 'autoshot', r: 2, n: 'ALUD', t: es_en('Tambor de veinte en automático. No para.', 'Twenty-round drum, full auto. It does not stop.'),
  s: { dmg: 10, pellets: 8, rate: 5, auto: true, mag: 20, reserve: 60, reload: 3.1 }, m: { mag: 'drum', stock: 'fixed', fg: 'vert', sight: 'holo' },
  l: { body: 'enamel:#dde1e6', hg: 'enamel:#dde1e6', stock: 'enamel:#dde1e6', mag: 'polymer:#2a2c31' } });
w({ k: 'sudestada', f: 'autoshot', r: 3, n: 'SUDESTADA', t: es_en('Perdigones criogénicos: congela y quiebra.', 'Cryo pellets: freezes, then shatters.'),
  s: { dmg: 11, pellets: 8, rate: 3.5, mag: 12 }, m: { mag: 'box', md: 'comp', sight: 'dot' },
  l: { body: 'frost', hg: 'enamel:#e8ebef', stock: 'enamel:#e8ebef', glow: C.ice }, x: { tracer: C.ice, fx: { freeze: 0.12 } } });
w({ k: 'tempestad', f: 'autoshot', r: 4, n: 'TEMPESTAD', t: es_en('Postas explosivas en tambor. Cada tiro, un trueno.', 'Explosive slugs from a drum. Every shot, thunder.'),
  s: { dmg: 40, pellets: 1, spread: 0.02, rate: 3, mag: 10, falloff: 0, range: 40, impulse: 14 }, m: { mag: 'drum', md: 'brake', sight: 'holo', fg: 'angled' },
  l: { body: 'parkerized:#1b1c20', hg: 'gold', stock: 'polymer:#1f2024', mag: 'gold', glow: C.gold }, x: { tracer: C.gold, width: 0.022, fx: { he: { r: 1.8, dmg: 60, force: 16 } } } });

// ── FUSILES DE ASALTO: felinos y ciervos ─────────────────────────────────────
w({ k: 'guanaco', f: 'assault', r: 0, n: 'GUANACO', t: es_en('Carabina negra de manual.', 'Textbook black carbine.'),
  s: { dmg: 30, rate: 11 }, m: { hg: 'mlok', mag: 'curved', magCurve: 0.25, stock: 'tube', sight: 'dot' }, l: { body: 'polymer:#26282c' } });
w({ k: 'guazuncho', f: 'assault', r: 0, n: 'GUAZUNCHO', t: es_en('Asa de transporte y guardamanos redondo: la vieja escuela.', 'Carry handle, round handguard: old school.'),
  s: { dmg: 32, rate: 9 }, m: { carry: true, hg: 'ribbed', stock: 'fixed', mag: 'curved', magCurve: 0.25 }, l: { body: 'polymer:#232428', stock: 'polymer:#26282c' } });
w({ k: 'vicuna', f: 'assault', r: 0, n: 'VICUÑA', t: es_en('La de siempre, modernizada. Cargador ciruela.', 'The old one, modernized. Plum mag.'),
  s: { dmg: 34, rate: 9.5 }, m: { hg: 'quad', gas: true, mag: 'curved', magCurve: 0.85, stock: 'skeleton', sight: 'holo', md: 'brake' },
  l: { body: 'polymer:#232428', mag: 'polymer:#6b3d4a', stock: 'polymer:#2a2c31' } });
w({ k: 'mara', f: 'assault', r: 1, n: 'MARA', t: es_en('Bullpup verde con mira integrada.', 'Green bullpup with an integral scope.'),
  s: { dmg: 29, rate: 11 }, m: { bullpup: true, sight: 'integral', fg: 'vert' },
  l: { body: 'polymer:#5d6b4a', mag: 'polymer:#2a2c31' }, x: { scope: 0.2 } });
w({ k: 'huemul', f: 'assault', r: 1, n: 'HUEMUL', t: es_en('Liviano, gris verdoso y confiable.', 'Light, grey-green and reliable.'),
  s: { dmg: 30, rate: 10.5 }, m: { carry: true, hg: 'mlok', stock: 'skeleton', mag: 'curved', magCurve: 0.4 },
  l: { body: 'polymer:#4a4f47', stock: 'polymer:#4a4f47', hg: 'polymer:#4a4f47', mag: 'polymer:#6b7a6a' } });
w({ k: 'pampa', f: 'assault', r: 1, n: 'PAMPA', t: es_en('Riel largo y holográfica: todo terreno.', 'Long rail, holo sight: all terrain.'),
  s: { dmg: 32, rate: 10 }, m: { hg: 'quad', stock: 'tube', sight: 'holo', mag: 'box' },
  l: { body: 'polymer:#b09a74', stock: 'polymer:#b09a74', hg: 'polymer:#b09a74', mag: 'polymer:#2a2c31' } });
w({ k: 'aguara', f: 'assault', r: 1, n: 'AGUARÁ', t: es_en('Camuflado de monte y mira de cuatro aumentos.', 'Woodland camo and a 4× scope.'),
  s: { dmg: 33, rate: 9.8, spread: 0.022 }, m: { hg: 'mlok', fg: 'angled', sight: 'scope', scopeLen: 0.2, mag: 'curved', magCurve: 0.4 },
  l: { body: 'camo:#5b6140/#3d4130/#7b6d4a/#1f211b', stock: 'camo:#5b6140/#3d4130/#7b6d4a/#1f211b', hg: 'camo:#5b6140/#3d4130/#7b6d4a/#1f211b' }, x: { scope: 0.3 } });
w({ k: 'zorro', f: 'assault', r: 2, n: 'ZORRO', t: es_en('Bullpup silenciado en digital urbano.', 'Suppressed bullpup in urban digital.'),
  s: { dmg: 30, rate: 11 }, m: { bullpup: true, sup: 0.16, sight: 'dot' },
  l: { body: 'digicamo:#8a8f96/#5d646e/#3d434c/#20242a', mag: 'polymer:#2a2c31' }, x: { flash: 'sup', fx: { silenced: true } } });
w({ k: 'ocelote', f: 'assault', r: 2, n: 'OCELOTE', t: es_en('Ráfagas de tres en digital desierto.', 'Three-round bursts in desert digital.'),
  s: { dmg: 38, rate: 3.4, auto: false, burst: 3, burstRate: 16, spread: 0.02 }, m: { hg: 'mlok', sight: 'holo', stock: 'tube', laser: true },
  l: { body: 'digicamo:#c8b48f/#a38f6a/#7c6a4b/#4d4231', hg: 'digicamo:#c8b48f/#a38f6a/#7c6a4b/#4d4231', stock: 'polymer:#8f7b5a', glow: C.red }, x: { fx: { laser: C.red } } });
w({ k: 'puma', f: 'assault', r: 3, n: 'PUMA', t: es_en('Perforante: atraviesa dos y sigue caliente.', 'Armor-piercing: through two and still hot.'),
  s: { dmg: 40, rate: 9.5, pierce: 2 }, m: { hg: 'mlok', md: 'brake', sight: 'holo', stock: 'skeleton' },
  l: { body: 'carbon', hg: 'carbon', stock: 'carbon', metal: 'brass:#caa24e/#8a6a2c', glow: C.gold }, x: { tracer: C.gold, width: 0.017 } });
w({ k: 'yaguarete', f: 'assault', r: 4, n: 'YAGUARETÉ', t: es_en('El rey del monte: atraviesa, cura al matar y la cabeza vale doble.', 'King of the jungle: pierces, heals on kill, headshots count double.'),
  s: { dmg: 42, rate: 11, pierce: 1, spread: 0.022 }, m: { hg: 'mlok', sight: 'scope', scopeLen: 0.22, md: 'brake', stock: 'tube', laser: true },
  l: { body: 'jaguar', stock: 'jaguar', hg: 'jaguar', metal: 'blued', mag: 'blued', glow: C.gold }, x: { tracer: C.gold, scope: 0.35, fx: { hs: 1.35, lifesteal: 3, laser: C.gold } } });

// ── FUSILES DE BATALLA Y DE TIRADOR: aves grandes ────────────────────────────
w({ k: 'carancho', f: 'battle', r: 0, n: 'CARANCHO', t: es_en('Madera y acero: el que se come lo que queda.', 'Wood and steel: it eats what is left.'),
  s: { dmg: 58, rate: 5 }, m: { hg: 'wood', stock: 'wood', gas: true, md: 'hider' },
  l: { body: 'parkerized:#34373d', hg: 'wood:#7a4a2a/#3a2213', stock: 'wood:#7a4a2a/#3a2213' } });
w({ k: 'caracara', f: 'battle', r: 1, n: 'CARACARA', t: es_en('El brazo derecho de la libertad, en automático.', 'The right arm of the free world, full auto.'),
  s: { dmg: 60, rate: 6.5, auto: true, spread: 0.02 }, m: { hg: 'ribbed', stock: 'fixed', md: 'hider', carry: true },
  l: { body: 'polymer:#23252a', stock: 'polymer:#2a2c31', hg: 'polymer:#2a2c31' } });
w({ k: 'milano', f: 'battle', r: 1, n: 'MILANO', t: es_en('Tirador de madera con mira de largo alcance.', 'Wooden marksman rifle with a long scope.'),
  s: { dmg: 72, rate: 3.8, mag: 10, spread: 0.01 }, m: { hg: 'wood', stock: 'skeleton', sight: 'scope', md: 'hider' },
  l: { body: 'parkerized:#26282c', hg: 'wood:#8a4e2c/#40220f', stock: 'wood:#8a4e2c/#40220f' }, x: { scope: 0.55 } });
w({ k: 'lechuza', f: 'battle', r: 2, n: 'LECHUZA', t: es_en('Silenciado, con visor nocturno. Ve en la oscuridad.', 'Suppressed, night scope. It sees in the dark.'),
  s: { dmg: 68, rate: 4.2, mag: 15 }, m: { hg: 'mlok', sup: 0.2, sight: 'longscope', stock: 'skeleton' },
  l: { body: 'polymer:#1f2024', lens: C.green, glow: C.green }, x: { flash: 'sup', scope: 0.6, fx: { silenced: true } } });
w({ k: 'nacurutu', f: 'battle', r: 2, n: 'ÑACURUTÚ', t: es_en('Bullpup de nogal: rara, precisa, hermosa.', 'Walnut bullpup: rare, precise, beautiful.'),
  s: { dmg: 74, rate: 4, mag: 12, spread: 0.008 }, m: { bullpup: true, sight: 'scope', md: 'brake' },
  l: { body: 'wood:#6e4326/#352012', mag: 'blued', body2: 'blued' }, x: { scope: 0.6 } });
w({ k: 'aguilamora', f: 'battle', r: 3, n: 'ÁGUILA MORA', t: es_en('Automático con tambor y bípode: barre la calle.', 'Full auto with drum and bipod: sweeps the street.'),
  s: { dmg: 55, rate: 8, auto: true, mag: 40, reserve: 120, reload: 3.2, spread: 0.024 }, m: { hg: 'quad', mag: 'drum', bipod: true, sight: 'holo', stock: 'tube' },
  l: { body: 'camo:#c8b48f/#a38f6a/#7c6a4b/#4d4231', hg: 'camo:#c8b48f/#a38f6a/#7c6a4b/#4d4231', stock: 'polymer:#8f7b5a', mag: 'polymer:#8f7b5a' } });
w({ k: 'peregrino', f: 'battle', r: 4, n: 'PEREGRINO', t: es_en('El ave más rápida: atraviesa tres y la cabeza vale el doble.', 'The fastest bird: pierces three, headshots double.'),
  s: { dmg: 88, rate: 4.6, mag: 15, pierce: 3, spread: 0.006 }, m: { hg: 'mlok', sight: 'longscope', md: 'brake', stock: 'thumbhole' },
  l: { body: 'damascus', stock: 'ivory', hg: 'damascus', metal: 'blued', glow: C.white }, x: { tracer: C.white, width: 0.022, trail: 1, scope: 0.7, fx: { hs: 1.5 } } });

// ── FRANCOTIRADORES: cerros ──────────────────────────────────────────────────
w({ k: 'condor', f: 'sniper', r: 0, n: 'CÓNDOR', t: es_en('Cerrojo y nogal: paciencia de montaña.', 'Bolt and walnut: mountain patience.'),
  s: { dmg: 125, rate: 1.1 }, m: { stock: 'wood' },
  l: { body: 'blued', metal: 'blued', stock: 'wood:#6e4326/#352012', body2: 'parkerized:#23252a' } });
w({ k: 'aconcagua', f: 'sniper', r: 1, n: 'ACONCAGUA', t: es_en('Diez tiros, bípode y el techo de América.', 'Ten rounds, bipod, the roof of the Americas.'),
  s: { dmg: 150, rate: 0.95, mag: 10, reserve: 40 }, m: { stock: 'thumbhole', bipod: true },
  l: { body: 'parkerized:#2a2c31', stock: 'polymer:#4c5a3a', body2: 'parkerized:#23252a' } });
w({ k: 'lanin', f: 'sniper', r: 1, n: 'LANÍN', t: es_en('Silenciado: el tiro llega antes que el ruido.', 'Suppressed: the shot lands before the sound.'),
  s: { dmg: 132, rate: 1.1 }, m: { sup: 0.22, stock: 'skeleton' },
  l: { body: 'parkerized:#2a2c31', stock: 'polymer:#b09a74', hg: 'polymer:#b09a74' }, x: { flash: 'sup', fx: { silenced: true } } });
w({ k: 'tupungato', f: 'sniper', r: 2, n: 'TUPUNGATO', t: es_en('Semiautomático ártico: diez tiros sin mover el cerrojo.', 'Arctic semi-auto: ten shots, no bolt work.'),
  s: { dmg: 110, rate: 2.2, mag: 10, reserve: 40, kick: 0.6 }, m: { stock: 'tube', bipod: true },
  l: { body: 'enamel:#dde1e6', stock: 'enamel:#dde1e6', hg: 'enamel:#dde1e6', body2: 'parkerized:#2a2c31' } });
w({ k: 'fitzroy', f: 'sniper', r: 2, n: 'FITZ ROY', t: es_en('Cerrojo recto de carbono: el más rápido de volver.', 'Carbon straight-pull: fastest back on target.'),
  s: { dmg: 160, rate: 1.3 }, m: { stock: 'skeleton', md: 'brake' },
  l: { body: 'carbon', stock: 'carbon', hg: 'carbon', mag: 'cerakote:#b3443f', rubber: 'rubber:#8f2f2b', glow: C.red } });
w({ k: 'cerrotorre', f: 'sniper', r: 3, n: 'CERRO TORRE', t: es_en('Antimaterial calibre .50: atraviesa cinco y parte en dos.', '.50 anti-materiel: through five, splits in half.'),
  s: { dmg: 240, rate: 1.0, mag: 5, reserve: 25, pierce: 5, impulse: 40, kick: 1.2, shake: 0.5, reload: 3.4 }, m: { amr: true },
  l: { body: 'polymer:#b09a74', hg: 'polymer:#b09a74', stock: 'parkerized:#2a2c31', metal: 'parkerized:#2a2c31' }, x: { sound: 'amr', width: 0.03, fx: { sever: 2.4 } } });
w({ k: 'champaqui', f: 'sniper', r: 4, n: 'CHAMPAQUÍ', t: es_en('Punta explosiva: atraviesa tres y revienta en el último.', 'Explosive tip: pierces three, bursts in the last.'),
  s: { dmg: 200, rate: 1.1, pierce: 3, mag: 6 }, m: { stock: 'thumbhole' },
  l: { body: 'gold', stock: 'polymer:#1b1c20', body2: 'parkerized:#1b1c20', metal: 'gold', glow: C.gold }, x: { tracer: C.gold, width: 0.028, fx: { he: { r: 1.9, dmg: 70, force: 18, last: true } } } });

// ── AMETRALLADORAS: vientos ──────────────────────────────────────────────────
w({ k: 'pampero', f: 'lmg', r: 0, n: 'PAMPERO', t: es_en('Cien tiros de cinta, sin respiro.', 'A hundred belted rounds, no breathing room.'),
  s: { dmg: 28, rate: 12, mag: 100 }, m: { mag: 'belt', stock: 'fixed' },
  l: { body: 'polymer:#232428', mag: 'polymer:#5d6142', stock: 'polymer:#26282c', hg: 'polymer:#26282c' } });
w({ k: 'zonda', f: 'lmg', r: 1, n: 'ZONDA', t: es_en('Viento caliente de madera y acero.', 'Hot wind of wood and steel.'),
  s: { dmg: 34, rate: 10.5 }, m: { mag: 'belt', stock: 'skeleton' },
  l: { body: 'parkerized:#2a2c31', stock: 'wood:#7a4a2a/#3a2213', hg: 'wood:#7a4a2a/#3a2213', mag: 'parkerized:#34373d' } });
w({ k: 'puelche', f: 'lmg', r: 1, n: 'PUELCHE', t: es_en('Plato arriba y camisa con aletas.', 'Top pan and finned shroud.'),
  s: { dmg: 32, rate: 9.5, mag: 47, reserve: 188, reload: 3.4 }, m: { shroud: true, mag: 'pan', stock: 'wood' },
  l: { body: 'blued', stock: 'wood:#6e4326/#352012', hg: 'parkerized:#34373d', mag: 'blued' }, x: { sound: 'lmg_old' } });
w({ k: 'vientoblanco', f: 'lmg', r: 2, n: 'VIENTO BLANCO', t: es_en('Ciento cincuenta tiros y mira: la ventisca.', 'A hundred fifty rounds and a scope: the blizzard.'),
  s: { dmg: 30, rate: 12, mag: 150, reserve: 300, spread: 0.034 }, m: { mag: 'belt', sight: 'scope' },
  l: { body: 'enamel:#dde1e6', stock: 'enamel:#dde1e6', hg: 'enamel:#dde1e6', mag: 'polymer:#5e636b' } });
w({ k: 'rafaga', f: 'lmg', r: 3, n: 'RÁFAGA', t: es_en('Cinta incendiaria: cada tiro, una trazadora.', 'Incendiary belt: every round a tracer.'),
  s: { dmg: 28, rate: 13 }, m: { mag: 'belt', md: 'brake' },
  l: { body: 'hazard:#e0782f/#1b1c1f', stock: 'polymer:#1f2024', hg: 'polymer:#1f2024', mag: 'polymer:#1f2024', glow: C.orange }, x: { tracer: C.orange, width: 0.018, fx: { burn: 2 } } });
w({ k: 'huracan', f: 'lmg', r: 4, n: 'HURACÁN', t: es_en('Dos cañones, doscientos tiros, veinte por segundo.', 'Twin barrels, two hundred rounds, twenty a second.'),
  s: { dmg: 30, rate: 20, mag: 200, reserve: 400, pierce: 1 }, m: { twin: true, mag: 'drum', stock: 'fixed' },
  l: { body: 'chrome', stock: 'polymer:#1b1c20', hg: 'chrome', mag: 'cerakote:#b3443f', glow: C.red }, x: { tracer: C.red } });

// ── ROTATIVAS: remolinos ─────────────────────────────────────────────────────
w({ k: 'molino', f: 'rotary', r: 1, n: 'MOLINO', t: es_en('Seis cañones que muelen todo.', 'Six barrels that grind everything.'),
  s: { dmg: 18, rate: 26, mag: 300 }, m: { barrels: 6 }, l: { body: 'polymer:#232428', body2: 'parkerized:#34373d', grip: 'rubber:#1d1e22' } });
w({ k: 'remolino', f: 'rotary', r: 2, n: 'REMOLINO', t: es_en('Cuatro cañones: arranca más rápido.', 'Four barrels: spins up faster.'),
  s: { dmg: 20, rate: 22, windup: 0.32, mag: 250 }, m: { barrels: 4, rr: 0.024, bl: 0.42 },
  l: { body: 'polymer:#b09a74', body2: 'parkerized:#2a2c31' } });
w({ k: 'torbellino', f: 'rotary', r: 4, n: 'TORBELLINO', t: es_en('Ocho cañones enfriados por plasma. Atraviesa.', 'Eight plasma-cooled barrels. It pierces.'),
  s: { dmg: 20, rate: 32, mag: 500, reserve: 500, pierce: 1, windup: 0.6 }, m: { barrels: 8, rr: 0.036, coils: true },
  l: { body: 'panel:#c9ced6', body2: 'enamel:#e8ebef', glow: C.teal }, x: { tracer: C.teal } });

// ── LANZADORES: volcanes ─────────────────────────────────────────────────────
w({ k: 'tromen', f: 'launcher', r: 0, n: 'TROMEN', t: es_en('Quebrado, de un tiro: la granada rebota antes de estallar.', 'Break-action, single shot: the grenade bounces, then bursts.'),
  s: { mag: 1, reserve: 12, reload: 1.4, rate: 1.4 }, m: { style: 'break' },
  l: { body2: 'polymer:#5d6142', metal: 'parkerized:#34373d', stock: 'wood:#7a4a2a/#3a2213', pump: 'wood:#7a4a2a/#3a2213' }, x: { proj: { ...PROJ.grenade }, flash: 'gl', sound: 'gl' } });
w({ k: 'copahue', f: 'launcher', r: 1, n: 'COPAHUE', t: es_en('Tambor de seis granadas.', 'Six-grenade cylinder.'),
  s: { mag: 6, reserve: 18, reload: 3.4, rate: 1.6 }, m: { style: 'revolver' },
  l: { body: 'polymer:#b09a74', body2: 'parkerized:#2a2c31', metal: 'parkerized:#2a2c31' }, x: { proj: { ...PROJ.grenade, fuse: 1.2 }, flash: 'gl', sound: 'gl' } });
w({ k: 'domuyo', f: 'launcher', r: 2, n: 'DOMUYO', t: es_en('Cohete que acelera y deja estela. Cuidado atrás.', 'A rocket that speeds up and trails smoke. Mind your back.'),
  s: { mag: 1, reserve: 8, reload: 2.6, rate: 1, kick: 0.9 }, m: { style: 'tube', wood: true },
  l: { body: 'polymer:#4c5037', body2: 'parkerized:#34373d', warhead: 'cerakote:#6b6f55' }, x: { proj: { ...PROJ.rocket }, sound: 'rocket' } });
w({ k: 'payun', f: 'launcher', r: 2, n: 'PAYÚN', t: es_en('Bombas pegajosas: se adhieren y estallan al segundo.', 'Sticky bombs: they cling and burst a second later.'),
  s: { mag: 4, reserve: 16, reload: 2.8, rate: 1.8 }, m: { style: 'tube', tubeLen: 0.62, tubeR: 0.04, warhead: false, sight: 'holo' },
  l: { body: 'hazard:#e3b341/#1b1c1f', body2: 'polymer:#1f2024', glow: C.red }, x: { proj: { ...PROJ.sticky }, flash: 'gl', sound: 'gl' } });
w({ k: 'maipo', f: 'launcher', r: 3, n: 'MAIPO', t: es_en('Granada de racimo: una se vuelve cinco.', 'Cluster grenade: one becomes five.'),
  s: { mag: 4, reserve: 12, reload: 3.0, rate: 1.2 }, m: { style: 'drum' },
  l: { body: 'polymer:#1f2024', hg: 'cerakote:#d9774a', stock: 'polymer:#1f2024', mag: 'cerakote:#d9774a', metal: 'parkerized:#2a2c31' }, x: { proj: { ...PROJ.cluster }, flash: 'gl', sound: 'gl' } });
w({ k: 'llullaillaco', f: 'launcher', r: 4, n: 'LLULLAILLACO', t: es_en('Enjambre: cuatro micro cohetes que buscan solos.', 'Swarm: four micro rockets that seek on their own.'),
  s: { mag: 3, reserve: 12, reload: 3.2, rate: 1.1, pellets: 4, spread: 0.07 }, m: { style: 'pods' },
  l: { body: 'panel:#dfe3e8', body2: 'polymer:#1b1c20', glow: C.red }, x: { proj: { ...PROJ.mini }, sound: 'rocket_swarm' } });

// ── ENERGÍA: estrellas del cielo austral ─────────────────────────────────────
w({ k: 'achernar', f: 'energy', r: 1, n: 'ACHERNAR', t: es_en('Pistola láser: se recarga sola.', 'Laser pistol: recharges itself.'),
  slot: 1, s: { dmg: 26, rate: 6, mag: 20, regen: 3, pierce: 1 }, m: { style: 'pistol' }, hold: 'pistol',
  l: { body: 'enamel:#e8ebef', body2: 'panel:#c9ced6', grip: 'rubber:#26282c', glow: C.red }, x: { tracer: C.red, width: 0.016, sound: 'laser_small' } });
w({ k: 'canopus', f: 'energy', r: 2, n: 'CANOPUS', t: es_en('Fusil láser: atraviesa y deja la marca.', 'Laser rifle: pierces and leaves a mark.'),
  s: { dmg: 36, rate: 7, mag: 30, regen: 5, pierce: 2 }, m: { style: 'laser', len: 0.72 },
  l: { body: 'enamel:#e8ebef', body2: 'panel:#c9ced6', grip: 'rubber:#26282c', glow: C.blue }, x: { tracer: C.blue } });
w({ k: 'pulsar', f: 'energy', r: 2, n: 'PULSAR', t: es_en('Ráfagas de plasma en tres pulsos.', 'Plasma in three-pulse bursts.'),
  slot: 2, s: { dmg: 20, rate: 3.6, burst: 3, burstRate: 16, mag: 45, regen: 8, spread: 0.02 }, m: { style: 'pulse', len: 0.56, h: 0.07 },
  l: { body: 'hex:#2a2e36', body2: 'panel:#3a4048', grip: 'rubber:#1d1e22', glow: C.sky },
  x: { kind: 'proj', proj: { ...PROJ.orb, speed: 46, dmg: 20, size: 0.6 }, tracer: C.sky, sound: 'pulse' } });
w({ k: 'quasar', f: 'energy', r: 3, n: 'QUÁSAR', t: es_en('Fusil de plasma: esferas que salpican.', 'Plasma rifle: orbs that splash.'),
  s: { dmg: 60, rate: 4, mag: 25, regen: 5 }, m: { style: 'plasma', len: 0.7, h: 0.09, w: 0.058 },
  l: { body: 'panel:#3a4048', body2: 'hex:#2a2e36', grip: 'rubber:#1d1e22', glow: C.green },
  x: { kind: 'proj', proj: { ...PROJ.orb, speed: 28, dmg: 55, radius: 1.3, blast: 32, force: 8 }, tracer: C.green, sound: 'plasma' } });
w({ k: 'cruzdelsur', f: 'energy', r: 4, n: 'CRUZ DEL SUR', t: es_en('Cañón de riel: se carga y atraviesa todo lo que hay en la línea.', 'Railgun: charges, then pierces everything in line.'),
  s: { dmg: 270, rate: 0.9, windup: 0.6, mag: 5, regen: 0.6, pierce: 99, impulse: 30, kick: 0.9, shake: 0.4, range: 90 }, m: { style: 'rail', len: 0.78 },
  l: { body: 'chrome', body2: 'panel:#3a4048', grip: 'rubber:#1d1e22', glow: C.violet }, x: { kind: 'rail', tracer: C.violet, width: 0.03, flash: 'rail', sound: 'rail', scope: 0.6, fx: { sever: 2 } } });
w({ k: 'aurora', f: 'energy', r: 3, n: 'AURORA', t: es_en('Tesla: el rayo salta de zombi en zombi.', 'Tesla: lightning jumps from zombie to zombie.'),
  slot: 5, s: { dmg: 46, rate: 2.6, mag: 12, regen: 3, range: 16 }, m: { style: 'tesla', len: 0.66 },
  l: { body: 'brass:#8a5a3a/#4a2e1c', body2: 'parkerized:#2a2c31', copper: 'brass:#c07a44/#6b3d20', glow: C.teal },
  x: { kind: 'arc', tracer: C.teal, chain: 5, chainR: 4.6, sound: 'tesla', fx: { shock: 1 } } });
w({ k: 'nebulosa', f: 'energy', r: 3, n: 'NEBULOSA', t: es_en('Rayo continuo: una línea rosa que no se corta.', 'Continuous beam: a pink line that never breaks.'),
  slot: 5, s: { dmg: 8, rate: 22, auto: true, mag: 100, regen: 14, pierce: 3, spread: 0.004, kick: 0.02, shake: 0.02 }, m: { style: 'beam', len: 0.74, h: 0.1, w: 0.06 },
  l: { body: { f: 'circuit', glowColor: C.pink, glowIntensity: 1.1 }, body2: 'panel:#3a4048', grip: 'rubber:#1d1e22', glow: C.pink }, x: { tracer: C.pink, width: 0.026, life: 0.07, flash: 'beam', sound: 'beam' } });
w({ k: 'magallanes', f: 'energy', r: 2, n: 'MAGALLANES', t: es_en('Escopeta de plasma: seis nubes chicas.', 'Plasma shotgun: six little clouds.'),
  slot: 3, s: { dmg: 22, rate: 1.6, pellets: 6, spread: 0.09, mag: 12, regen: 2 }, m: { style: 'scatter', len: 0.62 },
  l: { body: 'panel:#5a5f69', body2: 'hex:#2a2e36', grip: 'rubber:#1d1e22', glow: C.orange },
  x: { kind: 'proj', proj: { ...PROJ.orb, speed: 30, dmg: 22, size: 0.7 }, tracer: C.orange, sound: 'plasma_scatter' } });
w({ k: 'zodiacal', f: 'energy', r: 4, n: 'ZODIACAL', t: es_en('Cañón de iones: una esfera lenta que electrocuta a todos.', 'Ion cannon: a slow orb that shocks everyone around.'),
  slot: 5, s: { rate: 0.7, mag: 3, regen: 0.35, kick: 0.8, shake: 0.45 }, m: { style: 'ion', len: 0.7, h: 0.1 },
  l: { body: 'enamel:#e8ebef', body2: 'gold', grip: 'rubber:#1d1e22', glow: C.lav }, x: { kind: 'proj', proj: { ...PROJ.ion }, tracer: C.lav, flash: 'plasma', sound: 'ion' } });

// ── EXÓTICAS: mitos del monte ────────────────────────────────────────────────
w({ k: 'mandinga', f: 'exotic', r: 3, n: 'MANDINGA', t: es_en('Lanzallamas: el diablo en persona.', 'Flamethrower: the devil himself.'),
  s: { dmg: 7, rate: 20, auto: true, mag: 120, reserve: 240, reload: 3.4, range: 7.5, kick: 0.02, shake: 0.03 }, m: { style: 'thrower' },
  l: { body: 'parkerized:#2a2c31', tank: 'hazard:#c9412f/#1b1c1f', grip: 'rubber:#1d1e22', glow: C.orange }, hold: 'heavy',
  x: { kind: 'spray', spray: { type: 'fire', angle: 0.2, n: 6 }, sound: 'flame', fx: { burn: 4 } } });
w({ k: 'pombero', f: 'exotic', r: 2, n: 'POMBERO', t: es_en('Criógeno: los congela en el lugar.', 'Cryo thrower: freezes them in place.'),
  s: { dmg: 4, rate: 20, auto: true, mag: 120, reserve: 240, reload: 3.4, range: 6.5, kick: 0.02, shake: 0.02 }, m: { style: 'thrower' },
  l: { body: 'enamel:#e8ebef', tank: 'frost', grip: 'rubber:#1d1e22', glow: C.ice }, hold: 'heavy',
  x: { kind: 'spray', spray: { type: 'cryo', angle: 0.22, n: 6 }, sound: 'cryo', fx: { freeze: 0.07 } } });
w({ k: 'salamanca', f: 'exotic', r: 2, n: 'SALAMANCA', t: es_en('Lanza ácido que deja un charco.', 'Lobs acid that leaves a pool.'),
  slot: 3, s: { rate: 2, mag: 8, reserve: 32, reload: 2.6 }, m: { style: 'canister' },
  l: { body: 'polymer:#3d4130', lens: C.acid, glow: C.acid }, x: { proj: { ...PROJ.glob }, sound: 'acid' } });
w({ k: 'lobizon', f: 'exotic', r: 1, n: 'LOBIZÓN', t: es_en('Ballesta: un virote, silencio, uno menos.', 'Crossbow: one bolt, silence, one less.'),
  slot: 4, s: { rate: 1.1, mag: 1, reserve: 20, reload: 1.3 }, m: { style: 'crossbow' },
  l: { stock: 'wood:#3f2a1c/#1c120b', limb: 'carbon', bolt: 'carbon' }, x: { proj: { ...PROJ.bolt }, sound: 'bow', fx: { silenced: true } } });
w({ k: 'luzmala', f: 'exotic', r: 0, n: 'LUZ MALA', t: es_en('Pistola de bengalas: prende fuego y alumbra.', 'Flare gun: burns and lights the way.'),
  slot: 1, s: { rate: 1.6, mag: 1, reserve: 16, reload: 1.1 }, m: { style: 'flaregun' }, hold: 'pistol',
  l: { body: 'cerakote:#e0782f', grip: 'polymer:#2a2c31', glow: C.orange }, x: { proj: { ...PROJ.flare }, sound: 'flare' } });
w({ k: 'curupi', f: 'exotic', r: 2, n: 'CURUPÍ', t: es_en('Arpón: atraviesa dos y los clava.', 'Harpoon: skewers two and pins them.'),
  slot: 4, s: { rate: 0.8, mag: 1, reserve: 14, reload: 1.6, impulse: 45 }, m: { style: 'harpoon' },
  l: { body: 'hazard:#e3b341/#1b1c1f', stock: 'polymer:#1f2024', bolt: 'brushed:#9aa1aa' }, x: { proj: { ...PROJ.harpoon }, sound: 'harpoon', fx: { sever: 1.5 } } });
w({ k: 'pora', f: 'exotic', r: 0, n: 'PORÁ', t: es_en('Clavadora industrial: diez clavos por segundo.', 'Industrial nail gun: ten nails a second.'),
  slot: 2, s: { rate: 10, auto: true, mag: 60, reserve: 180, reload: 2.4, spread: 0.03 }, m: { style: 'nailgun' },
  l: { body: 'cerakote:#e3b341', mag: 'polymer:#2a2c31', grip: 'rubber:#1d1e22' }, x: { proj: { ...PROJ.nail }, sound: 'nail' } });
w({ k: 'familiar', f: 'exotic', r: 3, n: 'FAMILIAR', t: es_en('Discos de sierra que rebotan y cortan brazos.', 'Saw discs that ricochet and cut arms off.'),
  s: { rate: 1.3, mag: 5, reserve: 20, reload: 2.4 }, m: { style: 'saw' },
  l: { body: 'rust', grip: 'tape:#3a3c34', blade: 'brushed:#9aa1aa', stock: 'rust' }, x: { proj: { ...PROJ.disc }, sound: 'saw', fx: { sever: 3 } } });
w({ k: 'almamula', f: 'exotic', r: 2, n: 'ALMAMULA', t: es_en('Cañón sónico: los voltea en abanico.', 'Sonic cannon: knocks them down in a fan.'),
  slot: 3, s: { dmg: 24, rate: 1.2, mag: 6, regen: 1.2, reserve: Infinity, range: 8 }, m: { style: 'horn' },
  l: { body: 'parkerized:#2a2c31', horn: 'brass:#c9a24e/#6b5424', glow: C.violet }, x: { kind: 'wave', wave: { angle: 0.5, force: 1.7 }, sound: 'sonic' } });
w({ k: 'sachayoj', f: 'exotic', r: 4, n: 'SACHAYOJ', t: es_en('Vórtice: los chupa a un punto y después revienta.', 'Vortex: pulls them to one point, then bursts.'),
  s: { rate: 0.9, mag: 3, reserve: 12, reload: 3 }, m: { style: 'orb' },
  l: { body: 'panel:#2a2e36', stock: 'polymer:#1b1c20', glow: C.lav }, x: { proj: { ...PROJ.vortex }, sound: 'vortex' } });

// ═════════════════════════════════════════════════════════════════════════════
//  Mezcla, congelado y validación
// ═════════════════════════════════════════════════════════════════════════════

const SHOT_KINDS = new Set(['bullet', 'beam', 'rail', 'arc', 'proj', 'spray', 'wave']);
const HOLDS = new Set(['pistol', 'rifle', 'heavy', 'shoulder']);
const PROJ_AIMS = new Set(['lob', 'direct']);
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); } return o; };

function mergeWeapon(src) {
  const F = FAMILIES[src.f];
  if (!F) throw new Error(`arma ${src.k}: familia desconocida "${src.f}"`);
  const stats = { ...BASE_STATS, ...F.stats, ...(src.s || {}) };
  const x = src.x || {};
  const shot = { ...F.shot, ...x, fx: { ...(F.shot.fx || {}), ...(x.fx || {}) } };
  if (x.proj) shot.proj = { aim: 'direct', ...x.proj };
  const model = { ...F.model, ...(src.m || {}) };
  return {
    key: src.k, family: src.f, familyName: F.name, classic: !!src.classic,
    name: src.n, tag: src.t, rarity: src.r, slot: src.slot ?? F.slot, hold: src.hold || F.hold,
    ...stats, shot, model, look: { ...(src.l || {}) },
  };
}

/** Revisa el contrato de un arma. Tira con el nombre del arma y el campo culpable. */
function validate(d) {
  const bad = (msg) => { throw new Error(`arma ${d.key}: ${msg}`); };
  if (!/^[a-z0-9]+$/.test(d.key)) bad('clave inválida (sólo a-z y 0-9)');
  if (!d.classic && (typeof d.name !== 'string' || !d.name.trim())) bad('sin nombre');
  if (!d.tag || !d.tag.es || !d.tag.en) bad('lema incompleto');
  if (!(d.rarity >= 0 && d.rarity <= 4)) bad('rareza fuera de rango');
  if (!(d.slot >= 1 && d.slot <= SLOT_COUNT)) bad('ranura fuera de rango');
  if (!HOLDS.has(d.hold)) bad(`forma de sostener desconocida: ${d.hold}`);
  if (!SHOT_KINDS.has(d.shot.kind)) bad(`tipo de tiro desconocido: ${d.shot.kind}`);
  const pos = (k, max) => { if (!(Number.isFinite(d[k]) && d[k] > 0 && d[k] <= max)) bad(`${k}=${d[k]} fuera de (0, ${max}]`); };
  pos('rate', 40); pos('mag', 600); pos('reload', 8); pos('range', 120); pos('pellets', 16);
  if (!(d.reserve === Infinity || (Number.isInteger(d.reserve) && d.reserve >= 0))) bad('reserva inválida');
  if (!(d.spread >= 0 && d.spread < 0.3)) bad('dispersión inválida');
  if (!(d.dmg >= 0 && d.dmg <= 400)) bad('daño inválido');
  if (!(d.pierce >= 0 && d.pierce <= 99) || !Number.isInteger(d.pierce)) bad('perforación inválida');
  if (d.burst && (!Number.isInteger(d.burst) || d.burst < 2 || d.burst > 6)) bad('ráfaga inválida');
  if (d.regen < 0 || d.regen > 30) bad('regeneración inválida');
  if (d.regen > 0 && d.reserve !== Infinity) bad('un arma con batería no tiene reserva');
  if (d.shot.kind === 'proj') {
    const p = d.shot.proj;
    if (!p || !p.look) bad('proyectil sin aspecto');
    if (!(p.speed > 0 && p.speed < 200)) bad('velocidad de proyectil inválida');
    if (!PROJ_AIMS.has(p.aim)) bad(`puntería de proyectil desconocida: ${p.aim}`);
    if (p.radius > 0 && !(p.blast > 0)) bad('explosivo sin daño de explosión');
    if (!(p.radius > 0) && !(p.dmg > 0)) bad('proyectil que no hace daño');
  }
  if (d.shot.kind === 'bullet' || d.shot.kind === 'beam' || d.shot.kind === 'rail') { if (!(d.dmg > 0)) bad('sin daño'); }
  if (!d.model.b) bad('sin constructor de modelo');
  for (const role in d.look) { const v = d.look[role]; if (v == null || (typeof v !== 'string' && typeof v !== 'object')) bad(`paleta: rol ${role} inválido`); }
}

function build() {
  const out = {}, order = [];
  for (const src of W) {
    if (out[src.k]) throw new Error(`arma ${src.k}: clave repetida`);
    const d = mergeWeapon(src);
    validate(d);
    out[d.key] = deepFreeze(d);
    order.push(d.key);
  }
  return { out, order };
}

const BUILT = build();

/** Mezcla y valida una entrada cruda como las de arriba (las pruebas le pasan datos rotos a propósito). */
export function checkWeapon(src) { const d = mergeWeapon(src); validate(d); return d; }

/** Todas las armas por clave (congeladas). */
export const WEAPONS = Object.freeze(BUILT.out);
/** Orden del catálogo (ranura, después rareza, después el orden escrito). */
export const WEAPON_ORDER = Object.freeze([...BUILT.order].sort((a, b) => {
  const A = WEAPONS[a], B = WEAPONS[b];
  return A.slot - B.slot || A.rarity - B.rarity || BUILT.order.indexOf(a) - BUILT.order.indexOf(b);
}));
export const CLASSIC_KEYS = Object.freeze(['pistol', 'smg', 'shotgun', 'rifle']);
export const NEW_WEAPON_COUNT = WEAPON_ORDER.length - CLASSIC_KEYS.length;

/** Índices precomputados: por ranura y por rareza (se usan al sortear premios). */
export const BY_SLOT = Object.freeze(Array.from({ length: SLOT_COUNT }, (_, i) => Object.freeze(WEAPON_ORDER.filter(k => WEAPONS[k].slot === i + 1))));
export const BY_RARITY = Object.freeze(RARITY.map(R => Object.freeze(WEAPON_ORDER.filter(k => WEAPONS[k].rarity === R.id))));

/**
 * Sorteo de un arma para premio. Las rarezas altas se abren con la oleada:
 * peso = rareza.weight · (1 + oleada·0.12·id) para las raras. `exclude`
 * (Set) saca las que el jugador ya tiene. Muestreo por ruleta: O(n).
 */
export function rollWeapon(rng, wave = 1, { exclude = null, minRarity = 0, maxRarity = 4, classic = false } = {}) {
  let total = 0;
  const pool = [];
  for (const k of WEAPON_ORDER) {
    const d = WEAPONS[k];
    if ((!classic && d.classic) || d.rarity < minRarity || d.rarity > maxRarity || (exclude && exclude.has(k))) continue;
    const R = RARITY[d.rarity];
    const wgt = R.weight * (1 + Math.max(0, wave - 1) * 0.12 * d.rarity);
    pool.push([k, wgt]); total += wgt;
  }
  if (!pool.length) return null;
  let r = rng() * total;
  for (const [k, wgt] of pool) if ((r -= wgt) <= 0) return k;
  return pool[pool.length - 1][0];
}

/** Rasgos legibles de un arma (para la galería y el cartel de agarrar). */
export function weaponTraits(d) {
  const T = [], fx = d.shot.fx || {};
  if (d.shot.kind === 'proj') { const p = d.shot.proj; T.push(p.radius > 0 ? 'explosive' : 'projectile'); if (p.homing) T.push('homing'); if (p.split) T.push('cluster'); if (p.stick || p.stickAll) T.push('sticky'); if (p.bounce) T.push('bounce'); if (p.pull) T.push('vortex'); }
  if (d.shot.kind === 'beam') T.push('beam');
  if (d.shot.kind === 'rail') T.push('rail');
  if (d.shot.kind === 'arc') T.push('chain');
  if (d.shot.kind === 'spray') T.push(d.shot.spray.type === 'cryo' ? 'freeze' : 'burn');
  if (d.shot.kind === 'wave') T.push('knockback');
  if (d.auto) T.push('auto');
  else if (d.mag === 1) T.push('single');
  else if (!d.burst && !d.windup && d.shot.kind !== 'spray') T.push('semi');
  if (d.burst) T.push('burst');
  if (d.windup) T.push('windup');
  if (d.pierce) T.push(d.pierce >= 99 ? 'pierceAll' : 'pierce');
  if (d.pellets > 1) T.push('pellets');
  if (d.regen) T.push('battery');
  if (fx.burn && d.shot.kind !== 'spray') T.push('burn');
  if (fx.freeze && d.shot.kind !== 'spray') T.push('freeze');
  if (fx.shock && d.shot.kind !== 'arc') T.push('shock');
  if (fx.acid) T.push('acid');
  if (fx.he) T.push('explosive');
  if (fx.lifesteal) T.push('lifesteal');
  if (fx.silenced) T.push('silenced');
  if (fx.laser) T.push('laser');
  if (fx.hs) T.push('headshot');
  if (fx.sever) T.push('sever');
  if (d.reserve === Infinity && !d.regen) T.push('infinite');
  if (d.shot.scope >= 0.3) T.push('scope');
  return [...new Set(T)];
}
