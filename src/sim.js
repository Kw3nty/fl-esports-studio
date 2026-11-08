/*
 * FL Esports Studio — симулятор службы iot_driver + клавиатуры Q75.
 * Нужен для демо-режима (без клавиатуры) и автотестов. Реализует ту же
 * модель протокола, что и core.js, со стороны «прошивки».
 */
class SimKeyboard {
  constructor(model = 'knob') {
    this.model = model;
    this.base = Q75.defaultMatrix(model);
    this.fn = Q75.defaultMatrix(model);
    this.light = [7, 4, 2, 3, 8, 255, 0, 0];
    this.rate = 1; this.debounce = 5;
    this.sleep = { bt: 600, rf: 600, deepBt: 1800, deepRf: 1800 };
    this.opt = [0, 0, 0];
    this.last = null;
    this.version = 0x0107;
    this.macros = new Uint8Array(MACRO_SLOTS * 256);
    this.pics = [0, 1, 2].map((s) => { const a = new Uint8Array(USERPIC_BYTES); for (let i = 0; i < 128; i++) { const col = Math.floor(i / 6); a[i * 3 + s] = 40 + col * 13; } return a; });
    this.picSlot = 0;
  }
  // Обработка «feature-отчёта» от хоста; возвращает 64-байтный ответ (или null)
  handle(p) {
    const c = p[0], r = new Uint8Array(64); r[0] = c;
    switch (c) {
      case CMD.GET_REV: r[1] = this.version & 255; r[2] = this.version >> 8; return r;
      case CMD.SET_LEDPARAM: this.light = Array.from(p.slice(0, 8)); this.light[0] = CMD.SET_LEDPARAM; if (p[1] === 13) this.picSlot = Math.min(2, p[4] >> 4); return null;
      case CMD.SET_USERPIC: { const off = p[4] * 56; for (let i = 0; i < 56 && off + i < USERPIC_BYTES; i++) this.pics[this.picSlot][off + i] = p[8 + i]; return null; }
      case CMD.GET_USERPIC: return this.pics[this.picSlot].slice(p[2] * 64, p[2] * 64 + 64);
      case CMD.GET_LEDPARAM: r.set(this.light.slice(1, 8), 1); return r;
      case CMD.SET_REPORT: this.rate = p[2]; return null;
      case CMD.GET_REPORT: r[2] = this.rate; return r;
      case CMD.SET_DEBOUNCE: this.debounce = p[2]; return null;
      case CMD.GET_DEBOUNCE: r[2] = this.debounce; return r;
      case CMD.SET_SLEEPTIME:
        this.sleep = { bt: p[8] | p[9] << 8, rf: p[10] | p[11] << 8, deepBt: p[12] | p[13] << 8, deepRf: p[14] | p[15] << 8 }; return null;
      case CMD.GET_SLEEPTIME: {
        const s = this.sleep; r.set([s.bt & 255, s.bt >> 8, s.rf & 255, s.rf >> 8, s.deepBt & 255, s.deepBt >> 8, s.deepRf & 255, s.deepRf >> 8], 1); return r;
      }
      case CMD.SET_KBOPTION: this.opt = [p[2], p[3], p[4]]; return null;
      case CMD.GET_KBOPTION: r.set(this.opt, 2); return r;
      case CMD.GET_KEYMATRIX: return this.base.slice(p[2] * 64, p[2] * 64 + 64);
      case CMD.GET_FN: return this.fn.slice(p[2] * 64, p[2] * 64 + 64);
      case CMD.SET_KEYMATRIX: case CMD.SET_FN: {
        let sum = 0; for (let i = 0; i < 7; i++) sum += p[i];
        if (p[7] !== 255 - (sum & 255)) throw new Error('SIM: неверная контрольная сумма пакета раскладки');
        const dst = c === CMD.SET_FN ? this.fn : this.base;
        const off = p[4] * 56, data = p.slice(8, 64);
        for (let i = 0; i < 56 && off + i < 512; i++) dst[off + i] = data[i];
        return null;
      }
      case CMD.SET_MACRO: {
        const base = p[1] * 256, off = p[4] * 56;
        for (let i = 0; i < 56 && off + i < 256; i++) this.macros[base + off + i] = p[8 + i];
        return null;
      }
      case CMD.GET_MACRO: return this.macros.slice(p[1] * 256 + p[2] * 64, p[1] * 256 + p[2] * 64 + 64);
      case CMD.SET_RESET:
        Object.assign(this, new SimKeyboard(this.model)); return null;
      default: return null;
    }
  }
}

class SimDriver {
  constructor(model = 'knob') {
    this.kb = new SimKeyboard(model);
    this.log = () => {};
    this.sim = true;
    this.pending = null;
    this.id = model === 'knob' ? 541 : 335;
  }
  async getVersion() { return { version: 'симулятор', timestamp: '' }; }
  async sendMsg(path, bytes, checksum) {
    this.log('tx', bytes, checksum);
    await sleep(2);
    const r = this.kb.handle(bytes);
    if (r) this.pending = r;
    return true;
  }
  async readMsg() {
    await sleep(2);
    const r = this.pending || new Uint8Array(64);
    this.pending = null;
    this.log('rx', r);
    return r;
  }
  watchDevices(cb) {
    setTimeout(() => cb({ type: ListChange.INIT, list: [{ kind: 'dev', devtype: 0, is24: false, path: 'SIM#1', id: this.id, battery: 0, online: true, vid: 1452, pid: 591 }] }), 50);
    return () => {};
  }
}

if (typeof module !== 'undefined') module.exports = { SimKeyboard, SimDriver };
