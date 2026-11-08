/*
 * FL Esports Studio — ядро протокола.
 *
 * Транспорт: локальная служба iot_driver.exe из комплекта оригинального ПО
 * (gRPC-web, http://127.0.0.1:3814, сервис driver.DriverGrpc). Служба только
 * передаёт 64-байтные HID feature-отчёты и считает контрольные суммы. Весь
 * протокол клавиатуры (команды, форматы, раскладки) реализован здесь заново.
 *
 * Работает и в браузере, и в Node.js (для тестов).
 */

/* ------------------------------------------------------------------ */
/* Protobuf: минимальный кодек под сообщения driver.proto              */
/* ------------------------------------------------------------------ */
const PB = {
  varint(n) {
    const out = [];
    if (n < 0) {
      // int32/enum с отрицательным значением -> 10 байт (two's complement, 64 бит)
      let lo = n >>> 0, hi = 0xffffffff;
      for (let i = 0; i < 9; i++) {
        out.push((lo & 0x7f) | 0x80);
        lo = (lo >>> 7) | ((hi & 0x7f) << 25);
        hi = hi >>> 7;
      }
      out.push(1);
      return out;
    }
    while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
    out.push(n);
    return out;
  },
  tag(field, wire) { return PB.varint((field << 3) | wire); },
  encode(fields) {
    // fields: [[номер, тип, значение]], тип: 'string' | 'bytes' | 'enum' | 'bool' | 'msg'
    const out = [];
    for (const [no, type, val] of fields) {
      if (val === undefined || val === null) continue;
      if (type === 'string' || type === 'bytes' || type === 'msg') {
        const data = type === 'string' ? Array.from(new TextEncoder().encode(val)) : Array.from(val);
        if (type !== 'msg' && data.length === 0) continue;
        out.push(...PB.tag(no, 2), ...PB.varint(data.length), ...data);
      } else {
        const v = type === 'bool' ? (val ? 1 : 0) : val;
        if (v === 0) continue; // proto3: значения по умолчанию не пишутся
        out.push(...PB.tag(no, 0), ...PB.varint(v));
      }
    }
    return new Uint8Array(out);
  },
  decode(buf) {
    // -> {номер: [значения]}; varint -> Number (младшие 32 бита со знаком в .s32)
    const res = {};
    let p = 0;
    const rd = () => {
      let lo = 0, shift = 0, b, big = 0, i = 0;
      do {
        b = buf[p++];
        if (i < 5) lo += (b & 0x7f) * Math.pow(2, shift); else big = 1;
        shift += 7; i++;
      } while (b & 0x80);
      return { n: lo, s32: (lo >>> 0) | 0, big };
    };
    while (p < buf.length) {
      const t = rd().n, no = Math.floor(t / 8), wire = t & 7;
      let v;
      if (wire === 0) { const x = rd(); v = x; }
      else if (wire === 2) { const len = rd().n; v = buf.subarray(p, p + len); p += len; }
      else if (wire === 5) { v = buf.subarray(p, p + 4); p += 4; }
      else if (wire === 1) { v = buf.subarray(p, p + 8); p += 8; }
      else throw new Error('protobuf: неизвестный wire type ' + wire);
      (res[no] = res[no] || []).push(v);
    }
    return res;
  },
  str(v) { return v ? new TextDecoder().decode(v) : ''; },
};

/* ------------------------------------------------------------------ */
/* gRPC-web клиент (бинарный формат, fetch)                            */
/* ------------------------------------------------------------------ */
// Если интерфейс открыт из FL Esports Studio.exe (http://127.0.0.1:<порт>), запросы идут через встроенный прокси на том же адресе.
const DRIVER_BASE = (typeof location !== 'undefined' && location.protocol === 'http:' && location.hostname === '127.0.0.1' && location.port && location.port !== '3814')
  ? location.origin : 'http://127.0.0.1:3814';
const HOSTED = DRIVER_BASE !== 'http://127.0.0.1:3814';
if (HOSTED && typeof setInterval !== 'undefined') { const ping = () => fetch('/__alive').catch(() => {}); ping(); setInterval(ping, 5000); }

