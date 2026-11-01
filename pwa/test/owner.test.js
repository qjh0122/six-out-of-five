/**
 * 房主所有权与座位清理测试
 * 跑法：node pwa/test/owner.test.js
 *
 * 两条线上会真接投诉的死锁：
 *   A. 对局中房主离开 → 剩下的人在结算页点「开下一把」被拒（只有房主可以…），
 *      全房间卡死，只能解散重建。
 *   B. 等待中房主掉线判弃 → 那个座位既不移除也不转移所有权，
 *      房间变僵尸：没人能开局，空座位还占着 8 人上限，30 分钟后才被回收。
 *
 * 这里锁的是「所有权必须跟着在场的人走」+「等待阶段的空座位必须摘掉」。
 */
'use strict';

const SM = require('../js/stateMachine.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + b + ', got ' + a); }

const P = (id, extra) => Object.assign({ id: id, nickname: id }, extra || {});
const BOT = (id) => P(id, { isBot: true });

function makeRoom(players) {
  const room = SM.newRoom('R-OWNER', players[0]);
  players.slice(1).forEach((p) => SM.joinRoom(room, p));
  return room;
}
function deal(room) {
  room.phase = SM.PHASE.ROUND1_SPLIT;
  room.players.forEach(function (p, i) {
    p.hand = [];
    for (let k = 0; k < 6; k++) p.hand.push({ suit: 'spade', rank: 2 + ((i + k) % 12) });
  });
  return room;
}

/* ---------------------------- A. 对局中房主离开 ---------------------------- */
console.log('\n[对局中] 房主离开 → 所有权转给在场真人');

let room = deal(makeRoom([P('owner'), P('b'), P('c')]));
eq(room.ownerId, 'owner', '初始房主是 owner');

// 房主掉线，宽限到期判弃
SM.finalizeLeave(room, 'owner');
eq(room.ownerId, 'b', '房主判弃后所有权交给下一位在场真人');
ok(SM.activePlayers(room).length === 2, '在场人数变成 2');
ok(!!SM.findPlayer(room, 'owner'), '对局中判弃的座位仍保留（否则同轮重连回不来）');
ok(SM.findPlayer(room, 'owner').left === true, '该座位被标记为已弃局');

// 新的一把手：b 现在应当有权开局/开下一把
room.phase = SM.PHASE.SETTLED;
const rRestart = SM.restart(room, 'b');
ok(rRestart.ok === true, '新房主可以点「开下一把」（原本会卡死在这里）', rRestart.error);

/* 非房主也不该被挡：结算页现在是报名制，人人都有「开始下一局」。
 * 以前这里断言「只有房主能开下一把」—— 那条规则随房主闸门一起去掉了，
 * 现在房主的权限只剩「补 AI」和「发起解散」。 */
console.log('\n[权限] 结算页不再有房主闸门');

room = deal(makeRoom([P('owner'), P('b'), P('c')]));
room.phase = SM.PHASE.SETTLED;   // 「开始下一局」只在结算页出现
const rDeny = SM.restart(room, 'b');
ok(rDeny.ok === true, '★ 非房主也能点「开始下一局」（不再卡在结算页等房主）', rDeny.error);

const rDenyStart = SM.startGame(room, 'b');
ok(rDenyStart.ok === false, '房主还在时，其他人强行「开局」仍被拒');

/* ---------------------------- B. 等待中房主掉线 ---------------------------- */
console.log('\n[等待中] 房主掉线判弃 → 座位直接摘掉');

room = makeRoom([P('owner'), P('b')]);
eq(room.phase, SM.PHASE.WAITING, '当前是等待阶段');
eq(room.players.length, 2, '座位数 2');

const rFin = SM.finalizeLeave(room, 'owner');
ok(rFin.ok === true, '判弃成功');
eq(rFin.deleted, undefined, '房间还有人不该被删');
eq(room.players.length, 1, '空座位被摘掉，不再占 8 人上限');
eq(room.ownerId, 'b', '所有权转给剩下的人');
ok(!SM.findPlayer(room, 'owner'), '离开的玩家不在座位表里（僵尸座位消失）');

// 剩下的人能正常开局
SM.setReady(room, 'b', true);
const rStart = SM.startGame(room, 'b');
ok(rStart.ok === false, '一个人不够开局（人数下限仍在把关）', rStart.error);
SM.joinRoom(room, P('c'));
SM.setReady(room, 'c', true);
const rStart2 = SM.startGame(room, 'b');
ok(rStart2.ok === true, '补人后新房主能正常开局（原本会一直「只有房主可以开局」）', rStart2.error);

/* 最后一个玩家也走了 → 房间该被删除 */
console.log('\n[等待中] 最后一个玩家判弃 → 房间回收');

room = makeRoom([P('solo')]);
const rGone = SM.finalizeLeave(room, 'solo');
ok(rGone.deleted === true, '最后一人离开 → 返回 deleted，交给服务端回收');
ok(rGone.room === null, '不再返回一个空房间对象');

/* ---------------------------- 转移目标的挑选 ---------------------------- */
console.log('\n[选谁] 优先真人，其次 AI');

room = makeRoom([P('owner'), BOT('bot_1'), P('human')]);
SM.finalizeLeave(room, 'owner');
eq(room.ownerId, 'human', 'AI 排在人后面：优先交给真人');

room = makeRoom([P('owner'), BOT('bot_1')]);
SM.finalizeLeave(room, 'owner');
eq(room.ownerId, 'bot_1', '只剩 AI 时也要指定一个，避免 ownerId 悬空');

console.log('\n[兜底] 全员离开不炸');

room = makeRoom([P('a'), P('b')]);
SM.finalizeLeave(room, 'a');
SM.finalizeLeave(room, 'b');
eq(SM.ensureLiveOwner(room), false, '没有在场玩家时不改 ownerId、不抛错');
eq(SM.ensureLiveOwner(null), false, '传 null 也不抛错');

/* ---------------------------- 解散投票的票要清理 ---------------------------- */
console.log('\n[解散] 投票人走了，票要跟着清');

room = deal(makeRoom([P('a'), P('b'), P('c')]));
SM.proposeDissolve(room, 'a');
ok(room.dissolve.active === true, 'a 发起解散');
eq(room.dissolve.votes['a'], true, '发起者默认同意');

SM.voteDissolve(room, 'b', true);
ok(room.phase !== SM.PHASE.SETTLED, '还差 c 一票');

// c 掉线判弃：他的票不存在，但也不该阻塞
SM.finalizeLeave(room, 'c');
ok(room.phase === SM.PHASE.SETTLED, '剩下 a、b 都同意 → 判弃 c 后立即成立解散', room.phase);
ok(room.dissolve.votes['c'] === undefined, '离开者的票已清掉');

console.log('\n[解散] 发起人自己掉了');

room = deal(makeRoom([P('a'), P('b'), P('c')]));
SM.proposeDissolve(room, 'a');
SM.finalizeLeave(room, 'a');   // 发起人走了
ok(room.dissolve.initiatorId === null || room.dissolve.initiatorId === undefined,
  '发起人字段被清空，不会指向一个不在的人');
ok(room.dissolve.votes['a'] === undefined, '发起人的票也清掉了');

/* ---------------------------- 结算页卡死复现 ---------------------------- */
console.log('\n[复现] 原本的场景：房主离开后剩下的人开不了下一把');

room = deal(makeRoom([P('owner'), P('b')]));
room.phase = SM.PHASE.SETTLED;      // 已进入结算页
room.endReason = 'someoneLeft';
SM.leaveRoom(room, 'owner');         // 房主离开
eq(room.ownerId, 'b', '结算阶段房主离开也会转移所有权');
const rAgain = SM.restart(room, 'b');
ok(rAgain.ok === true, '剩下的 b 可以点「开下一把」，不再卡死', rAgain.error);

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
if (fail > 0) process.exitCode = 1;
