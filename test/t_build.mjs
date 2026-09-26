// Pruebas del build y la distribución: corre tools/build.mjs en una carpeta temporal
// y revisa dist/ (meta de build, sw.js con el precache exacto, manifest, lanzador,
// zip portable), más chequeos estáticos del lanzador PowerShell 5.1, los íconos,
// serve.py, el instalador y el workflow.
//   node test/t_build.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (...p) => path.join(ROOT, ...p);
const read = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => fs.existsSync(p);

let fails = 0;
const ok = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'OK   ' : 'FALLA'} ${name}   ${extra}`);
  if (!cond) fails++;
};

/** Recorrido recursivo ordenado, rutas relativas con '/'. */
function walk(dir, base = dir) {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

const pkg = JSON.parse(read(R('package.json')));
const version = pkg.version;
console.log(`  package.json: versión ${version}`);

// ═══ el build en una carpeta temporal ═══════════════════════════════════════
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carrona-build-'));
const dist = path.join(tmp, 'dist');
try {
  let buildOut = '';
  try {
    buildOut = execFileSync(process.execPath, [R('tools', 'build.mjs'), '--out', dist], { cwd: ROOT, encoding: 'utf8' });
  } catch (err) {
    ok('tools/build.mjs termina bien', false, String(err.stdout || err.message).trim());
  }
  ok('el build imprime un resumen', /archivos/.test(buildOut) && /precache/.test(buildOut), buildOut.trim().split('\n')[1] || '');

  // ── index.html ──
  const html = exists(path.join(dist, 'index.html')) ? read(path.join(dist, 'index.html')) : '';
  ok('dist/index.html tiene la meta carrona-build con la versión', html.includes(`<meta name="carrona-build" content="${version}">`));
  ok('la meta va después de <meta charset="utf-8">', html.indexOf('<meta charset="utf-8">') >= 0 && html.indexOf('<meta charset="utf-8">') < html.indexOf('carrona-build'));
  ok('el index.html del repo NO tiene la meta (el SW no se registra en desarrollo)', !read(R('index.html')).includes('carrona-build'));

  // ── payload ──
  ok('dist/src/main.js', exists(path.join(dist, 'src', 'main.js')));
  ok('dist/src/core/pwa.js', exists(path.join(dist, 'src', 'core', 'pwa.js')));
  ok('dist/vendor/three/three.module.js', exists(path.join(dist, 'vendor', 'three', 'three.module.js')));
  ok('dist/LICENSE', exists(path.join(dist, 'LICENSE')));
  ok('dist/launcher/carrona.ps1 copiado', exists(path.join(dist, 'launcher', 'carrona.ps1')));
  const distFiles = exists(dist) ? walk(dist) : [];
  ok('dist no trae docs/, test/, tools/, README ni serve.py', !distFiles.some((f) => /^(docs|test|tools|installer|\.github)\//.test(f) || f === 'README.md' || f === 'serve.py' || f === 'package.json'), distFiles.length + ' archivos');
  for (const f of distFiles) {
    if (f.endsWith('.zip')) continue;
    const a = fs.readFileSync(path.join(dist, f));
    const src = f === 'index.html' || f === 'sw.js' ? null : R(f);
    if (src && exists(src) && !a.equals(fs.readFileSync(src))) ok(`copia idéntica: ${f}`, false);
  }
  ok('las copias son idénticas a los originales', true);

  // ── sw.js ──
  const sw = exists(path.join(dist, 'sw.js')) ? read(path.join(dist, 'sw.js')) : '';
  ok('dist/sw.js no tiene __VERSION__ ni __PRECACHE__', sw.length > 0 && !sw.includes('__VERSION__') && !sw.includes('__PRECACHE__'));
  ok('dist/sw.js lleva la versión', sw.includes(`const VERSION = "${version}";`));
  const mPre = sw.match(/const PRECACHE = (\[[\s\S]*?\]);/);
  let precache = [];
  try { precache = JSON.parse(mPre ? mPre[1] : '[]'); } catch { precache = []; }
  ok('dist/sw.js tiene la lista de precache (JSON)', Array.isArray(precache) && precache.length > 10, precache.length + ' entradas');
  const excluded = (f) => f === 'sw.js' || f === 'LICENSE' || f === 'icons/carrona.ico' || f.startsWith('launcher/') || f.endsWith('.bat') || f.endsWith('.zip');
  const expected = ['./', ...distFiles.filter((f) => !excluded(f)).map((f) => './' + f)];
  const same = precache.length === expected.length && precache.every((p, i) => p === expected[i]);
  ok('el precache coincide EXACTAMENTE con dist menos las exclusiones', same,
    same ? '' : `faltan [${expected.filter((e) => !precache.includes(e)).join(', ')}] sobran [${precache.filter((p) => !expected.includes(p)).join(', ')}]`);
  for (const must of ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './src/main.js']) ok(`precache incluye ${must}`, precache.includes(must));
  const threeJs = distFiles.filter((f) => f.startsWith('vendor/three/') && f.endsWith('.js'));
  ok('precache incluye todos los vendor/three/**/*.js', threeJs.length > 5 && threeJs.every((f) => precache.includes('./' + f)), threeJs.length + ' archivos');
  ok('precache no incluye sw.js, el lanzador, el .bat, LICENSE ni el .ico', !precache.some((p) => /sw\.js$|launcher\/|\.bat$|LICENSE|carrona\.ico|\.zip$/.test(p)));
  ok('el sw.js del repo conserva los marcadores', read(R('sw.js')).includes("const VERSION = '__VERSION__';") && read(R('sw.js')).includes('const PRECACHE = __PRECACHE__;'));
  ok('sw.js ignora /__carrona y /__bye', /pathname\.startsWith\('\/__'\)/.test(sw));
  ok('sw.js: install con addAll + skipWaiting, activate con clients.claim', /addAll/.test(sw) && /skipWaiting/.test(sw) && /clients\.claim/.test(sw));

  // ── manifest ──
  let manifest = null;
  try { manifest = JSON.parse(read(path.join(dist, 'manifest.webmanifest'))); } catch { manifest = null; }
  ok('dist/manifest.webmanifest es JSON válido', !!manifest);
  ok('manifest: start_url "./" y scope "./"', manifest && manifest.start_url === './' && manifest.scope === './');
  ok('manifest: name CARRONA, display fullscreen, lang es, colores #06070a', manifest && manifest.name === 'CARRONA' && manifest.display === 'fullscreen' && manifest.lang === 'es' && manifest.theme_color === '#06070a' && manifest.background_color === '#06070a');
  const icons = manifest ? manifest.icons || [] : [];
  ok('manifest: íconos 192, 512 y maskable, y existen en dist', icons.length >= 3 && icons.some((i) => i.sizes === '192x192') && icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable') && icons.every((i) => exists(path.join(dist, i.src))), icons.map((i) => i.src).join(' '));

  // ── lanzador copiado y .bat ──
  const batPath = path.join(dist, 'Jugar CARRONA.bat');
  const bat = exists(batPath) ? read(batPath) : '';
  ok('dist/Jugar CARRONA.bat copiado', bat.length > 0);
  ok('.bat: -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File', /-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File/.test(bat));
  ok('.bat: referencia launcher\\carrona.ps1 con %~dp0', /"%~dp0launcher\\carrona\.ps1"/.test(bat));
  ok('.bat: cd /d "%~dp0" y @echo off', /@echo off/.test(bat) && /cd \/d "%~dp0"/.test(bat));
  ok('.bat: ASCII puro (cmd usa la página de códigos OEM)', !/[^\x00-\x7f]/.test(bat));
  ok('.bat: ya no llama a python', !bat.split(/\r?\n/).some((l) => !/^\s*rem\b/i.test(l) && /python/i.test(l)));

  // ── version.iss ──
  const iss = exists(R('installer', 'version.iss')) ? read(R('installer', 'version.iss')) : '';
  ok('installer/version.iss con la versión', iss.includes(`#define AppVersion "${version}"`));

  // ── zip portable ──
  const zipPath = path.join(dist, `CARRONA-portable-${version}.zip`);
  ok('el zip portable existe', exists(zipPath));
  if (exists(zipPath)) {
    const zip = fs.readFileSync(zipPath);
    // EOCD: se busca la firma desde el final
    let eocd = -1;
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    ok('el zip tiene EOCD', eocd >= 0);
    const entries = [];
    if (eocd >= 0) {
      const count = zip.readUInt16LE(eocd + 10), cdSize = zip.readUInt32LE(eocd + 12), cdOff = zip.readUInt32LE(eocd + 16);
      let p = cdOff;
      for (let i = 0; i < count; i++) {
        if (zip.readUInt32LE(p) !== 0x02014b50) break;
        const method = zip.readUInt16LE(p + 10), crc = zip.readUInt32LE(p + 16), csize = zip.readUInt32LE(p + 20), usize = zip.readUInt32LE(p + 24);
        const n = zip.readUInt16LE(p + 28), e = zip.readUInt16LE(p + 30), c = zip.readUInt16LE(p + 32), off = zip.readUInt32LE(p + 42);
        entries.push({ name: zip.toString('utf8', p + 46, p + 46 + n), method, crc, csize, usize, off });
        p += 46 + n + e + c;
      }
      ok('el directorio central se recorre entero', entries.length === count && p === cdOff + cdSize, `${entries.length} entradas`);
    }
    const filesNoZip = distFiles.filter((f) => !f.endsWith('.zip'));
    ok('entradas del zip = archivos de dist menos el zip', entries.length === filesNoZip.length, `${entries.length} vs ${filesNoZip.length}`);
    ok('todas las entradas van adentro de CARRONA/', entries.length > 0 && entries.every((e) => e.name.startsWith('CARRONA/') && !e.name.endsWith('/')));
    ok('los nombres coinciden con dist', entries.length > 0 && entries.every((e, i) => e.name === 'CARRONA/' + filesNoZip[i]));
    const inflate = (e) => {
      const lh = e.off;
      if (zip.readUInt32LE(lh) !== 0x04034b50) throw new Error('cabecera local rota');
      const n = zip.readUInt16LE(lh + 26), x = zip.readUInt16LE(lh + 28);
      const data = zip.subarray(lh + 30 + n + x, lh + 30 + n + x + e.csize);
      return e.method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
    };
    for (const rel of ['src/main.js', 'index.html', 'vendor/three/three.module.js', 'icons/icon-192.png']) {
      const e = entries.find((x) => x.name === 'CARRONA/' + rel);
      let same = false, note = 'no está en el zip';
      if (e) {
        try {
          const out = inflate(e);
          same = out.equals(fs.readFileSync(path.join(dist, rel))) && out.length === e.usize;
          note = `${e.csize} → ${out.length} bytes, método ${e.method}`;
        } catch (err) { note = err.message; }
      }
      ok(`${rel} descomprimido es idéntico al original`, same, note);
    }
    // determinista: un segundo zip del mismo dist es byte a byte igual
    const { makeZip } = await import('../tools/zip.mjs');
    const again = makeZip(filesNoZip.map((f) => ({ name: 'CARRONA/' + f, data: fs.readFileSync(path.join(dist, f)) })));
    ok('el zip es determinista', again.equals(zip), `${zip.length} bytes`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
ok('la carpeta temporal se limpió', !exists(tmp));

// ═══ chequeos estáticos del lanzador (PowerShell 5.1) ═══════════════════════
const ps1Buf = fs.readFileSync(R('launcher', 'carrona.ps1'));
const ps1 = ps1Buf.toString('utf8').replace(/^﻿/, '');
const code = ps1.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');   // sin las líneas de comentario
ok('carrona.ps1 tiene BOM UTF-8 (5.1 lo lee como ANSI si no)', ps1Buf[0] === 0xef && ps1Buf[1] === 0xbb && ps1Buf[2] === 0xbf);
ok('ps1: sin ?? (PS7)', !/\?\?/.test(code));
ok('ps1: sin ternario ? : (PS7)', !/\s\?\s/.test(code));
ok('ps1: sin -Parallel (PS7)', !/-Parallel/i.test(code));
ok('ps1: sin else/elseif al principio de línea (rompe en PowerShell)', !/^\s*(else|elseif)\b/m.test(code));
ok('ps1: usa [System.Net.HttpListener]', /\[System\.Net\.HttpListener\]/.test(code) && /New-Object System\.Net\.HttpListener/.test(code));
ok('ps1: escucha en http://localhost:', /http:\/\/localhost:/.test(code));
ok('ps1: GetContextAsync con Wait (GetContext bloqueante no se interrumpe en 5.1)', /GetContextAsync\(\)/.test(code) && /\.Wait\(250\)/.test(code) && !/\.GetContext\(\)/.test(code));
ok('ps1: abre el navegador con --app= y --user-data-dir', /--app=/.test(code) && /--user-data-dir/.test(code));
ok('ps1: --no-first-run, --no-default-browser-check y msEdgeFirstRunExperience', /--no-first-run/.test(code) && /--no-default-browser-check/.test(code) && /msEdgeFirstRunExperience/.test(code));
ok('ps1: busca msedge.exe y chrome.exe en App Paths (HKLM, HKCU, WOW6432Node)', /App Paths/.test(code) && /msedge\.exe/.test(code) && /chrome\.exe/.test(code) && /HKEY_CURRENT_USER/.test(code) && /WOW6432Node/.test(code));
ok('ps1: /__carrona y /__bye', /__carrona/.test(code) && /__bye/.test(code));
// la sonda va por IPv4 con Host: localhost (http.sys sólo atiende ese prefijo) y sin proxy: por "localhost" a secas
// se probaba primero ::1, donde serve.py no escucha, y la respuesta llegaba a los 4,9 s con un plazo de 2
ok('ps1: sonda de segunda instancia por 127.0.0.1 con Host: localhost, sin proxy y plazo de 2 s',
  /127\.0\.0\.1:\$port\/__carrona/.test(code) && /\.Host = "localhost:\$port"/.test(code) && /\.Proxy = \$null/.test(code) && /\.Timeout = 2000/.test(code));
ok('ps1: MIME text/javascript y application/manifest+json', /'\.js' = 'text\/javascript'/.test(code) && /'\.mjs' = 'text\/javascript'/.test(code) && /'\.webmanifest' = 'application\/manifest\+json'/.test(code));
ok('ps1: MIME html, css, json, png, ico, svg, txt, md', ['.html', '.css', '.json', '.png', '.ico', '.svg', '.txt', '.md'].every((e) => code.includes(`'${e}' = `)));
ok('ps1: rechaza .. y sirve / como index.html', /Contains\('\.\.'\)/.test(code) && /'\/index\.html'/.test(code));
ok('ps1: Cache-Control no-store y max-age=3600', /no-store/.test(code) && /max-age=3600/.test(code));
ok('ps1: puertos alternativos 8766..8775', /\$BasePort = 8765/.test(code) && /\$MaxPort = 8775/.test(code));
ok('ps1: 90 s sin pedidos sin proceso hijo', /TotalSeconds -gt 90/.test(code));
ok('ps1: la carpeta del juego es el padre de launcher\\', /Split-Path \$PSScriptRoot -Parent/.test(code));
ok('ps1: log en %LOCALAPPDATA%\\CARRONA\\launcher.log', /launcher\.log/.test(code) && /\$env:LOCALAPPDATA/.test(code));
ok('ps1: -ExecutionPolicy Bypass documentado en la cabecera', /-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File/.test(ps1));
{
  // llaves y paréntesis balanceados fuera de comentarios y strings (un chequeo grosero de sintaxis)
  let depth = { '{': 0, '(': 0 }, inStr = null, bad = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (inStr) { if (ch === '`') i++; else if (ch === inStr) inStr = null; continue; }
    if (ch === "'" || ch === '"') { inStr = ch; continue; }
    if (ch === '{' || ch === '(') depth[ch]++;
    if (ch === '}') { depth['{']--; if (depth['{'] < 0) bad = true; }
    if (ch === ')') { depth['(']--; if (depth['('] < 0) bad = true; }
  }
  ok('ps1: llaves y paréntesis balanceados', !bad && depth['{'] === 0 && depth['('] === 0 && !inStr, `{${depth['{']} (${depth['(']}`);
}

// ═══ íconos ═════════════════════════════════════════════════════════════════
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngSize = (buf) => (buf.subarray(0, 8).equals(PNG_SIG) && buf.toString('latin1', 12, 16) === 'IHDR' ? [buf.readUInt32BE(16), buf.readUInt32BE(20)] : null);
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['icon-maskable-512.png', 512], ['favicon-32.png', 32]]) {
  const p = R('icons', name);
  const s = exists(p) ? pngSize(fs.readFileSync(p)) : null;
  ok(`icons/${name} es PNG de ${size}x${size}`, s && s[0] === size && s[1] === size, s ? `${s[0]}x${s[1]}` : 'no existe o no es PNG');
}
{
  const p = R('icons', 'carrona.ico');
  const ico = exists(p) ? fs.readFileSync(p) : Buffer.alloc(0);
  const count = ico.length >= 6 ? ico.readUInt16LE(4) : 0;
  const sizes = [];
  let allPng = count > 0;
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    const w = ico[e] || 256, len = ico.readUInt32LE(e + 8), off = ico.readUInt32LE(e + 12);
    sizes.push(w);
    const s = pngSize(ico.subarray(off, off + len));
    if (!s || s[0] !== w) allPng = false;
  }
  ok('icons/carrona.ico: tipo 1, 4 entradas (16, 32, 48, 256) con PNG adentro', ico.readUInt16LE(2) === 1 && count === 4 && allPng && sizes.join(',') === '16,32,48,256', sizes.join(','));
}
{
  // determinista: regenerar en memoria da los mismos bytes que lo commiteado
  const { renderIcon, encodePng } = await import('../tools/icons.mjs');
  const again = encodePng(192, 192, renderIcon(192));
  ok('icons.mjs es determinista (icon-192.png se regenera idéntico)', again.equals(fs.readFileSync(R('icons', 'icon-192.png'))));
}

