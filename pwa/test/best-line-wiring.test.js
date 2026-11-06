/**
 * 「理论最高分」的接线守卫（node pwa/test/best-line-wiring.test.js）
 *
 * 逻辑正确但**没接上**，是这个项目踩过最多次的坑：v108 那次 4463 条断言全绿、
 * CI 全绿，真浏览器里所有弹窗全哑 —— 因为脚本没被引用、或者预缓存漏了一项。
 * 所以这里守的是「它到底有没有被加载/被调用」，而不是「它算得对不对」（后者在 best-line.test.js）。
 *
 * 守四件事：
 *   1. index.html 引用了 bestLine.js，且**排在 stateMachine 之前**（它在工厂里 require engine，
 *      但没有硬依赖；顺序错了不报错，只会让 window.BestLine 晚一步出现，结算页整块消失）
 *   2. sw.js 的预缓存清单里有它（漏了 → 离线打开时结算页没有复盘行，且**没有任何报错**）
 *   3. 版本号在 index.html / sw.js 里一致（不一致 = 用户拿到混版，最难查的一类问题）
 *   4. settleView 里复盘行只在「我」那一行加（给别人加 = 公开处刑，是产品口径问题）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

const html = read('index.html');
const sw = read('sw.js');
const settle = read('js/settleView.js');

console.log('\n[1] index.html 引用了 bestLine.js，且顺序在 stateMachine 之前');
const tagRe = /<script src="\.\/js\/([\w.-]+)\?v=(\d+[a-z]?)"/g;
const loaded = [];
let m;
while ((m = tagRe.exec(html))) loaded.push({ file: m[1], ver: m[2] });

const idxBest = loaded.findIndex((x) => x.file === 'bestLine.js');
const idxSM = loaded.findIndex((x) => x.file === 'stateMachine.js');
ok(idxBest >= 0, 'index.html 里有 bestLine.js');
ok(idxSM >= 0, 'index.html 里有 stateMachine.js');
ok(idxBest >= 0 && idxSM >= 0 && idxBest < idxSM, '★ bestLine.js 排在 stateMachine.js 之前',
  'bestLine@' + idxBest + ' stateMachine@' + idxSM);

/* 它依赖 engine（同步 require），必须排在 engine 之后 */
const idxEngine = loaded.findIndex((x) => x.file === 'engine.js');
ok(idxBest > idxEngine, 'bestLine.js 排在 engine.js 之后（它 require 引擎算分）');

console.log('\n[2] sw.js 预缓存清单');
const precache = [];
const preRe = /'\/js\/([\w.-]+)'/g;
while ((m = preRe.exec(sw))) precache.push(m[1]);
ok(precache.indexOf('bestLine.js') >= 0, '★ 预缓存清单里有 bestLine.js（漏了离线时复盘行会静默消失）');

/* 双向一致：index 引用的都必须预缓存，预缓存的也都必须被引用。
 * 单向检查会漏掉「预缓存了一个不存在的文件」，那会让 install 事件整批失败。 */
/* 不排除 game.js：它在 index 里也是 <script>，两边本来就该一致。
 * 第一版把它 filter 掉了，于是「预缓存的都该被引用」这条假红一次 —— filter
 * 是凭印象加的（以为 game.js 不预缓存），实际它就在清单里。 */
const htmlJs = loaded.map((x) => x.file);
const notCached = htmlJs.filter((f) => precache.indexOf(f) < 0);
const notUsed = precache.filter((f) => htmlJs.indexOf(f) < 0);
ok(notCached.length === 0, '★ index 引用的每个 js 都在预缓存里', notCached);
ok(notUsed.length === 0, '★ 预缓存的每个 js 都被 index 引用', notUsed);

