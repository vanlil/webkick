import { DT, PITCH, WIND_LEVELS, tuning, currentSurface } from '../config.js';

// Ball in 2.5D: x/y on the ground plane, z = height above ground.
export function createBall(x, y) {
  return {
    x, y, z: 0,
    vx: 0, vy: 0, vz: 0,
    spin: 0,          // sideways curve (rad/s of velocity rotation), set by aftertouch
    roll: 0,          // accumulated roll distance, for drawing only
    touchSeq: 0,      // increases on every touch; lets aftertouch know the ball was not touched since
    inGoal: -1,       // index of the goal the ball is in, or -1
    prev: { x, y, z: 0 },
  };
}

export function isAirborne(ball) {
  return ball.z > 0.001 || ball.vz > 0.001;
}

export function windVector() {
  const speed = WIND_LEVELS[tuning.game.wind] || 0;
  const a = (tuning.game.windDirDeg * Math.PI) / 180;
  return { x: Math.sin(a) * speed, y: -Math.cos(a) * speed };
}

// Goal 0 at the top (net towards negative y), goal 1 at the bottom.
export const GOALS = [
  { lineY: 0, dir: -1 },
  { lineY: PITCH.length, dir: 1 },
];
const GOAL_X0 = PITCH.width / 2 - PITCH.goalWidth / 2;
const GOAL_X1 = PITCH.width / 2 + PITCH.goalWidth / 2;
const POSTS_X = [GOAL_X0, GOAL_X1];

const MAX_SUBSTEP_DIST = 0.08; // metres per substep; keeps fast shots from passing through posts

// Advances the ball one simulation step. Pushes events ('bounce', 'post', 'bar', 'net',
// 'goal') into `events`.
// ball.prev (for render interpolation) is set by the caller at the start of the whole step.
export function stepBall(ball, rng, events) {
  // Start of this step's movement: players test contact against the whole path (swept test).
  if (!ball.from) ball.from = { x: 0, y: 0, z: 0 };
  ball.from.x = ball.x;
  ball.from.y = ball.y;
  ball.from.z = ball.z;
  const speed = Math.hypot(ball.vx, ball.vy, ball.vz);
  const n = Math.min(8, Math.max(1, Math.ceil((speed * DT) / MAX_SUBSTEP_DIST)));
  const h = DT / n;
  for (let i = 0; i < n; i++) substep(ball, h, rng, events);
  ball.spin *= Math.exp(-tuning.kick.spinDecay * DT);
}

function substep(ball, h, rng, events) {
  const surface = currentSurface();
  const cfg = tuning.ball;
  const px = ball.x, py = ball.y, pz = ball.z;

  if (isAirborne(ball)) {
    // Air drag acts on the velocity relative to the moving air, so wind drifts the ball.
    const wind = windVector();
    const drag = cfg.airDrag * surface.airDragMul;
    ball.vx -= (ball.vx - wind.x) * drag * h;
    ball.vy -= (ball.vy - wind.y) * drag * h;
    ball.vz -= cfg.gravity * h;
    if (ball.spin) rotateVelocity(ball, ball.spin * h);

    ball.x += ball.vx * h;
    ball.y += ball.vy * h;
    ball.z += ball.vz * h;

    if (ball.z <= 0) {
      ball.z = 0;
      if (-ball.vz > cfg.minBounceVz) {
        events.push({ type: 'bounce', strength: -ball.vz });
        ball.vz = -ball.vz * surface.restitution;
        ball.vx *= surface.bounceGrip;
        ball.vy *= surface.bounceGrip;
        if (surface.bumpiness > 0) rotateVelocity(ball, rng.range(-1, 1) * surface.bumpiness);
      } else {
        ball.vz = 0;
      }
      ball.spin *= 0.5;
    }
  } else {
    // Rolling: constant friction plus speed-proportional drag. Spin curves it only a little.
    const speed = Math.hypot(ball.vx, ball.vy);
    if (speed > 0) {
      const newSpeed = Math.max(0, speed - (surface.rollFriction + surface.rollDrag * speed) * h);
      const k = newSpeed / speed;
      ball.vx *= k;
      ball.vy *= k;
    }
    if (ball.spin) rotateVelocity(ball, ball.spin * 0.3 * h);
    ball.x += ball.vx * h;
    ball.y += ball.vy * h;
  }

  ball.roll += Math.hypot(ball.vx, ball.vy) * h;
  GOALS.forEach((goal, i) => collideGoal(ball, goal, i, px, py, pz, events));
  collideBoards(ball);
}

function rotateVelocity(ball, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const vx = ball.vx * c - ball.vy * s;
  ball.vy = ball.vx * s + ball.vy * c;
  ball.vx = vx;
}

