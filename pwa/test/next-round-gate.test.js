/**
 * 开局门槛（v121）的守卫 —— 「别替别人做决定」
 * 跑法：node pwa/test/next-round-gate.test.js
 *
 * 真机上报的场景（三个人都是真人）：
 *   A、B 点了「开始下一局」，C 还在看结算页。旧实现按「已报名的人数」算门槛，
 *   于是 2 ≥ MIN_PLAYERS，直接发牌 —— C 被判成旁听，座位变灰，
 *   他什么都没做，只是慢了几秒。
 *
 * 现在门槛是三条同时成立：
 *   ① 已报名人数 ≥ MIN_PLAYERS
 *   ② 已报名的人全部就位
 *   ③ **房间里没有任何「还没表态」的真人**
 *
 * ③ 的代价是「有人挂机就全桌等」，所以「不等他 / 这一把先不打」不是可选项，
 * 是这条规则的另一半。这个文件把两半都钉住。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const SM = require('../js/stateMachine.js');
const CONFIG = require('../js/config.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
function ids(list) { return list.map(function (p) { return p.id; }).sort().join(','); }

const ROOT = path.join(__dirname, '..');

function P(id, isBot) {
  return { id: id, nickname: id, isBot: !!isBot };
}

/* 建房 → 全员准备 → 开局 → 全员同意解散 → 停在结算期。
 * 走真实路径（不是手搓 SETTLED），因为 handSeq / AI 预置 / 结算标记都在里面。 */
function settled(ids) {
  const room = SM.newRoom('R-GATE', P(ids[0]));
  room.cap = Math.max(ids.length, 8);
  ids.slice(1).forEach(function (id) { SM.joinRoom(room, P(id)); });
  room.players.forEach(function (p) { p.ready = true; });
  SM.startGame(room, ids[0]);
  SM.proposeDissolve(room, ids[0]);
  SM.activePlayers(room).slice(1).forEach(function (p) {
    SM.voteDissolve(room, p.id, true);
  });
  return room;
}

/* ========================================================================== */
console.log('\n[1] 被报的那个 bug：三人房两人点了，不许开');
{
  const room = settled(['a', 'b', 'c']);
  SM.wantNext(room, 'a');
  SM.wantNext(room, 'b');
  eq(SM.canStartNext(room), false, '★★ 三个人、两个报名 → 不开（v121 之前这里会开）');
  eq(ids(SM.pendingNextPlayers(room)), 'c', '★ 卡住的人是 c，而且名单是公开的');
  ok(!SM.autoStartIfReady(room), '★ 自动开局也不会偷偷把 c 落下');
  eq(room.phase, SM.PHASE.SETTLED, '房间仍停在结算期（谁都没被打扰）');

  /* 出路一：c 自己点。 */
  SM.wantNext(room, 'c');
  eq(SM.canStartNext(room), true, '★ c 也点了之后才齐');
}

/* ========================================================================== */
console.log('\n[2] 出路二：不等他 —— 有名字、有确认、不踢人');
{
  const room = settled(['a', 'b', 'c']);
  SM.wantNext(room, 'a');
  SM.wantNext(room, 'b');
  const r = SM.dropFromNext(room, 'a', 'c');
  ok(r.ok, '「不等 c」成功', r.error);
  const c = SM.findPlayer(room, 'c');
  eq(c.outNext, true, '★ c 被标上「这次不等他」');
  eq(c.left, false, '★ 但不是退房');
  eq(room.players.length, 3, '★ 也没被移出房间（座位、分数、名次都留着）');
  eq(SM.canStartNext(room), true, '★ 摘掉之后立刻可以开');
  const start = SM.autoStartIfReady(room);
  ok(!!start && start.kind === 'next', '真的开了');
  eq(c.benched, true, '★ 新一局他变旁听（不是被删掉）');
  eq(c.outNext, false, '★ outNext 只对这一把有效，新一局要清掉');
}

/* ========================================================================== */
console.log('\n[3] 出路三：自己请假（这一把先不打）');
{
  const room = settled(['a', 'b', 'c']);
  SM.wantNext(room, 'a');
  SM.wantNext(room, 'b');
  /* 刻意不点「开始下一局」就请假 —— 这正是最常见的用法（我还没想好要不要打）。 */
  const r = SM.dropFromNext(room, 'c', 'c');
  ok(r.ok, '没报名的人也能自己请假', r.error);
  const c = SM.findPlayer(room, 'c');
  eq(c.outNext, true, '标上排除');
  eq(c.wantNext, false, '不报名');
  eq(c.left, false, '★ 不是退房');
  eq(SM.canStartNext(room), true, '★ 他一请假，别人立刻能开（不必替他按按钮）');

  /* 改变主意：重新报名会把排除标记摘掉，否则他会「报了名却永远不算数」。 */
  SM.wantNext(room, 'c');
  eq(c.outNext, false, '★ 重新报名即摘掉排除标记');
  eq(SM.canStartNext(room), true, '三个人又齐了');
}

