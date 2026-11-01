/**
 * 组槽实时牌型（v92，纯静态解析 + 真引擎求值，不开浏览器）
 * 跑法：node pwa/test/slot-type.test.js
 *
 * 这一项补的是**组牌阶段的反馈黑洞**：玩家把五张牌放进斗牛组之后，
 * 到结算弹窗之前，界面上一个字都没有 —— 想知道自己是牛几只能自己凑十。
 * 十点半组早就有实时点数（`.slot-point`），另外两组一直是空的。
 *
 * 这个文件守四件事：
 *   1. 牌型名只能来自 Engine —— 前端一旦自己复算，牛 9 变牛牛那种事就会重演
 *      （原型用 `r.t === 9` 裸数字，随机 800 组里 18.5% 判错）；
 *   2. 只在**放满**时报 —— 飘三叶放 1 张必然是散牌，报出来是噪音；
 *   3. 满组时**顶掉** n/n 进度，不是并排加 —— 窄横屏两列档是 nowrap，并排会顶出格子；
 *   4. `is-new` 只在牌型真的变了那一帧出现，且 `slotTypeSeen` 只在 innerHTML
 *      真的被重写之后才提交 —— 否则「内容没变 → 跳过重写」那一帧会吃掉状态，
 *      成手脉冲永远不放。
 */
'use strict';

const { readAll: readGameAll } = require('./helpers/gameSource');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const gameJs = readGameAll();
const css = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const Engine = require(path.join(ROOT, 'js', 'engine.js'));
const SM = require(path.join(ROOT, 'js', 'stateMachine.js'));

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function head(t) { console.log('\n' + t); }
function c(suit, rank) { return { suit: suit, rank: rank }; }
/* 取一个具名函数的完整源码。
 *
 * ★ 用**花括号配平**而不是「找下一个两空格缩进的 }」：
 *   后者把「函数写在几层缩进里」当成了函数的一部分。v108 把 slotTypeOf 搬进
 *   js/cardView.js 的工厂函数之后，它变成 4 空格缩进，旧写法会一路截到
 *   下一个恰好两格缩进的 `}` 上 —— 截出来的东西根本不是函数，
 *   然后 `new Function` 抛 SyntaxError，看起来像测试自己的 bug。
 *   配平不依赖缩进，搬去哪儿都对。 */
function fnSrc(name) {
  const key = 'function ' + name + '(';
  const start = gameJs.indexOf(key);
  if (start < 0) return '';
  const open = gameJs.indexOf('{', start);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < gameJs.length; i++) {
    const ch = gameJs[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return gameJs.slice(start, i + 1);
    }
  }
  return '';
}

/* 把 slotTypeOf 从源码里取出来，注入真 StateMachine / Engine 求值。
 * 用真引擎而不是手写一份对照表：一旦 engine 改了牌型名或王万能口径，
 * 这里会跟着变；写死一份对照就等于允许两份规则同时存在。 */
const slotTypeOfSrc = fnSrc('slotTypeOf');
const slotTypeOf = slotTypeOfSrc
  ? new Function('StateMachine', 'Engine', slotTypeOfSrc + '\n  return slotTypeOf;')(SM, Engine)
  : null;

/* ---------------- 1. 只在放满时报 ---------------- */
head('[1] 只在放满时报牌型');
{
  ok(!!slotTypeOf, '能从 game.js 里取出 slotTypeOf');
  ok(slotTypeOf('piaosanye', []) === '', '飘三叶 0 张不报');
  ok(slotTypeOf('piaosanye', [c('spade', 8), c('heart', 8)]) === '', '飘三叶 2 张不报');
  ok(slotTypeOf('douniu', [c('spade', 10), c('heart', 6), c('club', 4)]) === '', '斗牛 3 张不报');
  ok(slotTypeOf('douniu', []) === '', '斗牛 0 张不报');
}

