/**
 * 牌型特写幕（v98）—— 原型 .fx 层的移植契约
 * 跑法：node test/pattern-fx.test.js
 *
 * 这个文件的存在理由，就是防止 v83~v97 那次翻车再发生一次：
 * 那五个版本里，游戏其实**只落了原型特写的组内版**
 * （结算卡里一条 20px 的胶囊 + 12 颗飞 74px 的粒子 + 一圈描边），
 * 而原型是一整幕 —— 920 的旋转金环、三道冲击波、14 颗粒子飞 170~305、
 * 赢家的牌 104/94/84 宽砸下来、108px 大字从 2.3 倍缩进来、豹子/五花牛震桌。
 *
 * 当时所有测试都是绿的，因为断言问的是「bannerIn / fxBurst / fxHalo 有没有跑」，
 * 那是**我自己写的那套小动画**的名字，不是设计的名字。
 * 所以这里改成拿原型当基准：原型里每一个关键帧、每一个尺寸，
 * 线上的 `.pat-*` 必须有一份对得上号的实现。原型删了什么这里才敢删什么。
 *
 * 四节：
 *   [1] 原型基准（从 docs/prototypes/circle-table.html 现读，不抄常量）
 *   [2] 线上实现在不在（DOM 壳 / 关键帧 / 尺寸 / 数量）
 *   [3] 触发条件与时序（只给赢家、特写先于结算卡、可跳过、可关）
 *   [4] 反例（不震屏的两种、不重算牌型、10.5 的显示名）
 */
'use strict';

const { readAll: readGameAll } = require('./helpers/gameSource');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const game = readGameAll();
const css = read('css/style.css');
const html = read('index.html');
const cfg = read('js/config.js');
const proto = fs.readFileSync(
  path.join(ROOT, '..', 'docs', 'prototypes', 'circle-table.html'), 'utf8');
const Engine = require(path.join(ROOT, 'js', 'engine.js'));

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function head(t) { console.log('\n' + t); }

/* 去掉注释再找：注释里写「原型用的是 cardDrop」是对的（说明有出处），
 * 不该被当成「线上也有 cardDrop」的证据。 */