class GrpcWeb {
  constructor(base = DRIVER_BASE, service = 'driver.DriverGrpc') {
    this.base = base; this.service = service;
  }
  static frame(msg) {
    const out = new Uint8Array(5 + msg.length);
    out[0] = 0; new DataView(out.buffer).setUint32(1, msg.length);
    out.set(msg, 5);
    return out;
  }
  headers() {
    return { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1', 'accept': 'application/grpc-web+proto' };
  }
  // Разбирает поток кадров; onMessage вызывается на каждый data-кадр.
  async _pump(resp, onMessage) {
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const hs = resp.headers.get('grpc-status');
    if (hs && hs !== '0') throw new Error('gRPC ' + hs + ' ' + decodeURIComponent(resp.headers.get('grpc-message') || ''));
    const reader = resp.body.getReader();
    let buf = new Uint8Array(0);
    for (;;) {
      const { value, done } = await reader.read();
      if (value) { const n = new Uint8Array(buf.length + value.length); n.set(buf); n.set(value, buf.length); buf = n; }
      while (buf.length >= 5) {
        const len = new DataView(buf.buffer, buf.byteOffset).getUint32(1);
        if (buf.length < 5 + len) break;
        const flag = buf[0], payload = buf.slice(5, 5 + len);
        buf = buf.slice(5 + len);
        if (flag & 0x80) {
          const trailers = new TextDecoder().decode(payload);
          const m = /grpc-status:\s*(\d+)/i.exec(trailers);
          if (m && m[1] !== '0') {
            const mm = /grpc-message:\s*([^\r\n]*)/i.exec(trailers);
            throw new Error('gRPC ' + m[1] + ' ' + decodeURIComponent(mm ? mm[1] : ''));
          }
        } else if (onMessage(payload) === false) { try { await reader.cancel(); } catch (e) {} return; }
      }
      if (done) return;
    }
  }
  async unary(method, msg, timeoutMs = 4000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const resp = await fetch(`${this.base}/${this.service}/${method}`, {
        method: 'POST', headers: this.headers(), body: GrpcWeb.frame(msg), signal: ctl.signal,
      });
      let result = null;
      await this._pump(resp, (p) => { result = p; return false; });
      if (result === null) result = new Uint8Array(0);
      return result;
    } finally { clearTimeout(t); }
  }
  // Серверный поток. Возвращает функцию отмены.
  stream(method, msg, onMessage, onEnd) {
    const ctl = new AbortController();
    (async () => {
      try {
        const resp = await fetch(`${this.base}/${this.service}/${method}`, {
          method: 'POST', headers: this.headers(), body: GrpcWeb.frame(msg), signal: ctl.signal,
        });
        await this._pump(resp, onMessage);
        onEnd && onEnd(null);
      } catch (e) { onEnd && onEnd(ctl.signal.aborted ? null : e); }
    })();
    return () => ctl.abort();
  }
}

/* ------------------------------------------------------------------ */
/* Клиент службы iot_driver                                            */
/* ------------------------------------------------------------------ */
const CheckSum = { BIT7: 0, BIT8: 1, NONE: 2 };
const DangleType = { NONE: 0, KEYBOARD: 1, MOUSE: 2 };
const ListChange = { INIT: 0, ADD: 1, REMOVE: 2, CHANGE: 3 };

class IotDriver {
  constructor(base) { this.rpc = new GrpcWeb(base); this.log = () => {}; }

  async getVersion() {
    const r = PB.decode(await this.rpc.unary('getVersion', new Uint8Array(0), 1500));
    return { version: PB.str(r[1] && r[1][0]), timestamp: PB.str(r[2] && r[2][0]) };
  }

  async sendMsg(path, bytes, checksum = CheckSum.NONE, dangle = DangleType.NONE) {
    const body = PB.encode([[1, 'string', path], [2, 'bytes', bytes], [3, 'enum', checksum], [4, 'enum', dangle]]);
    this.log('tx', bytes, checksum);
    const r = PB.decode(await this.rpc.unary('sendMsg', body));
    const err = PB.str(r[1] && r[1][0]);
    if (err) { this.log('err', err); return false; }
    return true;
  }

  async readMsg(path) {
    const r = PB.decode(await this.rpc.unary('readMsg', PB.encode([[1, 'string', path]])));
    const err = PB.str(r[1] && r[1][0]);
    if (err) { this.log('err', 'read: ' + err); return undefined; }
    const msg = r[2] ? new Uint8Array(r[2][0]) : new Uint8Array(0);
    this.log('rx', msg);
    return msg;
  }