// Depth of a point behind the goal line (positive = on the goal side of the line).
const depthOf = (goal, y) => (y - goal.lineY) * goal.dir;

function insideGoal(goal, x, y, z) {
  const d = depthOf(goal, y);
  return x > GOAL_X0 && x < GOAL_X1 && d > 0 && d < PITCH.goalDepth && z < PITCH.goalHeight;
}

function collideGoal(ball, goal, index, px, py, pz, events) {
  const g = tuning.goal;
  const r = tuning.ball.radius;
  const H = PITCH.goalHeight;
  const hitR = r + g.postRadius;

  // Posts: vertical cylinders.
  if (ball.z < H + r) {
    for (const postX of POSTS_X) {
      const dx = ball.x - postX;
      const dy = ball.y - goal.lineY;
      const d = Math.hypot(dx, dy);
      if (d < hitR && d > 1e-6) {
        const nx = dx / d, ny = dy / d;
        const vn = ball.vx * nx + ball.vy * ny;
        if (vn < 0) {
          ball.vx -= (1 + g.postRestitution) * vn * nx;
          ball.vy -= (1 + g.postRestitution) * vn * ny;
          events.push({ type: 'post', strength: -vn });
        }
        ball.x = postX + nx * hitR;
        ball.y = goal.lineY + ny * hitR;
      }
    }
  }

  // Crossbar: horizontal cylinder along x.
  if (ball.x > GOAL_X0 && ball.x < GOAL_X1) {
    const dy = ball.y - goal.lineY;
    const dz = ball.z - H;
    const d = Math.hypot(dy, dz);
    if (d < hitR && d > 1e-6) {
      const ny = dy / d, nz = dz / d;
      const vn = ball.vy * ny + ball.vz * nz;
      if (vn < 0) {
        ball.vy -= (1 + g.postRestitution) * vn * ny;
        ball.vz -= (1 + g.postRestitution) * vn * nz;
        events.push({ type: 'bar', strength: -vn });
      }
      ball.y = goal.lineY + ny * hitR;
      ball.z = H + nz * hitR;
    }
  }

  // Net and goal line.
  const was = insideGoal(goal, px, py, pz);
  const now = insideGoal(goal, ball.x, ball.y, ball.z);
  if (!was && now) {
    if (depthOf(goal, py) <= 0) {
      // Entered across the goal line, between the posts and under the bar.
      if (ball.inGoal !== index) {
        ball.inGoal = index;
        events.push({ type: 'goal', goal: index });
      }
    } else {
      // Hit the net from outside: side, back or roof.
      ball.x = px; ball.y = py; ball.z = pz;
      if (pz >= H) {
        ball.vz = Math.abs(ball.vz) * 0.2;
        ball.vy += goal.dir * 0.4; // let it roll off the back of the roof
      } else if (px <= GOAL_X0 || px >= GOAL_X1) {
        ball.vx = -ball.vx * g.netDamping;
      } else {
        ball.vy = -ball.vy * g.netDamping;
      }
      events.push({ type: 'net' });
    }
  } else if (was && !now && depthOf(goal, ball.y) > 0) {
    // Inside the goal and about to leave through the net: the net catches the ball.
    const k = g.netDamping;
    if (ball.x <= GOAL_X0 + r) { ball.x = GOAL_X0 + r; ball.vx = Math.abs(ball.vx) * k; }
    if (ball.x >= GOAL_X1 - r) { ball.x = GOAL_X1 - r; ball.vx = -Math.abs(ball.vx) * k; }
    if (depthOf(goal, ball.y) >= PITCH.goalDepth - r) {
      ball.y = goal.lineY + goal.dir * (PITCH.goalDepth - r);
      ball.vy = -goal.dir * Math.abs(ball.vy) * k;
    }
    if (ball.z >= H - r) { ball.z = H - r; ball.vz = -Math.abs(ball.vz) * k; }
    ball.spin = 0;
    events.push({ type: 'net' });
  }
}

// Advertising boards around the pitch. Until the rules exist (M4) they keep the ball in play.
function collideBoards(ball) {
  const m = PITCH.margin - 0.5;
  const minX = -m, maxX = PITCH.width + m;
  const minY = -m, maxY = PITCH.length + m;
  const e = tuning.ball.boardRestitution;
  if (ball.z > 1) return; // above the boards; clamped once it comes down
  if (ball.x < minX) { ball.x = minX; ball.vx = Math.abs(ball.vx) * e; }
  if (ball.x > maxX) { ball.x = maxX; ball.vx = -Math.abs(ball.vx) * e; }
  if (ball.y < minY) { ball.y = minY; ball.vy = Math.abs(ball.vy) * e; }
  if (ball.y > maxY) { ball.y = maxY; ball.vy = -Math.abs(ball.vy) * e; }
}
