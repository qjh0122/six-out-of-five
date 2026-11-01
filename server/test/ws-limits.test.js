/**
 * WebSocket 连接的两条护栏
 * 跑法：node server/test/ws-limits.test.js
 *
 * 1. **分片累积必须有总量上限**。只限单帧 1MB 是不够的：
 *    客户端可以把消息切成无数个 1KB 的续帧，服务端每片都 push 进数组，
 *    总量没有任何约束。实测灌 60MB 未完成分片，服务端既不拒绝也不关连接。
 *    业务消息都是几百字节的 JSON，4MB 已经是极大余量。
 * 2. **连上来不鉴权的连接要有超时**。没有这条，一个脚本能开几万个空连接
 *    一直躺着 —— 它们不进房间、不占房间配额，却照样吃内存和 fd。
 *
 * 这里直接驱动 WSClient（不建真实 socket），这样能精确构造分片帧，
 * 也不需要为了测 30 秒超时真的等 30 秒（用 WS_AUTH_TIMEOUT_MS 缩短）。
 */
'use strict';

process.env.PROFILE_FILE = require('path').join(require('os').tmpdir(), 'lxw-wsl-profiles-' + Date.now() + '.json');
process.env.SEED_FILE = require('path').join(require('os').tmpdir(), 'lxw-wsl-seed-' + Date.now());
process.env.WS_AUTH_TIMEOUT_MS = '250';
process.env.PORT = process.env.PORT || '3194';
const PORT = Number(process.env.PORT);

const { WSClient } = require('../ws');
const { server } = require('../index.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 造一个够用的假 socket：只实现 WSClient 会碰到的几个方法 */
function fakeSocket() {
  const { EventEmitter } = require('events');
  const s = new EventEmitter();
  s.write = function () { return true; };
  s.end = function () { };
  s.destroy = function () { };
  s.setNoDelay = function () { };
  s.destroyed = false;
  s.writable = true;
  s.remoteAddress = '127.0.0.1';
  return s;
}

/** 按客户端方向编码一帧（必须带掩码，服务端会解） */
function frame(opcode, payload, fin) {
  const data = Buffer.from(payload);
  const len = data.length;
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  let head;
  if (len < 126) {
    head = Buffer.allocUnsafe(2);
    head[1] = 0x80 | len;
  } else if (len < 65536) {
    head = Buffer.allocUnsafe(4);
    head[1] = 0x80 | 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.allocUnsafe(10);
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = (fin ? 0x80 : 0x00) | opcode;
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i & 3];
  return Buffer.concat([head, mask, masked]);
}

async function run() {
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });

  /* ==================== 一、正常分片仍然能拼回来 ==================== */
  console.log('\n[分片消息正常拼装]');
  {
    const c = new WSClient(fakeSocket(), { socket: { remoteAddress: '127.0.0.1' } });
    const got = [];
    c.on('message', (m) => got.push(m));
    c._onData(frame(0x1, '{"type":"pi', false));
    c._onData(frame(0x0, 'ng"}', true));
    eq(got.length, 1, '两片拼成一条消息');
    eq(got[0], '{"type":"ping"}', '内容正确');
    ok(c.alive, '连接仍然存活');
  }

  /* ==================== 二、超大分片累积会被关闭 ==================== */
  console.log('\n[分片总量上限]');
  {
    const c = new WSClient(fakeSocket(), { socket: { remoteAddress: '127.0.0.1' } });
    let msgs = 0;
    c.on('message', () => { msgs++; });
    // 100KB 一片，连发 60 片 = 6MB，超过 4MB 上限
    const chunk = 'x'.repeat(100 * 1024);
    c._onData(frame(0x1, chunk, false));
    for (let i = 0; i < 60 && c.alive; i++) c._onData(frame(0x0, chunk, false));
    ok(!c.alive, '超过 4MB 的未完成分片 → 连接被关闭（旧实现会一直吃内存）');
    eq(msgs, 0, '从未把畸形消息当成正常消息交给业务层');
  }

  /* ==================== 三、单片超限也拦住 ==================== */
  console.log('\n[单帧上限]');
  {
    const c = new WSClient(fakeSocket(), { socket: { remoteAddress: '127.0.0.1' } });
    // 只发帧头声明 8MB，不真的发 8MB 数据（避免测试自己吃内存）
    const head = Buffer.allocUnsafe(10);
    head[0] = 0x81;
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(8 * 1024 * 1024), 2);
    c._onData(head);
    ok(!c.alive, '声明超过 1MB 的单帧 → 直接关闭');
  }

  /* ==================== 四、不鉴权的连接会被超时关掉 ==================== */
  console.log('\n[未鉴权连接超时]');
  {
    const { hub } = require('../index.js');
    const sock = fakeSocket();
    const c = new WSClient(sock, { socket: { remoteAddress: '127.0.0.1' } });
    hub.attach(c);
    ok(c.alive, '刚连上时是活的');
    await wait(500);   // WS_AUTH_TIMEOUT_MS = 250
    ok(!c.alive, '250ms 内没发 auth → 服务端主动断开');
  }

  /* ==================== 五、鉴权过的连接不会被超时误杀 ==================== */
  console.log('\n[已鉴权连接不受影响]');
  {
    const { hub } = require('../index.js');
    const { registerPlayer } = require('./helpers/account');
    const acc = await registerPlayer(PORT, '超时验证');
    const c = new WSClient(fakeSocket(), { socket: { remoteAddress: '127.0.0.1' } });
    hub.attach(c);
    hub.auth(c, { token: acc.token }, 1);
    await wait(500);
    ok(c.alive, '鉴权过的连接不会被握手指令超时误杀');
    c.close();
  }

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error('测试异常:', e); process.exit(1); });
