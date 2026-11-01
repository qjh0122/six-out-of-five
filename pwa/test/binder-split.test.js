/**
 * 事件绑定的结构守卫（node pwa/test/binder-split.test.js）
 *
 * `bindEvents` 曾经是 786 行：12 个分屏 binder **住在它肚子里**。
 * v79 按屏拆过一次（定位成本降了），但函数本身没短，因为它把 17 个函数装在自己里面。
 * v111 把它们抬到模块作用域，`bindEvents` 变成一张目录。
 *
 * ── 这份守卫守什么、不守什么 ─────────────────────────────────────────
 * 它守**结构**：binder 在模块级、bindEvents 里只剩调用、没有人偷偷往里加绑定。
 * 它**不守行为** —— 「点了会不会真的触发」这一层靠真浏览器：
 *   · `scripts/journey.js`（126 项，把每一屏点一遍）
 *   · `scripts/probe-ui-flow.js`（12 视口 × 13 屏）
 *   · CI 的 `ui-probe` job（v110 起，横竖屏各跑一次）
 * 单独写 12 个「handler 被调用次数」断言的想法被否掉了：那要么得把 game.js
 * 拖进 jsdom（多一个运行环境，测的还是替身），要么在源码里插计数（改被测对象）。
 * 真浏览器那条链已经在 CI 里，比计数器可信。
 */
'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'game.js'), 'utf8');

/* 12 个分屏 binder 里，11 个住在 game.js，第 12 个 `bindSeatSheet` 住在
 * js/seatSheetView.js（v108 拆出去的座位面板），由 game.js 注入进来。
 * 这恰好是 v108 那类「契约失配不报错」的高危点：注入漏了，座位面板就全哑，
 * 而单测会全绿 —— 所以这里单独钉一条。 */
const BINDERS = [
  'bindTableControls', 'bindGuide', 'setupInstallGuide', 'bindProfileCards',
  'bindRename', 'bindRecordsNav', 'bindAuthScreen',
  'bindAccountScreen', 'bindSettleActions', 'bindKeyboard', 'bindViewportAndLifecycle'
];
const INJECTED = ['bindSeatSheet'];

/* 取函数体：从 `  function name(` 到同缩进的收尾 `  }`（模块级函数都是 2 格） */
function bodyOf(name) {
  const re = new RegExp('\\n  function ' + name + '\\([^)]*\\) \\{([\\s\\S]*?)\\n  \\}\\n');
  const m = re.exec(src);
  return m ? m[1] : null;
}

console.log('\n[1] 12 个 binder 都在模块作用域');
{
  const missing = BINDERS.filter((n) => !new RegExp('\\n  function ' + n + '\\(').test(src));
  ok(missing.length === 0, '★ 11 个分屏 binder 都是 game.js 的模块级函数', missing.join(','));
  INJECTED.forEach((n) => {
    ok(new RegExp('var ' + n + ' = Seat\\.' + n).test(src), '★ ' + n + ' 从 seatSheetView 注入（漏了就整块功能全哑）');
  });
  const seatSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'seatSheetView.js'), 'utf8');
  ok(new RegExp('function ' + INJECTED[0] + '\\(').test(seatSrc), '★ seatSheetView.js 里确实定义了这个 binder');
  /* 反证：如果它们还在 bindEvents 里面，缩进会是 4 格 */
  const stillNested = BINDERS.filter((n) => new RegExp('\\n    function ' + n + '\\(').test(src));
  ok(stillNested.length === 0, '★ 没有残留的「嵌在 bindEvents 里」的副本', stillNested.join(','));
}

console.log('\n[2] bindEvents 只是一张目录');
{
  const re = /\n  function bindEvents\(\) \{([\s\S]*?)\n  \}\n/;
  const m = re.exec(src);
  ok(!!m, '找得到 bindEvents');
  const body = m ? m[1] : '';
  const lines = body.split('\n').filter((l) => l.trim() && !/^\s*(\/\*|\*|\/\/)/.test(l));
  ok(lines.length <= 16, 'billEvents 只剩调用（有效行 ' + lines.length + '，上限 16）', lines.length);
  BINDERS.concat(INJECTED).forEach((n) => {
    ok(new RegExp('\\n    ' + n + '\\(\\);').test(body), 'bindEvents 调用了 ' + n);
  });
  ok(!/addEventListener/.test(body), '★ bindEvents 里没有任何 addEventListener（绑定必须在自己那一屏里）');
}

console.log('\n[3] 每个 binder 真的绑了东西');
{
  const empty = BINDERS.filter((n) => {
    const b = bodyOf(n);
    return !b || !/addEventListener|\.onclick\s*=|\.on\w+\s*=/.test(b);
  });
  ok(empty.length === 0, '★ 每个 binder 至少注册一个监听（空壳会静默失效）', empty.join(','));

  /* 顺带守一条：绑定必须挂在具体元素上，不能全文 document.addEventListener 兜底 ——
   * 那种写法人人都在监听，点哪儿都响，出了事分不清是谁的。 */
  const docHeavy = BINDERS.filter((n) => {
    const b = bodyOf(n) || '';
    const all = (b.match(/addEventListener/g) || []).length;
    const doc = (b.match(/document\.addEventListener/g) || []).length;
    return all > 0 && doc === all;
  });
  ok(docHeavy.length === 0, '没有「只挂 document」的 binder（视口/键盘那屏本来就该挂 document，单独看下面）',
    docHeavy.join(','));
}

console.log('\n[4] 抬上来的共享状态');
{
  ['GUIDE_TOTAL', 'guideStep', 'achBackScreen'].forEach((v) => {
    ok(new RegExp('\\n  var ' + v + ' ').test(src), '★ ' + v + ' 在模块级声明（抬出去的函数要读它）');
    ok(!new RegExp('\\n    var ' + v + ' ').test(src), v + ' 没有残留在函数内部的旧声明');
  });
}

console.log('\n----------------------------------------');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) process.exit(1);
