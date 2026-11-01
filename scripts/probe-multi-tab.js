/**
 * 诊断：同一台设备、同一个浏览器、开多个标签登录多个账号，会发生什么？
 *
 * 跑法：node scripts/probe-multi-tab.js
 *
 * 为什么要有这个脚本：
 *   玩家反馈「和朋友玩好友房基本不卡，但自己在本地开三个账号同时玩就特别卡」。
 *   两组对照的服务器、协议、网络都是同一套，唯一变量是**一台设备上叠了几个客户端**。
 *   而「叠几个客户端」里藏着一个不是性能问题的问题：
 *     localStorage 是按 **origin** 共享的，不按标签页隔离。
 *   而本项目的登录态就存在 localStorage 的同一个键 `lxw_session_v1` 里
 *   （见 pwa/js/authStore.js 的 LS_KEY）。于是三个标签会互相覆盖同一个令牌。
 *
 * 这个脚本不猜，直接在真 Edge 里开两个标签、各登录一个账号，观察：
 *   [1] 第二个标签登录后，第一个标签的 localStorage 里是谁的令牌
 *   [2] 第一个标签 refresh 一次，会不会把第二个标签的令牌冲掉
 *   [3] 两个标签交替 refresh，session 会不会在 A/B 之间来回跳（这就是「卡」的源头之一）
 *
 * 结论无论是「踩」还是「不踩」，都同样是有效答案 —— 所以脚本只报事实，不预设。
 *
 * ★ 事后更正（v54）：这个脚本查的是「**同一个浏览器**开多个标签」，而玩家那次反馈用的是
 *   **三个独立容器**（Safari / Edge / PWA 安装各有自己的 localStorage），根本不会串号。
 *   那次「提交完切回来整屏只剩背景色」的真因是 `resize()` 读到 0 尺寸算出了 `scale(0)`，
 *   见 REVIEW 第十一章 P9-1，回归断言在 `scripts/journey.js` 的 `[9c]`。
 *   这个脚本仍然有效——它证明的是「同一浏览器开两个标签玩会互相顶掉登录态」这条真实限制，
 *   只是**和那次反馈不是同一件事**。别拿着它的结论去解释白屏。
 *
 * 端口：服务端 3973 / CDP 9381（避开 journey 的 3971/9377 和 probe-table 的其它端口）
 * 全程用临时 PROFILE_FILE，绝不读写 server/data/。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SRV_PORT = 3973;
const CDP_PORT = 9381;
const TMP = path.join(os.tmpdir(), 'lxw-multitab-' + Date.now());
const W = 390, H = 844;

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function info(label, val) { console.log('    ' + label + '：' + val); }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(new Error('timeout')); });
  });
}

/* 新标签必须用 PUT（Chrome 111+ 对 /json/new 的 GET 直接 405） */
function newTab(url) {
  return new Promise((resolve, reject) => {
    const u = new URL('http://127.0.0.1:' + CDP_PORT + '/json/new?url=' + encodeURIComponent(url));
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'PUT' }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 300) return reject(new Error('/json/new ' + res.statusCode + ' ' + body.slice(0, 100)));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
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

/* 页面里求值，返回 JSON 值；导航中会抛，交给 waitFor 重试 */
async function evalIn(tab, expr) {
  const r = await tab.cdp.send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true
  });
  if (r && r.exceptionDetails) {
    throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || 'eval 抛异常');
  }
  return r && r.result ? r.result.value : undefined;
}

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { last = e; }
    await sleep(120);
  }
  throw new Error('等待超时：' + label + (last ? '（最后一次错误：' + last.message + '）' : ''));
}

/* 把标签导航到首页，并做两件和 journey 一样的准备：
 * 预置「引导已看」避免弹窗遮挡；干掉 serviceWorker 避免首访 reload 冲掉状态。 */
