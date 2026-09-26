// El arsenal: catálogo (contrato), arsenal por ranuras (ráfaga, giro previo,
// carga del riel, batería), acabados procedurales (deterministas y sin
// costura), el armero (geometría de las 104), la balística sobre el mundo de
// verdad (hitscan, riel, relámpago, proyectiles, explosiones, chorro, onda,
// vórtice), los estados, el atlas de sprites, los perfiles de sonido y los textos.
//   node test/t_arsenal.mjs
import { register } from 'node:module';
register('./_three_hooks.mjs', import.meta.url);
import { createHash } from 'node:crypto';

const { WEAPONS, WEAPON_ORDER, RARITY, FAMILIES, BY_SLOT, BY_RARITY, NEW_WEAPON_COUNT, CLASSIC_KEYS, rollWeapon, weaponTraits, checkWeapon } = await import('../src/game/catalog.js');
const { Arsenal, WeaponState, fireHitscan } = await import('../src/game/weapons.js');
const { Ballistics, launchAngle, AIM_TORSO, AIM_MIN_DIST } = await import('../src/game/ballistics.js');
const { StatusBoard, STATUS } = await import('../src/game/status.js');
const { renderFinish, RECIPES, parseFinish, finishStats, finishMaterial, finishProxyMaterials, bakeFinishes, cachedFinishTextures } = await import('../src/render/finishes.js');
const { programSignature } = await import('../src/render/warmup.js');
const { buildWeaponModel, instantiateWeapon, animateWeapon, kickWeapon, weaponFinishSpecs } = await import('../src/render/gunsmith.js');
const { renderSpriteAtlas, ShotFX } = await import('../src/render/shotfx.js');
const { SHOT_SOUNDS, HUMS } = await import('../src/audio/audio.js');
const { t, setLang } = await import('../src/core/i18n.js');
const { ACTION_ORDER } = await import('../src/game/options.js');
const { PhysWorld } = await import('../src/phys/world.js');
const { NavGrid } = await import('../src/game/nav.js');
const { ZombieManager } = await import('../src/game/zombie.js');
const { CHEST } = await import('../src/phys/ragdoll.js');
const { makeRng } = await import('../src/core/util.js');
const THREE = await import('three');

let fails = 0, total = 0;
const ok = (name, cond, extra = '') => {
  total++;
  console.log(`  ${cond ? 'OK   ' : 'FALLA'} ${name}   ${extra}`);
  if (!cond) fails++;
};
const group = (s) => console.log(`\n  ── ${s} ${'─'.repeat(Math.max(2, 60 - s.length))}`);
const DT = 1 / 60;
const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);

// ═════════════════════════════════════════════════════════════════════════════
group('catálogo');
{
  ok('104 armas: 4 clásicas + 100 nuevas', WEAPON_ORDER.length === 104 && NEW_WEAPON_COUNT === 100, `${WEAPON_ORDER.length}`);
  ok('claves únicas', new Set(WEAPON_ORDER).size === WEAPON_ORDER.length);
  const names = WEAPON_ORDER.filter(k => !WEAPONS[k].classic).map(k => WEAPONS[k].name);
  ok('nombres únicos entre las nuevas', new Set(names).size === names.length);
  const P = WEAPONS.pistol, S = WEAPONS.smg, G = WEAPONS.shotgun, R = WEAPONS.rifle;
  ok('la pistola clásica no cambió', P.dmg === 30 && P.rate === 6.5 && P.mag === 12 && P.reserve === Infinity && P.reload === 1.05 && !P.auto && P.slot === 1);
  ok('el subfusil clásico no cambió', S.dmg === 17 && S.rate === 13 && S.mag === 32 && S.reserve === 96 && S.reload === 1.7 && S.auto);
  ok('la escopeta clásica no cambió', G.dmg === 14 && G.pellets === 9 && G.spread === 0.10 && G.falloff === 1 && G.mag === 6 && G.reserve === 18);
  ok('el fusil clásico no cambió', R.dmg === 44 && R.rate === 8.5 && R.pierce === 1 && R.mag === 30 && R.reserve === 90);
  ok('las clásicas quedan en ranuras distintas (la misión 8 las da juntas)', new Set(CLASSIC_KEYS.map(k => WEAPONS[k].slot)).size === 4);
  ok('cada ranura tiene al menos 10 armas', BY_SLOT.every(s => s.length >= 10), BY_SLOT.map(s => s.length).join('/'));
  const byR = RARITY.map(r => WEAPON_ORDER.filter(k => WEAPONS[k].rarity === r.id && !WEAPONS[k].classic).length);
  ok('cada rareza tiene al menos 8 armas nuevas', byR.every(n => n >= 8), byR.join('/'));
  const fams = new Map(); for (const k of WEAPON_ORDER) fams.set(WEAPONS[k].family, (fams.get(WEAPONS[k].family) || 0) + 1);
  ok('cada familia tiene al menos 3 armas', Object.keys(FAMILIES).every(f => (fams.get(f) || 0) >= 3), [...fams].map(([f, n]) => f + ':' + n).join(' '));
  const kinds = new Set(WEAPON_ORDER.map(k => WEAPONS[k].shot.kind));
  ok('están los siete tipos de tiro', ['bullet', 'beam', 'rail', 'arc', 'proj', 'spray', 'wave'].every(x => kinds.has(x)), [...kinds].join(' '));
  const looks = new Set(WEAPON_ORDER.filter(k => WEAPONS[k].shot.kind === 'proj').map(k => WEAPONS[k].shot.proj.look));
  ok('proyectiles de al menos 10 aspectos', looks.size >= 10, [...looks].join(' '));
  ok('las definiciones están congeladas', Object.isFrozen(WEAPONS.halcon) && Object.isFrozen(WEAPONS.halcon.shot) && Object.isFrozen(WEAPONS.halcon.shot.fx));
  // DPS teórico: ni absurdo ni nulo
  const dps = (d) => { const per = d.shot.kind === 'proj' ? (d.shot.proj.radius > 0 ? d.shot.proj.blast : d.shot.proj.dmg) * Math.max(1, d.pellets) : d.dmg * d.pellets; return per * (d.burst ? d.rate * d.burst : d.rate); };
  const bad = WEAPON_ORDER.filter(k => { const v = dps(WEAPONS[k]); return !(v > 20 && v < 2600); });
  ok('DPS teórico entre 20 y 2600 para las 104', bad.length === 0, bad.join(' '));
  // el contrato rechaza lo roto
  const base = { k: 'prueba', f: 'pistol', r: 0, n: 'PRUEBA', t: { es: 'a', en: 'b' } };
  let threw = (src) => { try { checkWeapon(src); return false; } catch { return true; } };
  ok('una entrada sana pasa el contrato', !threw(base));
  ok('rechaza familia inexistente', threw({ ...base, f: 'tanque' }));
  ok('rechaza clave con mayúsculas o acentos', threw({ ...base, k: 'Ñandú' }));
  ok('rechaza rareza fuera de rango', threw({ ...base, r: 7 }));
  ok('rechaza cadencia 0 y cargador negativo', threw({ ...base, s: { rate: 0 } }) && threw({ ...base, s: { mag: -3 } }));
  ok('rechaza batería con reserva finita', threw({ ...base, s: { regen: 3, reserve: 30 } }));
  ok('rechaza un explosivo sin daño de explosión', threw({ ...base, f: 'launcher', x: { proj: { look: 'rocket', speed: 20, radius: 3 } } }));
  ok('rechaza un tipo de tiro desconocido', threw({ ...base, x: { kind: 'magia' } }));
  // sorteo de premios
  const rng = makeRng(42), cnt = [0, 0, 0, 0, 0];
  for (let i = 0; i < 20000; i++) cnt[WEAPONS[rollWeapon(rng, 1)].rarity]++;
  ok('en la oleada 1 las comunes salen más que las legendarias', cnt[0] > cnt[1] && cnt[1] > cnt[2] && cnt[2] > cnt[3] && cnt[3] > cnt[4], cnt.join('/'));
  const rng2 = makeRng(42), cnt2 = [0, 0, 0, 0, 0];
  for (let i = 0; i < 20000; i++) cnt2[WEAPONS[rollWeapon(rng2, 12)].rarity]++;
  ok('en la oleada 12 las legendarias salen bastante más', cnt2[4] > cnt[4] * 2, `${cnt[4]} → ${cnt2[4]}`);
  const ex = new Set(WEAPON_ORDER.slice(0, 100));
  const r3 = rollWeapon(makeRng(7), 5, { exclude: ex });
  ok('el sorteo respeta lo excluido', r3 && !ex.has(r3), r3);
  ok('sin nada para sortear devuelve null', rollWeapon(makeRng(1), 5, { exclude: new Set(WEAPON_ORDER) }) === null);
  ok('rollWeapon no devuelve clásicas', ![...Array(500)].some(() => WEAPONS[rollWeapon(rng, 3)].classic));
  ok('cada arma tiene al menos un rasgo legible', WEAPON_ORDER.every(k => weaponTraits(WEAPONS[k]).length > 0));
}

