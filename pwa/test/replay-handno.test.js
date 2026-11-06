/**
 * 回放的「第几把」不能借用把次身份（v124）
 * 跑法：node pwa/test/replay-handno.test.js
 *
 * 【这个文件防的是什么】
 * 用户报：打完一局点「开始下一局」，战绩里第二局的详情显示的却是
 * 「第 4 把 / 第 5 把」—— 越往后打，数字越大，跟这一局的实际把数完全不符。
 *
 * 【根因不是算错，是两个概念被合并成一个字段】
 * `packHistory` 里每个 pack 只有 `hands` 一个数，而它同时承担了两件事：
 *   · 身份 —— 必须跨局唯一（用 handId：dealAll 里递增，永不重置）
 *   · 显示序号 —— 必须每局从 1 开始（用 handCount：每局归 1）
 * 房间打第二局时 handId 从 4 继续，于是身份号被直接印在标题上。
 *
 * 【这里守的三层】
 *   1. 数据层：packHistory 的 no（显示）/ g（局号）/ hands（身份）各自正确；
 *   2. 存档层：SessionLog 与 Records 的字段裁剪不能把 no/g 剪掉
 *      —— 剪掉了就是「内存里修好、刷新一次复发」；
 *   3. 渲染层：标题必须读 no，定位必须仍读 hands。
 */
'use strict';

/* historyKit 是浏览器全局模块（IIFE 挂 window.LXW）。
 * Node 里要先把 self 指回 global，并在 require 之前把 cardText 放好 ——
 * factory 在 require 那一刻就执行，晚一步就是 undefined。 */
global.self = global;
global.LXW = {
  utils: { cardText: function (c) { return String(c.suit) + String(c.rank); } }
};

/* SessionLog / Records 在缺省情况下自己 require ./storage.js，
 * 而 storage 的默认 backing 就是 global.localStorage。 */
var store = Object.create(null);
global.localStorage = {
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
  setItem: function (k, v) { store[k] = String(v); },
  removeItem: function (k) { delete store[k]; },
  clear: function () { store = Object.create(null); }
};

var SM = require('../js/stateMachine.js');
require('../js/historyKit.js');                 // 只为把 create 挂到 global.LXW 上
var HK = global.LXW.historyKit({ state: {} });
var SessionLog = require('../js/sessionLog.js');
var Records = require('../js/records.js');
var fs = require('fs');
var path = require('path');

var pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) {
  ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));
}
function head(t) { console.log('\n' + t); }

function player(id, nick) {
  return {
    id: id, nickname: nick, ready: true, left: false, connected: true,
    disconnectedAt: null, score: 20, hand: [],
    groups: null, submitted: { round1: false, round2: false }
  };
}

/* 用真实手牌分组：submitGroups 会校验「用的牌都在手上」 */
function submit1(room) {
  room.players.forEach(function (p) {
    if (p.left) return;
    SM.submitGroups(room, p.id, {
      single: [p.hand[0]],
      tenhalf: [p.hand[1], p.hand[2]],
      piaosanye: [p.hand[3], p.hand[4], p.hand[5]]
    });
  });
}
function submit2(room) {
  room.players.forEach(function (p) {
    if (p.left) return;
    SM.submitGroups(room, p.id, {
      single: [p.hand[0]],
      douniu: [p.hand[1], p.hand[2], p.hand[3], p.hand[4], p.hand[5]]
    });
  });
}
function playHand(room) { submit1(room); submit2(room); }

/* 前端 absorbHistory 是「每次房间广播都吸收一次」，不是「整局结束吸收一次」。
 * 这个节奏不能省：stateMachine 侧 history 只留最近 4 条（= 2 把，
 * 因为它每帧都要随广播下发），整局末才收一次就会漏掉前面的把。
 * 测试按真实节奏来，否则测出来的档案比线上少一半。 */
function absorbNow(room) {
  SessionLog.absorb({
    key: SessionLog.keyOf(room),
    roomId: room.roomId,
    startedAt: room.createdAt,
    packs: HK.packHistory(room.history)
  });
}

/* ================================================================
 * 0. 真打两局
 * ================================================================ */
