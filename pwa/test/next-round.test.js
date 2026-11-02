/**
 * 结算后「开始下一局」报名制测试
 * 跑法：node pwa/test/next-round.test.js
 *
 * 这套规则的核心是**不替别人做决定**：
 *   · 有人点了「开始下一局」，房间必须仍停在 SETTLED ——
 *     一旦推到 WAITING，所有没点的人会被广播顶出结算页，正在看的回放当场消失
 *   · 开局要等**房间里所有真人都表态**（v121）。以前分母是「已报名的人」，
 *     于是三人房里两个人点了就按两人开，第三个还在看结算页的人被静默判成旁听 ——
 *     他什么都没做，只是慢了几秒。想先开只有一条路：明确「不等他」。
 *   · 房主不点同样会等（他不是特权，是另一个人）；但「不等他」能把他摘出去，
 *     所以房主关掉页面也不会让整桌散场。
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
eq(SM.findPlayer(room1, 'a').ready, true, '★ 报名即就位（C-2 / v116：不再需要回房间页点一次准备）');
eq(SM.canStartNext(room1), false, '只有 a 一人报名 → 人数不够，还不能开');

/* ========================================================================== */
console.log('\n[2] 没报名的人不能准备');
const r2 = SM.setReady(room1, 'b', true);
eq(r2.ok, false, 'b 没点「开始下一局」就准备 → 被拒');
ok((r2.error || '').indexOf('开始下一局') >= 0, '提示说的是「先点开始下一局」，不是「对局已开始」', r2.error);

/* ========================================================================== */
console.log('\n[3] 两个人都报名 → 可以开');
/* ★ C-2（v116）改口径：报名那一刻就置 ready，所以「两人都报名」= 「两人都就位」= 可以开。
 * 这一条正是「一次点击」的验收 —— 报完名不该再有一个「还差你点一下」的中间态。 */
SM.wantNext(room1, 'b');
eq(SM.canStartNext(room1), true, '★ 两人都报名 → 立刻可开（报名即就位，不再需要单独点准备）');
eq(SM.nextRoundPlayers(room1).length, 2, '参与名单就是这两人的名单');

/* ========================================================================== */
console.log('\n[4] 三人房：两个点了还不够，要等第三个（v121 的核心）');
const room4 = settleByDissolve(makeRoom(['a', 'b', 'c']));
SM.wantNext(room4, 'a');
SM.wantNext(room4, 'b');
/* ★ 这就是被报回来的那个 bug：以前这里直接按 2 人开局，c 被判旁听。
 * 他没做错任何事，只是还在看结算页。 */
eq(SM.canStartNext(room4), false, '★★ 三个人、两个报名 → 不开（等 c 表态）');
ok(!SM.autoStartIfReady(room4), '★ 自动开局也不会偷偷把 c 落下');
eq(SM.pendingNextPlayers(room4).map(function (p) { return p.id; }).join(','), 'c',
  '★ 卡住的人是 c，而且这个名单是公开的（前端拿它提示「等谁」）');
/* 想先开只有一条路：明确说不等。 */
const drop4 = SM.dropFromNext(room4, 'a', 'c');
ok(drop4.ok, '「不等 c」成功', drop4.error);
eq(SM.canStartNext(room4), true, '★ 明确不等他之后才开');
const start4 = SM.autoStartIfReady(room4);
ok(!!start4 && start4.kind === 'next', '全员就绪 → 自动开下一局');
eq(room4.phase, SM.PHASE.ROUND1_SPLIT, '进入第一轮分牌');
/* ★ C-3b（v118）：没报名的人不再被删出房间 —— 座位留着、名字留着，只是不参与这一局。 */
eq(room4.players.length, 3, '★ 新一局三个人都还在房间里（座位不删）');
eq(SM.playingPlayers(room4).length, 2, '★ 但只有 a、b 参与这一局');
eq(SM.playingPlayers(room4).map(function (p) { return p.id; }).sort().join(','), 'a,b', '参与名单就是 a、b');
const c4 = SM.findPlayer(room4, 'c');
ok(c4 && c4.benched === true, '★ 没点的 c 变成旁听（benched），座位与分数都还在');
eq(c4.hand.length, 0, '★ 旁听的人不发牌（发了他会被当成还在这一局里）');
eq(start4.removed.length, 0, '★ 没人被赶出房间（removed 为空）—— C-3b 的全部意义');
ok(SM.playingPlayers(room4).every(function (p) { return p.hand.length === 6; }), '参与的人各拿 6 张');
ok(room4.players.every(function (p) { return p.score === CONFIG.INITIAL_SCORE; }), '分数重置为初始分');
ok(room4.players.every(function (p) { return !p.wantNext; }), 'wantNext 清零（下一局结算要重新报名）');

