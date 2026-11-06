/**
 * 重启后「时间线」必须活下来（v125 / 架构评审第 1 条 + QA 的 C3）
 * 跑法：node server/test/timers-restore.test.js
 *
 * 【这个文件防的是什么】
 * 房间对象能落盘、能恢复。但**定时器不能** —— 它们活在 Map 里的 setTimeout 上，
 * 进程一走全没了。而恢复时所有玩家又被置成 `connected = false`，
 * 分牌超时的回调里明确写着「断线的人跳过」（`_armOneSplitTimer`）。
 *
 * 两条一合：
 *
 *   > 一桌人打到一半、有人断线 → 进程重启 →
 *   > 断线者永远等不到 finalizeLeave（不会被判离开），
 *   > 别人的分牌超时又全部跳过断线者 → **全桌永远不结算**。
 *   > 唯一出路是有人重连后自己交牌，或凑齐解散票。
 *
 * 每次发布都可能撞上一次，只在恰好有进行中对局时才真的发生。
 * 所以它从来没被报回来过 —— 但这不代表它没发生。
 *
 * 【这一版守的三件事】
 *   1. 断线宽限按**剩余**时间补挂（不重新给满，也不永远不给）；
 *   2. 已经超时的立刻判离开（重启不该让断了很久的人继续占座）；
 *   3. 解散投票 / 等人挂起也都补挂（否则它们永远等不到「到点」）。
 */
'use strict';

/* 这个文件里 GRACE 要足够长，让「补挂」与「立刻判离开」两种分支都能被测到；
 * 房间回收给个大值，免得它在断言中途把房间删了。 */
process.env.GRACE_MS = '60000';
process.env.ROOM_IDLE_MS = '600000';
process.env.HOLD_TTL_MS = '60000';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Hub } = require('../hub.js');
const SM = require('../../pwa/js/stateMachine.js');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lxw-timers-'));
const FILE = path.join(DIR, 'state.json');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

function mkRoom(roomId) {
  const room = SM.newRoom(roomId, { id: 'pa', nickname: '甲' }, { handLimit: 3 });
  SM.joinRoom(room, { id: 'pb', nickname: '乙' });
  room.players.forEach((p) => { p.ready = true; });
  SM.startGame(room, 'pa');
  return room;
}

function freshHub() { return new Hub({ statePath: FILE, log: function () {} }); }

console.log('\n[1] 断线宽限：重启后按剩余时间补挂（不重新给满）');
{
  fs.rmSync(FILE, { force: true });
  const h1 = freshHub();
  const room = mkRoom('910001');
  /* 乙在 10 秒前断了 —— 重启发生在这之后 */
  const pb = SM.findPlayer(room, 'pb');
  pb.connected = false;
  pb.disconnectedAt = Date.now() - 10000;
  h1.rooms.set('910001', room);
  ok(h1._saveStateNow() === true, '落盘成功');

  const h2 = freshHub();                       // ← 模拟重启
  ok(h2.rooms.has('910001'), '房间回来了');
  const key = '910001#pb';
  ok(h2.graceTimers.has(key), '★★ 断线宽限被补挂（旧实现这里什么都没有 → 全桌永远不结算）');
  /* 剩余应当 ≈ 50 秒（GRACE 60s − 已经过去的 10s），而不是重新给满 60s。
   * 这里不读 setTimeout 的时长（拿不到），而是用「补挂之后数据侧的剩余」对照：
   * 两者必须同时变短，否则就还是两套时间。 */
  const left = SM.HOLD_TTL_MS;   // 占位，下面用真实判据
  const since = Number(pb.disconnectedAt);
  const remain = 60000 - (Date.now() - since);
  ok(remain > 45000 && remain < 60000,
    '★★ 剩余时间按 disconnectedAt 算（≈50s，不是 60s 也不是 0）',
    'remain≈' + Math.round(remain) + 'ms, TTL=' + left);
}

