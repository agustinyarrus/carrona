// ─────────────────────────────────────────────────────────────────────────────
//  build.mjs — Arma la distribución de CARRONA en dist/ con Node puro:
//    node tools/build.mjs [--out dist]
//  · copia el juego (index.html, src/, vendor/, LICENSE) más el lanzador, los íconos,
//    el manifest y el .bat
//  · inyecta <meta name="carrona-build" content="x.y.z"> en dist/index.html
//    (es la señal para que src/core/pwa.js registre el service worker)
//  · genera dist/sw.js desde sw.js reemplazando __VERSION__ y __PRECACHE__ con la
//    versión y la lista de todo lo que hay en dist (menos lo que no va en la caché)
//  · escribe installer/version.iss para Inno Setup
//  · arma dist/CARRONA-portable-x.y.z.zip (carpeta CARRONA/ con todo dist)
//  Determinista: archivos ordenados y fechas fijas en el zip.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeZip } from './zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// lo que se copia a dist (archivos o carpetas, relativo a la raíz del repo)
const PAYLOAD = ['index.html', 'src', 'vendor', 'LICENSE', 'launcher', 'icons', 'manifest.webmanifest', 'Jugar CARRONA.bat'];
// basura de sistema que nunca se copia
const JUNK = new Set(['Thumbs.db', '.DS_Store', 'desktop.ini']);

/** ¿Va a la caché del service worker? Fuera: el propio sw.js, el lanzador, el .bat, la licencia y el .ico. */
export function isPrecached(rel) {
  const p = rel.replace(/\\/g, '/');
  if (p === 'sw.js' || p === 'LICENSE' || p === 'icons/carrona.ico') return false;
  if (p.startsWith('launcher/') || p.endsWith('.bat')) return false;
  return true;
}

/** Recorrido recursivo ordenado: rutas relativas con '/'. */
export function walk(dir, base = dir) {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (JUNK.has(name)) continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function copyInto(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src).sort()) {
      if (JUNK.has(name)) continue;
      copyInto(path.join(src, name), path.join(dst, name));
    }
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

export function build({ out = path.join(ROOT, 'dist'), log = console.log } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version;
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`versión rara en package.json: ${version}`);
  out = path.resolve(out);
  const rootFull = path.resolve(ROOT);
  if (out === rootFull || rootFull.startsWith(out + path.sep)) throw new Error(`--out no puede ser la raíz del repo ni una carpeta que la contenga: ${out}`);

  // ── limpiar y copiar ──
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const item of PAYLOAD) {
    const src = path.join(ROOT, item);
    if (!fs.existsSync(src)) throw new Error(`falta ${item}${item === 'icons' ? ' (corré node tools/icons.mjs)' : ''}`);
    copyInto(src, path.join(out, item));
  }

  // ── index.html: la meta de build ──
  const indexPath = path.join(out, 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');
  const charset = '<meta charset="utf-8">';
  if (!html.includes(charset)) throw new Error('index.html no tiene <meta charset="utf-8">');
  fs.writeFileSync(indexPath, html.replace(charset, `${charset}\n<meta name="carrona-build" content="${version}">`));

  // ── sw.js con la versión y el precache ──
  const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  if (!swSrc.includes("'__VERSION__'") || !swSrc.includes('__PRECACHE__')) throw new Error('sw.js no tiene los marcadores __VERSION__ / __PRECACHE__');
  const precache = ['./', ...walk(out).filter(isPrecached).map((p) => './' + p)];
  const swOut = swSrc
    .replace("'__VERSION__'", JSON.stringify(version))
    .replace('__PRECACHE__', JSON.stringify(precache, null, 2));
  if (swOut.includes('__VERSION__') || swOut.includes('__PRECACHE__')) throw new Error('quedaron marcadores en sw.js');
  fs.writeFileSync(path.join(out, 'sw.js'), swOut);

  // ── version.iss para Inno Setup ──
  fs.mkdirSync(path.join(ROOT, 'installer'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'installer', 'version.iss'), `; generado por tools/build.mjs, no editar\n#define AppVersion "${version}"\n`);

  // ── zip portable: carpeta CARRONA/ con todo dist ──
  const files = walk(out);
  let bytes = 0;
  const entries = files.map((rel) => {
    const data = fs.readFileSync(path.join(out, rel));
    bytes += data.length;
    return { name: 'CARRONA/' + rel, data };
  });
  const zipName = `CARRONA-portable-${version}.zip`;
  const zip = makeZip(entries);
  fs.writeFileSync(path.join(out, zipName), zip);

  log(`  CARRONA ${version} → ${out}`);
  log(`  ${files.length} archivos, ${bytes} bytes · precache: ${precache.length} entradas`);
  log(`  ${zipName}: ${zip.length} bytes`);
  return { version, out, files, bytes, precache, zip: path.join(out, zipName) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--out');
  const out = i >= 0 && args[i + 1] ? path.resolve(args[i + 1]) : path.join(ROOT, 'dist');
  try {
    build({ out });
  } catch (err) {
    console.error(`  ERROR: ${err.message}`);
    process.exit(1);
  }
}
