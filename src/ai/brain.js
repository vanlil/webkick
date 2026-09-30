import { DT, PITCH, tuning, currentSurface } from '../config.js';
import { oppGoal, ownGoal } from '../world/team.js';
import { fromBehind, fatigue, holdForSpeed, speedForDistance } from '../world/player.js';
import {
  PASS_DIRS, zoneValue, depthOf, passChance, carryChance, reachTime, updateTeamState, lossWeight,
  planSupport, planMarking, homeSpot, coverSpot, pressTrigger,
} from './teamplay.js';

// The AI drives outfield players through the same virtual joystick as the human
// (8 directions + fire), so CPU players follow exactly the same ball rules.

const SECTOR = Math.PI / 4;
const GOAL_X0 = PITCH.width / 2 - PITCH.goalWidth / 2;
const GOAL_X1 = PITCH.width / 2 + PITCH.goalWidth / 2;

// Joysticks for all AI-driven outfield players of a team. `skip` = the human-controlled player.
export function teamJoysticks(team, world, skip, out) {
  const lvl = team.level;
  const ball = perceivedBall(world, lvl.reaction);
  // A keeper holds the ball: nobody goes for it. His team-mates spread out to receive the
  // throw or kick; the other team drops back into its defensive shape.
  const keeperBall = world.ball.heldBy;
  const attacking = keeperBall ? keeperBall.team === team.id : world.possession === team.id;
  const outfield = team.players.filter((p) => p.role !== 'keeper' && p !== skip && !p.sentOff);
  const st = updateTeamState(team, world);

  let chaser = null;
  let presser = null;
  let presserHunts = false;
  const m = world.match;
  const open = !keeperBall && (!m || m.phase === 'play' || (m.phase === 'start' && m.startTeam === team.id));
  // The human's team: in fixed-player mode the AI team-mates play fully (chaser, presser);
  // in nearest mode one only goes for the ball if he is clearly quicker there than the human.
  const fixed = team.human && world.human && world.human.fixed != null;
  // The dribbler keeps the ball even when it runs ahead of him closer to a team-mate, unless
  // his last touch was a pass on the move (then the receiver goes for it).
  const owner = world.ball.lastTouch;
  const ownerKeeps = owner && owner.team === team.id && outfield.includes(owner) && hasBall(owner, world.ball) &&
    !passReleased(owner, world.ball);
  // The human has the ball (fixed-player mode): no team-mate goes for it; they offer themselves.
  const humanHasBall = team.human && skip && hasBall(skip, world.ball);
  if (open && outfield.length && (!team.human || fixed) && !humanHasBall) {
    chaser = ownerKeeps ? owner : pickChaser(team, outfield, ball);
    if (ownerKeeps) team.chaser = owner;
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
      // The second man hunts the ball right after losing it (counter-press) or on a press
      // trigger; otherwise he blocks the most dangerous pass lane (cover shadow).
      const oppCarrier = world.ball.lastTouch && world.ball.lastTouch.team !== team.id ? world.ball.lastTouch : null;
      presserHunts = (st.phase === 'counterpress' && lvl.counterPress) || (lvl.pressTriggers && pressTrigger(world, oppCarrier));
    }
  }

  // Team play in open play: support and runs around our ball carrier (an AI player or the
  // human), marking near our goal when defending.
  if (open) {
    const carrier = team.players.find((p) => !p.sentOff && p.role !== 'keeper' && hasBall(p, world.ball));
    const free = outfield.filter((p) => p !== chaser && p !== presser);
    if (attacking && carrier) planSupport(team, world, carrier, free, lvl, st);
    else if (!attacking) { st.support.clear(); st.runs.clear(); }
    st.markTimer = (st.markTimer || 0) - DT;
    if (!attacking && st.markTimer <= 0) { planMarking(team, world, free, st, lvl); st.markTimer = 0.4; }
    if (attacking) st.marks.clear();
  } else {
    st.support.clear(); st.runs.clear(); st.marks.clear();
  }

  for (const p of outfield) {
    let joy;
    // Own shot or free kick still in the air: bend it with aftertouch.
    if (p.aftertouch && (p.aftertouch.kind === 'shot' || p.aftertouch.kind === 'freekick') && p.ai.useAftertouch) {
      out.set(p, finishJoy(p, aftertouch(p, team, world.ball)));
      continue;
    }
    if (p === chaser) joy = chase(p, team, world, ball);
    else {
      p.ai.plan = null; // not on the ball: forget any plan
      p.ai.turning = false;
      const role = open && (st.support.get(p) || st.runs.get(p) || st.marks.get(p));
      if (p === presser) joy = presserHunts ? huntBall(p, ball) : press(p, team, world, ball);
      else if (role) joy = steer(p, role.x, role.y, st.runs.has(p) ? 0 : 0.8);
      else joy = position(p, team, ball, attacking, world, st);
    }
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

// Own throw-in: the nearest team-mate offers himself forward along the line, the second one
// square, further infield.
function throwSpot(p, team, sp) {
  const mates = team.players.filter((q) => q.role !== 'keeper' && !q.sentOff && q !== sp.taker)
    .sort((a, b) => Math.hypot(a.x - sp.x, a.y - sp.y) - Math.hypot(b.x - sp.x, b.y - sp.y));
  const i = mates.indexOf(p);
  if (i < 0 || i > 1) return null;
  const infield = sp.x < PITCH.width / 2 ? 1 : -1;
  const fwd = team.attackDir; // +1: attacks towards y = length
  // Forward, but not into the corner: at least 12 m from the opponent's goal line.
  const toLine = fwd > 0 ? PITCH.length - sp.y : sp.y;
  const ahead = Math.max(-4, Math.min(9, toLine - 12));
  const spot = i === 0 ? { x: sp.x + infield * 5, y: sp.y + fwd * ahead } : { x: sp.x + infield * 10, y: sp.y + fwd * Math.min(2, ahead) };
  return { x: Math.min(PITCH.width - 2, Math.max(2, spot.x)), y: Math.min(PITCH.length - 3, Math.max(3, spot.y)) };
}

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

function position(p, team, ball, attacking, world, st) {
  const sp = world.match && world.match.setPiece;
  if (sp && sp.type === 'corner' && sp.stage !== 'dead') {
    const spot = cornerSpot(p, team, sp);
    if (spot) return steer(p, spot.x, spot.y, 0.6);
  }
  if (sp && sp.type === 'throwin' && sp.stage !== 'dead' && sp.team === team.id && p !== sp.taker) {
    const spot = throwSpot(p, team, sp);
    if (spot) return steer(p, spot.x, spot.y, 0.5);
  }
  if (sp && sp.type === 'freekick' && sp.stage !== 'dead') {
    const wi = sp.wall ? sp.wall.indexOf(p) : -1;
    if (wi >= 0) return steer(p, sp.wallSpots[wi].x, sp.wallSpots[wi].y, 0.15);
    const hi = sp.helpers ? sp.helpers.indexOf(p) : -1;
    if (hi >= 0) return steer(p, sp.helperSpots[hi].x, sp.helperSpots[hi].y, 0.3);
  }
  const w = homeSpot(p, team, ball, attacking, sp ? null : st);
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

// Second defender: block the most dangerous pass lane (cover shadow), or else stand between
// the ball and the own goal, a few metres from the ball.
function press(p, team, world, ball) {
  const carrier = world.ball.lastTouch && world.ball.lastTouch.team !== team.id ? world.ball.lastTouch : null;
  const cover = carrier && coverSpot(team, world, carrier);
  if (cover) return steer(p, cover.x, cover.y, 0.6);
  const g = ownGoal(team);
  const dx = g.x - ball.x, dy = g.y - ball.y;
  const d = Math.hypot(dx, dy) || 1;
  return steer(p, ball.x + (dx / d) * 4, ball.y + (dy / d) * 4, 0.8);
}

// Go straight for the ball (the second presser on a trigger).
function huntBall(p, ball) {
  const t = intercept(p, ball);
  return steer(p, t.x, t.y, 0);
}

function chase(p, team, world, ball) {
  const lvl = team.level;
  const real = world.ball;

  if (hasBall(p, real)) return withBall(p, team, world);
  p.ai.plan = null;
  p.ai.turning = false;
  p.ai.carryTime = 0;

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

  // An opponent has the ball at his feet: contain him. Stand goal-side at a short distance and
  // go in only when the ball comes free (a touch too far), when it is nearer to us than to him,
  // or after waiting too long. A defender who runs straight into the carrier gets dribbled or
  // fouls; this gives the attack time and the game its rhythm.
  if (q && q.team !== team.id && !real.heldBy && !real.kicked && real.z < 0.5 &&
      Math.hypot(q.x - real.x, q.y - real.y) < 2.4 && q.role !== 'keeper') {
    const dBall = Math.hypot(real.x - p.x, real.y - p.y), dThem = Math.hypot(real.x - q.x, real.y - q.y);
    if (p.ai.containFor !== q) { p.ai.containFor = q; p.ai.containTime = 0; }
    p.ai.containTime += DT;
    const eager = dBall < dThem - 0.25 || p.ai.containTime > (lvl.containTime ?? 1.6) || q.state === 'trap' && p.ai.containTime > 0.8;
    if (!eager) {
      const og = ownGoal(team);
      const gx = og.x - q.x, gy = og.y - q.y, gd = Math.hypot(gx, gy) || 1;
      const stand = lvl.containDist ?? 2.2;
      return steer(p, q.x + (gx / gd) * stand, q.y + (gy / gd) * stand, 0.35);
    }
  } else {
    p.ai.containFor = null;
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
  const joy = steer(p, tx, ty, 0);
  // Receiving a ball that comes at him: hold fire before the contact, so the first touch stops
  // it (a trap) instead of knocking it back the way it came.
  // Only when facing his own half: facing forward, he takes the ball on in his stride.
  const rx = p.x - real.x, ry = p.y - real.y, rd = Math.hypot(rx, ry);
  const bs = Math.hypot(real.vx, real.vy);
  const og = ownGoal(team);
  const facingBack = (p.fx * (og.x - p.x) + p.fy * (og.y - p.y)) / (Math.hypot(og.x - p.x, og.y - p.y) || 1) > 0.2;
  // Also when a touch in his facing direction would push the ball out of play (e.g. receiving
  // a throw-in while facing the touchline).
  const facingOut = !inside(p.x + p.fx * 9, p.y + p.fy * 9, 0);
  if ((facingBack || facingOut) && rd < 3.5 && bs > 3 && real.z < 1 && (real.vx * rx + real.vy * ry) / (rd * bs || 1) > 0.5 && p.shotWindow <= 0) joy.fire = true;
  return joy;
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

// A pass played on the move: the planned pass direction and the ball runs that way, faster
// than the passer.
function passReleased(p, ball) {
  const d = p.ai.dir;
  if (!p.ai.passTo || !d) return false;
  const bs = Math.hypot(ball.vx, ball.vy);
  const released = bs > Math.hypot(p.vx, p.vy) + 1 && (ball.vx * d.x + ball.vy * d.y) / (bs || 1) > 0.9;
  if (released) p.ai.passTo = null;
  return released;
}

function hasBall(p, ball) {
  if (p.state === 'trap') return true;
  // Dribbling: the last touch was his and not a kick (pass, shot). At full speed the ball runs
  // a few metres ahead.
  return ball.lastTouch === p && !ball.kicked && !ball.heldBy && ball.z < 0.6 &&
    Math.hypot(ball.x - p.x, ball.y - p.y) < 4.5;
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
  ai.carryTime = (ai.carryTime || 0) + DT;
  const busy = ai.turning || ai.plan === 'pass' ||
    ((ai.plan === 'shoot' || ai.plan === 'chip' || ai.plan === 'longball' || ai.plan === 'clear' || ai.plan === 'cross' || ai.plan === 'lofted') && ai.planTimer > 0);
  // Danger at the own box: decide at once (no waiting for the next decision).
  const urgent = ai.plan !== 'clear' && ownBoxPressure(team, world);
  if (urgent) { ai.turning = false; }
  if (urgent || (!busy && (!ai.plan || ai.decisionTimer <= 0))) {
    decide(p, team, world);
    ai.decisionTimer = lvl.decision;
  }

  if (ai.plan === 'pass') return executeTrap(p, lvl, ball, 'pass');
  if (p.state === 'trap' && !ai.turning && ai.dir && !['longball', 'shoot', 'chip', 'clear', 'cross', 'lofted'].includes(ai.plan)) {
    ai.turning = true;
    ai.passPhase = 'aim';
    ai.aimTimer = 0;
    ai.passTimer = 1.0;
  }
  if (ai.turning) return executeTrap(p, lvl, ball, 'turn');

  // Ball behind the player (seen from the wanted direction): turn with a trap first.
  // A ball to the side is played round instead (drive), which keeps the game flowing.
  const bx = ball.x - p.x, by = ball.y - p.y;
  const bd = Math.hypot(bx, by);
  if (ai.turnCooldown > 0) ai.turnCooldown -= DT;
  // (Not again right after a turn: the ball is then still at his feet, a little behind him.)
  if (bd < 3 && bd > 0.7 && !(ai.turnCooldown > 0) && (bx * ai.dir.x + by * ai.dir.y) / bd < -0.2) {
    // A rolling ball: turn on the move instead of stopping it. The next touch pushes it to the
    // side (a quarter turn, towards the side the player is already on); then the normal
    // dribble takes it on in the wanted direction.
    const bs = Math.hypot(ball.vx, ball.vy);
    if (bs > 1) {
      const a = Math.atan2(ball.vy, ball.vx);
      const s1 = toSectorDir(a + Math.PI / 2), s2 = toSectorDir(a - Math.PI / 2);
      const pick = (bx * s1.x + by * s1.y) >= (bx * s2.x + by * s2.y) ? s1 : s2;
      return drive(p, ball, pick);
    }
    ai.turning = true;
    ai.passPhase = 'approach';
    ai.passTimer = 1.3;
    return executeTrap(p, lvl, ball, 'turn');
  }

  if (ai.plan === 'chip' || ai.plan === 'clear' || ai.plan === 'cross' || ai.plan === 'lofted') return executeChip(p, ball, ai, team, world);

  if (ai.plan === 'longball') {
    // A driven kick straight from the dribble (fire just after a touch), like a human's long ball.
    const joy = drive(p, ball, ai.dir);
    if (p.shotWindow > 0 && p.fx * ai.dir.x + p.fy * ai.dir.y > 0.99) {
      joy.fire = true;
      ai.plan = null;
    }
    return joy;
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
  // A chip needs the ball just in front, in the chip direction (it is played at the next touch).
  const canChip = (d) => {
    const bx = ball.x - p.x, by = ball.y - p.y, bd = Math.hypot(bx, by);
    return bd < 1.8 && bd > 0.01 && (bx * d.x + by * d.y) / bd > 0.7 && Math.hypot(p.vx, p.vy) > 3;
  };

  // Keeper far off his line: chip it over him.
  if (dGoal < 24 && rng.next() < lvl.chip) {
    const chip = chipShot(ball, g, opponents);
    if (chip && canChip(chip)) {
      ai.plan = 'chip';
      ai.dir = chip;
      ai.planTimer = 1.5;
      return;
    }
  }

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

  // Shot, pass or carry: each option gets a value (how dangerous the ball is afterwards, times
  // the chance to keep it, minus the risk of losing it). The team's phase sets the risk.
  const st = team.play;
  const shot = dGoal < lvl.shootRange ? bestShot(ball, g, opponents, lvl) : null;
  const shotValue = shot ? shotQuality(team, ball) : -Infinity;
  const tempo = TEMPO[st.phase] || TEMPO.progress;
  const pass = choosePass(p, team, world, st, lvl, tempo.minP);
  const carry = chooseCarry(p, team, world, st, lvl);
  const passValue = pass ? pass.value : -Infinity;
  const carryValue = carry ? carry.value : -Infinity;

  if (shot && (shotValue >= Math.max(passValue, carryValue) * 0.85 || dGoal < 13)) {
    ai.plan = 'shoot';
    ai.dir = shot.dir;
    ai.targetX = shot.targetX;
    ai.planTimer = 2;
    return;
  }
  // No good ground pass and not much room: chip it over the defender in the lane.
  if (passValue < 0 && carryValue < 0 && rng.next() < lvl.chip) {
    const chip = bestChip(p, team, world, g, opponents);
    if (chip && canChip(chip)) {
      ai.plan = 'chip';
      ai.dir = chip;
      ai.planTimer = 1.5;
      return;
    }
  }
  // Clearance: under pressure in or near the own box, with no safe pass: long, high and wide.
  const pressed = contained(p, team, world) || pressureTime(world, team, ball) < 0.7;
  const boxPressure = ownBoxPressure(team, world);
  const goodPass = pass && pass.safe && pass.safe.p > 0.8 && (depthOf(team, from2(ball, pass.safe).y) <= depthOf(team, ball.y) + 0.02);
  if (boxPressure && !goodPass) {
    // Under pressure at the own box: high and wide (a one-touch run-up if he stands on it).
    const d = clearDir(team, ball, opponents);
    if (d) { setLob(ai, 'clear', d, true); return; }
  }
  // Cross: wide in the final third, team-mates in the box: a high ball into the box instead of
  // dribbling to the byline.
  const cross = crossDir(p, team, world, g);
  if (cross && (pressed || Math.abs(g.y - ball.y) < 20 || ai.carryTime > 0.6) && rng.next() < (lvl.cross ?? 0.85)) {
    setLob(ai, 'cross', cross.dir, cross.power);
    return;
  }

  // Rhythm: a contained carrier, or one who has had the ball for the phase's tempo, releases it
  // with the best pass that is safe enough for the phase.
  let pick = null;
  if (pass && pass.safe && (contained(p, team, world) || ai.carryTime > tempo.carry)) pick = pass.safe;
  // Otherwise keep carrying unless the pass is clearly better (no dithering between the two).
  const keepCarrying = ai.plan === 'dribble' && carry && ai.dir && carry.dir.x === ai.dir.x && carry.dir.y === ai.dir.y;
  if (!pick && pass && passValue > carryValue + (keepCarrying ? 0.006 : 0.002)) pick = pass;
  if (pick) {
    const pass = pick;
    ai.dir = { x: pass.dir.x, y: pass.dir.y, dist: pass.along };
    pass.to.ai.lastPasser = p;
    pass.to.ai.lastPassStep = world.step;
    ai.passTo = pass.to;
    if (pass.kind === 'lob') {
      setLob(ai, 'lofted', { x: pass.dir.x, y: pass.dir.y }, pass.power);
    } else if (pass.kind === 'long') {
      ai.plan = 'longball';
      ai.planTimer = 1.5;
    } else if (pass.kind === 'push') {
      ai.plan = 'dribble'; // the next touch, on the move, is the pass
      ai.planTimer = 0.8;
    } else {
      ai.plan = 'pass';
      ai.passPhase = 'approach';
      ai.holdNeeded = holdForSpeed(pass.speed);
      ai.passTimer = 1.3 + ai.holdNeeded;
    }
    return;
  }
  ai.plan = 'dribble';
  ai.passTo = null;
  ai.dir = carry ? carry.dir : bestDribble(p, ball, g, opponents, ai.dir);
}

// Carrying: extra value for running towards the opponent's goal (per unit of direction).
const DRIVE = 0.03;

// Extra value per metre a pass goes forward, per phase.
const FORWARD = { buildup: 0.0009, progress: 0.0016, attack: 0.001, counter: 0.002, block: 0.001, counterpress: 0.001 };

function inside(x, y, margin) {
  return x > margin && x < PITCH.width - margin && y > margin && y < PITCH.length - margin;
}

function overOwnLine(team, y) {
  const og = ownGoal(team);
  return og.y === 0 ? y < 0 : y > PITCH.length;
}

// How much further a pass rolls after `along` metres if nobody touches it.
function rollDistanceLeft(speed, along) {
  const s = currentSurface();
  const a = s.rollFriction, k = s.rollDrag;
  const total = ((speed + a / k) * (1 - (a / k) / (speed + a / k))) / k - (a / k) * (Math.log((speed + a / k) / (a / k)) / k);
  return Math.max(0, total - along);
}

// The ball is in or near the own box and an opponent is close (within 6 m, or there in 1.2 s).
function ownBoxPressure(team, world) {
  const ball = world.ball;
  const og = ownGoal(team);
  const into = og.y === 0 ? 1 : -1;
  if (Math.abs(ball.x - PITCH.width / 2) > PITCH.boxWidth / 2 + 5 || (ball.y - og.y) * into > PITCH.boxDepth + 6) return false;
  for (const o of world.teams[1 - team.id].players) {
    if (!o.sentOff && o.role !== 'keeper' && Math.hypot(o.x - ball.x, o.y - ball.y) < 6) return true;
  }
  return pressureTime(world, team, ball) < 1.2;
}

// Where a pass ends (for the depth check).
function from2(ball, pass) {
  return { x: ball.x + pass.dir.x * pass.along, y: ball.y + pass.dir.y * pass.along };
}

function setLob(ai, plan, dir, power) {
  ai.plan = plan;
  ai.dir = dir;
  ai.chipPower = power;
  ai.passTo = null;
  ai.planTimer = 2.0;
}

// Seconds until the nearest opponent can reach the ball.
function pressureTime(world, team, ball) {
  let t = Infinity;
  for (const o of world.teams[1 - team.id].players) if (!o.sentOff) t = Math.min(t, reachTime(o, ball.x, ball.y, 0.2));
  return t;
}

// Clearance direction: forward or diagonally forward, as wide as possible while the ball still
// lands inside the pitch (about 34 m away), away from opponents.
function clearDir(team, ball, opponents) {
  const fy = team.attackDir;
  let best = null, bestScore = -Infinity;
  for (const d of [{ x: 0, y: fy }, { x: Math.SQRT1_2, y: fy * Math.SQRT1_2 }, { x: -Math.SQRT1_2, y: fy * Math.SQRT1_2 }]) {
    const lx = ball.x + d.x * 34, ly = ball.y + d.y * 34;
    // The ball rolls on after landing: land well inside the touchline, or it is a throw-in.
    if (!inside(lx, ly, 8)) continue;
    let free = 20;
    for (const o of opponents) free = Math.min(free, Math.hypot(o.x - lx, o.y - ly));
    const score = Math.abs(lx - PITCH.width / 2) * 0.35 + free * 0.4;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

// Cross from the wing: a high ball along an 8-way direction towards the box, if team-mates are
// there. Longer crosses are played with more power.
function crossDir(p, team, world, g) {
  const ball = world.ball;
  const dLine = Math.abs(g.y - ball.y);
  // Only from a run with the ball (a lob needs a run-up).
  if (p.state === 'trap' || Math.hypot(p.vx, p.vy) < 4) return null;
  if (Math.abs(ball.x - PITCH.width / 2) < 15 || dLine > 32 || dLine < 3) return null;
  const into = g.y === 0 ? 1 : -1;
  const inBox = team.players.filter((m) => m !== p && !m.sentOff && m.role !== 'keeper' &&
    Math.abs(m.x - PITCH.width / 2) < PITCH.boxWidth / 2 + 2 && (m.y - g.y) * into < PITCH.boxDepth + 3);
  if (!inBox.length) return null;
  // Aim at the team-mate in the box with most room, or the penalty spot.
  const opp = world.teams[1 - team.id].players;
  let target = { x: PITCH.width / 2, y: g.y + into * PITCH.penaltySpot }, bestFree = 0;
  for (const m of inBox) {
    let free = 10;
    for (const o of opp) free = Math.min(free, Math.hypot(o.x - m.x, o.y - m.y));
    if (free > bestFree) { bestFree = free; target = { x: m.x, y: m.y }; }
  }
  // Only directions close to his run (a lob goes where he runs): usually diagonally inwards.
  const sp = Math.hypot(p.vx, p.vy);
  const run = sp > 2 ? { x: p.vx / sp, y: p.vy / sp } : { x: ball.vx, y: ball.vy };
  let best = null, bestErr = Infinity;
  for (const dir of PASS_DIRS) {
    if (dir.x * run.x + dir.y * run.y < 0.7 * Math.hypot(run.x, run.y)) continue;
    // The point on this line nearest to the target: is it in the box, near the target?
    const vx = target.x - ball.x, vy = target.y - ball.y;
    const along = vx * dir.x + vy * dir.y;
    if (along < 12 || along > 40) continue;
    const lx = ball.x + dir.x * along, ly = ball.y + dir.y * along;
    const inBoxArea = Math.abs(lx - PITCH.width / 2) < PITCH.boxWidth / 2 + 3 && (ly - g.y) * into > 1 && (ly - g.y) * into < PITCH.boxDepth + 4;
    const err = Math.hypot(lx - target.x, ly - target.y);
    if (inBoxArea && err < bestErr) { bestErr = err; best = { dir, power: along > 27 }; }
  }
  return best;
}

// Tempo per phase: how long a player carries the ball before looking to pass (s), and the
// lowest pass chance accepted then.
const TEMPO = {
  buildup: { carry: 1.2, minP: 0.62 },
  progress: { carry: 1.8, minP: 0.52 },
  attack: { carry: 1.4, minP: 0.42 },
  counter: { carry: 2.6, minP: 0.5 },
};

// A defender stands in front of the carrier (between him and the goal), close.
function contained(p, team, world) {
  const g = oppGoal(team);
  const gx = g.x - p.x, gy = g.y - p.y, gd = Math.hypot(gx, gy) || 1;
  for (const o of world.teams[1 - team.id].players) {
    if (o.sentOff || o.role === 'keeper') continue;
    const dx = o.x - p.x, dy = o.y - p.y, d = Math.hypot(dx, dy);
    if (d < 3.2 && (dx * gx + dy * gy) / (d * gd || 1) > 0.3) return true;
  }
  return false;
}

// Rough quality of a shot from the ball's position (like an expected-goals value).
function shotQuality(team, ball) {
  const g = oppGoal(team);
  const d = Math.hypot(g.x - ball.x, g.y - ball.y);
  const angle = Math.abs(Math.atan2(ball.x - g.x, Math.abs(g.y - ball.y)));
  return 0.7 * Math.exp(-d / 11) * Math.max(0.15, Math.cos(angle));
}

// The best pass: to a team-mate's feet or into the space ahead of a runner, along one of the
// 8 stick directions, played on the move (a touch), from a trapped ball (held longer for more
// power) or as a driven long ball.
function choosePass(p, team, world, st, lvl, minP = 0) {
  const ball = world.ball;
  const from = { x: ball.x, y: ball.y };
  const opp = world.teams[1 - team.id];
  const lw = lossWeight(st);
  const run = Math.hypot(p.vx, p.vy);
  const bs = Math.hypot(ball.vx, ball.vy);
  const moving = bs > 2 && run > 5 && p.state !== 'trap';
  const k = tuning.kick;
  let tPress = Infinity;
  for (const o of opp.players) if (!o.sentOff) tPress = Math.min(tPress, reachTime(o, ball.x, ball.y, 0.2));
  const underPressure = tPress < 0.8 || contained(p, team, world);
  const human = world.human && world.human.team === team.id ? world.human.player : null;
  let best = null, safe = null;
  for (const m of team.players) {
    if (m === p || m.sentOff || m.role === 'keeper') continue;
    if (world.rng.next() > (lvl.vision ?? 0.8)) continue; // not seen this time
    const mx = m.x + m.vx * 0.35, my = m.y + m.vy * 0.35;
    const targets = [{ x: mx, y: my }];
    const runTo = st && st.runs.get(m);
    if (runTo) {
      // A pass into the run: points along the runner's way (he gets there in time or not).
      const rx = runTo.x - m.x, ry = runTo.y - m.y, rd = Math.hypot(rx, ry) || 1;
      for (const k of [4, 8, 12]) if (k < rd + 3) targets.push({ x: m.x + (rx / rd) * k, y: m.y + (ry / rd) * k, run: true });
    } else if (Math.hypot(m.vx, m.vy) > 5) targets.push({ x: mx + m.vx * 0.6, y: my + m.vy * 0.6 });
    for (const t of targets) {
      const vx = t.x - from.x, vy = t.y - from.y, d = Math.hypot(vx, vy);
      if (d < 6 || d > 46) continue;
      const dir = PASS_DIRS[((Math.round(Math.atan2(vy, vx) / SECTOR) % 8) + 8) % 8];
      const along = vx * dir.x + vy * dir.y;
      const miss = Math.abs(vx * dir.y - vy * dir.x);
      if (along < 5 || miss > 3 + d * 0.06) continue;
      const kinds = [];
      if (moving && (ball.vx * dir.x + ball.vy * dir.y) / bs > 0.3) kinds.push({ kind: 'push', speed: run * tuning.player.dribbleFactor, delay: 0.12 });
      if (along > 26) kinds.push({ kind: 'long', speed: k.shotSpeed * (0.75 + 0.25 * p.shooting) + run * k.runBonus, delay: 0.2 });
      // From a trapped ball: soft (arrives slowly) or firm (arrives at about 11 m/s, less time
      // for an interception; the stick is held a little longer).
      const turn = Math.acos(Math.max(-1, Math.min(1, p.fx * dir.x + p.fy * dir.y))) / tuning.player.trapTurnRate;
      for (const arrive of [4 + along * 0.08, 11]) {
        const need = Math.min(k.passMaxSpeed, Math.max(k.passSpeed, speedForDistance(along, arrive)));
        const trapDelay = (p.state === 'trap' ? 0 : 0.3) + turn + (lvl.passAim || 0.15) + holdForSpeed(need);
        kinds.push({ kind: 'trap', speed: need, delay: trapDelay });
      }
      // The target must be well inside the pitch.
      const tx = from.x + dir.x * along, ty = from.y + dir.y * along;
      if (!inside(tx, ty, 2.5)) continue;
      for (const kd of kinds) {
        const c = passChance(world, team, from, dir, kd.speed, along, m, kd.delay);
        if (!Number.isFinite(c.tArrive)) continue; // the ball would stop before the target
        // If the receiver misses it, where does the ball end up? Over the own goal line = a
        // corner (never); over the touchline = a throw-in (risky).
        const over = Math.min(12, rollDistanceLeft(kd.speed, along));
        const ex = tx + dir.x * over, ey = ty + dir.y * over;
        if (!inside(ex, ey, 0) && overOwnLine(team, ey)) continue;
        const outRisk = inside(ex, ey, 0) ? 0 : 1;
        let pOk = c.p * (1 - outRisk * 0.25);
        if (tPress < kd.delay) pOk *= 0.55; // tackled before the ball is away
        if (kd.kind === 'long') pOk *= 0.75; // a driven ball in the air is harder to control
        // Worth more when the receiver will have time on the ball.
        let freeT = 3;
        for (const o of opp.players) if (!o.sentOff) freeT = Math.min(freeT, reachTime(o, c.x, c.y, 0.2) - c.tArrive - kd.delay);
        const gain = zoneValue(team, c.x, c.y) + 0.01 * Math.max(0, Math.min(2, freeT));
        const risk = zoneValue(opp, from.x + dir.x * along * 0.5, from.y + dir.y * along * 0.5);
        let value = pOk * gain - (1 - pOk) * risk * lw;
        // Forward thinking: metres gained towards the goal count extra (backwards only if needed).
        const fwd = (depthOf(team, from.y) - depthOf(team, c.y)) * PITCH.length;
        value += pOk * (fwd > 0 ? fwd * FORWARD[st.phase] : fwd * (underPressure ? 0.0004 : 0.0015));
        if (fwd < -15) value -= 0.02; // a long ball backwards gives the attack away (almost never right)
        if (m === human && value > 0) value *= 1.15;
        if (t.run && value > 0) value *= 1.2;
        if (m === p.ai.lastPasser && world.step - (p.ai.lastPassStep || -999) < 120) value -= 0.004;
        value += (world.rng.next() - 0.5) * 0.02 * (1 - (lvl.vision ?? 0.8));
        const cand = { to: m, dir, along, kind: kd.kind, speed: kd.speed, value, p: pOk };
        if (!best || value > best.value) best = cand;
        if (pOk >= minP && (!safe || value > safe.value)) safe = cand;
      }
    }
  }
  // Lofted pass (a lob, needs a run-up): over the opponents to where a team-mate gets first.
  // Wide balls and switches of play get a bonus.
  if (run > 4 && p.state !== 'trap') {
    const rdir = { x: p.vx / run, y: p.vy / run };
    const nearLine = ball.x < 5 || ball.x > PITCH.width - 5;
    for (const dir of PASS_DIRS) {
      // Near the touchline no turning for it (the touches on the way go out): only straight on.
      if (dir.x * rdir.x + dir.y * rdir.y < (nearLine ? 0.95 : 0.7)) continue;
      for (const lob of LOBS) {
        const lx = from.x + dir.x * lob.dist, ly = from.y + dir.y * lob.dist;
        if (!inside(lx, ly, 6)) continue;
        // Nobody gets there: the ball rolls on. Over the line = risky, over the own line = never.
        const ex = lx + dir.x * 14, ey = ly + dir.y * 14;
        if (!inside(ex, ey, 0) && overOwnLine(team, ey)) continue;
        const rollsOut = !inside(ex, ey, 0);
        let tR = Infinity, to = null;
        for (const m of team.players) {
          if (m === p || m.sentOff || m.role === 'keeper') continue;
          const t = reachTime(m, lx, ly, 0.15);
          if (t < tR) { tR = t; to = m; }
        }
        let tO = Infinity;
        for (const o of opp.players) if (!o.sentOff) tO = Math.min(tO, reachTime(o, lx, ly, 0.35));
        const pOk = sigmoidAI((tO - Math.max(tR, lob.time - 0.2)) / 0.25) * sigmoidAI((lob.time + 0.6 - tR) / 0.2) * (rollsOut ? 0.6 : 0.85);
        const gain = zoneValue(team, lx, ly);
        const risk = zoneValue(opp, lx, ly);
        let value = pOk * gain - (1 - pOk) * risk * lw;
        const fwd = (depthOf(team, from.y) - depthOf(team, ly)) * PITCH.length;
        if (fwd > 0) value += pOk * fwd * FORWARD[st.phase];
        const wide = Math.abs(lx - PITCH.width / 2) > 18 || Math.abs(lx - from.x) > 20;
        if (wide && fwd > -5) value += pOk * WIDE_BONUS;
        const cand = { to, dir, along: lob.dist, kind: 'lob', power: lob.power, value, p: pOk };
        if (!best || value > best.value) best = cand;
        if (pOk >= minP && (!safe || value > safe.value)) safe = cand;
      }
    }
  }
  if (best) best.safe = safe;
  return best;
}

// Lob distances (landing point) and flight times, measured with the ball physics.
const LOBS = [{ dist: 24.8, time: 1.84, power: false }, { dist: 43.2, time: 2.24, power: true }];
// Extra value for a high ball out wide or across the pitch (it opens the play).
const WIDE_BONUS = 0.012;
const sigmoidAI = (x) => 1 / (1 + Math.exp(-x));

// The best direction to carry the ball: forward into space, not into an opponent.
function chooseCarry(p, team, world, st, lvl) {
  const ball = world.ball;
  const from = { x: ball.x, y: ball.y };
  const opp = world.teams[1 - team.id];
  const lw = lossWeight(st);
  const riskHere = zoneValue(opp, from.x, from.y);
  const patience = 1;
  let best = null;
  const g = oppGoal(team);
  const gx = g.x - from.x, gy = g.y - from.y, gd = Math.hypot(gx, gy) || 1;
  const pressed = contained(p, team, world);
  for (const d of PASS_DIRS) {
    const len = 7;
    const x = from.x + d.x * len, y = from.y + d.y * len;
    // Stay on the pitch (the ball runs a few metres ahead): only towards the opponent's goal
    // mouth may the line be crossed.
    const x10 = from.x + d.x * 10, y10 = from.y + d.y * 10;
    const towardsGoalMouth = Math.abs(y10 - g.y) < 3 && x10 > GOAL_X0 - 4 && x10 < GOAL_X1 + 4;
    if (!towardsGoalMouth && (!inside(x, y, 1.5) || !inside(x10, y10, 0))) continue;
    const pk = carryChance(world, team, p, from, d, len);
    let value = pk * zoneValue(team, x, y) * patience - (1 - pk) * riskHere * lw;
    // Drive: towards the opponent's goal. Sideways costs a little, backwards a lot (only under
    // pressure is it a real option).
    const forward = (d.x * gx + d.y * gy) / gd;
    // Never run towards the own goal in the own half.
    if (forward < -0.3 && depthOf(team, from.y) > 0.5) continue;
    value += pk * forward * DRIVE;
    if (forward < -0.3) value -= pressed ? 0.01 : 0.04;
    // Rhythm: after a couple of seconds on the ball, a player looks to release it.
    value -= Math.max(0, (p.ai.carryTime || 0) - 1.6) * 0.006;
    if (p.ai.dir && p.ai.dir.x === d.x && p.ai.dir.y === d.y) value += 0.002;
    value += (world.rng.next() - 0.5) * 0.015 * (1 - (lvl.vision ?? 0.8));
    if (!best || value > best.value) best = { dir: d, value, p: pk };
  }
  return best;
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

// Chip pass: a free team-mate 12–24 m away (the range of a lob), whose ground lane is blocked.
function bestChip(p, team, world, g, opponents) {
  const ball = world.ball;
  const goalDir = norm(g.x - ball.x, g.y - ball.y);
  let best = null, bestScore = -Infinity;
  for (const m of team.players) {
    if (m === p || m.role === 'keeper' || m.sentOff) continue;
    const vx = m.x + m.vx * 0.8 - ball.x, vy = m.y + m.vy * 0.8 - ball.y;
    const d = Math.hypot(vx, vy);
    if (d < 12 || d > 24) continue;
    const progress = vx * goalDir.x + vy * goalDir.y;
    if (progress < 4) continue;
    const dir = toSectorDir(Math.atan2(vy, vx));
    const along = vx * dir.x + vy * dir.y;
    const miss = Math.abs(vx * dir.y - vy * dir.x);
    if (along <= 0 || miss > 3.5) continue;
    if (!blocked(ball, dir, along * 0.7, opponents, tuning.ai.laneWidth)) continue; // a ground pass would do
    let free = 10;
    for (const o of opponents) free = Math.min(free, Math.hypot(o.x - m.x, o.y - m.y));
    if (free < 3.5) continue;
    const score = progress * 0.5 + free - miss;
    if (score > bestScore) { bestScore = score; best = dir; }
  }
  return best;
}

// Chip shot: the keeper is more than 5 m off his line and the 8-way line ends in the goal.
function chipShot(ball, g, opponents) {
  const keeper = opponents[0];
  if (Math.abs(keeper.y - g.y) < 5) return null;
  const d = toSectorDir(Math.atan2(g.y - ball.y, g.x - ball.x));
  if (Math.abs(d.y) < 0.1) return null;
  const x = ball.x + (d.x / d.y) * (g.y - ball.y);
  return x > GOAL_X0 + 0.5 && x < GOAL_X1 - 0.5 ? d : null;
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
    // Long balls take longer: the receiver has time to run to the line, but opponents also
    // have time to step into the lane.
    if (along <= 0 || miss > 3.5 + d * 0.05) continue;
    if (blocked(ball, dir, along, opponents, cfg.laneWidth, speedForDistance(d, 4 + d * 0.08))) continue;
    let free = 10;
    for (const o of opponents) free = Math.min(free, Math.hypot(o.x - mx, o.y - my));
    let score = progress * 0.6 + free * 0.8 - miss - Math.max(0, d - 25) * 0.08;
    // Switch of play: a free team-mate far out on the other side.
    if (Math.abs(vx) > 20 && free > 7) score += 1.5;
    if (score > bestScore) { bestScore = score; best = { x: dir.x, y: dir.y, dist: along }; }
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

// A chip is a lob: run at the ball in the wanted direction and pull the stick back just before
// the touch (the same move as a human). The ball then goes high in the running direction.
function executeChip(p, ball, ai, team, world) {
  const cfg = tuning.player;
  // A clearance under close pressure: no time to set it up.
  if (ai.plan === 'clear' && team && world) {
    let near = Infinity;
    for (const o of world.teams[1 - team.id].players) if (!o.sentOff) near = Math.min(near, Math.hypot(o.x - p.x, o.y - p.y));
    if (p.state === 'trap' && near < 3.5) {
      // Release at once with the stick in the clearance direction: the ball is gone (flat).
      return { dx: Math.sign(Math.round(ai.dir.x * 2)), dy: Math.sign(Math.round(ai.dir.y * 2)), fire: false };
    }
    const speed = Math.hypot(p.vx, p.vy);
    const g = oppGoal(team);
    const run = speed > 0 ? { x: p.vx / speed, y: p.vy / speed } : null;
    const towardsGoal = run ? (run.x * (g.x - p.x) + run.y * (g.y - p.y)) / (Math.hypot(g.x - p.x, g.y - p.y) || 1) : -1;
    const close = Math.hypot(ball.x - p.x, ball.y - p.y) < tuning.kick.shotReach && ball.z < 0.3;
    if (p.state !== 'trap' && speed > tuning.kick.lobMinSpeed + 0.3 && close && towardsGoal > 0.3 &&
        (p.shotWindow > 0 || p.touchTimer <= 0)) {
      // High and long in the running direction (not towards the own goal).
      const back = toSector(Math.atan2(-p.vy, -p.vx));
      return { dx: back.dx, dy: back.dy, fire: true, reverse: true };
    }
  }
  // Standing on the ball (trap): turn to the direction first, then release with the stick
  // centred and run (releasing with a direction would be a pass).
  if (p.state === 'trap') {
    if (p.fx * ai.dir.x + p.fy * ai.dir.y > 0.9) return { dx: 0, dy: 0, fire: false };
    return { dx: Math.sign(Math.round(ai.dir.x * 2)), dy: Math.sign(Math.round(ai.dir.y * 2)), fire: true };
  }
  const speed = Math.hypot(p.vx, p.vy);
  // Just after a touch in the wanted direction (the lob window, like a shot): pull back.
  const aligned = speed > 0.5 && (p.vx * ai.dir.x + p.vy * ai.dir.y) / speed > 0.9;
  if (aligned && speed > tuning.kick.lobMinSpeed + 0.5 && ball.z < 0.3 && p.shotWindow > 0 &&
      (ball.vx * ai.dir.x + ball.vy * ai.dir.y) > 0 && Math.hypot(ball.x - p.x, ball.y - p.y) < tuning.kick.shotReach) {
    // The lob goes where he runs: pull the stick back against the running direction.
    const back = toSector(Math.atan2(-p.vy, -p.vx));
    return { dx: back.dx, dy: back.dy, fire: !!ai.chipPower, reverse: true };
  }
  // Get into the running direction (no trap on the way: a lob needs a moving player).
  return { ...drive(p, ball, ai.dir), fire: false };
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
    const held = mode === 'turn' || p.passHold >= (ai.holdNeeded || 0);
    if (ai.aimTimer <= 0 && aligned && held) ai.passPhase = 'release';
    return { dx: ai.dir.x ? Math.sign(ai.dir.x) : 0, dy: ai.dir.y ? Math.sign(ai.dir.y) : 0, fire: true };
  }
  if (mode === 'turn') {
    ai.turning = false;
    ai.turnCooldown = 0.6;
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
  // Close to the ball but not yet facing the wanted way: hold fire, so a contact stops the
  // ball (a trap, then a turn) instead of pushing it in the wrong direction (often out of play).
  // On the wrong side of the ball: go round it, not through it.
  let joy;
  if (bx * d.x + by * d.y < 0) {
    const sx = -d.y, sy = d.x;
    const side = (p.x - ball.x) * sx + (p.y - ball.y) * sy >= 0 ? 1 : -1;
    joy = steer(p, behindX + sx * side * 1.0, behindY + sy * side * 1.0, 0);
  } else {
    joy = steer(p, behindX, behindY, 0);
  }
  // The step (stick) or the run goes clearly another way than wanted, close to the ball: hold
  // fire, so a touch now stops the ball instead of pushing it that way.
  const run = Math.hypot(p.vx, p.vy);
  const sl = Math.hypot(joy.dx, joy.dy) || 1;
  const stickOff = (joy.dx * d.x + joy.dy * d.y) / sl < 0.3;
  const runOff = run > 1 && (p.vx * d.x + p.vy * d.y) / run < 0.3;
  joy.fire = dist < 1.8 && (stickOff || runOff) && p.shotWindow <= 0;
  // Right after a touch fire would be a shot: if the step would push the ball the wrong way,
  // wait a moment instead of stepping into it.
  if (stickOff && dist < 1.2 && p.shotWindow > 0) return { dx: 0, dy: 0, fire: false };
  return joy;
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

// Is an opponent in the lane of a ball played in direction d? With `ballSpeed`, the lane widens
// by how far an opponent can run (with some reaction time) until the ball passes him.
function blocked(ball, d, length, opponents, width, ballSpeed = 0) {
  for (const o of opponents) {
    const rx = o.x - ball.x, ry = o.y - ball.y;
    const along = rx * d.x + ry * d.y;
    if (along < 0.5 || along > length) continue;
    const reach = ballSpeed ? tuning.player.maxSpeed * (o.pace || 1) * (along / ballSpeed) * LANE_REACH : 0;
    if (Math.abs(rx * d.y - ry * d.x) < width + reach) return true;
  }
  return false;
}
const LANE_REACH = 0.2; // share of that run that counts (reaction time, not a straight line)

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
