const fs=require('fs'),vm=require('vm'),path=require('path');
const ctx={console,setTimeout,TextEncoder,TextDecoder,Uint8Array,DataView,Math,Object,Array,Number,String,Error,Promise};vm.createContext(ctx);
vm.runInContext(['defaults.js','core.js','keys.js'].map(f=>fs.readFileSync(path.join(__dirname,'../src',f),'utf8')).join('\n')+';this.X={PB,IotDriver,Q75,describe,MODELS};',ctx);
const {PB,IotDriver,Q75,describe,MODELS}=ctx.X; const ok=(c,m)=>{if(!c)throw new Error('FAIL '+m);console.log('  ✓',m)};
// отрицательный id (2.4G) и DangleCommon
const dev=PB.encode([[1,'enum',0],[3,'string','p'],[4,'enum',-2147483245],[7,'enum',1452]]);
const dang=PB.encode([[3,'string','d'],[5,'enum',2147483245],[1,'msg',PB.encode([[2,'msg',PB.encode([[1,'enum',77],[2,'bool',true]])]])]]);
const list=PB.encode([[1,'msg',PB.encode([[1,'msg',dev]])],[1,'msg',PB.encode([[2,'msg',dang]])],[2,'enum',1]]);
const r=IotDriver.parseDeviceList(list);
ok(r.type===1,'тип события ADD');
ok(r.list[0].id===-2147483245 && MODELS[r.list[0].id]==='std','отрицательный int32 id декодируется');
ok(r.list[1].keyboardId===2147483245 && r.list[1].keyboard.battery===77 && r.list[1].keyboard.online,'приёмник 2.4G: id и батарея');
// пакеты подсветки = как в оригинале
const p=Q75.buildLightPacket({type:'LightWave',brightness:4,speed:4,rainbow:true,option:'left',rgb:0});
ok(JSON.stringify(p.slice(0,8))==='[7,4,0,4,24,0,0,0]','Волна влево, радуга, макс. скорость');
const w=Q75.buildLightPacket({type:'LightAlwaysOn',brightness:3,speed:0,rainbow:false,rgb:0xffffff});
ok(JSON.stringify(w.slice(0,8))==='[7,1,4,3,7,250,255,250]','белый цвет подменяется 0xFAFFFA как в оригинале');
ok(JSON.stringify(Q75.buildLightPacket({type:'LightOff'}).slice(0,5))==='[7,0,4,0,7]','выключение');
const pk=Q75.buildMatrixPackets(Q75.defaultMatrix('std'));
ok(pk.length===9 && pk.every(x=>x.length===64),'раскладка: 9 пакетов по 64 байта');
ok(JSON.stringify(pk[0].slice(0,8))==='[9,0,248,1,0,0,0,253]','заголовок пакета и контрольная сумма');
ok(describe([0,224,6,0]).full==='Ctrl+C' && describe([3,0,205,0]).full==='Воспр./пауза' && describe([10,1,0,0]).full==='Fn','подписи назначений');
ok(Q75.matrixSanity(Q75.defaultMatrix('knob'),'knob')===1 && Q75.matrixSanity(new Uint8Array(512),'knob')===0,'проверка формата раскладки');
console.log('UNIT OK');
// --- макросы: сравнение с алгоритмом оригинального драйвера (nE.setMacro) ---
(() => {
  const OE = { 240: 240, 241: 241, 242: 242, 243: 243, 244: 244 };
  function original(n, repeat) { // дословный перенос логики setMacro
    const o = Buffer.alloc(256); let u = 0; o.writeUInt16LE(repeat, 0); u += 2; let i = false;
    for (let t = 0; t < n.length; t++) {
      const r = (e) => { let r = 0; if (t + 1 < n.length) { const a = n[t + 1]; if (a.type === 'delay' && a.value <= 127) r = a.value; }
        if (e.type !== 'mouse_move') r = e.action === 'down' ? (r | 128) : (r & ~128); o.writeUInt8(r, u); u++; i = true; if ((127 & r) > 0) { i = false; t++; } };
      const a = n[t];
      if (a.type !== 'delay' && i === true) { o.writeUInt16LE(0, u); u += 2; }
      if (a.type === 'delay') { if (i) { o.writeUInt16LE(a.value, u); u += 2; } else { o.writeUInt16LE(0, u); u += 2; o.writeUInt16LE(a.value, u); u += 2; } i = false; }
      else if (a.type === 'keyboard') { o.writeUInt8(a.value, u); u++; i = true; r(a); }
      else if (a.type === 'mouse_button') { o.writeUInt8(OE[a.value], u); u++; r(a); }
    }
    return Uint8Array.from(o);
  }
  let rnd = 7; const R = (n) => { rnd = (rnd * 1103515245 + 12345) & 0x7fffffff; return rnd % n; };
  for (let k = 0; k < 300; k++) {
    const ev = [], len = 1 + R(12);
    for (let j = 0; j < len; j++) {
      const hid = 4 + R(40);
      ev.push({ type: R(5) ? 'keyboard' : 'mouse_button', action: 'down', value: hid });
      if (R(2)) ev.push({ type: 'delay', value: R(3) ? 1 + R(126) : 128 + R(3000) });
      ev[ev.length - (ev[ev.length - 1].type === 'delay' ? 2 : 1)].type === 'mouse_button' && (ev[ev.length - (ev[ev.length - 1].type === 'delay' ? 2 : 1)].value = 240 + R(5));
      ev.push({ type: 'keyboard', action: 'up', value: hid });
      if (R(2)) ev.push({ type: 'delay', value: 1 + R(500) });
    }
    const a = Q75.encodeMacro(ev, 3), b = original(ev, 3);
    if (a.some((x, i) => x !== b[i])) throw new Error('FAIL кодирование макроса расходится с оригиналом: ' + JSON.stringify(ev));
    const back = Q75.decodeMacro(a);
    const norm = (e) => e.filter((x) => !(x.type === 'delay' && !x.value)).map((x) => x.type + x.action + x.value).join(',');
    if (back.repeat !== 3 || norm(back.events) !== norm(ev.map((x) => x.type === 'mouse_button' ? x : x))) {
      // события без промежуточной задержки и повторные задержки сливаются — сверяем через повторное кодирование
      const re = Q75.encodeMacro(back.events, back.repeat);
      if (re.some((x, i) => x !== a[i])) throw new Error('FAIL макрос: декодирование/кодирование не сходится');
    }
  }
  console.log('  ✓ кодирование 300 случайных макросов совпадает с оригинальным драйвером, декодирование обратимо');
  const pk = Q75.buildMacroPackets(2, Q75.encodeMacro([{ type: 'keyboard', action: 'down', value: 4 }, { type: 'keyboard', action: 'up', value: 4 }], 1));
  if (pk.length !== 5 || pk.some((p) => p.length !== 64) || pk[0][0] !== 11 || pk[0][1] !== 2 || pk[4][4] !== 4) throw new Error('FAIL пакеты макроса');
  console.log('  ✓ пакеты макроса: 5 × 64 байта, команда 0x0B');
})();
