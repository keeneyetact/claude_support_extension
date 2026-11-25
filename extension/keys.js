// Key definitions for CDP Input.dispatchKeyEvent.

const MOD_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

const NAMED = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Escape: { code: 'Escape', keyCode: 27 },
  Delete: { code: 'Delete', keyCode: 46 },
  Insert: { code: 'Insert', keyCode: 45 },
  ' ': { code: 'Space', keyCode: 32, text: ' ' },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Shift: { code: 'ShiftLeft', keyCode: 16 },
  Control: { code: 'ControlLeft', keyCode: 17 },
  Alt: { code: 'AltLeft', keyCode: 18 },
  Meta: { code: 'MetaLeft', keyCode: 91 },
  CapsLock: { code: 'CapsLock', keyCode: 20 },
  ContextMenu: { code: 'ContextMenu', keyCode: 93 },
};
for (let i = 1; i <= 12; i++) NAMED['F' + i] = { code: 'F' + i, keyCode: 111 + i };

const ALIASES = {
  esc: 'Escape', escape: 'Escape', return: 'Enter', enter: 'Enter', tab: 'Tab', backspace: 'Backspace',
  del: 'Delete', delete: 'Delete', insert: 'Insert', ins: 'Insert', space: ' ', spacebar: ' ',
  left: 'ArrowLeft', arrowleft: 'ArrowLeft', right: 'ArrowRight', arrowright: 'ArrowRight',
  up: 'ArrowUp', arrowup: 'ArrowUp', down: 'ArrowDown', arrowdown: 'ArrowDown',
  home: 'Home', end: 'End', pageup: 'PageUp', pgup: 'PageUp', pagedown: 'PageDown', pgdn: 'PageDown',
  shift: 'Shift', ctrl: 'Control', control: 'Control', alt: 'Alt', option: 'Alt', opt: 'Alt',
  meta: 'Meta', cmd: 'Meta', command: 'Meta', win: 'Meta', super: 'Meta', capslock: 'CapsLock',
  contextmenu: 'ContextMenu', menu: 'ContextMenu',
};

const PUNCT = {
  '-': ['Minus', 189], '=': ['Equal', 187], '[': ['BracketLeft', 219], ']': ['BracketRight', 221],
  '\\': ['Backslash', 220], ';': ['Semicolon', 186], "'": ['Quote', 222], ',': ['Comma', 188],
  '.': ['Period', 190], '/': ['Slash', 191], '`': ['Backquote', 192],
};

function normalizeName(name) {
  if (name.length === 1) return name;
  const a = ALIASES[name.toLowerCase()];
  if (a) return a;
  if (/^f([1-9]|1[0-2])$/i.test(name)) return name.toUpperCase();
  if (NAMED[name]) return name;
  throw new Error(`Unknown key "${name}". Use names like Enter, Tab, Escape, Backspace, ArrowDown, PageDown, F5, a single character, or combos like Control+A.`);
}

// Returns { key, code, keyCode, text? } for a normalized key name.
export function keyDef(name, shift = false) {
  name = normalizeName(name);
  if (NAMED[name]) return { key: name, ...NAMED[name] };
  const ch = name;
  if (/^[a-z]$/i.test(ch)) {
    const up = ch.toUpperCase();
    const key = shift ? up : ch;
    return { key, code: 'Key' + up, keyCode: up.charCodeAt(0), text: key };
  }
  if (/^[0-9]$/.test(ch)) return { key: ch, code: 'Digit' + ch, keyCode: ch.charCodeAt(0), text: ch };
  if (PUNCT[ch]) return { key: ch, code: PUNCT[ch][0], keyCode: PUNCT[ch][1], text: ch };
  return { key: ch, code: '', keyCode: 0, text: ch };
}

// "Control+Shift+K" -> { modifiers: ['Control','Shift'], key: 'K' }
export function parseCombo(combo) {
  const s = String(combo).trim();
  if (!s) throw new Error('Empty key.');
  if (s === '+') return { modifiers: [], key: '+' };
  let parts = s.split('+');
  // handle a trailing "+" key, e.g. "Control++"
  if (s.endsWith('++')) parts = [...s.slice(0, -2).split('+'), '+'];
  const keyName = parts.pop();
  const modifiers = parts.filter(Boolean).map((m) => {
    const n = normalizeName(m);
    if (!(n in MOD_BITS)) throw new Error(`"${m}" is not a modifier (use Control, Shift, Alt, Meta).`);
    return n;
  });
  return { modifiers, key: keyName };
}

export function modifierBits(mods) {
  return (mods || []).reduce((b, m) => b | (MOD_BITS[normalizeName(m)] || 0), 0);
}

// macOS editing shortcuts need explicit commands when dispatched through CDP.
const MAC_COMMANDS = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo' };
export function macCommands(modifiers, key) {
  if (modifiers.length === 1 && modifiers[0] === 'Meta' && key.length === 1) {
    const c = MAC_COMMANDS[key.toLowerCase()];
    if (c) return [c];
  }
  if (modifiers.length === 2 && modifiers.includes('Meta') && modifiers.includes('Shift') && key.toLowerCase() === 'z') return ['redo'];
  return undefined;
}
