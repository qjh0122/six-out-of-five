/**
 * 进房 / 建房限流（P1-7）
 * 跑法：node server/test/join-limit.test.js
 *
 * 为什么必须限：房间号是 6 位数字，只有 100 万种；而 joinRoom 的回包会明确区分
 * 「房间不存在 / 房间已满 / 加入成功」——一个连接只要有耐心，就能把**当前所有在线
 * 房间号**一个个试出来，再逐个混进去。每次尝试还要查表、算视图、必要时广播，
 * 成本远高于 ping。
 *
 * 约定：按**连接**计数（换账号比换连接容易），10 秒 10 次，建房与进房共用一个额度。
 */
'use strict';

process.env.PROFILE_FILE = require('path').join(require('os').tmpdir(), 'lxw-jl-profiles-' + Date.now() + '.json');
process.env.SEED_FILE = require('path').join(require('os').tmpdir(), 'lxw-jl-seed-' + Date.now() + '.json');
process.env.PORT = process.env.PORT || '3206';
process.env.JOIN_MAX = process.env.JOIN_MAX || '10';
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
        setTimeout(resolve, 150);   // 给 auth 一点时间
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

/** 发一次请求，返回 { ok, error }，不抛 */
async function attempt(client, type, payload) {
  try { await client.request(type, payload); return { ok: true, error: '' }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
}

async function run() {
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });
  console.log('\n服务端就绪 127.0.0.1:' + PORT + '（JOIN_MAX=' + process.env.JOIN_MAX + '）');

  const a = new Client('甲');
  const b = new Client('乙');
  await a.signup(); await a.connect();
  await b.signup(); await b.connect();
  ok(true, '两个客户端已鉴权连接');

  /* ================================================================= */
  console.log('\n[1] 额度内一切照常（不能把正常玩法限死）');
  const created = await a.request('createRoom', { nickname: '甲' });
  const roomId = created.room.roomId;
  ok(/^\d{6}$/.test(roomId), '建房成功，拿到 6 位房号');
  const joined = await attempt(b, 'joinRoom', { roomId: roomId, nickname: '乙' });
  eq(joined.ok, true, '乙正常进房没被误伤');

  /* ================================================================= */
  console.log('\n[2] 甲连续试房号 → 超过额度被挡（枚举攻击的核心防线）');
  /* 甲已经用掉 1 次（建房）。再试 9 次「不存在的房号」= 恰好用满 10 次，
   * 第 11 次应该被拒绝。房号故意取 999999 那种存在概率极低的。 */
  const misses = [];
  for (let i = 0; i < 9; i++) {
    misses.push(await attempt(a, 'joinRoom', { roomId: '9' + String(10000 + i).slice(-5) }));
  }
  const allNotFound = misses.every((r) => !r.ok && /房间不存在|房间已满|频繁/.test(r.error));
  ok(allNotFound, '前 9 次都是「房间不存在」（额度内，还没被限流）');
  eq(misses.filter((r) => /频繁/.test(r.error)).length, 0, '额度内没有出现限流提示');

  const over = await attempt(a, 'joinRoom', { roomId: '999999' });
  eq(over.ok, false, '★ 第 11 次被拒');
  ok(/频繁/.test(over.error), '提示是「操作太频繁」，与「房间不存在」能区分开', over.error);

  /* ================================================================= */
  console.log('\n[3] 建房也吃同一个额度（防刷房间对象）');
  const overCreate = await attempt(a, 'createRoom', { nickname: '甲' });
  eq(overCreate.ok, false, '★ 额度用完后建房同样被拒');
  ok(/频繁/.test(overCreate.error), '建房也是「操作太频繁」', overCreate.error);

  /* ================================================================= */
  console.log('\n[4] 限流是按连接算的 —— 不能连累同一房间里的其他人');
  /* 用第三个连接（丙）来验：如果限流是按房间或全局算的，丙也会被挡住。
   * 注意不能让乙「重新进同一个房间」来验——那走的是认回座位的分支，
   * 需要座位令牌，会得到「身份校验失败」而不是限流，测的东西就串了。 */
  const c = new Client('丙');
  await c.signup(); await c.connect();
  const cJoin = await attempt(c, 'joinRoom', { roomId: roomId, nickname: '丙' });
  eq(cJoin.ok, true, '★ 丙的连接没被甲的刷单影响');

  /* ================================================================= */
  console.log('\n[5] 未登录的尝试不计数、但也不放行');
  const anon = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
  await new Promise((r) => { anon.addEventListener('open', r); setTimeout(r, 800); });
  let anonSeen = null;
  anon.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.type === 'error') anonSeen = (m.payload && m.payload.error) || '';
  });
  anon.send(JSON.stringify({ type: 'joinRoom', reqId: 1, payload: { roomId: '999999' } }));
  await new Promise((r) => setTimeout(r, 500));
  ok(anonSeen === null || /未登录/.test(anonSeen), '未鉴权连接拿不到任何房间信息', String(anonSeen));
  try { anon.close(); } catch (e) {}

  a.close(); b.close(); c.close();
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  await new Promise((r) => setTimeout(r, 80));
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
