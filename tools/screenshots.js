#!/usr/bin/env node
'use strict';
// Скриншоты и GIF для README — с настоящего интерфейса, клавиатура не нужна.
// Страница работает с симулятором (test/mock_iot_driver.js) и открывается по
// http://127.0.0.1:38590, поэтому настоящая служба iot_driver на :3814 не затрагивается.
//
//   python build.py
//   node tools/screenshots.js                       # все сцены
//   node tools/screenshots.js --only=keys,music     # выборочно
//
// CHROME=<путь>  Chrome/Edge (по умолчанию ищется сам)
// EXT_CHROME=1   подключиться к уже запущенному браузеру с --remote-debugging-port=9333 (порт меняется через CDP_PORT)
// FFMPEG=<путь>  ffmpeg для сборки GIF (по умолчанию берётся из PATH)
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const opt = (k) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : null; };
const OUT = path.resolve(opt('out') || path.join(ROOT, 'docs', 'screenshots'));
const TMP = path.join(os.tmpdir(), 'q75shots');
const PROFILE = path.join(TMP, 'prof-' + Date.now()); // чистый профиль на каждый запуск
const ONLY = opt('only') ? opt('only').split(',') : null;
const W = 1440, H = 900, PORT = 38590, DBG = +(process.env.CDP_PORT || 9333), FPS = 15, SECONDS = 4;
const CHROME = process.env.CHROME || [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HTML = path.join(ROOT, 'dist', 'FLEsportsStudio.html');
if (!fs.existsSync(HTML)) { console.error('Нет dist/FLEsportsStudio.html — сначала выполните: python build.py'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

// Мок службы — тот же, что в тестах, но с нейтральной версией в шапке.
const mf = path.join(ROOT, 'test', 'mock_iot_driver.js');
const mod = new Module(mf, module);
mod.filename = mf; mod.paths = Module._nodeModulePaths(path.dirname(mf));
mod._compile(fs.readFileSync(mf, 'utf8').replace("'mock-1.0'", "'iot_driver'"), mf);
const mock = mod.exports;
const mockHandler = mock.listeners('request')[0];

// «Своя схема» в симуляторе: градиент вместо заводской заливки.
function hsl(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}
if (mock.kb && mock.kb.pics) for (let i = 0; i < 128; i++) mock.kb.pics[0].set(hsl((185 + Math.floor(i / 6) * 7.5 + (i % 6) * 5) % 360, 0.95, 0.5), i * 3);

// /api/stream лаунчера: «поток идёт», 30 кадров/с.
const t0 = Date.now();
let liveMode = '';
const liveState = () => ({ mode: liveMode, live: !!liveMode, frames: Math.floor((Date.now() - t0) * 0.03), audio: 'ok', errors: 0 });
const page = fs.readFileSync(HTML);
const ico = fs.readFileSync(path.join(ROOT, 'launcher', 'icon.ico'));
const srv = http.createServer((req, res) => {
  if (req.url.startsWith('/driver.DriverGrpc/')) return mockHandler(req, res);
  if (req.url === '/__alive') { res.writeHead(204); return res.end(); }
  if (req.url === '/favicon.ico') { res.writeHead(200, { 'Content-Type': 'image/x-icon' }); return res.end(ico); }
  if (req.url.startsWith('/api/stream')) {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      if (b) { try { const j = JSON.parse(b); if ('mode' in j) liveMode = j.mode || ''; } catch (e) { /* пусто */ } }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(liveState()));
    });
    return;
  }
  if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(page); }
  res.writeHead(404); res.end();
});

