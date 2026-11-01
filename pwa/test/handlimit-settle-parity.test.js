/**
 * 打满局数 vs 分数见底：**同一条结账路径、同一套结算界面**（v102 §14.1）
 *
 * 用户提的原始诉求（原话保留）：
 *   「打满局数结束的情况应该像有人到达底分结束一样，统一的逻辑结算，
 *     保持一样的界面选择退出或者下一局」
 *
 * 这句话拆成三层可验证的东西，本文件逐层锁死：
 *
 *   ① 状态机层：两条结束原因都必须落在 **SETTLED** 这一个相位上，
 *      并且都由 markSettled 收口（否则 settledAt / handSeq / voided / AI 报名
 *      这些「结账后才成立」的字段会缺一条腿 —— 战绩收录、就位态都会跟着错）。
 *
 *   ② 交互层：SETTLED 之后「开始下一局」和「离开房间」两条路都必须真的能走通。
 *      只断言 phase 不够 —— 真正会坏的是 canStartNext（报名 + 准备凑齐）
 *      和 startNextRound（档位要沿用、把数归零、分数重置）。
 *
 *   ③ 界面层：结算屏的进入条件里**不许出现 endReason**。
 *      这是「长得一样」的机器可读版本：只要有人哪天为 handLimit 加一句
 *      `if (endReason !== 'handLimit') showScreen('screen-settle')`，
 *      打满局数的人就会被留在牌桌上，而所有状态机测试照样全绿。
 *
 * 为什么不用真浏览器：本文件管的是「分支结构」，那部分静态 + 状态机就能证死；
 * 「按钮在视口里、点得到」属于布局，由 scripts/probe-handlimit-settle.js 负责。
 */
'use strict';

const { readAll: readGameAll } = require('./helpers/gameSource');
const fs = require('fs');
const path = require('path');
const SM = require('../js/stateMachine.js');
const CONFIG = require('../js/config.js');

let pass = 0;
let fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

function P(id) { return { id: id, nickname: id }; }

/* 建房 → 全员准备 → 开局，并把初始分垫高。
 * 垫高是为了让「打满」这条路一定由上限触发：本文件要验的正是 handLimit，
 * 不能被随机牌面碰巧打出极端负分干扰（v103 起负分已不会结束游戏）。 */
function makeRoom(ids, opts) {
  const room = SM.newRoom('R-PARITY', P(ids[0]), opts);
  ids.slice(1).forEach((id) => SM.joinRoom(room, P(id)));
  room.players.forEach((p) => { p.ready = true; });
  SM.startGame(room, ids[0]);
  room.players.forEach((p) => { p.score = 500; });
  return room;
}

function buildGroups(hand, round) {
  const keys = SM.ROUND_GROUPS[round];
  const groups = {};
  let i = 0;
  keys.forEach((k) => {
    groups[k] = hand.slice(i, i + SM.GROUP_COUNT[k]);
    i += SM.GROUP_COUNT[k];
  });
  return groups;
}

function allSubmit(room) {
  const round = room.round;
  SM.activePlayers(room).slice().forEach((p) => {
    SM.submitGroups(room, p.id, buildGroups(p.hand, round), round);
  });
}

function playOneHand(room) {
  const startHand = room.handCount;
  let guard = 0;
  while (room.handCount === startHand && room.phase !== SM.PHASE.SETTLED && guard < 6) {
    allSubmit(room);
    guard += 1;
  }
  return room.phase;
}

function playToSettle(room) {
  let guard = 0;
  while (room.phase !== SM.PHASE.SETTLED && guard < 40) {
    playOneHand(room);
    guard += 1;
  }
  return room.phase;
}

/* ========================================================================== */
console.log('\n[1] 两条结束原因落在同一个相位：SETTLED');

const limitRoom = makeRoom(['a', 'b'], { handLimit: 3 });
playToSettle(limitRoom);
eq(limitRoom.phase, SM.PHASE.SETTLED, '★ 打满 3 局 → phase === SETTLED（和异常终局是同一个屏）');
eq(limitRoom.endReason, 'handLimit', '原因是 handLimit（不是 dissolve 那种兜底）');
ok(!limitRoom.someoneLeft, '没有把「打满」误记成「有人离开」');

/* 第二个房间：走「人数不足」这条路（someoneLeft）。
 * ★ v103 之后正常终局只剩 handLimit 一条，「分数见底」已经不成立了，
 *   所以要证明「不同原因同屏」，对照组只能取异常终局里最常见的那一个：
 *   有人退出去没回来，剩的人不够开局。 */
