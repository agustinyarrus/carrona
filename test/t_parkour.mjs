// Saltos, brincos, trepadas por estilo, bajadas, rodadas, pounce, wall-kick, el
// jugador ágil (pared, choques, piso), heridas sostenidas, rasgos de la horda y
// los cincuenta estilos de marcha: cada pieza aislada, con medidas.
import { PhysWorld } from '../src/phys/world.js';
import { Ragdoll, HEAD, CHEST, HIP, FTL, FTR, HAL, HAR, KNL, KNR, SHL, SHR, ELL, ELR, HPL, HPR, B_SPINE, B_UARML, NP } from '../src/phys/ragdoll.js';
import { SEQ, OVER, VAULTS, DESCENTS, JUMPS, RUN_STYLES, WALK_STYLES, P } from '../src/phys/moves.js';
import { NavGrid } from '../src/game/nav.js';
import { ZombieManager, ATTACKS, TRAIT_RATES } from '../src/game/zombie.js';
import { makeRng } from '../src/core/util.js';

let fails = 0, total = 0;
const ok = (name, cond, extra = '') => { total++; console.log(`  ${cond ? 'OK   ' : 'FALLA'} ${name}   ${extra}`); if (!cond) fails++; };
const DT = 1 / 60;
const run = (w, sec, fn) => { for (let i = 0; i < sec * 60; i++) { for (const b of w.bodies) if (b.update) b.update(DT); w.step(DT); if (fn) fn(i * DT); } };
const nanFree = (w) => { for (let i = 0; i < w.pn; i++) if (Number.isNaN(w.px[i] + w.py[i] + w.pz[i])) return false; return true; };
const world = (boxes = []) => { const w = new PhysWorld(); w.groundHX = 30; w.groundHZ = 30; for (const b of boxes) w.addBox(...b); w.buildStaticIndex(); return w; };
const body = (w, o = {}) => new Ragdoll(w, { x: 0, z: 0, yaw: 0, rng: makeRng(o.seed ?? 1), ...o });
const RUNNER = { stride: 0.32, armMode: 'pump', stiffness: 165, maxMuscleSpeed: 13, kind: 'runner' };
const PLAYER = { isPlayer: true, armMode: 'aim', lockYaw: true, stiffness: 175, maxMuscleSpeed: 13, staggerScale: 0.3, stride: 0.27 };

// ── 1. SALTOS: cada estilo vuela lo que dice la física y aterriza de pie ─────
console.log('\n── saltos ──');
for (const name in JUMPS) {
  const w = world();
  const B = body(w, { seed: 2, ...RUNNER });
  run(w, 0.6);
  const v0 = 3.2, expect = 0.96 + v0 * v0 / 32;
  const started = B.jump(name, v0, 0, 1.5, { land: 'run' });
  let peak = 0, landedAt = -1, fell = false;
  run(w, 2.5, (t) => { peak = Math.max(peak, B.py(HIP)); if (landedAt < 0 && !B.jumping && t > 0.05) landedAt = t; if (t > 1.2 && !B.upright) fell = true; });
  ok(`${name.padEnd(9)} vuela (cadera ${peak.toFixed(2)} ≈ ${expect.toFixed(2)}) y aterriza de pie`, started && Math.abs(peak - expect) < 0.10 && landedAt > 0.3 && landedAt < 0.9 && !fell && B.upright && nanFree(w), `aterrizó a ${landedAt.toFixed(2)} s, avanzó ${B.z.toFixed(2)} m`);
}

