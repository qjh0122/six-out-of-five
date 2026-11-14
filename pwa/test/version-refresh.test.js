/**
 * 「客户端会拿到新 JS」的守卫（2026-11-12）
 *
 * ── 为什么会有这个文件 ──────────────────────────────────────────
 * 加小王（20261112a）之后，用户截图里两张王长得一模一样。
 * 三轮排查的结论是：**服务端和线上代码都是对的，客户端跑的是旧 JS**。
 *
 * 证据链：
 *   ① 线上全新浏览器（无缓存）实测：大王彩色像素 17.9%、小王 0%（纯灰）；
 *   ② 用户截图里两张都是彩色；
 *   ③ 把 v144 的 card.js 拿来做绘制桩测试，rank 15 与 14.5 的**绘制调用序列完全相同** ——
 *      旧版 drawJoker 只收 3 个参数，不认 small，所以两张必然一样。
 *
 * 让「客户端一直停在旧代码」的有两条机制，这个文件各守一条：
 *   [A] 页面只在启动时查一次版本（checkVersionConsistency）。
 *       PWA 挂后台一晚上不关 = 永远不查，服务端换了代码它不知道。
 *   [B] SW 的脚本/样式兜底用 `caches.match(req, { ignoreSearch: true })`，
 *       把 `?v=`（app-version）一起忽略 —— 那正是「这份 JS 属于哪一版」的唯一标记。
 *       于是网络慢过一次就拿到上一版 JS：HTML 新、JS 旧、版本号看着也对。
 *
 * 这类 bug 的共同特征是**没有报错**：请求全 200、界面正常、只有行为是旧的。
 * 所以必须靠断言钉住，而不是靠下次记得。
 */
'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

/* 负向断言前必须先去注释。
 * 源码里为了说清「为什么不能这样写」，会**原样引用**那种写法
 * （比如注释里写着 `caches.match(req, {ignoreSearch:true})` 是错的）。
 * 不去注释就会把说明文字当成代码，红的是注释、不是实现 ——
 * 这类假红第一次就该修掉，否则以后真出问题会被人当噪音忽略。
 * `[^:]` 是为了不把 `https://` 里的 `//` 当行注释。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const ROOT = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'pwa', 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(ROOT, 'pwa', 'sw.js'), 'utf8');

console.log('\n[A] 版本自检必须是「持续的」，而不是启动那一次');
{
  ok(/function checkVersionConsistency/.test(html), 'index.html 里有版本自检函数');
  ok(/setInterval\(checkVersionConsistency,\s*\d+\)/.test(html),
    '★ 版本自检有 setInterval 周期调用（否则长开页面永不更新）');
  const iv = /setInterval\(checkVersionConsistency,\s*(\d+)\)/.exec(html);
  ok(iv && Number(iv[1]) > 0 && Number(iv[1]) <= 300000,
    '周期在 5 分钟以内（实测值 ' + (iv ? iv[1] : '未找到') + 'ms）');
  ok(/visibilitychange/.test(html) && /checkVersionConsistency\(\)/.test(html),
    '★ 切回前台也会查一次（后台定时器会被节流到分钟级）');
  ok(/if \(!document\.hidden\) checkVersionConsistency\(\)/.test(html),
    '只在「变可见」时查，不是隐藏时也查');
}

console.log('\n[B] 忙的时候不能刷，但不能永远不刷');
{
  ok(/function reloadWhenIdle/.test(html), '有 reloadWhenIdle');
  ok(/if \(window\.LXWBusy && window\.LXWBusy\(\)\)/.test(html), '刷新前问 LXWBusy');
  ok(/setTimeout\(function \(\) \{ reloadWhenIdle\(reason\); \}, \d+\)/.test(html),
    '★ 忙的时候是「稍后重试」而不是直接放弃');
  ok(/VERSION_RELOADED/.test(html), '有 sessionStorage 防死循环（同一版本只刷一次）');
}

console.log('\n[C] SW 的脚本/样式兜底不许忽略 ?v=');
{
  ok(/function matchSameVersion/.test(sw), 'sw.js 有 matchSameVersion');
  /* 只看 js/css 那个分支的块内 —— 断言写宽了会匹配到函数定义本身，
   * 那样把调用改回旧写法也照样绿（红灯验证时踩过）。 */
  const at = sw.indexOf('if (isJsCss) {');
  const end = sw.indexOf('return;', sw.indexOf('event.respondWith', at));
  const block = at >= 0 && end > at ? sw.slice(at, end) : '';
  ok(block.length > 50, '找得到 js/css 分支（' + block.length + ' 字符）');
  ok(/matchSameVersion\(req\)/.test(block), '★ js/css 分支内部调用 matchSameVersion');
  ok(!/ignoreSearch/.test(stripComments(block)), '★ 负向：js/css 分支里不许出现 ignoreSearch');
  ok(/\(!got \|\| want === got\)/.test(sw), '版本比对逻辑在（有 v 且不同就丢弃）');
  ok(/vOf\(loose\.url/.test(sw), '比的是**缓存条目**的 URL，不是请求自己的');
}