async function prepare(tab) {
  await tab.cdp.send('Page.enable');
  await tab.cdp.send('Runtime.enable');
  await tab.cdp.send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 2, mobile: true
  });
  /* 两个必须在**每个新文档**生成前就位的补丁（照 journey.js 的做法）：
   *
   * 1) 预置「引导已看」标记：新账号第一次打开必弹引导，它盖住整个牌桌。
   * 2) 把 navigator.serviceWorker 换成**假对象**，而不是 undefined。
   *    这一点踩过：第一次写成 `get(){ return undefined; }`，页面里
   *    `navigator.serviceWorker.addEventListener(...)` 直接抛 TypeError，
   *    game.js 的 init() 在 `showScreen('screen-auth')` 之前就中断了，
   *    于是界面停在 HTML 里默认可见的首页 —— 看着像「莫名其妙跳过了登录」。
   *    **禁掉一个 API 不等于把它设成 undefined：调用方会调它的方法。**
   *    所以 register 返回 rejected（index.html 本来就 .catch），其余做成 noop，全程零报错。
   */
  await tab.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__errs = [];
      window.addEventListener('error', function(e){
        window.__errs.push(String((e && e.message) || 'unknown') + ' @ ' + ((e && e.filename) || '') + ':' + ((e && e.lineno) || 0));
      });
      window.addEventListener('unhandledrejection', function(e){
        window.__errs.push('unhandledrejection: ' + String((e && e.reason && e.reason.message) || (e && e.reason)));
      });
      try { localStorage.setItem('lxw_guide_seen_v1','1'); } catch (e) {}
      try {
        var fakeSw = {
          register: function(){ return Promise.reject(new Error('probe: sw disabled')); },
          addEventListener: function(){}, removeEventListener: function(){},
          getRegistrations: function(){ return Promise.resolve([]); },
          controller: null, ready: Promise.resolve({ active: null })
        };
        Object.defineProperty(navigator, 'serviceWorker', { get: function(){ return fakeSw; }, configurable: true });
      } catch (e) {}
    `
  });
  await tab.cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + SRV_PORT + '/' });
  await waitFor(() => evalIn(tab, 'document.readyState === "complete" && !!window.AuthStore'), 20000, '页面就绪');
  /* 只等「页面 + 模块就绪」，**不等登录页**：
   * 第二个标签打开时很可能直接继承了上一个账号的登录态（这本身就是要观察的现象），
   * 硬等登录页会把它误判成失败。 */
  await sleep(500);
}

/* 保证当前停在登录页。第二个标签会继承别的账号的登录态，所以要先登出再回到登录页。 */
async function ensureAuthScreen(tab) {
  const onAuth = await evalIn(tab, `(function(){
    var a = document.getElementById('screen-auth');
    return !!(a && !a.classList.contains('hidden'));
  })()`);
  if (onAuth) return { already: true };
  const sess = await evalIn(tab, 'AuthStore.session()');
  if (!sess) throw new Error('既不在登录页、也没有登录态，界面状态不明');
  await evalIn(tab, 'AuthStore.logout(); true');
  await evalIn(tab, 'location.reload(); true');
  await waitFor(() => evalIn(tab, `(function(){
    var a = document.getElementById('screen-auth');
    return !!(a && !a.classList.contains('hidden'));
  })()`), 15000, '登出后回到登录页');
  return { kickedOut: sess.name };
}

/* 注册一个账号，返回 { name, playerId }
 *
 * 判据必须用「会话真的落地了」，不能用「#screen-home 可见」——
 * 首页在 index.html 里初始就**没有** hidden 类（启动时才切到登录页），
 * 所以那个条件在页面一加载时就是真的，注册还没发出去它就返回了。
 * 这和 REVIEW 8.4 那四次假失败是同一类：判据不是只在目标事件发生后才成立。 */
async function register(tab, name) {
  await ensureAuthScreen(tab);

  await evalIn(tab, `document.querySelector('[data-auth-tab="register"]').click()`);
  await sleep(200);
  await evalIn(tab, `(function(){
    document.getElementById('auth-name').value = ${JSON.stringify(name)};
    document.getElementById('auth-pass').value = 'pass123456';
    var nick = document.getElementById('auth-nick');
    /* 昵称必须带完整账号名。上一版取 name.slice(-3)，而两个账号名只有
     * 前缀差一位（mta… / mtb…）、末三位都是同一串时间戳 —— 于是两个账号
     * 的昵称一模一样，第二次注册被服务端的「昵称唯一」挡下来。
     * 看起来像产品 bug（同一浏览器注册不了第二个账号），其实是探针自己撞的。 */
    if (nick) nick.value = ${JSON.stringify('多标签' + name)};
    return true;
  })()`);
  await evalIn(tab, `document.getElementById('btn-auth-submit').click()`);

  try {
    await waitFor(async () => {
      const s = await evalIn(tab, 'AuthStore.session()');
      return !!(s && s.name === name);
    }, 20000, '注册后会话落地 ' + name);
  } catch (e) {
    const err = await evalIn(tab, `(function(){
      var e = document.getElementById('auth-err');
      return e && !e.classList.contains('hidden') ? e.textContent : '(无 auth-err)';
    })()`);
    throw new Error(e.message + ' ｜ 登录页提示：' + err);
  }
  return evalIn(tab, 'AuthStore.session()');
}

/* 只读 localStorage 里那个键，绕开 AuthStore 的内存缓存 */
const readRaw = (tab) => evalIn(tab, `(function(){
  try { var s = JSON.parse(localStorage.getItem('lxw_session_v1') || 'null'); return s ? {name: s.name, playerId: s.playerId, tokenHead: (s.token||'').slice(0,10)} : null; }
  catch (e) { return null; }
})()`);

const readMem = (tab) => evalIn(tab, `(function(){
  var s = AuthStore.session();
  return s ? {name: s.name, playerId: s.playerId, tokenHead: (s.token||'').slice(0,10)} : null;
})()`);

async function main() {
  fs.mkdirSync(TMP, { recursive: true });

  console.log('\n[1] 起临时服务端 + 真 Edge');

  if (!fs.existsSync(EDGE)) {
    console.log('\n[SKIP] 本机没有 Edge（' + EDGE + '），这不是通过。\n');
    process.exit(2);
  }

  const srv = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(SRV_PORT),
      HOST: '127.0.0.1',
      PROFILE_FILE: path.join(TMP, 'profiles.json'),
      SEED_FILE: path.join(TMP, 'seed-none.json')
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));

  await waitFor(async () => {
    try { const h = await getJson('http://127.0.0.1:' + SRV_PORT + '/api/health'); return h && h.ok !== false; }
    catch (e) { return false; }
  }, 15000, '服务端起来');

  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(TMP, 'edge-profile'),   // 同一个 user-data-dir = 同一份磁盘存储
    '--window-size=' + W + ',' + H,
    '--force-device-scale-factor=1',
    'about:blank'
  ], { stdio: 'ignore' });

  let firstPage = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const list = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
      firstPage = (list || []).find((t) => t.type === 'page');
      if (firstPage) break;
    } catch (e) { /* 还没起来 */ }
  }
  if (!firstPage) throw new Error('连不上 Edge CDP');

  const tabA = { cdp: await cdpConnect(firstPage.webSocketDebuggerUrl) };
  await prepare(tabA);
  info('第一个标签就绪', 'ok');
  ok(true, '真 Edge 里起了第一个标签');

  console.log('\n[2] 标签 A 注册账号 A');
  const tag = Date.now().toString().slice(-6);
  const nameA = 'mta' + tag;
  const nameB = 'mtb' + tag;
  const sessA = await register(tabA, nameA);
  info('账号 A', sessA.name + ' / playerId ' + sessA.playerId);
  const raw1 = await readRaw(tabA);
  ok(!!raw1 && raw1.name === nameA, '标签 A 的 localStorage 里是账号 A 的会话');

  console.log('\n[3] 同一个浏览器再开第二个标签，注册账号 B');
  const second = await newTab('about:blank');
  const tabB = { cdp: await cdpConnect(second.webSocketDebuggerUrl) };
  await prepare(tabB);

  /* 这一条是整件事的起点，也是最容易被忽略的：
   * 第二个标签刚打开、什么都还没做，它就已经是账号 A 了。 */
  const inherited = await readMem(tabB);
  info('标签 B 一打开时的登录态', JSON.stringify(inherited));
  ok(!!inherited && inherited.name === nameA,
    '★ 新标签一打开就继承了账号 A 的登录态（localStorage 同源共享，不是按标签隔离）');

  const sessB = await register(tabB, nameB);
  info('账号 B', sessB.name + ' / playerId ' + sessB.playerId);

  const rawInB = await readRaw(tabB);
  ok(!!rawInB && rawInB.name === nameB, '标签 B 自己的 localStorage 读出来是账号 B（正常）');

  console.log('\n[4] ★ 关键：回到标签 A，看它现在读到的是谁的令牌');
  const rawInA = await readRaw(tabA);
  const memInA = await readMem(tabA);
  info('标签 A 的 localStorage', JSON.stringify(rawInA));
  info('标签 A 的 AuthStore 内存里', JSON.stringify(memInA));

  if (rawInA && rawInA.name === nameB) {
    ok(true, 'localStorage 被第二个标签覆盖成了账号 B（同源共享，不是按标签隔离）');
  } else {
    ok(false, '预期 localStorage 会被 B 覆盖，实际是 ' + JSON.stringify(rawInA),
      '如果没被覆盖说明这个环境按标签隔离了存储，下面几条前提不成立');
  }
  ok(!!memInA && memInA.name === nameA,
    '但标签 A 的内存缓存还是 A —— 所以「当场」看不出问题，问题要等下一次落盘');

  console.log('\n[5] ★ 标签 A refresh 一次（每次打开/回前台都会做）：会不会把 B 的令牌冲掉');
  const refreshRet = await evalIn(tabA, 'AuthStore.refresh()');
  info('标签 A refresh 结果', JSON.stringify(refreshRet));
  await sleep(300);
  const rawAfterA = await readRaw(tabA);
  const rawAfterB = await readRaw(tabB);
  info('refresh 后 localStorage', JSON.stringify(rawAfterA));
  info('     标签 B 读到的', JSON.stringify(rawAfterB));

  if (rawAfterA && rawAfterA.name === nameA) {
    ok(true, '★ 标签 A 一次 refresh 就把 localStorage 从 B 改回了 A（两个标签在抢同一个键）');
  } else {
    ok(false, '预期 A 的 refresh 会把自己的令牌写回去', JSON.stringify(rawAfterA));
  }

  console.log('\n[6] ★ 两个标签交替 refresh，看 session 会不会来回跳');
  const seq = [];
  for (let i = 0; i < 3; i++) {
    await evalIn(tabA, 'AuthStore.refresh()');
    await sleep(120);
    const a = await readRaw(tabA);
    await evalIn(tabB, 'AuthStore.refresh()');
    await sleep(120);
    const b = await readRaw(tabB);
    seq.push({ round: i + 1, storageAfterA: a && a.name, storageAfterB: b && b.name,
               memB: (await readMem(tabB)).name });
  }
  seq.forEach((s) => info('第 ' + s.round + ' 轮', JSON.stringify(s)));

  /* 每一轮结束时，存储里留下的是最后 refresh 的那个标签的身份 */
  const alwaysOwnA = seq.every((s) => s.storageAfterA === nameA);
  ok(alwaysOwnA, '每次 A refresh 都能成功覆盖（说明覆盖是常态，不是偶发）');

  console.log('\n[7] ★ 最狠的一条：A 刷新之后，B 页面重载一次，它会变成谁');
  /* 这不是造出来的极端情况 —— 手机上「切到别的 App 再切回来」，
   * 后台标签被系统回收后重开、SW 更新后自动 reload，都会走到这里。
   * 重载会丢掉内存缓存，只能按 localStorage 里那个唯一身份登录。 */
  await evalIn(tabA, 'AuthStore.refresh()');
  await sleep(250);
  const storageBeforeReload = await readRaw(tabB);
  info('B 重载前 localStorage 里是', storageBeforeReload && storageBeforeReload.name);

  await tabB.cdp.send('Page.reload');
  await waitFor(() => evalIn(tabB, 'document.readyState === "complete" && !!window.AuthStore'), 20000, 'B 重载完成');
  await sleep(700);

  const afterReload = await readMem(tabB);
  info('B 重载之后变成了', JSON.stringify(afterReload));
  ok(!!afterReload && afterReload.name === nameA,
    '★ B 重载后变成了账号 A 的身份（B 自己那个号「丢了」）—— 这就是串台',
    '实际是 ' + JSON.stringify(afterReload && afterReload.name));
  ok(!!afterReload && afterReload.name !== nameB,
    '★ B 已经不再是 B（换号玩家看到的「我怎么变成别人了」就是这个）',
    '实际是 ' + JSON.stringify(afterReload && afterReload.name));

  console.log('\n[8] 收尾');
  try { await tabA.cdp.send('Page.close'); } catch (e) {}
  try { await tabB.cdp.send('Page.close'); } catch (e) {}
  tabA.cdp.close(); tabB.cdp.close();
  try { edge.kill(); } catch (e) {}
  try { srv.kill(); } catch (e) {}

  /* 收尾顺序：先 kill 进程，再删目录 —— Windows 上 Edge 的用户目录被占着时 rm 会 EBUSY */
  await sleep(700);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('========================================');
  if (fail > 0) process.exitCode = 1;
}

process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
});

main().catch((e) => {
  console.error('\n[诊断失败] ' + (e && e.stack || e));
  process.exit(1);
});
