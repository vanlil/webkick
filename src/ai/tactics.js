import { PITCH } from '../config.js';

// Tactics are tables: the pitch is split into ZONES_X × ZONES_Y zones, and for every zone each
// outfield player has a target position, in one table for attacking (own team has the ball)
// and one for defending. Players move to the target of the ball's position, interpolated
// between zone centres.
//
// Coordinates here are normalised and seen from the team: x 0..1 from left to right while
// attacking, y 0 = opponent goal line, 1 = own goal line. toWorld/toNorm convert.

export const ZONES_X = 5;
export const ZONES_Y = 7;

// Base shape for the ball on the centre spot. Index 0 is the keeper (handled by keeper.js).
const FORMATIONS = {
  '4-4-2': [
    ['def', 0.15, 0.78], ['def', 0.38, 0.82], ['def', 0.62, 0.82], ['def', 0.85, 0.78],
    ['mid', 0.15, 0.60], ['mid', 0.40, 0.63], ['mid', 0.60, 0.63], ['mid', 0.85, 0.60],
    ['fwd', 0.40, 0.45], ['fwd', 0.60, 0.45],
  ],
  '4-3-3': [
    ['def', 0.15, 0.78], ['def', 0.38, 0.82], ['def', 0.62, 0.82], ['def', 0.85, 0.78],
    ['mid', 0.30, 0.62], ['mid', 0.50, 0.65], ['mid', 0.70, 0.62],
    ['fwd', 0.20, 0.43], ['fwd', 0.50, 0.41], ['fwd', 0.80, 0.43],
  ],
  '4-2-4': [
    ['def', 0.15, 0.78], ['def', 0.38, 0.82], ['def', 0.62, 0.82], ['def', 0.85, 0.78],
    ['mid', 0.40, 0.63], ['mid', 0.60, 0.63],
    ['fwd', 0.12, 0.45], ['fwd', 0.38, 0.42], ['fwd', 0.62, 0.42], ['fwd', 0.88, 0.45],
  ],
  '5-3-2': [
    ['def', 0.10, 0.74], ['def', 0.30, 0.82], ['def', 0.50, 0.85], ['def', 0.70, 0.82], ['def', 0.90, 0.74],
    ['mid', 0.30, 0.62], ['mid', 0.50, 0.64], ['mid', 0.70, 0.62],
    ['fwd', 0.40, 0.45], ['fwd', 0.60, 0.45],
  ],
};

// How strongly each role follows the ball, and how far up / back it may go.
const ROLE = {
  def: { fx: 0.35, fy: 0.60, minY: 0.35, maxY: 0.92 },
  mid: { fx: 0.50, fy: 0.75, minY: 0.15, maxY: 0.86 },
  fwd: { fx: 0.40, fy: 0.70, minY: 0.06, maxY: 0.70 },
};

const cache = new Map();

export function formationRoles(name) {
  return FORMATIONS[name].map(([role]) => role);
}

// Builds (once) the attack and defence tables of a formation:
// table.attack[zone][player] = [x, y], zone = zy * ZONES_X + zx.
export function tacticTable(name) {
  if (cache.has(name)) return cache.get(name);
  const shape = FORMATIONS[name];
  const build = (attacking) => {
    const zones = [];
    for (let zy = 0; zy < ZONES_Y; zy++) {
      for (let zx = 0; zx < ZONES_X; zx++) {
        const bx = (zx + 0.5) / ZONES_X;
        const by = (zy + 0.5) / ZONES_Y;
        zones.push(shape.map(([role, x, y]) => {
          const r = ROLE[role];
          const fx = attacking ? r.fx : r.fx + 0.15;         // defending: close down towards the ball
          const spread = attacking ? 1.12 : 0.9;               // attacking: use the width
          let tx = 0.5 + (x - 0.5) * spread + (bx - 0.5) * fx;
          let ty = y + (by - 0.5) * r.fy + (attacking ? -0.06 : 0.04);
          tx = Math.min(0.96, Math.max(0.04, tx));
          ty = Math.min(r.maxY, Math.max(r.minY, ty));
          return [tx, ty];
        }));
      }
    }
    return zones;
  };
  const table = { attack: build(true), defend: build(false) };
  cache.set(name, table);
  return table;
}

// Target position (normalised) of outfield player `slot` (0..9) for a normalised ball position.
export function tacticTarget(name, slot, bx, by, attacking) {
  const zones = tacticTable(name)[attacking ? 'attack' : 'defend'];
  // Bilinear interpolation between the four surrounding zone centres.
  const gx = Math.min(ZONES_X - 1, Math.max(0, bx * ZONES_X - 0.5));
  const gy = Math.min(ZONES_Y - 1, Math.max(0, by * ZONES_Y - 0.5));
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const x1 = Math.min(ZONES_X - 1, x0 + 1), y1 = Math.min(ZONES_Y - 1, y0 + 1);
  const tx = gx - x0, ty = gy - y0;
  const at = (zx, zy) => zones[zy * ZONES_X + zx][slot];
  const a = at(x0, y0), b = at(x1, y0), c = at(x0, y1), d = at(x1, y1);
  const top = [a[0] + (b[0] - a[0]) * tx, a[1] + (b[1] - a[1]) * tx];
  const bottom = [c[0] + (d[0] - c[0]) * tx, c[1] + (d[1] - c[1]) * tx];
  return [top[0] + (bottom[0] - top[0]) * ty, top[1] + (bottom[1] - top[1]) * ty];
}

// Team-relative normalised coordinates ↔ world metres.
// attackDir -1: the team attacks the top goal (y = 0); +1: the bottom goal.
export function toWorld(attackDir, nx, ny) {
  return attackDir < 0
    ? { x: nx * PITCH.width, y: ny * PITCH.length }
    : { x: (1 - nx) * PITCH.width, y: (1 - ny) * PITCH.length };
}

export function toNorm(attackDir, x, y) {
  return attackDir < 0
    ? { x: x / PITCH.width, y: y / PITCH.length }
    : { x: 1 - x / PITCH.width, y: 1 - y / PITCH.length };
}
