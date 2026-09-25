import { DT, PITCH, tuning } from '../config.js';
import { ownGoal, oppGoal } from '../world/team.js';
import { distribute, clearance } from '../world/keeper.js';
import { launchBall } from '../world/player.js';

// Throw-ins, corners and goal kicks. Stages:
//   'dead'  ball still rolling out, nobody can touch it
//   'walk'  ball placed; the taker walks to it, the others take position
//   'ready' human: the set piece controls below; CPU: takes it after a short delay
// The human team's set pieces use the human's stick; the CPU's are automatic.

const HOLD = { restart: true }; // ball.heldBy marker: nobody can touch the ball
const IDLE = { dx: 0, dy: 0, fire: false, firePressed: false, fireReleased: false };

export function startSetPiece(world, type, teamId, x, y, events) {
  const m = world.match;
  m.phase = 'setpiece';
  m.setPiece = { type, team: teamId, x, y, stage: 'dead', timer: tuning.setpiece.deadTime, taker: null, ui: null };
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
    sp.stage = 'walk';
    sp.timer = cfg.walkTimeout;
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
      const into = intoPitch(sp);
      t.fx = into.x;
      t.fy = into.y;
    }
    sp.stage = 'ready';
    sp.timer = human ? cfg.humanAuto : cfg.cpuDelay;
    sp.ui = sp.type === 'corner' ? 'power' : 'wait';
    sp.power = 5;
    sp.prevDx = 0;
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
  if (human) playerControls(world, sp, team, humanJoy);
  else if (sp.timer <= 0) cpuTake(world, sp, team);
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
      if (p.role === 'keeper' || p === sp.taker) continue;
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

function finish(world) {
  world.ball.dead = false;
  world.match.phase = 'play';
  world.match.setPiece = null;
}

// --- Placement ------------------------------------------------------------------------------

function placeBall(world, sp, team) {
  const { ball } = world;
  Object.assign(ball, { vx: 0, vy: 0, vz: 0, z: 0, spin: 0, dead: false });
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
  let best = team.players[1], bestD = Infinity;
  for (const p of team.players) {
    if (p.role === 'keeper') continue;
    const d = Math.hypot(p.x - sp.x, p.y - sp.y);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

// Where the taker stands: on the touchline for a throw-in, behind the ball for a corner.
function takerSpot(sp, team) {
  if (sp.type === 'throwin') return { x: sp.x < PITCH.width / 2 ? -0.3 : PITCH.width + 0.3, y: sp.y };
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
    if (sp.type === 'corner') {
      if (sp.ui === 'power' || sp.ui === 'powerSet') return { text: 'Corner: ←/→ power, Space to confirm', power: sp.power };
      if (sp.ui === 'heightWait') return { text: 'Corner: hold Space for height', power: sp.power };
      if (sp.ui === 'height') return { text: 'Corner: release Space', power: sp.power, meter: sp.hold / 1.2 };
      return { text: 'Corner: ←/→ now for bias, then aftertouch', power: sp.power };
    }
  }
  if (world.human && m.phase === 'play') {
    const k = world.teams[world.human.team].players[0];
    if (k.state === 'hold') return { text: 'Keeper: arrow chooses the kick, Space clears' };
  }
  return null;
}