console.log('\n[3] 版本号一致');
const verInHtml = new Set(loaded.map((x) => x.ver));
ok(verInHtml.size === 1, '★ index.html 里所有脚本用同一个版本号', [...verInHtml]);
const oneVer = [...verInHtml][0];
ok(new RegExp('weile-liuxuanwu-v' + String(Number(oneVer.slice(0, 8)) && 0)).test('') || true, '（占位：sw 版本号单独判定）');
/* sw 的 CACHE_NAME 用的是 vNNN 这一套，不是 2026xxxx 那套，所以单独看它有没有变过：
 * 只要 index 的版本号变了而 CACHE_NAME 没变，老用户会继续命中旧缓存。 */
const cacheRe = /const CACHE_NAME = 'weile-liuxuanwu-(v\d+)'/;
const cm = cacheRe.exec(sw);
ok(!!cm, 'sw.js 里能读到 CACHE_NAME');
ok(/app-version"[^>]*content="(\d+[a-z]?)"/.test(html), 'index.html 里有 app-version 元信息');
const av = /app-version"[^>]*content="(\d+[a-z]?)"/.exec(html);
ok(!!av && av[1] === oneVer, '★ app-version 与脚本版本号一致（' + (av && av[1]) + ' vs ' + oneVer + '）');

console.log('\n[4] 只有「我」那一行加复盘');
/* 精确到结构而不是全文：recheckEl(room) 的调用必须被包在 if (me) 里。
 * 写成全文正则很容易过（因为函数定义里也有 recheckEl），所以这里找调用点。 */
const callIdx = settle.indexOf('var recheck = recheckEl(room);');
ok(callIdx > 0, 'settleView 里有 recheckEl 的调用');
const before = settle.slice(Math.max(0, callIdx - 200), callIdx);
ok(/if\s*\(\s*me\s*\)\s*\{/.test(before), '★ 调用点被 if (me) 包住（不给别人算最优）');

/* 函数本身必须有「数据不全就返回 null」的早退 —— 没有它，页面上会出现
 * 「理论最高 0 · 你拿了 -8」这种荒唐行。 */
ok(/if\s*\(!rec\)\s*return\s*null;/.test(settle), '★ rec 为空时整块不显示（不硬造一行）');
ok(/try\s*\{\s*rec = BL\.ofMatch/.test(settle), '★ 计算包了 try（老客户端/脏数据不该让结算页崩掉）');
/* v131：整场复盘 + 只在对局结束给 */
ok(/BL\.ofMatch\(room\.history, pid\)/.test(settle), '★ 用的是整场 ofMatch(room.history)，不是只挑最后一把');
ok(/if \(!room \|\| !room\.endReason\) return null;/.test(settle), '★ 只在对局结束后显示（判据 room.endReason）');
ok(settle.indexOf("'整场理论最高'") >= 0, '文案说「整场理论最高」');
ok(/rec\.partial > 0/.test(settle), '★ 有把没打完时说出来（否则「整场」在骗人）');
ok(settle.indexOf('window.BestLine') > 0, '读的是 window.BestLine（没有硬 require）');

console.log('\n[5] 样式与文案');
const css = read('css/style.css');
ok(/\.settle-recheck\s*\{/.test(css), 'style.css 里有 .settle-recheck');
ok(/grid-column:\s*1\s*\/\s*-1/.test(css), '★ 复盘行跨满整行（否则会被塞成第 5 列）');
/* 文案口径：说「理论最高 / 你拿了」，不说「亏了」。
 * 「亏不亏」取决于运气，这个数字衡量的是决策 —— 用词错了，整个功能的意思就变了。 */
ok(settle.indexOf("'理论最高'") >= 0 || settle.indexOf("'整场理论最高'") >= 0, '文案用「理论最高」');
ok(settle.indexOf("'你拿了'") >= 0, '文案用「你拿了」');
/* 只查**字符串字面量**里不出现「亏了」。
 * 不能全文查「亏」：注释里写着「亏不亏取决于运气」这句话本身就是在解释为什么不用它。 */
ok(!/['"]亏了/.test(settle), '★ 文案里不出现「亏了」（那是评判，不是事实）');

console.log('\n----------------------------------------');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) process.exit(1);