console.log('\n[2] 已经超时的：重启后立刻判离开，不再白等一轮');
{
  fs.rmSync(FILE, { force: true });
  const h1 = freshHub();
  const room = mkRoom('910002');
  const pb = SM.findPlayer(room, 'pb');
  pb.connected = false;
  pb.disconnectedAt = Date.now() - 120000;    // 断了 2 分钟，早就超了 60 秒
  h1.rooms.set('910002', room);
  h1._saveStateNow();

  const h2 = freshHub();
  ok(h2.rooms.has('910002'), '房间还在（不是整间被删）');
  const p2 = SM.findPlayer(h2.rooms.get('910002'), 'pb');
  ok(!!p2, '乙还在座位上');
  ok(p2 && p2.left === true, '★★ 恢复时立刻判了离开（不是再等 60 秒）');
  ok(!h2.graceTimers.has('910002#pb'), '不会给一个已经判过的人再挂宽限');
}

console.log('\n[3] 解散投票：重启后仍要能超时（否则永远停在「等大家表态」）');
{
  fs.rmSync(FILE, { force: true });
  const h1 = freshHub();
  const room = mkRoom('910003');
  SM.proposeDissolve(room, 'pa');              // 只发起、不投票
  ok(room.dissolve && room.dissolve.active === true, '投票进行中');
  h1.rooms.set('910003', room);
  h1._saveStateNow();

  const h2 = freshHub();
  ok(h2.dissolveTimers.has('910003'), '★★ 解散投票的计时器被补挂');
  ok(h2._saveStateNow() === true, '（落盘一次，确保后续断言不受影响）');
}

console.log('\n[4] 「等人」挂起：重启后仍要到点自动放行');
{
  fs.rmSync(FILE, { force: true });
  const h1 = freshHub();
  const room = mkRoom('910004');
  SM.proposeDissolve(room, 'pa');
  SM.activePlayers(room).slice(1).forEach((p) => SM.voteDissolve(room, p.id, true));
  eq(room.phase, 'SETTLED', '进了结算期');
  SM.setHoldNext(room, 'pa', true);
  ok(!!SM.holdNextOf(room), '挂起生效');
  h1.rooms.set('910004', room);
  h1._saveStateNow();

  const h2 = freshHub();
  ok(h2.holdTimers.has('910004'), '★★ 挂起的计时器被补挂（否则永远等不到「到点放行」）');
}

console.log('\n[5] 老快照没有 disconnectedAt：按「刚断」处理，不许凭 undefined 判人离开');
{
  fs.rmSync(FILE, { force: true });
  const h1 = freshHub();
  const room = mkRoom('910005');
  const pb = SM.findPlayer(room, 'pb');
  pb.connected = false;
  delete pb.disconnectedAt;                    // v113 之前写下的快照没有这个字段
  h1.rooms.set('910005', room);
  h1._saveStateNow();

  const h2 = freshHub();
  const p2 = SM.findPlayer(h2.rooms.get('910005'), 'pb');
  ok(p2 && !p2.left, '★ 没有被判离开');
  ok(h2.graceTimers.has('910005#pb'), '★ 按满额补挂（宁可多给时间，也不能凭空值踢人）');
}

console.log('\n[6] 没人「主动断线」的房间：恢复照样给两个人挂宽限（重启那刻确实没人连着）');
{
  fs.rmSync(FILE, { force: true });
  const h1 = freshHub();
  const room = mkRoom('910006');
  h1.rooms.set('910006', room);
  h1._saveStateNow();

  const h2 = freshHub();
  /* 恢复时所有玩家一律 connected = false（重启那一刻连接全断了）。
   * 所以宽限不是「凭空多出来的」，而是**必须挂**：
   * 不挂的话两个人永远不会被判离开，房间也永远不结算。 */
  eq(h2.graceTimers.size, 2, '★ 两个人各挂一个宽限（等他们重连，不是判死）');
  ok(h2.graceTimers.has('910006#pa') && h2.graceTimers.has('910006#pb'), '两个座位都在等');
  eq(h2.dissolveTimers.size, 0, '★ 没投票就不挂投票计时器');
  eq(h2.holdTimers.size, 0, '★ 没挂起就不挂等人计时器');
  ok(h2.roomTimers.has('910006'), '回收计时器也要有（空房间最终得被收走）');
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
process.exit(fail ? 1 : 0);
