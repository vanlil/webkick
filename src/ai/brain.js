import { DT, PITCH, tuning, currentSurface } from '../config.js';
import { tacticTarget, toWorld, toNorm } from './tactics.js';
import { oppGoal, ownGoal } from '../world/team.js';
import { fromBehind, fatigue } from '../world/player.js';

// The AI drives outfield players through the same virtual joystick as the human
// (8 directions + fire), so CPU players follow exactly the same ball rules.

const SECTOR = Math.PI / 4;
const GOAL_X0 = PITCH.width / 2 - PITCH.goalWidth / 2;
const GOAL_X1 = PITCH.width / 2 + PITCH.goalWidth / 2;

// Joysticks for all AI-driven outfield players of a team. `skip` = the human-controlled player.
export function teamJoysticks(team, world, skip, out) {
  const lvl = team.level;
  const ball = perceivedBall(world, lvl.reaction);
  const attacking = world.possession === team.id;
  const outfield = team.players.filter((p) => p.role !== 'keeper' && p !== skip && !p.sentOff);

  let chaser = null;
  let presser = null;
  const m = world.match;
  const open = !m || m.phase === 'play' || (m.phase === 'start' && m.startTeam === team.id);
  // The human's team: in fixed-player mode the AI team-mates play fully (chaser, presser);
  // in nearest mode one only goes for the ball if he is clearly quicker there than the human.
  const fixed = team.human && world.human && world.human.fixed != null;
  if (open && outfield.length && (!team.human || fixed)) {
    chaser = pickChaser(team, outfield, ball);
  } else if (open && outfield.length && skip) {
    const c = pickChaser(team, outfield, ball);
    if (intercept(c, ball).t < intercept(skip, ball).t - 0.3) chaser = c;
  }
  if (chaser && (!team.human || fixed)) {
    if (lvl.chasers > 1 && !attacking) {
      let best = Infinity;
      for (const p of outfield) {
        if (p === chaser) continue;
        const d = Math.hypot(p.x - ball.x, p.y - ball.y);
        if (d < best) { best = d; presser = p; }
      }
    }
  }

  for (const p of outfield) {
    let joy;
    // Own shot or free kick still in the air: bend it with aftertouch.
    if (p.aftertouch && (p.aftertouch.kind === 'shot' || p.aftertouch.kind === 'freekick') && p.ai.useAftertouch) {
      out.set(p, finishJoy(p, aftertouch(p, team, world.ball)));
      continue;
    }
    if (p === chaser) joy = chase(p, team, world, ball);
    else if (p === presser) joy = press(p, team, ball);
    else joy = position(p, team, ball, attacking, world);
    out.set(p, finishJoy(p, joy));
  }
}

// --- Perception -----------------------------------------------------------------------------

// The ball as the AI sees it: `reaction` seconds old, extrapolated with its old velocity.
// Straight runs are predicted well; changes of direction are noticed late.
function perceivedBall(world, reaction) {
  const h = world.history;
  const steps = Math.max(0, Math.min(h.length - 1, Math.round(reaction / DT)));
  const b = h[h.length - 1 - steps] || world.ball;
  const t = steps * DT;
  if (world.ball.heldBy) return { ...world.ball };
  return { x: b.x + b.vx * t, y: b.y + b.vy * t, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz };
}

// Where the ball will be after t seconds (rolling friction or air drag; spin ignored).
function predictBall(b, t) {
  const s = currentSurface();
  const v0 = Math.hypot(b.vx, b.vy);
  if (v0 < 0.01) return { x: b.x, y: b.y };
  let dist;
  if (b.z > 0.3) {
    dist = v0 * t * Math.exp(-tuning.ball.airDrag * t * 0.5);
  } else {
    const a = s.rollFriction, k = Math.max(0.01, s.rollDrag);
    const tStop = Math.log(1 + (k * v0) / a) / k;
    const tt = Math.min(t, tStop);
    dist = ((v0 + a / k) * (1 - Math.exp(-k * tt))) / k - (a / k) * tt;
  }
  return { x: b.x + (b.vx / v0) * dist, y: b.y + (b.vy / v0) * dist };
}

