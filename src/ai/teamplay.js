import { DT, PITCH, tuning, currentSurface } from '../config.js';
import { oppGoal, ownGoal } from '../world/team.js';
import { fatigue } from '../world/player.js';
import { tacticTarget, toWorld, toNorm } from './tactics.js';

// Team play: what a team knows and plans together, on top of the single players' actions.
//
// - Pitch value: how dangerous the ball is at a point (a simple "expected threat" surface).
// - Pass probability: will a pass arrive? Time-based, as in pitch-control models: who reaches
//   the ball's path first, the receiver or an opponent (with speed and reaction time).
// - Phases: build-up, progression, attack and counter-attack in possession; counter-press,
//   press and block without the ball. Each phase sets how much risk the team accepts.
// - Support: team-mates move onto the ball carrier's 8 pass lanes (passes follow the 8 stick
//   directions), runners go in behind, defenders mark and block pass lanes.

const L = PITCH.length, W = PITCH.width;
const SECTOR = Math.PI / 4;
const DIRS = Array.from({ length: 8 }, (_, s) => {
  const a = s * SECTOR, dx = Math.round(Math.cos(a)), dy = Math.round(Math.sin(a));
  return dx && dy ? { x: dx * Math.SQRT1_2, y: dy * Math.SQRT1_2 } : { x: dx, y: dy };
});
export const PASS_DIRS = DIRS;

// --- pitch value --------------------------------------------------------------------------

// Depth from the opponent's goal line: 0 there, 1 at the own goal line.
export function depthOf(team, y) {
  return team.attackDir < 0 ? y / L : 1 - y / L;
}

// How dangerous it is for `team` to have the ball at (x, y): a smooth surface that rises
// towards the opponent's goal, most near its centre.
export function zoneValue(team, x, y) {
  const g = oppGoal(team);
  const d = Math.hypot(x - g.x, y - g.y);
  const centre = 1 - Math.min(1, Math.abs(x - W / 2) / (W / 2));
  const inside = x > 0 && x < W && y > 0 && y < L ? 1 : 0.3;
  return (0.06 * (1 - depthOf(team, y)) + 0.5 * Math.exp(-d / 10) * (0.35 + 0.65 * centre)) * inside;
}

// --- time model ---------------------------------------------------------------------------

// Time for a rolling ball starting at v0 to cover s metres (Infinity if it stops before).
export function rollTime(v0, s) {
  const { rollFriction: a, rollDrag: k } = currentSurface();
  const c = v0 + a / k;
  const tStop = Math.log(c / (a / k)) / k;
  const sAt = (t) => (c * (1 - Math.exp(-k * t))) / k - (a / k) * t;
  if (s >= sAt(tStop)) return Infinity;
  let lo = 0, hi = tStop;
  for (let i = 0; i < 22; i++) {
    const m = (lo + hi) / 2;
    if (sAt(m) < s) lo = m; else hi = m;
  }
  return hi;
}

export function rollSpeed(v0, t) {
  const { rollFriction: a, rollDrag: k } = currentSurface();
  return Math.max(0, (v0 + a / k) * Math.exp(-k * t) - a / k);
}

function speedOf(p) {
  return p.role === 'keeper' ? tuning.keeper.speed : tuning.player.maxSpeed * (p.pace || 1) * fatigue(p);
}

// Seconds for a player to get to (x, y), with reaction time; a player already running that way
// is quicker, one running the other way slower.
export function reachTime(p, x, y, reaction) {
  const dx = x - p.x, dy = y - p.y, d = Math.hypot(dx, dy);
  if (d < 0.3) return reaction * 0.5;
  const v = speedOf(p);
  const along = (p.vx * dx + p.vy * dy) / d;
  const accel = p.role === 'keeper' ? tuning.keeper.accel : tuning.player.accel;
  return reaction + d / v + Math.max(0, v - along) / (2 * accel);
}

const sigmoid = (x) => 1 / (1 + Math.exp(-x));
// Opponents first have to read where a pass goes before they can run for it.
const READ_TIME = 0.42;

