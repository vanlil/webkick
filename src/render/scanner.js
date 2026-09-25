import { PITCH } from '../config.js';

// Radar mini-map: the whole pitch with a dot per player, the ball and the visible area.
// Sizes: 0 = off, 1 = small, 2 = large (X cycles through them).
const HEIGHTS = [0, 150, 270];

export function drawScanner(ctx, W, H, world, camera, size) {
  const h = HEIGHTS[size] || 0;
  if (!h) return;
  const s = h / (PITCH.length + 4);
  const w = (PITCH.width + 4) * s;
  const x0 = 14, y0 = H - h - 48;
  const px = (x) => x0 + (x + 2) * s;
  const py = (y) => y0 + (y + 2) * s;

  ctx.save();
  ctx.fillStyle = 'rgba(10,20,15,0.6)';
  ctx.beginPath();
  ctx.roundRect(x0 - 4, y0 - 4, w + 8, h + 8, 8);
  ctx.fill();

  // Pitch outline, halfway line, boxes.
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 1;
  ctx.strokeRect(px(0), py(0), PITCH.width * s, PITCH.length * s);
  ctx.beginPath();
  ctx.moveTo(px(0), py(PITCH.length / 2));
  ctx.lineTo(px(PITCH.width), py(PITCH.length / 2));
  ctx.stroke();
  const bw = PITCH.boxWidth * s, bd = PITCH.boxDepth * s;
  ctx.strokeRect(px(PITCH.width / 2) - bw / 2, py(0), bw, bd);
  ctx.strokeRect(px(PITCH.width / 2) - bw / 2, py(PITCH.length) - bd, bw, bd);

  // Visible area.
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.strokeRect(px(camera.x - camera.viewW / 2), py(camera.y - camera.viewH / 2), camera.viewW * s, camera.viewH * s);

  // Players.
  const r = size === 2 ? 3.2 : 2.4;
  const active = world.human && world.human.player;
  for (const p of world.players) {
    ctx.fillStyle = p.kit.shirt;
    ctx.beginPath();
    ctx.arc(px(p.x), py(p.y), r, 0, Math.PI * 2);
    ctx.fill();
    if (p === active) {
      ctx.strokeStyle = '#ffe14d';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(px(p.x), py(p.y), r + 2, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Ball.
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(px(world.ball.x), py(world.ball.y), r * 0.9, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}
