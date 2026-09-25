import { PITCH, tuning } from '../config.js';
import * as synth from './synth.js';

// Turns match events into sounds and keeps the crowd murmur going.
// Browsers only allow audio after a user action, so start() is called from the title screen.
//
// Modes (tuning.audio.mode): 'all', 'crowd' (crowd only, no effects), 'off'.

export const SOUND_MODES = ['all', 'crowd', 'off'];

const MIN_GAP = { touch: 0.06, bounce: 0.05, block: 0.08, net: 0.3, kick: 0.04 }; // seconds

export function createAudio() {
  let ctx = null;
  let master, effects, crowdBus, noise, pink, claps, crowd;
  const lastPlayed = {};
  let lastShot = -Infinity;
  let excitement = 0;

  function build() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    master = ctx.createGain();
    effects = ctx.createGain();
    crowdBus = ctx.createGain();
    effects.connect(master);
    crowdBus.connect(master);
    master.connect(comp).connect(ctx.destination);
    noise = synth.whiteNoise(ctx, 2);
    pink = synth.pinkNoise(ctx, 6);
    claps = synth.applauseBuffer(ctx, 4);
    crowd = synth.createCrowd(ctx, crowdBus, pink);
    applyVolumes();
  }

  function applyVolumes() {
    if (!ctx) return;
    const a = tuning.audio;
    const t = ctx.currentTime;
    master.gain.setTargetAtTime(a.mode === 'off' ? 0 : a.master, t, 0.05);
    effects.gain.setTargetAtTime(a.mode === 'all' ? a.effects : 0, t, 0.05);
    crowdBus.gain.setTargetAtTime(a.crowd, t, 0.05);
  }

  // Throttle sounds that can fire many times in a row (bounces, dribbling).
  function allowed(kind) {
    const gap = MIN_GAP[kind] || 0;
    const t = ctx.currentTime;
    if (t - (lastPlayed[kind] || -1) < gap) return false;
    lastPlayed[kind] = t;
    return true;
  }

  // Stereo position and distance attenuation for a sound at the ball, relative to the camera.
  function at(ball, camera) {
    const pan = ctx.createStereoPanner();
    const g = ctx.createGain();
    const half = Math.max(1, camera.viewW / 2);
    pan.pan.value = Math.max(-1, Math.min(1, (ball.x - camera.x) / half)) * 0.7;
    const d = Math.hypot(ball.x - camera.x, ball.y - camera.y);
    g.gain.value = 1 / (1 + Math.max(0, d - 12) / 25);
    pan.connect(g).connect(effects);
    setTimeout(() => { pan.disconnect(); g.disconnect(); }, 6000); // longest sound: the clang
    return pan;
  }

  function handle(e, world, camera) {
    const { ball } = world;
    const t = ctx.currentTime;
    const here = () => at(ball, camera);
    switch (e.type) {
      case 'touch':
      case 'trap':
      case 'control':
      case 'flick':
        if (allowed('touch')) synth.touch(ctx, here(), t, noise);
        break;
      case 'shot':
      case 'lob':
      case 'overhead':
      case 'pass':
      case 'cross':
      case 'clearance':
        if (allowed('kick')) synth.kick(ctx, here(), t, noise, (e.speed || 20) / 28);
        if (e.type === 'shot' || e.type === 'overhead' || e.type === 'lob') lastShot = t;
        break;
      case 'header':
        synth.header(ctx, here(), t, noise);
        lastShot = t;
        break;
      case 'bounce':
        if ((e.strength || 0) > 1.2 && allowed('bounce')) synth.bounce(ctx, here(), t, noise, e.strength / 9);
        break;
      case 'block':
        if (allowed('block')) synth.bounce(ctx, here(), t, noise, (e.strength || 4) / 10);
        break;
      case 'post':
      case 'bar':
        synth.clang(ctx, here(), t, noise, (e.strength || 10) / 15);
        synth.ooh(ctx, crowdBus, t + 0.15, pink, 1);
        break;
      case 'net':
        if (allowed('net')) synth.net(ctx, here(), t, noise);
        break;
      case 'catch':
        synth.catchBall(ctx, here(), t, noise);
        if (t - lastShot < 2) synth.applause(ctx, crowdBus, t + 0.1, claps, 0.4, 2);
        break;
      case 'save':
        synth.ooh(ctx, crowdBus, t, pink, 0.9);
        synth.applause(ctx, crowdBus, t + 0.3, claps, 0.5, 2.2);
        break;
      case 'goal':
        synth.roar(ctx, crowdBus, t, pink, 1);
        synth.applause(ctx, crowdBus, t + 0.4, claps, 0.8, 4.5);
        break;
      case 'corner':
      case 'goalkick':
        // A shot that just went wide: "oooh".
        if (t - lastShot < 3 && Math.abs(ball.x - PITCH.width / 2) < PITCH.goalWidth / 2 + 5) {
          synth.ooh(ctx, crowdBus, t, pink, 0.8);
        }
        break;
      case 'whistle':
        synth.whistle(ctx, effects, t, noise, e.kind === 'long');
        break;
      case 'slide':
        synth.slide(ctx, here(), t, noise);
        break;
      case 'tackle':
        synth.kick(ctx, here(), t, noise, 0.5);
        break;
      case 'foul':
        synth.ooh(ctx, crowdBus, t + 0.05, pink, 0.7); // the crowd saw it, even if the referee did not
        break;
      case 'card':
        synth.ooh(ctx, crowdBus, t + 0.2, pink, e.color === 'red' ? 1.2 : 0.8);
        break;
      case 'penaltykick':
        synth.kick(ctx, here(), t, noise, 1);
        break;
      case 'shootoutGoal':
        synth.roar(ctx, crowdBus, t, pink, 0.8);
        break;
      case 'shootoutMiss':
        synth.ooh(ctx, crowdBus, t, pink, 1);
        break;
      case 'halftime':
      case 'fulltime':
        synth.applause(ctx, crowdBus, t + 0.8, claps, 0.7, 4);
        break;
      default:
        break;
    }
  }

  return {
    // Call from a user action (key press, click).
    start() {
      if (!ctx) build();
      if (ctx.state === 'suspended') ctx.resume();
    },
    get context() { return ctx; },
    setPaused(paused) {
      if (!ctx) return;
      if (paused) ctx.suspend();
      else ctx.resume();
    },
    applyVolumes,
    whistle(long = false) {
      if (ctx) synth.whistle(ctx, effects, ctx.currentTime + 0.05, noise, long);
    },
    handleEvents(events, world, camera) {
      if (!ctx || ctx.state !== 'running') return;
      for (const e of events) handle(e, world, camera);
    },
    // Crowd excitement follows the play: louder when the ball is near a goal.
    update(world, dt) {
      if (!ctx || !crowd) return;
      const { ball, match } = world;
      const goalDist = Math.min(
        Math.hypot(ball.x - PITCH.width / 2, ball.y),
        Math.hypot(ball.x - PITCH.width / 2, ball.y - PITCH.length),
      );
      let target = Math.max(0, Math.min(1, 1 - (goalDist - 8) / 32));
      if (match.phase === 'goal') target = 1;
      else if (match.phase === 'halftime' || match.phase === 'fulltime') target = 0.25;
      excitement += (target - excitement) * Math.min(1, dt * 1.5);
      crowd.setExcitement(excitement, ctx.currentTime);
    },
  };
}
