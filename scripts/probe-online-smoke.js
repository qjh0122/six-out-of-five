/**
 * 线上冒烟：用真实浏览器打开**已经部署的地址**，收一遍 console 与网络错误
 *
 * 为什么必须有这一步（v79 发布时立的规矩）：
 * 前面所有探针跑的都是本地静态服务，没有部署网关这一层。而网关要求每个请求带
 * `?sharecode=`，不带的一律 403 —— 麻烦在于**不同请求走的补丁不一样**：
 *   · 页面自己的 `<script>` / `<link>` → 经 SW 拦截，withShare() 补上 → 200
 *   · manifest / apple-touch-icon / manifest 里的 icons → **浏览器内部抓取，不经过 SW** → 403
 * 于是"本地全绿、线上图标全裂"这种事，只有真的用浏览器打开一次才看得见。
 * curl 也看不出来：curl 的 query 是我自己拼的，浏览器不会那样拼。
 *
 * 判据全部来自浏览器实测（DOM 计算样式、Runtime.exceptionThrown、Network.responseReceived），
 * 不看本地文件。
 *
 * 用法：
 *   node scripts/probe-online-smoke.js
 *   node scripts/probe-online-smoke.js "https://.../?sharecode=XXX" 430 932
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

/* 线上地址不写死：仓库公开，房号（sharecode）等于进房口令。
 * 用法：node scripts/probe-online-smoke.js 'https://<host>/?sharecode=<口令>'
 *      或 LXW_URL=... node scripts/probe-online-smoke.js */