/* ---------------- 2. 放满了，名字必须来自 Engine ---------------- */
head('[2] 放满了，名字来自 Engine（不是前端复算）');
{
  const psy = [c('spade', 8), c('heart', 8), c('club', 8)];
  ok(slotTypeOf('piaosanye', psy) === Engine.typeName('piaosanye', psy),
    '飘三叶 3 张 == Engine.typeName');
  ok(slotTypeOf('piaosanye', psy) === '豹子', '豹子判对（' + slotTypeOf('piaosanye', psy) + '）');

  const sf = [c('heart', 5), c('heart', 6), c('heart', 7)];
  ok(slotTypeOf('piaosanye', sf) === '同花顺', '同花顺判对（' + slotTypeOf('piaosanye', sf) + '）');

  const hi = [c('spade', 13), c('heart', 5), c('club', 2)];
  ok(slotTypeOf('piaosanye', hi) === '散牌', '散牌也照实报（不是不报）');

  const nn = [c('spade', 10), c('heart', 6), c('club', 4), c('diamond', 8), c('spade', 2)];
  ok(slotTypeOf('douniu', nn) === '牛牛', '牛牛判对（' + slotTypeOf('douniu', nn) + '）');

  const n9 = [c('spade', 10), c('heart', 6), c('club', 3), c('diamond', 8), c('spade', 2)];
  const n9name = slotTypeOf('douniu', n9);
  ok(/^牛[0-9]$/.test(n9name), '牛几判对（' + n9name + '）');
  ok(n9name !== '牛牛', '★ 牛 9 不会被当成牛牛（原型踩过的坑）');

  const wh = [c('club', 11), c('club', 12), c('club', 13), c('heart', 11), c('heart', 12)];
  ok(slotTypeOf('douniu', wh) === '五花牛', '五花牛判对（' + slotTypeOf('douniu', wh) + '）');

  const none = [c('spade', 2), c('heart', 5), c('club', 9), c('diamond', 13), c('spade', 12)];
  ok(slotTypeOf('douniu', none) === '没牛', '没牛也照实报（' + slotTypeOf('douniu', none) + '）');
}

/* ---------------- 3. 大王万能：口径必须和结算一致 ---------------- */
head('[3] 大王万能：组槽与结算同一口径');
{
  /* 9♠ 9♦ 2♣ + 大王 + 3♣：9+9+2=20 已成一十，大王当 7 配 3♣ → 牛牛。
   * 以前一律让王去凑十，剩 99 得牛 8 —— 玩家的牛牛被算没了（engine 注释里的真实截图）。 */
  const hand = [c('spade', 9), c('diamond', 9), c('club', 2), c('joker', 15), c('club', 3)];
  const got = slotTypeOf('douniu', hand);
  ok(got === Engine.typeName('douniu', hand), '组槽名 == 结算名（' + got + '）');
  ok(got === '牛牛', '王万能的牛牛在组槽上也显示牛牛（' + got + '）');

  /* 飘三叶的王：J♠ Q♠ + 王 按同花顺解析（王当 ♠ 的 4 或 K 之外最优）。
   * 只断言「两边一致」，不断言具体牌型 —— 解析择优的细节归 engine 管。 */
  const w = [c('spade', 11), c('spade', 12), c('joker', 15)];
  ok(slotTypeOf('piaosanye', w) === Engine.typeName('piaosanye', w),
    '飘三叶带王时组槽名 == 结算名（' + slotTypeOf('piaosanye', w) + '）');
}

