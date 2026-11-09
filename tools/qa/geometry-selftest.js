#!/usr/bin/env node
/**
 * 几何判定工具的**自验**（AC-NB-26 / BACKLOG N-3）
 *
 * 规矩只有一条：**先证明这把尺子是准的，才许拿它去量别人。**
 * 上一轮的教训（qa-doc-audit-2026-11-08 §0.2）是反过来的 ——
 * 一个按文本内容分类数字的采集器，看不见「框溢出但被 overflow:hidden 裁掉」，
 * 于是「M5 变异下不红」被当成「没问题」，其实是尺子本身有盲区。
 *
 * 本工具做两件事，任何一件不通过都**拒绝下结论**（退出码 1）：
 *
 *   ① 判定样本自验：6 组**已知答案**的矩形对（3 组该命中、3 组不该命中），
 *      跑「交集面积 / 是否在容器内 / 相邻间隙」三条判定，必须 6/6 通过。
 *      样本是手算的，不来自被测样式，也不 require 任何被测模块。
 *
 *   ② 采集器合规自验：从 scripts/probe-numbers.js 与 scripts/probe-undo.js
 *      里把几何采集器那段抠出来（去掉注释后），检查它
 *        · 有 querySelector + getBoundingClientRect（按结构取节点、量格子）
 *        · 没有 ownText( / NUM.test( / textContent（按文本采集 = M8 变异）
 *      命中禁用词 → 打印「拒绝用该采集器下结论」并按失败退出。
 *
 * 跑法：node tools/qa/geometry-selftest.js
 *      node tools/qa/geometry-selftest.js --verbose   打印每个样本的算式
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const VERBOSE = process.argv.indexOf('--verbose') >= 0;

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

/* ============ ① 判定样本（手工算出来的答案，不是跑出来的） ============ */
/* 交集面积：x 重叠 10 × y 重叠 12 = 120 */
function overlapArea(a, b) {
  const x = Math.min(a.r, b.r) - Math.max(a.l, b.l);
  const y = Math.min(a.b, b.b) - Math.max(a.t, b.t);
  return (x > 0 && y > 0) ? x * y : 0;
}
/* 在容器内：1px 抗锯齿容差（写死在这里，不取自 CSS） */
function inBounds(inner, outer, tol) {
  const t = tol === undefined ? 1 : tol;
  return inner.l >= outer.l - t && inner.r <= outer.r + t &&
         inner.t >= outer.t - t && inner.b <= outer.b + t;
}
function gapH(left, right) { return right.l - left.r; }

const C = { l: 0, t: 0, r: 100, b: 40 };
const SAMPLES = [
  /* --- 该命中（有问题）的三组 --- */
  { name: '右溢出 6px → 越界', kind: 'bounds', inner: { l: 2, t: 2, r: 106, b: 38 }, outer: C, expect: false },
  { name: '相邻块重叠 10×12 → 交集 120', kind: 'overlap',
    a: { l: 0, t: 0, r: 50, b: 30 }, b: { l: 40, t: 18, r: 90, b: 60 }, expect: 120 },
  { name: '相邻间隙 4px（规格 10）→ 不合规', kind: 'gap',
    a: { l: 0, t: 0, r: 50, b: 30 }, b: { l: 54, t: 0, r: 90, b: 30 }, expect: 4 },
  /* --- 不该命中的三组 --- */
  { name: '完全在容器内 → 不越界', kind: 'bounds', inner: { l: 1, t: 1, r: 99, b: 39 }, outer: C, expect: true },
  { name: '下溢出 1px（容差内）→ 不判越界', kind: 'bounds', inner: { l: 2, t: 2, r: 98, b: 41 }, outer: C, expect: true },
  { name: '不相接的两块 → 交集 0', kind: 'overlap',
    a: { l: 0, t: 0, r: 40, b: 20 }, b: { l: 40, t: 20, r: 80, b: 40 }, expect: 0 },
];

