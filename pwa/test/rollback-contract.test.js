/**
 * 回滚契约（R6）
 *
 * 这份测试守的不是某个功能，而是**「出事时能不能退回去」这件事本身**。
 *
 * 为什么单独一份：功能测试都会红，但它们是「功能坏了」的红；
 * 回滚能力坏掉时**所有功能测试照样全绿** —— 功能好好的，只是关不掉了。
 * 而它恰恰只在出事那天才被用上，届时没有时间查。
 *
 * 守四条：
 *   1. `config.js` 的「功能开关」区块里每一个键，都要有**运行时覆盖**
 *      （`?xxx=0/1`）与**统一的判定函数**。少一个 = 灰度期只能改文件重发。
 *   2. 判定函数只认 `0` / `1`，其余按 `CONFIG` 走 —— 一个笔误不该关掉功能。
 *   3. **不许有绕过**：运行时判断只能走判定函数，不能直接读 `CONFIG.XXX`
 *      （绕过就会出现「开关只关了一半」）。
 *   4. 回滚演练脚本覆盖得到这些组合（开关单关、两个都关、非法值）。
 *
 * 第 1 条是通用扫描而不是逐个写死 —— 以后再加开关，忘了加覆盖会直接红。
 */
'use strict';

const { readAll: readGameAll } = require('./helpers/gameSource');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const CFG = read('js/config.js');
const GAME = readGameAll();
const PROBE = fs.readFileSync(path.join(ROOT, '..', 'scripts', 'probe-rollback.js'), 'utf8');

/* config.js 的「功能开关」区块：从注释标记到 UI 设计分辨率之前。
 * 这一段里每一个 `KEY: true/false` 都是一个承诺「能一行翻回去」的开关。 */
function switchKeys(src) {
  const start = src.indexOf('功能开关');
  const end = src.indexOf('DESIGN_WIDTH');
  if (start < 0 || end < 0 || end < start) return [];
  const block = src.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const keys = [];
  const re = /(^|\n)\s*([A-Z][A-Z0-9_]*)\s*:\s*(true|false)\s*,?/g;
  let m;
  while ((m = re.exec(block))) keys.push(m[2]);
  return keys;
}

function toCamel(key) {
  return key.toLowerCase().replace(/_([a-z0-9])/g, (s, c) => c.toUpperCase());
}

const KEYS = switchKeys(CFG);

console.log('\n[1] 功能开关区块本身');
ok(KEYS.length >= 2, 'config.js 里能识别出功能开关（' + KEYS.length + ' 个：' + KEYS.join(', ') + '）');
ok(KEYS.indexOf('TABLE_READY') >= 0, '有 TABLE_READY（R2 的回滚开关）');
ok(KEYS.indexOf('EMOJI') >= 0, '有 EMOJI（R4 的回滚开关）');

console.log('\n[2] 每个开关都要有「运行时覆盖 + 统一判定函数」');
KEYS.forEach((key) => {
  const fn = toCamel(key) + 'Flag';
  const qs = key.toLowerCase().replace(/_/g, '');
  ok(new RegExp('function ' + fn + '\\s*\\(').test(GAME),
    key + ' → ' + fn + '() 存在（灰度期不改文件也能验老路径）');
  ok(GAME.indexOf("get('" + qs + "')") >= 0,
    key + ' 支持 ?' + qs + '=0/1（与其它开关同一套说法）');
});

console.log('\n[3] 判定函数只认 0/1，其余按 CONFIG 走');
KEYS.forEach((key) => {
  const fn = toCamel(key) + 'Flag';
  /* 窗口 700 → 1600：seatRingFlag 在 v88 多了两道高度闸门（竖屏矮屏 / 横屏高度），
   * 函数体长了一倍。窗口只用来「把函数体截出来」，放宽不影响下面几条断言的强度 ——
   * 认 0 / 认 1 / 兜底 CONFIG 三条仍然必须逐字命中。 */
  const m = GAME.match(new RegExp('function ' + fn + '\\s*\\([\\s\\S]{0,1600}?\\n  \\}'));
  const body = m ? m[0] : '';
  ok(body.length > 0, fn + ' 能定位到函数体');
  ok(/=== '0'\)\s*return false/.test(body), fn + " 认 0 → 关");
  ok(/=== '1'\)\s*return true/.test(body), fn + " 认 1 → 开");
  /* 最后一行必须是「回到 CONFIG」。写成 `return true` 就等于开关永久失效
   * —— 而所有功能测试照样绿，因为功能是开的。 */
  ok(/return (CONFIG\.[A-Z_]+|!!CONFIG\.[A-Z_]+)/.test(body),
    fn + ' 兜底回到 CONFIG（否则开关变成永久失效）');
});

console.log('\n[4] 不许绕过：运行时判断只能走判定函数');
/** 剥掉注释再数。注释里提开关名是好事（说明有文档），不该算违规；
 *  只有**代码里**直接读 `CONFIG.XXX` 才是「开关只关了一半」。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}
const CODE = stripComments(GAME);
KEYS.forEach((key) => {
  /* 只允许出现在判定函数自己的兜底行里。其它任何地方直接读 CONFIG.XXX
   * 都会让 ?xxx=0 在那一处不生效 —— 表现就是「开关只关了一半」。 */
  const hits = CODE.match(new RegExp('CONFIG\\.' + key, 'g')) || [];
  const allowed = 1;   // 判定函数里那一处
  ok(hits.length <= allowed,
    key + ' 没有被别处直接读取（代码里 ' + hits.length + ' 处 ≤ ' + allowed + '）',
    hits.length > allowed ? '多出来的那处没走判定函数，?=0 在它上面不生效' : '');
});

console.log('\n[5] 回滚演练脚本覆盖得到「交叉组合」');
ok(/tableready=0/.test(PROBE), '演练脚本会关 TABLE_READY');
ok(/&emoji=0/.test(PROBE), '演练脚本会关 EMOJI');
ok(/tableready=0&emoji=0/.test(PROBE), '★ 演练两个都关（「回到两个功能都没上线」才是真实回滚动作）');
ok(/emoji=abc/.test(PROBE), '★ 演练非法值（笔误不该关掉功能）');
ok(/probe-pal/.test(PROBE) && /sendEmoji/.test(PROBE),
  '★ 关掉之后从另一头注入一条 —— 验「收」那一路，不只是验按钮没了');

console.log('\n[6] 两个开关是正交的（管两件事，不互相牵连）');
ok(/tableReadyFlag\(\)/.test(GAME) && /emojiFlag\(\)/.test(GAME),
  '两套判定各自独立');
/* 关掉一个不许顺手关另一个：判定函数体里不许出现对方的判定 */
{
  const tr = GAME.match(/function tableReadyFlag\s*\([\s\S]{0,400}?\n  \}/);
  const em = GAME.match(/function emojiFlag\s*\([\s\S]{0,400}?\n  \}/);
  ok(tr && !/emojiFlag|CONFIG\.EMOJI/.test(tr[0]), 'tableReadyFlag 里不碰表情开关');
  ok(em && !/tableReadyFlag|CONFIG\.TABLE_READY/.test(em[0]), 'emojiFlag 里不碰准备态开关');
}

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) process.exitCode = 1;
