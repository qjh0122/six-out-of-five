/**
 * 「不等他」与「结算期补 AI」（v114 / P4-B）的守卫
 *
 * 这两件事解决的是同一个死局：**整局打完后，只要有一个已报名却不准备的人，
 * 整桌就永远开不了下一把**（没有超时、踢不掉、就位态连「结束本局」都是灰的）。
 *
 * 而这类「给一条出路」的改动最容易做成两件坏事：
 *   · 变成踢人 —— 人被移出房间、名次没了；
 *   · 变成催命 —— 谁都能催正常人，甚至把已准备好的人撤下来。
 * 所以断言一半是正向（能给出去路），一半是负向（不许越界）。
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

/** 结算期房间：甲乙丙都在，甲乙报名且已准备，丙报名但没准备 */
function roomWithStale() {
  const room = SM.newRoom('123456', { id: 'a', nickname: '甲' }, { handLimit: 3 });
  ['b', 'c'].forEach(function (id) {
    room.players.push(Object.assign({}, room.players[0], {
      id: id, nickname: id.toUpperCase(), ready: false, left: false,
      connected: true, disconnectedAt: null, leftAtRound: null, score: 0, hand: [], submit: null
    }));
  });
  room.phase = SM.PHASE.SETTLED;
  room.endReason = 'handLimit';
  room.players.forEach(function (p) { p.wantNext = true; p.ready = true; });
  room.players[2].ready = false;          // 丙：报名了但不准备 —— 就是那个卡住的人
  return room;
}

console.log('\n[1] 正路：已准备的人可以把「不准备的人」退回结算页');
{
  const room = roomWithStale();
  eq(SM.canStartNext(room), false, '卡住时确实开不了（丙没准备）');
  const res = SM.dropFromNext(room, 'a', 'c');
  ok(res && res.ok, '甲（已准备）可以发起');
  const c = SM.findPlayer(room, 'c');
  eq(c.wantNext, false, '丙的报名被撤回');
  eq(c.ready, false, '准备态也清掉（不留自相矛盾的组合）');
  eq(c.left, false, '★ 丙**没有**被判弃 —— 人还在房间');
  eq(room.players.length, 3, '★ 也没有被移出房间');
  eq(SM.canStartNext(room), true, '★ 撤掉之后就能开下一把了');
}

console.log('\n[2] 负路：不许变成「谁都能催」');
{
  const room = roomWithStale();
  eq(SM.dropFromNext(room, 'c', 'a').ok, false, '没准备的人不能催别人');
  eq(SM.dropFromNext(room, 'a', 'a').ok, false, '不能跳过自己');
  const b = SM.findPlayer(room, 'b');
  b.ready = true;
  eq(SM.dropFromNext(room, 'a', 'b').ok, false, '★ 已经准备好的人不能被撤下来');
  eq(SM.findPlayer(room, 'b').wantNext, true, '他的报名还在');
}
{
  const room = roomWithStale();
  room.phase = SM.PHASE.ROUND1_SPLIT;
  eq(SM.dropFromNext(room, 'a', 'c').ok, false, '对局中不能跳过任何人');
}
{
  const room = roomWithStale();
  SM.findPlayer(room, 'c').wantNext = false;
  const res = SM.dropFromNext(room, 'a', 'c');
  ok(res.ok, '★ 幂等：他已经回结算页了，再点一次也返回 ok');
  ok(!('targetId' in res) || res.targetId === 'c', '返回里带上目标（调用方不必猜）');
}

console.log('\n[3] 接线：协议 / 传输 / 界面');
{
  const hub = fs.readFileSync(path.join(ROOT, '..', 'server', 'hub.js'), 'utf8');
  ok(/case 'dropNext'/.test(hub), '服务端有 dropNext 协议分支');
  ok(/dropNext\(client, payload, reqId\)/.test(hub), '有对应的处理方法');
  ok(/this\._maybeAutoStart\(found\.roomId\);[\s\S]{0,80}dropNext|dropNext[\s\S]{0,900}_maybeAutoStart/.test(hub),
    '撤掉报名后要重新判一次「能不能开局」（否则还得再等一次广播）');

  const store = fs.readFileSync(path.join(ROOT, 'js', 'roomStore.js'), 'utf8');
  ok(/dropNext: function \(roomId, playerId, targetId\)/.test(store), '客户端传输层有 dropNext');

  const game = fs.readFileSync(path.join(ROOT, 'js', 'game.js'), 'utf8');
  ok(/function staleNextPlayers/.test(game), '有「谁在拖」的判定函数');
  ok(/data-skip-next/.test(game), '按钮带 data-skip-next（用委托绑定）');
  ok(/askConfirm\('不等 ' \+ who/.test(game), '★ 发起前要确认一次（不是一点就生效）');
  ok(/不等他[\s\S]{0,40}tr-skip|tr-skip/.test(game), '按钮挂在信息卡里（不挤底部动作条）');
}

console.log('\n[4] 结算期补 AI：给「剩 1 人」一条出路');
{
  const hub = fs.readFileSync(path.join(ROOT, '..', 'server', 'hub.js'), 'utf8');
  ok(/const wasSettled = room\.phase === SM\.PHASE\.SETTLED;/.test(hub), '服务端识别结算期');
  ok(/room\.phase !== SM\.PHASE\.WAITING && !wasSettled/.test(hub), '结算期也允许补 AI');
  ok(/if \(!wasSettled\) \{[\s\S]{0,160}room\.handHadBot = true;/.test(hub),
    '★ 结算期补的 AI 不标 handHadBot（否则已打完的那把会被判成含 AI 局）');
  ok(/SM\.wantNext\(room, botId\)/.test(hub), '★ 结算期补的 AI 要直接进下一把的名单');

  const game = fs.readFileSync(path.join(ROOT, 'js', 'game.js'), 'utf8');
  ok(/PHASE\.SETTLED && !!nextWait/.test(game), '就位态里房主能看到「补 AI」');
}

console.log('\n[5] 人数确认（B-2）');
{
  const game = fs.readFileSync(path.join(ROOT, 'js', 'game.js'), 'utf8');
  ok(/还有 ' \+ waiting \+ ' 人停在结算页/.test(game), '★ 准备前把「会挤掉几个人」说清');
  ok(/function doReady\(\)/.test(game), '真正的准备动作抽成了 doReady（确认后才执行）');
  ok(/if \(!me\.ready && state\.room\.phase === StateMachine\.PHASE\.SETTLED/.test(game),
    '★ 只在「结算后的就位态 + 我还没准备」时问（首次开局的准备不拦）');
}

console.log('\n----------------------------------------');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) process.exit(1);
