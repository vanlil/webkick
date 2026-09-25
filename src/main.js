import './polyfills.js';
import { DT, PITCH, TACTIC_NAMES, tuning, loadTuning, saveTuning } from './config.js';
import { createInput } from './input.js';
import { createWorld, stepWorld, applyOptions, configureTeams, playerSpeed } from './world/world.js';
import { createMatch, gameTime } from './rules/match.js';
import { setPiecePrompt } from './rules/setpieces.js';
import { drawScanner } from './render/scanner.js';
import { createAudio, SOUND_MODES } from './audio/audio.js';
import { createCamera, updateCamera, snapCamera } from './render/camera.js';
import { drawPitch, drawGoal } from './render/pitch.js';
import { drawPlayer, drawBall } from './render/sprites.js';
import { drawHud } from './render/hud.js';
import { createDevPanel } from './devpanel.js';
import { createMenus } from './ui/menus.js';
import { createReplay, clearReplay, recordReplay, startReplay, stepReplay, stopReplay } from './replay.js';

loadTuning();

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d', { alpha: false });
const input = createInput(window);
const world = createWorld();
const panel = createDevPanel(() => {
  applyOptions(world);
  audio.applyVolumes();
}, { hidden: true });
const camera = createCamera(world.ball.x, world.ball.y);
const audio = createAudio();
const replay = createReplay(400); // the last 8 seconds

// ?debug in the URL exposes the simulation in the browser console as window.webkick.
if (new URLSearchParams(location.search).has('debug')) window.webkick = { world, tuning, audio };


// --- Screens: title → main menu → match setup → match; Esc opens the pause menu --------------
// The first key press or click on the title screen also unlocks audio (browsers require a
// user action before they play sound).
const titleEl = document.getElementById('title');
const menuEl = document.getElementById('menu');
let started = false; // a match is running (possibly paused)
let paused = false;
let showDebug = false;
let fullTimeMenuTimer = 0;
let helpTimer = 0;
let practice = null; // null (a match), 'skill' or 'penalties'

const menus = createMenus(menuEl, {
  startMatch(mode = null) {
    practice = mode;
    configureTeams(world);
    applyOptions(world);
    newMatch();
  },
  resume() {
    menus.close();
    setPaused(false);
  },
  restart() {
    newMatch();
  },
  quit() {
    endReplay();
    started = false;
    setPaused(false);
    titleEl.classList.remove('hidden');
    menuEl.classList.remove('in-game');
    menus.open('main');
  },
  resultText,
  practice: () => practice,
  onChange() {
    applyOptions(world);
    audio.applyVolumes();
    panel.refresh();
  },
});

titleEl.querySelector('#title-prompt').textContent = 'Press Space to start';
titleEl.classList.add('ready');
function openMainMenu() {
  if (menus.isOpen() || started) return;
  audio.start();
  titleEl.querySelector('#title-prompt').textContent = '';
  titleEl.querySelector('#title-help').textContent = '';
  titleEl.classList.remove('ready');
  menus.open('main');
}
window.addEventListener('keydown', (e) => { if (!e.metaKey && !e.ctrlKey && !e.altKey) openMainMenu(); });
titleEl.addEventListener('pointerdown', openMainMenu);

function newMatch() {
  menus.close();
  titleEl.classList.add('hidden');
  menuEl.classList.add('in-game');
  started = true;
  setPaused(false);
  input.reset();
  createMatch(world, practice);
  clearReplay(replay);
  hud.bannerTime = 0;
  fullTimeMenuTimer = 0;
  helpTimer = 20; // the key help at the bottom shows for the first seconds of a match
  audio.whistle();
  showAction(practice ? 'Practice · Esc for the menu' : `Referee: ${world.referee.name}`, 3);
}

function setPaused(p) {
  paused = p;
  audio.setPaused(p);
}

// Keys for the running match only (not while a menu is open).
const inMatch = (fn) => () => { if (started && !menus.isOpen()) fn(); };

// Dev commands are queued and applied at the start of the next simulation step.
const commands = [];

// Messages for the HUD: a big banner (GOAL) and a small line for the last action.
const hud = { banner: '', bannerTime: 0, action: '', actionTime: 0 };

