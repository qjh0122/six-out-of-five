/**
 * 结算页冠军块（v115 · C-1）
 * 跑法：node pwa/test/settle-crown.test.js
 *
 * 为什么要有这块：结算页原来只有一个皇冠图标挂在第一名那一行。
 * 打了半小时，收尾是一张表 —— **谁赢的、赢多少、领先多少** 这三个问题
 * 得自己在表里找。C-1 在顶部补一块回答它们。
 *
 * 守三条，全是「看着像对、其实是编的」：
 *   ① 并列冠军：名字都写上，**分差那一句不写** —— 并列之间没有「领先」可言。
 *   ② 全员弃局 / 没有冠军：整块藏起来（`hidden`），不能留个空框。
 *   ③ 有冠军但没有第二名（只剩一个人）：**也不写分差** —— 差多少分是跟谁差？
 *
 * 测法：settleView 是 UMD，`el` 从 `global.LXW.utils` 取。
 * 这里塞一个假 `el`（造普通对象），拿真函数跑真数据 —— 不 grep 源码。
 */
'use strict';

/* ---- 最小的 el / $ 桩：只要 tag / class / text 三样，够断言了 ---- */
function fakeEl(tag, cls, text) {
  return {
    tag: tag,
    cls: cls || '',
    text: text === undefined ? '' : String(text),
    children: [],
    classList: {
      _self: null,
      add(c) { this._self.cls += (this._self.cls ? ' ' : '') + c; },
      contains(c) { return this._self.cls.split(/\s+/).indexOf(c) >= 0; }
    },
    appendChild(node) { this.children.push(node); return node; }
  };
}
function mk(tag, cls, text) {
  const n = fakeEl(tag, cls, text);
  n.classList._self = n;
  return n;
}

/* settleView 的 UMD 收尾是 `global.LXW.settleView = create`，
 * 而 node 里模块顶层的 `this` 就是 `module.exports` ——
 * 所以 `require` 拿到的是 `{ LXW: { settleView } }`，桩也要挂在这份对象上。 */
const M = require('../js/settleView.js');
M.LXW.utils = {
  $: function () { return null; },
  el: mk,
  esc: function (s) { return String(s); },
  netText: function (n) { return String(n); },
  netCls: function () { return ''; },
  pad2: function (n) { return String(n); },
  fmtTime: function () { return ''; },
  cardText: function () { return ''; },
  short: function (s) { return String(s); },
  colorFor: function () { return ''; }
};
const view = M.LXW.settleView({});

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

/* 收树：把整块 flatten 成 [{cls, text}]，断言文案时不用一路点下去 */
function flat(node, out) {
  out = out || [];
  out.push({ cls: node.cls, text: node.text });
  (node.children || []).forEach(function (c) { flat(c, out); });
  return out;
}
function texts(node) {
  return flat(node).map(function (x) { return x.text; }).filter(function (t) { return t; });
}
function hasCls(node, cls) {
  return flat(node).some(function (x) { return x.cls.split(/\s+/).indexOf(cls) >= 0; });
}
function findCls(node, cls) {
  return flat(node).filter(function (x) { return x.cls.split(/\s+/).indexOf(cls) >= 0; })[0];
}

/* 造人：settleRank 只认 id / nickname / score / left / abandoned 这几个字段 */
function P(id, score, opts) {
  const p = { id: id, nickname: id, score: score };
  Object.assign(p, opts || {});
  return p;
}
function room(players) {
  return { phase: 'SETTLED', handLimit: 3, handSeq: 1, players: players };
}

