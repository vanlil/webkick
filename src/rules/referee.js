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

export function pickReferee(rng) {
  const i = Math.floor(rng.next() * NAMES.length);
  // Fixed per name (derived from the index), so each referee keeps his character.
  const strictness = 0.35 + ((i * 7) % 24) / 24 * 0.65;
  const eyesight = 0.6 + ((i * 11) % 24) / 24 * 0.38;
  return { name: NAMES[i], strictness, eyesight, mood: rng.range(-0.15, 0.15) };
}

// Decide about a foul: does the referee see it, and is there a card?
// foul = { by, victim, x, y, fromBehind, kind: 'slide' | 'block' }
export function judgeFoul(world, foul) {
  const ref = world.referee;
  const { rng } = world;
  if (!tuning.game.referee || !ref) return { seen: false, card: null };

  const seenChance = Math.min(0.98, ref.eyesight * (foul.fromBehind ? 1 : 0.9) + (foul.kind === 'slide' ? 0.05 : -0.1));
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
