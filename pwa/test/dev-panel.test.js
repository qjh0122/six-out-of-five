/**
 * 调试侧栏 `?dev=1`（纯静态解析，不开浏览器）
 * 跑法：node pwa/test/dev-panel.test.js
 *
 * 这一项与倒计时同源（docs/circle-table-rollout-status.md §3.3 原型演示专用那一栏）：
 * 原型侧栏有六件事（三端切换 / 场景 A·B / 播放整局 / 特效演示 / 头像大小档 /
 * `__proto` 钩子），**正式版只保留前一半里对排障有用的部分**：看档位 + 翻开关。
 *
 * 所以这个文件守的同样是边界，而不是功能：
 *   1. 默认必须是关的，而且不带参数时**连 DOM 都不建** ——
 *      「正式包里有没有调试入口」不该靠读代码确认（探针 probe-dev-panel 从另一头验）；
 *   2. 不许有造局入口：场景 A·B / 播放整局 / `window.__proto` 一个都不能有。
 *      它们一旦上线，就等于在正式包里留了「跳过服务端造一局」的路径；
 *   3. 开关按钮只改 URL、只刷新，不许直接改内存状态 ——
 *      否则「面板上点开、真机行为却不同」这类幽灵问题会多出一整个来源。
 */
'use strict';

const { readAll: readGameAll } = require('./helpers/gameSource');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const gameJs = readGameAll();
const css = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');
const cfgJs = fs.readFileSync(path.join(ROOT, 'js', 'config.js'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function fnBody(name) {
  const start = gameJs.indexOf('function ' + name + '(');
  if (start < 0) return '';
  const end = gameJs.indexOf('\n  }', start);
  return end < 0 ? '' : gameJs.slice(start, end);
}
/* 剥注释再找「有没有这段代码」：注释里提到红线是好事（说明写清楚了）。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}
const CODE = stripComments(gameJs);

console.log('\n[1] 默认关，且关得干净');
ok(/DEV_PANEL: false/.test(cfgJs), '★ CONFIG.DEV_PANEL 默认 false（有人改成 true 就等于线上常驻调试层）');
const flag = fnBody('devPanelFlag');
ok(!!flag, '有 devPanelFlag()（与其它开关同一套说法）');
ok(/=== '0'\) return false/.test(flag), "认 ?dev=0 → 关");
ok(/=== '1'\) return true/.test(flag), "认 ?dev=1 → 开");
ok(/return CONFIG\.DEV_PANEL/.test(flag), '兜底回到 CONFIG（否则开关变成永久失效）');
ok(!/dev-panel/.test(html), '★ index.html 里没有 .dev-panel 节点（纯 JS 创建 —— 不带参数时不存在）');

console.log('\n[2] 不带参数连 DOM 都不建');
const upd = fnBody('updateDev');
ok(!!upd, '有 updateDev()');
ok(/if \(!devPanelFlag\(\)\) return;/.test(upd), '★ 第一行就是「开关没开直接返回」');
const firstCreate = CODE.indexOf("el('div', 'dev-panel')");
ok(firstCreate > 0, '面板由 el() 现建');
ok(CODE.indexOf('if (!devPanelFlag()) return;') < firstCreate,
  '★ 「开关没开就返回」在创建之前（顺序反了就等于无条件创建）');

console.log('\n[3] 不许有造局入口（原型侧栏那三件）');
ok(!/__proto/.test(CODE), '★ 没有 window.__proto 钩子');
ok(!/playFullHand|playWholeHand|playDemo|autoPlay/i.test(CODE), '★ 没有「播放整局」入口');
ok(!/scene\s*=\s*'?[AB]'?|scenarioA|场景 A/i.test(CODE), '★ 没有场景 A·B 假数据入口');
ok(!/mockRoom|fakeRoom|seedRoom/.test(CODE), '没有伪造房间/牌局的后门');

console.log('\n[4] 开关按钮只改 URL、只刷新');
ok(/u\.searchParams\.set\(key, on \? '1' : '0'\)/.test(upd), '按钮把开关写进 URL 参数');
ok(/location\.href = u\.toString\(\)/.test(upd), '★ 然后整页跳转（不直接改内存状态，见开头第 3 条）');
ok(!/CONFIG\.[A-Z_]+ = /.test(upd), '★ 面板里没有直接改 CONFIG 的赋值');
['seatring', 'startcountdown', 'emoji'].forEach((k) => {
  ok(upd.indexOf("'" + k + "'") >= 0, '面板能翻 ' + k);
});

console.log('\n[5] 读数四行都在，且都是「这一页实际的值」');
['版式', '舞台', '组槽', '牌面'].forEach((k) => {
  ok(upd.indexOf("'" + k + "'") >= 0, '有「' + k + '」这一行');
});
ok(/devRingMode\(\)/.test(upd), '版式行读的是真实档位（不写死字符串）');
ok(/function devRingMode\(\)[\s\S]{0,320}?ringDesktop\(\) \? 'desktop' : 'landscape'/.test(gameJs),
  '★ 档位名与 seatRing.js 的 MODES 对齐（面板写错名字比不写更坏）');
ok(/lastStageScale/.test(upd) && /slotDense/.test(upd), '舞台与组槽读的是运行时变量');
ok(/getBoundingClientRect\(\)[\s\S]{0,80}?lastStageScale/.test(fnBody('devCardBox') || ''),
  '★ 牌面除回 scale（否则报的是缩放后的 CSS px，与 §11 的 110×154 不是同一把尺子）');

console.log('\n[6] 不吃点击、只在 ?dev=1 时出现');
ok(/\.dev-panel \{[\s\S]{0,400}?pointer-events: none/.test(css), '★ 容器 pointer-events: none（不挡牌桌）');
ok(/\.dev-panel-btn \{[\s\S]{0,200}?pointer-events: auto/.test(css), '★ 按钮自己 auto（不然点不到）');
ok(/\.dev-panel\.hidden \{ display: none; \}/.test(css), '有收起态');
ok(/max-height: 40vh/.test(css), '★ 横屏也不占满屏（≤40vh）');
ok(/\.dev-panel \{[\s\S]{0,120}?position: fixed/.test(css),
  'fixed 定位（不跟着舞台 scale 缩成 6px 字，与 .diag-panel 同一条理由）');

console.log('\n[7] 与 ?diag=1 不重复');
ok(/function updateDiag/.test(gameJs) && /function updateDev/.test(gameJs), '两块各管一摊：diag 是视口读数，dev 是版式档位');
ok(!/diag-panel/.test(upd), '★ updateDev 里不碰 diag 那块（两个参数可以同时开，互不覆盖）');

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
