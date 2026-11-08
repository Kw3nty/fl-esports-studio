/* FL Esports Studio — коды клавиш, назначения и физическая раскладка. */

// HID Usage (Keyboard page 0x07) -> подпись
const HID = {
  4: 'A', 5: 'B', 6: 'C', 7: 'D', 8: 'E', 9: 'F', 10: 'G', 11: 'H', 12: 'I', 13: 'J', 14: 'K', 15: 'L', 16: 'M',
  17: 'N', 18: 'O', 19: 'P', 20: 'Q', 21: 'R', 22: 'S', 23: 'T', 24: 'U', 25: 'V', 26: 'W', 27: 'X', 28: 'Y', 29: 'Z',
  30: '1', 31: '2', 32: '3', 33: '4', 34: '5', 35: '6', 36: '7', 37: '8', 38: '9', 39: '0',
  40: 'Enter', 41: 'Esc', 42: 'Backspace', 43: 'Tab', 44: 'Space', 45: '-', 46: '=', 47: '[', 48: ']', 49: '\\',
  50: '#', 51: ';', 52: "'", 53: '`', 54: ',', 55: '.', 56: '/', 57: 'Caps Lock',
  58: 'F1', 59: 'F2', 60: 'F3', 61: 'F4', 62: 'F5', 63: 'F6', 64: 'F7', 65: 'F8', 66: 'F9', 67: 'F10', 68: 'F11', 69: 'F12',
  70: 'Print Screen', 71: 'Scroll Lock', 72: 'Pause', 73: 'Insert', 74: 'Home', 75: 'Page Up', 76: 'Delete', 77: 'End', 78: 'Page Down',
  79: '→', 80: '←', 81: '↓', 82: '↑', 83: 'Num Lock', 84: 'Num /', 85: 'Num *', 86: 'Num -', 87: 'Num +', 88: 'Num Enter',
  89: 'Num 1', 90: 'Num 2', 91: 'Num 3', 92: 'Num 4', 93: 'Num 5', 94: 'Num 6', 95: 'Num 7', 96: 'Num 8', 97: 'Num 9', 98: 'Num 0', 99: 'Num .',
  100: 'ISO \\', 101: 'Menu', 104: 'F13', 105: 'F14', 106: 'F15', 107: 'F16', 108: 'F17', 109: 'F18', 110: 'F19', 111: 'F20', 112: 'F21', 113: 'F22', 114: 'F23', 115: 'F24',
  224: 'L Ctrl', 225: 'L Shift', 226: 'L Alt', 227: 'L Win', 228: 'R Ctrl', 229: 'R Shift', 230: 'R Alt', 231: 'R Win',
};
const SHORT = {
  'Backspace': 'Bksp', 'Caps Lock': 'Caps', 'Print Screen': 'PrtSc', 'Scroll Lock': 'ScrLk', 'Page Up': 'PgUp', 'Page Down': 'PgDn',
  'Delete': 'Del', 'Insert': 'Ins', 'L Ctrl': 'Ctrl', 'R Ctrl': 'Ctrl', 'L Shift': 'Shift', 'R Shift': 'Shift', 'L Alt': 'Alt',
  'R Alt': 'Alt', 'L Win': 'Win', 'R Win': 'Win', 'Num Lock': 'NumLk', 'Num Enter': 'N.Ent', 'Space': '',
};

