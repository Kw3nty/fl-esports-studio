/* FL Esports Studio — палитра в стиле G HUB: кольцо оттенка, цвет в центре, RGB справа, полоса светлоты снизу. */
class ColorPicker {
  constructor(root, onChange) {
    this.root = root; this.onChange = onChange;
    this.h = 0; this.s = 1; this.v = 1;
    root.innerHTML = `
      <div class="cw-row">
        <div class="cw-wheel" tabindex="0" role="slider" aria-label="Оттенок" aria-valuemin="0" aria-valuemax="360">
          <canvas width="300" height="300"></canvas><span class="cw-center"></span><span class="cw-thumb"></span>
        </div>
        <div class="cw-fields">
          <label class="cw-f"><span>R</span><input type="number" min="0" max="255" aria-label="Красный"></label>
          <label class="cw-f"><span>G</span><input type="number" min="0" max="255" aria-label="Зелёный"></label>
          <label class="cw-f"><span>B</span><input type="number" min="0" max="255" aria-label="Синий"></label>
          <label class="cw-f hex"><span>#</span><input class="mono" maxlength="6" spellcheck="false" aria-label="HEX"></label>
        </div>
      </div>
      <div class="cw-light" tabindex="0" role="slider" aria-label="Светлота" aria-valuemin="0" aria-valuemax="100"><span class="cw-lthumb"></span></div>`;
    this.wheel = root.querySelector('.cw-wheel'); this.canvas = this.wheel.querySelector('canvas');
    this.center = root.querySelector('.cw-center'); this.thumb = root.querySelector('.cw-thumb');
    this.light = root.querySelector('.cw-light'); this.lthumb = root.querySelector('.cw-lthumb');
    const [r, g, b, hx] = root.querySelectorAll('.cw-fields input'); this.inp = { r, g, b, hx };
    this._paintWheel();
    const drag = (el, fn) => {
      el.addEventListener('pointerdown', (e) => { if (fn(e) === false) return; el.setPointerCapture(e.pointerId); this._emit(true); });
      el.addEventListener('pointermove', (e) => { if (el.hasPointerCapture(e.pointerId)) { fn(e); this._emit(true); } });
      el.addEventListener('pointerup', (e) => { if (el.hasPointerCapture(e.pointerId)) this._emit(false); });
    };
    drag(this.wheel, (e) => {
      const rc = this.wheel.getBoundingClientRect(), x = e.clientX - rc.left - rc.width / 2, y = e.clientY - rc.top - rc.height / 2;
      if (e.type === 'pointerdown' && Math.hypot(x, y) < rc.width * 0.3) return false; // клик по центру не меняет оттенок
      this.h = (Math.atan2(y, x) * 180 / Math.PI + 450) % 360; this._paint();
    });
    drag(this.light, (e) => { const rc = this.light.getBoundingClientRect(); this._setL(clamp01((e.clientX - rc.left) / rc.width)); this._paint(); });
    this.wheel.addEventListener('keydown', (e) => {
      const d = { ArrowLeft: -4, ArrowDown: -4, ArrowRight: 4, ArrowUp: 4 }[e.key]; if (!d) return;
      e.preventDefault(); this.h = (this.h + d + 360) % 360; this._paint(); this._emit(false);
    });
    this.light.addEventListener('keydown', (e) => {
      const d = { ArrowLeft: -0.03, ArrowRight: 0.03 }[e.key]; if (!d) return;
      e.preventDefault(); this._setL(clamp01(this._getL() + d)); this._paint(); this._emit(false);
    });
    hx.addEventListener('change', () => { const v = hx.value.replace(/^#/, ''); if (/^[0-9a-f]{6}$/i.test(v)) this.set(parseInt(v, 16), true); else this._fields(); });
    for (const k of ['r', 'g', 'b']) this.inp[k].addEventListener('change', () => {
      const n = (x) => Math.max(0, Math.min(255, Math.round(+this.inp[x].value || 0)));
      this.set((n('r') << 16) | (n('g') << 8) | n('b'), true);
    });
  }
  // Светлота как в G HUB: 0 — чёрный, 0.5 — чистый цвет, 1 — белый
  _getL() { return this.s >= 0.999 ? this.v / 2 : 0.5 + (1 - this.s) / 2; }
  _setL(p) { if (p <= 0.5) { this.s = 1; this.v = p * 2; } else { this.v = 1; this.s = 1 - (p - 0.5) * 2; } }
  get rgb() { const [r, g, b] = hsv2rgb(this.h, this.s, this.v); return (r << 16) | (g << 8) | b; }
  set(rgb, emit = false) {
    const [h, s, v] = rgb2hsv((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255);
    if (s > 0.001) this.h = h;
    if (s < 0.999 && v < 0.999) { this.s = s; this.v = v; } else { this.s = s; this.v = v; }
    this._paint(); if (emit) this._emit(false);
  }
  setDisabled(d) { this.root.classList.toggle('disabled', d); }
  _emit(live) { this.onChange && this.onChange(this.rgb, live); }
  _paintWheel() {
    const c = this.canvas.getContext('2d'), R = 150, r0 = 104;
    for (let a = 0; a < 360; a += 0.5) {
      c.beginPath(); c.strokeStyle = `hsl(${a},100%,50%)`; c.lineWidth = R - r0;
      const st = (a - 90 - 0.6) * Math.PI / 180, en = (a - 90 + 0.6) * Math.PI / 180;
      c.arc(150, 150, (R + r0) / 2, st, en); c.stroke();
    }
  }
  _paint() {
    const hex = '#' + this.rgb.toString(16).padStart(6, '0');
    this.center.style.background = hex;
    const ang = (this.h - 90) * Math.PI / 180, rad = 42.3; // % от центра до середины кольца
    this.thumb.style.left = 50 + Math.cos(ang) * rad + '%'; this.thumb.style.top = 50 + Math.sin(ang) * rad + '%';
    this.thumb.style.background = `hsl(${this.h},100%,50%)`;
    this.wheel.setAttribute('aria-valuenow', Math.round(this.h));
    const pure = `hsl(${this.h},100%,50%)`;
    this.light.style.background = `linear-gradient(90deg, #000, ${pure}, #fff)`;
    const L = this._getL(); this.lthumb.style.left = L * 100 + '%'; this.lthumb.style.background = hex;
    this.light.setAttribute('aria-valuenow', Math.round(L * 100));
    this._fields();
  }
  _fields() {
    const n = this.rgb;
    this.inp.hx.value = n.toString(16).padStart(6, '0').toUpperCase();
    this.inp.r.value = (n >> 16) & 255; this.inp.g.value = (n >> 8) & 255; this.inp.b.value = n & 255;
  }
}
function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function hsv2rgb(h, s, v) {
  const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
}
function rgb2hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, mx ? d / mx : 0, mx];
}
