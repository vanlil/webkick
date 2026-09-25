import { DT, PITCH, tuning } from '../config.js';
import { ownGoal, oppGoal } from '../world/team.js';
import { distribute, clearance, penaltyDive } from '../world/keeper.js';
import { launchBall } from '../world/player.js';

// Throw-ins, corners, goal kicks, free kicks and penalties. Stages:
//   'dead'  ball still rolling out, nobody can touch it
//   'walk'  ball placed; the taker walks to it, the others take position
//   'ready' human: the set piece controls below; CPU: takes it after a short delay
// The human team's set pieces use the human's stick; the CPU's are automatic.

const HOLD = { restart: true }; // ball.heldBy marker: nobody can touch the ball
const IDLE = { dx: 0, dy: 0, fire: false, firePressed: false, fireReleased: false };

export function startSetPiece(world, type, teamId, x, y, events, opts = {}) {
  const m = world.match;
  m.phase = 'setpiece';
  const foul = type === 'freekick' || type === 'penalty';
  const dead = opts.shootout ? 0 : tuning.setpiece.deadTime + (foul ? 0.5 : 0);
  m.setPiece = { type, team: teamId, x, y, stage: 'dead', timer: dead, taker: null, ui: null, shootout: !!opts.shootout, forcedTaker: opts.taker || null };
  world.ball.dead = true;
  world.possession = teamId; // the team taking it positions itself for attack
  events.push({ type, team: teamId }, { type: 'whistle', kind: 'short' });
}

// Called before the players move; overrides the joysticks of the taker.
export function stepSetPiece(world, humanJoy, joys) {
  const m = world.match;
  const sp = m.setPiece;
  const team = world.teams[sp.team];
  const human = !!world.human && world.human.team === sp.team;
  const cfg = tuning.setpiece;
  sp.timer -= DT;

  if (sp.stage === 'dead') {
    if (sp.timer > 0) return;
    placeBall(world, sp, team);
    sp.taker = chooseTaker(world, sp, team);
    if (human && sp.type !== 'goalkick') world.human.player = sp.taker;
    if (sp.type === 'freekick') setupFreeKick(world, sp, team);
    if (sp.type === 'penalty') setupPenalty(world, sp, team);
    sp.stage = 'walk';
    sp.timer = sp.shootout ? 0 : cfg.walkTimeout;
  }

  if (sp.stage === 'walk') {
    const t = sp.taker;
    if (sp.type !== 'goalkick') {
      const spot = takerSpot(sp, team);
      const d = Math.hypot(spot.x - t.x, spot.y - t.y);
      if (d > 0.35 && sp.timer > 0) {
        joys.set(t, steerJoy(t, spot));
        return;
      }
      Object.assign(t, { x: spot.x, y: spot.y, vx: 0, vy: 0 });
      t.prev.x = t.x;
      t.prev.y = t.y;
      const into = sp.aim || intoPitch(sp);
      t.fx = into.x;
      t.fy = into.y;
    }
    sp.stage = 'ready';
    sp.timer = human ? cfg.humanAuto : cfg.cpuDelay + (sp.type === 'penalty' ? 0.5 : 0);
    sp.ui = sp.type === 'corner' ? 'power' : sp.type === 'penalty' ? 'aim' : 'wait';
    sp.power = 5;
    sp.prevDx = 0;
    sp.ptime = 0;
    world.events.push({ type: 'whistle', kind: 'short' });
  }

  // Ready.
  const t = sp.taker;
  if (t.role !== 'keeper') joys.set(t, IDLE);
  if (sp.type === 'throwin') {
    // Held above the head, just inside the line (outside it would be out of play again).
    world.ball.x = t.x + intoPitch(sp).x * 0.45;
    world.ball.y = t.y;
    world.ball.z = 2.0;
  }
  if (sp.type === 'penalty' && world.human && !human) humanKeeper(world, sp, humanJoy);
  if (human) playerControls(world, sp, team, humanJoy);
  else if (sp.timer <= 0) cpuTake(world, sp, team);
}

