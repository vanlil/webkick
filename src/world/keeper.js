import { DT, PITCH, tuning } from '../config.js';
import { bodyBlock, canTouch } from './player.js';
import { createBall, stepBall } from './ball.js';
import { ownGoal, inOwnBox } from './team.js';

// CPU goalkeeper. States: 'guard' (positioning), 'rush' (coming out for a loose ball),
// 'dive', 'down' (on the ground after a dive), 'hold' (ball in the hands).
// The keeper reacts to a shot only after his reaction time, and predicts a straight path:
// a ball bent with aftertouch can beat him.

export function stepKeeper(k, team, world) {
  const { ball } = world;
  const goal = ownGoal(team);
  const lvl = team.level;
  const ai = k.ai;

  for (const t of ['touchTimer', 'kickTimer']) if (k[t] > 0) k[t] -= DT;

  // A new touch by an opponent starts the reaction time.
  if (ball.touchSeq !== ai.seenSeq) {
    ai.seenSeq = ball.touchSeq;
    if (ball.lastTouch && ball.lastTouch.team !== team.id) ai.reactTimer = lvl.keeperReaction;
  }
  if (ai.reactTimer > 0) ai.reactTimer -= DT;

  if (!k.state || k.state === 'run') k.state = 'guard';

  switch (k.state) {
    case 'hold': stepHold(k, team, world, goal); break;
    case 'penalty': stepPenalty(k, world, goal); break;
    case 'dive': stepDive(k, world); break;
    case 'down': stepDown(k); break;
    default: stepGuard(k, team, world, goal);
  }

  if (k.state !== 'hold') tryCatch(k, team, world, goal);
  if (k.state !== 'hold') bodyBlock(k, ball, world);
  keepInBox(k, goal);
}

function stepGuard(k, team, world, goal) {
  const { ball } = world;
  const kp = tuning.keeper;
  const ai = k.ai;
  let tx, ty;

  const threat = shotThreat(k, ball, goal);
  if (threat && ai.reactTimer <= 0) {
    const dx = threat.x - k.x;
    // Too far to reach by stepping across in time: dive.
    if (threat.t < 0.5 && Math.abs(dx) > kp.reach * 0.8) {
      k.state = 'dive';
      k.stateTimer = kp.diveTime;
      k.diveDir = Math.sign(dx);
      k.vx = k.diveDir * Math.min(kp.diveSpeed, Math.abs(dx) / Math.max(threat.t, 0.12));
      k.vy = 0;
      k.diveHeight = Math.min(1.6, Math.max(0, threat.z - 0.5));
      return;
    }
    tx = threat.x;
    ty = k.y;
  } else if (ai.reactTimer <= 0 && shouldRush(k, team, world)) {
    tx = ball.x;
    ty = ball.y;
  } else if (ai.reactTimer <= 0 || ai.tx === undefined) {
    // Stand on the line from the goal centre to the ball; further out when the ball is close.
    const bx = ball.x - goal.x;
    const by = ball.y - goal.y;
    const d = Math.hypot(bx, by) || 1;
    const out = Math.min(4.5, Math.max(1, d * 0.12));
    tx = goal.x + (bx / d) * out;
    ty = goal.y + (by / d) * out;
  } else {
    tx = ai.tx;
    ty = ai.ty;
  }
  ai.tx = tx;
  ai.ty = ty;
  moveTo(k, tx, ty, kp.speed, kp.accel);
  k.fx = Math.sign(ball.x - k.x) * 0.3;
  k.fy = goal.into;
  const n = Math.hypot(k.fx, k.fy);
  k.fx /= n;
  k.fy /= n;
}

