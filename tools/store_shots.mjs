// Capturas para la ficha de Google Play: Chrome headless emulando un teléfono apaisado de 960×540 a 2×
// (= 1920×1080 px, 16:9: Play exige lado largo / lado corto ≤ 2), calidad «alto», controles táctiles a la
// vista, todo desbloqueado. Ocho escenas: menú, campaña, arsenal, tiroteo en la oficina, la pila de
// ragdolls, el estacionamiento, el hospital y la pausa con ARSENAL. Salen a store/screenshots/phone/.
//   CARRONA_PORT=8767 node tools/store_shots.mjs
import { launch, sleep } from './cdp.mjs';
import fs from 'node:fs';

const OUT = 'store/screenshots/phone'; fs.mkdirSync(OUT, { recursive: true });
const W = 960, H = 540;
const c = await launch({ visible: false, width: W, height: H });
const BOOTED = 'window.carrona && carrona.curtain && carrona.curtain.phase === "open"';
const shot = async (n, name) => { const f = `${OUT}/${String(n).padStart(2, '0')}-${name}.png`; await c.shot(f, 'png'); console.log(`  ${f}`); return f; };
/** Dedos: apoya y desliza; devuelve cómo soltar. */
async function finger(id, x0, y0, x1, y1, steps = 6, others = []) {
  await c.touch('touchStart', [...others, { x: x0, y: y0, id }]);
  for (let i = 1; i <= steps; i++) { await c.touch('touchMove', [...others, { x: x0 + (x1 - x0) * i / steps, y: y0 + (y1 - y0) * i / steps, id }]); await sleep(16); }
  return async () => { await c.touch('touchEnd', others); };
}
/** Empieza una partida, espera la compuerta abierta y unos segundos de horda. El jugador no recibe daño: es una sesión de fotos, no una partida. */
async function partida(js, espera = 6000) { await c.eval(js); await c.waitFor('carrona.gate === "open" && carrona.state === "playing"', 30000, 50); await c.eval('carrona.player.damage = () => false, 1'); await sleep(espera); }
/** Vector de pantalla (unitario) del jugador al zombi vivo más cercano, para empujar el stick derecho hacia él. */
const haciaZombi = () => c.eval(`(() => { const g = carrona, P = g.player; let best = null, bd = 1e9; for (const Z of g.zm.zombies) { if (Z.dead) continue; const d = Math.hypot(Z.x - P.x, Z.z - P.z); if (d < bd) { bd = d; best = Z; } }
  if (!best) return { x: 0, y: -1 }; const a = {}, b = {}; g.R.worldToScreen(P.x, 1, P.z, a); g.R.worldToScreen(best.x, 1, best.z, b); const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1; return { x: dx / l, y: dy / l }; })()`);

try {
  await c.phone(W, H, 2);
  await c.goto(`http://localhost:${process.env.CARRONA_PORT || 8765}/`);
  if (!await c.waitFor(BOOTED, 90000, 100)) throw new Error('el juego no arrancó');
  // todo desbloqueado, calidad alta fija, táctil forzado, idioma castellano
  await c.eval(`(() => { const g = carrona; for (const id of ['m1','m2','m3','m4','m5','m6','m7','m8']) g.progress.missions[id] = { done: true, attempts: 1, bestTime: 95 + Math.random() * 60, bestKills: 40 };
    g.applySettings({ quality: 'alto', autoQuality: false, touch: 'si', lang: 'es', showFps: false }); g.ui.showMenu(g.menuInfo()); return 1; })()`);
  await sleep(2500);
  await shot(1, 'menu');

  await c.eval('carrona.ui.showCampaign(), 1'); await sleep(600);
  await shot(2, 'campana');
  await c.eval('carrona.ui.back(), 1'); await sleep(300);

  await c.eval('carrona.ui.showArmory(), 1'); await sleep(7000);   // las miniaturas se pintan de a poco
  await c.eval(`(() => { const k = carrona.armoryEntries().find(e => e.def.rarity === 4)?.key || 'condor'; carrona.ui._selectArmory(k); return k; })()`); await sleep(1500);
  await shot(3, 'arsenal');
  await c.eval('carrona.ui.back(), 1'); await sleep(300);

  // oficina: correr y disparar con la horda encima
  await partida(`carrona.startInfinite('office'), 1`, 9000);
  const relL = await finger(1, 190, 400, 190, 330);
  let v = await haciaZombi();
  const relR = await finger(2, 760, 400, 760 + v.x * 70, 400 + v.y * 70, 6, [{ x: 190, y: 330, id: 1 }]);
  await sleep(700);
  await shot(4, 'oficina-tiroteo');
  await relR(); await relL();
  // dejar que la ayuda de puntería limpie unos cuantos: la pila
  await c.eval(`carrona.input.setAim(0, 1, true), 1`);
  for (let i = 0; i < 22; i++) { v = await haciaZombi(); await c.eval(`carrona.input.setAim(${v.x}, ${-v.y}, true); carrona.input.setVirtual('fire', true); 1`); await sleep(400); }
  await c.eval(`carrona.input.setVirtual('fire', false); carrona.input.setAim(0, 0, false); 1`);
  await sleep(1800);
  console.log(`  bajas para la pila: ${await c.eval('carrona.stats.kills')}`);
  await shot(5, 'oficina-ragdolls');
  await c.eval('carrona.quitToMenu(), 1'); await sleep(800);

  await partida(`carrona.startInfinite('parking'), 1`, 7000);
  const relP = await finger(1, 190, 400, 190, 340);
  await sleep(600);
  await shot(6, 'estacionamiento');
  await relP();
  await c.eval('carrona.quitToMenu(), 1'); await sleep(800);

  await partida(`carrona.startInfinite('hospital'), 1`, 7000);
  v = await haciaZombi();
  const relH = await finger(2, 760, 400, 760 + v.x * 70, 400 + v.y * 70);
  await sleep(700);
  await shot(7, 'hospital');
  await relH();
  await c.eval('carrona.pause(), 1'); await sleep(500);
  await shot(8, 'pausa');
  await c.eval('carrona.quitToMenu(), 1');
  console.log('  listo: 8 capturas de 1920×1080');
  c.close();
  setTimeout(() => process.exit(0), 800);
} catch (e) {
  console.error('se cortó:', e);
  try { await c.shot(`${OUT}/error.png`, 'png'); } catch { /* sin página */ }
  c.close();
  setTimeout(() => process.exit(2), 800);
}
