// Abre CARRONA en un Chrome VISIBLE con CDP, junta errores de consola, juega
// un poco (mover, apuntar, disparar) y saca capturas a shots/.
//   node test/browser_drive.mjs [--keep]   (deja el Chrome abierto al terminar)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 9333;
const URL = 'http://127.0.0.1:8765/';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROFILE = path.join(process.env.TEMP || 'C:/Temp', 'carrona-chrome');
const OUT = path.resolve('shots');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Chrome ──────────────────────────────────────────────────────────────────
let alreadyOpen = false;
try { await fetch(`http://127.0.0.1:${PORT}/json/version`); alreadyOpen = true; } catch { /* no */ }
if (!alreadyOpen) {
  spawn(CHROME, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    '--window-size=1700,1000', '--window-position=60,40', '--no-first-run', '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter', '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    URL,
  ], { detached: true, stdio: 'ignore' }).unref();
}

async function getTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const t = list.find(t => t.type === 'page' && t.url.startsWith(URL));
      if (t) return t;
      if (alreadyOpen && i === 2) {
        // abrir una pestaña nueva con el juego
        await fetch(`http://127.0.0.1:${PORT}/json/new?${URL}`, { method: 'PUT' });
      }
    } catch { /* todavía no */ }
    await sleep(250);
  }
  throw new Error('no apareció la pestaña del juego');
}

// ── cliente CDP mínimo ──────────────────────────────────────────────────────
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) { const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
      else if (m.method) { const h = c.handlers.get(m.method); if (h) for (const f of h) f(m.params); }
    };
    return c;
  }
  send(method, params = {}, timeoutMs = 15000) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`timeout en ${method}`)); }, timeoutMs);
      this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
    });
  }
  on(method, f) { if (!this.handlers.has(method)) this.handlers.set(method, []); this.handlers.get(method).push(f); }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    const p = path.join(OUT, name + '.png');
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    console.log('  📸', path.relative(process.cwd(), p));
    return p;
  }
  async key(code, key, vk, ms = 80) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await sleep(ms);
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  }
  async keyDown(code, key, vk) { await this.send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }); }
  async keyUp(code, key, vk) { await this.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }); }
  async mouseMove(x, y) { await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); }
  async click(x, y, hold = 130) {
    await this.mouseMove(x, y);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(hold);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }
}

// ── la prueba ───────────────────────────────────────────────────────────────
const target = await getTarget();
const cdp = await CDP.connect(target.webSocketDebuggerUrl);
const errors = [], logs = [];
await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('Log.enable');
cdp.on('Runtime.exceptionThrown', (p) => errors.push('EXC ' + (p.exceptionDetails.exception?.description || p.exceptionDetails.text)));
cdp.on('Runtime.consoleAPICalled', (p) => {
  const txt = p.args.map(a => a.value ?? a.description ?? '').join(' ');
  if (p.type === 'error' || p.type === 'warning') errors.push(p.type.toUpperCase() + ' ' + txt); else logs.push(txt);
});
cdp.on('Log.entryAdded', (p) => { if (p.entry.level === 'error') errors.push('LOG ' + p.entry.text + ' ' + (p.entry.url || '')); });
await cdp.send('Page.bringToFront');
await cdp.send('Page.reload', { ignoreCache: true });
await sleep(6500);

const { innerWidth: W, innerHeight: H } = await cdp.eval('({innerWidth, innerHeight})');
console.log(`ventana ${W}x${H}`);
let state = await cdp.eval('window.carrona ? window.carrona.state : "sin juego"');
console.log('estado inicial:', state);
await cdp.shot('01_menu');

// empezar
await cdp.click(W / 2, H / 2);
await sleep(300);
state = await cdp.eval('window.carrona.state');
console.log('tras click:', state);
await sleep(2500);
await cdp.shot('02_inicio');

// caminar hacia arriba y a la derecha
await cdp.mouseMove(W * 0.65, H * 0.35);
await cdp.keyDown('KeyW', 'w', 87); await cdp.keyDown('KeyD', 'd', 68);
await sleep(1400);
await cdp.keyUp('KeyW', 'w', 87); await cdp.keyUp('KeyD', 'd', 68);
await sleep(400);
await cdp.shot('03_caminando');

// disparar unas veces hacia donde apunta el mouse
for (let i = 0; i < 4; i++) { await cdp.click(W * 0.65, H * 0.35, 40); await sleep(220); }
await sleep(300);
await cdp.shot('04_disparos');

// esperar la primera oleada y tirarle al zombi más cercano
await sleep(6000);
for (let round = 0; round < 3; round++) {
  const z = await cdp.eval(`(() => { const g = window.carrona; const P = g.player; let best = null, bd = 1e9;
    for (const Z of g.zm.zombies) { if (Z.dead) continue; const d = Math.hypot(Z.x - P.x, Z.z - P.z); if (d < bd) { bd = d; best = Z; } }
    if (!best) return null; const o = {}; g.R.worldToScreen(best.x, best.body.py(2), best.z, o); return { x: o.x, y: o.y, d: bd, type: best.type, n: g.zm.alive }; })()`);
  console.log('zombi más cercano:', z);
  if (z && z.x > 0 && z.x < W && z.y > 0 && z.y < H) {
    for (let i = 0; i < 6; i++) { await cdp.click(z.x, z.y, 40); await sleep(180); }
  }
  await sleep(500);
}
await cdp.shot('05_pelea');
// empujón + cambiar arma + recargar + linterna
await cdp.key('Space', ' ', 32); await sleep(400);
await cdp.key('KeyR', 'r', 82); await sleep(1500);
await cdp.key('KeyQ', 'q', 81); await sleep(1200);
await cdp.shot('06_camara_girada');
await cdp.key('F3', 'F3', 114); await sleep(600);
const perf = await cdp.eval('window.carrona._perfText()');
console.log('\n' + perf);
const stats = await cdp.eval('JSON.stringify({state: window.carrona.state, hp: window.carrona.player.hp, wave: window.carrona.wave, kills: window.carrona.stats.kills, shots: window.carrona.stats.shots, hits: window.carrona.stats.hits, zombies: window.carrona.zm.alive, corpses: window.carrona.corpses.n, drawn: window.carrona.bodies.drawnBones})');
console.log('stats:', stats);
await cdp.shot('07_perf');

console.log(`\nerrores de consola: ${errors.length}`);
for (const e of errors.slice(0, 20)) console.log('  ', e.slice(0, 300));
if (logs.length) console.log('logs:', logs.slice(0, 10).join(' | ').slice(0, 500));
console.log(process.argv.includes('--keep') ? 'Chrome queda abierto.' : 'listo (Chrome queda abierto para que lo veas).');
cdp.ws.close();
process.exit(errors.length ? 2 : 0);
