import { PITCH, tuning } from '../config.js';

// Follows the ball with look-ahead and exponential smoothing. Updated every rendered frame
// (not per simulation step) so scrolling is smooth at any display refresh rate.
export function createCamera(x, y) {
  return { x, y, scale: 20, viewW: 0, viewH: 0 };
}

export function updateCamera(cam, target, frameDt, screenW, screenH) {
  const cfg = tuning.camera;
  cam.scale = screenH / cfg.viewHeight;
  cam.viewW = screenW / cam.scale;
  cam.viewH = screenH / cam.scale;

  const tx = target.x + target.vx * cfg.lookAhead;
  const ty = target.y + target.vy * cfg.lookAhead;
  const k = 1 - Math.exp(-cfg.smoothing * frameDt);
  cam.x += (tx - cam.x) * k;
  cam.y += (ty - cam.y) * k;

  // Keep the view inside the stadium. If the view is wider than the stadium, centre it.
  const m = PITCH.margin + 1.5; // grass beyond the lines plus the advertising boards
  cam.x = clampView(cam.x, cam.viewW, -m, PITCH.width + m);
  cam.y = clampView(cam.y, cam.viewH, -m, PITCH.length + m);
}

export function snapCamera(cam, x, y) {
  cam.x = x;
  cam.y = y;
}

function clampView(c, size, min, max) {
  if (max - min <= size) return (min + max) / 2;
  return Math.min(max - size / 2, Math.max(min + size / 2, c));
}
