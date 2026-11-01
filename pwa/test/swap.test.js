/**
 * 拖动交换牌位测试（v105）
 * 跑法：node pwa/test/swap.test.js
 *
 * 要解决的场景：六张牌全部入组之后三组都满了，玩家想把「单张」里那张
 * 和「飘三叶」里那张对调 —— 旧实现没有交换原语，只能
 * 「收回一张 → 挪另一张 → 补回空位」三步走，中间牌区还会出现空洞。
 *
 * 这里守的是四条不变式：
 *   ① 交换只换位置，**张数一分不变**（所以不需要容量校验）
 *   ② 交换后仍然是同一副 6 张牌（不丢、不重、不凭空多出来）
 *   ③ 同组内交换没有意义 → 必须明确拒绝，不能假成功
 *   ④ 往返交换一次回到原样（否则「换错了再换回来」会把草稿弄脏）
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
function eq(a, b, name) { ok(a === b, name, 'expect ' + b + ', got ' + a); }

/* 造 6 张互不相同的牌。用花色+点数拼 id 方便比对。 */
function sixCards() {
  return [
    { suit: 'S', rank: 14 }, { suit: 'H', rank: 13 }, { suit: 'D', rank: 12 },
    { suit: 'C', rank: 11 }, { suit: 'S', rank: 10 }, { suit: 'H', rank: 9 }
  ];
}
function cid(c) { return c.suit + c.rank; }
function flatten(groups, round) {
  return (SM.ROUND_GROUPS[round] || []).reduce((a, k) => a.concat(groups[k] || []), []);
}
/* 第 1 轮：single 1 张 / tenhalf 2 张 / piaosanye 3 张 —— 正好 6 张，全满 */
function fullRound1() {
  const hand = sixCards();
  return {
    hand: hand,
    groups: {
      single: [hand[0]],
      tenhalf: [hand[1], hand[2]],
      piaosanye: [hand[3], hand[4], hand[5]]
    }
  };
}

console.log('\n[1] 两组之间交换：位置对调，张数不变');

(function () {
  const t = fullRound1();
  const g = t.groups;
  const before = { single: g.single.length, tenhalf: g.tenhalf.length, piaosanye: g.piaosanye.length };

  const r = SM.swapCards(1, g, t.hand[0], t.hand[3]);
  ok(r.ok === true, '满组状态下交换成功（旧实现里 placeCard 会直接拒绝）');
  eq(r.from, 'single', '被拖的那张原来在 single');
  eq(r.to, 'piaosanye', '落点那张原来在 piaosanye');

  eq(cid(g.single[0]), cid(t.hand[3]), '★ single 里换成了原来 piaosanye 的那张');
  eq(cid(g.piaosanye[0]), cid(t.hand[0]), '★ piaosanye 的第一位换成了原来 single 的那张');

  eq(g.single.length, before.single, 'single 张数不变');
  eq(g.tenhalf.length, before.tenhalf, 'tenhalf 张数不变');
  eq(g.piaosanye.length, before.piaosanye, 'piaosanye 张数不变');
})();

console.log('\n[2] 同副 6 张不丢不重（交换最怕的就是丢牌）');

(function () {
  const t = fullRound1();
  const ids = t.hand.map(cid).sort().join(',');
  SM.swapCards(1, t.groups, t.hand[0], t.hand[5]);
  SM.swapCards(1, t.groups, t.hand[2], t.hand[4]);
  const after = flatten(t.groups, 1).map(cid).sort().join(',');
  eq(after, ids, '★ 交换两次之后仍然是同一副 6 张');
  eq(flatten(t.groups, 1).length, 6, '总数仍是 6 张');
})();

console.log('\n[3] 往返交换回到原样');

(function () {
  const t = fullRound1();
  const snapshot = JSON.stringify(t.groups);
  SM.swapCards(1, t.groups, t.hand[0], t.hand[4]);
  SM.swapCards(1, t.groups, t.hand[0], t.hand[4]);
  eq(JSON.stringify(t.groups), snapshot, '★ 换过去再换回来，草稿一字不差');
})();

console.log('\n[4] 拒绝的三种情形（都不能假成功）');

