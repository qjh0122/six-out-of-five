/**
 * 设计令牌守（v134 · B1）
 *
 * 背景：UI 审计量出来的数字是——100 个 hex、188 处裸写颜色（token 采用率 65%）、
 * 33 档字号、**71 种 box-shadow**、39 个卡片类、7 档动效。
 *
 * 这不是审美问题，是**没有语法**：每屏都还行，串起来不像一个应用。
 * 而 71 种阴影的本质是「71 个光源」——现实里物体被同一个光照亮，
 * 投影应随高度连续变化；71 个答案让大脑读不出「谁在谁上面」。
 *
 * 本文件先钉最基础的一条：**外投影只能来自标尺（--elev-1/2/3）**。
 * 造型类的阴影不在此列，而且必须讲清楚为什么：
 *   · `0 2px 0 <色>` = 实体按钮的下沿（造型，不是高度；并进 elevation 会把按钮压平）
 *   · `0 0 Npx <色>` = 状态发光/环（表达状态，不表达高度）
 *   · `inset ...`     = 内描边 / 内高光 / 左侧色条（边缘与标记）
 *
 * 判据的写法刻意做成「分类器 + 自测 + 真文件」三段：
 * 只有分类器自测过了，「真文件零违规」才说明问题；否则它可能只是因为规则永远不匹配。
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

function readAll() {
  const out = {};
  for (const f of FILES) {
    try { out[f] = fs.readFileSync(path.join(CSS_DIR, f), 'utf8'); } catch (e) { out[f] = ''; }
  }
  return out;
}

/** 取所有 box-shadow 的声明值（跨行也算一条；注释先抹掉，注释里的例子不是违规） */
function shadows(css) {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const out = [];
  const re = /box-shadow\s*:\s*([^;}]+)/g;
  let m;
  while ((m = re.exec(flat))) out.push(m[1].trim().replace(/\s+/g, ' '));
  return out;
}

/**
 * 按顶层逗号切层：`rgba(0, 0, 0, .3), inset 0 1px 0 #fff` → 两层。
 * 不能直接 split(',')——颜色函数自己的逗号会把一层切碎，
 * 之前正是这个 bug 让 `0 8px 22px rgba(0,0,0,.34)` 被判成「非投影」而漏放。
 */
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

/**
 * 分类：这条阴影属不属于「外投影（高度）」。
 * 是 → 必须走 --elev-*；不是 → 归入造型类，不判。
 *
 * 只看**第一层**：`0 8px 20px ..., inset 0 1px 0 ...` 的语义是「一张浮起来的卡 + 它的内高光」，
 * 整体按外投影算；反过来 `0 0 16px ..., var(--elev-2)` 是「光环 + 已归位的高度」，不判。
 */
