/**
 * 昵称「一行放不下就缩字号」的守卫（20261111e）
 *
 * ── 这一版解决什么 ──────────────────────────────────────────────
 * 上一版（20261111d）把 `short()` 从「按字符数」改成「按估算显示宽度」，
 * 修好了 8 半角英文名被截成「Playe…」的问题。但它仍有一个天花板：估算上限
 * 12 个等效半角 = 6 个中文，**7 个中文的名字照样截**。
 *
 * 而「放不放得下」本来就不该靠估算：圆桌昵称块 `--nmw` 在 80~132 之间
 * 随半径变，非圆桌那条走 flex 自适应 —— 同样 7 个字，一处富余一处溢出。
 * 所以改成渲染后实测 `scrollWidth` vs `clientWidth`，缩字号而不是截字。
 *
 * ── 这里守什么 ──────────────────────────────────────────────────
 * [1][2] 纯函数 `fitFont()` 的比例与边界 —— 放得下不动、溢出按比例缩
 * [3]    下限真的生效（不许把名字缩成看不见的一条）
 * [4]    异常入参不崩（还没布局时 clientWidth = 0，必须原样返回）
 * [5]    接线：座位名 / 对战条不再走 short()，且缩字号在 DOM 重建后执行
 * [6]    端到端算术：8 个中文在 120px 块里确实放得下（不靠 ellipsis 兜）
 *
 * ── 为什么不测真实像素 ──────────────────────────────────────────
 * Node 里没有布局引擎。真实像素由线上 CDP 实测（见 docs/release-progress.md），
 * 这里守的是「算得对」和「接得上」——两者都错的时候，线上跑一次会同时暴露，
 * 但拆开测能在提交前就红。
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
function near(a, b, name, eps) {
  ok(Math.abs(a - b) < (eps || 1e-6), name, 'expect ≈' + b + ', got ' + a);
}

const ROOT = path.join(__dirname, '..', '..');
const game = fs.readFileSync(path.join(ROOT, 'pwa', 'js', 'game.js'), 'utf8');
const utils = fs.readFileSync(path.join(ROOT, 'pwa', 'js', 'gameUtils.js'), 'utf8');

console.log('\n[1] 放得下就一个像素都不动');
/* 这一条比「会缩」更重要：绝大多数名字都是正常长度，缩字号是**例外路径**。
 * 如果实现里少了 `t <= a` 的短路，所有名字都会被缩 ~1%（浮点误差），
 * 屏幕上看不出但行高会抖，而且每次 resize 都抖一次。 */
eq(U.fitFont(20, 120, 120, 15), 20, '正好卡满不缩');
eq(U.fitFont(20, 132, 60, 15), 20, '富余一半不缩');
eq(U.fitFont(24, 120, 110, 15), 24, '横屏 24px 富余时不缩');

console.log('\n[2] 溢出按比例缩，缩到刚好放下');
/* 线性近似：字宽 ∝ 字号。8 个中文 20px → 160px 宽，块只有 120px，
 * 目标字号 = 20 × 120 / 160 = 15。 */
eq(U.fitFont(20, 120, 160, 14), 15, '8 中文挤进 120px 块 → 15px');
near(U.fitFont(20, 120, 140, 14), 20 * 120 / 140, '7 中文挤进 120px 块 → 17.14px');
near(U.fitFont(18, 96, 126, 13), 18 * 96 / 126, '对战条 7 中文挤进 96px → 13.7px');
/* 缩完之后的**估算宽度**必须回到块内 —— 这是「缩字号」这个词的全部意义 */
[160, 140, 200].forEach(function (tw) {
  var fs = U.fitFont(20, 120, tw, 10);
  ok(tw * fs / 20 <= 120 + 1e-6, '缩完宽度 ≤ 120（原宽 ' + tw + '）', tw * fs / 20);
});

console.log('\n[3] 下限真的生效');
/* 极端长名（20 个中文）在 80px 块里按比例算出来是 4px —— 那是墨点不是字。
 * 下限挡住它，剩下的交给 CSS 省略号：这是**物理极限**，不是懒得做。 */
eq(U.fitFont(20, 80, 400, 15), 15, '极限溢出停在下限 15px');
eq(U.fitFont(20, 80, 400, 15.24), 15.24, '小数下限原样保留（不取整丢精度）');
ok(U.fitFont(20, 80, 400, 15) > 0, '下限不是 0（0 = 名字彻底消失）');

console.log('\n[4] 异常入参不崩、不乱猜');
/* clientWidth 在「还没布局」时是 0（display:none、刚 innerHTML 完还没 reflow、
 * 老浏览器），这时必须原样返回 —— 猜一个值会把名字缩成随机大小。 */
