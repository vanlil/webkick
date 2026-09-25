import { DT, PITCH, tuning } from '../config.js';
import { ownGoal } from '../world/team.js';
import { tacticTarget, toWorld } from '../ai/tactics.js';
import { startSetPiece, stepSetPiece } from './setpieces.js';
import { pickReferee, judgeFoul, inPenaltyArea } from './referee.js';

// Match phases:
//   'start'    teams in their halves; the clock starts when the kicking team touches the ball
//   'play'
//   'setpiece' throw-in, corner or goal kick (setpieces.js)
//   'goal'     celebration, then kick-off by the team that conceded
//   'halftime' pause, then the teams change sides
//   'shootout' penalty shoot-out after a draw (option); 'shootoutKick' while a kick is on
//   'fulltime'

const IDLE = { dx: 0, dy: 0, fire: false, firePressed: false, fireReleased: false };
const HALF_GAME_SECONDS = 45 * 60;

export function createMatch(world) {
  const first = world.rng.next() < 0.5 ? 0 : 1; // coin toss
  world.score[0] = world.score[1] = 0;
  world.teams[0].attackDir = -1;
  world.teams[1].attackDir = 1;
  for (const p of world.players) {
    p.yellow = 0;
    p.sentOff = false;
    p.stamina = 1;
  }
  world.referee = pickReferee(world.rng);
  world.match = { phase: 'start', half: 1, clock: 0, timer: 0, firstStart: first, startTeam: first, startSeq: 0, setPiece: null, shootout: null };
  setupCentreStart(world, first);
}

// Real seconds per half; the two halves of extra time are a third as long (at least 1 min).
const halfSeconds = (half = 1) => (half <= 2 ? tuning.game.halfMinutes * 60 : Math.max(60, tuning.game.halfMinutes * 20));

// Game time shown on the clock, in seconds: 0–45, 45–90, extra time 90–105, 105–120.
export function gameTime(m) {
  const start = [0, 45, 90, 105][m.half - 1] * 60;
  const length = (m.half <= 2 ? 45 : 15) * 60;
  return start + Math.min(1, m.clock / halfSeconds(m.half)) * length;
}

// Before the players move: joystick overrides for the current phase.
export function matchPreStep(world, humanJoy, joys) {
  const m = world.match;
  if (m.phase === 'start') {
    // Everyone waits except the kicking team's striker (the CPU's after a short pause).
    // The human may move his player; clampCentreStart keeps him in his half.
    m.timer -= DT;
    const striker = strikerOf(world.teams[m.startTeam]);
    for (const p of world.players) {
      if (p === striker) {
        const humanPlays = world.human && world.human.player === p;
        if (!humanPlays && m.timer > 0) joys.set(p, IDLE);
        // A CPU-controlled striker of the human's team (fixed-player mode) walks to the ball.
        else if (!humanPlays && world.teams[p.team].human) joys.set(p, towards(p, world.ball));
        continue;
      }
      if (world.human && p === world.human.player) continue;
      joys.set(p, IDLE);
    }
  } else if (m.phase === 'setpiece') {
    stepSetPiece(world, humanJoy, joys);
  } else if (m.phase === 'halftime' || m.phase === 'fulltime' || m.phase === 'shootout' || m.phase === 'shootoutKick') {
    for (const p of world.players) joys.set(p, IDLE);
  }
}