function intercept(p, b) {
  const speed = tuning.player.maxSpeed * p.pace * fatigue(p);
  let t = Math.hypot(b.x - p.x, b.y - p.y) / speed;
  let q = predictBall(b, t);
  for (let i = 0; i < 3; i++) {
    t = Math.hypot(q.x - p.x, q.y - p.y) / speed + 0.1;
    q = predictBall(b, t);
  }
  return { x: q.x, y: q.y, t };
}

// The player who reaches the ball first goes for it; keep the current one unless another is
// clearly quicker, so the chaser does not flicker.
function pickChaser(team, outfield, ball) {
  let best = null, bestT = Infinity, currentT = Infinity;
  for (const p of outfield) {
    const t = intercept(p, ball).t;
    if (t < bestT) { bestT = t; best = p; }
    if (p === team.chaser) currentT = t;
  }
  if (team.chaser && outfield.includes(team.chaser) && currentT < bestT + 0.35) return team.chaser;
  team.chaser = best;
  return best;
}

// --- Behaviours -----------------------------------------------------------------------------

// Corner positions (x offset from the goal centre towards the near post, distance from the
// goal line), in order of priority. Attackers crowd the box, defenders cover posts and zones.
const CORNER_ATTACK = [[3, 5], [-3, 6], [0, 11], [8, 12], [-8, 13], [0, 18]];
const CORNER_DEFEND = [[3.5, 1.5], [-3.5, 1.5], [0, 5], [6, 8], [-6, 8], [0, 12], [10, 14], [-10, 14]];

function cornerSpot(p, team, sp) {
  const attacking = sp.team === team.id;
  const spots = attacking ? CORNER_ATTACK : CORNER_DEFEND;
  // Who goes: attackers = forwards then midfielders; defenders = defenders then midfielders.
  const order = attacking ? ['fwd', 'mid'] : ['def', 'mid'];
  const takers = team.players
    .filter((q) => q.role !== 'keeper' && !q.sentOff && q !== sp.taker && order.includes(q.role))
    .sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role) || a.index - b.index);
  const i = takers.indexOf(p);
  if (i < 0 || i >= spots.length) return null;
  const goalY = sp.y < PITCH.length / 2 ? 0 : PITCH.length;
  const into = goalY === 0 ? 1 : -1;
  const near = Math.sign(sp.x - PITCH.width / 2) || 1;
  const [dx, dist] = spots[i];
  return { x: PITCH.width / 2 + dx * near, y: goalY + into * dist };
}

function position(p, team, ball, attacking, world) {
  const sp = world.match && world.match.setPiece;
  if (sp && sp.type === 'corner' && sp.stage !== 'dead') {
    const spot = cornerSpot(p, team, sp);
    if (spot) return steer(p, spot.x, spot.y, 0.6);
  }
  if (sp && sp.type === 'freekick' && sp.stage !== 'dead') {
    const wi = sp.wall ? sp.wall.indexOf(p) : -1;
    if (wi >= 0) return steer(p, sp.wallSpots[wi].x, sp.wallSpots[wi].y, 0.15);
    const hi = sp.helpers ? sp.helpers.indexOf(p) : -1;
    if (hi >= 0) return steer(p, sp.helperSpots[hi].x, sp.helperSpots[hi].y, 0.3);
  }
  const slot = p.index - 1;
  const n = toNorm(team.attackDir, ball.x, ball.y);
  const [tx, ty] = tacticTarget(team.tactic, slot, n.x, n.y, attacking);
  const w = toWorld(team.attackDir, tx, ty);
  // Penalty: everybody except taker and keeper outside the box and the arc.
  if (sp && sp.type === 'penalty' && sp.stage !== 'dead') {
    const goalY = sp.y < PITCH.length / 2 ? 0 : PITCH.length;
    const into = goalY === 0 ? 1 : -1;
    const minDepth = PITCH.boxDepth + 1;
    if ((w.y - goalY) * into < minDepth) w.y = goalY + into * minDepth;
    const ax = w.x - sp.x, ay = w.y - sp.y, ad = Math.hypot(ax, ay);
    if (ad < PITCH.circleRadius + 0.5) {
      w.x = sp.x + (ax / (ad || 1)) * (PITCH.circleRadius + 0.5);
      w.y = sp.y + (ay / (ad || 1)) * (PITCH.circleRadius + 0.5);
    }
    return steer(p, w.x, w.y, 1.0);
  }
  // Opponent's set piece: keep the distance from the ball.
  if (sp && sp.team !== team.id && sp.stage !== 'dead') {
    const R = sp.type === 'throwin' ? 3 : PITCH.circleRadius;
    const bx = world.ball.x, by = world.ball.y;
    const dx = w.x - bx, dy = w.y - by;
    const d = Math.hypot(dx, dy);
    if (d < R) {
      w.x = bx + (dx / (d || 1)) * R;
      w.y = by + (dy / (d || 1)) * R;
    }
  }
  return steer(p, w.x, w.y, 1.0);
}

