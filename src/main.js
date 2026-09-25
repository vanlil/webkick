import { DT, PITCH, tuning, loadTuning } from './config.js';
import { createInput } from './input.js';
import { createRng } from './rng.js';
import { createBall, stepBall } from './world/ball.js';
import { createPlayer, stepPlayer, playerSpeed } from './world/player.js';
import { createCamera, updateCamera, snapCamera } from './render/camera.js';
import { drawPitch, drawGoal } from './render/pitch.js';
import { drawPlayer, drawBall } from './render/sprites.js';
import { drawHud } from './render/hud.js';
import { createDevPanel } from './devpanel.js';

loadTuning();

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d', { alpha: false });
const input = createInput(window);
const panel = createDevPanel();

const HOME_KIT = { shirt: '#d8323c', shorts: '#ffffff', socks: '#d8323c', skin: '#e8b48f', hair: '#3b2a1e' };

// --- World (M1: one player and the ball) ---------------------------------------------------
const rng = createRng(20260925);
const ball = createBall(PITCH.width / 2, PITCH.length / 2);
const player = createPlayer({ x: PITCH.width / 2, y: PITCH.length / 2 + 2, kit: HOME_KIT });
const camera = createCamera(ball.x, ball.y);

// Dev commands are queued and applied at the start of the next simulation step.
const commands = [];
let paused = false;
let showDebug = true;

// Messages for the HUD: a big banner (GOAL) and a small line for the last action.
const hud = { banner: '', bannerTime: 0, action: '', actionTime: 0 };
let goalTimer = 0;
const score = [0, 0];

const ACTION_LABELS = {
  shot: 'Shot', pass: 'Pass', lob: 'Lob', header: 'Header', overhead: 'Overhead kick',
  flick: 'Flick', trap: 'Trap', post: 'Post!', bar: 'Crossbar!',
};

input.onKey('KeyP', () => { paused = !paused; });
input.onKey('KeyG', () => panel.toggle());
input.onKey('KeyI', () => { showDebug = !showDebug; });
input.onKey('KeyR', () => commands.push('reset'));
input.onKey('KeyL', () => commands.push('highball'));

function applyCommand(cmd) {
  const fx = player.fx, fy = player.fy;
  if (cmd === 'reset') {
    Object.assign(ball, { x: player.x + fx * 1.2, y: player.y + fy * 1.2, z: 0, vx: 0, vy: 0, vz: 0, spin: 0, inGoal: -1 });
  } else if (cmd === 'restart') {
    Object.assign(ball, { x: PITCH.width / 2, y: PITCH.length / 2, z: 0, vx: 0, vy: 0, vz: 0, spin: 0, inGoal: -1 });
    Object.assign(player, { x: PITCH.width / 2, y: PITCH.length / 2 + 1.5, vx: 0, vy: 0, fx: 0, fy: -1, state: 'run', z: 0 });
    player.prev.x = player.x;
    player.prev.y = player.y;
  } else if (cmd === 'highball') {
    // A high ball dropping about 10 m in front of the player, to practise running onto it.
    Object.assign(ball, { x: player.x + fx * 16, y: player.y + fy * 16, z: 1, vx: -fx * 5, vy: -fy * 5, vz: 13, spin: 0, inGoal: -1 });
  }
  ball.prev.x = ball.x;
  ball.prev.y = ball.y;
  ball.prev.z = ball.z;
}

function step() {
  while (commands.length) applyCommand(commands.shift());
  const events = [];
  const joy = input.sample();
  stepPlayer(player, joy, { ball, rng, events });
  stepBall(ball, rng, events);
  handleEvents(events);

  if (goalTimer > 0) {
    goalTimer -= DT;
    if (goalTimer <= 0) applyCommand('restart');
  }
  if (hud.bannerTime > 0) hud.bannerTime -= DT;
  if (hud.actionTime > 0) hud.actionTime -= DT;
}

function handleEvents(events) {
  for (const e of events) {
    if (e.type === 'goal') {
      score[e.goal]++;
      hud.banner = 'GOAL!';
      hud.bannerTime = tuning.goal.resetDelay;
      goalTimer = tuning.goal.resetDelay;
    } else if (ACTION_LABELS[e.type]) {
      const kmh = e.speed ? `  ${Math.round(e.speed * 3.6)} km/h` : '';
      hud.action = ACTION_LABELS[e.type] + kmh;
      hud.actionTime = 1.5;
    }
  }
}

// --- Canvas sizing (native resolution) -----------------------------------------------------
let W = 0, H = 0, dpr = 1;
function resize() {
  dpr = window.devicePixelRatio || 1;
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
}
window.addEventListener('resize', resize);
resize();

// --- Loop: fixed 50 Hz simulation, rendering every display frame with interpolation ---------
let last = performance.now();
let acc = 0;
let fps = 60;

function frame(now) {
  const realDt = Math.min(0.25, (now - last) / 1000);
  last = now;
  fps += (1 / Math.max(realDt, 1e-3) - fps) * 0.05;

  if (!paused) {
    acc += realDt * tuning.game.speed;
    while (acc >= DT) {
      step();
      acc -= DT;
    }
  }
  render(paused ? 1 : acc / DT, realDt);
  requestAnimationFrame(frame);
}

const lerp = (a, b, t) => a + (b - a) * t;

function render(alpha, realDt) {
  const bx = lerp(ball.prev.x, ball.x, alpha);
  const by = lerp(ball.prev.y, ball.y, alpha);
  const bz = lerp(ball.prev.z, ball.z, alpha);
  const px = lerp(player.prev.x, player.x, alpha);
  const py = lerp(player.prev.y, player.y, alpha);

  updateCamera(camera, { x: bx, y: by, vx: ball.vx, vy: ball.vy }, paused ? 0 : realDt, W, H);
  const s = camera.scale;
  const ox = W / 2 - camera.x * s;
  const oy = H / 2 - camera.y * s;
  const view = { W, H, scale: s, sx: (x) => ox + x * s, sy: (y) => oy + y * s };

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawPitch(ctx, view);
  drawGoal(ctx, view, true);

  // Painter's order: things further up the pitch are drawn first.
  const drawables = [
    { y: py, draw: () => drawPlayer(ctx, view, player, px, py, { active: true }) },
    { y: by, draw: () => drawBall(ctx, view, ball, bx, by, bz) },
  ].sort((a, b) => a.y - b.y);
  drawables.forEach((d) => d.draw());

  drawGoal(ctx, view, false);
  drawHud(ctx, W, H, {
    fps,
    paused,
    showDebug,
    ballSpeed: Math.hypot(ball.vx, ball.vy),
    ballZ: ball.z,
    ballSpin: ball.spin,
    playerSpeed: playerSpeed(player),
    playerState: player.state,
    score,
    hud,
  });
}

snapCamera(camera, ball.x, ball.y);
requestAnimationFrame(frame);
