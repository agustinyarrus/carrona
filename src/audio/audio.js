// ─────────────────────────────────────────────────────────────────────────────
//  audio.js — Todo el sonido, sintetizado con Web Audio. Cero archivos.
//
//  Disparos: ráfaga de ruido filtrada + golpe grave + clic. Zombis: dos
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
    // buffers de ruido
    this.white = this._noiseBuffer(2, 'white');
    this.brown = this._noiseBuffer(4, 'brown');
    this._ambient();
    this.ready = true;
  }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; }
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
    G.connect(P); P.connect(this.master);
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
  shot(kind, x, z) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const own = x === undefined;
    const dest = own ? this.master : this._out(x, z, 1, 8, 40);
    if (!dest) return;
    switch (kind) {
      case 'pistol':
        this._noise(this.white, dest, t, 0.16, { lp: 3200, hp: 120, peak: 0.55, decay: 0.12 });
        this._tone('sine', 150, dest, t, 0.09, 0.5, 45);
        this._noise(this.white, dest, t, 0.03, { lp: 9000, hp: 2000, peak: 0.35, decay: 0.02 });
        break;
      case 'smg':
        this._noise(this.white, dest, t, 0.1, { lp: 3800, hp: 200, peak: 0.42, decay: 0.07 });
        this._tone('sine', 130, dest, t, 0.06, 0.35, 50);
        break;
      case 'shotgun':
        this._noise(this.white, dest, t, 0.42, { lp: 1600, hp: 60, peak: 0.9, decay: 0.3 });
        this._tone('sine', 95, dest, t, 0.22, 0.8, 32);
        this._noise(this.white, dest, t, 0.05, { lp: 7000, hp: 1500, peak: 0.4, decay: 0.035 });
        break;
      case 'rifle':
        this._noise(this.white, dest, t, 0.2, { lp: 2600, hp: 90, peak: 0.7, decay: 0.15 });
        this._tone('sine', 120, dest, t, 0.11, 0.6, 40);
        this._noise(this.white, dest, t, 0.03, { lp: 10000, hp: 2500, peak: 0.45, decay: 0.02 });
        break;
    }
  }
  empty() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this._noise(this.white, this.master, t, 0.03, { lp: 5000, hp: 1500, peak: 0.25, decay: 0.02 });
  }
  reload(kind) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const dur = kind === 'shotgun' ? 0.5 : 0.35;
    this._noise(this.white, this.master, t, 0.04, { lp: 4000, hp: 800, peak: 0.2, decay: 0.03 });
    this._noise(this.white, this.master, t + dur, 0.05, { lp: 5000, hp: 1200, peak: 0.28, decay: 0.035 });
    this._tone('square', 900, this.master, t + dur, 0.02, 0.05);
  }
  switchWeapon() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this._noise(this.white, this.master, t, 0.05, { lp: 3000, hp: 600, peak: 0.18, decay: 0.04 });
  }
  shove() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this._noise(this.brown, this.master, t, 0.18, { lp: 600, hp: 40, peak: 0.6, decay: 0.14 });
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
    this._noise(this.brown, this.master, t, 0.3, { lp: 500, hp: 30, peak: 0.9, decay: 0.25 });
    this._tone('sine', 70, this.master, t, 0.35, 0.5, 35);
  }
  death() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this._tone('sine', 110, this.master, t, 2.2, 0.5, 28);
    this._noise(this.brown, this.master, t, 1.5, { lp: 300, hp: 20, peak: 0.6, decay: 1.4 });
  }
  pickup(kind = 'ammo') {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    if (kind === 'health') { this._tone('sine', 520, this.master, t, 0.15, 0.2); this._tone('sine', 780, this.master, t + 0.12, 0.25, 0.2); }
    else if (kind === 'weapon') { this._tone('square', 330, this.master, t, 0.08, 0.12); this._tone('square', 495, this.master, t + 0.09, 0.08, 0.12); this._tone('square', 660, this.master, t + 0.18, 0.18, 0.12); }
    else { this._noise(this.white, this.master, t, 0.05, { lp: 3000, hp: 800, peak: 0.3, decay: 0.04 }); this._tone('sine', 440, this.master, t + 0.03, 0.12, 0.15); }
  }
  waveSting(n) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const dest = this.master;
    this._noise(this.brown, dest, t, 2.5, { lp: 200, hp: 20, peak: 0.5, decay: 2.2, attack: 0.6 });
    const f = 55 * Math.pow(2, (n % 4) / 12);
    this._tone('sawtooth', f, dest, t, 2.4, 0.12, f * 0.98, 0.5);
    this._tone('sawtooth', f * 1.5, dest, t + 0.3, 2.0, 0.08, f * 1.48, 0.5);
  }

  // ═══ ambiente ═════════════════════════════════════════════════════════════
  _ambient() {
    const ctx = this.ctx;
    // ruido marrón muy bajo
    const n = ctx.createBufferSource(); n.buffer = this.brown; n.loop = true;
    const nlp = ctx.createBiquadFilter(); nlp.type = 'lowpass'; nlp.frequency.value = 220;
    const ng = ctx.createGain(); ng.gain.value = 0.05;
    n.connect(nlp); nlp.connect(ng); ng.connect(this.master); n.start();
    // zumbido eléctrico
    const hum = ctx.createOscillator(); hum.type = 'sawtooth'; hum.frequency.value = 50;
    const hlp = ctx.createBiquadFilter(); hlp.type = 'lowpass'; hlp.frequency.value = 160;
    const hg = ctx.createGain(); hg.gain.value = 0.012;
    hum.connect(hlp); hlp.connect(hg); hg.connect(this.master); hum.start();
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
    this.padLP.connect(this.padG); this.padG.connect(this.master);
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