// Ball heading for the goal: where and when does it cross the keeper's line? The keeper runs
// the ball physics ahead (air drag, bounces) but does not read spin: a shot bent with
// aftertouch still beats him.
const NO_RNG = { next: () => 0.5, range: (a, b) => (a + b) / 2 };
const ghost = createBall(0, 0);
function shotThreat(k, ball, goal) {
  const towards = -ball.vy * goal.into; // speed towards the goal line
  if (towards < 3 || Math.abs(ball.y - goal.y) > 40) return null;
  Object.assign(ghost, { x: ball.x, y: ball.y, z: ball.z, vx: ball.vx, vy: ball.vy, vz: ball.vz, spin: 0, inGoal: -1 });
  const sink = [];
  for (let t = DT; t < 1.6; t += DT) {
    const before = (ghost.y - k.y) * goal.into;
    stepBall(ghost, NO_RNG, sink);
    sink.length = 0;
    if ((ghost.y - k.y) * goal.into <= 0 && before > 0) {
      if (Math.abs(ghost.x - goal.x) > PITCH.goalWidth / 2 + 1.5 || ghost.z > PITCH.goalHeight + 0.5) return null;
      return { x: ghost.x, z: ghost.z, t };
    }
  }
  return null;
}

// Come out for a loose ball in the box if the keeper gets there first.
function shouldRush(k, team, world) {
  const { ball } = world;
  if (!inOwnBox(team, ball.x, ball.y) || Math.hypot(ball.vx, ball.vy) > 9 || ball.z > 2) return false;
  const kt = Math.hypot(ball.x - k.x, ball.y - k.y) / tuning.keeper.speed;
  let best = Infinity;
  for (const t of world.teams) {
    if (t.id === team.id) continue;
    for (const p of t.players) {
      best = Math.min(best, Math.hypot(ball.x - p.x, ball.y - p.y) / (tuning.player.maxSpeed * p.pace));
    }
  }
  return kt < best - 0.15;
}

// Facing a penalty: wait on the line until the kick; if he did not dive, back to normal
// shortly after.
function stepPenalty(k, world, goal) {
  k.vx = k.vy = 0;
  k.x = goal.x;
  k.y = goal.y + goal.into * 0.3;
  k.fx = 0;
  k.fy = goal.into;
  if (world.match && world.match.phase !== 'setpiece') {
    k.penaltyTimer = (k.penaltyTimer || 0) + DT;
    if (k.penaltyTimer > 1) {
      k.state = 'guard';
      k.penaltyTimer = 0;
    }
  }
}

// Penalty dive: side −1/0/1 (0 = stay in the middle), height of the jump in metres.
// `speed` (optional): lateral dive speed, so a CPU keeper arrives at his chosen point.
// A human's dive stops extending when he lets go of fire ("longer press = bigger move").
export function penaltyDive(k, side, height, human, speed = tuning.keeper.diveSpeed) {
  const kp = tuning.keeper;
  k.state = 'dive';
  k.stateTimer = kp.diveTime;
  k.diveDir = side;
  k.vx = side * Math.min(speed, kp.diveSpeed * 1.2);
  k.vy = 0;
  k.diveHeight = height;
  k.humanDive = human;
  k.penaltyTimer = 0;
}

function stepDive(k, world) {
  const kp = tuning.keeper;
  if (k.humanDive && world.humanJoy && !world.humanJoy.fire) k.vx *= 0.75;
  k.stateTimer -= DT;
  const t = 1 - Math.max(0, k.stateTimer) / kp.diveTime;
  k.z = k.diveHeight * Math.sin(Math.PI * Math.min(1, t * 1.2));
  k.diveAngle = k.diveDir * Math.min(1.3, t * 3);
  k.x += k.vx * DT;
  if (k.stateTimer <= 0) {
    k.state = 'down';
    k.stateTimer = kp.downTime;
    k.z = 0;
    k.humanDive = false;
  }
}

function stepDown(k) {
  k.stateTimer -= DT;
  k.vx *= 0.8;
  k.x += k.vx * DT;
  if (k.stateTimer <= 0) {
    k.state = 'guard';
    k.diveAngle = 0;
    k.vx = k.vy = 0;
  }
}