// ── 2. TREPADAS: cada estilo cruza un escritorio y sigue de pie ─────────────
console.log('\n── trepadas por estilo ──');
for (const name in VAULTS) {
  const w = world([[0, 0.37, 3.0, 1.2, 0.37, 0.4]]);
  const Z = body(w, { seed: 3, ...RUNNER });
  const sp = Math.max(1.4, VAULTS[name].minSpeed + 0.4);
  Z.wantX = 0; Z.wantZ = 1; Z.wantSpeed = sp;
  let onTop = false, fell = false, styles = new Set(), started = false;
  run(w, 7, () => {
    if (Z.vault) { started = true; styles.add(Z.vault.style); }
    if (Z.z > 2.7 && Z.z < 3.3 && Z.py(FTL) > 0.7 && Z.py(FTR) > 0.7) onTop = true;
    if (Z.state === 'falling' || Z.state === 'down') fell = true;
    if (!started && !Z.vault && Z.z > 1.8 && Z.z < 2.6) Z.tryVault(0, 1, name);
  });
  ok(`${name.padEnd(9)} a ${sp.toFixed(1)} m/s: se sube, cruza y no se cae`, styles.has(name) && onTop && Z.z > 4.5 && !fell && Z.upright && nanFree(w), `z=${Z.z.toFixed(2)} estilos=${[...styles].join(',')}`);
}
{
  // valla: un banco bajo a la carrera se salta sin manos
  const w = world([[0, 0.175, 3.0, 1.2, 0.175, 0.3]]);
  const Z = body(w, { seed: 4, ...RUNNER, traits: { parkour: true } });
  Z.wantX = 0; Z.wantZ = 1; Z.wantSpeed = 3.8;
  let jumped = false, fell = false;
  run(w, 5, () => { if (Z.flight && Z.flight.style === 'hurdle') jumped = true; if (Z.state === 'falling') fell = true; });
  ok('un banco bajo a la carrera se salta en valla', jumped && Z.z > 4.5 && !fell, `z=${Z.z.toFixed(2)} lastJump=${Z.lastJump} vaults=${Z.vaults}`);
}

// ── 3. BAJAR: cada estilo baja de un escritorio y sigue ─────────────────────
console.log('\n── bajadas ──');
for (const style of ['step', 'sit']) {
  const w = world([[0, 0.37, -1.0, 1.5, 0.37, 1.0]]);
  const Z = body(w, { seed: 4, y: 0.75, z: -0.9, kind: 'walker' });
  run(w, 0.8);
  Z._atEdge = function (drop, dx, dz, edge) { this.edgeCool = 1.6; this.descents++; this.lastDescent = style; return this._startDescent(DESCENTS[style], dx, dz, drop, edge); };
  Z.wantX = 0; Z.wantZ = 1; Z.wantSpeed = 1.3;
  let seen = false, fell = false, minHead = 9;
  run(w, 5, () => { if (Z.vault && Z.vault.kind === 'descent') seen = true; if (Z.state === 'falling') fell = true; if (Z.z > 0.3) minHead = Math.min(minHead, Z.py(HEAD)); });
  ok(`${style.padEnd(5)} baja con guion, llega al piso y sigue de pie`, seen && Z.z > 1.2 && Z.py(FTL) < 0.2 && !fell && Z.upright && nanFree(w), `z=${Z.z.toFixed(2)} cabeza mín ${minHead.toFixed(2)}`);
}
{
  const w = world([[0, 0.37, -1.0, 1.5, 0.37, 1.0]]);
  const Z = body(w, { seed: 5, y: 0.75, z: -0.9, ...RUNNER, traits: { parkour: true } });
  run(w, 0.8);
  Z._atEdge = function (drop, dx, dz) { this.edgeCool = 1.6; this.descents++; this.lastDescent = 'roll'; return this.jump('drop', 2.2, dx * 2.5, dz * 2.5, { land: 'roll', prep: 0.08 }); };
  Z.wantX = 0; Z.wantZ = 1; Z.wantSpeed = 3.0;
  let minHead = 9;
  run(w, 5, () => { if (Z.z > 0.3) minHead = Math.min(minHead, Z.py(HEAD)); });
  ok('parkour: salta del escritorio y rueda al caer', Z.rolls >= 1 && minHead < 0.6 && Z.z > 2.5 && Z.upright && nanFree(w), `rolls=${Z.rolls} ${Z.lastMove} cabeza mín ${minHead.toFixed(2)} z=${Z.z.toFixed(2)}`);
}