// Особые назначения (формат 4 байта прошивки)
const SPECIAL = [
  { cat: 'media', name: 'Без звука', code: [3, 0, 226, 0] },
  { cat: 'media', name: 'Громкость +', code: [3, 0, 233, 0] },
  { cat: 'media', name: 'Громкость −', code: [3, 0, 234, 0] },
  { cat: 'media', name: 'Воспр./пауза', code: [3, 0, 205, 0] },
  { cat: 'media', name: 'Следующий трек', code: [3, 0, 181, 0] },
  { cat: 'media', name: 'Предыдущий трек', code: [3, 0, 182, 0] },
  { cat: 'media', name: 'Стоп', code: [3, 0, 183, 0] },
  { cat: 'media', name: 'Плеер', code: [3, 0, 131, 1] },
  { cat: 'media', name: 'Яркость экрана +', code: [3, 0, 111, 0] },
  { cat: 'media', name: 'Яркость экрана −', code: [3, 0, 112, 0] },
  { cat: 'system', name: 'Калькулятор', code: [3, 0, 146, 1] },
  { cat: 'system', name: 'Почта', code: [3, 0, 138, 1] },
  { cat: 'system', name: 'Мой компьютер', code: [3, 0, 148, 1] },
  { cat: 'system', name: 'Поиск', code: [3, 0, 33, 2] },
  { cat: 'system', name: 'Браузер: домой', code: [3, 0, 35, 2] },
  { cat: 'system', name: 'Браузер: назад', code: [3, 0, 36, 2] },
  { cat: 'system', name: 'Браузер: обновить', code: [3, 0, 39, 2] },
  { cat: 'system', name: 'Заблокировать ПК (Win+L)', code: [0, 0, 227, 15] },
  { cat: 'system', name: 'Сменить язык (Ctrl+Space)', code: [0, 224, 44, 0] },
  { cat: 'mouse', name: 'ЛКМ', code: [1, 0, 240, 0] },
  { cat: 'mouse', name: 'ПКМ', code: [1, 0, 241, 0] },
  { cat: 'mouse', name: 'Колесо (клик)', code: [1, 0, 242, 0] },
  { cat: 'mouse', name: 'Назад', code: [1, 0, 243, 0] },
  { cat: 'mouse', name: 'Вперёд', code: [1, 0, 244, 0] },
  { cat: 'mouse', name: 'Прокрутка вверх', code: [1, 0, 245, 1] },
  { cat: 'mouse', name: 'Прокрутка вниз', code: [1, 0, 245, 255] },
  { cat: 'special', name: 'Fn', code: [10, 1, 0, 0] },
  { cat: 'special', name: 'Отключить клавишу', code: [0, 0, 0, 0] },
];
const MOD_CODES = { ctrl: 224, shift: 225, alt: 226, win: 227 };

function codeEq(a, b) { return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]; }

// 4 байта -> {short, full}
function describe(code) {
  const [t, m, k, k2] = code;
  if (t === 0 && m === 0 && k === 0 && k2 === 0) return { short: '—', full: 'Отключена' };
  const sp = SPECIAL.find((s) => codeEq(s.code, code));
  if (sp) return { short: sp.name.length > 8 ? sp.name.slice(0, 7) + '…' : sp.name, full: sp.name };
  if (t === 0) {
    const base = HID[k] || ('0x' + k.toString(16));
    if (m === 0 && k2 === 0) return { short: SHORT[base] !== undefined ? SHORT[base] : base, full: base };
    const mod = Object.keys(MOD_CODES).find((x) => MOD_CODES[x] === m);
    const parts = [];
    if (mod) parts.push(mod[0].toUpperCase() + mod.slice(1));
    else if (m) parts.push(HID[m] || ('0x' + m.toString(16)));
    parts.push(base);
    if (k2) parts.push(HID[k2] || ('0x' + k2.toString(16)));
    const s = parts.join('+');
    return { short: s.length > 9 ? s.slice(0, 8) + '…' : s, full: s };
  }
  if (t === 10 && m === 1) return { short: 'Fn', full: 'Fn' };
  if (t === 9) { const nm = (typeof macroName === 'function' && macroName(k)) || ('Макрос ' + (k + 1)); return { short: nm.length > 9 ? nm.slice(0, 8) + '…' : nm, full: nm + ' (' + ({ 0: 'повтор N раз', 1: 'вкл/выкл', 2: 'пока нажата' }[m] || 'режим ' + m) + ')' }; }
  if (t === 3) return { short: 'Media', full: 'Мультимедиа 0x' + (k | (k2 << 8)).toString(16) };
  const hex = code.map((x) => x.toString(16).padStart(2, '0')).join(' ');
  return { short: '?', full: 'Неизвестно: ' + hex };
}

