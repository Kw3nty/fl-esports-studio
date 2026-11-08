// Мок службы iot_driver.exe: gRPC-web (бинарный) + CORS, «прошивка» из sim.js.
const http = require('http');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ctx = { console, setTimeout, clearTimeout, TextEncoder, TextDecoder, Uint8Array, DataView, Promise, Math, Object, Array, Number, String, Error, fetch: undefined, AbortController };
vm.createContext(ctx);
const src = ['defaults.js', 'core.js', 'sim.js'].map((f) => fs.readFileSync(path.join(__dirname, '../src', f), 'utf8')).join('\n');
vm.runInContext(src + '\n;this.PB=PB;this.SimKeyboard=SimKeyboard;this.CheckSum=CheckSum;', ctx);
const { PB, SimKeyboard } = ctx;

const model = process.env.MODEL || 'std';
const kb = new SimKeyboard(model);
let pending = null;
const traffic = [];

function frame(flag, payload) {
  const b = Buffer.alloc(5 + payload.length); b[0] = flag; b.writeUInt32BE(payload.length, 1); Buffer.from(payload).copy(b, 5); return b;
}
const trailer = (status = 0) => frame(0x80, Buffer.from(`grpc-status:${status}\r\ngrpc-message:\r\n`));
function cors(req, res) {
  res.setHeader('access-control-allow-origin', req.headers.origin || '*');
  res.setHeader('access-control-allow-headers', req.headers['access-control-request-headers'] || '*');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  res.setHeader('access-control-expose-headers', 'grpc-status, grpc-message');
  if (req.headers['access-control-request-private-network']) res.setHeader('access-control-allow-private-network', 'true');
}
function applyChecksum(msg, type) {
  const m = Buffer.from(msg);
  if (type === 0) { let s = 0; for (let i = 0; i < 7; i++) s += m[i]; m[7] = 255 - (s & 255); }
  if (type === 1) { let s = 0; for (let i = 0; i < 8; i++) s += m[i]; m[8] = 255 - (s & 255); }
  return m;
}
function devListMsg() {
  const dev = PB.encode([[1, 'enum', 0], [3, 'string', '\\\\?\\hid#vid_05ac&pid_024f&mi_02#q75'], [4, 'enum', model === 'knob' ? 541 : 335], [6, 'bool', true], [7, 'enum', 1452], [8, 'enum', 591]]);
  const other = PB.encode([[1, 'enum', 0], [3, 'string', 'other'], [4, 'enum', 9999], [7, 'enum', 1], [8, 'enum', 2]]);
  const dj = (d) => PB.encode([[1, 'msg', d]]);
  return PB.encode([[1, 'msg', dj(dev)], [1, 'msg', dj(other)], [2, 'enum', 0]]);
}

const server = http.createServer((req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(200); return res.end(); }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (!/grpc-web/.test(req.headers['content-type'] || '')) { res.writeHead(415); return res.end(); }
    const msg = body.subarray(5, 5 + body.readUInt32BE(1));
    const f = PB.decode(new Uint8Array(msg));
    const method = req.url.split('/').pop();
    res.writeHead(200, { 'content-type': 'application/grpc-web+proto' });
    if (method === 'getVersion') { res.write(frame(0, PB.encode([[1, 'string', 'mock-1.0'], [2, 'string', 'now']]))); return res.end(trailer()); }
    if (method === 'watchDevList') { res.write(frame(0, devListMsg())); return; /* поток открыт */ }
    if (method === 'sendMsg') {
      const data = applyChecksum(f[2] ? f[2][0] : [], f[3] ? f[3][0].n : 0);
      if (data.length !== 64) { res.write(frame(0, PB.encode([[1, 'string', 'bad length ' + data.length]]))); return res.end(trailer()); }
      // проверка контрольных сумм, как у реальной прошивки
      traffic.push({ dir: 'tx', cks: f[3] ? f[3][0].n : 0, data: Array.from(data) });
      try { const r = kb.handle(new Uint8Array(data)); if (r) pending = r; }
      catch (e) { res.write(frame(0, PB.encode([[1, 'string', e.message]]))); return res.end(trailer()); }
      res.write(frame(0, PB.encode([])));
      return res.end(trailer());
    }
    if (method === 'readMsg') {
      const r = pending || new Uint8Array(64); pending = null;
      res.write(frame(0, PB.encode([[2, 'bytes', r]])));
      return res.end(trailer());
    }
    if (method === '__state') { res.end(); return; }
    res.end(trailer(12));
  });
});
server.kb = kb; server.traffic = traffic;
if (require.main === module) server.listen(3814, '127.0.0.1', () => console.log('mock iot_driver on :3814 model=' + model));
module.exports = server;
