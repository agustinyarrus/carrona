// ─────────────────────────────────────────────────────────────────────────────
//  apk.mjs — Arma el APK de CARRONA de punta a punta, con Node puro como el resto de tools/:
//    node tools/apk.mjs [--release] [--install] [--run] [--serial <adb>] [--solo-gradle]
//  1. build web para Android (dist-android/www; ver build.mjs --android)
//  2. `cap sync android`: copia el www adentro del proyecto nativo (instala mobile/node_modules
//     si falta; el juego en sí no tiene dependencias, sólo el envoltorio)
//  3. Gradle: assembleDebug (firma de debug, instalable) o, con --release, assembleRelease
//     (firmado si existe mobile/android/keystore.properties; si no, queda sin firmar)
//  4. deja el APK con nombre en dist-android/CARRONA-x.y.z[-debug|-sinfirmar].apk
//  5. opcional: lo instala (adb install -r) y lo abre en el teléfono o emulador conectado
//  Requisitos: JDK 17+, el SDK de Android (ANDROID_HOME / ANDROID_SDK_ROOT / el de Android
//  Studio). Escribe mobile/android/local.properties si no está: con barras normales, porque el
//  parser de propiedades de Java se come las invertidas y Gradle termina buscando el SDK en
//  «C:UsersaguyarAppData…».
// ─────────────────────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAndroid } from './build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOBILE = path.join(ROOT, 'mobile');
const ANDROID = path.join(MOBILE, 'android');
const DIST = path.join(ROOT, 'dist-android');
const APP_ID = 'com.agustinyarrus.carrona';
const WIN = process.platform === 'win32';
const MIN_JDK = 17;

// ── argumentos ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const RELEASE = flag('--release');
const RUN = flag('--run');
const INSTALL = flag('--install') || RUN;
const SOLO_GRADLE = flag('--solo-gradle');
const SERIAL = opt('--serial');

