import { PITCH, AI_LEVELS, HUMAN_TEAM, tuning } from '../config.js';
import { createPlayer } from './player.js';
import { formationRoles } from '../ai/tactics.js';

export const KITS = {
  red:  { shirt: '#d8323c', shorts: '#ffffff', socks: '#d8323c', skin: '#e8b48f', hair: '#3b2a1e' },
  blue: { shirt: '#2f6fd6', shorts: '#12244a', socks: '#2f6fd6', skin: '#d9a47e', hair: '#1f1a17' },
  redKeeper:  { shirt: '#2fa35a', shorts: '#1b1b1b', socks: '#2fa35a', skin: '#e8b48f', hair: '#6b4a2e' },
  blueKeeper: { shirt: '#f2c230', shorts: '#1b1b1b', socks: '#f2c230', skin: '#c98f6b', hair: '#1f1a17' },
};

// Skin and hair vary per player so the teams do not look cloned.
const SKINS = ['#f1c7a5', '#e8b48f', '#d9a47e', '#b97f5a', '#8d5a3b', '#6b4430'];
const HAIRS = ['#1f1a17', '#3b2a1e', '#6b4a2e', '#a0703f', '#d9b36c', '#2b2b2b'];

// id 0 = human team (red), id 1 = CPU team (blue).
export function createTeam({ id, name, human, attackDir, kit, keeperKit, tactic, rng }) {
  const team = {
    id, name, human, attackDir, kit, tactic,
    players: [],
    chaser: null,       // CPU: player currently going for the ball
  };
  applyLevel(team);
  const roles = formationRoles(tactic);
  for (let i = 0; i < 11; i++) {
    const isKeeper = i === 0;
    const base = isKeeper ? keeperKit : kit;
    const p = createPlayer({
      x: PITCH.width / 2, y: PITCH.length / 2,
      kit: { ...base, skin: SKINS[Math.floor(rng.next() * SKINS.length)], hair: HAIRS[Math.floor(rng.next() * HAIRS.length)] },
    });
    p.team = id;
    p.index = i;
    p.number = i + 1;
    p.role = isKeeper ? 'keeper' : roles[i - 1];
    p.variation = { pace: rng.range(-0.05, 0.05), skill: rng.range(-0.08, 0.08), aggression: rng.range(0.2, 0.95) };
    p.ai = { lastSector: null, prevFire: false, plan: null, decisionTimer: 0 };
    team.players.push(p);
  }
  applyAttributes(team);
  return team;
}

// Level parameters: the CPU team follows the difficulty option, the human team is fixed.
export function applyLevel(team) {
  team.difficulty = tuning.game.difficulty;
  team.level = team.human ? { ...AI_LEVELS.medium, ...HUMAN_TEAM } : AI_LEVELS[tuning.game.difficulty] || AI_LEVELS.medium;
}

export function applyAttributes(team) {
  const lvl = team.level;
  for (const p of team.players) {
    const clamp = (v) => Math.min(1, Math.max(0.2, v));
    p.pace = lvl.pace + p.variation.pace;
    p.shooting = clamp(lvl.skill + p.variation.skill);
    p.passing = clamp(lvl.skill - p.variation.skill * 0.5);
    p.flair = clamp(0.3 + p.variation.skill * 3);
    p.aggression = p.variation.aggression;
  }
}

export function setTactic(team, tactic) {
  team.tactic = tactic;
  const roles = formationRoles(tactic);
  team.players.forEach((p, i) => { if (i > 0) p.role = roles[i - 1]; });
}

// Goal geometry seen from a team.
export function ownGoal(team) {
  const y = team.attackDir < 0 ? PITCH.length : 0;
  return { x: PITCH.width / 2, y, into: team.attackDir }; // into: direction from the goal into the pitch
}

export function oppGoal(team) {
  const y = team.attackDir < 0 ? 0 : PITCH.length;
  return { x: PITCH.width / 2, y };
}

export function inOwnBox(team, x, y) {
  const g = ownGoal(team);
  const depth = (y - g.y) * g.into;
  return depth >= -0.5 && depth <= PITCH.boxDepth && Math.abs(x - g.x) <= PITCH.boxWidth / 2;
}