// After the players and the ball moved: clock, goals, ball out of play, phase changes.
export function matchPostStep(world, events) {
  const m = world.match;
  const { ball } = world;

  if (m.phase === 'play' || m.phase === 'setpiece') {
    m.clock += DT;
    // Time is up: the half ends, but not while a shot / free kick / penalty is still on its way
    // to goal (at most 8 s extra), so a goal in the last second still counts.
    const over = m.clock >= halfSeconds(m.half);
    if (over && m.phase === 'play' && (!attackOnGoal(world) || m.clock >= halfSeconds(m.half) + 8)) {
      endHalf(world, events);
      return;
    }
  }

  switch (m.phase) {
    case 'start':
      clampCentreStart(world);
      if (ball.touchSeq !== m.startSeq) m.phase = 'play';
      break;
    case 'play':
      for (const e of events) {
        if (e.type === 'goal') {
          goalScored(world, e);
          return;
        }
      }
      for (const e of events) {
        if (e.type === 'foul' && foulCalled(world, e, events)) return;
      }
      checkOutOfPlay(world, events);
      break;
    case 'shootoutKick':
      stepShootoutKick(world, events);
      break;
    case 'shootout':
      m.timer -= DT;
      if (m.timer <= 0) nextPenalty(world, events);
      break;
    case 'goal':
      m.timer -= DT;
      if (m.timer <= 0) {
        setupCentreStart(world, m.startTeam);
        events.push({ type: 'whistle', kind: 'short' });
      }
      break;
    case 'halftime':
      m.timer -= DT;
      if (m.timer <= 0) {
        for (const t of world.teams) t.attackDir = -t.attackDir;
        for (const p of world.players) p.stamina = Math.min(1, (p.stamina ?? 1) + 0.15); // a break
        m.half++;
        m.clock = 0;
        setupCentreStart(world, m.half % 2 === 1 ? m.firstStart : 1 - m.firstStart);
        events.push({ type: 'whistle', kind: 'short' });
      }
      break;
    default:
      break;
  }
}

// Ball moving fast towards a goal from within 30 m.
function attackOnGoal(world) {
  const b = world.ball;
  if (b.dead || b.heldBy || Math.hypot(b.vx, b.vy) < 4) return false;
  return [0, PITCH.length].some((gy) => Math.abs(b.y - gy) < 30 && (gy - b.y) * b.vy > 0);
}

function goalScored(world, e) {
  const m = world.match;
  // Goal 0 is the top goal: the team attacking upwards scores there.
  const scorer = world.teams.find((t) => (t.attackDir < 0 ? 0 : 1) === e.goal);
  world.score[scorer.id]++;
  e.team = scorer.id;
  world.ball.dead = true; // nobody plays the ball out of the net
  m.phase = 'goal';
  m.timer = tuning.goal.resetDelay;
  m.startTeam = 1 - scorer.id;
}

function endHalf(world, events) {
  const m = world.match;
  // The ball is dead from the whistle on (nobody can play it), but it lands and rolls out
  // naturally instead of stopping in mid-air.
  world.ball.dead = true;
  events.push({ type: 'whistle', kind: 'long' });
  const level = world.score[0] === world.score[1];
  const rule = tuning.game.draw;
  if (m.half === 1 || m.half === 3) {
    m.phase = 'halftime';
    m.timer = tuning.setpiece.halfTimePause;
    events.push({ type: m.half === 1 ? 'halftime' : 'extrabreak' });
  } else if (m.half === 2 && level && rule === 'extra') {
    m.phase = 'halftime';
    m.timer = tuning.setpiece.halfTimePause;
    events.push({ type: 'extratime' });
  } else if (level && (rule === 'penalties' || (rule === 'extra' && m.half === 4))) {
    startShootout(world, events);
  } else {
    m.phase = 'fulltime';
    events.push({ type: 'fulltime' });
  }
}

// Simple joystick towards a point (8 directions).
function towards(p, target) {
  const a = Math.atan2(target.y - p.y, target.x - p.x);
  const s = Math.round(a / (Math.PI / 4));
  return {
    dx: Math.round(Math.cos(s * Math.PI / 4)), dy: Math.round(Math.sin(s * Math.PI / 4)),
    fire: false, firePressed: false, fireReleased: false, noReverse: true,
  };
}

// --- Fouls ----------------------------------------------------------------------------------

// The referee judges a foul. Seen: whistle, maybe a card, then a free kick or a penalty.
// Not seen: play on. Returns true if play was stopped.
function foulCalled(world, e, events) {
  const verdict = judgeFoul(world, e);
  e.seen = verdict.seen;
  if (!verdict.seen) return false;
  const offender = e.by;
  const offenders = world.teams[offender.team];
  if (verdict.card) {
    if (verdict.card === 'yellow') offender.yellow = (offender.yellow || 0) + 1;
    events.push({ type: 'card', color: verdict.card, player: offender });
    if (verdict.card === 'red') sendOff(world, offender);
  }
  const victims = 1 - offender.team;
  if (inPenaltyArea(offenders, e.x, e.y)) {
    startSetPiece(world, 'penalty', victims, 0, 0, events);
  } else {
    const x = Math.min(PITCH.width - 0.5, Math.max(0.5, e.x));
    const y = Math.min(PITCH.length - 0.5, Math.max(0.5, e.y));
    startSetPiece(world, 'freekick', victims, x, y, events);
  }
  world.match.setPiece.victim = e.victim;
  return true;
}

