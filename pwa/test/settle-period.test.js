/**
 * 「结算期」的行为守卫（node pwa/test/settle-period.test.js）—— v113 / 方案 A
 *
 * 这一组断言全部来自同一件事：**整局打完之后，房间里的人不该再被当成「对局中」处理。**
 *
 * 修之前真实会发生（QA 报告 R1）：
 *   打完最后一把 → 结算页 → 切出去回消息 3 分钟 → 宽限到期 → `finalizeLeave`
 *   走「非等待阶段」那条路 → `left = true` → 结算名单把他剔出排名、沉底、角标写「—」、
 *   冠军顺位让给下一个人。**玩家什么都没做，一场已经结束的比赛被改写了结果。**
 *
 * 而这条路径从来没有测试覆盖：`finalizeLeave` 在全部测试里**从未在 SETTLED 下被调用过**。
 * 所以这里第一组就补它，并且配一条「非结算期照旧判弃」的对照 —— 只测「不判弃」是不够的，
 * 那样把 `finalizeLeave` 整个改成空函数也会绿。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const SM = require('../js/stateMachine.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

const ROOT = path.join(__dirname, '..');

/** 造一个已经打完的三人房：分数 +2 / 0 / -2，名次 1 / 2 / 3 */
function settledRoom() {
  const room = SM.newRoom('123456', { id: 'a', nickname: '甲' }, { handLimit: 3 });
  room.players.push(Object.assign({}, room.players[0], {
    id: 'b', nickname: '乙', ready: false, left: false, connected: true,
    disconnectedAt: null, leftAtRound: null, score: 0, hand: [], submit: null
  }));
  room.players.push(Object.assign({}, room.players[0], {
    id: 'c', nickname: '丙', ready: false, left: false, connected: true,
    disconnectedAt: null, leftAtRound: null, score: 0, hand: [], submit: null
  }));
  room.players[0].score = 2;
  room.players[1].score = 0;
  room.players[2].score = -2;
  room.phase = SM.PHASE.SETTLED;
  room.endReason = 'handLimit';
  room.handCount = 3;
  return room;
}

console.log('\n[1] 结算期掉线：只标离线，不判弃');
{
  const room = settledRoom();
  const res = SM.finalizeLeave(room, 'a');
  ok(res && res.ok, 'finalizeLeave 正常返回');
  const a = SM.findPlayer(room, 'a');
  eq(a.left, false, '★ 结算期掉线的人**没有**被判弃（left 仍是 false）');
  eq(a.connected, false, '但确实标成离线');
  ok(res.offline === true, '返回值里明确写了 offline（调用方不必靠猜）');
  eq(a.ready, false, '顺手把准备态清掉（他若回来要重新点）');
}

console.log('\n[2] 对照组：对局中掉线，照旧判弃');
{
  const room = settledRoom();
  room.phase = SM.PHASE.ROUND1_SPLIT;
  SM.finalizeLeave(room, 'a');
  const a = SM.findPlayer(room, 'a');
  eq(a.left, true, '★ 对局中掉线仍然判弃（不能因为修了结算期就把这条规则一起松掉）');
  eq(a.leftAtRound, room.round, '记下判弃时的轮次（回来时要用它挡人）');
}

console.log('\n[3] 结算期回来：能回座，且不再是「弃局」');
{
  const room = settledRoom();
  SM.finalizeLeave(room, 'a');
  const res = SM.reconnect(room, 'a');
  ok(res && res.ok, '★ 结算期 reconnect 不再被拒（旧版回「本局已结束，请等下一把」→ 客户端回首页）');
  const a = SM.findPlayer(room, 'a');
  eq(a.connected, true, '重新在线');
  eq(a.left, false, '没有被标成弃局');
}
{
  /* 反向：**对局中真的弃了**的人，结算期仍然不给回座。
   * 这一条是边界 —— 修 A-1 时最容易顺手把「所有结算期回座」都放开，
   * 那会让一个中途跑了的人重新出现在名次里，等于把结果改成第三种样子。 */
  const room = settledRoom();
  const a = SM.findPlayer(room, 'a');
  a.left = true;
  a.leftAtRound = 2;
  const res = SM.reconnect(room, 'a');
  eq(res.ok, false, '★ 对局中已判弃的人，结算期仍然回不来');
  eq(SM.findPlayer(room, 'a').left, true, '他的「弃局」状态保持不变');
}