// Помощники внутри страницы.
function pageHelpers() {
  const sl = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__H = {
    async effect(name) {
      const pop = document.querySelector('#effectPop');
      if (pop.hidden) document.querySelector('#effectBtn').click();
      await sl(400);
      const e = Array.from(document.querySelectorAll('.effect')).find((x) => Array.from(x.querySelectorAll('span')).some((s) => s.textContent.trim() === name));
      if (!e) return 'НЕТ ЭФФЕКТА: ' + name;
      e.click(); await sl(400);
      if (!pop.hidden) document.querySelector('#effectBtn').click();
      await sl(200);
      return 'эффект: ' + name;
    },
    rainbow(on) { const r = document.querySelector('#rainbow'); if (r && !r.disabled && r.checked !== on) r.click(); return r ? r.checked : null; },
    range(id, v) { const r = document.querySelector('#' + id); if (!r) return null; r.value = String(v); r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); return r.value; },
    page(p) { document.querySelector('nav button[data-page="' + p + '"]').click(); return 'страница: ' + p; },
    click(sel) { const e = document.querySelector(sel); if (!e) return 'НЕТ ' + sel; e.click(); return 'клик ' + sel; },
    clickText(sel, t) { const e = Array.from(document.querySelectorAll(sel)).find((x) => x.textContent.trim() === t); if (!e) return 'НЕТ ' + sel + ' ' + t; e.click(); return 'клик ' + t; },
    setVal(sel, v) { const e = document.querySelector(sel); if (!e) return 'НЕТ ' + sel; e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; },
    text(sel) { const e = document.querySelector(sel); return e ? e.textContent.trim().replace(/\s+/g, ' ').slice(0, 200) : null; },
    stageBox() {
      const k = document.querySelector('#kbStage');
      const s = k.closest('.stage') || k.parentElement;
      const kb = k.getBoundingClientRect(), sb = s.getBoundingClientRect();
      const t = s.querySelector('h1, h2');
      const top = t ? t.getBoundingClientRect().y : kb.y;
      return { x: sb.x, y: Math.max(0, Math.min(top, kb.y) - 18), w: sb.width, bottom: kb.y + kb.height + 14 };
    },
    macro(name) {
      const S = window.__Q75, m = S.macros && S.macros[S.macroSel];
      if (!m) return 'НЕТ МАКРОСА';
      const hid = { ControlLeft: 224, KeyC: 6, KeyV: 25 };
      const seq = [['ControlLeft', 'down'], 60, ['KeyC', 'down'], 45, ['KeyC', 'up'], 40, ['ControlLeft', 'up'], 350, ['ControlLeft', 'down'], 60, ['KeyV', 'down'], 45, ['KeyV', 'up'], 40, ['ControlLeft', 'up']];
      m.events = seq.map((s) => (typeof s === 'number' ? { type: 'delay', value: s } : { type: 'keyboard', action: s[1], value: hid[s[0]] }));
      m.dirty = true;
      const n = document.querySelector('#macroName');
      n.value = name; n.dispatchEvent(new Event('input', { bubbles: true })); n.dispatchEvent(new Event('change', { bubbles: true }));
      const it = document.querySelector('#macroList .macro-item[aria-selected="true"]');
      if (it) it.click();
      return 'шагов: ' + m.events.length;
    },
  };
  return 'helpers ok';
}