// ── 4. MOVIMIENTOS: rodadas, deslizada, embestida, gateo ────────────────────
console.log('\n── movimientos ──');
{
  const expect = { roll_fwd: [1.2, 3.0, 0.6], roll_shoulder: [1.4, 3.2, 0.6], roll_back: [-2.6, -0.8, 0.6], scramble: [1.6, 3.5, 1.2], slide: [1.3, 2.8, 1.3], charge: [1.8, 3.5, 1.5], duck: [-0.3, 0.3, 1.45], stagger_steps: [0.5, 1.8, 1.42] };
  for (const name in expect) {
    const [zMin, zMax, headMax] = expect[name];
    const w = world();
    const Z = body(w, { seed: 5, ...RUNNER });
    run(w, 0.6);
    const z0 = Z.z;
    const started = Z.playMove(name, { s: 1 });
    let minHead = 9;
    run(w, SEQ[name].dur + 2.5, () => { minHead = Math.min(minHead, Z.py(HEAD)); });
    const dz = Z.z - z0;
    ok(`${name.padEnd(14)} avanza ${dz.toFixed(2)} m (esperado ${zMin}…${zMax}), baja la cabeza a ${minHead.toFixed(2)} y termina de pie`, started && dz >= zMin && dz <= zMax && minHead < headMax && Z.state === 'up' && Z.upright && nanFree(w));
  }
  // rodar de costado: boca arriba, se desplaza lateralmente más de un metro
  const w = world();
  const Z = body(w, { seed: 6, ...RUNNER });
  run(w, 0.5); Z.rest('supine', 1); run(w, 0.5); Z.dormant = false; Z.state = 'down';
  const x0 = Z.x;
  Z.playMove('roll_side', { s: 1 });
  run(w, 1.2);
  const dx = Math.abs(Z.x - x0);
  run(w, 5);
  ok(`roll_side      rueda de costado ${dx.toFixed(2)} m y después se levanta`, dx > 0.8 && Z.state === 'up' && Z.upright && nanFree(w), Z.lastGetUp);
}

// ── 5. POUNCE: se lanza en plancha, cae de panza, se levanta ────────────────
console.log('\n── lanzarse ──');
{
  const w = world();
  const Z = body(w, { seed: 6, ...RUNNER });
  run(w, 0.5);
  const started = Z.pounce(0, 3.0);
  let peak = 0, landed = -1, dive = false;
  run(w, 3, (t) => { peak = Math.max(peak, Z.py(HIP)); if (Z.flight && Z.flight.style === 'superman') dive = true; if (landed < 0 && Z.landedJump) landed = t; });
  ok('vuela en plancha, aterriza sobre el blanco y cae encima (lo agarró)', started && dive && peak > 1.15 && landed > 0.3 && Z.pounceHit && Z.lastFall === 'fall_pounce_hit', `cadera máx ${peak.toFixed(2)} aterrizó a ${landed.toFixed(2)} s z=${Z.z.toFixed(2)} ${Z.lastFall}`);
  run(w, 5);
  ok('y se levanta después', Z.upright && Z.state === 'up', Z.lastGetUp);
  // el corredor que FALLA (el blanco se corrió) cae parado, tambalea y sigue; el caminante cae de panza
  const w3 = world();
  const Zr = body(w3, { seed: 8, ...RUNNER, traits: { agility: 0.65 } });
  run(w3, 0.5);
  Zr.pounce(0, 3.0); if (Zr.jumpPrep) Zr.jumpPrep.J.target = { x: 9, z: 9 };
  let fellR = false;
  run(w3, 3, () => { if (Zr.state === 'falling' || Zr.state === 'down') fellR = true; });
  const w4 = world();
  const Zw = body(w4, { seed: 9, kind: 'walker', traits: { agility: 0.1 } });
  run(w4, 0.5);
  Zw.pounce(0, 3.0); if (Zw.jumpPrep) Zw.jumpPrep.J.target = { x: 9, z: 9 };
  run(w4, 3);
  ok('si falla: el corredor puede caer parado y seguir; el caminante cae de panza', (!fellR || Zr.lastFall === 'fall_pounce_miss') && Zw.lastFall === 'fall_pounce_miss' && !Zr.pounceHit && !Zw.pounceHit, `corredor cayó=${fellR} (${Zr.lastFall || 'de pie, ' + Zr.stumbles + ' tambaleos'}) · caminante ${Zw.lastFall}`);
  // parkour: si falla, rueda en vez de caer de panza
  const w2 = world();
  const Zp = body(w2, { seed: 7, ...RUNNER, traits: { parkour: true } });
  run(w2, 0.5);
  Zp.pounce(0, 3.0, { roll: true }); if (Zp.jumpPrep) Zp.jumpPrep.J.target = { x: 9, z: 9 };
  run(w2, 3.5);
  ok('el de parkour sale rodando del salto fallido', Zp.rolls >= 1 && Zp.upright && Zp.state === 'up', `${Zp.lastMove} rolls=${Zp.rolls}`);
}