console.log('\n[D] 把 matchSameVersion 抽出来跑真实行为（不是只看正则）');
{
  const body = sw.slice(sw.indexOf('function vOf('), sw.indexOf("self.addEventListener('fetch'"));
  ok(body.length > 100, '抽到了函数体（' + body.length + ' 字符）');

  const fakeSelf = { location: { href: 'https://game.example/' } };
  function build(exact, loose) {
    const fakeCaches = {
      match(req, opts) {
        return Promise.resolve(opts && opts.ignoreSearch ? loose : exact);
      }
    };
    /* eslint-disable no-new-func */
    const f = new Function('caches', 'self', body + '\nreturn { matchSameVersion: matchSameVersion, vOf: vOf };');
    return f(fakeCaches, fakeSelf);
  }
  const reqSame = { url: 'https://game.example/js/card.js?v=20261112a&sharecode=S' };

  (async function run() {
    /* ① 精确命中：同 v + 同 sharecode */
    let m = build({ url: reqSame.url }, null);
    eq((await m.matchSameVersion(reqSame)) && 'hit', 'hit', '精确命中直接返回');

    /* ② 只有 ignoreSearch 命中、但版本一致 → 可以用 */
    m = build(null, { url: 'https://game.example/js/card.js?v=20261112a&sharecode=OTHER' });
    ok(!!(await m.matchSameVersion(reqSame)), '同版本、不同 sharecode → 允许复用');

    /* ③ 只有 ignoreSearch 命中、版本不同 → 必须丢弃（这正是本次 bug 的成因） */
    m = build(null, { url: 'https://game.example/js/card.js?v=20261111e&sharecode=S' });
    eq(await m.matchSameVersion(reqSame), null,
      '★ 旧版本缓存必须丢弃（否则就是「HTML 新、JS 旧」）');

    /* ④ 缓存条目没有 v（PRECACHE 写的是裸路径）→ 放行，否则离线能力整片废掉 */
    m = build(null, { url: 'https://game.example/js/card.js?sharecode=S' });
    ok(!!(await m.matchSameVersion(reqSame)), '无 v 的预缓存条目放行（离线要用）');

    /* ⑤ 完全没有缓存 → null，不抛 */
    m = build(null, null);
    eq(await m.matchSameVersion(reqSame), null, '没有缓存时返回 null');

    /* ⑥ 请求自己没带 v（直接打开某个 js）→ 与无 v 的条目同版本 */
    const reqNoV = { url: 'https://game.example/js/card.js' };
    m = build(null, { url: 'https://game.example/js/card.js?sharecode=S' });
    ok(!!(await m.matchSameVersion(reqNoV)), '请求无 v 时也能命中无 v 的缓存');

    /* ---------------------------------------------------------------- */
    console.log('\n[E] 「首页闪一下又回来」的两个来源（2026-11-14）');
    {
      /* ① controllerchange 不许再 reload。
       *    新 SW 接管发生在 install（预缓存 40 多条）→ activate → claim 之后，
       *    实测 2.9 秒 —— 那时首屏早画完了，这一刷就是用户看到的那一下闪。
       *    而它本身是多余的：导航 network-first，HTML 从网络拿，里面的 ?v= 必然是新版，
       *    页面跑着的已经是最新代码，没有任何理由刷。 */
      const ccAt = html.indexOf("addEventListener('controllerchange'");
      ok(ccAt > 0, '找得到 controllerchange 监听（' + ccAt + '）');
      const ccBlock = ccAt > 0 ? html.slice(ccAt, ccAt + 900) : '';
      ok(!/reloadWhenIdle/.test(ccBlock), '★ 负向：controllerchange 里不许再调 reloadWhenIdle');
      ok(!/location\.reload/.test(ccBlock), '★ 负向：也不许直接 location.reload');
      ok(/__lxwSwSwapped/.test(ccBlock), '仍然记录「被接管过」，供诊断页看状态');

      /* ② 版本自检必须挪出 load 回调、并且不再 setTimeout 500ms。
       *    留在 load 里 = 首屏画完才查，查到不一致再 reload 就是「闪」。
       *    现在脚本一执行就查：检查还在路上时首屏通常还没画出来。 */
      ok(!/setTimeout\(checkVersionConsistency/.test(html),
        '★ 负向：不再有 setTimeout(checkVersionConsistency, 500)');
      const loadAt = html.indexOf("window.addEventListener('load', function () {");
      const loadEnd = loadAt >= 0 ? html.indexOf('});', loadAt) : -1;
      const loadBlock = loadAt >= 0 && loadEnd > loadAt ? html.slice(loadAt, loadEnd) : '\u0000';
      ok(loadBlock !== '\u0000', '找得到 load 回调块');
      ok(loadBlock.indexOf('checkVersionConsistency') < 0,
        '★ 版本自检不在 load 回调里（否则等于「首屏之后再查」）');
      const bareAt = html.indexOf('\n    checkVersionConsistency();');
      const fnAt = html.indexOf('function checkVersionConsistency');
      ok(bareAt > 0 && fnAt > bareAt,
        '★ 有一处「脚本一执行就查」的裸调用（在函数定义之前）');

      /* ③ 首帧底色内联：style.css 到达前浏览器画白屏，白屏的感知是「卡住了」 */
      const bgAt = html.indexOf('<style>html,body{background:');
      const cssAt = html.indexOf('rel="stylesheet"');
      ok(bgAt > 0, '有内联首帧底色');
      ok(bgAt > 0 && cssAt > bgAt, '底色写在外链样式之前（否则它自己也要等网络）');
    }

    /* ---------------------------------------------------------------- */
    console.log('\n[F] 脚本/样式是 cache-first，且只认 URL 全等（2026-11-14）');
    {
      const at = sw.indexOf('if (isJsCss) {');
      const end = sw.indexOf('return;', sw.indexOf('event.respondWith', at));
      const block = at >= 0 && end > at ? sw.slice(at, end) : '';
      ok(block.length > 50, '找得到 js/css 分支（' + block.length + ' 字符）');
      /* ① 第一步必须是查缓存，不是发请求 —— 这是「每次打开卡一会儿」的修法本体 */
      ok(/event\.respondWith\(\s*\n?\s*caches\.match\(req\)/.test(block),
        '★ 分支第一件事是 caches.match(req)（精确匹配）');
      ok(!/networkFirst\(/.test(block),
        '★ 负向：不再走 networkFirst（那会让每次打开都先过一次网络）');
      /* ② 精确匹配的调用里不许带 ignoreSearch —— 带了就等于忽略 ?v=，混版本的老 bug 会回来 */
      ok(!/caches\.match\(req,\s*\{\s*ignoreSearch/.test(stripComments(block)),
        '★ 负向：精确匹配处不许出现 ignoreSearch');
      /* ③ 缓存 miss 时走网络并写回，断网才退到同版本兜底 */
      ok(/fetch\(req\)/.test(block), '缓存 miss 时走网络');
      ok(/c\.put\(req, copy\)|caches\.open\(CACHE_NAME\)/.test(block), '网络响应写回缓存');
      ok(/matchSameVersion\(req\)/.test(block), '断网兜底仍校验版本（matchSameVersion）');
    }

    console.log('\n' + (fail === 0 ? '全部通过' : fail + ' 项失败') + ' —— ' + pass + ' passed, ' + fail + ' failed\n');
    process.exit(fail === 0 ? 0 : 1);
  })();
}
