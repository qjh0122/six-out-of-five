/**
 * 渲染守卫：数据异常时不要在页面上显示内部字面量（BACKLOG C6）
 *
 * 三处已知问题：
 *   ① esc(undefined) 走 String(undefined) → 页面上出现「undefined」
 *   ② 结算行 p.nickname + '（弃局）' → 昵称为 null 时显示「null（弃局）」
 *   ③ myId 为空串时 '玩家' + ''.slice(-4) → 一圈人都叫光秃秃的「玩家」
 *
 * 这三条的共同点：**只在数据异常时出现**，所以手工测不出来，
 * 一旦出现又特别难看（玩家会以为游戏坏了）。
 * 所以测试方式是把 esc 从源码里取出来单独跑 —— 它必须是纯函数，
 * 只有纯函数才可能在没有 DOM 的情况下验证。
 */
'use strict';

const { readAll: readGameAll } = require('./helpers/gameSource');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const gameJs = readGameAll();

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

/* ---------------- 从源码取出 esc / defaultNick 单独执行 ---------------- */
function grab(name) {
  const re = new RegExp('function ' + name + '\\(s?\\)?[\\s\\S]*?\\n  \\}');
  const m = re.exec(gameJs);
  return m ? m[0] : null;
}

console.log('\n[esc：null / undefined 不再变成字面量]');
const escSrc = (gameJs.match(/function esc\(s\) \{[\s\S]*?\n  \}/) || [])[0];
ok(!!escSrc, '能从源码里取出 esc（它必须是独立纯函数，否则这里取不到）');
let esc = null;
if (escSrc) {
  // eslint-disable-next-line no-new-func
  esc = new Function(escSrc + '; return esc;')();
}
if (esc) {
  eq(esc(undefined), '', 'undefined → 空串');
  eq(esc(null), '', 'null → 空串');
  eq(esc(''), '', '空串保持空串');
  eq(esc(0), '0', '数字 0 仍然显示 0（不能被 falsy 判断误吞）');
  eq(esc(false), 'false', 'false 仍然显示 false');
  eq(esc('<b>&"\'</b>'), '&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;', '危险字符仍然转义（安全功能没被改坏）');
  eq(esc('张三'), '张三', '中文原样输出');
}

console.log('\n[defaultNick：没有身份时叫「我」，不是光秃秃的「玩家」]');
ok(/function defaultNick\(\)/.test(gameJs), '存在统一的 defaultNick()');
const nickSrc = (gameJs.match(/function defaultNick\(\) \{[\s\S]*?\n  \}/) || [])[0];
ok(!!nickSrc, '能取出 defaultNick');
if (nickSrc) {
  const make = (myId) => {
    const state = { myId };
    // eslint-disable-next-line no-new-func
    return new Function('state', nickSrc + '; return defaultNick;')(state);
  };
  eq(make('abc12345')(), '玩家2345', '有 id 时取后四位');
  eq(make('')() !== '玩家', true, '空 id 不能退化成「玩家」');
  eq(make('')(), '我', '空 id 显示「我」');
  eq(make(undefined)(), '我', 'id 未定义也不炸');
}

console.log('\n[调用点：不再各自拼 myId.slice(-4)]');
eq(/state\.myId\.slice\(-4\)/.test(gameJs), false, '没有裸露的 state.myId.slice(-4)（空 id 会直接抛错）');
ok(gameJs.indexOf("('玩家' + String(state.myId || '').slice(-4) || '')") === -1, '删掉了「三者都空就当空串」的表达式');
ok(/readNickname[\s\S]{0,400}defaultNick\(\)/.test(gameJs), 'readNickname 用 defaultNick()');
ok(/\$\('#nickname-input'\)\.value = nick \|\| defaultNick\(\)/.test(gameJs), '首屏回填也用 defaultNick()');

console.log('\n[结算行：昵称为空时不出现「null（弃局）」]');
ok(gameJs.indexOf("p.nickname + (p.left ? '（弃局）' : '')") === -1, '结算名不再直接拼 p.nickname');
ok(/\(p\.nickname \|\| '\?'\) \+ tag/.test(gameJs), '结算名有空值兜底（标记抽成 tag，仍有 ?  兜底）');
/* v83：出局（out）与弃局（left）必须分开说。
 * 只用一句「（弃局）」会在见底的人身上说谎 —— 他没走，是被打穿的。 */
ok(/p\.left \? '（弃局）' : \(p\.out \? '（见底）' : ''\)/.test(gameJs), '★ 弃局与见底是两个标记');
ok(/var name = p \? \(p\.nickname \|\| '\?'\) : \(en\.id \|\| '\?'\)/.test(gameJs), '结算明细行有空值兜底');

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail === 0 ? 0 : 1);
