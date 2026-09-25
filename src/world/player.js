import { DT, PITCH, tuning } from '../config.js';
import { isAirborne } from './ball.js';

const DIAG = Math.SQRT1_2;
const REVERSED = -0.7; // dot product below this = stick pulled against the running direction

// States: 'run' (normal), 'trap' (ball stopped at the feet, fire held),
// 'jump' (header attempt), 'down' (on the ground after an overhead kick).
export function createPlayer({ x, y, kit, pace = 1.0, shooting = 0.8, passing = 0.8 }) {
  return {
    x, y, z: 0,
    vx: 0, vy: 0,
    fx: 0, fy: -1,      // facing (unit vector, one of 8 directions)
    pace, shooting, passing,
    kit,
    state: 'run',
    stateTimer: 0,
    touchTimer: 0,      // cooldown until the next touch is possible
    shotWindow: 0,      // time left in which fire turns the last touch into a shot
    kickTimer: 0,       // kick animation
    runPhase: 0,        // running animation
    jumpDir: null,      // header direction chosen when the jump started
    headed: false,
    trapDir: null,      // facing when the ball was trapped (for the flick)
    flickTimer: 0,      // time left after pushing the stick forward in trap mode
    aftertouch: null,   // { time, dx, dy, seq } while the last kick can still be bent
    prev: { x, y, z: 0 },
  };
}

export function playerSpeed(p) {
  return Math.hypot(p.vx, p.vy);
}

// Normalised 8-way direction from joystick values (-1, 0, 1).
function joyDir(joy) {
  if (!joy.dx && !joy.dy) return null;
  return joy.dx && joy.dy ? { x: joy.dx * DIAG, y: joy.dy * DIAG } : { x: joy.dx, y: joy.dy };
}

const dot = (a, b) => a.x * b.x + a.y * b.y;

// One simulation step for a human-controlled player: movement and all ball actions.
// `world` = { ball, rng, events, step }.
export function stepPlayer(p, joy, world) {
  p.prev.x = p.x;
  p.prev.y = p.y;
  p.prev.z = p.z;
  for (const t of ['touchTimer', 'shotWindow', 'kickTimer', 'flickTimer']) {
    if (p[t] > 0) p[t] -= DT;
  }
  const dir = joyDir(joy);

  if (p.state === 'trap') stepTrap(p, joy, dir, world);
  else if (p.state === 'jump') stepJump(p, world);
  else if (p.state === 'down') stepDown(p);
  else stepRun(p, joy, dir, world);

  applyAftertouch(p, dir, world.ball);
  keepInStadium(p);
}

function stepRun(p, joy, dir, world) {
  const { ball } = world;
  const cfg = tuning.player;
  const speed = playerSpeed(p);
  const moveDir = speed > 0.5 ? { x: p.vx / speed, y: p.vy / speed } : null;

  // Stick pulled against the running direction, just as the ball is reached: lob or
  // overhead kick. Checked before moving, because moving turns the player round.
  // `noReverse`: the AI sets it so a change of direction is never read as a lob.
  if (!joy.noReverse && dir && moveDir && dot(dir, moveDir) < REVERSED && p.touchTimer <= 0 && canTouch(p, ball, world)) {
    const fx = p.x + moveDir.x * cfg.footReach;
    const fy = p.y + moveDir.y * cfg.footReach;
    const d = Math.hypot(ball.x - fx, ball.y - fy);
    if (!isAirborne(ball) && speed > tuning.kick.lobMinSpeed && d < cfg.touchRadius) {
      kick(p, ball, moveDir, tuning.kick.lobSpeed, tuning.kick.lobLift, p.passing, world, 'lob');
      return;
    }
    if (ball.z > 0.6 && ball.z < 2.2 && d < 1.0) {
      overheadKick(p, ball, dir, world);
      return;
    }
  }

  move(p, dir);

  if (joy.firePressed && canTouch(p, ball, world)) {
    const k = tuning.kick;
    const foot = footPoint(p);
    // Fire just after a touch: shot in the facing direction.
    if (p.shotWindow > 0 && ball.z < 0.6 && Math.hypot(ball.x - foot.x, ball.y - foot.y) < k.shotReach) {
      const power = k.shotSpeed * (0.75 + 0.25 * p.shooting) + playerSpeed(p) * k.runBonus;
      kick(p, ball, { x: p.fx, y: p.fy }, power, k.shotLift, p.shooting, world, 'shot');
      return;
    }
    // Fire with the ball in the air nearby: jump for a header.
    if (isAirborne(ball) && ball.z < 3.5 && Math.hypot(ball.x - p.x, ball.y - p.y) < k.headRange) {
      p.state = 'jump';
      p.stateTimer = k.jumpTime;
      p.jumpDir = dir || { x: p.fx, y: p.fy };
      p.headed = false;
      return;
    }
  }

  footContact(p, joy, world);
}

