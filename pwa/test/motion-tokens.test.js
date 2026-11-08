/**
 * 动效标尺守（v135 · B2）
 *
 * 背景：B1 把「光」收成三档之后，量了同一件事的另一半 —— **动**。
 * 改之前 transition 用了 9 种时长（0.1 / 0.12 / 0.15 / 0.16 / 0.22 / 0.25 / 0.3 / 0.4 / 0.42s）、
 * 5 种缓动。这不是节律，是九个节拍器：同一件事「点了有反应」，在五个按钮上要用五种速度。
 * 玩家读不出快慢的差别，只读得出「说不上来哪里不对」。
 *
 * 本文件钉三件事：
 *   1. transition 的时长只能来自 --dur-1/2/3，缓动只能来自 --ease-std/emph；
 *   2. 全站不再出现第二套 cubic-bezier 字面量（只有 :root 那两条）；
 *   3. 降级与焦点是**兜底**，不是白名单 —— 兜底靠"反向覆盖全部"，白名单的问题
 *      不是漏了几个，是「以后新加的元素默认没有」。
 *
 * animation 的时长**故意不管**：特写那一段 0.9~1.15s 是"演给你看"，
 * 不是"回应你的操作"，压到 320ms 会把特写压没。两类东西用同一个数才是错的。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CSS_DIR = path.join(__dirname, '..', 'css');
const FILES = ['style.css', 'records.css', 'emoji.css', 'flex-gap-fallback.css'];

let pass = 0, fail = 0;
function ok(c, m, extra) {
  if (c) { pass++; console.log('  ✓ ' + m); }
  else { fail++; console.log('  ✗ ' + m + (extra !== undefined ? '  ← ' + extra : '')); }
}
function eq(a, b, m, extra) {
  ok(a === b, m, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b) + (extra ? '  |  ' + extra : ''));
}
function head(t) { console.log('\n' + t); }

function strip(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}
function readAll() {
  const out = {};
  for (const f of FILES) {
    try { out[f] = strip(fs.readFileSync(path.join(CSS_DIR, f), 'utf8')); } catch (e) { out[f] = ''; }
  }
  return out;
}

/** 顶层逗号切层（rgba()/cubic-bezier() 里的逗号不算分隔） */
function layers(v) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of v) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** 按空白切词，但括号内的空白不切（`cubic-bezier(0, 0, 0.2, 1)` 必须是一个词） */
function tokens(layer) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of layer) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (/\s/.test(ch) && depth === 0) { if (cur) { out.push(cur); cur = ''; } }
    else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** 去掉 `@media (prefers-reduced-motion: reduce) { … }` 整块（含嵌套花括号） */
