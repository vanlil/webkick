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
// `world` = { ball, rng, events }.
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
  if (dir && moveDir && dot(dir, moveDir) < REVERSED && p.touchTimer <= 0) {
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

  if (joy.firePressed) {
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

// Ball at the foot: trap if fire is held, otherwise push it ahead (dribble).
function footContact(p, joy, world) {
  const { ball, events } = world;
  const cfg = tuning.player;
  const foot = footPoint(p);
  const speed = playerSpeed(p);

  if (p.touchTimer <= 0 && ball.z < cfg.touchMaxHeight && Math.hypot(ball.x - foot.x, ball.y - foot.y) < cfg.touchRadius) {
    if (joy.fire) {
      p.state = 'trap';
      p.trapDir = { x: p.fx, y: p.fy };
      p.flickTimer = 0;
      p.vx = p.vy = 0;
      stopBall(ball);
      touched(p, ball);
      events.push({ type: 'trap' });
      return;
    }
    if (speed > 0.5) {
      // The ball is never attached: how far it runs ahead depends only on the player's speed.
      const push = Math.max(speed * cfg.dribbleFactor, cfg.minPush);
      ball.vx = p.fx * push;
      ball.vy = p.fy * push;
      ball.vz = 0;
      ball.z = 0;
      ball.spin = 0;
      touched(p, ball);
      p.touchTimer = cfg.touchCooldown;
      p.shotWindow = tuning.kick.shotWindow;
      events.push({ type: 'touch' });
      return;
    }
  }
  bodyBlock(p, ball, events);
}

// Ball bounces off the body (legs up to chest height), losing most of its speed.
function bodyBlock(p, ball, events) {
  const cfg = tuning.player;
  if (p.kickTimer > 0 || ball.z > 1.8 + p.z) return; // never block your own kick
  const dx = ball.x - p.x;
  const dy = ball.y - p.y;
  const d = Math.hypot(dx, dy);
  const minD = cfg.bodyRadius + tuning.ball.radius;
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
    touched(p, ball);
    events.push({ type: 'block' });
  }
  ball.x = p.x + nx * minD;
  ball.y = p.y + ny * minD;
}

// Trap mode: the player stands on the ball. The stick picks a direction; releasing fire
// passes that way, or goes back to dribbling if the stick is centred.
function stepTrap(p, joy, dir, world) {
  const { ball } = world;
  const cfg = tuning.player;
  p.vx = p.vy = 0;

  // Ball knocked away (later: by an opponent) → back to normal play.
  if (Math.hypot(ball.x - p.x, ball.y - p.y) > cfg.footReach + 0.6 || isAirborne(ball)) {
    p.state = 'run';
    return;
  }

  if (dir) {
    p.fx = dir.x;
    p.fy = dir.y;
    if (dot(dir, p.trapDir) > 0.7) p.flickTimer = 0.35;
  }
  // Turn round the ball: move the player so the ball stays at the foot.
  const tx = ball.x - p.fx * cfg.footReach;
  const ty = ball.y - p.fy * cfg.footReach;
  const k = 1 - Math.exp(-20 * DT);
  p.x += (tx - p.x) * k;
  p.y += (ty - p.y) * k;
  stopBall(ball);

  if (!joy.fire) {
    p.state = 'run';
    if (dir && p.flickTimer > 0 && dot(dir, p.trapDir) < REVERSED) {
      // Flick: forward, then back while releasing fire → the ball pops up in front.
      ball.vx = p.trapDir.x * 1.2;
      ball.vy = p.trapDir.y * 1.2;
      ball.vz = tuning.kick.flickLift;
      p.fx = p.trapDir.x;
      p.fy = p.trapDir.y;
      touched(p, ball);
      p.touchTimer = 0.4;
      p.kickTimer = 0.25;
      world.events.push({ type: 'flick' });
    } else if (dir) {
      kick(p, ball, dir, tuning.kick.passSpeed, 0, p.passing, world, 'pass');
    } else {
      p.touchTimer = 0.25;
    }
  }
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

  if (!p.headed) {
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
      touched(p, ball);
      events.push({ type: 'header', speed: k.headerSpeed });
    }
  }
  if (p.stateTimer <= 0) {
    p.state = 'run';
    p.z = 0;
    p.touchTimer = 0.1;
  }
  bodyBlock(p, ball, events);
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
  const k = tuning.kick;
  const a = world.rng.range(-1, 1) * (1 - skill) * k.maxError;
  const dx = d.x * Math.cos(a) - d.y * Math.sin(a);
  const dy = d.x * Math.sin(a) + d.y * Math.cos(a);
  ball.vx = dx * speed;
  ball.vy = dy * speed;
  ball.vz = lift;
  ball.spin = 0;
  touched(p, ball);
  p.aftertouch = { time: k.aftertouchTime, dx, dy, seq: ball.touchSeq };
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

function stopBall(ball) {
  ball.vx = ball.vy = ball.vz = 0;
  ball.z = 0;
  ball.spin = 0;
}

function touched(p, ball) {
  ball.touchSeq++;
  ball.lastTouch = p;
}
