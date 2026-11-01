/**
 * 牌桌组槽布局测试
 * 跑法：node pwa/test/table-layout.test.js
 *
 * 锁的是「第一轮的三组永远完整可见」这条不变量 —— 踩过的坑：
 * 三组是刚性尺寸（牌高 202 + 组信息 55 + 内边距 14 = 单组 271，三组加间距 840），
 * 而 390×844 的组槽可用高正好 846，只剩 6 设计px。于是 375×667 上第三组
 * 「飘三叶」被整块挤出容器（真机实测 clippedPx 136 / visibleRatio 0），
 * 滚动条在皮肤里又看不见 —— 玩家以为这组不存在。
 *
 * 三层断言：
 *   1. slotLayout.js 的 METRICS 与 style.css 里真实的 gap / padding 一致（防止改了 CSS 忘改 JS）
 *   2. 每一档真实机型的舞台高度上，totalHeight(三组) ≤ 组槽可用高（核心不变量）
 *   3. 牌不会被缩到认不出来（宽度有下限），且大屏不会无谓缩小（上限仍是 144×202）
 */
'use strict';

const { readAll: readGameAll } = require('./helpers/gameSource');
const fs = require('fs');
const path = require('path');
const SlotLayout = require('../js/slotLayout.js');

const ROOT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');
const gameJs = readGameAll();
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const swJs = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

/* ---------------------------- 1. CSS 与 JS 常量对账 ---------------------------- */

/* 抓某个选择器块的声明体。CSS 里同名选择器只出现一次，简单切片即可。 */
function cssBlock(selector) {
  const i = css.indexOf(selector + ' {');
  if (i < 0) return null;
  const start = css.indexOf('{', i) + 1;
  const end = css.indexOf('}', start);
  return css.slice(start, end);
}
function pxOf(block, prop) {
  if (!block) return null;
  const m = block.match(new RegExp('(?:^|;|\\s)' + prop + '\\s*:\\s*([^;]+);'));
  if (!m) return null;
  return m[1].trim();
}
/* "8px 18px 6px 16px" / "6px" → 上下内边距之和 */
function paddingV(value) {
  if (!value) return null;
  const parts = value.split(/\s+/).map((v) => parseFloat(v));
  if (parts.some((v) => Number.isNaN(v))) return null;
  if (parts.length === 1) return parts[0] * 2;
  return parts[0] + parts[2];   // 上 + 下
}