const URL0 = process.argv[2] || process.env.LXW_URL || '';
if (!URL0) {
  console.error('缺少线上地址。用法：node scripts/probe-online-smoke.js https://<host>/?sharecode=<口令>');
  process.exit(2);
}
const W = Number(process.argv[3]) || 390;
const H = Number(process.argv[4]) || 844;
const CDP_PORT = 9411;
const SHOT_DIR = path.join(os.tmpdir(), 'lxw-smoke');

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
    const events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && waiting.has(msg.id)) {
        const w = waiting.get(msg.id);
        waiting.delete(msg.id);
        if (msg.error) w.reject(new Error(JSON.stringify(msg.error)));
        else w.resolve(msg.result);
        return;
      }
      if (msg.method) events.push(msg);
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => {
      resolve({
        events,
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

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const edge = spawn(exe, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(os.tmpdir(), 'lxw-smoke-edge-' + Date.now()),
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
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __error: String(r.exceptionDetails.text) };
    return r.result && r.result.value;
  };

  await cdp.send('Page.navigate', { url: URL0 });
  await sleep(6000);

  /* 等 SW 真正接管，而不是在固定 6 秒时瞄一眼。
   *
   * 第一次访问要跑完 register → install（预缓存 43 条）→ activate → clients.claim()，
   * 弱网下完全可能超过 6 秒。上一版就是固定 sleep 之后直接读 controller，
   * 横屏那次刚好没赶上，报了个「SW 没接管」的假失败 —— 而它其实只是慢。
   * 判据要看「最终状态」，不是「某一刻」。 */
  const swState = await evaluate(`new Promise(function (res) {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) return res('controlled');
    var t0 = Date.now();
    var iv = setInterval(function () {
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        clearInterval(iv); res('controlled');
      } else if (Date.now() - t0 > 14000) {
        clearInterval(iv); res('none');
      }
    }, 250);
  })`);

  const state = await evaluate(`(function(){
    var home = document.getElementById('screen-home');
    var auth = document.getElementById('screen-auth');
    var tk = document.getElementById('btn-auth-submit');
    var sw = navigator.serviceWorker && navigator.serviceWorker.controller ? 'controlled' : 'none';
    var mf = document.querySelector('link[rel=manifest]');
    var ico = document.querySelector('link[rel=icon]');
    return {
      title: document.title,
      version: (document.querySelector('meta[name=app-version]')||{}).content || '',
      home: home ? getComputedStyle(home).display : 'MISSING',
      auth: auth ? getComputedStyle(auth).display : 'MISSING',
      loginBtn: !!tk && tk.textContent.trim(),
      bodyText: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 120),
      sw: sw,
      manifestHref: mf ? mf.getAttribute('href') : '',
      iconHref: ico ? ico.getAttribute('href') : '',
      w: window.innerWidth, h: window.innerHeight
    };
  })()`);

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const shotPath = path.join(SHOT_DIR, 'online-' + W + 'x' + H + '.png');
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));

  /* manifest 的**内容**与可安装性，必须在关闭 CDP 之前取。
   * 这两项是 v86 修复的核心：第一版「给图标 URL 拼 sharecode」部署后实测没生效 ——
   * 网关校验完 query 就把它剥掉了，服务端拿不到。现在图标是 data URI。 */
  const mfDoc = await evaluate(`(async function(){
    var l = document.querySelector('link[rel=manifest]');
    if (!l) return null;
    try {
      var d = await (await fetch(l.href, { cache: 'no-store' })).json();
      return {
        icons: (d.icons || []).map(function (i) { return String(i.src).slice(0, 24); }),
        count: (d.icons || []).length,
        hasScreens: 'screenshots' in d,
        startUrl: d.start_url
      };
    } catch (e) { return { err: String(e && e.message) }; }
  })()`);

  let instErrs = null;
  try {
    const r = await cdp.send('Page.getInstallabilityErrors');
    instErrs = r.installabilityErrors || [];
  } catch (e) { instErrs = [{ error: String(e && e.message) }]; }

  const exceptions = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown');
  const consoleErr = cdp.events.filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error');
  const logErr = cdp.events.filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error');
  const failedReq = cdp.events.filter((e) => e.method === 'Network.loadingFailed');
  const non200 = cdp.events.filter((e) => e.method === 'Network.responseReceived'
    && e.params.response.status >= 400);

  console.log(JSON.stringify(state, null, 2));
  console.log('---');
  console.log('JS 异常   ', exceptions.length);
  exceptions.slice(0, 5).forEach((e) => console.log('   ', e.params.exceptionDetails.text,
    (e.params.exceptionDetails.exception || {}).description || ''));
  console.log('console.error', consoleErr.length);
  consoleErr.slice(0, 5).forEach((e) => console.log('   ',
    (e.params.args || []).map((a) => a.value || a.description).join(' ')));
  console.log('Log.error ', logErr.length);
  logErr.slice(0, 5).forEach((e) => console.log('   ', e.params.entry.text, e.params.entry.url || ''));
  console.log('请求失败  ', failedReq.length, failedReq.slice(0, 3).map((e) => e.params.errorText).join(' | '));
  console.log('HTTP>=400 ', non200.length, non200.slice(0, 5).map((e) => e.params.response.status + ' ' + e.params.response.url).join(' | '));
  console.log('截图      ', shotPath);

  cdp.close();
  edge.kill();

  /* ================================================================
   * 断言：以前这个脚本只打印诊断，退出码只看 JS 异常 —— 于是「manifest 403」
   * 这种最要命的问题可以一直挂在输出里而没人当回事（BACKLOG N2 就是这么留了一个月）。
   * 现在它是一份**发布后核对清单**：能不能判绿，就代表这次发版能不能算完。
   * ============================================================== */
  console.log('\n===== 发布后核对 =====');

  let pass = 0, bad = 0;
  function ok(cond, name, detail) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { bad++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + detail : '')); }
  }

  /* 期望版本号从**本地** index.html 读：部署的就是这个仓库。
   * 写死一个版本号的话，发版忘了改这里，这条断言就永远在验证一个不存在的版本。 */
  const localHtml = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'index.html'), 'utf8');
  const EXPECT = (localHtml.match(/name="app-version"[^>]*content="([^"]+)"/) || [])[1] || '';

  ok(state && state.title === '六选五', '页面能打开且标题正确', state && state.title);
  ok(state && state.version === EXPECT,
    '★ 线上版本 = 本地版本（' + EXPECT + '）—— 部署真的生效了',
    state && ('线上 ' + state.version));
  ok(state && (state.home === 'flex' || state.auth === 'flex'),
    '首页或登录页有一屏是可见的（不是白屏）',
    state && ('home=' + state.home + ' auth=' + state.auth));
  ok(exceptions.length === 0, '没有未捕获的 JS 异常',
    exceptions.slice(0, 3).map((e) => e.params.exceptionDetails.text).join(' | '));
  ok(consoleErr.length === 0, '没有 console.error',
    consoleErr.slice(0, 3).map((e) => (e.params.args || []).map((a) => a.value).join(' ')).join(' | '));

  /* manifest 这一条是 v86 的重点：以前它 403，而「403 不算失败」的旧判据
   * 让它一直绿着。现在单独拎出来判 —— 因为它决定「能不能装成桌面应用」。 */
  const mfRes = cdp.events.filter((e) => e.method === 'Network.responseReceived'
    && /manifest\.webmanifest/.test(e.params.response.url));
  const mfOk = mfRes.length > 0 && mfRes.every((e) => e.params.response.status === 200);
  ok(mfOk, '★ manifest 抓取 200（403 的话安卓装不出 WebAppK、iOS 图标是截图）',
    mfRes.map((e) => e.params.response.status + ' ' + e.params.response.url).join(' | ') || '浏览器压根没请求 manifest');
  ok(state && /sharecode=/.test(state.manifestHref || ''),
    '★ manifest 的 href 带 sharecode（网关要求每个请求都带）',
    state && state.manifestHref);
  ok(state && /sharecode=/.test(state.iconHref || ''),
    '★ 声明了带码的 favicon（不再去请求 /favicon.ico）', state && state.iconHref);

  /* manifest 的内容：图标必须内联成 data URI。
   * 这一条是 v86 第二次修复才成立的 —— 第一版拼 sharecode 在真实网关上无效。 */
  ok(mfDoc && mfDoc.count === 4 && mfDoc.icons.every((s) => s.indexOf('data:image/png') === 0),
    '★ manifest 图标是 data URI（零网络请求，绕开网关）',
    JSON.stringify(mfDoc && mfDoc.icons));
  ok(mfDoc && !mfDoc.hasScreens,
    'manifest 里没有 screenshots 死链（它们同样拼不上码）', mfDoc && mfDoc.hasScreens);
  ok(mfDoc && mfDoc.startUrl === '/',
    'start_url 仍是 "/"（写死码会破坏轮换自愈）', mfDoc && mfDoc.startUrl);
  ok(Array.isArray(instErrs) && instErrs.length === 0,
    '★ installabilityErrors 为空（安卓能装成独立窗口，不是带地址栏的快捷方式）',
    JSON.stringify(instErrs).slice(0, 240));

  ok(non200.length === 0, '★ 没有任何 HTTP >= 400（favicon 404 / manifest 403 都算）',
    non200.slice(0, 4).map((e) => e.params.response.status + ' ' + e.params.response.url).join(' | '));
  ok(failedReq.length === 0, '没有请求失败（断网 / CORS / 被拦截）',
    failedReq.slice(0, 3).map((e) => e.params.errorText).join(' | '));
  ok(swState === 'controlled', 'Service Worker 已接管（离线能力在这条路上）',
    swState + '（等待 14 秒仍未接管）');

  console.log('\n通过 ' + pass + ' 项，失败 ' + bad + ' 项');
  if (bad > 0) {
    console.log('\n结论：**这次发布还不能算完成** —— 上面的 FAIL 逐条处理，或明确记录为已知限制。');
    process.exitCode = 1;
  } else {
    console.log('\n结论：线上核对通过。');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
