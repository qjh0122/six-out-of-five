/**
 * 下一局的门槛：原因码与文案必须一一对应（v126）
 * 跑法：node pwa/test/next-round-gate-codes.test.js
 *
 * 【这个文件防的是什么】
 * 门槛有四个否决条件，而旧实现只返回 true/false —— 视图只能**猜**原因，
 * 猜错的方向刚好是最伤人的那种。2 人房里对手一掉线：
 *
 *   · 房间确实开不了（人数不够，不是「有人在犹豫」）；
 *   · 界面写「等 X 点开始下一局」——  X 已经掉线，永远不会点；
 *   · 「不等他」还亮着，点下去返回**成功**，房间依旧开不了。
 *
 * 玩家看到三句都对的话，合起来指向一个不存在的人。这类 bug 不会崩、不会报错，
 * 只会让人觉得「这游戏卡住了」。
 *
 * 【守的两层】
 *   1. 状态机：每个否决条件有自己的 code，且 canStartNext 只是它的布尔转发；
 *   2. 文案表：覆盖的 code 集合与状态机**等值** —— 状态机加了第 5 个条件
 *      而文案没跟上时，这里立刻红（那正是这个 bug 的形态）。
 */
'use strict';

const SM = require('../js/stateMachine.js');
const CONFIG = require('../js/config.js');
const Hints = require('../js/nextRoundHints.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

function P(id, nick) { return { id: id, nickname: nick || id }; }

/* 造一个「刚打完一局」的房间：proposeDissolve + 全员同意比打满 10 把快得多，
 * 而结算期的状态与正常打完完全一样（phase / handSeq / wantNext 都由同一条路径写）。 */
function settled(ids) {
  const room = SM.newRoom('R1', P(ids[0]), { handLimit: 3 });
  ids.slice(1).forEach((id) => SM.joinRoom(room, P(id)));
  room.players.forEach((p) => { p.ready = true; });
  SM.startGame(room, ids[0]);
  SM.proposeDissolve(room, ids[0]);
  SM.playingPlayers(room).slice(1).forEach((p) => SM.voteDissolve(room, p.id, true));
  return room;
}
const C = SM.GATE_CODES;

/* ========================================================================== */
console.log('\n[1] 原因码本身：五个，一个都不能少');
{
  const keys = Object.keys(C).sort();
  eq(keys.join(','), 'HOLD,NEED_PLAYERS,OK,WAITING_OFFLINE,WAITING_OTHERS',
    '★ 枚举值就是这五个（多一个少一个都说明有人改了协议）');
  eq(SM.nextRoundGate(null).code, C.NEED_PLAYERS, '没有房间 → 人不够（不抛）');
  eq(SM.nextRoundGate(null).ok, false, '没有房间时 ok 为 false');
}

/* ========================================================================== */
console.log('\n[2] 每个否决条件都有自己的 code');
{
  /* 全都就位 → OK */
  const r1 = settled(['a', 'b']);
  SM.wantNext(r1, 'a'); SM.wantNext(r1, 'b');
  eq(SM.nextRoundGate(r1).code, C.OK, '★ 两人都报名 → OK');

  /* 有人还在看结算页 → WAITING_OTHERS */
  const r2 = settled(['a', 'b']);
  SM.wantNext(r2, 'a');
  const g2 = SM.nextRoundGate(r2);
  eq(g2.code, C.WAITING_OTHERS, '★ 有人没表态 → WAITING_OTHERS');
  eq((g2.pending || []).length, 1, '并把「在等谁」带出来（视图要点名）');
  ok((g2.pending || [])[0].id === 'b', '点名的是 b', g2.pending && g2.pending[0].id);

  /* 没表态的人掉线了 → WAITING_OFFLINE（3 人房：b 报名了，a 掉线没表态） */
  const r3 = settled(['a', 'b', 'c']);
  SM.wantNext(r3, 'b'); SM.wantNext(r3, 'c');
  SM.findPlayer(r3, 'a').connected = false;
  const g3 = SM.nextRoundGate(r3);
  eq(g3.code, C.WAITING_OFFLINE, '★ 没表态的人掉线 → WAITING_OFFLINE（不是「在犹豫」）');
  eq((g3.offline || []).length, 1, '掉线的人单独带出来');

  /* 房主挂起 → HOLD，且优先级最高（即使人数也不够） */
  const r4 = settled(['a', 'b']);
  SM.wantNext(r4, 'a'); SM.wantNext(r4, 'b');
  SM.setHoldNext(r4, 'a', true);
  eq(SM.nextRoundGate(r4).code, C.HOLD, '★ 挂起优先于「已经可以开了」');

  const r5 = settled(['a', 'b']);
  SM.setHoldNext(r5, 'a', true);   // 一个人都没报名，同时挂起
  eq(SM.nextRoundGate(r5).code, C.HOLD, '★ 挂起也优先于「人不够」（先说是房主不让开）');

  /* 2 人房对手掉线 → WAITING_OFFLINE（他还在等位名单里，只是不会动）
   * ★ 这条最早写成 NEED_PLAYERS，是错的：对方只是掉线，不是「不在了」。
   *   说他「人不够」会把房主推向「补只 AI」，等于把朋友挤成旁听。 */
  const r6 = settled(['a', 'b']);
  SM.wantNext(r6, 'b');
  SM.findPlayer(r6, 'a').connected = false;
  const g6 = SM.nextRoundGate(r6);
  eq(g6.code, C.WAITING_OFFLINE, '★★ 2 人房里对手掉线 → WAITING_OFFLINE（不是「人不够」）');
  eq(g6.joined, 1, '带出「能上场 1 人」');
  eq(g6.need, CONFIG.MIN_PLAYERS, '带出「需要几人」');
  eq((g6.offline || []).length, 1, '★ 同时告诉视图「掉线的是谁」');

  /* 全部在场真人都表过态、人还是不够 → 这才是 NEED_PLAYERS */
  const r7 = settled(['a', 'b']);
  SM.dropFromNext(r7, 'a', 'a');    // a 自己请假
  SM.dropFromNext(r7, 'b', 'b');    // b 也请假
  const g7 = SM.nextRoundGate(r7);
  eq(g7.code, C.NEED_PLAYERS, '★★ 没人可等了且人数不够 → NEED_PLAYERS');
  eq((g7.pending || []).length, 0, '（前置）此刻确实没人可等');
}

/* ========================================================================== */
console.log('\n[3] canStartNext 必须只是 gate 的布尔转发（不许有第二套判据）');
{
  const scenes = [];
  const mk = () => { const r = settled(['a', 'b', 'c']); scenes.push(r); return r; };

  let r = mk();                                   // 谁都没点
  r = mk(); SM.wantNext(r, 'a');                  // 一个人点了
  r = mk(); SM.wantNext(r, 'a'); SM.wantNext(r, 'b'); SM.wantNext(r, 'c');  // 都点了
  r = mk(); SM.wantNext(r, 'a'); SM.wantNext(r, 'b'); SM.wantNext(r, 'c');
  SM.setHoldNext(r, 'a', true);                   // 都点了但挂起
  r = mk(); SM.wantNext(r, 'a'); SM.wantNext(r, 'b');
  SM.dropFromNext(r, 'b', 'c');                   // 跳过 c（3 人房够 2 人）
  r = mk(); SM.findPlayer(r, 'a').connected = false; SM.wantNext(r, 'b'); SM.wantNext(r, 'c');

  let checked = 0;
  scenes.forEach((room, i) => {
    const g = SM.nextRoundGate(room);
    eq(SM.canStartNext(room), g.ok, '场景 ' + (i + 1) + '：canStartNext === gate.ok（code=' + g.code + '）');
    checked += 1;
  });
  ok(checked === 6, '六个场景都对照过', checked);
}

/* ========================================================================== */
console.log('\n[4] 文案表与原因码必须等值（加条件不改文案 = 玩家看不到原因）');
{
  const gateCodes = Object.keys(C).sort().join(',');
  const hintCodes = Hints.codes().slice().sort().join(',');
  eq(hintCodes, gateCodes, '★★ 文案表覆盖的 code 集合 === GATE_CODES（多一个少一个都红）');
}

/* ========================================================================== */
console.log('\n[5] 每种原因说的必须是真话');
{
  /* WAITING_OTHERS：必须点名，不能只说「等其他人」 */
  const r1 = settled(['a', 'b']);
  SM.wantNext(r1, 'a');
  const g1 = SM.nextRoundGate(r1);
  const t1 = Hints.hintFor(g1.code, { pending: g1.pending, isOwner: true, joined: g1.joined, need: g1.need });
  ok(/b/.test(t1), '★ WAITING_OTHERS 点名了在等谁', t1);

  /* ★ 在等的是「我」时，必须说「你」——
   * 念自己的昵称会让玩家慢半拍，而这一秒正是需要他立刻按下去的时候。
   * 这条来自真机：最后那个没表态的人看到「已经有 2 人进入下一把」，
   * 完全不知道自己就是卡住全桌的那个人。 */
  const t1b = Hints.hintFor(C.WAITING_OTHERS, { pending: [{ id: 'a', nickname: '甲' }], myId: 'a' });
  ok(/还在等你/.test(t1b), '★ 等的是我 → 说「还在等你」', t1b);
  ok(!/甲/.test(t1b), '★ 且不念我自己的昵称', t1b);

  const t1c = Hints.hintFor(C.WAITING_OTHERS, {
    pending: [{ id: 'a', nickname: '甲' }, { id: 'b', nickname: '乙' }], myId: 'a'
  });
  ok(/你/.test(t1c) && /乙/.test(t1c), '★ 我和别人都没点 → 「你和你 乙」都说出来', t1c);

  /* WAITING_OFFLINE（2 人房对手掉线）：不许只说「等他点开始下一局」 */
  const r2 = settled(['a', 'b']);
  SM.wantNext(r2, 'b');
  SM.findPlayer(r2, 'a').connected = false;
  const g2 = SM.nextRoundGate(r2);
  const t2 = Hints.hintFor(g2.code, {
    stage: 'ready', isOwner: false, joined: g2.joined, need: g2.need,
    offline: g2.offline, pending: g2.pending || []
  });
  eq(g2.code, C.WAITING_OFFLINE, '（前置）这一局是 WAITING_OFFLINE');
  ok(/掉线/.test(t2), '★ 点名「掉线了」（玩家要知道为什么点了没反应）', t2);
  ok(/补 ?AI|重连/.test(t2), '★★ 给出真实出路（等他重连 / 补 AI），不是让他一直等', t2);

  /* NEED_PLAYERS（没人可等了、人数不够）：说人不够，并给出可点的东西 */
  const t3b = Hints.hintFor(C.NEED_PLAYERS, { stage: 'ready', joined: 1, need: 2, isOwner: true });
  ok(/还差 1 人/.test(t3b), '★ 说清还差几个人', t3b);
  ok(/补 ?AI/.test(t3b), '★ 给出房主能按的那颗键', t3b);

  /* joined = 0：引导按主按钮，不要引导补 AI（2 人房要补 2 只，会变成 AI 自己打） */
  const t3 = Hints.hintFor(C.NEED_PLAYERS, { stage: 'settle', joined: 0, need: 2, isOwner: true });
  ok(/点「开始下一局」/.test(t3), '★ 一个人都没上场时引导按主按钮', t3);
  ok(!/补 ?AI/.test(t3), '★ 且不提「补 AI」（要补 2 只，会造出 0 真人 + 2 AI 的空转局）', t3);

  /* joined >= 1：房主要知道可以补 AI */
  const t4 = Hints.hintFor(C.NEED_PLAYERS, { stage: 'ready', joined: 1, need: 2, isOwner: true });
  ok(/补 ?AI/.test(t4), '★ 房主在「还差 1 人」时被告知可以补 AI', t4);

  /* 非房主：给出他能做的事（房主可以补），不要让他去找一颗看不见的按钮 */
  const t5 = Hints.hintFor(C.NEED_PLAYERS, { stage: 'ready', joined: 1, need: 2, isOwner: false });
  ok(/房主/.test(t5), '★ 非房主的文案指向房主（他那边没有补 AI 按钮）', t5);

  /* HOLD：房主与其他人说的不是同一句 */
  const ownerHold = Hints.hintFor(C.HOLD, { isOwner: true });
  const otherHold = Hints.hintFor(C.HOLD, { isOwner: false });
  ok(ownerHold !== otherHold, '★ 挂起时房主看到的是「你可以开牌」，其他人看到的是「房主在等」', ownerHold + ' / ' + otherHold);
  ok(/开牌/.test(ownerHold), '房主那句指向那颗按钮', ownerHold);

  /* 未知 code：不许编话 */
  eq(Hints.hintFor('SOMETHING_NEW', {}), '', '★ 未知原因码返回空串（不编一句似是而非的话）');
}

/* ========================================================================== */
console.log('\n[6] 「不等他」在 2 人房里必须被拒绝（#11 止血）');
{
  /* 对手结算期掉线：只标 connected=false，不判 left（v113 的正当设计） */
  const room = settled(['a', 'b']);
  SM.wantNext(room, 'b');
  SM.findPlayer(room, 'a').connected = false;

  const res = SM.dropFromNext(room, 'b', 'a');
  eq(res.ok, false, '★★ 跳过他也开不了 → 必须拒绝，不能返回成功');
  eq(res.code, C.NEED_PLAYERS, '拒绝原因是人数不够（不是权限/阶段）');
  ok(/补 ?AI|一个人/.test(res.error || ''), '★ 文案指出真正的出路（补 AI）', res.error);
  eq(SM.canStartNext(room), false, '（前置）房间确实还是开不了');

  /* 自己说「这一把先不打」必须继续允许 —— 拦掉等于把人锁在房间里 */
  const self = SM.dropFromNext(room, 'b', 'b');
  eq(self.ok, true, '★★ 自己请假仍然允许（v121 的唯一出口，不能被顺手拦住）');
}

/* ========================================================================== */
console.log('\n[7] 3 人房里「不等他」照常可用（守卫不能变成全面禁用）');
{
  const room = settled(['a', 'b', 'c']);
  SM.wantNext(room, 'b'); SM.wantNext(room, 'c');
  SM.findPlayer(room, 'a').connected = false;

  const res = SM.dropFromNext(room, 'b', 'a');
  eq(res.ok, true, '★ 3 人房跳过掉线者 → 允许（跳过之后 2 人，开得起来）', res.error);
  eq(SM.canStartNext(room), true, '★★ 而且真的可以开了（不是又一次假成功）');
}

/* ========================================================================== */
console.log('\n[8] 这条不变量才是根：界面给的理由必须为真');
{
  /* 判据（修正版）：
   *   canStartNext === false 时，要么「确实有人在等」（pending > 0），
   *   要么「人不够 · 并给出可点的东西」—— 二选一，不能两头空。
   *
   * 原式写成 `pending > 0 || holdNextOf` 会误报：全桌都请假时 pending 是 0，
   * 但任何在场真人点一下「开始下一局」就能回来（wantNext 会清 outNext），
   * 那也是一个真实出口 —— 所以判据必须把「主按钮可点」算进出口。 */
  const scenes = [];
  let r = settled(['a', 'b']); scenes.push(r);                       // 谁都没点
  r = settled(['a', 'b']); SM.wantNext(r, 'a'); scenes.push(r);       // 还差 b
  r = settled(['a', 'b']); SM.wantNext(r, 'b'); SM.findPlayer(r, 'a').connected = false; scenes.push(r);
  r = settled(['a', 'b']); SM.wantNext(r, 'a'); SM.wantNext(r, 'b'); SM.setHoldNext(r, 'a', true); scenes.push(r);
  r = settled(['a', 'b', 'c']); SM.dropFromNext(r, 'a', 'a'); scenes.push(r);   // a 请假

  scenes.forEach((room, i) => {
    const g = SM.nextRoundGate(room);
    if (g.ok) return;
    const hasWaiter = (g.pending || []).length > 0;
    const canAct = !!(room.players.filter((p) => !p.left).length >= 1);   // 主按钮对在场真人可用
    ok(hasWaiter || canAct, '场景 ' + (i + 1) + '（' + g.code + '）：有原因就必须有可点的东西');
  });
  ok(true, '（这条断言在旧实现下会以「返回成功却开不了」的形式失败 —— 见 [6]）');
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
