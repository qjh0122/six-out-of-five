/**
 * 弹窗无障碍测试（纯静态解析，不开浏览器）
 * 跑法：node pwa/test/modal-a11y.test.js
 *
 * 守的是「15 个弹窗对键盘和读屏用户是否真的存在」这件事。三块：
 *   1. 语义：每个 .modal 都有 role="dialog" / aria-modal="true" / aria-labelledby，
 *      且 labelledby 指的 id 在 HTML 里真实存在（指向一个不存在的 id = 读屏念不出名字，
 *      比不写还糟：看起来做了，实际是个哑弹窗）。
 *   2. 入口：所有弹窗的显示/隐藏都必须走 showModalEl / hideModalEl。
 *      绕过它们直接 classList.remove('hidden') 的写法会让焦点进出失效，
 *      而这种失效在界面上完全看不出来，只能靠扫源码守住。
 *   3. 焦点：打开时记 activeElement、关闭时还回去（元素不在 DOM 里就放弃）、
 *      Tab 在弹窗内循环、Esc 的既有优先级没有被打乱。
 *
 * 为什么不开真浏览器：这些都能从源码里确定。真浏览器要验的「焦点真的动了」
 * 交给 scripts/journey.js（它跑完整旅途，弹窗焦点一旦搞挂流程就会红）。
 */
'use strict';

const { readAll: readGameAll, readOne: readGameOne } = require('./helpers/gameSource');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const gameJs = readGameAll();

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

/* ---------- 解析 HTML 里所有 .modal 的开标签 ----------
 * 注意不能按行匹配：加了无障碍属性之后开标签折成了两行。
 * `<div\b[^>]*>` 里的 `[^>]` 是包含换行的，所以能跨行吃到整个标签。 */
const modalTags = [];
const tagRe = /<div\b[^>]*\bid="([a-z-]+-modal)"[^>]*>/g;
let m;
while ((m = tagRe.exec(html)) !== null) {
  if (!/class="[^"]*\bmodal\b/.test(m[0])) continue;   // 只要带 .modal 的
  modalTags.push({ id: m[1], tag: m[0] });
}

console.log('\n[弹窗清单]');
console.log('  HTML 里 ' + modalTags.length + ' 个：' + modalTags.map(function (t) { return t.id; }).join(', '));
/* 17 个：
 *   · #seat-sheet **故意不是 .modal**（v89 起它取代了居中弹窗式的表情面板）——
 *     .modal 是 fixed 全屏居中的，而这张必须贴着被点的人定位；
 *     它自己带 role="dialog"、aria-label、Esc 关闭与遮罩，不参与这套 .modal 清点。
 *   · #avatar-modal（换头像）与 #round-break-modal（轮次交替卡，v89 §13.2）
 *     都是标准居中弹窗，正常计入。
 *   · #create-modal（建房先选本局局数，v101）同样计入 —— 它虽然只在首页出现，
 *     但焦点进出、Tab 圈定、Esc 关闭跟其它弹窗一视同仁。 */
ok(modalTags.length === 17, '一共 17 个 .modal（实际 ' + modalTags.length + ' 个）');

/* ---------- 1. 语义 ---------- */
console.log('\n[1] 对话框语义：每个弹窗都要有 role / aria-modal / aria-labelledby]');
modalTags.forEach(function (t) {
  ok(/\brole="dialog"/.test(t.tag), t.id + ' 有 role="dialog"', t.tag.replace(/\s+/g, ' '));
  ok(/\baria-modal="true"/.test(t.tag), t.id + ' 有 aria-modal="true"');
  const lb = /\baria-labelledby="([^"]+)"/.exec(t.tag);
  ok(!!lb, t.id + ' 有 aria-labelledby（否则读屏念不出它叫什么）');
  if (lb) {
    /* 目标必须真实存在，且只能有一份 —— 重名 id 会让可访问名取决于浏览器怎么挑 */
    const hits = (html.match(new RegExp('id="' + lb[1] + '"', 'g')) || []).length;
    ok(hits === 1, t.id + ' 的 aria-labelledby 指向的 #' + lb[1] + ' 存在且唯一',
      '命中 ' + hits + ' 次');
  }
});

ok(!/aria-label="[^"]*弹窗/.test(html), '没有拿手写的 aria-label 糊对话框名字（一律走 labelledby 指标题元素）');