(function () {
  const t = fullRound1();
  const r1 = SM.swapCards(1, t.groups, t.hand[1], t.hand[2]);
  eq(r1.ok, false, '同组内两张 → 拒绝');
  ok(/同一组/.test(r1.error || ''), '错误文案说清是同组', r1.error);

  const r2 = SM.swapCards(1, t.groups, t.hand[0], t.hand[0]);
  eq(r2.ok, false, '同一张牌 → 拒绝');

  const r3 = SM.swapCards(1, t.groups, t.hand[0], { suit: 'S', rank: 2 });
  eq(r3.ok, false, '落点牌不在任何组里 → 拒绝');
  ok(/不在分组里/.test(r3.error || ''), '错误文案说清是找不到牌', r3.error);

  /* 被拒之后草稿必须原封不动 */
  eq(JSON.stringify(t.groups), JSON.stringify(fullRound1().groups), '三种拒绝都没动过草稿');
})();

console.log('\n[5] 第 2 轮（单张 + 斗牛 5 张）同样成立');

(function () {
  const hand = sixCards();
  const g = { single: [hand[0]], douniu: hand.slice(1) };
  const r = SM.swapCards(2, g, hand[0], hand[4]);
  ok(r.ok === true, '单张 ↔ 斗牛 交换成功');
  eq(cid(g.single[0]), cid(hand[4]), '单张换成了斗牛里的那张');
  eq(g.douniu.length, 5, '斗牛仍是 5 张');
  ok(g.douniu.some((c) => cid(c) === cid(hand[0])), '斗牛里出现了原来单张那张');
})();

console.log('\n[6] locateCard 定位');

(function () {
  const t = fullRound1();
  const at = SM.locateCard(t.groups, SM.ROUND_GROUPS[1], t.hand[4]);
  eq(at && at.key, 'piaosanye', '能定位到所在的组');
  eq(at && at.idx, 1, '能定位到组内下标');
  eq(SM.locateCard(t.groups, SM.ROUND_GROUPS[1], { suit: 'S', rank: 2 }), null, '找不到返回 null');
})();

console.log('\n[7] removeCard 仍按原语义工作（locateCard 是共用的，别改坏它）');

(function () {
  const t = fullRound1();
  const r = SM.removeCard(1, t.groups, t.hand[4]);
  eq(r.ok, true, '收回成功');
  eq(r.key, 'piaosanye', '报告的是原来那一组');
  eq(t.groups.piaosanye.length, 2, '该组少一张');
  eq(flatten(t.groups, 1).length, 5, '总数少一张');
})();

console.log('\n[8] 界面接线（源码扫描）');

(function () {
  const root = path.join(__dirname, '..');
  const js = readGameAll();
  const css = fs.readFileSync(path.join(root, 'css', 'style.css'), 'utf8');

  ok(/StateMachine\.swapCards\(/.test(js), '拖拽走 StateMachine.swapCards，不自己拼');
  ok(/d\.overCard/.test(js), '★ 拖拽落点记了具体牌（否则永远解析成「落到这个组」）');
  ok(/'#slots \.card-box\[data-card-id\]'/.test(js), '落点先判牌、再判组');
  ok(/overCard\.classList\.add\('drop-swap'\)/.test(js), '交换有独立高亮，不与整组接收混用');
  ok(/\.card-box\.drop-swap\s*\{/.test(css), 'CSS 有 .drop-swap 样式');
  /* 守卫最要紧的一条：交换分支必须排在「没有 slotKey 就 return」之前，
   * 落到牌上时 slotKey 是显式置 null 的，顺序错了就是「拖过去没反应」。 */
  const endDrag = js.slice(js.indexOf('function endDrag('), js.indexOf('function onHandPointerUp('));
  ok(/swapByDrag\(/.test(endDrag), '★ endDrag 里有交换分支');
  ok(endDrag.indexOf('swapByDrag(') < endDrag.indexOf('if (!d.slotKey) return;'),
    '★ 交换分支排在 slotKey 早退之前（顺序错了就静默失效）');
})();

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
if (fail > 0) process.exitCode = 1;
