// Regression checks for webkick (headless, Node.js): ball control, passing, a goal, full CPU
// matches on every level, human modes, determinism, penalties, practice and replay.
// Usage: node tools/regress.mjs
const root = new URL('../src/', import.meta.url).href;
const { tuning, PITCH } = await import(root + 'config.js');
const { createWorld, stepWorld } = await import(root + 'world/world.js');
const { createMatch } = await import(root + 'rules/match.js');
const { createReplay, recordReplay, startReplay, stepReplay, stopReplay } = await import(root + 'replay.js');
const IDLE = { dx: 0, dy: 0, fire: false, firePressed: false, fireReleased: false };
let fails = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); if (!ok) fails++; };
const J = (dx, dy, fire, prev) => ({ dx, dy, fire, firePressed: fire && !prev, fireReleased: !fire && prev, noReverse: true });
function isolate(w) {
  w.match.phase = 'play';
  for (const q of w.players) if (q !== w.human.player && q.role !== 'keeper') { q.x = 3; q.y = 3; q.prev.x = 3; q.prev.y = 3; }
}

// 1. Human dribble: the ball stays close and is not lost.
{
  const w = createWorld({ seed: 1 }); isolate(w);
  const p = w.human.player;
  Object.assign(p, { x: 34, y: 90, vx: 0, vy: 0, fx: 0, fy: -1 }); p.prev.x = 34; p.prev.y = 90;
  Object.assign(w.ball, { x: 34, y: 89.4, z: 0, vx: 0, vy: 0, vz: 0, lastTouch: null, dead: false }); w.ball.prev.x = 34; w.ball.prev.y = 89.4;
  let maxGap = 0;
  for (let i = 0; i < 200; i++) { stepWorld(w, J(0, -1, false, false)); if (i > 60) maxGap = Math.max(maxGap, p.y - w.ball.y); }
  check('human dribble keeps the ball close', w.ball.lastTouch === p && maxGap < 2.6, `max gap ${maxGap.toFixed(2)} m`);
}
// 2. Human trap and pass.
{
  const w = createWorld({ seed: 2 }); isolate(w);
  const p = w.human.player;
  Object.assign(p, { x: 30, y: 60, vx: 0, vy: 0, fx: 0, fy: -1 }); p.prev.x = 30; p.prev.y = 60;
  Object.assign(w.ball, { x: 30, y: 59.3, z: 0, vx: 0, vy: 0, vz: 0, lastTouch: null, dead: false }); w.ball.prev.x = 30; w.ball.prev.y = 59.3;
  let i = 0; for (; i < 40 && p.state !== 'trap'; i++) stepWorld(w, J(0, -1, true, i > 0));
  for (let k = 0; k < 20; k++) stepWorld(w, J(1, 0, true, true));
  const ev = stepWorld(w, J(1, 0, false, true));
  const pass = ev.find((e) => e.type === 'pass');
  check('human trap + pass', p.state !== 'trap' && !!pass && w.ball.vx > 10, pass ? `${pass.speed.toFixed(1)} m/s` : 'no pass');
}
// 2b. Lob and long clearance: pull back just after a touch (with fire: clearance).
for (const fire of [false, true]) {
  const w = createWorld({ seed: 2 }); isolate(w);
  const p = w.human.player;
  Object.assign(p, { x: 30, y: 70, vx: 0, vy: 0, fx: 0, fy: -1 }); p.prev.x = 30; p.prev.y = 70;
  Object.assign(w.ball, { x: 30, y: 69.3, z: 0, vx: 0, vy: 0, vz: 0, lastTouch: null, dead: false }); w.ball.prev.x = 30; w.ball.prev.y = 69.3;
  let kick = null;
  for (let i = 0; i < 120 && !kick; i++) {
    const touched = w.ball.lastTouch === p && p.shotWindow > 0 && i > 20;
    const ev = stepWorld(w, touched ? { dx: 0, dy: 1, fire, firePressed: fire, fireReleased: false } : J(0, -1, false, false));
    kick = ev.find((e) => e.type === 'lob' || e.type === 'clearance');
  }
  check(fire ? 'long clearance (pull back + fire)' : 'lob (pull back after a touch)', !!kick && kick.type === (fire ? 'clearance' : 'lob'), kick ? `${kick.type} ${kick.speed.toFixed(1)} m/s` : 'none');
}
// 3. A shot into an empty goal counts.
{
  const w = createWorld({ seed: 3 }); isolate(w);
  const k = w.teams[1].players[0]; k.x = 5; k.y = 5; k.prev.x = 5; k.prev.y = 5;
  const p = w.human.player;
  Object.assign(p, { x: 34, y: 20, vx: 0, vy: -6, fx: 0, fy: -1 }); p.prev.x = 34; p.prev.y = 20;
  Object.assign(w.ball, { x: 34, y: 19.3, z: 0, vx: 0, vy: 0, vz: 0, lastTouch: null, dead: false }); w.ball.prev.x = 34; w.ball.prev.y = 19.3;
  let goal = false, prev = false;
  for (let i = 0; i < 150 && !goal; i++) { const fire = i >= 3 && i < 6; goal = stepWorld(w, J(0, -1, fire, prev)).some((e) => e.type === 'goal'); prev = fire; }
  check('shot into the empty goal is a goal', goal);
}
// 4. Full CPU matches on every level: no crash, reach full time, no long stall.
for (const lv of ['easy', 'medium', 'hard']) {
  tuning.game.difficulty = lv; tuning.game.halfMinutes = 2;
  const w = createWorld({ seed: 11, withHuman: false });
  let stall = 0, maxStall = 0, err = null, goals = 0, passes = 0;
  try {
    while (w.match.phase !== 'fulltime' && w.step < 50 * 60 * 6) {
      const bx = w.ball.x, by = w.ball.y;
      const ev = stepWorld(w, IDLE);
      goals += ev.filter((e) => e.type === 'goal').length;
      passes += ev.filter((e) => e.type === 'pass' || e.type === 'longball').length;
      const moved = Math.hypot(w.ball.x - bx, w.ball.y - by) > 0.001;
      stall = moved ? 0 : stall + 1; maxStall = Math.max(maxStall, stall);
    }
  } catch (e) { err = e.message; }
  check(`CPU match (${lv}) runs to full time`, !err && w.match.phase === 'fulltime' && maxStall < 50 * 8, err || `goals ${goals}, passes ${passes}, longest still ball ${(maxStall / 50).toFixed(1)} s`);
}
// 5. Human team in nearest and fixed mode, idle input: no crash, match runs.
for (const control of ['nearest', 'fixed']) {
  tuning.game.control = control; tuning.game.fixedPlayer = 6; tuning.game.difficulty = 'medium';
  const w = createWorld({ seed: 4 });
  let err = null;
  try { for (let i = 0; i < 50 * 90; i++) stepWorld(w, IDLE); } catch (e) { err = e.message; }
  check(`human team in ${control} mode (idle)`, !err, err || `phase ${w.match.phase}`);
}
tuning.game.control = 'nearest';
// 6. Same seed → same match.
{
  tuning.game.difficulty = 'hard';
  const run = () => { const w = createWorld({ seed: 21, withHuman: false }); for (let i = 0; i < 3000; i++) stepWorld(w, IDLE); return JSON.stringify([w.ball.x, w.ball.y, w.score, w.players.map((p) => [p.x.toFixed(5), p.y.toFixed(5)])]); };
  check('deterministic (same seed, same result)', run() === run());
}
// 7. Penalty shoot-out practice ends with a winner.
{
  const w = createWorld({ seed: 9 }); createMatch(w, 'penalties');
  let n = 0; while (w.match.phase !== 'fulltime' && n < 50 * 300) { stepWorld(w, IDLE); n++; }
  check('penalty shoot-out finishes', w.match.phase === 'fulltime' && w.match.shootout.winner !== null, JSON.stringify(w.match.shootout?.goals));
}
// 8. Skill practice: only the keeper opposes, ball resets work.
{
  const w = createWorld({ seed: 5 }); createMatch(w, 'skill');
  let err = null; try { for (let i = 0; i < 50 * 60; i++) stepWorld(w, IDLE); } catch (e) { err = e.message; }
  const opp = w.teams[1 - w.human.team].players.filter((p) => !p.sentOff).length;
  check('skill practice runs', !err && opp === 1 && w.match.phase === 'play', err || `opponents on pitch ${opp}`);
}
// 9. Replay restores the exact state.
{
  const w = createWorld({ seed: 6, withHuman: false }); const r = createReplay(400);
  for (let i = 0; i < 600; i++) { stepWorld(w, IDLE); recordReplay(r, w); }
  const snap = JSON.stringify([w.ball.x, w.ball.y, w.players.map((p) => [p.x, p.y, p.state])]);
  startReplay(r, w, 0.35); while (stepReplay(r, w, 1 / 60, 0.02) >= 0); stopReplay(r, w);
  check('replay restores the state', snap === JSON.stringify([w.ball.x, w.ball.y, w.players.map((p) => [p.x, p.y, p.state])]));
}
console.log(fails ? `${fails} FAILED` : 'all passed');
