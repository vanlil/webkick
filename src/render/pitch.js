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
const BOARD_DEPTH = 1.2; // advertising boards around the pitch (drawn depth in metres)

const BACKGROUND = '#1d2a22';

// --- Cached pitch layer ---------------------------------------------------------------------
// Everything on the ground that never moves (grass, lines, goal shadows, boards, corner flags)
// is drawn once into tiles of TILE × TILE device pixels. A frame only copies the visible tiles.
// The tiles are rebuilt when the zoom, the pixel ratio, the pitch type or the grass pattern
// changes. Tiles are built on demand (least recently used ones are reused).

const TILE = 512;
const EDGE = PITCH.margin + BOARD_DEPTH + 0.5;
const LAYER = { x0: -EDGE, y0: -EDGE, x1: PITCH.width + EDGE, y1: PITCH.length + EDGE };
const cache = { key: '', tiles: new Map(), pool: [], max: 0 };

export function drawPitch(ctx, view) {
  const dpr = view.dpr || 1;
  const s = view.scale;
  const key = `${s}|${dpr}|${tuning.game.grass}|${tuning.game.pitchType}`;
  if (cache.key !== key) {
    for (const c of cache.tiles.values()) cache.pool.push(c);
    cache.tiles.clear();
    cache.key = key;
  }
  const ppm = s * dpr; // device pixels per metre
  const cols = Math.ceil(((LAYER.x1 - LAYER.x0) * ppm) / TILE);
  const rows = Math.ceil(((LAYER.y1 - LAYER.y0) * ppm) / TILE);
  // Screen position of the layer in device pixels, snapped to whole pixels (no seams).
  const ox = Math.round(view.sx(LAYER.x0) * dpr);
  const oy = Math.round(view.sy(LAYER.y0) * dpr);
  const Wd = view.W * dpr, Hd = view.H * dpr;
  const i0 = Math.floor(-ox / TILE), i1 = Math.floor((Wd - 1 - ox) / TILE);
  const j0 = Math.floor(-oy / TILE), j1 = Math.floor((Hd - 1 - oy) / TILE);
  // Room for the visible tiles and the ring around them, so no tile in use is thrown away.
  cache.max = (i1 - i0 + 3) * (j1 - j0 + 3) + 4;
  if (cache.pool.length > cache.max) cache.pool.length = cache.max;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (i0 < 0 || j0 < 0 || i1 >= cols || j1 >= rows) {
    ctx.fillStyle = BACKGROUND; // the view is larger than the stadium
    ctx.fillRect(0, 0, Wd, Hd);
  }
  for (let j = Math.max(0, j0); j <= Math.min(rows - 1, j1); j++) {
    for (let i = Math.max(0, i0); i <= Math.min(cols - 1, i1); i++) {
      ctx.drawImage(tile(i, j, view), ox + i * TILE, oy + j * TILE);
    }
  }
  ctx.restore();

  // Build one tile of the ring around the view per frame, so scrolling finds them ready.
  for (let j = Math.max(0, j0 - 1); j <= Math.min(rows - 1, j1 + 1); j++) {
    for (let i = Math.max(0, i0 - 1); i <= Math.min(cols - 1, i1 + 1); i++) {
      if (!cache.tiles.has(i + ',' + j)) {
        tile(i, j, view);
        return;
      }
    }
  }
}