// Second defender: stand between the ball and the own goal, a few metres from the ball.
function press(p, team, ball) {
  const g = ownGoal(team);
  const dx = g.x - ball.x, dy = g.y - ball.y;
  const d = Math.hypot(dx, dy) || 1;
  return steer(p, ball.x + (dx / d) * 4, ball.y + (dy / d) * 4, 0.8);
}

function chase(p, team, world, ball) {
  const lvl = team.level;
  const real = world.ball;

  if (hasBall(p, real)) return withBall(p, team, world);
  p.ai.plan = null;
  p.ai.turning = false;

  // Header towards the goal.
  if (lvl.headers && p.state === 'run' && real.z > 1.2 && real.vz < 0 && real.z < 3 &&
      Math.hypot(real.x - p.x, real.y - p.y) < 1.8) {
    const g = oppGoal(team);
    const d = toSector(Math.atan2(g.y - p.y, g.x - p.x));
    return { ...d, fire: true };
  }

  const slide = trySlide(p, team, world, real);
  if (slide) return slide;

  // Chasing a dribbler from behind: a sensible defender does not go through the man (foul),
  // he runs alongside and overtakes to reach the ball from the side.
  const q = real.lastTouch;
  if (q && q.team !== team.id && !real.heldBy && Math.hypot(q.x - real.x, q.y - real.y) < 1.2 &&
      Math.hypot(q.x - p.x, q.y - p.y) < 2 && fromBehind(p, q)) {
    if (p.ai.carefulFor !== q) {
      p.ai.carefulFor = q;
      p.ai.careful = world.rng.next() < team.level.tackleSense;
    }
    if (p.ai.careful) {
      const side = (p.x - q.x) * -q.fy + (p.y - q.y) * q.fx >= 0 ? 1 : -1;
      return steer(p, real.x + q.fx * 1.2 - q.fy * side * 1.1, real.y + q.fy * 1.2 + q.fx * side * 1.1, 0);
    }
  } else {
    p.ai.carefulFor = null;
  }

  const target = intercept(p, ball);
  // Arrive on the goal side of the ball's path, so the touch pushes it towards the goal.
  const g = oppGoal(team);
  const gd = Math.hypot(g.x - target.x, g.y - target.y) || 1;
  let tx = target.x, ty = target.y;
  if (Math.hypot(target.x - p.x, target.y - p.y) < 4) {
    tx -= ((g.x - target.x) / gd) * 0.35;
    ty -= ((g.y - target.y) / gd) * 0.35;
  }
  return steer(p, tx, ty, 0);
}

// Sliding tackle on an opponent who has the ball at his feet. Willingness depends on the
// level; tackles from behind (fouls) are avoided by sensible defenders, less so by aggressive ones.
function trySlide(p, team, world, ball) {
  const lvl = team.level;
  const q = ball.lastTouch;
  if (p.state !== 'run' || !q || q.team === team.id || ball.heldBy || ball.z > 0.5) return null;
  if (Math.hypot(q.x - ball.x, q.y - ball.y) > 2) return null;
  const bx = ball.x + ball.vx * 0.25, by = ball.y + ball.vy * 0.25; // where the ball will be
  const d = Math.hypot(bx - p.x, by - p.y);
  if (d < 1.0 || d > 3.0) return null;
  // Only when the ball is nearer to the tackler than to the opponent: then the slide reaches the
  // ball first (a clean tackle) instead of the man.
  if (d > Math.hypot(q.x - p.x, q.y - p.y) - 0.3) return null;
  const dx = (bx - p.x) / d, dy = (by - p.y) / d;
  const behind = dx * q.fx + dy * q.fy > 0.5 && (q.x - p.x) * q.fx + (q.y - p.y) * q.fy > 0;
  const willing = behind ? p.aggression * (1 - lvl.tackleSense) : 1;
  if (world.rng.next() > lvl.slide * willing * 0.9 * DT) return null;
  const st = toSector(Math.atan2(dy, dx));
  return { dx: st.dx, dy: st.dy, fire: true };
}

