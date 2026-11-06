/**
 * 静默吞异常守卫（v127）
 *
 * 这个文件守的不是某一条逻辑，而是**一类错误的可见性**。
 *
 * 起因是两次真实事故：
 *   · v121：`RoomStore.dropNext is not a function` → 被 `catch (e) { flash('网络不太稳…') }`
 *     吞掉，玩家看到的是「网络不太稳，再试一次」，服务端日志一片安静。
 *     一条「方法名根本没有」的问题，在真机上表现为「点了没反应」。
 *   · v108：订阅回调里的 `ReferenceError: state is not defined` →
 *     被 `catch (e) {}` 吞掉，界面从此不再更新，控制台也没声音。
 *
 * 两次的共同点：**catch 里只有"安抚"，没有"证据"**。
 *
 * 所以判据不是"catch 里必须有什么"，而是两句可以机检的话：
 *   ① 只要 catch 里给了提示（flash），就必须同时上报；
 *   ② 订阅者的 catch 不许空着 —— 吞掉可以（不能因为一个订阅者挂了就不通知别人），
 *      但必须留痕。
 *
 * 注意这里**故意不要求「所有空 catch 都要写日志」**：pwa/js 下有 60 多处
 * `catch (e) {}` 围着 focus() / history.replaceState / AudioContext / socket.close，
 * 它们抛出来也没有任何补救动作，全加日志只会把真正的问题淹掉。
 * 一刀切的规矩没人守得住，守得住的是"说谎的那一类"。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'js');

let pass = 0;
let fail = 0;
function ok(c, m, extra) {
  if (c) { pass++; console.log('  ✓ ' + m); }
  else { fail++; console.log('  ✗ ' + m + (extra ? '  ← ' + extra : '')); }
}
function eq(a, b, m) { ok(a === b, m, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); }
function head(t) { console.log('\n' + t); }

function read(f) { return fs.readFileSync(path.join(JS, f), 'utf8'); }

/* 把注释剥掉再判断：注释里提到「网络不太稳」是在解释为什么不能说，不算违规 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/* ★ 把注释"抹成等长的空格"，不是删掉。
 *
 * 为什么必须这么做：`catch (e) { /* 把 {ok:false} 转成 ... *\/ reportBug(...) }`
 * 这种块，注释里带花括号，而按 `\{([^{}]*)\}` 取块体的解析器会在注释里的 `}`
 * 处提前收尾 —— 于是 reportBug 那句落在"块外"，断言判它没上报。
 *
 * 这是第一版真踩到的：一条关于 `joinRoom` 的注释把守卫骗过去了。
 * **守卫因为注释而失明，比没有守卫更糟**（它给的是"全绿"）。
 * 保留等长空格 + 换行，行号就不会漂。 */
function blankComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + m.slice(p1.length).replace(/[^\n]/g, ' '));
}

/* 取出每个 catch (x) { ... } 的块体（在"注释已抹平"的文本上匹配）。 */
function catches(src) {
  const flat = blankComments(src);
  const out = [];
  const re = /catch\s*\(\w+\)\s*\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(flat))) {
    out.push({
      line: flat.slice(0, m.index).split('\n').length,
      body: m[1],
      core: m[1].trim()
    });
  }
  return out;
}