const CSS = css.replace(/\/\*[\s\S]*?\*\//g, '');
const GAME = game.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
  .map((l) => l.replace(/\/\/.*$/, '')).join('\n');

/* 取一条 @keyframes 的完整块（含 at-rule 行） */
function keyframes(src, name) {
  const i = src.indexOf('@keyframes ' + name);
  if (i < 0) return '';
  const j = src.indexOf('{', i);
  let depth = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
  return '';
}
/* 取一条普通规则（第一个匹配的选择器块） */
function rule(src, sel) {
  const i = src.indexOf(sel);
  if (i < 0) return '';
  const j = src.indexOf('{', i);
  const k = src.indexOf('}', j);
  return src.slice(i, k + 1);
}
const decl = (block, prop) => {
  const m = block.match(new RegExp('(?:^|[;{\\s])' + prop.replace(/[-]/g, '\\-') + '\\s*:\\s*([^;}]+)'));
  return m ? m[1].trim() : '';
};

/* =================================================================== */
head('[1] 原型基准：特写层由哪些东西组成（直接从原型读，不抄常量）');

ok(/\.fx\{position:absolute/.test(proto), '原型里有 .fx 特写层');
ok(/\.fx \.halo\{/.test(proto), '原型里有 .halo 旋转光环');
ok(/@keyframes spin\{to\{transform:rotate\(360deg\)\}\}/.test(proto), '原型光环用 spin 转圈');
ok(/@keyframes cardDrop\{from\{opacity:0;transform:translateY\(-110px\)/.test(proto),
  '原型用 cardDrop：牌从 -110px 落下来');
ok(/@keyframes lblIn\{from\{opacity:0;transform:scale\(2\.3\) rotate\(-7deg\)/.test(proto),
  '原型用 lblIn：大字从 2.3 倍砸进来');
ok(/@keyframes wave\{from\{opacity:\.9;transform:scale\(\.22\)\}/.test(proto),
  '原型用 wave：冲击波 0.22 → 5.2');
ok(/@keyframes burst\{\n  0%\{opacity:0;transform:rotate\(var\(--a\)\) translate\(0,0\) scale\(\.3\)\}/
  .test(proto), '原型用 burst：粒子沿 --a 射线飞出');
ok(/@keyframes fshk\{/.test(proto), '原型用 fshk 震桌');
ok(/width:920px;height:920px/.test(proto), '原型光环 920×920');
ok(/font-size:108px;font-weight:900;letter-spacing:10px/.test(proto), '原型大字 108px / 900 / 10px 字距');
ok(/for \(var i = 0; i < 14; i\+\+\)/.test(proto), '原型 14 颗粒子');
ok(/\[0, 0\.14, 0\.28\]\.forEach/.test(proto), '原型三道冲击波错峰 0/0.14/0.28');
ok(/var big = n >= 5 \? 84 : \(n === 3 \? 94 : 104\)/.test(proto), '原型牌宽 84 / 94 / 104');
ok(/\.fx\.bz \.lbl\{color:#FFC0AC/.test(proto), '原型豹子是红金（大字 #FFC0AC）');
ok(/\.fx\.wh \.lbl\{color:#F3D7FF/.test(proto), '原型五花牛是紫金（大字 #F3D7FF）');

/* =================================================================== */
head('[2] 线上实现：DOM 壳 + 关键帧 + 尺寸 + 数量');

ok(/<div id="pattern-fx" class="pat-fx hidden"/.test(html), 'index.html 有 #pattern-fx 壳');
ok(html.indexOf('id="pattern-fx"') < html.indexOf('id="result-modal"'),
  '#pattern-fx 在 #result-modal 之前（后出现的兄弟节点才压得住它）');
/* 它在 #stage 里、而且是 .modal 的兄弟：跟着 750 设计稿一起缩放 */
ok(/<div id="pattern-fx"[^>]*><\/div>/.test(html), '壳是空容器（内容由 JS 现拼，不留死 DOM）');

ok(!!keyframes(CSS, 'patSpin'), '线上有 patSpin（对应原型 spin）');
ok(/to \{ transform: rotate\(360deg\); \}/.test(keyframes(CSS, 'patSpin')), 'patSpin 转满 360 度');
ok(!!keyframes(CSS, 'patCardDrop'), '线上有 patCardDrop（对应原型 cardDrop）');
ok(/translateY\(-110px\) rotate\(-7deg\) scale\(1\.24\)/.test(keyframes(CSS, 'patCardDrop')),
  'patCardDrop 起点与原型逐字一致（-110px / -7deg / 1.24）');
ok(!!keyframes(CSS, 'patLblIn'), '线上有 patLblIn（对应原型 lblIn）');
ok(/scale\(2\.3\) rotate\(-7deg\)/.test(keyframes(CSS, 'patLblIn')),
  'patLblIn 起点与原型一致（2.3 倍 / -7deg）');
ok(!!keyframes(CSS, 'patWave'), '线上有 patWave（对应原型 wave）');
ok(/scale\(0\.22\)/.test(keyframes(CSS, 'patWave')) && /scale\(5\.2\)/.test(keyframes(CSS, 'patWave')),
  'patWave 0.22 → 5.2，与原型同一段行程');
ok(!!keyframes(CSS, 'patBurst'), '线上有 patBurst（对应原型 burst）');
ok(/rotate\(var\(--a\)\) translate\(0, calc\(-1 \* var\(--r\)\)\)/.test(keyframes(CSS, 'patBurst')),
  'patBurst 沿 --a 射线按 --r 飞出去（不是绕圈）');
ok(!!keyframes(CSS, 'patShake'), '线上有 patShake（对应原型 fshk）');
ok(/-7px, 4px/.test(keyframes(CSS, 'patShake')) && /6px, -5px/.test(keyframes(CSS, 'patShake')),
  'patShake 的位移与原型同幅（7/6/4/3）');

const halo = rule(CSS, '.pat-halo {');
ok(decl(halo, 'width') === '920px' && decl(halo, 'height') === '920px',
  '线上光环也是 920×920', decl(halo, 'width'));
ok(/conic-gradient/.test(halo), '线上光环是 conic-gradient（不是位图，跟着缩放不会糊）');
ok(/-webkit-mask: radial-gradient/.test(halo) && /[^-]mask: radial-gradient/.test(halo),
  '两层蒙版都写了（-webkit- 与标准）—— 只写一层的话 iOS 上就是一个实心饼');
ok(/animation: patSpin 7s linear infinite/.test(halo), '光环 7 秒一圈、无限转', decl(halo, 'animation'));

const lbl = rule(CSS, '.pat-lbl {');
ok(decl(lbl, 'font-size') === '108px', '线上大字 108 设计 px', decl(lbl, 'font-size'));
ok(decl(lbl, 'font-weight') === '900' && decl(lbl, 'letter-spacing') === '10px',
  '字重 900 + 10px 字距（与原型一致）');
ok(/-webkit-text-stroke: 3px/.test(lbl), '3px 描边 —— 深色毡面上光靠 text-shadow 会糊成一团');

const wave = rule(CSS, '.pat-wave {');
ok(decl(wave, 'width') === '160px' && decl(wave, 'height') === '160px', '冲击波底 160×160');
ok(/animation: patWave 0\.95s ease-out both/.test(wave), '冲击波 0.95s（与原型同长）');

const pt = rule(CSS, '.pat-pt {');
ok(decl(pt, 'width') === '12px', '粒子 12px（原型同尺寸）');
ok(/background: var\(--pc/.test(pt), '粒子颜色读 --pc（同一幕里两色交错，CSS 一条规则表达不了）');
ok(/animation: patBurst 1\.05s ease-out both/.test(pt), '粒子 1.05s（与原型同长）');

/* JS 里造出来的数量与尺寸 */
ok(/for \(var i = 0; i < 14; i\+\+\)/.test(GAME), '线上 JS 造 14 颗粒子（不是 12）');
ok(/\[0, 0\.14, 0\.28\]\.forEach/.test(GAME), '线上 JS 造 3 道冲击波，错峰 0/0.14/0.28');
ok(/var cw = n >= 5 \? 84 : \(n === 3 \? 94 : 104\)/.test(GAME),
  '牌宽 84 / 94 / 104（与原型同一套）');
ok(/cardImgHtml\(c, cw, ch, 'pat-card'\)/.test(GAME),
  '牌用全站同一套 cardImgHtml 重画（不是另画一份牌面）');
ok(/Math\.round\(cw \* 202 \/ 144\)/.test(GAME), '高宽比 202/144，与全站牌面比例一致');

/* =================================================================== */
head('[3] 触发条件与时序');

ok(/BIG_FX\[g\.winnerTypeName\]/.test(GAME), '特写只看**赢家**的牌型（g.winnerTypeName）');
ok(GAME.indexOf("pat.step !== i") >= 0, '同一幕只放一次（否则「跳过」和「播完」会各放一遍）');

const step = GAME.slice(GAME.indexOf('function renderResultStep'), GAME.indexOf('function advanceResult'));
ok(step.indexOf('playPatternFx(') > 0, 'renderResultStep 里放特写幕');
ok(/var heroNow = !!\(big && pat\.step !== i && patternFxFlag\(\)\)/.test(step),
  '三条闸门合一：大牌型 + 这一幕还没放过 + 开关打开');
ok(/var total = hold \+ \(heroNow \? PAT_FX_MS : 0\)/.test(step),
  '有特写这一幕停留 = 节奏 + 特写时长（否则 3 秒里 1.6 秒被盖着，读不完分数）');
ok(/modal\.dataset\.hold = String\(total\)/.test(step), 'data-hold 报的是真实停留（探针才不会误判卡住）');
ok(/modal\.style\.setProperty\('--hold', total \+ 'ms'\)/.test(step),
  '进度条与定时器同一个数（不会「文案说 3 秒、条子跑 4.6 秒」）');
ok(step.indexOf("hideModalEl('result-modal')") === -1,
  '特写不去关结算弹窗 —— 关了再开会闪，而且探针会看到「反复开关」');
ok(/if \(pat\.timer && pat\.step !== i\) stopPatternFx\(\);/.test(step),
  '上一幕的还没播完就点了「下一组」时先收幕（否则光环盖在新一幕的账上）');
ok(/#result-modal\.is-hero \.modal-card \{ opacity: 0; \}/.test(CSS),
  '特写期间结算卡是 opacity:0（不是 display:none —— 位置和点击区域要留着）');
/* v135：时长收进 --dur-* 之后，这条断言不能再看字面量 0.22s（那是旧的实现细节），
 * 要看的是**语义**：结算卡淡入与幕布淡出必须是同一档，否则交叉过渡会有一帧空档。 */
ok(/#result-modal \.modal-card \{ transition: opacity var\(--dur-\d\)/.test(CSS)
  && /\.pat-fx\.is-out \{ animation: patFadeOut var\(--dur-\d\)/.test(CSS),
  '卡回来与幕布淡出用同一个时长令牌（交叉过渡，不许一边 200ms 一边 320ms）');
{
  const a = /#result-modal \.modal-card \{ transition: opacity var\((--dur-\d)\)/.exec(CSS);
  const b = /\.pat-fx\.is-out \{ animation: patFadeOut var\((--dur-\d)\)/.exec(CSS);
  ok(a && b && a[1] === b[1], '两个令牌是同一档（' + (a ? a[1] : '?') + ' vs ' + (b ? b[1] : '?') + '）');
}
ok(/if \(m\) m\.classList\.add\('is-hero'\)/.test(GAME) && /if \(m\) m\.classList\.remove\('is-hero'\)/.test(GAME),
  'is-hero 有加有撤（漏掉一处就是一张永远空着的弹窗）');

ok(/if \(q === '0'\) return false;/.test(GAME) && /if \(q === '1'\) return true;/.test(GAME),
  '?patternfx=0/1 能覆盖（与其它功能开关同一套说法）');
ok(/prefers-reduced-motion: reduce/.test(GAME), '系统「减少动态效果」时不放这一幕');
ok(/sp\.get\('patternfx'\) \|\| sp\.get\('fx'\)/.test(GAME), '?fx=0 是同一个开关的短写法');
ok(/PATTERN_FX: true/.test(cfg), 'CONFIG.PATTERN_FX 默认开（这是游戏本体，不是排障工具）');
ok(/@media \(prefers-reduced-motion: reduce\)/.test(CSS) &&
  /\.pat-halo \{ animation: none; \}/.test(CSS),
  'CSS 也有一道兜底：JS 被绕过时 / 至少不会动画，而不是永远转');
ok(/return 220/.test(GAME) || /\}, 220\)/.test(GAME), '淡出 220ms 后才回调（不硬切）');
ok(/patBox\.addEventListener\('click'/.test(GAME), '点一下能跳过（一局要放 3~5 次，必须有出口）');

/* =================================================================== */
head('[4] 反例与边界');

ok(/kind === 'bz' \|\| kind === 'wh'/.test(GAME), '震屏只给豹子 / 五花牛（原型也只有这两个 kind 挂 .felt.shake）');
ok(/classList\.toggle\('is-shake', kind === 'bz' \|\| kind === 'wh'\)/.test(GAME),
  '不震屏的两种（牛牛 / 10.5）不会被 toggle 打开');
ok(GAME.indexOf('specialOf') === -1, '没有另起一套牌型判定（那是第二份规则实现）');
ok(/Engine\.douNiuPoint/.test(GAME), '凑十高亮用的是引擎的点数函数，不是手抄一张点数表');
ok(/kind === 'nn' \? patTrio\(cards\) : \(kind === 'wh' \? \[0, 1, 2, 3, 4\] : \[\]\)/.test(GAME),
  '牛牛圈「凑十的三张」、五花牛圈全部五张、其余不圈（与原型一致）');
ok(/<span class="pat-mkb">10<\/span>/.test(GAME), '牛牛的金圈上挂「10」徽标');
ok(/patLabel\(typeName\)/.test(GAME) && /typeName === '10\.5点' \? '10\.5'/.test(GAME),
  '10.5 幕上写「10.5」不写「10.5点」（与原型 label 一致；只改显示，不改查表名）');

/* 真引擎复核：这四种牌型确实会命中 BIG_FX，牛 9 不会 */
const BIG = (() => {
  const m = GAME.match(/var BIG_FX = \{([\s\S]*?)\n\s*\};/);
  return m ? new Function('return {' + m[1] + '\n}')() : {};
})();
const c = (s, r) => ({ suit: s, rank: r });
[
  ['tenhalf', [c('spade', 10), c('heart', 13)], '10.5点'],
  ['piaosanye', [c('spade', 8), c('heart', 8), c('club', 8)], '豹子'],
  ['douniu', [c('spade', 10), c('heart', 6), c('club', 4), c('diamond', 8), c('spade', 2)], '牛牛'],
  ['douniu', [c('club', 11), c('club', 12), c('club', 13), c('heart', 11), c('heart', 12)], '五花牛']
].forEach(([mode, hand, want]) => {
  const name = Engine.typeName(mode, hand);
  ok(name === want, '引擎确认样例是「' + want + '」', name);
  ok(!!BIG[name], '★「' + want + '」在 BIG_FX 里（否则这一幕根本不会触发）');
});
const niu9 = [c('spade', 10), c('heart', 6), c('club', 3), c('diamond', 8), c('spade', 2)];
ok(Engine.typeName('douniu', niu9) !== '牛牛', '牛 9 不会被当成牛牛');

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项\n');
process.exit(fail ? 1 : 0);