function hasBall(p, ball) {
  if (p.state === 'trap') return true;
  return ball.lastTouch === p && !ball.heldBy && ball.z < 0.6 && Math.hypot(ball.x - p.x, ball.y - p.y) < 3;
}

function withBall(p, team, world) {
  const ai = p.ai;
  const lvl = team.level;
  const ball = world.ball;
  // Opportunity: the touch just pushed the ball in a direction that is on target → shoot now.
  if (p.shotWindow > 0 && !ai.turning && ai.plan !== 'pass') {
    const shot = onTarget(p, team, world);
    if (shot) {
      ai.plan = null;
      ai.useAftertouch = world.rng.next() < lvl.aftertouch;
      ai.shotTargetX = shot.targetX;
      return { dx: 0, dy: 0, fire: true };
    }
  }

  ai.decisionTimer -= DT;
  if (ai.planTimer > 0) ai.planTimer -= DT;
  const busy = ai.turning || (ai.plan === 'pass' && ai.passPhase !== 'approach') || (ai.plan === 'shoot' && ai.planTimer > 0);
  if (!busy && (!ai.plan || ai.decisionTimer <= 0)) {
    decide(p, team, world);
    ai.decisionTimer = lvl.decision;
  }

  if (ai.plan === 'pass') return executeTrap(p, lvl, ball, 'pass');
  if (ai.turning) return executeTrap(p, lvl, ball, 'turn');

  // Ball behind the player (seen from the wanted direction): turn with a trap first.
  // A ball to the side is played round instead (drive), which keeps the game flowing.
  const bx = ball.x - p.x, by = ball.y - p.y;
  const bd = Math.hypot(bx, by);
  if (bd < 3 && bd > 0.01 && (bx * ai.dir.x + by * ai.dir.y) / bd < -0.2) {
    ai.turning = true;
    ai.passPhase = 'approach';
    ai.passTimer = 1.3;
    return executeTrap(p, lvl, ball, 'turn');
  }

  if (ai.plan === 'shoot') {
    const joy = drive(p, ball, ai.dir);
    // Fire just after the touch, when the push went in the shooting direction.
    if (p.shotWindow > 0 && p.fx * ai.dir.x + p.fy * ai.dir.y > 0.99) {
      joy.fire = true;
      ai.plan = null;
      ai.useAftertouch = world.rng.next() < lvl.aftertouch;
      ai.shotTargetX = ai.targetX;
    }
    return joy;
  }
  return drive(p, ball, ai.dir);
}

function decide(p, team, world) {
  const ai = p.ai;
  const lvl = team.level;
  const { ball, rng } = world;
  const g = oppGoal(team);
  const dGoal = Math.hypot(g.x - ball.x, g.y - ball.y);
  const opponents = world.teams[1 - team.id].players;

  if (dGoal < lvl.shootRange) {
    const shot = bestShot(ball, g, opponents, lvl);
    if (shot) {
      ai.plan = 'shoot';
      ai.dir = shot.dir;
      ai.targetX = shot.targetX;
      ai.planTimer = 2;
      return;
    }
  }

  // Leading by one goal in the last minutes: waste time. Keep the ball near the opponent's
  // corner flag, or play it back to a free team-mate.
  if (wastingTime(team, world) && dGoal > lvl.shootRange) {
    const back = bestPass(p, team, world, ownGoal(team), opponents, 18);
    if (back && rng.next() < 0.4) {
      ai.plan = 'dribble';
      ai.dir = back;
      ai.planTimer = 0.6;
      return;
    }
    const flagX = ball.x < PITCH.width / 2 ? 1 : PITCH.width - 1;
    ai.plan = 'dribble';
    ai.dir = toSectorDir(Math.atan2(g.y - ball.y, flagX - ball.x));
    return;
  }

  let nearest = Infinity;
  for (const o of opponents) nearest = Math.min(nearest, Math.hypot(o.x - p.x, o.y - p.y));
  const pressured = nearest < tuning.ai.pressureDist;
  if ((pressured || rng.next() < 0.08) && rng.next() > p.flair * 0.6) {
    // One-touch pass: a team-mate 6–15 m away in a direction the ball already runs in: the next
    // touch in that direction plays it to him (no trap needed).
    const quick = bestPass(p, team, world, g, opponents, 15);
    const bx = ball.x - p.x, by = ball.y - p.y, bd = Math.hypot(bx, by) || 1;
    if (quick && (bx * quick.x + by * quick.y) / bd > 0.55) {
      ai.plan = 'dribble';
      ai.dir = quick;
      ai.planTimer = 0.6;
      return;
    }
    const pass = bestPass(p, team, world, g, opponents);
    if (pass) {
      ai.plan = 'pass';
      ai.dir = pass;
      ai.passPhase = 'approach';
      ai.passTimer = 1.3;
      return;
    }
  }

  ai.plan = 'dribble';
  // Close to goal without a shooting line: turn the dribble towards the goal to set up a shot.
  if (dGoal < lvl.shootRange * 1.3) {
    const d = toSectorDir(Math.atan2(g.y - ball.y, g.x - ball.x));
    if (!blocked(ball, d, 5, opponents, 1.2)) {
      ai.dir = d;
      return;
    }
  }
  ai.dir = bestDribble(p, ball, g, opponents, ai.dir);
}

