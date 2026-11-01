/**
 * 刷新回座测试（整页重载后凭令牌认回原座位）
 * 跑法：node server/test/resume.test.js
 *
 * 线上真实场景：玩到一半来个电话 / 切 App 被系统回收 / 手滑刷新，
 * 页面整个重建，内存里的 roomId 没了。以前这局就直接白打了，
 * 哪怕服务端那个座位还热着。
 *
 * 这里用真的服务端 + 真的 roomStore.js（带 localStorage 垫片）跑完整链路：
 * 建房 → 模拟整页重载（重新 require 模块，内存全清）→ resume → 必须回到原房间。
 */
'use strict';

const path = require('path');
const os = require('os');

process.env.PROFILE_FILE = path.join(os.tmpdir(), 'lxw-resume-profiles-' + Date.now() + '.json');
// 种子也指到临时目录：否则会读到仓库里的真实榜单，断言的数量一变就挂
process.env.SEED_FILE = path.join(os.tmpdir(), 'lxw-resume-seed-' + Date.now() + '.json');
process.env.PORT = process.env.PORT || '3197';
const PORT = Number(process.env.PORT);

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + b + ', got ' + a); }

/* ---------------------------- 浏览器环境垫片 ---------------------------- */
/* roomStore.js 是给浏览器写的：靠 window.location 判断模式和 ws 地址，
 * 靠 localStorage 存令牌。这里给最小可用实现，别的都不装。 */

const store = {};
global.localStorage = {
  getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; }
};
global.location = { protocol: 'http:', host: '127.0.0.1:' + PORT, search: '', href: 'http://127.0.0.1:' + PORT + '/' };
global.window = { location: global.location, addEventListener: function () {} };
global.self = global;

const { server } = require('../index.js');
const { registerPlayer } = require('./helpers/account');

/* 登录态垫片：roomStore 连上 WS 后要先出示令牌，服务端才认身份。
 * 这里模拟「已登录的浏览器」——token 来自真实注册，链路和生产一致。 */
let AUTH = null;
global.AuthStore = {
  token: function () { return AUTH ? AUTH.token : ''; },
  playerId: function () { return AUTH ? AUTH.playerId : ''; }
};

/** 换一个账号（等价于「用另一个号打开」），返回 playerId */
async function become(nickname) {
  AUTH = await registerPlayer(PORT, nickname);
  return AUTH.playerId;
}

/* 重新加载 roomStore，等价于「整页重载」：模块级变量与内存状态全部重来，
 * 只有 localStorage 活着——这正是刷新后的真实情形。 */
const ROOMSTORE_PATH = require.resolve('../../pwa/js/roomStore.js');
function loadRoomStoreFresh() {
  delete require.cache[ROOMSTORE_PATH];
  return require(ROOMSTORE_PATH);
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* 最小 WS 客户端，只用来把第二个玩家塞进房间 */
function connectRaw(playerId, nickname, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
    const pending = new Map();
    let seq = 0;
    const client = {
      playerId: playerId,
      nickname: nickname,
      request: function (type, payload) {
        const reqId = ++seq;
        return new Promise((res, rej) => {
          const timer = setTimeout(() => { pending.delete(reqId); rej(new Error(type + ' 超时')); }, 5000);
          pending.set(reqId, {
            resolve: (v) => { clearTimeout(timer); res(v); },
            reject: (e) => { clearTimeout(timer); rej(e); }
          });
          ws.send(JSON.stringify({ type: type, reqId: reqId, payload: payload || {} }));
        });
      },
      close: function () { try { ws.close(); } catch (e) {} }
    };
    ws.addEventListener('open', () => {
      // 服务端只认令牌身份，请求体里的 playerId 不采信
      if (token) ws.send(JSON.stringify({ type: 'auth', payload: { token: token } }));
      resolve(client);
    });
    ws.addEventListener('error', () => reject(new Error('连接失败')));
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type !== 'ok' && msg.type !== 'error') return;
      const q = pending.get(msg.reqId);
      if (!q) return;
      pending.delete(msg.reqId);
      if (msg.type === 'ok') q.resolve(msg.payload || {});
      else q.reject(new Error((msg.payload && msg.payload.error) || '请求失败'));
    });
  });
}

