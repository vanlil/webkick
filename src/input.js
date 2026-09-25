// Keyboard (+ optional gamepad) → one virtual joystick: 8 directions and one fire button.
// The simulation reads the joystick once per fixed step via sample().

const P1_KEYS = {
  up: ['ArrowUp'],
  down: ['ArrowDown'],
  left: ['ArrowLeft'],
  right: ['ArrowRight'],
  fire: ['Space', 'ControlRight'],
};

const GAME_KEYS = new Set(Object.values(P1_KEYS).flat());
const DEADZONE = 0.4;

export function createInput(target = window) {
  const down = new Set();
  const commandHandlers = new Map();

  target.addEventListener('keydown', (e) => {
    if (GAME_KEYS.has(e.code)) {
      e.preventDefault();
      down.add(e.code);
      return;
    }
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    const handler = commandHandlers.get(e.code);
    if (handler) {
      e.preventDefault();
      handler();
    }
  });
  target.addEventListener('keyup', (e) => down.delete(e.code));
  // Avoid stuck keys when the window loses focus.
  target.addEventListener('blur', () => down.clear());

  const anyDown = (codes) => codes.some((c) => down.has(c));
  let prevFire = false;

  function readGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = pads && pads[0];
    if (!pad) return null;
    const b = (i) => !!(pad.buttons[i] && pad.buttons[i].pressed);
    let dx = pad.axes[0] || 0;
    let dy = pad.axes[1] || 0;
    if (b(14)) dx = -1;
    if (b(15)) dx = 1;
    if (b(12)) dy = -1;
    if (b(13)) dy = 1;
    return {
      dx: Math.abs(dx) > DEADZONE ? Math.sign(dx) : 0,
      dy: Math.abs(dy) > DEADZONE ? Math.sign(dy) : 0,
      fire: b(0),
    };
  }

  return {
    // Register a one-shot key command (pause, reset, …). Not part of the simulation input.
    onKey(code, handler) {
      commandHandlers.set(code, handler);
    },

    // Called once per simulation step.
    sample() {
      let dx = (anyDown(P1_KEYS.right) ? 1 : 0) - (anyDown(P1_KEYS.left) ? 1 : 0);
      let dy = (anyDown(P1_KEYS.down) ? 1 : 0) - (anyDown(P1_KEYS.up) ? 1 : 0);
      let fire = anyDown(P1_KEYS.fire);
      const pad = readGamepad();
      if (pad) {
        if (!dx && !dy) { dx = pad.dx; dy = pad.dy; }
        fire = fire || pad.fire;
      }
      const joy = {
        dx, dy,
        fire,
        firePressed: fire && !prevFire,
        fireReleased: !fire && prevFire,
      };
      prevFire = fire;
      return joy;
    },
  };
}