function wastingTime(team, world) {
  const m = world.match;
  if (!m || team.human) return false;
  const lead = world.score[team.id] - world.score[1 - team.id];
  const lastHalf = m.half === 2 || m.half === 4;
  const left = 1 - m.clock / ((m.half <= 2 ? tuning.game.halfMinutes : Math.max(1, tuning.game.halfMinutes / 3)) * 60);
  return lead === 1 && lastHalf && left < 0.15;
}

// An 8-way direction whose straight line ends between the posts (or close, if the shot can be
// bent in with aftertouch), aiming at the corner the keeper does not cover.
function bestShot(ball, g, opponents, lvl) {
  const keeper = opponents[0];
  const targetX = keeper.x < g.x ? GOAL_X1 - 0.8 : GOAL_X0 + 0.8;
  const margin = lvl.aftertouch > 0 ? 4 : -0.4;
  let best = null, bestErr = Infinity;
  for (let s = 0; s < 8; s++) {
    const d = sectorDir(s);
    if (Math.abs(d.y) < 0.1 || Math.sign(d.y) !== Math.sign(g.y - ball.y)) continue;
    const x = ball.x + (d.x / d.y) * (g.y - ball.y);
    if (x < GOAL_X0 - margin || x > GOAL_X1 + margin) continue;
    if (blocked(ball, d, Math.abs(g.y - ball.y), opponents.slice(1), 1.2)) continue;
    const err = Math.abs(x - targetX);
    if (err < bestErr) { bestErr = err; best = { dir: d, targetX }; }
  }
  return best;
}

// Is the player's facing direction (the direction of the last touch) a shot on target?
function onTarget(p, team, world) {
  const lvl = team.level;
  const ball = world.ball;
  const g = oppGoal(team);
  if (Math.hypot(g.x - ball.x, g.y - ball.y) > lvl.shootRange) return null;
  const d = { x: p.fx, y: p.fy };
  if (Math.abs(d.y) < 0.1 || Math.sign(d.y) !== Math.sign(g.y - ball.y)) return null;
  const x = ball.x + (d.x / d.y) * (g.y - ball.y);
  const opponents = world.teams[1 - team.id].players;
  const keeper = opponents[0];
  const targetX = keeper.x < g.x ? GOAL_X1 - 0.8 : GOAL_X0 + 0.8;
  const margin = lvl.aftertouch > 0 ? 4 : 0.5;
  if (x < GOAL_X0 - margin || x > GOAL_X1 + margin) return null;
  if (blocked(ball, d, Math.abs(g.y - ball.y), opponents.slice(1), 1.0)) return null;
  return { targetX };
}

