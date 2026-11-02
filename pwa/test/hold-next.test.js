/**
 * 「等个人」与「局中进房旁听」的守卫（v122）
 * 跑法：node pwa/test/hold-next.test.js
 *
 * 真机上报的场景（三个人都是真人）：
 *   打完一局停在结算页，三个人都点了「开始下一局」→ 服务端立刻发牌。
 *   第四个人恰好在这时输完房号，撞上「这局正在打，等这局结束再进来」，
 *   被关在门外整整一局（可能 10 把）。
 *
 * 这不是并发竞态（服务端单线程、消息串行），是**窗口关闭**：
 *   · 结算期是唯一能「加入并参与」的时刻，最后一个人点下的瞬间它就关了；
 *   · 门外有没有人，服务端**不可能知道** —— 没有连接、没有房间、没有意图。
 *
 * 所以修法是两件，缺一不可：
 *   ① 房主能明说「先别开牌，我朋友在输房号」（setHoldNext）；
 *   ② 来不及说的场合，晚到的人**进得来**，只是这一把旁听（joinRoom 局中放行）。
 *
 * 守的东西：
 *   [1] 挂起真的挡住开局；解除立刻开
 *   [2] 只有房主能挂、只有结算期能挂
 *   [3] 出门（离开 / 换房主 / 3 分钟到点）都要自动失效 —— 不许变成一个「没有理由的卡死」
 *   [4] 开局时清掉，不带到下一场
 *   [5] 局中加入 = 旁听，不进 playingPlayers，不挂分牌计时器
 *   [6] 两端接线：协议动作、payload.on、本地模式、结算页那块
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

const ROOT = path.join(__dirname, '..', '..');
function src(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

function P(id, isBot) { return { id: id, nickname: id, isBot: !!isBot }; }

/* 建房 → 全员准备 → 开局 → 全员同意结束 → 停在结算期（走真实路径）。 */
function settled(ids) {
  const room = SM.newRoom('R-HOLD', P(ids[0]));
  room.cap = Math.max(ids.length, 8);
  ids.slice(1).forEach(function (id) { SM.joinRoom(room, P(id)); });
  room.players.forEach(function (p) { p.ready = true; });
  SM.startGame(room, ids[0]);
  SM.proposeDissolve(room, ids[0]);
  SM.activePlayers(room).slice(1).forEach(function (p) { SM.voteDissolve(room, p.id, true); });
  return room;
}

/* ================================================================ */
console.log('\n[1] 挂起挡住开局；解除立刻开');
{
  const room = settled(['a', 'b', 'c']);
  ['a', 'b', 'c'].forEach(function (id) { SM.wantNext(room, id); });
  eq(SM.canStartNext(room), true, '前置：三个人都表态 → 可以开');

  const r = SM.setHoldNext(room, 'a', true);
  ok(r.ok, '房主挂起「先别开牌」', r.error);
  eq(SM.canStartNext(room), false, '★ 挂起之后不开了（哪怕全员已报名、全部就位、无人未表态）');
  eq(SM.autoStartIfReady(room), null, '★ 自动开局也不会偷偷绕过它');
  eq(room.phase, SM.PHASE.SETTLED, '房间仍停在结算期，谁都没被打扰');
  ok(!!SM.holdNextOf(room), 'holdNextOf 认为「正在等」');

  const off = SM.setHoldNext(room, 'a', false);
  ok(off.ok, '解除挂起', off.error);
  ok(!SM.holdNextOf(room), 'holdNextOf 认为「没在等」');
  const started = SM.autoStartIfReady(room);
  ok(started && started.kind === 'next', '★ 解除后人都齐了 → 立刻开牌（不用再点一次）');
  eq(room.phase, SM.PHASE.ROUND1_SPLIT, '真的进入发牌阶段');
}

