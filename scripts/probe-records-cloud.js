/**
 * 战绩页「云端数据源」探针（一次性诊断脚本，不进测试套件）
 *
 * 验的是这次改动的核心链路：战绩页不再读本机 localStorage，而是读服务器档案
 * （与排行榜同一份）。要确认三件事：
 *   1) 一进来就显示账号数据，页脚写的是「已保存到账号」而不是设备兜底文案；
 *   2) 数字口径没变味 —— 场次/胜率/净胜/单场最高/连胜连败/趋势条，全部来自档案；
 *   3) ★ 清除弹窗默认勾上「同时清除云端」，点确定真的会打 /api/me/reset-stats，
 *      清完当场切空态 —— 这是「删了战绩排行榜还在」的正解。
 *
 * 为什么不用真的服务端：这个探针只验前端接线（字段名映射、空态切换、按钮状态）。
 * 服务端的口径已经由 server/test/me-records.test.js 锁住了，两件事分开验更好定位。
 *
 * 用法：node scripts/probe-records-cloud.js [宽] [高] [输出目录]
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const W = Number(process.argv[2]) || 390;
const H = Number(process.argv[3]) || 844;
const OUT = process.argv[4] || path.join(os.tmpdir(), 'lxw-recc-' + Date.now());
const STATIC_PORT = 3043;
const CDP_PORT = 9353;
const ROOT = path.join(__dirname, '..', 'pwa');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.webmanifest': 'application/manifest+json', '.json': 'application/json'
};

/* ---------------- 假档案：25 局，流水给 20 条（服务端上限） ---------------- */
const NOW = Date.now();
function buildProfile() {
  const recent = [];
  for (let i = 0; i < 20; i++) {
    /* 最新一条 net = +39，往前交替输赢，方便肉眼对照 */
    recent.push({
      endedAt: NOW - i * 3600 * 1000,
      net: i === 0 ? 39 : (i % 3 === 0 ? 0 : (i % 2 ? -6 : 12)),
      roomId: String(700000 + i),
      playerCount: i === 0 ? 3 : 4,
      endReason: i % 4 === 0 ? 'scoreZero' : 'dissolve'
    });
  }
  /* 人机局流水：单独一份（aiRecent），不计入上面任何一个统计字段。
   * 时间刻意插在人类局之间 —— 战绩页要的是**一条**时间线，
   * 如果实现把两份数组首尾相接而不是按时间合并，这里的顺序就会露馅。 */
  const aiRecent = [
    { endedAt: NOW - 1800 * 1000, net: 21, roomId: '800000', playerCount: 3, endReason: 'scoreZero', ai: true },
    { endedAt: NOW - 5 * 3600 * 1000, net: -8, roomId: '800001', playerCount: 2, endReason: 'dissolve', ai: true },
    { endedAt: NOW - 9 * 3600 * 1000, net: 12, roomId: '800002', playerCount: 3, endReason: 'scoreZero', ai: true }
  ];
  return {
    playerId: 'p1',
    nickname: '玩家A',
    games: 25, wins: 18, losses: 6, draws: 1, winRate: 72,
    totalNet: 143, currentStreak: -2,
    longestStreak: 7, longestLoseStreak: 3,
    bestNet: 39, updatedAt: NOW,
    /* 刻意让它**大于** aiRecent 的行数（+2）：aiRecent 也是 20 条上限，
     * 只跟 AI 练球的人真会碰上「说明写 5 局、列表只列 3 行」。
     * 这里就是要跑到那个分支，验证说明行会补「列表近 3 场」。 */
    aiGames: aiRecent.length + 2,
    recent: recent,
    aiRecent: aiRecent
  };
}
let profile = buildProfile();
let resetCalls = 0;
/* 探针身份标记。端口被上一个残留实例占着时，我们会**连到别人的服务**，
 * 于是一路断言全红——看起来像代码回归，其实是环境问题。
 * 这个 nonce 让「连错了」当场变成一个明确的报错。 */
