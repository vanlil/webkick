import { DT, PITCH, tuning } from '../config.js';
import { ownGoal } from '../world/team.js';
import { tacticTarget, toWorld } from '../ai/tactics.js';
import { startSetPiece, stepSetPiece } from './setpieces.js';

// Match phases:
//   'start'    teams in their halves; the clock starts when the kicking team touches the ball
//   'play'
//   'setpiece' throw-in, corner or goal kick (setpieces.js)
//   'goal'     celebration, then kick-off by the team that conceded
//   'halftime' pause, then the teams change sides
//   'fulltime'

const IDLE = { dx: 0, dy: 0, fire: false, firePressed: false, fireReleased: false };
const HOLD = { restart: true };
const HALF_GAME_SECONDS = 45 * 60;

export function createMatch(world) {
  const first = world.rng.next() < 0.5 ? 0 : 1; // coin toss
  world.score[0] = world.score[1] = 0;
  world.match = { phase: 'start', half: 1, clock: 0, timer: 0, firstStart: first, startTeam: first, startSeq: 0, setPiece: null };
  setupCentreStart(world, first);
}

const halfSeconds = () => tuning.game.halfMinutes * 60;

// Game time shown on the clock, in seconds (0 … 90 minutes).
export function gameTime(m) {
  return (m.half - 1) * HALF_GAME_SECONDS + Math.min(1, m.clock / halfSeconds()) * HALF_GAME_SECONDS;
}

// Before the players move: joystick overrides for the current phase.
export function matchPreStep(world, humanJoy, joys) {
  const m = world.match;
  if (m.phase === 'start') {
    // Everyone waits except the kicking team's striker (the CPU's after a short pause).
    // The human may move his player; clampCentreStart keeps him in his half.
    m.timer -= DT;
    const striker = world.teams[m.startTeam].players[10];
    for (const p of world.players) {
      if (p === striker) {
        if (!world.teams[p.team].human && m.timer > 0) joys.set(p, IDLE);
        continue;
      }
      if (world.human && p === world.human.player) continue;
      joys.set(p, IDLE);
    }
  } else if (m.phase === 'setpiece') {
    stepSetPiece(world, humanJoy, joys);
  } else if (m.phase === 'halftime' || m.phase === 'fulltime') {
    for (const p of world.players) joys.set(p, IDLE);
  }
}

// After the players and the ball moved: clock, goals, ball out of play, phase changes.
export function matchPostStep(world, events) {
  const m = world.match;
  const { ball } = world;

  if (m.phase === 'play' || m.phase === 'setpiece') {
    m.clock += DT;
    // The half ends at the next moment the ball is in play.
    if (m.clock >= halfSeconds() && m.phase === 'play') {
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
      checkOutOfPlay(world, events);
      break;
    case 'goal':
      m.timer -= DT;
      if (m.timer <= 0) setupCentreStart(world, m.startTeam);
      break;
    case 'halftime':
      m.timer -= DT;
      if (m.timer <= 0) {
        for (const t of world.teams) t.attackDir = -t.attackDir;
        m.half = 2;
        m.clock = 0;
        setupCentreStart(world, 1 - m.firstStart);
      }
      break;
    default:
      break;
  }
}

function goalScored(world, e) {
  const m = world.match;
  // Goal 0 is the top goal: the team attacking upwards scores there.
  const scorer = world.teams.find((t) => (t.attackDir < 0 ? 0 : 1) === e.goal);
  world.score[scorer.id]++;
  e.team = scorer.id;
  m.phase = 'goal';
  m.timer = tuning.goal.resetDelay;
  m.startTeam = 1 - scorer.id;
}

function endHalf(world, events) {
  const m = world.match;
  const { ball } = world;
  Object.assign(ball, { vx: 0, vy: 0, vz: 0, spin: 0, heldBy: ball.heldBy || HOLD });
  events.push({ type: 'whistle', kind: 'long' });
  if (m.half === 1) {
    m.phase = 'halftime';
    m.timer = tuning.setpiece.halfTimePause;
    events.push({ type: 'halftime' });
  } else {
    m.phase = 'fulltime';
    events.push({ type: 'fulltime' });
  }
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
      if (team.id === m.startTeam && p === team.players[10]) continue;
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
      const striker = team.players[10];
      resetPlayer(striker, ball.x - 0.5, ball.y - team.attackDir * 1.1, team.attackDir);
    }
  }
  if (world.human) {
    const t = world.teams[world.human.team];
    world.human.player = t.id === teamId ? t.players[10] : t.players[9];
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
  p.ai.turning = false;
  p.ai.lastSector = null;
}
