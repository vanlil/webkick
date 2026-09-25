import { PITCH, tuning } from '../config.js';

// Colours per pitch type: two grass stripe tones, surround and line colour.
const SURFACE_LOOK = {
  normal:     { a: '#3d8b3d', b: '#45964a', surround: '#2f6f33', line: 'rgba(255,255,255,0.92)' },
  wet:        { a: '#2f7a3c', b: '#378545', surround: '#255f30', line: 'rgba(255,255,255,0.85)' },
  soggy:      { a: '#4f7a36', b: '#58833d', surround: '#3f622c', line: 'rgba(245,245,235,0.80)' },
  artificial: { a: '#2f9a4f', b: '#34a656', surround: '#2a7a44', line: 'rgba(255,255,255,0.95)' },
  icy:        { a: '#9fc3b8', b: '#aacdc2', surround: '#86a89e', line: 'rgba(255,255,255,0.95)' },
  muddy:      { a: '#6b6a3a', b: '#737240', surround: '#565430', line: 'rgba(240,235,220,0.75)' },
  bumpy:      { a: '#5a8a3a', b: '#4f7f33', surround: '#44692c', line: 'rgba(250,250,240,0.85)' },
};

const STRIPES = 18;
const BOARD_DEPTH = 0.8;

export function drawPitch(ctx, view) {
  const look = SURFACE_LOOK[tuning.game.pitchType] || SURFACE_LOOK.normal;
  const { W, H } = view;
  const m = PITCH.margin;

  ctx.fillStyle = '#1d2a22';
  ctx.fillRect(0, 0, W, H);

  // Surround (grass outside the lines).
  rectW(ctx, view, -m, -m, PITCH.width + 2 * m, PITCH.length + 2 * m, look.surround);

  // Mowing stripes, extended a bit into the surround. One base fill plus every second
  // stripe on top, so there are never hairline gaps between neighbouring stripes.
  const stripeLen = PITCH.length / STRIPES;
  rectW(ctx, view, -2, -stripeLen, PITCH.width + 4, PITCH.length + 2 * stripeLen, look.a);
  for (let i = -1; i <= STRIPES; i += 2) {
    rectW(ctx, view, -2, i * stripeLen, PITCH.width + 4, stripeLen, look.b);
  }

  drawBoards(ctx, view);
  drawLines(ctx, view, look.line);
}

// Goals are drawn separately so the near (bottom) goal can overlap the players.
export function drawGoal(ctx, view, top) {
  const s = view.scale;
  const z = tuning.render.zScale;
  const lineY = top ? 0 : PITCH.length;
  const back = top ? -PITCH.goalDepth : PITCH.length + PITCH.goalDepth;
  const x0 = PITCH.width / 2 - PITCH.goalWidth / 2;
  const x1 = PITCH.width / 2 + PITCH.goalWidth / 2;
  const h = PITCH.goalHeight;
  const backH = h * 0.8;

  const p = (x, y, hz) => [view.sx(x), view.sy(y) - hz * z * s];

  // Net: the roof and the back, as a light mesh.
  ctx.save();
  ctx.lineWidth = Math.max(1, 0.03 * s);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  const roof = [p(x0, lineY, h), p(x1, lineY, h), p(x1, back, backH), p(x0, back, backH)];
  const backNet = [p(x0, back, backH), p(x1, back, backH), p(x1, back, 0), p(x0, back, 0)];
  for (const poly of [backNet, roof]) {
    ctx.beginPath();
    poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fill();
  }
  const cols = 14;
  ctx.beginPath();
  for (let i = 0; i <= cols; i++) {
    const x = x0 + ((x1 - x0) * i) / cols;
    const [ax, ay] = p(x, lineY, h);
    const [bx, by] = p(x, back, backH);
    const [cx, cy] = p(x, back, 0);
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.lineTo(cx, cy);
  }
  for (let j = 1; j < 4; j++) {
    const hz = (backH * j) / 4;
    const [ax, ay] = p(x0, back, hz);
    const [bx, by] = p(x1, back, hz);
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
  }
  ctx.stroke();

  // Frame: posts and crossbar.
  ctx.lineWidth = Math.max(2, 0.12 * s);
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#f4f4f4';
  ctx.beginPath();
  ctx.moveTo(...p(x0, lineY, 0));
  ctx.lineTo(...p(x0, lineY, h));
  ctx.lineTo(...p(x1, lineY, h));
  ctx.lineTo(...p(x1, lineY, 0));
  ctx.stroke();
  ctx.restore();
}

