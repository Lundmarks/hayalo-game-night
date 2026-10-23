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

    const isUi = ['click', 'select', 'yourTurn', 'turn', 'tick', 'win', 'lose', 'place'].includes(name);
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
  return d + 0.1;
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
    a.tone(out, t, { type: 'triangle', from: 260 * p, to: 560, peak: 0.25, decay: 0.16 });
    return 0.2;
  },
  land: (a, out, t) => {
    a.burst(out, t, { type: 'lowpass', from: 500, peak: 0.35, decay: 0.12 });
    a.tone(out, t, { from: 100, to: 50, peak: 0.3, decay: 0.1 });
    return 0.2;
  },
  hurt: (a, out, t, p) => {
    // A rough "oof": buzzy tone through a vowel-like band filter.
    const o = a.c.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(270 * p, t);
    o.frequency.exponentialRampToValueAtTime(160 * p, t + 0.2);
    const f = a.filter('bandpass', 850, 3);
    const g = a.env(t, 0.01, 0.4, 0.2);
    o.connect(f).connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.25);
    return 0.3;
  },
  die: (a, out, t) => {
    a.tone(out, t, { type: 'triangle', from: 520, to: 120, peak: 0.25, decay: 0.8 });
    a.burst(out, t + 0.6, { type: 'lowpass', from: 900, peak: 0.3, decay: 0.3 });
    return 1;
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
  step: (a, out, t) => {
    a.burst(out, t, { type: 'lowpass', from: 700, peak: 0.08, decay: 0.04 });
    return 0.06;
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
  win: notes([523.3, 659.3, 784, 1046.5, 784, 1046.5], 0.11, 'triangle', 0.25, 0.4),
  lose: notes([392, 349.2, 311.1, 261.6], 0.18, 'triangle', 0.2, 0.4),
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