// ── salida: pastel sobre negro, progreso y tarjeta final ──────────────────────
const TTY = !process.env.NO_COLOR;
const tinta = (rgb) => (s) => (TTY ? `\x1b[38;2;${rgb}m${s}\x1b[0m` : String(s));
const K = { azul: tinta('122;162;247'), verde: tinta('158;206;106'), rojo: tinta('247;118;142'), gris: tinta('86;95;137'), cian: tinta('125;207;255'), lila: tinta('187;154;247'), crema: tinta('192;202;245'), ambar: tinta('224;175;104') };
const t0 = Date.now();
const seg = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s`;
const PASOS = 5;
let pasoN = 0;
const paso = (texto) => console.log(`\n${K.gris(seg())}  ${K.azul(`${++pasoN}/${PASOS}`)}  ${K.crema(texto)}`);
const nota = (texto) => console.log(`${' '.repeat(15)}${K.gris('·')} ${texto}`);
const morir = (texto) => { console.error(`\n${K.rojo('✗')} ${texto}\n`); process.exit(1); };
const MB = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

/** Corre un programa mostrando su salida; muere ruidosamente si falla. `.cmd`/`.bat` van por el shell (Node no los ejecuta directo). */
function correr(cmd, args, { cwd = ROOT, shell = false, quiet = false } = {}) {
  const r = spawnSync(cmd, args, { cwd, shell, stdio: quiet ? 'pipe' : 'inherit', windowsHide: true, encoding: 'utf8' });
  if (r.error) morir(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) morir(`${path.basename(cmd)} ${args.join(' ')} salió con código ${r.status}${quiet && r.stderr ? '\n' + r.stderr : ''}`);
  return r;
}

// ── el entorno: JDK y SDK ─────────────────────────────────────────────────────
/** Versión mayor del java que va a usar Gradle (JAVA_HOME primero, después el PATH). */
function jdkMayor() {
  const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', WIN ? 'java.exe' : 'java') : 'java';
  const r = spawnSync(java, ['-version'], { encoding: 'utf8', windowsHide: true });
  if (r.error) return { java, mayor: 0 };
  const m = /version "(\d+)(?:\.(\d+))?/.exec(r.stderr + r.stdout);
  if (!m) return { java, mayor: 0 };
  // «1.8.0» es Java 8; «17.0.17» es 17
  return { java, mayor: m[1] === '1' ? +m[2] : +m[1] };
}

/** Dónde está el SDK: variables de entorno o el lugar donde lo deja Android Studio. */
function sdkDir() {
  const candidatos = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT,
    WIN && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : null,
    process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Android', 'sdk') : path.join(os.homedir(), 'Android', 'Sdk')];
  for (const c of candidatos) if (c && fs.existsSync(path.join(c, 'platform-tools'))) return c;
  return null;
}

const gameVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
console.log(`\n${K.lila('CARRONA')} ${K.gris('·')} APK ${K.crema(gameVersion)} ${K.gris(RELEASE ? '· release' : '· debug')}`);

paso('El entorno: JDK y SDK de Android');
const { java, mayor } = jdkMayor();
if (mayor < MIN_JDK) morir(`hace falta un JDK ${MIN_JDK} o más nuevo (Gradle lo busca en JAVA_HOME o en el PATH); encontré ${mayor || 'ninguno'} en ${java}`);
nota(`java ${mayor} ${K.gris(`(${java})`)}`);
const sdk = sdkDir();
if (!sdk) morir('no encuentro el SDK de Android: seteá ANDROID_HOME (la carpeta con platform-tools/, platforms/ y build-tools/)');
nota(`sdk ${K.gris(sdk)}`);
const localProps = path.join(ANDROID, 'local.properties');
if (!fs.existsSync(localProps)) {
  // barras normales a propósito: en un .properties «C:\Users» se lee «C:Users»
  fs.writeFileSync(localProps, `sdk.dir=${sdk.split(path.sep).join('/')}\n`);
  nota(`escribí ${K.gris('mobile/android/local.properties')} (no va al repo)`);
}
if (!fs.existsSync(path.join(MOBILE, 'node_modules', '@capacitor', 'cli'))) {
  nota('falta mobile/node_modules: npm ci (Capacitor y el generador de íconos, nada más)');
  correr('npm ci --no-audit --no-fund', [], { cwd: MOBILE, shell: true });
}

// ── 1 + 2: el juego adentro del proyecto nativo ───────────────────────────────
if (SOLO_GRADLE) {
  paso('Build web y cap sync: salteados (--solo-gradle)'); pasoN++;
} else {
  paso('Build web para Android (dist-android/www)');
  const b = buildAndroid({ log: (s) => nota(s) });
  nota(`${b.files.length} archivos ${K.gris('→')} ${K.gris(path.relative(ROOT, b.out))}`);

  paso('cap sync android (copia el www al proyecto nativo)');
  // el CLI directo por Node, sin npx: sin shell y sin depender del PATH
  correr(process.execPath, [path.join(MOBILE, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor'), 'sync', 'android'], { cwd: MOBILE });
}

// ── 3: Gradle ─────────────────────────────────────────────────────────────────
const tarea = RELEASE ? 'assembleRelease' : 'assembleDebug';
paso(`Gradle ${tarea} (la primera vez baja el wrapper y las dependencias: minutos)`);
const keystore = fs.existsSync(path.join(ANDROID, 'keystore.properties'));
if (RELEASE) nota(keystore ? 'firma: la clave de mobile/android/keystore.properties' : K.ambar('sin keystore.properties: el APK de release queda SIN FIRMAR (no se instala así)'));
if (WIN) correr(path.join(ANDROID, 'gradlew.bat'), [tarea, '--console=plain', '-q'], { cwd: ANDROID, shell: true });
else correr(path.join(ANDROID, 'gradlew'), [tarea, '--console=plain', '-q'], { cwd: ANDROID });

// ── 4: el APK con nombre ──────────────────────────────────────────────────────
const salida = path.join(ANDROID, 'app', 'build', 'outputs', 'apk', RELEASE ? 'release' : 'debug');
const candidatos = fs.existsSync(salida) ? fs.readdirSync(salida).filter((f) => f.endsWith('.apk')).map((f) => path.join(salida, f)) : [];
if (!candidatos.length) morir(`Gradle terminó pero no hay .apk en ${salida}`);
const apkSrc = candidatos.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
const sinFirmar = /unsigned/.test(path.basename(apkSrc));
const tipo = RELEASE ? (sinFirmar ? 'release sin firmar' : 'release firmado') : 'debug';
const sufijo = RELEASE ? (sinFirmar ? '-sinfirmar' : '') : '-debug';
fs.mkdirSync(DIST, { recursive: true });
const apk = path.join(DIST, `CARRONA-${gameVersion}${sufijo}.apk`);
fs.copyFileSync(apkSrc, apk);
const bytes = fs.statSync(apk).size;
const sha = crypto.createHash('sha256').update(fs.readFileSync(apk)).digest('hex');

// ── 5: al aparato ─────────────────────────────────────────────────────────────
let aparato = null;
if (INSTALL) {
  paso(`Instalo${RUN ? ' y abro' : ''} en el aparato conectado`);
  if (sinFirmar) morir('un APK sin firmar no se puede instalar: armá con --release y keystore.properties, o sin --release (firma de debug)');
  const adb = path.join(sdk, 'platform-tools', WIN ? 'adb.exe' : 'adb');
  const sel = SERIAL ? ['-s', SERIAL] : [];
  const devs = correr(adb, ['devices'], { quiet: true }).stdout.split('\n').slice(1).map((l) => l.trim()).filter((l) => /\tdevice$/.test(l)).map((l) => l.split('\t')[0]);
  if (!devs.length) morir('adb no ve ningún aparato (¿depuración USB? ¿el emulador arrancó?)');
  if (devs.length > 1 && !SERIAL) morir(`hay ${devs.length} aparatos (${devs.join(', ')}): elegí uno con --serial`);
  aparato = SERIAL || devs[0];
  const inst = correr(adb, [...sel, 'install', '-r', apk], { quiet: true }).stdout;
  if (!/Success/.test(inst)) morir(`adb install: ${inst.trim()}`);
  nota(`instalado en ${aparato}`);
  if (RUN) {
    const st = correr(adb, [...sel, 'shell', 'am', 'start', '-W', '-n', `${APP_ID}/.MainActivity`], { quiet: true }).stdout;
    nota(`abierto ${K.gris((/TotalTime:\s*(\d+)/.exec(st) || [, '?'])[1] + ' ms')}`);
  }
} else { pasoN++; }

// ── la tarjeta ────────────────────────────────────────────────────────────────
const filas = [
  ['versión', `${gameVersion}  ${K.gris(`(versionCode ${gameVersion.split('.').reduce((acc, n) => acc * 100 + +n, 0)})`)}`],
  ['tipo', tipo === 'debug' ? K.cian(tipo) : sinFirmar ? K.ambar(tipo) : K.verde(tipo)],
  ['tamaño', MB(bytes)],
  ['sha256', K.gris(sha)],
  ['apk', path.relative(ROOT, apk)],
  ...(aparato ? [['aparato', `${aparato}${RUN ? '  · abierto' : ''}`]] : []),
  ['tiempo', seg().trim()],
];
const ancho = 78;
const linea = (s = '') => console.log(`  ${K.gris('│')} ${s}${' '.repeat(Math.max(0, ancho - 4 - s.replace(/\x1b\[[0-9;]*m/g, '').length))}${K.gris('│')}`);
console.log(`\n  ${K.gris('╭' + '─'.repeat(ancho - 2) + '╮')}`);
linea(`${K.verde('✓')} ${K.lila('CARRONA para Android')}`);
linea();
for (const [k, v] of filas) linea(`${K.gris(k.padEnd(9))}${v}`);
console.log(`  ${K.gris('╰' + '─'.repeat(ancho - 2) + '╯')}\n`);