// The human's keeper facing a CPU penalty: stick + fire starts the dive (the stick picks the
// direction: sideways = dive to that side, up = high, down = low, centre = stay and block).
function humanKeeper(world, sp, joy) {
  if (sp.keeperDived || !joy.firePressed) return;
  sp.keeperDived = true;
  penaltyDive(sp.keeper, joy.dx, joy.dy < 0 ? 1.3 : joy.dy > 0 ? 0.15 : 0.6, true);
}

// --- Human controls -------------------------------------------------------------------------

function playerControls(world, sp, team, joy) {
  const cfg = tuning.setpiece;
  if (sp.type === 'throwin') {
    // Hold fire for distance, stick for direction; automatic if fire is not pressed in time.
    if (sp.ui === 'wait') {
      if (joy.firePressed) { sp.ui = 'charge'; sp.charge = 0; }
      else if (sp.timer <= 0) cpuTake(world, sp, team);
    } else if (sp.ui === 'charge') {
      sp.charge = Math.min(1, sp.charge + DT);
      if (!joy.fire) throwIn(world, sp, joy, sp.charge);
    }
  } else if (sp.type === 'corner') {
    // 1. ←/→ power (9 steps), fire  2. hold fire = height  3. ←/→ during the run-up = bias.
    if (sp.ui === 'power') {
      if (joy.dx !== sp.prevDx && joy.dx !== 0) sp.power = Math.min(9, Math.max(1, sp.power + joy.dx));
      sp.prevDx = joy.dx;
      if (joy.firePressed) sp.ui = 'powerSet';
      else if (sp.timer < -5) cpuTake(world, sp, team); // nobody there: taken automatically
    } else if (sp.ui === 'powerSet') {
      if (!joy.fire) sp.ui = 'heightWait';
    } else if (sp.ui === 'heightWait') {
      if (joy.firePressed) { sp.ui = 'height'; sp.hold = 0; }
    } else if (sp.ui === 'height') {
      sp.hold = Math.min(1.2, sp.hold + DT);
      if (!joy.fire) { sp.ui = 'runup'; sp.runup = cfg.runupTime; sp.bias = 0; }
    } else if (sp.ui === 'runup') {
      sp.bias = Math.max(-cfg.runupTime, Math.min(cfg.runupTime, sp.bias + joy.dx * DT));
      sp.runup -= DT;
      if (sp.runup <= 0) cornerKick(world, sp, team, sp.power, sp.hold, sp.bias);
    }
  } else if (sp.type === 'freekick') {
    // Hold fire = height (power is random). The stick at the moment of the kick picks the
    // variant: diagonal forward = slight bend, sideways = more bend, diagonal back = pass to a
    // team-mate, forward = step over (a team-mate shoots). Then aftertouch as usual.
    if (sp.ui === 'wait') {
      if (joy.firePressed) { sp.ui = 'height'; sp.hold = 0; }
      else if (sp.timer < -5) cpuTake(world, sp, team);
    } else if (sp.ui === 'height') {
      sp.hold = Math.min(1, sp.hold + DT);
      if (!joy.fire) freeKick(world, sp, team, joy, sp.hold);
    }
  } else if (sp.type === 'penalty') {
    // A pointer sweeps across the goal: fire fixes the direction, the hold time the height.
    sp.ptime += DT;
    if (sp.ui === 'aim') {
      sp.pointer = pointerAt(sp.ptime);
      if (joy.firePressed) { sp.ui = 'height'; sp.aimX = sp.pointer; sp.hold = 0; }
      else if (sp.timer < -8) cpuTake(world, sp, team);
    } else if (sp.ui === 'height') {
      sp.hold = Math.min(1, sp.hold + DT);
      if (!joy.fire) penaltyKick(world, sp, team, sp.aimX, sp.hold);
    }
  } else if (sp.type === 'goalkick') {
    // Stick = one of 9 kick types, fire = kick; automatic if nothing happens.
    if (joy.firePressed) {
      clearance(sp.taker, team, world, joy);
      finish(world);
    } else if (sp.timer <= 0) {
      distribute(sp.taker, team, world, true);
      finish(world);
    }
  }
}