// A team-mate reachable with a ground pass along one of the 8 directions.
function bestPass(p, team, world, g, opponents, maxDist = tuning.ai.passMaxDist) {
  const ball = world.ball;
  const cfg = tuning.ai;
  const goalDir = norm(g.x - ball.x, g.y - ball.y);
  let best = null, bestScore = -Infinity;
  for (const m of team.players) {
    if (m === p || m.role === 'keeper' || m.sentOff) continue;
    const mx = m.x + m.vx * 0.5, my = m.y + m.vy * 0.5;
    const vx = mx - ball.x, vy = my - ball.y;
    const d = Math.hypot(vx, vy);
    if (d < (maxDist < cfg.passMaxDist ? 6 : cfg.passMinDist) || d > maxDist) continue;
    const progress = (vx * goalDir.x + vy * goalDir.y);
    if (progress < -4) continue;
    const dir = toSectorDir(Math.atan2(vy, vx));
    const along = vx * dir.x + vy * dir.y;
    const miss = Math.abs(vx * dir.y - vy * dir.x); // how far the mate is from the pass line
    if (along <= 0 || miss > 3.5) continue;
    if (blocked(ball, dir, along, opponents, cfg.laneWidth)) continue;
    let free = 10;
    for (const o of opponents) free = Math.min(free, Math.hypot(o.x - mx, o.y - my));
    const score = progress * 0.6 + free * 0.8 - miss;
    if (score > bestScore) { bestScore = score; best = dir; }
  }
  return best;
}