// Probability that a ball played from `from` in direction `dir` at `speed` is won by the
// receiver at the point `along` metres away, not by an opponent on the way. `delay` = seconds
// before the ball leaves (a trap and aim takes time; the opponents keep running).
export function passChance(world, team, from, dir, speed, along, receiver, delay = 0) {
  const tArrive = rollTime(speed, along);
  if (!Number.isFinite(tArrive)) return { p: 0, tArrive: Infinity, arriveSpeed: 0 };
  const tx = from.x + dir.x * along, ty = from.y + dir.y * along;
  const arriveSpeed = rollSpeed(speed, tArrive);
  // The receiver knows the pass is coming: short reaction.
  const tRecv = receiver ? reachTime(receiver, tx, ty, 0.1) : 0;
  const pRecv = sigmoid((tArrive + delay + 0.3 - tRecv) / 0.12);
  let pKeep = 1;
  const opponents = world.teams[1 - team.id].players;
  const n = Math.max(3, Math.ceil(along / 2.5));
  for (const o of opponents) {
    if (o.sentOff) continue;
    const og = ownGoal(world.teams[o.team]);
    let margin = Infinity;
    for (let i = 1; i <= n; i++) {
      const s = (along * i) / n;
      const bx = from.x + dir.x * s, by = from.y + dir.y * s;
      // A keeper only comes for balls near his goal.
      if (o.role === 'keeper' && Math.hypot(bx - og.x, by - og.y) > 18) continue;
      const tBall = delay + rollTime(speed, s);
      const tOpp = reachTime(o, bx, by, READ_TIME);
      margin = Math.min(margin, tOpp - tBall);
    }
    if (margin < Infinity) pKeep *= 1 - sigmoid(-margin / 0.13);
  }
  let p = pKeep * pRecv;
  if (arriveSpeed > tuning.player.controlMaxSpeed) p *= 0.4;
  return { p, tArrive, arriveSpeed, x: tx, y: ty };
}

// Chance to keep the ball when carrying it `len` metres in direction dir.
// The ball runs a metre or two ahead of the dribbler, so a defender close to the path wins it
// after the next touch: the path is checked at several points, the nearest ones matter most.
export function carryChance(world, team, carrier, from, dir, len) {
  const run = Math.max(4, Math.hypot(carrier.vx, carrier.vy));
  const v = Math.max(run, speedOf(carrier) * 0.85);
  let pKeep = 1;
  for (const o of world.teams[1 - team.id].players) {
    if (o.sentOff || o.role === 'keeper') continue;
    let worst = 0;
    for (const s of [1.5, 3, len]) {
      const x = from.x + dir.x * s, y = from.y + dir.y * s;
      const tCarrier = s / v + 0.1;
      const lose = sigmoid((tCarrier - reachTime(o, x, y, 0.15)) / 0.1);
      if (lose > worst) worst = lose;
    }
    pKeep *= 1 - worst;
  }
  return pKeep;
}

// --- phases -------------------------------------------------------------------------------

// Updated every step for both teams: the phase of play and how long it lasts.
export function updateTeamState(team, world) {
  const st = team.play || (team.play = { phase: 'block', since: 0, possSince: 0, lostAt: -99, wonAt: -99, had: false, supportTimer: 0, support: new Map(), runs: new Map(), marks: new Map() });
  const now = world.step * DT;
  // Ours: the debounced possession, or one of our players has the ball at his feet right now.
  const lt = world.ball.lastTouch;
  const atFeet = lt && lt.team === team.id && !world.ball.kicked && !world.ball.heldBy &&
    Math.hypot(world.ball.x - lt.x, world.ball.y - lt.y) < 3;
  const ours = world.possession === team.id || !!atFeet;
  if (ours && !st.had) { st.wonAt = now; st.possSince = now; }
  // Lost the ball: counter-press only if it happened in the opponent's half.
  if (!ours && st.had) st.lostAt = depthOf(team, world.ball.y) < 0.5 ? now : -99;
  st.had = ours;
  const b = world.ball;
  let phase;
  if (ours) {
    const depth = depthOf(team, b.y);
    // Counter-attack: the ball was just won and few opponents are behind it.
    const opp = world.teams[1 - team.id].players;
    const goalSideOpp = opp.filter((o) => !o.sentOff && o.role !== 'keeper' && depthOf(team, o.y) < depth).length;
    if (now - st.wonAt < 4 && goalSideOpp <= 4 && depth < 0.75 && (st.phase === 'counter' || now - st.wonAt < 0.8)) phase = 'counter';
    else if (depth > 0.66) phase = 'buildup';
    else if (depth > 0.33) phase = 'progress';
    else phase = 'attack';
  } else {
    phase = now - st.lostAt < 2.0 ? 'counterpress' : 'block';
  }
  if (phase !== st.phase) { st.phase = phase; st.since = now; }
  st.possTime = ours ? now - st.possSince : 0;
  return st;
}

// How costly losing the ball is, per phase (safe in the build-up, bold in the final third).
// A long possession makes the team hungrier to go forward.
export function lossWeight(st) {
  const base = { buildup: 1.4, progress: 1.0, attack: 0.7, counter: 0.55 }[st.phase] ?? 1;
  return base * (st.possTime > 6 ? 0.75 : 1);
}

// --- support and runs ---------------------------------------------------------------------

const SUPPORT_DIST = [9, 13, 18];

