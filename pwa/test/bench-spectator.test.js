/**
 * C-3b「座位全保留 / 不续局的人变旁听」的守卫（v118）
 * 跑法：node pwa/test/bench-spectator.test.js
 *
 * 以前没报名下一局的人会在开局那一刻被 `room.players = joiners` 删掉，
 * 服务端再给他推一条「本局打完后用房号 XXXX 还能进来」。三个后果：
 * 座位凭空消失、结算页名次表少人、回来还得重新输房号。
 *
 * 现在他留在房间里，只是 `benched = true`。这个改动把一件事拆成了两件：
 *
 *     activePlayers   = 房间里的人（占座位、算容量、算房间空不空）
 *     playingPlayers  = 参与本局的人（发牌、提交、结算、投票、算人数）
 *
 * 拆错的代价一边一半，而且都不报错：
 *   · 该用 playing 的地方写成 active → 整桌卡死。旁听者没有手牌，
 *     永远不会提交，「全员提交就结算」永远不成立。玩家只看到「都交了，就是不开」。
 *   · 该用 active 的地方写成 playing → 座位表少人。这个人明明在房间里，
 *     却看不到自己的座位，也不知道自己在旁听。
 *
 * 所以这个文件一半是行为断言，一半是**源码结构断言**：
 * 把「哪几处必须用 playingPlayers」钉死。光有行为断言守不住 —— 
 * 有些地方（解散投票、成就累计）在常见场景里根本走不到。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const SM = require('../js/stateMachine.js');
/* settleView 里 StateMachine 是浏览器全局（脚本顺序即依赖图），node 里得手动挂上。 */
global.StateMachine = SM;
const CONFIG = require('../js/config.js');

