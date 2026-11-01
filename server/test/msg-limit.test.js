/**
 * 单连接消息限流（P2-13 过程中新发现的问题）
 * 跑法：node server/test/msg-limit.test.js
 *
 * 发现过程：写 peekRoom 的测试时，为了证明「peek 不会补分牌时限」，
 * 循环里一路狂发 peekRoom —— 结果 1.4 秒内服务端照做了 **13190 条**。
 * 也就是说整条 WS 协议从来没有消息级限流：进房限流只管 joinRoom/createRoom，
 * 其余请求想发多少发多少。
 *
 * 危害不只是 CPU：
 *   - ready / submitGroups / proposeDissolve 每收到一条就 _broadcast 一次，
 *     一条连接刷 N 次，房间里 m 个人就吃 N×m 条推送（放大倍数 = 房间人数）；
 *   - JSON.parse 在限流之前跑的话，超大 payload 本身就能吃满 CPU。
 *
 * 约定：MSG_MAX 条/秒/连接；超出丢弃（客户端表现为超时）；
 * 连续 MSG_STRIKE_MAX 个窗口超限则断开（4002 kicked）。
 * 测试把 MSG_MAX 压到 6，避免一条测试要打上千条请求。
 */
'use strict';

process.env.PROFILE_FILE = require('path').join(require('os').tmpdir(), 'lxw-ml-profiles-' + Date.now() + '.json');
process.env.SEED_FILE = require('path').join(require('os').tmpdir(), 'lxw-ml-seed-' + Date.now() + '.json');
process.env.PORT = process.env.PORT || '3213';
process.env.MSG_MAX = '6';
const PORT = Number(process.env.PORT);

const { server } = require('../index.js');
const { registerPlayer } = require('./helpers/account');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* 一条裸连接：不自带缓冲队列，方便直接数「哪些 reqId 得到了回包」 */
class Raw {
  constructor() {
    this.seq = 0;
    this.got = new Set();   // 收到回包的 reqId
    this.kicked = null;     // 收到 kicked 的文案
    this.closed = false;
    this.socket = null;
  }
  async signup(nickname) {
    const acc = await registerPlayer(PORT, nickname);
    this.playerId = acc.playerId;
    this.token = acc.token;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
      this.socket = ws;
      const timer = setTimeout(() => reject(new Error('连接超时')), 5000);
      ws.addEventListener('open', () => { clearTimeout(timer); setTimeout(resolve, 120); });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('连接失败')); });
      ws.addEventListener('close', () => { this.closed = true; });
      ws.addEventListener('message', (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.type === 'error' && m.payload && m.payload.kicked) this.kicked = m.payload.error;
        if (m.type === 'ok' || m.type === 'error') this.got.add(m.reqId);
      });
    });
  }
  send(type, payload) {
    const reqId = ++this.seq;
    this.socket.send(JSON.stringify({ type: type, reqId: reqId, payload: payload || {} }));
    return reqId;
  }
  async auth() {
    const id = this.send('auth', { token: this.token });
    const start = Date.now();
    while (Date.now() - start < 3000) {
      if (this.got.has(id)) return true;
      await wait(20);
    }
    return false;
  }
  close() { try { this.socket.close(); } catch (e) {} }
}

async function run() {
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });
  console.log('\n服务端就绪 127.0.0.1:' + PORT + '（MSG_MAX=6/秒）');

  /* ---------------------------------------------------------------- */
  console.log('\n[1] 正常节奏完全不受影响');
  const a = new Raw();
  await a.signup('甲');
  await a.connect();
  ok(await a.auth(), 'auth 成功');

  const created = a.send('createRoom', { nickname: '甲' });
  await wait(200);
  ok(a.got.has(created), '建房正常（1 条）');
  /* 真实玩家一秒内也发不了几条：准备 → 开局前后最多三五条 */
  await wait(1100);                              // 让 auth+createRoom 那个窗口过去
  a.got.clear();
  const normal = [];
  for (let i = 0; i < 5; i++) { normal.push(a.send('peekRoom', {})); await wait(60); }
  await wait(250);
  eq(normal.filter((id) => a.got.has(id)).length, 5, '1 秒 5 条（低于 6/秒）全部得到回包');

  /* ---------------------------------------------------------------- */
  console.log('\n[2] 超出部分被丢弃');
  await wait(1100);                              // 换窗口，清计数
  a.got.clear();
  const burst = [];
  for (let i = 0; i < 20; i++) burst.push(a.send('peekRoom', {}));
  await wait(350);
  const answered = burst.filter((id) => a.got.has(id)).length;
  ok(answered <= 6, '★ 猛发 20 条，只有 ' + answered + ' 条被处理（上限 6）');
  ok(answered >= 1, '丢弃是「超过才丢」，不是全丢（实际处理 ' + answered + ' 条）');
  ok(answered < 20, '确实发生了丢弃');

  /* ---------------------------------------------------------------- */
  console.log('\n[3] 连续超限 → 断开（不是无限次静默丢弃）');
  /* strikes 只在**窗口翻转**时累加，所以每轮必须跨过整整一个窗口
   * （MSG_WINDOW_MS=1000）。MSG_STRIKE_MAX=3，最迟第 4 个窗口开头的
   * 第一次丢弃就会触发踢线。 */
  let rounds = 0;
  const deadline = Date.now() + 12000;
  while (!a.kicked && !a.closed && Date.now() < deadline && rounds < 8) {
    for (let i = 0; i < 20; i++) {
      if (a.closed) break;
      try { a.send('peekRoom', {}); } catch (e) { break; }
    }
    rounds++;
    await wait(1100);
  }
  ok(rounds <= 6, '在第 ' + rounds + ' 个超限窗口内被处理（没有无限容忍）');
  ok(!!a.kicked, '★ 持续猛刷后收到 kicked 通知（' + (a.kicked || '无') + '）');
  ok(a.kicked && a.kicked.indexOf('频繁') >= 0, '断开原因说明了是频率问题');
  await wait(200);
  ok(a.closed === true, '连接确实被关掉了');

  /* ---------------------------------------------------------------- */
  console.log('\n[4] 限流是按连接算的，不牵连别人');
  const b = new Raw();
  await b.signup('乙');
  await b.connect();
  ok(await b.auth(), '乙在甲被踢之后仍能正常连接并鉴权');
  const bid = b.send('createRoom', { nickname: '乙' });
  await wait(250);
  ok(b.got.has(bid), '★ 乙建房正常（甲的限流状态没有外溢）');

  b.close();
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  await new Promise((r) => setTimeout(r, 80));
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
