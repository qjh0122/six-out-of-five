/**
 * 分牌计时器：第二轮也得挂上
 * 跑法：node server/test/split-timer-round2.test.js
 *
 * Bug 形态：`_broadcast` 里 `_armSplitTimers` 跑在 `_autoBots` **之前**，
 * 而「第一轮 → 第二轮」这一步恰恰是 AI 提交触发的。
 * 于是第二轮一开始，一个计时器都没挂：
 *
 *   · 前端 `syncSplitTimer` 拿不到 `splitEndsAt` → 倒计时 chip 直接隐藏，
 *     玩家看不到「还剩 N 秒」，也就不知道自己在被倒计时；
 *   · 更糟的是**没有超时弃权**。第二轮里谁都不先动手，整桌就一直卡着 ——
 *     谁先离开谁丢分，而房间因为有活连接也走不到 idle 回收。
 *
 * 「挂机不卡桌」这条防线在第二轮是空的，而它正是当初写 SPLIT_TIMEOUT 的理由。
 *
 * 修法是把 `_armSplitTimers` 挪到 `_autoBots` 之后：挂的永远是「AI 推进完之后
 * 真正所处的那个阶段」。幂等由 `_armOneSplitTimer(…, true)` 保证。
 *
 * 为什么不用 WS 端到端：这里要验的是「广播链路里的挂计时器顺序」，
 * 直接驱动 hub 就能精确卡在那一刻，比起服务端再等 60 秒稳定得多。
 * 端到端的超时弃权行为由 forfeit-timeout.test.js 覆盖。
 */
'use strict';

const os = require('os');
const path = require('path');

process.env.PROFILE_FILE = path.join(os.tmpdir(), 'lxw-r2timer-' + Date.now() + '.json');

const SM = require('../../pwa/js/stateMachine.js');
const AI = require('../../pwa/js/ai.js');
const { Hub } = require('../hub.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

/* 只记「有没有被写」，不碰真档案 */
const hub = new Hub({
  profiles: { accountOf: () => ({ id: 'x' }), record: () => {}, get: () => null },
  log: () => {}
});

/* 造一个「1 真人 + n 个 AI」的已开局房间。
 * AI 不挂计时器，所以房间里只可能有一个 key，断言好写。 */
function botRoom(roomId, bots) {
  const r = SM.newRoom(roomId, { id: 'H', nickname: '真人' });
  for (let i = 1; i <= bots; i++) {
    SM.joinRoom(r, { id: 'bot_' + i, nickname: '机器人' + i, isBot: true });
  }
  SM.setReady(r, 'H', true);
  for (let i = 1; i <= bots; i++) SM.setReady(r, 'bot_' + i, true);
  SM.startGame(r, 'H');
  hub.rooms.set(roomId, r);
  return r;
}

console.log('\n[1] 第一轮：真人提交前，计时器在');

(function () {
  const r = botRoom('T100001', 1);
  hub._broadcast('T100001');
  const key = 'T100001#' + r.round + '#H';
  ok(hub.splitTimers.has(key), '★ 第一轮挂上了真人的计时器');
  ok(!!hub.splitStartedAt.get(key), '起始时刻也记了（前端才算得出倒计时）');
  const view = hub._view(r, 'H');
  ok(!!view.splitEndsAt, '★ 下发的视图里有 splitEndsAt');
  ok(typeof view.now === 'number', '同时下发服务端 now（客户端据此扣时钟偏差）');
})();

console.log('\n[2] 第二轮：AI 推进过去之后，计时器也必须立刻在');

(function () {
  const r = botRoom('T100002', 2);
  /* 真人交第一轮 → AI 跟着交 → 结算 → 翻到第二轮。
   * 以前这一步结束时 splitTimers 是空的。 */
  SM.submitGroups(r, 'H', AI.decide(SM.findPlayer(r, 'H').hand, 1));
  hub._broadcast('T100002');

  eq(r.phase, SM.PHASE.ROUND2_SPLIT, '确实翻到了第二轮');
  eq(r.round, 2, 'round 变成 2');

  const key = 'T100002#2#H';
  ok(hub.splitTimers.has(key), '★ 第二轮挂上了真人的计时器（这就是本次修复）');
  ok(!!hub.splitStartedAt.get(key), '★ 起始时刻也记了');

  const view = hub._view(r, 'H');
  ok(!!view.splitEndsAt, '★ 第二轮下发的视图里有 splitEndsAt（前端才显示倒计时）');
  ok(view.splitEndsAt > view.now, '截止时间在未来（不是一进来就「时间到」）');

  /* 反向：第一轮的 key 必须被清掉，不能两个 round 的计时器同时活着 */
  ok(!hub.splitTimers.has('T100002#1#H'), '★ 第一轮的计时器已清（不留孤儿）');
})();

console.log('\n[3] 不该挂的两类人：AI 与已提交者');

(function () {
  const r = botRoom('T100003', 2);
  hub._broadcast('T100003');
  const botKeys = [...hub.splitTimers.keys()].filter((k) => k.indexOf('bot_') >= 0);
  eq(botKeys.length, 0, '★ AI 一个计时器都没有');

  /* 真人提交之后，计时器回调里的 `q.submitted` 守卫会把它变成空转 ——
   * 这里不验「key 被删掉」（实现上是等它自然到期再删），验真正重要的事：
   * 反复广播之后，这个已提交的人**没有**被判弃权。 */
  SM.submitGroups(r, 'H', AI.decide(SM.findPlayer(r, 'H').hand, 1));
  for (let i = 0; i < 5; i++) hub._broadcast('T100003');
  const me = SM.findPlayer(r, 'H');
  eq(me.forfeitRound, null, '★ 已提交的人不会被判弃权（forfeitRound 为空）');
  ok(me.submitted.round1 === true, '他的提交记录还在（没被弃权覆盖）');
})();

console.log('\n[4] 重复广播不会把倒计时重新给满');

(function () {
  const r = botRoom('T100004', 1);
  hub._broadcast('T100004');
  const key = 'T100004#' + r.round + '#H';
  const started1 = hub.splitStartedAt.get(key);
  const timer1 = hub.splitTimers.get(key);

  for (let i = 0; i < 5; i++) hub._broadcast('T100004');

  eq(hub.splitStartedAt.get(key), started1, '★ 起始时刻没被刷新（否则永远不超时）');
  ok(hub.splitTimers.get(key) === timer1, '★ 计时器还是同一个句柄（幂等生效）');
})();

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
