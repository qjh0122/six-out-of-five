/**
 * 提交与「改一次」测试
 * 跑法：node pwa/test/resubmit.test.js
 *
 * 两条现状问题：
 *   1. 点错一张牌，提交后这一轮分数就定了，没有任何挽回余地
 *   2. 第二次提交返回 ok 但内容被静默丢弃 —— 玩家以为改成功了，实际还是旧分组计分
 *
 * 现在的规则：结算前允许改一次；第二次之后的提交必须**明确报错**，不能假成功。
 */
'use strict';

const SM = require('../js/stateMachine.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + b + ', got ' + a); }

/* 建一个已开局的房间（发好牌，停在 ROUND1_SPLIT） */
function makeRoom(ids) {
  const room = SM.newRoom('R-RS', { id: ids[0], nickname: ids[0] });
  ids.slice(1).forEach((id) => SM.joinRoom(room, { id: id, nickname: id }));
  room.players.forEach((p) => { p.ready = true; });
  SM.startGame(room, ids[0]);
  return room;
}

/* 按轮次分组规则把 6 张牌切成合法分组 */
function buildGroups(hand, round) {
  const keys = SM.ROUND_GROUPS[round];
  const groups = {};
  let i = 0;
  keys.forEach((k) => {
    groups[k] = hand.slice(i, i + SM.GROUP_COUNT[k]);
    i += SM.GROUP_COUNT[k];
  });
  return groups;
}

/* 把分组整体轮转一位：内容合法但与原来不同，用来验证"确实被覆盖了" */
function rotateGroups(groups, round) {
  const keys = SM.ROUND_GROUPS[round];
  let flat = [];
  keys.forEach((k) => { flat = flat.concat(groups[k]); });
  flat = flat.slice(1).concat(flat.slice(0, 1));
  const out = {};
  let i = 0;
  keys.forEach((k) => {
    out[k] = flat.slice(i, i + SM.GROUP_COUNT[k]);
    i += SM.GROUP_COUNT[k];
  });
  return out;
}

console.log('\n[首次提交]');

let room = makeRoom(['a', 'b']);
let me = SM.findPlayer(room, 'a');
const hand = me.hand.slice();
let g1 = buildGroups(hand, 1);

let r = SM.submitGroups(room, 'a', g1);
ok(r.ok === true, '首次提交成功');
eq(r.revised, false, '不算修改');
eq(me.submitted.round1, true, '标记为已提交');
eq(me.resubmits.round1, 0, '修改额度还没用');
eq(room.phase, 'ROUND1_SPLIT', '只有一个人提交，还没结算');

console.log('\n[改一次]');

const g2 = rotateGroups(g1, 1);
const sameAsBefore = JSON.stringify(g2) === JSON.stringify(g1);
ok(!sameAsBefore, '测试前提：改后的分组与原来不同');

r = SM.submitGroups(room, 'a', g2);
ok(r.ok === true, '结算前可以改');
eq(r.revised, true, '这次标记为修改');
eq(me.resubmits.round1, 1, '修改额度已用掉');
eq(JSON.stringify(me.groups.round1), JSON.stringify({
  single: g2.single, tenhalf: g2.tenhalf, piaosanye: g2.piaosanye, douniu: []
}), '服务端存的是**改后**的分组，不是旧的');
ok(room.phase === 'ROUND1_SPLIT', '改一次不会触发结算');

console.log('\n[超出额度] 必须明确报错，不能假成功');

r = SM.submitGroups(room, 'a', g1);
eq(r.ok, false, '第三次提交被拒绝');
ok((r.error || '').indexOf('改过一次') >= 0, '错误信息说清楚原因', r.error);
eq(me.resubmits.round1, 1, '额度没有被错误累加');
eq(JSON.stringify(me.groups.round1.single), JSON.stringify(g2.single), '被拒绝时不会污染已有分组');

console.log('\n[坏数据不消耗额度]');

room = makeRoom(['a', 'b']);
me = SM.findPlayer(room, 'a');
const h2 = me.hand.slice();
const good = buildGroups(h2, 1);
SM.submitGroups(room, 'a', good);

const bad = { single: [], tenhalf: [], piaosanye: [] };  // 缺张
r = SM.submitGroups(room, 'a', bad);
eq(r.ok, false, '不合法的修改被拒绝');
eq(me.resubmits.round1, 0, '校验失败不消耗修改额度（否则玩家点了没填满就白丢机会）');

const rev = rotateGroups(good, 1);
r = SM.submitGroups(room, 'a', rev);
ok(r.ok === true, '补正之后仍然可以改', r.error);
eq(me.resubmits.round1, 1, '这次才记额度');

console.log('\n[结算之后不能再改]');

room = makeRoom(['a', 'b']);
const a1 = SM.findPlayer(room, 'a');
const b1 = SM.findPlayer(room, 'b');
SM.submitGroups(room, 'a', buildGroups(a1.hand, 1));
SM.submitGroups(room, 'b', buildGroups(b1.hand, 1));
ok(room.phase !== 'ROUND1_SPLIT', '两人都提交后进入下一阶段', room.phase);
eq(room.round, 2, '已经翻到第二轮');
const round1Snapshot = JSON.stringify(a1.groups.round1);
r = SM.submitGroups(room, 'a', buildGroups(a1.hand, 1));
eq(r.ok, false, '拿第一轮的分组再提交，被拒绝');
ok((r.error || '').length > 0, '拒绝时给出原因', r.error);
eq(a1.resubmits.round1, 0, '第一轮修改额度没有被这一段消耗');
eq(JSON.stringify(a1.groups.round1), round1Snapshot, '第一轮的计分分组没有被篡改');

console.log('\n[两轮额度独立]');

room = makeRoom(['a', 'b']);
const pa = SM.findPlayer(room, 'a');
const pb = SM.findPlayer(room, 'b');
const g1a = buildGroups(pa.hand, 1);
SM.submitGroups(room, 'a', g1a);
SM.submitGroups(room, 'a', rotateGroups(g1a, 1));
eq(pa.resubmits.round1, 1, '第一轮额度已用');

SM.submitGroups(room, 'b', buildGroups(pb.hand, 1));
// 若已进入第二轮
if (room.phase === 'ROUND2_SPLIT') {
  const g2a = buildGroups(pa.hand, 2);
  const rr = SM.submitGroups(room, 'a', g2a);
  ok(rr.ok === true, '第二轮首次提交成功', rr.error);
  eq(pa.resubmits.round2, 0, '第二轮额度是新的');
  const rr2 = SM.submitGroups(room, 'a', rotateGroups(g2a, 2));
  ok(rr2.ok === true, '第二轮也能改一次', rr2.error);
  eq(pa.resubmits.round2, 1, '第二轮额度用掉');
} else {
  ok(true, '本轮直接结账（分数见底），跳过第二轮断言');
}

console.log('\n[新一把清空额度]');

room = makeRoom(['a', 'b']);
const qa = SM.findPlayer(room, 'a');
const qb = SM.findPlayer(room, 'b');
const q1 = buildGroups(qa.hand, 1);
SM.submitGroups(room, 'a', q1);
SM.submitGroups(room, 'a', rotateGroups(q1, 1));
eq(qa.resubmits.round1, 1, '用掉第一轮的额度');

/*
 * 「打到结账」的路径由 e2e 用例覆盖，这里只验证新一局会不会把额度清零。
 * 分数见底靠随机牌局才能凑出来，用例不该依赖它——直接置成结账态。
 * 报名制：两个人各自报名 + 准备，全员就绪自动开局（以前 restart 一步到位）。
 */
room.phase = SM.PHASE.SETTLED;
room.players.filter(function (p) { return !p.left; }).forEach(function (p) {
  SM.wantNext(room, p.id);
  SM.setReady(room, p.id, true);
});
const nextStarted = SM.autoStartIfReady(room);
ok(!!nextStarted && nextStarted.kind === 'next', '全员就绪 → 自动开下一局');
eq(SM.findPlayer(room, 'a').resubmits.round1, 0, '新一把的修改额度归零（不带到下一局）');
eq(SM.findPlayer(room, 'a').resubmits.round2, 0, '第二轮额度同时归零');
eq(room.phase, SM.PHASE.ROUND1_SPLIT, '回到第一轮分牌');
void qb;

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
if (fail > 0) process.exitCode = 1;
