/**
 * config.js 与 engine.js 的双端同源（P1-10）
 * 跑法：node pwa/test/config-sync.test.js
 *
 * README 承诺「改数值只改 pwa/js/config.js（服务端通过同一份文件读取，双端同源）」。
 * 但 config.js 里同步数值的那段代码只找 `global.Engine`，而 engine.js 是
 * IIFE + module.exports，**在 Node 下不会挂到 global**。结果：
 *   浏览器  → 用 config.js 里的新数值
 *   服务端  → 仍用 engine.js 的内置默认值
 * 同一局牌，前端算出赢 3 分、服务端记 1 分。两边的值当时恰好相同，所以没暴露。
 *
 * 这里用「先破坏、看能不能被配置纠正回来」的方式验证，而不是简单比较两个相等
 * 的数字——否则默认值本来就相等，断言等于空转。
 */
'use strict';

const path = require('path');
const ENGINE_PATH = path.join(__dirname, '..', 'js', 'engine.js');
const CONFIG_PATH = path.join(__dirname, '..', 'js', 'config.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

/* ========================================================================== */
console.log('\n[1] 刚 require 完，两边数值就该一致');
const Engine = require(ENGINE_PATH);
const CONFIG = require(CONFIG_PATH);

eq(Engine.CONFIG.INITIAL_SCORE, CONFIG.INITIAL_SCORE, 'INITIAL_SCORE 一侧');
eq(Engine.CONFIG.DOUNIU_NONE_PENALTY, CONFIG.DOUNIU_NONE_PENALTY, 'DOUNIU_NONE_PENALTY 一侧');
eq(Engine.CONFIG.PIAOSANYE_LEOPARD_BONUS, CONFIG.PIAOSANYE_LEOPARD_BONUS, 'PIAOSANYE_LEOPARD_BONUS 一侧');
const keys = Object.keys(CONFIG.DOUNIU_WIN_POINTS);
let objSame = true;
for (const k of keys) {
  if (Engine.CONFIG.DOUNIU_WIN_POINTS[k] !== CONFIG.DOUNIU_WIN_POINTS[k]) objSame = false;
}
ok(objSame, 'DOUNIU_WIN_POINTS 每个键都一致（嵌套对象也要同步）');

/* ========================================================================== */
console.log('\n[2] ★ 核心：先破坏引擎里的值，再重新加载 config，必须被纠正回来');
/* 这一条才是真正在验「同步那段代码跑到了」。
 * 只比相等的话，默认值本来就相等，改了也发现不了。 */
const ORIGINAL = Engine.CONFIG.INITIAL_SCORE;
Engine.CONFIG.INITIAL_SCORE = 999999;
Engine.CONFIG.DOUNIU_WIN_POINTS.NIUNIU = 999999;
eq(Engine.CONFIG.INITIAL_SCORE, 999999, '已人为破坏引擎侧数值');

delete require.cache[require.resolve(CONFIG_PATH)];
require(CONFIG_PATH);                     // 重新跑一遍 config.js

eq(Engine.CONFIG.INITIAL_SCORE, ORIGINAL, '★ 重新加载 config 后 INITIAL_SCORE 被纠正回来');
eq(Engine.CONFIG.DOUNIU_WIN_POINTS.NIUNIU, CONFIG.DOUNIU_WIN_POINTS.NIUNIU, '★ 嵌套对象也被纠正回来');

/* ========================================================================== */
console.log('\n[3] 浏览器那条路不能被改动带坏');
/* 模拟浏览器：把 Engine 挂到 global，清掉缓存再加载 config，同步也要发生。 */
delete require.cache[require.resolve(CONFIG_PATH)];
Engine.CONFIG.TENHALF_WIN = 999999;
global.Engine = Engine;
require(CONFIG_PATH);
eq(Engine.CONFIG.TENHALF_WIN, CONFIG.TENHALF_WIN, 'global.Engine 分支仍然有效');
delete global.Engine;

/* ========================================================================== */
console.log('\n[4] 结算真的会用这些数值（不是只同步了个摆设）');
/* 用 2 人局真跑一局十点半，检查赢家收的分数等于 CONFIG 里的值。
 * 这里只验数值链路通不通，具体规则由 rules.test.js 覆盖。 */
eq(Engine.CONFIG.TENHALF_WIN, CONFIG.TENHALF_WIN, '十点半普通赢分一致');
eq(Engine.CONFIG.TENHALF_MAX_WIN, CONFIG.TENHALF_MAX_WIN, '十点半 10.5 赢分一致');
eq(Engine.CONFIG.SINGLE_WIN, CONFIG.SINGLE_WIN, '单张赢分一致');

const cfgCopy = JSON.parse(JSON.stringify(Engine.CONFIG));
ok(Object.keys(cfgCopy).length > 5, '引擎侧配置项齐全（' + Object.keys(cfgCopy).length + ' 项）');

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