/* ---------- 2. 入口收敛 ---------- */
console.log('\n[2] 开关入口：不许绕过 showModalEl / hideModalEl');
ok(/function showModalEl\(/.test(gameJs), '有 showModalEl');
ok(/function hideModalEl\(/.test(gameJs), '有 hideModalEl');

/* 直接 classList.remove('hidden') 打开弹窗 = 焦点进出全部失效，而界面看不出来 */
const directOpen = gameJs.match(/\$\('#[a-z-]+-modal'\)\.classList\.remove\('hidden'\)/g) || [];
ok(directOpen.length === 0, '★ 没有任何地方直接 classList.remove(\'hidden\') 打开弹窗',
  directOpen.join(' / '));
const directOpen2 = gameJs.match(/getElementById\('[a-z-]+-modal'\)\.classList\.remove\('hidden'\)/g) || [];
ok(directOpen2.length === 0, '★ 也没有用 getElementById 绕过（同一个意思，别漏）', directOpen2.join(' / '));

/* 关闭侧允许 classList.add('hidden')：hideModalEl 内部就是它，没有别处该有。 */
const viaShow = (gameJs.match(/showModalEl\('/g) || []).length;
const viaHide = (gameJs.match(/hideModalEl\('/g) || []).length;
ok(viaShow >= 12, 'showModalEl 至少被 12 处调用（每个弹窗都要走它，实际 ' + viaShow + ' 处）');
ok(viaHide >= 12, 'hideModalEl 至少被 12 处调用（实际 ' + viaHide + ' 处）');

/* ---------- 3. 焦点 ---------- */
console.log('\n[3] 焦点进出');
ok(/document\.activeElement/.test(gameJs), '打开时记下当前焦点（document.activeElement）');
ok(/modalReturnStack/.test(gameJs), '★ 归还目标用栈存（改密码叠在账号卡上，只存一个变量会把外层那层冲掉）');
ok(/document\.body\.contains\(mine\.el\)/.test(gameJs),
  '★ 归还前确认目标还在 DOM 里（不在就安静放弃，不许为了还焦点抛错）');
ok(/querySelector\('\[data-autofocus\]'\)/.test(gameJs), '打开时优先 [data-autofocus]，其次第一个可聚焦元素');

/* 嵌套关闭：下层还开着时焦点必须搬进「剩下那层」。
 * 反面做法是原地不动 —— 元素被加上 hidden 之后浏览器不会主动交还焦点，
 * 焦点就挂在一个已经看不见的按钮上。这个失效在界面上完全看不出来，
 * 只有键盘用户下一次 Tab 从「虚空」开始数的时候才会察觉，所以只能静态守住。 */
const hideBody = (/function hideModalEl\(id\) \{[\s\S]*?\r?\n  \}/.exec(gameJs) || [''])[0];
ok(hideBody.length > 0, '★ 能定位到 hideModalEl 的函数体（否则下面几条都是空转）');
ok(!/if \(topModalId\(\)\) return;/.test(hideBody),
  '★ 不再「下层还开着就原地 return」（那样焦点会留在刚被隐藏的按钮上）');
const belowBlock = (/if \(below\) \{([\s\S]*?)\r?\n    \}/.exec(hideBody) || [''])[0];
ok(belowBlock.length > 0, '★ 下层还开着时走单独分支，且用变量接住 topModalId() 的结果');
if (belowBlock) {
  ok(/querySelector\('\[data-autofocus\]'\)/.test(belowBlock),
    '★ 焦点交给剩下那层时同样 [data-autofocus] 优先');
  ok(/modalFocusables\(box\)/.test(belowBlock), '其次取剩下那层里第一个可聚焦元素');
  ok(/focusEl\(into\)/.test(belowBlock), '★ 真的把焦点搬进去，不是只算出来不用');
  ok(/\breturn;/.test(belowBlock), '搬完就 return，不再往下走「还回背景」那条路');
  ok(!/modalReturnStack\.length = 0/.test(belowBlock),
    '★ 嵌套路径不许清空归还栈（外层那层的归还目标还要留着，等它自己关掉时用）');
}

/* 注意 §换行：仓库里 game.js 是 CRLF（core.autocrlf=true），所以下面凡是跨行匹配
 * 的地方一律写 \r?\n —— 只写 \n 会在 CRLF 文件上一个都匹配不到，而那种失败
 * 长得像「代码没写」，最容易被误判。 */
/* ★ 这一条必须指名读 modalKit.js，不能读拼接后的全文：
 * game.js 里也有一行 `var MODAL_FOCUSABLE = Modal.MODAL_FOCUSABLE, ...`（解构别名），
 * 而拼接时 game.js 排在最前面 —— 于是正则抓到的是那行别名，sel 取出来是
 * 「Modal.MODAL_FOCUSABLE, MODAL_ORDER = ...」，下面三条包含性断言必然全红。
 * 这也说明「读哪个文件」本身就是断言的一部分：可聚焦选择器该定义在弹窗模块里。 */
const modalSrc = readGameOne('modalKit.js');
const focusableConst = /var MODAL_FOCUSABLE = ([\s\S]*?);\r?\n/.exec(modalSrc);
ok(!!focusableConst, '可聚焦选择器抽成了 MODAL_FOCUSABLE 常量（测试要能定位它）');
if (focusableConst) {
  const sel = focusableConst[1];
  ok(/button:not\(\[disabled\]\)/.test(sel), 'MODAL_FOCUSABLE 覆盖 button（排除 disabled）');
  ok(/input:not\(\[disabled\]\)/.test(sel), 'MODAL_FOCUSABLE 覆盖 input');
  ok(/\[tabindex\]:not\(\[tabindex="-1"\]\)/.test(sel),
    'MODAL_FOCUSABLE 覆盖 [tabindex]（排除 -1）', sel);
}
ok(/closest\('\.hidden'\)/.test(gameJs), '圈定时滤掉处在 .hidden 容器里的元素（解散弹窗三个按钮轮流藏两个）');

ok(/id="btn-confirm-cancel"[^>]*data-autofocus/.test(html),
  '★ 通用确认框默认焦点落在「取消」上（这里也挂着删号，不能让一个回车把数据删了）');
ok(/confirmNeedSecret\) sec\.setAttribute\('data-autofocus'/.test(gameJs),
  '★ 要输密码时把默认焦点改到密码框上');

/* ---------- 4. Tab 圈定 ---------- */
console.log('\n[4] Tab 圈定');
ok(/if \(e\.key !== 'Tab'\) return;/.test(gameJs), '有 Tab 键的拦截');
ok(/var id = topModalId\(\);/.test(gameJs), '用 topModalId() 判断「当前最上层那个弹窗」');
ok(/var list = modalFocusables\(\$\('#' \+ id\)\);/.test(gameJs), '在那一层的可聚焦元素之间循环');
ok(/e\.shiftKey[\s\S]{0,400}focusEl\(last\)/.test(gameJs), 'Shift+Tab 到第一个时回卷到最后一个');
ok(/\}, true\);\s*\n\s*\/\*|focusEl\(first\)[\s\S]{0,200}\}, true\);/.test(gameJs),
  '监听挂在 capture 阶段（输入框自己处理按键时 Tab 仍要先过这里）');
ok(/if \(idx < 0 \|\| idx === list\.length - 1\)/.test(gameJs),
  '★ 焦点不在弹窗里时（刚打开 / 用户点了背景）也接住，一个 Tab 就拉回来');

/* ---------- 5. 叠层顺序 ---------- */
console.log('\n[5] 叠层顺序与 Esc 优先级');
const orderMatch = /var MODAL_ORDER = \[([\s\S]*?)\];/.exec(gameJs);
ok(!!orderMatch, '能定位到 MODAL_ORDER（Esc 关闭与 Tab 圈定共用这一份判断）');
const orderIds = orderMatch
  ? (orderMatch[1].match(/'([a-z-]+)'/g) || []).map(function (s) { return s.replace(/'/g, ''); })
  : [];
modalTags.forEach(function (t) {
  ok(orderIds.indexOf(t.id) >= 0, t.id + ' 已登记在 MODAL_ORDER 里（否则它开着时 Tab 圈不住）');
});
ok(orderIds.indexOf('pwd-modal') < orderIds.indexOf('account-modal'),
  '★ pwd 排在 account 之前（改密码叠在账号卡上，它才是那一层）');

/* Esc 的既有优先级必须原样：profile → rename → clear → confirm → guide → replay → rules */
const escBody = (/\/\/ Esc \/ 移动端返回键关闭弹窗[\s\S]*?\r?\n    \}\);/.exec(gameJs) || [''])[0];
ok(escBody.length > 0, '能定位到 Esc 处理函数');
const escOrder = ['closeProfile', 'closeRename', 'closeClearModal', 'closeConfirm',
  'closeGuide', 'closeReplay', 'rules-modal'];
let lastAt = -1, escOk = true;
escOrder.forEach(function (k) {
  const at = escBody.indexOf(k);
  if (at < 0 || at < lastAt) escOk = false;
  lastAt = at;
});
ok(escOk, '★ Esc 关闭顺序与改动前一致（这一段既有的优先级一点没动）');
ok(/if \(!\$\('#pwd-modal'\)\.classList\.contains\('hidden'\)\) \{ closePwdModal\(\); return; \}/.test(escBody),
  '★ 补上了：Esc 能关改密码（键盘用户以前只能去找按钮）');
/* v89 起这一条后面多了一句 return：结算弹窗与交替卡也进了 Esc 链，
 * 账号卡不 return 就会继续往下走到「按 Esc = 下一幕结算」那一支。 */
ok(/if \(!\$\('#account-modal'\)\.classList\.contains\('hidden'\)\) \{ closeAccount\(\); return; \}/.test(escBody),
  '★ 补上了：Esc 能关账号卡');
ok(escBody.indexOf('closePwdModal') < escBody.indexOf('closeAccount'),
  'pwd 先于 account 被关（只加不删，且顺序对得上叠层）');

console.log('\n[6] 自动弹出的两层也一样走统一入口');
ok(/showModalEl\('result-modal'\)/.test(gameJs), '#result-modal 用 showModalEl（每轮结算后自动弹，不是特例）');
ok(/showModalEl\('dissolve-modal'\)/.test(gameJs), '#dissolve-modal 用 showModalEl（别人发起解散时自动弹）');
ok(/hideModalEl\('dissolve-modal'\)/.test(gameJs), '#dissolve-modal 的关闭也都走 hideModalEl（含结算页兜底关一次）');

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