(async () => {
  await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));
  let ch = null;
  if (!process.env.EXT_CHROME) {
    if (!CHROME) throw new Error('Не найден Chrome/Edge — укажите CHROME=<путь>');
    ch = cp.spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + DBG, '--user-data-dir=' + PROFILE, '--window-size=' + W + ',' + H, '--hide-scrollbars', '--force-device-scale-factor=1', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  }
  let list = null;
  for (let i = 0; i < 60 && !list; i++) { try { list = await (await fetch('http://127.0.0.1:' + DBG + '/json/list')).json(); } catch (e) { await sleep(250); } }
  if (!list) throw new Error('Браузер не отвечает на порту ' + DBG);
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let seq = 0;
  const pend = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pend.has(msg.id)) { const p = pend.get(msg.id); pend.delete(msg.id); if (msg.error) p.j(new Error(JSON.stringify(msg.error))); else p.r(msg.result); }
    else if (msg.method === 'Page.javascriptDialogOpening') { console.log('диалог:', msg.params.message); send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); }
    else if (msg.method === 'Runtime.exceptionThrown') { const d = msg.params.exceptionDetails; console.log('ОШИБКА СТРАНИЦЫ:', (d.exception && d.exception.description) || d.text); }
  };
  const send = (method, params) => new Promise((r, j) => {
    const i = ++seq;
    pend.set(i, { r, j });
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); j(new Error('браузер не ответил за 30 с: ' + method)); } }, 30000);
  });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('eval: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text)); return r.result.value; };
  const h = (call) => ev('window.__H.' + call);
  const say = async (p) => console.log('  ' + (await p));
  const shot = async (name, clip) => {
    const r = await send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
    console.log('снимок ' + name + '.png');
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' });
  for (let i = 0; i < 100; i++) { if (await ev('!!(window.__Q75 && window.__Q75.kb && window.__Q75.mx && window.__Q75.mx.base)')) break; await sleep(200); }
  await sleep(1500);
  console.log('страница загружена');
  await say(ev('(' + pageHelpers.toString() + ')()'));

  const scenes = {
    async lighting() { await say(h("effect('Волна')")); await h('rainbow(true)'); await h("range('bright', 4)"); await sleep(3000); await shot('lighting'); },
    async effects() { await h("click('#effectBtn')"); await sleep(1200); await shot('effects'); await h("click('#effectBtn')"); await sleep(400); },
    async 'custom-scheme'() { await say(h("effect('Своя схема (из памяти)')")); await sleep(3000); await shot('custom-scheme'); },
    async music() { await say(h("effect('Под музыку')")); await h('rainbow(true)'); await h("range('bright', 4)"); await sleep(3500); await say(h("text('#liveState')")); await shot('music'); },
    async settings() { await say(h("page('settings')")); await sleep(1200); await shot('settings'); await h("page('light')"); await sleep(600); },
    async macros() {
      await say(h("page('macros')"));
      // макросы читаются с клавиатуры асинхронно — ждём список
      for (let i = 0; i < 80; i++) { if (await ev('!!window.__Q75.macros')) break; await sleep(250); }
      await sleep(400);
      await say(h("click('#btnNewMacro')"));
      for (let i = 0; i < 80; i++) { if (await ev('window.__Q75.macroSel != null')) break; await sleep(250); }
      await sleep(500);
      await say(h("macro('Копировать и вставить')")); await sleep(700);
      await shot('macros'); await h("page('light')"); await sleep(600);
    },
    async keys() {
      await say(h("page('keys')")); await sleep(1200);
      await say(h("click('#kbKeys .key[data-i=\"3\"]')")); await sleep(500);
      await say(h("clickText('#pickBody .chip', 'Esc')")); await sleep(600);
      await shot('keys'); await h("page('light')"); await sleep(600);
    },
    // GIF «Под музыку»: виртуальные часы — каждый кадр рисуется ровно на своём шаге времени.
    async 'music-gif'() {
      await say(h("effect('Под музыку')")); await h('rainbow(true)'); await sleep(2500);
      const b = await h('stageBox()');
      const clip = { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.w / 2) * 2, height: Math.round((b.bottom - b.y) / 2) * 2, scale: 1 };
      await ev("(function(){ if (window.__vt) return; const raf = window.requestAnimationFrame.bind(window), pn = performance.now.bind(performance); const v = { t: pn(), raf: raf }; const t0 = v.t, d0 = Date.now(); performance.now = function(){ return v.t; }; Date.now = function(){ return Math.round(d0 + v.t - t0); }; window.requestAnimationFrame = function(cb){ return raf(function(){ cb(v.t); }); }; window.__vt = v; })()");
      const fdir = path.join(TMP, 'frames');
      fs.rmSync(fdir, { recursive: true, force: true }); fs.mkdirSync(fdir, { recursive: true });
      const n = FPS * SECONDS;
      for (let k = 0; k < n; k++) {
        await ev('new Promise(function(r){ window.__vt.t += ' + (1000 / FPS) + '; window.__vt.raf(function(){ window.__vt.raf(function(){ r(1); }); }); })');
        const r = await send('Page.captureScreenshot', { format: 'png', clip });
        fs.writeFileSync(path.join(fdir, 'f' + String(k).padStart(4, '0') + '.png'), Buffer.from(r.data, 'base64'));
      }
      console.log('кадров GIF: ' + n + ', область ' + clip.width + '×' + clip.height);
      const ff = process.env.FFMPEG || 'ffmpeg';
      const gif = path.join(OUT, 'music.gif');
      const args = ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(fdir, 'f%04d.png'), '-vf', 'scale=800:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle', '-loop', '0', gif];
      const r = cp.spawnSync(ff, args, { stdio: 'inherit' });
      if (r.status === 0) console.log('GIF: ' + gif + ' (' + Math.round(fs.statSync(gif).size / 1024) + ' КБ)');
      else console.log('ffmpeg не запустился — соберите GIF вручную:\n  ffmpeg ' + args.map((a) => (/[ ;\[]/.test(a) ? '"' + a + '"' : a)).join(' '));
    },
  };
  for (const [name, fn] of Object.entries(scenes)) if (!ONLY || ONLY.includes(name)) { console.log('— ' + name); await fn(); }
  ws.close();
  if (ch) ch.kill();
  srv.close();
  setTimeout(() => process.exit(0), 300);
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
