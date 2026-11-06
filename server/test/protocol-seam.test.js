/**
 * 协议 seam 测试（v128）
 * 跑法：node server/test/protocol-seam.test.js
 *
 * ★ 这个文件守的是**两个模块之间的那条缝**，不是任何一边的逻辑。
 *
 * 为什么需要它：`roomStore.js` 有三层同名的东西 ——
 *   ① 对外 API（`RoomStore.xxx`，浏览器调用的就是它）
 *   ② `ws` 传输实现（真 WebSocket）
 *   ③ `local` 传输实现（BroadcastChannel）
 * 历史的两次真 bug 都出在「这三层对不上」：
 *   · v117：前端把 `playerId` 放在 payload 顶层，服务端读的是 `payload.playerId`
 *           —— 两边各自单测都绿，接起来就是「参数不对」；
 *   · v121：`RoomStore.dropNext` 在 ws 里存在、对外 API 里**根本没有**
 *           —— 点下去是 `is not a function`，被 catch 吞成「网络不太稳」（v127 才修）。
 *
 * 为什么以前的测试抓不到：
 *   · 服务端测试全手写 `{type, reqId, payload}` 原始帧（跳过了 roomStore 这一层）；
 *   · 客户端测试拿手写 socket 桩（跳过了真服务端）；
 *   · 结构守卫 grep 的是「文件里有没有 `dropNext: function` 这行」——
 *     它匹配到了 ws 里那份，界面用的却是对外那份。**守卫站错了层级**。
 *
 * 本文件用**真服务端 + 真 roomStore**（只垫一个 localStorage 和一个登录态），
 * 把 23 个请求逐个打一遍，并且先做一次结构对账：
 *   「game.js 里调用的每个 RoomStore.xxx，必须真的存在于对外 API 上」。
 * 那一条如果早点有，v121 根本到不了真机。
 */
'use strict';

const path = require('path');
const os = require('os');

process.env.PROFILE_FILE = path.join(os.tmpdir(), 'lxw-seam-profiles-' + Date.now() + '.json');
process.env.SEED_FILE = path.join(os.tmpdir(), 'lxw-seam-seed-' + Date.now() + '.json');
process.env.PORT = process.env.PORT || '3198';
const PORT = Number(process.env.PORT);

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + b + ', got ' + a); }

/* ---------------------------- 浏览器环境垫片 ---------------------------- */
const store = {};
global.localStorage = {
  getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; }
};
global.location = {
  protocol: 'http:', host: '127.0.0.1:' + PORT, search: '',
  href: 'http://127.0.0.1:' + PORT + '/'
};
global.window = { location: global.location, addEventListener: function () {} };
global.self = global;

const { server } = require('../index.js');
const { registerPlayer } = require('./helpers/account');

let AUTH = null;
global.AuthStore = {
  token: function () { return AUTH ? AUTH.token : ''; },
  playerId: function () { return AUTH ? AUTH.playerId : ''; }
};