function tile(i, j, view) {
  const id = i + ',' + j;
  let c = cache.tiles.get(id);
  if (c) {
    cache.tiles.delete(id); // move to the end: most recently used
    cache.tiles.set(id, c);
    return c;
  }
  if (cache.tiles.size >= cache.max) {
    const [oldest, old] = cache.tiles.entries().next().value;
    cache.tiles.delete(oldest);
    cache.pool.push(old);
  }
  c = cache.pool.pop();
  if (!c) {
    c = document.createElement('canvas');
    c.width = c.height = TILE;
  }
  const g = c.getContext('2d', { alpha: false });
  const dpr = view.dpr || 1;
  const s = view.scale;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.filter = 'none';
  g.fillStyle = BACKGROUND;
  g.fillRect(0, 0, TILE, TILE);
  // Layer coordinates: CSS pixels from the layer's top-left corner.
  g.setTransform(dpr, 0, 0, dpr, -i * TILE, -j * TILE);
  drawPitchLayer(g, {
    dpr, scale: s,
    sx: (x) => (x - LAYER.x0) * s,
    sy: (y) => (y - LAYER.y0) * s,
  });
  cache.tiles.set(id, c);
  return c;
}

function drawPitchLayer(ctx, view) {
  const look = SURFACE_LOOK[tuning.game.pitchType] || SURFACE_LOOK.normal;
  const m = PITCH.margin;

  // Surround (grass outside the lines).
  rectW(ctx, view, -m, -m, PITCH.width + 2 * m, PITCH.length + 2 * m, look.surround);

  drawMowing(ctx, view, look);
  drawGrassTexture(ctx, view);

  drawLines(ctx, view, look.line);
  drawGoalShadow(ctx, view, true);
  drawGoalShadow(ctx, view, false);
  drawBoards(ctx, view); // after the shadows, so no shadow falls onto the boards
  for (const [x, y] of [[0, 0], [PITCH.width, 0], [0, PITCH.length], [PITCH.width, PITCH.length]]) {
    drawCornerFlag(ctx, view, x, y);
  }
}

// --- Grass ----------------------------------------------------------------------------------

// Mowing pattern of the pitch (option "grass"): diamonds (a diagonal chessboard, as in the
// classic game), stripes, squares or plain. Extended a little into the surround.
const DIAMOND = 7; // side of one diamond / square (m)

function drawMowing(ctx, view, look) {
  const kind = tuning.game.grass;
  const x0 = -2, y0 = -2, w = PITCH.width + 4, h = PITCH.length + 4;
  if (kind === 'stripes') {
    // One base fill plus every second stripe on top, so there are no hairline gaps.
    const stripeLen = PITCH.length / STRIPES;
    rectW(ctx, view, x0, -stripeLen, w, PITCH.length + 2 * stripeLen, look.a);
    for (let i = -1; i <= STRIPES; i += 2) rectW(ctx, view, x0, i * stripeLen, w, stripeLen, look.b);
    return;
  }
  if (kind === 'plain') {
    rectW(ctx, view, x0, y0, w, h, look.a);
    return;
  }
  // Chessboard pattern, anchored at the centre spot so it scrolls with the pitch.
  const dpr = view.dpr || 1;
  const cell = DIAMOND * view.scale; // CSS px
  const tile = chessTile(Math.max(2, Math.round(cell * dpr)), look.a, look.b);
  const pattern = ctx.createPattern(tile.canvas, 'repeat');
  const m = new DOMMatrix()
    .translateSelf(view.sx(PITCH.width / 2), view.sy(PITCH.length / 2))
    .rotateSelf(kind === 'diamonds' ? 45 : 0)
    .scaleSelf(cell / tile.size);
  pattern.setTransform(m);
  ctx.fillStyle = pattern;
  ctx.fillRect(view.sx(x0), view.sy(y0), w * view.scale, h * view.scale);
}

// Pre-drawn chessboard tile (2 × 2 cells): one per colour pair, rebuilt when the size changes.
const tiles = new Map();
function chessTile(size, a, b) {
  const key = `${a}|${b}`;
  let t = tiles.get(key);
  if (!t || t.size !== size) {
    const c = document.createElement('canvas');
    c.width = c.height = size * 2;
    const g = c.getContext('2d');
    g.fillStyle = a;
    g.fillRect(0, 0, size * 2, size * 2);
    g.fillStyle = b;
    g.fillRect(0, 0, size, size);
    g.fillRect(size, size, size, size);
    t = { canvas: c, size };
    tiles.set(key, t);
  }
  return t;
}

