/* FL Esports Studio 1.2 — интерфейс */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const h = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v; else if (k === 'style') e.style.cssText = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
    return e;
  };
  const hex = (b) => Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join(' ');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  $$('[data-icon]').forEach((el) => el.replaceWith(Object.assign(icon(el.dataset.icon), { id: el.id || '' })));

  /* ---------------- состояние ---------------- */
  const S = {
    driver: new IotDriver(), driverOk: false, driverVer: '',
    devices: [], showAll: false, cur: null, kb: null, demo: null,
    light: null, layer: 'base', iso: false,
    mx: { base: null, fn: null }, orig: { base: null, fn: null }, sel: null, knobPart: 'press',
    pickTab: 'keys', logOn: true, writeBlocked: false, keysBanner: '',
  };

  /* ---------------- уведомления, ожидание, диалоги ---------------- */
  function toast(msg, kind = 'info') {
    const t = h('div', { class: 'toast ' + kind, role: kind === 'bad' ? 'alert' : 'status' }, icon(kind === 'ok' ? 'check' : kind === 'bad' ? 'alert' : 'info'), h('span', {}, msg));
    $('#toasts').append(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 200); }, kind === 'bad' ? 6000 : 3500);
  }
  async function busy(text, fn) {
    $('#busyText').textContent = text; $('#busy').hidden = false;
    try { return await fn(); } catch (e) { log('err', String(e.message || e)); toast(String(e.message || e), 'bad'); return undefined; }
    finally { $('#busy').hidden = true; }
  }
  function confirmDlg(title, text, okText = 'OK', danger = false) {
    const d = $('#dlg');
    $('#dlgTitle').textContent = title; $('#dlgText').textContent = text;
    $('#dlgOk').textContent = okText; $('#dlgOk').className = 'btn ' + (danger ? 'danger' : 'primary');
    d.returnValue = '';
    d.showModal(); $('#dlgCancel').focus();
    return new Promise((res) => d.addEventListener('close', () => res(d.returnValue === 'ok'), { once: true }));
  }
  const logLines = [];
  function log(kind, data, extra) {
    if (!S.logOn && kind !== 'err') return;
    const t = new Date().toTimeString().slice(0, 8);
    let text = typeof data === 'string' ? data : hex(data.slice ? data.slice(0, 64) : data);
    if (kind === 'tx' && extra !== undefined) text += '   [checksum ' + ['BIT7', 'BIT8', 'NONE'][extra] + ']';
    logLines.push({ kind, line: `${t} ${kind.toUpperCase().padEnd(4)} ${text}` });
    if (logLines.length > 3000) logLines.splice(0, 500);
    if ($('#page-log').classList.contains('active')) renderLog();
  }
  function renderLog() {
    const el = $('#log'); el.innerHTML = '';
    for (const l of logLines.slice(-800)) el.append(h('div', { class: l.kind }, l.line));
    el.scrollTop = el.scrollHeight;
  }
  S.driver.log = log;

  /* ---------------- навигация ---------------- */
  const PAGE_NAMES = { light: 'Подсветка', keys: 'Клавиши', macros: 'Макросы', settings: 'Настройки', log: 'Журнал', help: 'Справка' };
  function showPage(name) {
    $('#eyebrow').textContent = PAGE_NAMES[name];
    closeEffects();
    $$('.rail button[data-page]').forEach((x) => { const on = x.dataset.page === name; x.classList.toggle('active', on); on ? x.setAttribute('aria-current', 'page') : x.removeAttribute('aria-current'); });
    $$('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + name));
    if (name === 'log') renderLog();
    if (name === 'keys') renderKeys();
    if (name === 'macros') openMacros();
    updateEmpty(); requestAnimationFrame(fitKeyboard);
  }
  $$('.rail button[data-page]').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.page)));

  /* ---------------- служба драйвера и устройства ---------------- */
  let stopWatch = null;
  async function connectDriver() {
    try {
      const v = await S.driver.getVersion();
      S.driverOk = true; S.driverVer = v.version || '?';
      $('#drvDot').className = 'dot ok'; $('#drvText').textContent = 'Служба ' + S.driverVer;
      if (!stopWatch) stopWatch = S.driver.watchDevices(onDevList, (err) => { stopWatch = null; if (err) log('err', 'watchDevList: ' + err.message); setTimeout(connectDriver, 1500); });
    } catch (e) {
      S.driverOk = false;
      $('#drvDot').className = 'dot bad'; $('#drvText').textContent = 'Служба не запущена';
      if (stopWatch) { stopWatch(); stopWatch = null; }
      setTimeout(connectDriver, 3000);
    }
    renderDevSel(); updateEmpty();
  }
  const devKey = (d) => d.path + '|' + d.kind;
  const devId = (d) => (d.kind === 'dangle' ? -d.keyboardId : d.id);
  const knownDev = (d) => !!MODELS[devId(d)];
  // Служба присылает дубли одного пути и иногда мусорный id (читает его, пока клавиатура занята) —
  // запись с известной моделью не затираем неизвестной.
  function mergeDev(list, d) {
    const i = list.findIndex((x) => devKey(x) === devKey(d));
    if (i < 0) list.push(d); else if (knownDev(d) || !knownDev(list[i])) list[i] = d;
  }
  const devWaiters = [];
  function flushWaiters(d) { devWaiters.splice(0).forEach((f) => f(d)); }
  function curPresent() { return S.cur && S.devices.find((d) => devKey(d) === devKey(S.cur) && knownDev(d)); }
  function waitDev(ms) {
    // Устройство в списке, но не отвечает — через секунду пробуем снова; пропало — ждём возврата до ms.
    return new Promise((res) => {
      if (!S.cur) { res(null); return; }
      let done = false, t1, t2;
      const f = (d) => { if (!done) { done = true; clearTimeout(t1); clearTimeout(t2); res(d); } };
      devWaiters.push(f);
      t1 = setTimeout(() => { const p = curPresent(); if (p && !S.lost) f(p); }, 1000);
      t2 = setTimeout(() => f(null), ms);
    });
  }
  function clearLost() { S.lost = false; clearTimeout(S.lostT); }
  function onDevList(ev) {
    if (ev.type === ListChange.INIT) { const l = []; for (const d of ev.list) mergeDev(l, d); S.devices = l; }
    else if (ev.type === ListChange.REMOVE) S.devices = S.devices.filter((d) => !ev.list.some((x) => devKey(x) === devKey(d)));
    else for (const d of ev.list) mergeDev(S.devices, d);
    log('info', 'Устройства: ' + S.devices.map((d) => `${d.kind} id=${devId(d)} vid=${d.vid} pid=${d.pid}`).join('; '));
    renderDevSel();
    if (S.cur && !S.demo) {
      const same = curPresent();
      if (same) { if (S.lost) { clearLost(); S.cur = same; renderDevSel(); updateDevStatus(); } flushWaiters(same); }
      else if (!S.lost) {
        // Не «отключена», а переподключается: после смены подсветки прошивка пропадает на ~15–20 с
        S.lost = true; renderDevSel(); updateDevStatus();
        S.lostT = setTimeout(() => { if (!S.lost) return; clearLost(); flushWaiters(null); selectDevice(null); toast('Клавиатура отключена'); }, 45000);
      }
    }
    if (!S.cur && !S.demo) { const first = q75List()[0]; if (first) selectDevice(first); }
  }
  function q75List() {
    return S.devices.filter((d) => (d.kind === 'dev' ? d.devtype === 0 : d.keyboardId) && MODELS[devId(d)] && MODEL_INFO[MODELS[devId(d)]].supported);
  }
  function renderDevSel() {
    const sel = $('#devSel'); sel.innerHTML = '';
    const items = [];
    const list = S.showAll ? S.devices.filter((d) => d.kind === 'dev' || d.keyboardId) : q75List();
    for (const d of list) {
      const m = MODELS[devId(d)], info = m ? MODEL_INFO[m] : null;
      const via = d.kind === 'dangle' ? ' — 2.4G' : d.is24 ? ' — беспроводное' : ' — USB';
      items.push({ v: 'dev:' + devKey(d), t: (info ? info.title + (info.supported ? '' : ' (не поддерживается)') : `Неизвестное, id ${devId(d)}, ${d.vid.toString(16)}:${d.pid.toString(16)}`) + via, d });
    }
    if (S.cur && S.lost && !S.demo && !items.some((it) => it.v === 'dev:' + devKey(S.cur))) {
      const info = MODEL_INFO[MODELS[devId(S.cur)]];
      items.unshift({ v: 'dev:' + devKey(S.cur), t: (info ? info.title : 'Клавиатура') + ' — переподключается…', d: S.cur });
    }
    if (!items.length) items.push({ v: '', t: S.driverOk ? 'Клавиатура не найдена' : 'Нет связи со службой' });
    items.push({ v: 'demo:std', t: 'Демо: Q75' }, { v: 'demo:knob', t: 'Демо: Q75 с крутилкой' }, { v: 'all', t: S.showAll ? 'Скрыть прочие HID-устройства' : 'Показать все HID-устройства' });
    for (const it of items) sel.append(h('option', { value: it.v }, it.t));
    sel.value = S.demo ? 'demo:' + S.demo : S.cur ? 'dev:' + devKey(S.cur) : items[0].v;
    sel._items = items;
  }
  $('#devSel').addEventListener('change', async (e) => {
    const v = e.target.value;
    if (v === 'all') { S.showAll = !S.showAll; renderDevSel(); return; }
    if (!(await guardUnsaved())) { renderDevSel(); return; }
    if (v.startsWith('demo:')) return selectDemo(v.slice(5));
    const it = e.target._items.find((x) => x.v === v);
    if (it && it.d) {
      const m = MODELS[devId(it.d)];
      if (!m || !MODEL_INFO[m].supported) { toast('Эта модель или ревизия пока не поддерживается. Пришлите журнал разработчику.', 'bad'); renderDevSel(); return; }
      selectDevice(it.d);
    }
  });
  async function guardUnsaved() {
    if (!changeCount()) return true;
    return confirmDlg('Есть незаписанные изменения', 'Изменения раскладки не записаны в клавиатуру и будут потеряны.', 'Продолжить без записи', true);
  }
  function selectDemo(model) {
    const sim = new SimDriver(model); sim.log = log;
    S.demo = model;
    const dev = { kind: 'dev', path: 'SIM#1', id: sim.id, is24: false, vid: 1452, pid: 591, devtype: 0 };
    attach(new Q75(sim, dev), dev);
    toast('Демо-режим: изменения не уходят в реальную клавиатуру');
  }
  function selectDevice(d) {
    S.demo = null; clearLost(); flushWaiters(null);
    if (!d) { S.cur = null; S.kb = null; updateDevStatus(); updateEmpty(); renderDevSel(); return; }
    attach(new Q75(S.driver, d), d);
  }
  async function attach(kb, dev) {
    if (!S.demo) kb.waitDevice = waitDev;
    stopRec(); S.macros = null; S.macroSel = null;
    UP.cache = {}; UP.undo = []; UP.loading = null;
    S.kb = kb; S.cur = dev; S.mx = { base: null, fn: null }; S.orig = { base: null, fn: null }; S.sel = null; S.writeBlocked = false;
    renderDevSel(); updateDevStatus(); updateEmpty();
    $('#kbLight').innerHTML = '';
    await busy('Чтение настроек клавиатуры…', async () => {
      kb.fw = await kb.getFirmwareVersion();
      S.light = (await kb.getLight()) || { type: 'LightAlwaysOn', brightness: 4, speed: 2, rgb: 0xffffff, rainbow: true };
      renderLight();
      await loadSettings();
      await loadMatrices();
    });
    updateDevStatus(); renderInfo(); requestAnimationFrame(fitKeyboard);
  }
  function updateDevStatus() {
    const st = $('#devStatus'); st.innerHTML = '';
    const nf = $('#navFoot'); nf.innerHTML = '';
    const d = S.cur;
    if (!d) { st.append(icon('plug', 16), h('span', {}, 'Нет устройства')); return; }
    const wireless = d.kind === 'dangle' || d.is24;
    const bat = d.kind === 'dangle' ? d.keyboard && d.keyboard.battery : d.is24 ? d.battery : 0;
    if (S.lost && !S.demo) st.append(h('span', { class: 'spinner', style: 'width:13px;height:13px' }), h('span', {}, 'Клавиатура сохраняет настройки…'));
    else st.append(icon(S.demo ? 'play' : wireless ? 'radio' : 'plug', 16), h('span', {}, S.demo ? 'Демо-режим' : wireless ? 'Беспроводное' : 'USB-кабель'));
    nf.append(h('div', { class: 'dc-cap' }, MODEL_INFO[S.kb.model].title),
      h('div', { class: 'dc-val' }, bat ? [h('span', {}, bat + '%'), icon('battery', 22)] : [h('span', {}, wireless ? '2.4G' : 'USB'), icon(wireless ? 'radio' : 'plug', 20)]),
      h('div', { class: 'dc-sub' }, S.kb.fw ? 'Прошивка ' + S.kb.fw.text : 'Прошивка не прочитана'));
  }
  function updateEmpty() {
    const active = $('.page.active');
    const need = active && ['page-light', 'page-keys', 'page-macros', 'page-settings'].includes(active.id);
    const show = !!(need && !S.kb);
    $('#noDev').hidden = !show;
    if (active) active.style.display = show ? 'none' : '';
    if (!show) return;
    const box = $('#noDev'); box.innerHTML = '';
    box.append(h('div', { class: 'empty-icon' }, icon(S.driverOk ? 'keyboard' : 'plug', 30)),
      h('h2', {}, S.driverOk ? 'Подключите клавиатуру Q75' : 'Служба драйвера не запущена'),
      h('p', {}, S.driverOk ? 'Подключите клавиатуру кабелем USB или вставьте 2.4G-приёмник — она появится автоматически.'
        : (HOSTED ? 'FL Esports Studio.exe не нашёл службу iot_driver.exe. Положите iot_driver.exe из оригинального драйвера рядом с FL Esports Studio.exe и перезапустите программу.' : 'Запустите FL Esports Studio.exe (или «Запустить FL Esports Studio.bat»): он запускает фоновую службу iot_driver.exe.')),
      h('button', { class: 'btn', onclick: () => selectDemo('std') }, icon('play', 16), 'Открыть демо-режим'));
  }

  /* ---------------- отрисовка клавиатуры ---------------- */
  function drawKeyboard(root, opts) {
    root.innerHTML = ''; root._model = S.kb.model; root._iso = S.iso;
    const U = parseFloat(root.style.getPropertyValue('--u')) || 52, G = 5;
    const keys = [], d = defaults();
    buildLayout(S.kb.model, S.iso).forEach((row, ri) => {
      const r = h('div', { class: 'r' + (ri === 0 ? ' f' : ''), role: 'row' });
      let x = 0;
      for (const k of row) {
        const w = k.w * U + (k.w - 1) * G;
        if (k.gap) { r.append(h('div', { class: 'key gap', style: `width:${w}px`, 'aria-hidden': 'true' })); x += k.w; continue; }
        const el = h(opts.interactive ? 'button' : 'div', { class: 'key' + (k.knob ? ' knob' : ''), style: `width:${w}px`, 'data-i': k.knob ? k.press : k.i, type: opts.interactive ? 'button' : null, role: opts.interactive ? 'gridcell' : null });
        el._k = k; el._x = x + k.w / 2; el._y = ri;
        if (k.knob) el.append(h('span', { class: 'cap' }, icon('knob', Math.round(U * 0.42))));
        else if (!opts.interactive) el.append(keycapLegend(cell(d, k.i)));
        if (opts.interactive) el.addEventListener('click', () => opts.onClick(k));
        r.append(el); keys.push(el); x += k.w;
      }
      root.append(r);
    });
    root._keys = keys;
    return keys;
  }
  function fitKeyboard() {
    for (const id of ['kbKeys', 'kbLight']) {
      const kb = $('#' + id); if (!kb) continue;
      const stage = kb.closest('.stage'); if (!stage || !stage.clientWidth) continue;
      const avail = stage.clientWidth - 64 - 40;
      const u = Math.max(34, Math.min(60, Math.floor((avail - 15 * 5) / 16.25)));
      if (kb.style.getPropertyValue('--u') !== u + 'px') {
        kb.style.setProperty('--u', u + 'px');
        if (S.kb) { if (id === 'kbKeys') renderKeys(); else { kb.innerHTML = ''; kb._keys = null; paintPreview(); } }
      }
    }
  }
  window.addEventListener('resize', () => { clearTimeout(fitKeyboard._t); fitKeyboard._t = setTimeout(fitKeyboard, 120); });

  /* ---------------- подсветка ---------------- */
  const SWATCHES = [[0xff0000, 'Красный'], [0xff8000, 'Оранжевый'], [0xffff00, 'Жёлтый'], [0x00ff00, 'Зелёный'], [0x00ffff, 'Голубой'], [0x0000ff, 'Синий'], [0xff00ff, 'Пурпурный'], [0xffffff, 'Белый']];
  const OPT_LABEL = { LightMusicFollow2: 'Рисунок', LightWave: 'Направление', LightLineWave: 'Направление', LightSnake: 'Траектория', LightKaleidoscope: 'Направление', LightCircleWave: 'Вращение', LightUserPicture: 'Схема' };
  const toHex = (n) => '#' + (n >>> 0).toString(16).padStart(6, '0').slice(-6);
  let customColors = [];
  try { customColors = JSON.parse(localStorage.getItem('q75.customColors') || '[]'); } catch (e) {}
  const cp = new ColorPicker($('#cp'), (rgb, live) => {
    S.light.rgb = rgb; S.light.rainbow = false; $('#rainbow').checked = false; $('#rainbowHint').hidden = true; cp.setDisabled(false);
    renderColorBits(); paintThumbs();
    if (!live) pushLight(); else pushLight(true);
  });
  const setRangeFill = (el) => el.style.setProperty('--p', ((el.value - el.min) / (el.max - el.min)) * 100 + '%');
  function renderLight() {
    const L = S.light; if (!L) return;
    const mode = LIGHT_MODES.find((m) => m.id === L.type) || LIGHT_MODES[1];
    $('#curEffect').textContent = mode.name; $('#effectName').textContent = mode.name;
    const groups = $('#effectGroups'); groups.innerHTML = '';
    for (const g of EFFECT_GROUPS) {
      const grid = h('div', { class: 'effects', role: 'radiogroup', 'aria-label': g.name });
      for (const id of g.ids) {
        const m = LIGHT_MODES.find((x) => x.id === id); if (!m) continue;
        const cv = h('canvas', { width: 128, height: 26, 'aria-hidden': 'true' });
        const b = h('button', { class: 'effect', role: 'radio', 'aria-checked': String(m.id === mode.id), onclick: () => {
          L.type = m.id;
          if (m.opts && !m.opts.some((o) => o[0] === L.option)) L.option = m.opts[0][0];
          closeEffects(); renderLight(); pushLight();
        } }, cv, h('span', {}, m.name));
        b._cv = cv; b._mode = m.id;
        grid.append(b);
      }
      groups.append(h('div', { class: 'effect-group' }, h('h3', {}, g.name), grid));
    }
    $('#fBright').hidden = !mode.bright; $('#fSpeed').hidden = !mode.speed;
    $('#bright').value = L.brightness; $('#vBright').textContent = L.brightness + ' / 4'; setRangeFill($('#bright'));
    $('#speed').value = L.speed; $('#vSpeed').textContent = L.speed + ' / 4'; setRangeFill($('#speed'));
    const opts = $('#opts'); opts.innerHTML = '';
    $('#fOpt').hidden = !mode.opts; $('#optLabel').textContent = OPT_LABEL[mode.id] || 'Вариант';
    (mode.opts || []).forEach(([v, t]) => opts.append(h('button', { class: L.option === v ? 'on' : '', role: 'radio', 'aria-checked': String(L.option === v), onclick: () => { L.option = v; renderLight(); pushLight(); } }, t)));
    $('#fColor').hidden = !mode.color;
    $('#fLive').hidden = !mode.live; renderLive();
    upRender(mode);
    $('#rainbow').checked = !!L.rainbow;
    cp.set(L.rgb); cp.setDisabled(!!L.rainbow); $('#rainbowHint').hidden = !L.rainbow;
    renderColorBits();
    paintThumbs(); paintPreview();
  }
  function renderColorBits() {
    const L = S.light;
    const dot = $('#colorDot'); dot.style.background = toHex(L.rgb); dot.classList.toggle('rainbow', !!L.rainbow);
    const sw = $('#swatches'); sw.innerHTML = ''; sw.classList.toggle('off', !!L.rainbow);
    for (const [c, name] of SWATCHES) sw.append(h('button', { class: 'sw', role: 'radio', 'aria-checked': String(!L.rainbow && L.rgb === c), 'aria-label': name, title: name, style: 'background:' + toHex(c), onclick: () => pickColor(c) }));
    const cs = $('#customSw'); cs.innerHTML = ''; cs.classList.toggle('off', !!L.rainbow);
    for (const c of customColors) cs.append(h('button', { class: 'sw', 'aria-label': 'Свой цвет ' + toHex(c), title: toHex(c) + ' (правый клик — удалить)', 'aria-checked': String(!L.rainbow && L.rgb === c), style: 'background:' + toHex(c), onclick: () => pickColor(c),
      oncontextmenu: (e) => { e.preventDefault(); customColors = customColors.filter((x) => x !== c); saveCustom(); renderColorBits(); } }));
    if (customColors.length < 10) cs.append(h('button', { class: 'sw add', 'aria-label': 'Добавить текущий цвет', title: 'Сохранить текущий цвет', onclick: () => {
      if (!customColors.includes(L.rgb)) { customColors.push(L.rgb); saveCustom(); renderColorBits(); toast('Цвет ' + toHex(L.rgb).toUpperCase() + ' сохранён', 'ok'); }
    } }, icon('plus', 16)));
  }
  const saveCustom = () => localStorage.setItem('q75.customColors', JSON.stringify(customColors));
  function pickColor(c) { S.light.rgb = c; S.light.rainbow = false; $('#rainbow').checked = false; $('#rainbowHint').hidden = true; cp.set(c); cp.setDisabled(false); renderColorBits(); paintThumbs(); pushLight(); }
  $('#bright').addEventListener('input', (e) => { S.light.brightness = +e.target.value; $('#vBright').textContent = e.target.value + ' / 4'; setRangeFill(e.target); paintThumbs(); pushLight(); });
  $('#speed').addEventListener('input', (e) => { S.light.speed = +e.target.value; $('#vSpeed').textContent = e.target.value + ' / 4'; setRangeFill(e.target); pushLight(); });
  $('#rainbow').addEventListener('change', (e) => { S.light.rainbow = e.target.checked; cp.setDisabled(e.target.checked); $('#rainbowHint').hidden = !e.target.checked; renderColorBits(); paintThumbs(); pushLight(); });
  const effBtn = $('#effectBtn'), effPop = $('#effectPop');
  function closeEffects() { effPop.hidden = true; effBtn.setAttribute('aria-expanded', 'false'); }
  effBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = effPop.hidden; effPop.hidden = !open; effBtn.setAttribute('aria-expanded', String(open));
    if (open) { paintThumbs(); const cur = effPop.querySelector('[aria-checked=true]') || effPop.querySelector('.effect'); cur && cur.focus(); }
  });
  document.addEventListener('click', (e) => { if (!effPop.hidden && !effPop.contains(e.target)) closeEffects(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !effPop.hidden) { closeEffects(); effBtn.focus(); } });
  let lightT;
  function setLightState(kind, text) { const el = $('#lightState'); el.className = 'apply-state ' + kind; el.innerHTML = ''; if (text) el.append(kind === 'ok' ? icon('check', 15) : kind === 'bad' ? icon('alert', 15) : h('span', { class: 'spinner', style: 'width:13px;height:13px' }), h('span', {}, text)); }
  function pushLight(live) {
    clearTimeout(lightT);
    setLightState('', 'Применение');
    lightT = setTimeout(async () => {
      if (!S.kb) return;
      try { const ok = await S.kb.setLight(S.light); ok ? setLightState('ok', 'Применено') : setLightState('bad', 'Не принято'); }
      catch (e) { setLightState('bad', e.message); }
      livePost();
    }, live ? 400 : 250);
  }

  /* ---- живая подсветка: звук / экран. Захват и поток кадров делает FL Esports Studio.exe,
     поэтому работает и со свёрнутым окном, а после закрытия окна поток продолжает фоновый
     процесс программы (значок у часов). Страница только включает/выключает поток. ---- */
  const LV = { api: HOSTED ? undefined : false, sent: '', synced: false, st: null, fps: 0, f0: 0, t0: 0 };
  function liveWanted() {
    const m = S.light && LIGHT_MODES.find((x) => x.id === S.light.type);
    return S.kb && !S.demo && S.cur && m && m.live ? m.live : '';
  }
  async function liveFetch(body) {
    if (LV.api === false) return null;
    try {
      const r = await fetch('/api/stream', body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
      if (r.status === 404) { LV.api = false; return null; }
      if (!r.ok) return null;
      LV.api = true; return await r.json();
    } catch (e) { return null; }
  }
  async function livePost() {
    const mode = liveWanted();
    // обычный эффект: один раз сообщаем программе, что живая подсветка выключена,
    // чтобы после закрытия окна фоновый процесс не продолжил старый поток
    if (!mode && !LV.sent && (LV.synced || !S.kb || S.demo || !S.cur || !S.light)) return;
    const d = S.cur || {};
    const st = await liveFetch({ mode, path: mode ? S.kb.path || d.path || '' : '', id: mode ? d.id || 0 : 0, dangle: mode ? S.kb.dangle || 0 : 0 });
    if (st) { LV.sent = mode; LV.st = st; LV.synced = true; }
    renderLive();
  }
  async function livePoll() {
    if (!liveWanted() || document.hidden || LV.api === false) return;
    const st = await liveFetch();
    if (!st) return;
    LV.st = st;
    const now = Date.now();
    if (!LV.t0 || st.frames < LV.f0) { LV.t0 = now; LV.f0 = st.frames; }
    else if (now - LV.t0 > 1000) { LV.fps = Math.round((st.frames - LV.f0) * 1000 / (now - LV.t0)); LV.t0 = now; LV.f0 = st.frames; }
    if (st.levels) LIVE.levels = st.levels;
    if (st.rgb && st.mode === 'screen') LIVE.rgb = st.rgb;
    LIVE.at = now;
    renderLive();
  }
  function renderLive() {
    const m = S.light && LIGHT_MODES.find((x) => x.id === S.light.type);
    if (!m || !m.live) return;
    const st = LV.st, state = $('#liveState'), hint = $('#liveHint');
    const base = (m.live === 'music' ? 'Клавиатура реагирует на звук, который играет на компьютере.' : 'Клавиатура повторяет средний цвет экрана.')
      + ' Окно можно свернуть или закрыть — подсветка продолжит работать в фоне (значок у часов).';
    let s = '', h2 = '';
    if (S.demo) { s = 'Демо'; h2 = 'В демо-режиме предпросмотр показывает пример.'; }
    else if (LV.api === false) { s = 'Недоступно'; h2 = 'Поток работает только в приложении FL Esports Studio.'; }
    else if (!st) s = 'Запуск…';
    else if (m.live === 'music' && st.audio && st.audio !== 'ok' && st.audio !== 'запуск') { s = 'Нет звука'; h2 = 'Не удалось подключиться к устройству вывода звука: ' + st.audio; }
    else if (st.live) s = 'Поток · ' + (LV.fps || '…') + ' кадр/с';
    else if (st.errors > 0) { s = 'Ожидание клавиатуры'; h2 = 'После смены режима клавиатура переподключается секунд 15 — поток начнётся сам.'; }
    else s = 'Запуск…';
    state.textContent = s;
    hint.textContent = h2 ? base + ' ' + h2 : base;
  }
  LV.holdAt = 0;
  Q75.beforeIo = async () => {
    if (!LV.sent || LV.api !== true) return;
    const now = Date.now();
    if (now - LV.holdAt < 500) return;
    LV.holdAt = now;
    await liveFetch({ hold: 1500 });
  };
  setInterval(livePoll, 150);
  setInterval(livePost, 2000);
  function paintThumbs() {
    if (effPop.hidden && paintThumbs._done) return;
    paintThumbs._done = true;
    for (const b of $$('#effectGroups .effect')) {
      const ctx = b._cv.getContext('2d'), L = Object.assign({}, S.light, { type: b._mode, brightness: 4 });
      ctx.clearRect(0, 0, 128, 26);
      for (let y = 0; y < 3; y++) for (let x = 0; x < 16; x++) {
        const [r, g, bl, a] = effectColor(L, x + 0.5, y * 2, 1.3);
        ctx.fillStyle = `rgba(${r | 0},${g | 0},${bl | 0},${Math.max(0.08, a)})`;
        ctx.fillRect(x * 8 + 1, y * 8 + 1, 6, 6);
      }
    }
  }
  function paintPreview() {
    const kb = $('#kbLight'); if (!S.kb) return;
    if (!kb._keys || !kb.childElementCount || kb._model !== S.kb.model || kb._iso !== S.iso) drawKeyboard(kb, { interactive: false });
    frame(performance.now());
  }
  let rafT = 0;
  function frame(now) {
    const kb = $('#kbLight');
    if (!S.light || !kb._keys) return;
    const t = reduceMotion.matches ? 1.3 : now / 1000;
    if (KB3D.on) { KB3D.update(kb._keys, kb._keys.map((el) => upColor(el) || effectColor(S.light, el._x, el._y, t))); return; }
    const cv = $('#glowCanvas'), W = cv.clientWidth, H = cv.clientHeight;
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, W, H);
    const base = cv.getBoundingClientRect();
    for (const el of kb._keys) {
      const [r, g, b, a] = upColor(el) || effectColor(S.light, el._x, el._y, t);
      const c = a > 0.02 ? `rgba(${r | 0},${g | 0},${b | 0},${a.toFixed(2)})` : 'transparent';
      el.style.setProperty('--glow', c);
      if (a > 0.02) { const rc = el.getBoundingClientRect(); ctx.fillStyle = c; ctx.fillRect(rc.left - base.left - 6, rc.top - base.top - 6, rc.width + 12, rc.height + 12); }
    }
  }
  function loop(now) {
    if (!reduceMotion.matches && $('#page-light').classList.contains('active') && !document.hidden && now - rafT > 40) { rafT = now; frame(now); }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);


  /* ---------------- своя схема: редактор цветов клавиш ---------------- */
  const UP = { cache: {}, dirty: {}, undo: [], tool: 'paint', rgb: 0xff0000, loading: null, down: false };
  const upIsPic = () => S.light && S.light.type === 'LightUserPicture' && S.kb;
  const upSlot = () => String((S.light && S.light.option) || '1');
  const cpPic = new ColorPicker($('#cpPic'), (rgb) => { UP.rgb = rgb; if (UP.tool !== 'paint') upTool('paint'); upSw(); });
  cpPic.set(UP.rgb);
  function upTool(t) { UP.tool = t; $$('#picTool button').forEach((b) => { const on = b.dataset.t === t; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }); }
  $$('#picTool button').forEach((b) => b.addEventListener('click', () => upTool(b.dataset.t)));
  function upSw() {
    const sw = $('#picSw'); sw.innerHTML = '';
    for (const [c, name] of SWATCHES) sw.append(h('button', { class: 'sw', role: 'radio', 'aria-checked': String(UP.rgb === c), 'aria-label': name, title: name, style: 'background:' + toHex(c) + (c === 0 ? ';box-shadow:inset 0 0 0 1px var(--border-strong)' : ''), onclick: () => { UP.rgb = c; cpPic.set(c); upTool('paint'); upSw(); } }));
  }
  upSw();
  function upState() {
    const el = $('#upState'), s = upSlot();
    if (UP.loading) { el.className = 'pic-state'; el.textContent = 'Чтение…'; return; }
    el.className = 'pic-state' + (UP.dirty[s] ? ' dirty' : '');
    el.textContent = UP.dirty[s] ? 'Не записано' : (UP.cache[s] ? 'Как в клавиатуре' : '');
    $('#picSave').disabled = !UP.cache[s] || !UP.dirty[s];
    $('#picUndo').disabled = !UP.undo.some((u) => u.slot === s);
  }
  function upRender(mode) {
    const on = !!(mode && mode.userPic && S.kb);
    $('#fPic').hidden = !on;
    $('#kbLight').classList.toggle('painting', on);
    if (!on) return;
    const s = upSlot();
    if (!UP.cache[s] && UP.loading !== s) upLoad(s);
    upState();
  }
  async function upLoad(s) {
    UP.loading = s; upState();
    try {
      const data = await S.kb.readUserPic(+s, S.light.brightness);
      UP.cache[s] = data; UP.dirty[s] = false;
    } catch (e) { toast(e.message, 'bad'); }
    UP.loading = null; upState(); frame(performance.now());
  }
  function upColor(el) {
    if (!upIsPic()) return null;
    const d = UP.cache[upSlot()]; if (!d) return [0, 0, 0, 0];
    const i = +el.dataset.i * 3, r = d[i], g = d[i + 1], b = d[i + 2];
    if (!(r | g | b)) return [0, 0, 0, 0];
    return [r, g, b, 0.35 + 0.65 * (Math.max(1, S.light.brightness) / 4)];
  }
  function upSnap() { const s = upSlot(); const d = UP.cache[s]; if (!d) return; UP.undo.push({ slot: s, data: d.slice() }); if (UP.undo.length > 60) UP.undo.shift(); }
  function upDirty() { UP.dirty[upSlot()] = true; upState(); frame(performance.now()); }
  function upPaint(el) {
    const d = UP.cache[upSlot()]; if (!d || !el || el.classList.contains('gap') || el.dataset.i == null) return;
    const i = +el.dataset.i * 3;
    if (UP.tool === 'pick') { UP.rgb = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2]; cpPic.set(UP.rgb); upTool('paint'); upSw(); return; }
    const c = UP.tool === 'erase' ? 0 : UP.rgb;
    const nr = (c >> 16) & 255, ng = (c >> 8) & 255, nb = c & 255;
    if (d[i] === nr && d[i + 1] === ng && d[i + 2] === nb) return;
    d[i] = nr; d[i + 1] = ng; d[i + 2] = nb; upDirty();
  }
  const upKb = $('#kbLight');
  upKb.addEventListener('pointerdown', (e) => {
    if (!upIsPic() || !UP.cache[upSlot()] || e.button !== 0) return;
    const el = e.target.closest('.key'); if (!el) return;
    e.preventDefault(); if (UP.tool !== 'pick') upSnap(); UP.down = true; upPaint(el);
  });
  upKb.addEventListener('pointerover', (e) => { if (UP.down && UP.tool !== 'pick') upPaint(e.target.closest('.key')); });
  window.addEventListener('pointerup', () => { UP.down = false; });

  /* ---------------- 3D-модель в предпросмотре подсветки ---------------- */
  const NOTE2D = 'Предпросмотр приблизительный: точный рисунок эффекта задаёт прошивка.';
  const has3d = (() => { try { return KB3D.init($('#kb3d'), {
    canPaint: () => !!(upIsPic() && UP.cache[upSlot()]),
    paint: (el, phase) => { if (phase === 'down') { if (UP.tool !== 'pick') upSnap(); UP.down = true; upPaint(el); } else if (UP.down && UP.tool !== 'pick') upPaint(el); },
  }); } catch (e) { console.error(e); return false; } })();
  function setView(v) {
    if (!has3d) v = '2d';
    // «Плоский» — та же 3D-модель, только камера строго сверху; старая плоская схема остаётся, если нет WebGL
    $('#kbStage').classList.toggle('is3d', has3d);
    $$('#viewSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    if (has3d) { KB3D.setMode(v === '3d' ? 'orbit' : 'top'); KB3D.setOn(true); }
    try { localStorage.setItem('q75.view', v); } catch (e) {}
    updNote();
    if (S.kb && $('#page-light').classList.contains('active')) paintPreview();
  }
  function updNote() {
    const on = has3d && KB3D.on;
    $('#stageNote').textContent = !on ? NOTE2D : KB3D.mode === 'top'
      ? (upIsPic() ? 'Вид сверху. Красьте левой кнопкой мыши.' : 'Вид сверху. Рисунок эффекта приблизительный: точный задаёт прошивка.')
      : upIsPic()
      ? 'Красьте левой кнопкой. Повернуть — правой кнопкой или с Shift, колесо — приблизить.'
      : 'Потяните мышью, чтобы повернуть, колесо — приблизить, двойной щелчок — сбросить вид. Рисунок эффекта приблизительный.';
  }
  if (!has3d) $('#viewSeg').hidden = true;
  $$('#viewSeg button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.v)));
  setInterval(updNote, 700);
  setView((() => { try { return localStorage.getItem('q75.view') || '3d'; } catch (e) { return '3d'; } })());
  function upAll(fn) { const d = UP.cache[upSlot()]; if (!d) return; upSnap(); for (const el of upKb._keys || []) { const i = +el.dataset.i * 3; fn(d, i); } upDirty(); }
  $('#picFill').addEventListener('click', () => upAll((d, i) => { d[i] = (UP.rgb >> 16) & 255; d[i + 1] = (UP.rgb >> 8) & 255; d[i + 2] = UP.rgb & 255; }));
  $('#picClear').addEventListener('click', () => upAll((d, i) => { d[i] = d[i + 1] = d[i + 2] = 0; }));
  $('#picUndo').addEventListener('click', () => {
    const s = upSlot(); for (let k = UP.undo.length - 1; k >= 0; k--) if (UP.undo[k].slot === s) { UP.cache[s] = UP.undo.splice(k, 1)[0].data; upDirty(); return; }
  });
  $('#picSave').addEventListener('click', () => {
    const s = upSlot(), d = UP.cache[s]; if (!d || !S.kb) return;
    busy('Запись схемы ' + s + '…', async () => {
      const r = await S.kb.writeUserPic(+s, S.light.brightness, d);
      UP.dirty[s] = false;
      if (r.verified) toast('Схема ' + s + ' записана и проверена', 'ok');
      else { UP.cache[s] = r.back; toast('Клавиатура сохранила схему не полностью — показано то, что в ней сейчас', 'bad'); }
      upState(); frame(performance.now());
    });
  });

  /* ---------------- раскладка ---------------- */
  async function loadMatrices() {
    const kb = S.kb;
    S.keysBanner = '';
    try {
      const base = await kb.readMatrix('base');
      const ok = Q75.matrixSanity(base, kb.model);
      log('info', `Раскладка прочитана, совпадение с заводской ${(ok * 100).toFixed(0)}%`);
      if (ok < 0.35) {
        S.writeBlocked = true;
        S.keysBanner = 'Ответ клавиатуры не похож на раскладку (совпадение ' + (ok * 100).toFixed(0) + '%). Запись отключена для безопасности. Чтобы начать с заводских значений, выберите в меню «Заводская раскладка слоя».';
        S.orig.base = Q75.defaultMatrix(kb.model);
      } else S.orig.base = base;
    } catch (e) {
      S.writeBlocked = true;
      S.keysBanner = 'Не удалось прочитать раскладку: ' + e.message;
      S.orig.base = Q75.defaultMatrix(kb.model);
    }
    try { S.orig.fn = await kb.readMatrix('fn'); } catch (e) { S.orig.fn = new Uint8Array(512); log('err', 'Слой Fn: ' + e.message); }
    S.mx.base = S.orig.base.slice(); S.mx.fn = S.orig.fn.slice();
    renderKeys();
  }
  const cell = (m, i) => Array.from(m.slice(i * 4, i * 4 + 4));
  const defaults = () => Q75.defaultMatrix(S.kb.model);
  function cellsChanged(layer) {
    const a = S.mx[layer], b = S.orig[layer]; if (!a || !b) return 0;
    let n = 0; for (let i = 0; i < 128; i++) if (!codeEq(cell(a, i), cell(b, i))) n++; return n;
  }
  const changeCount = () => (S.kb ? cellsChanged('base') + cellsChanged('fn') : 0);
  const idxOf = (k) => (k.knob ? k[S.knobPart] : k.i);
  const isEmpty = (c) => c.every((x) => x === 0);

  function renderKeys() {
    if (!S.kb || !S.mx.base) return;
    const m = S.mx[S.layer], o = S.orig[S.layer], d = defaults();
    const ban = $('#keysBanner'); ban.innerHTML = '';
    if (S.keysBanner) ban.append(h('div', { class: 'banner warn', role: 'alert' }, icon('alert'), h('div', {}, S.keysBanner)));
    if (S.layer === 'fn') ban.append(h('div', { class: 'banner info' }, icon('info'), h('div', {}, 'Слой Fn задаёт действие клавиши при зажатой Fn. Точка означает «не назначено»: работает заводская функция Fn (подсветка, Bluetooth и т.п.).')));
    const keys = drawKeyboard($('#kbKeys'), { interactive: true, onClick: (k) => { if (S.sel !== k) $('#page-keys .panel').scrollTop = 0; S.sel = k; if (k.knob && !S.knobPart) S.knobPart = 'press'; renderKeys(); } });
    for (const el of keys) {
      const k = el._k;
      const ids = k.knob ? [k.press, k.ccw, k.cw] : [k.i];
      if (k.knob) { el.setAttribute('aria-label', 'Крутилка'); el.title = 'Крутилка: нажатие и повороты'; }
      else {
        const c = cell(m, k.i), dc = cell(d, k.i);
        const empty = S.layer === 'fn' && isEmpty(c);
        const cur = empty ? { short: '·', full: 'не назначено' } : describe(c);
        if (empty) el.append(h('span', { class: 'cap' }, h('span', { class: 'cap-main word dim' }, '·')));
        else el.append(keycapLegend(c));
        if (S.layer === 'base' && !codeEq(c, dc)) el.append(h('span', { class: 'key-orig' }, describe(dc).short));
        el.setAttribute('aria-label', describe(dc).full + ': ' + cur.full);
        el.title = describe(dc).full + ' → ' + cur.full;
      }
      const sel = S.sel && ((S.sel.knob && k.knob) || (!S.sel.knob && !k.knob && S.sel.i === k.i));
      if (sel) { el.classList.add('sel'); el.setAttribute('aria-selected', 'true'); }
      if (ids.some((i) => !codeEq(cell(m, i), cell(o, i)))) el.classList.add('changed');
      else if (S.layer === 'base' && ids.some((i) => !codeEq(cell(m, i), cell(d, i)))) el.classList.add('remapped');
    }
    $('#keysTitle').textContent = S.layer === 'fn' ? 'Слой Fn' : 'Основной слой';
    $$('#layerSeg button').forEach((b) => { b.classList.toggle('on', b.dataset.l === S.layer); b.setAttribute('aria-selected', String(b.dataset.l === S.layer)); });
    $$('#isoSeg button').forEach((b) => b.classList.toggle('on', b.dataset.iso === (S.iso ? '1' : '0')));
    renderSel(); renderPicker(); renderSaveBar();
  }
  function renderSaveBar() {
    const n = changeCount();
    $('#saveBar').hidden = n === 0;
    if (!n) return;
    const parts = [];
    const b = cellsChanged('base'), f = cellsChanged('fn');
    if (b) parts.push('основной слой: ' + b); if (f) parts.push('слой Fn: ' + f);
    $('#saveText').textContent = 'Не записано: ' + parts.join(', ');
    $('#writeText').textContent = 'Записать (' + n + ')';
    $('#btnWrite').disabled = S.writeBlocked;
  }
  function renderSel() {
    const box = $('#selPanel'); box.innerHTML = '';
    const k = S.sel;
    $('#picker').classList.toggle('disabled', !k);
    if (!k) { box.append(h('div', { class: 'sel-empty' }, icon('target', 22), h('span', {}, 'Выберите клавишу на схеме, чтобы изменить её назначение.'))); return; }
    const i = idxOf(k), m = S.mx[S.layer], c = cell(m, i), dflt = cell(defaults(), i);
    const defName = describe(dflt).full;
    box.append(h('div', { class: 'sel-head' },
      h('span', { class: 'sel-key' }, k.knob ? icon('knob', 26) : keycapLegend(dflt)),
      h('div', {}, h('h2', {}, k.knob ? 'Крутилка' : defName), h('p', {}, S.layer === 'fn' ? 'Слой Fn' : 'Основной слой'))));
    if (k.knob) box.append(h('div', { class: 'seg', style: 'margin-bottom:12px', role: 'radiogroup', 'aria-label': 'Действие крутилки' },
      ...[['press', 'Нажатие'], ['ccw', 'Влево'], ['cw', 'Вправо']].map(([p, t]) => h('button', { class: S.knobPart === p ? 'on' : '', role: 'radio', 'aria-checked': String(S.knobPart === p), onclick: () => { S.knobPart = p; renderKeys(); } }, t))));
    box.append(h('div', { class: 'sel-now' }, h('span', {}, 'Сейчас'), h('b', {}, (S.layer === 'fn' && isEmpty(c)) ? 'не назначено' : describe(c).full)));
    const actions = h('div', { class: 'sel-actions' });
    if (S.layer === 'base') actions.append(h('button', { class: 'btn ghost', disabled: codeEq(c, dflt), onclick: () => assign(dflt) }, icon('reset', 16), 'Заводское'));
    else actions.append(h('button', { class: 'btn ghost', disabled: isEmpty(c), onclick: () => assign([0, 0, 0, 0]) }, icon('x', 16), 'Очистить'));
    actions.append(h('button', { class: 'btn ghost', disabled: codeEq(c, cell(S.orig[S.layer], i)), onclick: () => assign(cell(S.orig[S.layer], i)) }, icon('undo', 16), 'Как было'));
    box.append(actions);
    box.append(h('details', { class: 'tech' }, h('summary', {}, 'Технические данные'), h('code', {}, 'Код ' + hex(c) + ', ячейка ' + i + (S.layer === 'base' ? ', заводской ' + hex(dflt) : ''))));
  }
  function assign(code) {
    if (!S.sel) { toast('Сначала выберите клавишу на схеме'); return; }
    S.mx[S.layer].set(code, idxOf(S.sel) * 4);
    renderKeys();
  }
  const PICK_TABS = [['keys', 'Клавиши'], ['media', 'Медиа'], ['system', 'Система'], ['mouse', 'Мышь'], ['special', 'Особые'], ['combo', 'Комбинация'], ['macro', 'Макрос'], ['capture', 'Нажатием']];
  const combo = { mod: 'ctrl', key: 6 };
  function renderPicker() {
    const tabs = $('#pickTabs'); tabs.innerHTML = '';
    for (const [id, t] of PICK_TABS) tabs.append(h('button', { role: 'tab', 'aria-selected': String(S.pickTab === id), onclick: () => { S.pickTab = id; renderPicker(); } }, t));
    const body = $('#pickBody'); const scroll = body.scrollTop; body.innerHTML = '';
    const curCode = S.sel ? cell(S.mx[S.layer], idxOf(S.sel)) : null;
    const chip = (name, code) => h('button', { class: 'chip', 'aria-pressed': String(!!curCode && codeEq(curCode, code)), onclick: () => assign(code) }, name);
    if (S.pickTab === 'keys') {
      for (const g of PICK_GROUPS) body.append(h('div', { class: 'pick-group' }, h('h3', {}, g.name), h('div', { class: 'chips' }, g.codes.map((c) => chip(HID[c], [0, 0, c, 0])))));
    } else if (['media', 'system', 'mouse', 'special'].includes(S.pickTab)) {
      body.append(h('div', { class: 'chips' }, SPECIAL.filter((s) => s.cat === S.pickTab).map((s) => chip(s.name, s.code))));
    } else if (S.pickTab === 'combo') {
      const keySel = h('select', { class: 'input', 'aria-label': 'Клавиша' }, ...Object.keys(HID).filter((c) => c < 224).map((c) => h('option', { value: c }, HID[c])));
      keySel.value = combo.key; keySel.addEventListener('change', () => (combo.key = +keySel.value));
      body.append(h('div', { class: 'combo' }, h('p', { class: 'hint', style: 'margin:0' }, 'Модификатор и клавиша одним нажатием, например Ctrl + C.'),
        h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Модификатор' }, ...Object.keys(MOD_CODES).map((m) => h('button', { class: combo.mod === m ? 'on' : '', role: 'radio', 'aria-checked': String(combo.mod === m), onclick: () => { combo.mod = m; renderPicker(); } }, m[0].toUpperCase() + m.slice(1)))),
        keySel, h('button', { class: 'btn primary', onclick: () => assign([0, MOD_CODES[combo.mod], combo.key, 0]) }, icon('check', 16), 'Назначить комбинацию')));
    } else if (S.pickTab === 'macro') {
      if (!S.macros) { body.append(h('p', { class: 'hint', style: 'margin:0 0 10px' }, 'Макросы ещё не прочитаны с клавиатуры.'), h('button', { class: 'btn', onclick: () => busy('Чтение макросов…', async () => { await loadMacros(); renderPicker(); }) }, icon('refresh', 16), 'Прочитать макросы')); }
      else {
        const used = S.macros.map((m, i) => [m, i]).filter(([m]) => m.events.length);
        body.append(h('div', { class: 'p-label sm', style: 'margin-top:0' }, 'Режим воспроизведения'),
          h('div', { class: 'seg wide', style: 'margin-bottom:14px', role: 'radiogroup', 'aria-label': 'Режим макроса' }, ...[0, 2, 1].map((md) => h('button', { class: S.macroMode === md ? 'on' : '', role: 'radio', 'aria-checked': String(S.macroMode === md), title: MACRO_MODES[md], onclick: () => { S.macroMode = md; renderPicker(); } }, { 0: 'N раз', 2: 'Пока нажата', 1: 'Вкл / выкл' }[md]))));
        if (!used.length) body.append(h('p', { class: 'hint', style: 'margin:0' }, 'Макросов пока нет. Создайте их в разделе «Макросы».'));
        else body.append(h('div', { class: 'macro-pick' }, used.map(([m, i]) => {
          const code = [9, S.macroMode, i, 0];
          return h('button', { class: 'chip', 'aria-pressed': String(!!curCode && codeEq(curCode, code)), onclick: () => { if (m.dirty) toast('Макрос «' + macroName(i) + '» ещё не записан в клавиатуру — запишите его в разделе «Макросы».', 'bad'); assign(code); } }, h('span', {}, macroName(i)), h('small', { class: 'hint', style: 'margin:0' }, m.events.filter((e) => e.type !== 'delay' && e.action === 'down').length + ' наж.'));
        })));
        body.append(h('button', { class: 'btn ghost', style: 'margin-top:12px', onclick: () => showPage('macros') }, icon('macro', 16), 'Открыть редактор макросов'));
      }
    } else if (S.pickTab === 'capture') {
      const box = h('div', { class: 'capture', tabindex: 0, role: 'button', 'aria-label': 'Захват нажатия' }, icon('keyboard', 28), h('span', {}, 'Нажмите сюда, затем нужную клавишу на любой клавиатуре'));
      box.addEventListener('focus', () => { box.classList.add('on'); box.lastChild.textContent = 'Жду нажатия…'; });
      box.addEventListener('blur', () => { box.classList.remove('on'); box.lastChild.textContent = 'Нажмите сюда, затем нужную клавишу на любой клавиатуре'; });
      box.addEventListener('keydown', (e) => {
        e.preventDefault(); e.stopPropagation();
        const c = CODE2HID[e.code];
        if (c === undefined) { box.lastChild.textContent = 'Клавиша ' + e.code + ' не поддерживается'; return; }
        assign([0, 0, c, 0]); toast('Назначено: ' + HID[c], 'ok');
      });
      body.append(box);
    }
    body.scrollTop = scroll;
  }
  const CODE2HID = (() => {
    const m = {};
    for (let i = 0; i < 26; i++) m['Key' + String.fromCharCode(65 + i)] = 4 + i;
    for (let i = 1; i <= 9; i++) m['Digit' + i] = 29 + i; m.Digit0 = 39;
    for (let i = 1; i <= 12; i++) m['F' + i] = 57 + i;
    for (let i = 13; i <= 24; i++) m['F' + i] = 91 + i;
    for (let i = 1; i <= 9; i++) m['Numpad' + i] = 88 + i; m.Numpad0 = 98;
    Object.assign(m, { Enter: 40, Escape: 41, Backspace: 42, Tab: 43, Space: 44, Minus: 45, Equal: 46, BracketLeft: 47, BracketRight: 48, Backslash: 49,
      Semicolon: 51, Quote: 52, Backquote: 53, Comma: 54, Period: 55, Slash: 56, CapsLock: 57, PrintScreen: 70, ScrollLock: 71, Pause: 72,
      Insert: 73, Home: 74, PageUp: 75, Delete: 76, End: 77, PageDown: 78, ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82,
      NumLock: 83, NumpadDivide: 84, NumpadMultiply: 85, NumpadSubtract: 86, NumpadAdd: 87, NumpadEnter: 88, NumpadDecimal: 99,
      IntlBackslash: 100, ContextMenu: 101, ControlLeft: 224, ShiftLeft: 225, AltLeft: 226, MetaLeft: 227, ControlRight: 228, ShiftRight: 229, AltRight: 230, MetaRight: 231 });
    return m;
  })();

  $$('#layerSeg button').forEach((b) => b.addEventListener('click', () => { S.layer = b.dataset.l; S.sel = null; renderKeys(); }));
  $$('#isoSeg button').forEach((b) => b.addEventListener('click', () => { S.iso = b.dataset.iso === '1'; S.sel = null; renderKeys(); $('#kbLight').innerHTML = ''; paintPreview(); }));
  function undoAll() { S.mx.base = S.orig.base.slice(); S.mx.fn = S.orig.fn.slice(); renderKeys(); toast('Изменения отменены'); }
  $('#btnUndo').addEventListener('click', undoAll);
  const menu = $('#moreMenu'), moreBtn = $('#btnMore');
  const closeMenu = () => { menu.hidden = true; moreBtn.setAttribute('aria-expanded', 'false'); };
  moreBtn.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; moreBtn.setAttribute('aria-expanded', String(!menu.hidden)); if (!menu.hidden) menu.querySelector('button').focus(); });
  document.addEventListener('click', (e) => { if (!menu.contains(e.target)) closeMenu(); });
  $('#btnDefaults').addEventListener('click', async () => {
    closeMenu();
    const fn = S.layer === 'fn';
    if (!(await confirmDlg(fn ? 'Очистить слой Fn?' : 'Загрузить заводскую раскладку?', fn ? 'Все назначения слоя Fn будут убраны. В клавиатуру это попадёт после нажатия «Записать».' : 'Все клавиши основного слоя вернутся к заводским значениям. В клавиатуру это попадёт после нажатия «Записать».', fn ? 'Очистить' : 'Загрузить', true))) return;
    if (fn) S.mx.fn = new Uint8Array(512);
    else { S.mx.base = defaults(); if (S.writeBlocked) { S.writeBlocked = false; S.keysBanner = ''; } }
    renderKeys();
  });
  $('#btnReload').addEventListener('click', async () => { if (await guardUnsaved()) busy('Чтение раскладки…', loadMatrices); });
  async function writeAll() {
    if (!changeCount() || S.writeBlocked) return;
    await busy('Запись раскладки…', async () => {
      let diff = 0;
      for (const layer of ['base', 'fn']) {
        if (!cellsChanged(layer)) continue;
        const data = S.mx[layer].slice();
        await S.kb.writeMatrix(data, layer);
        const back = await S.kb.readMatrix(layer);
        for (let i = 0; i < 504; i++) if (back[i] !== data[i]) diff++;
        S.orig[layer] = back; S.mx[layer] = data;
      }
      if (diff) { log('err', `После записи отличаются ${diff} байт`); toast('Записано, но проверка нашла расхождения. Подробности в журнале.', 'bad'); }
      else toast('Раскладка записана и проверена', 'ok');
      renderKeys();
    });
  }
  $('#btnWrite').addEventListener('click', writeAll);
  document.addEventListener('keydown', (e) => {
    if (S.rec || !$('#page-keys').classList.contains('active') || $('#dlg').open) return;
    if (e.ctrlKey && e.code === 'KeyS') { e.preventDefault(); writeAll(); }
    else if (e.ctrlKey && e.code === 'KeyZ' && changeCount() && !/INPUT|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); undoAll(); }
    else if (e.key === 'Escape' && S.sel) { S.sel = null; renderKeys(); }
  });
  window.addEventListener('beforeunload', (e) => { if (changeCount() || (S.macros && S.macros.some((m) => m.dirty))) { e.preventDefault(); e.returnValue = ''; } });
  $('#btnExport').addEventListener('click', () => {
    closeMenu(); if (!S.mx.base) return;
    const data = { app: 'FL Esports Studio', version: 2, model: S.kb.model, base: Array.from(S.mx.base), fn: Array.from(S.mx.fn), macros: S.macros ? S.macros.map((m, i) => ({ slot: i, name: macroNames[i] || null, repeat: m.repeat, events: m.events })).filter((m) => m.events.length) : undefined };
    const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' })), download: 'q75-layout.json' });
    document.body.append(a); a.click(); a.remove();
    toast('Файл раскладки сохранён', 'ok');
  });
  $('#fileImport').addEventListener('change', async (e) => {
    closeMenu();
    const f = e.target.files[0]; if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!['FL Esports Studio', 'Q75 Studio'].includes(d.app) || d.base.length !== 512 || d.fn.length !== 512) throw new Error('Неверный формат файла');
      if (d.model !== S.kb.model && !(await confirmDlg('Файл для другой модели', 'Раскладка сохранена для модели «' + d.model + '». Всё равно загрузить?', 'Загрузить'))) return;
      S.mx.base = Uint8Array.from(d.base); S.mx.fn = Uint8Array.from(d.fn);
      if (Array.isArray(d.macros) && d.macros.length) {
        if (!S.macros) await busy('Чтение макросов…', loadMacros);
        for (const mm of d.macros) { if (mm.slot < 0 || mm.slot >= MACRO_SLOTS) continue; const m = S.macros[mm.slot]; m.events = mm.events; m.repeat = mm.repeat || 1; markDirty(m); if (mm.name) macroNames[mm.slot] = mm.name; }
        saveNames(); toast('Загружено макросов: ' + d.macros.length + '. Запишите их в разделе «Макросы».');
      }
      renderKeys(); toast('Раскладка загружена. Нажмите «Записать».');
    } catch (err) { toast(err.message, 'bad'); }
    e.target.value = '';
  });

  /* ---------------- макросы ---------------- */
  S.macroMode = 0;
  let macroNames = {};
  try { macroNames = JSON.parse(localStorage.getItem('q75.macroNames') || '{}'); } catch (e) {}
  const saveNames = () => localStorage.setItem('q75.macroNames', JSON.stringify(macroNames));
  const macroName = (i) => macroNames[i] || 'Макрос ' + (i + 1);
  window.macroName = macroName;
  const evKeyName = (e) => e.type === 'mouse_button' ? ({ 240: 'ЛКМ', 241: 'ПКМ', 242: 'Колесо', 243: 'Назад', 244: 'Вперёд' }[e.value] || 'Мышь') : (HID[e.value] || '0x' + e.value.toString(16));
  async function loadMacros() {
    const list = [];
    for (let i = 0; i < MACRO_SLOTS; i++) {
      try { const m = await S.kb.readMacro(i); list.push({ events: m.events, repeat: m.repeat || 1, saved: JSON.stringify(m.events) + '|' + (m.repeat || 1), dirty: false }); }
      catch (e) { log('err', e.message); list.push({ events: [], repeat: 1, saved: '[]|1', dirty: false, unread: true }); }
    }
    S.macros = list;
  }
  async function openMacros() {
    if (!S.kb) return;
    if (!S.macros) await busy('Чтение макросов…', loadMacros);
    renderMacros();
  }
  const markDirty = (m) => { m.dirty = (JSON.stringify(m.events) + '|' + m.repeat) !== m.saved; };
  function usedOnKeys(i) {
    const out = [];
    for (const layer of ['base', 'fn']) { const mx = S.mx[layer]; if (!mx) continue; for (let c = 0; c < 128; c++) if (mx[c * 4] === 9 && mx[c * 4 + 2] === i) out.push({ layer, c, mode: mx[c * 4 + 1] }); }
    return out;
  }
  const plural = (n, one, few, many) => n + ' ' + (n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);
  const MODE_SHORT = { 0: 'N раз', 1: 'вкл/выкл', 2: 'пока нажата' };
  function useLabel(u) { const k = describe(cell(defaults(), u.c)).short || 'Space'; return (u.layer === 'fn' ? 'Fn + ' : '') + k; }
  function useChip(u) {
    return h('span', { class: 'kchip' + (u.layer === 'fn' ? ' fn' : ''), title: (u.layer === 'fn' ? 'Слой Fn: Fn + ' : 'Основной слой: ') + describe(cell(defaults(), u.c)).full + ', режим «' + MODE_SHORT[u.mode] + '»' },
      useLabel(u), h('i', {}, MODE_SHORT[u.mode]));
  }
  function gotoKey(u) {
    S.layer = u.layer; S.pickTab = 'macro';
    const k = buildLayout(S.kb.model, S.iso).flat().find((x) => !x.gap && (x.knob ? [x.press, x.ccw, x.cw].includes(u.c) : x.i === u.c));
    if (k) { S.sel = k; if (k.knob) S.knobPart = k.press === u.c ? 'press' : k.ccw === u.c ? 'ccw' : 'cw'; }
    showPage('keys');
  }
  function renderMacros() {
    if (!S.macros) return;
    const list = $('#macroList'); list.innerHTML = '';
    S.macros.forEach((m, i) => {
      if (!m.events.length && !m.dirty && S.macroSel !== i) return;
      const presses = m.events.filter((e) => e.type !== 'delay' && e.action === 'down').length;
      const uses = usedOnKeys(i);
      const state = m.dirty ? ['dirty', 'Не записан'] : !m.events.length ? ['empty', 'Пусто'] : ['ok', 'В клавиатуре'];
      list.append(h('button', { class: 'macro-item', role: 'option', 'aria-selected': String(S.macroSel === i), onclick: () => { stopRec(); S.macroSel = i; S.evCur = null; renderMacros(); } },
        h('span', { class: 'mi-num' }, String(i + 1)),
        h('span', { class: 'mi-body' },
          h('span', { class: 'mi-top' }, h('b', {}, macroName(i)), h('span', { class: 'mi-state ' + state[0], title: state[1], 'aria-label': state[1] }, state[1])),
          h('small', {}, plural(presses, 'нажатие', 'нажатия', 'нажатий')),
          h('span', { class: 'mi-keys' }, uses.length ? uses.map(useChip) : h('span', { class: 'mi-none' }, 'не назначен на клавишу')))));
    });
    if (!list.childElementCount) list.append(h('p', { class: 'hint', style: 'margin:0' }, 'Макросов пока нет.'));
    const m = S.macroSel !== null && S.macroSel !== undefined ? S.macros[S.macroSel] : null;
    $('#macroEmpty').hidden = !!m; $('#macroEditor').hidden = !m;
    if (!m) return;
    $('#macroName').value = macroName(S.macroSel);
    $('#macroSlot').textContent = 'Ячейка ' + (S.macroSel + 1) + ' из ' + MACRO_SLOTS;
    const uses = usedOnKeys(S.macroSel), ab = $('#macroUses'); ab.innerHTML = '';
    ab.append(h('span', { class: 'p-label', style: 'margin:0' }, 'Клавиши'), ...(uses.length ? uses.map((u) => { const ch = useChip(u); const b = h('button', { class: 'kchip-btn', title: 'Открыть эту клавишу на вкладке «Клавиши»', onclick: () => gotoKey(u) }, ch); return b; }) : [h('span', { class: 'mi-none' }, 'макрос не назначен — нажмите «Назначить на клавишу»')]));
    $('#macroRepeat').value = m.repeat;
    $('#fixedWrap').hidden = $('#recDelays').checked;
    renderEvents(m);
    const bytes = Q75.macroBytes(m.events), pct = Math.min(100, (bytes / MACRO_MAX_BYTES) * 100);
    $('#meterFill').style.width = pct + '%'; $('#meterFill').parentElement.classList.toggle('full', bytes > MACRO_MAX_BYTES);
    $('#meterText').textContent = Math.min(bytes, 999) + ' / ' + MACRO_MAX_BYTES + ' Б'; $('#meterText').title = 'Занято памяти макроса';
    $('#btnSaveMacro').disabled = !m.dirty || bytes > MACRO_MAX_BYTES || S.rec;
  }
  function renderEvents(m) {
    const ol = $('#eventList'); const st = ol.scrollTop; ol.innerHTML = '';
    if (!m.events.length) { ol.append(h('li', { class: 'events-empty' }, 'Шагов пока нет. Нажмите «Записать» и наберите последовательность или добавьте шаги вручную.')); return; }
    m.events.forEach((e, idx) => {
      const tools = h('span', { class: 'ev-tools' },
        h('button', { title: 'Выше', 'aria-label': 'Переместить выше', disabled: idx === 0, onclick: () => moveEv(m, idx, -1) }, icon('chevUp', 16)),
        h('button', { title: 'Ниже', 'aria-label': 'Переместить ниже', disabled: idx === m.events.length - 1, onclick: () => moveEv(m, idx, 1) }, icon('chevron', 16)),
        h('button', { title: 'Удалить шаг', 'aria-label': 'Удалить шаг', onclick: () => { m.events.splice(idx, 1); markDirty(m); renderMacros(); } }, icon('x', 16)));
      if (e.type === 'delay') {
        const inp = h('input', { type: 'number', min: 1, max: 65535, value: e.value, 'aria-label': 'Пауза, мс' });
        inp.addEventListener('change', () => { e.value = Math.max(1, Math.min(65535, Math.round(+inp.value || 1))); inp.value = e.value; markDirty(m); renderMacros(); });
        ol.append(h('li', { class: 'ev delay' + (S.evCur === idx ? ' cur' : ''), onclick: (ev) => { if (ev.target === ev.currentTarget) { S.evCur = idx; renderMacros(); } } }, h('span', { class: 'ev-ico' }, icon('clock', 16)), h('span', { class: 'ev-delay' }, 'пауза', inp, 'мс'), tools));
      } else {
        ol.append(h('li', { class: 'ev ' + e.action + (S.evCur === idx ? ' cur' : ''), onclick: (ev) => { if (!ev.target.closest('button')) { S.evCur = idx; renderMacros(); } } },
          h('span', { class: 'ev-ico' }, icon(e.action === 'down' ? 'down' : 'up', 16)),
          h('span', { class: 'ev-body' }, h('span', { class: 'ev-key' }, evKeyName(e)), h('span', { class: 'ev-act' }, e.action === 'down' ? 'нажать' : 'отпустить')), tools));
      }
    });
    ol.scrollTop = S.rec ? ol.scrollHeight : st;
  }
  function moveEv(m, i, d) { const j = i + d; if (j < 0 || j >= m.events.length) return; [m.events[i], m.events[j]] = [m.events[j], m.events[i]]; S.evCur = j; markDirty(m); renderMacros(); }
  function insertEvents(m, evs) {
    const at = S.evCur !== null && S.evCur !== undefined && S.evCur < m.events.length ? S.evCur + 1 : m.events.length;
    m.events.splice(at, 0, ...evs); S.evCur = at + evs.length - 1; markDirty(m); renderMacros();
  }
  const fixedDelay = () => Math.max(1, Math.min(65535, Math.round(+$('#fixedDelay').value || 20)));
  $('#btnNewMacro').addEventListener('click', async () => {
    if (!S.macros) await busy('Чтение макросов…', loadMacros);
    const i = S.macros.findIndex((m, k) => !m.events.length && !m.dirty && !usedOnKeys(k).length);
    if (i < 0) { toast('Все 20 ячеек заняты. Удалите ненужный макрос.', 'bad'); return; }
    stopRec(); S.macroSel = i; S.evCur = null; delete macroNames[i]; saveNames();
    S.macros[i].dirty = true; renderMacros(); $('#macroName').focus(); $('#macroName').select();
  });
  $('#btnReadMacros').addEventListener('click', async () => {
    if (S.macros && S.macros.some((m) => m.dirty) && !(await confirmDlg('Есть незаписанные макросы', 'Несохранённые изменения макросов будут потеряны.', 'Прочитать', true))) return;
    stopRec(); await busy('Чтение макросов…', loadMacros); renderMacros();
  });
  $('#macroName').addEventListener('input', (e) => { const v = e.target.value.trim(); if (v) macroNames[S.macroSel] = v; else delete macroNames[S.macroSel]; saveNames(); renderMacroListOnly(); });
  function renderMacroListOnly() { const sel = S.macroSel; const nm = $('#macroName').value; renderMacros(); $('#macroName').value = nm; }
  $('#macroRepeat').addEventListener('change', (e) => { const m = S.macros[S.macroSel]; m.repeat = Math.max(1, Math.min(65535, Math.round(+e.target.value || 1))); e.target.value = m.repeat; markDirty(m); renderMacros(); });
  $('#recDelays').addEventListener('change', () => { $('#fixedWrap').hidden = $('#recDelays').checked; });
  $('#btnClearEv').addEventListener('click', async () => {
    const m = S.macros[S.macroSel]; if (!m.events.length) return;
    if (!(await confirmDlg('Очистить макрос?', 'Все шаги макроса будут удалены.', 'Очистить', true))) return;
    m.events = []; S.evCur = null; markDirty(m); renderMacros();
  });
  $('#btnDelMacro').addEventListener('click', async () => {
    const i = S.macroSel, m = S.macros[i], uses = usedOnKeys(i);
    if (!(await confirmDlg('Удалить «' + macroName(i) + '»?', 'Макрос будет стёрт из памяти клавиатуры.' + (uses.length ? ' Он назначен на ' + uses.length + ' клав. — эти клавиши станут неактивны, переназначьте их.' : ''), 'Удалить', true))) return;
    stopRec();
    await busy('Удаление макроса…', async () => {
      await S.kb.writeMacro(i, [], 1);
      Object.assign(m, { events: [], repeat: 1, saved: '[]|1', dirty: false });
      delete macroNames[i]; saveNames(); S.macroSel = null;
      toast('Макрос удалён', 'ok');
    });
    renderMacros();
  });
  $('#btnSaveMacro').addEventListener('click', () => saveMacro());
  async function saveMacro() {
    const i = S.macroSel, m = S.macros[i];
    if (!m || !m.dirty) return;
    if (Q75.macroBytes(m.events) > MACRO_MAX_BYTES) { toast('Макрос не помещается в память клавиатуры. Уберите часть шагов.', 'bad'); return; }
    await busy('Запись макроса…', async () => {
      await S.kb.writeMacro(i, m.events, m.repeat);
      const back = await S.kb.readMacro(i);
      const same = Q75.encodeMacro(back.events, back.repeat).every((x, k) => x === Q75.encodeMacro(m.events, m.repeat)[k]);
      m.saved = JSON.stringify(m.events) + '|' + m.repeat; m.dirty = false;
      if (same) toast('Макрос записан и проверен', 'ok'); else { log('err', 'Макрос после записи отличается'); toast('Макрос записан, но проверка нашла расхождения. Подробности в журнале.', 'bad'); }
      if (!usedOnKeys(i).length) toast('Теперь назначьте макрос на клавишу — кнопка «Назначить на клавишу».');
    });
    renderMacros();
  }
  $('#btnAssignMacro').addEventListener('click', () => {
    S.pickTab = 'macro'; S.sel = null; showPage('keys');
    toast('Выберите клавишу на схеме, затем макрос в панели слева.');
  });
  const addMenu = $('#addMenu'), addBtn = $('#btnAddEv');
  addBtn.addEventListener('click', (e) => { e.stopPropagation(); addMenu.hidden = !addMenu.hidden; addBtn.setAttribute('aria-expanded', String(!addMenu.hidden)); });
  document.addEventListener('click', (e) => { if (!addMenu.contains(e.target)) { addMenu.hidden = true; addBtn.setAttribute('aria-expanded', 'false'); } });
  $$('#addMenu [data-add]').forEach((b) => b.addEventListener('click', () => {
    addMenu.hidden = true; const m = S.macros[S.macroSel], kind = b.dataset.add, row = $('#addRow');
    if (kind === 'delay') { insertEvents(m, [{ type: 'delay', value: fixedDelay() }]); return; }
    row.innerHTML = ''; row.hidden = false;
    const sel = h('select', { class: 'input', 'aria-label': kind === 'key' ? 'Клавиша' : 'Кнопка мыши' },
      ...(kind === 'key' ? Object.keys(HID).map((c) => h('option', { value: c }, HID[c])) : [[240, 'ЛКМ'], [241, 'ПКМ'], [242, 'Колесо (клик)'], [243, 'Назад'], [244, 'Вперёд']].map(([v, t]) => h('option', { value: v }, t))));
    const type = kind === 'key' ? 'keyboard' : 'mouse_button';
    const add = (evs) => { insertEvents(m, evs); row.hidden = true; };
    row.append(h('span', { class: 'p-label', style: 'margin:0' }, kind === 'key' ? 'Клавиша' : 'Кнопка мыши'), sel,
      h('button', { class: 'btn primary', onclick: () => { const v = +sel.value; add([{ type, action: 'down', value: v }, { type: 'delay', value: fixedDelay() }, { type, action: 'up', value: v }]); } }, 'Нажать и отпустить'),
      h('button', { class: 'btn ghost', onclick: () => add([{ type, action: 'down', value: +sel.value }]) }, 'Только нажать'),
      h('button', { class: 'btn ghost', onclick: () => add([{ type, action: 'up', value: +sel.value }]) }, 'Только отпустить'),
      h('button', { class: 'btn ghost icon-only', 'aria-label': 'Закрыть', onclick: () => (row.hidden = true) }, icon('x', 16)));
    sel.focus();
  }));
  // запись
  function startRec() {
    const m = S.macros[S.macroSel]; if (!m) return;
    S.rec = { m, last: null, held: new Set() };
    $('#btnRec').classList.add('on'); $('#recText').textContent = 'Стоп'; $('#recBanner').hidden = false;
    document.activeElement && document.activeElement.blur();
    renderMacros();
  }
  function stopRec() {
    if (!S.rec) return;
    const m = S.rec.m; S.rec = null;
    for (; m.events.length && m.events[m.events.length - 1].type === 'delay';) m.events.pop();
    $('#btnRec').classList.remove('on'); $('#recText').textContent = 'Записать'; $('#recBanner').hidden = true;
    markDirty(m); renderMacros();
  }
  $('#btnRec').addEventListener('click', () => (S.rec ? stopRec() : startRec()));
  const recKey = (e, action) => {
    if (!S.rec) return;
    e.preventDefault(); e.stopPropagation();
    if (action === 'down' && e.repeat) return;
    const c = CODE2HID[e.code]; if (c === undefined) return;
    if (action === 'up' && !S.rec.held.has(c)) return;
    action === 'down' ? S.rec.held.add(c) : S.rec.held.delete(c);
    const now = performance.now(), m = S.rec.m;
    if (S.rec.last !== null) m.events.push({ type: 'delay', value: $('#recDelays').checked ? Math.max(1, Math.min(65535, Math.round(now - S.rec.last))) : fixedDelay() });
    S.rec.last = now;
    m.events.push({ type: 'keyboard', action, value: c });
    if (Q75.macroBytes(m.events) > MACRO_MAX_BYTES) { m.events.splice(-2); stopRec(); toast('Память макроса заполнена, запись остановлена.', 'bad'); return; }
    markDirty(m); renderMacros();
  };
  window.addEventListener('keydown', (e) => recKey(e, 'down'), true);
  window.addEventListener('keyup', (e) => recKey(e, 'up'), true);

  /* ---------------- настройки ---------------- */
  async function loadSettings() {
    const kb = S.kb;
    S.rate = await kb.getReportRate(); S.deb = await kb.getDebounce(); S.opt = await kb.getOptions(); S.sleep = await kb.getSleep();
    renderSettings();
  }
  function renderSettings() {
    const seg = $('#rateSeg'); seg.innerHTML = '';
    for (const hz of [125, 250, 500, 1000]) seg.append(h('button', { class: S.rate === hz ? 'on' : '', role: 'radio', 'aria-checked': String(S.rate === hz), onclick: () => busy('Смена частоты опроса…', async () => {
      if (await S.kb.setReportRate(hz)) { S.rate = hz; toast('Частота опроса: ' + hz + ' Гц', 'ok'); } else toast('Клавиатура не приняла настройку', 'bad');
      renderSettings();
    }) }, hz + ' Гц'));
    $('#deb').value = S.deb ?? 5; $('#vDeb').textContent = (S.deb ?? '?') + ' мс';
    $('#optWin').checked = !!(S.opt && S.opt.winLock); $('#optWasd').checked = !!(S.opt && S.opt.wasdSwap);
    $('#optWin').disabled = $('#optWasd').disabled = !S.opt;
    const sl = S.sleep || { bt: 0, rf: 0, deepBt: 0, deepRf: 0 };
    $('#slBt').value = Math.round(sl.bt / 60); $('#slRf').value = Math.round(sl.rf / 60);
    $('#slDBt').value = Math.round(sl.deepBt / 60); $('#slDRf').value = Math.round(sl.deepRf / 60);
  }
  $('#deb').addEventListener('input', (e) => ($('#vDeb').textContent = e.target.value + ' мс'));
  $('#deb').addEventListener('change', async (e) => { if (await S.kb.setDebounce(+e.target.value)) { S.deb = +e.target.value; toast('Антидребезг: ' + S.deb + ' мс', 'ok'); } else toast('Не удалось сохранить', 'bad'); });
  const optChange = async () => {
    const o = Object.assign({}, S.opt, { winLock: $('#optWin').checked, wasdSwap: $('#optWasd').checked });
    if (await S.kb.setOptions(o)) { S.opt = (await S.kb.getOptions()) || o; toast('Сохранено', 'ok'); } else toast('Не удалось сохранить', 'bad');
    renderSettings();
  };
  $('#optWin').addEventListener('change', optChange); $('#optWasd').addEventListener('change', optChange);
  $('#btnSleep').addEventListener('click', () => busy('Сохранение…', async () => {
    const m = (id) => Math.max(0, Math.min(60, +$(id).value || 0)) * 60;
    const s = { bt: m('#slBt'), rf: m('#slRf'), deepBt: m('#slDBt'), deepRf: m('#slDRf') };
    if (await S.kb.setSleep(s)) { S.sleep = (await S.kb.getSleep()) || s; toast('Таймеры сна сохранены', 'ok'); } else toast('Не удалось сохранить', 'bad');
    renderSettings();
  }));
  $('#btnReset').addEventListener('click', async () => {
    if (!(await confirmDlg('Сбросить клавиатуру?', 'Раскладка, подсветка и все параметры вернутся к заводским. Отменить это нельзя.', 'Сбросить', true))) return;
    busy('Сброс…', async () => {
      if (!(await S.kb.factoryReset())) throw new Error('Клавиатура не приняла команду сброса');
      S.light = (await S.kb.getLight()) || S.light; renderLight();
      await loadSettings(); await loadMatrices();
      toast('Клавиатура сброшена к заводским настройкам', 'ok');
    });
  });
  function renderInfo() {
    const t = $('#devInfo'); t.innerHTML = ''; if (!S.kb) return;
    const d = S.cur, m = MODEL_INFO[S.kb.model];
    const rows = [['Модель', m.title], ['Платформа', m.chip], ['ID в базе', String(devId(d))], ['VID:PID', (d.vid || 0).toString(16).padStart(4, '0') + ':' + (d.pid || 0).toString(16).padStart(4, '0')],
      ['Подключение', d.kind === 'dangle' ? '2.4G-приёмник' : d.is24 ? 'беспроводное' : 'USB-кабель'], ['Прошивка', S.kb.fw ? S.kb.fw.text + ' (0x' + S.kb.fw.raw.toString(16) + ')' : 'не прочитана'],
      ['Служба драйвера', S.demo ? 'симулятор' : S.driverVer], ['Путь HID', d.path]];
    for (const [a, b] of rows) t.append(h('dt', {}, a), h('dd', {}, b));
  }

  /* ---------------- журнал ---------------- */
  $('#logOn').addEventListener('change', (e) => (S.logOn = e.target.checked));
  $('#btnLogClear').addEventListener('click', () => { logLines.length = 0; renderLog(); });
  $('#btnLogCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(logLines.map((l) => l.line).join('\n')); toast('Журнал скопирован', 'ok'); } catch (e) { toast('Не удалось скопировать', 'bad'); }
  });

  window.__Q75 = S;
  updateDevStatus(); updateEmpty(); connectDriver();
})();

