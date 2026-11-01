/**
 * 表情 / 短语：只转发、不落库、2 秒一条
 * 跑法：node server/test/emoji.test.js
 *
 * 这一档是 v82 里**唯一碰 WS 协议**的改动，所以它要证明四件事：
 *
 * 1. **转发范围正确**：发全场 = 全房间都收到；发给某人 = 只带那个人的 id，
 *    但仍然是**推到全房间**由客户端过滤（服务端不必知道谁打开了面板）。
 * 2. **白名单在服务端**：不在 Emoji 清单里的 id 一律不发。前端校验可以被绕过，
 *    服务端这份是唯一的闸。
 * 3. **2 秒一条**：连发 3 条只转发第 1 条。如果这里不挡，一个人按住按钮
 *    就能让全桌每秒收到几十条飞行动画。
 * 4. **不进房间状态**：room 广播里不能出现表情。这条最重要 ——
 *    一旦进了 room，就会被 _persistSettlement 落库、被回放读走，
 *    变成「战绩里混着聊天记录」。
 *
 * 另外补一条协议兼容性：**未知请求类型不能把连接搞断**。
 * 老服务端遇到新客户端的 emoji 请求就是这个场景。
 */
'use strict';

process.env.PROFILE_FILE = require('path').join(require('os').tmpdir(), 'lxw-emoji-profiles-' + Date.now() + '.json');
process.env.SEED_FILE = require('path').join(require('os').tmpdir(), 'lxw-emoji-seed-' + Date.now() + '.json');
process.env.PORT = process.env.PORT || '3216';
const PORT = Number(process.env.PORT);