// ═══ serve.py, lanzador viejo, versión, instalador, workflow ════════════════
const servePy = read(R('serve.py'));
ok('serve.py enlaza a localhost', /\('localhost', PORT\)/.test(servePy) && /http:\/\/localhost:\{PORT\}/.test(servePy));
ok('serve.py no usa 127.0.0.1', !servePy.includes('127.0.0.1'));
ok('serve.py responde /__carrona, acepta --dir y --no-open, y sirve .webmanifest', /__carrona/.test(servePy) && /--dir/.test(servePy) && /--no-open/.test(servePy) && /application\/manifest\+json/.test(servePy));
ok('el .vbs ya no existe', !exists(R('Jugar CARRONA (sin consola).vbs')));
ok('.gitignore ignora dist/ e installer/version.iss', /^dist\/$/m.test(read(R('.gitignore'))) && /^installer\/version\.iss$/m.test(read(R('.gitignore'))));

if (exists(R('src', 'core', 'version.js'))) {
  const m = read(R('src', 'core', 'version.js')).match(/VERSION\s*=\s*'([^']+)'/);
  ok('src/core/version.js coincide con package.json', m && m[1] === version, `${m ? m[1] : '?'} vs ${version}`);
}

const pwa = read(R('src', 'core', 'pwa.js'));
ok('pwa.js exporta initPwa, isStandalone y pingServer', /export function initPwa/.test(pwa) && /export function isStandalone/.test(pwa) && /export async function pingServer/.test(pwa));
ok('pwa.js registra ./sw.js sólo con la meta carrona-build', /meta\[name="carrona-build"\]/.test(pwa) && /register\('\.\/sw\.js'/.test(pwa));
ok('pwa.js no importa nada del juego', !/import /.test(pwa));

const issSrc = read(R('installer', 'carrona.iss'));
ok('carrona.iss: incluye version.iss y usa {#AppVersion}', /#include "version\.iss"/.test(issSrc) && /AppVersion=\{#AppVersion\}/.test(issSrc));
ok('carrona.iss: lanza powershell.exe con Bypass y launcher\\carrona.ps1', /powershell\.exe/.test(issSrc) && /-ExecutionPolicy Bypass -WindowStyle Hidden -File ""\{app\}\\launcher\\carrona\.ps1""/.test(issSrc));
ok('carrona.iss: por usuario, excluye el zip, español, borra %LOCALAPPDATA%\\CARRONA', /PrivilegesRequired=lowest/.test(issSrc) && /Excludes: "\*\.zip"/.test(issSrc) && /Spanish\.isl/.test(issSrc) && /\{localappdata\}\\CARRONA/.test(issSrc));

const wf = read(R('.github', 'workflows', 'release.yml'));
ok('release.yml: windows-latest, icons, test, build, ISCC, artefactos y release', /windows-latest/.test(wf) && /tools\/icons\.mjs/.test(wf) && /npm test/.test(wf) && /tools\/build\.mjs/.test(wf) && /ISCC\.exe/.test(wf) && /upload-artifact@v4/.test(wf) && /gh release create/.test(wf));
const uses = [...wf.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
ok('release.yml: sólo acciones de primera parte (actions/*)', uses.length >= 3 && uses.every((u) => u.startsWith('actions/')), uses.join(' '));

console.log(fails ? `\n${fails} PRUEBAS FALLARON` : '\nTODO VERDE');
process.exit(fails ? 1 : 0);
