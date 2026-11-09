/**
 * 逐把流水：累计快照 → 本把盈亏（server/botRunner.js 的 handDeltas）
 * 跑法：node server/test/bot-hand-delta.test.js
 *
 * 为什么单独测这个函数：后台的逐把流水原先直接铺 `score`，而那个值是
 * **打完这一把之后的累计**。于是每一行都长得像「累计净胜」，实际看不出
 * 任何一把的输赢 —— 用户报的就是「累计净胜这列不合理，应该展示每局的详情」。
 *
 * 这里锁三件事：
 *   1. 第一把的 delta 就是它自己的累计（起点是 0，不是「没有上一把」）；
 *   2. 同一个玩家相邻两把的 delta 之和 == 最后一把的累计（不漂）；
 *   3. **换场必须重置**。每场分数从 0 重发，跨场沿用会把上一场终局分
 *      当成本场起点，算出「第一把 −120」这种一看就不对的数字。
 */
'use strict';

const { handDeltas } = require('../botRunner.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}
const byName = (arr) => {
  const o = {};
  arr.forEach((x) => { o[x.nickname] = x; });
  return o;
};

console.log('[第一把：起点是 0]');
{
  const prev = {};
  const out = byName(handDeltas(prev, { 甲: 30, 乙: -30 }));
  ok(out['甲'].delta === 30 && out['甲'].score === 30, '甲的 delta == 累计（从 0 起算）', out['甲']);
  ok(out['乙'].delta === -30 && out['乙'].score === -30, '乙的 delta 是负的，不是绝对值', out['乙']);
  ok(prev['甲'] === 30 && prev['乙'] === -30, '回调里记下了累计，供下一把相减', prev);
}

console.log('\n[逐把相减：和为最后一把的累计]');
{
  const prev = {};
  const snaps = [
    { 甲: 20, 乙: -20 },
    { 甲: 5, 乙: -5 },     // 这一把乙赢回去 15，甲倒输 15
    { 甲: 5, 乙: -5 }      // 这一把两人打平
  ];
  const all = snaps.map((s) => handDeltas(prev, s));
  const a = all.map((r) => byName(r)['甲']);
  const b = all.map((r) => byName(r)['乙']);
  ok(a[0].delta === 20 && a[1].delta === -15 && a[2].delta === 0, '甲：+20 / −15 / 0', a.map((x) => x.delta));
  ok(b[0].delta === -20 && b[1].delta === 15 && b[2].delta === 0, '乙：−20 / +15 / 0', b.map((x) => x.delta));
  ok(a.reduce((s, x) => s + x.delta, 0) === 5, '三把 delta 之和 == 第三把的累计 5',
    { sum: a.reduce((s, x) => s + x.delta, 0), last: a[2].score });
  ok(a.map((x) => x.score).join(',') === '20,5,5', '每行仍带着当时的累计（给「累计净胜」单起一条用）',
    a.map((x) => x.score));
}

console.log('\n[换场必须重置：否则第一把会拿上一场终局分当起点]');
{
  const prev = {};
  handDeltas(prev, { 甲: 80, 乙: -80 });      // 第一场打到 +80 收尾
  const wrong = byName(handDeltas(prev, { 甲: -10, 乙: 10 }));   // 沿用上一场的 prev
  ok(wrong['甲'].delta === -90, '不重置就会算出 −90（复现这个坑，说明重置不是可有可无）', wrong['甲'].delta);

  const fresh = {};                            // 第二场：新开一份
  const right = byName(handDeltas(fresh, { 甲: -10, 乙: 10 }));
  ok(right['甲'].delta === -10 && right['乙'].delta === 10, '重置后第二场第一把就是它自己的输赢', right);
}

console.log('\n[边界：空快照 / 新玩家中途出现]');
{
  const prev = {};
  ok(handDeltas(prev, {}).length === 0, '空快照返回空数组，不崩');
  ok(handDeltas(prev, null).length === 0, 'null 快照也不崩');
  handDeltas(prev, { 甲: 10 });
  const r = byName(handDeltas(prev, { 甲: 10, 丙: 5 }));
  ok(r['丙'].delta === 5, '中途出现的玩家从 0 起算（不拿别人的累计来减）', r['丙']);
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