const NONCE = 'probe-' + Date.now() + '-' + Math.random().toString(36).slice(2);

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/api/auth/me') {
    return sendJson(res, 200, { ok: true, me: { playerId: 'p1', nickname: '玩家A', account: { name: 'test_acc', createdAt: NOW } } });
  }
  if (url === '/api/me/records') {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只接受 GET' });
    return sendJson(res, 200, { ok: true, profile: profile, serverTime: Date.now() });
  }
  if (url === '/api/me/reset-stats') {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' });
    resetCalls += 1;
    profile = Object.assign({}, profile, {
      games: 0, wins: 0, losses: 0, draws: 0, winRate: 0,
      totalNet: 0, currentStreak: 0, longestStreak: 0, longestLoseStreak: 0,
      bestNet: 0, recent: [],
      aiGames: 0, aiRecent: []      // 清空战绩连人机流水一起清（服务端 resetStatsOf 的口径）
    });
    return sendJson(res, 200, { ok: true, profile: profile });
  }
  if (url === '/api/leaderboard') return sendJson(res, 200, { ok: true, list: [] });
  if (url === '/__probe-nonce') return sendJson(res, 200, { nonce: NONCE });

  let p = url === '/' ? '/index.html' : url;
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

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(STATIC_PORT, '127.0.0.1', resolve);
  }).catch((e) => {
    console.error('端口 ' + STATIC_PORT + ' 起不来（' + e.code + '）：可能上一个探针实例还没退。'
      + '先 taskkill //F //IM msedge.exe，或换个端口再跑。');
    process.exit(1);
  });

  const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const userDir = path.join(os.tmpdir(), 'lxw-recc-edge-' + Date.now());
  const edge = spawn(exe, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + userDir,
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
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
  /* 页面级身份标记：只有**本进程新建的文档**才有这个值。
   * nonce 校验只能证明「页面连的是我的服务」，证明不了「这个文档是新的」——
   * 如果 CDP 连到了上一个残留浏览器的旧页面，它的 fetch 会打到我的服务上、
   * nonce 一样能对上，但 DOM 是旧的。两个一起校验才封死。 */
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "window.__probeNonce = " + JSON.stringify(NONCE) + ";"
  });

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { error: String(r.exceptionDetails.text) };
    return r.result && r.result.value;
  };
  /* 显式等待，别用固定 sleep 赌浏览器启动速度：
   * 机器一忙，sleep(1800) 可能还没等到首屏脚本绑好事件，点击就落空了，
   * 于是整段断言集体失败——这种「偶发全红」最容易被误判成代码回归。 */
  async function waitFor(expr, ms) {
    const deadline = Date.now() + (ms || 6000);
    while (Date.now() < deadline) {
      const v = await evaluate(expr);
      if (v) return true;
      await sleep(120);
    }
    return false;
  }

  /* 等 Node 侧计数器变大。
   * ★ 为什么不能只等页面变空态：空态出现 ≠ 请求已到达服务端。
   *   上一轮这条断言报过 resetCalls=0，而页面确实空了 —— 断言在请求还在飞的时候
   *   就执行了，读到的是 0。它既可能是「真的没发请求」，也可能只是「读早了」，
   *   两种含义完全不同的故障混成一个数字，等于没有诊断力。
   *   改成显式等计数达标：真没发就是超时失败，发慢了就是多等 100ms 后通过。 */
  async function waitForFlag(get, ms) {
    const deadline = Date.now() + (ms || 6000);
    while (Date.now() < deadline) {
      if (get() > 0) return true;
      await sleep(80);
    }
    return false;
  }

  /* 打开战绩页并**确认真的打开了**。
   * 首屏还在跑 boot 序列（refresh → 回座）时，一次过早的点击会被随后的
   * showScreen('screen-home') 顶掉——这是启动期的真实竞态，不是探针写错。
   * 这里重试并校验，既能稳定复现，也不会把真失败掩盖成「偶发」。 */
  async function openRecordsScreen() {
    for (let i = 0; i < 4; i++) {
      await evaluate(`document.getElementById('btn-records-home').click()`);
      const opened = await waitFor(`(function(){
        var s = document.getElementById('screen-records');
        return !!(s && !s.classList.contains('hidden'));
      })()`, 2500);
      if (opened) return i;
      await sleep(400);
    }
    return -1;
  }

  /* 截图前必须先等切屏/入场动画跑完。
   * 这个仓库已经踩过两次「动画中途取证」：第 19 章把弹窗错峰入场当成卡住、
   * 第 20 章把 translateX 入场中的 -63px 当成整屏右移。这次又差点第三次
   * ——横屏战绩页的截图里内容只剩右边一条，而同一时刻量矩形是居中的
   * （rp-nav 209..635 / ink 230..614，屏宽 844）。像素和矩形不符时，
   * 先怀疑取证时机，别急着报 bug。 */
  async function settleScreens(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 2500)) {
      const busy = await evaluate(`(function(){
        var list = Array.prototype.slice.call(document.querySelectorAll('.screen'));
        return list.some(function(s){
          return !s.classList.contains('hidden') && getComputedStyle(s).transform !== 'none';
        });
      })()`);
      if (!busy) { await sleep(260); return true; }
      await sleep(80);
    }
    return false;
  }

  async function shot(name) {
    await settleScreens();
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const p = path.join(OUT, name);
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    return p;
  }

  /* 先拿同源上下文写会话，再带 ?mode=ws 重进（强制走 ws 分支，才有云端） */
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + STATIC_PORT + '/' });
  await sleep(1400);
  await evaluate(`localStorage.setItem('lxw_session_v1', ${JSON.stringify(JSON.stringify({
    token: 'fake-token-for-probe', playerId: 'p1', nickname: '玩家A', name: 'test_acc', joinedAt: NOW
  }))});
  localStorage.setItem('lxw_guide_seen_v1','1');
  localStorage.removeItem('lxw_records_v1');
  'ok'`);
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + STATIC_PORT + '/?mode=ws' });
  await sleep(1200);
  /* 先确认「这张页面确实由本进程服务」，否则后面全是假失败 */
  const docNonce = await evaluate('window.__probeNonce || ""');
  if (docNonce !== NONCE) {
    console.error('当前文档不是本进程创建的（window.__probeNonce 对不上：' + docNonce + '）。'
      + 'CDP 连到了残留浏览器的旧页面。先 taskkill //F //IM msedge.exe 再跑。');
    try { edge.kill(); } catch (e) {}
    server.close();
    process.exit(1);
  }

  const seenNonce = await evaluate(`fetch('/__probe-nonce').then(function(r){return r.json();}).then(function(j){return j.nonce;}).catch(function(){return '';})`);
  if (seenNonce !== NONCE) {
    console.error('连到的不是本进程的服务（nonce 对不上：' + seenNonce + '）。'
      + '多半是残留实例占着端口，先 taskkill //F //IM msedge.exe 再跑。');
    try { edge.kill(); } catch (e) {}
    server.close();
    process.exit(1);
  }

  const homeReady = await waitFor(`(function(){
    var h = document.getElementById('screen-home');
    return !!(h && !h.classList.contains('hidden') && document.getElementById('btn-records-home'));
  })()`);
  ok(homeReady === true, '首页就绪（显式等待，不靠固定 sleep）');
  /* 引导弹窗会挡住点击：确认它没弹 */
  await evaluate(`(function(){ var g = document.getElementById('guide-modal'); if (g) g.classList.add('hidden'); return 'ok'; })()`);

  console.log('视口 ' + W + '×' + H + '  截图目录 ' + OUT);

  console.log('\n[1] 打开「我的战绩」—— 数据必须来自云端');
  const openTries = await openRecordsScreen();
  ok(openTries >= 0, '战绩页打开成功', '重试次数 ' + openTries);
  /* 只当信息打印、不当断言：首屏 init 里 showScreen 早于 bindEvents 绑定事件，
   * 抢在这个窗口内的点击是没有 handler 的空点击。这是探针的时序问题，
   * 不是产品缺陷；把它写成断言会让这个探针天生带一条偶发失败。 */
  console.log('    打开战绩页用了 ' + (openTries + 1) + ' 次点击');
  const listReady = await waitFor(`document.querySelectorAll('#records-list .rp-row').length > 0`);
  ok(listReady === true, '战绩列表渲染完成（显式等待）');
  const info = await evaluate(`(function(){
    var g = function(id){ var e = document.getElementById(id); return e ? e.textContent : null; };
    var rows = document.querySelectorAll('#records-list .rp-row');
    var src = document.getElementById('records-source');
    var trend = document.querySelectorAll('#rp-trend-bar .rp-t');
    var first = rows[0];
    return {
      source: src ? src.textContent : null,
      net: g('rp-net'), games: g('rp-games'), winrate: g('rp-winrate'),
      wins: g('rp-wins'), losses: g('rp-losses'), flats: g('rp-flats'),
      bestNet: g('rp-best-net'), bestWin: g('rp-best-win'), bestLose: g('rp-best-lose'),
      count: g('rp-list-count'),
      rows: rows.length,
      firstNet: first ? (first.querySelector('.rp-net') || {}).textContent : null,
      firstPeople: first ? (first.querySelector('.rp-people') || {}).textContent : null,
      firstReason: first ? (first.querySelector('.rp-sub') || {}).textContent : null,
      trendSlots: trend.length,
      emptyHidden: document.getElementById('records-empty').classList.contains('hidden'),
      dataHidden: document.getElementById('records-data').classList.contains('hidden'),
      scrollHidden: document.getElementById('records-scroll').classList.contains('hidden'),
      footShown: !document.getElementById('records-foot').classList.contains('hidden'),
      /* 含人机：说明行是否出现、说了什么，以及列表里被标记成 ai 的行 */
      aiNoteHidden: (function(){ var e = document.getElementById('rp-ai-note'); return e ? e.classList.contains('hidden') : null; })(),
      aiNoteText: g('rp-ai-note-text'),
      aiNoteH: (function(){ var e = document.getElementById('rp-ai-note'); return e ? Math.round(e.getBoundingClientRect().height) : 0; })(),
      /* 这行字变长之后要确认它没被挤爆：横向或纵向溢出都会让「不计入」三个字被裁掉 */
      aiNoteOverflow: (function(){
        var e = document.getElementById('rp-ai-note');
        return e ? (e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1) : null;
      })(),
      aiRows: document.querySelectorAll('#records-list .rp-row.is-ai').length,
      aiBadges: document.querySelectorAll('#records-list .rp-row .rp-row-ai').length,
      /* 前 4 行的「时间 / 人数 / 净胜 / 是否含人机」——用来核对两份流水是否真的按时间合并 */
      head: Array.prototype.slice.call(rows, 0, 4).map(function(r){
        return {
          t: (r.querySelector('.rp-time') || {}).textContent,
          p: (r.querySelector('.rp-people') || {}).textContent,
          n: (r.querySelector('.rp-net') || {}).textContent,
          ai: r.classList.contains('is-ai')
        };
      })
    };
  })()`);
  console.log('    ' + JSON.stringify(info));
  const shotMain = await shot('records-cloud.png');
  console.log('    图：' + shotMain);

  ok(/已保存到账号/.test(info.source || ''), '★ 页脚标明数据已保存到账号', info.source);
  eq(info.net, '+143', '累计净胜 = 服务器档案的 +143');
  eq(info.games, '25', '场次 25');
  eq(info.winrate, '72%', '胜率 72%');
  eq(info.wins, '18', '胜 18');
  eq(info.losses, '6', '负 6');
  eq(info.flats, '1', '平 1');
  eq(info.bestNet, '+39', '单场最高 +39');
  eq(info.bestWin, '7', '最长连胜 7');
  eq(info.bestLose, '3', '★ 最长连败 3（这字段是新加的，以前服务端没有）');
  eq(info.rows, 23, '★ 列表 23 行 = 20 条人类流水（服务端上限）+ 3 条人机流水');
  eq(info.count, '共 25 场 · 列表近 20 场', '★ 场次多于流水时把口径写明，不是含糊的「共 25 场」');
  eq(info.firstNet, '+39', '最新一局 +39');
  eq(info.firstPeople, '3 人', '★ 人数来自服务端流水（以前只有本机记录才有）');
  eq(info.firstReason, '分数见底结束', '★ 结束原因是人话，不是 scoreZero');
  eq(info.trendSlots, 10, '趋势条 10 格');
  eq(info.emptyHidden, true, '有数据时不显示空态');
  eq(info.footShown, true, '页脚可见');

  /* 横向溢出：手机竖屏上，内容一旦比视口宽，整屏就能被横向拖动，
   * 表现是「左边一条空白、右边被切掉」——截图上看着像布局错位，实际是溢出。
   * 静态断言抓不到这类问题，只能量 scrollWidth / 元素左边缘。 */
  /* 横向溢出：手机竖屏上，内容一旦比视口宽，整屏就能被横向拖动，
   * 表现是「左边一条空白、右边被切掉」——截图上看着像布局错位，实际是溢出。
   * 静态断言抓不到这类问题，只能量 scrollWidth / 元素左边缘。
   *
   * **必须等转场结束再量**：切屏有 translateX 入场动画，动画中途量到的
   * screenLeft=63px 是动画本身（120.6 设计像素 × 0.52 缩放），不是布局偏移。
   * 第一版没等，量出 63 就当成了 bug —— 记下来，别再踩。 */
  const geomExpr = `(function(){
    var d = document.documentElement, s = document.getElementById('screen-records');
    var r = s ? s.getBoundingClientRect() : null;
    return {
      win: window.innerWidth,
      docScrollW: d.scrollWidth, docClientW: d.clientWidth,
      screenLeft: r ? Math.round(r.left) : null,
      screenRight: r ? Math.round(r.right) : null,
      scrollX: window.scrollX,
      busy: !!(s && getComputedStyle(s).transform !== 'none'),
      /* 屏盒子贴 0 不等于「内容在屏里」：内容列可能是被子块自己推出去的，
       * 所以要把子块的真实矩形也打出来 —— 只看 #screen-records 会漏掉整块右移。 */
      kids: s ? Array.prototype.map.call(s.children, function(k){
        var rr = k.getBoundingClientRect();
        return (k.id || k.className) + '@' + Math.round(rr.left) + '..' + Math.round(rr.right)
          + ' y=' + Math.round(rr.top) + '..' + Math.round(rr.bottom)
          + ' scroll=' + k.scrollHeight + '/' + k.clientHeight
          + ' pos=' + getComputedStyle(k).position;
      }) : null,
      /* 横屏两栏的可行性取决于各块的「设计像素高度」：
       * 屏幕是 1624×750 画布，1 设计 px = scale CSS px，所以 CSS 高度 / scale 才是要排的预算。 */
      blocks: (function(){
        var st = document.getElementById('stage');
        /* 这段在模板字符串里求值：正则里的反斜杠会被模板字面量吃掉（\( 变成 (），
         * 上一版就是这么写坏的 —— 整个 IIFE 抛 SyntaxError，三条几何断言全红。
         * 所以不写正则，直接切逗号取第一个数。 */
        var tf = getComputedStyle(st).transform || 'none';
        var sc = 1;
        if (tf.indexOf('matrix') === 0) {
          var nums = tf.slice(tf.indexOf('(') + 1, tf.lastIndexOf(')')).split(',');
          sc = Number(nums[0]) || 1;
        }
        var sel = ['#rp-sum', '.rp-grid', '#rp-bests', '.rp-trend', '.rp-list-head', '#records-list'];
        return sel.map(function(q){
          var e = document.querySelector(q);
          if (!e) return q + '=none';
          var r = e.getBoundingClientRect();
          return q + '=' + Math.round(r.height / sc) + 'd/' + Math.round(r.height) + 'px';
        }).join(' ');
      })(),
      /* 左栏「纪录」卡是否被裁：真机上横屏只露出标题行、数值整排不见，
       * 原因是左栏内容（546 设计像素）超过可视高（418）。这里直接量卡底 vs 栏底。 */
      bestsInCol: (function(){
        var col = document.querySelector('.rp-sumcol');
        var b = document.getElementById('rp-bests');
        if (!col || !b) return null;
        var cr = col.getBoundingClientRect(), br = b.getBoundingClientRect();
        return { over: Math.round(br.bottom - cr.bottom), bestsBottom: Math.round(br.bottom), colBottom: Math.round(cr.bottom) };
      })(),
      inkLeft: (function(){
        var e = s ? s.querySelector('.rp-sum, .rp-row, .rp-empty') : null;
        if (!e) return null;
        var rr = e.getBoundingClientRect();
        return Math.round(rr.left) + '..' + Math.round(rr.right);
      })()
    };
  })()`;
  await waitFor(`(function(){
    var s = document.getElementById('screen-records');
    return !!s && getComputedStyle(s).transform === 'none';
  })()`, 3000);
  const geom = await evaluate(geomExpr);
  console.log('    ' + JSON.stringify(geom));
  eq(geom.docScrollW <= geom.win, true, '★ 页面宽度不超过视口（无横向溢出）');
  eq(geom.screenLeft, 0, '★ 战绩屏左边缘贴住视口（整体没被推偏）');
  eq(geom.scrollX, 0, '★ 没有横向滚动位移');
  /* 只在横屏断言：竖屏是整页单列滚，纪录卡本来就在第一屏之外。 */
  if (W > H) {
    ok(geom.bestsInCol && geom.bestsInCol.over <= 2,
      '★ 横屏左栏「纪录」卡没被裁（数值可见）', JSON.stringify(geom.bestsInCol));
  }

  console.log('\n[2] 含人机的场次：看得见，但不算数');
  /* 口径（用户原话）：「不计入战绩和排行榜……但在我的战绩页面上表示出含人机对战」。
   * 所以这里两件事都要成立：数字里没有它们，列表里必须有它们，并且标出来。 */
  eq(info.aiNoteHidden, false, '★ 说明行显示了（有 5 场人机局）');
  /* 假档案的 aiGames = 5，而 aiRecent 只有 3 条 —— 就是要走「说明比行数多」这条分支。
   * 用户 2026-10-28 的第 3 条反馈（「要」）要的就是这个：「列表近 N 场」必须出现，
   * 否则玩家数不满列表只会以为数据丢了。 */
  eq(info.aiNoteText || '', '5 场 · 列表近 3 场 · 不计入战绩与排行榜',
    '★ 说明行：场数 + 列表近 N 场 + 不计入');
  ok(/不计入战绩与排行榜/.test(info.aiNoteText || ''), '★ 说明行写清影响：不计入战绩与排行榜');
  ok(info.aiNoteH > 0, '★ 说明行真的占了高度（不是被 hidden 之类的 0 高元素骗过去）', 'h=' + info.aiNoteH);
  eq(info.aiNoteOverflow, false, '★ 变长之后说明行没有被裁（横竖都没溢出）');
  eq(info.aiRows, 3, '★ 3 行被标记成含人机');
  eq(info.aiBadges, 3, '★ 每行都有一枚「含人机」徽标（不是只靠颜色）');
  eq(info.games, '25', '★ 场次仍然是 25：人机局没有混进 games（这是整个需求的核心）');
  eq(info.net, '+143', '★ 累计净胜也没被 21 / -8 / 12 污染');
  /* 顺序：两份流水必须按时间合并。人机那场 elapsed 30 分钟，应排在最新人类局之后 */
  eq(info.head[0].ai, false, '第 1 行是人类局');
  eq(info.head[1].ai, true, '★ 第 2 行是 30 分钟前那场人机局（按时间插进同一列，不是接在队尾）');
  eq(info.head[1].n, '+21', '★ 人机局的净胜照样显示 +21（结果要给玩家看）');
  eq(info.head[1].p, '3 人', '人数也照常显示');

  /* 截图取证：先把列表滚到说明行，否则竖屏第一屏看不到它。 */
  await evaluate(`(function(){
    var box = document.getElementById('records-scroll');
    var note = document.getElementById('rp-ai-note');
    if (box && note) box.scrollTop = Math.max(0, note.offsetTop - 120);
    return 'ok';
  })()`);
  const shotAi = await shot('records-ai.png');
  console.log('    图：' + shotAi);
  await evaluate(`(function(){ var b = document.getElementById('records-scroll'); if (b) b.scrollTop = 0; return 'ok'; })()`);

  console.log('\n[3] 清除弹窗：默认连云端一起清');
  await evaluate(`document.getElementById('btn-records-clear').click()`);
  await sleep(500);
  const modal = await evaluate(`(function(){
    var m = document.getElementById('records-clear-modal');
    var b = document.getElementById('records-clear-cloud');
    var w = document.getElementById('records-clear-cloud-wrap');
    var c = document.getElementById('records-clear-count');
    var txt = w ? w.querySelector('.rp-opt-text') : null;
    var wr = w ? w.getBoundingClientRect() : null;
    var tr = txt ? txt.getBoundingClientRect() : null;
    return {
      open: !m.classList.contains('hidden'),
      checked: b ? b.checked : null,
      disabled: b ? b.disabled : null,
      dimmed: w ? w.classList.contains('is-off') : null,
      count: c ? c.textContent : null,
      /* 文字右缘必须留在选项框内（曾经 24px 时贴着右边框） */
      textRight: tr ? Math.round(tr.right) : 0,
      boxRight: wr ? Math.round(wr.right) : 0,
      /* 阈值用 4 屏幕px 而不是 8：这段页面在 750 设计空间里，
       * 容器右内边距 18 设计px 落到 320 宽屏只剩 7.7 屏幕px，
       * 卡 8 会把「本来就正确」的排版判成失败（v51 踩过一次）。 */
      textInside: !!(tr && wr && tr.right <= wr.right - 4)
    };
  })()`);
  console.log('    ' + JSON.stringify(modal));
  const shotModal = await shot('records-clear.png');
  console.log('    图：' + shotModal);

  ok(modal.open === true, '弹窗打开');
  eq(modal.checked, true, '★ 云端勾选默认打开（用户说「删」就是想删干净）');
  eq(modal.disabled, false, '已登录时勾选框可用');
  eq(modal.dimmed, false, '没有置灰');
  eq(modal.count, '当前 25 场记录将被删除', '提示的是云端场次');
  eq(modal.textInside, true, '★ 勾选说明没有溢出边框（文字右缘在框内）',
    'textRight ' + modal.textRight + ' vs boxRight ' + modal.boxRight);

  console.log('\n[4] 确定 → 真的打 reset-stats');
  await evaluate(`document.getElementById('btn-records-clear-ok').click()`);
  await waitFor(`!document.getElementById('records-empty').classList.contains('hidden')`);
  /* 再等 Node 侧的计数真的涨上来（见 waitForFlag 的注释：空态出现不代表请求已到） */
  const hit = await waitForFlag(() => resetCalls, 6000);
  if (!hit) console.log('    !! 6 秒内服务端没收到 reset-stats，resetCalls=' + resetCalls);
  const after = await evaluate(`(function(){
    var g = function(id){ var e = document.getElementById(id); return e ? e.textContent : null; };
    return {
      resetCalls: null,
      emptyShown: !document.getElementById('records-empty').classList.contains('hidden'),
      title: g('records-empty-title'),
      footHidden: document.getElementById('records-foot').classList.contains('hidden'),
      modalClosed: document.getElementById('records-clear-modal').classList.contains('hidden')
    };
  })()`);
  console.log('    ' + JSON.stringify(after));
  const shotAfter = await shot('records-cleared.png');
  console.log('    图：' + shotAfter);

  eq(resetCalls, 1, '★ 服务端收到了一次 /api/me/reset-stats');
  eq(after.emptyShown, true, '★ 清完立刻切空态');
  eq(after.title, '还没有战绩，去开一局吧', '空态文案正常');
  eq(after.footHidden, true, '空态隐藏页脚（不再挂着一个清除按钮）');
  eq(after.modalClosed, true, '弹窗关掉了');

  console.log('\n[5] 退出登录后不能还显示上一个账号的云端数据');
  /* 这条守的是缓存归属：cloudRecordsOk 一旦为 true 就不会自动变 false，
   * 不校验「这份缓存属于谁」的话，登出后战绩页会继续显示旧账号的数据 ——
   * 那是同一个「串台」bug 换了个地方发生。 */
  /* 必须走 AuthStore.logout()：readSession() 有一层内存缓存，
   * 直接删 localStorage 不会让 AuthStore.playerId() 立刻变空。 */
  await evaluate(`(typeof AuthStore !== 'undefined' && AuthStore.logout) ? (AuthStore.logout(), 'ok') : 'no-auth-store'`);
  resetCalls = 0;
  await evaluate(`document.getElementById('btn-records-back').click()`);
  await sleep(500);
  const reopen = await openRecordsScreen();
  ok(reopen >= 0, '登出后还能打开战绩页');
  await waitFor(`document.getElementById('records-empty') && !document.getElementById('records-empty').classList.contains('hidden')`);
  const afterOut = await evaluate(`(function(){
    var src = document.getElementById('records-source');
    return {
      source: src ? src.textContent : null,
      emptyShown: !document.getElementById('records-empty').classList.contains('hidden'),
      title: (document.getElementById('records-empty-title') || {}).textContent
    };
  })()`);
  console.log('    ' + JSON.stringify(afterOut));
  ok(/只在这台设备上/.test(afterOut.source || ''), '★ 登出后页脚明确标注只在这台设备上', afterOut.source);
  eq(afterOut.emptyShown, true, '★ 登出后不会残留上个账号的战绩（本机也已清空 → 空态）');
  eq(resetCalls, 0, '登出状态不会去调 reset-stats');

  await cdp.send('Page.close').catch(() => {});
  cdp.close();
  try { edge.kill(); } catch (e) {}
  server.close();

  console.log('\n' + '='.repeat(48));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
