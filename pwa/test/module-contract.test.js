/**
 * 模块契约守卫 —— 拆分后的「接口对得上吗」
 *
 * ── 为什么要有这个文件 ────────────────────────────────────────────────
 * game.js 拆成 8 个模块之后，两边靠两条隐形约定咬合：
 *
 *   ① 模块把名字挂出去（`api.xxx = xxx` / 工厂 `return {...}`）
 *   ② game.js 把名字解构进来（`var xxx = NS.xxx`，或当依赖对象传进去）
 *
 * 这两条**任何一边漏一个名字，都不会有编译错误**：读到的就是 undefined，
 * 直到用户点了那个按钮才炸成 `TypeError: xxx is not a function`，
 * 而报错只进控制台 —— 界面上看就是「点了没反应」。
 *
 * 这不是假设，真发生过：modalKit.js 的导出块整块丢过一次，`api` 成了空对象。
 * `npm test` 当时 **4463 条断言全绿**，因为源码级断言只认
 * `/function showModalEl\(/` 这种文本，而函数体一个不少地待在那里；
 * 探针一跑，建房/账号/规则/战绩……**所有弹窗全哑**。
 *
 * 所以这个文件的立场是：**不查源码写了什么，查两边接得上吗。**
 *
 * ── 三条断言 ──────────────────────────────────────────────────────
 * 1. 8 个模块都能在严格模式下加载（裸赋值 `X = 1` 少写 var 会在这里炸，
 *    而 `node --check` 只查语法，查不出来）
 * 2. 每个工厂能创建，导出不是空对象
 * 3. game.js 里每一个 `NS.key` 读到的名字，模块里真的有 —— **这条是核心**
 *
 * 第 3 条排在正确的层级：它不关心名字是在哪个函数里定义的、缩进几格、
 * 是不是 `api.x = function` 形式。它只问「解构出来的东西存在吗」。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS = path.join(__dirname, '..', 'js');
const GAME = path.join(JS, 'game.js');

let pass = 0;
let fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

/* ---------------------------- 一个够用的浏览器桩 ----------------------------
 * 模块只在**加载**和**工厂创建**阶段跑，DOM 交互全在函数体里，所以这个桩
 * 只需要让顶层那几行跑完。故意做得薄：桩越厚，越容易把「真的读不到 DOM」
 * 掩盖成「桩没写全」。 */
const noop = function () {};
function mkEl() {
  return {
    style: {}, dataset: {}, children: [], parentNode: null,
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    appendChild: (c) => c, removeChild: noop, remove: noop, insertBefore: noop,
    setAttribute: noop, getAttribute: () => null, removeAttribute: noop, hasAttribute: () => false,
    addEventListener: noop, removeEventListener: noop,
    querySelector: () => mkEl(), querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }),
    focus: noop, blur: noop, click: noop,
    innerHTML: '', textContent: '', value: '', checked: false,
    offsetWidth: 0, offsetHeight: 0, offsetTop: 0,
    scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    firstChild: null, firstElementChild: null, nextSibling: null,
  };
}

function makeHost() {
  const documentStub = {
    body: mkEl(), documentElement: mkEl(), head: mkEl(), activeElement: mkEl(),
    getElementById: () => mkEl(), querySelector: () => mkEl(), querySelectorAll: () => [],
    createElement: () => mkEl(), createDocumentFragment: () => mkEl(),
    addEventListener: noop, removeEventListener: noop,
    hidden: false, visibilityState: 'visible',
  };
  const host = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: noop,
    document: documentStub,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    navigator: { userAgent: 'node', language: 'zh-CN', vibrate: noop, clipboard: { writeText: () => Promise.resolve() } },
    location: { href: 'http://localhost/', search: '', hash: '', origin: 'http://localhost' },
    matchMedia: () => ({ matches: false, addEventListener: noop, addListener: noop }),
    Image: function () { return mkEl(); },
    Audio: function () { return { play: () => Promise.resolve(), pause: noop, load: noop, addEventListener: noop, removeEventListener: noop, volume: 1 }; },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  };
  host.window = host;
  host.self = host;
  host.globalThis = host;
  return vm.createContext(host);
}