console.log('\n[1] 唯一冠军：谁赢、赢多少、领先多少');
{
  const box = view.crownBlock(room([P('甲', 12), P('乙', 5), P('丙', -8)]));
  ok(!hasCls(box, 'hidden'), '有冠军时不隐藏');
  ok(!!findCls(box, 'sc-name'), '有名字那一行（sc-name）');
  const t = texts(box);
  ok(t.indexOf('本局冠军') >= 0, '标题写「本局冠军」（不是并列时才这么写）', t.join('|'));
  ok(t.indexOf('甲') >= 0, '★ 名字是冠军的');
  ok(t.indexOf('+12 分') >= 0, '★ 赢多少写成带号的形式（+12 分）', t.join('|'));
  ok(t.indexOf('matters') < 0, '没有多余的占位文本');
  const gap = findCls(box, 'sc-gap');
  ok(!!gap, '★ 唯一冠军 → 有分差那一句');
  ok(gap && gap.text.indexOf('7') >= 0, '★ 分差 = 12 - 5 = 7', gap && gap.text);
  ok(gap && gap.text.indexOf('乙') >= 0, '分差里带上第二名的名字（不然「领先 7 分」不知道领先谁）');
}

console.log('\n[2] 并列冠军：名字都写，分差一句都不写');
{
  const box = view.crownBlock(room([P('甲', 9), P('乙', 9), P('丙', 1)]));
  const t = texts(box);
  ok(t.indexOf('并列冠军') >= 0, '★ 标题改成「并列冠军」', t.join('|'));
  ok(t.indexOf('甲、乙') >= 0, '★ 两个人的名字都在（顿号连起来）', t.join('|'));
  ok(!findCls(box, 'sc-gap'), '★ 并列时不写分差（并列之间没有「领先」）');
  ok(!hasCls(box, 'hidden'), '并列也是冠军，不隐藏');
}

console.log('\n[3] 只剩一个人 / 全员弃局');
{
  const solo = view.crownBlock(room([P('甲', 3)]));
  ok(!findCls(solo, 'sc-gap'), '★ 没有第二名 → 不写分差（差多少分是跟谁差？）');
  ok(texts(solo).indexOf('甲') >= 0, '但冠军本身照写');
}
{
  /* 所有人都在开局前弃局（`left`）：settleRank 认不出冠军，这块必须整块藏掉 */
  const box = view.crownBlock(room([P('甲', 0, { left: true }), P('乙', 0, { left: true })]));
  ok(hasCls(box, 'hidden'), '★ 没有冠军 → 整块 hidden（不留空框）');
  eq(texts(box).length, 0, '藏起来的块里没有文案');
}

console.log('\n[4] 分数是负的时候');
{
  const box = view.crownBlock(room([P('甲', -2), P('乙', -9)]));
  const t = texts(box);
  ok(t.indexOf('-2 分') >= 0, '★ 负数不额外加号（写 -2 分，不写 +-2 分）', t.join('|'));
  const gap = findCls(box, 'sc-gap');
  ok(gap && gap.text.indexOf('7') >= 0, '分差取绝对值 7（两个人都是负分，差 7）', gap && gap.text);
}

console.log('\n[5] 接线：只在结算页出现，回看弹窗里不重复');
{
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'settleView.js'), 'utf8');
  const renderStart = src.indexOf('function renderSettle(');
  const prevStart = src.indexOf('function openPrevResult(');
  ok(renderStart > 0 && prevStart > renderStart, '两个渲染点都在（先 renderSettle 后 openPrevResult）');
  const renderBody = src.slice(renderStart, prevStart);
  const prevBody = src.slice(prevStart, src.indexOf('function closePrevResult('));
  ok(/crownBlock\(room\)/.test(renderBody), '★ 结算页调了 crownBlock');
  ok(!/crownBlock\(room\)/.test(prevBody), '★ 「回看上一把」弹窗里没有（同一块只看一次，弹窗是窄容器）');
  /* CSS 三件套：块 / 名字 / 分差 + hidden */
  const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'style.css'), 'utf8');
  ['.settle-crown', '.sc-name', '.sc-net', '.sc-gap', '.settle-crown.hidden'].forEach(function (sel) {
    ok(css.indexOf(sel) >= 0, 'CSS 里有 ' + sel);
  });
}

console.log('\n----------------------------------------');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) process.exit(1);
