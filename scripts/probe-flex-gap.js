/**
 * flex gap 兼容层的真浏览器验证
 *
 * 单测（pwa/test/flex-gap-fallback.test.js）只能证明「文件内容符合预期」，
 * 证明不了两件真正要命的事：
 *
 *   A. 现代浏览器上，这 76 条规则是不是**真的完全惰性**。
 *      「全部挂在 html.no-flex-gap 下」是纸面正确，得实测：
 *      不挂 class 时这些选择器一个元素都匹配不到 → 布局与改动前逐像素相同。
 *      这是整个方案「零回归」的唯一依据，必须实测而不是读代码。
 *
 *   B. 老内核上，这些 margin 是不是**真的能补回间距**。
 *      模拟方法：把容器的 gap 强制改成 0（等价于老内核忽略 gap），
 *      再挂上 .no-flex-gap → 量出来的间距应该回到原来的 gap 值。
 *      如果量出来还是 0，说明规则写错了（方向判反 / 选择器打偏），
 *      而那种错误在现代浏览器上永远看不出来。
 *
 * 用法：node scripts/probe-flex-gap.js [宽] [高]
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const W = Number(process.argv[2]) || 390;
const H = Number(process.argv[3]) || 844;
const STATIC_PORT = 3045;
const CDP_PORT = 9375;
const ROOT = path.join(__dirname, '..', 'pwa');
const FALLBACK = path.join(ROOT, 'css', 'flex-gap-fallback.css');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.webmanifest': 'application/manifest+json'
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  const abs = path.join(ROOT, p);
  if (!abs.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(abs, (e, buf) => {
    if (e) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
    res.end(buf);
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const waiting = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && waiting.has(msg.id)) {
        const w = waiting.get(msg.id);
        waiting.delete(msg.id);
        if (msg.error) w.reject(new Error(JSON.stringify(msg.error)));
        else w.resolve(msg.result);
      }
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => {
      resolve({
        send(method, params) {
          return new Promise((res, rej) => {
            id += 1;
            waiting.set(id, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id, method, params: params || {} }));
          });
        },
        close() { try { ws.close(); } catch (e) {} }
      });
    });
  });
}

let pass = 0; let fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

async function main() {
  await new Promise((r) => server.listen(STATIC_PORT, '127.0.0.1', r));

  const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const edge = spawn(exe, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(os.tmpdir(), 'lxw-gap-edge-' + Date.now()),
    '--window-size=' + W + ',' + H,
    '--force-device-scale-factor=1',
    'about:blank'
  ], { stdio: 'ignore' });

  let page = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const list = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
      page = (list || []).find((t) => t.type === 'page');
      if (page) break;
    } catch (e) { /* 还没起来 */ }
  }
  if (!page) { console.error('连不上 Edge CDP'); edge.kill(); process.exit(1); }

  const cdp = await cdpConnect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  /* 未捕获异常在页面里收集起来，最后统一断言 */
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.__probeErrors = [];'
      + 'window.addEventListener("error", function(e){ window.__probeErrors.push(String(e.message)); });'
      + 'window.addEventListener("unhandledrejection", function(e){ window.__probeErrors.push("rej:" + String(e.reason)); });'
  });

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + STATIC_PORT + '/' });
  await sleep(2400);

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __error: String(r.exceptionDetails.text) };
    return r.result && r.result.value;
  };

  /* 让首页可见：未登录时 boot 会切到登录页，而 .join-row 这些都在首页里。
   * 不这么做，量到的全是 0×0 的隐藏元素，后面的间距断言会全部失去意义。 */
  await evaluate(`(function(){
    var h = document.getElementById('screen-home');
    var a = document.getElementById('screen-auth');
    if (h) h.classList.remove('hidden');
    if (a) a.classList.add('hidden');
    /* 停掉 boot 的自动切屏，免得下一拍又被切回去 */
    window.__stopAutoScreen = true;
  })()`);
  await sleep(300);

  console.log('视口 ' + W + '×' + H + '\n');

  /* ================================================================
   * A. 现代浏览器：兼容层必须完全惰性
   * ============================================================== */
  console.log('[A] 现代浏览器上兼容层是否惰性');

  const cls = await evaluate('document.documentElement.className');
  ok(String(cls).indexOf('no-flex-gap') < 0, '★ 检测判定「支持 flex gap」，没有挂 .no-flex-gap', JSON.stringify(cls));

  const matched = await evaluate('document.querySelectorAll("html.no-flex-gap *").length');
  ok(matched === 0, '★ 不挂 class 时，兼容层选择器匹配 0 个元素（= 规则完全没生效）', String(matched));

  const askedForFallback = await evaluate(`(function(){
    var hit = 0;
    try {
      performance.getEntriesByType('resource').forEach(function(e){
        if (e.name.indexOf('flex-gap-fallback') >= 0) hit++;
      });
    } catch (err) { return -1; }
    return hit;
  })()`);
  ok(askedForFallback === 0, '★ 现代浏览器没有下载兼容层（省掉这 5KB）', String(askedForFallback));

  const baseline = await evaluate(`(function(){
    var el = document.querySelector('.join-row');
    if (!el || el.children.length < 2) return null;
    var a = el.children[0].getBoundingClientRect();
    var b = el.children[1].getBoundingClientRect();
    return { gapPx: Math.round(b.left - a.right), computed: getComputedStyle(el).columnGap };
  })()`);
  ok(baseline && baseline.gapPx > 0, '基准：.join-row 子元素间距正常（gap 生效）', JSON.stringify(baseline));

  /* ================================================================
   * 装上兼容层（不挂 class），再验一次惰性
   * ============================================================== */
  console.log('\n[A2] 把兼容层真正装进文档、但仍不挂 class');
  {
    const cssText = fs.readFileSync(FALLBACK, 'utf8');
    await evaluate(`(function(){
      var s = document.createElement('style');
      s.id = '__probe_fallback';
      s.textContent = ${JSON.stringify(cssText)};
      document.head.appendChild(s);
      return s.sheet ? s.sheet.cssRules.length : -1;
    })()`);

    const ruleCount = await evaluate(`(function(){
      var s = document.getElementById('__probe_fallback');
      return s && s.sheet ? s.sheet.cssRules.length : -1;
    })()`);
    ok(ruleCount > 0, '兼容层样式表已进文档（' + ruleCount + ' 条顶层规则）', String(ruleCount));

    /* 这是「零回归」最直接的一条证据：
     * 样式表已经在文档里了，但 class 没挂 → 匹配 0 个元素 → 任何计算值都不变。 */
    const afterLoad = await evaluate(`(function(){
      var el = document.querySelector('.join-row');
      var a = el.children[0].getBoundingClientRect();
      var b = el.children[1].getBoundingClientRect();
      return {
        matched: document.querySelectorAll('html.no-flex-gap *').length,
        gapPx: Math.round(b.left - a.right)
      };
    })()`);
    ok(afterLoad.matched === 0, '★ 样式表已装好，仍匹配 0 个元素', String(afterLoad.matched));
    ok(afterLoad.gapPx === (baseline && baseline.gapPx),
      '★ 装上兼容层后间距与之前完全一致（零回归的直接证据）',
      '之前 ' + (baseline && baseline.gapPx) + '，之后 ' + afterLoad.gapPx);
  }

  /* ================================================================
   * B. 模拟老内核：把 gap 抹掉，看 margin 能不能补回来
   * ============================================================== */
  console.log('\n[B] 模拟老内核（gap 被忽略）后，兼容层能否补回间距');

  const restored = await evaluate(`(function(){
    var el = document.querySelector('.join-row');
    if (!el || el.children.length < 2) return { skip: 'no-el' };
    function measure() {
      var a = el.children[0].getBoundingClientRect();
      var b = el.children[1].getBoundingClientRect();
      return Math.round(b.left - a.right);
    }
    var before = measure();
    /* 老内核模拟：忽略 gap（等价于不支持该属性的浏览器） */
    el.style.gap = '0px';
    document.documentElement.classList.add('no-flex-gap');
    void el.offsetHeight;                 /* 强制同步重排，别拿到旧值 */
    var after = measure();
    el.style.gap = '';
    document.documentElement.classList.remove('no-flex-gap');
    return { before: before, after: after };
  })()`);

  ok(restored && !restored.skip, '.join-row 存在（基准可用）', JSON.stringify(restored));
  if (restored && !restored.skip) {
    ok(restored.before > 0, '先确认基准间距 > 0（原 gap 是 16px）', JSON.stringify(restored));
    ok(restored.after > 0,
      '★ 抹掉 gap 后兼容层的 margin 把间距补回来了', JSON.stringify(restored));
    ok(Math.abs(restored.after - restored.before) <= 1,
      '★ 补回来的间距与原 gap 一致（±1px）', '原 ' + restored.before + '，补后 ' + restored.after);
  }

  /* column 方向单独验：方向判反在现代浏览器上绝对看不出来 */
  console.log('\n[C] column 方向');
  const colRestored = await evaluate(`(function(){
    /* 找一个明确是 column、有两个以上子元素、而且**当前可见**的容器。
     * 第一版漏了可见性检查，抓到房间页的 .room-actions —— 它在首页是 display:none，
     * 量出来前后都是 0，于是「0 === 0」让一条本该报警的断言假通过了。
     * 隐藏元素测出来的 0 什么都不能证明。 */
    var cands = ['.entry-link', '.acc-actions', '.game-bottom', '.gt-info', '.rp-foot', '.room-actions'];
    for (var i = 0; i < cands.length; i++) {
      var el = document.querySelector(cands[i]);
      if (!el || el.children.length < 2) continue;
      if (getComputedStyle(el).flexDirection !== 'column') continue;
      var box = el.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) continue;      /* 不可见，跳过 */
      function v() {
        var a = el.children[0].getBoundingClientRect();
        var b = el.children[1].getBoundingClientRect();
        return Math.round(b.top - a.bottom);
      }
      var before = v();
      if (before <= 0) continue;                          /* 没有基准间距，验不了 */
      el.style.gap = '0px';
      document.documentElement.classList.add('no-flex-gap');
      void el.offsetHeight;
      var after = v();
      el.style.gap = '';
      document.documentElement.classList.remove('no-flex-gap');
      return { sel: cands[i], before: before, after: after };
    }
    return { skip: 'none' };
  })()`);
  ok(colRestored && !colRestored.skip, '找到一个可见的、有纵向间距的 column 容器', JSON.stringify(colRestored));
  if (colRestored && !colRestored.skip) {
    ok(colRestored.after > 0, '★ column 方向也补上了纵向间距（方向没判反）', JSON.stringify(colRestored));
    ok(Math.abs(colRestored.after - colRestored.before) <= 1,
      '★ column 补回的间距与原 gap 一致', '原 ' + colRestored.before + '，补后 ' + colRestored.after);
  }

  /* ================================================================
   * D. 覆盖率：页面上真实生效的 flex+gap 容器，有多少被覆盖
   * ============================================================== */
  console.log('\n[D] 覆盖率');
  const cover = await evaluate(`(function(){
    var rules = [];
    Array.prototype.forEach.call(document.styleSheets, function(sh){
      try {
        Array.prototype.forEach.call(sh.cssRules, function(r){
          if (r.selectorText && r.selectorText.indexOf('html.no-flex-gap') >= 0) rules.push(r.selectorText);
        });
      } catch (e) { /* 跨域表，跳过 */ }
    });
    document.documentElement.classList.add('no-flex-gap');
    var flexGap = [], uncovered = [];
    Array.prototype.forEach.call(document.querySelectorAll('body *'), function(el){
      var cs = getComputedStyle(el);
      if (!/flex/.test(cs.display)) return;
      var g = parseFloat(cs.columnGap) || 0;
      var rg = parseFloat(cs.rowGap) || 0;
      if (!g && !rg) return;
      if (el.children.length < 2) return;
      if (!el.getBoundingClientRect().width) return;   /* 隐藏元素不算 */
      flexGap.push(1);
      /* ★ 关键：兼容规则的选择器是「容器 > * + *」，匹配的是容器的**子元素**。
       * 第一版拿容器本身去 matches，永远 false —— 于是明明覆盖了也报未覆盖。
       * 拿最后一个子元素去试：只要它匹配上了，这条容器的间距就补得上。 */
      var kid = el.children[el.children.length - 1];
      var hit = rules.some(function(sel){
        try { return kid.matches(sel); } catch (e) { return false; }
      });
      if (!hit) uncovered.push((el.className || el.tagName) + ' [' + cs.flexDirection + ' ' + g + 'x' + rg + ']');
    });
    document.documentElement.classList.remove('no-flex-gap');
    return { total: flexGap.length, covered: flexGap.length - uncovered.length,
             uncovered: uncovered.slice(0, 20), ruleCount: rules.length };
  })()`);

  console.log('    可见 flex+gap 容器 ' + cover.total + ' 个，覆盖 ' + cover.covered
    + ' 个（文档里 ' + cover.ruleCount + ' 条兼容规则）');
  ok(cover.total > 0, '页面上确实存在 flex+gap 容器');
  ok(cover.covered === cover.total, '★ 所有可见的 flex+gap 容器都被覆盖',
    '未覆盖：' + (cover.uncovered || []).join(' | '));
  if (cover.uncovered && cover.uncovered.length) {
    cover.uncovered.forEach((u) => console.log('      - ' + u));
  }

  /* ================================================================
   * E. grid 不受影响
   * ============================================================== */
  console.log('\n[E] grid 容器不受兼容层影响');
  const gridTest = await evaluate(`(function(){
    var el = document.querySelector('.entry-links') || document.querySelector('.room-grid');
    if (!el || el.children.length < 2) return { skip: 'no-el' };
    function g() {
      return Math.round(el.children[1].getBoundingClientRect().top - el.children[0].getBoundingClientRect().bottom);
    }
    var before = g();
    document.documentElement.classList.add('no-flex-gap');
    void el.offsetHeight;
    var after = g();
    document.documentElement.classList.remove('no-flex-gap');
    return { display: getComputedStyle(el).display, gap: getComputedStyle(el).rowGap, before: before, after: after };
  })()`);
  ok(gridTest && !gridTest.skip, '找到 grid 容器', JSON.stringify(gridTest));
  if (gridTest && !gridTest.skip) {
    ok(gridTest.before === gridTest.after,
      '★ 挂 class 前后 grid 间距不变（grid gap 不受影响）',
      'before ' + gridTest.before + ' / after ' + gridTest.after);
  }

  /* ================================================================
   * F. 绝对定位的子元素会不会被 margin 推歪
   *
   * 兼容层用的是 `容器 > * + * { margin-left / margin-top }`，它会给**所有**
   * 非首个子元素加外边距，包括 position:absolute 的那些。
   * 一个绝对定位元素如果靠 left/top 定位，margin 会把它从原位推开几像素 ——
   * 这种偏差在老内核上只有几像素，肉眼极难发现，但会累积成"某些东西对不齐"。
   * 目前页面里没有出现，这条断言是为了在它**将来出现时**能立刻报警。
   * ============================================================== */
  console.log('\n[F] 绝对定位子元素是否被 margin 影响');
  const absCheck = await evaluate(`(function(){
    var rules = [];
    Array.prototype.forEach.call(document.styleSheets, function(sh){
      try {
        Array.prototype.forEach.call(sh.cssRules, function(r){
          if (r.selectorText && r.selectorText.indexOf('html.no-flex-gap') >= 0) rules.push(r.selectorText);
        });
      } catch (e) {}
    });
    var risky = [];
    Array.prototype.forEach.call(document.querySelectorAll('body *'), function(el){
      var cs = getComputedStyle(el);
      if (!/flex/.test(cs.display)) return;
      if (el.children.length < 2) return;
      if (!el.getBoundingClientRect().width) return;
      var kid = el.children[el.children.length - 1];
      var covered = rules.some(function(sel){ try { return kid.matches(sel); } catch (e) { return false; } });
      if (!covered) return;
      /* 这个容器被兼容层管着 —— 看它的非首个子元素里有没有绝对定位 */
      for (var i = 1; i < el.children.length; i++) {
        var pos = getComputedStyle(el.children[i]).position;
        if (pos === 'absolute' || pos === 'fixed') {
          risky.push((el.className || el.tagName) + ' → child[' + i + '] ' + pos);
        }
      }
    });
    return { risky: risky };
  })()`);
  ok(absCheck && absCheck.risky.length === 0,
    '★ 被兼容层覆盖的容器里没有绝对定位的非首个子元素（否则会被 margin 推歪）',
    (absCheck && absCheck.risky.join(' | ')) || '');

  /* ================================================================
   * G. 控制台
   * ============================================================== */
  console.log('\n[G] 控制台');
  const errs = await evaluate('(window.__probeErrors || []).slice(0, 8)');
  ok(Array.isArray(errs) && errs.length === 0, '页面没有未捕获异常', JSON.stringify(errs));

  console.log('\n========================================');
  console.log(fail === 0 ? '全部通过' : '有失败');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');

  try { edge.kill(); } catch (e) {}
  server.close();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
