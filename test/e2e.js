// Сквозной тест: настоящий HTML (file://) -> gRPC-web -> мок iot_driver -> симулятор прошивки
const { chromium } = require('playwright');
const path = require('path');
const server = require('./mock_iot_driver.js');
const SHOTS = path.join(require('os').tmpdir(), 'q75-e2e');
require('fs').mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };

(async () => {
  await new Promise((r) => server.listen(3814, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const url = process.env.Q75_URL || ('file://' + path.resolve(__dirname, '../dist/FLEsportsStudio.html'));
  await page.goto(url);
  const kb = server.kb;

  console.log('1. Подключение');
  await page.waitForFunction(() => window.__Q75 && window.__Q75.kb && window.__Q75.mx.base, null, { timeout: 15000 });
  await sleep(300);
  assert(await page.textContent('#drvText') === 'Служба mock-1.0', 'служба найдена');
  assert((await page.textContent('#navFoot')).includes('Q75'), 'клавиатура определена: ' + await page.textContent('#navFoot'));
  assert((await page.textContent('#navFoot')).includes('1.07'), 'прошивка прочитана');
  await page.screenshot({ path: path.join(SHOTS, 'shot_light.png'), fullPage: true });

  console.log('2. Подсветка');
  await page.click('#effectBtn');
  await page.click('.effect:has(span:text-is("Волна"))');
  await page.click('#opts button:has-text("Вверх")');
  await page.locator('#bright').fill('2');
  await page.locator('#bright').dispatchEvent('input');
  await sleep(1800);
  assert(kb.light[1] === 4, 'режим Волна записан (mode=4), сейчас ' + kb.light[1]);
  assert(kb.light[3] === 2, 'яркость 2');
  assert((kb.light[4] >> 4) === 3, 'направление вверх (бит-поле 3)');
  await page.click('#swatches .sw[title="Зелёный"]');
  await sleep(1500);
  assert(kb.light[5] === 0 && kb.light[6] === 255 && kb.light[7] === 0, 'цвет зелёный: ' + kb.light.slice(5, 8));
  assert((kb.light[4] & 15) === 7, 'режим «свой цвет»');

  console.log('3. Переназначение клавиш');
  await page.click('nav button[data-page=keys]');
  await sleep(300);
  // Caps Lock = колонка 0, ряд 3 -> ячейка 3
  await page.click('#kbKeys .key[data-i="3"]');
  await page.click('#pickBody .chip:has-text("Esc")');
  assert(await page.isEnabled('#btnWrite'), 'кнопка «Записать» активна');
  await page.screenshot({ path: path.join(SHOTS, 'shot_keys.png'), fullPage: true });
  await page.click('#btnWrite');
  await page.waitForFunction(() => document.querySelector('#toasts').textContent.includes('проверена'), null, { timeout: 15000 });
  assert(kb.base[3 * 4 + 2] === 41, 'Caps Lock -> Esc записан в прошивку');
  assert(kb.base[0 * 4 + 2] === 41, 'остальные клавиши не тронуты (Esc на месте)');
  // F1 = колонка 2, ряд 0 -> ячейка 12
  await page.click('#kbKeys .key[data-i="12"]');
  await page.click('#pickTabs button:text-is("Медиа")');
  await page.click('#pickBody .chip:has-text("Воспр./пауза")');
  await page.click('#btnWrite');
  await page.waitForFunction(() => document.querySelector('#busy').hidden, null, { timeout: 15000 });
  await sleep(300);
  assert(kb.base[12 * 4] === 3 && kb.base[12 * 4 + 2] === 205, 'F1 -> Play/Pause');
  // Слой Fn
  await page.click('#layerSeg button[data-l=fn]');
  await page.click('#kbKeys .key[data-i="8"]'); // Q
  await page.click('#pickTabs button:text-is("Клавиши")');
  await page.click('#pickBody .chip:text-is("F5")');
  await page.click('#btnWrite');
  await page.waitForFunction(() => document.querySelector('#busy').hidden, null, { timeout: 15000 });
  await sleep(300);
  assert(kb.fn[8 * 4 + 2] === 62, 'Fn+Q -> F5 записан в слой Fn');
  assert(kb.base[8 * 4 + 2] === 20, 'основной слой Q не изменился');

  console.log('4. Настройки');
  await page.click('nav button[data-page=settings]');
  await page.click('#rateSeg button:has-text("500")');
  await page.waitForFunction(() => document.querySelector('#busy').hidden, null, { timeout: 15000 });
  assert(kb.rate === 2, 'частота 500 Гц (код 2)');
  await page.locator('#deb').fill('8'); await page.locator('#deb').dispatchEvent('change');
  await sleep(900);
  assert(kb.debounce === 8, 'антидребезг 8 мс');
  await page.click('label.switch:has(#optWin)');
  await sleep(500);
  assert((kb.opt[0] & 1) === 1, 'блокировка Win включена');
  await page.fill('#slBt', '15'); await page.click('#btnSleep');
  await page.waitForFunction(() => document.querySelector('#busy').hidden, null, { timeout: 15000 });
  assert(kb.sleep.bt === 900, 'сон BT 15 мин');
  await page.screenshot({ path: path.join(SHOTS, 'shot_settings.png'), fullPage: true });

  console.log('5. Контрольные суммы и формат пакетов');
  const bad = server.traffic.filter((t) => t.data[0] === 9 || t.data[0] === 16).filter((t) => {
    let s = 0; for (let i = 0; i < 7; i++) s += t.data[i]; return t.data[7] !== 255 - (s & 255);
  });
  assert(bad.length === 0, 'все пакеты раскладки с верной контрольной суммой');
  assert(server.traffic.every((t) => t.data.length === 64), 'все пакеты по 64 байта');
  assert(server.traffic.filter((t) => t.data[0] === 7).every((t) => t.cks === 1), 'подсветка отправляется с BIT8');


  console.log('7. Макросы');
  await page.click('.rail button[data-page=macros]');
  await page.click('#btnNewMacro');
  await page.fill('#macroName', 'Привет');
  await page.click('#btnRec');
  await page.keyboard.down('Shift'); await page.keyboard.press('KeyH'); await page.keyboard.up('Shift');
  await page.keyboard.press('KeyI');
  await page.click('#btnRec');
  const evCount = await page.$$eval('#eventList .ev:not(.delay)', (x) => x.length);
  assert(evCount === 6, 'записано 6 шагов нажатий (Shift, H, I): ' + evCount);
  await page.click('#btnSaveMacro');
  await page.waitForFunction(() => document.querySelector('#toasts').textContent.includes('Макрос записан'), null, { timeout: 15000 });
  const dec = (() => { const buf = kb.macros.slice(0, 256); return buf; })();
  const vmctx = require('vm'); const fs = require('fs');
  const c2 = {}; vmctx.createContext(Object.assign(c2, { TextEncoder, TextDecoder, Uint8Array, DataView, Math, Object, Array, Number, String, Error, Promise, setTimeout }));
  vmctx.runInContext(['defaults.js','core.js'].map((f) => fs.readFileSync(path.join(__dirname,'../src',f),'utf8')).join('\n') + ';this.Q=Q75;', c2);
  const m = c2.Q.decodeMacro(dec);
  const keys = m.events.filter((e) => e.type === 'keyboard').map((e) => e.action[0] + e.value).join(' ');
  assert(keys === 'd225 d11 u11 u225 d12 u12', 'макрос в прошивке: ' + keys);
  assert(m.events.some((e) => e.type === 'delay'), 'паузы между нажатиями сохранены');
  await page.click('#btnAssignMacro');
  await page.click('#layerSeg button[data-l=base]');
  await page.click('#kbKeys .key[data-i="18"]');
  await page.click('#pickBody .seg button:text-is("Пока нажата")');
  await page.click('#pickBody .macro-pick .chip:has-text("Привет")');
  await page.click('#btnWrite');
  await page.waitForFunction(() => document.querySelector('#toasts').textContent.includes('проверена'), null, { timeout: 15000 });
  assert(kb.base[18 * 4] === 9 && kb.base[18 * 4 + 1] === 2 && kb.base[18 * 4 + 2] === 0, 'F2 -> макрос №1, режим «пока нажата»: ' + Array.from(kb.base.slice(72, 76)));
  assert((await page.textContent('#kbKeys .key[data-i="18"]')).toUpperCase().includes('ПРИВЕТ'), 'на кейкапе показано имя макроса');
  await page.click('.rail button[data-page=macros]'); await sleep(300);
  const chip = await page.textContent('#macroList .macro-item .kchip');
  assert(chip.includes('F2') && chip.includes('пока нажата'), 'в списке макросов видно клавишу и режим: ' + chip);

  console.log('6. Сброс');
  await page.click('.rail button[data-page=settings]');
  await page.click('#btnReset');
  await page.click('#dlgOk');
  await page.waitForFunction(() => document.querySelector('#toasts').textContent.includes('сброшена'), null, { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('#busy').hidden, null, { timeout: 20000 });
  assert(kb.base[3 * 4 + 2] === 57, 'после сброса Caps Lock снова Caps Lock');

  await page.click('nav button[data-page=log]');
  await sleep(200);
  await page.screenshot({ path: path.join(SHOTS, 'shot_log.png') });
  assert(errors.length === 0, 'нет ошибок JS в консоли ' + JSON.stringify(errors));
  console.log('\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
  await browser.close(); server.close(); process.exit(0);
})().catch(async (e) => { console.error(e); process.exit(1); });
