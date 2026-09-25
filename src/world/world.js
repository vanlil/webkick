import { DT, PITCH, tuning } from '../config.js';
import { createRng } from '../rng.js';
import { createBall, stepBall } from './ball.js';
import { stepPlayer, playerSpeed } from './player.js';
import { stepKeeper } from './keeper.js';
import { createTeam, KITS, applyLevel, applyAttributes, setTactic, ownGoal } from './team.js';
import { teamJoysticks } from '../ai/brain.js';
import { tacticTarget, toWorld } from '../ai/tactics.js';

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
    goalTimer: 0,
    restart: null,
    human: withHuman ? { team: 0, player: teams[0].players[10], switchTimer: 0 } : null,
    joys: new Map(),
  };
  startFromCentre(world, 0);
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

  if (world.human) switchHumanPlayer(world);

  // Joysticks: the human's stick for the controlled player, AI for everyone else.
  const joys = world.joys;
  joys.clear();
  const active = world.human ? world.human.player : null;
  for (const team of world.teams) teamJoysticks(team, world, active, joys);
  if (active) joys.set(active, humanJoy);

  // Players nearest to the ball act first: they win a contested ball.
  const order = world.players.slice().sort((a, b) => dist2(a, ball) - dist2(b, ball));
  for (const p of order) {
    if (p.role === 'keeper') stepKeeper(p, world.teams[p.team], world);
    else stepPlayer(p, joys.get(p) || IDLE, world);
  }
  separatePlayers(world.players);

  if (!ball.heldBy) stepBall(ball, rng, events);
  if (ball.lastTouch) world.possession = ball.lastTouch.team;
  if (world.restart) stepRestart(world, events);
  else if (world.goalTimer <= 0) checkOutOfPlay(world, events);

  for (const e of events) {
    if (e.type === 'goal' && world.goalTimer <= 0) {
      // Goal 0 is the top goal: the team attacking upwards scores there.
      const scorer = world.teams.find((t) => (t.attackDir < 0 ? 0 : 1) === e.goal);
      world.score[scorer.id]++;
      e.team = scorer.id;
      world.goalTimer = tuning.goal.resetDelay;
      world.centreTeam = 1 - scorer.id;
    }
  }
  if (world.goalTimer > 0) {
    world.goalTimer -= DT;
    if (world.goalTimer <= 0) startFromCentre(world, world.centreTeam);
  }
  return events;
}

// --- Out of play (simple automatic restarts; M4 replaces them with full set pieces) -------

const RESTART_PAUSE = 1.0;
const RESTART_HOLD = { restart: true }; // ball.heldBy marker: nobody can touch the ball

function checkOutOfPlay(world, events) {
  const { ball } = world;
  if (ball.heldBy || ball.inGoal >= 0) return;
  const r = tuning.ball.radius;
  const W = PITCH.width, L = PITCH.length;
  const last = ball.lastTouch ? ball.lastTouch.team : world.possession;

  if (ball.x < -r || ball.x > W + r) {
    const x = ball.x < 0 ? 0 : W;
    startRestart(world, events, 'throwin', 1 - last, x, Math.min(L - 0.5, Math.max(0.5, ball.y)));
  } else if (ball.y < -r || ball.y > L + r) {
    const lineY = ball.y < 0 ? 0 : L;
    const defending = world.teams.find((t) => ownGoal(t).y === lineY);
    if (last === defending.id) {
      const x = ball.x < W / 2 ? 0.5 : W - 0.5;
      startRestart(world, events, 'corner', 1 - defending.id, x, lineY === 0 ? 0.5 : L - 0.5);
    } else {
      startRestart(world, events, 'goalkick', defending.id, 0, 0);
    }
  }
}

function startRestart(world, events, type, teamId, x, y) {
  const { ball } = world;
  const team = world.teams[teamId];
  Object.assign(ball, { vx: 0, vy: 0, vz: 0, z: 0, spin: 0 });
  if (type === 'goalkick') {
    // The keeper takes it from his hands, from the edge of the goal area.
    const k = team.players[0];
    const g = ownGoal(team);
    Object.assign(k, { x: g.x, y: g.y + g.into * PITCH.sixDepth, vx: 0, vy: 0, state: 'hold', stateTimer: tuning.keeper.holdTime, diveAngle: 0, z: 0 });
    ball.heldBy = k;
    ball.lastTouch = k;
    ball.touchSeq++;
  } else {
    ball.x = x;
    ball.y = y;
    ball.heldBy = RESTART_HOLD;
    world.restart = { type, team: teamId, timer: RESTART_PAUSE };
  }
  world.possession = teamId;
  events.push({ type, team: teamId });
}

