// Sound engine. Every sound is generated in code with the Web Audio API, so
// there are no files to download through Discord's proxy.
//
//   sources -> per-sound panner -> sfx/ui bus -> master gain -> limiter -> speakers
//                       wind ambience bus ----^
//
// Browsers (and Discord) only allow audio after the user clicks or presses a
// key, so call unlock() from the first input event.

export type Sound =
  | 'explosion' | 'bigExplosion' | 'smallExplosion' | 'launch' | 'throw' | 'bounce' | 'splash' | 'shotgun'
  | 'plane' | 'whistle' | 'teleport' | 'jump' | 'land' | 'hurt' | 'die' | 'holy' | 'fuse' | 'step'
  | 'boing' | 'bonk' | 'pop' | 'slide' | 'bubbles' | 'ricochet' | 'chirp' | 'whoosh' | 'hup' | 'sadTrombone'
  | 'pickup' | 'heal' | 'crateLand' | 'parachute' | 'flood' | 'alarm' | 'retreat' | 'slowmo'
  | 'click' | 'select' | 'yourTurn' | 'turn' | 'tick' | 'win' | 'lose' | 'place';

type Opts = { pan?: number; gain?: number; pitch?: number };

const PREFS_KEY = 'hgn-audio';

class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private ui!: GainNode;
  private windGain: GainNode | null = null;
  private noise!: AudioBuffer;
  private voices = 0;
  private listeners = new Set<() => void>();
  volume = 0.7;
  muted = false;

  constructor() {
    try {
      const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
      if (typeof p.volume === 'number') this.volume = p.volume;
      if (typeof p.muted === 'boolean') this.muted = p.muted;
    } catch {}
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) this.ctx.suspend();
      else this.ctx.resume();
    });
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as any).webkitAudioContext;
      if (!Ctx) return;
      const ctx: AudioContext = new Ctx();
      this.ctx = ctx;

      // A limiter on the master stops stacked explosions from clipping.
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -10;
      limiter.knee.value = 6;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.25;
      limiter.connect(ctx.destination);

      this.master = ctx.createGain();
      this.master.connect(limiter);
      this.sfx = ctx.createGain();
      this.sfx.connect(this.master);
      this.ui = ctx.createGain();
      this.ui.gain.value = 0.8;
      this.ui.connect(this.master);
      this.applyVolume();

      this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.volume > 0) this.muted = false;
    this.applyVolume();
  }

  toggleMute() {
    this.muted = !this.muted;
    this.applyVolume();
  }

  private applyVolume() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ volume: this.volume, muted: this.muted }));
    } catch {}
    if (this.ctx) {
      // Squared curve feels more even than a linear slider.
      const v = this.muted ? 0 : this.volume * this.volume;
      this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
    }
    this.listeners.forEach((fn) => fn());
  }

  /** Steady wind noise, louder when the wind is strong. Pass null to stop. */
  setWind(strength: number | null) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!this.windGain) {
      const src = this.noiseSource();
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 450;
      filter.Q.value = 0.7;
      // Slow wobble on the filter makes it sound like gusts.
      const lfo = ctx.createOscillator();
      const lfoDepth = ctx.createGain();
      lfo.frequency.value = 0.13;
      lfoDepth.gain.value = 220;
      lfo.connect(lfoDepth).connect(filter.frequency);
      lfo.start();
      this.windGain = ctx.createGain();
      this.windGain.gain.value = 0;
      src.connect(filter).connect(this.windGain).connect(this.master);
      src.start();
    }
    const target = strength === null ? 0 : 0.015 + Math.abs(strength) * 0.06;
    this.windGain.gain.setTargetAtTime(target, ctx.currentTime, 0.8);
  }

  play(name: Sound, o: Opts = {}) {
    const ctx = this.ctx;
    if (!ctx || this.muted || ctx.state !== 'running') return;
    if (this.voices > 28) return;

    const isUi = ['click', 'select', 'yourTurn', 'turn', 'tick', 'win', 'lose', 'place', 'sadTrombone', 'alarm', 'retreat'].includes(name);
    const out = ctx.createGain();
    out.gain.value = o.gain ?? 1;
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, o.pan ?? 0));
    out.connect(panner).connect(isUi ? this.ui : this.sfx);

    // Small random pitch change so repeated sounds don't feel robotic.
    const pitch = (o.pitch ?? 1) * (isUi ? 1 : 0.94 + Math.random() * 0.12);
    const dur = RECIPES[name](this, out, ctx.currentTime, pitch);
    this.voices++;
    setTimeout(() => {
      this.voices--;
      out.disconnect();
    }, dur * 1000 + 100);
  }

  // ---- building blocks for recipes ----
  get c() {
    return this.ctx!;
  }

  noiseSource() {
    const s = this.c.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    return s;
  }

  /** Gain node with a quick attack and exponential decay. */
  env(t: number, attack: number, peak: number, decay: number) {
    const g = this.c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    return g;
  }

  filter(type: BiquadFilterType, freq: number, q = 1) {
    const f = this.c.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  /** Noise burst through a filter. */
  burst(out: AudioNode, t: number, o: { type: BiquadFilterType; from: number; to?: number; q?: number; attack?: number; peak: number; decay: number }) {
    const src = this.noiseSource();
    const f = this.filter(o.type, o.from, o.q ?? 1);
    if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, t + (o.attack ?? 0.005) + o.decay);
    const g = this.env(t, o.attack ?? 0.005, o.peak, o.decay);
    src.connect(f).connect(g).connect(out);
    src.start(t, Math.random() * 1.5);
    src.stop(t + (o.attack ?? 0.005) + o.decay + 0.05);
  }

  /**
   * A tiny cartoon voice: a buzzy tone through two vowel filters that glide
   * from one vowel to another. Formants are [F1, F2] pairs in Hz.
   */
  voice(out: AudioNode, t: number, o: { pitch: number[]; from: [number, number]; to: [number, number]; dur: number; peak: number }) {
    const osc = this.c.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(o.pitch[0], t);
    o.pitch.slice(1).forEach((f, i) => osc.frequency.linearRampToValueAtTime(f, t + (o.dur * (i + 1)) / (o.pitch.length - 1)));
    const g = this.env(t, 0.015, o.peak, o.dur);
    for (const k of [0, 1]) {
      const f = this.filter('bandpass', o.from[k], k ? 9 : 6);
      f.frequency.linearRampToValueAtTime(o.to[k], t + o.dur);
      const lvl = this.c.createGain();
      lvl.gain.value = k ? 0.6 : 1;
      osc.connect(f).connect(lvl).connect(g);
    }
    g.connect(out);
    osc.start(t);
    osc.stop(t + o.dur + 0.1);
  }

  /** Oscillator with a pitch sweep. */
  tone(out: AudioNode, t: number, o: { type?: OscillatorType; from: number; to?: number; attack?: number; peak: number; decay: number; sweep?: number }) {
    const osc = this.c.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.from, t);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + (o.sweep ?? o.decay));
    const g = this.env(t, o.attack ?? 0.005, o.peak, o.decay);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + (o.attack ?? 0.005) + o.decay + 0.05);
  }
}