/* 依赖文件按 index.html 的顺序，先于 8 个模块加载 —— 否则工厂创建时
 * 读不到真的 CONFIG / Engine / Card，会把「漏注入」误报成「桩不够」。 */
const DEPS = ['errorReport.js', 'engine.js', 'card.js', 'config.js', 'emoji.js', 'stateMachine.js',
  'authStore.js', 'roomStore.js', 'records.js', 'sessionLog.js', 'sfx.js', 'slotLayout.js',
  'avatar.js', 'ringGate.js', 'seatRing.js'];

/* 8 个被拆出来的模块。前两个 / 三个是立即执行（挂到 window.LXW），其余是工厂。 */
const MODULES = ['gameUtils.js', 'modalKit.js', 'cardView.js', 'historyKit.js',
  'accountView.js', 'settleView.js', 'seatSheetView.js', 'recordsView.js'];

/* game.js 里指向模块的命名空间变量名 → 模块键名。
 * 新增一个模块时这里加一行，忘了加的话下面的「每个 LXW 引用都被覆盖」断言会红。 */
const NAMESPACES = {
  U: 'utils',
  CardView: 'cardView',
  Modal: 'modalKit',
  History: 'historyKit',
  Account: 'accountView',
  Settle: 'settleView',
  Seat: 'seatSheetView',
  Records: 'recordsView',
};

const host = makeHost();

console.log('[1] 8 个模块加载（严格模式，裸赋值会在这里炸）');
{
  let loaded = 0;
  DEPS.concat(MODULES).forEach((f) => {
    const p = path.join(JS, f);
    if (!fs.existsSync(p)) { ok(false, f + ' 存在'); return; }
    try {
      vm.runInContext(fs.readFileSync(p, 'utf8'), host, { filename: f });
      loaded += 1;
    } catch (e) {
      ok(false, f + ' 能加载', e.name + ': ' + e.message);
    }
  });
  ok(loaded === DEPS.length + MODULES.length, '全部 ' + (DEPS.length + MODULES.length) + ' 个文件加载成功（实际 ' + loaded + '）');
}

console.log('\n[2] 工厂能创建，导出不是空对象');
/* ★ 查契约必须查**创建出来的实例**，不是工厂函数本身：
 *   工厂是个函数，它身上本来就没有 HAND_CARD_W 之类的属性，
 *   拿它当命名空间查会把「接得上」全部判成「接不上」。 */
const RESOLVED = { utils: host.LXW.utils, modalKit: host.LXW.modalKit };
{
  const deps = {
    cardView: { stageScale: () => 1, onHandCardTap: noop },
    historyKit: { state: {}, getMe: () => null, recordsPid: () => '', flash: noop },
    accountView: {}, settleView: {}, seatSheetView: {}, recordsView: {},
  };
  Object.keys(deps).forEach((k) => {
    const fn = host.LXW[k];
    if (typeof fn !== 'function') { ok(false, 'LXW.' + k + ' 是工厂函数'); return; }
    let out = null;
    try { out = fn(deps[k]); } catch (e) { ok(false, 'LXW.' + k + '() 能创建', e.message); return; }
    const n = out ? Object.keys(out).length : 0;
    ok(n > 0, 'LXW.' + k + '() 导出非空（' + n + ' 项）');
    RESOLVED[k] = out;
  });
  ['utils', 'modalKit'].forEach((k) => {
    const ns = host.LXW[k];
    const n = ns ? Object.keys(ns).length : 0;
    ok(n > 0, 'LXW.' + k + ' 导出非空（' + n + ' 项）');
  });
}

