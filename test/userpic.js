const fs=require('fs'),vm=require('vm'),path=require('path');
const ctx={console,setTimeout,TextEncoder,TextDecoder,Uint8Array,DataView,Math,Object,Array,Number,String,Error,Promise};vm.createContext(ctx);
vm.runInContext(['defaults.js','core.js','keys.js','sim.js'].map(f=>fs.readFileSync(path.join(__dirname,'../src',f),'utf8')).join('\n')+';this.X={Q75,SimDriver,USERPIC_BYTES,CMD};',ctx);
const {Q75,SimDriver,USERPIC_BYTES}=ctx.X; const ok=(c,m)=>{if(!c)throw new Error('FAIL '+m);console.log('  ✓',m)};
const pk=Q75.buildUserPicPackets(new Uint8Array(USERPIC_BYTES).map((_,i)=>i&255));
ok(pk.length===7&&pk.every(p=>p.length===64),'схема: 7 пакетов по 64 байта');
ok(JSON.stringify(pk[3].slice(0,9))==='[12,0,128,1,3,0,0,0,168]','заголовок как в оригинале (0x0C, длина 384, номер пакета)');
(async()=>{
  const drv=new SimDriver('std'); const kb=new Q75(drv,{kind:'dev',path:'SIM#1',id:335});
  const a=await kb.readUserPic(1,4), b=await kb.readUserPic(2,4);
  ok(a.length===384&&a.some(x=>x)&&a.some((x,i)=>x!==b[i]),'слоты 1 и 2 читаются раздельно');
  const d=new Uint8Array(384); d.set([255,0,0],0); d.set([0,255,0],21); d.set([1,2,3],381);
  const r=await kb.writeUserPic(2,4,d);
  ok(r.ok&&r.verified,'запись слота 2 подтверждена чтением');
  const a2=await kb.readUserPic(1,4);
  ok(a2.every((x,i)=>x===a[i]),'слот 1 не затронут');
  console.log('USERPIC OK');
})().catch(e=>{console.error(e);process.exit(1)});
