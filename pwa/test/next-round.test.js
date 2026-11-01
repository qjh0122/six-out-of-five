/**
 * 结算后「开始下一局」报名制测试
 * 跑法：node pwa/test/next-round.test.js
 *
 * 这套规则的核心不是「能开下一局」，而是**没点的人不被打扰、也不挡别人**：
 *   · 有人点了「开始下一局」，房间必须仍停在 SETTLED ——
 *     一旦推到 WAITING，所有没点的人会被广播顶出结算页，正在看的回放当场消失
 *   · 分母是「已报名的人」而不是「房间里的人」，否则没点的人永远卡住别人
 *   · 房主不点也要能开（否则房主一关页面，剩下的人只能散场）
 *
 * 顺带覆盖「新的一局已经开始了」这条友好提示：它是玩家最可能撞到的一种「失败」，
 * 但玩家没做错任何事，所以必须是可读的一句话，不能是报错。
 */
'use strict';

const SM = require('../js/stateMachine.js');
const CONFIG = require('../js/config.js');
/* 初始分不写死：v105 已把基准改成 0，写死的 20 会让这个文件在改数值时假失败。 */

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

function P(id, isBot) {
  return { id: id, nickname: id, isBot: !!isBot };
}

/* 建房 → 全员准备 → 开局（状态机不会自动开局，这里显式调一次） */
function makeRoom(ids) {
  const room = SM.newRoom('R-NR', P(ids[0]));
  /* 上限 v82 收到 5；这里的场景（含 8 人房）都属于「老房间」，
   * 显式放宽上限，让这些用例继续测它们本来要测的东西（座位表 / 报名 / 结算）。
   * 新的 5 人上限由 pwa/test/player-cap.test.js 负责。 */
  room.cap = Math.max(ids.length, 8);
  ids.slice(1).forEach(function (id) { SM.joinRoom(room, P(id)); });
  room.players.forEach(function (p) { p.ready = true; });
  SM.startGame(room, ids[0]);
  return room;
}

/* 打到结算：全员同意解散。走真实路径，settledAt / handSeq / AI 预置都和线上一致。 */
function settleByDissolve(room) {
  const first = SM.activePlayers(room)[0];
  SM.proposeDissolve(room, first.id);
  SM.activePlayers(room).slice(1).forEach(function (p) {
    SM.voteDissolve(room, p.id, true);
  });
  return room;
}

/* ========================================================================== */
console.log('\n[1] 报名之后房间必须仍是结算态');
const room1 = settleByDissolve(makeRoom(['a', 'b']));
eq(room1.phase, SM.PHASE.SETTLED, '前置：房间在结算阶段');
const w1 = SM.wantNext(room1, 'a');
ok(w1.ok === true, 'a 点「开始下一局」成功', w1.error);
eq(room1.phase, SM.PHASE.SETTLED, '★ 报名后 phase 仍是 SETTLED（没点的人继续看结算页，不被顶走）');
eq(SM.findPlayer(room1, 'a').wantNext, true, 'a 已标记进入下一局');
ok(!SM.findPlayer(room1, 'b').wantNext, 'b 还没进入（没点就是没点）');
eq(SM.findPlayer(room1, 'a').ready, false, '报名不等于准备（回房间后要自己点准备）');
eq(SM.canStartNext(room1), false, '只报名不准备 → 还不能开');

/* ========================================================================== */
console.log('\n[2] 没报名的人不能准备');
const r2 = SM.setReady(room1, 'b', true);
eq(r2.ok, false, 'b 没点「开始下一局」就准备 → 被拒');
ok((r2.error || '').indexOf('开始下一局') >= 0, '提示说的是「先点开始下一局」，不是「对局已开始」', r2.error);

/* ========================================================================== */
console.log('\n[3] 分母是报名者，不是房间里所有人');
SM.wantNext(room1, 'b');
eq(SM.canStartNext(room1), false, '两人都报名但都没准备 → 还不能开');
SM.setReady(room1, 'a', true);
eq(SM.canStartNext(room1), false, '只有一个人准备 → 还不能开');
SM.setReady(room1, 'b', true);
eq(SM.canStartNext(room1), true, '★ 报名者全部准备 → 可以开');

