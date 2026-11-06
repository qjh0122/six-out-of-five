/**
 * 表情 / 短语探针（真浏览器 / CDP）
 *
 * 静态断言能证明「元素存在」，但证明不了下面这些 —— 而它们才是会进线上的问题：
 *
 *   1) **图真的加载出来了**：13 个格子里 `<img>` 的 naturalWidth 必须 > 0。
 *      素材没发出去 / 路径大小写不对时，DOM 结构完全正常，只是空格子。
 *   2) **触摸目标够大**：格子在 390 宽的屏上是 139 设计像素 ≈ 72 CSS 像素；
 *      一旦布局改成 7 列挤进竖屏，手指就点不准了，而代码看起来没问题。
 *   3) **真能飞起来**：点完之后 #emoji-layer 里出现节点，且它的位置从
 *      「我的座位」移动到了「目标座位」附近。只断言「有节点」抓不到
 *      「起点终点算反了 / 用了缩放前坐标」这类错（后者在横屏必错）。
 *   4) **会自己消失**：1.9 秒后节点必须被移除。漏了 removeChild 的话，
 *      一局下来 layer 里会挂几百个节点，越打越卡。
 *   5) **2 秒节流真的挡住了第二条**，并且给了提示（服务端是静默丢弃，
 *      所以客户端这一层必须说话）。
 *   6) **定向发给谁**：选了某人之后，事件里的 to 必须是那个人的 id。
 *
 * 用法：node scripts/probe-emoji.js [宽] [高]
 *   竖屏：node scripts/probe-emoji.js 390 844
 *   横屏：node scripts/probe-emoji.js 844 390
 *   ZOOM=1 额外截图到系统临时目录
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const W = Number(process.argv[2]) || 390;
const H = Number(process.argv[3]) || 844;
const PORT = 3047;
const CDP_PORT = 9357;
const ROOT = path.join(__dirname, '..', 'pwa');
const SHOT_DIR = path.join(os.tmpdir(), 'lxw-emoji-probe');
const SHOTS = !!process.env.ZOOM;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.webmanifest': 'application/manifest+json', '.json': 'application/json'
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
        const w = waiting.get(msg.id); waiting.delete(msg.id);
        if (msg.error) w.reject(new Error(JSON.stringify(msg.error))); else w.resolve(msg.result);
      }
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => resolve({
      send(m, p) {
        return new Promise((res, rej) => { id += 1; waiting.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method: m, params: p || {} })); });
      },
      close() { try { ws.close(); } catch (e) {} }
    }));
  });
}

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

/* 页面里用：等某个条件为真（每 80ms 一次，最多 timeout） */
const WAIT_FN = `function __wait(fn, timeout, step){
  step = step || 80;
  return new Promise(function(res){
    var t0 = Date.now();
    (function loop(){
      var v = null;
      try { v = fn(); } catch (e) { v = null; }
      if (v) return res(v);
      if (Date.now() - t0 > (timeout || 4000)) return res(null);
      setTimeout(loop, step);
    })();
  });
}`;