// A sent-off player leaves the pitch; he waits at the side of the pitch.
function sendOff(world, p) {
  p.sentOff = true;
  p.state = 'leaving'; // walks off (world.js), then 'off'
  p.vx = p.vy = 0;
  p.aftertouch = null;
  if (world.human && world.human.player === p) {
    const mates = world.teams[p.team].players.filter((q) => q.role !== 'keeper' && !q.sentOff);
    mates.sort((a, b) => Math.hypot(a.x - world.ball.x, a.y - world.ball.y) - Math.hypot(b.x - world.ball.x, b.y - world.ball.y));
    if (mates.length) {
      world.human.player = mates[0];
      // Fixed-player mode: a midfielder takes over.
      if (world.human.fixed != null) {
        const mid = mates.find((q) => q.role === 'mid') || mates[0];
        world.human.player = mid;
        world.human.fixed = mid.index;
      }
    }
  }
}

// --- Penalty shoot-out ----------------------------------------------------------------------
// 5 penalties each, alternately, at the top goal; then sudden death.

function startShootout(world, events) {
  const m = world.match;
  const first = world.rng.next() < 0.5 ? 0 : 1;
  m.shootout = { goals: [0, 0], kicks: [0, 0], turn: first, order: [0, 0], winner: null };
  m.phase = 'shootout';
  m.timer = 2;
  events.push({ type: 'shootout' });
}

function nextPenalty(world, events) {
  const m = world.match;
  const so = m.shootout;
  const shooters = world.teams[so.turn];
  const keepers = world.teams[1 - so.turn];
  // The shooting team attacks the top goal, so the defending keeper stands there.
  shooters.attackDir = -1;
  keepers.attackDir = 1;
  // Everyone else waits in the centre circle.
  for (const t of world.teams) {
    t.players.forEach((p, i) => {
      if (p.sentOff) return;
      const a = (i / 11) * Math.PI * 2 + (t.id ? 0.15 : 0);
      resetPlayer(p, PITCH.width / 2 + Math.cos(a) * 6, PITCH.length / 2 + Math.sin(a) * 6, t.attackDir);
    });
  }
  const outfield = shooters.players.filter((p) => p.role !== 'keeper' && !p.sentOff);
  const taker = outfield[(outfield.length - 1) - (so.order[so.turn]++ % outfield.length)];
  startSetPiece(world, 'penalty', so.turn, 0, 0, events, { shootout: true, taker });
}

// Watch the kick: a goal, or no goal once the ball is dead (caught, out, stopped) or after 3 s.
function stepShootoutKick(world, events) {
  const m = world.match;
  const so = m.shootout;
  const { ball } = world;
  m.timer -= DT;
  const goal = events.some((e) => e.type === 'goal');
  const over = goal || m.timer <= 0 || ball.heldBy || ball.y < -1 || ball.x < -1 || ball.x > PITCH.width + 1 ||
    (Math.hypot(ball.vx, ball.vy) < 0.5 && m.timer < 2.2);
  if (!over) return;
  if (goal) so.goals[so.turn]++;
  so.kicks[so.turn]++;
  events.push({ type: goal ? 'shootoutGoal' : 'shootoutMiss', team: so.turn });

  const [g0, g1] = so.goals, [k0, k1] = so.kicks;
  let winner = null;
  if (k0 <= 5 && k1 <= 5) {
    // Decided early if one team can no longer catch up.
    if (g0 > g1 + (5 - k1)) winner = 0;
    else if (g1 > g0 + (5 - k0)) winner = 1;
  }
  if (winner === null && k0 === k1 && k0 >= 5 && g0 !== g1) winner = g0 > g1 ? 0 : 1;
  if (winner !== null) {
    so.winner = winner;
    m.phase = 'fulltime';
    ball.dead = true;
    events.push({ type: 'whistle', kind: 'long' }, { type: 'fulltime' });
    return;
  }
  so.turn = 1 - so.turn;
  m.phase = 'shootout';
  m.timer = 1.5;
}

