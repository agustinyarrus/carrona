// ─────────────────────────────────────────────────────────────────────────────
//  audio.js — Todo el sonido, sintetizado con Web Audio. Cero archivos.
//
//  Disparos: perfiles por arma (ruido filtrado, golpe grave, chasquido,
//  barridos, FM, chisporroteo: ver SHOT_SOUNDS al final). Zombis: dos
//  osciladores con vibrato pasando por formantes, distinto por bicho.
//  Ambiente: ruido marrón muy bajo, un zumbido eléctrico y un colchón oscuro
//  de dos sierras desafinadas que se abre cuando la cosa se pone fea.
//  Todo lo que ocurre en el mundo se paneá y se atenúa según dónde esté
//  respecto del jugador.
// ─────────────────────────────────────────────────────────────────────────────

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.volume = 0.8;
    this.sfxVolume = 1; this.musicVolume = 1;   // dos buses debajo del master: efectos y ambiente
    this.lx = 0; this.lz = 0;         // el oyente (el jugador)
    this.moans = 0;
    this.intensity = 0;
    this._padNotes = [[55, 82.41], [43.65, 65.41], [49, 73.42], [55, 87.31]];
    this._padIdx = 0;
  }

  init() {
    if (this.ready) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC({ latencyHint: 'interactive' });
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14; this.comp.knee.value = 18; this.comp.ratio.value = 5;
    this.comp.attack.value = 0.003; this.comp.release.value = 0.18;
    this.master.connect(this.comp); this.comp.connect(ctx.destination);
    // buses: todo lo que suena en el mundo va por `sfx`; el ambiente por `music`
    this.sfx = ctx.createGain(); this.sfx.gain.value = this.sfxVolume; this.sfx.connect(this.master);
    this.music = ctx.createGain(); this.music.gain.value = this.musicVolume; this.music.connect(this.master);
    // buffers de ruido
    this.white = this._noiseBuffer(2, 'white');
    this.brown = this._noiseBuffer(4, 'brown');
    this._ambient();
    this.ready = true;
  }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
  /** Pausa: el contexto se congela (nada suena, nada avanza) hasta `resume()`. */
  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; }
  setSfxVolume(v) { this.sfxVolume = v; if (this.sfx) this.sfx.gain.value = v; }
  setMusicVolume(v) { this.musicVolume = v; if (this.music) this.music.gain.value = v; }
  listener(x, z) { this.lx = x; this.lz = z; }

  _noiseBuffer(sec, kind) {
    const ctx = this.ctx, n = Math.floor(ctx.sampleRate * sec);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
      else d[i] = w;
    }
    return buf;
  }

  /** Ganancia y paneo según la distancia al oyente. */
  _spatial(x, z, refDist = 6, maxDist = 32) {
    if (x === undefined) return { g: 1, pan: 0 };
    const dx = x - this.lx, dz = z - this.lz;
    const d = Math.hypot(dx, dz);
    const g = d < refDist ? 1 : Math.max(0, 1 - (d - refDist) / (maxDist - refDist));
    const pan = Math.max(-0.8, Math.min(0.8, dx / 10));
    return { g: g * g, pan };
  }
  _out(x, z, gain, refDist, maxDist) {
    const ctx = this.ctx;
    const { g, pan } = this._spatial(x, z, refDist, maxDist);
    if (g <= 0.001) return null;
    const G = ctx.createGain(); G.gain.value = gain * g;
    const P = ctx.createStereoPanner(); P.pan.value = pan;
    G.connect(P); P.connect(this.sfx);
    return G;
  }
  _noise(buf, dest, t0, dur, { lp = 8000, hp = 40, q = 0.7, peak = 1, decay = null, attack = 0.002 } = {}) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    src.playbackRate.value = 0.9 + Math.random() * 0.2;
    const LP = ctx.createBiquadFilter(); LP.type = 'lowpass'; LP.frequency.value = lp; LP.Q.value = q;
    const HP = ctx.createBiquadFilter(); HP.type = 'highpass'; HP.frequency.value = hp;
    const G = ctx.createGain();
    G.gain.setValueAtTime(0, t0);
    G.gain.linearRampToValueAtTime(peak, t0 + attack);
    G.gain.exponentialRampToValueAtTime(0.001, t0 + (decay ?? dur));
    src.connect(HP); HP.connect(LP); LP.connect(G); G.connect(dest);
    src.start(t0); src.stop(t0 + dur + 0.05);
    return { src, LP, G };
  }
  _tone(type, freq, dest, t0, dur, peak = 0.5, endFreq = null, attack = 0.002) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t0);
    if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, t0 + dur);
    const G = ctx.createGain();
    G.gain.setValueAtTime(0, t0);
    G.gain.linearRampToValueAtTime(peak, t0 + attack);
    G.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    o.connect(G); G.connect(dest);
    o.start(t0); o.stop(t0 + dur + 0.05);
    return o;
  }

  // ═══ armas ════════════════════════════════════════════════════════════════
  /**
   * Un disparo. `w` es la definición del arma (o, como antes, el nombre de un
   * perfil). El perfil es una lista de capas (ruido filtrado, tono con
   * barrido, FM, chisporroteo) — ver SHOT_SOUNDS. El silenciador baja todo y
   * lo filtra; el tono varía ±4 % por tiro para que una ráfaga no suene a loop.
   */
  shot(w, x, z) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const own = x === undefined;
    const dest = own ? this.sfx : this._out(x, z, 1, 8, 40);
    if (!dest) return;
    const name = typeof w === 'string' ? w : (w.shot && w.shot.sound) || 'pistol';
    const silenced = typeof w === 'object' && w.shot && w.shot.fx && w.shot.fx.silenced;
    const pitch = (typeof w === 'object' && w.shot && w.shot.pitch || 1) * (0.96 + Math.random() * 0.08);
    const P = SHOT_SOUNDS[name] || SHOT_SOUNDS.pistol;
    let out = dest;
    if (silenced) {
      // silenciado: pasa-bajos fuerte y la mitad de volumen (el "tup" en vez del estampido)
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1400;
      const g = ctx.createGain(); g.gain.value = 0.42;
      lp.connect(g); g.connect(dest); out = lp;
    }
    for (const L of P) this._layer(L, out, t, pitch);
  }

  /** Una capa de un perfil de sonido. */
  _layer(L, dest, t0, pitch) {
    const t = t0 + (L.at || 0);
    if (L.n) {
      // ruido: n = 'w' blanco / 'b' marrón
      this._noise(L.n === 'b' ? this.brown : this.white, dest, t, L.dur, { lp: L.lp * pitch, hp: L.hp || 40, peak: L.peak, decay: L.decay ?? L.dur * 0.8, q: L.q ?? 0.7, attack: L.atk ?? 0.002 });
    } else if (L.fm) {
      // FM: la moduladora hace temblar a la portadora (plasma, iones)
      const ctx = this.ctx;
      const car = ctx.createOscillator(), mod = ctx.createOscillator(), mg = ctx.createGain(), G = ctx.createGain();
      car.type = L.wave || 'sine'; car.frequency.setValueAtTime(L.f0 * pitch, t);
      if (L.f1) car.frequency.exponentialRampToValueAtTime(L.f1 * pitch, t + L.dur);
      mod.frequency.value = L.fm * pitch; mg.gain.value = L.depth || 80;
      mod.connect(mg); mg.connect(car.frequency);
      G.gain.setValueAtTime(0, t); G.gain.linearRampToValueAtTime(L.peak, t + 0.004); G.gain.exponentialRampToValueAtTime(0.001, t + L.dur);
      car.connect(G); G.connect(dest);
      car.start(t); mod.start(t); car.stop(t + L.dur + 0.05); mod.stop(t + L.dur + 0.05);
    } else if (L.crackle) {
      // chisporroteo: ráfagas cortitas de ruido agudo al azar (tesla)
      for (let i = 0; i < L.crackle; i++) {
        const tt = t + Math.random() * L.dur;
        this._noise(this.white, dest, tt, 0.018, { lp: 9000, hp: 2500, peak: L.peak * (0.5 + Math.random() * 0.5), decay: 0.012 });
      }
    } else {
      // tono con barrido
      this._tone(L.wave || 'sine', L.f0 * pitch, dest, t, L.dur, L.peak, L.f1 ? L.f1 * pitch : null, L.atk ?? 0.002);
    }
  }

  /** Estallido: golpe grave, cuerpo de ruido marrón, crujido y cola larga. Espacial. */
  explosion(x, z, size = 1) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const dest = x === undefined ? this.sfx : this._out(x, z, 1.1, 10, 55); if (!dest) return;
    const k = Math.min(1.6, size);
    this._tone('sine', 70, dest, t, 0.7 * k, 0.9, 24);
    this._noise(this.brown, dest, t, 1.4 * k, { lp: 900, hp: 20, peak: 1.0, decay: 1.1 * k });
    this._noise(this.white, dest, t, 0.35, { lp: 3200, hp: 300, peak: 0.45, decay: 0.25 });
    for (let i = 0; i < 6; i++) this._noise(this.white, dest, t + 0.08 + Math.random() * 0.5, 0.03, { lp: 6000, hp: 1500, peak: 0.12, decay: 0.02 });
  }
  /** Clavo, virote o disco que pega en la pared. */
  thunk(x, z, metal = false) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const dest = this._out(x, z, 0.6, 6, 26); if (!dest) return;
    this._noise(this.brown, dest, t, 0.08, { lp: metal ? 5000 : 1200, hp: 200, peak: 0.5, decay: 0.06 });
    if (metal) this._tone('triangle', 1800 + Math.random() * 600, dest, t, 0.18, 0.08, 1500);
  }
  /** El relámpago que salta entre zombis. */
  zap(x, z) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const dest = this._out(x, z, 0.7, 6, 28); if (!dest) return;
    for (let i = 0; i < 5; i++) this._noise(this.white, dest, t + Math.random() * 0.1, 0.02, { lp: 8000, hp: 2000, peak: 0.3, decay: 0.015 });
    this._tone('sawtooth', 120, dest, t, 0.12, 0.08, 60);
  }

  /**
   * Zumbidos continuos (rotativa girando, riel cargando, lanzallamas): un
   * oscilador o un ruido que se prenden una vez y se modulan por cuadro.
   * `level` 0..1; con 0 se apagan solos. O(1) por llamada.
   */
  hum(id, level, spec) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    this._hums = this._hums || {};
    let H = this._hums[id];
    if (!H && level <= 0.001) return;
    if (!H) {
      const G = ctx.createGain(); G.gain.value = 0; G.connect(this.sfx);
      let src, filt = null;
      if (spec.noise) {
        src = ctx.createBufferSource(); src.buffer = this.white; src.loop = true;
        filt = ctx.createBiquadFilter(); filt.type = 'bandpass'; filt.frequency.value = spec.f0; filt.Q.value = spec.q || 0.8;
        src.connect(filt); filt.connect(G);
      } else {
        src = ctx.createOscillator(); src.type = spec.wave || 'sawtooth'; src.frequency.value = spec.f0;
        filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = spec.lp || 1800;
        src.connect(filt); filt.connect(G);
      }
      src.start();
      H = this._hums[id] = { G, src, filt, spec };
    }
    const s = H.spec;
    H.G.gain.setTargetAtTime(level * s.peak, t, 0.05);
    const f = s.f0 + (s.f1 - s.f0) * level;
    if (s.noise) H.filt.frequency.setTargetAtTime(f, t, 0.05); else H.src.frequency.setTargetAtTime(f, t, 0.03);
  }
  /** Apaga todos los zumbidos (cambio de arma, pausa, muerte). */
  humStop() { if (!this._hums) return; const t = this.ctx.currentTime; for (const k in this._hums) this._hums[k].G.gain.setTargetAtTime(0, t, 0.04); }

  empty() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this._noise(this.white, this.sfx, t, 0.03, { lp: 5000, hp: 1500, peak: 0.25, decay: 0.02 });
  }
  /** Recarga: dos chasquidos (o varios cartuchos de a uno en las escopetas, o el zumbido de la batería). */
  reload(kind) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const fam = typeof kind === 'object' ? kind.family : kind;
    if (fam === 'energy') { this._tone('sine', 220, this.sfx, t, 0.5, 0.06, 880, 0.2); return; }
    if (fam === 'shotgun' || kind === 'shotgun') {
      for (let i = 0; i < 3; i++) this._noise(this.white, this.sfx, t + i * 0.28, 0.04, { lp: 3500, hp: 700, peak: 0.22, decay: 0.03 });
      this._noise(this.white, this.sfx, t + 0.95, 0.06, { lp: 4500, hp: 900, peak: 0.3, decay: 0.045 });
      return;
    }
    const dur = fam === 'lmg' || fam === 'rotary' ? 0.8 : fam === 'launcher' ? 0.6 : 0.35;
    this._noise(this.white, this.sfx, t, 0.04, { lp: 4000, hp: 800, peak: 0.2, decay: 0.03 });
    this._noise(this.white, this.sfx, t + dur, 0.05, { lp: 5000, hp: 1200, peak: 0.28, decay: 0.035 });
    this._tone('square', 900, this.sfx, t + dur, 0.02, 0.05);
  }
  switchWeapon() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this._noise(this.white, this.sfx, t, 0.05, { lp: 3000, hp: 600, peak: 0.18, decay: 0.04 });
  }
  shove() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this._noise(this.brown, this.sfx, t, 0.18, { lp: 600, hp: 40, peak: 0.6, decay: 0.14 });
  }

  // ═══ impactos ═════════════════════════════════════════════════════════════
  fleshHit(x, z, big = false) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const dest = this._out(x, z, 0.8, 6, 30); if (!dest) return;
    this._noise(this.brown, dest, t, 0.12, { lp: 900, hp: 60, peak: big ? 0.9 : 0.55, decay: 0.09 });
    this._tone('sine', big ? 90 : 140, dest, t, 0.07, 0.3, 50);
  }
  wallHit(x, z) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const dest = this._out(x, z, 0.5, 6, 26); if (!dest) return;
    this._noise(this.white, dest, t, 0.06, { lp: 4500, hp: 700, peak: 0.35, decay: 0.045 });
  }
  gore(x, z) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const dest = this._out(x, z, 0.9, 6, 30); if (!dest) return;
    this._noise(this.brown, dest, t, 0.25, { lp: 1200, hp: 80, peak: 0.8, decay: 0.2 });
    this._noise(this.white, dest, t + 0.02, 0.12, { lp: 2500, hp: 400, peak: 0.25, decay: 0.1 });
  }
  thud(x, z, k = 1) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const dest = this._out(x, z, 0.5 * k, 5, 24); if (!dest) return;
    this._noise(this.brown, dest, t, 0.14, { lp: 400, hp: 30, peak: 0.5, decay: 0.11 });
  }

  // ═══ zombis ═══════════════════════════════════════════════════════════════
  groan(x, z, pitch = 1, kind = 'walker') {
    if (!this.ready || this.moans >= 5) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const dest = this._out(x, z, 0.55, 5, 26); if (!dest) return;
    this.moans++;
    const dur = kind === 'runner' ? 0.5 + Math.random() * 0.3 : 0.9 + Math.random() * 0.9;
    const base = (kind === 'brute' ? 62 : kind === 'runner' ? 150 : 95) * pitch * (0.9 + Math.random() * 0.25);
    const o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = base;
    const o2 = ctx.createOscillator(); o2.type = 'triangle'; o2.frequency.value = base * 1.005;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 4.5 + Math.random() * 3;
    const lfoG = ctx.createGain(); lfoG.gain.value = base * 0.06;
    lfo.connect(lfoG); lfoG.connect(o1.frequency); lfoG.connect(o2.frequency);
    // barrido de tono: sube y cae
    o1.frequency.setValueAtTime(base * 0.85, t);
    o1.frequency.linearRampToValueAtTime(base * 1.1, t + dur * 0.35);
    o1.frequency.linearRampToValueAtTime(base * 0.8, t + dur);
    const f1 = ctx.createBiquadFilter(); f1.type = 'bandpass'; f1.frequency.value = 520 + Math.random() * 200; f1.Q.value = 3;
    const f2 = ctx.createBiquadFilter(); f2.type = 'bandpass'; f2.frequency.value = 1100 + Math.random() * 400; f2.Q.value = 4;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1800;
    const G = ctx.createGain();
    G.gain.setValueAtTime(0, t);
    G.gain.linearRampToValueAtTime(0.5, t + dur * 0.25);
    G.gain.linearRampToValueAtTime(0.35, t + dur * 0.7);
    G.gain.exponentialRampToValueAtTime(0.001, t + dur);
    const mix = ctx.createGain(); mix.gain.value = 0.8;
    o1.connect(mix); o2.connect(mix);
    mix.connect(f1); mix.connect(f2); f1.connect(lp); f2.connect(lp); mix.connect(lp);
    lp.connect(G); G.connect(dest);
    // aire
    this._noise(this.white, dest, t, dur, { lp: 900, hp: 200, peak: 0.08, decay: dur, attack: dur * 0.3 });
    o1.start(t); o2.start(t); lfo.start(t);
    o1.stop(t + dur + 0.05); o2.stop(t + dur + 0.05); lfo.stop(t + dur + 0.05);
    o1.onended = () => { this.moans = Math.max(0, this.moans - 1); };
  }
  bite(x, z) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const dest = this._out(x, z, 0.8, 5, 20); if (!dest) return;
    this._tone('sawtooth', 220, dest, t, 0.25, 0.25, 90);
    this._noise(this.brown, dest, t + 0.05, 0.2, { lp: 1500, hp: 80, peak: 0.7, decay: 0.16 });
  }
  hurt() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this._noise(this.brown, this.sfx, t, 0.3, { lp: 500, hp: 30, peak: 0.9, decay: 0.25 });
    this._tone('sine', 70, this.sfx, t, 0.35, 0.5, 35);
  }
  death() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this._tone('sine', 110, this.sfx, t, 2.2, 0.5, 28);
    this._noise(this.brown, this.sfx, t, 1.5, { lp: 300, hp: 20, peak: 0.6, decay: 1.4 });
  }
  pickup(kind = 'ammo') {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    if (kind === 'health') { this._tone('sine', 520, this.sfx, t, 0.15, 0.2); this._tone('sine', 780, this.sfx, t + 0.12, 0.25, 0.2); }
    else if (kind === 'weapon') { this._tone('square', 330, this.sfx, t, 0.08, 0.12); this._tone('square', 495, this.sfx, t + 0.09, 0.08, 0.12); this._tone('square', 660, this.sfx, t + 0.18, 0.18, 0.12); }
    else { this._noise(this.white, this.sfx, t, 0.05, { lp: 3000, hp: 800, peak: 0.3, decay: 0.04 }); this._tone('sine', 440, this.sfx, t + 0.03, 0.12, 0.15); }
  }
  waveSting(n) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const dest = this.sfx;
    this._noise(this.brown, dest, t, 2.5, { lp: 200, hp: 20, peak: 0.5, decay: 2.2, attack: 0.6 });
    const f = 55 * Math.pow(2, (n % 4) / 12);
    this._tone('sawtooth', f, dest, t, 2.4, 0.12, f * 0.98, 0.5);
    this._tone('sawtooth', f * 1.5, dest, t + 0.3, 2.0, 0.08, f * 1.48, 0.5);
  }
  /** Objetivo cumplido: dos notas cortas que suben. */
  objectiveSting() {
    if (!this.ready) return;
    const t = this.ctx.currentTime, dest = this.sfx;
    this._tone('triangle', 440, dest, t, 0.18, 0.18);
    this._tone('triangle', 660, dest, t + 0.16, 0.35, 0.18);
  }
  /** Misión cumplida: un acorde que se abre despacio, sobre el colchón. */
  winSting() {
    if (!this.ready) return;
    const t = this.ctx.currentTime, dest = this.sfx;
    for (const [f, d, k] of [[220, 0, 0.14], [277.2, 0.12, 0.12], [329.6, 0.24, 0.12], [440, 0.4, 0.1]]) this._tone('triangle', f, dest, t + d, 2.6, k, null, 0.08);
    this._noise(this.white, dest, t, 2.0, { lp: 1200, hp: 300, peak: 0.05, decay: 1.8, attack: 0.5 });
  }

  // ═══ ambiente ═════════════════════════════════════════════════════════════
  _ambient() {
    const ctx = this.ctx;
    // ruido marrón muy bajo
    const n = ctx.createBufferSource(); n.buffer = this.brown; n.loop = true;
    const nlp = ctx.createBiquadFilter(); nlp.type = 'lowpass'; nlp.frequency.value = 220;
    const ng = ctx.createGain(); ng.gain.value = 0.05;
    n.connect(nlp); nlp.connect(ng); ng.connect(this.music); n.start();
    // zumbido eléctrico
    const hum = ctx.createOscillator(); hum.type = 'sawtooth'; hum.frequency.value = 50;
    const hlp = ctx.createBiquadFilter(); hlp.type = 'lowpass'; hlp.frequency.value = 160;
    const hg = ctx.createGain(); hg.gain.value = 0.012;
    hum.connect(hlp); hlp.connect(hg); hg.connect(this.music); hum.start();
    // colchón: dos sierras desafinadas
    this.padA = ctx.createOscillator(); this.padA.type = 'sawtooth';
    this.padB = ctx.createOscillator(); this.padB.type = 'sawtooth';
    this.padC = ctx.createOscillator(); this.padC.type = 'sawtooth';
    this.padA.detune.value = -7; this.padB.detune.value = 6; this.padC.detune.value = 3;
    this.padLP = ctx.createBiquadFilter(); this.padLP.type = 'lowpass'; this.padLP.frequency.value = 240; this.padLP.Q.value = 1.2;
    this.padG = ctx.createGain(); this.padG.gain.value = 0.0;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lfoG = ctx.createGain(); lfoG.gain.value = 60;
    lfo.connect(lfoG); lfoG.connect(this.padLP.frequency); lfo.start();
    this.padA.connect(this.padLP); this.padB.connect(this.padLP); this.padC.connect(this.padLP);
    this.padLP.connect(this.padG); this.padG.connect(this.music);
    this._padChord(0);
    this.padA.start(); this.padB.start(); this.padC.start();
    this._padTimer = setInterval(() => this._padChord((this._padIdx + 1) % this._padNotes.length), 14000);
  }
  _padChord(i) {
    this._padIdx = i;
    const [a, b] = this._padNotes[i];
    const t = this.ctx.currentTime;
    this.padA.frequency.setTargetAtTime(a, t, 1.5);
    this.padB.frequency.setTargetAtTime(b, t, 1.5);
    this.padC.frequency.setTargetAtTime(a * 2, t, 1.5);
  }
  /** 0 = calma, 1 = horda encima. Abre el colchón y sube el filtro. */
  setIntensity(v) {
    if (!this.ready) return;
    v = Math.max(0, Math.min(1, v));
    if (Math.abs(v - this.intensity) < 0.01) return;
    this.intensity = v;
    const t = this.ctx.currentTime;
    this.padG.gain.setTargetAtTime(0.012 + v * 0.05, t, 1.2);
    this.padLP.frequency.setTargetAtTime(200 + v * 500, t, 1.5);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  Perfiles de disparo. Cada capa:
//    {n:'w'|'b', dur, lp, hp, peak, decay, at}     ruido blanco/marrón filtrado
//    {wave, f0, f1, dur, peak, at}                 tono con barrido
//    {fm, f0, f1, depth, dur, peak, wave}          FM (portadora + moduladora)
//    {crackle: n, dur, peak}                       chasquidos al azar
//  Las cuatro clásicas son EXACTAMENTE las de antes.
// ═════════════════════════════════════════════════════════════════════════════
const N = (n, dur, lp, hp, peak, decay, extra = {}) => ({ n, dur, lp, hp, peak, decay, ...extra });
const T = (wave, f0, f1, dur, peak, extra = {}) => ({ wave, f0, f1, dur, peak, ...extra });

export const SHOT_SOUNDS = {
  pistol: [N('w', 0.16, 3200, 120, 0.55, 0.12), T('sine', 150, 45, 0.09, 0.5), N('w', 0.03, 9000, 2000, 0.35, 0.02)],
  heavypistol: [N('w', 0.2, 2600, 100, 0.65, 0.15), T('sine', 120, 38, 0.12, 0.6), N('w', 0.03, 9000, 2000, 0.38, 0.02)],
  magnum: [N('w', 0.32, 2200, 80, 0.85, 0.26), T('sine', 105, 34, 0.18, 0.75), N('w', 0.04, 10000, 2500, 0.45, 0.03), N('b', 0.5, 600, 30, 0.25, 0.45, { at: 0.05 })],
  magnum_heavy: [N('w', 0.42, 1800, 60, 0.95, 0.34), T('sine', 80, 26, 0.26, 0.9), N('w', 0.05, 10000, 2200, 0.5, 0.035), N('b', 0.7, 500, 25, 0.35, 0.6, { at: 0.05 })],
  smg_light: [N('w', 0.08, 4200, 260, 0.36, 0.055), T('sine', 150, 60, 0.05, 0.28)],
  smg: [N('w', 0.1, 3800, 200, 0.42, 0.07), T('sine', 130, 50, 0.06, 0.35)],
  smg_heavy: [N('w', 0.13, 3000, 150, 0.5, 0.09), T('sine', 110, 42, 0.08, 0.45), N('w', 0.02, 8000, 2200, 0.2, 0.015)],
  shotgun: [N('w', 0.42, 1600, 60, 0.9, 0.3), T('sine', 95, 32, 0.22, 0.8), N('w', 0.05, 7000, 1500, 0.4, 0.035)],
  shotgun_auto: [N('w', 0.3, 1900, 70, 0.8, 0.22), T('sine', 100, 34, 0.16, 0.7), N('w', 0.04, 7000, 1500, 0.35, 0.03)],
  shotgun_slug: [N('w', 0.4, 1500, 55, 0.9, 0.3), T('sine', 85, 28, 0.24, 0.85), N('w', 0.06, 9000, 2400, 0.45, 0.04)],
  rifle: [N('w', 0.2, 2600, 90, 0.7, 0.15), T('sine', 120, 40, 0.11, 0.6), N('w', 0.03, 10000, 2500, 0.45, 0.02)],
  battle: [N('w', 0.28, 2300, 80, 0.8, 0.22), T('sine', 105, 34, 0.14, 0.7), N('w', 0.035, 10000, 2600, 0.5, 0.025), N('b', 0.4, 700, 30, 0.2, 0.35, { at: 0.04 })],
  sniper: [N('w', 0.5, 2000, 70, 0.95, 0.4), T('sine', 90, 28, 0.2, 0.85), N('w', 0.05, 12000, 3200, 0.6, 0.04), N('b', 1.2, 500, 25, 0.3, 1.0, { at: 0.06 })],
  amr: [N('w', 0.7, 1500, 50, 1.0, 0.55), T('sine', 65, 22, 0.32, 1.0), N('w', 0.06, 12000, 3000, 0.65, 0.045), N('b', 1.6, 400, 20, 0.45, 1.4, { at: 0.06 })],
  lmg: [N('w', 0.2, 2500, 90, 0.66, 0.14), T('sine', 115, 40, 0.1, 0.55), N('w', 0.025, 9000, 2400, 0.38, 0.02)],
  lmg_old: [N('w', 0.24, 2100, 80, 0.7, 0.17), T('sine', 100, 36, 0.12, 0.6), N('w', 0.03, 7000, 1800, 0.3, 0.02)],
  minigun: [N('w', 0.07, 3400, 180, 0.34, 0.05), T('sine', 120, 55, 0.045, 0.28)],
  gl: [T('sine', 190, 70, 0.12, 0.7), N('b', 0.25, 1200, 60, 0.6, 0.2), N('w', 0.04, 5000, 900, 0.25, 0.03)],
  rocket: [N('w', 0.9, 2400, 120, 0.8, 0.8, { atk: 0.02 }), T('sawtooth', 90, 45, 0.5, 0.25), N('b', 1.1, 800, 30, 0.5, 1.0)],
  rocket_swarm: [N('w', 0.5, 3200, 200, 0.6, 0.45, { atk: 0.01 }), T('sawtooth', 160, 70, 0.3, 0.18), N('w', 0.4, 4200, 300, 0.4, 0.35, { at: 0.08 })],
  laser: [T('sawtooth', 1800, 320, 0.16, 0.18), T('sine', 900, 180, 0.2, 0.24), N('w', 0.05, 9000, 3000, 0.12, 0.04)],
  laser_small: [T('square', 2200, 500, 0.1, 0.12), T('sine', 1300, 320, 0.13, 0.2)],
  pulse: [T('square', 700, 180, 0.08, 0.14), { fm: 90, f0: 400, f1: 150, depth: 120, dur: 0.09, peak: 0.2 }],
  plasma: [{ fm: 55, f0: 260, f1: 90, depth: 180, dur: 0.3, peak: 0.34, wave: 'triangle' }, N('b', 0.3, 900, 60, 0.4, 0.25), T('sine', 1400, 300, 0.12, 0.1)],
  plasma_scatter: [{ fm: 70, f0: 300, f1: 110, depth: 200, dur: 0.26, peak: 0.34, wave: 'triangle' }, N('w', 0.25, 2200, 200, 0.4, 0.2)],
  rail: [T('sine', 2400, 120, 0.5, 0.35), N('w', 0.08, 12000, 3500, 0.7, 0.06), T('sawtooth', 70, 30, 0.45, 0.5), N('b', 1.0, 600, 30, 0.3, 0.9, { at: 0.04 })],
  tesla: [{ crackle: 14, dur: 0.22, peak: 0.4 }, T('sawtooth', 110, 55, 0.22, 0.22), N('w', 0.2, 6000, 1800, 0.25, 0.18)],
  beam: [T('sawtooth', 420, 400, 0.09, 0.08), N('w', 0.09, 5000, 1800, 0.06, 0.08)],
  ion: [{ fm: 30, f0: 180, f1: 60, depth: 140, dur: 0.8, peak: 0.45, wave: 'sine' }, N('b', 0.9, 700, 30, 0.6, 0.8), T('sine', 3000, 400, 0.4, 0.12)],
  flame: [N('w', 0.12, 1400, 150, 0.22, 0.1, { atk: 0.02 }), N('b', 0.14, 500, 40, 0.2, 0.12)],
  cryo: [N('w', 0.12, 6000, 1800, 0.16, 0.1, { atk: 0.02 }), N('w', 0.1, 2400, 600, 0.1, 0.09)],
  acid: [T('sine', 300, 120, 0.2, 0.3), N('b', 0.3, 900, 80, 0.4, 0.25), N('w', 0.15, 3000, 800, 0.12, 0.12, { at: 0.05 })],
  bow: [T('triangle', 170, 90, 0.18, 0.4), N('w', 0.05, 4000, 800, 0.25, 0.04), N('w', 0.2, 2500, 700, 0.1, 0.18, { at: 0.02 })],
  flare: [T('sine', 210, 80, 0.1, 0.55), N('w', 1.2, 5200, 1400, 0.16, 1.1, { at: 0.04, atk: 0.1 })],
  harpoon: [T('triangle', 120, 60, 0.25, 0.5), N('b', 0.3, 900, 60, 0.5, 0.25), N('w', 0.3, 3000, 700, 0.15, 0.28, { at: 0.03 })],
  nail: [N('w', 0.05, 7000, 1600, 0.4, 0.035), T('square', 600, 200, 0.04, 0.1)],
  saw: [N('w', 0.2, 5500, 900, 0.4, 0.18), T('sawtooth', 900, 1600, 0.3, 0.1), N('b', 0.2, 900, 60, 0.35, 0.15)],
  sonic: [T('sine', 55, 30, 0.5, 0.9), T('sine', 110, 60, 0.35, 0.4), N('b', 0.5, 400, 20, 0.6, 0.45)],
  vortex: [{ fm: 8, f0: 90, f1: 300, depth: 60, dur: 0.6, peak: 0.35, wave: 'sine' }, N('w', 0.6, 1200, 200, 0.2, 0.5, { atk: 0.2 })],
};

/** Zumbidos continuos por arma: el giro de la rotativa y la carga del riel. */
export const HUMS = {
  spin: { f0: 70, f1: 260, peak: 0.07, wave: 'sawtooth', lp: 900 },
  charge: { f0: 220, f1: 1800, peak: 0.08, wave: 'sine', lp: 4000 },
  flame: { noise: true, f0: 500, f1: 900, peak: 0.12, q: 0.6 },
  cryo: { noise: true, f0: 3200, f1: 4200, peak: 0.08, q: 0.9 },
};