// Where the team-mates of the ball carrier go: up to `n` supporters onto free pass lanes
// (on one of the carrier's 8 directions), and one runner in behind the defence.
export function planSupport(team, world, carrier, candidates, lvl, st) {
  const now = world.step * DT;
  st.supportTimer -= DT;
  const stale = [...st.support.keys()].some((p) => !candidates.includes(p));
  if (st.supportTimer > 0 && !stale && st.supportFor === carrier) return;
  st.supportTimer = 0.3;
  st.supportFor = carrier;
  st.support.clear();
  const b = world.ball;
  const from = { x: b.x, y: b.y };
  const opponents = world.teams[1 - team.id].players.filter((o) => !o.sentOff);
  const n = lvl.support ?? 2;
  // The nearest team-mates are the candidates for support.
  const near = candidates.filter((p) => p !== carrier)
    .map((p) => ({ p, d: Math.hypot(p.x - b.x, p.y - b.y) }))
    .sort((a, c) => a.d - c.d).slice(0, n + 2).map((e) => e.p);
  const taken = [];
  for (let k = 0; k < n; k++) {
    let best = null, bestScore = -Infinity;
    for (const p of near) {
      if (st.support.has(p)) continue;
      const home = homeSpot(p, team, b, true);
      for (const d of DIRS) {
        for (const dist of SUPPORT_DIST) {
          const x = from.x + d.x * dist, y = from.y + d.y * dist;
          if (x < 2 || x > W - 2 || y < 2 || y > L - 2) continue;
          let lane = 99, free = 99;
          for (const o of opponents) {
            const rx = o.x - from.x, ry = o.y - from.y, al = rx * d.x + ry * d.y;
            if (al > 0.5 && al < dist) lane = Math.min(lane, Math.abs(rx * d.y - ry * d.x));
            free = Math.min(free, Math.hypot(o.x - x, o.y - y));
          }
          let score = zoneValue(team, x, y) * 18 + Math.min(6, free) * 0.3 + (lane > 2.2 ? Math.min(3, lane - 2.2) * 0.4 : -3);
          score -= Math.hypot(p.x - x, p.y - y) * 0.09 + Math.hypot(home.x - x, home.y - y) * 0.05;
          if (taken.some((t) => Math.hypot(t.x - x, t.y - y) < 7)) score -= 3;
          // Roles: the first supporter offers the forward option, the second a safe one (square
          // or behind the ball).
          const ahead = (depthOf(team, b.y) - depthOf(team, y)) * L;
          if (k === 0) score += Math.max(-3, ahead) * 0.12;
          else if (ahead > 6) score -= (ahead - 6) * 0.08;
          if (score > bestScore) { bestScore = score; best = { p, x, y }; }
        }
      }
    }
    if (!best) break;
    st.support.set(best.p, { x: best.x, y: best.y });
    taken.push(best);
  }
  // A run in behind: a forward (or winger) ahead of the ball goes into the space behind the
  // last defender when the carrier has time and faces forward.
  for (const [p, r] of st.runs) if (now > r.until || !candidates.includes(p)) st.runs.delete(p);
  if (st.runs.size === 0 && (st.phase === 'progress' || st.phase === 'attack' || st.phase === 'counter') && world.rng.next() < (lvl.runs ?? 0.6)) {
    let pressure = 99;
    for (const o of opponents) pressure = Math.min(pressure, Math.hypot(o.x - carrier.x, o.y - carrier.y));
    const g = oppGoal(team);
    const forward = (carrier.fx * (g.x - carrier.x) + carrier.fy * (g.y - carrier.y)) / (Math.hypot(g.x - carrier.x, g.y - carrier.y) || 1);
    if ((pressure > 4 || st.phase === 'counter') && forward > 0.2) {
      const lastLine = opponents.filter((o) => o.role !== 'keeper')
        .reduce((m, o) => Math.min(m, depthOf(team, o.y)), 1);
      const runners = candidates.filter((p) => p !== carrier && !st.support.has(p) && (p.role === 'fwd' || p.role === 'mid') &&
        depthOf(team, p.y) < depthOf(team, b.y) + 0.05 && Math.abs(depthOf(team, p.y) - lastLine) < 0.18);
      let best = null, bestScore = -Infinity;
      for (const p of runners) {
        for (const ox of [-8, 0, 8]) {
          const x = Math.min(W - 4, Math.max(4, p.x + ox));
          const depth = Math.max(0.06, lastLine - 0.07);
          const y = team.attackDir < 0 ? depth * L : (1 - depth) * L;
          let free = 99;
          for (const o of opponents) free = Math.min(free, Math.hypot(o.x - x, o.y - y));
          const score = free * 0.4 + zoneValue(team, x, y) * 10 - Math.hypot(p.x - x, p.y - y) * 0.05;
          if (score > bestScore) { bestScore = score; best = { p, x, y }; }
        }
      }
      if (best) st.runs.set(best.p, { x: best.x, y: best.y, until: now + 2.6 });
    }
  }
}