// --- CPU ------------------------------------------------------------------------------------

function cpuTake(world, sp, team) {
  const { rng } = world;
  if (sp.type === 'penalty') {
    penaltyKick(world, sp, team, (rng.next() < 0.5 ? -1 : 1) * rng.range(0.4, 0.95), rng.range(0.05, 0.55));
    return;
  }
  if (sp.type === 'freekick') {
    cpuFreeKick(world, sp, team);
    return;
  }
  if (sp.type === 'goalkick') {
    distribute(sp.taker, team, world, true);
    finish(world);
  } else if (sp.type === 'corner') {
    cornerKick(world, sp, team, Math.round(rng.range(4, 8)), rng.range(0.5, 1.1), rng.range(-0.2, 0.2));
  } else {
    // Throw to the nearest free team-mate.
    const { ball } = world;
    let best = null, bestD = Infinity;
    for (const p of team.players) {
      if (p.role === 'keeper' || p === sp.taker || p.sentOff) continue;
      const d = Math.hypot(p.x - ball.x, p.y - ball.y);
      if (d > 3 && d < bestD) { bestD = d; best = p; }
    }
    const target = best || { x: PITCH.width / 2, y: ball.y };
    const d = Math.hypot(target.x - ball.x, target.y - ball.y) || 1;
    const vh = Math.min(14, Math.max(6, d * 1.1));
    const T = d / vh;
    const vz = (0.5 * tuning.ball.gravity * T * T - ball.z) / T;
    launchBall(sp.taker, ball, ((target.x - ball.x) / d) * vh, ((target.y - ball.y) / d) * vh, vz, world, 'throwin', false);
    finish(world);
  }
}

// --- Execution ------------------------------------------------------------------------------

function throwIn(world, sp, joy, charge) {
  const cfg = tuning.setpiece;
  const into = intoPitch(sp);
  // Only the 5 directions that do not point out of the pitch.
  let dx = joy.dx, dy = joy.dy;
  if ((!dx && !dy) || dx * into.x < 0) { dx = into.x; dy = 0; }
  const n = Math.hypot(dx, dy);
  const vh = cfg.throwMin + (cfg.throwMax - cfg.throwMin) * charge;
  launchBall(sp.taker, world.ball, (dx / n) * vh, (dy / n) * vh, 2 + 3 * charge, world, 'throwin', false);
  finish(world);
}

// Power 1–9 sets the distance towards the area in front of the goal, hold time the height,
// bias (seconds of ←/→) moves the target sideways.
function cornerKick(world, sp, team, power, hold, bias) {
  const cfg = tuning.setpiece;
  const { ball } = world;
  const g = oppGoal(team);
  const into = g.y === 0 ? 1 : -1;
  const aimX = PITCH.width / 2, aimY = g.y + into * 8;
  const ax = aimX - ball.x, ay = aimY - ball.y;
  const ad = Math.hypot(ax, ay) || 1;
  const dist = cfg.cornerMin + ((cfg.cornerMax - cfg.cornerMin) * (power - 1)) / 8;
  const tx = ball.x + (ax / ad) * dist + bias * 10;
  const ty = ball.y + (ay / ad) * dist;
  const vz = 2 + 10 * Math.min(1, hold);
  const flight = (2 * vz) / tuning.ball.gravity;
  const d = Math.hypot(tx - ball.x, ty - ball.y) || 1;
  const vh = Math.min(30, Math.max(8, d / Math.max(flight, 0.4)));
  launchBall(sp.taker, ball, ((tx - ball.x) / d) * vh, ((ty - ball.y) / d) * vh, vz, world, 'cross', true);
  finish(world);
}