// Группы клавиш для выбора
const PICK_GROUPS = [
  { name: 'Буквы', codes: [...Array(26)].map((_, i) => 4 + i) },
  { name: 'Цифры и символы', codes: [30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 45, 46, 47, 48, 49, 51, 52, 53, 54, 55, 56, 50, 100] },
  { name: 'F-клавиши', codes: [58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115] },
  { name: 'Управление', codes: [41, 40, 42, 43, 44, 57, 70, 71, 72, 73, 74, 75, 76, 77, 78, 101] },
  { name: 'Стрелки', codes: [82, 81, 80, 79] },
  { name: 'Модификаторы', codes: [224, 225, 226, 227, 228, 229, 230, 231] },
  { name: 'Цифровой блок', codes: [83, 84, 85, 86, 87, 88, 95, 96, 97, 92, 93, 94, 89, 90, 91, 98, 99] },
];

/*
 * Физическая раскладка 75%. [index | null, ширина, особый флаг]
 * index = колонка*6 + ряд в матрице прошивки. null = промежуток.
 */
const K = (col, row, w = 1, extra) => ({ i: col * 6 + row, w, ...(extra || {}) });
const GAP = (w) => ({ gap: true, w });
function buildLayout(model, iso) {
  const right = (row) => K(14, row);
  const rows = [
    [K(0, 0), GAP(1), K(2, 0), K(3, 0), K(4, 0), K(5, 0), GAP(0.5), K(6, 0), K(7, 0), K(8, 0), K(9, 0), GAP(0.5), K(10, 0), K(11, 0), K(12, 0), K(13, 0), GAP(0.25),
      model === 'knob' ? { knob: true, w: 1, press: 14 * 6 + 5, ccw: 15 * 6 + 0, cw: 15 * 6 + 1 } : right(0)],
    [K(0, 1), K(1, 1), K(2, 1), K(3, 1), K(4, 1), K(5, 1), K(6, 1), K(7, 1), K(8, 1), K(9, 1), K(10, 1), K(11, 1), K(12, 1), K(13, 1, 2), GAP(0.25), right(1)],
    [K(0, 2, 1.5), K(1, 2), K(2, 2), K(3, 2), K(4, 2), K(5, 2), K(6, 2), K(7, 2), K(8, 2), K(9, 2), K(10, 2), K(11, 2), K(12, 2), iso ? K(13, 3, 1.5, { isoEnterTop: true }) : K(13, 2, 1.5), GAP(0.25), right(2)],
    [K(0, 3, 1.75), K(1, 3), K(2, 3), K(3, 3), K(4, 3), K(5, 3), K(6, 3), K(7, 3), K(8, 3), K(9, 3), K(10, 3), K(11, 3),
      ...(iso ? [K(12, 3), K(13, 3, 1.25, { isoEnterBottom: true })] : [K(13, 3, 2.25)]), GAP(0.25), right(3)],
    [...(iso ? [K(0, 4, 1.25), K(1, 4)] : [K(0, 4, 2.25)]), K(2, 4), K(3, 4), K(4, 4), K(5, 4), K(6, 4), K(7, 4), K(8, 4), K(9, 4), K(10, 4), K(11, 4), K(12, 4, 1.75), GAP(0.25), K(13, 4), right(4)],
    [K(0, 5, 1.25), K(2, 5, 1.25), K(3, 5, 1.25), K(4, 5, 6.25), K(5, 5), K(6, 5), K(7, 5), GAP(0.25), K(8, 5), K(9, 5), K(10, 5)],
  ];
  return rows;
}

if (typeof module !== 'undefined') module.exports = { HID, SPECIAL, MOD_CODES, describe, PICK_GROUPS, buildLayout, codeEq };
