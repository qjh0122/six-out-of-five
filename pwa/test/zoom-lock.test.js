/**
 * 禁止页面缩放测试（纯静态解析，不开浏览器）
 * 跑法：node pwa/test/zoom-lock.test.js
 *
 * 守的是「牌桌不能被浏览器捏合放大/缩小」这件事。
 *
 * 为什么值得单独一个文件：这个功能**不是一处开关，是三处必须同时成立**，
 * 而且任何一处漏掉，界面上都不会报错，只会表现为「有时候还能放大」——
 * 玩家看到的是牌突然变小、拖牌点不中，而开发者在自己机器上复现不出来。
 *
 *   1. <meta viewport>：maximum-scale / user-scalable
 *   2. CSS：html,body 的 touch-action **不能是 manipulation**
 *      （manipulation 等于 pan-x pan-y pinch-zoom，是把捏合明确允许给浏览器）
 *   3. JS：Safari 私有 gesture 事件 + 双指 touchmove 拦截
 *
 * 第 3 条是真正干活的那条：iOS Safari 从 iOS 10 起故意忽略 user-scalable=no
 * （无障碍政策），光靠 meta 在 iPhone 上等于没写。
 *
 * 为什么不开真浏览器：桌面 Chrome/Edge 没有「页面捏合缩放」这件事，
 * 开了也测不到 iOS 的行为。能测的是「拦截器有没有挂上、双指时有没有 preventDefault」，
 * 那部分交给 scripts/journey.js 的 [9d]（真派发事件、读 defaultPrevented）。
 */
'use strict';

const { readAll: readGameAll } = require('./helpers/gameSource');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');
const gameJs = readGameAll();

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

/* ------------------------------------------------------------------ */
console.log('\n[1] viewport meta：Android Chrome 认这一条');
/* ------------------------------------------------------------------ */

const vpMeta = (/<meta\s+name="viewport"\s+content="([^"]*)"/.exec(html) || [])[1] || '';
ok(!!vpMeta, 'index.html 有 viewport meta');
ok(/maximum-scale\s*=\s*1(\.0)?\b/.test(vpMeta),
  '★ viewport 写了 maximum-scale=1.0', vpMeta);
ok(/user-scalable\s*=\s*no/.test(vpMeta),
  '★ viewport 写了 user-scalable=no', vpMeta);
ok(/viewport-fit\s*=\s*cover/.test(vpMeta),
  'viewport-fit=cover 没有被这次改动挤掉（安全区还靠它）', vpMeta);
ok(/width\s*=\s*device-width/.test(vpMeta), 'width=device-width 仍在');

/* ------------------------------------------------------------------ */
console.log('\n[2] CSS：touch-action 不许再写 manipulation');
/* ------------------------------------------------------------------ */

/* 只取 html, body 那条规则里的 touch-action 声明。
 * 不能用「全文不含 pinch-zoom」来判 —— 注释里说明就写着 pinch-zoom 这个词，
 * 那种判法会因为注释而误报，正是这个项目里反复出现过的「断言测错了对象」。 */
const rootRule = (/html,\s*body\s*\{([\s\S]*?)\n\}/.exec(css) || [])[1] || '';
const rootTa = (/touch-action:\s*([^;]+);/.exec(rootRule) || [])[1] || '';
const rootTaNorm = rootTa.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim();

ok(!!rootTa, 'html,body 有 touch-action 声明');
ok(rootTaNorm === 'pan-x pan-y',
  '★ 根元素 touch-action 是 pan-x pan-y（不含 pinch-zoom）', '实际="' + rootTaNorm + '"');
ok(!/\bmanipulation\b/.test(rootTaNorm),
  '★ 明确不是 manipulation —— 它等于 pan-x pan-y pinch-zoom，会把捏合交还给浏览器',
  '实际="' + rootTaNorm + '"');
ok(!/pinch-zoom/.test(rootTaNorm),
  '★ touch-action 声明里没有 pinch-zoom', '实际="' + rootTaNorm + '"');

/* 拖拽区必须继续是 none：这轮改动不能把它们一起改松，否则手牌拖拽会退回「跟手差半拍」 */
ok(/\.card-wrap\s*\{[\s\S]*?touch-action:\s*none;/.test(css),
  '手牌 .card-wrap 仍 touch-action:none（拖拽要跟手）');
ok(/\.card-box\s*\{[\s\S]*?touch-action:\s*none;/.test(css),
  '组槽 .card-box 仍 touch-action:none');

/* ------------------------------------------------------------------ */
console.log('\n[3] JS：Safari 手势事件拦截（iPhone 上真正生效的那道）');
/* ------------------------------------------------------------------ */

const lockBody = (/function lockPageZoom\(\)\s*\{([\s\S]*?)\n  \}/.exec(gameJs) || [])[1] || '';
ok(!!lockBody, 'game.js 里存在 lockPageZoom()');

if (lockBody) {
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (name) {
    ok(lockBody.indexOf("'" + name + "'") >= 0,
      "★ 拦了 '" + name + "'（Safari 私有手势事件）");
  });

  /* passive:false 是硬要求：被动监听器里的 preventDefault 会被浏览器直接忽略，
   * 那样代码看着写了、实际一点用都没有 —— 是这个项目最容易被误判成"已修"的写法。 */
  const gestureBlock = (/\[[\s\S]*?\]\.forEach[\s\S]*?\}\);/.exec(lockBody) || [])[0] || '';
  ok(/passive:\s*false/.test(gestureBlock),
    '★ gesture 监听器是 passive:false（否则 preventDefault 无效）');

  ok(/touches\s*\.\s*length\s*>\s*1/.test(lockBody),
    '★ touchmove 只在双指及以上才拦（单指拖牌不受影响）');
  ok(/addEventListener\('touchmove'[\s\S]{0,120}passive:\s*false/.test(lockBody),
    '★ touchmove 监听器是 passive:false');

  /* 反向守一条：不许写「无条件 preventDefault 所有 touchmove」。
   * 那种写法能禁缩放，但会顺手把单指拖拽和点击一起搞坏。 */
  const unconditional = /touchmove'[\s\S]{0,160}?function\s*\(e\)\s*\{\s*e\.preventDefault\(\)/.test(lockBody);
  ok(!unconditional, '★ 没有无条件拦截所有 touchmove（只拦双指）');
}

ok(/lockPageZoom\(\);/.test(gameJs), '★ init 里真的调用了 lockPageZoom（不是定义完没人用）');

/* init 里调用，而不是等进对局页 —— 首页也能被捏合缩放的话，一进游戏就是放大状态 */
const initCallIdx = gameJs.indexOf('lockPageZoom();');
const initFnIdx = gameJs.lastIndexOf('function init()', initCallIdx);
ok(initFnIdx >= 0, 'lockPageZoom() 的调用点在 init() 内部');

/* ------------------------------------------------------------------ */
console.log('\n' + '='.repeat(60));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('='.repeat(60));
if (fail > 0) process.exit(1);