function runSamples() {
  console.log('\n[1] 判定样本自验（6 组已知答案）');
  for (const s of SAMPLES) {
    let got;
    if (s.kind === 'bounds') got = inBounds(s.inner, s.outer);
    else if (s.kind === 'overlap') got = overlapArea(s.a, s.b);
    else got = gapH(s.a, s.b);
    const good = got === s.expect;
    ok(good, s.name, 'expect=' + s.expect + ' got=' + got);
    if (VERBOSE) console.log('        ' + JSON.stringify(s.kind === 'bounds' ? s.inner : [s.a, s.b]));
  }
  console.log('    样本结果 ' + pass + '/' + (pass + fail) + ' 通过');
}

/* ============ ② 采集器合规（挡 M8：按文本采集） ============ */
/* 从源码里抠一段：从 startMarker 起到第一个以 `;\n` 结尾的模板字符串结束 */
function sliceTemplate(src, startMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) return null;
  const q = src.indexOf('`', i);
  if (q < 0) return null;
  const e = src.indexOf('`', q + 1);
  if (e < 0) return null;
  return src.slice(q + 1, e);
}
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // /* … */
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // // …（不碰 http://）
}

const COLLECTORS = [
  {
    label: 'probe-numbers 几何采集器',
    file: 'scripts/probe-numbers.js',
    marker: 'const GEOMETRY = `',
    must: ['querySelector(', 'getBoundingClientRect('],
    forbid: ['ownText(', 'NUM.test(', 'textContent']
  },
  {
    label: 'probe-undo 几何采集器',
    file: 'scripts/probe-undo.js',
    marker: 'const GEO = (sels) => `',
    must: ['querySelectorAll(', 'getBoundingClientRect('],
    forbid: ['ownText(', 'NUM.test(', 'textContent']
  }
];

function runCollectorCheck() {
  console.log('\n[2] 采集器合规自验（按文本采集 = 拒绝下结论）');
  let refused = [];
  for (const c of COLLECTORS) {
    const abs = path.join(ROOT, c.file);
    let src = '';
    try { src = fs.readFileSync(abs, 'utf8'); } catch (e) {
      ok(false, c.label + '：源码读不到', c.file);
      refused.push(c.file + '（读不到）');
      continue;
    }
    const raw = sliceTemplate(src, c.marker);
    if (!raw) {
      ok(false, c.label + '：找不到采集器代码块（marker="' + c.marker + '"）',
        '改过名的采集器等于换了尺子，本工具必须跟着改，而不是默默放过');
      refused.push(c.file + '（找不到采集器）');
      continue;
    }
    const code = stripComments(raw);
    const missMust = c.must.filter((k) => code.indexOf(k) < 0);
    const hitForbid = c.forbid.filter((k) => code.indexOf(k) >= 0);
    ok(missMust.length === 0, c.label + '：按结构取节点（含 ' + c.must.join(' + ') + '）',
      '缺少 ' + JSON.stringify(missMust));
    ok(hitForbid.length === 0, c.label + '：不含按文本采集的写法（' + c.forbid.join(' / ') + '）',
      '命中 ' + JSON.stringify(hitForbid));
    if (missMust.length || hitForbid.length) refused.push(c.file);
  }
  if (refused.length) {
    console.log('\n  ✗ 拒绝用该采集器下结论：' + refused.join('、'));
    console.log('    按文本内容分类的采集器看不见「框溢出但被 overflow:hidden 裁掉」这类盲区，');
    console.log('    拿它量出来的绿只能说明它没看见，不能说明没问题。');
    return false;
  }
  return true;
}

console.log('几何判定工具自验（AC-NB-26 / N-3）');
runSamples();
const collectorOk = runCollectorCheck();

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项' +
  (collectorOk ? '' : '（采集器不合格：拒绝下结论）'));
process.exit(fail ? 1 : 0);