var room = SM.newRoom('700001', player('p1', '甲'), { handLimit: 3 });
SM.joinRoom(room, player('p2', '乙'));
SM.joinRoom(room, player('p3', '丙'));
/* newRoom 会把房主置为未准备，joinRoom 也会重置 —— 统一置一次 */
room.players.forEach(function (p) { p.ready = true; });
var sg = SM.startGame(room, 'p1');
ok(sg.ok === true, '开局成功', JSON.stringify(sg));

head('[0] 第一局打满 3 把');
for (var i = 0; i < 3; i++) { playHand(room); absorbNow(room); }
eq(room.phase, 'SETTLED', '★ 第一局打满 → 结算');
eq(room.handSeq, 1, '结算后 handSeq = 1（本房间第 1 场已归档）');
eq(room.handId, 3, 'handId 停在第 3 把（跨局不重置）');

var key = SessionLog.keyOf(room);
absorbNow(room);

head('[0a] 第一局的条目：seq 全是 0、hand 是 1/2/3');
var seqs1 = room.history.map(function (h) { return h.seq; });
ok(seqs1.every(function (x) { return x === 0; }), '★ 第一局所有条目 seq = 0', seqs1.join(','));
/* history 侧只剩最近 2 把 —— 用整场档案验完整的第一局 */
var sess1 = SessionLog.load(key);
var firstGame = (sess1 ? sess1.packs : []).filter(function (p) { return p.g === 0; });
eq(firstGame.length, 3, '★ 整场档案收全了第一局 3 把（吸收节奏正确）',
  sess1 ? sess1.packs.map(function (p) { return p.g + '/' + p.no; }).join(' ') : 'null');
eq(firstGame.map(function (p) { return p.no; }).join(','), '1,2,3', '★ 第一局显示序号 1,2,3');
ok(firstGame.every(function (p) { return p.g === 0; }), '★ 第一局 g 全是 0');

head('[0b] 点「开始下一局」→ 第二局打 2 把');
room.players.forEach(function (p) { SM.wantNext(room, p.id); });
var st = SM.startNextRound(room);
ok(!!(st && st.ok), '★ 下一局开起来了', JSON.stringify(st));
eq(room.handCount, 1, '新一局 handCount 归 1');
eq(room.handId, 4, '★ handId 继续数（这是身份，不该归 1）');
playHand(room); absorbNow(room);
playHand(room); absorbNow(room);

/* 服务端只留最近几把，但 stateMachine 侧两份都在 —— 这里要的正是跨局 */
var hist = room.history;
head('[1] 第二局的 history 条目：身份连续、序号重数、局号是新的');
var h4 = hist.filter(function (h) { return h.hid === 4; })[0];
var h5 = hist.filter(function (h) { return h.hid === 5; })[0];
ok(!!h4 && !!h5, 'history 里有 hid=4 和 hid=5', hist.map(function (h) { return h.hid; }).join(','));
eq(h4 && h4.hand, 1, '★ 第二局第 1 把的 hand = 1（本局第 1 把）');
eq(h4 && h4.seq, 1, '★ 带上了局号 seq = 1（第 2 局）');
eq(h5 && h5.hand, 2, '★ 第二局第 2 把 hand = 2');
eq(h5 && h5.seq, 1, 'hid=5 同属第 2 局');

/* ================================================================
 * 2. packHistory：三个字段各管一件事
 * ================================================================ */
head('[2] packHistory 的 no / g / hands（v131 起 history 保留整场，两局都在）');
var allPacks = HK.packHistory(hist);
/* ★ v131：history 上限从「最近 4 轮（2 把）」改成「按 handLimit 保留整场」，
 * 所以打包结果里第 1 局和第 2 局的把都在。这条测的是**字段口径**，只看第 2 局。 */
ok(allPacks.length >= 2, '打包出跨局的把（' + allPacks.length + ' 把）', 'packs=' + allPacks.length);
var packs = allPacks.filter(function (p) { return p.g === 1; });
eq(packs.length, 2, '第二局打包出 2 把', 'packs=' + packs.length + ' 全部=' + allPacks.map(function (p) { return p.g + '/' + p.no; }).join(' '));

var byHandId = {};
packs.forEach(function (p) { byHandId[p.hands] = p; });

ok(!!byHandId[4] && !!byHandId[5], '★ 身份键仍是 hid（4、5 在），回放定位不受影响');
eq(byHandId[4].no, 1, '★ hid=4 的显示序号是 1（不是 4）');
eq(byHandId[5].no, 2, '★ hid=5 的显示序号是 2（不是 5）');
eq(byHandId[4].g, 1, 'hid=4 属于第 2 局（g=1）');
eq(byHandId[5].g, 1, 'hid=5 属于第 2 局（g=1）');