// ── 6. PARED: el jugador la atrapa con las manos; el parkour rebota con el pie ─
console.log('\n── pared ──');
{
  const w = world([[0, 1.5, 4.0, 3, 1.5, 0.15]]);
  const Pl = body(w, { seed: 7, ...PLAYER });
  Pl.wantX = 0; Pl.wantZ = 1; Pl.wantSpeed = 5.6;
  let fell = false, ov = new Set(), maxZ = -9;
  run(w, 4, () => { if (!Pl.upright) fell = true; if (Pl.overlay) ov.add(Pl.overlay.def.name); maxZ = Math.max(maxZ, Pl.z); if (Pl.slams > 0) Pl.wantSpeed = 0; });
  ok('el jugador a 5,6 m/s contra la pared atrapa con las manos y NO se cae', Pl.slams >= 1 && !fell && ov.has('wall_catch') && Pl.upright, `slams=${Pl.slams} overlays=${[...ov].join(',')} z máx ${maxZ.toFixed(2)}`);
  ok('nunca atravesó la pared', maxZ < 3.9, maxZ.toFixed(2));
  const w2 = world([[0, 1.5, 4.0, 3, 1.5, 0.15]]);
  const Z = body(w2, { seed: 8, ...RUNNER, traits: { parkour: true, agility: 0.9 } });
  Z.wantX = 0.3; Z.wantZ = 1; Z.wantSpeed = 4.0;
  let fell2 = false, peak = 0;
  run(w2, 4, () => { if (Z.state === 'falling' || Z.state === 'down') fell2 = true; peak = Math.max(peak, Z.py(HIP)); if (Z.slams > 0 || Z.wallKicks > 0) Z.wantSpeed = 0; });
  ok('el de parkour rebota en la pared con el pie (wall kick) sin caerse', Z.wallKicks >= 1 && !fell2 && Z.upright && peak > 1.1, `wallKicks=${Z.wallKicks} cadera máx ${peak.toFixed(2)}`);
  // un caminante torpe a la carrera sí se estrella y cae, con alguna de las variantes de pared
  const w3 = world([[0, 1.5, 4.0, 3, 1.5, 0.15]]);
  const Wk = body(w3, { seed: 9, ...RUNNER, kind: 'walker', traits: { agility: 0.0 } });
  Wk.wantX = 0; Wk.wantZ = 1; Wk.wantSpeed = 3.5;
  let fell3 = false;
  run(w3, 4, () => { if (Wk.state === 'falling' || Wk.state === 'down') fell3 = true; if (Wk.slams > 0) Wk.wantSpeed = 0; });
  ok('el torpe se estrella y cae con una variante de pared', Wk.slams >= 1 && fell3 && /fall_wall|fall_back|fall_side|fall_over/.test(Wk.lastFall), Wk.lastFall);
  // los corredores comunes (sin parkour) se ESTRELLAN casi siempre: es el show
  let crashes = 0;
  for (let k = 0; k < 6; k++) {
    const w4 = world([[0, 1.5, 4.0, 3, 1.5, 0.15]]);
    const Rn = body(w4, { seed: 20 + k, ...RUNNER });
    Rn.wantX = 0; Rn.wantZ = 1; Rn.wantSpeed = 3.8;
    let fell4 = false;
    run(w4, 3.5, () => { if (Rn.state === 'falling' || Rn.state === 'down') fell4 = true; if (Rn.slams > 0 || Rn.wallKicks > 0) Rn.wantSpeed = 0; });
    if (fell4) crashes++;
  }
  ok('seis corredores contra la pared: al menos cinco se estrellan y caen', crashes >= 5, `${crashes}/6`);
  // inclinarse en las curvas: corriendo en círculo la cabeza se va hacia adentro del giro
  const w5 = world();
  const Rc = body(w5, { seed: 30, ...RUNNER });
  Rc.wantX = 0; Rc.wantZ = 1; Rc.wantSpeed = 3.6;
  run(w5, 2.5);
  let lat = 0, n = 0;
  run(w5, 3, (t) => { const a = t * 1.3; Rc.wantX = Math.sin(a); Rc.wantZ = Math.cos(a); Rc.wantSpeed = 3.6; if (t > 0.6) { const dx = Rc.px(HEAD) - Rc.px(HIP), dz = Rc.pz(HEAD) - Rc.pz(HIP); lat += dx * Rc.rx + dz * Rc.rz; n++; } });
  ok('corriendo en curva hacia la derecha se inclina hacia adentro (cabeza a la derecha de la cadera)', lat / n > 0.02 && Rc.upright, `${(lat / n * 100).toFixed(1)} cm promedio, v=${Rc.speed.toFixed(2)}`);
}