const ACTION_LABELS = {
  shot: 'Shot', pass: 'Pass', lob: 'Lob', header: 'Header', overhead: 'Overhead kick',
  flick: 'Flick', post: 'Post!', bar: 'Crossbar!', save: 'Save!', catch: 'Caught',
  throwin: 'Throw-in', corner: 'Corner', goalkick: 'Goal kick', cross: 'Cross', clearance: 'Clearance',
  tackle: 'Tackle', freekick: 'Free kick', penalty: 'Penalty!', shootout: 'Penalty shoot-out',
  shootoutGoal: 'Scored!', shootoutMiss: 'Missed!',
};

input.onKey('Escape', inMatch(() => {
  if (replay.active) return endReplay();
  setPaused(true);
  menus.open('pause');
}));
input.onKey('KeyP', inMatch(() => { if (!replay.active) setPaused(!paused); }));
// Replay of the last seconds: R at normal speed, S in slow motion. R/S/Esc/fire end it.
const toggleReplay = (rate) => inMatch(() => {
  if (replay.active) return endReplay();
  if (paused || !startReplay(replay, world, rate)) return;
  audio.setPaused(true);
});
input.onKey('KeyR', toggleReplay(1));
input.onKey('KeyS', toggleReplay(0.35));

function endReplay() {
  if (!replay.active) return;
  stopReplay(replay, world);
  input.reset();
  acc = 0;
  audio.setPaused(paused);
}
input.onKey('KeyG', () => panel.toggle());
input.onKey('KeyI', inMatch(() => { showDebug = !showDebug; }));
input.onKey('KeyX', inMatch(() => {
  tuning.game.radar = (tuning.game.radar + 1) % 3;
  saveTuning();
}));
input.onKey('KeyM', inMatch(() => {
  const a = tuning.audio;
  a.mode = SOUND_MODES[(SOUND_MODES.indexOf(a.mode) + 1) % SOUND_MODES.length];
  saveTuning();
  audio.applyVolumes();
  panel.refresh();
  showAction({ all: 'Sound on', crowd: 'Crowd only', off: 'Sound off' }[a.mode]);
}));
input.onKey('KeyL', inMatch(() => commands.push('highball')));
// Tactics of the human team (keys 1–4); they take effect at the next stoppage.
TACTIC_NAMES.forEach((name, i) => input.onKey(`Digit${i + 1}`, inMatch(() => {
  tuning.game.humanTactic = name;
  saveTuning();
  applyOptions(world);
  panel.refresh();
  const now = world.teams[0].tactic === name;
  showAction(now ? `Tactic ${name}` : `Tactic ${name} at the next stoppage`, 2);
})));

function applyCommand(cmd) {
  const { ball } = world;
  const p = world.human.player;
  if (cmd === 'highball' && world.match.phase === 'play') {
    // A high ball dropping in front of the controlled player, to practise headers.
    Object.assign(ball, {
      x: p.x + p.fx * 16, y: p.y + p.fy * 16, z: 1, vx: -p.fx * 5, vy: -p.fy * 5, vz: 13,
      spin: 0, inGoal: -1, heldBy: null,
    });
    ball.prev.x = ball.x;
    ball.prev.y = ball.y;
    ball.prev.z = ball.z;
  }
}

function showAction(text, seconds = 1.5) {
  hud.action = text;
  hud.actionTime = seconds;
}

function banner(text, seconds, color) {
  hud.banner = text;
  hud.bannerTime = seconds;
  hud.bannerAge = 0;
  hud.bannerColor = color;
}

