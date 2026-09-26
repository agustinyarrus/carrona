// Cliente CDP mínimo para las sondas del arsenal: lanza Chrome (headless o visible) con un
// perfil temporal, o se cuelga de un DevTools ya abierto (el WebView de Android por `adb
// forward`); junta errores de consola, evalúa, captura, mueve el mouse, apoya dedos y aprieta
// teclas. Cierra SU proceso por PID (nunca Chrome global).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = path.join(process.env.ProgramFiles || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe');
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Se cuelga de una página por su WebSocket de DevTools (`webSocketDebuggerUrl` de /json/list)
 * y devuelve el cliente. Sirve igual para el Chrome que lanzamos y para un WebView de Android.
 * @param {string} wsUrl
 * @param {object} o
 * @param {number}  [o.width]        tamaño lógico (informativo; con `emulate` fija el viewport)
 * @param {number}  [o.height]
 * @param {boolean} [o.emulate]      fijar las métricas del viewport (Chrome headless)
 * @param {import('node:child_process').ChildProcess|null} [o.proc]  el Chrome propio: close() lo mata
 * @param {string|null} [o.tempProfile]  perfil temporal que close() borra
 */
export async function attach(wsUrl, { width = 0, height = 0, emulate = false, proc = null, tempProfile = null } = {}) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map(); const logs = []; const hooks = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    if (m.method && hooks.has(m.method)) for (const fn of hooks.get(m.method)) fn(m.params);
    if (m.method === 'Runtime.exceptionThrown') logs.push({ kind: 'exception', text: (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').split('\n').slice(0, 4).join(' | ') });
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) logs.push({ kind: m.params.type, text: m.params.args.map(a => a.value ?? a.description).join(' ').slice(0, 400) });
    if (m.method === 'Log.entryAdded' && (m.params.entry.level === 'error')) logs.push({ kind: 'log', text: (m.params.entry.text || '').slice(0, 300) });
  };
  const send = (method, params = {}, to = 30000) => new Promise((res, rej) => {
    const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('timeout ' + method)); } }, to);
  });
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  if (emulate) await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const c = {
    proc, logs, send, width, height,
    /** Escucha un evento de CDP (p. ej. 'Tracing.dataCollected'). */
    on(method, fn) { if (!hooks.has(method)) hooks.set(method, []); hooks.get(method).push(fn); },
    async eval(expr, to = 30000) {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, to);
      if (r.result?.exceptionDetails) throw new Error((r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').split('\n')[0]);
      return r.result?.result?.value;
    },
    async goto(u) { await send('Page.navigate', { url: u }); },
    async waitFor(expr, ms = 20000, step = 150) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await c.eval(expr)) return true; } catch { /* todavía no */ } await sleep(step); } return false; },
    async shot(file, fmt = 'jpeg') { const r = await send('Page.captureScreenshot', { format: fmt, quality: 88 }, 60000); fs.writeFileSync(file, Buffer.from(r.result.data, 'base64')); return file; },
    async mouse(type, x, y, button = 'none', buttons = 0) { await send('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount: type === 'mouseMoved' ? 0 : 1 }); },
    async key(type, code, key, vk) { await send('Input.dispatchKeyEvent', { type, code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }); },
    /** Dedos: type touchStart|touchMove|touchEnd|touchCancel; points = [{x, y, id}] (todos los dedos que siguen apoyados). */
    async touch(type, points) { await send('Input.dispatchTouchEvent', { type, touchPoints: points.map(p => ({ x: p.x, y: p.y, id: p.id ?? 0, radiusX: 8, radiusY: 8, force: 1 })) }); },
    /** Emula un teléfono apaisado: métricas, dedo grueso y eventos táctiles. */
    async phone(width = 915, height = 412, dpr = 2.6) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: true, screenOrientation: { type: 'landscapePrimary', angle: 90 } });
      await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await send('Emulation.setEmitTouchEventsForMouse', { enabled: false });
      try { await send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'hover', value: 'none' }, { name: 'any-pointer', value: 'coarse' }] }); } catch { /* Chrome viejo */ }
    },
    async tap(code, key, vk, hold = 60) { await c.key('keyDown', code, key, vk); await sleep(hold); await c.key('keyUp', code, key, vk); },
    /** Cierra la sesión; si el Chrome es nuestro lo mata y borra su perfil temporal. Un WebView ajeno queda vivo. */
    close() {
      try { ws.close(); } catch { /* ya cerrado */ }
      if (proc) { try { proc.kill(); } catch { /* ya cerrado */ } }
      if (tempProfile) setTimeout(() => { try { fs.rmSync(tempProfile, { recursive: true, force: true }); } catch { /* Chrome suelta archivos tarde */ } }, 800);
    },
  };
  return c;
}

export async function launch({ visible = false, width = 1600, height = 900, url = 'about:blank', profile = null } = {}) {
  const port = 9500 + Math.floor(Math.random() * 400);
  // perfil persistente opcional (para medir con el caché de shaders de Chrome caliente); si no, uno temporal
  const prof = profile ? (fs.mkdirSync(profile, { recursive: true }), profile) : fs.mkdtempSync(path.join(os.tmpdir(), 'carrona-probe-'));
  const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist', `--window-size=${width},${height}`,
    // tapada por otra ventana (el usuario sigue trabajando) Chrome deja de dibujarla: el juego se congela y el CDP espera
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];
  if (!visible) args.unshift('--headless=new', '--hide-scrollbars');
  else args.push('--window-position=40,20');
  const proc = spawn(CHROME, [...args, url], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(150);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); } catch { /* arrancando */ }
  }
  if (!target) { proc.kill(); throw new Error('Chrome no levantó el puerto de depuración'); }
  return attach(target.webSocketDebuggerUrl, { width, height, emulate: !visible, proc, tempProfile: profile ? null : prof });
}