// Ball completely over a line: throw-in, corner or goal kick.
function checkOutOfPlay(world, events) {
  const { ball } = world;
  if (ball.heldBy || ball.inGoal >= 0) return;
  const r = tuning.ball.radius;
  const W = PITCH.width, L = PITCH.length;
  const last = ball.lastTouch ? ball.lastTouch.team : world.possession;

  if (ball.x < -r || ball.x > W + r) {
    startSetPiece(world, 'throwin', 1 - last, ball.x < 0 ? 0 : W, Math.min(L - 0.5, Math.max(0.5, ball.y)), events);
  } else if (ball.y < -r || ball.y > L + r) {
    const lineY = ball.y < 0 ? 0 : L;
    const defending = world.teams.find((t) => ownGoal(t).y === lineY);
    if (last === defending.id) {
      startSetPiece(world, 'corner', 1 - defending.id, ball.x < W / 2 ? 0.5 : W - 0.5, lineY === 0 ? 0.5 : L - 0.5, events);
    } else {
      startSetPiece(world, 'goalkick', defending.id, 0, 0, events);
    }
  }
}

// Kick-off: keep the kicking team's opponents in their half and out of the centre circle.
function clampCentreStart(world) {
  const m = world.match;
  const cx = PITCH.width / 2, cy = PITCH.length / 2;
  for (const team of world.teams) {
    const side = -team.attackDir; // own half: y > centre for side +1
    for (const p of team.players) {
      if (p.sentOff) continue;
      if (team.id === m.startTeam && p === strikerOf(team)) continue;
      if ((p.y - cy) * side < 0.5) p.y = cy + 0.5 * side;
      if (team.id !== m.startTeam) {
        const dx = p.x - cx, dy = p.y - cy;
        const d = Math.hypot(dx, dy);
        const R = PITCH.circleRadius + 0.3;
        if (d < R) {
          p.x = cx + (dx / (d || 1)) * R;
          p.y = cy + (dy / (d || 1)) * R;
        }
      }
    }
  }
}

// Everyone in the own half; `teamId` kicks off from the centre spot.
export function setupCentreStart(world, teamId) {
  const m = world.match;
  const { ball } = world;
  Object.assign(ball, {
    x: PITCH.width / 2, y: PITCH.length / 2, z: 0, vx: 0, vy: 0, vz: 0,
    spin: 0, inGoal: -1, heldBy: null, lastTouch: null, dead: false,
  });
  ball.prev.x = ball.x;
  ball.prev.y = ball.y;
  ball.prev.z = 0;
  world.possession = teamId;
  world.history.length = 0;
  m.phase = 'start';
  m.startTeam = teamId;
  m.startSeq = ball.touchSeq;
  m.timer = 1.0;
  m.setPiece = null;

  for (const team of world.teams) {
    team.chaser = null;
    const kicking = team.id === teamId;
    for (const p of team.players) {
      if (p.sentOff) continue;
      let x, y;
      if (p.role === 'keeper') {
        const g = ownGoal(team);
        x = g.x;
        y = g.y + g.into;
      } else {
        const [nx, ny] = tacticTarget(team.tactic, p.index - 1, 0.5, 0.5, false);
        ({ x, y } = toWorld(team.attackDir, nx, Math.max(0.53, ny)));
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
      // A forward stands just behind the ball, facing the opponent's goal; slightly to the
      // side, so he does not hide the ball in the 3/4 view.
      const striker = strikerOf(team);
      resetPlayer(striker, ball.x - 0.5, ball.y - team.attackDir * 1.1, team.attackDir);
    }
  }
  if (world.human) {
    const t = world.teams[world.human.team];
    const own = t.players.filter((p) => p.role !== 'keeper' && !p.sentOff);
    const fixed = world.human.fixed != null ? t.players[world.human.fixed] : null;
    if (fixed && !fixed.sentOff) world.human.player = fixed;
    else world.human.player = t.id === teamId ? strikerOf(t) : own[own.length - 2] || own[0];
  }
}

// The kick-off taker: the last outfield player still on the pitch (a forward).
function strikerOf(team) {
  for (let i = team.players.length - 1; i > 0; i--) if (!team.players[i].sentOff) return team.players[i];
  return team.players[0];
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
  p.ai.turning = false;
  p.ai.lastSector = null;
}