// Fine speckles over the grass (lighter and darker blades), drawn once into a small tile.
let grainTile = null;
function drawGrassTexture(ctx, view) {
  if (!grainTile) {
    const size = 128;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    for (let i = 0; i < 900; i++) {
      const light = Math.random() < 0.5;
      g.fillStyle = light ? `rgba(255,255,230,${0.03 + Math.random() * 0.05})` : `rgba(0,30,0,${0.04 + Math.random() * 0.06})`;
      g.fillRect(Math.random() * size, Math.random() * size, 1 + Math.random() * 1.5, 1 + Math.random() * 2.5);
    }
    grainTile = c;
  }
  const m = PITCH.margin;
  const pattern = ctx.createPattern(grainTile, 'repeat');
  pattern.setTransform(new DOMMatrix().translateSelf(view.sx(0), view.sy(0)));
  ctx.fillStyle = pattern;
  ctx.fillRect(view.sx(-m), view.sy(-m), (PITCH.width + 2 * m) * view.scale, (PITCH.length + 2 * m) * view.scale);
}

// Shadow direction: ground offset per metre of height (same "sun" as players and ball).
const SUN = { x: 0.35, y: 0.2 };
const shadowOf = (view, x, y, z) => [view.sx(x + z * SUN.x), view.sy(y + z * SUN.y)];

