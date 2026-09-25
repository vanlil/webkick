// All tunable constants. Units: metres, seconds, m/s, m/s².
// `tuning` is mutable (dev panel) and persisted in localStorage; DEFAULTS stays untouched.

export const SIM_HZ = 50;
export const DT = 1 / SIM_HZ;

// Pitch geometry (fixed, real-world sizes). x across (0..width), y along (0 = top goal line).
export const PITCH = {
  width: 68,
  length: 105,
  margin: 7,            // grass/track outside the lines up to the boards
  goalWidth: 7.32,
  goalHeight: 2.44,
  goalDepth: 2.0,
  boxDepth: 16.5,
  boxWidth: 40.32,
  sixDepth: 5.5,
  sixWidth: 18.32,
  circleRadius: 9.15,
  penaltySpot: 11,
  cornerRadius: 1,
  lineWidth: 0.12,
};

// Surface behaviour per pitch type.
// rollFriction: constant deceleration of a rolling ball (m/s²)
// rollDrag:     speed-proportional deceleration of a rolling ball (1/s)
// restitution:  vertical bounce factor
// bounceGrip:   horizontal speed kept on each bounce
// airDragMul:   multiplier on air drag
// bumpiness:    max random deflection on a bounce (radians)
// staminaMul:   how fast players tire (used from M3 on)
const PITCH_TYPES = {
  normal:     { rollFriction: 1.6, rollDrag: 0.35, restitution: 0.55, bounceGrip: 0.85, airDragMul: 1.0, bumpiness: 0.0,  staminaMul: 1.0 },
  wet:        { rollFriction: 1.0, rollDrag: 0.25, restitution: 0.45, bounceGrip: 0.95, airDragMul: 1.0, bumpiness: 0.0,  staminaMul: 1.1 },
  soggy:      { rollFriction: 2.8, rollDrag: 0.60, restitution: 0.30, bounceGrip: 0.65, airDragMul: 1.0, bumpiness: 0.0,  staminaMul: 1.4 },
  artificial: { rollFriction: 1.1, rollDrag: 0.25, restitution: 0.72, bounceGrip: 0.90, airDragMul: 1.0, bumpiness: 0.0,  staminaMul: 1.3 },
  icy:        { rollFriction: 0.5, rollDrag: 0.12, restitution: 0.60, bounceGrip: 0.97, airDragMul: 1.0, bumpiness: 0.0,  staminaMul: 1.0 },
  muddy:      { rollFriction: 4.5, rollDrag: 1.00, restitution: 0.22, bounceGrip: 0.50, airDragMul: 1.8, bumpiness: 0.0,  staminaMul: 2.0 },
  bumpy:      { rollFriction: 1.8, rollDrag: 0.40, restitution: 0.55, bounceGrip: 0.85, airDragMul: 1.0, bumpiness: 0.45, staminaMul: 1.1 },
};

// CPU difficulty. reaction: how old the ball information is that the AI acts on (s);
// decision: time between decisions when on the ball (s); aftertouch: chance to bend a shot;
// chasers: players going for the ball (2 = one presses the ball carrier);
// skill/pace: base attributes of the players; keeper*: goalkeeper reaction and skill.
export const AI_LEVELS = {
  easy:   { reaction: 0.40, decision: 0.45, shootRange: 17, aftertouch: 0.0, passAim: 0.25, chasers: 1, headers: false, skill: 0.60, pace: 0.92, keeperReaction: 0.32, keeperSkill: 0.55 },
  medium: { reaction: 0.22, decision: 0.28, shootRange: 22, aftertouch: 0.5, passAim: 0.15, chasers: 2, headers: true,  skill: 0.80, pace: 0.97, keeperReaction: 0.22, keeperSkill: 0.75 },
  hard:   { reaction: 0.10, decision: 0.15, shootRange: 27, aftertouch: 1.0, passAim: 0.08, chasers: 2, headers: true,  skill: 0.95, pace: 1.02, keeperReaction: 0.14, keeperSkill: 0.90 },
};

// The human team: fixed attributes; its CPU-controlled keeper and team-mates use these.
export const HUMAN_TEAM = { reaction: 0.2, skill: 0.85, pace: 1.0, keeperReaction: 0.22, keeperSkill: 0.75 };

export const TACTIC_NAMES = ['4-4-2', '4-3-3', '4-2-4', '5-3-2'];

// Wind presets (m/s), airborne ball only.
export const WIND_LEVELS = { none: 0, light: 2, medium: 4, strong: 6 };

