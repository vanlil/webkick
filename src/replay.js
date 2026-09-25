// Action replay: a ring buffer with the drawn state of the last seconds (ball, players,
// referee). R plays it back at normal speed, S in slow motion. The simulation is frozen while
// the replay runs; afterwards the real state is put back exactly.

const BODY_FIELDS = ['x', 'y', 'z', 'fx', 'fy', 'vx', 'vy', 'state', 'runPhase', 'kickTimer',
  'diveDir', 'gettingUp', 'sentOff'];
const BALL_FIELDS = ['x', 'y', 'z', 'vx', 'vy', 'roll'];

export function createReplay(steps = 400) {
  return { frames: new Array(steps), steps, count: 0, head: 0, active: null };
}

export function clearReplay(r) {
  r.count = 0;
  r.head = 0;
  r.active = null;
}

function copy(dst, src, fields) {
  for (let i = 0; i < fields.length; i++) dst[fields[i]] = src[fields[i]];
}

function bodiesOf(world) {
  return world.referee ? [...world.players, world.referee.body] : world.players;
}

// Stores the state after a simulation step. Frames are preallocated and reused.
export function recordReplay(r, world) {
  const bodies = bodiesOf(world);
  let f = r.frames[r.head];
  if (!f || f.bodies.length !== bodies.length) {
    f = { ball: {}, bodies: bodies.map(() => ({})) };
    r.frames[r.head] = f;
  }
  copy(f.ball, world.ball, BALL_FIELDS);
  for (let i = 0; i < bodies.length; i++) copy(f.bodies[i], bodies[i], BODY_FIELDS);
  r.head = (r.head + 1) % r.steps;
  r.count = Math.min(r.count + 1, r.steps);
}

// Starts the playback. rate 1 = normal speed, below 1 = slow motion.
export function startReplay(r, world, rate) {
  if (r.count < 10) return false;
  const bodies = bodiesOf(world);
  const save = (o, fields) => {
    const s = {};
    copy(s, o, fields);
    s.prev = { ...o.prev };
    return s;
  };
  r.active = {
    rate,
    t: 0,
    bodies,
    saved: { ball: save(world.ball, BALL_FIELDS), bodies: bodies.map((b) => save(b, BODY_FIELDS)) },
  };
  return true;
}

// Advances the playback by dt real seconds (at the 50 Hz step rate) and writes the two frames
// around the playback time into prev / current, so the normal renderer interpolates between
// them. Returns the interpolation alpha, or -1 when the replay has ended.
export function stepReplay(r, world, dt, stepDt) {
  const a = r.active;
  a.t += (dt * a.rate) / stepDt;
  const last = r.count - 1;
  if (a.t >= last) return -1;
  const i = Math.floor(a.t);
  const f0 = r.frames[(r.head - r.count + i + r.steps) % r.steps];
  const f1 = r.frames[(r.head - r.count + i + 1 + r.steps) % r.steps];
  if (f0.bodies.length !== a.bodies.length || f1.bodies.length !== a.bodies.length) return -1;
  apply(world.ball, f0.ball, f1.ball, BALL_FIELDS);
  for (let k = 0; k < a.bodies.length; k++) apply(a.bodies[k], f0.bodies[k], f1.bodies[k], BODY_FIELDS);
  return a.t - i;
}

function apply(o, f0, f1, fields) {
  copy(o, f1, fields);
  o.prev.x = f0.x;
  o.prev.y = f0.y;
  o.prev.z = f0.z;
}

// Puts the real state back.
export function stopReplay(r, world) {
  const a = r.active;
  if (!a) return;
  const restore = (o, s, fields) => {
    copy(o, s, fields);
    Object.assign(o.prev, s.prev);
  };
  restore(world.ball, a.saved.ball, BALL_FIELDS);
  a.bodies.forEach((b, i) => restore(b, a.saved.bodies[i], BODY_FIELDS));
  r.active = null;
}
