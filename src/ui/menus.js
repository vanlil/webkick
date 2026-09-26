import { tuning, saveTuning, DEFAULTS, AI_LEVELS, TEAM_LEVELS, TEAM_LEVEL_NAMES, TACTIC_NAMES, HALF_MINUTES, PITCH_TYPE_NAMES, WIND_LEVELS } from '../config.js';
import { TEAMS, PALETTE } from '../data/teams.js';
import { formationRoles } from '../ai/tactics.js';

// Menu screens (DOM). Keyboard: ↑/↓ choose, ←/→ change a value, Space/Enter select,
// Esc back. The mouse works too. Screens are functions, so labels always show current values.
//
// Item types: action (run), choice (values + get/set), color (palette), key (remap a key),
// info (text only, not selectable).

const COLOR_NAMES = [
  'red', 'dark red', 'orange', 'yellow', 'cream', 'white', 'grey', 'black',
  'green', 'dark green', 'sky blue', 'blue', 'navy', 'purple', 'pink', 'brown',
];
const ROLE_NAMES = { def: 'defender', mid: 'midfielder', fwd: 'forward' };
const KEY_LABELS = { up: 'Up', down: 'Down', left: 'Left', right: 'Right', fire: 'Fire', fire2: 'Fire (2nd key)' };
// Keys with a fixed meaning; they cannot be used for movement or fire.
const RESERVED = new Set(['Escape', 'KeyP', 'KeyX', 'KeyM', 'KeyG', 'KeyI', 'KeyL', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Enter', 'Tab']);

export function createMenus(root, actions) {
  const titleEl = root.querySelector('.menu-title');
  const listEl = root.querySelector('.menu-items');
  const hintEl = root.querySelector('.menu-hint');
  let stack = [];
  let index = 0;
  let capturing = null; // key binding being remapped

  const changed = () => {
    saveTuning();
    actions.onChange();
  };
  const choice = (label, values, labels, get, set) => ({ type: 'choice', label, values, labels, get, set });
  const onOff = (label, obj, key) => choice(label, [true, false], ['on', 'off'], () => obj[key], (v) => { obj[key] = v; });

  const home = () => TEAMS[tuning.team.home] || TEAMS[0];
  const opponents = () => TEAMS.map((_, i) => i).filter((i) => i !== tuning.team.home);

  const SCREENS = {
    main: () => ({
      title: 'Main menu',
      items: [
        { type: 'action', label: 'Play match', run: () => push('setup') },
        { type: 'action', label: 'Practice', run: () => push('practice') },
        { type: 'action', label: 'Options', run: () => push('options') },
        { type: 'action', label: 'Controls', run: () => push('controls') },
      ],
    }),

    setup: () => {
      const t = tuning.team;
      const g = tuning.game;
      const roles = formationRoles(g.humanTactic);
      const items = [
        choice('Your team', TEAMS.map((_, i) => i), TEAMS.map((x) => x.name), () => t.home, (v) => {
          t.home = v;
          t.shirt = t.shorts = t.stripes = ''; // back to the team's own colours
          if (t.away === v) t.away = (v + 1) % TEAMS.length;
        }),
        { type: 'color', label: 'Shirt', get: () => t.shirt || home().shirt, set: (v) => { t.shirt = v; if (!t.shorts) t.shorts = home().shorts; } },
        { type: 'color', label: 'Shorts', get: () => t.shorts || home().shorts, set: (v) => { t.shorts = v; if (!t.shirt) t.shirt = home().shirt; } },
        choice('Shirt style', ['plain', 'stripes'], ['plain', 'striped'],
          () => ((t.shirt ? t.stripes : home().stripes) ? 'stripes' : 'plain'),
          (v) => {
            if (!t.shirt) { t.shirt = home().shirt; t.shorts = home().shorts; }
            t.stripes = v === 'plain' ? '' : (t.shorts !== t.shirt ? t.shorts : '#ffffff');
          }),
        choice('Opponent', opponents(), opponents().map((i) => TEAMS[i].name), () => t.away, (v) => { t.away = v; }),
        choice('Your team level', Object.keys(TEAM_LEVELS), Object.values(TEAM_LEVEL_NAMES), () => g.homeLevel, (v) => { g.homeLevel = v; }),
        choice('Opponent level', Object.keys(TEAM_LEVELS), Object.values(TEAM_LEVEL_NAMES), () => g.awayLevel, (v) => { g.awayLevel = v; }),
        choice('CPU skill (how it plays)', Object.keys(AI_LEVELS), null, () => g.difficulty, (v) => { g.difficulty = v; }),
        choice('Your tactic', TACTIC_NAMES, null, () => g.humanTactic, (v) => { g.humanTactic = v; }),
        choice('Control', ['nearest', 'fixed'], ['nearest to the ball', 'fixed player'], () => g.control, (v) => { g.control = v; }),
      ];
      if (g.control === 'fixed') {
        items.push(choice('Your player', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
          [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => `#${i + 1} ${ROLE_NAMES[roles[i - 1]]}`),
          () => g.fixedPlayer, (v) => { g.fixedPlayer = v; }));
      }
      items.push({ type: 'action', label: 'Webkick!', run: () => actions.startMatch(), primary: true });
      items.push({ type: 'action', label: 'Back', run: back });
      return { title: 'Match setup', items };
    },

    practice: () => ({
      title: 'Practice',
      items: [
        { type: 'action', label: 'Skill: dribble, pass and shoot', run: () => actions.startMatch('skill'), primary: true },
        { type: 'action', label: 'Penalties: shoot-out against the CPU', run: () => actions.startMatch('penalties') },
        { type: 'info', label: 'Teams', value: 'from Match setup' },
        { type: 'action', label: 'Back', run: back },
      ],
    }),

    options: () => {
      const g = tuning.game;
      return {
        title: 'Options',
        items: [
          choice('Minutes per half', HALF_MINUTES, HALF_MINUTES.map((m) => `${m} min`), () => g.halfMinutes, (v) => { g.halfMinutes = v; }),
          choice('Pitch', PITCH_TYPE_NAMES, null, () => g.pitchType, (v) => { g.pitchType = v; }),
          choice('Grass pattern', ['diamonds', 'stripes', 'squares', 'plain'], null, () => g.grass, (v) => { g.grass = v; }),
          choice('Wind', Object.keys(WIND_LEVELS), null, () => g.wind, (v) => { g.wind = v; }),
          choice('Wind blows to', [0, 45, 90, 135, 180, 225, 270, 315], ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'], () => g.windDirDeg, (v) => { g.windDirDeg = v; }),
          choice('Game speed', [1, 0.75, 0.5], ['normal', 'reduced', 'slow'], () => g.speed, (v) => { g.speed = v; }),
          onOff('Aftertouch', g, 'aftertouch'),
          onOff('Referee (fouls)', g, 'referee'),
          choice('After a draw', ['none', 'penalties', 'extra'], ['draw stands', 'penalties', 'extra time + penalties'], () => g.draw, (v) => { g.draw = v; }),
          choice('Sound', ['all', 'crowd', 'off'], ['on', 'crowd only', 'off'], () => tuning.audio.mode, (v) => { tuning.audio.mode = v; }),
          choice('Radar', [0, 1, 2], ['off', 'small', 'large'], () => g.radar, (v) => { g.radar = v; }),
          choice('Frame rate', [60, 0], ['60 fps (less load)', 'screen maximum'], () => g.frameRate, (v) => { g.frameRate = v; }),
          { type: 'action', label: 'Back', run: back },
        ],
      };
    },

    controls: () => ({
      title: 'Controls',
      items: [
        ...Object.keys(KEY_LABELS).map((k) => ({ type: 'key', label: KEY_LABELS[k], action: k })),
        { type: 'action', label: 'Reset keys', run: () => { Object.assign(tuning.keys, DEFAULTS.keys); changed(); render(); } },
        { type: 'info', label: 'Esc', value: 'menu / pause' },
        { type: 'info', label: 'P · X · M', value: 'pause · radar size · sound' },
        { type: 'info', label: 'R · S', value: 'replay · slow-motion replay' },
        { type: 'info', label: '1 – 4', value: 'tactic (from the next stoppage)' },
        { type: 'info', label: 'G', value: 'tuning panel (for developers)' },
        { type: 'action', label: 'Back', run: back },
      ],
    }),

    pause: () => ({
      title: 'Paused',
      items: [
        { type: 'action', label: 'Resume', run: () => actions.resume(), primary: true },
        { type: 'action', label: actions.practice() ? 'Restart practice' : 'Restart match', run: () => actions.restart() },
        { type: 'action', label: 'Options', run: () => push('options') },
        { type: 'action', label: 'Controls', run: () => push('controls') },
        { type: 'action', label: 'Quit to main menu', run: () => actions.quit() },
      ],
      back: () => actions.resume(),
    }),

    fulltime: () => ({
      title: actions.resultText(),
      items: [
        { type: 'action', label: actions.practice() ? 'Again' : 'New match', run: () => actions.restart(), primary: true },
        { type: 'action', label: 'Main menu', run: () => actions.quit() },
      ],
    }),
  };

  function current() {
    return SCREENS[stack[stack.length - 1]]();
  }

  function selectable(items) {
    return items.map((it, i) => (it.type === 'info' ? -1 : i)).filter((i) => i >= 0);
  }

  function render() {
    const screen = current();
    titleEl.textContent = screen.title;
    const sel = selectable(screen.items);
    if (!sel.includes(index)) index = sel[0];
    listEl.innerHTML = '';
    screen.items.forEach((it, i) => {
      const li = document.createElement('li');
      li.className = `menu-item ${it.type}${i === index ? ' selected' : ''}${it.primary ? ' primary' : ''}`;
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = it.label;
      li.appendChild(label);
      const value = valueElement(it);
      if (value) li.appendChild(value);
      if (it.type !== 'info') {
        li.addEventListener('mouseenter', () => { index = i; highlight(); });
        li.addEventListener('click', (e) => {
          index = i;
          const dir = e.target.dataset && e.target.dataset.dir;
          if (dir) change(Number(dir));
          else activate();
        });
      }
      listEl.appendChild(li);
    });
    hintEl.textContent = capturing
      ? `Press a key for "${KEY_LABELS[capturing]}" (Esc cancels)`
      : '↑↓ choose · ←→ change · Space/Enter select · Esc back';
  }

  function valueElement(it) {
    if (it.type === 'info') {
      const v = document.createElement('span');
      v.className = 'value';
      v.textContent = it.value;
      return v;
    }
    if (it.type === 'key') {
      const v = document.createElement('span');
      v.className = 'value keycap';
      v.textContent = capturing === it.action ? '…' : keyName(tuning.keys[it.action]);
      return v;
    }
    if (it.type !== 'choice' && it.type !== 'color') return null;
    const v = document.createElement('span');
    v.className = 'value';
    const left = document.createElement('button');
    left.className = 'arrow';
    left.dataset.dir = '-1';
    left.textContent = '◀';
    left.tabIndex = -1;
    const right = left.cloneNode();
    right.dataset.dir = '1';
    right.textContent = '▶';
    const text = document.createElement('span');
    text.className = 'value-text';
    if (it.type === 'color') {
      const c = it.get();
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = c;
      text.appendChild(sw);
      text.appendChild(document.createTextNode(COLOR_NAMES[PALETTE.indexOf(c)] || c));
    } else {
      const i = it.values.indexOf(it.get());
      text.textContent = String(it.labels ? it.labels[i] : it.values[i] ?? it.get());
    }
    v.append(left, text, right);
    return v;
  }

  function highlight() {
    [...listEl.children].forEach((li, i) => li.classList.toggle('selected', i === index));
  }

  function change(dir) {
    const it = current().items[index];
    if (it.type === 'choice') {
      const i = it.values.indexOf(it.get());
      it.set(it.values[(i + dir + it.values.length) % it.values.length]);
    } else if (it.type === 'color') {
      const i = Math.max(0, PALETTE.indexOf(it.get()));
      it.set(PALETTE[(i + dir + PALETTE.length) % PALETTE.length]);
    } else {
      return;
    }
    changed();
    render();
  }

  function activate() {
    const it = current().items[index];
    if (it.type === 'action') it.run();
    else if (it.type === 'choice' || it.type === 'color') change(1);
    else if (it.type === 'key') {
      capturing = it.action;
      render();
    }
  }

  function move(dir) {
    const sel = selectable(current().items);
    const i = sel.indexOf(index);
    index = sel[(i + dir + sel.length) % sel.length];
    highlight();
  }

  function push(name) {
    stack.push(name);
    index = -1;
    render();
  }

  function back() {
    const screen = current();
    if (screen.back) return screen.back();
    if (stack.length > 1) {
      stack.pop();
      index = -1;
      render();
    }
  }

  window.addEventListener('keydown', (e) => {
    if (!isOpen()) return;
    if (capturing) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.code === 'Escape') {
        capturing = null;
        render();
        return;
      }
      if (RESERVED.has(e.code)) {
        hintEl.textContent = `${keyName(e.code)} is reserved (menu, pause, radar, …). Choose another key or Esc.`;
        return;
      }
      // A key already used by another action: swap the two bindings.
      const other = Object.keys(tuning.keys).find((k) => k !== capturing && tuning.keys[k] === e.code);
      if (other) tuning.keys[other] = tuning.keys[capturing];
      tuning.keys[capturing] = e.code;
      changed();
      capturing = null;
      render();
      return;
    }
    const map = {
      ArrowUp: () => move(-1), ArrowDown: () => move(1),
      ArrowLeft: () => change(-1), ArrowRight: () => change(1),
      Enter: activate, Space: activate, Escape: back,
    };
    const fn = map[e.code];
    if (fn) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat || e.code.startsWith('Arrow')) fn();
    }
  }, true);

  function isOpen() {
    return !root.classList.contains('hidden');
  }

  return {
    open(name) {
      stack = [name];
      index = -1;
      capturing = null;
      root.classList.remove('hidden');
      render();
    },
    close() {
      root.classList.add('hidden');
      capturing = null;
    },
    isOpen,
  };
}

// "ArrowUp" → "↑", "KeyA" → "A", "ShiftLeft" → "Shift Left".
function keyName(code) {
  const arrows = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
  if (arrows[code]) return arrows[code];
  return code.replace(/^(Key|Digit)/, '').replace(/(Left|Right)$/, ' $1');
}