// The tactical spot of a player (formation table), shifted by the phase: in possession the
// team pushes up and uses the width; without the ball it stays compact.
export function homeSpot(p, team, ball, attacking, st) {
  const n = toNorm(team.attackDir, ball.x, ball.y);
  const [tx, ty] = tacticTarget(team.tactic, p.index - 1, n.x, n.y, attacking);
  let nx = tx, ny = ty;
  if (st) {
    if (attacking && (st.phase === 'attack' || st.phase === 'counter')) ny -= 0.05; // push up
    // Build-up: midfield and attack push up and spread out, so the ball can be played forward
    // (not everybody in the own box).
    if (attacking && st.phase === 'buildup' && p.role !== 'def') { ny -= 0.08; nx = 0.5 + (nx - 0.5) * 1.15; }
    // Ball wide in the final third: attack the box for the cross. Forwards to the near and far
    // post, the midfielders to the edge of the box.
    if (attacking && (st.phase === 'attack' || st.phase === 'counter') && Math.abs(n.x - 0.5) > 0.2 && n.y < 0.36) {
      const side = n.x < 0.5 ? -1 : 1;
      if (p.role === 'fwd') {
        const near = p.index % 2 === 0;
        nx = 0.5 + side * (near ? 0.07 : -0.09);
        ny = near ? 0.06 : 0.1;
      } else if (p.role === 'mid') {
        ny = Math.min(ny, 0.2);
      }
    }
    if (!attacking) {
      // Compact block: pull everyone towards the ball's line (length about 35 m).
      const lineY = Math.min(0.95, Math.max(0.05, n.y));
      ny = lineY + (ny - lineY) * 0.8;
      nx = 0.5 + (nx - 0.5) * 0.92 + (n.x - 0.5) * 0.12;
    }
  }
  return toWorld(team.attackDir, Math.min(0.97, Math.max(0.03, nx)), Math.min(0.97, Math.max(0.03, ny)));
}

// --- defending ----------------------------------------------------------------------------

// Defenders pick up the opponents' forwards near their own goal (goal-side marking).
export function planMarking(team, world, candidates, st, lvl) {
  st.marks.clear();
  const b = world.ball;
  const own = ownGoal(team);
  if (Math.hypot(b.x - own.x, b.y - own.y) > 42 || world.rng.next() > (lvl.marking ?? 0.7) + 0.3) return;
  const threats = world.teams[1 - team.id].players
    .filter((o) => !o.sentOff && o.role !== 'keeper' && Math.hypot(o.x - own.x, o.y - own.y) < 30 && o !== b.lastTouch)
    .sort((a, c) => Math.hypot(a.x - own.x, a.y - own.y) - Math.hypot(c.x - own.x, c.y - own.y));
  const free = candidates.slice();
  for (const o of threats.slice(0, 4)) {
    let best = null, bd = 18;
    for (const p of free) { const d = Math.hypot(p.x - o.x, p.y - o.y); if (d < bd) { bd = d; best = p; } }
    if (!best) continue;
    free.splice(free.indexOf(best), 1);
    const gx = own.x - o.x, gy = own.y - o.y, gd = Math.hypot(gx, gy) || 1;
    st.marks.set(best, { x: o.x + (gx / gd) * 1.6, y: o.y + (gy / gd) * 1.6 });
  }
}

// Cover shadow: stand in the pass lane from the ball carrier to his most dangerous team-mate.
export function coverSpot(team, world, carrier) {
  const b = world.ball;
  let best = null, bestV = -1;
  for (const m of world.teams[1 - team.id].players) {
    if (m === carrier || m.sentOff || m.role === 'keeper') continue;
    const d = Math.hypot(m.x - b.x, m.y - b.y);
    if (d < 6 || d > 30) continue;
    const v = zoneValue(world.teams[m.team], m.x, m.y);
    if (v > bestV) { bestV = v; best = m; }
  }
  if (!best) return null;
  const dx = best.x - b.x, dy = best.y - b.y, d = Math.hypot(dx, dy);
  const k = Math.min(5, d * 0.4);
  return { x: b.x + (dx / d) * k, y: b.y + (dy / d) * k };
}

// Press triggers: the carrier faces his own goal, is trapped (standing on the ball) or is near
// the touchline. Then a second player goes for the ball too.
export function pressTrigger(world, carrier) {
  if (!carrier) return false;
  const team = world.teams[carrier.team];
  const g = ownGoal(team);
  const back = (carrier.fx * (g.x - carrier.x) + carrier.fy * (g.y - carrier.y)) / (Math.hypot(g.x - carrier.x, g.y - carrier.y) || 1);
  return back > 0.5 || carrier.state === 'trap' || carrier.x < 4 || carrier.x > W - 4;
}