// Corner flag: a pole with a small flag, and its shadow.
function drawCornerFlag(ctx, view, x, y) {
  const s = view.scale;
  const z = tuning.render.zScale;
  const H = 1.5;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(0,0,0,0.3)';
  ctx.lineWidth = Math.max(1, 0.06 * s);
  ctx.beginPath();
  ctx.moveTo(view.sx(x), view.sy(y));
  ctx.lineTo(...shadowOf(view, x, y, H));
  ctx.stroke();
  const bx = view.sx(x), by = view.sy(y), ty = by - H * z * s;
  ctx.strokeStyle = '#f4f4f4';
  ctx.lineWidth = Math.max(1.5, 0.07 * s);
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(bx, ty);
  ctx.stroke();
  ctx.fillStyle = '#ffd23f';
  ctx.beginPath();
  ctx.moveTo(bx, ty);
  ctx.lineTo(bx + 0.5 * s, ty + 0.18 * s);
  ctx.lineTo(bx, ty + 0.36 * s);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// --- Goals ----------------------------------------------------------------------------------
// One net geometry (roof, back and both side nets as a mesh of strings, plus the frame) in
// world coordinates; the goal and its shadow are both drawn from it.

const MESH = 0.35; // size of the net's squares (m)

const goalCache = new Map();
function goalGeometry(top) {
  if (!goalCache.has(top)) goalCache.set(top, buildGoalGeometry(top));
  return goalCache.get(top);
}

function buildGoalGeometry(top) {
  const lineY = top ? 0 : PITCH.length;
  const back = top ? -PITCH.goalDepth : PITCH.length + PITCH.goalDepth;
  const x0 = PITCH.width / 2 - PITCH.goalWidth / 2;
  const x1 = PITCH.width / 2 + PITCH.goalWidth / 2;
  const h = PITCH.goalHeight;
  const backH = h * 0.8;
  const atDepth = (t) => [lineY + (back - lineY) * t, h + (backH - h) * t]; // [y, roof height]
  const lines = [];
  const cols = Math.round((x1 - x0) / MESH);
  const depthSteps = Math.round(PITCH.goalDepth / MESH);
  const rows = Math.round(backH / MESH);
  // Roof and back: strings from the crossbar over the roof and down the back.
  for (let i = 0; i <= cols; i++) {
    const x = x0 + ((x1 - x0) * i) / cols;
    lines.push([[x, lineY, h], [x, back, backH]], [[x, back, backH], [x, back, 0]]);
  }
  for (let d = 1; d < depthSteps; d++) {
    const [y, hz] = atDepth(d / depthSteps);
    lines.push([[x0, y, hz], [x1, y, hz]]);                    // across the roof
    for (const x of [x0, x1]) lines.push([[x, y, 0], [x, y, hz]]); // side nets, vertical
  }
  for (let r = 1; r < rows; r++) {
    const hz = (backH * r) / rows;
    lines.push([[x0, back, hz], [x1, back, hz]]);              // back net, horizontal
    for (const x of [x0, x1]) lines.push([[x, lineY, hz * (h / backH)], [x, back, hz]]); // side nets, along
  }
  const panels = [
    [[x0, lineY, h], [x1, lineY, h], [x1, back, backH], [x0, back, backH]], // roof
    [[x0, back, backH], [x1, back, backH], [x1, back, 0], [x0, back, 0]],   // back
    [[x0, lineY, h], [x0, back, backH], [x0, back, 0], [x0, lineY, 0]],     // left side
    [[x1, lineY, h], [x1, back, backH], [x1, back, 0], [x1, lineY, 0]],     // right side
  ];
  const frame = [[x0, lineY, 0], [x0, lineY, h], [x1, lineY, h], [x1, lineY, 0]];
  return { lines, panels, frame };
}

function strokeLines(ctx, lines, project) {
  ctx.beginPath();
  for (const [a, b] of lines) {
    ctx.moveTo(...project(a));
    ctx.lineTo(...project(b));
  }
  ctx.stroke();
}

function fillPanels(ctx, panels, project) {
  for (const poly of panels) {
    ctx.beginPath();
    poly.forEach((pt, i) => (i ? ctx.lineTo(...project(pt)) : ctx.moveTo(...project(pt))));
    ctx.closePath();
    ctx.fill();
  }
}

// Goals are drawn separately so the near (bottom) goal can overlap the players.
export function drawGoal(ctx, view, top) {
  const s = view.scale;
  const z = tuning.render.zScale;
  const g = goalGeometry(top);
  const project = ([x, y, hz]) => [view.sx(x), view.sy(y) - hz * z * s];
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  fillPanels(ctx, g.panels, project);
  ctx.lineWidth = Math.max(0.75, 0.025 * s);
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  strokeLines(ctx, g.lines, project);
  // Frame: posts and crossbar, with a thin dark edge so it stands out on light grass.
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const frame = () => {
    ctx.beginPath();
    g.frame.forEach((pt, i) => (i ? ctx.lineTo(...project(pt)) : ctx.moveTo(...project(pt))));
    ctx.stroke();
  };
  ctx.lineWidth = Math.max(3, 0.16 * s);
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  frame();
  ctx.lineWidth = Math.max(2, 0.12 * s);
  ctx.strokeStyle = '#f7f7f7';
  frame();
  ctx.restore();
}

// Shadows of the frame and the net on the grass, in the same sun direction as players and ball.
function drawGoalShadow(ctx, view, top) {
  const s = view.scale;
  const g = goalGeometry(top);
  const project = ([x, y, hz]) => shadowOf(view, x, y, hz);
  ctx.save();
  if ('filter' in ctx) ctx.filter = 'blur(0.8px)'; // soft edges
  // The net only throws a faint pattern; the frame a clear shadow.
  ctx.fillStyle = 'rgba(0,0,0,0.035)';
  fillPanels(ctx, g.panels, project);
  ctx.lineWidth = Math.max(0.6, 0.02 * s);
  ctx.strokeStyle = 'rgba(0,0,0,0.07)';
  strokeLines(ctx, g.lines, project);
  ctx.lineWidth = Math.max(2, 0.13 * s);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  g.frame.forEach((pt, i) => (i ? ctx.lineTo(...project(pt)) : ctx.moveTo(...project(pt))));
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
  ctx.font = `600 ${Math.round(0.82 * s)}px system-ui, -apple-system, sans-serif`;
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