console.log('\n[4] 对照：翻轮后回来仍被挡（这条规则不能被顺手改掉）');
{
  const room = settledRoom();
  room.phase = SM.PHASE.ROUND2_SPLIT;
  room.round = 2;
  const a = SM.findPlayer(room, 'a');
  a.left = true;
  a.leftAtRound = 1;           // 第 1 轮掉线被判弃
  const res = SM.reconnect(room, 'a');
  eq(res.ok, false, '★ 手里还是上一轮的牌 → 不许回来（放回来会算错分）');
}

console.log('\n[5] 名次口径：掉线不改写冠军');
{
  /* 直接从 settleView 源码里取 settleRank 单跑 —— 它是纯函数（只读 players）。
   * 用「取源码执行」而不是 require：那个模块创建时就要 DOM。 */
  const src = fs.readFileSync(path.join(ROOT, 'js', 'settleView.js'), 'utf8');
  const m = /function settleRank\(players\) \{[\s\S]*?\n  \}/.exec(src);
  ok(!!m, '取得到 settleRank');
  const settleRank = eval('(' + m[0] + ')');   // eslint-disable-line no-eval

  const room = settledRoom();
  SM.finalizeLeave(room, 'a');                 // 甲在结算页掉线
  const rows = settleRank(room.players);
  const champ = rows.filter(function (r) { return r.champion; }).map(function (r) { return r.p.id; });
  eq(champ.join(','), 'a', '★ 掉线的人仍然是冠军（修之前这里会变成 b）');
  eq(rows.find(function (r) { return r.p.id === 'a'; }).abandoned, false, '他没有被标成「弃局」');
}
{
  const src = fs.readFileSync(path.join(ROOT, 'js', 'settleView.js'), 'utf8');
  const settleRank = eval('(' + /function settleRank\(players\) \{[\s\S]*?\n  \}/.exec(src)[0] + ')'); // eslint-disable-line no-eval
  /* 并列第一：两个冠军都要被认出来（庆祝音那条修的就是这里） */
  const players = [
    { id: 'a', score: 5, left: false },
    { id: 'b', score: 5, left: false },
    { id: 'c', score: -10, left: false }
  ];
  const champ = settleRank(players).filter(function (r) { return r.champion; }).map(function (r) { return r.p.id; });
  eq(champ.join(','), 'a,b', '★ 并列第一时两个人都算冠军');
}

console.log('\n[6] 文案与接线（改的是「说错话」的部分）');
{
  const settle = fs.readFileSync(path.join(ROOT, 'js', 'settleView.js'), 'utf8');
  ok(/打满 ' \+ lim \+ ' 把，本局结束/.test(settle), '★ 打满把数写「把」，与顶栏「第 N/M 把」一致');
  ok(/人进入下一把/.test(settle), '★ 结算页等待提示写「下一把」');
  ok(/'下一把分数从 0 分重新开始'/.test(settle), '★ 明说下一把分数归零（否则玩家以为分丢了）');
  ok(/room\.endReason === 'handLimit'[\s\S]{0,80}settle-reset-note/.test(settle),
    '这句只在「打满把数」时出现（解散/有人离开时没有下一把）');

  const game = fs.readFileSync(path.join(ROOT, 'js', 'game.js'), 'utf8');
  ok(/settleRank\(room\.players\)\.filter/.test(game),
    '★ 庆祝音用与名次同一份结果（不再自己排一次序）');
  ok(!/var _sorted = room\.players\.slice\(\)\.sort/.test(game),
    '旧的自排序写法已删除（同一个事实不许有两个来源）');
}

console.log('\n----------------------------------------');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) process.exit(1);