// ═════════════════════════════════════════════════════════════════════════════
group('arsenal por ranuras');
{
  const A = new Arsenal();
  ok('arranca con la pistola en la ranura 1', A.current === 'pistol' && A.inSlot(0) === 'pistol' && A.owned().length === 1);
  ok('agarrar el subfusil lo pone en la 2 y lo equipa', A.give('smg') === true && A.inSlot(1) === 'smg' && A.current === 'smg');
  ok('la 1 sigue ocupada: CHIMANGO no se levanta solo', !A.canTake('chimango') && A.canTake('granizo'));
  A.switchTo('pistol'); A.switchT = 0; A.weapon.mag = 5;
  ok('cambiar CHIMANGO por la pistola suelta la pistola con sus balas', A.give('chimango') === true && A.dropped && A.dropped.def.key === 'pistol' && A.dropped.mag === 5 && A.current === 'chimango');
  const ammo = { mag: 3, reserve: 40 };
  const A2 = new Arsenal(); A2.give('guanaco', ammo);
  ok('un arma levantada trae la munición que tenía', A2.weapon.mag === 3 && A2.weapon.reserve === 40);
  A2.give('guanaco');
  ok('agarrar la misma suma munición (con tope)', A2.weapon.reserve > 40 && A2.weapon.reserve <= A2.weapon.reserveCap && A2.give('guanaco') === false);
  ok('ranura vacía: no cambia', A2.switchSlot(2) === false);
  // ráfaga
  const B = new Arsenal(); B.give('cuis'); B.switchT = 0;
  let shots = 0, times = [];
  for (let i = 0; i < 120; i++) { const r = B.tryFire(i < 60, DT); if (r && r !== 'empty') { shots++; times.push(i); } B.update(DT); }
  ok('ráfaga de 3 con el gatillo apretado: 3 tiros', shots === 3, `${shots} tiros en ${times.join(',')}`);
  ok('dentro de la ráfaga los tiros van a burstRate', times.length === 3 && (times[2] - times[0]) * DT < 3.5 / WEAPONS.cuis.burstRate, times.join(','));
  // giro previo
  const M = new Arsenal(); M.give('molino'); M.switchT = 0;
  let first = -1; shots = 0;
  for (let i = 0; i < 90; i++) { const r = M.tryFire(true, DT); if (r && r !== 'empty') { shots++; if (first < 0) first = i; } M.update(DT); }
  ok('la rotativa no tira antes de girar', first * DT >= WEAPONS.molino.windup - DT, `primer tiro a ${(first * DT).toFixed(2)} s`);
  ok('girando tira a su cadencia', shots >= Math.floor((1.5 - WEAPONS.molino.windup) * WEAPONS.molino.rate) - 2, `${shots} tiros`);
  for (let i = 0; i < 90; i++) { M.tryFire(false, DT); M.update(DT); }
  ok('suelto el gatillo, el giro se apaga', M.weapon.spin < 0.05, M.weapon.spin.toFixed(2));
  // riel
  const RL = new Arsenal(); RL.give('cruzdelsur'); RL.switchT = 0;
  shots = 0;
  for (let i = 0; i < 120; i++) { const r = RL.tryFire(true, DT); if (r && r !== 'empty') shots++; RL.update(DT); }
  ok('el riel carga y tira UNA vez con el gatillo apretado', shots === 1, `${shots}`);
  // batería
  const E = new Arsenal(); E.give('achernar'); E.switchT = 0;
  for (let i = 0; i < 400 && E.weapon.overheat <= 0; i++) { E.tryFire(i % 2 === 0, DT); E.update(DT); }
  ok('vaciar la batería la recalienta', E.weapon.overheat > 0 && !E.weapon.canReload);
  for (let i = 0; i < Math.ceil(WEAPONS.achernar.reload / DT) + 2; i++) E.update(DT);
  ok('recalentada vuelve llena', E.weapon.mag === WEAPONS.achernar.mag && E.weapon.overheat === 0);
  E.weapon.mag = 10; E.weapon.sinceShot = 0;
  for (let i = 0; i < 60; i++) E.update(DT);
  ok('tras el último tiro la batería carga sola', E.weapon.mag > 10, E.weapon.mag.toFixed(1));
  ok('WeaponState trae su tope de reserva', new WeaponState(WEAPONS.molino).reserveCap === WEAPONS.molino.mag * 3 && new WeaponState(WEAPONS.smg).reserveCap === 32 * 6);
}