/* ========================================================================== */
console.log('\n[4] 开局只带报名者，没点的人被移出并拿到通知');
const room4 = settleByDissolve(makeRoom(['a', 'b', 'c']));
SM.wantNext(room4, 'a');
SM.wantNext(room4, 'b');
SM.setReady(room4, 'a', true);
SM.setReady(room4, 'b', true);
const start4 = SM.autoStartIfReady(room4);
ok(!!start4 && start4.kind === 'next', '全员就绪 → 自动开下一局');
eq(room4.phase, SM.PHASE.ROUND1_SPLIT, '进入第一轮分牌');
eq(room4.players.length, 2, '★ 新一局只有 a、b 两个人');
ok(!SM.findPlayer(room4, 'c'), '没点的 c 不在新一局里');
ok(start4.removed.indexOf('c') >= 0, '★ c 在 removed 名单里（服务端据此通知他「新的一局开始了」）');
ok(room4.players.every(function (p) { return p.hand.length === 6; }), '新一局每人都拿到 6 张牌');
ok(room4.players.every(function (p) { return p.score === CONFIG.INITIAL_SCORE; }), '分数重置为初始分');
ok(room4.players.every(function (p) { return !p.wantNext; }), 'wantNext 清零（下一局结算要重新报名）');

/* ========================================================================== */
console.log('\n[5] 房主没报名 → 所有权转移，别人照样能开');
const room5 = settleByDissolve(makeRoom(['owner', 'b', 'c']));
ok(room5.ownerId === 'owner', '前置：房主是 owner');
SM.wantNext(room5, 'b');
SM.wantNext(room5, 'c');
SM.setReady(room5, 'b', true);
SM.setReady(room5, 'c', true);
ok(SM.canStartNext(room5), '房主没报名也不挡别人（分母里没有他）');
const start5 = SM.autoStartIfReady(room5);
ok(!!start5 && start5.kind === 'next', '★ 房主没点也照样开局');
ok(room5.ownerId !== 'owner', '★ 所有权交给了留下的人（否则补 AI / 发起解散会失效）');
ok(room5.ownerId === 'b' || room5.ownerId === 'c', '新房主是 b 或 c', room5.ownerId);

/* ========================================================================== */
console.log('\n[6] AI 自动报名 + 自动准备（单人 + AI 局不会被卡住）');
const room6 = SM.newRoom('R-NR', P('solo'));
SM.joinRoom(room6, P('bot_1', true));
room6.players.forEach(function (p) { p.ready = true; });
SM.startGame(room6, 'solo');
settleByDissolve(room6);
/* 解散票只算真人，AI 不计票，solo 一个人同意即可 */
const bot = SM.findPlayer(room6, 'bot_1');
eq(bot.wantNext, true, '★ AI 在结算时被自动标记进入下一局');
eq(bot.ready, true, '★ AI 自动准备（它不会自己点按钮）');
SM.wantNext(room6, 'solo');
SM.setReady(room6, 'solo', true);
ok(SM.canStartNext(room6), '单人 + AI 也能凑够人数开下一局');
const start6 = SM.autoStartIfReady(room6);
ok(!!start6 && start6.kind === 'next', '单人 + AI 局开下一局成功');
eq(room6.players.length, 2, 'AI 跟着进了新一局');

/* ========================================================================== */
console.log('\n[7] 新的一局已经开始了 → 友好拒绝（不报错、不挤进去）');
const lateWant = SM.wantNext(room6, 'solo');
eq(lateWant.ok, false, '新局进行中再点「开始下一局」→ 被拒');
eq(lateWant.code, 'NEXT_STARTED', '★ 带 NEXT_STARTED 标记（前端可据此区分处理）');
ok((lateWant.error || '').indexOf('已经开始了') >= 0, '★ 文案是「新的一局已经开始了」，不是冷冰冰的「非法状态」', lateWant.error);
ok((lateWant.error || '').indexOf('等这局打完') >= 0, '还说清了接下来该怎么办');

