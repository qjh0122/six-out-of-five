/**
 * 「改一下」的结算时序测试（v105）
 * 跑法：node pwa/test/revise.test.js
 *
 * ── 要修的那个 bug ──────────────────────────────────────────────
 *   甲提交 → 点「改一下」→ 正在重新摆牌（还没交）
 *   乙提交 → 「全员到齐」成立 → 本轮立刻结算
 *   结算用的是甲**还没改完的那份旧分组**，甲连提交都没点
 *
 * 根因不是「判断写错了」，是**服务端根本不知道有人在改**：
 * 前端只设了自己的 state.reviseRound，`submitted` 一直是 true。
 *
 * ── 这个文件守什么 ─────────────────────────────────────────────
 *   ① 正在改 = 没定稿：别人全交也不结算（否则 bug 复现）
 *   ② 对照组：不走 beginRevise 就会结算 —— 证明这条测试不是恒真的空转门
 *   ③ 交完 / 取消修改之后能正常结算，且用的是正确的那份分组
 *   ④ 修改中的人超时 = 放弃修改，按已交的旧分组算，不按弃权罚
 *   ⑤ 三处「到齐」判定共用 isRoundLocked，不允许再抄一份
 */
'use strict';

const { readAll: readGameAll } = require('./helpers/gameSource');
const fs = require('fs');
const path = require('path');
const SM = require('../js/stateMachine.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

function makeRoom(ids, id) {
  const room = SM.newRoom(id || 'R-RV', { id: ids[0], nickname: ids[0] });
  ids.slice(1).forEach((pid) => SM.joinRoom(room, { id: pid, nickname: pid }));
  room.players.forEach((p) => { p.ready = true; });
  SM.startGame(room, ids[0]);
  return room;
}
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
/* 把分组整体轮转一位：内容仍然合法，但与原来不同，用来分辨「用的是哪一份」 */
function rotate(groups, round) {
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
function groupsOf(room, pid, round) {
  return SM.findPlayer(room, pid).groups['round' + round];
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
/* 只取本轮用到的组再比。状态机落盘时会把四条键都写进去（含本轮不用的），
 * 而 buildGroups 只造本轮的键 —— 直接整对象比会因为「多两个空数组」永远不等。 */
function pick(groups, round) {
  const out = {};
  (SM.ROUND_GROUPS[round] || []).forEach((k) => { out[k] = groups[k]; });
  return out;
}

/* ================================================================ */
console.log('\n[0] 对照组：不走 beginRevise 的老行为（证明下面那条测试不是恒真）');

(function () {
  const room = makeRoom(['a', 'b'], 'R-RV-0');
  const a = SM.findPlayer(room, 'a');
  const b = SM.findPlayer(room, 'b');
  SM.submitGroups(room, 'a', buildGroups(a.hand, 1));
  eq(room.results.round1, null, '  甲提交后还没结算');
  SM.submitGroups(room, 'b', buildGroups(b.hand, 1));
  ok(room.results.round1 !== null, '★ 乙提交 → 全员到齐 → 结算了（这正是有 bug 的那条路径）');
})();

console.log('\n[1] 甲点「改一下」之后，乙提交也不能结算');

let room = makeRoom(['a', 'b'], 'R-RV-1');
let pa = SM.findPlayer(room, 'a');
let pb = SM.findPlayer(room, 'b');
let oldA = buildGroups(pa.hand, 1);
SM.submitGroups(room, 'a', oldA);
eq(room.results.round1, null, '前置：甲已提交，未结算');

let r = SM.beginRevise(room, 'a');
eq(r.ok, true, 'beginRevise 成功');
eq(pa.revising, 1, '甲被标记为「第 1 轮正在改」');
eq(pa.submitted.round1, true, '★ 旧分组仍然留在服务端（超时兜底要用它）');

SM.submitGroups(room, 'b', buildGroups(pb.hand, 1));
eq(room.results.round1, null, '★★ 乙提交后**没有结算** —— 全桌在等甲改完');
eq(room.phase, 'ROUND1_SPLIT', '仍在第一轮分牌阶段');
eq(SM.isRoundLocked(pa, 1), false, 'isRoundLocked(甲) = false（未定稿）');
eq(SM.isRoundLocked(pb, 1), true, 'isRoundLocked(乙) = true（已定稿）');

console.log('\n[2] 甲重新提交 → 立刻结算，且用的是新分组');

let newA = rotate(oldA, 1);
SM.submitGroups(room, 'a', newA);
ok(room.results.round1 !== null, '★ 甲交完，全员到齐，结算了');
eq(pa.revising, null, '提交后退出修改态');
eq(pa.resubmits.round1, 1, '消耗掉唯一一次修改额度');
ok(same(pick(groupsOf(room, 'a', 1), 1), newA), '★ 算的是甲改后的新分组，不是旧的');

console.log('\n[3] 取消修改 → 恢复定稿，全桌立刻走动');

(function () {
  const rm = makeRoom(['a', 'b'], 'R-RV-3');
  const a = SM.findPlayer(rm, 'a');
  const b = SM.findPlayer(rm, 'b');
  const keep = buildGroups(a.hand, 1);
  SM.submitGroups(rm, 'a', keep);
  SM.beginRevise(rm, 'a');
  SM.submitGroups(rm, 'b', buildGroups(b.hand, 1));
  eq(rm.results.round1, null, '前置：乙交了但甲在改，没结算');

  const cr = SM.cancelRevise(rm, 'a');
  eq(cr.ok, true, 'cancelRevise 成功');
  eq(a.revising, null, '退出修改态');
  eq(a.resubmits.round1, 0, '★ 取消不消耗修改额度');
  ok(rm.results.round1 !== null, '★ 恢复定稿的瞬间全桌就齐了 —— 立刻结算');
  ok(same(pick(groupsOf(rm, 'a', 1), 1), keep), '用的是甲原来那份已提交的分组');
})();

console.log('\n[4] 修改中的人超时 = 放弃修改，不按弃权罚');

(function () {
  const rm = makeRoom(['a', 'b'], 'R-RV-4');
  const a = SM.findPlayer(rm, 'a');
  const b = SM.findPlayer(rm, 'b');
  const keep = buildGroups(a.hand, 1);
  SM.submitGroups(rm, 'a', keep);
  SM.beginRevise(rm, 'a');
  SM.submitGroups(rm, 'b', buildGroups(b.hand, 1));
  eq(rm.results.round1, null, '前置：甲在改，没结算');

  const fr = SM.forfeitRound(rm, 'a');
  eq(fr.ok, true, 'forfeitRound 接受了这次调用');
  eq(fr.droppedRevise, true, '★ 语义是「放弃修改」，不是弃权');
  eq(a.revising, null, '退出修改态');
  eq(a.forfeitRound, null, '★ 没有被打上弃权标记');
  ok(!same(a.groups.round1, { single: [], tenhalf: [], piaosanye: [], douniu: [] }),
    '★ 分组没被清空（弃权才会清空）');
  ok(rm.results.round1 !== null, '全桌立刻走动并结算');
  ok(same(pick(groupsOf(rm, 'a', 1), 1), keep), '按他交过的那份算');
})();

console.log('\n[5] beginRevise 的拒绝条件');

(function () {
  let rm = makeRoom(['a', 'b'], 'R-RV-5a');
  let a = SM.findPlayer(rm, 'a');
  eq(SM.beginRevise(rm, 'a').ok, false, '一次都没提交 → 拒绝（没有可改的东西）');

  SM.submitGroups(rm, 'a', buildGroups(a.hand, 1));
  SM.beginRevise(rm, 'a');
  eq(SM.beginRevise(rm, 'a').ok, true, '重复 beginRevise 幂等，不报错');

  SM.cancelRevise(rm, 'a');
  SM.beginRevise(rm, 'a');
  SM.submitGroups(rm, 'a', rotate(buildGroups(a.hand, 1), 1));
  eq(a.resubmits.round1, 1, '已经改过一次');
  eq(SM.beginRevise(rm, 'a').ok, false, '★ 额度用完 → 拒绝再改');

  rm = makeRoom(['a', 'b'], 'R-RV-5b');
  a = SM.findPlayer(rm, 'a');
  SM.submitGroups(rm, 'a', buildGroups(a.hand, 1));
  SM.forfeitRound(rm, 'a');   // 上一步已提交，这里会被「已提交无需弃权」挡掉
  eq(a.forfeitRound, null, '前置：他没弃权（已提交）');
  ok(SM.beginRevise(rm, 'a').ok === true, '已提交且没弃权 → 可以改');
})();

console.log('\n[6] 新一把 / 翻轮之后，修改态必须归零');

(function () {
  const rm = makeRoom(['a', 'b'], 'R-RV-6');
  const a = SM.findPlayer(rm, 'a');
  const b = SM.findPlayer(rm, 'b');
  SM.submitGroups(rm, 'a', buildGroups(a.hand, 1));
  SM.beginRevise(rm, 'a');
  /* 直接推第二轮：把甲按定稿处理，让结算发生 */
  SM.cancelRevise(rm, 'a');
  SM.submitGroups(rm, 'b', buildGroups(b.hand, 1));
  eq(rm.round, 2, '已翻到第二轮');
  eq(a.revising, null, '★ 结算后修改态被清掉（settleRound 里统一清）');
  eq(SM.isRoundLocked(a, 2), false, '第二轮还没交，不算定稿');
})();

console.log('\n[7] isRoundLocked 的四种组合');

(function () {
  const p = { submitted: { round1: false }, forfeitRound: null, revising: null };
  eq(SM.isRoundLocked(p, 1), false, '没提交 / 没弃权 / 没在改 → 未定稿');
  p.submitted.round1 = true;
  eq(SM.isRoundLocked(p, 1), true, '已提交 → 定稿');
  p.revising = 1;
  eq(SM.isRoundLocked(p, 1), false, '★ 已提交 + 正在改 → 未定稿');
  p.forfeitRound = 1;
  eq(SM.isRoundLocked(p, 1), true, '已弃权 → 定稿（空分组也参与比牌）');
  eq(SM.isRoundLocked(null, 1), false, '空对象不炸');
  eq(SM.isRoundLocked({}, 1), false, '缺字段不炸');
})();

console.log('\n[8] 三人局：两个人交了，第三个人在改，一样等');

(function () {
  const rm = makeRoom(['a', 'b', 'c'], 'R-RV-8');
  const a = SM.findPlayer(rm, 'a');
  const b = SM.findPlayer(rm, 'b');
  const c = SM.findPlayer(rm, 'c');
  SM.submitGroups(rm, 'a', buildGroups(a.hand, 1));
  SM.submitGroups(rm, 'b', buildGroups(b.hand, 1));
  SM.submitGroups(rm, 'c', buildGroups(c.hand, 1));
  ok(rm.results.round1 !== null, '前置：三人都交 → 已结算');
})();

console.log('\n[9] 源码守卫：三处「到齐」判定不许再各写一份');

(function () {
  const root = path.join(__dirname, '..');
  const sm = fs.readFileSync(path.join(root, 'js', 'stateMachine.js'), 'utf8');
  const hub = fs.readFileSync(path.join(root, '..', 'server', 'hub.js'), 'utf8');
  const gs = readGameAll();

  ok((sm.match(/isRoundLocked\(q,/g) || []).length >= 3,
    '★ stateMachine 里三处判定都走 isRoundLocked');
  ok(!/q\.forfeitRound === round \|\| q\.submitted\[/.test(sm),
    '★ 旧的「弃权 或 已提交」手抄版已经不存在');
  ok(!/q\.submitted\['round' \+ rd\] \|\| q\.forfeitRound/.test(sm),
    '★ settleIfAllIn 那份手抄版也不存在了');
  ok(/if \(SM\.isRoundLocked\(p, round\)\) return;/.test(hub),
    '服务端挂倒计时也按「有没有定稿」判，不是只看 submitted');
  ok(/function beginRevise\(/.test(sm) && /function cancelRevise\(/.test(sm), '两个动作都在状态机里');
  ok(/p\.revising = null;/.test(sm), '提交 / 弃权 / 结算都会清修改态');
  ok(/StateMachine\.isRoundLocked\(p, round\)/.test(gs), '顶栏进度环用同一口径，不再数 submitted');
  ok(/p\.revising === round\) return \{ text: '正在改'/.test(gs), '座位卡显示「正在改」，不是「已提交」');
})();

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
if (fail > 0) process.exitCode = 1;