  static parseDevice(d) {
    const g = (k, f = 'n') => (d[k] ? d[k][0][f] : 0);
    return {
      kind: 'dev', devtype: g(1), is24: !!g(2), path: PB.str(d[3] && d[3][0]), id: g(4, 's32'),
      battery: g(5), online: !!g(6), vid: g(7), pid: g(8),
    };
  }
  static parseDangle(d) {
    const status = (raw) => {
      if (!raw) return null;
      const s = PB.decode(raw[0]);
      if (!s[2]) return { online: false, battery: 0 };
      const st = PB.decode(s[2][0]);
      return { battery: st[1] ? st[1][0].n : 0, online: !!(st[2] && st[2][0].n) };
    };
    return {
      kind: 'dangle', keyboard: status(d[1]), mouse: status(d[2]), path: PB.str(d[3] && d[3][0]),
      keyboardId: d[5] ? d[5][0].n : 0, mouseId: d[6] ? d[6][0].n : 0, vid: d[7] ? d[7][0].n : 0, pid: d[8] ? d[8][0].n : 0,
    };
  }
  static parseDeviceList(buf) {
    const r = PB.decode(buf);
    const list = (r[1] || []).map((raw) => {
      const dj = PB.decode(raw);
      if (dj[1]) return IotDriver.parseDevice(PB.decode(dj[1][0]));
      if (dj[2]) return IotDriver.parseDangle(PB.decode(dj[2][0]));
      return null;
    }).filter(Boolean);
    return { type: r[2] ? r[2][0].n : ListChange.INIT, list };
  }

  // Подписка на список устройств. cb(events) на каждое изменение.
  watchDevices(cb, onEnd) {
    return this.rpc.stream('watchDevList', new Uint8Array(0), (p) => { cb(IotDriver.parseDeviceList(p)); }, onEnd);
  }
}

/* ------------------------------------------------------------------ */
/* Модели                                                               */
/* ------------------------------------------------------------------ */
// id из официальной базы устройств «腹灵 (F. L)». Отрицательные id — подключение через 2.4G-приёмник.
const MODELS = {
  335: 'std', 403: 'std', [-2147483245]: 'std', [-2147483313]: 'std',
  541: 'knob', [-2147483107]: 'knob',
  775: 'soc', [-2147484423]: 'soc',
};
const MODEL_INFO = {
  std: { title: 'FL·ESPORTS Q75', chip: 'yc200_k232', supported: true },
  knob: { title: 'FL·ESPORTS Q75 (с крутилкой)', chip: 'yc300_k239', supported: true },
  soc: { title: 'FL·ESPORTS Q75 (SOC-ревизия)', chip: 'yc500_k239_soc', supported: false },
};

/* ------------------------------------------------------------------ */
/* Протокол Q75 (семейство Rongyuan yc200/yc300)                       */
/* ------------------------------------------------------------------ */
const CMD = {
  SET_RESET: 2, SET_REPORT: 4, GET_REPORT: 132, SET_KBOPTION: 6, GET_KBOPTION: 134,
  SET_LEDPARAM: 7, GET_LEDPARAM: 135, SET_KEYMATRIX: 9, GET_KEYMATRIX: 137,
  SET_FN: 16, GET_FN: 144, SET_DEBOUNCE: 17, GET_DEBOUNCE: 145,
  SET_SLEEPTIME: 18, GET_SLEEPTIME: 146, GET_REV: 128,
  SET_MACRO: 11, GET_MACRO: 139,
  SET_USERPIC: 12, GET_USERPIC: 140,
};
const USERPIC_BYTES = 384; // 128 ячеек матрицы × RGB; ячейка = col*6+row

const MAXSPEED = 4;
const COLOR_RAINBOW = 8; // «DAZZLE» — радужный режим
const COLOR_CUSTOM = 7;  // свой цвет из байтов r,g,b
const PRESET_COLORS = { 0: 0xff0000, 1: 0xff8000, 2: 0xffff00, 3: 0x00ff00, 4: 0x00ffff, 5: 0x0000ff, 6: 0xff00ff };
const WHITE_FIX = 16449530; // драйвер подменяет 0xFFFFFF на это значение