/* ========================================================================== */
console.log('\n[8] 打牌中进不来（这一条不变）');
const playing = makeRoom(['a', 'b']);
const joinPlaying = SM.joinRoom(playing, P('x'));
eq(joinPlaying.ok, false, '打牌中进不来');
eq(joinPlaying.code, 'ROOM_PLAYING', '★ 打牌中 → ROOM_PLAYING');
ok(joinPlaying.error.indexOf('正在打') >= 0, '文案是「这局正在打」', joinPlaying.error);

/* ========================================================================== */
/* 结算期必须能进来 —— 这是真机上被报回来的：
 * 「我点了继续下一局已经进房间了，朋友（他不在上一局）加不进来」。
 *
 * 查下去比「等几十秒」严重得多：phase 只在 newRoom 那一刻写成 WAITING，
 * 之后**一直**在 SPLIT / SETTLED 之间来回。也就是说房间从第一局打完起，
 * 对新人就是永久锁门 —— 打牌中被拒、结算中也被拒，再没有第三个窗口。 */
console.log('\n[8b] 结算期可以进来，而且必须被带进下一局');
const settling = settleByDissolve(makeRoom(['a', 'b']));
const joinSettling = SM.joinRoom(settling, P('x'));
eq(joinSettling.ok, true, '★ 结算期进房成功（以前这里被拒 → 房间第一局打完就再进不来人）');
const x = SM.findPlayer(settling, 'x');
ok(!!x, '新人在房间里');
eq(x.wantNext, true, '★ 自动算「报名下一局」：否则 startNextRound 会把他静默丢掉');
eq(x.joinedLate, true, '★ 标记「没打上一局」（前端据此不弹上一局结算、分数不写上局）');
eq(x.ready, false, '不替他点准备（准备是他自己的动作）');
eq(x.score, CONFIG.INITIAL_SCORE, '分数是初始分，不继承别人的');

/* 他真的能被带进下一局，不是「进来了但开下一局时消失」。
 * 分母是「已报名的人」，所以新人必须自己算进这个分母 —— 只挂个座位不算数。 */
SM.wantNext(settling, 'a'); SM.setReady(settling, 'a', true);
eq(SM.canStartNext(settling), false, '只有 a 报名 + 准备 → 人数不够（MIN_PLAYERS=2）');
SM.setReady(settling, 'x', true);
eq(SM.canStartNext(settling), true, '★ 新人报名且准备后人数够了（他确实被算进下一局，不是挂名）');
SM.startNextRound(settling);
eq(settling.phase, SM.PHASE.ROUND1_SPLIT, '下一局开了');
ok(!!SM.findPlayer(settling, 'x'), '★ 新人没有在开局瞬间被丢掉');
eq(SM.findPlayer(settling, 'x').hand.length, 6, '★ 新人手里有牌（真的进了这一局）');
eq(SM.findPlayer(settling, 'x').joinedLate, false, '新一局开始后 joinedLate 清掉（下一把结算要照常弹）');

/* 打起来之后仍然进不来 —— 这条边界不能被上面的放行顺带破掉 */
const joinDuringPlay = SM.joinRoom(settling, P('late'));
eq(joinDuringPlay.ok, false, '新一局开打后再来人 → 仍然拒绝');
eq(joinDuringPlay.code, 'ROOM_PLAYING', '★ 仍是 ROOM_PLAYING');

/* 结算期里「中途离开过」的人也能回来：以前 findPlayer 命中 → 幂等返回 → 状态还是 left，
 * 之后点什么都回「你已经离开这一局了」，人卡在房间里出不来 */
