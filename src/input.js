import { tuning } from './config.js';

// Keyboard (+ optional gamepad) → one virtual joystick: 8 directions and one fire button.
// The simulation reads the joystick once per fixed step via sample().
// The keys come from tuning.keys (remappable in the Controls menu).

const DEADZONE = 0.4;
const isGameKey = (code) => Object.values(tuning.keys).includes(code);

export function createInput(target = window) {
  const down = new Set();
  const commandHandlers = new Map();

  target.addEventListener('keydown', (e) => {
    if (isGameKey(e.code)) {
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

  const pressed = (action) => down.has(tuning.keys[action]);
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

    // Forget held keys (e.g. when a menu closes, so a key used there does not count as held).
    reset() {
      down.clear();
      prevFire = false;
    },

    // Called once per simulation step.
    sample() {
      let dx = (pressed('right') ? 1 : 0) - (pressed('left') ? 1 : 0);
      let dy = (pressed('down') ? 1 : 0) - (pressed('up') ? 1 : 0);
      let fire = pressed('fire');
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