const ROOMSTORE_PATH = require.resolve('../../pwa/js/roomStore.js');
function loadRoomStore() {
  delete require.cache[ROOMSTORE_PATH];
  return require(ROOMSTORE_PATH);
}
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* 最小 WS 客户端：只用来把第二个真人塞进房间（对手方走原始协议是对的，
 * 因为要验的缝在我这一侧 —— 我的 roomStore → 真服务端）。 */
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
      close: function () { try { ws.close(); } catch (e) { /* silence: 关连接失败没有补救动作 */ } }
    };
    ws.addEventListener('open', () => {
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

/* 把对外 API 的方法名从源码里取出来（而不是 require 后 Object.keys）——
 * 两者都要：源码对账能发现「写了但没导出」，运行时对账能发现「导出的不是函数」。 */
function outerApiNames(src) {
  const start = src.indexOf('\n  return {\n');
  if (start < 0) return [];
  const body = src.slice(start + 1);
  const names = [];
  let depth = 0;
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    depth += (l.match(/\{/g) || []).length - (l.match(/\}/g) || []).length;
    const m = /^    (\w+):/.exec(l);
    if (m && i > 0) names.push(m[1]);
    if (depth <= 0 && i > 0) break;
  }
  return names;
}

/* 每把牌的分组张数（第 1 轮）。这里**故意不从 stateMachine 读** —— 读被测方的常量
 * 就等于把规则抄两遍，规则改了测试也跟着改，等于没测。写死一份是"外部期望"。 */
const R1_COUNTS = { single: 1, tenhalf: 2, piaosanye: 3 };

async function run() {
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });
  console.log('\n服务端已就绪 127.0.0.1:' + PORT);

  const fs = require('fs');

  /* ================================================================== */
  console.log('\n[1] 结构对账：游戏调的每个 RoomStore.xxx 都真的存在');

  const JS_DIR = path.join(__dirname, '..', '..', 'pwa', 'js');
  const rsSrc = fs.readFileSync(ROOMSTORE_PATH, 'utf8');
  const api = outerApiNames(rsSrc);
  ok(api.length >= 30, '对外 API 取到 ' + api.length + ' 个方法（不是空扫描）');

  /* ① 源码对账：所有 `RoomStore.xxx` 引用都必须能在这个表里找到。
   * v121 的 `RoomStore.dropNext is not a function` 就是这一条会当场抓到的东西。 */
  const refs = new Map();          // name -> [file:line]
  fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js')).forEach((f) => {
    if (f === 'roomStore.js') return;   // 自己内部用的是闭包变量，不是 RoomStore.xxx
    const lines = fs.readFileSync(path.join(JS_DIR, f), 'utf8').split('\n');
    lines.forEach((l, i) => {
      const re = /RoomStore\.(\w+)/g;
      let m;
      while ((m = re.exec(l))) {
        const n = m[1];
        if (!refs.has(n)) refs.set(n, []);
        refs.get(n).push(f + ':' + (i + 1));
      }
    });
  });
  ok(refs.size >= 10, '页面侧引用了 ' + refs.size + ' 个不同的 RoomStore 方法');

  const missing = [];
  refs.forEach((where, name) => {
    if (api.indexOf(name) < 0) missing.push(name + '（' + where[0] + '）');
  });
  eq(missing.length, 0,
    '★★ 没有「页面在调、对外 API 里却没有」的方法（v121 就是这个形状）');
  if (missing.length) console.log('     ' + missing.join('\n     '));

  /* ② 运行时对账：表里每一个都必须是函数（不只是有个键） */
  AUTH = await registerPlayer(PORT, 'seam-me');
  const mateAuth = await registerPlayer(PORT, 'seam-mate');
  const myId = AUTH.playerId;

  const RS = loadRoomStore();
  eq(RS.getMode(), 'ws', '走联机模式');
  const notFn = api.filter((n) => typeof RS[n] !== 'function');
  eq(notFn.length, 0, '★ 对外 API 的每一项运行时都是函数', notFn.join(','));

  /* ================================================================== */
  console.log('\n[2] 真链路：23 个请求逐个打穿（真 WebSocket + 真服务端）');

  /* 统一的判据：**每个请求都必须回一个带 boolean ok 的对象**。
   * 这一条看着很弱，但它恰好是 seam 的定义 ——
   * undefined（方法不存在）/ 抛异常（payload 形状错）/ 返回裸 true（协议对不上）
   * 都会被它抓住。 */
  const seam = [];
  async function call(label, p) {
    let res;
    let threw = null;
    try { res = await p; } catch (e) { threw = e && e.message; }
    const shaped = !!res && typeof res === 'object' && typeof res.ok === 'boolean';
    seam.push({ label: label, shaped: shaped, ok: !!(res && res.ok), err: (res && res.error) || threw });
    return res;
  }

  const room = await RS.createRoom({ id: myId, nickname: '缝隙甲' }, { handLimit: 3 });
  ok(!!room && /^\d{6}$/.test(room.roomId), 'createRoom → 拿到 6 位房号', JSON.stringify(room && room.roomId));
  const roomId = room.roomId;

  await call('peekRoom', RS.peekRoom(roomId)).then((r) => {
    ok(!!r && r.ok && r.room && r.room.roomId === roomId, 'peekRoom → 拿到只读快照');
  });
  await call('rename', RS.rename(roomId, myId, '缝隙甲改名')).then((r) => {
    ok(!!r && r.ok, 'rename → 改名成功', JSON.stringify(r && r.error));
  });
  await call('getProfile', RS.getProfile(myId)).then((r) => {
    ok(!!r && typeof r.ok === 'boolean', 'getProfile → 通道往返（ok=' + (r && r.ok) + '）');
  });

  /* subscribe 不走「请求-回包」，单独判：要回一个退订函数 */
  const off = RS.subscribe(roomId, function () { /* 只为验它能被订阅 */ });
  eq(typeof off, 'function', 'subscribe → 返回退订函数（不是 Promise）');
  off();

  /* 对手用原始协议进场：要验的缝在**我这一侧**（我的 roomStore → 真服务端），
   * 对手只是把房间凑够两个人。 */
  const mate = await connectRaw(mateAuth.playerId, '缝隙乙', mateAuth.token);
  await mate.request('joinRoom', { roomId: roomId, playerId: mateAuth.playerId, nickname: '缝隙乙' });
  await wait(120);
  ok(true, '对手进场（原始协议）');

  /* startGame：两人都在但都没准备时应当被明确拒绝，且**不能崩** */
  await call('startGame', RS.startGame(roomId, myId)).then((r) => {
    ok(!!r && typeof r.ok === 'boolean', 'startGame → 通道往返（ok=' + (r && r.ok) + '）');
  });

  await call('setReady', RS.setReady(roomId, myId, true)).then((r) => {
    ok(!!r && r.ok, 'setReady → 我准备好了', JSON.stringify(r && r.error));
  });
  await mate.request('ready', { ready: true });
  await wait(250);
  const started = RS.getRoom(roomId);
  eq(started && started.phase, 'ROUND1_SPLIT', '★★ 两边都准备 → 真的发牌了（roomStore 收到了广播）');

  /* 交牌：第 1 轮是 1 + 2 + 3。服务端只校验「张数 + 是不是自己的牌」，
   * 牌型留给结算去算 —— 所以随便切一刀就是合法提交，不存在扑空。 */
  const me = (started.players || []).find((p) => p.id === myId) || {};
  eq((me.hand || []).length, 6, '我拿到 6 张牌');
  const hand = (me.hand || []).slice();
  const groups = {
    single: hand.slice(0, R1_COUNTS.single),
    tenhalf: hand.slice(R1_COUNTS.single, R1_COUNTS.single + R1_COUNTS.tenhalf),
    piaosanye: hand.slice(R1_COUNTS.single + R1_COUNTS.tenhalf)
  };
  await call('submitGroups', RS.submitGroups(roomId, myId, groups)).then((r) => {
    ok(!!r && r.ok, 'submitGroups → 交牌成功', JSON.stringify(r && r.error));
  });
  await wait(60);

  /* 修改一轮（beginRevise / cancelRevise 是两步） */
  await call('beginRevise', RS.beginRevise(roomId, myId)).then((r) => {
    ok(!!r && r.ok, 'beginRevise → 进入修改态', JSON.stringify(r && r.error));
  });
  await call('cancelRevise', RS.cancelRevise(roomId, myId)).then((r) => {
    ok(!!r && r.ok, 'cancelRevise → 撤回修改', JSON.stringify(r && r.error));
  });

  /* 走到结算：发起解散 + 两边都同意 */
  await call('proposeDissolve', RS.proposeDissolve(roomId, myId)).then((r) => {
    ok(!!r && r.ok, 'proposeDissolve → 发起解散', JSON.stringify(r && r.error));
  });
  /* 顺序：我先投，对手后投。
   * 反过来的话对手一投就凑齐两票、解散当场生效，我再投会撞「没有进行中的提议」
   * —— 那是**顺序问题**不是缺陷，写成断言会变成一条稳定的假红。 */
  await call('voteDissolve', RS.voteDissolve(roomId, myId, true)).then((r) => {
    ok(!!r && r.ok, 'voteDissolve → 我同意', JSON.stringify(r && r.error));
  });
  await mate.request('voteDissolve', { agree: true });
  await wait(200);
  const settled = RS.getRoom(roomId);
  eq(settled && settled.phase, 'SETTLED', '★★ 两边同意 → 真的进结算态');

  /* ---- 以下是**只在结算期可用**的动作 ----
   * 第一版把它们写在开局前，于是 setHandLimit 回了「这一局已经开打了」。
   * 那不是 bug，是**前置条件没满足**——这类假红必须在这里留一句，
   * 否则下一个人照着重跑一遍还会以为踩到了真问题。 */
  await call('setHandLimit', RS.setHandLimit(roomId, myId, 5)).then((r) => {
    ok(!!r && r.ok, 'setHandLimit → 改把数成功（只在结算期可用）', JSON.stringify(r && r.error));
  });
  await call('holdNext', RS.holdNext(roomId, myId, true)).then((r) => {
    ok(!!r && r.ok, 'holdNext(on) → 挂起', JSON.stringify(r && r.error));
  });
  await call('holdNext', RS.holdNext(roomId, myId, false)).then((r) => {
    ok(!!r && r.ok, 'holdNext(off) → 放行', JSON.stringify(r && r.error));
  });
  await call('wantNext', RS.wantNext(roomId, myId)).then((r) => {
    ok(!!r && r.ok, 'wantNext → 报名下一局', JSON.stringify(r && r.error));
  });
  await call('unWantNext', RS.unWantNext(roomId, myId)).then((r) => {
    ok(!!r && r.ok, 'unWantNext → 撤回报名', JSON.stringify(r && r.error));
  });
  await call('dropNext', RS.dropNext(roomId, myId, myId)).then((r) => {
    ok(!!r && r.ok, '★ dropNext → 这一把先不打（v121 那颗对外的 API 里根本没有的按钮）', JSON.stringify(r && r.error));
  });
  await call('addBot', RS.addBot()).then((r) => {
    ok(!!r && typeof r.ok === 'boolean', 'addBot → 通道往返（ok=' + (r && r.ok) + '）');
  });
  await call('restart', RS.restart(roomId, myId)).then((r) => {
    ok(!!r && typeof r.ok === 'boolean', 'restart → 通道往返（ok=' + (r && r.ok) + '）');
  });
  await call('cancelDissolve', RS.cancelDissolve(roomId, myId)).then((r) => {
    ok(!!r && typeof r.ok === 'boolean', 'cancelDissolve → 通道往返（ok=' + (r && r.ok) + '）');
  });
  await call('resume', RS.resume(myId)).then((r) => {
    ok(!!r && typeof r.ok === 'boolean', 'resume → 通道往返（ok=' + (r && r.ok) + '）');
  });
  /* reauth 不走「请求-回包」：它换一条新连接，resolve 的是 socket（或 null）。
   * 第一版当成请求打，拿到 undefined 就判红 —— 那不是缺陷，是我判错了形状。
   * 这里只验「它会返回一个 thenable，而且不抛」。 */
  const reauthP = RS.reauth();
  ok(!!reauthP && typeof reauthP.then === 'function', 'reauth → 返回 thenable（不是 {ok} 形状）');
  await reauthP.catch(() => null);
  await wait(150);

  /* ---- 从「人已经在房里」这一侧验 joinRoom ----
   * 上面我是创建者，走不到加入那条分支。让对手建一个新房间，我再 join 进去：
   * 这条路径在 v108/v117 都出过 payload 形状问题。 */
  await mate.request('leaveRoom');
  await wait(120);
  const mateRoom = await mate.request('createRoom', { playerId: mateAuth.playerId, nickname: '缝隙乙' });
  const mateRoomId = mateRoom.room.roomId;
  await call('joinRoom', RS.joinRoom(mateRoomId, { id: myId, nickname: '缝隙甲改名' })).then((r) => {
    ok(!!r && r.ok, '★ joinRoom → 我的 roomStore 真的进了别人的房间', JSON.stringify(r && r.error));
  });
  await wait(120);
  const joined = RS.getRoom(mateRoomId);
  ok(!!joined && (joined.players || []).some((p) => p.id === myId),
    '★ 进房之后我的座位真的出现在房间里');

  await call('leaveRoom', RS.leaveRoom(mateRoomId, myId)).then((r) => {
    ok(!!r && r.ok, '★ leaveRoom → 退房（v128 之前成功时回的是空对象）', 'RAW=' + JSON.stringify(r));
  });

  /* 同步方法：sendEmoji 返回布尔，getRoom / canQueryProfile 返回裸值 */
  ok(typeof RS.sendEmoji(mateRoomId, myId, null, 'hi') === 'boolean',
    'sendEmoji → 同步返回布尔（不是 Promise）');
  ok(RS.getRoom(mateRoomId) === null || typeof RS.getRoom(mateRoomId) === 'object',
    'getRoom → 同步返回对象或 null');
  eq(typeof RS.canQueryProfile(), 'boolean', 'canQueryProfile → 布尔');

  /* ---- seam 总账 ---- */
  const bad = seam.filter((s) => !s.shaped);
  eq(bad.length, 0,
    '★★ 打穿的 ' + seam.length + ' 个请求，全部回 {ok:boolean}',
    bad.map((s) => s.label + '=' + JSON.stringify(s.err)).join(' | '));
  ok(seam.length >= 20, '确实覆盖了 ' + seam.length + ' 个请求（不是只打了两三个）');

  /* 这几个是主流程上的，必须**真成功**，不能只是"有形状" */
  const mustOk = ['createRoom', 'joinRoom', 'peekRoom', 'rename', 'setReady',
    'submitGroups', 'beginRevise', 'cancelRevise', 'proposeDissolve', 'voteDissolve',
    'setHandLimit', 'holdNext', 'wantNext', 'unWantNext', 'dropNext', 'leaveRoom'];
  const notOk = seam.filter((s) => mustOk.indexOf(s.label) >= 0 && !s.ok);
  eq(notOk.length, 0, '★★ 主流程上的 ' + mustOk.length + ' 个动作全部 ok:true',
    notOk.map((s) => s.label + ': ' + s.err).join(' | '));

  console.log('\n[3] 参数形状：错的必须明确拒绝，不是 500 也不是假成功');

  /* 这一节的判据来自 v127 的教训：**假成功比报错更糟**。
   * 换一个新房间做，避免污染上面的状态。 */
  AUTH = await registerPlayer(PORT, 'seam-shape');
  const RS2 = loadRoomStore();
  const r2 = await RS2.createRoom({ id: AUTH.playerId, nickname: '形状' });
  const rid2 = r2.roomId;

  let r = await RS2.setHandLimit(rid2, AUTH.playerId, 999);
  ok(r && r.ok === false && !!r.error, '把数 999 → 明确拒绝并给原因', JSON.stringify(r));
  ok(r && /把|档|范围|合法/.test(r.error || ''), '★ 拒绝文案说得清是"把数不对"', r && r.error);

  r = await RS2.wantNext(rid2, AUTH.playerId);
  ok(r && r.ok === false && !!r.error, '不在结算期却报名下一局 → 明确拒绝', JSON.stringify(r));

  r = await RS2.submitGroups(rid2, AUTH.playerId, { single: [], tenhalf: [], piaosanye: [] });
  ok(r && r.ok === false && !!r.error, '空分组的交牌 → 明确拒绝', JSON.stringify(r));

  r = await RS2.holdNext(rid2, AUTH.playerId, true);
  ok(r && r.ok === false && !!r.error, '不在结算期却挂起 → 明确拒绝', JSON.stringify(r));

  await RS2.leaveRoom(rid2, AUTH.playerId).catch(() => {});
  await RS2.disconnect();
  mate.close();
  await wait(120);

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('========================================');
  setTimeout(() => process.exit(fail > 0 ? 1 : 0), 100);
}

run().catch((e) => {
  console.error('测试异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
