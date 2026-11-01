/**
 * 战绩落库的幂等键：同房间同场次不能互相顶掉
 * 跑法：node server/test/idempotency-key.test.js
 *
 * 幂等键存在的意义是挡「同一场被重复广播」，但键取得太粗就会顺手挡掉**另一场真打的牌**。
 *
 * 原来的键是 `房间#场次`（roomId 是 6 位数字、且**会回收**）。
 *   房间 573921 的第 3 场打完了 → 键 `573921#3`
 *   过几天同一个房间号又被随机抽到，又打到第 3 场 → 还是 `573921#3`
 *   而 `_seen` 保留最近 40 条，这中间完全可能只有几场
 * → 第二场被当重复**静默丢掉**：玩家打了一整场，档案里什么都没有，且没有任何报错。
 *
 * 现在键是 `房间#场次#结算时刻`。结算时刻（room.settledAt）在 markSettled 里只写一次，
 * 同一场重复广播拿到的必然是同一个值，所以幂等性没有被削弱 —— 这两件事必须一起验，
 * 否则很容易为了修「误挡」而把「重复」也放进来。
 */
'use strict';

const os = require('os');
const path = require('path');

const { ProfileStore } = require('../profile.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

let seq = 0;
function fresh() {
  seq += 1;
  const base = path.join(os.tmpdir(), 'lxw-idem-' + process.pid + '-' + seq);
  return new ProfileStore({ file: base + '-prof.json', seedFile: base + '-seed.json' });
}

console.log('\n[1] 同一场重复广播：仍然只记一次]');

{
  const s = fresh();
  const t = 1761800000000;
  const r1 = s.record('p1', '甲', 5, t, '573921', 3, { playerCount: 2 });
  eq(r1.recorded, true, '第一次落库是「真的记了」');

  /* 完全相同的三个分量 = 同一场被广播两次 */
  const r2 = s.record('p1', '甲', 5, t, '573921', 3, { playerCount: 2 });
  eq(r2.reason, 'duplicate', '★ 同一场重复广播被幂等挡住');
  eq(s.getSelf('p1').games, 1, '★ 场次仍然是 1（没有记成 2 场）');
  eq(s.getSelf('p1').totalNet, 5, '★ 净胜没有被重复累加');
}

console.log('\n[2] 房间号回收后撞到同一场次：这是另一场真打的牌，必须记]');

{
  const s = fresh();
  const t1 = 1761800000000;
  const t2 = t1 + 3 * 24 * 3600 * 1000;          // 三天后又抽到同一个 6 位房间号

  s.record('p1', '甲', 5, t1, '573921', 3, { playerCount: 2 });
  const r2 = s.record('p1', '甲', -2, t2, '573921', 3, { playerCount: 3 });

  ok(!(r2 && r2.reason === 'duplicate'), '★ 同房间同场次、不同结算时刻 → 不被当成重复',
    'reason=' + (r2 && r2.reason));
  eq(s.getSelf('p1').games, 2, '★ 两场都记上了（旧实现这里会静默只剩 1 场）');
  eq(s.getSelf('p1').totalNet, 3, '★ 净胜 5 + (−2) = 3');
  eq(s.getSelf('p1').recent.length, 2, '战绩流水里两条都在');
}

console.log('\n[3] 三处细微但会反噬的情形]');

{
  const s = fresh();
  /* 3.1 房间号也一样、场次也一样、连净胜也一样，只有时刻不同 —— 仍是两场 */
  s.record('p1', '甲', 0, 1000, 'R', 1, {});
  s.record('p1', '甲', 0, 2000, 'R', 1, {});
  eq(s.getSelf('p1').games, 2, '★ 时刻不同就是两场（哪怕分数一模一样）');

  /* 3.2 endedAt 缺失时退回两段式键：不能因为「键短了一段」就每广播一次记一场。
   *     这是给「还没改过来的调用方」留的兼容口子，必须有。 */
  const s2 = fresh();
  s2.record('p2', '乙', 4, undefined, 'R', 2, {});
  const dup = s2.record('p2', '乙', 4, undefined, 'R', 2, {});
  eq(dup.reason, 'duplicate', '★ endedAt 缺失时仍按「房间#场次」去重（不降级成不去重）');
  eq(s2.getSelf('p2').games, 1, '★ 只记了 1 场');

  /* 3.3 endedAt 传 0 / NaN / 字符串等脏值时，一律按缺失处理，不进键 */
  const s3 = fresh();
  [0, NaN, 'abc', null].forEach((bad) => {
    s3.record('p3', '丙', 1, bad, 'R', 5, {});
  });
  eq(s3.getSelf('p3').games, 1, '★ 脏 endedAt 全部退化成同一个两段式键，只记 1 场');
}

console.log('\n[4] 幂等键不会无限增长]');

{
  const s = fresh();
  for (let i = 1; i <= 60; i++) {
    s.record('p1', '甲', 1, 1000 + i, 'WIN' + i, 1, {});
  }
  const p = s.get('p1');
  const seenKeys = Object.keys(p._seen || {});
  ok(seenKeys.length <= 41, '★ 幂等键被裁剪到 40 条附近', '实际 ' + seenKeys.length + ' 条');
  eq(p.games, 60, '60 场一场不少');
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
if (fail > 0) process.exitCode = 1;