console.log('\n[3] ★ game.js 读到的每个名字，模块里真的有');
{
  const src = fs.readFileSync(GAME, 'utf8');

  /* 先把 game.js 里所有 `NS.key` 读法捞出来。
   * 覆盖三种写法：解构（var a = NS.a）、直接调用（NS.f()）、当依赖传进去（k: NS.f）——
   * 三者在文本上都是 `NS.key`，一条正则就够。 */
  const wanted = {};
  Object.keys(NAMESPACES).forEach((ns) => { wanted[ns] = new Set(); });

  Object.keys(NAMESPACES).forEach((ns) => {
    const re = new RegExp('\\b' + ns + '\\.([A-Za-z_$][\\w$]*)', 'g');
    let m;
    while ((m = re.exec(src)) !== null) wanted[ns].add(m[1]);
  });

  let totalNames = 0;
  Object.keys(NAMESPACES).forEach((ns) => {
    const nsKey = NAMESPACES[ns];
    const obj = RESOLVED[nsKey];
    if (!obj) { ok(false, ns + '（LXW.' + nsKey + '）存在'); return; }

    const names = Array.from(wanted[ns]).sort();
    totalNames += names.length;
    /* 一条断言一个命名空间，缺的名字全部列出来（缺 1 个和缺 8 个都要看得见） */
    const missing = names.filter((n) => !Object.prototype.hasOwnProperty.call(obj, n));
    ok(missing.length === 0,
      ns + ' 的 ' + names.length + ' 个引用全部能解析',
      missing.length ? '缺 ' + missing.length + ' 个：' + missing.join(', ') : undefined);
  });
  ok(totalNames > 100, 'game.js 对模块的引用总数合理（' + totalNames + ' 处，太少说明正则没捞到）');

  /* 反向兜底：game.js 里出现过的每个 window.LXW.xxx，都必须在 NAMESPACES 里登记。
   * 漏登记 = 新模块没人守，等于这个文件对它失明。 */
  const used = new Set();
  const reAll = /window\.LXW\.([A-Za-z_$][\w$]*)/g;
  let m2;
  while ((m2 = reAll.exec(src)) !== null) used.add(m2[1]);
  const unregistered = Array.from(used).filter((k) => Object.keys(NAMESPACES).every((ns) => NAMESPACES[ns] !== k));
  ok(unregistered.length === 0, 'game.js 用到的模块都在 NAMESPACES 里登记了',
    unregistered.length ? '未登记：' + unregistered.join(', ') : undefined);
}