const roomLeft = settleByDissolve(makeRoom(['a', 'b']));
SM.findPlayer(roomLeft, 'b').left = true;
const rejoin = SM.joinRoom(roomLeft, P('b'));
eq(rejoin.ok, true, '离开过的人能在结算期回到房间');
eq(SM.findPlayer(roomLeft, 'b').left, false, '★ left 被清掉（否则点什么都报错）');
eq(roomLeft.players.length, 2, '没有多出一个重复座位');

/* ========================================================================== */
/* [8c] 座位表只认「在场的人」
 *
 * 结算期离开的人只是 left=true，仍然留在 room.players 里（他的分数还要参与结算）。
 * 前端如果直接拿 room.players 当座位表：
 *   · 已经走了的人继续占着一个格子（界面在说谎）；
 *   · 满员时更糟 —— 8 人里走 1 个、再进 1 个新人，数组变 9 而格子只有 8，
 *     第 9 个正好是那个新人，他会被画在格子外面，自己在房间里看不到自己。
 */
console.log('\n[8c] 座位表 = 在场的人，不是 room.players');
const eight = [];
for (let i = 0; i < 8; i++) eight.push('p' + i);
const big = settleByDissolve(makeRoom(eight));
eq(big.phase, SM.PHASE.SETTLED, '前置：8 人房已结算');
eq(SM.roomSeats(big).length, 8, '前置：8 个座位');

SM.leaveRoom(big, 'p3');                       // 结算期离开：只置 left，不删
eq(SM.findPlayer(big, 'p3').left, true, 'p3 已离开');
eq(big.players.length, 8, '★ 离开的人仍在 players 里（分数要结算）');
eq(SM.roomSeats(big).length, 7, '★ 但座位表只剩 7 个（走了的人不该占座）');

const joinFull = SM.joinRoom(big, P('newbie'));
eq(joinFull.ok, true, '满员里有人离开 → 新人能进来（按在场人数判满）');
eq(big.players.length, 9, '★ players 变成 9（含 1 个已离开的人）');
eq(SM.roomSeats(big).length, 8, '★ 座位表仍是 8 —— 数组再长，格子也就 8 个');
ok(SM.roomSeats(big).length <= 8, '★ 座位数不超过 MAX_PLAYERS（否则第 9 个人画不出来）');
ok(SM.roomSeats(big).indexOf(SM.findPlayer(big, 'newbie')) >= 0, '★ 新人被画进座位（不会「进来了但看不到自己」）');
ok(SM.roomSeats(big).indexOf(SM.findPlayer(big, 'p3')) < 0, '★ 已离开的人不在座位表里');
eq(SM.findPlayer(big, 'newbie').joinedLate, true, '新人是 joinedLate（前端据此隐藏「上一局结算」）');


/* ========================================================================== */
console.log('\n[9] 所有人都没报名 → 房间停在结算态，什么都不发生');
const room9 = settleByDissolve(makeRoom(['a', 'b']));
eq(SM.autoStartIfReady(room9), null, '没人报名 → 不开局');
eq(room9.phase, SM.PHASE.SETTLED, '房间仍在结算态（可以一直看回放）');
eq(room9.players.length, 2, '两个人还都在房间里（没报名不等于被踢）');

/* ========================================================================== */
console.log('\n[10] 报名人数不足最少人数 → 不能开');
const room10 = settleByDissolve(makeRoom(['a', 'b']));
SM.wantNext(room10, 'a');
SM.setReady(room10, 'a', true);
eq(SM.canStartNext(room10), false, '只有 1 人报名 → 人数不足，不能开');
eq(SM.autoStartIfReady(room10), null, '也就不会开局');
eq(room10.phase, SM.PHASE.SETTLED, '继续停在结算态，等别人报名');