function step() {
  while (commands.length) applyCommand(commands.shift());
  const events = stepWorld(world, input.sample());
  recordReplay(replay, world);
  audio.handleEvents(events, world, camera);
  for (const e of events) {
    if (e.type === 'goal' && e.team !== undefined) {
      banner('GOAL!', tuning.goal.resetDelay);
    } else if (e.type === 'halftime') {
      banner('HALF TIME', tuning.setpiece.halfTimePause);
    } else if (e.type === 'fulltime') {
      banner('FULL TIME', 3);
      fullTimeMenuTimer = 3;
    } else if (e.type === 'extratime') {
      banner('EXTRA TIME', tuning.setpiece.halfTimePause);
    } else if (e.type === 'tactic') {
      showAction(`Tactic ${world.teams[0].tactic}`);
    } else if (e.type === 'card') {
      banner(e.color === 'red' ? 'RED CARD' : 'YELLOW CARD', 2, e.color === 'red' ? '#ff4d4d' : '#ffe14d');
      showAction(`#${e.player.number} ${world.teams[e.player.team].name}${e.color === 'red' ? ' is sent off' : ''}`, 2);
    } else if (e.type === 'foul' && e.seen) {
      showAction(`Foul by #${e.by.number} ${world.teams[e.by.team].name}`);
    } else if (ACTION_LABELS[e.type]) {
      showAction(ACTION_LABELS[e.type] + (e.speed ? `  ${Math.round(e.speed * 3.6)} km/h` : ''));
    }
  }
  if (hud.bannerTime > 0) hud.bannerTime -= DT;
  hud.bannerAge = (hud.bannerAge || 0) + DT;
  if (hud.actionTime > 0) hud.actionTime -= DT;
  // After the full-time banner: the menu with the result.
  if (fullTimeMenuTimer > 0) {
    fullTimeMenuTimer -= DT;
    if (fullTimeMenuTimer <= 0 && world.match.phase === 'fulltime') menus.open('fulltime');
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

  let alpha = paused ? 1 : acc / DT;
  if (replay.active) {
    alpha = stepReplay(replay, world, realDt, DT);
    if (alpha < 0 || input.sample().firePressed) {
      endReplay();
      alpha = 1;
    }
  } else if (!paused && started) {
    acc += realDt * tuning.game.speed;
    while (acc >= DT) {
      step();
      acc -= DT;
    }
  }
  if (!replay.active) alpha = paused ? 1 : acc / DT;
  if (started && !paused && !replay.active) audio.update(world, realDt);
  if (helpTimer > 0 && started && !paused) helpTimer -= realDt;
  render(alpha, realDt);
  requestAnimationFrame(frame);
}

const lerp = (a, b, t) => a + (b - a) * t;

function render(alpha, realDt) {
  const { ball } = world;
  const bx = lerp(ball.prev.x, ball.x, alpha);
  const by = lerp(ball.prev.y, ball.y, alpha);
  const bz = lerp(ball.prev.z, ball.z, alpha);

  updateCamera(camera, { x: bx, y: by, vx: ball.vx, vy: ball.vy }, paused && !replay.active ? 0 : realDt, W, H);
  const s = camera.scale;
  const ox = W / 2 - camera.x * s;
  const oy = H / 2 - camera.y * s;
  const view = { W, H, dpr, scale: s, sx: (x) => ox + x * s, sy: (y) => oy + y * s };

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawPitch(ctx, view);
  drawGoal(ctx, view, true);

  // Painter's order: things further up the pitch are drawn first. Off-screen players are skipped.
  const margin = 3;
  const minX = camera.x - camera.viewW / 2 - margin, maxX = camera.x + camera.viewW / 2 + margin;
  const minY = camera.y - camera.viewH / 2 - margin, maxY = camera.y + camera.viewH / 2 + margin;
  const drawables = [{ y: by, draw: () => drawBall(ctx, view, ball, bx, by, bz) }];
  const active = world.human && world.human.player;
  const bodies = world.referee ? [...world.players, world.referee.body] : world.players;
  for (const p of bodies) {
    if (p.sentOff && p.state !== 'leaving') continue;
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
    clock: gameTime(world.match),
    half: world.match.half,
    prompt: world.match.phase === 'fulltime' || replay.active ? null : setPiecePrompt(world),
    replay: replay.active ? replay.active.rate : 0,
    shootout: world.match.shootout,
    practice: world.match.practice,
    showHelp: (helpTimer > 0 || paused) && !replay.active,
    hud,
  });
  if (started) drawScanner(ctx, W, H, world, camera, tuning.game.radar);
}

// "Red Lions 2 – 1 Blue Stars", plus the shoot-out result if there was one.
function resultText() {
  const t = world.teams;
  const so = world.match.shootout;
  let text = `${t[0].name} ${world.score[0]} – ${world.score[1]} ${t[1].name}`;
  if (so && so.winner !== null) text += ` · ${t[so.winner].name} win ${so.goals[so.winner]}–${so.goals[1 - so.winner]} on penalties`;
  return text;
}

snapCamera(camera, PITCH.width / 2, PITCH.length / 2);
requestAnimationFrame(frame);