/* ========================================================================== */
head('[1] 全 UI 层：给了提示就必须上报（这是 v121 那种「说网络不太稳」的形状）');
{
  /* 不只扫 game.js：settleView / recordsView / accountView 也会 flash。
   * 只守一个文件的话，下次把逻辑挪到另一个模块，守卫就自动失效了 —— 那是最隐蔽的失守方式。 */
  const files = fs.readdirSync(JS).filter((f) => f.endsWith('.js'));
  const liars = [];
  let total = 0;
  files.forEach((f) => {
    catches(read(f)).forEach((c) => {
      total++;
      if (!/flash\s*\(|toast\s*\(/.test(c.core)) return;
      if (/reportBug|reportQuietly|reportSubscriber|ErrorReport|console\.error/.test(c.core)) return;
      if (/silence:/.test(c.body)) return;
      liars.push(f + ':' + c.line + ': ' + c.core.replace(/\s+/g, ' ').slice(0, 70));
    });
  });

  ok(total >= 100, '扫到 ' + total + ' 处 catch（' + files.length + ' 个模块），不是空扫描');
  eq(liars.length, 0, '★ 全 UI 层没有「只提示、不上报」的 catch');
  if (liars.length) console.log('     ' + liars.join('\n     '));

  /* 反过来：真的有 catch 在**上报**。
   * v127 之后 catch 体里不再直接 flash（提示已经收进 reportBug），
   * 所以前置条件要换成「有 13 处在真的调 reportBug」—— 11 个动作 + 建房 + 进房。
   * 没有这一条，上面那句「没有只 flash 不上报的 catch」在"一个人都不上报"时也会绿。 */
  const reporting = catches(read('game.js')).filter((c) => /reportBug\s*\(/.test(c.core));
  ok(reporting.length >= 14,
    '（前置）game.js 至少 14 处 catch 真的在上报（11 动作 + 建房 + 进房 + 回座），实际 ' + reporting.length);
}

head('[1b] 协议调用的 catch 不许「悄悄 return」（回座那条就是这么消失的）');
{
  const src = read('game.js');
  const flat = blankComments(src);
  const re = /try\s*\{([\s\S]*?)\}\s*catch\s*\(\w+\)\s*\{([^{}]*)\}/g;
  const pairs = [];
  let m;
  while ((m = re.exec(flat))) {
    if (!/RoomStore\./.test(m[1])) continue;
    pairs.push({ line: flat.slice(0, m.index).split('\n').length, body: m[2].trim() });
  }
  ok(pairs.length >= 12, '★ 找到 ' + pairs.length + ' 处「协议调用 + catch」（不是空扫描）');

  const mute = pairs.filter((c) => !/reportBug|ErrorReport|console\.error|flash|silence:/.test(c.body));
  eq(mute.length, 0,
    '★★ 没有一处协议调用被静默吞掉（既不上报也不告诉用户，等于这条路径不存在）',
    mute.map((c) => 'line ' + c.line + ': ' + JSON.stringify(c.body.slice(0, 40))).join(','));
}

head('[2] 「网络不太稳」不再出现在任何提示里');
{
  const src = read('game.js');
  const code = stripComments(src);
  ok(code.indexOf('网络不太稳') < 0,
    '★★ 代码里不再有「网络不太稳」这句（它把本端 bug 说成玩家的网络问题）');

  /* 全仓扫一遍：别的文件也不许说 */
  const others = fs.readdirSync(JS).filter((f) => f.endsWith('.js') && f !== 'game.js');
  const hit = others.filter((f) => stripComments(read(f)).indexOf('网络不太稳') >= 0);
  eq(hit.join(','), '', '其他模块也没有这句话');
}

head('[3] reportBug 真的会把异常交出去，且不说谎');
{
  const src = read('game.js');
  const fnSrc = (src.match(/function reportBug\([\s\S]*?\n  \}/) || [])[0];
  ok(!!fnSrc, '能从 game.js 取出 reportBug（独立函数，取不到说明它被藏进了闭包里）');

  if (fnSrc) {
    const make = (capture, flashCalls) => {
      const fakeReport = { capture: capture };
      const fakeFlash = (m) => flashCalls.push(m);
      const fakeConsole = { error: () => {} };
      // eslint-disable-next-line no-new-func
      return new Function('ErrorReport', 'flash', 'console', fnSrc + '; return reportBug;')(
        fakeReport, fakeFlash, fakeConsole
      );
    };

    /* ① 正常路径：报上去，且报的内容带位置 */
    let seen = null;
    let flashes = [];
    const bug = make((kind, msg, extra) => { seen = { kind, msg, extra }; }, flashes);
    bug('submitGroups', new TypeError('x is not a function'), '交牌出了点问题，已经记下了');
    ok(!!seen, '★ 异常被交给上报（不是只 flash 一句就算了）');
    eq(seen && seen.kind, 'catch', 'kind 默认是 catch');
    ok(seen && /submitGroups/.test(seen.msg), '★ 消息里带上了位置（否则线上只知道"有个错"）', seen && seen.msg);
    ok(seen && /is not a function/.test(seen.msg), '★ 也带上了原始 message');
    eq(flashes.length, 1, '提示只说一次');

    /* ② 默认文案不许提「网络」——玩家没有做错任何事 */
    flashes = [];
    const bug2 = make(() => {}, flashes);
    bug2('wantNext', new Error('boom'));
    ok(!/网络/.test(flashes[0] || ''), '★ 默认提示不提网络', flashes[0]);
    ok(/记下/.test(flashes[0] || ''), '★ 明确告诉玩家「已经记下了」（这是实话：真的上报了）', flashes[0]);

    /* ③ 自定义文案要能覆盖（交牌那句要说「可能已经提交」） */
    flashes = [];
    const bug3 = make(() => {}, flashes);
    bug3('submitGroups', new Error('boom'), '交牌出了点问题，已经记下了');
    eq(flashes[0], '交牌出了点问题，已经记下了', '自定义文案生效');

    /* ④ userMsg === null = 只上报不提示（回座那种「本来就该安静」的场景） */
    flashes = [];
    let seenQ = null;
    const bugQ = make((kind, msg) => { seenQ = msg; }, flashes);
    bugQ('resume', new Error('boom'), null);
    eq(flashes.length, 0, '★★ 传 null 时不弹提示（否则每次刷新都打扰用户）');
    ok(!!seenQ, '★ 但**仍然上报**了（安静是给用户的，不是给我们的）');

    /* ⑤ 不传 userMsg（undefined）仍然走默认文案 —— null 与 undefined 不能混为一谈 */
    flashes = [];
    const bugU = make(() => {}, flashes);
    bugU('resume', new Error('boom'));
    eq(flashes.length, 1, '不传 userMsg 时照常提示（undefined ≠ null）');

    /* ⑥ 上报自己炸了，不能让 reportBug 炸 —— 否则一次渲染失败会连锁成白屏 */
    let threw = false;
    try {
      const bug4 = make(() => { throw new Error('上报端点挂了'); }, []);
      bug4('render', new Error('boom'));
    } catch (e) { threw = true; }
    ok(!threw, '★★ 上报本身抛异常时，reportBug 不往外抛（它在一个 catch 里被调用）');

    /* ⑦ 没有 ErrorReport（Node / 极老环境）也不能炸 */
    threw = false;
    try {
      const fakeFlash = () => {};
      // eslint-disable-next-line no-new-func
      const bug5 = new Function('ErrorReport', 'flash', 'console', fnSrc + '; return reportBug;')(
        undefined, fakeFlash, { error: () => {} }
      );
      bug5('render', new Error('boom'));
    } catch (e) { threw = true; }
    ok(!threw, '★ ErrorReport 不存在时也不抛');
  }
}

head('[4] 11 个动作的 catch 都接上了 reportBug（逐个点名，防止改回一半）');
{
  const src = read('game.js');
  /* 这 11 个是 v127 之前**全部**说「网络不太稳」的地方。
   * 逐个点名而不是数总数：总数对得上但漏了某一个，正是这类改动最常见的失手方式。 */
  const actions = ['setHandLimit', 'beginRevise', 'cancelRevise', 'submitGroups', 'wantNext',
    'setReady', 'addBot', 'dropNext', 'holdNext', 'unWantNext', 'proposeDissolve', 'resume'];
  actions.forEach((a) => {
    ok(src.indexOf("reportBug('" + a + "'") >= 0, '★ ' + a + ' 的 catch 会上报');
  });
}

head('[5] roomStore：订阅者抛异常必须留痕（v108 的 ReferenceError 死在这里）');
{
  const src = read('roomStore.js');

  /* ★ 关键：要匹配的是「try 里调订阅者 / catch 里处置」这一对，而不是 catch 体。
   * 第一版写成在 catch 体里找 `list[i](room)`，结果 0 处 —— 因为那句话在 try 里。
   * 守卫自己写错了会给出「全绿」的假象，这比没有守卫更糟。 */
  const flat = blankComments(src);
  const pair = /try\s*\{([^{}]*?(?:list\[i\]|Cbs\[i\]|cb\(|fn\(|forEach\(function \(cb\))[^{}]*)\}\s*catch\s*\(\w+\)\s*\{([^{}]*)\}/g;
  const subs = [];
  let m;
  while ((m = pair.exec(flat))) {
    subs.push({ line: flat.slice(0, m.index).split('\n').length, tryBody: m[1], body: m[2] });
  }
  ok(subs.length >= 6,
    '★ 找到 ' + subs.length + ' 处「调订阅者 + catch」的对（emit/emoji/offline/disconnect/subscribe/fatal）',
    '实际 ' + subs.length);

  const silent = subs.filter((c) => c.body.trim() === '');
  eq(silent.length, 0,
    '★★ 没有一处订阅者的 catch 是空的（v108 就是死在这里）',
    silent.map((c) => 'line ' + c.line).join(','));

  const noReport = subs.filter((c) => !/reportSubscriber/.test(c.body));
  eq(noReport.length, 0,
    '★ 每一处都走 reportSubscriber（吞掉可以，但不能不留痕）',
    noReport.map((c) => 'line ' + c.line).join(','));

  /* 空 catch 不设"总数上限"（pwa/js 里有 60 多处围着 focus/AudioContext/postMessage，
   * 它们抛出来也没有补救动作）。要守的是：**别把订阅者或协议响应塞进空 catch 里**。 */
  const badEmpty = [];
  const re2 = /try\s*\{([^{}]*)\}\s*catch\s*\(\w+\)\s*\{\s*\}/g;
  while ((m = re2.exec(flat))) {
    const tb = m[1];
    if (/(cb\(|Cbs\[i\]|list\[i\]|fn\(|forEach\(function \(cb\)|pending\[)/.test(tb)) {
      badEmpty.push({ line: flat.slice(0, m.index).split('\n').length, body: tb.trim().slice(0, 60) });
    }
  }
  eq(badEmpty.length, 0,
    '★ 没有「订阅者/回包处理」被塞进空 catch',
    badEmpty.map((c) => 'line ' + c.line + ': ' + c.body).join(' | '));

  /* 行为：reportSubscriber 上报 + 打控制台 + **不重抛** */
  const fnSrc = (src.match(/function reportSubscriber\([\s\S]*?\n  \}/) || [])[0];
  ok(!!fnSrc, '能取出 reportSubscriber');
  if (fnSrc) {
    const make = (capture, errs) => {
      // eslint-disable-next-line no-new-func
      return new Function('ErrorReport', 'console', fnSrc + '; return reportSubscriber;')(
        { capture: capture }, { error: (...a) => errs.push(a) }
      );
    };
    let seen = null;
    const errs = [];
    const rep = make((kind, msg, extra) => { seen = { kind, msg, extra }; }, errs);
    let threw = false;
    try { rep('emit', new ReferenceError('state is not defined')); } catch (e) { threw = true; }
    ok(!threw, '★★ 不重抛（重抛会把一次局部渲染失败升级成整条广播失败）');
    ok(!!seen && seen.kind === 'subscriber', '★ 上报了，kind=subscriber', seen && seen.kind);
    ok(!!seen && /emit/.test(seen.msg) && /state is not defined/.test(seen.msg),
      '★ 消息里带位置与原话（否则线上只知道"有个订阅者挂了"）', seen && seen.msg);
    eq(errs.length, 1, '控制台也留了一份（本地复现不用翻服务端日志）');
  }
}

head('[6] 上报不是"写了没用"：ErrorReport.capture 有真实调用点');
{
  ok(/capture/.test(read('errorReport.js')), '（前置）模块有 capture');
  const callers = ['game.js', 'roomStore.js'].filter((f) => /ErrorReport\.capture\s*\(/.test(read(f)));
  eq(callers.join(','), 'game.js,roomStore.js',
    '★★ 两个 catch 出口都真的在调它（v127 之前全仓 0 个调用点）');
}

head('[7] 语义边界：说「网络」的地方必须真的是网络');
{
  const src = read('game.js');
  /* createRoom 是唯一一个把网络失败原样抛上来的协议方法（ws.createRoom 没有 .catch），
   * 所以只有它可以说「检查一下网络」，并且要以 kind='net' 上报 —— 混进 catch 里
   * 会让"本端 bug"的信号被网络噪声稀释。 */
  ok(/reportBug\('createRoom',[\s\S]{0,200}?'net'\)/.test(src),
    '★ 建房用 kind=net 上报（它是真的网络失败）');
  const ws = read('roomStore.js');
  const block = (ws.match(/createRoom: function \(player, opts\) \{[\s\S]*?\n      \},/) || [])[0] || '';
  ok(block && block.indexOf('.catch(') < 0,
    '★ 前置仍然成立：ws.createRoom 不吞拒绝（否则建房那句「检查网络」就成了谎话）');
}

/* ========================================================================== */
console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
