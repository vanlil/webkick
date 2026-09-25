import { tuning } from '../config.js';

// Players are drawn from straight above (bird's-eye view, as in the classic game), turned to
// the running direction. The ball and the goals use a slight 3/4 view: height moves them up
// the screen. A player's height (jump) shows as a larger figure and a shadow further away.
//
// Each player is a list of simple shapes in local metres (x = forward, y = to the right).
// The shadow is the whole silhouette as one path, offset down-right like the sun's shadow.

const SHADOW = 'rgba(0,0,0,0.25)';
const OUTLINE = 'rgba(0,0,0,0.35)';
const SUN = { x: 0.35, y: 0.2 };    // shadow offset per metre of height
const SHADOW_BASE = { x: 0.16, y: 0.12 }; // shadow offset of a player standing on the ground
// Like the classic sprites, standing players are drawn much larger than real (they are only
// shoulder-wide from above) and lying players shorter, so both read well at the same zoom.
const LYING_SCALE = 0.62;
const STRIDE = 0.15; // how far the feet move forward and back while running (m)
const SHOULDER_TURN = 0.21; // shoulders counter-rotate against the legs while running (rad, ≈ 12°)

export function drawPlayer(ctx, view, p, x, y, { active = false } = {}) {
  const lying = p.state === 'slide' || p.state === 'fallen' || (p.state === 'down' && p.gettingUp) ||
    (p.role === 'keeper' && (p.state === 'dive' || p.state === 'down') && p.diveDir);
  const shapes = lying ? lyingShapes(p) : standingShapes(p);
  let fx = p.fx, fy = p.fy;
  if (lying) {
    // Direction hips → head.
    if (p.role === 'keeper' && p.diveDir) { fx = p.diveDir; fy = 0; }
    else if (p.state !== 'fallen') { fx = -p.fx; fy = -p.fy; } // sliding: feet first
  }
  const z = p.z || 0;
  const s = view.scale * tuning.render.playerScale * (lying ? LYING_SCALE : 1);
  const k = s * (1 + z * 0.25);                    // nearer to the camera when in the air
  const gx = view.sx(x), gy = view.sy(y) - z * tuning.render.zScale * view.scale;
  const angle = Math.atan2(fy, fx);

  if (active) {
    ctx.strokeStyle = '#ffe14d';
    ctx.lineWidth = Math.max(1.5, 0.07 * s);
    ctx.beginPath();
    ctx.arc(view.sx(x), view.sy(y), (lying ? 1.2 : 0.55) * s, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Shadow: the silhouette as one path (no darker overlaps), offset with the height.
  const sx = view.sx(x) + (SHADOW_BASE.x + z * SUN.x) * s;
  const sy = view.sy(y) + (SHADOW_BASE.y + z * SUN.y) * s;
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(angle);
  ctx.scale(s, s);
  const silhouette = new Path2D();
  for (const sh of shapes) addShape(silhouette, sh);
  ctx.fillStyle = SHADOW;
  ctx.fill(silhouette, 'nonzero');
  ctx.restore();

  // The player.
  ctx.save();
  ctx.translate(gx, gy);
  ctx.rotate(angle);
  ctx.scale(k, k);
  for (const sh of shapes) {
    const path = new Path2D();
    addShape(path, sh);
    ctx.fillStyle = colorOf(sh.part, p.kit);
    ctx.fill(path);
    if (sh.stripes && p.kit.stripes) drawStripes(ctx, path, sh, p.kit.stripes);
    if (sh.outline) {
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 1 / k;
      ctx.stroke(path);
    }
  }
  ctx.restore();
}

// Standing / running, seen from above: the legs only show during the stride.
function standingShapes(p) {
  const speed = Math.hypot(p.vx, p.vy);
  // Stride length (visual only; the running speed is not affected). Kept short: from above,
  // long strides look restless.
  let swing = speed > 0.3 ? Math.sin(p.runPhase) * Math.min(1, speed / 4) * STRIDE : 0;
  let kick = 0;
  if (p.kickTimer > 0) { kick = 0.42; swing = 0; }       // kicking leg forward
  else if (p.state === 'trap') swing = 0.12;            // one foot on the ball
  const shapes = [];
  // Legs (sock colour) with boots; the kicking leg reaches forward.
  for (const side of [-1, 1]) {
    const reach = kick ? (side > 0 ? kick : -0.08) : swing * side;
    const hip = [0, 0.13 * side];
    const foot = [reach + 0.04, 0.15 * side];
    shapes.push({ part: 'socks', type: 'capsule', a: hip, b: foot, w: 0.13 });
    shapes.push({ part: 'boots', type: 'ellipse', c: [foot[0] + 0.05, foot[1]], rx: 0.1, ry: 0.065 });
  }
  shapes.push({ part: 'shorts', type: 'ellipse', c: [-0.05, 0], rx: 0.11, ry: 0.19 });
  // Upper body: the shoulders turn against the legs while running (right leg forward →
  // right shoulder back), the arms swing with them. Everything rotates round the body centre.
  const running = speed > 0.3 && !kick && p.state !== 'trap';
  const turn = running ? (swing / STRIDE) * SHOULDER_TURN : 0;
  const r = (pt) => rotate(pt, turn);
  const holding = p.role === 'keeper' && p.state === 'hold';
  for (const side of [-1, 1]) {
    const hand = r(holding ? [0.32, 0.13 * side] : [-swing * side * 0.8, 0.4 * side]);
    const shoulder = r([0, 0.3 * side]);
    shapes.push({ part: 'shirt', type: 'capsule', a: shoulder, b: mid(shoulder, hand), w: 0.105 });
    shapes.push({ part: 'skin', type: 'capsule', a: mid(shoulder, hand), b: hand, w: 0.08 });
    shapes.push({ part: 'skin', type: 'ellipse', c: hand, rx: 0.05, ry: 0.05 });
  }
  // Athletic torso from above: broad, flat shoulders with rounded deltoids, not an oval.
  shapes.push({ part: 'shirt', type: 'capsule', a: r([0, -0.24]), b: r([0, 0.24]), w: 0.24, outline: true, stripes: true, span: 0.3, rot: turn });
  for (const side of [-1, 1]) {
    shapes.push({ part: 'shirt', type: 'ellipse', c: r([0.01, 0.27 * side]), rx: 0.1, ry: 0.085 });
  }
  // Head: mostly hair from above; a little face at the front.
  shapes.push({ part: 'hair', type: 'ellipse', c: [0.02, 0], rx: 0.125, ry: 0.11, outline: true });
  shapes.push({ part: 'skin', type: 'ellipse', c: [0.11, 0], rx: 0.035, ry: 0.065 });
  return shapes;
}

// On the ground (sliding, fouled, getting up, diving keeper): full length, x = towards the head.
function lyingShapes(p) {
  const diving = p.role === 'keeper';
  const shapes = [];
  for (const side of [-1, 1]) {
    shapes.push({ part: 'socks', type: 'capsule', a: [-0.05, 0.1 * side], b: [-0.9, 0.16 * side], w: 0.13 });
    shapes.push({ part: 'boots', type: 'ellipse', c: [-0.96, 0.17 * side], rx: 0.06, ry: 0.09 });
  }
  shapes.push({ part: 'shorts', type: 'ellipse', c: [-0.05, 0], rx: 0.17, ry: 0.19 });
  // Arms: a diving keeper stretches them beyond his head; others spread them out.
  for (const side of [-1, 1]) {
    const hand = diving ? [0.95, 0.13 * side] : [0.25, 0.45 * side];
    shapes.push({ part: 'shirt', type: 'capsule', a: [0.45, 0.2 * side], b: mid([0.45, 0.2 * side], hand), w: 0.12 });
    shapes.push({ part: diving ? 'gloves' : 'skin', type: 'capsule', a: mid([0.45, 0.2 * side], hand), b: hand, w: 0.1 });
  }
  shapes.push({ part: 'shirt', type: 'capsule', a: [0.05, 0], b: [0.5, 0], w: 0.4, outline: true, stripes: true });
  shapes.push({ part: 'hair', type: 'ellipse', c: [0.7, 0], rx: 0.14, ry: 0.13, outline: true });
  return shapes;
}

function colorOf(part, kit) {
  switch (part) {
    case 'boots': return '#1a1a1a';
    case 'gloves': return '#f4f4f4';
    default: return kit[part] || kit.shirt;
  }
}

function addShape(path, sh) {
  if (sh.type === 'ellipse') {
    path.moveTo(sh.c[0] + sh.rx, sh.c[1]);
    path.ellipse(sh.c[0], sh.c[1], sh.rx, sh.ry, 0, 0, Math.PI * 2);
  } else {
    // Capsule: a thick line with round ends, as a closed outline.
    const [ax, ay] = sh.a, [bx, by] = sh.b;
    const dx = bx - ax, dy = by - ay;
    const r = sh.w / 2;
    const a = Math.atan2(dy, dx);
    path.moveTo(ax + Math.cos(a + Math.PI / 2) * r, ay + Math.sin(a + Math.PI / 2) * r);
    path.arc(ax, ay, r, a + Math.PI / 2, a + Math.PI * 1.5);
    path.lineTo(ax + dx + Math.cos(a - Math.PI / 2) * r, ay + dy + Math.sin(a - Math.PI / 2) * r);
    path.arc(ax + dx, ay + dy, r, a - Math.PI / 2, a + Math.PI / 2);
    path.closePath();
  }
}

// Stripes run front to back over the shirt (vertical stripes, seen from above).
function drawStripes(ctx, path, sh, color) {
  ctx.save();
  ctx.clip(path);
  ctx.rotate(sh.rot || 0); // stripes turn with the shoulders
  ctx.fillStyle = color;
  const half = sh.span || (sh.type === 'ellipse' ? sh.ry : sh.w / 2);
  for (const y of [-half * 0.55, 0, half * 0.55]) ctx.fillRect(-1, y - half * 0.13, 2, half * 0.26);
  ctx.restore();
}

const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const rotate = ([x, y], a) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];

export function drawBall(ctx, view, ball, x, y, z) {
  const s = view.scale;
  const zs = tuning.render.zScale;
  const R = tuning.ball.drawRadius * s * (1 + z * 0.04);
  const gx = view.sx(x);
  const gy = view.sy(y);

  // Shadow on the ground, offset and fading with height.
  const fade = Math.max(0.25, 1 - z / 10);
  ctx.fillStyle = `rgba(0,0,0,${0.3 * fade})`;
  ctx.beginPath();
  ctx.ellipse(gx + z * SUN.x * s, gy + z * SUN.y * s, R * 1.05, R * 0.6, 0, 0, Math.PI * 2);
  ctx.fill();

  const bx = gx;
  const by = gy - (z + tuning.ball.radius) * zs * s;
  ctx.fillStyle = '#fafafa';
  ctx.beginPath();
  ctx.arc(bx, by, R, 0, Math.PI * 2);
  ctx.fill();

  // Two dark patches that roll with the ball.
  const speed = Math.hypot(ball.vx, ball.vy);
  const dx = speed > 0.05 ? ball.vx / speed : 0;
  const dy = speed > 0.05 ? ball.vy / speed : 1;
  const angle = ball.roll / tuning.ball.drawRadius;
  ctx.save();
  ctx.beginPath();
  ctx.arc(bx, by, R, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = '#2a2a2a';
  for (const offset of [0, Math.PI]) {
    const c = Math.cos(angle + offset);
    if (c < -0.2) continue;
    const t = Math.sin(angle + offset);
    ctx.beginPath();
    ctx.arc(bx + dx * t * R * 0.75, by + dy * t * R * 0.75, R * 0.32 * (0.6 + 0.4 * c), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(bx, by, R, 0, Math.PI * 2);
  ctx.stroke();
}