function bestDribble(p, ball, g, opponents, current) {
  const goalDir = norm(g.x - ball.x, g.y - ball.y);
  let best = null, bestScore = -Infinity;
  for (let s = 0; s < 8; s++) {
    const d = sectorDir(s);
    let score = (d.x * goalDir.x + d.y * goalDir.y) * 2;
    for (const o of opponents) {
      const rx = o.x - ball.x, ry = o.y - ball.y;
      const along = rx * d.x + ry * d.y;
      if (along < -1 || along > 9) continue;
      const side = Math.abs(rx * d.y - ry * d.x);
      score -= Math.max(0, 1 - side / 3) * (1 - along / 12) * 1.5;
    }
    // Stay on the pitch.
    const ax = ball.x + d.x * 6, ay = ball.y + d.y * 6;
    if (ax < 2 || ax > PITCH.width - 2) score -= 3;
    if ((ay < 1 || ay > PITCH.length - 1) && (ax < GOAL_X0 - 6 || ax > GOAL_X1 + 6)) score -= 3;
    if (current && current.x === d.x && current.y === d.y) score += 0.3;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

// Trap, aim, release: the same steps a human uses. mode 'pass' releases fire with the stick
// held (a pass); mode 'turn' releases it with the stick centred (keeps the ball, now facing
// the new direction).
function executeTrap(p, lvl, ball, mode) {
  const ai = p.ai;
  ai.passTimer -= DT;
  if (ai.passTimer <= 0) {
    ai.plan = null;
    ai.turning = false;
    return { dx: 0, dy: 0, fire: false };
  }
  if (ai.passPhase === 'approach') {
    if (p.state === 'trap') {
      ai.passPhase = 'aim';
      ai.aimTimer = lvl.passAim;
    } else {
      // Hold fire to trap the ball at the next touch, but not while fire would still
      // turn the last touch into a shot.
      const j = steer(p, ball.x, ball.y, 0);
      return { ...j, fire: p.shotWindow <= 0 };
    }
  }
  if (ai.passPhase === 'aim') {
    ai.aimTimer -= DT;
    // Release only when the player has finished turning to the new direction.
    const aligned = p.fx * ai.dir.x + p.fy * ai.dir.y > 0.97;
    if (ai.aimTimer <= 0 && aligned) ai.passPhase = 'release';
    return { dx: ai.dir.x ? Math.sign(ai.dir.x) : 0, dy: ai.dir.y ? Math.sign(ai.dir.y) : 0, fire: true };
  }
  if (mode === 'turn') {
    ai.turning = false;
    return { dx: 0, dy: 0, fire: false };
  }
  ai.plan = null;
  return { dx: ai.dir.x ? Math.sign(ai.dir.x) : 0, dy: ai.dir.y ? Math.sign(ai.dir.y) : 0, fire: false };
}

// Dribble in direction d: run in d while the ball is just ahead; otherwise first get behind
// the ball (seen from d), so the next touch pushes it the right way.
function drive(p, ball, d) {
  const bx = ball.x - p.x, by = ball.y - p.y;
  const dist = Math.hypot(bx, by);
  if (dist < 1.6 && dist > 0.01 && (bx * d.x + by * d.y) / dist > 0.55) {
    return { dx: Math.sign(Math.round(d.x * 2)), dy: Math.sign(Math.round(d.y * 2)), fire: false };
  }
  const behindX = ball.x - d.x * 0.7, behindY = ball.y - d.y * 0.7;
  // On the wrong side of the ball: go round it, not through it.
  if (bx * d.x + by * d.y < 0) {
    const sx = -d.y, sy = d.x;
    const side = (p.x - ball.x) * sx + (p.y - ball.y) * sy >= 0 ? 1 : -1;
    return steer(p, behindX + sx * side * 1.0, behindY + sy * side * 1.0, 0);
  }
  return steer(p, behindX, behindY, 0);
}

// Aftertouch for an AI shot: bend the ball towards the chosen corner, dip it under the bar.
function aftertouch(p, team, ball) {
  const at = p.aftertouch;
  const g = oppGoal(team);
  if (Math.abs(ball.vy) < 1) return { dx: 0, dy: 0, fire: false };
  const t = (g.y - ball.y) / ball.vy;
  if (t <= 0) return { dx: 0, dy: 0, fire: false };
  const px = ball.x + ball.vx * t;
  const pz = ball.z + ball.vz * t - 0.5 * tuning.ball.gravity * t * t;
  const err = p.ai.shotTargetX - px;
  const rx = -at.dy, ry = at.dx; // stick direction that bends the ball towards +r
  if (Math.abs(err) > 0.4 && Math.abs(rx) > 0.3) {
    const s = Math.sign(err) * Math.sign(rx);
    return { dx: Math.sign(Math.round(rx * s * 2)), dy: Math.sign(Math.round(ry * s * 2)), fire: false };
  }
  if (pz > PITCH.goalHeight - 0.2) return { dx: Math.sign(Math.round(at.dx * 2)), dy: Math.sign(Math.round(at.dy * 2)), fire: false };
  return { dx: 0, dy: 0, fire: false };
}

// --- Helpers --------------------------------------------------------------------------------

// Steer towards a point with the 8-way stick. Keeps the last direction while it is still
// within ~26° of the ideal one, so players do not zigzag between two directions every step.
function steer(p, tx, ty, stop) {
  const dx = tx - p.x, dy = ty - p.y;
  if (Math.hypot(dx, dy) < stop) {
    p.ai.lastSector = null;
    return { dx: 0, dy: 0, fire: false };
  }
  const angle = Math.atan2(dy, dx);
  let sector = Math.round(angle / SECTOR);
  const last = p.ai.lastSector;
  if (last !== null && Math.abs(angleDiff(angle, last * SECTOR)) < 0.45) sector = last;
  p.ai.lastSector = sector;
  const d = sectorStick(sector);
  return { dx: d.dx, dy: d.dy, fire: false };
}

function finishJoy(p, joy) {
  const fire = !!joy.fire;
  const out = {
    dx: joy.dx || 0, dy: joy.dy || 0, fire,
    firePressed: fire && !p.ai.prevFire, fireReleased: !fire && p.ai.prevFire,
    noReverse: !joy.reverse, // the AI never lobs by accident
  };
  p.ai.prevFire = fire;
  return out;
}

function blocked(ball, d, length, opponents, width) {
  for (const o of opponents) {
    const rx = o.x - ball.x, ry = o.y - ball.y;
    const along = rx * d.x + ry * d.y;
    if (along < 0.5 || along > length) continue;
    if (Math.abs(rx * d.y - ry * d.x) < width) return true;
  }
  return false;
}

function sectorStick(s) {
  const a = s * SECTOR;
  return { dx: Math.round(Math.cos(a)), dy: Math.round(Math.sin(a)) };
}

function sectorDir(s) {
  const { dx, dy } = sectorStick(s);
  return dx && dy ? { x: dx * Math.SQRT1_2, y: dy * Math.SQRT1_2 } : { x: dx, y: dy };
}

function toSectorDir(angle) {
  return sectorDir(Math.round(angle / SECTOR));
}

function toSector(angle) {
  const s = sectorStick(Math.round(angle / SECTOR));
  return { dx: s.dx, dy: s.dy };
}

function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function norm(x, y) {
  const d = Math.hypot(x, y) || 1;
  return { x: x / d, y: y / d };
}
