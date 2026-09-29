import { PITCH, tuning } from '../config.js';
import { ownGoal } from '../world/team.js';

// 24 referees (invented names), each with his own strictness and eyesight. A match gets one
// of them, plus a mood of the day: the same referee can be mild one day and harsh the next.

const NAMES = [
  'A. Brandt', 'M. Keller', 'J. Novak', 'P. Lindqvist', 'R. Moreau', 'S. Duarte',
  'T. Okafor', 'L. Bianchi', 'K. Jansen', 'D. Horvat', 'E. Sandoval', 'F. Kowalski',
  'G. Ferreira', 'H. Aydin', 'I. Petrov', 'B. Lambert', 'C. Nilsen', 'N. Varga',
  'O. Castell', 'U. Richter', 'V. Molina', 'W. Hughes', 'Y. Tanaka', 'Z. Adeyemi',
];

const REF_KIT = { shirt: '#1b1b1b', shorts: '#1b1b1b', socks: '#1b1b1b', skin: '#d9a47e', hair: '#3b2a1e', stripes: '' };

export function pickReferee(rng) {
  const i = Math.floor(rng.next() * NAMES.length);
  // Fixed per name (derived from the index), so each referee keeps his character.
  const strictness = 0.35 + ((i * 7) % 24) / 24 * 0.65;
  const eyesight = 0.6 + ((i * 11) % 24) / 24 * 0.38;
  // His body on the pitch (drawn like a player, never touches the ball).
  const body = {
    x: PITCH.width / 2 + 8, y: PITCH.length / 2 - 6, z: 0, vx: 0, vy: 0, fx: 0, fy: 1,
    runPhase: 0, kickTimer: 0, state: 'run', role: 'referee', index: 0, kit: REF_KIT,
    prev: { x: PITCH.width / 2 + 8, y: PITCH.length / 2 - 6, z: 0 },
  };
  return { name: NAMES[i], strictness, eyesight, mood: rng.range(-0.15, 0.15), body };
}

// The referee follows play along the diagonal, 10–14 m from the ball and a little closer to
// the middle of the pitch, so he rarely stands in the way.
export function stepReferee(world, dt) {
  const ref = world.referee;
  if (!ref) return;
  const b = world.ball;
  const r = ref.body;
  r.prev.x = r.x;
  r.prev.y = r.y;
  const side = b.x > PITCH.width / 2 ? -1 : 1;
  const ahead = b.y > PITCH.length / 2 ? -1 : 1;
  const tx = Math.min(PITCH.width - 2, Math.max(2, b.x + side * 10));
  const ty = Math.min(PITCH.length - 2, Math.max(2, b.y + ahead * 7));
  const dx = tx - r.x, dy = ty - r.y, d = Math.hypot(dx, dy);
  const speed = Math.min(7, d * 1.5);
  const vx = d > 0.1 ? (dx / d) * speed : 0, vy = d > 0.1 ? (dy / d) * speed : 0;
  r.vx += (vx - r.vx) * Math.min(1, dt * 4);
  r.vy += (vy - r.vy) * Math.min(1, dt * 4);
  r.x += r.vx * dt;
  r.y += r.vy * dt;
  r.runPhase += Math.hypot(r.vx, r.vy) * dt * 2.4;
  // He watches the ball.
  const lx = b.x - r.x, ly = b.y - r.y, ld = Math.hypot(lx, ly) || 1;
  r.fx = lx / ld;
  r.fy = ly / ld;
}

// Decide about a foul: does the referee see it, and is there a card?
// foul = { by, victim, x, y, fromBehind, kind: 'slide' | 'block' }
export function judgeFoul(world, foul) {
  const ref = world.referee;
  const { rng } = world;
  if (!tuning.game.referee || !ref) return { seen: false, card: null };

  // Far from the referee a foul is easier to miss.
  const dist = ref.body ? Math.hypot(ref.body.x - foul.x, ref.body.y - foul.y) : 15;
  const range = Math.min(1, Math.max(0.35, 1.25 - dist / 40));
  const seenChance = Math.min(0.98, (ref.eyesight * (foul.fromBehind ? 1 : 0.9) + (foul.kind === 'slide' ? 0.05 : -0.3)) * range);
  if (rng.next() > seenChance) return { seen: false, card: null };

  const team = world.teams[foul.by.team];
  let severity = foul.kind === 'slide' ? 0.45 : 0.25;
  if (foul.fromBehind) severity += 0.3;
  if (lastMan(world, team, foul)) severity += 0.3;
  severity += (foul.by.aggression || 0.5) * 0.15;
  const strict = Math.max(0, ref.strictness + ref.mood);
  const s = severity * strict;

  // Examples (average referee): foul from the front → yellow ~20 %; slide from behind → yellow
  // ~45 %; slide from behind as the last man → red ~30 %, otherwise yellow.
  let card = null;
  const r = rng.next();
  if (s > 0.75 && r < (s - 0.6) * 1.5) card = 'red';
  else if (s > 0.35 && r < (s - 0.2) * 1.2) card = 'yellow';
  if (card === 'yellow' && (foul.by.yellow || 0) >= 1) card = 'red';
  if (card === 'red' && foul.by.role === 'keeper') card = 'yellow';
  return { seen: true, card };
}

// No outfield team-mate of the offender between the foul and his own goal: a "last man" foul.
function lastMan(world, team, foul) {
  const g = ownGoal(team);
  const fd = Math.abs(foul.y - g.y);
  if (fd > PITCH.length / 2) return false;
  return !team.players.some((p) => p !== foul.by && p.role !== 'keeper' && !p.sentOff && Math.abs(p.y - g.y) < fd);
}

// A foul inside the offender's own penalty area is a penalty.
export function inPenaltyArea(team, x, y) {
  const g = ownGoal(team);
  const depth = (y - g.y) * g.into;
  return depth >= 0 && depth <= PITCH.boxDepth && Math.abs(x - g.x) <= PITCH.boxWidth / 2;
}
