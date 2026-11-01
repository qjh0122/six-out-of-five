/**
 * 分牌落点逻辑测试
 * 跑法：node pwa/test/split.test.js
 *
 * 分牌从「点牌选中 → 够到顶部点空槽」改成「点牌直接落进当前组」之后，
 * 「这张牌该进哪一组」成了每点一次都要跑一遍的逻辑。它必须满足：
 *   - 指定组满了不能吞牌，要自动顺延到下一个没满的组
 *   - 全都满了要明确失败，界面才能给出「可以提交了」而不是点了没反应
 *   - 取回一张牌后，那一组要重新腾出位置
 * 这些都是纯数据变换，和 DOM 无关，所以直接测函数。
 */
'use strict';

const SM = require('../js/stateMachine.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

function empty() { return { single: [], tenhalf: [], piaosanye: [], douniu: [] }; }
function card(rank, suit) { return { rank: rank, suit: suit || 'spade' }; }
function n(rank) { return rank; }

console.log('\n[第一轮：单张 1 / 十点半 2 / 飘三叶 3]');

let g = empty();
eq(SM.nextOpenGroup(1, g, null), 'single', '空盘时第一组是单张');
eq(SM.groupsFull(1, g), false, '空盘当然没满');

let r = SM.placeCard(1, g, card(5), 'single');
ok(r.ok === true, '进第一张成功');
eq(r.key, 'single', '落在指定组');
eq(r.full, true, '单张组 1/1 已满');
eq(g.single.length, 1, '数组里真的有这张牌');

eq(SM.nextOpenGroup(1, g, null), 'tenhalf', '单张满了，下一个空位是十点半');

console.log('\n[指定组满了要顺延，不能吞牌]');

r = SM.placeCard(1, g, card(6), 'single');
ok(r.ok === true, '单张已满时点牌不会失败', r.error);
eq(r.key, 'tenhalf', '自动顺延到十点半');
eq(g.single.length, 1, '单张组没有被塞进第二张（否则提交会报重复/超张）');
eq(g.tenhalf.length, 1, '顺延后确实进了十点半');

console.log('\n[连点：一路填满]');

g = empty();
[9, 10, 11, 12, 13, 14].forEach(function (rank) {
  SM.placeCard(1, g, card(rank), 'single');
});
eq(g.single.length, 1, '单张 1 张');
eq(g.tenhalf.length, 2, '十点半 2 张');
eq(g.piaosanye.length, 3, '飘三叶 3 张');
eq(SM.groupsFull(1, g), true, '六张落完，全满');

const over = SM.placeCard(1, g, card(7), 'single');
eq(over.ok, false, '全满之后再点，明确失败');
ok((over.error || '').indexOf('填满') >= 0, '错误信息说得清为什么', over.error);
eq(g.single.length + g.tenhalf.length + g.piaosanye.length, 6, '失败时没有把牌偷偷塞进去');

console.log('\n[第二轮：单张 1 / 斗牛 5]');

g = empty();
eq(SM.nextOpenGroup(2, g, null), 'single', '第二轮第一组还是单张');
SM.placeCard(2, g, card(3), 'single');
eq(SM.nextOpenGroup(2, g, 'single'), 'douniu', '单张满了直接到斗牛（跳过第一轮才有的十点半）');
[4, 5, 6, 7, 8].forEach(function (rank) { SM.placeCard(2, g, card(rank), 'douniu'); });
eq(g.douniu.length, 5, '斗牛 5 张');
eq(SM.groupsFull(2, g), true, '第二轮全满');
eq(g.tenhalf.length, 0, '第二轮不该往十点半里塞牌');

console.log('\n[组没满就一直钉在指定组，不能抢跳]');

g = empty();
// 用户点了「斗牛」，接下来连续放牌都应该进斗牛，而不是第二张就被顺延到单张
[2, 3, 4, 5].forEach(function (rank) {
  r = SM.placeCard(2, g, card(rank), 'douniu');
  eq(r.key, 'douniu', '斗牛未满时，第 ' + rank + ' 张仍进斗牛（不是被推到单张）');
});
eq(g.douniu.length, 4, '连续 4 张都钉在斗牛');
eq(g.single.length, 0, '单张组一张都没被抢走');
// 第 5 张填满斗牛
r = SM.placeCard(2, g, card(6), 'douniu');
eq(r.key, 'douniu', '第 5 张仍在斗牛');
eq(r.full, true, '斗牛此时才满');
// 满了之后再指定斗牛，才顺延到下一个空位（单张）
r = SM.placeCard(2, g, card(7), 'douniu');
eq(r.key, 'single', '斗牛满了才轮到单张');

console.log('\n[取回一张牌]');

r = SM.removeCard(1, g);
eq(r.ok, false, '第二轮的分组里没有第一轮的牌，取不到就返回失败');

g = empty();
const c1 = card(9), c2 = card(10), c3 = card(11);
SM.placeCard(1, g, c1, 'single');
SM.placeCard(1, g, c2, 'tenhalf');
SM.placeCard(1, g, c3, 'tenhalf');
eq(g.tenhalf.length, 2, '十点半满 2 张');

r = SM.removeCard(1, g, c2);
ok(r.ok === true, '取回成功');
eq(r.key, 'tenhalf', '报告了从哪一组取回的');
eq(g.tenhalf.length, 1, '十点半腾出一个位置');
eq(SM.nextOpenGroup(1, g, null), 'tenhalf', '空位重新变成可落点');
eq(g.single.length, 1, '别的组不受影响');

r = SM.removeCard(1, g, card(99));
eq(r.ok, false, '取一张不存在的牌返回失败，不抛错');

console.log('\n[异常输入]');

eq(SM.nextOpenGroup(9, empty(), null), null, '不存在的轮次返回 null');
eq(SM.placeCard(9, empty(), card(1), 'single').ok, false, '不存在的轮次不能放牌');
eq(SM.placeCard(1, empty(), null, 'single').ok, false, '没有牌时不能放');
eq(SM.placeCard(1, empty(), card(1), 'douniu').key, 'single',
  '指定了本轮不存在的组（douniu 是第二轮才有）时，退回第一个能放的组');

console.log('\n[牌对象不被篡改]');
g = empty();
const cc = card(7, 'heart');
SM.placeCard(1, g, cc, 'single');
eq(g.single[0], cc, '放进去的是同一个对象引用（界面靠它读花色/点数）');
eq(Object.keys(cc).length, 2, '没有往牌对象上挂额外字段');

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
if (fail > 0) process.exitCode = 1;
