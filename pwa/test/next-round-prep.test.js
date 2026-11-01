/**
 * C-2「报名即准备（一次点击）」的守卫（v116）
 * 跑法：node pwa/test/next-round-prep.test.js
 *
 * 改的是什么：「开始下一局」以前要两次点击 —— 先报名、回房间页再点准备。
 * 两次问的是同一件事（你要不要打下一局），拆成两步只制造了
 * 「报了名却不准备」这个能卡住整桌的中间态。
 *
 * 这一份守的是「改完之后不许悄悄退回去」：
 *   ① 报名那一刻就就位 —— 再有人把 wantNext 里的 ready 改回 false，这里立刻红；
 *   ② **AI 房不会变成死局**：markSettled 给 AI 预置了报名，所以 1 真人 + N AI 的房
 *      点一下就能开。这条最容易在重构里丢掉（AI 不报名 → 那个房间永远凑不齐人数）；
 *   ③ 阈值没被顺手改掉：5 真人房里仍然是「2 人报名即开」，剩下的不参与；
 *   ④ 侧门保持原样：从房号摸进结算期的人仍要自己点一次准备（他不是在结算页上点的）；
 *   ⑤ 撤回：报了名又回结算页，必须把就位状态一起撤掉（否则人不在下一局却带着 ready）。
 */
'use strict';

