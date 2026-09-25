import { tuning } from '../config.js';

// Players and ball drawn with vector shapes in a 3/4 top-down view.
// World height (metres) is drawn as an upward screen offset of `height * zScale * scale`.

const SHADOW = 'rgba(0,0,0,0.25)';
const OUTLINE = 'rgba(0,0,0,0.35)';
const SUN = { x: 0.35, y: 0.2 }; // shadow offset per metre of height

export function drawPlayer(ctx, view, p, x, y, { active = false } = {}) {
  if (p.state === 'slide' || p.state === 'fallen' || (p.state === 'down' && p.gettingUp)) {
    drawLying(ctx, view, p, x, y, active);
    return;
  }
  const s = view.scale * tuning.render.playerScale;
  const zs = tuning.render.zScale;
  const gx = view.sx(x);
  const gy = view.sy(y);
  const lift = p.z || 0; // jump height; the shadow stays on the ground
  const P = (ox, oy, hz) => [gx + ox * s, gy + oy * s - (hz + lift) * zs * s];

  const fx = p.fx, fy = p.fy;
  const qx = -fy, qy = fx;           // body side axis (to the player's right)
  const speed = Math.hypot(p.vx, p.vy);
  let swing = speed > 0.3 ? Math.sin(p.runPhase) * Math.min(1, speed / 4) * 0.3 : 0;
  if (p.kickTimer > 0) swing = 0.45;           // kicking leg forward
  else if (p.state === 'down') swing = 0.6;    // overhead kick: legs up
  else if (p.state === 'trap') swing = 0.12;   // one foot on the ball
  const kit = p.kit;

  // Ground: shadow and the marker of the controlled player.
  ctx.fillStyle = SHADOW;
  ctx.beginPath();
  ctx.ellipse(gx + 0.25 * s, gy + 0.12 * s, 0.45 * s, 0.2 * s, 0, 0, Math.PI * 2);
  ctx.fill();
  if (active) {
    ctx.strokeStyle = '#ffe14d';
    ctx.lineWidth = Math.max(1.5, 0.08 * s);
    ctx.beginPath();
    ctx.ellipse(gx, gy, 0.62 * s, 0.34 * s, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // A diving keeper: rotate the whole body round the hips.
  const tilted = !!p.diveAngle;
  if (tilted) {
    const [hx, hy] = P(0, 0, 0.9);
    ctx.save();
    ctx.translate(hx, hy);
    ctx.rotate(p.diveAngle);
    ctx.translate(-hx, -hy);
  }

  // Legs: hip → knee (skin), knee → foot (sock), boot. Far leg first.
  const legs = [
    { side: 1, swing },
    { side: -1, swing: -swing },
  ].map((l) => {
    const hip = [qx * 0.1 * l.side, qy * 0.1 * l.side];
    const foot = [hip[0] + fx * l.swing, hip[1] + fy * l.swing];
    // Running lifts the back foot; kicking lifts the front foot high.
    const kicking = p.kickTimer > 0 || p.state === 'down';
    return { hip, foot, lift: kicking ? Math.max(0, l.swing) * 0.9 : Math.max(0, -l.swing) * 0.35 };
  });
  legs.sort((a, b) => a.foot[1] - b.foot[1]);
  const legW = Math.max(2, 0.13 * s);
  for (const l of legs) {
    const hip = P(l.hip[0], l.hip[1], 0.85);
    const knee = P((l.hip[0] + l.foot[0]) / 2, (l.hip[1] + l.foot[1]) / 2, 0.45 + l.lift * 0.5);
    const foot = P(l.foot[0], l.foot[1], 0.06 + l.lift * 0.4);
    line(ctx, hip, knee, kit.skin, legW);
    line(ctx, knee, foot, kit.socks, legW);
    ctx.fillStyle = '#1a1a1a';
    ctx.beginPath();
    ctx.arc(foot[0] + fx * 0.05 * s, foot[1] + fy * 0.05 * s, legW * 0.6, 0, Math.PI * 2);
    ctx.fill();
  }

  // Width of the body on screen depends on which way the player faces.
  const bodyW = 0.44 * Math.abs(qx) + 0.26 * Math.abs(qy);
  const hipW = 0.36 * Math.abs(qx) + 0.24 * Math.abs(qy);

  // Arms swing opposite to the legs. The far arm is drawn behind the body.
  const arms = [1, -1].map((side) => {
    const sh = [qx * (bodyW / 2) * side, qy * (bodyW / 2) * side];
    const a = -swing * side * 0.8;
    return { sh, hand: [sh[0] + fx * a + qx * 0.05 * side, sh[1] + fy * a + qy * 0.05 * side] };
  });
  arms.sort((a, b) => a.sh[1] - b.sh[1]);
  const armW = Math.max(1.5, 0.1 * s);
  const drawArm = (arm) => {
    const shoulder = P(arm.sh[0], arm.sh[1], 1.38);
    const elbow = P((arm.sh[0] + arm.hand[0]) / 2, (arm.sh[1] + arm.hand[1]) / 2, 1.15);
    const hand = P(arm.hand[0], arm.hand[1], 0.95);
    line(ctx, shoulder, elbow, kit.shirt, armW * 1.2);
    line(ctx, elbow, hand, kit.skin, armW);
  };
  drawArm(arms[0]);

  // Shorts and shirt.
  const [shX, shY] = P(0, 0, 0.88);
  roundRect(ctx, shX - (hipW / 2) * s, shY - 0.1 * zs * s, hipW * s, 0.26 * zs * s, 0.06 * s, kit.shorts);
  const [tX, tY] = P(0, 0, 1.45);
  roundRect(ctx, tX - (bodyW / 2) * s, tY, bodyW * s, 0.58 * zs * s, 0.1 * s, kit.shirt, true);

  drawArm(arms[1]);

  // Head: hair all round, face visible unless the player faces away from the camera.
  const [hX, hY] = P(fx * 0.03, fy * 0.03, 1.66);
  const r = 0.15 * s;
  ctx.fillStyle = kit.hair;
  ctx.beginPath();
  ctx.arc(hX, hY, r, 0, Math.PI * 2);
  ctx.fill();
  if (fy > -0.6) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(hX, hY, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = kit.skin;
    ctx.beginPath();
    ctx.arc(hX + fx * 0.07 * s, hY + (0.04 + fy * 0.04) * s, r * 0.9, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(hX, hY, r, 0, Math.PI * 2);
  ctx.stroke();
  if (tilted) ctx.restore();
}

// A player on the ground: sliding (feet first, in the facing direction) or fallen (face down,
// head in the facing direction).
function drawLying(ctx, view, p, x, y, active) {
  const s = view.scale * tuning.render.playerScale;
  const zs = tuning.render.zScale;
  const gx = view.sx(x), gy = view.sy(y);
  const P = (ox, oy, hz) => [gx + ox * s, gy + oy * s - hz * zs * s];
  const feetFirst = p.state !== 'fallen';
  let dx = feetFirst ? p.fx : -p.fx, dy = feetFirst ? p.fy : -p.fy; // hips → feet
  // Lying straight up or down the screen would look like standing in the 3/4 view:
  // turn the body a little, so it clearly lies on the ground.
  if (Math.abs(dx) < 0.4) {
    const a = (p.index % 2 ? 1 : -1) * 0.45;
    [dx, dy] = [dx * Math.cos(a) - dy * Math.sin(a), dx * Math.sin(a) + dy * Math.cos(a)];
  }
  const qx = -dy, qy = dx;
  const kit = p.kit;

  // Shadow along the body.
  ctx.fillStyle = SHADOW;
  ctx.beginPath();
  ctx.ellipse(gx - dx * 0.1 * s + 0.15 * s, gy - dy * 0.1 * s + 0.1 * s, 1.0 * s, 0.38 * s, Math.atan2(dy, dx), 0, Math.PI * 2);
  ctx.fill();
  if (active) {
    ctx.strokeStyle = '#ffe14d';
    ctx.lineWidth = Math.max(1.5, 0.08 * s);
    ctx.beginPath();
    ctx.ellipse(gx, gy, 0.9 * s, 0.5 * s, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.lineCap = 'round';
  const legW = Math.max(2, 0.13 * s);
  for (const side of [1, -1]) {
    const hip = P(qx * 0.1 * side, qy * 0.1 * side, 0.15);
    const knee = P(dx * 0.45 + qx * 0.12 * side, dy * 0.45 + qy * 0.12 * side, 0.18);
    const foot = P(dx * 0.9 + qx * 0.14 * side, dy * 0.9 + qy * 0.14 * side, 0.12);
    line(ctx, hip, knee, kit.skin, legW);
    line(ctx, knee, foot, kit.socks, legW);
    ctx.fillStyle = '#1a1a1a';
    ctx.beginPath();
    ctx.arc(foot[0], foot[1], legW * 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
  // Arms out to the sides.
  const shoulder = P(-dx * 0.5, -dy * 0.5, 0.2);
  for (const side of [1, -1]) {
    line(ctx, shoulder, P(-dx * 0.35 + qx * 0.45 * side, -dy * 0.35 + qy * 0.45 * side, 0.15), kit.skin, Math.max(1.5, 0.1 * s));
  }
  // Shorts, shirt, head.
  const hip = P(0, 0, 0.18);
  ctx.fillStyle = kit.shorts;
  ctx.beginPath();
  ctx.arc(hip[0], hip[1], 0.17 * s, 0, Math.PI * 2);
  ctx.fill();
  line(ctx, P(-dx * 0.1, -dy * 0.1, 0.2), shoulder, kit.shirt, 0.36 * s);
  const head = P(-dx * 0.78, -dy * 0.78, 0.2);
  ctx.fillStyle = kit.hair;
  ctx.beginPath();
  ctx.arc(head[0], head[1], 0.15 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 1;
  ctx.stroke();
}

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

function line(ctx, a, b, color, width) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(b[0], b[1]);
  ctx.stroke();
}

function roundRect(ctx, x, y, w, h, r, color, outline = false) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
  if (outline) {
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}