// Ball contact in normal play:
// - ball at the feet: trap if fire is held, otherwise push it ahead (dribble);
// - ball coming at the player up to shoulder height: he controls it, and it drops at his
//   feet (trap if fire is held); a very hard shot deflects off him instead.
// The tests use the ball's whole movement in the last step, so fast balls cannot slip through.
function footContact(p, joy, world) {
  const { ball } = world;
  const cfg = tuning.player;
  if (p.touchTimer > 0 || !canTouch(p, ball, world)) {
    bodyBlock(p, ball, world);
    return;
  }
  const foot = footPoint(p);
  const atFoot = closestApproach(ball, foot.x, foot.y);
  if (atFoot.z < cfg.touchMaxHeight && atFoot.d < cfg.touchRadius) {
    if (joy.fire) trap(p, ball, world);
    else if (playerSpeed(p) > 0.5) push(p, ball, world);
    else if (approaching(p, ball)) control(p, ball, world, foot);
    return;
  }

  const atBody = closestApproach(ball, p.x, p.y);
  if (atBody.z < cfg.controlHeight + p.z && atBody.d < cfg.controlRadius && approaching(p, ball)) {
    const rel = Math.hypot(ball.vx - p.vx, ball.vy - p.vy, ball.vz);
    if (rel > cfg.controlMaxSpeed) bodyBlock(p, ball, world, atBody);
    else if (joy.fire) trap(p, ball, world);
    else control(p, ball, world, foot);
    return;
  }
  bodyBlock(p, ball, world);
}

function trap(p, ball, world) {
  p.state = 'trap';
  p.trapDir = { x: p.fx, y: p.fy };
  p.trapAim = null;
  p.flickTimer = 0;
  p.vx = p.vy = 0;
  // The ball stops where it is (the player steps to it); a high ball drops.
  ball.vx = ball.vy = 0;
  ball.vz = Math.min(ball.vz, 0);
  ball.spin = 0;
  touched(p, ball, world);
  world.events.push({ type: 'trap' });
}

// Dribble touch: the ball is never attached; how far it runs ahead depends only on the
// player's speed.
function push(p, ball, world) {
  const cfg = tuning.player;
  const speed = Math.max(playerSpeed(p) * cfg.dribbleFactor, cfg.minPush);
  ball.vx = p.fx * speed;
  ball.vy = p.fy * speed;
  ball.vz = Math.min(ball.vz, 0) * 0.3; // a bouncing ball keeps its height and drops, no snap
  ball.spin = 0;
  touched(p, ball, world);
  p.touchTimer = cfg.touchCooldown;
  p.shotWindow = tuning.kick.shotWindow;
  world.events.push({ type: 'touch' });
}

// Cushion the ball: it loses its speed, moves on with the player and glides to his feet
// (no jump); a high ball drops to the ground.
function control(p, ball, world, foot) {
  const cfg = tuning.player;
  ball.vx = p.vx + (foot.x - ball.x) * 4 + p.fx * 0.5;
  ball.vy = p.vy + (foot.y - ball.y) * 4 + p.fy * 0.5;
  ball.vz = Math.min(ball.vz, 0) * 0.3;
  ball.spin = 0;
  touched(p, ball, world);
  p.touchTimer = cfg.touchCooldown;
  world.events.push({ type: 'control' });
}