// Catch (or parry) a ball within reach, only inside the own penalty box.
function tryCatch(k, team, world, goal) {
  const { ball, rng, events } = world;
  const kp = tuning.keeper;
  // Just after landing from a dive, the outstretched keeper can still push the ball away.
  const landed = k.state === 'down' && k.stateTimer > kp.downTime - 0.35;
  if ((k.state === 'down' && !landed) || k.touchTimer > 0 || !canTouch(k, ball, world)) return;
  if (!inOwnBox(team, ball.x, ball.y) || ball.z > kp.catchHeight) return;
  const diving = k.state === 'dive' || landed;
  const hx = k.x + (diving ? (k.diveDir || 0) * 0.6 : 0);
  const reach = diving ? kp.diveReach : kp.reach;
  if (Math.hypot(ball.x - hx, ball.y - k.y) > reach) return;
  if (!diving && ball.z > 2.3) return;
  if (landed && ball.z > 1) return;

  const speed = Math.hypot(ball.vx, ball.vy, ball.vz);
  const own = ball.lastTouch && ball.lastTouch.team === team.id;
  // Hard, high and diving saves are harder to hold: then the keeper only parries.
  const high = Math.max(0, ball.z - 1.5) * 0.35;
  let pCatch = own ? 1 : Math.min(0.9, Math.max(0.05, team.level.keeperSkill - speed / 40 - high - (diving ? 0.12 : 0)));
  if (landed) pCatch = 0; // lying on the ground: parry only
  ball.touchSeq++;
  ball.lastTouch = k;
  ball.touchStep = world.step;
  if (rng.next() < pCatch) {
    k.state = 'hold';
    k.stateTimer = team.human ? tuning.setpiece.humanAuto : kp.holdTime;
    k.diveAngle = 0;
    k.z = 0;
    k.vx = k.vy = 0;
    ball.heldBy = k;
    ball.vx = ball.vy = ball.vz = 0;
    ball.spin = 0;
    events.push({ type: 'catch' });
  } else {
    // Parry: push the ball away from the goal and wide, often round the post for a corner.
    const wide = Math.sign(ball.x - goal.x) || (rng.next() < 0.5 ? -1 : 1);
    ball.vy = goal.into * Math.max(2, Math.abs(ball.vy) * rng.range(0.1, 0.35));
    ball.vx = wide * rng.range(4, 10);
    ball.vz = rng.range(1.5, 4);
    ball.spin = 0;
    k.touchTimer = 0.5;
    events.push({ type: 'save' });
  }
}

// Holding the ball: wait, then throw or kick it to a team-mate. The human's keeper can clear
// it earlier with a stick direction + fire (9 kick types).
function stepHold(k, team, world, goal) {
  const { ball } = world;
  k.vx = k.vy = 0;
  ball.x = k.x + goal.into * 0.1;
  ball.y = k.y + goal.into * 0.35;
  ball.z = 1.0;
  ball.vx = ball.vy = ball.vz = 0;
  k.fx = 0;
  k.fy = goal.into;
  // During a set piece (goal kick) the set piece code decides when he kicks.
  if (world.match && world.match.phase !== 'play') return;
  if (team.human && world.humanJoy && world.human && world.human.fixed == null) {
    if (world.humanJoy.firePressed) {
      clearance(k, team, world, world.humanJoy);
      return;
    }
  }
  k.stateTimer -= DT;
  if (k.stateTimer > 0) return;
  distribute(k, team, world, false);
}

// CPU: throw to a free team-mate nearby, or kick long. `forceKick` for goal kicks.
export function distribute(k, team, world, forceKick) {
  const { ball, rng, events } = world;
  const kp = tuning.keeper;
  const throwTarget = forceKick ? null : pickTarget(k, team, world, false);
  const throwIt = throwTarget && Math.hypot(throwTarget.x - ball.x, throwTarget.y - ball.y) < 28;
  const target = throwIt ? throwTarget : pickTarget(k, team, world, true);
  const dx = target.x - ball.x;
  const dy = target.y - ball.y;
  const d = Math.hypot(dx, dy) || 1;
  let vh, vz;
  if (throwIt) {
    // Throw: flat arc that lands at the team-mate.
    vh = Math.min(18, Math.max(10, d * 0.9));
    const T = d / vh;
    vz = (0.5 * tuning.ball.gravity * T * T - ball.z) / T;
    events.push({ type: 'throw' });
  } else {
    // Kick: a high arc whose length matches the distance to the team-mate (a little extra for
    // air drag), never more than the keeper's kicking power.
    vz = kp.kickLift;
    const T = (2 * vz) / tuning.ball.gravity;
    vh = Math.min(kp.kickSpeed * (0.85 + 0.15 * team.level.keeperSkill), (d / T) * 1.12);
    events.push({ type: 'clearance' });
  }
  const err = rng.range(-0.05, 0.05);
  release(k, world, (dx / d) * vh + err * vh, (dy / d) * vh, vz);
}