export const DEFAULTS = {
  game: {
    speed: 1.0,           // 1 = normal, 0.75 = reduced, 0.5 = slow
    pitchType: 'normal',
    wind: 'none',
    windDirDeg: 90,       // direction the wind blows TO; 0 = up the screen, 90 = right
    aftertouch: true,
    difficulty: 'medium', // CPU opponent: easy / medium / hard
    humanTactic: '4-4-2',
    cpuTactic: '4-4-2',
  },
  ball: {
    gravity: 9.81,
    airDrag: 0.12,        // 1/s, applied to velocity relative to the wind
    radius: 0.11,         // physical radius
    drawRadius: 0.2,      // drawn larger than real, for readability
    minBounceVz: 0.9,     // below this vertical speed the ball stops bouncing and rolls
    boardRestitution: 0.3,
  },
  player: {
    maxSpeed: 7.0,        // top running speed (pace 1.0)
    accel: 38,            // how fast the player reaches top speed
    decel: 30,            // how fast the player stops when the stick is released
    footReach: 0.42,      // distance of the "foot point" in front of the body centre
    touchRadius: 0.5,     // ball within this distance of the foot point = touch
    bodyRadius: 0.3,      // keep bodyRadius + ball radius < footReach, or a trapped ball touches the body
    dribbleFactor: 1.55,  // ball speed after a touch = player speed × this
    minPush: 2.2,         // minimum ball speed after a touch
    touchCooldown: 0.12,  // seconds between two touches
    touchMaxHeight: 0.5,  // ball above this is not playable with the feet
    blockDamping: 0.25,   // ball speed kept when it bounces off a player's body
  },
  kick: {
    shotWindow: 0.18,     // seconds after a dribble touch in which fire = shot
    shotReach: 1.5,       // ball must still be this close to the foot to shoot
    shotSpeed: 24,        // base shot speed (shooting skill 1.0)
    shotLift: 2.6,        // vertical speed of a shot: low drive
    runBonus: 0.3,        // share of the player's speed added to a shot
    passSpeed: 14,
    lobSpeed: 13,
    lobLift: 9,
    lobMinSpeed: 2,       // player must run at least this fast to lob
    flickLift: 5.5,
    maxError: 0.12,       // max direction error (radians) for skill 0
    aftertouchTime: 0.45, // seconds after a kick in which the stick bends the ball
    curveRate: 4,         // spin added per second of full sideways stick
    spinMax: 1.2,         // max spin (rad/s of velocity rotation)
    spinDecay: 0.5,       // how fast spin fades during the flight (1/s)
    dipRate: 14,          // extra downward acceleration with the stick forward (m/s²)
    headRange: 2.5,       // fire starts a jump if an airborne ball is this close
    headReach: 0.7,
    headerSpeed: 12,
    headerLift: 1.2,
    jumpTime: 0.5,
    jumpHeight: 0.45,
    overheadSpeed: 17,
    overheadLift: 3.5,
    overheadTime: 0.9,    // time on the ground after an overhead kick
  },
  keeper: {
    speed: 6.0,
    accel: 30,
    reach: 0.8,           // catching reach when standing (m)
    diveReach: 1.2,       // catching reach when diving
    diveSpeed: 7.5,
    diveTime: 0.45,
    downTime: 0.9,        // time on the ground after a dive
    catchHeight: 2.6,
    holdTime: 1.4,        // seconds before the keeper throws or kicks the ball out
    kickSpeed: 23,
    kickLift: 11,
  },
  ai: {
    passMinDist: 7,
    passMaxDist: 24,
    pressureDist: 7,      // an opponent this close = under pressure → look for a pass
    laneWidth: 1.8,       // an opponent this close to the pass line blocks it
    switchMargin: 1.5,    // human control switches when another player is this much closer to the ball
  },
  goal: {
    postRadius: 0.06,
    postRestitution: 0.6,
    netDamping: 0.15,     // speed kept when the ball hits the net
    resetDelay: 2.5,      // seconds until the kick-off after a goal
  },
  camera: {
    viewHeight: 36,       // visible pitch height in metres (zoom)
    lookAhead: 0.35,      // seconds of ball velocity to look ahead
    smoothing: 5,         // higher = camera follows faster
  },
  render: {
    zScale: 0.75,         // height → screen offset factor (3/4 view)
    playerScale: 1.3,     // players drawn larger than real, for readability (visual only)
  },
  surfaces: PITCH_TYPES,
};

export const PITCH_TYPE_NAMES = Object.keys(PITCH_TYPES);

export const tuning = structuredClone(DEFAULTS);

const STORAGE_KEY = 'webkick.tuning.v1';

export function loadTuning() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) mergeKnown(tuning, JSON.parse(raw), DEFAULTS);
  } catch { /* storage blocked or corrupt: keep defaults */ }
}

export function saveTuning() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(tuning)); } catch { /* ignore */ }
}

export function resetTuning() {
  mergeKnown(tuning, structuredClone(DEFAULTS), DEFAULTS);
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

export function currentSurface() {
  return tuning.surfaces[tuning.game.pitchType] || tuning.surfaces.normal;
}

// Copy values from `source` into `target`, but only keys that exist in `template` with the
// same type. Nested objects are merged in place, so references held elsewhere stay valid.
function mergeKnown(target, source, template) {
  if (!source || typeof source !== 'object') return;
  for (const k of Object.keys(template)) {
    const t = template[k];
    if (t && typeof t === 'object') mergeKnown(target[k], source[k], t);
    else if (typeof source[k] === typeof t) target[k] = source[k];
  }
}