const SM = require('../js/stateMachine.js');
const CONFIG = require('../js/config.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

/* 造一间「刚打完、停在结算态」的房：手牌与轮次都不重要，只关心报名与就位。 */
function P(id, opts) {
  const p = {
    id: id, nickname: id, isBot: !!(opts && opts.bot),
    ready: false, wantNext: false, left: false, connected: true,
    score: 0, hand: [], groups: {}, submitted: { round1: true, round2: true }
  };
  return p;
}
function settledRoom(players) {
  const room = {
    roomId: 'r-prep', ownerId: players[0].id, cap: 5, handLimit: 3,
    phase: SM.PHASE.SETTLED, round: 2, handCount: 2, handSeq: 2,
    results: { round1: null, round2: null }, history: [],
    bustedIds: [], groupsDone: 5, anyScoreChange: true, settledAt: Date.now(),
    players: players
  };
  /* 结算这一刻服务端会做什么，照抄一遍：AI 预置报名 + 就位。
   * 不抄这一句，下面的「AI 房」用例就测不到真实状态。 */
  room.players.forEach(function (p) { if (p.isBot && !p.left) { p.wantNext = true; p.ready = true; } });
  return room;
}

/* ================================================================ */
console.log('\n[1] 报名即就位：一次点击');
{
  const room = settledRoom([P('a'), P('b')]);
  eq(SM.canStartNext(room), false, '前置：谁都没报名 → 开不了');

  const r = SM.wantNext(room, 'a');
  ok(r.ok === true, '点「开始下一局」成功', r.error);
  const a = SM.findPlayer(room, 'a');
  eq(a.wantNext, true, 'wantNext 置真');
  eq(a.ready, true, '★ ready 同时置真（C-2 的全部内容就在这一行）');
  eq(room.phase, SM.PHASE.SETTLED, '报名本身不动阶段（没点的人还能继续看结算页）');
  eq(SM.canStartNext(room), false, '但只有 1 个人 → 人数不够，仍然不开');

  /* 第二个人点完 → 人数齐了。这一句就是「不再需要点第二次」的验收。 */
  SM.wantNext(room, 'b');
  eq(SM.canStartNext(room), true, '★ 两人都点完 → 直接可开（中间没有「再点一次准备」）');
  const started = SM.autoStartIfReady(room);
  ok(!!started && started.kind === 'next', '★ 服务端推一次就把下一局开起来了');
  eq(room.phase, SM.PHASE.ROUND1_SPLIT, '进入第一轮分牌');
}

/* ================================================================ */
console.log('\n[2] AI 房不许变成死局（1 真人 + N AI）');
{
  /* markSettled 会给 AI 预置报名，所以「我 + 1 个 AI」两间人：
   * 我点一下就是 2 人，够 MIN_PLAYERS，开。 */
  const two = settledRoom([P('me'), P('bot1', { bot: true })]);
  SM.wantNext(two, 'me');
  eq(SM.nextRoundPlayers(two).length, 2, '★ AI 已在下一局名单里（不是我一个人）');
  eq(SM.canStartNext(two), true, '★ 我 + 1 AI → 点一下就能开');
  const s1 = SM.autoStartIfReady(two);
  ok(!!s1 && s1.kind === 'next', '真的开了');
  eq(two.players.length, 2, '★ AI 没被踢出房间（startNextRound 只留报名者）');
  ok(SM.findPlayer(two, 'bot1'), '★ AI 还在（这条挡的是「打完一局 AI 全消失」）');

  /* 1 真人 + 3 AI：同样一下。 */
  const four = settledRoom([P('me'), P('b1', { bot: true }), P('b2', { bot: true }), P('b3', { bot: true })]);
  eq(SM.nextRoundPlayers(four).length, 3, '三个 AI 都已报名');
  SM.wantNext(four, 'me');
  eq(SM.canStartNext(four), true, '★ 1 真人 + 3 AI 也是一下');
}

/* ================================================================ */
console.log('\n[3] 阈值没被顺手改掉：全真人房仍是「凑够 2 人即开」');
{
  /* 5 个真人：2 人报名即开，剩下 3 个这一把不参与（C-2 之前就是这个行为，
   * 只是以前要这 2 个人各点两次）。谁要是把门槛改成「所有真人必须表态」，
   * 这一条会红 —— 那是另一条规则，不该搭 C-2 的车。 */
  const five = settledRoom([P('a'), P('b'), P('c'), P('d'), P('e')]);
  SM.wantNext(five, 'a');
  SM.wantNext(five, 'b');
  eq(SM.canStartNext(five), true, '★ 5 人房里 2 人报名 → 可开');
  const r = SM.startNextRound(five);
  ok(r.ok, '开得起来', r.error);
  eq(five.players.length, 2, '新一局只有报名的那两个');
  eq(r.removed.length, 3, '另外 3 人进 removed（服务端据此通知他们）');
  ok(five.players.every(function (p) { return !p.wantNext && !p.ready; }),
    '新一局把报名与就位都清掉（下一把重新来）');
}

/* ================================================================ */
console.log('\n[4] 侧门保持原样：从房号摸进来的人仍要自己点准备');
{
  const room = settledRoom([P('a'), P('b')]);
  const j = SM.joinRoom(room, P('x'));
  ok(j.ok, '结算期能进房', j.error);
  const x = SM.findPlayer(room, 'x');
  eq(x.wantNext, true, '自动算报名（否则开局时会被静默丢掉）');
  eq(x.ready, false, '★ 但不替他点准备 —— 他还没看到这间房长什么样');
  SM.wantNext(room, 'a');
  eq(SM.canStartNext(room), false, '★ 他卡着门槛：a 报了名也开不了（这是「不等他」存在的理由）');
  SM.setReady(room, 'x', true);
  eq(SM.canStartNext(room), true, '他点了准备就齐了');
}

/* ================================================================ */
console.log('\n[5] 撤回：报名与就位必须一起撤');
{
  const room = settledRoom([P('a'), P('b')]);
  SM.wantNext(room, 'a');
  const a = SM.findPlayer(room, 'a');
  eq(a.ready, true, '前置：报名即就位');
  const r = SM.unWantNext(room, 'a');
  ok(r.ok, '撤回成功', r.error);
  eq(a.wantNext, false, '报名撤掉');
  eq(a.ready, false, '★ 就位跟着撤掉（人不在下一局里却带着 ready 是自相矛盾的状态）');
  eq(room.phase, SM.PHASE.SETTLED, '仍停在结算态（回结算页看回放）');
  eq(SM.nextRoundPlayers(room).length, 0, '下一局名单里没有他了');
}

/* ================================================================ */
console.log('\n[6] 旧客户端（restart）：仍然一条命令搞定');
{
  /* 缓存里还留着「开下一把」按钮的老页面调 restart。它以前是
   * 「报名 + 置 ready」两件事，C-2 之后 wantNext 已经带了 ready，
   * 这一条守的是「别把它改成只剩报名」。 */
  const room = settledRoom([P('owner'), P('b')]);
  const r = SM.restart(room, 'owner');
  ok(r.ok, 'restart 成功', r.error);
  const o = SM.findPlayer(room, 'owner');
  eq(o.wantNext, true, '报名');
  eq(o.ready, true, '就位');
}

/* ================================================================ */
console.log('\n[7] 结构不变量');
{
  /* wantNext 里那句 `p.ready = true` 是这一版的全部内容，用源码钉一次：
   * 光靠行为断言的话，「先置真再被别处覆盖」这种退化测不出来。 */
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'stateMachine.js'), 'utf8');
  const fnStart = src.indexOf('function wantNext(');
  const fnEnd = src.indexOf('function unWantNext(');
  ok(fnStart > 0 && fnEnd > fnStart, 'wantNext / unWantNext 都在');
  const body = src.slice(fnStart, fnEnd);
  ok(/p\.wantNext = true;/.test(body), 'wantNext 里置报名');
  ok(/p\.ready = true;/.test(body), '★ wantNext 里同时置就位（删掉这一行就等于回滚 C-2）');
  ok(!/p\.ready = false;/.test(body), '★ 不许在 wantNext 里把就位清掉');
  eq(CONFIG.MIN_PLAYERS, 2, '门槛还是 2（C-2 只改流程，不改阈值）');
}

console.log('\n----------------------------------------');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) process.exit(1);
