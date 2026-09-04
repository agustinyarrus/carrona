// Sonda rápida contra el Chrome ya abierto (puerto 9333): mide fps por calidad
// y saca una captura. Uso: node test/browser_probe.mjs
import fs from 'node:fs';
fs.mkdirSync('shots', { recursive: true });
import path from 'node:path';
const PORT = 9333, URL = 'http://127.0.0.1:8765/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const t = list.find(t => t.type === 'page' && t.url.startsWith(URL));
if (!t) { console.log('no hay pestaña del juego'); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('timeout ' + method)); } }, 15000); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text); return r.result?.result?.value; };
await send('Page.bringToFront');
const args = process.argv.slice(2);
if (args.includes('--reload')) { await send('Page.reload', { ignoreCache: true }); await sleep(6000); }
// arrancar una partida y quedarse quieto en el pasillo
await ev('window.carrona.newGame(); "ok"');
await sleep(1500);
const ensureAlive = async () => { const st = await ev('window.carrona.state'); if (st !== 'playing') { await ev('window.carrona.newGame(); "ok"'); await sleep(1500); } };
const measure = async (q) => {
  await ev(`window.carrona.applySettings({quality:'${q}'}); "ok"`);
  await sleep(4000);
  const fps = await ev('window.carrona.perf.fps');
  const frame = await ev('window.carrona.perf.frame');
  const phys = await ev('window.carrona.perf.phys');
  const z = await ev('window.carrona.zm.alive');
  console.log(`calidad ${q.padEnd(6)} → ${fps.toFixed(0)} fps · CPU frame ${frame.toFixed(1)} ms · física ${phys.toFixed(1)} ms · zombis ${z}`);
};
for (const q of (args.includes('--all') ? ['bajo', 'medio', 'alto'] : ['medio'])) await measure(q);
const lights = await ev('(() => { let n = 0; window.carrona.scene.traverse(o => { if (o.isPointLight || o.isSpotLight) n++; }); return n; })()');
console.log('luces puntuales/focos:', lights);
const dpr = await ev('window.devicePixelRatio + " · canvas " + document.getElementById("c").width + "x" + document.getElementById("c").height');
console.log('dpr / canvas:', dpr);
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); const p = path.resolve('shots/' + name + '.png'); fs.writeFileSync(p, Buffer.from(r.result.data, 'base64')); console.log('📸', p); };
const keyDown = (code, key, vk) => send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
const keyUp = (code, key, vk) => send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
const click = async (x, y) => { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }); await sleep(130); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }); };
if (args.includes('--player')) {
  // el jugador: vista general, sprint con el arma baja, disparo (retroceso), recarga
  await ev('window.carrona.newGame(); "ok"'); await sleep(1200);
  const { innerWidth: W, innerHeight: H } = await ev('({innerWidth, innerHeight})');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: W * 0.62, y: H * 0.38 });
  await sleep(400);
  await shot('p0_vista');
  await keyDown('ShiftLeft', 'Shift', 16); await keyDown('KeyW', 'w', 87);
  await sleep(1300);
  await shot('p1_sprint');
  const st1 = await ev('JSON.stringify({aimBlend: +window.carrona.player.body.aimBlend.toFixed(2), speed: +window.carrona.player.body.speed.toFixed(2), gait: +window.carrona.player.body.gait.toFixed(2)})');
  console.log('sprint:', st1);
  await sleep(300);
  await shot('p2_sprint_b');
  await keyUp('KeyW', 'w', 87); await keyUp('ShiftLeft', 'Shift', 16);
  await sleep(500);
  await click(W * 0.62, H * 0.38); await sleep(40);
  await shot('p3_disparo');
  const st2 = await ev('JSON.stringify({aimBlend: +window.carrona.player.body.aimBlend.toFixed(2), recoil: +window.carrona.player.body.recoil.toFixed(2)})');
  console.log('disparo:', st2);
  await sleep(300);
  await keyDown('KeyR', 'r', 82); await sleep(60); await keyUp('KeyR', 'r', 82);
  await sleep(450);
  await shot('p4_recarga');
  const st3 = await ev('JSON.stringify({reloadT: +window.carrona.player.body.reloadT.toFixed(2)})');
  console.log('recarga:', st3);
}
if (args.includes('--hit')) {
  // un zombi quieto a 4 m: tres tiros de pistola (capturas) y después escopeta a quemarropa
  await ensureAlive();
  const { innerWidth: W, innerHeight: H } = await ev('({innerWidth, innerHeight})');
  await ev(`(() => { const g = window.carrona, P = g.player; for (const Z of g.zm.zombies) if (!Z.dead) Z.body.kill(); const Z = g._spawnZombie('walker', P.x, P.z - 4, 0, true); Z.wanderT = 99; Z.wanderX = 0; Z.wanderZ = 0; Z.hp = 1e9; window.__zt = Z; return 'ok'; })()`);
  await sleep(900);
  const aimAt = async () => { const o = await ev('(() => { const g = window.carrona, Z = window.__zt; const o = {}; g.R.worldToScreen(Z.x, Z.body.py(2), Z.z, o); return { x: o.x, y: o.y }; })()'); await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: o.x, y: o.y }); return o; };
  for (let i = 0; i < 3; i++) {
    const o = await aimAt();
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: o.x, y: o.y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(60);
    await shot('hit_' + i);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: o.x, y: o.y, button: 'left', buttons: 0, clickCount: 1 });
    const st = await ev('(() => { const Z = window.__zt, B = Z.body; return JSON.stringify({ limp: +B.limp.toFixed(2), stagger: +B.stagger.toFixed(2), rootZ: +B.rootZ.toFixed(2), z: +B.z.toFixed(2), up: B.upright, hp: Z.hp }); })()');
    console.log('tiro', i, st);
    await sleep(350);
  }
  await ev(`(() => { const g = window.carrona; g.player.arsenal.give('shotgun'); g._setWeaponVisible('shotgun'); return 'ok'; })()`);
  await sleep(500);
  const o = await aimAt();
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: o.x, y: o.y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(150);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: o.x, y: o.y, button: 'left', buttons: 0, clickCount: 1 });
  for (let i = 0; i < 3; i++) { await sleep(180); await shot('shotgun_' + i); }
  const st = await ev('(() => { const Z = window.__zt, B = Z.body; return JSON.stringify({ limp: +B.limp.toFixed(2), up: B.upright, z: +B.z.toFixed(2), head: +B.py(0).toFixed(2), dead: B.dead }); })()');
  console.log('escopeta:', st);
}
if (args.includes('--runners')) {
  // ráfaga de corredores hacia el jugador + 3 capturas seguidas para ver la marcha
  await ensureAlive();
  await ev(`(() => { const g = window.carrona, P = g.player; for (let i = 0; i < 5; i++) { const a = -0.6 + i * 0.3; const Z = g._spawnZombie('runner', P.x + Math.sin(a) * 9, P.z - Math.cos(a) * 9, 0, false); Z.alert = true; } return 'ok'; })()`);
  await sleep(1100);
  for (let i = 0; i < 3; i++) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const p = path.resolve('shots/run_' + i + '.png');
    fs.writeFileSync(p, Buffer.from(r.result.data, 'base64'));
    console.log('📸', p);
    await sleep(160);
  }
  const st = await ev(`(() => { const g = window.carrona; const rs = g.zm.zombies.filter(Z => Z.type === 'runner' && !Z.dead); return rs.map(Z => ({ v: Z.body.speed.toFixed(1), gait: Z.body.gait.toFixed(2), up: Z.body.upright, d: Math.hypot(Z.x - g.player.x, Z.z - g.player.z).toFixed(1) })); })()`);
  console.log('corredores:', JSON.stringify(st));
}
if (args.includes('--shot')) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const p = path.resolve('shots/probe.png');
  fs.writeFileSync(p, Buffer.from(r.result.data, 'base64'));
  console.log('📸', p);
}
ws.close();
process.exit(0);