// ── 7. CHOQUES: el jugador que embiste a un zombi no se cae ─────────────────
console.log('\n── choques ──');
{
  const w = world();
  const rng = makeRng(10);
  const Wk = new Ragdoll(w, { x: 0, z: 3.0, yaw: Math.PI, rng });
  const Pl = body(w, { seed: 11, ...PLAYER });
  Pl.wantX = 0; Pl.wantZ = 1; Pl.wantSpeed = 5.0;
  let fellP = false;
  run(w, 3, () => { if (!Pl.upright) fellP = true; if (Pl.bumps > 0) Pl.wantSpeed = 0; });
  ok('el jugador choca al zombi, lo tambalea y sigue de pie', Pl.bumps >= 1 && !fellP && Pl.upright && (Wk.stumbles >= 1 || Wk.falls >= 1), `bumps=${Pl.bumps} zombi: tambaleos ${Wk.stumbles} caídas ${Wk.falls}`);
}

// ── 8. EN EL PISO: el jugador se mueve hacia donde aprieta y se levanta rápido ─
console.log('\n── el jugador en el piso ──');
{
  const w = world();
  const Pl = body(w, { seed: 12, ...PLAYER });
  run(w, 0.5);
  Pl.knockback(0, -1, 1.5, 0.3);
  // el jugador mantiene apretado hacia +X desde que cae (como en el juego)
  let o0 = '', x0 = Pl.x, moves = new Set(), upAt = -1, downAt = -1;
  run(w, 5, (t) => {
    Pl.groundDrive(1, 0, 1.4);
    if (downAt < 0 && Pl.state === 'down') { downAt = t; o0 = Pl.orientation().from; x0 = Pl.x; }
    if (Pl.moveName) moves.add(Pl.moveName);
    if (upAt < 0 && downAt >= 0 && Pl.state === 'up') upAt = t;
  });
  ok(`tirado (${o0}) y apretando a +X: rueda/gatea (${[...moves].join(',')}) y se desplaza`, Math.abs(Pl.x - x0) > 0.6 && (moves.has('roll_side') || moves.has('scramble')), `se movió ${(Pl.x - x0).toFixed(2)} m`);
  ok('y está de pie antes de los 3,5 s de caer (rodada + levantada rápida)', upAt > 0 && upAt - downAt < 3.5 && Pl.upright, `cayó a ${downAt.toFixed(2)} s, de pie a ${upAt.toFixed(2)} s ${Pl.lastGetUp}`);
  // sin apretar nada se levanta igual, más rápido que un zombi
  const w2 = world();
  const Pl2 = body(w2, { seed: 13, ...PLAYER });
  const Zb = new Ragdoll(w2, { x: 4, z: 0, yaw: 0, rng: makeRng(14), kind: 'walker' });
  run(w2, 0.5);
  Pl2.knockback(0, 1, 1.5, 0.3); Zb.knockback(0, 1, 1.5, 0.3);
  let upP = -1, upZ = -1;
  run(w2, 7, (t) => { if (upP < 0 && t > 0.5 && Pl2.state === 'up' && Pl2.upright) upP = t; if (upZ < 0 && t > 0.5 && Zb.state === 'up' && Zb.upright) upZ = t; });
  ok('el jugador se levanta solo, antes que el caminante', upP > 0 && (upZ < 0 || upP <= upZ + 0.05), `jugador ${upP.toFixed(2)} s (${Pl2.lastGetUp}) · caminante ${upZ.toFixed(2)} s (${Zb.lastGetUp})`);
}

