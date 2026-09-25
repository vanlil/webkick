// Procedural sound effects (Web Audio API). No samples: every sound is built from
// oscillators, noise and filters. Each function schedules one sound at time t into `out`.
// They take the AudioContext as a parameter, so they also work with an OfflineAudioContext.

const SILENT = 0.0001;

// --- Noise buffers --------------------------------------------------------------------------

export function whiteNoise(ctx, seconds) {
  const buf = ctx.createBuffer(1, Math.round(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

// Pink noise (Paul Kellet's filter): softer, more natural than white noise; used for crowds.
export function pinkNoise(ctx, seconds) {
  const buf = ctx.createBuffer(1, Math.round(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < d.length; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return buf;
}

// Applause: many short, randomly timed claps, rendered once into a buffer.
export function applauseBuffer(ctx, seconds) {
  const sr = ctx.sampleRate;
  const buf = ctx.createBuffer(2, Math.round(sr * seconds), sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const claps = Math.round(seconds * 140);
    for (let c = 0; c < claps; c++) {
      const start = Math.floor(Math.random() * (d.length - sr * 0.02));
      const len = Math.floor(sr * (0.006 + Math.random() * 0.01));
      const vol = 0.15 + Math.random() * 0.35;
      let lp = 0;
      for (let i = 0; i < len; i++) {
        // Filtered noise burst with a fast decay: a hand clap.
        lp += ((Math.random() * 2 - 1) - lp) * 0.6;
        d[start + i] += lp * vol * Math.exp(-i / (len * 0.3));
      }
    }
  }
  return buf;
}

// --- Helpers --------------------------------------------------------------------------------

function envelope(ctx, t, attack, peak, decay) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(SILENT, t);
  g.gain.linearRampToValueAtTime(Math.max(SILENT, peak), t + attack);
  g.gain.exponentialRampToValueAtTime(SILENT, t + attack + decay);
  return g;
}

// A short burst of band-pass filtered noise.
function noiseBurst(ctx, out, t, noise, { freq, q = 1, dur, vol, type = 'bandpass' }) {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.playbackRate.value = 0.8 + Math.random() * 0.4;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = envelope(ctx, t, 0.002, vol, dur);
  src.connect(f).connect(g).connect(out);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.05);
}

// A sine "thump" whose pitch drops quickly.
function thump(ctx, out, t, from, to, dur, vol) {
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(from, t);
  o.frequency.exponentialRampToValueAtTime(to, t + dur * 0.8);
  const g = envelope(ctx, t, 0.004, vol, dur);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + dur + 0.05);
}

// --- Ball and player sounds -----------------------------------------------------------------

// Kick: a dull thud plus the slap of the leather. strength 0..1.
export function kick(ctx, out, t, noise, strength) {
  const s = Math.min(1, Math.max(0.15, strength));
  thump(ctx, out, t, 150, 50, 0.14 + 0.06 * s, 0.9 * s);
  noiseBurst(ctx, out, t, noise, { freq: 1100 + 600 * s, q: 0.8, dur: 0.03 + 0.02 * s, vol: 0.45 * s });
}

// Soft dribbling touch.
export function touch(ctx, out, t, noise) {
  thump(ctx, out, t, 120, 60, 0.06, 0.22);
  noiseBurst(ctx, out, t, noise, { freq: 900, q: 1, dur: 0.025, vol: 0.12 });
}

export function bounce(ctx, out, t, noise, strength) {
  const s = Math.min(1, Math.max(0.1, strength));
  thump(ctx, out, t, 110, 45, 0.1, 0.55 * s);
  noiseBurst(ctx, out, t, noise, { freq: 700, q: 0.7, dur: 0.02, vol: 0.15 * s });
}

export function header(ctx, out, t, noise) {
  thump(ctx, out, t, 190, 85, 0.1, 0.6);
  noiseBurst(ctx, out, t, noise, { freq: 1500, q: 1, dur: 0.03, vol: 0.3 });
}

// Keeper catches the ball: a padded thump.
export function catchBall(ctx, out, t, noise) {
  thump(ctx, out, t, 95, 55, 0.12, 0.6);
  noiseBurst(ctx, out, t, noise, { freq: 380, q: 0.7, dur: 0.08, vol: 0.4, type: 'lowpass' });
}

// Ball hits the post or the crossbar: inharmonic metal partials with a long decay.
export function clang(ctx, out, t, noise, strength) {
  const s = Math.min(1, Math.max(0.3, strength));
  const partials = [[520, 1, 1.2], [1335, 0.6, 0.9], [2180, 0.4, 0.6], [3100, 0.25, 0.45], [4310, 0.15, 0.3]];
  for (const [freq, amp, decay] of partials) {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = freq * (0.99 + Math.random() * 0.02);
    const g = envelope(ctx, t, 0.002, 0.28 * amp * s, decay);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + decay + 0.05);
  }
  noiseBurst(ctx, out, t, noise, { freq: 2500, q: 0.8, dur: 0.02, vol: 0.4 * s });
}

// Ball in the net: a short swish.
export function net(ctx, out, t, noise) {
  noiseBurst(ctx, out, t, noise, { freq: 3200, q: 0.5, dur: 0.35, vol: 0.22 });
  noiseBurst(ctx, out, t + 0.03, noise, { freq: 600, q: 0.6, dur: 0.25, vol: 0.12 });
}

// --- Referee --------------------------------------------------------------------------------

// Pea whistle: a high tone with a fast trill from the pea (frequency and amplitude wobble).
export function whistle(ctx, out, t, noise, long = false) {
  const dur = long ? 0.95 : 0.28;
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.value = 2850;
  const trill = ctx.createOscillator();
  trill.frequency.value = 31;
  const depth = ctx.createGain();
  depth.gain.value = 170;
  trill.connect(depth).connect(o.frequency);
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(SILENT, t);
  amp.gain.linearRampToValueAtTime(0.15, t + 0.02);
  amp.gain.setValueAtTime(0.15, t + dur - 0.05);
  amp.gain.exponentialRampToValueAtTime(SILENT, t + dur);
  const wobble = ctx.createGain();
  wobble.gain.value = 0.04;
  trill.connect(wobble).connect(amp.gain);
  o.connect(amp).connect(out);
  o.start(t);
  trill.start(t);
  o.stop(t + dur + 0.05);
  trill.stop(t + dur + 0.05);
  // Breath noise.
  noiseBurst(ctx, out, t, noise, { freq: 3000, q: 2, dur, vol: 0.03 });
}

// --- Crowd ----------------------------------------------------------------------------------

// Goal roar: a swelling wall of noise that slowly dies down. level 0..1.
export function roar(ctx, out, t, pink, level = 1) {
  const src = ctx.createBufferSource();
  src.buffer = pink;
  src.loop = true;
  const f1 = ctx.createBiquadFilter();
  f1.type = 'bandpass';
  f1.Q.value = 0.6;
  f1.frequency.setValueAtTime(550, t);
  f1.frequency.linearRampToValueAtTime(950, t + 0.5);
  f1.frequency.linearRampToValueAtTime(700, t + 3);
  const g = ctx.createGain();
  const peak = 2.6 * level;
  g.gain.setValueAtTime(SILENT, t);
  g.gain.linearRampToValueAtTime(peak, t + 0.45);
  g.gain.linearRampToValueAtTime(peak * 0.75, t + 2.2);
  g.gain.exponentialRampToValueAtTime(SILENT, t + 5.5);
  src.connect(f1).connect(g).connect(out);
  src.start(t, Math.random() * 2);
  src.stop(t + 5.6);
}

// "Oooh" after a near miss: noise through two vowel formants that glide.
export function ooh(ctx, out, t, pink, level = 1) {
  const src = ctx.createBufferSource();
  src.buffer = pink;
  src.loop = true;
  const g = ctx.createGain();
  g.gain.setValueAtTime(SILENT, t);
  g.gain.linearRampToValueAtTime(3.6 * level, t + 0.25);
  g.gain.exponentialRampToValueAtTime(SILENT, t + 1.7);
  for (const [a, b, c, q] of [[320, 420, 300, 7], [820, 950, 780, 9]]) {
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = q;
    f.frequency.setValueAtTime(a, t);
    f.frequency.linearRampToValueAtTime(b, t + 0.3);
    f.frequency.linearRampToValueAtTime(c, t + 1.5);
    src.connect(f).connect(g);
  }
  g.connect(out);
  src.start(t, Math.random() * 2);
  src.stop(t + 1.8);
}

export function applause(ctx, out, t, buffer, level = 1, dur = 3) {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  const g = ctx.createGain();
  g.gain.setValueAtTime(SILENT, t);
  g.gain.linearRampToValueAtTime(0.9 * level, t + 0.3);
  g.gain.setValueAtTime(0.9 * level, t + dur * 0.5);
  g.gain.exponentialRampToValueAtTime(SILENT, t + dur);
  src.connect(g).connect(out);
  src.start(t, Math.random());
  src.stop(t + dur + 0.1);
}

// Constant crowd murmur in stereo. Two looping noise layers with slow waves;
// setExcitement(0..1) makes it louder and brighter.
export function createCrowd(ctx, out, pink) {
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 550;
  filter.Q.value = 0.5;
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = 1800;
  const level = ctx.createGain();
  level.gain.value = 0.2;
  filter.connect(lowpass).connect(level).connect(out);

  const sources = [];
  for (const [pan, rate] of [[-0.6, 0.07], [0.6, 0.11]]) {
    const src = ctx.createBufferSource();
    src.buffer = pink;
    src.loop = true;
    src.playbackRate.value = pan < 0 ? 0.97 : 1.03;
    const wave = ctx.createGain();
    wave.gain.value = 0.8;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = rate;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.25;
    lfo.connect(lfoDepth).connect(wave.gain);
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    src.connect(wave).connect(panner).connect(filter);
    src.start(0, Math.random() * 3);
    lfo.start();
    sources.push(src, lfo);
  }

  return {
    setExcitement(e, t) {
      level.gain.setTargetAtTime(0.16 + 0.42 * e, t, 0.5);
      filter.frequency.setTargetAtTime(500 + 650 * e, t, 0.5);
    },
    stop() {
      sources.forEach((s) => s.stop());
    },
  };
}