// Is the ball moving towards the player (and not just rolling away after his own touch)?
function approaching(p, ball) {
  const rx = p.x - ball.x, ry = p.y - ball.y;
  return (ball.vx - p.vx) * rx + (ball.vy - p.vy) * ry > 0.3;
}

// Closest point of the ball's movement in the last step to (x, y), on the ground plane.
// Returns the distance and the ball's height at that point.
function closestApproach(ball, x, y) {
  const f = ball.from || ball;
  const sx = ball.x - f.x, sy = ball.y - f.y;
  const len2 = sx * sx + sy * sy;
  let t = len2 > 1e-9 ? ((x - f.x) * sx + (y - f.y) * sy) / len2 : 1;
  t = Math.max(0, Math.min(1, t));
  const cx = f.x + sx * t, cy = f.y + sy * t;
  return { d: Math.hypot(x - cx, y - cy), z: f.z + (ball.z - f.z) * t, x: cx, y: cy };
}

// Ball bounces off the body (legs up to chest height), losing most of its speed.
// `hit` (optional) is the point where a hard shot passes the player: it deflects from there.
export function bodyBlock(p, ball, world, hit = null) {
  const cfg = tuning.player;
  if (p.kickTimer > 0 || ball.z > 1.8 + p.z || !canTouch(p, ball, world)) return; // never block your own kick
  const { events } = world;
  const bx = hit ? hit.x : ball.x;
  const by = hit ? hit.y : ball.y;
  const dx = bx - p.x;
  const dy = by - p.y;
  const d = Math.hypot(dx, dy);
  const minD = hit ? Math.max(d, 0.05) + 0.01 : cfg.bodyRadius + tuning.ball.radius;
  if (d >= minD || d < 1e-6) return;
  const nx = dx / d, ny = dy / d;
  const relVx = ball.vx - p.vx;
  const relVy = ball.vy - p.vy;
  const vn = relVx * nx + relVy * ny;
  if (vn < 0) {
    const k = cfg.blockDamping;
    ball.vx = p.vx + (relVx - 2 * vn * nx) * k;
    ball.vy = p.vy + (relVy - 2 * vn * ny) * k;
    ball.vz *= 0.3;
    ball.spin = 0;
    touched(p, ball, world);
    if (-vn > 1.5) events.push({ type: 'block', strength: -vn }); // not for a ball just pinched
  }
  // Push the ball out of the body smoothly: it gets at least the player's speed away from
  // him, and the position is corrected by at most a few centimetres per step.
  const pn = p.vx * nx + p.vy * ny;
  const bn = ball.vx * nx + ball.vy * ny;
  if (bn < pn + 0.3) {
    ball.vx += (pn + 0.3 - bn) * nx;
    ball.vy += (pn + 0.3 - bn) * ny;
  }
  const push = Math.min(minD - d, 0.04);
  ball.x += nx * push;
  ball.y += ny * push;
}

