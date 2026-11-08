/*
 * FL Esports Studio — 3D-модель FL Esports Q75 (Three.js r158 + bloom).
 * Сделано по фото производителя (прозрачная версия):
 *  • корпус-«клин» из глянцевого прозрачного поликарбоната ≈ 330 × 142 мм, угол ≈ 5,5°:
 *    верхняя рамка ровной толщины + нижняя крышка; гаскет-лапки видны насквозь;
 *  • матовая молочная PC-пластина, белая силиконовая прослойка, чёрная плата;
 *  • прозрачные свитчи и стабилизаторы, светодиод каждого свитча смотрит «на север»;
 *  • прозрачные кейкапы с матовым верхом, скруглённый профиль со скульптурой рядов,
 *    чёрные надписи по центру.
 * Свет: светодиод → корпус свитча → матовый кейкап → пластина → стенки корпуса → стол,
 * поверх — bloom, как на фото с подсветкой.
 * 1 единица сцены = 1u = 19,05 мм.
 */
const KB3D = (() => {
  const T = typeof window !== 'undefined' ? window.THREE : null;
  const PP = typeof window !== 'undefined' ? window.THREE_PP : null;
  const st = { ok: false, on: false };
  const VIEW = { az: -0.3, el: 0.74, zoom: 1 }, EL_MAX = 1.5; // камера: по кругу без ограничений, сверху и снизу до ±86°
  // геометрия (в u)
  const TILT = 0.096, TAN = Math.tan(TILT); // угол набора ≈ 5,5°
  const GAP_F = 0.4; // зазор между F-рядом и цифрами (по фото ≈ 0,4u)
  const BZ = { side: 0.45, top: 0.42, bot: 0.55 }; // рамка: бока / сзади / спереди
  const HF = 0.9; // высота корпуса спереди ≈ 17 мм (сзади ≈ 31 мм)
  const TOPH = 0.52; // толщина верхней рамки
  const PY = -0.33; // верх пластины относительно верха рамки
  const CAPY = -0.05; // нижний край кейкапа
  const ROW_H = [0.47, 0.47, 0.43, 0.41, 0.43, 0.43]; // высота кейкапов по рядам
  const ROW_T = [0.13, 0.13, 0.05, 0, -0.07, -0.07]; // наклон верхней грани по рядам
  // яркость подсветки (линейные единицы до тонмаппинга)
  const CAP_I = 0.3, HOUS_I = 1.0, STEM_I = 0.8, LED_I = 3.0, LED_BASE = 0.2, PLATE_I = 0.95;
  // откуда свет светодиода «выходит» к соседям: под кейкапом, у северного края свитча (в системе деки)
  const LED_Y = PY + 0.25, LED_DZ = -0.18;
  const ENV_TOP = 0.8, TOP_LIGHT = 1.35; // вид сверху: блики потолка в глянце слабее (кейкапы не белеют), прямой свет сильнее (модель не серая)
  const KC = 5;
  let R, composer = null, bloom = null, scene, cam, host, cv, root, deck, hooks = {};
  let keys = [], builtFor = null, pickables = [], envMats = [], adapt = 1, lights = {}, deskParts = [];
  let litNow = 0, litHold = 0, litT = 0, litWhite = 0, bloomW = 0, litPeak = 0, peakHold = 0; // сколько подсветки горит (и насколько она белая): от этого зависит «экспозиция» комнаты
  let dims = { W: 16.25, D: 6.4, CW: 17.15, CD: 7.37, HC: 1.25, KZ: 0 };
  let az = VIEW.az, el = VIEW.el, zoom = VIEW.zoom, vaz = 0, vel = 0;
  let drag = null, dirty = true, lastT = 0;
  let inst = {}, gl = {};
  let mode = 'orbit', ocam = null, rpass = null, ledMats = [], adaptMode = '', ledP = new Float32Array(4), ledC = new Float32Array(4);
  // параметры «ламп»: k1 — свой кейкап (яркость, затухание), соседи (яркость, затухание); k2 — мягкость косинуса, радиус (в u), доля света, рассеянного в пластике во все стороны
  const LEDU = { k1: { value: T ? new T.Vector4(1.8, 7.0, 1.4, 4.5) : null }, k2: { value: T ? new T.Vector4(0.35, 1.8, 0.45, 0) : null } };
  const capCache = {}, hotCache = {};
  const ray = T ? new T.Raycaster() : null, ptr = T ? new T.Vector2() : null;

  /* ---------- геометрия ---------- */
  // точки скруглённого прямоугольника в плоскости XZ (одинаковое число точек для любого размера)
  function ring(w, d, r, kc = KC) {
    r = Math.max(0.002, Math.min(r, w / 2 - 0.001, d / 2 - 0.001));
    const p = [], cx = w / 2 - r, cz = d / 2 - r;
    for (const [ox, oz, a0] of [[cx, cz, 0], [-cx, cz, 0.5], [-cx, -cz, 1], [cx, -cz, 1.5]])
      for (let i = 0; i < kc; i++) { const a = (a0 + (i / (kc - 1)) * 0.5) * Math.PI; p.push([ox + Math.cos(a) * r, oz + Math.sin(a) * r]); }
    return p;
  }
  // Shape лежит в XY; после rotateX(-90°) координата y фигуры становится -z
  function toPath(P, pts, dz) { const s = new P(); s.moveTo(pts[0][0], -(pts[0][1] + dz)); for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], -(pts[i][1] + dz)); s.closePath(); return s; }
  function extrude(shape, h, bevel) {
    const g = new T.ExtrudeGeometry(shape, { depth: h, bevelEnabled: !!bevel, bevelThickness: bevel || 0, bevelSize: bevel || 0, bevelSegments: 3, curveSegments: 4 });
    g.rotateX(-Math.PI / 2);
    return g;
  }
  function planarUV(g, W, D) {
    const p = g.attributes.position, uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) { uv[i * 2] = p.getX(i) / W + 0.5; uv[i * 2 + 1] = 0.5 - p.getZ(i) / D; }
    g.setAttribute('uv', new T.BufferAttribute(uv, 2));
  }
  function merge(geos) {
    const parts = geos.map((g) => (g.index ? g.toNonIndexed() : g));
    const n = parts.reduce((s, g) => s + g.attributes.position.count, 0);
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
    let o = 0;
    for (const g of parts) { pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3); o += g.attributes.position.count; }
    const m = new T.BufferGeometry();
    m.setAttribute('position', new T.BufferAttribute(pos, 3)); m.setAttribute('normal', new T.BufferAttribute(nor, 3));
    return m;
  }
  const boxAt = (w, h, d, x, y, z) => new T.BoxGeometry(w, h, d).translate(x, y, z);
  const cylAt = (r, h, x, y, z, seg = 14) => new T.CylinderGeometry(r, r, h, seg).translate(x, y, z);

  // Кейкап: «лофт» из скруглённых колец — стенки с сужением, скруглённая кромка, сферическая выемка сверху
  function capInfo(w, row) {
    const key = w + ':' + row;
    if (capCache[key]) return capCache[key];
    const bw = w - 0.055, bd = 0.945, h = ROW_H[row] ?? 0.43, tl = ROW_T[row] ?? 0;
    const fr = 0.055, tw = bw - 0.26, td = 0.665, rb = 0.07, rt = 0.12;
    const dish = w >= 6 ? 0 : w >= 1.75 ? 0.012 : 0.02;
    const topY = (z) => h - tl * z;
    const pos = [], uv = [], rings = [];
    const add = (pts, yf) => { rings.push(pos.length / 3); for (const [x, z] of pts) { pos.push(x, yf(x, z), z); uv.push(x / bw + 0.5, 0.5 - z / bd); } };
    const NW = 5;
    for (let j = 0; j <= NW; j++) {
      const t = j / NW;
      add(ring(bw + (tw + 2 * fr - bw) * t, bd + (td + 2 * fr - bd) * t, rb + (rt + fr - rb) * t), (x, z) => t * (topY(z) - fr));
    }
    const NF = 4;
    for (let j = 1; j <= NF; j++) {
      const a = (j / NF) * (Math.PI / 2), ins = fr * (1 - Math.cos(a));
      add(ring(tw + 2 * (fr - ins), td + 2 * (fr - ins), rt + fr - ins), (x, z) => topY(z) - fr + fr * Math.sin(a));
    }
    const NS = 4;
    for (let j = 1; j < NS; j++) { const s = 1 - j / NS; add(ring(tw * s, td * s, rt * s), (x, z) => topY(z) - dish * (1 - s * s)); }
    const ci = pos.length / 3; pos.push(0, topY(0) - dish, 0); uv.push(0.5, 0.5);
    const P = KC * 4, idx = [];
    for (let k = 0; k < rings.length - 1; k++) {
      const a = rings[k], b = rings[k + 1];
      for (let p = 0; p < P; p++) { const q = (p + 1) % P; idx.push(a + p, b + p, a + q, a + q, b + p, b + q); }
    }
    const L = rings[rings.length - 1];
    for (let p = 0; p < P; p++) idx.push(L + p, ci, L + ((p + 1) % P));
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
    g.setIndex(idx); g.computeVertexNormals();
    if (g.attributes.normal.getY(ci) < 0) { // нормали должны смотреть наружу
      for (let i = 0; i < idx.length; i += 3) { const s = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = s; }
      g.setIndex(idx); g.computeVertexNormals();
    }
    // поверхность верхней грани — для надписи
    const surf = (x, z) => { const q = Math.min(1, Math.max(Math.abs(x) / (tw / 2), Math.abs(z) / (td / 2))); return topY(z) - dish * (1 - q * q); };
    const lw = tw * 0.94, ld = td * 0.94;
    const lg = new T.PlaneGeometry(lw, ld, Math.max(4, Math.round(w * 6)), 6); lg.rotateX(-Math.PI / 2);
    const lp = lg.attributes.position;
    for (let i = 0; i < lp.count; i++) lp.setY(i, surf(lp.getX(i), lp.getZ(i)) + 0.004);
    lg.computeVertexNormals();
    return (capCache[key] = { geo: g, lgeo: lg, lw, ld });
  }

  /* ---------- текстуры ---------- */
  function canvas(w, h) { const c = document.createElement('canvas'); c.width = Math.max(2, Math.round(w)); c.height = Math.max(2, Math.round(h)); return c; }
  function ctex(c, linear) { const t = new T.CanvasTexture(c); t.colorSpace = linear ? T.NoColorSpace : T.SRGBColorSpace; return t; }
  const FONT = '"Century Gothic", Futura, "Avenir Next", "Segoe UI", Arial, sans-serif';
  // надпись: белая маска, цвет задаёт материал (чёрный, как на фото)
  function legendTex(info, lw, ld) {
    const PX = 220, c = canvas(PX * lw, PX * ld), cw = c.width, ch = c.height;
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle';
    const F = (s, wt) => `${wt} ${Math.round(s)}px ${FONT}`;
    const fit = (txt, s, maxW, wt) => { x.font = F(s, wt); while (s > 8 && x.measureText(txt).width > maxW) { s -= 1; x.font = F(s, wt); } };
    if (info.arrow) {
      const a = { up: 0, right: Math.PI / 2, down: Math.PI, left: -Math.PI / 2 }[info.arrow] || 0, s = ch * 0.13;
      x.translate(cw / 2, ch / 2); x.rotate(a); x.beginPath(); x.moveTo(0, -s); x.lineTo(s * 0.95, s * 0.7); x.lineTo(-s * 0.95, s * 0.7); x.closePath(); x.fill();
    } else if (info.top && info.main) {
      fit(info.top, ch * 0.25, cw * 0.8, 400); x.fillText(info.top, cw / 2, ch * 0.33);
      fit(info.main, ch * 0.27, cw * 0.8, 400); x.fillText(info.main, cw / 2, ch * 0.67);
    } else if (info.main) {
      if (info.big) x.font = F(ch * 0.4, 400); else fit(info.main, ch * 0.19, cw * 0.86, 500);
      if (info.dim) x.globalAlpha = 0.4;
      x.fillText(info.main, cw / 2, ch * 0.52);
    } else return null;
    const t = ctex(c); t.anisotropy = 4; return t;
  }
  // «горячее пятно» от светодиода (с севера), ширина пятна всегда ~1u
  function hotTex(w) {
    if (hotCache[w]) return hotCache[w];
    const ch = 48, c = canvas((48 * (w - 0.055)) / 0.945, ch), cw = c.width, x = c.getContext('2d'), b = Math.round(255 * 0.45);
    x.fillStyle = `rgb(${b},${b},${b})`; x.fillRect(0, 0, cw, ch);
    const g = x.createRadialGradient(cw / 2, ch * 0.28, 0, cw / 2, ch * 0.28, ch * 0.9);
    g.addColorStop(0, '#fff'); g.addColorStop(0.4, 'rgb(190,190,190)'); g.addColorStop(1, `rgb(${b},${b},${b})`);
    x.fillStyle = g; x.fillRect(0, 0, cw, ch);
    return (hotCache[w] = ctex(c, true));
  }
  // холсты свечения: пластина, стенки корпуса, стол — из одной «карты света» клавиш
  function makeGlow() {
    for (const t of [gl.deskTex, gl.caseTex, gl.plateTex, gl.shadowTex]) if (t) t.dispose();
    const S = 12, { W, D, CW, CD } = dims, DW = CW + 8, DD = CD + 7, PW = W + 0.56, PD = D + 0.56;
    gl = { S, DW, DD, PW, PD, painted: false };
    gl.base = canvas(DW * S, DD * S);
    gl.desk = canvas(DW * 6, DD * 6);
    gl.case = canvas(CW * S, CD * S);
    gl.plate = canvas(PW * 16, PD * 16);
    gl.deskTex = ctex(gl.desk); gl.caseTex = ctex(gl.case); gl.plateTex = ctex(gl.plate);
    // мягкая тень под корпусом
    const SS = 16, sw = CW + 2.6, sd = CD + 2.6, sc = canvas(sw * SS, sd * SS), sx = sc.getContext('2d');
    sx.filter = `blur(${Math.round(0.5 * SS)}px)`; sx.fillStyle = 'rgba(0,0,0,0.85)'; sx.fillRect(1.4 * SS, 1.45 * SS, (CW - 0.2) * SS, (CD - 0.2) * SS);
    sx.filter = `blur(${Math.round(0.1 * SS)}px)`; sx.fillStyle = 'rgba(0,0,0,0.55)'; sx.fillRect(1.33 * SS, 1.33 * SS, (CW - 0.06) * SS, (CD - 0.06) * SS);
    gl.shadowTex = ctex(sc);
    for (const c of [gl.base, gl.desk, gl.case, gl.plate]) { const x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height); }
  }
  function paintGlow() {
    const { S, DW, DD, PW, PD } = gl, KZ = dims.KZ, b = gl.base.getContext('2d');
    b.filter = 'none'; b.globalCompositeOperation = 'source-over'; b.fillStyle = '#000'; b.fillRect(0, 0, gl.base.width, gl.base.height);
    for (const k of keys) {
      const [r, g, bl] = k.c; if (r + g + bl < 0.004) continue;
      b.fillStyle = `rgb(${(r * 255) | 0},${(g * 255) | 0},${(bl * 255) | 0})`;
      b.fillRect((k.x - k.w / 2 + 0.06 + DW / 2) * S, (k.z - 0.47 + DD / 2) * S, (k.w - 0.12) * S, 0.86 * S);
    }
    const blit = (dst, blur, sx, sy, sw, sh, gain) => {
      const c = dst.getContext('2d');
      c.filter = 'none'; c.globalCompositeOperation = 'source-over'; c.fillStyle = '#000'; c.fillRect(0, 0, dst.width, dst.height);
      c.filter = `blur(${blur}px)`; c.globalCompositeOperation = 'lighter';
      for (let i = 0; i < gain; i++) c.drawImage(gl.base, sx, sy, sw, sh, 0, 0, dst.width, dst.height);
      c.filter = 'none'; c.globalCompositeOperation = 'source-over';
    };
    blit(gl.desk, 9, 0, 0, gl.base.width, gl.base.height, 1);
    blit(gl.case, 10, (DW / 2 - dims.CW / 2) * S, (DD / 2 - dims.CD / 2) * S, dims.CW * S, dims.CD * S, 2);
    blit(gl.plate, 6, (DW / 2 - PW / 2) * S, (DD / 2 + KZ - PD / 2) * S, PW * S, PD * S, 1);
    gl.deskTex.needsUpdate = gl.caseTex.needsUpdate = gl.plateTex.needsUpdate = true;
  }
  function fallbackEnv(pm) {
    const es = new T.Scene();
    es.background = new T.Color(0x18191d);
    const add = (w, h, c, p) => { const m = new T.Mesh(new T.PlaneGeometry(w, h), new T.MeshBasicMaterial({ color: c, side: T.DoubleSide })); m.position.set(...p); m.lookAt(0, 0, 0); es.add(m); };
    add(14, 5, 0xffffff, [0, 12, 4]); add(6, 10, 0x8899bb, [-14, 4, -2]); add(6, 10, 0xbbaa99, [14, 4, 2]);
    return pm.fromScene(es, 0.04).texture;
  }
  // instanced-детали: цвет экземпляра идёт в свечение, а не в основной цвет
  function instEmissive(m, tag) {
    m.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <color_fragment>', '')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n#ifdef USE_COLOR\n\ttotalEmissiveRadiance *= vColor;\n#endif');
    };
    m.customProgramCacheKey = () => 'q75-inst-' + tag;
    return m;
  }

  // Каждый светодиод — маленькая точечная «лампа». Сотня настоящих источников three.js слишком медленная,
  // поэтому свет считаем прямо в шейдере кейкапа и только от ближайших светодиодов (свой + до 11 соседей):
  // короткий радиус, мягкое затухание, «обёрнутый» косинус. Свой светодиод светит изнутри (рассеяние в пластике),
  // соседние подсвечивают обращённые к ним стенки. Пластина, корпус и стол получают свет через размытые карты свечения.
  const KB_M = 12;
  const LED_PARS = ['#define KB_M ' + KB_M, 'varying vec3 vKbW;', 'uniform vec4 kbNP[ KB_M ];', 'uniform vec4 kbNC[ KB_M ];', 'uniform vec4 kbK1;', 'uniform vec4 kbK2;', 'uniform float kbSelfOn;', 'uniform float kbScat;'].join('\n');
  const LED_FRAG = [
    '{',
    '\tvec3 kbN = normalize( ( vec4( normal, 0.0 ) * viewMatrix ).xyz );',
    '\tvec3 kbNb = vec3( 0.0 ), kbOwn = vec3( 0.0 );',
    '\tfloat kbR2 = kbK2.y * kbK2.y;',
    '\tfor ( int kbI = 0; kbI < KB_M; kbI ++ ) {',
    '\t\tvec4 kbC = kbNC[ kbI ];',
    '\t\tif ( kbC.a <= 0.0 ) continue;',
    '\t\tvec4 kbP = kbNP[ kbI ];',
    '\t\tvec3 kbD = kbP.xyz - vKbW;',
    '\t\tvec3 kbS = vec3( kbD.x / kbP.w, kbD.y, kbD.z );',
    '\t\tfloat kbQ = dot( kbS, kbS );',
    '\t\tif ( kbI == 0 && kbSelfOn > 0.5 ) { kbOwn = kbC.rgb / ( 1.0 + kbQ * kbK1.y ); continue; }',
    '\t\tif ( kbQ >= kbR2 ) continue;',
    '\t\tfloat kbW = 1.0 - kbQ / kbR2;',
    '\t\tfloat kbL = dot( kbN, kbD ) * inversesqrt( dot( kbD, kbD ) + 1e-4 );',
    '\t\tkbNb += kbC.rgb * ( kbW * kbW / ( 1.0 + kbQ * kbK1.w ) ) * mix( saturate( ( kbL + kbK2.x ) / ( 1.0 + kbK2.x ) ), 1.0, kbK2.z * kbScat );',
    '\t}',
    '\tvec3 kbNbL = kbNb * ( kbK1.z * kbScat ); float kbNbM = max( max( kbNbL.r, kbNbL.g ), kbNbL.b ); if ( kbNbM > 0.6 ) kbNbL *= ( 0.6 + ( kbNbM - 0.6 ) * 0.3 ) / kbNbM; totalEmissiveRadiance += kbNbL + kbOwn * kbK1.x;',
    '}'].join('\n');
  // k — клавиша материала: по ней в build() выбираются ближайшие светодиоды; self — есть ли свой светодиод под ним
  function ledLight(m, k, self, scat) {
    const u = { kbNP: { value: new Float32Array(4 * KB_M) }, kbNC: { value: new Float32Array(4 * KB_M) }, kbSelfOn: { value: self ? 1 : 0 }, kbScat: { value: scat } };
    m.userData.led = { k, self: !!self, u, list: [] };
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u, { kbK1: LEDU.k1, kbK2: LEDU.k2 });
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vKbW;')
        .replace('#include <project_vertex>', '#include <project_vertex>\n\tvec4 kbW = vec4( transformed, 1.0 );\n#ifdef USE_INSTANCING\n\tkbW = instanceMatrix * kbW;\n#endif\n\tvKbW = ( modelMatrix * kbW ).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + LED_PARS)
        .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + LED_FRAG);
    };
    m.customProgramCacheKey = () => 'kbled-5';
    ledMats.push(m);
    return m;
  }

  /* ---------- сборка ---------- */
  function readLegend(el) {
    const top = el.querySelector('.cap-top'), main = el.querySelector('.cap-main'), arr = el.querySelector('.cap-arrow');
    if (arr) return { arrow: ['up', 'down', 'left', 'right'].find((d) => arr.classList.contains(d)) };
    return { top: top ? top.textContent : '', main: main ? main.textContent : '', big: !!(main && main.classList.contains('big')), dim: !!(main && main.classList.contains('dim')) };
  }
  function clearRoot() {
    if (!root) return;
    root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { if (m.map && !m.userData.sharedMap) m.map.dispose(); m.dispose(); });
    });
    scene.remove(root);
    for (const k in capCache) delete capCache[k];
    inst = {};
  }
  function build(els) {
    clearRoot();
    builtFor = els;
    keys = []; pickables = []; envMats = []; ledMats = [];
    let W = 0, rows = 0;
    for (const e of els) { W = Math.max(W, e._x + e._k.w / 2); rows = Math.max(rows, e._y + 1); }
    const D = rows + (rows > 1 ? GAP_F : 0), CW = W + 2 * BZ.side, CD = D + BZ.top + BZ.bot;
    const HC = HF + (CD / 2) * TAN, KZ = (BZ.top - BZ.bot) / 2;
    dims = { W, D, CW, CD, HC, KZ };
    const zOf = (r) => r + (r > 0 ? GAP_F : 0) + 0.5 - D / 2 + KZ, xOf = (x) => x - W / 2;
    makeGlow();
    root = new T.Group(); root.position.y = 0.04; scene.add(root);
    deck = new T.Group(); deck.position.y = HC; deck.rotation.x = TILT; root.add(deck);

    const env = (m, k) => { m.userData.env = k; m.envMapIntensity = k * adapt; envMats.push(m); return m; };
    // аддитивное свечение только в RGB: альфа холста не меняется, корпус остаётся прозрачным
    const addBlend = (m) => { m.blending = T.CustomBlending; m.blendEquation = T.AddEquation; m.blendSrc = T.SrcAlphaFactor; m.blendDst = T.OneFactor; m.blendSrcAlpha = T.ZeroFactor; m.blendDstAlpha = T.OneFactor; return m; };
    const caseMat = env(new T.MeshPhysicalMaterial({ color: 0xf2f6ff, roughness: 0.035, metalness: 0, transparent: true, opacity: 0.16, clearcoat: 1, clearcoatRoughness: 0.02, ior: 1.58, specularIntensity: 1, side: T.DoubleSide, depthWrite: false }), 1.2);
    const edgeMat = new T.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16, depthWrite: false });
    const glowMat = addBlend(new T.MeshBasicMaterial({ map: gl.caseTex, transparent: true, depthWrite: false, side: T.DoubleSide, opacity: 0.8 }));
    glowMat.userData.sharedMap = true;
    const plateMat = env(new T.MeshStandardMaterial({ color: 0xf1f3f6, roughness: 0.78, metalness: 0, emissive: 0xffffff, emissiveIntensity: PLATE_I, emissiveMap: gl.plateTex }), 0.28);
    const whiteMat = env(new T.MeshStandardMaterial({ color: 0xe6e9ee, roughness: 0.72 }), 0.28);
    const pcbMat = env(new T.MeshStandardMaterial({ color: 0x0d0f13, roughness: 0.42, metalness: 0.15 }), 0.5);
    const footMat = env(new T.MeshStandardMaterial({ color: 0x1b1c1f, roughness: 0.9 }), 0.3);
    const housMat = env(instEmissive(new T.MeshStandardMaterial({ color: 0xcfd5de, roughness: 0.16, metalness: 0, emissive: 0xffffff, emissiveIntensity: 1, flatShading: true }), 'h'), 0.4);
    const stemMat = env(instEmissive(new T.MeshStandardMaterial({ color: 0xe1e6ec, roughness: 0.2, metalness: 0, emissive: 0xffffff, emissiveIntensity: 1 }), 's'), 0.4);
    const ledMat = new T.MeshBasicMaterial({ color: 0xffffff });
    const stabMat = env(new T.MeshStandardMaterial({ color: 0xd5dbe3, roughness: 0.2 }), 0.4);
    const wireMat = env(new T.MeshStandardMaterial({ color: 0xc9ced6, roughness: 0.25, metalness: 0.9 }), 1);

    // корпус: верхняя рамка (в системе наклонённой «деки») + нижняя крышка-клин
    const bs = 0.035;
    const sh = toPath(T.Shape, ring(CW - 2 * bs, CD - 2 * bs, 0.2, 7), 0);
    sh.holes.push(toPath(T.Path, ring(W + 0.16 + 2 * bs, D + 0.16 + 2 * bs, 0.07), KZ));
    const topG = extrude(sh, TOPH, bs); topG.translate(0, -(TOPH + bs), 0); planarUV(topG, CW, CD);
    const topCase = new T.Mesh(topG, caseMat); topCase.renderOrder = 5; deck.add(topCase);
    const topGlow = new T.Mesh(topG, glowMat); topGlow.renderOrder = 6; deck.add(topGlow);
    deck.add(new T.LineSegments(new T.EdgesGeometry(topG, 30), edgeMat));
    const seam = (z) => HC - (TOPH + 2 * bs) / Math.cos(TILT) - z * TAN;
    const botG = extrude(toPath(T.Shape, ring(CW - 0.05 - 2 * bs, CD - 0.05 - 2 * bs, 0.19, 7), 0), 1, bs);
    const bp = botG.attributes.position;
    for (let i = 0; i < bp.count; i++) bp.setY(i, ((bp.getY(i) + bs) / (1 + 2 * bs)) * seam(bp.getZ(i)));
    botG.computeVertexNormals(); planarUV(botG, CW, CD);
    const botCase = new T.Mesh(botG, caseMat); botCase.renderOrder = 5; root.add(botCase);
    const botGlow = new T.Mesh(botG, glowMat); botGlow.renderOrder = 6; root.add(botGlow);
    root.add(new T.LineSegments(new T.EdgesGeometry(botG, 30), edgeMat));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) { const f = new T.Mesh(new T.CylinderGeometry(0.17, 0.17, 0.04, 20), footMat); f.position.set(sx * (CW / 2 - 0.75), -0.02, sz * (CD / 2 - 0.55)); root.add(f); }

    // стол: тень + отсвет подсветки
    const shadow = new T.Mesh(new T.PlaneGeometry(CW + 2.6, CD + 2.6), new T.MeshBasicMaterial({ color: 0x000000, map: gl.shadowTex, transparent: true, opacity: 0.85, depthWrite: false }));
    shadow.material.userData.sharedMap = true; shadow.rotation.x = -Math.PI / 2; shadow.position.y = -0.039; shadow.renderOrder = -2; root.add(shadow);
    const under = new T.Mesh(new T.PlaneGeometry(gl.DW, gl.DD), addBlend(new T.MeshBasicMaterial({ map: gl.deskTex, transparent: true, depthWrite: false, opacity: 0.75 })));
    under.material.userData.sharedMap = true; under.rotation.x = -Math.PI / 2; under.position.y = -0.037; under.renderOrder = -1; root.add(under);
    shadow.userData.op = 0.85; under.userData.op = 0.75; deskParts = [shadow, under];

    // пластина, прослойка, плата, нижний демпфер
    const { PW, PD } = gl;
    const plateTop = new T.Mesh(new T.PlaneGeometry(PW, PD), plateMat); plateTop.rotation.x = -Math.PI / 2; plateTop.position.set(0, PY, KZ); deck.add(plateTop);
    const plate = new T.Mesh(new T.BoxGeometry(PW, 0.07, PD), whiteMat); plate.position.set(0, PY - 0.04, KZ); deck.add(plate);
    const pad = new T.Mesh(new T.BoxGeometry(W + 0.4, 0.13, D + 0.4), whiteMat); pad.position.set(0, PY - 0.17, KZ); deck.add(pad);
    const pcb = new T.Mesh(new T.BoxGeometry(W + 0.36, 0.085, D + 0.36), pcbMat); pcb.position.set(0, PY - 0.28, KZ); deck.add(pcb);
    const foam = new T.Mesh(new T.BoxGeometry(W + 0.3, 0.16, D + 0.3), whiteMat); foam.position.set(0, PY - 0.42, KZ); deck.add(foam);
    // гаскет-лапки пластины (видны сквозь рамку на фото сверху)
    const tabG = new T.BoxGeometry(0.5, 0.05, 0.26), gasG = new T.BoxGeometry(0.42, 0.05, 0.17);
    const gasMat = env(new T.MeshStandardMaterial({ color: 0xdfe3e8, roughness: 0.9 }), 0.6);
    const addTab = (x, z) => { const t = new T.Mesh(tabG, whiteMat); t.position.set(x, PY - 0.03, z); deck.add(t); const g = new T.Mesh(gasG, gasMat); g.position.set(x, PY + 0.02, z); deck.add(g); };
    const r0 = els.filter((e) => e._y === 0).sort((a, b) => a._x - b._x), gaps = [];
    for (let i = 0; i + 1 < r0.length; i++) { const a = r0[i]._x + r0[i]._k.w / 2, b = r0[i + 1]._x - r0[i + 1]._k.w / 2; if (b - a > 0.15) gaps.push((a + b) / 2); }
    (gaps.length ? gaps : [W * 0.1, W * 0.37, W * 0.65, W * 0.93]).forEach((gx) => addTab(xOf(gx), KZ - PD / 2 - 0.08));
    [0.14, 0.46, 0.77].forEach((f) => addTab(xOf(W * f), KZ + PD / 2 + 0.08));

    // клавиши
    const sw = [], stab = [];
    els.forEach((e) => {
      const w = e._k.w, x = xOf(e._x), z = zOf(e._y), row = Math.min(5, e._y);
      const k = { el: e, x, z, w, c: [-1, -1, -1], si: -1, knob: !!e._k.knob };
      if (k.knob) {
        const m = ledLight(env(new T.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 1, roughness: 0.3 }), 0.7), k, false, 0.3);
        const kn = new T.Mesh(new T.CylinderGeometry(0.42, 0.44, 0.5, 40), m); kn.position.set(x, 0.2, z); kn.userData.el = e; deck.add(kn); pickables.push(kn);
        k.capMat = m;
      } else {
        const ci = capInfo(w, row);
        const mat = ledLight(env(new T.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.16, metalness: 0, transmission: 1, thickness: 0.45, ior: 1.5, specularIntensity: 0.7, emissive: 0x000000, emissiveIntensity: 1, emissiveMap: hotTex(w) }), 0.3), k, true, 1);
        const cap = new T.Mesh(ci.geo, mat); cap.position.set(x, CAPY, z); cap.userData.el = e; deck.add(cap); pickables.push(cap);
        const tex = legendTex(readLegend(e), ci.lw, ci.ld);
        if (tex) {
          const lm = new T.Mesh(ci.lgeo, new T.MeshBasicMaterial({ color: 0x101216, map: tex, transparent: true, opacity: 0.95, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
          lm.position.copy(cap.position); lm.renderOrder = 2; deck.add(lm);
        }
        k.capMat = mat; k.si = sw.length; sw.push(k);
        if (w >= 2) stab.push(k);
      }
      keys.push(k);
    });

    // свитчи (прозрачные), штоки, окно светодиода — instanced
    const n = sw.length;
    if (n) {
      const hTop = new T.CylinderGeometry(0.335, 0.39, 0.27, 4, 1); hTop.rotateY(Math.PI / 4); hTop.translate(0, PY + 0.135, 0);
      const housG = merge([hTop, boxAt(0.56, 0.17, 0.56, 0, PY - 0.155, 0)]);
      const stemG = merge([boxAt(0.15, 0.17, 0.045, 0, PY + 0.355, 0), boxAt(0.045, 0.17, 0.15, 0, PY + 0.355, 0), cylAt(0.115, 0.3, 0, CAPY + 0.02 + 0.15, 0)]);
      const ledG = boxAt(0.2, 0.07, 0.03, 0, PY + 0.19, -0.25);
      inst.hous = new T.InstancedMesh(housG, housMat, n); inst.stem = new T.InstancedMesh(stemG, stemMat, n); inst.led = new T.InstancedMesh(ledG, ledMat, n);
      const m4 = new T.Matrix4(), black = new T.Color(0, 0, 0), grey = new T.Color(LED_BASE, LED_BASE, LED_BASE);
      sw.forEach((k, i) => {
        m4.makeTranslation(k.x, 0, k.z);
        for (const m of [inst.hous, inst.stem, inst.led]) m.setMatrixAt(i, m4);
        inst.hous.setColorAt(i, black); inst.stem.setColorAt(i, black); inst.led.setColorAt(i, grey);
      });
      for (const m of [inst.hous, inst.stem, inst.led]) { m.instanceMatrix.needsUpdate = true; m.instanceColor.needsUpdate = true; m.frustumCulled = false; deck.add(m); }
    }
    // стабилизаторы: прозрачные корпуса + проволока
    if (stab.length) {
      const pts = [], wires = [];
      stab.forEach((k) => { const off = k.w >= 6 ? 2.62 : 0.6; pts.push([k.x - off, k.z], [k.x + off, k.z]); wires.push([k.x, k.z, off]); });
      const sG = boxAt(0.24, 0.24, 0.44, 0, PY + 0.12, 0.02), wG = new T.CylinderGeometry(0.014, 0.014, 1, 6); wG.rotateZ(Math.PI / 2);
      const sm = new T.InstancedMesh(sG, stabMat, pts.length), wm = new T.InstancedMesh(wG, wireMat, wires.length);
      const m4 = new T.Matrix4(), q = new T.Quaternion(), s = new T.Vector3(), p = new T.Vector3();
      pts.forEach(([x, z], i) => { m4.makeTranslation(x, 0, z); sm.setMatrixAt(i, m4); });
      wires.forEach(([x, z, off], i) => { p.set(x, PY + 0.03, z - 0.24); s.set(2 * off, 1, 1); m4.compose(p, q, s); wm.setMatrixAt(i, m4); });
      sm.instanceMatrix.needsUpdate = true; wm.instanceMatrix.needsUpdate = true; sm.frustumCulled = false; wm.frustumCulled = false;
      deck.add(sm, wm);
    }
    // светодиоды — источники света: мировые координаты (дека наклонена); каждому кейкапу — свой и ближайшие соседи
    root.updateMatrixWorld(true);
    ledP = new Float32Array(4 * Math.max(1, n)); ledC = new Float32Array(4 * Math.max(1, n));
    const v3 = new T.Vector3(), RNG = LEDU.k2.value.y + 0.3;
    sw.forEach((k, i) => { v3.set(k.x, LED_Y, k.z + LED_DZ); deck.localToWorld(v3); ledP.set([v3.x, v3.y, v3.z, Math.max(1, (k.w - 0.4) / 1.2)], i * 4); });
    for (const m of ledMats) {
      const L = m.userData.led, a = L.k, P = L.u.kbNP.value, cand = [];
      sw.forEach((b, i) => {
        if (L.self && b === a) return;
        const dx = Math.max(0, Math.abs(b.x - a.x) - a.w / 2) / Math.max(1, (b.w - 0.4) / 1.2), dz = Math.max(0, Math.abs(b.z + LED_DZ - a.z) - 0.5);
        const d = Math.hypot(dx, dz); if (d < RNG) cand.push([d, i]);
      });
      cand.sort((p, q) => p[0] - q[0]);
      L.list = (L.self && a.si >= 0 ? [a.si] : []).concat(cand.map((c) => c[1])).slice(0, KB_M);
      P.fill(0); L.list.forEach((i, j) => P.set(ledP.subarray(i * 4, i * 4 + 4), j * 4));
    }
    adaptMode = '';
    if (mode === 'top') resize();
    paintGlow();
    dirty = true;
  }

  /* ---------- камера, ввод, отрисовка ---------- */
  // «Плоский» вид: та же 3D-модель, ортографическая камера перпендикулярно наклонённой деке — раскладка без искажений
  function placeTop() {
    if (!deck) return;
    const w = host.clientWidth || 800, h = host.clientHeight || 400, asp = w / h;
    let hw = (dims.CW + 1.2) / 2, hh = (dims.CD + 1.2) / 2;
    if (hw / hh > asp) hh = hw / asp; else hw = hh * asp;
    ocam.left = -hw; ocam.right = hw; ocam.top = hh; ocam.bottom = -hh;
    const c = deck.localToWorld(new T.Vector3(0, 0.2, 0)), s = Math.sin(TILT), co = Math.cos(TILT);
    ocam.up.set(0, s, -co);
    ocam.position.set(c.x, c.y + co * 40, c.z + s * 40);
    ocam.lookAt(c);
    ocam.updateProjectionMatrix();
    for (const m of deskParts) { m.visible = true; m.material.opacity = m.userData.op; }
  }
  function place() {
    if (mode === 'top') return placeTop();
    const w = host.clientWidth || 800, h = host.clientHeight || 400;
    cam.aspect = w / h;
    const half = (dims.CW + 1.4) / 2, hf = Math.tan((cam.fov * Math.PI) / 360);
    const d = (Math.max(half / (hf * cam.aspect), (dims.CD + 3.2) / 2 / hf) * 1.1) / zoom;
    const ty = 0.95, tz = 0.3;
    cam.position.set(Math.sin(az) * Math.cos(el) * d, Math.sin(el) * d + ty, Math.cos(az) * Math.cos(el) * d + tz);
    cam.lookAt(0, ty, tz);
    cam.updateProjectionMatrix();
    // снизу стола нет: тень и отсвет на столе плавно исчезают, когда камера опускается ниже его уровня
    const f = Math.max(0, Math.min(1, el / 0.14));
    for (const m of deskParts) { m.visible = f > 0.01; m.material.opacity = m.userData.op * f; }
  }
  function resize() {
    if (!host) return;
    if (asleep) return;
    const w = host.clientWidth; if (!w) return;
    const h = mode === 'top' ? Math.round(Math.max(240, Math.min((w * (dims.CD + 1.2)) / (dims.CW + 1.2), window.innerHeight * 0.7)))
      : Math.round(Math.max(300, Math.min(w * 0.5, window.innerHeight * 0.6)));
    host.style.height = h + 'px';
    R.setSize(w, h, false);
    if (composer) { composer.setPixelRatio(R.getPixelRatio()); composer.setSize(w, h); }
    dirty = true;
  }
  function pick(ev) {
    const r = cv.getBoundingClientRect();
    ptr.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ptr, mode === 'top' ? ocam : cam);
    const hit = ray.intersectObjects(pickables, false)[0];
    return hit ? hit.object.userData.el : null;
  }
  function bind() {
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('pointerdown', (e) => {
      const paint = hooks.canPaint && hooks.canPaint() && e.button === 0 && !e.shiftKey;
      if (paint) { const k = pick(e); if (k) { drag = { paint: true }; hooks.paint(k, 'down'); cv.setPointerCapture(e.pointerId); return; } }
      if (mode === 'top') return; // вид сверху не вращается
      drag = { x: e.clientX, y: e.clientY, az, el }; vaz = vel = 0; cv.setPointerCapture(e.pointerId); cv.classList.add('grab');
    });
    cv.addEventListener('pointermove', (e) => {
      if (!drag) { cv.style.cursor = hooks.canPaint && hooks.canPaint() && pick(e) ? 'crosshair' : ''; return; }
      if (drag.paint) { const k = pick(e); if (k) hooks.paint(k, 'move'); return; }
      const naz = drag.az - (e.clientX - drag.x) * 0.006;
      const nel = Math.max(-EL_MAX, Math.min(EL_MAX, drag.el + (e.clientY - drag.y) * 0.005));
      vaz = naz - az; vel = nel - el; az = naz; el = nel; dirty = true;
    });
    const end = (e) => { if (drag && !drag.paint) cv.classList.remove('grab'); drag = null; try { cv.releasePointerCapture(e.pointerId); } catch (x) {} };
    cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
    cv.addEventListener('wheel', (e) => { if (mode === 'top') return; e.preventDefault(); zoom = Math.max(0.75, Math.min(4, zoom * Math.exp(-e.deltaY * 0.0012))); dirty = true; }, { passive: false });
    cv.addEventListener('dblclick', () => { if (mode === 'top') return; az = VIEW.az; el = VIEW.el; zoom = VIEW.zoom; vaz = vel = 0; dirty = true; });
    if (window.ResizeObserver) new ResizeObserver(resize).observe(host); else window.addEventListener('resize', resize);
  }
  // «экспозиция камеры», как на видео: с подсветкой комната тёмная и светятся только клавиши, без неё — обычный свет.
  // Пик держится 1–2 с, чтобы «музыка» и «дыхание» не мигали светом комнаты.
  function adaptStep(now) {
    const dt = litT ? Math.min(0.25, Math.max(0, (now - litT) / 1000)) : 0; litT = now;
    litHold = Math.max(litNow, litHold * Math.exp(-dt / 0.9));
    peakHold = Math.max(litPeak, peakHold * Math.exp(-dt / 2.5));
    // даже несколько ярких клавиш приглушают комнату: свет «ламп» на соседних кейкапах заметен только в полутьме
    const L = Math.min(1, Math.max(litHold / 0.15, 0.62 * peakHold)), target = 1 - 0.86 * L * L * (3 - 2 * L);
    // экспозиция меняется плавно (~0.3 с), как у камеры, — без вспышек света комнаты на каждое нажатие
    let na = dt > 0 ? adapt + (target - adapt) * (1 - Math.exp(-dt / 0.3)) : adapt;
    if (Math.abs(target - na) < 0.004) na = target;
    const w = litWhite; // 0 — чистые цвета, 1 — белый
    if (na === adapt && Math.abs(w - bloomW) < 0.02 && adaptMode === mode) return;
    adapt = na; bloomW = w; adaptMode = mode;
    const lit = (1 - adapt) / 0.86, top = mode === 'top';
    const ek = top ? ENV_TOP : 1, lk = top ? TOP_LIGHT : 1;
    for (const m of envMats) m.envMapIntensity = m.userData.env * adapt * ek;
    lights.key.intensity = 1.1 * adapt * lk; lights.hemi.intensity = 0.35 * adapt * (top ? 1.6 : 1); lights.rim.intensity = 0.5 * adapt;
    // много света, особенно белого, — камера «прикрывает диафрагму», и клавиши не сливаются в одно белое пятно
    R.toneMappingExposure = 1 - 0.15 * lit - 0.3 * lit * w;
    // белый свет втрое ярче чистого цвета — ореол для него слабее и уже; сверху ореол мягче, чтобы читались подписи
    if (bloom) {
      const bk = top ? 0.65 : 1;
      bloom.threshold = 0.95 - 0.33 * lit + 0.2 * lit * w + (top ? 0.12 : 0);
      bloom.strength = (0.22 + 0.2 * lit) * (1 - 0.45 * lit * w) * bk;
      bloom.radius = 0; // форму ореола задают веса уровней (bloomFactors)
    }
    dirty = true;
  }
  function render() {
    if (rpass) rpass.camera = mode === 'top' ? ocam : cam;
    if (composer) {
      try { composer.render(); return; } catch (e) { console.warn('KB3D: bloom off', e); composer = null; }
    }
    R.render(scene, mode === 'top' ? ocam : cam);
  }
  // Окно свёрнуто или 3D не на экране дольше 3 с — отдаём видеопамять: холст и буферы кадра сжимаются до 1×1
  // (вместе с ними и буфер преломления three.js). При показе resize() возвращает размеры, буферы создаются заново.
  let asleep = false, hiddenSince = 0;
  const seen = () => st.on && !document.hidden && !!host.offsetParent && window.innerWidth > 0 && window.innerHeight > 0;
  function freeGpu() {
    asleep = true;
    R.setSize(1, 1, false);
    if (composer) composer.setSize(1, 1);
    try { render(); } catch (e) {}
  }
  function wake() { asleep = false; hiddenSince = 0; resize(); }
  // проверка по таймеру: в свёрнутом окне requestAnimationFrame не вызывается
  function watch() {
    if (!st.ok || asleep) return;
    if (seen()) { hiddenSince = 0; return; }
    const now = performance.now();
    if (!hiddenSince) hiddenSince = now; else if (now - hiddenSince > 3000) freeGpu();
  }
  function tick(now) {
    requestAnimationFrame(tick);
    if (!seen()) return;
    hiddenSince = 0;
    if (asleep) wake();
    if (!drag && (Math.abs(vaz) > 1e-4 || Math.abs(vel) > 1e-4)) {
      vaz *= 0.9; vel *= 0.9;
      az += vaz; el = Math.max(-EL_MAX, Math.min(EL_MAX, el + vel)); dirty = true;
    }
    adaptStep(now);
    if (!dirty || now - lastT < 15) return;
    lastT = now; dirty = false;
    place(); render();
  }
  function setupComposer() {
    if (!PP || !PP.EffectComposer) return;
    try {
      const sz = R.getDrawingBufferSize(new T.Vector2());
      const rt = new T.WebGLRenderTarget(Math.max(2, sz.x), Math.max(2, sz.y), { type: T.HalfFloatType, samples: R.capabilities.isWebGL2 ? 4 : 0 });
      composer = new PP.EffectComposer(R, rt);
      rpass = new PP.RenderPass(scene, cam); composer.addPass(rpass);
      bloom = new PP.UnrealBloomPass(new T.Vector2(512, 256), 0.3, 0.3, 0.95);
      // ореол только крупный, как блик в объективе: мелкий уровень размывал подписи и края кейкапов
      const bf = bloom.compositeMaterial && bloom.compositeMaterial.uniforms && bloom.compositeMaterial.uniforms.bloomFactors;
      if (bf) bf.value = [0.12, 0.35, 0.6, 0.5, 0.35];
      // порог по самому яркому каналу, а не по яркости: насыщенные синий и красный светятся наравне с белым
      const hp = bloom.materialHighPassFilter;
      if (hp && /float v = [^;]+;/.test(hp.fragmentShader)) { hp.fragmentShader = hp.fragmentShader.replace(/float v = [^;]+;/, 'float v = max( texel.r, max( texel.g, texel.b ) );'); hp.needsUpdate = true; }
      // свечение добавляем только в RGB: фон холста остаётся прозрачным, ореол ложится на фон приложения
      const bm = bloom.blendMaterial;
      bm.blending = T.CustomBlending; bm.blendEquation = T.AddEquation;
      bm.blendSrc = T.OneFactor; bm.blendDst = T.OneFactor; bm.blendSrcAlpha = T.ZeroFactor; bm.blendDstAlpha = T.OneFactor; bm.needsUpdate = true;
      composer.addPass(bloom);
      // кадр всегда собирается в одном буфере: без обмена буферами второй HDR-буфер с MSAA (~56 байт на пиксель) не создаётся.
      // А в three.min.js буфер преломления прозрачных кейкапов создаётся без MSAA (samples:0): после размытия по шероховатости разницы не видно
      const out = new PP.OutputPass(); out.needsSwap = false;
      composer.addPass(out);
    } catch (e) { console.warn('KB3D: no composer', e); composer = null; bloom = null; }
  }

  /* ---------- публичный API ---------- */
  function init(el, h) {
    host = el; hooks = h || {};
    if (!T) return false;
    try {
      cv = document.createElement('canvas'); cv.className = 'kb3d-canvas';
      // с постобработкой сглаживает её HDR-буфер (4× MSAA), а MSAA и трафарет самого холста только занимали видеопамять
      const pp = !!(PP && PP.EffectComposer);
      R = new T.WebGLRenderer({ canvas: cv, antialias: !pp, stencil: false, alpha: true, powerPreference: 'high-performance' });
    } catch (e) { return false; }
    if (!R.getContext()) return false;
    R.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
    // цвет подсветки не выцветает: ACES смешивает каналы (чистый зелёный становится салатовым),
    // поэтому яркий цветной свет сжимаем без смены оттенка, а белые и серые поверхности остаются как были
    const SC = T.ShaderChunk, TMK = 'tonemapping_pars_fragment', ACES = 'vec3 ACESFilmicToneMapping( vec3 color ) {';
    if (SC && SC[TMK] && SC[TMK].indexOf('kb3dHP') < 0 && SC[TMK].indexOf(ACES) >= 0) {
      SC[TMK] = SC[TMK].replace(ACES, 'vec3 ACESFilmicToneMappingOrig( vec3 color ) {') + [
        '', 'vec3 ACESFilmicToneMapping( vec3 color ) { // kb3dHP',
        '\tvec3 aces = ACESFilmicToneMappingOrig( color );',
        '\tvec3 c = max( color, vec3( 0.0 ) ) * ( toneMappingExposure / 0.6 );',
        '\tfloat m = max( max( c.r, c.g ), c.b );',
        '\tif ( m <= 0.00001 ) return aces;',
        '\tfloat s = ( m - min( min( c.r, c.g ), c.b ) ) / m;',
        '\tvec3 hp = c * ( saturate( RRTAndODTFit( vec3( m ) ).x ) / m );',
        '\treturn mix( aces, hp, s * s * ( 3.0 - 2.0 * s ) );', '}', ''].join('\n');
    }
    R.toneMapping = T.ACESFilmicToneMapping; R.toneMappingExposure = 1.0;
    R.setClearColor(0x000000, 0);
    host.append(cv);
    scene = new T.Scene();
    cam = new T.PerspectiveCamera(26, 2, 0.5, 200);
    ocam = new T.OrthographicCamera(-10, 10, 5, -5, 1, 100);
    const pm = new T.PMREMGenerator(R);
    try {
      if (PP && PP.RoomEnvironment) { const room = new PP.RoomEnvironment(); scene.environment = pm.fromScene(room, 0.04).texture; if (room.dispose) room.dispose(); }
      else scene.environment = fallbackEnv(pm);
    } catch (e) { scene.environment = fallbackEnv(pm); }
    pm.dispose();
    lights.hemi = new T.HemisphereLight(0xe6edff, 0x0c0c10, 0.35); scene.add(lights.hemi);
    lights.key = new T.DirectionalLight(0xffffff, 1.1); lights.key.position.set(-5, 12, 9); scene.add(lights.key);
    lights.rim = new T.DirectionalLight(0xbfd0ff, 0.5); lights.rim.position.set(8, 5, -10); scene.add(lights.rim);
    setupComposer();
    bind(); resize();
    st.ok = true; requestAnimationFrame(tick); setInterval(watch, 1000);
    return true;
  }
  const col = new (T ? T.Color : Object)(), tmp = new (T ? T.Color : Object)(), Z4 = [0, 0, 0, 0];
  // els — DOM-клавиши плоского предпросмотра (раскладка и подписи), cols — [r,g,b,a] на каждую
  function update(els, cols) {
    if (!st.ok) return;
    if (els !== builtFor) build(els);
    let changed = false, sum = 0, sumW = 0, pk = 0;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i], c = cols[i] || Z4, a = Math.max(0, Math.min(1, +c[3] || 0));
      const r = (c[0] / 255) * a, g = (c[1] / 255) * a, b = (c[2] / 255) * a;
      const mx = Math.max(r, g, b); sum += mx; sumW += Math.min(r, g, b); if (mx > pk) pk = mx;
      if (k.c[0] === r && k.c[1] === g && k.c[2] === b) continue;
      k.c[0] = r; k.c[1] = g; k.c[2] = b; changed = true;
      col.setRGB(r, g, b, T.SRGBColorSpace);
      if (k.knob) { k.capMat.emissive.copy(col).multiplyScalar(0.15); continue; }
      k.capMat.emissive.copy(col).multiplyScalar(CAP_I);
      inst.hous.setColorAt(k.si, tmp.copy(col).multiplyScalar(HOUS_I));
      inst.stem.setColorAt(k.si, tmp.copy(col).multiplyScalar(STEM_I));
      const base = LED_BASE * adapt * Math.max(0, 1 - Math.max(r, g, b) * 2);
      inst.led.setColorAt(k.si, tmp.copy(col).multiplyScalar(LED_I).addScalar(base));
      const o = k.si * 4;
      if (o + 3 < ledC.length) { ledC[o] = col.r; ledC[o + 1] = col.g; ledC[o + 2] = col.b; ledC[o + 3] = Math.max(col.r, col.g, col.b); }
    }
    if (changed || !gl.painted) {
      gl.painted = true;
      if (inst.hous) for (const m of [inst.hous, inst.stem, inst.led]) m.instanceColor.needsUpdate = true;
      for (const m of ledMats) { const L = m.userData.led, C = L.u.kbNC.value; L.list.forEach((i, j) => C.set(ledC.subarray(i * 4, i * 4 + 4), j * 4)); }
      paintGlow(); dirty = true;
    }
    litNow = sum / Math.max(1, keys.length); litWhite = sum > 0.01 ? sumW / sum : 0; litPeak = pk;
  }
  function setOn(v) { st.on = !!v && st.ok; dirty = true; if (st.on) resize(); }
  // 'orbit' — свободная камера, 'top' — «Плоский» вид: та же модель строго сверху
  function setMode(v) {
    const m = v === 'top' ? 'top' : 'orbit';
    if (m === mode) return;
    mode = m; vaz = vel = 0; drag = null;
    if (cv) { cv.classList.toggle('top', m === 'top'); cv.classList.remove('grab'); cv.style.cursor = ''; }
    if (st.ok) resize();
    dirty = true;
  }
  return { init, update, setOn, setMode, get mode() { return mode; }, get adapt() { return adapt; }, get ok() { return st.ok; }, get on() { return st.on; }, resetView() { az = VIEW.az; el = VIEW.el; zoom = VIEW.zoom; dirty = true; } };
})();