const ROOT = path.join(__dirname, '..');
const SM_SRC = fs.readFileSync(path.join(ROOT, 'js', 'stateMachine.js'), 'utf8');
const GAME_SRC = fs.readFileSync(path.join(ROOT, 'js', 'game.js'), 'utf8');
const SETTLE_SRC = fs.readFileSync(path.join(ROOT, 'js', 'settleView.js'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

function P(id, isBot) {
  return { id: id, nickname: id, isBot: !!isBot };
}

function makeRoom(ids, opts) {
  const room = SM.newRoom('R-BENCH', P(ids[0]), opts);
  room.cap = Math.max(ids.length, 8);
  ids.slice(1).forEach(function (id) { SM.joinRoom(room, P(id)); });
  room.players.forEach(function (p) { p.ready = true; });
  SM.startGame(room, ids[0]);
  return room;
}

/* 打到结算：全员同意解散。走真实路径，settledAt / handSeq / AI 预置都和线上一致。 */
function settleByDissolve(room) {
  SM.proposeDissolve(room, room.players[0].id);
  room.players.forEach(function (p) {
    if (!p.isBot) SM.voteDissolve(room, p.id, true);
  });
  return room;
}

/* 第一轮 / 第二轮的分组（1 张 + 3 张 + 2 张 / 3 张 + 3 张）。
 * 必须显式传：submitGroups 读的是入参，不是 player.groups。 */
/* 张数从状态机读，不写死：single 1 + tenhalf 2 + piaosanye 3 = 6；
 * 第二轮 single 1 + douniu 5 = 6。写错就是「每组必须填满指定张数」。 */
const CNT = SM.GROUP_COUNT;
function groupsOf1(p) {
  let i = 0;
  return {
    single: p.hand.slice(i, i += CNT.single),
    tenhalf: p.hand.slice(i, i += CNT.tenhalf),
    piaosanye: p.hand.slice(i, i += CNT.piaosanye)
  };
}
function groupsOf2(p) {
  let i = 0;
  return {
    single: p.hand.slice(i, i += CNT.single),
    douniu: p.hand.slice(i, i += CNT.douniu)
  };
}

/* 造一个「a、b 在打，c 旁听」的房间。
 *
 * handLimit 直接写 1，不走 newRoom 的 opts：那个参数会过 normalizeHandLimit，
 * 而白名单是 3/5/10/15/30 —— 传 1 会被**悄悄收敛成 10**。
 * （这正是 v117 里那条「改契约时收敛就是骗人」的同一个坑，只是这次踩在测试里。） */
function roomWithSpectator() {
  const room = settleByDissolve(makeRoom(['a', 'b', 'c']));
  room.handLimit = 1;
  SM.wantNext(room, 'a');
  SM.wantNext(room, 'b');
  /* ★ v121：a、b 点了还不够 —— 房间里还有 c 没表态，整桌会一直等。
   * 旁听这个状态现在是「被明确不等」的结果，所以这里必须真的走一次那个动作。
   * （以前不写这句也能开，代价是 c 被静默判旁听 —— 真机上就是这么被报回来的。） */
  SM.dropFromNext(room, 'a', 'c');
  const r = SM.autoStartIfReady(room);
  return { room: room, start: r };
}

/* ========================================================================== */
console.log('[1] 状态机：开局只标旁听，不删人');
{
  const { room, start } = roomWithSpectator();
  ok(!!start && start.kind === 'next', '★ 两人报名 → 自动开下一局');
  eq(start.removed.length, 0, '★ removed 恒为空（没人被赶出房间）');
  eq(room.players.length, 3, '★ 三个人都还在 players 里');
  eq(SM.activePlayers(room).length, 3, 'activePlayers = 房间里的人 = 3');
  eq(SM.playingPlayers(room).length, 2, '★ playingPlayers = 参与本局的人 = 2');

  const c = SM.findPlayer(room, 'c');
  eq(c.benched, true, '★ c 是旁听');
  eq(c.hand.length, 0, '★ 旁听的人不发牌');
  eq(c.score, CONFIG.INITIAL_SCORE, '旁听的人分数重置为基准分（不然 voided 判定会错）');
  eq(c.wantNext, false, '他这一局没报名');
  const a = SM.findPlayer(room, 'a');
  eq(a.benched, false, '报名的人是上场状态');
  eq(a.hand.length, CONFIG.CARDS_PER_PLAYER, '上场的人拿到 6 张');
}

/* ========================================================================== */
console.log('\n[2] 旁听的人不会被等提交（否则整桌卡死）');
{
  const { room } = roomWithSpectator();
  eq(room.phase, SM.PHASE.ROUND1_SPLIT, '前置：进入第一轮分牌');
  /* 只有 a 提交，b 还没交。旁听者 c 永远不会有 submitted，
   * 如果他进「全员提交」的分母，这一轮就永远结算不了。 */
  const a = SM.findPlayer(room, 'a');
  SM.submitGroups(room, 'a', groupsOf1(a));
  eq(room.phase, SM.PHASE.ROUND1_SPLIT, '只有 a 交了 → 还不能结算（b 没交）');

  const b = SM.findPlayer(room, 'b');
  SM.submitGroups(room, 'b', groupsOf1(b));
  eq(room.phase, SM.PHASE.ROUND2_SPLIT, '★ 两个上场的人都交了 → 立刻进第二轮（没等旁听者）');
}

/* ========================================================================== */
console.log('\n[3] 旁听的人不计分、不进结算');
{
  const { room } = roomWithSpectator();
  const c = SM.findPlayer(room, 'c');
  /* 让他两轮都不提交（旁听的人本来也提交不了）。 */
  const a = SM.findPlayer(room, 'a');
  const b = SM.findPlayer(room, 'b');
  SM.submitGroups(room, 'a', groupsOf1(a));
  SM.submitGroups(room, 'b', groupsOf1(b));
  eq(room.phase, SM.PHASE.ROUND2_SPLIT, '进了第二轮');
  SM.submitGroups(room, 'a', groupsOf2(a));
  SM.submitGroups(room, 'b', groupsOf2(b));
  eq(room.phase, SM.PHASE.SETTLED, '★ 两个人都交完 → 结算（旁听者一次都没交也不影响）');
  eq(c.score, CONFIG.INITIAL_SCORE, '★ 旁听的人一分没动');
  eq(c.benched, true, '结算后他仍是「这一局没打」的状态');
}

/* ========================================================================== */
console.log('\n[4] 旁听的人不算人数：剩两个看着的人也要结束本局');
{
  const { room } = roomWithSpectator();
  /* a、b 都离开，只剩旁听的 c。人数不足 → 本局结束。 */
  SM.leaveRoom(room, 'a');
  SM.leaveRoom(room, 'b');
  eq(room.phase, SM.PHASE.SETTLED, '★ 只剩旁听的人 → 本局结束（旁听不算人数）');
  eq(room.endReason, 'someoneLeft', '结束原因是人数不足');
}

/* ========================================================================== */
console.log('\n[5] 旁听的人不能解散、不能被催准备');
{
  const { room } = roomWithSpectator();
  const r1 = SM.proposeDissolve(room, 'c');
  eq(r1.ok, false, '★ 旁听的人不能发起「结束本局」');
  ok(/你不在该房间/.test(r1.error), '错误信息是「你不在该房间」（对局意义上）', r1.error);

  const r2 = SM.setReady(room, 'c', true);
  eq(r2.ok, false, '★ 旁听的人不能点「准备」');
  ok(/旁听/.test(r2.error), '错误信息说清了他在旁听', r2.error);
}

/* ========================================================================== */
console.log('\n[6] 旁听的人掉线 = 退房，不判弃局');
{
  const { room } = roomWithSpectator();
  const r = SM.finalizeLeave(room, 'c');
  ok(r.ok, '宽限到期处理成功');
  ok(!SM.findPlayer(room, 'c'), '★ 座位直接摘掉（不留一个「已弃局」的空壳）');
  eq(room.players.length, 2, '剩两个上场的人');
  eq(room.phase, SM.PHASE.ROUND1_SPLIT, '对局没被打断（他没在打）');

  /* 对照：上场的人掉线**要**判弃局 —— 这才是「弃局」该有的语义。 */
  const room2 = roomWithSpectator().room;
  SM.finalizeLeave(room2, 'a');
  const a2 = SM.findPlayer(room2, 'a');
  ok(a2 && a2.left === true, '★ 对照：上场的人掉线 → left=true（判弃局）');
}

/* ========================================================================== */
console.log('\n[7] 结算页名次：旁听不进名次、不能当冠军');
{
  const { room } = roomWithSpectator();
  /* settleView 是 UMD：工厂从 `global.LXW.utils` 取 el / esc 那一套，
   * 而 node 里模块顶层的 this 就是 module.exports —— 所以 require 拿到的是
   * { LXW: { settleView } }，桩也要挂在同一份对象上。 */
  const M = require('../js/settleView.js');
  M.LXW.utils = {
    $: function () { return null; },
    el: function (tag, cls, text) { return { tag: tag, cls: cls, text: text }; },
    esc: function (x) { return String(x); },
    netText: function (n) { return String(n); },
    netCls: function () { return ''; },
    pad2: function (n) { return String(n); },
    fmtTime: function () { return ''; },
    cardText: function () { return ''; },
    short: function (x) { return String(x); },
    colorFor: function () { return ''; }
  };
  const view = M.LXW.settleView({});
  /* 让 a、b 分数不同，c 是干净的基准分（0）。
   * 如果 settleRank 只按 left 过滤，c 会和「0 分的人」并列，
   * 甚至因为排序靠前被标成冠军 —— 他一张牌都没出过。 */
  SM.findPlayer(room, 'a').score = 4;
  SM.findPlayer(room, 'b').score = -4;
  SM.findPlayer(room, 'c').score = CONFIG.INITIAL_SCORE;
  const rows = view.settleRank(room.players);
  const byId = {};
  rows.forEach(function (r) { byId[r.p.id] = r; });
  eq(byId.a.rank, 1, 'a 第 1');
  eq(byId.b.rank, 2, 'b 第 2');
  eq(byId.c.rank, 0, '★ 旁听者没有名次（rank 0）');
  eq(byId.c.champion, false, '★ 旁听者绝不会被标成冠军');
  eq(byId.c.benched, true, '★ 行上带 benched 标记，渲染据此写「（旁听）」');
  eq(byId.c.abandoned, false, '旁听 ≠ 弃局（两种事实不能共用一个标记）');
  eq(rows.length, 3, '三个人都在名单里（座位不删，名次表也不删）');
  eq(rows[2].p.id, 'c', '旁听的人排在名次之后');
}

/* ========================================================================== */
console.log('\n[8] 报名下一局会把旁听身份摘掉');
{
  const { room } = roomWithSpectator();
  const c = SM.findPlayer(room, 'c');
  eq(c.benched, true, '前置：c 在旁听');
  /* 打到结算，他报名下一局。 */
  const a = SM.findPlayer(room, 'a');
  const b = SM.findPlayer(room, 'b');
  SM.submitGroups(room, 'a', groupsOf1(a)); SM.submitGroups(room, 'b', groupsOf1(b));
  SM.submitGroups(room, 'a', groupsOf2(a)); SM.submitGroups(room, 'b', groupsOf2(b));
  eq(room.phase, SM.PHASE.SETTLED, '前置：这一局打完');

  const want = SM.wantNext(room, 'c');
  ok(want.ok, '旁听的人可以在结算页报名下一局');
  eq(c.benched, false, '★ 报名即摘掉旁听身份（不摘的话下一局他仍会被当成旁听）');
  eq(c.wantNext, true, '报名成功');
  eq(c.ready, true, 'C-2：报名即就位');
}

/* ========================================================================== */
console.log('\n[9] 房主旁听时仍然是房主（能补 AI / 改把数）');
{
  const room = settleByDissolve(makeRoom(['owner', 'b', 'c']));
  SM.wantNext(room, 'b');
  SM.wantNext(room, 'c');
  /* v121：房主也要表态，或者被明确不等 —— 这里走后者。 */
  ok(!SM.canStartNext(room), '★ 房主没表态 → 先不开（v121：房主也算一个人）');
  SM.dropFromNext(room, 'b', 'owner');
  const r = SM.autoStartIfReady(room);
  ok(!!r && r.kind === 'next', '摘掉房主之后两位客人开起来');
  eq(room.ownerId, 'owner', '★ 房主没报名但还在房间里 → 所有权不转交');
  eq(SM.findPlayer(room, 'owner').benched, true, '他自己是旁听');
}

/* ========================================================================== */
console.log('\n[10] 源码结构：这几处必须是 playingPlayers');
{
  /* 每一行对应一次「用错就整桌卡死」的地方。行为断言覆盖不到全部场景
   * （比如解散投票要先有人发起），所以这里直接钉源码。 */
  const holes = [
    ['全员提交判定', /var act = playingPlayers\(room\);\s*\n\s*var allSubmitted/],
    ['分组结算计分名单', /var pool = playingPlayers\(room\);/],
    ['人数不足结束本局', /playingPlayers\(room\)\.length < CONFIG\.MIN_PLAYERS/],
    ['解散投票人', /return playingPlayers\(room\)\.filter/],
    ['成就累计', /Ach\.accumulateHand\(room\.achRun, playingPlayers\(room\)\)/],
    ['voided 判定', /!playingPlayers\(room\)\.some\(function \(p\)/]
  ];
  holes.forEach(function (h) {
    ok(h[1].test(SM_SRC), '★ ' + h[0] + ' 用的是 playingPlayers');
  });

  /* 反过来：「房间里还有谁」这几处必须继续用 activePlayers。 */
  ok(/function roomSeats\(room\) \{\s*\n\s*return room \? activePlayers\(room\)/.test(SM_SRC),
    '★ 座位表用 activePlayers（旁听的人也要有座位）');
  ok(/if \(activePlayers\(room\)\.length >= capOf\(room\)\)/.test(SM_SRC),
    '★ 容量检查用 activePlayers（旁听的人也占一个位置）');

  /* 前端：提交进度条的分母。写成 room.players 的话，旁听者会让顶栏永远停在 3/5。 */
  ok(/function ringProgress[\s\S]{0,1600}if \(p\.left \|\| p\.benched\) return;/.test(GAME_SRC),
    '★ 顶栏提交进度的分母排除了旁听者');
  /* v121：就位态走的是另一条分支 —— 分母是「报名 + 没表态」。
   * 写成「报名的人」的话，三缺一时顶栏照样满格（已准备 3/3），牌却不发。 */
  ok(/if \(nextWait\) \{[\s\S]{0,400}total: joined\.length \+ pending\.length/.test(GAME_SRC),
    '★ 就位态的分母把「还没表态的人」算进去了（否则满格不发牌）');
  ok(/if \(!nextWait && p\.benched && room\.phase !== StateMachine\.PHASE\.WAITING\)/.test(GAME_SRC),
    '★ 对手条上能看出「旁听」（否则他像一直不提交的队友）');

  /* ★ v121：就位态与旁听态共用 #screen-game，但就位态不走 renderGame ——
   * 漏掉一次清理，旁听卡就会压在就位态的房间信息卡上，变成真机截图里那一屏：
   * 上面「准备中 已准备 3/3」，中间「这一局你在旁观」，下面并排两颗离开房间。 */
  ok(/function showReadyTable[\s\S]{0,500}hideSpectator\(\)/.test(GAME_SRC),
    '★★ 就位态进入时先收起旁听卡（否则两层 UI 叠在一起）');
  ok(/function hideSpectator\(\)[\s\S]{0,300}sp\.innerHTML = ''/.test(GAME_SRC),
    '★ 收起时连内容一起清掉（不只是 hidden）');

  /* 结算页：旁听与弃局必须是两个标记。 */
  ok(SETTLE_SRC.indexOf("（旁听）") > 0, '★ 结算名区分「（旁听）」与「（弃局）」');
  ok(/r\.benched \? '—' : \(p\.score \+ ' 分'\)/.test(SETTLE_SRC),
    '★ 旁听者的分数列写「—」（写 0 分会被读成「打了没拿到」）');
}

/* ========================================================================== */
console.log('\n[11] 别人的手牌不会因为「在房间里」而漏给旁听者');
{
  /* 这条守的是隐私。C-3b 之后旁听者能看到牌桌上的进度，
   * 如果服务端把 room 原样广播出去，他就拿到了所有人的手牌。 */
  const HUB_SRC = fs.readFileSync(path.join(ROOT, '..', 'server', 'hub.js'), 'utf8');
  ok(/out\.hand = \[\];\s*\n\s*out\.groups = \{\};/.test(HUB_SRC),
    '★ _view 对非本人的手牌与分组都清空（旁听者看不到别人的牌）');
}

console.log('\n----------------------------------------');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) process.exit(1);
