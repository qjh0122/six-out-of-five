/**
 * 爆点提交拦截 + 两处口径说明的静态测试
 * 跑法：node pwa/test/bust-block.test.js
 *
 * 为什么是静态的：这次要守的是「提交这条路被拦住了没有」——
 * 而拦截本身的正确性（什么时候该拦）已经由 tenhalf-priority.test.js 盯着
 * （kind='bust' 分支、整手必爆返回 null 分支各有一组断言）。
 * 真正跑一遍「点结束本局 → 弹框 → 点去改 → 换牌 → 再提交」交给
 * scripts/probe-tenhalf.js 的 [3] 段（真浏览器）。这里只守三件容易在后续改动里
 * 被悄悄改回去的事：
 *   1. onSubmit **先判爆点、再弹确认框**（顺序反了就又变回「提示完照样能提交」）；
 *   2. 拦截框只有一个出口，没有「就这样提交」的后路；
 *   3. 排行榜页脚写的是「不含人机对局」，战绩页那句会带上「列表近 N 局」。
 */
'use strict';

const { readAll: readGameAll } = require('./helpers/gameSource');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const gameJs = readGameAll();

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

/* ---------- 定位函数体 ---------- */
function bodyOf(header) {
  const at = gameJs.indexOf(header);
  if (at < 0) return '';
  /* 从函数头往后取到下一个顶层函数声明为止：够粗，但比全文匹配可靠得多 */
  const rest = gameJs.slice(at + header.length);
  const end = rest.search(/\n  (?:async )?function [a-zA-Z_$]+\s*\(/);
  return end < 0 ? rest : rest.slice(0, end);
}

/* ---------- 1. 顺序：先判爆点，再弹确认框 ---------- */
console.log('\n[1] onSubmit：爆点判定必须排在「弹确认框」之前');
const onSubmit = bodyOf('async function onSubmit() {');
ok(onSubmit.length > 0, '★ 能定位到 onSubmit 的函数体（否则下面几条全是空转）');

const atBust = onSubmit.indexOf('tenHalfAdvice(1, groups, me.hand)');
const atConfirm = onSubmit.indexOf('askConfirm(');
ok(atBust > 0, '★ onSubmit 里调用了 StateMachine.tenHalfAdvice（判据放在状态机，不在界面里重写）',
  onSubmit.slice(0, 120));
ok(atConfirm > 0, 'onSubmit 里仍然会弹提交确认框');
ok(atBust > 0 && atConfirm > 0 && atBust < atConfirm,
  '★ 爆点判定在确认框之前（顺序反了就又变成「提示完照样能提交」）',
  'bust@' + atBust + ' confirm@' + atConfirm);
ok(/kind === 'bust'/.test(onSubmit),
  '★ 只拦 kind=\'bust\'（手里还有不爆的打法）；整手必爆返回 null，照常放行');
ok(/blockBustSubmit\(bustAdv\)/.test(onSubmit), '★ 命中就交给 blockBustSubmit，并且 return');

/* 旧的「bustTip 塞进确认框」写法必须已经删干净 —— 它正是这次要修的那个半成品 */
ok(!/bustTip/.test(onSubmit), '★ 旧的 bustTip（把爆点写进确认框但照样提交）已删除');

/* ---------- 2. 拦截框：一个出口，没有后路 ---------- */
console.log('\n[2] 拦截框只有一个「去改」');
const bustTag = (/<div\b[^>]*\bid="bust-modal"[^>]*>[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/.exec(html) || [''])[0];
ok(bustTag.length > 0, '能定位到 #bust-modal 的 HTML');
const bustBtns = (bustTag.match(/<button\b/g) || []).length;
eq(bustBtns, 1, '★ 只有一个按钮（没有「坚持提交 / 就这样提交」这种后路）');
ok(/id="bust-title"/.test(bustTag), '标题元素带 id（aria-labelledby 指得到）');
ok(/id="bust-desc"/.test(bustTag), '正文元素带 id（文案由 JS 填点数）');
ok(/id="btn-bust-fix"/.test(bustTag), '按钮 id = btn-bust-fix');
/* 注释里会解释「为什么不给就这样提交的后路」，所以先剥掉注释再扫文案 ——
 * 不然这条断言会被自己的说明文字绊倒（第一次跑就绊了）。 */
const htmlText = html.replace(/<!--[\s\S]*?-->/g, '');
ok(!/就这样提交|坚持提交|继续提交/.test(htmlText), '★ 全站没有「就这样提交」式的出口文案');

const blockFn = bodyOf('function blockBustSubmit(adv) {');
ok(blockFn.length > 0, '★ 能定位到 blockBustSubmit');
ok(/showModalEl\('bust-modal'\)/.test(blockFn), '★ 走 showModalEl（焦点进出与 Tab 圈定才成立）');
ok(!/classList\.remove\('hidden'\)/.test(blockFn), '没有绕过 showModalEl 直接开');
ok(/activeGroup = 'tenhalf'/.test(blockFn), '★ 把当前组切回十点半（合上就能动手改）');
/* 顺序：render() 会重建槽位，先弹框再渲染会把 nudge 动画冲掉 */
const atRender = blockFn.indexOf('render()');
const atShow = blockFn.indexOf("showModalEl('bust-modal')");
ok(atRender >= 0 && atShow > atRender, '★ 先 render 再 showModalEl（否则刚挂上的抖动会被重建冲掉）',
  'render@' + atRender + ' show@' + atShow);
ok(/fmtTenths\(adv\.points\)/.test(blockFn), '文案里带上具体点数（不是一句空的「爆了」）');

/* ---------- 3. 入口：按钮 / Esc / 叠层 ---------- */
console.log('\n[3] 入口与叠层');
ok(/\$\('#btn-bust-fix'\)\.addEventListener\('click'/.test(gameJs), '「去改」按钮有绑定');
ok(/if \(!\$\('#bust-modal'\)\.classList\.contains\('hidden'\)\) \{ hideModalEl\('bust-modal'\); return; \}/.test(gameJs),
  '★ Esc 能关掉拦截框（键盘用户否则只能点按钮）');
ok(/var MODAL_ORDER = \['bust-modal',/.test(gameJs),
  '★ bust-modal 登记在 MODAL_ORDER 最前（它是当时唯一的一层，Tab 圈定要认得它）');

/* ---------- 4. 两处文案口径 ---------- */
console.log('\n[4] 文案口径');
ok(/按累计净胜排序 · 不含人机对局/.test(html), '★ 排行榜页脚写的是「不含人机对局」');
ok(!/仅统计对人类局/.test(html), '旧的「仅统计对人类局」已换掉（用户要的是直接说不含人机）');

const noteAt = gameJs.indexOf("$('#rp-ai-note-text').textContent");
const noteSeg = noteAt > 0 ? gameJs.slice(noteAt, noteAt + 400) : '';
ok(noteSeg.length > 0, '能定位到战绩页人机说明的赋值');
ok(/列表近/.test(noteSeg), '★ aiRecent 被截断时补「列表近 N 局」（否则 N 局比列出来的行数多）');
ok(/不计入战绩与排行榜/.test(noteSeg), '仍然写清「不计入」');
ok(!/'人机对局 '/.test(noteSeg),
  '★ 正文不再自带「人机对局」（芯片上已有「含人机」，重复会读成「含人机人机对局」）');

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
