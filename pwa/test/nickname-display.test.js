/**
 * 昵称显示：正常长度的名字必须完整显示（v143）
 * 跑法：node pwa/test/nickname-display.test.js
 *
 * 真机上报的场景（2026-11-11，等待房间截图）：
 *   一个 8 半角的英文昵称在座位上显示成「Playe…」，在 2 人局对战条上也一样。
 *   第一眼看着像「昵称太长被省略号收了」，但那其实是**误伤** ——
 *   `short()` 当时写的是 `name.length > 4` 就截成 4 个字：
 *
 *       function short(name) { return name.length > 4 ? name.slice(0, 4) + '…' : name; }
 *
 *   8 个半角字符在 20px 字号下约 88px，而座位名块有 112px
 *   （seatRing 的 nmw），完全放得下；中文名更明显，5 个中文 = 100px
 *   也在 112px 之内，同样被截。判据用了「字符数」，而布局约束是「像素宽」，
 *   两者不是一回事，所以名字长度一过 4 就无差别中枪。
 *   （用例里的名字是等宽替身，见 [1] 的说明。）
 *
 * 守的东西：
 *   [1] 线上在用的昵称宽度分布一律完整显示（值逐个手写，不引用被测常量）
 *   [2] 只有真的撑不下才截，且**截断必须带省略号**（不许静默丢字）
 *   [3] emoji 按码点走，不会劈成两个问号
 *   [4] 接线：座位名与 2 人局对战条这两个「用户直接看得见」的位置，
 *       必须都走 short()，不许有一处绕过
 */
'use strict';

const fs = require('fs');
const path = require('path');
const U = require('../js/gameUtils.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

const ROOT = path.join(__dirname, '..', '..');
const game = fs.readFileSync(path.join(ROOT, 'pwa', 'js', 'game.js'), 'utf8');

console.log('\n[1] 真实昵称必须完整显示');
/* ★ 这些是**等宽替身**（2026-11-12）：用例的宽度分布取自线上真实昵称，
 * 但玩家昵称属于数据，不进仓库 —— 仓库要能公开，而名字本身对断言没有任何作用。
 * 每个替身的显示宽度与原来的真实昵称一致（半角 1 / 中文 2），所以覆盖面没变：
 *   8 半角 / 5 中文 / 8 半角 / 3 中文 / 4 / 5 / 3 / 2 中文 / 2 中文 / 1 / 6 半角。
 * 逐个写死期望值 = 原样返回，**不引用 SHORT_W** —— 上限将来再调，
 * 调错方向（比如又调回 4）会在这里红，而不是跟着常量一起漂绿。 */
const REAL = [
  'PlayerAA',      // 8 半角（截图里被误截成「Playe…」的就是这个宽度）
  '示例玩家甲',     // 5 中文
  'DemoUser',      // 8 半角
  '示例丙',         // 3 中文
  'demo',          // 4 半角
  'nolan',         // 5 半角
  'bob',           // 3 半角
  '甲乙',           // 2 中文
  '丙丁',           // 2 中文
  'A',             // 1 半角（最短边界）
  'taylor'         // 6 半角
];
REAL.forEach(function (n) {
  eq(U.short(n), n, '完整显示 ' + JSON.stringify(n));
});

console.log('\n[2] 截断只在真的撑不下时发生，且必须带省略号');
/* 座位名块最宽 132px（seatRing 三个布局里的 nmwMax 最大者），20px 字号下
 * 约 12 个半角 / 6 个全角。超过这个量级才该动手。 */
const LONG = [
  '这是一个非常非常长的昵称',      // 12 个全角 = 24 等效，必然截
  'abcdefghijklmnopqrstuvwxyz'  // 26 个半角
];
LONG.forEach(function (n) {
  const out = U.short(n);
  ok(out.length < n.length, '确实缩短了 ' + JSON.stringify(n), out);
  ok(/…$/.test(out), '带省略号（不许静默丢字） ' + JSON.stringify(n), out);
});
/* 负向：不能把长的原样放过 —— 否则「完整显示」会变成「什么都不截」 */
ok(U.short('abcdefghijklmnopqrstuvwxyz') !== 'abcdefghijklmnopqrstuvwxyz',
  '负向：26 个半角不许原样返回');

console.log('\n[3] emoji 按码点走，不劈成半个');
/* 半个代理项在 DOM 里会渲染成方块 / 问号。Array.from 保证不会出现。 */
const EMOJI_LONG = '🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉';
const eout = U.short(EMOJI_LONG);
ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(eout.replace(/…$/, '')), '没有孤立高位代理项', eout);
ok(!/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(eout.replace(/…$/, '')), '没有孤立低位代理项', eout);
eq(U.short('🎉玩家'), '🎉玩家', '短 emoji 昵称完整显示');

console.log('\n[4] 空值 / 非字符串不炸');
eq(U.short(''), '', '空串返回空串');
eq(U.short(null), '', 'null 返回空串');
eq(U.short(undefined), '', 'undefined 返回空串');
eq(U.short(12345), '12345', '数字转成字符串');

console.log('\n[5] 接线：句子/列表里的名字仍走 short()，座位名改走缩字号');
/* 20261111e 起，**座位名与对战条不再截字** —— 它们改成「一行放不下就缩字号」
 *（见 pwa/test/nickname-fit.test.js）。这里守的是另一半：`short()` 还留在
 * 「名字嵌在一句话/一格固定宽列表里」的位置，那些地方缩字号没有意义
 *（句子的字号不能为了一个名字变小），截断才是对的。
 *
 * 所以本节的语义是：**这两类位置不许混淆**。谁把 short() 从掉线提示里删掉，
 * 长名会把整句话撑出屏幕；谁把它加回座位名，7 个中文又变省略号。
 * 两个方向各有一条断言。 */
const seatUses = (game.match(/<span class="opp-name">' \+ esc\(p\.nickname\)/g) || []).length;
eq(seatUses, 2, '座位名两条渲染路径已改为原样渲染（缩字号由 fitLongNames 负责）');
ok(!/esc\(short\(p\.nickname\)\)/.test(game), '负向：座位名不许再走 short()');
/* 句子/列表位：掉线提示（game.js）、表情面板选人（seatSheetView）、
 * 结算等待（settleView）—— 三处仍在用。 */
ok(/return short\(p\.nickname \|\| '他'\);/.test(game), '掉线提示仍走 short()');
const seatSheet = require('fs').readFileSync(require('path').join(ROOT, 'pwa', 'js', 'seatSheetView.js'), 'utf8');
ok(/esc\(short\(p\.nickname \|\| ''\)\)/.test(seatSheet), '表情面板选人仍走 short()');
const settle = require('fs').readFileSync(require('path').join(ROOT, 'pwa', 'js', 'settleView.js'), 'utf8');
ok(/return short\(p\.nickname \|\| '朋友'\);/.test(settle), '结算等待仍走 short()');

console.log('\n' + (fail === 0 ? '全部通过' : fail + ' 项失败') + ' —— ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail === 0 ? 0 : 1);