console.log('\n[1] slotLayout.js 的 METRICS 与 style.css 对账');
{
  const normalSlots = cssBlock('.slots');
  const denseSlots = cssBlock('.slots[data-dense="1"]');
  const normalSlot = cssBlock('.slot');
  const denseSlot = cssBlock('.slots[data-dense="1"] .slot');

  ok(!!normalSlots && !!denseSlots, 'CSS 里有 .slots 与 .slots[data-dense="1"] 两条规则');
  ok(!!normalSlot && !!denseSlot, 'CSS 里有 .slot 与 dense 版 .slot 两条规则');

  const gN = pxOf(normalSlots, 'gap');
  const gD = pxOf(denseSlots, 'gap');
  ok(gN !== null && parseFloat(gN) === SlotLayout.METRICS.normal.gap,
    '普通模式 .slots gap = ' + SlotLayout.METRICS.normal.gap + 'px', 'CSS 实际 ' + gN);
  ok(gD !== null && parseFloat(gD) === SlotLayout.METRICS.dense.gap,
    'dense 模式 .slots gap = ' + SlotLayout.METRICS.dense.gap + 'px', 'CSS 实际 ' + gD);

  const pN = paddingV(pxOf(normalSlot, 'padding'));
  const pD = paddingV(pxOf(denseSlot, 'padding'));
  ok(pN === SlotLayout.METRICS.normal.padV,
    '普通模式 .slot 上下内边距合计 = ' + SlotLayout.METRICS.normal.padV + 'px', 'CSS 实际 ' + pN);
  ok(pD === SlotLayout.METRICS.dense.padV,
    'dense 模式 .slot 上下内边距合计 = ' + SlotLayout.METRICS.dense.padV + 'px', 'CSS 实际 ' + pD);

  /* dense 必须把组信息挪到右侧、并藏掉规则提示 —— 否则 metaV 归零的前提不成立 */
  ok(/flex-direction:\s*row/.test(denseSlot || ''), 'dense 下 .slot 改成横向排布（组信息到右侧）');
  ok(/\.slots\[data-dense="1"\]\s*\.slot-hint\s*\{\s*display:\s*none/.test(css),
    'dense 下 .slot-hint 隐藏（规则提示不占右侧横向空间）');
  /* 普通模式必须仍是纵向，否则 metaV=55 的前提也不成立 */
  ok(/flex-direction:\s*column/.test(normalSlot || ''), '普通模式 .slot 仍是纵向（组信息在牌下方）');
}

/* ---------------------------- 2. 各档机型：三组必须放得下 ---------------------------- */

/* 用户实际会遇到的舞台高度（设计像素 = 视口高 / scale，scale = 屏宽/750）。
 *   stageH        ← 代表机型
 *   1331          ← 320×568（iPhone 5/SE 一代）、窄安卓
 *   1334          ← 375×667（iPhone SE 2/3 / 6/7/8）、360×640
 *   750           ← 横屏画布高（resize 里的 LS_DESIGN_H，1624×750）
 *                   注意横屏的组槽高度**不**能套 slotsHeight()：那 777 是竖屏的纵向开销，
 *                   横屏是两栏网格，纵向只剩顶栏，实测 844×390 的组槽是 535（见 probe-table）
 *   1500          ← dense 阈值本身（边界）
 *   1623/1626     ← 390×844、430×932（19.5:9，主流 iPhone） */
const DEVICES = [
  { name: '320×568 竖屏', stageH: 1331 },
  { name: '375×667 竖屏', stageH: 1334 },
  { name: '360×640 竖屏', stageH: 1334 },
  { name: '横屏 844×390（两栏，组槽实测 535）', stageH: 750, avail: 535 },
  { name: '1500 边界', stageH: 1500 },
  { name: '390×844 竖屏', stageH: 1623 },
  { name: '430×932 竖屏', stageH: 1626 }
];

console.log('\n[2] 三组是否完整放得下（totalHeight ≤ 组槽可用高）');
const rows = [];
DEVICES.forEach((d) => {
  const dense = SlotLayout.isDense(d.stageH);
  /* 横屏的组槽高度由网格实测得出，不套竖屏那套 slotsHeight（见顶部注释） */
  const avail = d.avail != null ? d.avail : SlotLayout.slotsHeight(d.stageH);
  const maxH = SlotLayout.maxCardHeight(avail, dense);
  /* 最挤的一组：第一轮「飘三叶」3 张 */
  const size = SlotLayout.cardSize(3, { dense: dense, maxCardH: maxH });
  const need = SlotLayout.totalHeight(size.h, dense);
  const fits = need <= avail;
  rows.push({
    机型: d.name, stageH: d.stageH, dense: dense ? 'Y' : 'N',
    组槽可用: avail, 牌: size.w + '×' + size.h, 三组需要: need, 余量: avail - need, 放得下: fits ? 'Y' : 'N'
  });
  ok(fits, d.name + '：三组放得下（' + need + ' ≤ ' + avail + '，余量 ' + (avail - need) + 'px）');
});
console.table(rows);

console.log('\n[3] dense 阈值与两档分界');
{
  ok(SlotLayout.isDense(1334) === true, '1334（16:9 手机）走 dense');
  ok(SlotLayout.isDense(750) === true, '750（横屏画布）走 dense');
  ok(SlotLayout.isDense(1623) === false, '1623（390×844）走普通排法，布局不变');
  ok(SlotLayout.isDense(1500) === false, '1500 是开区间下界，等于 1500 仍走普通排法');
  ok(/SlotLayout\.isDenseAt\(/.test(gameJs) && /RING_EXTRA_H/.test(gameJs),
    'game.js 的 resize() 按可用高判排法，并把圆桌多吃的 RING_EXTRA_H 扣掉');
  /* v87 新增：圆桌开着时 390×844 必须切 dense —— 否则三组硬挤进 552 的高度、
   * 第三组被裁。这一条是「牌变小了但都看得见」与「牌没变小但第三组不见」的分界。 */
  {
    const avail390 = SlotLayout.slotsHeight(1623);
    ok(SlotLayout.isDenseAt(avail390 - SlotLayout.RING_EXTRA_H) === true,
      '圆桌版 390×844：按可用高判 dense（' + (avail390 - SlotLayout.RING_EXTRA_H) + ' < ' + SlotLayout.NORMAL_NEED + '）');
    /* 关掉圆桌时两条判据结论必须一致，否则「翻开关」会顺带改牌尺寸 —— 那就不算干净回滚 */
    let same = true;
    [1334, 1440, 1623, 1624, 1734].forEach((h) => {
      if (SlotLayout.isDense(h) !== SlotLayout.isDenseAt(SlotLayout.slotsHeight(h))) same = false;
    });
    ok(same, '座位环关掉时：isDense(stageH) 与 isDenseAt(可用高) 结论一致（回滚不改牌尺寸）');
  }
  ok(/data-dense/.test(gameJs) && /setAttribute/.test(gameJs), 'game.js 会写 #slots 的 data-dense');
}

/* ---------------------------- 4. 牌尺寸上下限 ---------------------------- */

console.log('\n[4] 牌尺寸：大屏不缩小、矮屏不认不出');
{
  /* 390×844：算下来必须顶到上限 144×202 —— 和改之前一像素不差，不能出现视觉回归 */
  const avail390 = SlotLayout.slotsHeight(1623);
  const s390 = SlotLayout.cardSize(3, {
    dense: false, maxCardH: SlotLayout.maxCardHeight(avail390, false)
  });
  ok(s390.w === 144 && s390.h === 202, '390×844 的牌仍是 144×202（无视觉回归）',
    '实际 ' + s390.w + '×' + s390.h);

  /* 375×667：矮屏必须缩，且不能缩到认不出 */
  const avail375 = SlotLayout.slotsHeight(1334);
  const s375 = SlotLayout.cardSize(3, {
    dense: true, maxCardH: SlotLayout.maxCardHeight(avail375, true)
  });
  ok(s375.h < 202, '375×667 的牌比上限小（确实在按预算缩）', '实际高 ' + s375.h);
  ok(s375.w >= 100, '375×667 的牌宽 ≥ 100（牌面还认得出来）', '实际宽 ' + s375.w);

  /* dense 下组信息在右侧，牌最多占 55% 桌带宽度，留够文字空间 */
  const wide = SlotLayout.cardSize(3, { dense: true, maxCardH: 9999, bandInnerW: 629 });
  ok(wide.w * 3 + 8 * 2 <= Math.floor(629 * 0.55),
    'dense 下 3 张牌总宽不超过桌带的 55%（组信息有地方放）',
    '实际 ' + (wide.w * 3 + 16) + ' / ' + Math.floor(629 * 0.55));

  /* 张数越少每张越大，但不会超过上限 */
  const s1 = SlotLayout.cardSize(1, { dense: false, maxCardH: 9999 });
  const s5 = SlotLayout.cardSize(5, { dense: false, maxCardH: 9999 });
  ok(s1.w === 144, '1 张的组顶到上限 144');
  ok(s5.w < s1.w, '5 张的组（斗牛）按宽度均分后更小', s5.w + ' < ' + s1.w);
  ok(s5.w * 5 + 8 * 4 <= 629, '5 张牌不会挤出桌带', (s5.w * 5 + 32) + ' ≤ 629');

  /* 可用高为 0（牌桌还没显示）时不能算出 0 尺寸 */
  const none = SlotLayout.cardSize(3, { dense: false });
  ok(none.w > 0 && none.h > 0, '还没量到可用高时回落原尺寸，不是 0');
  ok(none.w === 144 && none.h === 202, '回落值就是设计尺寸 144×202');
}

/* ------------------- 4b. 圆桌版的牌面下限（文档 §11 验收标准） -------------------
 *
 * 这一节是补上的**下限**。原来的 [4] 只断言「5 张比 1 张小」「不溢出桌带」——
 * 两条都是「越小越容易通过」，于是斗牛组在线上被压到 69×97（低于 82×115）
 * 挂了一个版本都没人发现。文档写了标准，测试里就必须有一份同样的标准。
 */
console.log('\n[4b] 圆桌版牌面下限（1–3 张 ≥110×154、5 张 ≥82×115）');
{
  /* 竖屏圆桌：390×844 舞台 1623，环吃掉 280 后组槽实测 537（probe-table 量的） */
  const availRing = 537;
  const maxHRing = SlotLayout.maxCardHeight(availRing, true);
  function ringSize(n, bandInnerW, maxH) {
    return SlotLayout.cardSize(n, {
      dense: true,
      bandInnerW: bandInnerW || 629,
      capW: 144,
      maxCardH: maxH != null ? maxH : maxHRing,
      widthRatio: SlotLayout.ringWidthRatio(n),
      minW: SlotLayout.ringMinCardW(n)
    });
  }
  [1, 2, 3].forEach(function (n) {
    const s = ringSize(n);
    ok(s.w >= 110 && s.h >= 154,
      '竖屏圆桌 ' + n + ' 张组 ≥110×154（实测 ' + s.w + '×' + s.h + '）');
  });
  const s5 = ringSize(5);
  ok(s5.w >= 82 && s5.h >= 115,
    '★ 竖屏圆桌斗牛 5 张 ≥82×115（实测 ' + s5.w + '×' + s5.h + '）');
  ok(s5.w * 5 + 8 * 4 <= 629, '斗牛 5 张不挤出桌带', (s5.w * 5 + 32) + ' ≤ 629');
  ok(s5.w < ringSize(3).w, '5 张仍比 3 张小（宽度均分的方向没反）');

  /* 平板横屏：组槽 692，右栏更宽 */
  const maxHLs = SlotLayout.maxCardHeight(692, true);
  const s5ls = ringSize(5, 760, maxHLs);
  ok(s5ls.w >= 82 && s5ls.h >= 115,
    '平板横屏斗牛 5 张 ≥82×115（实测 ' + s5ls.w + '×' + s5ls.h + '）');

  /* 不传圆桌参数 = v86 原有口径，一个像素都不许变（回滚的前提） */
  const plain = SlotLayout.cardSize(5, { dense: true, bandInnerW: 629, capW: 144, maxCardH: maxHRing });
  ok(plain.w === Math.floor((629 * 0.55 - 32) / 5),
    '不传圆桌参数时 5 张仍是原来的口径（' + plain.w + '，回滚不改牌尺寸）', '实际 ' + plain.w);

  /* minW 兜底：比例算得比下限还狠时抬到下限 */
  const forced = SlotLayout.cardSize(5, {
    dense: true, bandInnerW: 629, capW: 144, maxCardH: maxHRing, widthRatio: 0.5, minW: 82
  });
  ok(forced.w >= 82, '比例算出来低于下限时抬到 82（minW 兜底生效）', '实际 ' + forced.w);

  /* 但桌带真的放不下时不许硬抬 —— 那会变成横向溢出，比牌小更糟 */
  const tight = SlotLayout.cardSize(5, {
    dense: true, bandInnerW: 400, capW: 144, maxCardH: maxHRing, widthRatio: 0.6, minW: 82
  });
  ok(tight.w * 5 + 32 <= 400, '桌带太窄时不硬抬（不横向溢出）', (tight.w * 5 + 32) + ' / 400');
}

/* ---------------------------- 5. 接入是否完整 ---------------------------- */

console.log('\n[5] 接入完整性');
{
  /* 只认 <script src> 的顺序。以前这里是 html.indexOf('./js/game.js')，
   * 于是往 <head> 里加一行 `<link rel="preload" as="script">` 就会误判 ——
   * preload 不是脚本，它出现在前面完全正常。 */
  const scriptSrcs = [];
  const re = /<script[^>]+src=["']([^"']+)["']/g;
  let mm;
  while ((mm = re.exec(html)) !== null) scriptSrcs.push(mm[1]);

  ok(scriptSrcs.some(function (s) { return s.indexOf('slotLayout.js') >= 0; }),
    'index.html 加载了 js/slotLayout.js');
  const iSlot = scriptSrcs.findIndex(function (s) { return s.indexOf('slotLayout.js') >= 0; });
  const iGame = scriptSrcs.findIndex(function (s) { return s.indexOf('game.js') >= 0; });
  ok(iSlot >= 0 && iGame > iSlot, 'slotLayout.js 在 game.js 之前加载（game.js 要用 SlotLayout）',
    'slot=' + iSlot + ' game=' + iGame);

  /* preload 的 URL 必须和被 preload 的那条 src 完全一致（含 ?v=），
   * 否则浏览器当成两个资源，等于首屏多下一份 86KB。 */
  const preloads = [];
  const pre = /<link[^>]+rel=["']preload["'][^>]*>/g;
  let pm;
  while ((pm = pre.exec(html)) !== null) {
    const href = /href=["']([^"']+)["']/.exec(pm[0]);
    const as = /as=["']([^"']+)["']/.exec(pm[0]);
    if (href && as) preloads.push({ href: href[1], as: as[1] });
  }
  if (preloads.length) {
    let allMatch = true;
    preloads.forEach(function (p) {
      if (p.as === 'script' && scriptSrcs.indexOf(p.href) < 0) allMatch = false;
      if (p.as === 'style' && html.indexOf('href="' + p.href + '"') < 0) allMatch = false;
    });
    ok(allMatch, '★ 每个 preload 的 URL 都和真实引用一字不差（带同样的 ?v=，否则会下两份）',
      JSON.stringify(preloads.map(function (p) { return p.as + ' ' + p.href; })));
  }

  ok(swJs.indexOf("'/js/slotLayout.js'") > 0, 'sw.js 的 PRECACHE 收录了 slotLayout.js（离线可用）');

  /* 飞牌与拖拽幽灵都不能再写死 144×202，否则矮屏上尺寸会跳 */
  ok(!/flyCard\(source, target, card, SLOT_CARD_W, SLOT_CARD_H/.test(gameJs),
    '入槽飞牌改用 slotCardSize() 的实际尺寸');
  ok(/d\.wrap\.offsetWidth/.test(gameJs), '拖拽幽灵牌按源节点实际尺寸取');

  ok(/function refreshSlotLayout/.test(gameJs), 'resize() 之后会重画组槽（转屏/换机型）');
  ok(/lastSlotsHtml = null;/.test(gameJs.split('function refreshSlotLayout')[1] || ''),
    'refreshSlotLayout 会清空 lastSlotsHtml，强制按新尺寸重写');
}

/* ==========================================================================
 * 键盘弹起不该把版式档位抖一下
 *
 * #viewport 是 fixed inset:0，安卓键盘一弹出布局视口被压掉一半 → resize() →
 * stageH 掉到 1500 以下 → compact-v 挂上 → 打字时整页字号和间距缩一档，收起又弹回。
 * 这是纯视觉档位，跟「屏幕上真的只有这么高」不是一回事，所以判输入焦点时跳过。
 * 浏览器行为测不了，只能靠源码结构断言守着（判据被删掉/位置被挪走都会红）。
 * ======================================================================== */
console.log('\n[键盘弹起不切版式档位]');
{
  ok(/function isTypingTarget/.test(gameJs), '有 isTypingTarget 判据');
  ok(/tag === 'TEXTAREA'/.test(gameJs) && /tag === 'INPUT'/.test(gameJs),
    '判据覆盖 textarea 与 input');
  ok(/isContentEditable/.test(gameJs), 'contenteditable 也算输入中');

  /* 两个 toggle 必须在 `if (!typing)` 里面：只看有没有 typing 变量不够，
   * 得看它是不是真的包住了这两个类切换 —— 否则等于写了判据没用上。 */
  const guard = /var typing = isTypingTarget\(document\.activeElement\);\s*if \(!typing\) \{([\s\S]*?)\n    \}/.exec(gameJs);
  ok(!!guard, '★ 两个档位切换被 `if (!typing)` 包住');
  if (guard) {
    ok(/classList\.toggle\('compact-v'/.test(guard[1]), '★ compact-v 在守卫内');
    ok(/classList\.toggle\('ls-tight'/.test(guard[1]), '★ ls-tight 在守卫内');
  }
  /* 挡的只能是「切类」，不能顺手把缩放计算也挡了 —— 键盘态下输入框必须还在可见区域里 */
  ok(/var typing = isTypingTarget/.test(gameJs) &&
     gameJs.indexOf('var typing = isTypingTarget') > gameJs.indexOf('stage.style.transform'),
    '★ 守卫在缩放写完之后（没有拦住舞台缩放本身）');
}

console.log('\n' + (fail === 0 ? '全部通过' : '失败 ' + fail + ' 项') + '：' + pass + ' 通过 / ' + fail + ' 失败\n');
process.exit(fail === 0 ? 0 : 1);