function isElevation(v) {
  if (!v) return false;
  if (/^var\(--elev-/.test(v)) return false;          // 已经是令牌
  const first = layers(v)[0] || '';
  if (/^inset\b/.test(first)) return false;           // 内描边/内高光/色条
  const parts = first.split(/\s+/);
  const num = (s) => (s === undefined ? NaN : parseFloat(s));
  if (num(parts[0]) !== 0) return false;              // x 偏移不为 0（少见，发光/斜影）不按高度管
  const y = num(parts[1]);
  const blur = num(parts[2]);
  if (!(y > 0)) return false;                         // y=0 → 四向光环，表达状态不表达高度
  if (!(blur > 0)) return false;                      // blur=0 → 实体按钮下沿（造型）
  return true;
}

/* =================== [1] 光的三档：令牌定义齐全 =================== */
head('[1] 标尺本身');
{
  const style = readAll()['style.css'];
  for (const t of ['--elev-1', '--elev-2', '--elev-3', '--edge-hairline', '--edge-top', '--edge-paper', '--elev-paper']) {
    ok(new RegExp('\\' + t + '\\s*:').test(style), '定义了 ' + t);
  }
  /* 三档必须是递进的关系：模糊半径与不透明度都随高度增大。
   * 这条防的是「三档写了但写得一样」——那种情况下"统一"只是把 71 个换成了 3 个同值。 */
  const val = (t) => {
    const m = new RegExp('\\' + t + '\\s*:\\s*([^;]+);').exec(style);
    return m ? m[1] : '';
  };
  const blurOf = (s) => {
    const m = /0\s+(\d+)px\s+(\d+)px/.exec(s.split(',')[0]);
    return m ? Number(m[2]) : -1;
  };
  const b1 = blurOf(val('--elev-1')), b2 = blurOf(val('--elev-2')), b3 = blurOf(val('--elev-3'));
  ok(b1 > 0 && b2 > b1 && b3 > b2, '★ 三档模糊半径严格递增（' + b1 + ' < ' + b2 + ' < ' + b3 + '）');
  /* 自引用守卫：`--elev-1: 0 2px 6px ..., var(--elev-1)` 是循环引用，
   * 浏览器会把整条声明判为无效 → 元素**完全没有阴影**，但源码里看着「有写」。
   * 这种错只有跑起来才看得见，源码评审 100% 漏掉，所以钉死在这里。 */
  const cyc = ['--elev-1', '--elev-2', '--elev-3', '--elev-paper', '--edge-paper'].filter(
    (t) => new RegExp('var\\(' + t + '\\)').test(val(t))
  );
  eq(cyc.length, 0, '★★ 令牌不引用自己（循环引用会让整条声明被丢弃）', cyc.join(','));
}

/* =================== [2] 分类器自测：三个方向都要对 =================== */
head('[2] 分类器自测（不测这个，「零违规」就没有意义）');
{
  ok(isElevation('0 8px 22px rgba(0, 0, 0, 0.34)'), '外投影 → 该判（真阳性）');
  ok(isElevation('0 8px 20px rgba(0, 0, 0, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.12)'),
    '外投影 + 内高光 → 整体算外投影（第一层是投影）');
  ok(!isElevation('var(--elev-2)'), '已经是令牌 → 不判');
  ok(!isElevation('0 2px 0 #B47F22'), '★ 实体按钮下沿（blur=0）→ 不判（这是造型）');
  ok(!isElevation('0 0 16px rgba(245, 193, 92, 0.5)'), '★ 状态发光（y=0）→ 不判');
  ok(!isElevation('0 0 16px rgba(245, 193, 92, 0.5), var(--elev-2)'),
    '★ 光环 + 已归位的高度 → 不判（第一层是环，不是投影）');
  ok(!isElevation('0 0 10px rgba(67, 209, 124, 0.22), inset 0 -6px 10px rgba(0, 0, 0, 0.20)'),
    '★ 光环 + 内影 → 不判');
  ok(isElevation('0 4px 18px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.1)'),
    '★ 颜色里的逗号不能把一层切碎（回归：曾被 split(",") 误判）');
  ok(!isElevation('inset 0 1px 0 rgba(255, 255, 255, 0.45)'), '内高光 → 不判');
  ok(!isElevation('none'), 'none → 不判');
}

/* =================== [3] 真文件：外投影零字面量 =================== */
head('[3] 真文件');
const css = readAll();
{
  const bad = [];
  let total = 0;
  for (const f of Object.keys(css)) {
    for (const v of shadows(css[f])) {
      total += 1;
      if (isElevation(v)) bad.push(f + ': ' + v);
    }
  }
  ok(total >= 60, '一共扫到 ' + total + ' 条 box-shadow 声明（太少说明解析坏了）');
  eq(bad.length, 0, '★★ 没有一条外投影是手写字面量（全部来自 --elev-*）', bad.slice(0, 4).join(' | '));
}

/* =================== [4] 种类上限：只准减 =================== */
head('[4] 阴影种类不回升');
{
  const set = new Set();
  for (const f of Object.keys(css)) for (const v of shadows(css[f])) set.add(v);
  /* 这个数是 v134 的实测基线（113 条声明 / 83 种）。它包含外投影 3 档 +
   * 内描边 / 状态环 / 色条 / 按钮下沿等**造型**——造型本来就该按场景不同。
   * 所以这条不是「种类越少越美」，而是**只准减**：
   * 想加一个新的阴影写法，先找找能不能复用现有的；真不能，就把数字往上调并在提交里说明为什么。
   * 卡死不放到 88 那种「留余量」，是因为余量会立刻被吃掉。
   *
   * v136 → 84：新增的 `#undo-bar` 是「浮起 + 金色发丝边」的组合，现有三种 elevation
   * 都不能表达（内容卡没有边、弹窗是暖白纸、浮层是菜单）。这是**真需要**而不是随手调，
   * 所以基线加一；下一次要加，同样得在这里写清楚理由。 */
  const CAP = 84;
  ok(set.size <= CAP, '★ 不同 box-shadow 共 ' + set.size + ' 种，≤ ' + CAP + '（基线，只准减）', String(set.size));
}

/* =================== [5] 纸必须有边 =================== */
head('[5] 纸的厚度来自边缘');
{
  const style = readAll()['style.css'];
  const box = /\.modal-box\s*\{([\s\S]*?)\}/.exec(style);
  ok(!!box, '找到 .modal-box');
  const body = box ? box[1] : '';
  ok(/--elev-3/.test(body), '★ 弹窗用第三档高度');
  ok(/--edge-paper/.test(body), '★★ 弹窗带纸边（只靠阴影是贴图，有边才有厚度）');
  const stage = /#stage\s*\{([\s\S]*?)\}/.exec(style);
  ok(!!stage && /radial-gradient/.test(stage[1]), '★ 毡面有一层中心光（不是均色底）');
  ok(!!stage && /tabular-nums/.test(stage[1]), '★ 数字全局等宽（否则一列分数会左右跳）');
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
