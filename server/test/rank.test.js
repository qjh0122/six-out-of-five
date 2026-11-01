/**
 * 排行榜「我在第几名」测试
 * 跑法：node server/test/rank.test.js
 *
 * 榜单页只给 top 50，排在 51 名开外的人打开就是「榜上没我」——
 * 明明打了十几把，界面却说不出他第几。这个用例锁住：
 *   1. top(50) 只切列表，不能改变排序口径
 *   2. rankOf 用的是**完整**榜单的名次（不是 top50 里的位置）
 *   3. 没打过牌的人不该有名次（不然没玩过就是第 N 名，很怪）
 *   4. top 和 rankOf 必须口径一致——两套排序算法是这类功能最容易埋的坑
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ProfileStore } = require('../profile.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

const tmpFile = path.join(os.tmpdir(), 'lxw-rank-test-' + process.pid + '.json');
function fresh() {
  // 主文件存在即权威（含空对象），不写 {} 的话会从随包的种子文件恢复真实玩家数据
  fs.writeFileSync(tmpFile, '{}', 'utf8');
  return new ProfileStore({ file: tmpFile });
}

/* 造 n 个人：第 i 名净胜 (n - i) 分，都是胜场 */
function seed(store, n) {
  for (let i = 0; i < n; i++) {
    const id = 'p' + String(i).padStart(2, '0');
    const net = n - i;
    store.record(id, '玩家' + i, net, Date.now(), 'r' + i, 1);
  }
}

console.log('\n[top(50) 的边界]');

let store = fresh();
seed(store, 60);

const top = store.top(50);
eq(top.length, 50, '60 人在榜，top(50) 只给 50 条');
eq(top[0].playerId, 'p00', '第一名是净胜最高的');
eq(top[0].totalNet, 60, '净胜值对得上');
eq(top[49].playerId, 'p49', '第 50 名正确');
ok(!top.some(function (r) { return r.playerId === 'p55'; }), '第 56 名不在 top50 里（正是问题所在）');

console.log('\n[rankOf 给的是完整榜单名次]');

const me55 = store.rankOf('p55');
ok(me55 !== null, '第 56 名能查到名次');
eq(me55.rank, 56, '名次是 56（不是"不在榜上"）');
eq(me55.total, 60, '带上总人数，界面才能说"56 / 60"');
eq(me55.nickname, '玩家55', '带上自己的昵称，榜单末尾那行要显示');
eq(me55.totalNet, 5, '带上自己的净胜');

eq(store.rankOf('p00').rank, 1, '第 1 名');
eq(store.rankOf('p49').rank, 50, '第 50 名（刚好在榜尾）');
eq(store.rankOf('p50').rank, 51, '第 51 名（top50 之外的第一人）');

console.log('\n[top 与 rankOf 口径一致]');

let mismatch = null;
for (let i = 0; i < 50; i++) {
  const r = store.rankOf(top[i].playerId);
  if (!r || r.rank !== i + 1) { mismatch = i; break; }
}
eq(mismatch, null, 'top50 里每一行的位置都等于 rankOf 给出的名次');

console.log('\n[没打过牌的人没有名次]');

store = fresh();
store.ensure('ghost', '幽灵');
eq(store.rankOf('ghost'), null, '只进过房间没结算 → 不入榜');
eq(store.top(50).length, 0, '榜是空的');
eq(store.rankOf(''), null, '空 id 返回 null');
eq(store.rankOf(null), null, 'null 返回 null');
eq(store.rankOf('不存在的人'), null, '查不到返回 null，不抛错');

console.log('\n[并列时的排序]');

store = fresh();
store.record('a', 'A', 10, 1, 'r1', 1);
store.record('b', 'B', 10, 1, 'r2', 1);
store.record('c', 'C', 10, 1, 'r3', 1);
store.record('c', 'C', 5, 1, 'r3', 2);   // c 变成 2 胜
store.data.get('c').wins = 2;
const tie = store.top(50);
eq(tie[0].playerId, 'c', '净胜相同时胜场多的在前');
eq(store.rankOf('c').rank, 1, 'rankOf 用的是同一套并列规则');

console.log('\n[净胜为负也照样有名次]');

store = fresh();
seed(store, 5);
store.record('loser', '倒霉蛋', -99, Date.now(), 'rx', 1);
const last = store.rankOf('loser');
eq(last.rank, 6, '垫底也是有名次的');
eq(last.totalNet, -99, '净胜是负的也如实返回');
eq(store.top(50)[5].playerId, 'loser', '垫底排在最后一行');

try { fs.unlinkSync(tmpFile); } catch (e) {}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
if (fail > 0) process.exitCode = 1;
