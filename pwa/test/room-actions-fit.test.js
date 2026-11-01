/**
 * 房间页底排按钮的排版约束（BACKLOG N1）
 *
 * 问题回顾：390 宽下「补 AI 队友」被拆成「补 AI 队」+「友」。
 * 根因不是容器太窄，而是 `flex: 1` 把三颗按钮压成**等宽**，
 * 而中文字允许逐字断行 —— 浏览器选择了「挤在同一行 + 从词中间劈开」，
 * 而不是「整体换到下一行」。
 *
 * 所以修法必须是两句话一起说：
 *   ① 文字不许断（white-space: nowrap）
 *   ② 容器允许换行（flex-wrap: wrap）
 * 只做①会横向溢出，只做②还是会在等宽约束下断字。
 *
 * 这里测的是 CSS 规则本身。真实的渲染结果由 scripts/probe-room-actions.js
 * 在 320/360/390/430/横屏 五档宽度上量（判据是文本节点被拆成几个矩形）。
 * 两者都要在：单测防「有人把这两条删了」，探针防「删了之外还能挤出别的问题」。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

/* 取出某个选择器的**全部**声明块并拼起来。
 * 为什么不能只取第一个：同一个选择器会被拆成多条规则
 * （`.ls … .ghost-row { width:100% }` 和 `{ flex-direction: column }` 就是两处），
 * 只取第一个会漏掉后面那条 —— 这正是第一次跑这个测试时假失败的原因。 */
function rule(sel) {
  const parts = [];
  let from = 0;
  for (;;) {
    const i = css.indexOf(sel + ' {', from);
    if (i < 0) break;
    const j = css.indexOf('}', i);
    parts.push(css.slice(i + sel.length + 2, j));
    from = j;
  }
  return parts.length ? parts.join('\n') : null;
}

console.log('\n[竖屏：文字不断行 + 容器可换行]');
const row = rule('.room-actions .ghost-row');
ok(!!row, '存在 .room-actions .ghost-row 规则');
ok(/flex-wrap:\s*wrap/.test(row || ''), '容器允许换行（否则只能靠压窄按钮来塞下）', row);
ok(/display:\s*flex/.test(row || ''), '仍是 flex 布局（不能退回 block）');

const btn = rule('.room-actions .ghost-row .btn');
ok(!!btn, '存在按钮规则');
ok(/white-space:\s*nowrap/.test(btn || ''), '按钮文字不断行（这是本条的核心）', btn);
ok(!/min-width:\s*0/.test(btn || ''), '没有 min-width:0 —— 那会让文字溢出按钮而不是换行', btn);
ok(!/flex:\s*1;/.test(btn || ''), '不再用 flex:1 等分（等分才是断字的直接原因）', btn);

console.log('\n[横屏：竖排时不能另起一列]');
const ls = rule('.ls #screen-room .room-actions .ghost-row');
ok(!!ls, '存在横屏覆盖规则');
ok(/flex-direction:\s*column/.test(ls || ''), '横屏是竖排', ls);
/* column + wrap 在高度不够时会另起一列，三颗按钮会横着排成三列 —— 必须显式关掉。 */
ok(/flex-wrap:\s*nowrap/.test(ls || ''), '横屏显式关掉换行（column + wrap 会变成多列）', ls);

console.log('\n[兼容层：老内核里这排也不能断字]');
/* flex gap 兼容层只补 margin，不管 nowrap。nowrap 在老内核同样生效，
 * 所以这里只需要确认兼容层没有反向覆盖这两个属性。 */
const fb = fs.readFileSync(path.join(ROOT, 'css/flex-gap-fallback.css'), 'utf8');
ok(fb.indexOf('white-space') === -1, '兼容层不碰 white-space（不会把 nowrap 冲掉）');
ok(fb.indexOf('flex-wrap') === -1, '兼容层不碰 flex-wrap');

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail === 0 ? 0 : 1);