// ═════════════════════════════════════════════════════════════════════════════
group('acabados procedurales');
{
  const names = Object.keys(RECIPES);
  ok('27 recetas', names.length === 27, names.length + '');
  const PAL = { camo: { cols: ['#5b6140', '#3d4130', '#7b6d4a', '#1f211b'] }, digicamo: { cols: ['#8a8f96', '#5d646e', '#3d434c', '#20242a'] }, tiger: { cols: ['#6b6a45', '#1e1f18', '#8a7f55'] }, wood: { c: '#7a4a2a' } };
  const params = (n) => ({ c: '#6a6f78', ...(PAL[n] || {}), seed: 5 });
  let allFine = true, seams = [], nanFound = false, badNormal = false;
  for (const n of names) {
    const a = renderFinish(n, params(n), 64), b = renderFinish(n, params(n), 64);
    if (sha(a.albedo) !== sha(b.albedo)) allFine = false;
    const S = a.size, px = a.albedo;
    for (let i = 0; i < px.length; i++) if (!Number.isFinite(px[i])) nanFound = true;
    // costura: diferencia entre la última y la primera columna (vecinas al repetir) contra la media entre columnas vecinas
    let seam = 0, inner = 0;
    for (let y = 0; y < S; y++) {
      const L = (y * S) * 4, Rr = (y * S + S - 1) * 4;
      for (let c = 0; c < 3; c++) seam += Math.abs(px[L + c] - px[Rr + c]);
      for (let x = 1; x < S; x++) { const p0 = (y * S + x - 1) * 4, p1 = (y * S + x) * 4; for (let c = 0; c < 3; c++) inner += Math.abs(px[p1 + c] - px[p0 + c]); }
    }
    inner /= (S - 1); seams.push([n, seam / Math.max(1, inner)]);
    if (a.normal) for (let i = 0; i < a.normal.length; i += 4) { const x = a.normal[i] / 127.5 - 1, y = a.normal[i + 1] / 127.5 - 1, z = a.normal[i + 2] / 127.5 - 1; const l = Math.hypot(x, y, z); if (z < 0 || l < 0.9 || l > 1.1) { badNormal = true; break; } }
  }
  ok('deterministas: mismos parámetros, mismos bytes (27/27)', allFine);
  const worst = seams.sort((p, q) => q[1] - p[1])[0];
  ok('ninguna tiene costura al repetir (borde ≈ interior)', seams.every(([, r]) => r < 3.2), `la peor: ${worst[0]} ×${worst[1].toFixed(2)}`);
  ok('sin NaN en los píxeles', !nanFound);
  ok('los mapas de normales están normalizados y miran afuera', !badNormal);
  ok('otra semilla, otra textura', sha(renderFinish('camo', { ...PAL.camo, seed: 1 }, 64).albedo) !== sha(renderFinish('camo', { ...PAL.camo, seed: 2 }, 64).albedo));
  ok('la receta de circuito escribe máscara emisiva', !!renderFinish('circuit', {}, 32).emissive);
  let t1 = () => { try { parseFinish('plasma:#fff'); return false; } catch { return true; } };
  ok('una receta inexistente se rechaza en la frontera', t1());
  ok('un color roto se rechaza', (() => { try { parseFinish('polymer:#zz00zz'); return false; } catch { return true; } })());
  ok('sin colores, la receta usa los suyos (latón es latón)', parseFinish('brass').c === undefined);
  const before = finishStats().textures;
  finishMaterial('polymer:#112233'); finishMaterial('polymer:#998877'); finishMaterial('polymer:#445566');
  ok('tres polímeros de colores distintos comparten UNA textura (teñido)', finishStats().textures - before <= 1, `${finishStats().textures - before} nuevas`);
  ok('el material teñido lleva el color, no la textura', finishMaterial('polymer:#998877').color.r > finishMaterial('polymer:#112233').color.r);
}

// ═════════════════════════════════════════════════════════════════════════════
group('el armero: las 104');
{
  let worstT = 0, worstK = '', nan = [], badN = [], degenerate = [], badMuzzle = [], badBounds = [], heavy = [];
  const t0 = performance.now();
  for (const k of WEAPON_ORDER) {
    const P = buildWeaponModel(WEAPONS[k]);
    if (P.stats.tris > worstT) { worstT = P.stats.tris; worstK = k; }
    if (P.stats.tris > 6000 || P.stats.draws > 16) heavy.push(k);
    P.group.traverse(o => {
      if (!o.isMesh) return;
      const pos = o.geometry.attributes.position.array, nor = o.geometry.attributes.normal.array;
      for (let i = 0; i < pos.length; i++) if (!Number.isFinite(pos[i])) { nan.push(k); break; }
      for (let i = 0; i < nor.length; i += 3) { const l = Math.hypot(nor[i], nor[i + 1], nor[i + 2]); if (Math.abs(l - 1) > 0.06) { badN.push(k); break; } }
      for (let i = 0; i < pos.length; i += 9) {
        const ax = pos[i + 3] - pos[i], ay = pos[i + 4] - pos[i + 1], az = pos[i + 5] - pos[i + 2], bx = pos[i + 6] - pos[i], by = pos[i + 7] - pos[i + 1], bz = pos[i + 8] - pos[i + 2];
        const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
        if (cx * cx + cy * cy + cz * cz < 1e-16) { degenerate.push(k); break; }
      }
    });
    const b = P.bounds, len = b.max.z - b.min.z;
    if (!(len > 0.15 && len < 1.5) || b.max.x - b.min.x > 0.7) badBounds.push(k + ':' + len.toFixed(2));
    if (!(P.muzzle.z > 0.1 && P.muzzle.z >= b.max.z - 0.12 && Math.abs(P.muzzle.x) < 0.08)) badMuzzle.push(k);
  }
  const ms = performance.now() - t0;
  ok('las 104 se arman sin NaN', nan.length === 0, nan.join(' '));
  ok('normales unitarias', badN.length === 0, badN.join(' '));
  ok('sin triángulos degenerados', degenerate.length === 0, degenerate.join(' '));
  ok('tamaños de arma creíbles (0,15–1,5 m de largo)', badBounds.length === 0, badBounds.join(' '));
  ok('la boca está adelante, al frente del modelo y centrada', badMuzzle.length === 0, badMuzzle.join(' '));
  ok('presupuesto: ≤ 6000 triángulos y ≤ 16 draw calls por arma', heavy.length === 0, `la más pesada: ${worstK} (${worstT})`);
  ok('armar las 104 lleva menos de 20 s (en frío, Node)', ms < 20000, `${ms.toFixed(0)} ms`);
  const I1 = instantiateWeapon(WEAPONS.matrero), I2 = instantiateWeapon(WEAPONS.matrero);
  let shared = true; I1.group.traverse(o => { if (o.isMesh) { let found = false; I2.group.traverse(q => { if (q.isMesh && q.geometry === o.geometry && q.material === o.material) found = true; }); if (!found) shared = false; } });
  ok('las instancias comparten geometría y materiales', shared && I1.group !== I2.group);
  ok('grupos animables: tambor, corredera, rotativa, cerrojo, bomba', !!instantiateWeapon(WEAPONS.matrero).anim.cyl && !!instantiateWeapon(WEAPONS.chimango).anim.slide && !!instantiateWeapon(WEAPONS.molino).anim.spin && !!instantiateWeapon(WEAPONS.condor).anim.bolt && !!instantiateWeapon(WEAPONS.carpincho).anim.pump);
  const Ip = instantiateWeapon(WEAPONS.gavilan);
  kickWeapon(Ip); animateWeapon(Ip, 0.01);
  const back = Ip.anim.slide.position.z;
  for (let i = 0; i < 30; i++) animateWeapon(Ip, DT);
  ok('la corredera retrocede al disparar y vuelve', back < -0.01 && Math.abs(Ip.anim.slide.position.z) < 1e-4, `${back.toFixed(3)} → ${Ip.anim.slide.position.z.toFixed(4)}`);
  const Ic = instantiateWeapon(WEAPONS.baqueano);
  kickWeapon(Ic); for (let i = 0; i < 60; i++) animateWeapon(Ic, DT);
  ok('el tambor gira un sexto por tiro', Math.abs(Ic.anim.cyl.rotation.z - Math.PI / 3) < 0.01, Ic.anim.cyl.rotation.z.toFixed(3));
}