const leftRoom = makeRoom(['c', 'd'], { handLimit: 30 });
playOneHand(leftRoom);                  // 先真打一把，这一局才不算作废
SM.leaveRoom(leftRoom, 'd');            // 剩 1 人 < MIN_PLAYERS → 本局提前结束
eq(leftRoom.phase, SM.PHASE.SETTLED, '人数不足 → 也是 SETTLED');
eq(leftRoom.endReason, 'someoneLeft', '原因是 someoneLeft');
ok(leftRoom.settledAt > 0, '人数不足这条路写入了 settledAt');

/* 同一个收口函数：意味着这几个「结账后才成立」的字段两条路都有。
 * 少任何一个，前端就会表现为「打满局数的这一局收录不进战绩」或
 * 「结算页没有就位态」，而那类 bug 从界面上看只是「功能没做」。 */
ok(limitRoom.settledAt > 0, '★ 打满也写入了 settledAt（战绩幂等键，两条路一致）');
ok(limitRoom.handSeq > 0 && leftRoom.handSeq > 0, '★ 两条路都推进了 handSeq（结算广播的序号）');
eq(limitRoom.voided, false, '★ 打满 3 局算真打，不是作废局（voided=false）');
eq(limitRoom.handCount, 3, '★ 停在刚打完的那一把（第 3 把），不偷偷发第 4 把');
eq(limitRoom.round, 2, '★ 轮次停在 2（结算页继续显示这一把第二轮的明细）');

/* ========================================================================== */
console.log('\n[2] 结算后「下一局」这条路：报名 → 准备 → 真的开局');

const meA = limitRoom.players[0].id;
const w1 = SM.wantNext(limitRoom, meA);
ok(w1.ok, '★ 打满后点「开始下一局」不报错', JSON.stringify(w1));
ok(SM.nextRoundPlayers(limitRoom).length === 1, '报名的人被计入下一局');
ok(!SM.canStartNext(limitRoom), '只有 1 人时不满足最少人数（不会自己开）');

SM.wantNext(limitRoom, limitRoom.players[1].id);
ok(SM.nextRoundPlayers(limitRoom).length === 2, '两人都报名');
/* ★ C-2（v116）：报名即就位，所以「两人都报名」这一句本身就成立了 ——
 *   以前这里还要断言「还没准备 → 仍然不开」，现在那个中间态已经不存在。 */
ok(SM.canStartNext(limitRoom), '★ 两人都报名（= 都已就位）→ 条件成立');

const started = SM.autoStartIfReady(limitRoom);
ok(!!started && started.kind === 'next', '★ 真的开了下一局（不是只改了按钮状态）');
eq(limitRoom.phase, SM.PHASE.ROUND1_SPLIT, '回到第一轮分牌');
eq(limitRoom.handCount, 1, '★ 把数归零到 1（不会一开局又立刻打满）');
eq(limitRoom.endReason, null, '★ 结束原因被清掉（否则新一局一进来就显示「已结束」）');
eq(limitRoom.settledAt, null, 'settledAt 也清掉');
eq(SM.handLimitOf(limitRoom), 3, '★ 档位仍是建房时选的 3（续局沿用）');
ok(limitRoom.players.every((p) => p.score === CONFIG.INITIAL_SCORE),
  '★ 分数重置回初始 ' + CONFIG.INITIAL_SCORE + ' 分');

/* 第二局再打满一次，确认沿用不是「第一次碰巧」 */
playToSettle(limitRoom);
eq(limitRoom.phase, SM.PHASE.SETTLED, '★ 第二局打满同样进 SETTLED');
eq(limitRoom.endReason, 'handLimit', '★ 第二局的原因仍是 handLimit');
eq(limitRoom.handCount, 3, '★ 第二局也正好打 3 把');
eq(SM.handLimitOf(limitRoom), 3, '★ 第三局还会是 3（档位跟房间走）');

/* ========================================================================== */
console.log('\n[3] 结算后「退出」这条路：离开不改变结账结果');

const bye = SM.leaveRoom(limitRoom, meA);
ok(!!bye.room, '★ 打满后点「离开房间」不报错');
eq(bye.room.endReason, 'handLimit', '★ 离开不会把结束原因覆盖成 dissolve（结账已经定了）');
eq(bye.room.phase, SM.PHASE.SETTLED, '离开后仍是 SETTLED（还在结算页，不是被弹回牌桌）');
ok(bye.room.players.some((p) => p.id === meA && p.left), '离开者被标记 left（分数仍参与结算）');