// Trap mode: the player stands on the ball. The stick picks a direction; releasing fire
// passes that way, or goes back to dribbling if the stick is centred.
function stepTrap(p, joy, dir, world) {
  const { ball } = world;
  const cfg = tuning.player;
  p.vx = p.vy = 0;

  // Ball knocked away (by an opponent) or kicked up → back to normal play.
  if (Math.hypot(ball.x - p.x, ball.y - p.y) > cfg.footReach + cfg.touchRadius + 0.3 || ball.z > 2.2 || ball.lastTouch !== p) {
    p.state = 'run';
    return;
  }

  if (dir) {
    p.trapAim = dir;
    if (dot(dir, p.trapDir) > 0.7) p.flickTimer = 0.35;
  }
  // Turn towards the chosen direction at a limited speed, walking round the ball in an arc
  // (no jump to the other side), and keep the ball at the foot.
  if (p.trapAim) turnTowards(p, p.trapAim, cfg.trapTurnRate * DT);
  const tx = ball.x - p.fx * cfg.footReach;
  const ty = ball.y - p.fy * cfg.footReach;
  // Step there at most at a brisk walk, so the player never jumps.
  const gx = tx - p.x, gy = ty - p.y;
  const gd = Math.hypot(gx, gy);
  const stepMax = 4 * DT;
  if (gd > stepMax) { p.x += (gx / gd) * stepMax; p.y += (gy / gd) * stepMax; }
  else { p.x = tx; p.y = ty; }
  p.runPhase += Math.min(gd, stepMax) * 2.4; // small steps while turning
  // Hold the ball; a ball that arrived high drops to the ground.
  ball.vx = ball.vy = 0;
  ball.spin = 0;

  if (!joy.fire) {
    p.state = 'run';
    if (dir && p.flickTimer > 0 && dot(dir, p.trapDir) < REVERSED) {
      // Flick: forward, then back while releasing fire → the ball pops up in front.
      ball.vx = p.trapDir.x * 1.2;
      ball.vy = p.trapDir.y * 1.2;
      ball.vz = tuning.kick.flickLift;
      p.fx = p.trapDir.x;
      p.fy = p.trapDir.y;
      touched(p, ball, world);
      p.touchTimer = 0.4;
      p.kickTimer = 0.25;
      world.events.push({ type: 'flick' });
    } else if (dir) {
      p.fx = dir.x;
      p.fy = dir.y;
      kick(p, ball, dir, tuning.kick.passSpeed, 0, p.passing, world, 'pass');
    } else {
      if (p.trapAim) { p.fx = p.trapAim.x; p.fy = p.trapAim.y; }
      p.touchTimer = 0.25;
    }
    p.trapAim = null;
  }
}

// Rotate the facing towards `target` (unit vector) by at most `maxStep` radians.
function turnTowards(p, target, maxStep) {
  const a = Math.atan2(p.fy, p.fx);
  let d = Math.atan2(target.y, target.x) - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  const na = a + Math.sign(d) * Math.min(Math.abs(d), maxStep);
  p.fx = Math.cos(na);
  p.fy = Math.sin(na);
}

function stepJump(p, world) {
  const { ball, events } = world;
  const k = tuning.kick;
  p.stateTimer -= DT;
  const t = 1 - Math.max(0, p.stateTimer) / k.jumpTime;
  p.z = k.jumpHeight * Math.sin(Math.PI * t);
  p.vx *= 0.97;
  p.vy *= 0.97;
  p.x += p.vx * DT;
  p.y += p.vy * DT;

  if (!p.headed && canTouch(p, ball, world)) {
    const hx = p.x + p.fx * 0.15;
    const hy = p.y + p.fy * 0.15;
    const headZ = 1.7 + p.z;
    if (Math.hypot(ball.x - hx, ball.y - hy) < k.headReach && Math.abs(ball.z - headZ) < 0.55) {
      const d = p.jumpDir;
      const error = (1 - p.passing) * k.maxError;
      const a = world.rng.range(-1, 1) * error;
      ball.vx = (d.x * Math.cos(a) - d.y * Math.sin(a)) * k.headerSpeed;
      ball.vy = (d.x * Math.sin(a) + d.y * Math.cos(a)) * k.headerSpeed;
      ball.vz = k.headerLift;
      ball.spin = 0;
      p.fx = d.x;
      p.fy = d.y;
      p.headed = true;
      touched(p, ball, world);
      events.push({ type: 'header', speed: k.headerSpeed });
    }
  }
  if (p.stateTimer <= 0) {
    p.state = 'run';
    p.z = 0;
    p.touchTimer = 0.1;
  }
  bodyBlock(p, ball, world);
}

function overheadKick(p, ball, dir, world) {
  const k = tuning.kick;
  kick(p, ball, dir, k.overheadSpeed, k.overheadLift, p.shooting, world, 'overhead');
  p.state = 'down';
  p.stateTimer = k.overheadTime;
}

function stepDown(p) {
  p.stateTimer -= DT;
  const t = 1 - Math.max(0, p.stateTimer) / tuning.kick.overheadTime;
  p.z = t < 0.3 ? 0.6 * Math.sin((Math.PI * t) / 0.3) : 0;
  p.vx *= 0.85;
  p.vy *= 0.85;
  p.x += p.vx * DT;
  p.y += p.vy * DT;
  if (p.stateTimer <= 0) {
    p.state = 'run';
    p.z = 0;
  }
}