group('shaders: un programa para todas las armas, muestras que las cubren');
{
  // lo que decide el programa de shader de cada malla de las 104 armas
  const sigs = new Map();
  for (const k of WEAPON_ORDER) buildWeaponModel(WEAPONS[k]).group.traverse((o) => {
    if (!o.isMesh) return;
    const sg = programSignature(o.material);
    if (!sigs.has(sg)) sigs.set(sg, k);
  });
  ok('las 104 armas usan a lo sumo dos programas (estándar y emisivo)', sigs.size <= 2, [...sigs.keys()].map(x => x.split('|')[0]).join(' · '));
  const proxy = new Set(finishProxyMaterials().map(programSignature));
  const missing = [...sigs].filter(([sg]) => !proxy.has(sg));
  ok('las muestras del precompilado cubren todas las estructuras de arma', missing.length === 0, missing.length ? 'faltan: ' + missing.map(([, k]) => k).join(' ') : `${proxy.size} muestras`);
  const std = WEAPON_ORDER.flatMap(k => { const out = []; buildWeaponModel(WEAPONS[k]).group.traverse(o => { if (o.isMesh && o.material.isMeshStandardMaterial) out.push(o.material); }); return out; });
  ok('todo material estándar lleva los cuatro mapas (color, normales, rugosidad, emisión)', std.every(M => M.map && M.normalMap && M.roughnessMap && M.emissiveMap), `${std.length} materiales`);
  ok('y el reflejo de estudio', std.every(M => M.envMap === std[0].envMap), std[0].envMap ? 'con reflejo' : 'sin reflejo (Node)');
  ok('los emisivos sólo brillan si el acabado lo pide (emisión negra si no)', std.filter(M => !M.userData.finish.glowColor && !M.userData.finish.lens).every(M => M.emissive.getHex() === 0));

  // recetas puras: sin Three ni DOM (corren en el Worker del horno)
  const fsm = await import('node:fs');
  const pure = fsm.readFileSync(new URL('../src/render/finish_recipes.js', import.meta.url), 'utf8');
  ok('finish_recipes.js no importa Three ni toca el DOM', !/from ['"]three/.test(pure) && !/\b(document|window|THREE)\./.test(pure));

  // el protocolo del Worker, con un `self` de mentira: mismos bytes que renderFinish y buffers transferidos
  const posted = [];
  globalThis.self = { postMessage: (msg, transfer) => posted.push({ msg, transfer }) };
  await import('../src/render/finish_worker.js');
  const params = { c: '#5a6b3c', c2: '#2f3322', c3: '#8b8455', cols: ['#5a6b3c', '#2f3322', '#8b8455', '#1c1d18'], seed: 3 };
  self.onmessage({ data: { id: 7, name: 'camo', params } });
  const ref = renderFinish('camo', params), got = posted[0] && posted[0].msg;
  ok('el Worker devuelve los mismos bytes que el hilo principal', !!got && got.id === 7 && sha(got.px.albedo) === sha(ref.albedo) && (!ref.normal || sha(got.px.normal) === sha(ref.normal)));
  ok('y transfiere los buffers (no los copia)', !!posted[0] && posted[0].transfer.includes(got.px.albedo.buffer) && posted[0].transfer.length === ['albedo', 'normal', 'rough', 'emissive'].filter(k => got.px[k]).length);
  self.onmessage({ data: { id: 8, name: 'no-existe', params: {} } });
  ok('una receta desconocida vuelve como error, sin romper el Worker', posted[1] && posted[1].msg.id === 8 && /desconocida/.test(posted[1].msg.error || ''), posted[1] ? posted[1].msg.error : '');
  delete globalThis.self;

  // el horno (en Node no hay Worker: calcula acá, igual de determinista) y su caché
  const specs = ['camo:#445533/#223311/#667744/#111a0c', 'polymer:#ff00aa', 'polymer:#00ffaa', 'flat:#123456'];
  const b1 = await bakeFinishes(specs), b2 = await bakeFinishes(specs);
  ok('el horno calcula lo que falta: las «tint» comparten, los lisos no tienen', b1.baked + b1.cached === 2 && b1.sets.every(T => T.map), `horneadas ${b1.baked} · ya estaban ${b1.cached}`);
  ok('la segunda vez sale todo de la caché', b2.baked === 0 && b2.cached === 2);
  ok('y el material usa esas mismas texturas', finishMaterial(specs[0]).map.source === cachedFinishTextures(specs[0]).map.source);
  const all = new Set(); for (const k of WEAPON_ORDER) for (const sp of weaponFinishSpecs(WEAPONS[k])) all.add(typeof sp === 'string' ? sp : JSON.stringify(sp));
  ok('las specs de acabado de las 104 armas se listan sin armar geometría', all.size > 50, `${all.size} specs distintas`);
}

// ═════════════════════════════════════════════════════════════════════════════
//  Balística sobre el mundo de verdad
// ═════════════════════════════════════════════════════════════════════════════
function makeArena() {
  const w = new PhysWorld(); w.groundHX = 20; w.groundHZ = 20;
  w.addBox(0, 1.5, 12, 6, 1.5, 0.2);            // pared al fondo (z = 12)
  w.addBox(-4, 1.5, 4, 0.2, 1.5, 2);            // columna a la izquierda
  w.buildStaticIndex();
  const nav = new NavGrid(w, { cell: 0.4, margin: 0.3 });
  const zm = new ZombieManager(w, nav, makeRng(9));
  return { w, zm };
}
/** Sumidero de prueba: aplica el daño como el juego y cuenta todo. */
function testSink(zm, status = null) {
  const S = {
    bodyHits: 0, staticHits: 0, explosions: [], statuses: [], alerts: 0, dmg: 0,
    hitBody(body, bone, s, dmg, imp) {
      const res = body.hit(bone, s, dmg, imp); S.bodyHits++; S.dmg += res.damage;
      const Z = body.zombie;
      if (Z && !body.dead) { Z.hp -= res.damage; if (Z.hp <= 0) body.kill(true); }
      return res;
    },
    hitStatic() { S.staticHits++; },
    targets(includeDead) { const out = []; for (const Z of zm.zombies) if (Z.body.alive && (includeDead || !Z.body.dead)) out.push(Z.body); return out; },
    applyStatus(body, kind, amount, def) { S.statuses.push(kind); if (status && body.zombie) status.apply(body.zombie, kind, amount, def); },
    selfBlast() {}, onExplosion(x, y, z, r) { S.explosions.push({ x, y, z, r }); }, alert() { S.alerts++; },
  };
  return S;
}
const settle = (w, zm, sec = 0.6) => { for (let i = 0; i < sec * 60; i++) { for (const b of w.bodies) if (b.update) b.update(DT); w.step(DT); } };
const standing = (zm, x, z) => { const Z = zm.spawn('walker', x, z, Math.PI, true); Z.wanderT = 99; Z.wanderX = 0; Z.wanderZ = 0; Z.hp = 1e6; return Z; };
const shotFrom = (x, z, dx, dz, y = 1.25) => ({ shooter: null, mx: x, my: y, mz: z, ox: x, oy: y, oz: z, dx, dy: 0, dz, aimX: x + dx * 6, aimZ: z + dz * 6 });
const nanFree = (w) => { for (let i = 0; i < w.pn; i++) if (Number.isNaN(w.px[i] + w.py[i] + w.pz[i])) return false; return true; };

group('balística: hitscan, riel, relámpago');
{
  const { w, zm } = makeArena();
  const Z1 = standing(zm, 0, 4), Z2 = standing(zm, 0, 6), Z3 = standing(zm, 0, 8);
  settle(w, zm);
  const sink = testSink(zm), B = new Ballistics({ world: w, sink, rng: makeRng(3) });
  const aim = (Z) => { const dx = Z.body.px(CHEST) - 0, dz = Z.body.pz(CHEST) - 0, l = Math.hypot(dx, dz); return shotFrom(0, 0, dx / l, dz / l, Z.body.py(CHEST)); };
  const hp0 = Z1.hp;
  B.fire({ ...WEAPONS.chimango, spread: 0 }, aim(Z1));
  ok('una bala le pega al primero', sink.bodyHits === 1 && Z1.hp < hp0, `daño ${(hp0 - Z1.hp).toFixed(0)}`);
  ok('el disparo alerta a la horda', sink.alerts === 1);
  sink.bodyHits = 0;
  B.fire({ ...WEAPONS.cruzdelsur, spread: 0 }, aim(Z1));
  ok('el riel atraviesa a los tres en fila', sink.bodyHits === 3, `${sink.bodyHits} impactos`);
  sink.bodyHits = 0; sink.statuses.length = 0;
  B.fire(WEAPONS.aurora, aim(Z1));
  ok('el relámpago encadena a los tres (están a menos de 4,6 m)', sink.bodyHits === 3 && sink.statuses.filter(s => s === 'shock').length === 3, `${sink.bodyHits} saltos`);
  sink.bodyHits = 0;
  B.fire({ ...WEAPONS.canopus, spread: 0 }, aim(Z1));
  ok('el láser perfora dos y se detiene', sink.bodyHits === 1 + WEAPONS.canopus.pierce, `${sink.bodyHits}`);
  sink.bodyHits = 0;
  B.fire({ ...WEAPONS.chimango, spread: 0 }, shotFrom(0, 0, -1, 0));
  ok('un tiro al costado no toca a nadie', sink.bodyHits === 0);
  ok('sin NaN', nanFree(w));
}

group('balística: proyectiles y explosiones');
{
  // granada: parábola que cae donde apunta
  const { w, zm } = makeArena();
  const sink = testSink(zm), B = new Ballistics({ world: w, sink, rng: makeRng(4) });
  const g = WEAPONS.tromen, S = shotFrom(0, 0, 0, 1, 1.3); S.aimX = 0; S.aimZ = 7;
  B.fire(g, S);
  ok('la granada sale como proyectil', B.projectiles.length === 1 && B.projectiles[0].look === 'grenade');
  let landed = null;
  for (let i = 0; i < 240 && !landed; i++) { B.update(DT); if (sink.explosions.length) landed = sink.explosions[0]; }
  ok('estalla (rebote o espoleta)', !!landed);
  ok('cae cerca de donde apuntaste (parábola)', landed && Math.hypot(landed.x - 0, landed.z - 7) < 2.4, landed ? `a ${Math.hypot(landed.x, landed.z - 7).toFixed(2)} m del punto` : '');
  // ángulo de tiro: el arco bajo llega a la distancia pedida
  const v = 21, gr = 13, D = 9, th = launchAngle(v, gr, D, 0);
  const tFlight = D / (v * Math.cos(th)), yEnd = v * Math.sin(th) * tFlight - 0.5 * gr * tFlight * tFlight;
  ok('launchAngle: el arco bajo llega a (D, 0)', Math.abs(yEnd) < 1e-6, `θ = ${(th * 180 / Math.PI).toFixed(1)}°, y(D) = ${yEnd.toExponential(1)}`);
  ok('launchAngle fuera de alcance usa 45°', Math.abs(launchAngle(5, 13, 40, 0) - Math.PI / 4) < 1e-9);
  // cohete: acelera y revienta contra la pared
  sink.explosions.length = 0;
  B.fire(WEAPONS.domuyo, shotFrom(0, 0, 0, 1));
  let maxSp = 0;
  for (let i = 0; i < 180 && !sink.explosions.length; i++) { B.update(DT); for (const p of B.projectiles) maxSp = Math.max(maxSp, Math.hypot(p.vx, p.vy, p.vz)); }
  ok('el cohete acelera hasta su tope', maxSp > WEAPONS.domuyo.shot.proj.speed * 2 && maxSp <= WEAPONS.domuyo.shot.proj.maxSpeed + 1e-6, `${maxSp.toFixed(1)} m/s`);
  ok('revienta contra la pared del fondo', sink.explosions.length === 1 && Math.abs(sink.explosions[0].z - 11.8) < 0.4, sink.explosions[0] ? `z = ${sink.explosions[0].z.toFixed(2)}` : 'no reventó');
  // racimo
  sink.explosions.length = 0; B.clear();
  const S2 = shotFrom(0, 0, 0, 1, 1.3); S2.aimX = 0; S2.aimZ = 6;
  B.fire(WEAPONS.maipo, S2);
  let spawned = 0;
  for (let i = 0; i < 300; i++) { const before = B.projectiles.length; B.update(DT); spawned = Math.max(spawned, B.projectiles.length); if (sink.explosions.length >= 1 + WEAPONS.maipo.shot.proj.split) break; void before; }
  ok('la de racimo se vuelve cinco', spawned >= WEAPONS.maipo.shot.proj.split && sink.explosions.length === 1 + WEAPONS.maipo.shot.proj.split, `${sink.explosions.length} explosiones`);
  // pegajosa en la pared
  sink.explosions.length = 0; B.clear();
  B.fire(WEAPONS.payun, { ...shotFrom(0, 0, 0, 1, 1.5), aimX: undefined });
  let stuckAt = -1;
  for (let i = 0; i < 400 && !sink.explosions.length; i++) { B.update(DT); if (stuckAt < 0 && B.projectiles[0] && B.projectiles[0].stuck) stuckAt = i; }
  ok('la bomba pegajosa se clava y estalla con retardo', stuckAt >= 0 && sink.explosions.length === 1, stuckAt >= 0 ? `clavada a ${(stuckAt * DT).toFixed(2)} s` : 'no se clavó');
  // disco que rebota
  B.clear();
  B.fire(WEAPONS.familiar, shotFrom(0, 0, 0, 1));
  let maxB = 0;
  for (let i = 0; i < 400; i++) { B.update(DT); for (const p of B.projectiles) maxB = Math.max(maxB, p.bounces); }
  ok('el disco rebota en las paredes (hasta 3)', maxB >= 1 && maxB <= WEAPONS.familiar.shot.proj.bounces, `${maxB} rebotes`);
  ok('y al final se va', B.projectiles.length === 0);
  ok('sin NaN', nanFree(w));
}

group('balística: puntería de los proyectiles (parábola o directo)');
{
  // el solver: forma racionalizada, sin cancelación cuando la gravedad es chica
  const textbook = (v, g, D, h) => Math.atan((v * v - Math.sqrt(v ** 4 - g * (g * D * D + 2 * h * v * v))) / (g * D));
  ok('launchAngle con g = 0 es la recta: atan(h / D)', Math.abs(launchAngle(40, 0, 7, -0.3) - Math.atan(-0.3 / 7)) < 1e-15);
  ok('coincide con la fórmula de libro donde ésa anda (g = 13)', Math.abs(launchAngle(21, 13, 9, 0.4) - textbook(21, 13, 9, 0.4)) < 1e-12);
  const tiny = [1e-3, 1e-6, 1e-9, 1e-12].map(g => Math.abs(launchAngle(85, g, 7, -0.25) - launchAngle(85, 0, 7, -0.25)));
  const book = Math.abs(textbook(85, 1e-9, 7, -0.25) - launchAngle(85, 0, 7, -0.25));
  ok('continuo cuando g → 0 (la de libro se desarma)', tiny.every((d, i) => d < [1e-4, 1e-7, 1e-10, 1e-13][i]), `Δθ ${tiny.map(d => d.toExponential(0)).join(' ')} · libro con g=1e-9: ${book.toExponential(1)}`);
  ok('distancia nula o velocidad nula no revientan', launchAngle(40, 4, 0, 1) === 0 && launchAngle(0, 4, 7, 1) === 0 && launchAngle(40, 4, NaN, 1) === 0);

  // el catálogo: cada proyectil sabe cómo apunta
  const projKeys = WEAPON_ORDER.filter(k => WEAPONS[k].shot.kind === 'proj');
  const lob = projKeys.filter(k => WEAPONS[k].shot.proj.aim === 'lob'), direct = projKeys.filter(k => WEAPONS[k].shot.proj.aim === 'direct');
  ok('todo proyectil del catálogo es «lob» o «direct»', lob.length + direct.length === projKeys.length, `${lob.length} en parábola · ${direct.length} directos`);
  const LOB_LOOKS = new Set(['grenade', 'glob', 'sticky', 'vortex']);
  ok('parábola: granadas, racimo, ácido, pegajosas y vórtices; nada más', projKeys.every(k => (WEAPONS[k].shot.proj.aim === 'lob') === LOB_LOOKS.has(WEAPONS[k].shot.proj.look)), lob.join(' '));
  let threw = ''; try { checkWeapon({ k: 'malaputeria', f: 'launcher', r: 1, n: 'MALA', t: { es: 'x', en: 'x' }, x: { proj: { look: 'bolt', speed: 30, dmg: 20, aim: 'curva' } } }); } catch (e) { threw = e.message; }
  ok('el contrato rechaza una puntería desconocida', /puntería de proyectil desconocida: curva/.test(threw), threw);

  // directo: llega al TORSO a la distancia del mouse (la gravedad compensada), sin tocar el piso antes
  const { w, zm } = makeArena();
  const sink = testSink(zm), B = new Ballistics({ world: w, sink, rng: makeRng(12) });
  /** Vuela un proyectil sin dispersión y devuelve la altura al cruzar z = zAt (interpolada) y el piso más bajo antes. O(pasos). */
  const flyTo = (key, zAim, zAt = zAim, my = 1.36, extra = {}, z0 = 0) => {
    B.clear();
    const S = { ...shotFrom(0, z0, 0, 1, my), aimX: 0, aimZ: z0 + zAim, ...extra };
    zAt += z0;
    B.fire({ ...WEAPONS[key], spread: 0 }, S);
    const p = B.projectiles[0];
    let py = p.y, pz = p.z, minY = p.y;
    for (let i = 0; i < 600 && p.alive && !p.stuck; i++) {
      B.update(DT / 4);
      if (p.z >= zAt) return { y: py + (p.y - py) * (zAt - pz) / (p.z - pz || 1), minY, look: p.look };
      py = p.y; pz = p.z; minY = Math.min(minY, p.y);
    }
    return { y: NaN, minY, look: p.look };
  };
  const DIRECT = ['curupi', 'lobizon', 'luzmala', 'pora'];
  const arrive = DIRECT.map(k => ({ k, ...flyTo(k, 7) }));
  ok('arpón, virote, bengala y clavo llegan al torso a 7 m (±3 cm)', arrive.every(r => Math.abs(r.y - AIM_TORSO) < 0.03), arrive.map(r => `${r.look} ${r.y.toFixed(3)}`).join(' · '));
  ok('ninguno baja del torso antes de llegar (no se clava en el piso)', arrive.every(r => r.minY > AIM_TORSO - 0.03), arrive.map(r => r.minY.toFixed(2)).join(' '));
  const far = flyTo('luzmala', 16, 16, 1.36, {}, -8);          // de z = −8 a z = 8: la pared del fondo está en 12
  ok('la bengala (la de más gravedad) llega igual a 16 m', Math.abs(far.y - AIM_TORSO) < 0.03, far.y.toFixed(3));
  const close = flyTo('curupi', 1, AIM_MIN_DIST);
  ok(`mouse encima del jugador: se resuelve a ${AIM_MIN_DIST} m y no se entierra`, Math.abs(close.y - AIM_TORSO) < 0.03, `y(${AIM_MIN_DIST} m) = ${close.y.toFixed(3)}`);
  const exact = flyTo('curupi', 1.5, 1.5, 0.1, { aimY: 0.4, aimMin: 0 });
  ok('con aimY y aimMin (la galería) va exacto al blanco', Math.abs(exact.y - 0.4) < 0.02, `y(1,5 m) = ${exact.y.toFixed(3)}`);
  const cursorLob = flyTo('tromen', 7, 7);
  ok('la granada, en cambio, sigue cayendo al piso bajo el mouse', cursorLob.y < 0.45, `y(7 m) = ${cursorLob.y.toFixed(2)}`);

  // CURUPÍ contra tres zombis en fila con el mouse en el primero: atraviesa dos y se clava en el tercero
  const { w: w2, zm: zm2 } = makeArena();
  const Zs = [4, 5.5, 7].map(z => standing(zm2, 0, z));
  settle(w2, zm2);
  const sink2 = testSink(zm2), B2 = new Ballistics({ world: w2, sink: sink2, rng: makeRng(13) });
  B2.fire({ ...WEAPONS.curupi, spread: 0 }, { ...shotFrom(0, 0, 0, 1, 1.36), aimX: 0, aimZ: 4 });
  for (let i = 0; i < 120; i++) B2.update(DT);
  const hit = Zs.map(Z => 1e6 - Z.hp > 0);
  ok('CURUPÍ: el arpón atraviesa a los dos primeros y se clava en el tercero', hit.every(Boolean) && sink2.bodyHits === 3, `${sink2.bodyHits} impactos · ${Zs.map(Z => Math.round(1e6 - Z.hp)).join('/')}`);
  const stuck = B2.projectiles.find(p => p.look === 'harpoon');
  ok('y queda clavado en el cuerpo (no en el piso)', !!(stuck && stuck.stuck && stuck.stuck.body), stuck ? (stuck.stuck ? (stuck.stuck.body ? 'en el cuerpo' : 'en la pared o el piso') : 'volando') : 'sin arpón');
  ok('sin NaN', nanFree(w) && nanFree(w2));
}

group('balística: la explosión y sus víctimas');
{
  const { w, zm } = makeArena();
  const near = standing(zm, 1.0, 6), far = standing(zm, 3.0, 6), hidden = standing(zm, -5.2, 4);
  settle(w, zm);
  const sink = testSink(zm), B = new Ballistics({ world: w, sink, rng: makeRng(5) });
  const hp = (Z) => 1e6 - Z.hp;
  B.explode(0, 0.3, 6, { radius: 4, blast: 200, force: 30 }, WEAPONS.domuyo, null);
  ok('el de cerca recibe más que el de lejos (caída cuadrática)', hp(near) > hp(far) && hp(far) > 0, `${hp(near).toFixed(0)} vs ${hp(far).toFixed(0)}`);
  B.explode(-3.2, 0.3, 4, { radius: 4, blast: 200, force: 30 }, WEAPONS.domuyo, null);
  ok('la columna tapa al que está detrás (línea de visión)', hp(hidden) === 0, `${hp(hidden)}`);
  settle(w, zm, 0.3);
  const vy = Math.max(...[near].map(Z => { let m = 0; for (const p of Z.body.p) m = Math.max(m, Math.abs(w.vx[p]) + Math.abs(w.vz[p])); return m; }));
  ok('la onda empuja los cuerpos', vy > 0.1, vy.toFixed(2));
  // vórtice: la velocidad apunta al centro
  const { w: w2, zm: zm2 } = makeArena();
  const Z = standing(zm2, 3, 4); settle(w2, zm2);
  const s2 = testSink(zm2), B2 = new Ballistics({ world: w2, sink: s2, rng: makeRng(6) });
  B2.zones.push({ type: 'vortex', x: 0, y: 1, z: 4, r: 5.5, t: 0.6, t0: 0.6, P: { radius: 3, blast: 50, force: 10 }, def: WEAPONS.sachayoj, shooter: null });
  const x0 = Z.body.px(CHEST);
  for (let i = 0; i < 30; i++) { B2.update(DT); for (const b of w2.bodies) if (b.update) b.update(DT); w2.step(DT); }
  ok('el vórtice arrastra hacia el centro', Z.body.px(CHEST) < x0 - 0.2, `${x0.toFixed(2)} → ${Z.body.px(CHEST).toFixed(2)}`);
  for (let i = 0; i < 40; i++) B2.update(DT);
  ok('y al terminar revienta', s2.explosions.length === 1 && B2.zones.length === 0);
  ok('sin NaN', nanFree(w) && nanFree(w2));
}

group('chorro, onda y estados');
{
  const { w, zm } = makeArena();
  const front = standing(zm, 0, 3), back = standing(zm, 0, -3);
  settle(w, zm);
  const status = new StatusBoard(null, makeRng(1));
  const sink = testSink(zm, status), B = new Ballistics({ world: w, sink, rng: makeRng(7) });
  for (let i = 0; i < 10; i++) B.fire(WEAPONS.mandinga, shotFrom(0, 0, 0, 1));
  ok('el lanzallamas quema al de adelante y no al de atrás', front.hp < 1e6 && back.hp === 1e6 && status.isBurning(front) && !status.isBurning(back));
  let dot = 0;
  const hp0 = front.hp;
  status.update(1.0, (Z, d) => { dot += d; Z.hp -= d; });
  ok('el fuego hace su daño por segundo', Math.abs(dot - STATUS.burn.dps) < STATUS.burn.dps * 0.35, `${dot.toFixed(1)} en 1 s (esperado ${STATUS.burn.dps})`);
  void hp0;
  // frío
  const cold = standing(zm, 2, 3); settle(w, zm, 0.2);
  for (let i = 0; i < 20; i++) status.apply(cold, 'freeze', 0.07, WEAPONS.pombero);
  ok('suficiente frío lo congela y se quiebra (×1,5)', status.isFrozen(cold) && status.vulnerability(cold) === STATUS.freeze.vuln);
  cold.body.wantSpeed = 3; status.applySlows();
  ok('congelado no se mueve', cold.body.wantSpeed === 0);
  const burnt = standing(zm, -2, 3); settle(w, zm, 0.2);
  status.apply(burnt, 'freeze', 0.5); status.apply(burnt, 'burn', 3);
  ok('el fuego apaga el frío', burnt.st.freeze === 0 && status.isBurning(burnt));
  // onda
  const wv = standing(zm, 0.3, 4.5); settle(w, zm, 0.2);
  const x0 = wv.body.pz(CHEST);
  B.fire(WEAPONS.almamula, shotFrom(0, 0, 0, 1));
  for (let i = 0; i < 40; i++) { for (const b of w.bodies) if (b.update) b.update(DT); w.step(DT); }
  ok('la onda sónica lo empuja hacia atrás', wv.body.pz(CHEST) > x0 + 0.3, `${x0.toFixed(2)} → ${wv.body.pz(CHEST).toFixed(2)}`);
  ok('sin NaN', nanFree(w));
}

// ═════════════════════════════════════════════════════════════════════════════
group('efectos, sonido y textos');
{
  const a1 = renderSpriteAtlas(256), a2 = renderSpriteAtlas(256);
  ok('el atlas de sprites es determinista', sha(a1) === sha(a2));
  const C = 64; let emptyCells = 0, dirtyBorder = 0;
  for (let cell = 0; cell < 16; cell++) {
    const cx = (cell % 4) * C, cy = Math.floor(cell / 4) * C;
    let alpha = 0;
    for (let j = 0; j < C; j++) for (let i = 0; i < C; i++) {
      const k = ((cy + j) * 256 + cx + i) * 4;
      alpha += a1[k + 3];
      if ((i === 0 || j === 0 || i === C - 1 || j === C - 1) && a1[k + 3] > 0) dirtyBorder++;
    }
    if (alpha === 0) emptyCells++;
  }
  ok('las 16 formas tienen algo dibujado', emptyCells === 0, `${emptyCells} vacías`);
  ok('borde transparente en cada celda (el filtrado no sangra)', dirtyBorder === 0);
  const scene = new THREE.Scene(), fx = new ShotFX(scene, { glow: 256, smoke: 64 });
  fx.flash('shotgun', 0, 1, 0, 0, 0, 1); fx.tracer(0, 1, 0, 0, 1, 20, '#ffd79a'); fx.explosion(0, 0.5, 5, 3); fx.rail(0, 1, 0, 0, 1, 8, '#cba6f7'); fx.arc(0, 1, 0, 3, 1, 3, '#94e2d5');
  const live0 = fx.live;
  for (let i = 0; i < 400; i++) fx.update(DT);
  ok('los efectos nacen y se apagan solos', live0 > 50 && fx.live === 0, `${live0} → ${fx.live}`);
  for (let i = 0; i < 1000; i++) fx.billboard(0, 0, 0, 0.1, '#fff', 1, 5);
  ok('el lote lleno recicla sin crecer', fx.glow.n === 256);
  fx.drawProjectiles([{ alive: true, look: 'rocket', x: 0, y: 1, z: 0, vx: 0, vy: 0, vz: 30, spin: 0 }, { alive: true, look: 'disc', x: 1, y: 1, z: 0, vx: 5, vy: 0, vz: 0, spin: 2 }]);
  ok('los proyectiles se dibujan por aspecto', fx.proj.rocket.mesh.count === 1 && fx.proj.disc.mesh.count === 1 && fx.proj.grenade.mesh.count === 0);
  // sonido
  const sounds = new Set(WEAPON_ORDER.map(k => WEAPONS[k].shot.sound));
  ok('cada arma tiene su perfil de sonido', [...sounds].every(s => SHOT_SOUNDS[s]), [...sounds].filter(s => !SHOT_SOUNDS[s]).join(' '));
  let badLayer = [];
  for (const [name, L] of Object.entries(SHOT_SOUNDS)) for (const l of L) {
    const dur = l.dur, peak = l.peak ?? 1;
    if (!(dur > 0 && dur < 3 && peak > 0 && peak <= 1.2)) badLayer.push(name);
    if (l.f0 !== undefined && !(l.f0 > 20 && l.f0 < 16000)) badLayer.push(name + ':f0');
    if (l.lp !== undefined && !(l.lp > 50 && l.lp < 16000)) badLayer.push(name + ':lp');
  }
  ok('capas de sonido sanas (duración, pico, frecuencias)', badLayer.length === 0, badLayer.join(' '));
  ok('zumbidos de giro, carga y chorro', !!(HUMS.spin && HUMS.charge && HUMS.flame && HUMS.cryo));
  // textos
  const traits = new Set(); for (const k of WEAPON_ORDER) for (const tr of weaponTraits(WEAPONS[k])) traits.add(tr);
  let missing = [];
  for (const lang of ['es', 'en']) {
    setLang(lang);
    for (const tr of traits) if (t('trait.' + tr) === 'trait.' + tr) missing.push(lang + ':' + tr);
    for (const a of ACTION_ORDER) if (t('action.' + a) === 'action.' + a) missing.push(lang + ':' + a);
    for (const key of ['armory.title', 'armory.try', 'armory.fire', 'hud.swapFor', 'hud.overheat', 'ann.range', 'menu.armory', 'keys.swap']) if (t(key) === key) missing.push(lang + ':' + key);
  }
  setLang('es');
  ok('rasgos, acciones y pantallas con texto en los dos idiomas', missing.length === 0, missing.join(' '));
  ok('lemas en los dos idiomas y cortos (≤ 90)', WEAPON_ORDER.every(k => { const d = WEAPONS[k]; return d.tag.es.length <= 90 && d.tag.en.length <= 90; }));
  ok('las teclas 5 y G existen', ACTION_ORDER.includes('weapon5') && ACTION_ORDER.includes('swap'));
}

console.log(fails ? `\n${fails} de ${total} PRUEBAS FALLARON` : `\nTODO VERDE (${total} pruebas)`);
process.exit(fails ? 1 : 0);