async function main() {
  server.listen(PORT);
  const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ['--headless=new', '--remote-debugging-port=' + CDP_PORT, '--no-first-run', '--disable-gpu', 'about:blank'],
    { stdio: 'ignore' });
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

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __error: String(r.exceptionDetails.text) };
    return r.result && r.result.value;
  };
  const shot = async (name) => {
    if (!SHOTS) return '';
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const p = path.join(SHOT_DIR, name + '.png');
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    return p;
  };

  const URL_LOCAL = 'http://127.0.0.1:' + PORT + '/?mode=local';
  console.log('===== ' + W + '×' + H + ' 表情探针 =====');

  await cdp.send('Page.navigate', { url: URL_LOCAL });
  await sleep(1500);
  await evaluate('localStorage.setItem(\'lxw_guide_seen_v1\',\'1\')');
  await cdp.send('Page.navigate', { url: URL_LOCAL });
  await sleep(1700);
  await evaluate(WAIT_FN);
  await evaluate('document.getElementById("btn-create").click()');
  /* ★ v103 起「创建房间」不再直接建房：它先弹「本局打几把」，点了确认才真的开房。
   * 探针原来少了这一步，于是所有后续断言都卡在「进不了牌桌」——
   * 这是**脚本过期**，不是功能坏了（10 个红探针里有一批是同一个原因）。 */
  await sleep(500);
  await evaluate('(function(){var b=document.getElementById("btn-create-confirm");if(b)b.click();})()');

  /* 进牌桌：本地演示模式没有服务端，第二个玩家用 RoomStore 的公开接口加进去 ——
   * 和真实多标签页走的是同一条路（local store 的 joinRoom）。
   * 不用改游戏代码加测试钩子：探针越少碰内部实现，验的东西越接近线上。 */
  const table = await evaluate(`(function(){
    return __wait(function(){
      var rooms = JSON.parse(Store.read(Store.KEYS.ROOMS) || '{}');
      var id = Object.keys(rooms)[0];
      if (!id) return null;
      var room = rooms[id];
      if (room.players.length >= 2) return id;
      if (window.__joined) return null;
      window.__joined = 1;
      RoomStore.joinRoom(id, { id: 'probe-pal', nickname: '陪练' });
      return null;
    }, 6000);
  })()`);
  await evaluate(`(function(){
    var rooms = JSON.parse(Store.read(Store.KEYS.ROOMS) || '{}');
    var id = Object.keys(rooms)[0];
    if (id) { RoomStore.setReady(id, 'probe-pal', true); }
    return id;
  })()`);
  await sleep(300);
  await evaluate('(function(){ var b = document.getElementById("btn-ready"); if (b) b.click(); return "ok"; })()');
  const inGame = await evaluate('__wait(function(){ return document.getElementById("game-top") && document.querySelectorAll("#game-top .gt-opp").length > 0; }, 8000)');
  ok(!!inGame, '开局：顶栏出现对手座位（第二个人真的进桌了）', JSON.stringify(table));
  if (!inGame) {
    console.log('    !! 进不了牌桌，后面的断言没有意义，提前结束');
    /* ------------------- [8] 点座位 → 贴着他弹三档面板（v89 统一浮层）-------------------
   * 这一节是「统一浮层面板」的验收：早先是点座位开战绩卡、点表情钮开底部 sheet，
   * 两个入口互不相干。现在点谁就弹谁，且面板必须**贴着那个人**，不是屏幕居中。 */
  console.log('\n[8] 点座位 → 贴着弹三档面板');
  const seatSheet = await evaluate(`(function(){
    var seat = document.querySelector('#game-top .gt-opp');
    var me = document.querySelector('#game-top .gt-me');
    if (!seat || !me) return { error: '牌桌上没有座位' };
    seat.click();
    var panel = document.getElementById('seat-sheet');
    if (panel.classList.contains('hidden')) return { error: '点座位没打开面板' };
    var pr = panel.getBoundingClientRect();
    var sr = seat.getBoundingClientRect();
    var tabs = [].slice.call(panel.querySelectorAll('#ss-tabs [data-ss-tab]'))
      .map(function(b){ return b.textContent; });
    var open = {
      tabs: tabs,
      name: (document.getElementById('ss-name') || {}).textContent,
      /* 贴着 = 面板与座位的水平或垂直间距小，且不是「居中弹」 */
      gapX: Math.round(sr.left > pr.right ? sr.left - pr.right : pr.left - sr.right),
      gapY: Math.round(sr.top > pr.bottom ? sr.top - pr.bottom : pr.top - sr.bottom),
      side: panel.getAttribute('data-side'),
      fits: pr.top >= -1 && pr.left >= -1 && pr.right <= innerWidth + 1 && pr.bottom <= innerHeight + 1,
      targetOn: (function(){ var on = panel.querySelector('.emoji-who.is-on'); return on ? on.textContent.trim() : null; })()
    };
    /* 切到信息档 */
    var infoTab = panel.querySelector('[data-ss-tab="info"]');
    if (infoTab) infoTab.click();
    open.infoShown = !document.getElementById('ss-info').classList.contains('hidden');
    open.gridHiddenOnInfo = document.getElementById('emoji-grid').classList.contains('hidden');
    open.infoText = (document.getElementById('ss-info').textContent || '').slice(0, 40);
    document.getElementById('btn-ss-close').click();
    /* 点自己：只有信息档 */
    me.click();
    open.selfOpened = !panel.classList.contains('hidden');
    open.selfTabs = [].slice.call(panel.querySelectorAll('#ss-tabs [data-ss-tab]'))
      .map(function(b){ return b.textContent; });
    open.selfActive = (function(){ var t = panel.querySelector('[data-ss-tab].is-on'); return t ? t.textContent : null; })();
    document.getElementById('btn-ss-close').click();
    return open;
  })()`);
  ok(seatSheet && !seatSheet.error, '点对手座位能打开面板', seatSheet && seatSheet.error);
  if (seatSheet && !seatSheet.error) {
    ok(seatSheet.tabs.length === 3 && seatSheet.tabs.join('/') === '表情/短语/信息',
      '★ 三档 tab：表情 / 短语 / 信息', JSON.stringify(seatSheet.tabs));
    ok(seatSheet.name && seatSheet.name !== '发给全场', '标题写的是被点的那个人（' + seatSheet.name + '）');
    ok(!!seatSheet.targetOn && seatSheet.targetOn !== '全场',
      '★ 表情默认就发给这个人（不用先选「发给谁」）', seatSheet.targetOn);
    ok(seatSheet.gapX <= 60 || seatSheet.gapY <= 60,
      '★ 面板贴着座位（间距 ' + seatSheet.gapX + '×' + seatSheet.gapY + ' CSS px，落点 ' + seatSheet.side + '）');
    ok(seatSheet.fits, '面板整体在视口内');
    ok(seatSheet.infoShown && seatSheet.gridHiddenOnInfo, '信息档替换掉表情格子');
    ok(!!seatSheet.infoText, '信息档有内容（' + seatSheet.infoText.slice(0, 20) + '…）');
    ok(seatSheet.selfOpened && seatSheet.selfTabs.length === 1 && seatSheet.selfActive === '信息',
      '★ 点自己只有「信息」一档（自己给自己发表情没有意义）', JSON.stringify(seatSheet.selfTabs));
  }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    cdp.close(); try { edge.kill(); } catch (e) {} server.close();
    process.exitCode = 1;
    return;
  }

  /* 记录页面收到的每一条表情事件，用来验「定向发给谁」 */
  await evaluate('window.__emojiLog = []; RoomStore.onEmoji(function(e){ window.__emojiLog.push(e); }); "ok"');
  await sleep(200);
  if (SHOTS) console.log('    截图：' + (await shot('table')));

  console.log('\n[1] 入口按钮');
  const btn = await evaluate(`(function(){
    var b = document.getElementById('btn-emoji');
    if (!b) return { missing: true };
    var r = b.getBoundingClientRect();
    var mine = document.querySelector('#game-top .gt-me');
    var mr = mine ? mine.getBoundingClientRect() : null;
    /* v87：入口从「我的分左边那一格」搬到了桌面右下角（圆桌版），
     * 两套版式的相对位置不同，但「不压住我的分」和「整个在屏内」是共同不变量。
     * 只断言其中一个版的几何，翻开关那天就会红得莫名其妙。 */
    var ring = !!document.querySelector('#game-top.gt-ring');
    return {
      w: Math.round(r.width), h: Math.round(r.height),
      visible: r.width > 0 && r.height > 0,
      ring: ring,
      overlap: !!(mr && r.left < mr.right - 1 && r.right > mr.left + 1 && r.top < mr.bottom - 1 && r.bottom > mr.top + 1),
      inView: r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1
    };
  })()`);
  ok(btn && !btn.missing, '顶栏有表情按钮');
  ok(btn && btn.visible, '按钮可见（有尺寸）', JSON.stringify(btn));
  ok(btn && btn.w >= 44 && btn.h >= 44, '触摸目标 ≥ 44 CSS px（实测 ' + (btn && btn.w) + '×' + (btn && btn.h) + '）');
  ok(btn && !btn.overlap, '★ 按钮没有压住「我的分」（' + (btn && btn.ring ? '圆桌版：桌面右下角' : '旧顶栏：我的分左侧') + '）');
  ok(btn && btn.inView, '按钮完整落在视口内');

  console.log('\n[2] 面板');
  await evaluate('document.getElementById("btn-emoji").click()');
  await sleep(400);
  const panel = await evaluate(`(function(){
    /* v89：面板是「点谁弹谁」的浮层（#seat-sheet），不再是居中弹窗 */
    var m = document.getElementById('seat-sheet');
    var card = m;
    var grid = document.getElementById('emoji-grid');
    var cells = [].slice.call(grid.querySelectorAll('.emoji-cell'));
    var imgs = [].slice.call(grid.querySelectorAll('img'));
    var loaded = imgs.filter(function(i){ return i.naturalWidth > 0; }).length;
    var cr = card.getBoundingClientRect();
    var cellRects = cells.map(function(c){ var r = c.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
    var whos = [].slice.call(document.querySelectorAll('#emoji-to .emoji-who'));
    return {
      open: !m.classList.contains('hidden'),
      fits: cr.top >= -1 && cr.bottom <= innerHeight + 1 && cr.left >= -1 && cr.right <= innerWidth + 1,
      card: { t: Math.round(cr.top), b: Math.round(cr.bottom), h: Math.round(cr.height), w: Math.round(cr.width) },
      overflowInside: Math.round(card.scrollHeight - card.clientHeight),
      cells: cells.length, loaded: loaded,
      minCellW: Math.min.apply(null, cellRects.map(function(c){ return c.w; })),
      minCellH: Math.min.apply(null, cellRects.map(function(c){ return c.h; })),
      targets: whos.map(function(w){ return w.textContent.trim(); }),
      cols: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
      /* 面板不是全屏弹窗，不锁 stage 的 modal-open —— 它真正的「模态」表现
       * 是背后有一层可点击关闭的遮罩。这里断言遮罩在，而不是滚动锁。 */
      bgLocked: !document.getElementById('seat-sheet-bd').classList.contains('hidden')
    };
  })()`);
  ok(panel && panel.open, '点按钮 → 面板打开');
  ok(panel && panel.fits, '面板整体在视口内', JSON.stringify(panel && panel.card));
  ok(panel && panel.overflowInside <= 2, '面板内容没有被 overflow 裁掉', String(panel && panel.overflowInside));
  ok(panel && panel.cells === 13, '13 个表情格子', String(panel && panel.cells));
  ok(panel && panel.loaded === 13, '★ 13 张图全部加载成功（naturalWidth > 0）', (panel && panel.loaded) + '/13');
  ok(panel && panel.minCellW >= 36 && panel.minCellH >= 36,
    '格子触摸目标 ≥ 36 CSS px（实测 ' + (panel && panel.minCellW) + '×' + (panel && panel.minCellH) + '）');
  ok(panel && panel.cols === 4, '表情格子 4 列（浮层面板宽度固定 520，横竖屏都一样）',
    '实测 ' + (panel && panel.cols) + ' 列');
  ok(panel && panel.targets.length >= 2, '目标行有「全场」+ 同桌的人', JSON.stringify(panel && panel.targets));
  ok(panel && panel.bgLocked, '面板背后有可点关闭的遮罩');
  if (SHOTS) console.log('    截图：' + (await shot('panel')));

  console.log('\n[3] 发一条：真的会飞');
  const fly = await evaluate(`(function(){
    var cells = document.querySelectorAll('#emoji-grid .emoji-cell');
    var pal = document.querySelector('#game-top .gt-opp');
    var me = document.querySelector('#game-top .gt-me');
    var before = { pal: pal.getBoundingClientRect(), me: me.getBoundingClientRect() };
    cells[0].click();
    return new Promise(function(res){
      __wait(function(){ return document.querySelector('#emoji-layer .emoji-fly'); }, 1500).then(function(node){
        if (!node) return res({ spawned: false });
        var r0 = node.getBoundingClientRect();
        var closed = document.getElementById('seat-sheet').classList.contains('hidden');
        var start = { x: r0.left + r0.width / 2, y: r0.top + r0.height / 2 };
        setTimeout(function(){
          var r1 = node.getBoundingClientRect();
          var end = { x: r1.left + r1.width / 2, y: r1.top + r1.height / 2 };
          var palC = { x: before.pal.left + before.pal.width / 2, y: before.pal.top + before.pal.height / 2 };
          var meC = { x: before.me.left + before.me.width / 2, y: before.me.top + before.me.height / 2 };
          res({
            spawned: true, closed: closed,
            start: { x: Math.round(start.x), y: Math.round(start.y) },
            end: { x: Math.round(end.x), y: Math.round(end.y) },
            /* 全场：落点在我的座位附近；飞行起点也是我 */
            nearMe: Math.hypot(start.x - meC.x, start.y - meC.y) < 60,
            endNearMe: Math.hypot(end.x - meC.x, end.y - meC.y) < 60,
            palC: { x: Math.round(palC.x), y: Math.round(palC.y) },
            meC: { x: Math.round(meC.x), y: Math.round(meC.y) },
            moved: Math.hypot(end.x - start.x, end.y - start.y) > 4
          });
        }, 520);
      });
    });
  })()`);
  ok(fly && fly.spawned, '点表情 → 动画层里出现节点', JSON.stringify(fly));
  ok(fly && fly.closed, '发完自动关面板（不关就挡住了表情落点）');
  ok(fly && fly.nearMe, '起点在我的座位旁（' + JSON.stringify(fly && fly.start) + ' vs 我 ' + JSON.stringify(fly && fly.meC) + '）');
  ok(fly && fly.endNearMe, '发给全场 → 落点在我的座位旁', JSON.stringify(fly && fly));
  if (SHOTS) console.log('    截图：' + (await shot('fly')));

  const ev1 = await evaluate('window.__emojiLog');
  ok(ev1 && ev1.length === 1, '页面收到 1 条表情事件（自己发的也走回程路径）', JSON.stringify(ev1));
  ok(ev1 && ev1[0] && ev1[0].to === '*', '默认发给全场（to = *）', JSON.stringify(ev1 && ev1[0]));

  console.log('\n[4] 节流');
  const throttle = await evaluate(`(function(){
    var cards = JSON.parse(Store.read(Store.KEYS.ROOMS) || '{}');
    document.getElementById('btn-emoji').click();
    var cell = document.querySelectorAll('#emoji-grid .emoji-cell')[1];
    cell.click();
    var toast = document.getElementById('toast');
    return { toast: toast ? toast.textContent : '', hidden: toast ? toast.classList.contains('hidden') : true };
  })()`);
  await sleep(300);
  const throttled = await evaluate('window.__emojiLog.length');
  ok(throttled === 1, '2 秒内第二条没有发出去（事件数还是 1）', '实际 ' + throttled);
  ok(throttle && !throttle.hidden && /慢一点/.test(throttle.toast), '给了提示而不是静默失败', JSON.stringify(throttle));

  console.log('\n[5] 定向 + 短语');
  await sleep(2100);
  const directed = await evaluate(`(function(){
    document.getElementById('btn-emoji').click();
    var who = [].slice.call(document.querySelectorAll('#emoji-to .emoji-who')).filter(function(w){
      return w.getAttribute('data-to') !== '*';
    })[0];
    if (!who) return { noTarget: true };
    who.click();
    document.querySelectorAll('#emoji-grid .emoji-cell')[2].click();
    return { to: who.getAttribute('data-to') };
  })()`);
  await sleep(500);
  const ev2 = await evaluate('window.__emojiLog[1] || null');
  ok(directed && !directed.noTarget, '目标行里有具体的人可以选');
  ok(ev2 && ev2.to === (directed && directed.to), '选定某人后事件里的 to 就是他', JSON.stringify(ev2));
  const aimed = await evaluate(`(function(){
    var node = document.querySelector('#emoji-layer .emoji-fly');
    var pal = document.querySelector('#game-top .gt-opp');
    if (!node || !pal) return null;
    var r = node.getBoundingClientRect(), p = pal.getBoundingClientRect();
    return { d: Math.round(Math.hypot(r.left + r.width / 2 - (p.left + p.width / 2), r.top + r.height / 2 - (p.top + p.height / 2))) };
  })()`);
  ok(aimed && aimed.d < 70, '定向的表情落在对方座位旁（偏差 ' + (aimed && aimed.d) + ' px）', JSON.stringify(aimed));

  await sleep(2100);
  const phrase = await evaluate(`(function(){
    document.getElementById('btn-emoji').click();
    var tab = document.querySelector('[data-ss-tab="phr"]');
    tab.click();
    var rows = document.querySelectorAll('#emoji-phr .phrase-row');
    var shown = rows.length;
    var gridHidden = document.getElementById('emoji-grid').classList.contains('hidden');
    rows[0].click();
    return { shown: shown, gridHidden: gridHidden, text: rows[0].textContent };
  })()`);
  await sleep(300);
  const bubble = await evaluate(`(function(){
    var n = document.querySelector('#emoji-layer .emoji-fly.is-phrase');
    return n ? { text: n.textContent, w: Math.round(n.getBoundingClientRect().width) } : null;
  })()`);
  ok(phrase && phrase.shown === 8, '短语 tab 有 8 条', String(phrase && phrase.shown));
  ok(phrase && phrase.gridHidden, '切到短语后表情格子被藏起来');
  ok(bubble && bubble.text === (phrase && phrase.text), '发出去的短语渲染成气泡且文案一致', JSON.stringify(bubble));
  ok(bubble && bubble.w <= 470, '气泡宽度不超过设计上限（不会横穿屏幕）', JSON.stringify(bubble));

  console.log('\n[6] 自动清理');
  const cleaned = await evaluate('__wait(function(){ return document.querySelectorAll("#emoji-layer .emoji-fly").length === 0; }, 3000)');
  ok(!!cleaned, '★ 动画结束后节点被移除（不留垃圾）',
    '剩余 ' + JSON.stringify(await evaluate('document.querySelectorAll("#emoji-layer .emoji-fly").length')));

  console.log('\n[7] 关闭方式');
  const closing = await evaluate(`(function(){
    document.getElementById('btn-emoji').click();
    var opened = !document.getElementById('seat-sheet').classList.contains('hidden');
    var m = document.getElementById('seat-sheet');
    document.getElementById('seat-sheet-bd').click();   // 点遮罩
    var closedByMask = m.classList.contains('hidden');
    document.getElementById('btn-emoji').click();
    document.getElementById('btn-ss-close').click();
    var closedByX = m.classList.contains('hidden');
    return { opened: opened, closedByMask: closedByMask, closedByX: closedByX,
             unlocked: !document.getElementById('stage').classList.contains('modal-open') };
  })()`);
  ok(closing && closing.opened, '再点一次按钮能重新打开');
  ok(closing && closing.closedByMask, '点遮罩能关');
  ok(closing && closing.closedByX, '点右上角 × 能关');
  ok(closing && closing.unlocked, '关掉之后背景滚动恢复');

  /* ------------------- [8] 点座位 → 贴着他弹三档面板（v89 统一浮层）-------------------
   * 这一节是「统一浮层面板」的验收：早先是点座位开战绩卡、点表情钮开底部 sheet，
   * 两个入口互不相干。现在点谁就弹谁，且面板必须**贴着那个人**，不是屏幕居中。 */
  console.log('\n[8] 点座位 → 贴着弹三档面板');
  const seatSheet = await evaluate(`(function(){
    var seat = document.querySelector('#game-top .gt-opp');
    var me = document.querySelector('#game-top .gt-me');
    if (!seat || !me) return { error: '牌桌上没有座位' };
    seat.click();
    var panel = document.getElementById('seat-sheet');
    if (panel.classList.contains('hidden')) return { error: '点座位没打开面板' };
    var pr = panel.getBoundingClientRect();
    var sr = seat.getBoundingClientRect();
    var tabs = [].slice.call(panel.querySelectorAll('#ss-tabs [data-ss-tab]'))
      .map(function(b){ return b.textContent; });
    var open = {
      tabs: tabs,
      name: (document.getElementById('ss-name') || {}).textContent,
      /* 贴着 = 面板与座位的水平或垂直间距小，且不是「居中弹」 */
      gapX: Math.round(sr.left > pr.right ? sr.left - pr.right : pr.left - sr.right),
      gapY: Math.round(sr.top > pr.bottom ? sr.top - pr.bottom : pr.top - sr.bottom),
      side: panel.getAttribute('data-side'),
      fits: pr.top >= -1 && pr.left >= -1 && pr.right <= innerWidth + 1 && pr.bottom <= innerHeight + 1,
      targetOn: (function(){ var on = panel.querySelector('.emoji-who.is-on'); return on ? on.textContent.trim() : null; })()
    };
    /* 切到信息档 */
    var infoTab = panel.querySelector('[data-ss-tab="info"]');
    if (infoTab) infoTab.click();
    open.infoShown = !document.getElementById('ss-info').classList.contains('hidden');
    open.gridHiddenOnInfo = document.getElementById('emoji-grid').classList.contains('hidden');
    open.infoText = (document.getElementById('ss-info').textContent || '').slice(0, 40);
    document.getElementById('btn-ss-close').click();
    /* 点自己：只有信息档 */
    me.click();
    open.selfOpened = !panel.classList.contains('hidden');
    open.selfTabs = [].slice.call(panel.querySelectorAll('#ss-tabs [data-ss-tab]'))
      .map(function(b){ return b.textContent; });
    open.selfActive = (function(){ var t = panel.querySelector('[data-ss-tab].is-on'); return t ? t.textContent : null; })();
    document.getElementById('btn-ss-close').click();
    return open;
  })()`);
  ok(seatSheet && !seatSheet.error, '点对手座位能打开面板', seatSheet && seatSheet.error);
  if (seatSheet && !seatSheet.error) {
    ok(seatSheet.tabs.length === 3 && seatSheet.tabs.join('/') === '表情/短语/信息',
      '★ 三档 tab：表情 / 短语 / 信息', JSON.stringify(seatSheet.tabs));
    ok(seatSheet.name && seatSheet.name !== '发给全场', '标题写的是被点的那个人（' + seatSheet.name + '）');
    ok(!!seatSheet.targetOn && seatSheet.targetOn !== '全场',
      '★ 表情默认就发给这个人（不用先选「发给谁」）', seatSheet.targetOn);
    ok(seatSheet.gapX <= 60 || seatSheet.gapY <= 60,
      '★ 面板贴着座位（间距 ' + seatSheet.gapX + '×' + seatSheet.gapY + ' CSS px，落点 ' + seatSheet.side + '）');
    ok(seatSheet.fits, '面板整体在视口内');
    ok(seatSheet.infoShown && seatSheet.gridHiddenOnInfo, '信息档替换掉表情格子');
    ok(!!seatSheet.infoText, '信息档有内容（' + seatSheet.infoText.slice(0, 20) + '…）');
    ok(seatSheet.selfOpened && seatSheet.selfTabs.length === 1 && seatSheet.selfActive === '信息',
      '★ 点自己只有「信息」一档（自己给自己发表情没有意义）', JSON.stringify(seatSheet.selfTabs));
  }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  cdp.close();
  try { edge.kill(); } catch (e) { /* 已退出 */ }
  server.close();
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; try { server.close(); } catch (x) {} });