async function run() {
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });
  console.log('\n服务端已就绪 127.0.0.1:' + PORT);

  // 现在身份来自账号：注册一个号再建房
  const playerId = await become('刷新测试');

  console.log('\n[第一次打开] 建房');
  let RS = loadRoomStoreFresh();
  eq(RS.getMode(), 'ws', '默认走联机模式');
  const room = await RS.createRoom({ id: playerId, nickname: '刷新测试' });
  ok(!!room && /^\d{6}$/.test(room.roomId), '建房成功，拿到 6 位房间号');
  const roomId = room.roomId;

  const savedRaw = localStorage.getItem('lxw_resume_v1');
  ok(!!savedRaw, '座位令牌已写入 localStorage');
  const saved = JSON.parse(savedRaw);
  eq(saved.roomId, roomId, '记录里的房间号正确');
  eq(saved.playerId, playerId, '记录里的身份正确');
  ok(!!saved.token && saved.token.length >= 16, '记录里带着服务端签发的令牌');

  console.log('\n[整页重载] 内存清空，只留 localStorage');
  RS = loadRoomStoreFresh();               // 关键：模块重新加载
  eq(RS.getRoom(roomId), null, '新实例的内存里没有房间（模拟刷新后内存丢失）');

  let res = await RS.resume(playerId);
  ok(res.ok === true, '回座成功', res.reason || res.error);
  eq(res.roomId, roomId, '回到的是同一个房间');
  ok(!!res.room && res.room.players.some((p) => p.id === playerId), '座位还在，自己仍在玩家列表里');

  console.log('\n[回座后仍能正常操作]');
  const ready = await RS.setReady(roomId, playerId, true);
  ok(ready.ok === true, '回座后能点准备（连接已正确绑定到该房间）', ready.error);

  console.log('\n[身份对不上] 清过缓存 / 换了身份');
  RS = loadRoomStoreFresh();
  const otherId = 'resume_other_' + Date.now();
  res = await RS.resume(otherId);
  ok(res.ok === false, '身份不一致时不回座');
  eq(res.reason, 'identity-changed', '原因写明是身份变了');
  eq(localStorage.getItem('lxw_resume_v1'), null, '失效记录被清掉，不会反复重试');

  console.log('\n[没有记录] 全新用户');
  RS = loadRoomStoreFresh();
  res = await RS.resume(playerId);
  ok(res.ok === false, '没有本地记录时安静返回，不报错');
  eq(res.reason, 'no-resume', '原因是「没有可恢复的记录」');

  console.log('\n[主动离开后] 不该再被拽回房间');
  RS = loadRoomStoreFresh();
  const room2 = await RS.createRoom({ id: playerId, nickname: '刷新测试' });
  eq(localStorage.getItem('lxw_resume_v1') !== null, true, '新建房后又写了记录');
  await RS.leaveRoom();
  eq(localStorage.getItem('lxw_resume_v1'), null, '离开房间后记录被清掉');
  RS = loadRoomStoreFresh();
  res = await RS.resume(playerId);
  ok(res.ok === false, '离开后刷新不会自动回到已离开的房间');

  console.log('\n[房间没了] 服务端已回收');
  RS = loadRoomStoreFresh();
  const room3 = await RS.createRoom({ id: playerId, nickname: '刷新测试' });
  // 手动制造「本地还记着、服务端已没有」的错位
  await RS.leaveRoom();
  localStorage.setItem('lxw_resume_v1', JSON.stringify({
    roomId: room3.roomId, playerId: playerId, token: 'deadbeefdeadbeefdeadbeefdeadbeef'
  }));
  RS = loadRoomStoreFresh();
  res = await RS.resume(playerId);
  ok(res.ok === false, '房间不存在时不回座');
  eq(localStorage.getItem('lxw_resume_v1'), null, '残留记录被清掉');
  ok(room2.roomId !== room3.roomId, '两次建房拿到不同房间号（前置条件成立）');

  /* ---------------------------- 对局中刷新 ---------------------------- */
  console.log('\n[对局中刷新] 手牌与座位都要回来');

  const RSw = loadRoomStoreFresh();
  const owner = await become('打到一半');
  const room4 = await RSw.createRoom({ id: owner, nickname: '打到一半' });

  // 第二个玩家用裸 WS 塞进来（他不需要验证回座，只要凑够人开局）
  const mateAcc = await registerPlayer(PORT, '对手');
  const mate = await connectRaw(mateAcc.playerId, '对手', mateAcc.token);
  await mate.request('joinRoom', { roomId: room4.roomId, playerId: mate.playerId, nickname: '对手' });
  await RSw.setReady(room4.roomId, owner, true);
  await mate.request('ready', { ready: true });
  /* 全员准备即开局（「开始游戏」按钮已删）：最后一个人 ready 的那一下
   * 服务端就把房间推进到分牌，这里再调 startGame 只会被拒。 */
  await wait(120);
  ok(RSw.getRoom(room4.roomId).phase === 'ROUND1_SPLIT', '两人都准备后自动开局');

  const midRoom = RSw.getRoom(room4.roomId);
  const myHandBefore = (midRoom.players.find((p) => p.id === owner) || {}).hand || [];
  eq(myHandBefore.length, 6, '开局后手上有 6 张牌');

  // 整页重载
  const RSr = loadRoomStoreFresh();
  const mid = await RSr.resume(owner);
  ok(mid.ok === true, '对局中刷新也能回座', mid.reason || mid.error);
  const back = mid.room.players.find((p) => p.id === owner) || {};
  eq((back.hand || []).length, 6, '回座后手牌完整（没有因为刷新而丢牌）');
  eq(back.left, false, '座位没有被判弃');
  ok((mid.room.phase === 'ROUND1_SPLIT' || mid.room.phase === 'ROUND2_SPLIT'),
    '仍停在分牌阶段，可以接着打', mid.room.phase);

  mate.close();
  await wait(60);

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('========================================');
  setTimeout(() => process.exit(fail > 0 ? 1 : 0), 100);
}

run().catch((e) => {
  console.error('测试异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