head('[2b] 排序与身份键不受 no 影响');
var ids = packs.map(function (p) { return p.hands; });
var sortedIds = ids.slice().sort(function (a, b) { return a - b; });
eq(ids.join(','), sortedIds.join(','), '★ packs 仍按身份号升序（时间线不倒流）');
var nos = packs.map(function (p) { return p.no; });
eq(nos.join(','), '1,2', '★ 第二局的序号是 1,2 —— 这就是用户看到的那个数字');

/* ================================================================
 * 3. 老数据：没有 seq / 没有 hid
 * ================================================================ */
head('[3] 老存档（无 seq、无 hid）不许炸，也不许比修之前更差');
var legacy = [
  { hand: 1, round: 1, groups: [] },
  { hand: 1, round: 2, groups: [] },
  { hand: 2, round: 1, groups: [] }
];
var lp = null;
try { lp = HK.packHistory(legacy); } catch (e) { lp = null; }
ok(!!lp && lp.length === 2, '老数据仍能打包（hid 缺失时退回 hand）', lp ? 'packs=' + lp.length : '抛异常');
eq(lp[0].g, 0, '老数据没有 seq → g=0（不分局）');
eq(lp[0].no, 1, '老数据序号取 hand');
eq(lp[1].no, 2, '老数据第 2 把序号 2');

/* ================================================================
 * 4. 存档层不能把新字段剪掉
 * ================================================================ */
head('[4] SessionLog：吸收两局之后，no / g 还在（刷新不复发）');
var sess = SessionLog.load(key);
ok(!!sess && sess.packs.length === 5, '整场档案里两局共 5 把', sess ? 'packs=' + sess.packs.length : 'null');
var sPacks = {};
if (sess) sess.packs.forEach(function (p) { sPacks[p.hands] = p; });
ok(!!sPacks[4], '★ 身份键 hands=4 存下来了');
eq(sPacks[4] && sPacks[4].no, 1, '★ 存档里的 no=1（没被 sanePack 剪掉）');
eq(sPacks[4] && sPacks[4].g, 1, '★ 存档里的 g=1');
eq(sPacks[1] && sPacks[1].no, 1, '第一局第 1 把的 no 也是 1');
eq(sPacks[1] && sPacks[1].g, 0, '★ 第一局的 g=0 —— 两局没有混成同一局');
ok(sess && sess.packs.length > 0 && SessionLog.describe(sess) === '整场 5 把',
  '会话摘要按把数说（跨局的分别由界面负责）', sess ? SessionLog.describe(sess) : '');

head('[4b] Records 的单把副本同样保留');
var rec = Records.add({
  id: 'rec-1',
  playerId: 'p1',
  roomId: room.roomId,
  endedAt: Date.now(),
  playerCount: 3,
  myNet: 1,
  replay: HK.slimReplay(room)
});
var all = Records.all();
var saved = all.filter(function (r) { return r && r.replay; })[0];
ok(!!saved, '记录写进去了', JSON.stringify(rec));
if (saved) {
  eq(saved.replay.hands, 5, '单把副本仍按身份号存（5）');
  eq(saved.replay.no, 2, '★ 单把副本带 no=2');
  eq(saved.replay.g, 1, '★ 单把副本带 g=1');
}

/* ================================================================
 * 5. 渲染层：读 no、不读 hands
 * ================================================================ */
head('[5] recordsView 的标题必须用 no');
var rv = fs.readFileSync(path.join(__dirname, '..', 'js', 'recordsView.js'), 'utf8');
ok(/replay-pack-no">第 ' \+ v\.no \+ ' 把/.test(rv),
  '★ 标题读 v.no');
ok(!/replay-pack-no">第 ' \+ v\.hands \+ ' 把/.test(rv),
  '★ 标题不再读 v.hands（回归就会红）');
ok(/data-hand="' \+ v\.hands \+ '"/.test(rv),
  '★ 定位属性仍用 v.hands（改了会把「你点的这把」指错）');
ok(/replay-game-title/.test(rv), '多局时有局分隔');
ok(/replaySubText/.test(rv) && /局 · /.test(rv), '跨局副标题写「N 局 · M 把」，不冒充「整场」');

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