/* ================================================================ */
console.log('\n[2] 只有房主能挂，只有结算期能挂');
{
  const room = settled(['a', 'b', 'c']);
  const r1 = SM.setHoldNext(room, 'b', true);
  eq(r1.ok, false, '★ 非房主不行（时机是整桌的规则，要一个人负责）');
  ok(SM.holdNextOf(room) === null, '被拒之后没有留下半个状态');

  const waiting = SM.newRoom('R-WAIT', P('a'));
  SM.joinRoom(waiting, P('b'));
  const r2 = SM.setHoldNext(waiting, 'a', true);
  eq(r2.ok, false, '★ 还在等人开局（WAITING）时不行 —— 那时本来就没开牌');
  eq(r2.code, 'NOT_SETTLED', '给了可区分的错误码');

  const playing = settled(['a', 'b']);
  SM.wantNext(playing, 'a');
  SM.wantNext(playing, 'b');
  SM.startNextRound(playing);
  const r3 = SM.setHoldNext(playing, 'a', true);
  eq(r3.ok, false, '★ 打牌中不行');
}

/* ================================================================ */
console.log('\n[3] 三条自动失效的出口：离开 / 换房主 / 到点');
{
  /* 3a 房主自己离开 */
  const room = settled(['a', 'b', 'c']);
  ['a', 'b', 'c'].forEach(function (id) { SM.wantNext(room, id); });
  SM.setHoldNext(room, 'a', true);
  SM.leaveRoom(room, 'a');
  ok(SM.holdNextOf(room) === null, '★ 挂起的人走了 → 等待立刻作废（否则别人被一个不在房里的人挡住）');
  eq(room.holdNext, null, '字段也清干净了，不留旧时间戳');

  /* 3b 房主换人：ensureLiveOwner 之后旧人的等待不算数 */
  const room2 = settled(['a', 'b', 'c']);
  ['a', 'b', 'c'].forEach(function (id) { SM.wantNext(room2, id); });
  SM.setHoldNext(room2, 'a', true);
  SM.findPlayer(room2, 'a').left = true;
  const moved = SM.ensureLiveOwner(room2);
  ok(moved, '前置：房主转移给了下一个人');
  ok(SM.holdNextOf(room2) === null, '★ 换房主后旧人的等待失效（holdNextOf 按 ownerId 比对）');

  /* 3c 3 分钟到点 */
  const room3 = settled(['a', 'b', 'c']);
  ['a', 'b', 'c'].forEach(function (id) { SM.wantNext(room3, id); });
  SM.setHoldNext(room3, 'a', true);
  room3.holdNext.at = Date.now() - SM.HOLD_TTL_MS - 1;
  ok(SM.holdNextOf(room3) === null, '★ 超过 3 分钟自动失效（「等个人」不该变成「全桌锁死」）');
  eq(SM.holdNextLeftMs(room3), 0, '剩余时间读到 0');
  eq(SM.canStartNext(room3), true, '失效之后又能开了');

  /* 3d 连点不续期 */
  const room4 = settled(['a', 'b', 'c']);
  SM.setHoldNext(room4, 'a', true);
  const first = room4.holdNext.at;
  room4.holdNext.at = first - 60000;      // 假装已经等了一分钟
  SM.setHoldNext(room4, 'a', true);
  eq(room4.holdNext.at, first - 60000, '★ 再点一次不重置计时（否则多按几下等于无限续期）');
}

/* ================================================================ */
console.log('\n[4] 开局时清掉，不带到下一场');
{
  const room = settled(['a', 'b', 'c']);
  ['a', 'b', 'c'].forEach(function (id) { SM.wantNext(room, id); });
  SM.setHoldNext(room, 'a', true);
  /* 直接造「已放行」的状态：调用 startNextRound 前先清（真实链路里是 setHoldNext(false)），
   * 这里要验证的是 startNextRound 自己的兜底 —— 万一以后有人加了别的开牌路径。 */
  room.holdNext.at = 0;
  const r = SM.startNextRound(room);
  ok(r.ok, '开局成功', r.error);
  eq(room.holdNext, null, '★ 开牌后「等个人」被清掉，下一场结算页不会凭空显示在等');
}