/* ========================================================================== */
console.log('\n[4] 界面层：进结算屏的条件里没有 endReason');

const ROOT = path.join(__dirname, '..');
const gameJs = readGameAll();
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* 把 render() 的 SETTLED 分支切出来看。用「从 SETTLED 判断到下一次 return」的窗口，
 * 足够覆盖这一屏的全部分支（showReadyTable / renderRoom / showScreen / renderSettle）。 */
const settleBranch = (function () {
  const at = gameJs.indexOf("if (room.phase === StateMachine.PHASE.SETTLED) {");
  if (at < 0) return '';
  return gameJs.slice(at, at + 2200);
})();
ok(settleBranch.length > 400, '找得到 render() 里的 SETTLED 分支（正则没跑偏）');
ok(/showScreen\('screen-settle'\)/.test(settleBranch), '★ 结算屏在这里切出来');
ok(!/endReason/.test(settleBranch),
  '★ 这一整段没有出现 endReason（任何结束原因都走同一块界面）', settleBranch.slice(0, 200));

/* 结算页的按钮是静态 HTML，谁都不能按原因藏起来。 */
ok(/id="btn-next"/.test(html), '结算页有「开始下一局」');
ok(/id="btn-back-room"/.test(html), '结算页有「离开房间」');
ok(/id="btn-share"/.test(html) && /id="btn-replay"/.test(html), '结算页有「生成战绩图 / 本局过程」');
ok(/id="btn-records"/.test(html), '结算页有「查看战绩」');

/* renderSettle 只管内容，不许动按钮的可见性 —— 否则「一样」就只剩一句话。 */
const settleFn = (function () {
  const at = gameJs.indexOf('function renderSettle(room) {');
  if (at < 0) return '';
  return gameJs.slice(at, gameJs.indexOf('\n  }', at) + 4);
})();
ok(settleFn.length > 200, '找得到 renderSettle()');
/* 只看代码，不看注释：renderSettle 里恰好有一句注释提到「见 index.html #btn-next」，
 * 拿全文正则去匹配会把那句说明判成「代码在动按钮」—— 测试自己制造的假故障。 */
const settleCode = settleFn
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');
ok(!/btn-next|btn-back-room|btn-share|btn-replay|btn-records/.test(settleCode),
  '★ renderSettle 不碰任何结算按钮（按钮对所有结束原因一视同仁）');
ok(!/classList\.(add|remove)\('hidden'\)/.test(settleCode),
  '★ renderSettle 也不藏任何元素（只写文字）');

/* 全局搜一遍：任何「按 handLimit 决定显示/隐藏」的写法都不该存在。 */
ok(!/handLimit[^\n;]{0,80}(classList\.(add|remove)\('hidden'\)|\.style\.display)/.test(gameJs),
  '★ 没有「按 handLimit 藏东西」的代码');

/* ========================================================================== */
console.log('\n[5] 文案：两种原因都说得出「本局结束」');

const reasonText = (function () {
  const at = gameJs.indexOf('var END_REASON_TEXT = {');
  return at < 0 ? '' : gameJs.slice(at, gameJs.indexOf('};', at) + 2);
})();
ok(/scoreZero:\s*'[^']+'/.test(reasonText),
  'END_REASON_TEXT 仍留着 scoreZero（v103 起不再产生，但老战绩里的记录还要能念成人话）');
ok(/handLimit:\s*'[^']+'/.test(reasonText), '★ END_REASON_TEXT 有 handLimit（结算列表副标题不会空）');
ok((reasonText.match(/:\s*'[^']+'/g) || []).length === 4, '四条结束原因都在（不多不少）');

/* settleReasonText 的 handLimit 分支要把局数报出来 —— 用户需要知道「我是打满的」 */
ok(/endReason === 'handLimit'/.test(gameJs), 'settleReasonText 有 handLimit 分支');
/* v113：术语从「局」改成「把」—— 同一句里「局」出现两次，而顶栏一直说「第 N/M 把」。
 * 这条断言守的仍是「必须报出把数、且不是事故口气」，只换了那个量词。 */
ok(/打满 ' \+ lim \+ ' 把，本局结束/.test(gameJs),
  '★ 打满的说明写成「打满 N 把，本局结束」，不是「提前结束」那种事故口气');
ok(/isFinite\(lim\)/.test(gameJs),
  '仍防着 Infinity（v103 起 handLimitOf 不会返回它，这条当第二道闸留着）');

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