/* ========================================================================== */
console.log('\n[4] 谁算「还没表态」：AI 不算，掉线但没走的人算');
{
  const room = SM.newRoom('R-GATE2', P('me'));
  SM.joinRoom(room, P('bot1', true));
  room.players.forEach(function (p) { p.ready = true; });
  SM.startGame(room, 'me');
  SM.proposeDissolve(room, 'me');
  const bot = SM.findPlayer(room, 'bot1');
  eq(bot.wantNext, true, '前置：AI 在结算期已被自动报名');
  eq(ids(SM.pendingNextPlayers(room)), 'me', '★ AI 不算「还没表态」（它不会自己点按钮）—— 名单里只有我');

  /* 掉线但还在宽限期里的人：他没走，座位还在，所以仍然算「等他」。
   * 这不是毛病 —— 他有 3 分钟能回来；等不了就「不等他」。 */
  const room2 = settled(['a', 'b', 'c']);
  SM.findPlayer(room2, 'c').connected = false;
  eq(ids(SM.pendingNextPlayers(room2)), 'a,b,c', '★ 掉线未离开的人仍算「还没表态」（没有静默放行）');
  eq(SM.canStartNext(room2), false, '所以整桌会等');
  SM.wantNext(room2, 'a');
  SM.wantNext(room2, 'b');
  ok(SM.dropFromNext(room2, 'a', 'c').ok, '等不了就明确不等他');
  eq(SM.canStartNext(room2), true, '★ 这才开');
}

/* ========================================================================== */
console.log('\n[5] 旁听不是「永久免检」：下一把又要表态');
{
  const room = settled(['a', 'b', 'c']);
  room.handLimit = 1;                      // 一把就收，省得手打
  SM.wantNext(room, 'a');
  SM.wantNext(room, 'b');
  SM.dropFromNext(room, 'a', 'c');
  SM.startNextRound(room);
  eq(SM.findPlayer(room, 'c').benched, true, '前置：c 在旁听');
  /* 这一把打完 → 又回到结算期。c 虽然上一把没打，但他还在房间里。 */
  SM.proposeDissolve(room, 'a');
  SM.playingPlayers(room).slice(1).forEach(function (p) { SM.voteDissolve(room, p.id, true); });
  eq(room.phase, SM.PHASE.SETTLED, '前置：回到结算期');
  SM.wantNext(room, 'a');
  SM.wantNext(room, 'b');
  eq(ids(SM.pendingNextPlayers(room)), 'c', '★ 旁听过的人同样要表态（不因为上次没打就免检）');
  eq(SM.canStartNext(room), false, '★ 所以这一把仍然等他');
}

/* ========================================================================== */
console.log('\n[6] 从房号进来的人：wantNext 与 ready 必须同步');
{
  /* 这一条守的是一个曾经的真实死锁：结算期从房号进来的人 wantNext=true、ready=false，
   * 而就位态那颗按钮被无条件画成「已就位 ✓」—— 界面写 3/3，服务端永远差一个人。 */
  const room = settled(['a', 'b']);
  const j = SM.joinRoom(room, P('x'));
  ok(j.ok, '结算期能进房', j.error);
  const x = SM.findPlayer(room, 'x');
  eq(x.wantNext, true, '自动报名');
  eq(x.ready, true, '★ 报名即就位（两个字段不许分岔）');
  const src = fs.readFileSync(path.join(ROOT, 'js', 'stateMachine.js'), 'utf8');
  const joinSrc = src.slice(src.indexOf('function joinRoom('), src.indexOf('function leaveRoom('));
  ok(/p\.wantNext = settling;/.test(joinSrc) && /p\.ready = settling;/.test(joinSrc),
    '★ 源码里这两行是同一句（删掉任何一行都会回到那个死锁）');
}

/* ========================================================================== */
console.log('\n[7] 三条判据一条都不能少（源码级）');
{
  const src = fs.readFileSync(path.join(ROOT, 'js', 'stateMachine.js'), 'utf8');
  const fn = src.slice(src.indexOf('function canStartNext('), src.indexOf('function wantNext('));
  ok(/list\.length < CONFIG\.MIN_PLAYERS/.test(fn), '① 人数够');
  ok(/list\.every\(function \(p\) \{ return p\.ready; \}\)/.test(fn), '② 报名的人都就位');
  ok(/return pendingNextPlayers\(room\)\.length === 0;/.test(fn), '★ ③ 房间里没有还没表态的真人');
  eq(CONFIG.MIN_PLAYERS, 2, '门槛常量本身没被动过（改的是分母，不是阈值）');
}

/* ========================================================================== */
console.log('\n[8] 客户端接口：dropNext 必须真的接出去');
{
  /* ★ 这里曾经有一个从 v114 活到 v121 的洞：
   * 「不等他」和「这一把先不打」都调 RoomStore.dropNext(...)，
   * 而对外接口里**从来没有这个名字** —— ws 对象里有一个同名的私有实现，
   * local 那边连实现都没有。点下去就是 TypeError，被 catch 吞成「网络不太稳」。
   * 单测当时盯的是「roomStore.js 里有 dropNext: function (...)」，
   * 匹配到了私有那份，于是绿的。 */
  const store = fs.readFileSync(path.join(ROOT, 'js', 'roomStore.js'), 'utf8');
  const api = store.slice(store.lastIndexOf('return {'));
  ok(/^ {4}dropNext: function \(roomId, playerId, targetId\) \{/m.test(api),
    '★ 对外接口里有 dropNext');
  ok(/local\.dropNext\(roomId, playerId, targetId\)/.test(api), '本地模式走 local.dropNext');
  ok(/ws\.dropNext\(roomId, playerId, targetId\)/.test(api), '联机模式走 ws.dropNext');
  ok(/dropNext: function \(roomId, playerId, targetId\) \{\n\s+var room = getRoom\(roomId\);/.test(store),
    '★ local 里有实现（以前这里什么都没有）');
  /* 协议层：targetId 必须包在 payload 里。写成顶层会得到「缺少要跳过的人」。 */
  ok(/type: 'dropNext', payload: \{ targetId: targetId \}/.test(store),
    '★ 协议把 targetId 包进 payload（v117 的 setHandLimit 踩过同一个坑）');
}

console.log('\n----------------------------------------');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) process.exit(1);