/* ---------------- 4. 十点半与单张不掺合 ---------------- */
head('[4] 十点半 / 单张不重复报');
{
  ok(slotTypeOf('tenhalf', [c('spade', 10), c('heart', 13)]) === '',
    '★ 十点半 2 张不报牌型（它已经有 slot-point 实时点数 + 爆点提示）');
  ok(slotTypeOf('single', [c('joker', 15)]) === '',
    '★ 单张 1 张不报牌型（牌面就是答案，再贴一个胶囊是重复）');
  ok(/key === 'piaosanye'/.test(slotTypeOfSrc) && /key === 'douniu'/.test(slotTypeOfSrc),
    '只对飘三叶与斗牛两支取值');
  ok(!/typeName\(/.test(slotTypeOfSrc.replace(/Engine\.(piaoSanYe|douNiu)TypeName/g, '')),
    '★ slotTypeOf 里没有自己实现的牌型判定，只有 Engine 的两个调用');
}

/* ---------------- 5. 接线：渲染路径 ---------------- */
head('[5] 接线（组槽渲染）');
{
  const start = gameJs.indexOf('function renderSlots(');
  const rs = start < 0 ? '' : gameJs.slice(start, gameJs.indexOf('function refreshSlotLayout('));
  ok(!!rs, '能取出 renderSlots');
  ok(/var typeName = slotTypeOf\(key, cards\);/.test(rs), 'renderSlots 调用 slotTypeOf');
  /* 只要求「映射来自 BIG_FX」，不锁死某一行写法 —— v93 给十点半补 10.5 的成手信号时
   * 这一行变成了三元两支（typeName / bestNow），锁字符串会让它无缘无故变红。
   * 真正要守的是：renderSlots 里**没有第二份牌型名单**。 */
  ok(/BIG_FX\[typeName\]/.test(rs) && !/\['豹子', '同花顺'/.test(rs),
    '大牌型判定复用 BIG_FX（不另写一份名单）');
  /* ★ 关键：满组时用 slot-type **顶掉** slot-progress，不是并排。
   * 窄横屏两列档 .slot-meta-main 是 nowrap，并排会顶出格子。 */
  ok(/\? '<span class="slot-type' \+ \(BIG_FX\[typeName\] \? ' is-big' : ''\)/.test(rs),
    '★ 有牌型时渲染 slot-type（大牌型挂 is-big）');
  ok(/: '<span class="slot-progress' \+\n\s*\(cards\.length === count \? ' full' : ''\) \+ '">'/.test(rs)
    || /: '<span class="slot-progress'/.test(rs),
    '★ 没有牌型时才渲染 slot-progress（二选一，不并存）');
  ok(/\(typeFresh \? ' is-new' : ''\)/.test(rs), 'is-new 只由 typeFresh 控制');
  ok(/\(typeFresh && typeFx \? ' is-fresh' : ''\)/.test(rs), '大牌型刚成手时组本身也亮一下');
  ok(/\(typeFx \? ';--fx-color:' \+ typeFx\.color : ''\)/.test(rs),
    '--fx-color 写在 .slot 上（CSS 的组脉冲与胶囊同色）');
}

/* ---------------- 6. 状态提交时机（最容易写错的一处） ---------------- */
head('[6] slotTypeSeen 只在 innerHTML 真的被重写后提交');
{
  const start = gameJs.indexOf('function renderSlots(');
  const rs = start < 0 ? '' : gameJs.slice(start, gameJs.indexOf('function refreshSlotLayout('));
  const tail = rs.slice(rs.indexOf('if (html !== lastSlotsHtml)'));
  /* v108 起记忆归 cardView 模块所有，提交走 setter（值对象是整体替换的，
   * 直接给外面一个引用的话，外面赋值只改外面那个变量）。断言的意图没变：
   * **提交必须发生在「真的重写了 innerHTML」的那个分支里**，不能在 forEach 里。 */
  ok(/if \(html !== lastSlotsHtml\) \{[\s\S]{0,220}?(?:slotTypeSeen = nextTypeSeen|CardView\.setSlotTypeSeen\(nextTypeSeen\))/.test(tail),
    '★ slotTypeSeen = nextTypeSeen 在写入分支里（不是在 forEach 里）');
  ok(!/slotTypeSeen\[key\] = typeName;/.test(rs),
    '★ 没有在 forEach 里就地更新（那会让「跳过重写」那一帧把状态吃掉）');
  ok(/var freshKey = round \+ ':' \+ \(room\.handCount \|\| 0\);/.test(rs),
    '★ 用「轮 + 手数」做局粒度（只用 round 会和新一局撞上）');
  ok(/if \((?:CardView\.getSlotTypeRound\(\)|slotTypeRound) !== freshKey\) resetSlotTypeSeen\(freshKey\);/.test(rs),
    '换轮 / 换局时清空记忆');
  ok(/function resetSlotTypeSeen\(round\)/.test(gameJs), '有 resetSlotTypeSeen');
  ok(/resetSlotTypeSeen\(-1\)/.test(gameJs), '离桌清理时也清（cleanupRoom）');
}

/* ---------------- 7. 提交确认弹窗 ---------------- */
head('[7] 提交确认弹窗补牌型');
{
  const gs = fnSrc('groupsSummary');
  ok(!!gs, '能取出 groupsSummary');
  ok(/Engine\.typeName\(k, cards\)/.test(gs), '★ 走 Engine.typeName（不重算规则）');
  ok(/cards\.length === need/.test(gs), '只在放满的组上追加');
  ok(/k !== 'single'/.test(gs), '★ 单张组不追加（Engine 对 single 返回的就是那张牌名，会重复）');
  ok(/typeText = ' · ' \+ tn/.test(gs), '牌型名接在牌名后面');
}

/* ---------------- 8. 样式 ---------------- */
head('[8] 样式：胶囊 / 脉冲 / 减弱动效');
{
  ok(/\.slot-type \{[\s\S]{0,360}?background: rgba\(0, 0, 0, 0\.34\)/.test(css),
    '★ 普通牌型用中性深底（不借组色，避免与「爆 15」的红色撞语义）');
  ok(/\.slot-type\.is-big \{[\s\S]{0,220}?background: var\(--fx-color/.test(css),
    '大牌型用牌型色（与结算特写同一套 --fx-color）');
  ok(/@keyframes slotTypePop/.test(css), '有一次成手脉冲');
  ok(/\.slot-type\.is-new\.is-big \{\s*animation: slotTypePop/.test(css),
    '★ 脉冲只挂在 is-new + is-big 上（普通牌型不放动画）');
  ok(/@keyframes slotFreshGlow/.test(css) && /\.slot\.is-fresh \{/.test(css),
    '大牌型刚成手时组本身也有一下光晕');
  ok(!/\.slot\.is-fresh \{[^}]*transition/.test(css), '不用 transition（一次性动画，不留在元素上）');
  /* prefers-reduced-motion 的全局规则（animation-duration: 0.01ms）会覆盖到这里，
   * 不需要额外写一条 —— 但要是哪天有人给 slot-type 加了 transition，就会漏。 */
  ok(/@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{/.test(css),
    '全局减弱动效规则仍在（脉冲会被它一起关掉）');
}

/* ---------------- 9. 10.5 的成手信号（v93） ---------------- */
head('[9] 十点半 10.5：不贴胶囊，但要有成手信号');
{
  const start = gameJs.indexOf('function renderSlots(');
  const rs = start < 0 ? '' : gameJs.slice(start, gameJs.indexOf('function refreshSlotLayout('));

  /* 为什么单独一条：四个大牌型里，10.5 是唯一一个「牌型名就是点数」的，
   * 所以它不贴胶囊。但正因为不贴胶囊，它连 is-big / 脉冲 / 组光晕一起没有 ——
   * 凑到满分那一刻界面毫无反应，而豹子/牛牛/五花牛都会弹一下。
   * 审计（scripts/audit-pattern-fx.js）就是在这里发现缺口的。 */
  ok(/var bestNow = !!\(pair && !pair\.bust && pair\.points === StateMachine\.TENHALF_MAX_TENTHS\)/.test(rs),
    '★ 10.5 用一个 bestNow 判定（含「没爆」，爆牌不能当满分）');
  ok(/var seenKey = typeName \|\| \(bestNow \? '10\.5点' : ''\)/.test(rs),
    '★ 合成名参与 typeFresh：一份 seen 表管四种牌型，不为十点半另养一份');
  ok(/BIG_FX\['10\.5点'\]/.test(rs),
    '★ 走的是同一张 BIG_FX 表（颜色与结算特写同源）');
  ok(/nextTypeSeen\[key\] = seenKey/.test(rs),
    '★ 提交进 seen 表的是 seenKey 而不是 typeName（否则十点半永远判不出「刚成手」）');
  ok(/\(bestNow && typeFresh \? ' is-new' : ''\)/.test(rs),
    '★ 满分徽标在自己刚出现的那一帧挂 is-new');
  /* 反向：仍然不出胶囊 —— 十点半的牌型就是点数，胶囊会和小绿标说同一句话 */
  ok(slotTypeOf('tenhalf', [c('spade', 10), c('heart', 13)]) === '',
    '★ 依旧不贴胶囊（10.5 也走 n/n 进度 + 点数徽标）');

  ok(/\.slot-point\.is-new\.best \{\s*animation: slotTypePop/.test(css),
    '★ CSS 给 .slot-point.is-new.best 挂上同一支 slotTypePop');
  ok((css.match(/@keyframes slotTypePop/g) || []).length === 1,
    '★ 没有为它新写关键帧（四个大牌型的成手必须是同一个动作）');
}

/* ---------------- 10. 不能碰的东西 ---------------- */
head('[10] 边界');
{
  /* 这条功能是纯展示：不许影响提交、算分、时序。
   * 注意 `submitted` 是 renderSlots 的入参名，不能拿它当关键字判。 */
  const start = gameJs.indexOf('function renderSlots(');
  const rs = start < 0 ? '' : gameJs.slice(start, gameJs.indexOf('function refreshSlotLayout('));
  ok(!/Sfx\.play|RoomStore\.|fetch\(|await |submitGroups|advanceResult/.test(rs),
    'renderSlots 里没有音效/网络/提交/结算推进调用');
  ok(!/slot-type/.test(html), 'index.html 里没有硬编码的 slot-type（全是运行时生成）');
  ok(/slot-type/.test(gameJs) && /slot-type/.test(css), '游戏逻辑与样式各自提到它（两边都在）');
}

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