type Recipe = (a: AudioEngine, out: AudioNode, t: number, p: number) => number;

const explosion = (size: number): Recipe => (a, out, t, p) => {
  const d = 0.45 + 0.55 * size;
  a.burst(out, t, { type: 'lowpass', from: (900 + 1600 * size) * p, to: 70, q: 0.8, peak: 0.9, decay: d });
  a.burst(out, t, { type: 'highpass', from: 2500, peak: 0.35 * size, decay: 0.07 });
  a.tone(out, t, { from: 95 * p, to: 30, peak: 0.9, decay: 0.3 + 0.3 * size });
  // Cartoon "ka-" thump before the boom, and dirt crackling down afterwards.
  a.tone(out, t, { type: 'square', from: 180 * p, to: 60, peak: 0.25, decay: 0.08 });
  const bits = Math.round(4 + size * 6);
  for (let i = 0; i < bits; i++) {
    a.burst(out, t + 0.15 + Math.random() * d, { type: 'bandpass', from: 1500 + Math.random() * 2500, q: 4, peak: 0.12, decay: 0.025 });
  }
  return d + 0.2;
};

const notes = (freqs: number[], gap: number, type: OscillatorType, peak: number, decay: number): Recipe => (a, out, t) => {
  freqs.forEach((f, i) => a.tone(out, t + i * gap, { type, from: f, peak, decay }));
  return freqs.length * gap + decay;
};