console.log('\n[4] ★ 传进工厂的依赖，在创建那一刻真的已经有值');
{
  /* 这是「var 不提升值」的坑，也是本轮踩得最深的一个：
   *   var recordsPid = Records.recordsPid;   // 第 2697 行
   *   var Account = LXW.accountView({ recordsPid: recordsPid });  // 第 2498 行
   * 第 2498 行执行时 recordsPid 还是 undefined（var 声明被提升了，赋值没有），
   * 传进去就是个**死值**：之后 recordsPid() 永远 TypeError。
   *
   * 它静态可查，所以不靠跑起来才能发现：
   *   函数声明 → 整体提升，随便传（含函数表达式里被提前引用的情况）
   *   var / let / const → **必须**声明在创建行之前
   * 拿不到声明 → 既不是提升也不是前面的 var，等于 undefined。 */
  const src = fs.readFileSync(GAME, 'utf8').split(/\r?\n/);

  /* 找出所有工厂创建点，并按花括号配平取出依赖对象的字面量文本 */
  function findCalls(modName) {
    const out = [];
    const head = 'window.LXW.' + modName + '({';
    let from = 0;
    let at;
    while ((at = src.join('\n').indexOf(head, from)) !== -1) {
      from = at + 1;
      /* 用字符偏移换算行号 */
      const lineNo = src.join('\n').slice(0, at).split('\n').length;
      /* 从 `(` 开始配平 */
      const open = src.join('\n').indexOf('(', at);
      let depth = 0;
      let i = open;
      for (; i < src.join('\n').length; i++) {
        const ch = src.join('\n')[i];
        if (ch === '{' || ch === '(' || ch === '[') depth += 1;
        else if (ch === '}' || ch === ')' || ch === ']') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      out.push({ line: lineNo, body: src.join('\n').slice(open, i + 1) });
    }
    return out;
  }

  /* 依赖对象里需要检查的标识符，两种形态都要抓：
   *   `k: ident`                                  直接传引用
   *   `k: function () { return ident.apply(...) }` 透传包装（延迟绑定）
   * ★ 第二种必须一起抓：包装正是**为了绕开越序引用**才存在的，
   *   如果守卫只认第一种，那么改完之后这 9 个最危险的依赖就正好从视野里消失。 */
  function depIdents(body) {
    const res = [];
    const re = /(?:^|[{,\s])([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\s*(?=[,}])/g;
    let m;
    while ((m = re.exec(body)) !== null) {
      if (m[2] === 'true' || m[2] === 'false' || m[2] === 'null' || m[2] === 'undefined') continue;
      res.push({ name: m[2], wrapped: false });
    }
    const reWrap = /(?:^|[{,\s])([A-Za-z_$][\w$]*)\s*:\s*function\s*\([^)]*\)\s*\{\s*return\s+([A-Za-z_$][\w$]*)\.apply\(/g;
    while ((m = reWrap.exec(body)) !== null) res.push({ name: m[2], wrapped: true });
    return res;
  }

  /* 标识符在 game.js 里的「最早可用行」：
   *   函数声明 → 整体提升，算第 1 行
   *   var/let/const → 取声明行（要认**逗号链** `var a = X.a, b = X.b;`，
   *                   只认行首的话 b 会被误判成「没声明」，守卫自己在造假警报）
   *   找不到 → Infinity（既不是提升也不是声明，等于 undefined） */
  function availableLine(ident) {
    const esc = ident.replace(/\$/g, '\\$');
    for (let i = 0; i < src.length; i++) {
      /* `async function` 同样是函数声明、同样整体提升，漏掉这个前缀会把
       * handleInvite / tryResumeRoom 误判成「还没赋值」。 */
      if (new RegExp('^\\s*(?:async\\s+)?function\\s+' + esc + '\\s*\\(').test(src[i])) return 1;
    }
    const declRe = new RegExp('(?:^\\s*(?:var|let|const)\\s+|\\bvar\\s+|\\blet\\s+|\\bconst\\s+|,)\\s*' + esc + '\\s*=');
    for (let i = 0; i < src.length; i++) {
      if (declRe.test(src[i])) return i + 1;
    }
    return Infinity;
  }

  const FACTORIES = ['cardView', 'historyKit', 'accountView', 'settleView', 'seatSheetView', 'recordsView'];
  let checked = 0;
  FACTORIES.forEach((mod) => {
    const calls = findCalls(mod);
    if (!calls.length) { ok(false, '找到 ' + mod + ' 的创建点'); return; }
    calls.forEach((c) => {
      const bad = [];
      depIdents(c.body).forEach((d) => {
        checked += 1;
        const avail = availableLine(d.name);
        /* 包装形态（`function(){ return x.apply(...) }`）是**故意的延迟绑定**，
         * 顺序无所谓，只要这个名字真的存在（防手滑写成不存在的名字）。
         * 直接传引用则必须在创建行之前就已经有值 —— 否则传进去是个死值。 */
        if (d.wrapped ? avail === Infinity : avail >= c.line) bad.push(d.name + (d.wrapped ? '(拼错?)' : ''));
      });
      ok(bad.length === 0, mod + '（第 ' + c.line + ' 行创建）的依赖在创建时都已有值',
        bad.length ? '传进去就是 undefined：' + bad.join(', ') + '（函数可改成 function(){ return ' + bad[0] + '.apply(null, arguments); }）' : undefined);
    });
  });
  ok(checked > 30, '依赖项总数合理（' + checked + ' 个，太少说明没解析出来）');
}

console.log('\n[5] ★ 模块里读的常量，必须有来源（本文件 / deps / 全局）');
{
  /* 这一组守的是「裸标识符」：模块里写了 `BIG_TYPES`，但它是 cardView 的私有常量，
   * 既没在本文件声明、也没走 deps 注入 —— 加载时不报错（只在函数体里用到），
   * 真跑到那一行才 ReferenceError。曾经就是这样丢的：结算页的「大牌型横幅」
   * 让整个 render() 抛异常，房间到第 2 轮时界面不再重绘，看起来像「点提交没反应」。
   *
   * 判据只取**全大写常量**：小写裸标识符（state、side、image）在正则/字符串里
   * 误报太多，而全大写的命名在这套代码里是有纪律的，几乎不会误伤。 */
  const strip = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');

  /* 浏览器内置对象：桩里故意没造（造了会把「忘了注入」掩盖成「桩写全了」），
   * 但它们在任何浏览器里都存在，不是本项目要注入的东西。 */
  const BUILTIN = new Set(['URL', 'URLSearchParams', 'Image', 'File', 'Blob', 'FileReader', 'FormData',
    'DOMException', 'TextEncoder', 'TextDecoder', 'AbortController', 'CustomEvent', 'HTMLElement']);

  MODULES.forEach((f) => {
    const raw = fs.readFileSync(path.join(JS, f), 'utf8');
    const src = strip(raw);

    const declared = new Set();
    let m;
    const declRe = /\b(?:var|let|const|function|class)\s+([A-Za-z_$][\w$]*)/g;
    while ((m = declRe.exec(src)) !== null) declared.add(m[1]);
    const chainRe = /(?:^|\n)\s*(?:var|let|const)\s+([^;\n]+)/g;
    while ((m = chainRe.exec(src)) !== null) {
      m[1].split(',').forEach((seg) => {
        const n = /^\s*([A-Za-z_$][\w$]*)\s*=/.exec(seg);
        if (n) declared.add(n[1]);
      });
    }
    const depsRe = /deps\.([A-Za-z_$][\w$]*)/g;
    while ((m = depsRe.exec(src)) !== null) declared.add(m[1]);

    const bad = new Set();
    const idRe = /\b([A-Z][A-Z0-9_]{2,})\b/g;
    while ((m = idRe.exec(src)) !== null) {
      const name = m[1];
      if (src[m.index - 1] === '.') continue;                    // 属性访问
      if (src.slice(m.index + name.length, m.index + name.length + 1) === ':') continue; // 对象键
      if (declared.has(name)) continue;
      if (BUILTIN.has(name)) continue;
      if (typeof host[name] !== 'undefined') continue;            // index.html 里挂上的全局
      bad.add(name);
    }
    ok(bad.size === 0, f + ' 引用的常量都有来源',
      bad.size ? '无来源：' + Array.from(bad).join(', ') + '（要么在文件里声明，要么走 deps 注入）' : undefined);
  });

  /* `state` 单独点名检查。它是 game.js 里唯一的共享可变状态对象，
   * 名字全是小写，混不进上面那条全大写的规则 —— 但它恰恰是最容易漏的一个：
   * settleView / seatSheetView / recordsView 三个模块都漏过，
   * 而漏了之后的表现是「房间到第 2 轮就不重绘了」，查了很久才追到 ReferenceError。
   * 判定很简单：模块里出现了裸 `state`，就**必须**有 deps.state。 */
  MODULES.forEach((f) => {
    const src = strip(fs.readFileSync(path.join(JS, f), 'utf8'));
    const usesState = /(^|[^.\w$])state\s*[.[]/.test(src);
    if (!usesState) return;
    const provides = /deps\.state\b/.test(src);
    ok(provides, f + ' 用了 state，就必须从 deps 注入',
      provides ? undefined : '缺 deps.state —— 模块作用域里读不到 game.js 的 state');
  });
}

console.log('\n----------------------------------------');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