// ── 9. HERIDAS SOSTENIDAS y sacudones nuevos ────────────────────────────────
console.log('\n── heridas ──');
{
  const w = world();
  const B = body(w, { seed: 15, kind: 'walker' });
  run(w, 1);
  let wounded = false, names = new Set(), fell = false;
  for (let k = 0; k < 6 && !wounded; k++) { B.hit(B_SPINE, 0.7, 25, [0, 1, -6]); run(w, 0.3, () => { if (B.woundOv) { wounded = true; names.add(B.woundOv.def.name); } if (!B.upright) fell = true; }); }
  let handAtGut = false;
  run(w, 1.0, () => { if (B.woundOv && B.woundOv.k > 0.7) { const hy = Math.min(B.py(HAL), B.py(HAR)); if (hy > 0.8 && hy < 1.15) handAtGut = true; } });
  ok('un tiro en la panza deja la mano apretando la herida un rato', wounded && names.has('wd_gut') && handAtGut && !fell, `${[...names].join(',')}`);
  run(w, 5);
  ok('y la herida se suelta sola', !B.woundOv && B.upright);
  // todos los sacudones y ataques nuevos mueven la pose sin tirarlo
  let badOv = [];
  for (const name in OVER) {
    if (!/^(fl_|atk_|wd_|wall_)/.test(name)) continue;
    const w2 = world();
    const B2 = body(w2, { seed: 16, kind: 'walker' });
    run(w2, 1);
    const T0 = Float32Array.from(B2.target);
    B2.playOverlay(name, 1, { sx: 1, along: -1, lat: 0.3 });
    let maxDev = 0, fell2 = false;
    run(w2, Math.min(1.2, OVER[name].dur + 0.3), () => { const T = B2.target; for (let i = 0; i < NP; i++) maxDev = Math.max(maxDev, Math.hypot(T[i * 3] - T0[i * 3], T[i * 3 + 1] - T0[i * 3 + 1], T[i * 3 + 2] - T0[i * 3 + 2])); if (!B2.upright) fell2 = true; });
    if (!(maxDev > 0.03 && !fell2)) badOv.push(name);
  }
  ok('los sacudones, ataques y heridas mueven la pose y no lo tiran', badOv.length === 0, badOv.join(',') || 'todos');
}

// ── 10. ESTILOS: los cincuenta corren/caminan sin caerse ni clavar rodillas al revés ─
console.log('\n── estilos ──');
{
  const bad = [];
  for (const [list, speed, label] of [[RUN_STYLES, 3.6, 'run'], [WALK_STYLES, 1.3, 'walk']]) {
    for (const st of list) {
      const w = world();
      const r = new Ragdoll(w, { x: 0, z: -25, yaw: 0, rng: makeRng(11), ...RUNNER, runStyle: label === 'run' ? st : RUN_STYLES[0], walkStyle: label === 'walk' ? st : WALK_STYLES[0] });
      r.wantX = 0; r.wantZ = 1; r.wantSpeed = speed;
      let kneeBad = 0, fell = false, n = 0;
      run(w, 5, (t) => { if (t < 2) return; n++; if (!r.upright) fell = true;
        for (const [hp, kn, ft] of [[HPL, KNL, FTL], [HPR, KNR, FTR]]) { const mx = (r.px(hp) + r.px(ft)) / 2, my = (r.py(hp) + r.py(ft)) / 2, mz = (r.pz(hp) + r.pz(ft)) / 2; if ((r.px(kn) - mx) * r.fx + (r.py(kn) - my) * r.fy + (r.pz(kn) - mz) * r.fz < -0.05) kneeBad++; } });
      const slow = label === 'run' ? r.speed < 3.0 : r.speed < 1.0;
      if (fell || kneeBad > 0 || slow) bad.push(`${label}:${st.name} v=${r.speed.toFixed(2)} rodilla=${kneeBad} cayó=${fell}`);
    }
  }
  ok(`${RUN_STYLES.length} estilos de correr y ${WALK_STYLES.length} de caminar: todos llegan a la velocidad, sin caerse, rodillas siempre bien`, bad.length === 0, bad.join(' | ') || 'todos');
  // brazos sin músculo: el estilo ragarms tiene los brazos colgando de verdad
  const w = world();
  const r = new Ragdoll(w, { x: 0, z: -20, yaw: 0, rng: makeRng(12), ...RUNNER, runStyle: RUN_STYLES.find((s) => s.name === 'ragarms') });
  r.wantX = 0; r.wantZ = 1; r.wantSpeed = 3.6;
  let lm = 1;
  run(w, 3, () => { lm = Math.min(lm, r.limbMul[HAL]); });
  ok('ragarms: los brazos van sin músculo (física pura) y el cuerpo sigue corriendo', lm < 0.05 && r.speed > 3.0 && r.upright, `limbMul mano ${lm.toFixed(2)} v=${r.speed.toFixed(2)}`);
}

