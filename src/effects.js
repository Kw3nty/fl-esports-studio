/* FL Esports Studio — группы эффектов и программный предпросмотр подсветки (приближение к поведению прошивки). */
const EFFECT_GROUPS = [
  { name: 'Основные', ids: ['LightOff', 'LightAlwaysOn', 'LightBreath', 'LightNeon'] },
  { name: 'Волны', ids: ['LightWave', 'LightLineWave', 'LightSineWave', 'LightCircleWave', 'LightKaleidoscope', 'LightConverage'] },
  { name: 'Реакция на нажатие', ids: ['LightPressAction', 'LightPressActionOff', 'LightRipple', 'LightLaser'] },
  { name: 'Динамика', ids: ['LightRaindrop', 'LightRainDown', 'LightMeteor', 'LightSnake', 'LightDazzing'] },
  { name: 'Звук и экран', ids: ['LightMusicFollow2', 'LightScreenColor'] },
  { name: 'Пользовательские', ids: ['LightUserPicture'] },
];

// последние данные живого потока (заполняет app.js из /api/stream)
const LIVE = { levels: null, rgb: null, at: 0 };
const liveFresh = () => Date.now() - LIVE.at < 2000;

const hash = (a, b, c = 0) => { let x = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453; return x - Math.floor(x); };
function hsl(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  const f = (n) => { const k = (n + h * 12) % 12; return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

// x: 0..16 (центр клавиши в юнитах), y: 0..5 (ряд), t: секунды. Возвращает [r,g,b,яркость 0..1]
function effectColor(L, x, y, t) {
  const m = LIGHT_MODES.find((q) => q.id === L.type);
  if (!m || m.mode === 0) return [0, 0, 0, 0];
  const sp = 0.35 + (L.speed || 0) * 0.45;
  const rainbow = L.rainbow || !m.color;
  const own = [(L.rgb >> 16) & 255, (L.rgb >> 8) & 255, L.rgb & 255];
  const hueAt = (h) => (rainbow ? hsl(h, 0.9, 0.55) : own);
  const cx = 8, cy = 2.5, dx = x - cx, dy = (y - cy) * 1.4, dist = Math.hypot(dx, dy);
  // псевдо-нажатия для реактивных эффектов
  const pressAt = (period) => {
    const k = Math.floor(t / period), age = t - k * period;
    return { px: 1 + hash(k, 1) * 14, py: Math.floor(hash(k, 2) * 6), age, k };
  };
  let c = hueAt(x * 22), v = 1;
  switch (m.id) {
    case 'LightAlwaysOn': break;
    case 'LightBreath': v = 0.15 + 0.85 * (0.5 + 0.5 * Math.sin(t * sp * 2)); c = hueAt(rainbow ? t * 30 : 0); break;
    case 'LightNeon': c = hsl(t * sp * 60, 0.9, 0.55); break;
    case 'LightWave': {
      const dir = { right: -x, left: x, down: -y * 2.5, up: y * 2.5 }[L.option || 'right'];
      const ph = dir + t * sp * 6; c = rainbow ? hsl(ph * 22, 0.9, 0.55) : own; v = rainbow ? 1 : 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(ph * 0.6)); break;
    }
    case 'LightLineWave': { const pos = ((t * sp * 5) % 20) - 2, d = L.option === 'left' ? 16 - x : x; v = Math.max(0, 1 - Math.abs(d - pos) / 2.2); c = hueAt(pos * 20); break; }
    case 'LightSineWave': v = Math.max(0, Math.sin(x * 0.7 - t * sp * 3) * 0.5 + 0.5 - Math.abs(y - 2.5 - Math.sin(x * 0.5 - t * sp * 2) * 2) * 0.25); c = hueAt(x * 22 + t * 40); break;
    case 'LightCircleWave': { const a = Math.atan2(dy, dx) * 57.3 * (L.option === 'clockwise' ? 1 : -1); c = hsl(a + t * sp * 120, 0.9, 0.55); if (!rainbow) { c = own; v = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(a / 30 + t * sp * 3)); } break; }
    case 'LightKaleidoscope': { const ph = dist * (L.option === 'in' ? 1 : -1) + t * sp * 4; c = hueAt(ph * 40); v = rainbow ? 1 : 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(ph)); break; }
    case 'LightConverage': { const ph = Math.abs(dx) + t * sp * 4; c = hueAt(ph * 30); v = 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(ph)); break; }
    case 'LightPressAction': { const p = pressAt(0.7); v = (Math.abs(x - p.px) < 0.6 && y === p.py) ? Math.max(0, 1 - p.age / 0.7) : 0; c = hueAt(p.k * 47); break; }
    case 'LightPressActionOff': { const p = pressAt(0.7); v = (Math.abs(x - p.px) < 0.6 && y === p.py) ? Math.min(1, p.age / 0.7) : 1; break; }
    case 'LightRipple': { const p = pressAt(1.2), r = p.age * sp * 9, d = Math.hypot(x - p.px, (y - p.py) * 1.4); v = Math.max(0, 1 - Math.abs(d - r) / 1.2) * Math.max(0, 1 - p.age / 1.2); c = hueAt(d * 30 + p.k * 50); break; }
    case 'LightLaser': { const p = pressAt(1); v = y === p.py ? Math.max(0, 1 - Math.abs(Math.abs(x - p.px) - p.age * sp * 12) / 1.5) : 0; c = hueAt(p.k * 60); break; }
    case 'LightRaindrop': { const k = Math.floor(t * sp * 3), h = hash(x, y, k); v = h > 0.82 ? 1 - ((t * sp * 3) % 1) : 0; c = hueAt(h * 360); break; }
    case 'LightRainDown': { const col = Math.round(x), off = hash(col, 9) * 8, pos = (t * sp * 4 + off) % 9; v = Math.max(0, 1 - (pos - y) / 3) * (pos >= y ? 1 : 0); c = hueAt(col * 25); break; }
    case 'LightMeteor': { const pos = (t * sp * 7) % 26 - 5, d = x + y * 1.2 - pos; v = d < 0 && d > -5 ? 1 + d / 5 : 0; c = hueAt(pos * 15); break; }
    case 'LightSnake': {
      const idx = y * 17 + (L.option === 'return' && y % 2 ? 16 - x : x), head = (t * sp * 18) % 102, d = head - idx;
      v = d >= 0 && d < 10 ? 1 - d / 10 : 0; c = hueAt(idx * 4); break;
    }
    case 'LightDazzing': { const k = Math.floor(t * sp * 2); c = hsl(hash(x, y, k) * 360, 0.9, 0.55); break; }
    case 'LightUserPicture': c = hsl(y * 50 + x * 5, 0.8, 0.55); break;
    case 'LightScreenColor': c = liveFresh() && LIVE.rgb ? LIVE.rgb : hsl(t * 25, 0.75, 0.5); break;
    case 'LightMusicFollow2': {
      const i = Math.max(0, Math.min(31, Math.floor((x + 0.5) / 17 * 32)));
      const lv = liveFresh() && LIVE.levels ? LIVE.levels[i] || 0 : 3 + 3 * Math.sin(t * 5 + x * 0.9) * Math.abs(Math.sin(t * 1.7 + x * 0.35));
      const up = 5 - y, opt = L.option || 'upright';
      const on = opt === 'separate' ? Math.abs(y - 2.5) < lv / 2 : opt === 'intersect' ? (up < lv / 2 || y < lv / 2) : up < lv;
      // как на самой клавиатуре: радуга идёт по столбцам (~30° на клавишу) и всё время бежит слева направо (~200°/с)
      v = on ? 1 : 0.04; c = rainbow ? hsl((((t * 200 - x * 30) % 360) + 360) % 360, 1, 0.5) : own; break;
    }
    default: break;
  }
  return [c[0], c[1], c[2], Math.max(0, Math.min(1, v)) * (0.25 + 0.75 * ((L.brightness ?? 4) / 4))];
}
