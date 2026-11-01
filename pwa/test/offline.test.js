/**
 * 掉线重连测试
 * 跑法：node pwa/test/offline.test.js
 *
 * 之前的行为：宽限 20 秒一到就判弃，手牌清空、人踢出对局，
 * 网络抖一下这局就白打了。现在改成：
 *   - 宽限拉长到 90 秒（移动网络切网/电梯/隧道都需要）
 *   - 判弃不再清手牌，本局未翻轮就能回桌接着打
 *   - 但翻轮后手牌内容已失效，必须挡住，否则会拿上一轮的牌算这一轮的分
 */
'use strict';

const SM = require('../js/stateMachine.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

const P = (id, extra) => Object.assign({ id: id, nickname: id }, extra || {});

function makeRoom(ids) {
  const room = SM.newRoom('R-OFF', P(ids[0]));
  /* 这些用例关心的是「掉线/回来」时的人数与阶段，不是上限本身。
   * 里面确实有 8 人局的场景，而上限 v82 收到 5 —— 8 人局只存在于老房间，
   * 所以显式放宽房间上限（老房间就是按建房时的上限走的）。
   * 新的 5 人上限由 pwa/test/player-cap.test.js 负责。 */
  room.cap = Math.max(ids.length, 8);
  ids.slice(1).forEach((id) => SM.joinRoom(room, P(id)));
  room.phase = SM.PHASE.ROUND1_SPLIT;
  room.players.forEach(function (p, i) {
    p.hand = [];
    for (let k = 0; k < 6; k++) p.hand.push({ suit: 'spade', rank: 2 + ((i + k) % 12) });
  });
  return room;
}

console.log('\n[判弃不再摧毁手牌]');
let room = makeRoom(['a', 'b', 'c']);   // 3 人，掉 1 个还剩 2 人 ≥ MIN
SM.markDisconnected(room, 'b');
ok(room.players[1].connected === false, '掉线标记为不在线');
ok(room.players[1].left === false, '宽限内还不算弃局');

SM.finalizeLeave(room, 'b');
const b = SM.findPlayer(room, 'b');
ok(b.left === true, '宽限到期 → 判弃');
ok(b.hand.length === 6, '手牌保留（清空就回不来了）');
ok(b.leftAtRound === 1, '记录了判弃时在第几轮');
ok(room.phase === SM.PHASE.ROUND1_SPLIT, '3 人掉 1 个，对局继续');
ok(SM.activePlayers(room).length === 2, '计分只算在场的 2 人');

console.log('\n[未翻轮：可以回桌]');
let res = SM.reconnect(room, 'b');
ok(res.ok === true, '重连成功');
ok(SM.findPlayer(room, 'b').left === false, '恢复为在局玩家');
ok(SM.findPlayer(room, 'b').connected === true, '在线');
ok(SM.findPlayer(room, 'b').hand.length === 6, '手牌还在，能直接打');
ok(SM.activePlayers(room).length === 3, '重新计入在场人数');

console.log('\n[翻轮后：拒绝回桌]');
room = makeRoom(['a', 'b', 'c']);
SM.markDisconnected(room, 'b');
SM.finalizeLeave(room, 'b');
room.round = 2;                       // 他掉线期间翻到第二轮
res = SM.reconnect(room, 'b');
ok(res.ok === false, '被拒绝');
ok(/下一轮/.test(res.error), '原因说明是翻轮', res.error);
ok(SM.findPlayer(room, 'b').left === true, '仍然是判弃状态');

console.log('\n[本局已结算：拒绝回桌]');
room = makeRoom(['a', 'b', 'c']);
SM.markDisconnected(room, 'b');
SM.finalizeLeave(room, 'b');
room.phase = SM.PHASE.SETTLED;
res = SM.reconnect(room, 'b');
ok(res.ok === false, '被拒绝');
ok(/结束/.test(res.error), '原因说明是本局已结束', res.error);

console.log('\n[2 人局掉 1 个：人数不足必须结束]');
room = makeRoom(['a', 'b']);
SM.markDisconnected(room, 'b');
SM.finalizeLeave(room, 'b');
ok(room.phase === SM.PHASE.SETTLED, '人数不足 → 立即结算');
ok(room.endReason === 'someoneLeft', '结束原因是有人离开');
res = SM.reconnect(room, 'b');
ok(res.ok === false, '已经结束的局回不去');

console.log('\n[8 人局掉 3 个：仍可继续，都能回来]');
room = makeRoom(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
['b', 'c', 'd'].forEach(function (id) { SM.finalizeLeave(room, id); });
ok(SM.activePlayers(room).length === 5, '剩 5 人在场');
ok(room.phase === SM.PHASE.ROUND1_SPLIT, '对局没有结束');
['b', 'c', 'd'].forEach(function (id) {
  ok(SM.reconnect(room, id).ok === true, id + ' 能回桌');
});
ok(SM.activePlayers(room).length === 8, '全部回来，人数恢复');

console.log('\n[正常重连不受影响]');
room = makeRoom(['a', 'b', 'c']);
SM.markDisconnected(room, 'b');
res = SM.reconnect(room, 'b');
ok(res.ok === true, '宽限内重连成功');
ok(SM.findPlayer(room, 'b').connected === true, '恢复在线');
ok(SM.findPlayer(room, 'b').left === false, '没有被判弃');

console.log('\n[重复判弃是幂等的]');
room = makeRoom(['a', 'b', 'c']);
SM.finalizeLeave(room, 'b');
const handLen = SM.findPlayer(room, 'b').hand.length;
SM.finalizeLeave(room, 'b');
ok(SM.findPlayer(room, 'b').hand.length === handLen, '多次判弃不重复扣手牌');
ok(SM.activePlayers(room).length === 2, '在场人数不会被重复扣');

console.log('\n[服务端宽限与客户端一致]');
const hubSrc = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'server', 'hub.js'), 'utf8');
const storeSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'js', 'roomStore.js'), 'utf8');
const hubMs = (hubSrc.match(/GRACE_MS\s*=\s*(\d+)/) || [])[1];
const storeMs = (storeSrc.match(/GRACE_MS\s*=\s*(\d+)/) || [])[1];
ok(hubMs === '90000', '服务端宽限 90 秒', 'got ' + hubMs);
ok(storeMs === '90000', '客户端宽限 90 秒', 'got ' + storeMs);
ok(hubMs === storeMs, '两侧数值一致（不一致会导致一端先放弃）');

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
