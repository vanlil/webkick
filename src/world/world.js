import { DT, PITCH, tuning } from '../config.js';
import { createRng } from '../rng.js';
import { createBall, stepBall } from './ball.js';
import { stepPlayer, playerSpeed } from './player.js';
import { stepKeeper } from './keeper.js';
import { createTeam, KITS, applyLevel, applyAttributes, setTactic } from './team.js';
import { teamJoysticks } from '../ai/brain.js';
import { createMatch, matchPreStep, matchPostStep } from '../rules/match.js';

const HISTORY_STEPS = 40; // ball history for AI reaction delay (0.8 s)
const IDLE = { dx: 0, dy: 0, fire: false, firePressed: false, fireReleased: false };

// The whole simulation state. `withHuman: false` lets the CPU play both teams (tests).
export function createWorld({ seed = 20260925, withHuman = true } = {}) {
  const rng = createRng(seed);
  const teams = [
    createTeam({ id: 0, name: 'Red', human: withHuman, attackDir: -1, kit: KITS.red, keeperKit: KITS.redKeeper, tactic: tuning.game.humanTactic, rng }),
    createTeam({ id: 1, name: 'Blue', human: false, attackDir: 1, kit: KITS.blue, keeperKit: KITS.blueKeeper, tactic: tuning.game.cpuTactic, rng }),
  ];
  const world = {
    rng,
    ball: createBall(PITCH.width / 2, PITCH.length / 2),
    teams,
    players: [...teams[0].players, ...teams[1].players],
    step: 0,
    history: [],
    possession: 0,
    score: [0, 0],
    human: withHuman ? { team: 0, player: teams[0].players[10], switchTimer: 0 } : null,
    humanJoy: null,
    joys: new Map(),
    match: null,
  };
  createMatch(world);
  return world;
}

// Re-read options that can change during play (difficulty, tactics).
export function applyOptions(world) {
  const cpu = world.teams[1];
  if (cpu.difficulty !== tuning.game.difficulty) {
    applyLevel(cpu);
    applyAttributes(cpu);
  }
  if (world.teams[0].tactic !== tuning.game.humanTactic) setTactic(world.teams[0], tuning.game.humanTactic);
  if (world.teams[1].tactic !== tuning.game.cpuTactic) setTactic(world.teams[1], tuning.game.cpuTactic);
}

export function stepWorld(world, humanJoy) {
  const { ball, rng } = world;
  world.step++;
  const events = [];
  world.events = events;

  ball.prev.x = ball.x;
  ball.prev.y = ball.y;
  ball.prev.z = ball.z;
  for (const p of world.players) {
    p.prev.x = p.x;
    p.prev.y = p.y;
    p.prev.z = p.z;
  }
  world.history.push({ x: ball.x, y: ball.y, z: ball.z, vx: ball.vx, vy: ball.vy, vz: ball.vz });
  if (world.history.length > HISTORY_STEPS) world.history.shift();

  world.humanJoy = humanJoy;
  if (world.human && canSwitch(world)) switchHumanPlayer(world);

  // Joysticks: the human's stick for the controlled player, AI for everyone else,
  // then the match phase overrides (kick-off, set pieces, breaks).
  const joys = world.joys;
  joys.clear();
  const active = world.human ? world.human.player : null;
  for (const team of world.teams) teamJoysticks(team, world, active, joys);
  if (active) {
    // While the human's keeper has the ball, the stick belongs to him (clearance).
    const keeper = world.teams[world.human.team].players[0];
    joys.set(active, keeper.state === 'hold' ? IDLE : humanJoy);
  }
  matchPreStep(world, humanJoy, joys);

  // Players nearest to the ball act first: they win a contested ball.
  const order = world.players.slice().sort((a, b) => dist2(a, ball) - dist2(b, ball));
  for (const p of order) {
    if (p.role === 'keeper') stepKeeper(p, world.teams[p.team], world);
    else stepPlayer(p, joys.get(p) || IDLE, world);
  }
  separatePlayers(world.players);

  if (!ball.heldBy) stepBall(ball, rng, events);
  if (ball.lastTouch && !(world.match.phase === 'setpiece')) world.possession = ball.lastTouch.team;
  matchPostStep(world, events);
  return events;
}

// The human may change player in open play, and during the opponent's set pieces.
function canSwitch(world) {
  const m = world.match;
  return m.phase === 'play' || m.phase === 'goal' || (m.phase === 'setpiece' && m.setPiece.team !== world.human.team);
}

// Human control goes to the outfield player nearest to the ball, with some hysteresis.
// No switch while the current player is trapping, jumping or bending a shot.
function switchHumanPlayer(world) {
  const h = world.human;
  const team = world.teams[h.team];
  const cur = h.player;
  if (h.switchTimer > 0) h.switchTimer -= DT;
  const busy = cur.state !== 'run' || (cur.aftertouch && cur.aftertouch.kind !== 'pass');
  if (busy || h.switchTimer > 0) return;
  const b = world.ball;
  const tx = b.x + b.vx * 0.3, ty = b.y + b.vy * 0.3;
  let best = cur, bestD = Math.hypot(cur.x - tx, cur.y - ty);
  const curD = bestD;
  for (const p of team.players) {
    if (p.role === 'keeper') continue;
    const d = Math.hypot(p.x - tx, p.y - ty);
    if (d < bestD) { bestD = d; best = p; }
  }
  if (best !== cur && bestD < curD - tuning.ai.switchMargin) {
    h.player = best;
    h.switchTimer = 0.25;
    best.ai.prevFire = cur.ai.prevFire;
  }
}

// Players cannot overlap: push overlapping pairs apart.
function separatePlayers(players) {
  const minD = 0.6;
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i], b = players[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      if (d >= minD || d < 1e-6) continue;
      const push = (minD - d) / 2;
      const nx = dx / d, ny = dy / d;
      a.x -= nx * push; a.y -= ny * push;
      b.x += nx * push; b.y += ny * push;
    }
  }
}

function dist2(p, b) {
  return (p.x - b.x) ** 2 + (p.y - b.y) ** 2;
}

export { playerSpeed };