/* ================================================================ */
console.log('\n[5] 局中加入 = 旁听（v122）');
{
  const room = SM.newRoom('R-MID', P('a'));
  room.cap = 8;
  SM.joinRoom(room, P('b'));
  room.players.forEach(function (p) { p.ready = true; });
  SM.startGame(room, 'a');
  eq(room.phase, SM.PHASE.ROUND1_SPLIT, '前置：已经开打了');

  const r = SM.joinRoom(room, P('late'));
  ok(r.ok, '★ 打牌中也能进房（以前直接拒：「这局正在打」）', r.error);
  const late = SM.findPlayer(room, 'late');
  eq(late.benched, true, '★ 进来即旁听');
  eq(late.wantNext, false, '旁听 ≠ 报名下一局');
  eq(late.ready, false, '没就位（他还没看到结算页）');
  eq((late.hand || []).length, 0, '手上没有这一把的牌');
  eq(late.joinedLate, true, '标记「结算期/局中才来」（前端不弹别人的结算）');
  eq(SM.playingPlayers(room).map(function (p) { return p.id; }).sort().join(','), 'a,b',
    '★ 在打的人仍是 a,b（旁听不进 playingPlayers）');

  /* 牌局照常结束 → 他进结算页但不排名次，下一局可以报名 */
  SM.proposeDissolve(room, 'a');
  SM.activePlayers(room).forEach(function (p) {
    if (p.id !== 'a' && !p.left) SM.voteDissolve(room, p.id, true);
  });
  eq(room.phase, SM.PHASE.SETTLED, '结算了');
  eq(SM.nextRoundPlayers(room).length, 0, '结算页刚出来时没人自动报名');
  SM.wantNext(room, 'late');
  eq(SM.findPlayer(room, 'late').benched, false, '★ 报名下一局就把旁听身份摘掉');
}

/* ================================================================ */
console.log('\n[6] 接线守卫（单测绿、真机失败过两次，都是这一层漏的）');
{
  const hub = src('server/hub.js');
  const rs = src('pwa/js/roomStore.js');
  const sv = src('pwa/js/settleView.js');
  const html = src('pwa/index.html');
  const game = src('pwa/js/game.js');

  ok(/case 'holdNext':/.test(hub), '★ 协议分发里有 holdNext');
  ok(/SM\.setHoldNext\(found\.room, found\.playerId, !!\(payload && payload\.on\)\)/.test(hub),
    '★ 服务端读 payload.on');
  ok(/_armHoldTimer\(found\.roomId\)/.test(hub), '★ 挂起时真的挂了到期 timer（否则到点没人清）');
  ok(/_clearHoldTimer\(roomId\)/.test(hub.slice(hub.indexOf('_deleteRoom'))), '回收房间时清 timer');

  /* 加入也要判一次开局：两人房走了一个、新人补位的那一下，全靠这里。 */
  ok(/this\._maybeAutoStart\(roomId\);/.test(hub.slice(hub.indexOf('joinRoom(client, payload, reqId) {'), hub.indexOf('leaveRoom(client, reqId) {'))),
    '★ joinRoom 之后判一次自动开局（补位凑齐人数的那一刻）');
  ok(/if \(p\.benched\) return;/.test(hub), '★ 旁听者不挂分牌计时器（否则 60 秒后判他弃权）');

  ok(/holdNext: function \(roomId, on\)/.test(rs), '联机侧有 holdNext');
  ok(/type: 'holdNext', payload: \{ on: !!on \}/.test(rs), '★ payload.on 包这一层（v117 / v121 各踩过一次）');
  ok(/holdNext: function \(roomId, playerId, on\)/.test(rs), '本地模式有实现');
  ok(/MODE === 'local'\s*\n\s*\? Promise\.resolve\(local\.holdNext/.test(rs), '对外接口接到两条路上');

  ok(/data-hold-next/.test(sv) && /data-hold-next/.test(game), '★ 按钮走委托（渲染不绑事件）');
  /* 「等个人」并进把数那一行（v122 定稿）：结算页高度是硬约束，
   * 单独一块会把内容推到动作条下面（ui-flow 报 cover 4177px²）。
   * 所以它必须挂在 handLimitBlock 里，而 handLimitBlock 必须真的被画进结算页。 */
  ok(/function handLimitBlock/.test(sv) && /setAttribute\('data-hold-next'/.test(sv),
    '★ 「等个人」并进把数行（不新增块高度）');
  ok(/inner\.appendChild\(handLimitBlock\(room\)\)/.test(sv), '★ 它真的被画进结算页（不只是导出）');
  ok(/btn-hold-off/.test(html) && /btn-hold-off/.test(game), '★ 就位态也有解除入口（房主点完下一局后够得着）');
  ok(/onHoldNext/.test(game), '前端有动作实现');
}

/* ================================================================ */
console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
