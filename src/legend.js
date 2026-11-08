/* FL Esports Studio — надписи на кейкапах (как на прозрачных кейкапах Q75: основная надпись + верхний символ). */
const LEGEND = (() => {
  const L = {};
  for (let i = 0; i < 26; i++) L[4 + i] = { main: String.fromCharCode(65 + i), big: true };
  const nums = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'], tops = ['!', '@', '#', '$', '%', '^', '&', '*', '(', ')'];
  nums.forEach((n, i) => (L[30 + i] = { main: n, top: tops[i] }));
  Object.assign(L, {
    45: { main: '-', top: '_' }, 46: { main: '=', top: '+' }, 47: { main: '[', top: '{' }, 48: { main: ']', top: '}' }, 49: { main: '\\', top: '|' },
    50: { main: '#', top: '~' }, 51: { main: ';', top: ':' }, 52: { main: "'", top: '"' }, 53: { main: '`', top: '~' }, 54: { main: ',', top: '<' },
    55: { main: '.', top: '>' }, 56: { main: '/', top: '?' }, 100: { main: '\\', top: '|' },
    40: { main: 'ENTER', word: true }, 41: { main: 'ESC', word: true }, 42: { main: 'BACKSPACE', word: true }, 43: { main: 'TAB', word: true },
    44: { main: '', word: true }, 57: { main: 'CAPSLOCK', word: true }, 70: { main: 'PRTSC', word: true }, 71: { main: 'SCRLK', word: true },
    72: { main: 'PAUSE', word: true }, 73: { main: 'INSERT', word: true }, 74: { main: 'HOME', word: true }, 75: { main: 'PGUP', word: true },
    76: { main: 'DELETE', word: true }, 77: { main: 'END', word: true }, 78: { main: 'PGDN', word: true },
    79: { arrow: 'right' }, 80: { arrow: 'left' }, 81: { arrow: 'down' }, 82: { arrow: 'up' },
    101: { main: 'MENU', word: true },
    224: { main: 'CTRL', word: true }, 225: { main: 'SHIFT', word: true }, 226: { main: 'ALT', word: true }, 227: { main: 'WIN', word: true },
    228: { main: 'CTRL', word: true }, 229: { main: 'SHIFT', word: true }, 230: { main: 'ALT', word: true }, 231: { main: 'WIN', word: true },
  });
  for (let i = 1; i <= 12; i++) L[57 + i] = { main: 'F' + i, word: true };
  for (let i = 13; i <= 24; i++) L[91 + i] = { main: 'F' + i, word: true };
  return L;
})();

// 4 байта назначения -> разметка кейкапа
function keycapLegend(code) {
  const [t, m, k, k2] = code;
  const el = document.createElement('span'); el.className = 'cap';
  if (t === 0 && m === 0 && k2 === 0 && LEGEND[k]) {
    const lg = LEGEND[k];
    if (lg.arrow) {
      const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      s.setAttribute('viewBox', '0 0 10 10'); s.setAttribute('class', 'cap-arrow ' + lg.arrow); s.setAttribute('aria-hidden', 'true');
      s.innerHTML = '<path d="M5 2 L8.5 7.5 H1.5 Z" fill="currentColor"/>';
      el.append(s); return el;
    }
    if (lg.top) { const top = document.createElement('span'); top.className = 'cap-top'; top.textContent = lg.top; el.append(top); }
    const main = document.createElement('span');
    main.className = 'cap-main' + (lg.word ? ' word' : '') + (lg.big ? ' big' : '');
    main.textContent = lg.main; el.append(main);
    return el;
  }
  if (t === 10 && m === 1) { el.innerHTML = '<span class="cap-main word">FN</span>'; return el; }
  if (t === 0 && m === 0 && k === 0 && k2 === 0) { el.innerHTML = '<span class="cap-main word dim">—</span>'; return el; }
  const d = describe(code);
  const main = document.createElement('span'); main.className = 'cap-main word custom'; main.textContent = d.short.toUpperCase();
  el.append(main);
  return el;
}