const { server, hub } = require('../index.js');
const { registerPlayer } = require('./helpers/account');
const Emoji = require('../../pwa/js/emoji.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
/* 等一个条件成立（默认 2 秒）。
 *
 * 为什么不一律用 wait(固定毫秒)：全量跑时 88 个测试文件并发，这台机器上
 * ws 一帧的往返能从几毫秒抖到几百毫秒。固定 400ms 在单独跑时永远够，
 * 并发时偶尔不够 —— 表现是「每隔几次全量就有 1 项红，单独跑又是绿的」，
 * 最容易被当成玄学。凡是「等某件事发生」的地方都用它。 */
async function until(cond, ms) {
  const end = Date.now() + (ms || 2000);
  while (Date.now() < end) {
    if (cond()) return true;
    await wait(20);
  }
  return cond();
}

class Client {
  constructor(nickname) {
    this.nickname = nickname;
    this.seq = 0;
    this.pending = new Map();
    this.emoji = [];        // 收到的 emoji 推送
    this.rooms = [];        // 收到的 room 推送
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
    if (msg.type === 'emoji') { this.emoji.push(msg.payload || {}); return; }
    if (msg.type === 'room') { this.rooms.push(msg.payload || {}); return; }
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
  /** 发一条表情：不走 reqId（服务端不回包），所以只负责把帧送出去 */
  fire(payload) {
    this.socket.send(JSON.stringify({ type: 'emoji', payload: payload }));
  }
  clear() { this.emoji = []; this.rooms = []; }
  close() { try { this.socket.close(); } catch (e) {} }
}

async function main() {
  await new Promise((r) => server.listen(PORT, r));

  const a = new Client('甲');
  const b = new Client('乙');
  await a.signup(); await b.signup();
  await a.connect(); await b.connect();

  const created = await a.request('createRoom', {});
  const roomId = created.room.roomId;
  await b.request('joinRoom', { roomId: roomId });
  await wait(200);
  a.clear(); b.clear();

  console.log('\n[1] 白名单（服务端是唯一闸口）');
  {
    eq(Emoji.list().length, 13, '清单里 13 张表情');
    eq(Emoji.phrases().length, 8, '清单里 8 条短语');

    a.fire({ to: '*', id: 'e99' });          // 不存在
    a.fire({ to: '*', id: 'DROP TABLE' });   // 超长 + 不存在
    a.fire({ to: '*', id: '' });             // 空
    a.fire({ to: '*', id: 'e3x' });          // 形状对、id 不对
    await wait(400);
    eq(a.emoji.length + b.emoji.length, 0, '非法 id 一条都不转发');
  }

  console.log('\n[2] 2 秒一条');
  {
    a.clear(); b.clear();
    a.fire({ to: '*', id: 'e3' });
    a.fire({ to: '*', id: 'e4' });
    a.fire({ to: '*', id: 'e5' });
    /* 先等第 1 条真的到（没到就说明整条链路没通，不该报成「节流失效」），
     * 再多等一会儿给后两条一个到达的机会 —— 它们必须被丢掉。 */
    await until(() => a.emoji.length >= 1);
    await wait(200);
    eq(a.emoji.length, 1, '发送者只收到 1 条');
    eq(b.emoji.length, 1, '同桌也只收到 1 条');
    eq((a.emoji[0] || {}).id, 'e3', '留下的是第一条');
  }

  console.log('\n[3] 转发范围与字段');
  {
    a.clear(); b.clear();
    await wait(Emoji.MIN_INTERVAL_MS + 100);   // 等过节流窗口
    a.fire({ to: b.playerId, id: 'p5' });
    await until(() => a.emoji.length >= 1 && b.emoji.length >= 1);
    eq(a.emoji.length, 1, '发送者能收到自己那条（不做乐观渲染，同一条回程路径）');
    eq(b.emoji.length, 1, '同房间的人收到（定向由客户端过滤）');
    const ev = b.emoji[0] || {};
    eq(ev.from, a.playerId, 'from 是发送者');
    eq(ev.to, b.playerId, 'to 保留原样');
    eq(ev.id, 'p5', 'id 原样');
    ok(typeof ev.at === 'number' && ev.at > 0, '带服务端时间戳（客户端据此判断新旧）');

    a.clear(); b.clear();
    await wait(Emoji.MIN_INTERVAL_MS + 100);
    a.fire({ to: 'not-a-real-player', id: 'e0' });
    await wait(400);
    eq(a.emoji.length + b.emoji.length, 0, '收件人不在房间里 → 不转发');
  }

  console.log('\n[4] 不进房间状态（不落库、不进回放的前提）');
  {
    const room = hub.rooms.get(roomId);
    ok(!!room, '房间还在');
    const json = JSON.stringify(room);
    eq(json.indexOf('"emoji"'), -1, 'room 对象里没有 emoji 字段');
    /* ★ 必须带引号查完整字符串值。
     * 原来写的是 indexOf('p5') —— 而 playerId 是随机串，含 "p5" 起头的概率不低，
     * 于是这条断言大约五次红一次，红的时候看起来像「表情真的被写进 room 了」。
     * 短 id 查子串在这类断言里永远是个陷阱：要查的是**值**，不是它碰巧出现的字符。 */
    eq(json.indexOf('"p5"'), -1, 'room 对象里没有刚发过的短语 id');
    const view = JSON.stringify((a.rooms[a.rooms.length - 1] || {}).room || {});
    eq(view.indexOf('emoji'), -1, 'room 广播里也没有');
  }

  console.log('\n[5] 协议兼容：未知类型不能把连接搞断');
  {
    /* 老服务端遇到新客户端就是这一条：必须回一个错误（而不是崩/断线），
     * 客户端才有机会降级。这里同时验证「回完还能继续用」。 */
    a.clear();
    let rejected = false;
    try {
      await a.request('emojiV2FromFuture', { foo: 1 });
    } catch (e) {
      rejected = /未知请求类型/.test(e.message);
    }
    ok(rejected, '未知请求类型返回「未知请求类型」错误');
    ok(a.socket.readyState === 1, '连接仍然活着');
    const pong = await new Promise((resolve) => {
      const h = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type === 'pong') { a.socket.removeEventListener('message', h); resolve(true); }
      };
      a.socket.addEventListener('message', h);
      a.socket.send(JSON.stringify({ type: 'ping' }));
      setTimeout(() => resolve(false), 1500);
    });
    ok(pong, 'ping 仍然有回应（连接没被未知类型搞坏）');
  }

  console.log('\n[6] 未登录 / 不在房间的人发不出去');
  {
    const c = new Client('丙');
    await c.signup();
    await c.connect();
    c.clear();
    c.fire({ to: '*', id: 'e0' });       // 没进房间
    await wait(400);
    eq(c.emoji.length, 0, '不在房间里 → 什么都不会转发给自己');
    c.close();
  }

  a.close(); b.close();
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  server.close();
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; try { server.close(); } catch (x) {} });