// Kick the ball in direction `d` (unit vector). Skill (0..1) sets the random direction error.
function kick(p, ball, d, speed, lift, skill, world, kind) {
  const a = world.rng.range(-1, 1) * (1 - skill) * tuning.kick.maxError;
  const dx = d.x * Math.cos(a) - d.y * Math.sin(a);
  const dy = d.x * Math.sin(a) + d.y * Math.cos(a);
  launchBall(p, ball, dx * speed, dy * speed, lift, world, kind, true);
}

// Give the ball a velocity as a touch of player p (kicks, throw-ins, corners).
// With `withAftertouch` the player can bend it for a short time afterwards.
export function launchBall(p, ball, vx, vy, vz, world, kind, withAftertouch) {
  ball.vx = vx;
  ball.vy = vy;
  ball.vz = vz;
  ball.spin = 0;
  ball.heldBy = null;
  touched(p, ball, world);
  const speed = Math.hypot(vx, vy) || 1;
  p.aftertouch = withAftertouch
    ? { time: tuning.kick.aftertouchTime, dx: vx / speed, dy: vy / speed, seq: ball.touchSeq, kind }
    : null;
  p.kickTimer = 0.2;
  p.touchTimer = 0.3;
  p.shotWindow = 0;
  world.events.push({ type: kind, speed });
}

// Aftertouch: for a short time after the kick the stick bends the ball (sideways or
// diagonal forward) or makes it dip (forward). Backward directions do nothing.
function applyAftertouch(p, dir, ball) {
  const at = p.aftertouch;
  if (!at) return;
  at.time -= DT;
  if (at.time <= 0 || ball.touchSeq !== at.seq) {
    p.aftertouch = null;
    return;
  }
  if (!dir || !tuning.game.aftertouch) return;
  const k = tuning.kick;
  const fade = at.time / k.aftertouchTime;
  const fwd = dir.x * at.dx + dir.y * at.dy;
  const lat = at.dx * dir.y - at.dy * dir.x; // > 0: stick to the right of the ball's path
  if (fwd < -0.01) return;
  if (Math.abs(lat) > 0.3) {
    ball.spin = Math.max(-k.spinMax, Math.min(k.spinMax, ball.spin + Math.sign(lat) * k.curveRate * fade * DT));
  }
  if (fwd > 0.9 && isAirborne(ball)) ball.vz -= k.dipRate * fade * DT;
}

function move(p, dir) {
  const cfg = tuning.player;
  const maxSpeed = cfg.maxSpeed * p.pace;
  let tx = 0, ty = 0, rate = cfg.decel;
  if (dir) {
    // Facing snaps to the stick at once: fast, responsive turning.
    p.fx = dir.x;
    p.fy = dir.y;
    tx = dir.x * maxSpeed;
    ty = dir.y * maxSpeed;
    rate = cfg.accel;
  }
  // Move velocity towards the target velocity with limited acceleration.
  const ddx = tx - p.vx;
  const ddy = ty - p.vy;
  const dist = Math.hypot(ddx, ddy);
  const maxDelta = rate * DT;
  if (dist <= maxDelta) {
    p.vx = tx;
    p.vy = ty;
  } else {
    p.vx += (ddx / dist) * maxDelta;
    p.vy += (ddy / dist) * maxDelta;
  }
  p.x += p.vx * DT;
  p.y += p.vy * DT;
  p.runPhase += playerSpeed(p) * DT * 2.4;
}

function keepInStadium(p) {
  const m = PITCH.margin - 1;
  p.x = Math.min(PITCH.width + m, Math.max(-m, p.x));
  p.y = Math.min(PITCH.length + m, Math.max(-m, p.y));
}

function footPoint(p) {
  const r = tuning.player.footReach;
  return { x: p.x + p.fx * r, y: p.y + p.fy * r };
}

function touched(p, ball, world) {
  ball.touchSeq++;
  ball.lastTouch = p;
  ball.touchStep = world.step;
}

// The ball can be played unless it is held, out of play (dead) or touched by another player this step.
export function canTouch(p, ball, world) {
  return !ball.heldBy && !ball.dead && !(ball.touchStep === world.step && ball.lastTouch !== p);
}
