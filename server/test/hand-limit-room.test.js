/**
 * 建房局数（handLimit）协议测试
 * 跑法：node server/test/hand-limit-room.test.js
 *
 * 验的是**服务端不信任客户端**这一层：
 *   · 建房时送来的档位必须过白名单，脏值回落 10 而**不是**报错（建房不能因为
 *     一个下拉框失败），但也绝不能把 7 这种值原样写进房间 —— 那样局数上限
 *     就变成了"由客户端决定"，结束契约形同虚设。
 *   · 进房的人只能读到房主选的那一档，没有任何接口能改它。
 */
'use strict';

process.env.PROFILE_FILE = require('path').join(require('os').tmpdir(), 'lxw-hl-profiles-' + Date.now() + '.json');
process.env.SEED_FILE = require('path').join(require('os').tmpdir(), 'lxw-hl-seed-' + Date.now() + '.json');
process.env.PORT = process.env.PORT || '3217';
/* 本文件要在一条连接上连开十几个房验白名单，会撞上「10 秒 10 次」的建房限流
 * （那条防线由 join-limit.test.js 专门负责）。这里把额度放宽，测的才是参数收敛。 */
process.env.JOIN_MAX = process.env.JOIN_MAX || '100';
const PORT = Number(process.env.PORT);

const { server } = require('../index.js');
const { registerPlayer } = require('./helpers/account');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

class Client {
  constructor(nickname) {
    this.nickname = nickname;
    this.seq = 0;
    this.pending = new Map();
    this.socket = null;
  }
  async signup() {
    const acc = await registerPlayer(PORT, this.nickname);
    this.playerId = acc.playerId;
    this.token = acc.token;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
      this.socket = ws;
      const timer = setTimeout(() => reject(new Error('连接超时')), 5000);
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'auth', payload: { token: this.token } }));
        clearTimeout(timer);
        setTimeout(resolve, 150);
      });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('连接失败')); });
      ws.addEventListener('message', (ev) => this._onMessage(ev.data));
    });
  }
  _onMessage(raw) {
    let msg; try { msg = JSON.parse(raw); } catch (e) { return; }
    if (msg.type !== 'ok' && msg.type !== 'error') return;
    const p = this.pending.get(msg.reqId);
    if (!p) return;
    this.pending.delete(msg.reqId);
    if (msg.type === 'ok') p.resolve(msg.payload || {});
    else p.reject(new Error((msg.payload && msg.payload.error) || '请求失败'));
  }
  request(type, payload) {
    const reqId = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(reqId); reject(new Error(type + ' 超时')); }, 4000);
      this.pending.set(reqId, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      this.socket.send(JSON.stringify({ type: type, reqId: reqId, payload: payload || {} }));
    });
  }
  close() { try { this.socket.close(); } catch (e) {} }
}

async function createWith(client, handLimit) {
  // handLimit === undefined 时连字段都不带，模拟老客户端 / 用户没选
  const payload = { nickname: client.nickname };
  if (handLimit !== undefined) payload.handLimit = handLimit;
  const res = await client.request('createRoom', payload);
  return res.room;
}

async function run() {
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });
  console.log('\n服务端就绪 127.0.0.1:' + PORT);

  const a = new Client('甲');
  const b = new Client('乙');
  await a.signup(); await a.connect();
  await b.signup(); await b.connect();
  ok(true, '两个客户端已鉴权连接');

  console.log('\n[1] 三档正常值原样落到房间上');
  for (const v of [3, 5, 10, 15, 30]) {
    const room = await createWith(a, v);
    eq(room.handLimit, v, '选 ' + v + ' 局 → room.handLimit = ' + v);
  }

  console.log('\n[2] 不选 / 脏值一律回落 10，且建房不失败');
  eq((await createWith(a)).handLimit, 10, '★ 完全不传 handLimit → 默认 10');
  eq((await createWith(a, null)).handLimit, 10, 'null → 10');
  eq((await createWith(a, 7)).handLimit, 10, '★ 白名单外的 7 → 10（不报错、也不按 7 生效）');
  eq((await createWith(a, 999)).handLimit, 10, '999 → 10');
  eq((await createWith(a, 'abc')).handLimit, 10, '非数字 → 10');
  eq((await createWith(a, 0)).handLimit, 10, '0 → 10（0 只是房间层的回滚标记，不接受客户端指定）');
  eq((await createWith(a, -3)).handLimit, 10, '负数 → 10');

  console.log('\n[3] 字符串档位照收（表单控件/老客户端送的就是字符串）');
  eq((await createWith(a, '15')).handLimit, 15, "'15' → 15");
  eq((await createWith(a, '3')).handLimit, 3, "'3' → 3");

  console.log('\n[4] 进房的人读到的是房主选的那一档，且改不了');
  const host = await createWith(a, 5);
  const joined = await b.request('joinRoom', { roomId: host.roomId, nickname: '乙' });
  eq(joined.room.handLimit, 5, '★ 乙进房看到 5（沿用房主的选择）');
  /* 客户端就算硬塞 handLimit 进别的请求，服务端也不认 —— joinRoom 只看 roomId。
   * 这里验的是「没有第二条写入路径」，而不是解析细节。 */
  const again = await b.request('joinRoom', { roomId: host.roomId, handLimit: 30, token: joined.token });
  eq(again.room.handLimit, 5, '★ 带着 handLimit:30 重进房，房间仍是 5');

  a.close(); b.close();
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  await new Promise((r) => setTimeout(r, 80));
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
