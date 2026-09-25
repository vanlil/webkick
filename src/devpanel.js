import GUI from '../vendor/lil-gui.esm.min.js';
import { PITCH_TYPE_NAMES, WIND_LEVELS, AI_LEVELS, TACTIC_NAMES, tuning, saveTuning, resetTuning, currentSurface } from './config.js';

// Live tuning panel. Every change is saved to localStorage. "Copy settings" puts the current
// values on the clipboard as JSON, so good values can be moved into config.js.
// `onChange` is called after every change, so the game can apply options at once.
export function createDevPanel(onChange = () => {}) {
  const gui = new GUI({ title: 'Tuning (G)' });
  gui.onChange(() => {
    saveTuning();
    onChange();
  });

  const match = gui.addFolder('Match');
  match.add(tuning.game, 'difficulty', Object.keys(AI_LEVELS)).name('CPU difficulty');
  match.add(tuning.game, 'humanTactic', TACTIC_NAMES).name('your tactic (1–4)');
  match.add(tuning.game, 'cpuTactic', TACTIC_NAMES).name('CPU tactic');

  const game = gui.addFolder('Game');
  game.add(tuning.game, 'speed', { normal: 1, reduced: 0.75, slow: 0.5 });
  game.add(tuning.game, 'pitchType', PITCH_TYPE_NAMES).name('pitch');
  game.add(tuning.game, 'wind', Object.keys(WIND_LEVELS));
  game.add(tuning.game, 'windDirDeg', 0, 359, 1).name('wind direction °');
  game.add(tuning.game, 'aftertouch');

  const player = gui.addFolder('Player');
  player.add(tuning.player, 'maxSpeed', 3, 12, 0.1).name('top speed');
  player.add(tuning.player, 'accel', 5, 100, 1);
  player.add(tuning.player, 'decel', 5, 100, 1);
  player.add(tuning.player, 'dribbleFactor', 1, 2.5, 0.01).name('dribble factor');
  player.add(tuning.player, 'minPush', 0, 6, 0.1).name('min push');
  player.add(tuning.player, 'footReach', 0, 1, 0.01).name('foot reach');
  player.add(tuning.player, 'touchRadius', 0.2, 1.2, 0.01).name('touch radius');
  player.add(tuning.player, 'touchCooldown', 0, 0.5, 0.01).name('touch cooldown');
  player.add(tuning.player, 'blockDamping', 0, 1, 0.01).name('block damping');

  const kick = gui.addFolder('Kicking');
  const k = tuning.kick;
  kick.add(k, 'shotWindow', 0.05, 0.5, 0.01).name('shot window s');
  kick.add(k, 'shotReach', 0.5, 3, 0.05).name('shot reach');
  kick.add(k, 'shotSpeed', 10, 40, 0.5).name('shot speed');
  kick.add(k, 'shotLift', 0, 8, 0.1).name('shot lift');
  kick.add(k, 'passSpeed', 5, 30, 0.5).name('pass speed');
  kick.add(k, 'lobSpeed', 5, 25, 0.5).name('lob speed');
  kick.add(k, 'lobLift', 3, 15, 0.1).name('lob lift');
  kick.add(k, 'maxError', 0, 0.4, 0.01).name('max error rad');
  kick.add(k, 'aftertouchTime', 0, 1.5, 0.01).name('aftertouch s');
  kick.add(k, 'curveRate', 0, 6, 0.05).name('curve rate');
  kick.add(k, 'spinMax', 0, 3, 0.01).name('max spin');
  kick.add(k, 'spinDecay', 0, 3, 0.05).name('spin decay');
  kick.add(k, 'dipRate', 0, 40, 0.5).name('dip rate');
  kick.add(k, 'headerSpeed', 4, 25, 0.5).name('header speed');
  kick.add(k, 'headReach', 0.3, 1.5, 0.05).name('head reach');
  kick.add(k, 'jumpTime', 0.2, 1, 0.01).name('jump time');
  kick.add(k, 'overheadSpeed', 5, 30, 0.5).name('overhead speed');
  kick.close();

  const keeper = gui.addFolder('Keeper');
  keeper.add(tuning.keeper, 'speed', 2, 10, 0.1);
  keeper.add(tuning.keeper, 'reach', 0.3, 2, 0.05);
  keeper.add(tuning.keeper, 'diveReach', 0.5, 2.5, 0.05).name('dive reach');
  keeper.add(tuning.keeper, 'diveSpeed', 2, 12, 0.1).name('dive speed');
  keeper.add(tuning.keeper, 'holdTime', 0.3, 4, 0.1).name('hold time');
  keeper.close();

  const ai = gui.addFolder('AI');
  ai.add(tuning.ai, 'pressureDist', 1, 15, 0.5).name('pressure distance');
  ai.add(tuning.ai, 'passMaxDist', 10, 40, 1).name('max pass distance');
  ai.add(tuning.ai, 'switchMargin', 0, 5, 0.1).name('switch margin');
  ai.close();

  const goal = gui.addFolder('Goal');
  goal.add(tuning.goal, 'postRestitution', 0, 1, 0.01).name('post bounce');
  goal.add(tuning.goal, 'netDamping', 0, 1, 0.01).name('net damping');
  goal.close();

  const ball = gui.addFolder('Ball');
  ball.add(tuning.ball, 'airDrag', 0, 0.6, 0.01).name('air drag');
  ball.add(tuning.ball, 'gravity', 5, 15, 0.01);
  ball.add(tuning.ball, 'minBounceVz', 0.1, 3, 0.05).name('min bounce speed');
  ball.add(tuning.ball, 'drawRadius', 0.11, 0.4, 0.01).name('drawn size');

  const surface = gui.addFolder('Current pitch surface');
  const surfaceCtrls = [];
  const bindSurface = () => {
    surfaceCtrls.forEach((c) => c.destroy());
    surfaceCtrls.length = 0;
    const t = currentSurface();
    surfaceCtrls.push(
      surface.add(t, 'rollFriction', 0, 8, 0.05).name('roll friction'),
      surface.add(t, 'rollDrag', 0, 2, 0.01).name('roll drag'),
      surface.add(t, 'restitution', 0, 1, 0.01),
      surface.add(t, 'bounceGrip', 0, 1, 0.01).name('bounce grip'),
      surface.add(t, 'airDragMul', 0.5, 3, 0.05).name('air drag ×'),
      surface.add(t, 'bumpiness', 0, 1, 0.01),
    );
  };
  bindSurface();
  game.controllers.find((c) => c.property === 'pitchType').onChange(bindSurface);
  surface.close();

  const camera = gui.addFolder('Camera and view');
  camera.add(tuning.camera, 'viewHeight', 15, 80, 1).name('zoom (visible m)');
  camera.add(tuning.camera, 'lookAhead', 0, 1.5, 0.01).name('look-ahead s');
  camera.add(tuning.camera, 'smoothing', 0.5, 20, 0.1);
  camera.add(tuning.render, 'playerScale', 1, 2, 0.05).name('player size ×');
  camera.close();

  const actions = {
    copy: async () => {
      const json = JSON.stringify(tuning, null, 2);
      try {
        await navigator.clipboard.writeText(json);
      } catch {
        console.log(json);
      }
    },
    reset: () => {
      resetTuning();
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
      bindSurface();
      onChange();
    },
  };
  gui.add(actions, 'copy').name('Copy settings (JSON)');
  gui.add(actions, 'reset').name('Reset to defaults');

  let visible = true;
  return {
    refresh() {
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
    },
    toggle() {
      visible = !visible;
      gui.show(visible);
    },
  };
}