// mode — номер эффекта в прошивке; opt — список вариантов (значение = бит 4 байта флагов)
const LIGHT_MODES = [
  { id: 'LightOff', mode: 0, name: 'Выключено', bright: false, speed: false, color: false },
  { id: 'LightAlwaysOn', mode: 1, name: 'Статичный', speed: false },
  { id: 'LightBreath', mode: 2, name: 'Дыхание' },
  { id: 'LightNeon', mode: 3, name: 'Неон', color: false },
  { id: 'LightWave', mode: 4, name: 'Волна', opts: [['right', 'Вправо'], ['left', 'Влево'], ['down', 'Вниз'], ['up', 'Вверх']], optShift: { right: 0, left: 1, down: 2, up: 3 } },
  { id: 'LightRipple', mode: 5, name: 'Рябь' },
  { id: 'LightRaindrop', mode: 6, name: 'Капли' },
  { id: 'LightSnake', mode: 7, name: 'Змейка', opts: [['z', 'Зигзаг'], ['return', 'Возврат']], optShift: { z: 0, return: 1 } },
  { id: 'LightPressAction', mode: 8, name: 'Реакция на нажатие' },
  { id: 'LightConverage', mode: 9, name: 'Схождение' },
  { id: 'LightSineWave', mode: 10, name: 'Синусоида' },
  { id: 'LightKaleidoscope', mode: 11, name: 'Калейдоскоп', opts: [['out', 'Наружу'], ['in', 'Внутрь']], optShift: { out: 0, in: 1 } },
  { id: 'LightLineWave', mode: 12, name: 'Линейная волна', opts: [['right', 'Вправо'], ['left', 'Влево']], optShift: { right: 0, left: 1 } },
  { id: 'LightUserPicture', mode: 13, name: 'Своя схема (из памяти)', speed: false, color: false, opts: [['1', 'Схема 1'], ['2', 'Схема 2'], ['3', 'Схема 3']], userPic: true },
  { id: 'LightLaser', mode: 14, name: 'Лазер' },
  { id: 'LightCircleWave', mode: 15, name: 'Круговая волна', opts: [['anti-clockwise', 'Против часовой'], ['clockwise', 'По часовой']], optShift: { 'anti-clockwise': 0, clockwise: 1 } },
  { id: 'LightDazzing', mode: 16, name: 'Сияние' },
  { id: 'LightRainDown', mode: 17, name: 'Дождь' },
  { id: 'LightMeteor', mode: 18, name: 'Метеор' },
  { id: 'LightPressActionOff', mode: 19, name: 'Гаснет при нажатии' },
  // живые режимы: прошивка ждёт поток кадров (0x0E — уровни звука, 0x0F — цвет экрана); его шлёт FL Esports Studio.exe
  { id: 'LightMusicFollow2', mode: 22, name: 'Под музыку', speed: false, live: 'music', music: true, opts: [['upright', 'Столбики'], ['separate', 'Раздельно'], ['intersect', 'Пересечение']], optShift: { upright: 0, separate: 1, intersect: 2 } },
  { id: 'LightScreenColor', mode: 21, name: 'Цвет экрана', bright: false, speed: false, color: false, live: 'screen', fixedValue: 4 },
].map((m) => Object.assign({ bright: true, speed: true, color: true }, m));
const USEROP = { 1: 0, 2: 16, 3: 32 };

