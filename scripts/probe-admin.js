/**
 * 后台「模拟对战」全链路探针
 * 跑法：node scripts/probe-admin.js
 *
 * 为什么需要它：`pwa/test/admin.test.js` 是**静态契约**——它只能证明
 * 「页面里写的路径在服务端存在」，证明不了「点下去真的能跑」。
 * 而这个后台的三个页签全是异步 + 轮询 + 局部重绘，坏起来很像：
 * 页面在、按钮在、点下去什么都不发生，控制台一条错都没有
 * （历史上有过 fetch 异常没人接，界面毫无变化）。
 *
 * 这条探针做的是：真起一个服务端实例 → 真注册 3 个账号 → 真开无头浏览器 →
 * 真点「开始模拟」→ 等它把 2 场 × 3 把打完 → 核对进度、明细、榜单增量 → 切排行榜。
 *
 * 两个刻意的做法：
 *
 * 1. **断言锚定「刚启动的那个任务」**，不看页面上「某个」任务的状态。
 *    第一版就是被上一轮遗留的「已完成 2/2」骗过去的：新任务因为按钮没启用压根没启动，
 *    三条断言却全绿。所以这里先从 `#btn-bot-stop[data-job]` 取到新 id，
 *    之后所有判断都要求 `id === newJob`。
 *
 * 2. **控制台异常算失败**。页内 IIFE 静默抛错是这类页面的典型假绿来源：
 *    视觉上什么都没变，只有 console 里有痕迹。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { findBrowser } = require('./lib/browser');

const W = Number(process.argv[2]) || 1280;
const H = Number(process.argv[3]) || 1000;
const SRV_PORT = 3061;
const CDP_PORT = 9366;
const KEY = 'probe-admin-key';
const PASSWORD = 'probepass1234';
const ACCOUNTS = ['probeak', 'probebk', 'probeck'];
const SHOT_DIR = process.env.SHOT_DIR ? path.resolve(process.env.SHOT_DIR) : path.join(os.tmpdir(), 'lxw-admin-probe');

const BASE = 'http://127.0.0.1:' + SRV_PORT;
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

function postJson(url, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = JSON.stringify(body || {});
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }, headers || {})
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch (e) { resolve({ status: res.statusCode, body: null }); } });
    });
    req.on('error', reject);
    req.end(payload);
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
      } else if (msg.method) {
        events.push(msg);
      }
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => resolve({
      events,
      send(method, params) {
        return new Promise((res, rej) => {
          id += 1;
          waiting.set(id, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id, method, params: params || {} }));
        });
      },
      close() { try { ws.close(); } catch (e) { /* 已断 */ } }
    }));
  });
}

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const dataDir = path.join(os.tmpdir(), 'lxw-admin-probe-' + Date.now());
  fs.mkdirSync(dataDir, { recursive: true });

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(SRV_PORT),
      HOST: '127.0.0.1',
      PROFILE_FILE: path.join(dataDir, 'profiles.json'),
      SEED_FILE: path.join(dataDir, 'seed.json'),
      BACKUP_KEY: KEY
    }),
    stdio: 'ignore'
  });

  let up = false;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try { await getJson(BASE + '/api/health'); up = true; break; } catch (e) { /* 还没起来 */ }
  }
  if (!up) { console.error('服务端没起来'); server.kill(); process.exit(1); }

  /* 账号先注册好：后台的玩家池是读 /admin/users，没有账号就没得选 */
  for (const name of ACCOUNTS) {
    await postJson(BASE + '/api/auth/register', { name: name, password: PASSWORD, nickname: name });
  }
  const reg = await postJson(BASE + '/api/auth/login', { name: ACCOUNTS[0], password: PASSWORD });
  ok(!!(reg.body && reg.body.ok), '预置账号可登录', reg.body && reg.body.error);

  const exe = findBrowser();
  const edge = spawn(exe, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(os.tmpdir(), 'lxw-admin-edge-' + Date.now()),
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
    } catch (e) { /* 未就绪 */ }
  }
  if (!page) { console.error('连不上浏览器 CDP'); edge.kill(); server.kill(); process.exit(1); }

  const cdp = await cdpConnect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __error: String(r.exceptionDetails.text) };
    return r.result && r.result.value;
  };
  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(r.data, 'base64'));
  };

  await cdp.send('Page.navigate', { url: BASE + '/admin.html' });
  await sleep(1500);

  console.log('\n[页面加载]');
  ok(/管理后台/.test(String(await evaluate('document.querySelector("h1").textContent'))), '标题渲染');
  ok(await evaluate('document.querySelectorAll(".tab").length') === 3, '三个页签');

  console.log('\n[载入账号]');
  await evaluate('document.querySelector("#key").value=' + JSON.stringify(KEY));
  await evaluate('document.querySelector("#btn-load").click()');
  await sleep(1200);
  const poolRows = await evaluate('document.querySelectorAll("#pool .pool-row:not(.head)").length');
  ok(poolRows >= 3, '玩家池渲染出账号', poolRows);
  ok(await evaluate('document.querySelectorAll("#table-wrap tbody tr").length') >= 3, '用户表渲染出账号');

  console.log('\n[页签切换 + 排行榜]');
  await evaluate('document.querySelector(\'[data-tab="bot"]\').click()');
  await sleep(300);
  ok(await evaluate('!document.querySelector("#pane-bot").classList.contains("hidden")'), '切到模拟对战页签');
  await evaluate('document.querySelector(\'[data-tab="board"]\').click()');
  await sleep(1200);
  /* 新实例还没人打过，榜是空的 —— 这里断言的是「页面能正常表达空态」，
   * 而不是「有数据」。有数据的断言放到任务跑完之后。 */
  ok(/还没有人上榜/.test(String(await evaluate('document.querySelector("#board-wrap").innerText'))), '空榜单给出空态说明');

  console.log('\n[起一次真实任务]');
  await evaluate('document.querySelector(\'[data-tab="bot"]\').click()');
  await sleep(300);
  const oldJob = await evaluate('(function(){var o=document.querySelector("#job-pick option");return o?o.value:"";})()');
  await evaluate(`(function(){
    var rows=[].slice.call(document.querySelectorAll('#pool .pool-row:not(.head)')).slice(0,3);
    rows.forEach(function(r){
      var cb=r.querySelector('input[type=checkbox]');
      cb.checked=true;
      /* 真用户点勾选框时 change 是从 checkbox 冒泡上来的 */
      cb.dispatchEvent(new Event('change',{bubbles:true}));
      var p=r.querySelector('input[data-pw]');
      p.value=${JSON.stringify(PASSWORD)};
      p.dispatchEvent(new Event('input',{bubbles:true}));
    });
    document.querySelector('#bot-rooms').value='2';
    document.querySelector('#bot-hands').value='3';
    document.querySelector('#bot-pace').value='fast';
    return document.querySelectorAll('#pool input[type=checkbox]:checked').length;
  })()`);
  await sleep(300);
  ok(await evaluate('document.querySelectorAll("#pool input[type=checkbox]:checked").length') === 3, '勾选 3 个玩家');
  ok(await evaluate('!document.querySelector("#btn-bot-start").disabled'), '「开始模拟」可用');
  await shot('01-form.png');

  await evaluate('document.querySelector("#btn-bot-start").click()');
  await sleep(2000);
  const newJob = await evaluate('(function(){var b=document.querySelector("#btn-bot-stop");return b?b.getAttribute("data-job"):"";})()');
  ok(!!newJob && newJob !== oldJob, '任务已启动（拿到新任务 id）', { newJob: newJob, oldJob: oldJob });
  ok(/已启动/.test(String(await evaluate('document.querySelector("#bot-hint").textContent'))), '页面提示已启动');

  /* 等这一个任务跑完。断言锚定 newJob —— 不看页面上「某个」任务的状态 */
  let done = false, last = null;
  for (let i = 0; i < 60; i++) {
    await sleep(1500);
    const st = await evaluate(`(function(){
      var b=document.querySelector('#btn-bot-stop');
      var el=document.querySelector('#job-view');
      if(!el) return {id:'',text:''};
      return {id:b?b.getAttribute('data-job'):'', text:el.innerText.replace(/\\s+/g,' ').slice(0,300)};
    })()`);
    last = st;
    if (st && st.id === newJob && /已完成/.test(st.text) && /场 2\/2/.test(st.text)) { done = true; break; }
  }
  ok(done, '目标任务跑完（2/2 场）', last);
  await shot('02-done.png');

  const detail = String(await evaluate('(function(){var el=document.querySelector("#job-view");return el?el.innerText.replace(/\\s+/g," "):"";})()'));
  ok(/把 6\/6/.test(detail), '6 把全部完成', detail.slice(0, 160));
  ok(/场次 0→2/.test(detail), '榜单增量 0→2（战绩真的落库了）', detail.slice(0, 220));
  ok((detail.match(/完成/g) || []).length >= 2, '逐场明细两场都是「完成」');

  await evaluate('(function(){var d=document.querySelector("#job-view details"); if(d) d.open=true;})()');
  await sleep(400);
  ok(await evaluate('document.querySelectorAll("#job-view details tbody tr").length') >= 6, '逐把流水 6 条');
  await shot('03-hands.png');

  console.log('\n[排行榜回来了]');
  await evaluate('document.querySelector(\'[data-tab="board"]\').click()');
  await sleep(1400);
  const boardRows = await evaluate('document.querySelectorAll("#board-wrap tbody tr").length');
  ok(boardRows >= 3, '排行榜出现 3 个人', boardRows);
  const first = String(await evaluate('(document.querySelector("#board-wrap tbody tr")||{}).innerText'));
  ok(/2 场|2\b/.test(first), '第一名场次是 2', first);
  await shot('04-board.png');

  console.log('\n[控制台]');
  const errs = cdp.events.filter((e) =>
    e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Log.entryAdded' && e.params && e.params.entry && e.params.entry.level === 'error') ||
    (e.method === 'Runtime.consoleAPICalled' && e.params && e.params.type === 'error'));
  ok(errs.length === 0, '无 JS 异常 / console.error', errs.map((e) => JSON.stringify(e.params).slice(0, 160)));

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  console.log('截图: ' + SHOT_DIR);
  cdp.close();
  edge.kill();
  server.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('探针崩溃：', e && e.stack || e);
  process.exit(1);
});
