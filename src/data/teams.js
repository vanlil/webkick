// Fictional teams. Strength: added to the difficulty-based skill (CPU) — small differences.

export const PALETTE = [
  '#d8323c', '#8e1b25', '#f07f2a', '#f2c230', '#f6e7a6', '#ffffff', '#b8c2cc', '#1b1b1b',
  '#2fa35a', '#15603a', '#5fc3e4', '#2f6fd6', '#12244a', '#6a3fb5', '#c2447f', '#8b5a2b',
];

export const TEAMS = [
  { name: 'Red Lions',     shirt: '#d8323c', shorts: '#ffffff', stripes: '',        keeper: '#2fa35a', strength: 0.02 },
  { name: 'Blue Stars',    shirt: '#2f6fd6', shorts: '#12244a', stripes: '',        keeper: '#f2c230', strength: 0.02 },
  { name: 'Green Rovers',  shirt: '#2fa35a', shorts: '#ffffff', stripes: '#ffffff', keeper: '#1b1b1b', strength: 0 },
  { name: 'Yellow Hornets', shirt: '#f2c230', shorts: '#1b1b1b', stripes: '#1b1b1b', keeper: '#5fc3e4', strength: 0 },
  { name: 'Black Knights', shirt: '#1b1b1b', shorts: '#1b1b1b', stripes: '#b8c2cc', keeper: '#f07f2a', strength: 0.01 },
  { name: 'White Eagles',  shirt: '#ffffff', shorts: '#12244a', stripes: '',        keeper: '#c2447f', strength: 0.01 },
  { name: 'Orange Tigers', shirt: '#f07f2a', shorts: '#1b1b1b', stripes: '',        keeper: '#2f6fd6', strength: -0.01 },
  { name: 'Purple Wolves', shirt: '#6a3fb5', shorts: '#ffffff', stripes: '',        keeper: '#f6e7a6', strength: -0.01 },
];

// Kit colours are too close when both shirts would be hard to tell apart.
export function kitsClash(a, b) {
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  return Math.hypot(r1 - r2, g1 - g2, b1 - b2) < 120;
}

// Away kit when the colours clash: white shirts, or dark ones if the home team wears white.
export function alternateKit(team) {
  const light = team.shirt.toLowerCase() === '#ffffff';
  return { ...team, shirt: light ? '#12244a' : '#ffffff', shorts: light ? '#12244a' : team.shirt, stripes: '' };
}