// Выпадающий список устройств в стиле приложения. Родной <select id="devSel"> остаётся источником правды:
// меню читает его пункты и при выборе ставит value и шлёт change, логика app.js не меняется.
(() => {
  const sel = document.getElementById('devSel');
  if (!sel) return;
  const pick = sel.closest('.dev-pick');
  const svg = (d) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'dp-btn'; btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = '<span class="dp-val"></span>' + svg('<path d="m6 9 6 6 6-6"/>');
  const menu = document.createElement('div');
  menu.className = 'menu dp-menu'; menu.setAttribute('role', 'listbox'); menu.hidden = true;
  pick.classList.add('dp-on');
  pick.append(btn, menu);
  const val = btn.querySelector('.dp-val');
  const sync = () => {
    const o = sel.options[sel.selectedIndex];
    val.textContent = o ? o.textContent : '';
    btn.title = val.textContent;
  };
  const build = () => {
    menu.innerHTML = '';
    let prevKind = null;
    for (const o of sel.options) {
      const kind = o.value.startsWith('demo:') ? 'demo' : o.value === 'all' ? 'all' : 'dev';
      if (prevKind && kind !== prevKind) menu.append(Object.assign(document.createElement('div'), { className: 'menu-sep' }));
      prevKind = kind;
      const b = document.createElement('button');
      b.type = 'button'; b.setAttribute('role', 'option'); b.dataset.v = o.value;
      const on = o.value === sel.value && kind !== 'all';
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      if (!o.value) b.disabled = true;
      b.innerHTML = `<span class="dp-check">${on ? svg('<path d="M20 6 9 17l-5-5"/>') : ''}</span><span class="dp-t"></span>`;
      b.querySelector('.dp-t').textContent = o.textContent;
      menu.append(b);
    }
  };
  const items = () => [...menu.querySelectorAll('button:not(:disabled)')];
  const close = (focus) => { if (menu.hidden) return; menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); if (focus) btn.focus(); };
  const open = () => {
    build(); menu.hidden = false; btn.setAttribute('aria-expanded', 'true');
    (menu.querySelector('[aria-selected=true]') || items()[0])?.focus();
  };
  btn.addEventListener('click', (e) => { e.preventDefault(); menu.hidden ? open() : close(); });
  btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); } });
  menu.addEventListener('click', (e) => {
    e.preventDefault();
    const b = e.target.closest('button[data-v]');
    if (!b || b.disabled) return;
    close(true);
    if (b.dataset.v === sel.value && b.dataset.v !== 'all') return;
    sel.value = b.dataset.v;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    sync(); setTimeout(sync, 0);
  });
  menu.addEventListener('keydown', (e) => {
    const list = items(), i = list.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); close(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === 'Tab') close();
  });
  document.addEventListener('pointerdown', (e) => { if (!pick.contains(e.target)) close(); });
  new MutationObserver(() => { sync(); if (!menu.hidden) build(); }).observe(sel, { childList: true, subtree: true, characterData: true });
  sel.addEventListener('change', () => setTimeout(sync, 0));
  sync();
})();