// Human clearance: forward/back on the stick = strong/weak (centre = medium), sideways = angle.
// "Forward" means towards the opponent's goal.
export function clearance(k, team, world, joy) {
  const f = joy.dy * team.attackDir; // +1 forward, 0 centre, -1 back
  const side = joy.dx;
  const [angle, vh, vz] =
    f > 0 ? [side ? 0.52 : 0, 25, 12] :
    f < 0 ? [side ? 0.7 : 0, 12, 5] :
    [side ? 0.96 : 0, 19, 9];
  const power = 0.85 + 0.15 * team.level.keeperSkill;
  const vx = Math.sin(angle) * side * vh * power;
  const vy = Math.cos(angle) * team.attackDir * vh * power;
  world.events.push({ type: 'clearance' });
  release(k, world, vx, vy, vz * power);
}

function release(k, world, vx, vy, vz) {
  const { ball } = world;
  ball.vx = vx;
  ball.vy = vy;
  ball.vz = vz;
  ball.heldBy = null;
  ball.touchSeq++;
  ball.lastTouch = k;
  ball.touchStep = world.step;
  k.state = 'guard';
  k.touchTimer = 0.8;
  k.kickTimer = 0.2;
}

// Free team-mate, not near an opponent. Throws: 8–28 m, never backwards. Kicks: at least 15 m
// up the pitch and at most ~55° off the forward direction, so a goal kick never goes out
// sideways; if nobody fits, a long kick up the middle.
function pickTarget(k, team, world, kick) {
  let best = null;
  let bestScore = -Infinity;
  const opponents = world.teams.find((t) => t.id !== team.id).players;
  for (const p of team.players) {
    if (p === k || p.sentOff) continue;
    const dx = p.x - k.x, dy = p.y - k.y;
    const d = Math.hypot(dx, dy);
    const progress = dy * team.attackDir; // metres up the pitch
    if (d < 8 || progress < 0) continue;
    if (kick && (progress < 15 || progress < Math.abs(dx) * 0.7)) continue;
    let free = 12;
    for (const o of opponents) free = Math.min(free, Math.hypot(o.x - p.x, o.y - p.y));
    const score = kick
      ? free * 1.2 + progress * 0.15 - Math.abs(p.x - PITCH.width / 2) * 0.05
      : free * 1.2 - Math.abs(d - 18) * 0.25;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  if (best) return best;
  return kick
    ? { x: PITCH.width / 2 + (k.x - PITCH.width / 2) * 0.3, y: k.y + team.attackDir * 45 }
    : null;
}

function moveTo(k, tx, ty, maxSpeed, accel) {
  const dx = tx - k.x;
  const dy = ty - k.y;
  const d = Math.hypot(dx, dy);
  // Slow down near the target so the keeper does not overshoot.
  const speed = Math.min(maxSpeed, d * 4);
  const vx = d > 0.02 ? (dx / d) * speed : 0;
  const vy = d > 0.02 ? (dy / d) * speed : 0;
  const ddx = vx - k.vx, ddy = vy - k.vy;
  const dv = Math.hypot(ddx, ddy);
  const maxDv = accel * DT;
  if (dv <= maxDv) { k.vx = vx; k.vy = vy; }
  else { k.vx += (ddx / dv) * maxDv; k.vy += (ddy / dv) * maxDv; }
  k.x += k.vx * DT;
  k.y += k.vy * DT;
  k.runPhase += Math.hypot(k.vx, k.vy) * DT * 2.4;
}

function keepInBox(k, goal) {
  const halfW = PITCH.boxWidth / 2;
  k.x = Math.min(goal.x + halfW, Math.max(goal.x - halfW, k.x));
  const depth = (k.y - goal.y) * goal.into;
  const clamped = Math.min(PITCH.boxDepth, Math.max(0.3, depth));
  k.y = goal.y + clamped * goal.into;
}