const RECIPES: Record<Sound, Recipe> = {
  explosion: explosion(1),
  bigExplosion: explosion(2),
  smallExplosion: explosion(0.45),

  launch: (a, out, t, p) => {
    a.burst(out, t, { type: 'bandpass', from: 500 * p, to: 2200, q: 1.2, attack: 0.02, peak: 0.4, decay: 0.45 });
    a.tone(out, t, { from: 150 * p, to: 55, peak: 0.6, decay: 0.15 });
    return 0.5;
  },
  throw: (a, out, t, p) => {
    a.burst(out, t, { type: 'bandpass', from: 1600 * p, to: 500, q: 1.5, attack: 0.03, peak: 0.25, decay: 0.22 });
    return 0.3;
  },
  bounce: (a, out, t, p) => {
    a.tone(out, t, { type: 'triangle', from: 420 * p, to: 170, peak: 0.35, decay: 0.09 });
    a.burst(out, t, { type: 'highpass', from: 3000, peak: 0.12, decay: 0.02 });
    return 0.15;
  },
  splash: (a, out, t, p) => {
    a.burst(out, t, { type: 'bandpass', from: 1300 * p, to: 500, q: 0.7, attack: 0.01, peak: 0.6, decay: 0.7 });
    for (let i = 0; i < 5; i++) {
      const f = 400 + Math.random() * 600;
      a.tone(out, t + 0.05 + Math.random() * 0.35, { from: f, to: f * 2.2, peak: 0.12, decay: 0.06 });
    }
    return 0.8;
  },
  shotgun: (a, out, t, p) => {
    a.burst(out, t, { type: 'highpass', from: 500 * p, attack: 0.001, peak: 1, decay: 0.2 });
    a.tone(out, t, { from: 130, to: 45, peak: 0.8, decay: 0.14 });
    a.burst(out, t + 0.38, { type: 'bandpass', from: 2400, q: 3, peak: 0.25, decay: 0.03 });
    a.burst(out, t + 0.52, { type: 'bandpass', from: 1900, q: 3, peak: 0.25, decay: 0.04 });
    return 0.6;
  },
  plane: (a, out, t) => {
    const dur = 2.4;
    const pan = a.c.createStereoPanner();
    pan.pan.setValueAtTime(-1, t);
    pan.pan.linearRampToValueAtTime(1, t + dur);
    const f = a.filter('lowpass', 650);
    const g = a.c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + dur * 0.45);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    for (const hz of [92, 95.5, 184]) {
      const o = a.c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = hz;
      o.connect(f);
      o.start(t);
      o.stop(t + dur);
    }
    f.connect(g).connect(pan).connect(out);
    return dur;
  },
  whistle: (a, out, t, p) => {
    a.tone(out, t, { from: 1700 * p, to: 520, attack: 0.1, peak: 0.1, decay: 0.75 });
    return 0.9;
  },
  teleport: notes([660, 880, 990, 1320, 1760, 1980], 0.045, 'sine', 0.14, 0.18),
  jump: (a, out, t, p) => {
    a.tone(out, t, { type: 'triangle', from: 220 * p, to: 700, peak: 0.25, decay: 0.18, sweep: 0.14 });
    a.voice(out, t, { pitch: [420 * p, 520 * p], from: [600, 1500], to: [750, 1300], dur: 0.1, peak: 0.2 });
    return 0.25;
  },
  land: (a, out, t) => {
    a.burst(out, t, { type: 'lowpass', from: 500, peak: 0.35, decay: 0.12 });
    a.tone(out, t, { from: 100, to: 50, peak: 0.3, decay: 0.1 });
    return 0.2;
  },
  hurt: (a, out, t, p) => {
    // A squeaky cartoon "ow!"
    a.voice(out, t, { pitch: [520 * p, 640 * p, 380 * p], from: [850, 1250], to: [380, 800], dur: 0.28, peak: 0.45 });
    return 0.35;
  },
  die: (a, out, t, p) => {
    // A deflating squeal and then a pop.
    a.voice(out, t, { pitch: [700 * p, 900 * p, 260 * p], from: [700, 1500], to: [400, 900], dur: 0.5, peak: 0.3 });
    a.tone(out, t + 0.55, { from: 260, to: 1300, peak: 0.35, decay: 0.07, sweep: 0.05 });
    a.burst(out, t + 0.55, { type: 'lowpass', from: 1400, peak: 0.4, decay: 0.25 });
    return 0.9;
  },
  holy: (a, out, t) => {
    // A short "hallelujah" chord before the big bang.
    const f = a.filter('lowpass', 2200);
    const g = a.c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
    for (const hz of [440, 554.4, 659.3, 880]) {
      for (const detune of [-8, 8]) {
        const o = a.c.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = hz;
        o.detune.value = detune;
        o.connect(f);
        o.start(t);
        o.stop(t + 1.4);
      }
    }
    f.connect(g).connect(out);
    return 1.4;
  },
  fuse: (a, out, t) => {
    a.tone(out, t, { type: 'square', from: 2200, peak: 0.05, decay: 0.03 });
    return 0.05;
  },
  step: (a, out, t, p) => {
    a.tone(out, t, { type: 'sine', from: 260 * p, to: 140, peak: 0.1, decay: 0.05 });
    a.burst(out, t, { type: 'lowpass', from: 600, peak: 0.05, decay: 0.03 });
    return 0.07;
  },
  boing: (a, out, t, p) => {
    // A spring: a rising tone with a fast wobble.
    const o = a.c.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(140 * p, t);
    o.frequency.exponentialRampToValueAtTime(420 * p, t + 0.35);
    const lfo = a.c.createOscillator();
    lfo.frequency.value = 26;
    const depth = a.c.createGain();
    depth.gain.setValueAtTime(70 * p, t);
    depth.gain.exponentialRampToValueAtTime(5, t + 0.4);
    lfo.connect(depth).connect(o.frequency);
    const g = a.env(t, 0.005, 0.3, 0.4);
    o.connect(g).connect(out);
    o.start(t);
    lfo.start(t);
    o.stop(t + 0.45);
    lfo.stop(t + 0.45);
    return 0.5;
  },
  bonk: (a, out, t, p) => {
    // Wood block on a head.
    a.tone(out, t, { type: 'sine', from: 720 * p, to: 520 * p, peak: 0.45, decay: 0.09 });
    a.tone(out, t, { type: 'triangle', from: 1450 * p, peak: 0.12, decay: 0.04 });
    a.burst(out, t, { type: 'bandpass', from: 1800, q: 5, peak: 0.25, decay: 0.03 });
    return 0.15;
  },
  pop: (a, out, t, p) => {
    a.tone(out, t, { from: 300 * p, to: 1400 * p, peak: 0.35, decay: 0.07, sweep: 0.05 });
    a.burst(out, t, { type: 'highpass', from: 2000, peak: 0.2, decay: 0.03 });
    return 0.1;
  },
  slide: (a, out, t, p) => {
    // Falling slide whistle with a little vibrato.
    const o = a.c.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(1500 * p, t);
    o.frequency.exponentialRampToValueAtTime(260 * p, t + 0.9);
    const lfo = a.c.createOscillator();
    lfo.frequency.value = 7;
    const depth = a.c.createGain();
    depth.gain.value = 25;
    lfo.connect(depth).connect(o.frequency);
    const g = a.env(t, 0.04, 0.16, 0.9);
    o.connect(g).connect(out);
    o.start(t);
    lfo.start(t);
    o.stop(t + 1);
    lfo.stop(t + 1);
    return 1;
  },
  bubbles: (a, out, t) => {
    for (let i = 0; i < 9; i++) {
      const f = 300 + Math.random() * 500;
      a.tone(out, t + i * 0.07 + Math.random() * 0.04, { from: f, to: f * 2.5, peak: 0.14, decay: 0.05, sweep: 0.04 });
    }
    return 0.8;
  },
  ricochet: (a, out, t, p) => {
    const o = a.c.createOscillator();
    o.frequency.setValueAtTime(3200 * p, t);
    o.frequency.exponentialRampToValueAtTime(900 * p, t + 0.35);
    const lfo = a.c.createOscillator();
    lfo.frequency.value = 40;
    const depth = a.c.createGain();
    depth.gain.value = 120;
    lfo.connect(depth).connect(o.frequency);
    const g = a.env(t, 0.003, 0.08, 0.35);
    o.connect(g).connect(out);
    o.start(t);
    lfo.start(t);
    o.stop(t + 0.4);
    lfo.stop(t + 0.4);
    return 0.45;
  },
  chirp: (a, out, t, p) => {
    const n = 2 + Math.floor(Math.random() * 3);
    const base = (2600 + Math.random() * 1200) * p;
    for (let i = 0; i < n; i++) a.tone(out, t + i * 0.11, { from: base, to: base * 1.5, peak: 0.05, decay: 0.06, sweep: 0.05 });
    return n * 0.11 + 0.1;
  },
  whoosh: (a, out, t, p) => {
    a.burst(out, t, { type: 'bandpass', from: 400 * p, to: 2600, q: 2, attack: 0.08, peak: 0.25, decay: 0.25 });
    return 0.4;
  },
  hup: (a, out, t, p) => {
    a.voice(out, t, { pitch: [380 * p, 470 * p], from: [500, 1400], to: [700, 1200], dur: 0.12, peak: 0.35 });
    return 0.2;
  },
  sadTrombone: (a, out, t) => {
    const f = a.filter('lowpass', 1300);
    f.connect(out);
    [293.7, 277.2, 261.6, 246.9].forEach((hz, i) => {
      const last = i === 3;
      const st = t + i * 0.32;
      const len = last ? 0.9 : 0.28;
      const o = a.c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = hz;
      if (last) {
        const lfo = a.c.createOscillator();
        lfo.frequency.value = 6;
        const d = a.c.createGain();
        d.gain.value = 7;
        lfo.connect(d).connect(o.frequency);
        lfo.start(st);
        lfo.stop(st + len);
        o.frequency.setValueAtTime(hz, st);
        o.frequency.linearRampToValueAtTime(hz * 0.94, st + len);
      }
      const g = a.env(st, 0.03, 0.2, len);
      o.connect(g).connect(f);
      o.start(st);
      o.stop(st + len + 0.05);
    });
    return 2;
  },

  slowmo: (a, out, t) => {
    // Time slows: a deep falling whoosh and two heartbeats.
    a.burst(out, t, { type: 'lowpass', from: 1800, to: 120, attack: 0.05, peak: 0.3, decay: 0.9 });
    a.tone(out, t, { from: 300, to: 60, peak: 0.2, decay: 0.8 });
    for (const d of [0.25, 0.47]) a.tone(out, t + d, { from: 70, to: 40, peak: 0.45, decay: 0.14 });
    return 1;
  },
  pickup: notes([784, 988, 1175, 1568], 0.06, 'square', 0.08, 0.16),
  heal: (a, out, t) => {
    notes([523.3, 659.3, 784, 1046.5], 0.07, 'sine', 0.2, 0.35)(a, out, t, 1);
    notes([1046.5, 1318.5], 0.07, 'triangle', 0.06, 0.4)(a, out, t + 0.28, 1);
    return 0.8;
  },
  crateLand: (a, out, t, p) => {
    a.tone(out, t, { type: 'triangle', from: 210 * p, to: 120, peak: 0.35, decay: 0.12 });
    a.burst(out, t, { type: 'bandpass', from: 900, q: 2, peak: 0.25, decay: 0.08 });
    return 0.2;
  },
  parachute: (a, out, t) => {
    // A cloth "fwump" as the canopy opens.
    a.burst(out, t, { type: 'lowpass', from: 700, to: 200, attack: 0.03, peak: 0.25, decay: 0.3 });
    a.tone(out, t + 0.05, { from: 880, to: 1320, peak: 0.06, decay: 0.2, sweep: 0.15 });
    return 0.4;
  },
  flood: (a, out, t) => {
    // Rushing water with a low rumble.
    a.burst(out, t, { type: 'lowpass', from: 500, to: 900, attack: 0.4, peak: 0.35, decay: 1.4 });
    a.burst(out, t, { type: 'bandpass', from: 2400, q: 0.8, attack: 0.3, peak: 0.08, decay: 1.2 });
    a.tone(out, t, { from: 55, to: 45, attack: 0.3, peak: 0.25, decay: 1.4 });
    return 1.8;
  },
  alarm: (a, out, t) => {
    for (let i = 0; i < 3; i++) {
      a.tone(out, t + i * 0.42, { type: 'sawtooth', from: 440, to: 660, attack: 0.02, peak: 0.07, decay: 0.36, sweep: 0.3 });
    }
    return 1.4;
  },
  retreat: (a, out, t) => {
    a.tone(out, t, { type: 'square', from: 660, peak: 0.06, decay: 0.06 });
    a.tone(out, t + 0.09, { type: 'square', from: 880, peak: 0.06, decay: 0.08 });
    return 0.2;
  },

  click: (a, out, t) => {
    a.tone(out, t, { from: 1000, peak: 0.12, decay: 0.04 });
    return 0.06;
  },
  select: (a, out, t) => {
    a.tone(out, t, { type: 'triangle', from: 660, to: 990, peak: 0.15, decay: 0.08 });
    return 0.1;
  },
  yourTurn: notes([523.3, 659.3, 784], 0.09, 'triangle', 0.25, 0.3),
  turn: notes([440], 0, 'sine', 0.1, 0.15),
  tick: (a, out, t, p) => {
    a.tone(out, t, { from: 1400 * p, peak: 0.18, decay: 0.035 });
    return 0.05;
  },
  win: (a, out, t) => {
    // Ta-da fanfare with a drum hit.
    notes([523.3, 523.3, 523.3, 659.3, 784, 1046.5], 0.1, 'square', 0.09, 0.3)(a, out, t, 1);
    notes([261.6, 329.6, 392], 0, 'triangle', 0.15, 1.1)(a, out, t + 0.6, 1);
    notes([523.3, 659.3, 784, 1046.5], 0, 'sawtooth', 0.05, 1.1)(a, out, t + 0.6, 1);
    a.burst(out, t + 0.6, { type: 'highpass', from: 3000, peak: 0.25, decay: 0.6 });
    return 1.8;
  },
  lose: (a, out, t, p) => RECIPES.sadTrombone(a, out, t, p),
  place: (a, out, t, p) => {
    a.tone(out, t, { from: 640 * p, to: 320, peak: 0.25, decay: 0.08 });
    return 0.1;
  },
};

export const audio = new AudioEngine();

// Audio may only start after a user gesture.
for (const ev of ['pointerdown', 'keydown', 'touchend'] as const) {
  window.addEventListener(ev, () => audio.unlock(), { capture: true, passive: true });
}
