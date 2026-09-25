import { DT, PITCH, tuning } from '../config.js';
import { createRng } from '../rng.js';
import { createBall, stepBall } from './ball.js';
import { stepPlayer, playerSpeed } from './player.js';
import { stepKeeper } from './keeper.js';
import { createTeam, KITS, applyLevel, applyAttributes, setTactic, applyKit } from './team.js';
import { TEAMS, kitsClash, alternateKit } from '../data/teams.js';
import { teamJoysticks } from '../ai/brain.js';
import { createMatch, matchPreStep, matchPostStep } from '../rules/match.js';
import { stepReferee } from '../rules/referee.js';

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
    human: withHuman ? { team: 0, player: teams[0].players[10], switchTimer: 0, fixed: null } : null,
    humanJoy: null,
    joys: new Map(),
    match: null,
  };
  configureTeams(world);
  createMatch(world);
  return world;
}

// Teams, kits and control mode from the match setup (tuning.team, tuning.game).
export function configureTeams(world) {
  const t = tuning.team;
  const home = TEAMS[t.home] || TEAMS[0];
  const away = TEAMS[t.away] || TEAMS[1];
  const homeKit = t.shirt
    ? { shirt: t.shirt, shorts: t.shorts || home.shorts, stripes: t.stripes }
    : { shirt: home.shirt, shorts: home.shorts, stripes: home.stripes };
  const awayKit = kitsClash(homeKit.shirt, away.shirt) ? alternateKit(away) : away;
  applyKit(world.teams[0], home.name, homeKit, home.keeper);
  applyKit(world.teams[1], away.name, awayKit, away.keeper);
  world.teams[1].strength = away.strength;
  applyAttributes(world.teams[1]);
  if (world.human) world.human.fixed = tuning.game.control === 'fixed' ? tuning.game.fixedPlayer : null;
}

// Re-read options that can change during play (difficulty, tactics).
export function applyOptions(world) {
  const cpu = world.teams[1];
  if (cpu.difficulty !== tuning.game.difficulty) {
    applyLevel(cpu);
    applyAttributes(cpu);
  }
  // A new tactic takes effect at the next stoppage (not in open play).
  world.teams[0].pendingTactic = tuning.game.humanTactic;
  world.teams[1].pendingTactic = tuning.game.cpuTactic;
  applyPendingTactics(world, !world.match || world.match.phase !== 'play');
}

// Returns true if a team changed its tactic.
function applyPendingTactics(world, stoppage) {
  let changed = false;
  for (const team of world.teams) {
    if (!team.pendingTactic || team.pendingTactic === team.tactic) continue;
    if (!stoppage) continue;
    setTactic(team, team.pendingTactic);
    changed = true;
  }
  return changed;
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
    // While the human's keeper has the ball, or faces a penalty, the stick belongs to him.
    const keeper = world.teams[world.human.team].players[0];
    const sp = world.match.setPiece;
    const keeperPenalty = sp && sp.type === 'penalty' && sp.team !== world.human.team;
    const keeperBusy = world.human.fixed == null && (keeper.state === 'hold' || keeperPenalty);
    joys.set(active, keeperBusy ? IDLE : humanJoy);
  }
  matchPreStep(world, humanJoy, joys);

  // Players nearest to the ball act first: they win a contested ball.
  const order = world.players.slice().sort((a, b) => dist2(a, ball) - dist2(b, ball));
  for (const p of order) {
    if (p.sentOff) continue;
    if (p.role === 'keeper') stepKeeper(p, world.teams[p.team], world);
    else stepPlayer(p, joys.get(p) || IDLE, world);
  }
  separatePlayers(world.players);
  stepReferee(world, DT);
  stepLeaving(world);

  if (!ball.heldBy) stepBall(ball, rng, events);
  updatePossession(world);
  matchPostStep(world, events);
  if (world.match.phase !== 'play' && applyPendingTactics(world, true)) events.push({ type: 'tactic' });
  return events;
}

// Sent-off players walk to the nearest touchline and leave the pitch.
function stepLeaving(world) {
  for (const p of world.players) {
    if (p.state !== 'leaving') continue;
    const tx = p.x < PITCH.width / 2 ? -2 : PITCH.width + 2;
    const dx = tx - p.x;
    p.vx = Math.sign(dx) * 3;
    p.vy = 0;
    p.fx = Math.sign(dx);
    p.fy = 0;
    p.x += p.vx * DT;
    p.runPhase += 3 * DT * 2.4;
    if (Math.abs(dx) < 0.2) {
      p.state = 'off';
      p.vx = 0;
    }
  }
}

// Possession (attack or defence formation) changes only when the other team has kept the ball
// for 0.35 s, so a deflection or a keeper's parry does not flip both formations.
function updatePossession(world) {
  const { ball } = world;
  if (!ball.lastTouch || world.match.phase === 'setpiece') return;
  const team = ball.heldBy && ball.heldBy.team !== undefined ? ball.heldBy.team : ball.lastTouch.team;
  if (team === world.possession) {
    world.possessionTimer = 0;
    return;
  }
  world.possessionTimer = (world.possessionTimer || 0) + DT;
  if (world.possessionTimer >= 0.35 || ball.heldBy) {
    world.possession = team;
    world.possessionTimer = 0;
  }
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
  if (h.fixed != null) return; // "fixed player" mode: the same player all match
  if (h.switchTimer > 0) h.switchTimer -= DT;
  // Keep the player while he traps, jumps, slides or bends a shot; switch away from a player
  // lying on the ground.
  const busy = ['trap', 'jump', 'slide'].includes(cur.state) || (cur.aftertouch && cur.aftertouch.kind !== 'pass');
  if (busy || h.switchTimer > 0) return;
  const b = world.ball;
  const tx = b.x + b.vx * 0.3, ty = b.y + b.vy * 0.3;
  let best = cur, bestD = Math.hypot(cur.x - tx, cur.y - ty);
  const curD = bestD;
  for (const p of team.players) {
    if (p.role === 'keeper' || p.sentOff) continue;
    const d = Math.hypot(p.x - tx, p.y - ty);
    if (d < bestD) { bestD = d; best = p; }
  }
  if (best !== cur && bestD < curD - tuning.ai.switchMargin) {
    h.player = best;
    h.switchTimer = 0.15;
    best.ai.prevFire = cur.ai.prevFire;
  }
}

// Players cannot overlap: push overlapping pairs apart.
function separatePlayers(players) {
  const minD = 0.6;
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i], b = players[j];
      if (a.sentOff || b.sentOff) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      if (d >= minD || d < 1e-6) continue;
      const push = (minD - d) / 2;
      const nx = dx / d, ny = dy / d;
      a.x -= nx * push; a.y -= ny * push;
      b.x += nx * push; b.y += ny * push;
    }
  }
  const m = PITCH.margin - 1;
  for (const p of players) {
    p.x = Math.min(PITCH.width + m, Math.max(-m, p.x));
    p.y = Math.min(PITCH.length + m, Math.max(-m, p.y));
  }
}

function dist2(p, b) {
  return (p.x - b.x) ** 2 + (p.y - b.y) ** 2;
}

export { playerSpeed };