/* ========================================================================== */
console.log('\n[5] 房主没报名 → 等不到就把他摘出去，别人照样能开');
const room5 = settleByDissolve(makeRoom(['owner', 'b', 'c']));
ok(room5.ownerId === 'owner', '前置：房主是 owner');
SM.wantNext(room5, 'b');
SM.wantNext(room5, 'c');
/* ★ v121：房主不再是「分母里没有他」。他也是房间里的人，也在等。
 * 这条变严了，但换来的是一致 —— 否则「房主可以不等，别人不行」。 */
ok(!SM.canStartNext(room5), '★ 房主没表态 → 先不开（他也得表态，或者被明确不等）');
ok(SM.dropFromNext(room5, 'b', 'owner').ok, '「不等房主」成功 —— 房主关掉页面也不会让整桌散场');
ok(SM.canStartNext(room5), '摘掉房主之后可以开');
const start5 = SM.autoStartIfReady(room5);
ok(!!start5 && start5.kind === 'next', '★ 房主没点也照样开局');
/* ★ C-3b 改了这里的答案：以前房主没报名就被删出房间，所有权必须转交。
 * 现在他还坐在房间里（只是旁听），补 AI、改把数这些房主权限仍然该由他持有 ——
 * 转交反而会让他「明明还在房间里，却什么都改不了」。 */
eq(room5.ownerId, 'owner', '★ 房主没报名但仍在房间里 → 所有权不转交（他还能补 AI / 改把数）');
eq(SM.findPlayer(room5, 'owner').benched, true, '他自己是旁听状态');

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
console.log('\n[8] 打牌中进得来，但只能旁听（v122）');
/* 以前这里是「打牌中进不来 → ROOM_PLAYING」。规则没错，代价错了：
 * 三个人在结算页都把「开始下一局」点了，第四个人恰好这时才输完房号，
 * 就被关在门外整整一局。牌确实不能中途补人（发都发了），
 * 但「进不来房间」和「这一把不打」是两件事。 */
const playing = makeRoom(['a', 'b']);
const joinPlaying = SM.joinRoom(playing, P('x'));
eq(joinPlaying.ok, true, '★ 打牌中也能进房（以前直接拒「这局正在打」）');
const xSeat = SM.findPlayer(playing, 'x');
eq(xSeat.benched, true, '★ 进来即旁听（牌已发完，不能中途补人）');
eq(xSeat.wantNext, false, '旁听 ≠ 报名下一局');
eq(xSeat.ready, false, '没就位（他还没看到结算页）');
eq((xSeat.hand || []).length, 0, '手上没有这一把的牌');
eq(SM.playingPlayers(playing).length, 2, '★ 在打的人仍是 2 个');

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
eq(x.ready, true, '★ 从房号进来即就位（v121：wantNext 和 ready 必须同步，否则界面写「已就位」而服务端还在等）');
eq(x.score, CONFIG.INITIAL_SCORE, '分数是初始分，不继承别人的');

/* 他真的能被带进下一局，不是「进来了但开下一局时消失」。 */
eq(SM.nextRoundPlayers(settling).length, 1, '还没人报名时，参与名单里只有新人 x');
eq(SM.canStartNext(settling), false, '只有新人 x 一个 → 人数不够（MIN_PLAYERS=2）');
SM.wantNext(settling, 'a');
/* ★ v121：房间里还有 b 没表态 —— 以前这里会按 x、a 两个人开，b 变旁听。 */
eq(SM.canStartNext(settling), false, '★ 三个人、两个报名 → 仍不开（等 b）');
SM.dropFromNext(settling, 'a', 'b');
eq(SM.canStartNext(settling), true, '★ 明确不等 b 之后才开（他确实被算进下一局，不是挂名）');
SM.startNextRound(settling);
eq(settling.phase, SM.PHASE.ROUND1_SPLIT, '下一局开了');
ok(!!SM.findPlayer(settling, 'x'), '★ 新人没有在开局瞬间被丢掉');
eq(SM.findPlayer(settling, 'x').hand.length, 6, '★ 新人手里有牌（真的进了这一局）');
eq(SM.findPlayer(settling, 'x').joinedLate, false, '新一局开始后 joinedLate 清掉（下一把结算要照常弹）');

/* ★ v122：开打之后再来人，进得来但只能旁听 —— 上面那次「结算期放行」不再
 * 是唯一入口，也不会因为放行就把「中途补人」这种错误的事顺带做掉。 */
const joinDuringPlay = SM.joinRoom(settling, P('late'));
eq(joinDuringPlay.ok, true, '新一局开打后再来人 → 能进房');
const lateSeat = SM.findPlayer(settling, 'late');
eq(lateSeat.benched, true, '★ 但他这一把是旁听');
eq((lateSeat.hand || []).length, 0, '★ 没有给他发牌（中途补人等于凭空造一手分）');
eq(SM.playingPlayers(settling).map(function (p) { return p.id; }).sort().join(','), 'a,x',
  '★ 在打的人没变多（上一把 b 被「不等他」排除，这一把是 a + 新人 x）');

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