// --- Free kick ------------------------------------------------------------------------------

function freeKick(world, sp, team, joy, hold) {
  const cfg = tuning.freekick;
  const { ball, rng } = world;
  const a = sp.aim;
  const r = { x: -a.y, y: a.x }; // to the right of the aim
  let variant = 'straight', bias = 0, side = 0;
  if (joy.dx || joy.dy) {
    const n = Math.hypot(joy.dx, joy.dy);
    const f = (joy.dx * a.x + joy.dy * a.y) / n;
    const sdot = (joy.dx * r.x + joy.dy * r.y) / n;
    side = Math.sign(sdot);
    if (f > 0.9) variant = 'stepover';
    else if (f > 0.3) bias = side * 0.07;
    else if (f > -0.3) bias = side * 0.16;
    else if (Math.abs(sdot) > 0.3) variant = 'pass';
  }
  const speed = rng.range(cfg.powerMin, cfg.powerMax);
  const vz = 2 + 9 * Math.min(1, hold);
  if (variant === 'pass') {
    const mate = side > 0 ? sp.helpers[0] : sp.helpers[1];
    if (mate) {
      const dx = mate.x - ball.x, dy = mate.y - ball.y, d = Math.hypot(dx, dy) || 1;
      launchBall(sp.taker, ball, (dx / d) * 9, (dy / d) * 9, 0, world, 'pass', true);
      return finish(world);
    }
  }
  if (variant === 'stepover' && sp.helpers[0]) {
    // The taker steps over the ball; the team-mate on the right shoots.
    const mate = sp.helpers[0];
    const g = oppGoal(team);
    const dx = g.x - ball.x, dy = g.y - ball.y, d = Math.hypot(dx, dy) || 1;
    launchBall(mate, ball, (dx / d) * speed, (dy / d) * speed, vz, world, 'freekick', true);
    if (world.human && world.human.team === team.id) world.human.player = mate;
    return finish(world);
  }
  const c = Math.cos(bias), s2 = Math.sin(bias);
  launchBall(sp.taker, ball, (a.x * c - a.y * s2) * speed, (a.x * s2 + a.y * c) * speed, vz, world, 'freekick', true);
  finish(world);
}

