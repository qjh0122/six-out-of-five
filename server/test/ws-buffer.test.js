/**
 * WebSocket 收流缓冲的复杂度回归（P2-1）
 * 跑法：node server/test/ws-buffer.test.js
 *
 * 旧实现每来一个 TCP 分片就 `Buffer.concat([this.buffer, chunk])`，
 * 把已累积的内容整体复制一遍 —— O(n²)。而 TCP 段大小是**发送方可控**的：
 * 同一段数据用 1 字节的段发，代价是 1KB 段的 1830 倍（实测灌满 1MB：
 * 67719ms vs 79ms）。所有房间共用一个事件循环，几个这样的连接就能把
 * 单核钉死、全场卡住。
 *
 * 这里既验**正确性**（换成指针推进后不能解析错），也验**复杂度**
 * （小分片不再随数据量平方增长）。
 */
'use strict';

const { WSClient } = require('../ws.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

/** 不带真实 socket 的客户端：只测解析与缓冲，不碰网络 */
function makeClient() {
  const fakeSocket = {
    written: [],
    setNoDelay() {},
    on() {},
    end() {},
    destroy() {},
    write(b) { this.written.push(b); return true; }
  };
  const c = new WSClient(fakeSocket, { socket: { remoteAddress: '127.0.0.1' } });
  c.messages = [];
  c.on('message', (m) => c.messages.push(m));
  c.closed = [];
  c.on('close', () => c.closed.push(true));
  return c;
}

/** client→server 的帧必须加掩码 */
function makeFrame(text, opts) {
  const o = opts || {};
  const payload = Buffer.isBuffer(text) ? text : Buffer.from(String(text), 'utf8');
  const len = payload.length;
  const opcode = o.opcode == null ? 0x1 : o.opcode;
  const fin = o.fin === false ? 0 : 0x80;
  let header;
  if (len < 126) {
    header = Buffer.from([fin | opcode, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = fin | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = fin | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const body = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, body]);
}

/* ========================================================================== */
console.log('\n[1] 正确性：一个 chunk 里塞多帧');
{
  const c = makeClient();
  const buf = Buffer.concat([
    makeFrame('{"a":1}'),
    makeFrame('第二个消息'),
    makeFrame('x'.repeat(200))          // 走 126 扩展长度分支
  ]);
  c._onData(buf);
  eq(c.messages.length, 3, '三帧都解出来了');
  eq(c.messages[0], '{"a":1}', '第一帧内容正确');
  eq(c.messages[1], '第二个消息', '中文（多字节 utf8）没被切断');
  eq(c.messages[2].length, 200, '扩展长度分支正常');
  eq(c.wlen, 0, '缓冲已消费干净');
}

/* ========================================================================== */
console.log('\n[2] 正确性：同样的字节流，按 1 字节逐次喂进来');
{
  const c = makeClient();
  const buf = Buffer.concat([makeFrame('hello'), makeFrame('world')]);
  for (let i = 0; i < buf.length; i++) c._onData(buf.subarray(i, i + 1));
  eq(c.messages.length, 2, '逐字节喂也能解出两帧（边界处理没丢字节）');
  eq(c.messages.join(','), 'hello,world', '内容完全一致');
}

/* ========================================================================== */
console.log('\n[3] 正确性：分片续帧（CONT）仍然可用');
{
  const c = makeClient();
  c._onData(makeFrame('前半', { fin: false }));
  eq(c.messages.length, 0, '未收到 fin 前不派发');
  c._onData(makeFrame('后半', { opcode: 0x0 }));
  eq(c.messages.length, 1, 'fin 到了才派发');
  eq(c.messages[0], '前半后半', '分片拼装正确');
}

/* ========================================================================== */
console.log('\n[4] 复杂度：小分片不再平方增长（这条是本次修复的重点）');
function feedOneBytePayload(totalBytes) {
  const payload = Buffer.alloc(totalBytes, 0x41);
  const frame = makeFrame(payload);
  const c = makeClient();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < frame.length; i++) c._onData(frame.subarray(i, i + 1));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, got: c.messages.length, size: c.messages[0] ? c.messages[0].length : 0 };
}
function feedChunked(totalBytes, chunkSize) {
  const frame = makeFrame(Buffer.alloc(totalBytes, 0x41));
  const c = makeClient();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < frame.length; i += chunkSize) c._onData(frame.subarray(i, Math.min(i + chunkSize, frame.length)));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, got: c.messages.length };
}

const SIZE = 256 * 1024;
const slow = feedOneBytePayload(SIZE);
const fast = feedChunked(SIZE, 1448);
console.log('    1 字节/次：' + slow.ms.toFixed(1) + ' ms    1448 字节/次：' + fast.ms.toFixed(1) + ' ms    倍率 ' + (slow.ms / Math.max(fast.ms, 0.01)).toFixed(1) + '×');
eq(slow.got, 1, '1 字节灌 ' + SIZE + ' 字节，消息完整收到');
eq(slow.size, SIZE, '内容长度正确（缓冲前移没丢字节）');
ok(slow.ms < 3000, '1 字节灌 256KB 在 3 秒内完成（旧实现同规模约 4 秒以上，1MB 要 67 秒）', slow.ms.toFixed(0) + 'ms');
ok(slow.ms / Math.max(fast.ms, 0.01) < 300, '小分片与大分片的耗时比不再是数量级爆炸', (slow.ms / Math.max(fast.ms, 0.01)).toFixed(1) + '×');

/* ========================================================================== */
console.log('\n[5] 超限帧仍然被拒（不能为了性能把防护弄丢）');
{
  const c = makeClient();
  const header = Buffer.alloc(10);
  header[0] = 0x81; header[1] = 0x80 | 127;
  header.writeBigUInt64BE(BigInt((2 << 20)), 2);   // 宣称 2MB > MAX_FRAME
  c._onData(Buffer.concat([header, Buffer.from([1, 2, 3, 4])]));
  eq(c.closed.length, 1, '超过单帧上限 → 直接关连接');
  eq(c.messages.length, 0, '没有把超大帧派发出去');
}

/* ========================================================================== */
console.log('\n[6] 长连接不泄漏：多轮收发后缓冲不膨胀');
{
  const c = makeClient();
  for (let round = 0; round < 50; round++) {
    c._onData(makeFrame('第' + round + '条'));
  }
  eq(c.messages.length, 50, '50 轮全部收到');
  eq(c.wlen, 0, '每轮都消费干净，缓冲没有残留');
  ok(c.buf.length <= 8 * 1024, '缓冲容量没有因为多次小消息无限增长（当前 ' + c.buf.length + ' 字节）');
}

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