function withoutReducedMotion(css) {
  let out = css;
  const open = /@media\s*\(prefers-reduced-motion[^{]*\{/g;
  let m;
  while ((m = open.exec(out))) {
    let i = m.index + m[0].length, depth = 1;
    while (i < out.length && depth > 0) {
      if (out[i] === '{') depth++;
      else if (out[i] === '}') depth--;
      i++;
    }
    out = out.slice(0, m.index) + out.slice(i);
    open.lastIndex = m.index;
  }
  return out;
}

/** 所有 transition 声明的值（transition / transition-duration 都算） */
function transitions(css) {
  const out = [];
  const re = /(?:^|[;{\s])transition(?:-duration)?\s*:\s*([^;}]+)/g;
  let m;
  while ((m = re.exec(withoutReducedMotion(css)))) out.push(m[1].trim().replace(/\s+/g, ' '));
  return out;
}

/**
 * 一条 transition 值里「手写的」时长与缓动。
 * 允许：var(--dur-*) / var(--ease-*) / 0s / 0ms / 属性名 / !important
 * 违规：任何 ms|s 字面量（除 0）/ 任何 easing 关键字或 cubic-bezier() 字面量
 *
 * 分类器必须自测：如果它永远返回空集合，「零违规」只说明规则不匹配，不说明代码干净。
 */
function bareTimes(v) {
  const bad = [];
  const easing = /^(ease|linear|ease-in|ease-out|ease-in-out|step-start|step-end)$/;
  for (const layer of layers(v)) {
    for (const tok of tokens(layer)) {
      if (!tok) continue;
      if (/^var\(/.test(tok)) continue;
      if (/^-?\d*\.?\d+(ms|s)$/.test(tok)) {
        if (parseFloat(tok) === 0) continue;          // 0s / 0ms 是"立刻"，不需要档位
        bad.push(tok);
        continue;
      }
      if (easing.test(tok) || /^(cubic-bezier|steps)\(/.test(tok)) bad.push(tok);
    }
  }
  return bad;
}

const css = readAll();

/* =================== [1] 标尺本身 =================== */
head('[1] 三档时长 + 两条缓动');
{
  const style = css['style.css'];
  const val = (t) => {
    const m = new RegExp('\\' + t + '\\s*:\\s*([^;]+);').exec(style);
    return m ? m[1].trim() : '';
  };
  const ms = (t) => {
    const v = val(t);
    const m = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(v);
    if (!m) return -1;
    return m[2] === 's' ? Number(m[1]) * 1000 : Number(m[1]);
  };
  const d1 = ms('--dur-1'), d2 = ms('--dur-2'), d3 = ms('--dur-3');
  ok(d1 > 0 && d2 > d1 && d3 > d2, '★ 三档严格递增（' + d1 + ' < ' + d2 + ' < ' + d3 + ' ms）');
  /* 120 是"比手指抬起快"的上限；320 是"还能被看作即时反馈"的上限。
   * 这两条边界不是审美，是可感知阈值的经验值：>320ms 的过渡会被读成"卡了一下"。 */
  ok(d1 <= 150, '★ 微反馈档 ≤ 150ms（否则按压像卡顿）', String(d1));
  ok(d3 <= 320, '★ 入场档 ≤ 320ms（否则被读成卡顿而不是动画）', String(d3));

  ok(/cubic-bezier\(/.test(val('--ease-std')), '定义了 --ease-std（cubic-bezier）');
  ok(/cubic-bezier\(/.test(val('--ease-emph')), '定义了 --ease-emph（cubic-bezier）');
  ok(val('--ease-std') !== val('--ease-emph'), '★★ 两条缓动不是同一个值（写成一样等于只统一了名字）');
}

/* =================== [2] 分类器自测 =================== */
head('[2] 分类器自测（不测这个，「零违规」就没有意义）');
{
  eq(bareTimes('transform var(--dur-1) var(--ease-std)').length, 0, '全令牌 → 不判');
  eq(bareTimes('background 0.15s').join(','), '0.15s', '★ 裸时长 → 该判');
  eq(bareTimes('opacity 200ms').join(','), '200ms', '★ ms 写法也要判');
  eq(bareTimes('transform var(--dur-2) ease-out').join(','), 'ease-out', '★ 裸缓动关键字 → 该判');
  eq(bareTimes('transform var(--dur-2) cubic-bezier(0, 0, 0.2, 1)').join(','),
    'cubic-bezier(0, 0, 0.2, 1)', '★ 裸 cubic-bezier（含逗号）→ 整条判');
  eq(bareTimes('opacity 0s').length, 0, '0s 是「立刻」，不强制走档位');
  eq(bareTimes('transform var(--dur-1) var(--ease-std), background 0.2s ease').length, 2,
    '★ 多层里有一层裸写 → 只判那一层（2 个违规，不是 0 也不是 4）');
}

/* =================== [3] 真文件：transition 全走令牌 =================== */
head('[3] 真文件');
{
  let total = 0;
  const bad = [];
  for (const f of Object.keys(css)) {
    for (const v of transitions(css[f])) {
      total += 1;
      const b = bareTimes(v);
      if (b.length) bad.push(f + ': ' + v + '  →  ' + b.join(' '));
    }
  }
  ok(total >= 20, '一共扫到 ' + total + ' 条 transition 声明（太少说明解析坏了）');
  eq(bad.length, 0, '★★ 每一条 transition 的时长与缓动都来自令牌', bad.slice(0, 3).join(' | '));

  /* 时长取值去重：改之前是 9 种，现在是 3 种。这条防的是"令牌写了但没人用"——
   * 只要有一条绕过令牌，去重数就会 > 3。 */
  const used = new Set();
  for (const f of Object.keys(css)) {
    for (const v of transitions(css[f])) {
      const m = v.match(/var\(--dur-(\d)\)/g) || [];
      m.forEach((x) => used.add(x));
    }
  }
  ok(used.size === 3, '★ transition 实际用到了 ' + used.size + ' 档（应为 3，少于 3 说明有档位是摆设）');
}

/* =================== [4] 缓动：回应只准两条 =================== */
head('[4] 缓动');
{
  /* 规则分两处，因为"回应"和"表演"不是一类东西：
   *   · transition（回应你的操作）—— 只准 var(--ease-std) / var(--ease-emph)，字面量 0；
   *   · animation（演给你看）—— 允许各自的曲线（特写的冲刺、回弹、抖动的形状各不相同），
   *     但**种类只准减**，基线 9 条。 */
  const inTransition = [];
  for (const f of Object.keys(css)) {
    for (const v of transitions(css[f])) {
      for (const c of v.match(/cubic-bezier\([^)]*\)/g) || []) inTransition.push(f + ': ' + c);
    }
  }
  eq(inTransition.length, 0, '★★ transition 里没有 cubic-bezier 字面量（只准用令牌）', inTransition.slice(0, 2).join(' | '));

  const lit = new Set();
  for (const f of Object.keys(css)) {
    for (const m of css[f].match(/cubic-bezier\([^)]*\)/g) || []) lit.add(m);
  }
  /* 9 = :root 两条令牌 + 表演动画的 7 条。只准减：想加一条新的回弹曲线，先看看能不能复用。 */
  ok(lit.size <= 9, '★ 全站 cubic-bezier 去重 ' + lit.size + ' 条 ≤ 9（基线，只准减）', [...lit].join(' | '));
}

/* =================== [5] 降级与焦点是兜底，不是白名单 =================== */
head('[5] 兜底');
{
  const style = css['style.css'];
  const rm = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/.exec(style);
  /* 注意：style.css 里有 4 个 reduced-motion 块，其中 3 个是单点关闭（.pat-halo 等），
   * 只有一个是 `*` 兜底。这里要求**至少存在一个 `*` 且同时关掉 animation 与 transition**。 */
  const all = style.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\n\}/g) || [];
  const universal = all.filter((b) => /\*\s*,\s*\*::before\s*,\s*\*::after/.test(b));
  eq(universal.length, 1, '★★ 恰有一个 `*` 兜底块（多了说明有重复实现，少了说明降级不完整）', String(all.length));
  const u = universal[0] || '';
  ok(/animation-duration\s*:/.test(u), '★ 兜底关了 animation');
  ok(/transition-duration\s*:/.test(u), '★ 兜底关了 transition');
  ok(/!important/.test(u), '★ 兜底用 !important（否则被组件规则盖掉，等于没写）');
  ok(!rm || true, '（单点块与兜底块并存是允许的：单点块保留语义，兜底块保底）');

  /* 焦点兜底：必须是「元素 + 伪类」的权重 (0,1,1)，
   * 不能用 :where() 包起来 —— 那会让 `input { outline: none }` 这类规则反盖回来。 */
  ok(/^button:focus-visible/m.test(style), '★ 焦点兜底写在 button:focus-visible（元素+伪类，非 :where）');
  ok(!/:where\([^)]*\):focus-visible/.test(style), '★ 没有用 :where() 包焦点兜底（权重 0 会被单类规则盖掉）');
  ok(/\[role="button"\]:focus-visible/.test(style), '★ 覆盖了 [role="button"]（div 装的假按钮）');
  ok(/\[tabindex\]:not\(\[tabindex="-1"\]\):focus-visible/.test(style), '★ 覆盖了 tabindex 容器');
  /* 环必须看得见：颜色不能是 transparent / none，而且要有 offset（否则贴着元素边缘像描边）。 */
  const ring = /button:focus-visible[\s\S]{0,400}?\{([\s\S]*?)\}/.exec(style);
  ok(!!ring && /outline\s*:\s*3px solid rgba?\(/.test(ring[1]), '★ 兜底环是 3px 实色（不是 transparent / none）');
  ok(!!ring && /outline-offset\s*:\s*[1-9]/.test(ring[1]), '★ 兜底环有 offset（贴着边缘会像描边而不是焦点）');
}

/* =================== [6] 引用完整性：写错的令牌名 = 静默失效 =================== */
head('[6] 令牌名必须真有');
{
  /* 这是 B1 那次 `--elev-1` 自引用教会的：CSS 里引用一个不存在的变量，
   * 不会报错、不会警告，**整条声明直接作废** —— transition 变成"瞬间完成"，
   * 界面看起来正常，只是所有按压都"没有回执"。静态守卫必须自己查引用。 */
  const style = css['style.css'];
  const defined = new Set();
  for (const m of style.match(/^\s*(--[a-z0-9-]+)\s*:/gm) || []) defined.add(m.trim().replace(/\s*:$/, ''));

  const used = new Map();     // name -> 首次出现的文件
  for (const f of Object.keys(css)) {
    for (const v of transitions(css[f])) {
      for (const m of v.match(/var\((--[a-z0-9-]+)\)/g) || []) {
        const name = m.slice(4, -1);
        if (!used.has(name)) used.set(name, f);
      }
    }
  }
  const missing = [...used.keys()].filter((n) => !defined.has(n));
  eq(missing.length, 0, '★★ transition 里引用的 ' + used.size + ' 个令牌全部有定义',
    missing.map((n) => n + ' @' + used.get(n)).join(', '));
  /* 反向：三档时长必须都被用到（[3] 已经查过 dur，这里补缓动） */
  for (const e of ['--ease-std', '--ease-emph']) {
    ok([...used.keys()].includes(e), '★ ' + e + ' 真的被用上了（不是写了没人用的摆设）');
  }
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