// CPU: near the goal a shot over the wall at the far corner (bent in with aftertouch on the
// higher levels); further away a long ball to a free team-mate.
function cpuFreeKick(world, sp, team) {
  const { ball, rng } = world;
  const g = oppGoal(team);
  const dist = Math.hypot(g.x - ball.x, g.y - ball.y);
  if (dist < 30) {
    const keeper = world.teams[1 - team.id].players[0];
    const targetX = keeper.x < g.x ? g.x + PITCH.goalWidth / 2 - 0.7 : g.x - PITCH.goalWidth / 2 + 0.7;
    const dx = targetX - ball.x, dy = g.y - ball.y, d = Math.hypot(dx, dy) || 1;
    const speed = rng.range(21, 25);
    const T = tuning.freekick.wallDistance / speed;
    const vz = (2.3 + 0.5 * tuning.ball.gravity * T * T) / T; // just clears the wall
    sp.taker.ai.useAftertouch = rng.next() < team.level.aftertouch;
    sp.taker.ai.shotTargetX = targetX;
    launchBall(sp.taker, ball, (dx / d) * speed, (dy / d) * speed, vz, world, 'freekick', true);
    return finish(world);
  }
  let best = null, bestScore = -Infinity;
  const opponents = world.teams[1 - team.id].players;
  for (const p of team.players) {
    if (p.role === 'keeper' || p.sentOff || p === sp.taker) continue;
    const progress = (p.y - ball.y) * team.attackDir;
    const d = Math.hypot(p.x - ball.x, p.y - ball.y);
    if (d < 10 || d > 40) continue;
    let free = 12;
    for (const o of opponents) free = Math.min(free, Math.hypot(o.x - p.x, o.y - p.y));
    const score = progress * 0.3 + free;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  const target = best || { x: g.x, y: ball.y + team.attackDir * 25 };
  const dx = target.x - ball.x, dy = target.y - ball.y, d = Math.hypot(dx, dy) || 1;
  const vh = Math.min(24, d * 0.8 + 6);
  const T = d / vh;
  launchBall(sp.taker, ball, (dx / d) * vh, (dy / d) * vh, 0.5 * tuning.ball.gravity * T, world, 'freekick', false);
  finish(world);
}

// Two team-mates next to the ball; a wall of 3–4 defenders 9.15 m away, if near the goal.
function setupFreeKick(world, sp, team) {
  const { ball } = world;
  const g = oppGoal(team);
  const dx = g.x - ball.x, dy = g.y - ball.y;
  const dist = Math.hypot(dx, dy) || 1;
  sp.aim = dist < 40 ? { x: dx / dist, y: dy / dist } : { x: 0, y: team.attackDir };
  const r = { x: -sp.aim.y, y: sp.aim.x };
  const mates = team.players
    .filter((p) => p.role !== 'keeper' && !p.sentOff && p !== sp.taker)
    .sort((a, b) => Math.hypot(a.x - ball.x, a.y - ball.y) - Math.hypot(b.x - ball.x, b.y - ball.y));
  sp.helpers = mates.slice(0, 2);
  sp.helperSpots = [
    { x: ball.x + r.x * 3, y: ball.y + r.y * 3 },
    { x: ball.x - r.x * 3, y: ball.y - r.y * 3 },
  ];
  sp.wall = [];
  sp.wallSpots = [];
  if (dist < 35) {
    const defenders = world.teams[1 - team.id].players
      .filter((p) => p.role !== 'keeper' && !p.sentOff)
      .sort((a, b) => Math.hypot(a.x - ball.x, a.y - ball.y) - Math.hypot(b.x - ball.x, b.y - ball.y));
    const n = dist < 25 ? 4 : 3;
    const wd = tuning.freekick.wallDistance;
    const cx = ball.x + (dx / dist) * wd, cy = ball.y + (dy / dist) * wd;
    const wr = { x: -dy / dist, y: dx / dist };
    sp.wall = defenders.slice(0, n);
    sp.wallSpots = sp.wall.map((_, i) => {
      const o = (i - (n - 1) / 2) * 0.75;
      return { x: cx + wr.x * o, y: cy + wr.y * o };
    });
  }
}

// --- Penalty --------------------------------------------------------------------------------

// Triangle wave −1 … 1 … −1: the direction pointer.
function pointerAt(t) {
  const ph = (t / tuning.freekick.pointerPeriod) % 1;
  return ph < 0.5 ? -1 + 4 * ph : 3 - 4 * ph;
}

function setupPenalty(world, sp, team) {
  const defenders = world.teams[1 - team.id];
  const g = ownGoal(defenders);
  sp.aim = { x: 0, y: -g.into };
  // The keeper waits on his line, in the middle of the goal.
  const k = defenders.players[0];
  Object.assign(k, { x: g.x, y: g.y + g.into * 0.3, vx: 0, vy: 0, z: 0, state: 'penalty', diveAngle: 0 });
  k.prev.x = k.x;
  k.prev.y = k.y;
  sp.keeper = k;
  sp.keeperDived = false;
  if (sp.shootout) {
    const spot = takerSpot(sp, team);
    Object.assign(sp.taker, { x: spot.x, y: spot.y, vx: 0, vy: 0, fx: sp.aim.x, fy: sp.aim.y });
    sp.taker.prev.x = spot.x;
    sp.taker.prev.y = spot.y;
  }
}

// aimX −1 … 1 across the goal; hold 0 … 1 = height (a quick tap: low along the ground).
function penaltyKick(world, sp, team, aimX, hold) {
  const { ball, rng } = world;
  const g = oppGoal(team);
  const tx = g.x + aimX * (PITCH.goalWidth / 2 + 0.3);
  const h = hold < 0.12 ? 0.15 : 0.3 + hold * 2.8;
  const dx = tx - ball.x, dy = g.y - ball.y, d = Math.hypot(dx, dy) || 1;
  const speed = tuning.freekick.penaltySpeed;
  const T = d / speed;
  const vz = (h + 0.5 * tuning.ball.gravity * T * T) / T;
  launchBall(sp.taker, ball, (dx / d) * speed, (dy / d) * speed, vz, world, 'penaltykick', false);
  // A CPU keeper picks a point at the kick and dives there, arriving with the ball. A good
  // keeper reads the shot more often; otherwise he guesses a side and a distance.
  const defenders = world.teams[1 - team.id];
  if (!defenders.human && !sp.keeperDived) {
    const reads = rng.next() < defenders.level.keeperSkill * 0.4;
    const r = rng.next();
    const offset = reads ? tx - g.x : (r < 0.42 ? -1 : r < 0.84 ? 1 : 0) * rng.range(1.2, 3.4);
    const side = Math.abs(offset) < 0.6 ? 0 : Math.sign(offset);
    const arrive = Math.max(0.2, T - 0.05);
    penaltyDive(sp.keeper, side, h > 1.6 ? 1.2 : 0.4, false, Math.abs(offset) / arrive);
  }
  finish(world);
}

function finish(world) {
  const m = world.match;
  world.ball.dead = false;
  if (m.setPiece && m.setPiece.shootout) {
    m.phase = 'shootoutKick';
    m.timer = 3;
  } else {
    m.phase = 'play';
  }
  m.setPiece = null;
}

// --- Placement ------------------------------------------------------------------------------

function placeBall(world, sp, team) {
  const { ball } = world;
  Object.assign(ball, { vx: 0, vy: 0, vz: 0, z: 0, spin: 0, dead: false, inGoal: -1 });
  if (sp.type === 'goalkick') {
    // The keeper takes it from his hands at the edge of the goal area.
    const k = team.players[0];
    const g = ownGoal(team);
    Object.assign(k, { x: g.x, y: g.y + g.into * PITCH.sixDepth, vx: 0, vy: 0, state: 'hold', stateTimer: 99, diveAngle: 0, z: 0 });
    k.prev.x = k.x;
    k.prev.y = k.y;
    ball.heldBy = k;
    ball.x = k.x;
    ball.y = k.y + g.into * 0.35;
    ball.z = 1;
  } else if (sp.type === 'penalty') {
    const g = ownGoal(world.teams[1 - sp.team]);
    sp.x = g.x;
    sp.y = g.y + g.into * PITCH.penaltySpot;
    ball.x = sp.x;
    ball.y = sp.y;
    ball.heldBy = HOLD;
  } else {
    ball.x = sp.x;
    ball.y = sp.y;
    ball.heldBy = HOLD;
  }
  ball.prev.x = ball.x;
  ball.prev.y = ball.y;
  ball.prev.z = ball.z;
}

function chooseTaker(world, sp, team) {
  if (sp.type === 'goalkick') return team.players[0];
  if (sp.forcedTaker) return sp.forcedTaker;
  // Penalty: the fouled player takes it, if he can.
  if (sp.type === 'penalty' && sp.victim && sp.victim.team === team.id && !sp.victim.sentOff) return sp.victim;
  let best = team.players[1], bestD = Infinity;
  for (const p of team.players) {
    if (p.role === 'keeper' || p.sentOff) continue;
    const d = Math.hypot(p.x - sp.x, p.y - sp.y);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

// Where the taker stands: on the touchline for a throw-in, behind the ball for a corner.
function takerSpot(sp, team) {
  if (sp.type === 'throwin') return { x: sp.x < PITCH.width / 2 ? -0.3 : PITCH.width + 0.3, y: sp.y };
  if (sp.aim) {
    // Behind the ball and a little to the side: a run-up angle, and the taker does not hide
    // the ball in the 3/4 view.
    const back = sp.type === 'penalty' ? 1.6 : 1.3;
    return { x: sp.x - sp.aim.x * back + sp.aim.y * 0.6, y: sp.y - sp.aim.y * back - sp.aim.x * 0.6 };
  }
  const g = oppGoal(team);
  const into = g.y === 0 ? 1 : -1;
  const ax = PITCH.width / 2 - sp.x, ay = g.y + into * 8 - sp.y;
  const d = Math.hypot(ax, ay) || 1;
  return { x: sp.x - (ax / d) * 1.1, y: sp.y - (ay / d) * 1.1 };
}

// Unit vector from the set piece position into the pitch.
function intoPitch(sp) {
  if (sp.type === 'throwin') return { x: sp.x < PITCH.width / 2 ? 1 : -1, y: 0 };
  const dx = PITCH.width / 2 - sp.x, dy = PITCH.length / 2 - sp.y;
  const d = Math.hypot(dx, dy);
  return { x: dx / d, y: dy / d };
}

function steerJoy(p, spot) {
  const a = Math.atan2(spot.y - p.y, spot.x - p.x);
  const s = Math.round(a / (Math.PI / 4));
  return {
    dx: Math.round(Math.cos(s * Math.PI / 4)), dy: Math.round(Math.sin(s * Math.PI / 4)),
    fire: false, firePressed: false, fireReleased: false, noReverse: true,
  };
}

// Text for the HUD while the human takes a set piece (or the human's keeper holds the ball).
export function setPiecePrompt(world) {
  const m = world.match;
  const sp = m.setPiece;
  if (sp && world.human && sp.team === world.human.team && sp.stage === 'ready') {
    const secs = Math.max(0, Math.ceil(sp.timer));
    if (sp.type === 'throwin') {
      return sp.ui === 'charge'
        ? { text: 'Throw-in: release Space to throw (arrow = direction)', meter: sp.charge }
        : { text: `Throw-in: hold Space for distance, arrow for direction (auto in ${secs})` };
    }
    if (sp.type === 'goalkick') return { text: `Goal kick: arrow chooses the kick, Space kicks (auto in ${secs})` };
    if (sp.type === 'freekick') {
      return sp.ui === 'height'
        ? { text: 'Free kick: release Space (arrow: diagonal = bend, side = more, back-diagonal = pass, forward = step over)', meter: sp.hold }
        : { text: 'Free kick: hold Space for height' };
    }
    if (sp.type === 'penalty') {
      return sp.ui === 'height'
        ? { text: 'Penalty: release Space (longer = higher)', pointer: sp.aimX, meter: sp.hold }
        : { text: 'Penalty: Space fixes the direction', pointer: sp.pointer || 0 };
    }
    if (sp.type === 'corner') {
      if (sp.ui === 'power' || sp.ui === 'powerSet') return { text: 'Corner: ←/→ power, Space to confirm', power: sp.power };
      if (sp.ui === 'heightWait') return { text: 'Corner: hold Space for height', power: sp.power };
      if (sp.ui === 'height') return { text: 'Corner: release Space', power: sp.power, meter: sp.hold / 1.2 };
      return { text: 'Corner: ←/→ now for bias, then aftertouch', power: sp.power };
    }
  }
  if (sp && sp.type === 'penalty' && world.human && sp.team !== world.human.team && sp.stage === 'ready' && !sp.keeperDived) {
    return { text: 'Penalty against you: arrow + Space makes your keeper dive (up = high, down = low)' };
  }
  if (world.human && m.phase === 'play') {
    const k = world.teams[world.human.team].players[0];
    if (k.state === 'hold') return { text: 'Keeper: arrow chooses the kick, Space clears' };
  }
  return null;
}
