import { DT, PITCH, TACTIC_NAMES, tuning, loadTuning, saveTuning } from './config.js';
import { createInput } from './input.js';
import { createWorld, stepWorld, applyOptions, startFromCentre, playerSpeed } from './world/world.js';
import { createCamera, updateCamera, snapCamera } from './render/camera.js';
import { drawPitch, drawGoal } from './render/pitch.js';
import { drawPlayer, drawBall } from './render/sprites.js';
import { drawHud } from './render/hud.js';
import { createDevPanel } from './devpanel.js';

loadTuning();

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d', { alpha: false });
const input = createInput(window);
const world = createWorld();
const panel = createDevPanel(() => applyOptions(world));
const camera = createCamera(world.ball.x, world.ball.y);

// Dev commands are queued and applied at the start of the next simulation step.
const commands = [];
let paused = false;
let showDebug = true;

// Messages for the HUD: a big banner (GOAL) and a small line for the last action.
const hud = { banner: '', bannerTime: 0, action: '', actionTime: 0 };

const ACTION_LABELS = {
  shot: 'Shot', pass: 'Pass', lob: 'Lob', header: 'Header', overhead: 'Overhead kick',
  flick: 'Flick', post: 'Post!', bar: 'Crossbar!', save: 'Save!', catch: 'Caught',
  throwin: 'Throw-in', corner: 'Corner', goalkick: 'Goal kick',
};

input.onKey('KeyP', () => { paused = !paused; });
input.onKey('KeyG', () => panel.toggle());
input.onKey('KeyI', () => { showDebug = !showDebug; });
input.onKey('KeyR', () => commands.push('restart'));
input.onKey('KeyL', () => commands.push('highball'));
// Tactics of the human team (keys 1–4).
TACTIC_NAMES.forEach((name, i) => input.onKey(`Digit${i + 1}`, () => {
  tuning.game.humanTactic = name;
  saveTuning();
  applyOptions(world);
  panel.refresh();
  showAction(`Tactic ${name}`);
}));

function applyCommand(cmd) {
  const { ball } = world;
  const p = world.human.player;
  if (cmd === 'restart') {
    startFromCentre(world, 0);
  } else if (cmd === 'highball') {
    // A high ball dropping in front of the controlled player, to practise headers.
    Object.assign(ball, {
      x: p.x + p.fx * 16, y: p.y + p.fy * 16, z: 1, vx: -p.fx * 5, vy: -p.fy * 5, vz: 13,
      spin: 0, inGoal: -1, heldBy: null,
    });
    world.restart = null;
    ball.prev.x = ball.x;
    ball.prev.y = ball.y;
    ball.prev.z = ball.z;
  }
}

function showAction(text) {
  hud.action = text;
  hud.actionTime = 1.5;
}

function step() {
  while (commands.length) applyCommand(commands.shift());
  const events = stepWorld(world, input.sample());
  for (const e of events) {
    if (e.type === 'goal' && e.team !== undefined) {
      hud.banner = 'GOAL!';
      hud.bannerTime = tuning.goal.resetDelay;
    } else if (ACTION_LABELS[e.type]) {
      showAction(ACTION_LABELS[e.type] + (e.speed ? `  ${Math.round(e.speed * 3.6)} km/h` : ''));
    }
  }
  if (hud.bannerTime > 0) hud.bannerTime -= DT;
  if (hud.actionTime > 0) hud.actionTime -= DT;
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
  const { ball } = world;
  const bx = lerp(ball.prev.x, ball.x, alpha);
  const by = lerp(ball.prev.y, ball.y, alpha);
  const bz = lerp(ball.prev.z, ball.z, alpha);

  updateCamera(camera, { x: bx, y: by, vx: ball.vx, vy: ball.vy }, paused ? 0 : realDt, W, H);
  const s = camera.scale;
  const ox = W / 2 - camera.x * s;
  const oy = H / 2 - camera.y * s;
  const view = { W, H, scale: s, sx: (x) => ox + x * s, sy: (y) => oy + y * s };

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawPitch(ctx, view);
  drawGoal(ctx, view, true);

  // Painter's order: things further up the pitch are drawn first. Off-screen players are skipped.
  const margin = 3;
  const minX = camera.x - camera.viewW / 2 - margin, maxX = camera.x + camera.viewW / 2 + margin;
  const minY = camera.y - camera.viewH / 2 - margin, maxY = camera.y + camera.viewH / 2 + margin;
  const drawables = [{ y: by, draw: () => drawBall(ctx, view, ball, bx, by, bz) }];
  const active = world.human && world.human.player;
  for (const p of world.players) {
    const px = lerp(p.prev.x, p.x, alpha);
    const py = lerp(p.prev.y, p.y, alpha);
    if (px < minX || px > maxX || py < minY || py > maxY) continue;
    drawables.push({ y: py, draw: () => drawPlayer(ctx, view, p, px, py, { active: p === active }) });
  }
  drawables.sort((a, b) => a.y - b.y).forEach((d) => d.draw());

  drawGoal(ctx, view, false);
  drawHud(ctx, W, H, {
    fps,
    paused,
    showDebug,
    ballSpeed: Math.hypot(ball.vx, ball.vy),
    ballZ: ball.z,
    ballSpin: ball.spin,
    playerSpeed: active ? playerSpeed(active) : 0,
    playerState: active ? active.state : '-',
    teams: world.teams,
    score: world.score,
    hud,
  });
}

snapCamera(camera, PITCH.width / 2, PITCH.length / 2);
requestAnimationFrame(frame);