eq(U.fitFont(0, 120, 160, 15), 0, '原字号 0 → 返回 0');
eq(U.fitFont(20, 0, 160, 15), 20, '块宽没量到 → 不动');
eq(U.fitFont(20, 120, 0, 15), 20, '文本宽没量到 → 不动');
eq(U.fitFont(20, 120, 160, 0), 15, '下限缺失但没到极限 → 仍按比例缩到 15');
eq(U.fitFont(20, 120, 800, 0), 10, '下限缺失且极度溢出 → 按半号保底 10');
eq(U.fitFont(20, 120, 160, 300), 15, '下限比原字号还大 → 忽略它，照常缩到 15');
eq(U.fitFont(20, 120, 800, 300), 10, '下限比原字号还大且极度溢出 → 按半号保底 10（不许放大）');
eq(U.fitFont('20', '120', '160', '14'), 15, '字符串入参也能算（style 读出来是字符串）');

console.log('\n[5] 接线：座位名不截字，缩字号在 DOM 重建之后跑');
/* 上一版的守卫在这里断言「座位名必须走 short()」—— 这一版语义反过来了：
 * 座位名要**原样**渲染，改由 fitLongNames 缩字号。谁要是把 short() 加回去，
 * 7 个中文又会变回省略号，必须在这里红。 */
const rawSeat = (game.match(/<span class="opp-name">' \+ esc\(p\.nickname\)/g) || []).length;
eq(rawSeat, 2, '座位名两条渲染路径都原样渲染（ringTopHtml + gt 座位条）');
ok(!/esc\(short\(p\.nickname\)\)/.test(game), '负向：座位名不许再走 short()');
ok(/vs-side vs-opp"><i>' \+ esc\(opp\.nickname \|\| '对手'\)/.test(game),
  '2 人局对战条原样渲染');
ok(!/esc\(short\(opp\.nickname\)/.test(game), '负向：对战条不许再走 short()');

ok(/function fitLongNames\(root\)/.test(game), '存在 fitLongNames()');
/* 顺序：必须先重建 DOM 再量。反过来量到的是旧节点的宽度 —— 人数变化时
 * （4 人→5 人，昵称块从 120 收到 88）会按旧宽度算出偏大的字号，
 * 于是新布局里溢出、ellipsis 出现，而代码看起来「明明缩过」。 */
const iInner = game.indexOf('top.innerHTML = html;');
const iFit = game.indexOf('fitLongNames(top);');
ok(iInner > 0 && iFit > iInner, 'finishTopBar：先 innerHTML 再 fitLongNames');
ok(/fitLongNames\(\$\('#game-top'\)\);/.test(game),
  'seatText 里也重算（转屏后 html 没变，只有 --seat-name 变）');
ok(/\.opp-name, \.gt-vs \.vs-side i/.test(game), '选择器覆盖座位名与对战条');

console.log('\n[6] 端到端算术：8 个中文在 120px 块里真的放得下');
/* 取线上真实会出现的档位：iPhone 竖屏 scale≈0.525，圆桌昵称块 120 设计px。 */
const SCALE = 0.525;
const FIT_MIN_CSS = 7.5;                       // 与 game.js 同值（下面有一条断言守着）
const baseFs = 20, avail = 120, floorFs = Math.max(FIT_MIN_CSS / SCALE, baseFs * 0.5);
const name8 = '示例玩家甲加长版六字';            // 10 个字，先算 8
const fs8 = U.fitFont(baseFs, avail, 8 * baseFs, Math.min(baseFs * 0.9, floorFs));
ok(8 * fs8 <= avail + 1e-6, '8 中文缩完放得下（字号 ' + fs8.toFixed(2) + '）');
ok(fs8 * SCALE >= FIT_MIN_CSS - 1e-6, '缩完物理字号 ≥ 7.5 CSS px', fs8 * SCALE);
/* 6 个中文是上一版就能显示的（SHORT_W=12 等效），这一版必须**一像素不动** */
eq(U.fitFont(baseFs, avail, 6 * baseFs, floorFs), 20, '6 中文不缩（20px 原样）');
/* 10 个中文在 5 人局的 80px 窄座位里：物理上放不下，允许省略号兜底 ——
 * 但**不许**缩到 7.5 CSS px 以下去硬塞（那样是「显示了一个读不出来的名字」）。 */
const fs10 = U.fitFont(baseFs, 80, 10 * baseFs, Math.min(baseFs * 0.9, floorFs));
ok(fs10 * SCALE >= FIT_MIN_CSS - 1e-6, '10 中文在 80px 块里不低于下限', fs10 * SCALE);
ok(10 * fs10 > 80, '而且确实放不下（说明该由 CSS 省略号收尾）', 10 * fs10);

console.log('\n[7] 常量与注释同步');
ok(/FIT_MIN_CSS = 7\.5;/.test(game), 'game.js 里下限是 7.5（测试里写死的也是这个值）');
ok(/fitFont = U\.fitFont;/.test(game), 'game.js 解构了 fitFont');
ok(/api\.fitFont = fitFont;/.test(utils), 'gameUtils 导出了 fitFont');
/* 取 7.5 而不是 8 的理由必须留在代码里 —— 这是「差 1px 就白缩一场」的坑，
 * 半年后有人「顺手调成整数 8」会让 8 字名重新溢出，且看不出原因。 */
ok(/卡在 8 会/.test(game), '注释里解释了为什么是 7.5 不是 8');

console.log('\n' + (fail === 0 ? '全部通过' : fail + ' 项失败') + ' —— ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail === 0 ? 0 : 1);