/* ========================================================================== */
console.log('\n[11] 第二局打完还能再开第三局（报名状态必须被清干净）');
const room11 = settleByDissolve(makeRoom(['a', 'b']));
SM.wantNext(room11, 'a'); SM.wantNext(room11, 'b');
SM.setReady(room11, 'a', true); SM.setReady(room11, 'b', true);
SM.autoStartIfReady(room11);
const seqAfter2 = room11.handSeq;
settleByDissolve(room11);
eq(room11.handSeq, seqAfter2 + 1, '第二局结算 → handSeq 继续递增');
SM.wantNext(room11, 'a'); SM.wantNext(room11, 'b');
SM.setReady(room11, 'a', true); SM.setReady(room11, 'b', true);
ok(!!SM.autoStartIfReady(room11), '★ 第二局结算后还能开第三局（wantNext 已被上一局清掉）');
eq(room11.phase, SM.PHASE.ROUND1_SPLIT, '第三局进入分牌');

/* ========================================================================== */
console.log('\n[12] 报名可以撤回（「开始下一局」不再是单向门）');
/* 以前 wantNext 一旦置真，除了开局和离开房间没有任何出口能改回来。
 * 同一屏上「准备」能取消、「报名」不能取消，点错一次只能退房重进。 */
const room12 = settleByDissolve(makeRoom(['a', 'b']));
SM.wantNext(room12, 'a');
SM.setReady(room12, 'a', true);
eq(SM.nextRoundPlayers(room12).length, 1, '报名后进入下一局名单');

const uw = SM.unWantNext(room12, 'a');
ok(uw.ok === true, '可以撤回报名');
eq(SM.nextRoundPlayers(room12).length, 0, '撤回后不在下一局名单里');
const pa12 = SM.findPlayer(room12, 'a');
eq(pa12.wantNext, false, 'wantNext 已清');
eq(pa12.ready, false, '★ 准备标记跟着撤（不留「不在局里却已准备」）');
eq(room12.phase, SM.PHASE.SETTLED, '★ 撤回不改变 phase —— 人还留在结算页，回放不丢');
ok(SM.unWantNext(room12, 'a').ok === true, '连撤两次不报错（幂等）');

/* 开局之后撤回不了。这是唯一一种撤回失败，必须给可读原因：
 * 玩家没做错事，只是慢了一步，不能给他一个红叉。 */
SM.wantNext(room12, 'a'); SM.wantNext(room12, 'b');
SM.setReady(room12, 'a', true); SM.setReady(room12, 'b', true);
ok(!!SM.autoStartIfReady(room12), '两人都报名 + 准备 → 正常开局');
eq(room12.voided, false, '★ 开了新一局，「上一把作废」标记被清掉（否则新一局也不记战绩）');
eq(room12.endReason, null, 'endReason 一并清空');
const uwLate = SM.unWantNext(room12, 'a');
ok(uwLate.ok === false, '开局后撤回被拒');
eq(uwLate.code, 'NEXT_STARTED', '带 NEXT_STARTED，前端据此说人话而不是弹报错');
ok(/已经开始了/.test(uwLate.error), '文案说清「已经开始了」：' + uwLate.error);

/* 撤回会让满足条件的人变少，绝不能反过来触发开局 */
const room12b = settleByDissolve(makeRoom(['a', 'b']));
SM.wantNext(room12b, 'a'); SM.wantNext(room12b, 'b');
SM.unWantNext(room12b, 'b');
eq(SM.canStartNext(room12b), false, '★ 有人撤回 → 开局条件不再满足');
eq(SM.autoStartIfReady(room12b), null, '撤回不会触发开局');

/* ========================================================================== */
console.log('\n[13] 中途结束本局 → 这一把作废（不进任何档案）');
/* 解散时分数根本没动过（分数只在正常结算里加减），照常落库就会记成
 * 「净胜 0」的一场平局：场次 +1、胜率被稀释、连胜被清零。
 * 两个标记各管一头：voided 管落库，endReason 管结算页怎么解释。 */
const room13 = settleByDissolve(makeRoom(['a', 'b']));
eq(room13.voided, true, '★ voided 为真（hub 据此跳过落库）');
eq(room13.endReason, 'dissolve', '★ endReason 为 dissolve（结算页据此说明为什么结束）');
eq(SM.newRoom('R-FRESH', P('z')).voided, false, '新房间默认不作废');

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
if (fail > 0) process.exitCode = 1;