// ── 11. HORDA: rasgos en proporción, brincos, pounces y ataques nuevos ──────
console.log('\n── horda ──');
{
  const w = world([[0, 0.37, -5.0, 1.6, 0.37, 0.4], [4, 0.37, -5.0, 1.6, 0.37, 0.4], [-4, 0.37, -5.0, 1.6, 0.37, 0.4]]);
  const nav = new NavGrid(w, { cell: 0.4, margin: 0.3, vaultTop: 1.05 });
  const zm = new ZombieManager(w, nav, makeRng(40));
  let hop = 0, pk = 0, n = 0;
  for (let k = 0; k < 200; k++) { const Z = zm.spawn('walker', -20 + (k % 20) * 2, -20 + Math.floor(k / 20) * 2, 0, true); if (Z.traits.hopper) hop++; if (Z.traits.parkour) pk++; n++; }
  ok(`1 de cada 5 pega saltitos (${hop}/${n}) y 2 de cada 10 hacen parkour (${pk}/${n})`, hop / n > 0.12 && hop / n < 0.29 && pk / n > 0.12 && pk / n < 0.29);
  zm.clear();
  const PB = body(w, { seed: 41, ...PLAYER });
  const player = { alive: true, body: PB, hp: 100 };
  Object.defineProperty(player, 'x', { get: () => PB.x }); Object.defineProperty(player, 'z', { get: () => PB.z });
  const hits = {};
  const hooks = { onAttack: (Z, dmg, ux, uz, kind) => { hits[kind] = (hits[kind] || 0) + 1; }, onDeath: () => {}, onCorpse: () => {}, onMoan: () => {} };
  const H = zm.spawn('runner', 0, -14, 0, false, null, { hopper: true, parkour: false, hopStyle: 'skip' });
  const Pk = zm.spawn('runner', 3, -14, 0, false, null, { hopper: false, parkour: true });
  const Wk = zm.spawn('walker', -3, -13, 0, false, null, { hopper: false, parkour: false });
  run(w, 14, () => { PB.wantX = 0; PB.wantZ = 0; PB.wantSpeed = 0; zm.update(DT, player, hooks); });
  ok('el que pega saltitos brincó mientras corría', H.body.hops >= 1, `hops=${H.body.hops} (${H.traits.hopStyle})`);
  ok('el de parkour cruzó el escritorio con un estilo de parkour, o se lanzó', /kong|dash|speed/.test(Pk.body.lastVault) || Pk.body.pounces >= 1 || Pk.body.lastJump === 'superman', `vault=${Pk.body.lastVault} pounces=${Pk.body.pounces} jump=${Pk.body.lastJump}`);
  const kinds = Object.keys(hits);
  ok('llegaron ataques al jugador', kinds.length >= 1, kinds.join(','));
  ok('sin NaN', nanFree(w));
}

console.log(`\n${total} pruebas, ${fails} fallaron`);
console.log(fails ? `\n${fails} PRUEBAS FALLARON` : '\nTODO VERDE');
process.exit(fails ? 1 : 0);