const REPORT_RATES = { 1000: 1, 500: 2, 250: 4, 125: 8 };
const MACRO_SLOTS = 20, MACRO_MAX_BYTES = 248;
const MACRO_MODES = { 0: 'Повторить N раз', 2: 'Повторять, пока нажата', 1: 'Вкл / выкл нажатием' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rgbToInt = (r, g, b) => (r << 16) | (g << 8) | b;

class Q75 {
  /**
   * @param {IotDriver} driver
   * @param {object} dev — запись из списка устройств ({path, id, is24, kind})
   */
  constructor(driver, dev) {
    this.driver = driver;
    this.dev = dev;
    this.path = dev.path;
    this.model = MODELS[dev.id] || 'std';
    this.dangle = dev.kind === 'dangle' ? DangleType.KEYBOARD : DangleType.NONE;
    this.wireless = dev.kind === 'dangle' || dev.is24;
    this.profile = 0;
    this._q = Promise.resolve();
    this.waitDevice = null; // (ms) => Promise<dev|null>, ставит приложение
    this._lastLight = null; this._lastLightT = 0; this._giveUpT = 0;
  }

  // Все обращения к клавиатуре строго последовательно.
  _serial(fn) {
    // живой поток (музыка/экран) ставим на паузу, пока страница читает/пишет клавиатуру
    const g = () => (Q75.beforeIo ? Q75.beforeIo().catch(() => {}).then(fn) : fn());
    const p = this._q.then(g, g);
    this._q = p.catch(() => {});
    return p;
  }
  static buf(arr) { const b = new Uint8Array(64); b.set(arr.slice(0, 64)); return b; }

  async _send(bytes, checksum) {
    try { return await this.driver.sendMsg(this.path, Q75.buf(bytes), checksum, this.dangle); } catch (e) { return false; }
  }
  // После смены подсветки прошивка через ~5 с пропадает с USB на ~15 с и возвращается.
  // Запись в этот момент не роняем, а ждём, пока клавиатура вернётся (до 35 с).
  async _write(bytes, checksum = CheckSum.NONE, delay = 10) {
    await sleep(delay + (this.wireless ? 60 : 0));
    if (await this._send(bytes, checksum)) return true;
    if (!this.waitDevice || this.driver.sim || Date.now() < this._giveUpT) return false;
    const end = Date.now() + 35000;
    while (Date.now() < end) {
      const d = await this.waitDevice(end - Date.now());
      if (!d) break;
      if (d.path) this.path = d.path;
      await sleep(700);
      if (await this._send(bytes, checksum)) return true;
    }
    this._giveUpT = Date.now() + 5000;
    return false;
  }
  async _read(delay = 5) {
    await sleep(delay + (this.wireless ? 30 : 0));
    return this.driver.readMsg(this.path);
  }
  // Запрос-ответ с повтором
  async _query(bytes, checksum = CheckSum.BIT7, tries = 3) {
    for (let i = 0; i < tries; i++) {
      if (await this._write(bytes, checksum)) {
        const r = await this._read();
        if (r && r.length) return r;
      }
      await sleep(50 * (i + 1));
    }
    return undefined;
  }

  /* ---- информация ---- */
  getFirmwareVersion() {
    return this._serial(async () => {
      const r = await this._query([CMD.GET_REV]);
      if (!r) return undefined;
      const v = r[1] | (r[2] << 8);
      return { raw: v, text: (v >> 8) + '.' + (v & 0xff).toString(16).padStart(2, '0') };
    });
  }

  /* ---- подсветка ---- */
  getLight() {
    return this._serial(async () => {
      const a = await this._query([CMD.GET_LEDPARAM]);
      if (!a) return undefined;
      const mode = LIGHT_MODES.find((m) => m.mode === a[1]);
      const flags = a[4], colorMode = flags & 15, optBits = flags >> 4;
      let rgb = rgbToInt(a[5], a[6], a[7]);
      if (rgb === WHITE_FIX) rgb = 0xffffff;
      const music = !!(mode && mode.music);
      if (!music && colorMode !== COLOR_RAINBOW && colorMode !== COLOR_CUSTOM && PRESET_COLORS[colorMode] !== undefined) rgb = PRESET_COLORS[colorMode];
      const res = {
        type: mode ? mode.id : 'Unknown(' + a[1] + ')',
        brightness: a[3], speed: Math.max(0, MAXSPEED - a[2]),
        rainbow: music ? colorMode === 0 : colorMode === COLOR_RAINBOW, rgb, raw: Array.from(a.slice(0, 8)),
      };
      if (mode && mode.optShift) res.option = Object.keys(mode.optShift).find((k) => mode.optShift[k] === optBits) || mode.opts[0][0];
      if (mode && mode.userPic) res.option = Object.keys(USEROP).find((k) => USEROP[k] === flags) || '1';
      return res;
    });
  }

  static buildLightPacket(s) {
    const m = LIGHT_MODES.find((x) => x.id === s.type);
    if (!m) throw new Error('Неизвестный режим ' + s.type);
    const colorMode = s.rainbow ? COLOR_RAINBOW : COLOR_CUSTOM;
    let flags = COLOR_CUSTOM, speed = 0, value = 0;
    if (m.mode !== 0) {
      value = clamp(s.brightness, 0, 4);
      if (m.speed) speed = clamp(s.speed, 0, MAXSPEED);
      if (m.color) flags = colorMode;
      if (m.optShift) flags = ((m.optShift[s.option] || 0) << 4) | (m.color ? colorMode : COLOR_CUSTOM);
      if (m.userPic) flags = USEROP[s.option || '1'] || 0;
      if (m.music) flags = ((m.optShift[s.option] || 0) << 4) | (s.rainbow ? 0 : 4); // у музыки радуга = 0, свой цвет = 4
      if (m.fixedValue !== undefined) value = m.fixedValue;
    }
    const a = new Array(64).fill(0);
    a[0] = CMD.SET_LEDPARAM; a[1] = m.mode; a[2] = MAXSPEED - speed; a[3] = value; a[4] = flags;
    if (m.color) {
      let rgb = s.rgb === 0xffffff ? WHITE_FIX : (s.rgb >>> 0);
      a[5] = (rgb >> 16) & 255; a[6] = (rgb >> 8) & 255; a[7] = rgb & 255;
    }
    if (m.userPic) { a[5] = 0; a[6] = 200; a[7] = 200; }
    return a;
  }
  _sameLight(p, loose) {
    const l = this._lastLight;
    if (!l || Date.now() - this._lastLightT > 60000) return false;
    if (loose) return l[1] === p[1] && l[3] === p[3] && l[4] === p[4];
    return l.length === p.length && l.every((v, i) => v === p[i]);
  }
  _noteLight(p) { this._lastLight = p.slice(); this._lastLightT = Date.now(); }
  setLight(s) {
    return this._serial(async () => {
      const p = Q75.buildLightPacket(s);
      if (this._sameLight(p)) return true; // то же самое уже стоит — лишний раз не дёргаем прошивку
      const ok = await this._write(p, CheckSum.BIT8, 500);
      if (ok) this._noteLight(p);
      await sleep(500);
      return ok;
    });
  }

  /* ---- частота опроса ---- */
  getReportRate() {
    return this._serial(async () => {
      const r = await this._query([CMD.GET_REPORT, this.profile]);
      if (!r) return undefined;
      const e = Object.entries(REPORT_RATES).find(([, v]) => v === r[2]);
      return e ? Number(e[0]) : undefined;
    });
  }
  setReportRate(hz) {
    return this._serial(async () => {
      const code = REPORT_RATES[hz];
      if (!code) throw new Error('Недопустимая частота ' + hz);
      const ok = await this._write([CMD.SET_REPORT, this.profile, code], CheckSum.BIT7);
      await sleep(1000);
      return ok;
    });
  }

  /* ---- антидребезг ---- */
  getDebounce() {
    return this._serial(async () => { const r = await this._query([CMD.GET_DEBOUNCE]); return r ? r[2] : undefined; });
  }
  setDebounce(ms) {
    return this._serial(async () => {
      const ok = await this._write([CMD.SET_DEBOUNCE, 0, clamp(ms, 0, 10)], CheckSum.BIT7);
      await sleep(500);
      return ok;
    });
  }

  /* ---- сон (беспроводные режимы), значения в секундах ---- */
  getSleep() {
    return this._serial(async () => {
      const a = await this._query([CMD.GET_SLEEPTIME]);
      if (!a) return undefined;
      return { bt: a[2] << 8 | a[1], rf: a[4] << 8 | a[3], deepBt: a[6] << 8 | a[5], deepRf: a[8] << 8 | a[7] };
    });
  }
  setSleep(s) {
    return this._serial(async () => {
      const a = [CMD.SET_SLEEPTIME, 0, 0, 0, 0, 0, 0, 0,
        s.bt & 255, s.bt >> 8, s.rf & 255, s.rf >> 8, s.deepBt & 255, s.deepBt >> 8, s.deepRf & 255, s.deepRf >> 8];
      const ok = await this._write(a, CheckSum.BIT7);
      await sleep(500);
      return ok;
    });
  }

  /* ---- опции клавиатуры (биты сохраняются как есть, меняются только выбранные) ---- */
  getOptions() {
    return this._serial(async () => {
      const a = await this._query([CMD.GET_KBOPTION, this.profile]);
      if (!a) return undefined;
      return { raw: [a[2], a[3], a[4]], winLock: !!(a[2] & 1), wasdSwap: !!(a[2] & 8) };
    });
  }
  setOptions(o) {
    return this._serial(async () => {
      let b = o.raw[0];
      b = o.winLock ? b | 1 : b & ~1;
      b = o.wasdSwap ? b | 8 : b & ~8;
      return this._write([CMD.SET_KBOPTION, this.profile, b & 255, o.raw[1], o.raw[2]], CheckSum.BIT7);
    });
  }

  /* ---- раскладка ---- */
  // layer: 'base' | 'fn'. Возвращает массив 512 байт (128 ячеек по 4 байта).
  readMatrix(layer = 'base') {
    return this._serial(async () => {
      const out = new Uint8Array(512);
      for (let n = 0; n < 8; n++) {
        const req = layer === 'fn' ? [CMD.GET_FN, 0, n] : [CMD.GET_KEYMATRIX, this.profile, n];
        const r = await this._query(req);
        if (!r || r.length < 64) throw new Error('Не удалось прочитать раскладку (пакет ' + n + ')');
        out.set(r.slice(0, 64), n * 64);
      }
      return out;
    });
  }
  static buildMatrixPackets(matrix, layer = 'base', profile = 0) {
    const pk = [];
    for (let o = 0; o < 9; o++) {
      const h = [layer === 'fn' ? CMD.SET_FN : CMD.SET_KEYMATRIX, layer === 'fn' ? 0 : profile, 248, 1, o, 0, 0, 0];
      let sum = 0; for (let i = 0; i < 7; i++) sum += h[i];
      h[7] = 255 - (sum & 255);
      const chunk = Array.from(matrix.slice(56 * o, 56 * o + 56));
      while (chunk.length < 56) chunk.push(0);
      pk.push(h.concat(chunk));
    }
    return pk;
  }
  writeMatrix(matrix, layer = 'base') {
    return this._serial(async () => {
      for (const p of Q75.buildMatrixPackets(matrix, layer, this.profile)) {
        if (!(await this._write(p, CheckSum.NONE))) throw new Error('Ошибка записи раскладки');
      }
      await sleep(layer === 'fn' ? 100 : 1000);
      return true;
    });
  }
  static defaultMatrix(model) {
    const out = new Uint8Array(512);
    const d = DEFAULT_MATRIX[model === 'knob' ? 'knob' : 'std'];
    for (const k of Object.keys(d)) out.set(d[k], Number(k) * 4);
    return out;
  }
  // Сколько заводских клавиш совпадает с прочитанной раскладкой (проверка формата ответа)
  static matrixSanity(matrix, model) {
    const d = DEFAULT_MATRIX[model === 'knob' ? 'knob' : 'std'];
    let same = 0, total = 0;
    for (const k of Object.keys(d)) {
      total++;
      const i = Number(k) * 4;
      if (d[k].every((v, j) => matrix[i + j] === v)) same++;
    }
    return same / total;
  }


  /* ---- макросы (формат как в оригинальном драйвере, буфер 256 байт) ---- */
  // events: [{type:'keyboard', action:'down'|'up', value:HID}, {type:'mouse_button', action, value:240..244}, {type:'delay', value:мс}]
  static encodeMacro(events, repeat = 1) {
    const o = new Uint8Array(256), dv = new DataView(o.buffer);
    let u = 0, flagOnly = false;
    const need = (n) => { if (u + n > 256) throw new Error('Макрос слишком длинный'); };
    need(2); dv.setUint16(0, repeat & 0xffff, true); u = 2;
    for (let t = 0; t < events.length; t++) {
      const a = events[t];
      if (a.type !== 'delay' && flagOnly) { need(2); dv.setUint16(u, 0, true); u += 2; }
      if (a.type === 'delay') {
        if (flagOnly) { need(2); dv.setUint16(u, a.value & 0xffff, true); u += 2; }
        else { need(4); dv.setUint16(u, 0, true); u += 2; dv.setUint16(u, a.value & 0xffff, true); u += 2; }
        flagOnly = false;
        continue;
      }
      if (a.type !== 'keyboard' && a.type !== 'mouse_button') continue;
      need(2);
      o[u++] = a.value & 255;
      let r = 0;
      if (t + 1 < events.length && events[t + 1].type === 'delay' && events[t + 1].value <= 127) r = events[t + 1].value;
      if (a.action === 'down') r |= 128;
      o[u++] = r; flagOnly = true;
      if ((r & 127) > 0) { flagOnly = false; t++; }
    }
    return o;
  }
  static decodeMacro(buf) {
    const b = buf instanceof Uint8Array ? buf : Uint8Array.from(buf);
    const u16 = (i) => b[i] | (b[i + 1] << 8);
    const ev = [], repeat = u16(0);
    let a = 2, n = b.slice(a, a + 4); a += 4;
    while (a <= b.length && n.length === 4) {
      if (n[0] === 0 && n[1] === 0 && n[2] === 0 && n[3] === 0) break;
      const action = n[1] & 128 ? 'down' : 'up';
      if (n[0] >= 4 && n[0] <= 239) ev.push({ type: 'keyboard', action, value: n[0] });
      else if (n[0] >= 240 && n[0] <= 244) ev.push({ type: 'mouse_button', action, value: n[0] });
      let d;
      if ((n[1] & 127) !== 0) { d = n[1] & 127; a -= 2; } else d = n[2] | (n[3] << 8);
      if (d) ev.push({ type: 'delay', value: d });
      n = b.slice(a, a + 4);
      if (n.length < 4 || n.every((x) => x === 0)) break;
      a += 4;
    }
    return { events: ev, repeat };
  }
  // занятый объём буфера (из 248 допустимых)
  static macroBytes(events) {
    try { const enc = Q75.encodeMacro(events, 1); let last = 2; for (let i = 255; i >= 2; i--) if (enc[i]) { last = i + 1; break; } return Math.max(last, 2); }
    catch (e) { return 999; }
  }
  readMacro(idx) {
    return this._serial(async () => {
      const out = new Uint8Array(256);
      for (let n = 0; n < 4; n++) {
        const r = await this._query([CMD.GET_MACRO, idx, n]);
        if (!r || r.length < 64) throw new Error('Не удалось прочитать макрос ' + (idx + 1));
        out.set(r.slice(0, 64), n * 64);
      }
      return Q75.decodeMacro(out);
    });
  }
  static buildMacroPackets(idx, buf) {
    const pk = [];
    for (let l = 0; l < 5; l++) {
      const chunk = Array.from(buf.slice(56 * l, 56 * l + 56)); while (chunk.length < 56) chunk.push(0);
      pk.push([CMD.SET_MACRO, idx, 0, 1, l, 0, 0, 0].concat(chunk));
    }
    return pk;
  }
  writeMacro(idx, events, repeat) {
    return this._serial(async () => {
      if (idx < 0 || idx >= MACRO_SLOTS) throw new Error('Неверный номер макроса');
      const buf = Q75.encodeMacro(events, repeat);
      for (const p of Q75.buildMacroPackets(idx, buf)) if (!(await this._write(p, CheckSum.BIT7))) throw new Error('Ошибка записи макроса');
      await sleep(1000);
      return true;
    });
  }

  /* ---- своя схема: цвет каждой клавиши (проверено на Q75 yc200) ---- */
  // Схема пишется/читается для активного слота режима «Своя схема», поэтому сначала включаем слот.
  static buildUserPicPackets(data) {
    const pk = [];
    for (let u = 0; u < 7; u++) {
      const chunk = Array.from(data.slice(56 * u, 56 * u + 56)); while (chunk.length < 56) chunk.push(0);
      pk.push([CMD.SET_USERPIC, 0, USERPIC_BYTES & 255, USERPIC_BYTES >> 8, u, 0, 0, 0].concat(chunk));
    }
    return pk;
  }
  async _selectPicSlot(slot, brightness) {
    const p = Q75.buildLightPacket({ type: 'LightUserPicture', option: String(slot), brightness: brightness == null ? 4 : brightness });
    if (this._sameLight(p, true)) return; // схема уже выбрана (её только что включил setLight)
    if (!(await this._write(p, CheckSum.BIT8, 50))) throw new Error('Клавиатура не переключилась на схему ' + slot);
    this._noteLight(p);
    await sleep(this.driver.sim ? 20 : 1200); // после смены режима прошивка ~1 с не отвечает
  }
  async _readPicRaw() {
    const out = new Uint8Array(USERPIC_BYTES);
    for (let n = 0; n < 6; n++) {
      let r;
      for (let k = 0; k < 5; k++) {
        r = await this._query([CMD.GET_USERPIC, 0, n]);
        if (r && r.length >= 64) break;
        await sleep(this.driver.sim ? 5 : 400);
      }
      if (!r || r.length < 64) throw new Error('Не удалось прочитать схему подсветки');
      out.set(r.slice(0, 64), n * 64);
    }
    return out;
  }
  readUserPic(slot, brightness) {
    return this._serial(async () => { await this._selectPicSlot(slot, brightness); return this._readPicRaw(); });
  }
  writeUserPic(slot, brightness, data) {
    return this._serial(async () => {
      await this._selectPicSlot(slot, brightness);
      for (const p of Q75.buildUserPicPackets(data)) {
        let ok = false;
        for (let k = 0; k < 3 && !ok; k++) { ok = await this._write(p, CheckSum.BIT7, 20); if (!ok) await sleep(400); }
        if (!ok) throw new Error('Ошибка записи схемы подсветки');
      }
      await sleep(this.driver.sim ? 20 : 600);
      const back = await this._readPicRaw();
      for (let i = 0; i < USERPIC_BYTES; i++) if (back[i] !== data[i]) return { ok: true, verified: false, back };
      return { ok: true, verified: true, back };
    });
  }

  /* ---- сброс к заводским ---- */
  factoryReset() {
    return this._serial(async () => { const ok = await this._write([CMD.SET_RESET], CheckSum.BIT7); await sleep(1500); return ok; });
  }
}

function clamp(v, a, b) { v = Number(v) || 0; return Math.max(a, Math.min(b, v)); }

if (typeof module !== 'undefined') {
  module.exports = { PB, GrpcWeb, IotDriver, Q75, CMD, CheckSum, DangleType, LIGHT_MODES, MODELS, MODEL_INFO, REPORT_RATES, MACRO_SLOTS, USERPIC_BYTES };
}