function drawBoards(ctx, view) {
  const m = PITCH.margin;
  const W = PITCH.width, L = PITCH.length;
  const col = '#1f3b63';
  rectW(ctx, view, -m, -m - BOARD_DEPTH, W + 2 * m, BOARD_DEPTH, col);
  rectW(ctx, view, -m, L + m, W + 2 * m, BOARD_DEPTH, col);
  rectW(ctx, view, -m - BOARD_DEPTH, -m, BOARD_DEPTH, L + 2 * m, col);
  rectW(ctx, view, W + m, -m, BOARD_DEPTH, L + 2 * m, col);

  // Board text along the top and bottom.
  const s = view.scale;
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = `600 ${Math.round(0.55 * s)}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let x = 4; x < W; x += 12) {
    ctx.fillText('webkick', view.sx(x), view.sy(-m - BOARD_DEPTH / 2));
    ctx.fillText('webkick', view.sx(x), view.sy(L + m + BOARD_DEPTH / 2));
  }
  ctx.restore();
}

function drawLines(ctx, view, color) {
  const s = view.scale;
  const W = PITCH.width, L = PITCH.length;
  const cx = W / 2;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1, PITCH.lineWidth * s);

  const rect = (x, y, w, h) => ctx.strokeRect(view.sx(x), view.sy(y), w * s, h * s);
  const arc = (x, y, r, a0, a1) => {
    ctx.beginPath();
    ctx.arc(view.sx(x), view.sy(y), r * s, a0, a1);
    ctx.stroke();
  };
  const dot = (x, y, r) => {
    ctx.beginPath();
    ctx.arc(view.sx(x), view.sy(y), r * s, 0, Math.PI * 2);
    ctx.fill();
  };

  rect(0, 0, W, L);
  ctx.beginPath();
  ctx.moveTo(view.sx(0), view.sy(L / 2));
  ctx.lineTo(view.sx(W), view.sy(L / 2));
  ctx.stroke();
  arc(cx, L / 2, PITCH.circleRadius, 0, Math.PI * 2);
  dot(cx, L / 2, 0.2);

  // Penalty and goal areas, spots and arcs, for both ends.
  const arcAngle = Math.acos((PITCH.boxDepth - PITCH.penaltySpot) / PITCH.circleRadius);
  rect(cx - PITCH.boxWidth / 2, 0, PITCH.boxWidth, PITCH.boxDepth);
  rect(cx - PITCH.sixWidth / 2, 0, PITCH.sixWidth, PITCH.sixDepth);
  dot(cx, PITCH.penaltySpot, 0.15);
  arc(cx, PITCH.penaltySpot, PITCH.circleRadius, Math.PI / 2 - arcAngle, Math.PI / 2 + arcAngle);

  rect(cx - PITCH.boxWidth / 2, L - PITCH.boxDepth, PITCH.boxWidth, PITCH.boxDepth);
  rect(cx - PITCH.sixWidth / 2, L - PITCH.sixDepth, PITCH.sixWidth, PITCH.sixDepth);
  dot(cx, L - PITCH.penaltySpot, 0.15);
  arc(cx, L - PITCH.penaltySpot, PITCH.circleRadius, -Math.PI / 2 - arcAngle, -Math.PI / 2 + arcAngle);

  // Corner arcs.
  const r = PITCH.cornerRadius;
  arc(0, 0, r, 0, Math.PI / 2);
  arc(W, 0, r, Math.PI / 2, Math.PI);
  arc(0, L, r, -Math.PI / 2, 0);
  arc(W, L, r, Math.PI, Math.PI * 1.5);
  ctx.restore();
}

// Filled rectangle in world coordinates.
function rectW(ctx, view, x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(view.sx(x), view.sy(y), w * view.scale, h * view.scale);
}