// After a short pause the ball is thrown in or crossed automatically.
function stepRestart(world, events) {
  const { ball, rng } = world;
  const rs = world.restart;
  rs.timer -= DT;
  if (rs.timer > 0) return;
  const team = world.teams[rs.team];
  let tx, ty, vh, vz;
  if (rs.type === 'corner') {
    // Cross into the box, around the penalty spot.
    const g = world.teams[1 - rs.team];
    const goalY = ownGoal(g).y;
    tx = PITCH.width / 2 + rng.range(-6, 6);
    ty = goalY + ownGoal(g).into * rng.range(6, 12);
    vh = 17;
    vz = 8;
  } else {
    // Throw-in to the nearest outfield team-mate.
    let best = null, bestD = Infinity;
    for (const p of team.players) {
      if (p.role === 'keeper') continue;
      const d = Math.hypot(p.x - ball.x, p.y - ball.y);
      if (d > 3 && d < bestD) { bestD = d; best = p; }
    }
    tx = best ? best.x : PITCH.width / 2;
    ty = best ? best.y : ball.y;
    const d = Math.hypot(tx - ball.x, ty - ball.y) || 1;
    vh = Math.min(14, Math.max(6, d * 1.1));
    const T = d / vh;
    vz = (0.5 * tuning.ball.gravity * T * T - 1.8) / T;
    ball.z = 1.8;
  }
  const dx = tx - ball.x, dy = ty - ball.y;
  const d = Math.hypot(dx, dy) || 1;
  ball.vx = (dx / d) * vh;
  ball.vy = (dy / d) * vh;
  ball.vz = vz;
  ball.heldBy = null;
  // Credit the restart to the nearest player of the team, for possession and aftertouch rules.
  let taker = team.players[1], bestD = Infinity;
  for (const p of team.players) {
    const pd = Math.hypot(p.x - ball.x, p.y - ball.y);
    if (p.role !== 'keeper' && pd < bestD) { bestD = pd; taker = p; }
  }
  ball.lastTouch = taker;
  ball.touchSeq++;
  ball.touchStep = world.step;
  world.restart = null;
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

// Everyone in the own half; `team` kicks off from the centre spot.
export function startFromCentre(world, teamId) {
  const { ball } = world;
  world.restart = null;
  Object.assign(ball, {
    x: PITCH.width / 2, y: PITCH.length / 2, z: 0, vx: 0, vy: 0, vz: 0,
    spin: 0, inGoal: -1, heldBy: null, lastTouch: null,
  });
  ball.prev.x = ball.x;
  ball.prev.y = ball.y;
  ball.prev.z = 0;
  world.possession = teamId;
  world.history.length = 0;

  for (const team of world.teams) {
    team.chaser = null;
    const kicking = team.id === teamId;
    for (const p of team.players) {
      let x, y;
      if (p.role === 'keeper') {
        const g = ownGoal(team);
        x = g.x;
        y = g.y + g.into;
      } else {
        const [nx, ny] = tacticTarget(team.tactic, p.index - 1, 0.5, 0.5, false);
        ({ x, y } = toWorld(team.attackDir, nx, Math.max(0.53, ny)));
        // Opponents of the kicking team stay outside the centre circle.
        const cx = x - ball.x, cy = y - ball.y;
        const d = Math.hypot(cx, cy);
        if (!kicking && d < PITCH.circleRadius + 0.5) {
          x = ball.x + (cx / (d || 1)) * (PITCH.circleRadius + 0.5);
          y = ball.y + (cy / (d || 1)) * (PITCH.circleRadius + 0.5);
        }
      }
      resetPlayer(p, x, y, team.attackDir);
    }
    if (kicking) {
      // The last player (a forward) stands just behind the ball, facing the opponent's goal;
      // slightly to the side, so he does not hide the ball in the 3/4 view.
      const striker = team.players[10];
      resetPlayer(striker, ball.x - 0.5, ball.y - team.attackDir * 1.1, team.attackDir);
      if (world.human && team.id === world.human.team) world.human.player = striker;
    }
  }
}

function resetPlayer(p, x, y, attackDir) {
  Object.assign(p, {
    x, y, z: 0, vx: 0, vy: 0, fx: 0, fy: attackDir, state: p.role === 'keeper' ? 'guard' : 'run',
    stateTimer: 0, touchTimer: 0, shotWindow: 0, kickTimer: 0, aftertouch: null, diveAngle: 0,
  });
  p.prev.x = x;
  p.prev.y = y;
  p.prev.z = 0;
  p.ai.plan = null;
  p.ai.lastSector = null;
}

function dist2(p, b) {
  return (p.x - b.x) ** 2 + (p.y - b.y) ** 2;
}

export { playerSpeed };
