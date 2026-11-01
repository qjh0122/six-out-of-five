/**
 * 横屏「未专门适配的屏」探针（一次性诊断，不进测试套件）
 *
 * 为什么需要：`.ls` 只写了 #screen-game / #screen-room / #screen-settle 三屏，
 * 首页 / 战绩 / 排行榜 靠 `.ls .screen > *:not(.home-inner) { max-width: 820px }` 兜。
 * 1624 设计宽的画布里，820 意味着左右各 400 设计像素（≈208 CSS px）空着 ——
 * 这到底「可接受」还是「一半屏幕是空的」，得看图，不能靠读 CSS 猜。
 *
 * 用法：node scripts/probe-landscape-screens.js
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', 'pwa');
const PORT = 3067;
const CDP = 9367;
const SHOT_DIR = path.join(os.tmpdir(), 'lxw-lscreens');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.webmanifest': 'application/manifest+json', '.json': 'application/json'
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const p = url === '/' ? '/index.html' : url;
  const abs = path.join(ROOT, p);
  if (!abs.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(abs, (e, buf) => {
    if (e) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
    res.end(buf);
  });
});

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

/* 铺满检测：舞台渲染矩形 vs 视口。
 * 判定标准是「四边都不超过 2px 的缝」，因为铺满的定义就是背景连到屏幕边缘。 */
async function coverage(cdp, w, h, label) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/?mode=local' });
  await sleep(1500);
  const g = await evaluate(cdp, MEASURE);
  const fill = (x) => x.gapL <= 2 && x.gapR <= 2 && x.gapT <= 2 && x.gapB <= 2;
  console.log('cover ' + label.padEnd(16) + ' ' + JSON.stringify(g));
  ok(fill(g), '★ 铺满：' + label + '（四边无缝）', JSON.stringify(g));

  /* 真机上「横屏底部一条深色带」的成因：舞台尺寸是 JS 按当时视口算死的像素值，
   * 之后容器变高却没收到 resize，死值停在旧高度，底下露出 #viewport 的底色。
   *
   * 现在的铺满由 CSS 的 calc(100% / --ls-scale) 保证，不依赖比例算对。
   * 这里故意把比例改成错的（模拟过期值），四边仍必须贴边 —— 这是那条真机 bug 的回归守卫。 */
  if (g.ls) {
    await evaluate(cdp, `document.getElementById('stage').style.setProperty('--ls-scale','0.45')`);
    await sleep(150);
    const g2 = await evaluate(cdp, MEASURE);
    ok(fill(g2), '★ 比例过期也铺满：' + label, JSON.stringify(g2));
    await evaluate(cdp, `window.dispatchEvent(new Event('resize'))`);
    await sleep(200);
  }
  return g;
}

/* 铺满测量表达式（coverage 用两次：正常比例 / 故意改错比例） */
const MEASURE = `(function(){
    var st = document.getElementById('stage');
    var r = st.getBoundingClientRect();
    var tf = getComputedStyle(st).transform || 'none';
    var sc = 1;
    if (tf.indexOf('matrix') === 0) {
      var n = tf.slice(tf.indexOf('(') + 1, tf.lastIndexOf(')')).split(',');
      sc = Number(n[0]) || 1;
    }
    return {
      vw: innerWidth, vh: innerHeight,
      stageCssW: Math.round(r.width), stageCssH: Math.round(r.height),
      designW: Math.round(st.offsetWidth), designH: Math.round(st.offsetHeight),
      scale: Math.round(sc * 1000) / 1000,
      gapL: Math.round(r.left), gapR: Math.round(innerWidth - r.right),
      gapT: Math.round(r.top), gapB: Math.round(innerHeight - r.bottom),
      ls: st.classList.contains('ls')
    };
  })()`;

async function shot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
  const p = path.join(SHOT_DIR, name + '.png');
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  return p;
}

async function evaluate(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result.value;
}

/* 量「当前可见屏」的内容盒 vs 画布盒：contentW / stageW 就是这条屏撑满了几何 */
const GEOM = `(function(){
  var st = document.getElementById('stage');
  var scr = Array.prototype.filter.call(document.querySelectorAll('.screen'), function(s){
    return !s.classList.contains('hidden');
  })[0];
  if (!st || !scr) return null;
  var sr = scr.getBoundingClientRect(), tr = st.getBoundingClientRect();
  var first = scr.querySelector('.home-inner') || scr.querySelector('.auth-inner') || scr.children[0];
  var fr = first ? first.getBoundingClientRect() : null;
  return {
    screen: scr.id,
    stageW: Math.round(tr.width), stageH: Math.round(tr.height),
    screenW: Math.round(sr.width), screenH: Math.round(sr.height),
    contentW: fr ? Math.round(fr.width) : null,
    contentLeft: fr ? Math.round(fr.left - sr.left) : null,
    contentRightGap: fr ? Math.round(sr.right - fr.right) : null,
    fillRatio: fr && sr.width ? Math.round(fr.width / sr.width * 1000) / 10 : null,
    overflowX: Math.round(scr.scrollWidth - scr.clientWidth),
    overflowY: Math.round(scr.scrollHeight - scr.clientHeight),
    ls: st.classList.contains('ls')
  };
})()`;

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}
function eq(got, want, name, detail) {
  ok(got === want, name, detail || ('expect ' + want + ', got ' + got));
}

/* 横屏最小可读字号。
 *
 * 横屏 1112×511 的缩放是 0.681：16 设计 px 的文字渲染出来只有 10.9 CSS px，
 * 而 iOS 上「能读但不费劲」的下限大约 11px。这个探针把每个可见屏里
 * **最小的** 20 个字号的元素列出来，低于 11 CSS px 就报出来 ——
 * 「看着有点小」这种判断不该靠眼睛，也不该每屏各调一次。
 */
const MIN_FONT = `(function(){
  var scr = Array.prototype.filter.call(document.querySelectorAll('.screen'), function(s){
    return !s.classList.contains('hidden');
  })[0];
  if (!scr) return null;
  var st0 = document.getElementById('stage');
  var tf0 = getComputedStyle(st0).transform || 'none';
  var SCALE_OF_PAGE = tf0.indexOf('matrix') === 0
    ? (Number(tf0.slice(tf0.indexOf('(') + 1, tf0.lastIndexOf(')')).split(',')[0]) || 1) : 1;
  var worst = [];
  Array.prototype.forEach.call(scr.querySelectorAll('*'), function(e){
    if (!e.offsetParent && getComputedStyle(e).position !== 'fixed') return;
    var hasText = Array.prototype.some.call(e.childNodes, function(n){
      return n.nodeType === 3 && (n.textContent || '').trim().length > 0;
    });
    if (!hasText) return;
    var cs = getComputedStyle(e);
    if (cs.visibility === 'hidden' || cs.opacity === '0') return;
    var r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    var design = parseFloat(cs.fontSize);
    worst.push({
      sel: (e.id ? '#' + e.id : e.className ? '.' + String(e.className).split(' ')[0] : e.tagName),
      /* computed font-size 是**设计像素**（transform 不影响计算值），
       * 屏上真实大小 = 设计值 × 缩放。判断「读不读得动」只能用后者。 */
      design: Math.round(design * 10) / 10,
      px: Math.round(design * SCALE_OF_PAGE * 10) / 10
    });
  });
  worst.sort(function(a, b){ return a.px - b.px; });
  return { screen: scr.id, min: worst.length ? worst[0] : null, sample: worst.slice(0, 5) };
})()`;

async function main() {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const edge = spawn(exe, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + CDP,
    '--user-data-dir=' + path.join(os.tmpdir(), 'lxw-ls2-' + Date.now()),
    '--window-size=844,390', '--force-device-scale-factor=1', 'about:blank'
  ], { stdio: 'ignore' });

  let page = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const list = await getJson('http://127.0.0.1:' + CDP + '/json/list');
      page = (list || []).find((t) => t.type === 'page');
      if (page) break;
    } catch (e) {}
  }
  if (!page) { console.error('连不上 Edge'); edge.kill(); process.exit(1); }

  const cdp = await cdpConnect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  /* 铺满矩阵：手机横屏几种比例 / 4:3 平板 / 电脑窗口 / 竖屏对照 */
  for (const [w, h, label] of [
    [844, 390, '手机 844×390'],
    [932, 430, '手机 932×430'],
    [1112, 511, '手机 1112×511'],
    [667, 375, '小屏 667×375'],
    [1024, 768, '平板 1024×768'],
    [1440, 900, '电脑 1440×900'],
    [390, 844, '竖屏 390×844']
  ]) {
    await coverage(cdp, w, h, label);
  }

  for (const [w, h, tag] of [[844, 390, 'ls'], [390, 844, 'pt']]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/?mode=local' });
    await sleep(2000);

    console.log('===== ' + tag + ' ' + w + '×' + h + ' =====');

    /* 新手引导：首次进入自动弹。它决定新玩家能不能开局，
     * 而 .guide-body 写死 min-height:616 —— 横屏舞台只有 750 高，装不下。 */
    const guide = await evaluate(cdp, `(function(){
      var m = document.getElementById('guide-modal');
      if (!m || m.classList.contains('hidden')) return { open: false };
      var card = m.querySelector('.modal-card');
      var body = m.querySelector('.guide-body');
      var nav = m.querySelector('.guide-nav');
      var next = nav ? nav.querySelector('.btn:not([hidden])') : null;
      var cr = card.getBoundingClientRect(), vr = { h: innerHeight, w: innerWidth };
      var nr = next ? next.getBoundingClientRect() : null;
      return {
        open: true,
        cardTop: Math.round(cr.top), cardBottom: Math.round(cr.bottom),
        cardH: Math.round(cr.height), viewH: vr.h,
        /* 正数 = 卡片下沿已经出屏，说明底部被切 */
        clippedBottom: Math.round(cr.bottom - vr.h),
        bodyMinH: getComputedStyle(body).minHeight,
        bodyScrollH: body.scrollHeight, bodyClientH: body.clientHeight,
        bodyCanScroll: body.scrollHeight > body.clientHeight + 1,
        nextBtn: next ? { text: next.textContent.trim(), top: Math.round(nr.top), bottom: Math.round(nr.bottom), inView: nr.bottom <= vr.h && nr.top >= 0, h: Math.round(nr.height) } : null,
        skipInView: (function(){ var s = m.querySelector('.guide-skip'); var r = s.getBoundingClientRect(); return r.bottom <= vr.h; })()
      };
    })()`);
    console.log('guide ' + JSON.stringify(guide));
    console.log('  截图 ' + (await shot(cdp, tag + '-guide')));

    /* 关掉引导（点「跳过」）再看首页本身的版式 */
    await evaluate(cdp, `(function(){ var s = document.querySelector('#guide-modal .guide-skip'); if (s) s.click(); })()`);
    await sleep(500);

    console.log('home  ' + JSON.stringify(await evaluate(cdp, GEOM)));
    const mf = await evaluate(cdp, MIN_FONT);
    console.log('  最小字号 ' + JSON.stringify(mf));
    /* 横屏的判定线是 11 CSS px（iOS 上「能读但不费劲」的下限）。
     * 竖屏缩放是 0.52，同样的设计字号会更小一档，这条先只对横屏立规矩 —— 
     * 竖屏要不要抬，得单独过一轮，别顺手改出另一种不一致。 */
    if (tag.indexOf('ls') === 0 && mf && mf.min) {
      ok(mf.min.px >= 11, '★ 横屏可读性：首页最小文字 ≥ 11 CSS px', JSON.stringify(mf.sample));
    }
    console.log('  截图 ' + (await shot(cdp, tag + '-home')));

    /* 房间页：座位网格在横屏能不能一次放下。
     * 真机截图上（1 人 + 5 个空位）第 3 行被裁掉一半，底部提示条压在裁口上 ——
     * 座位网格是 2 列 × 3 行，横屏可用高只有 546 设计像素，一行 182 装不下座位卡。
     *
     * v82 起准备态画在牌桌上，这个网格只在**回退路径**里出现（CONFIG.TABLE_READY=false）。
     * 这里显式带上 tableready=0 量回退路径，理由有两条：
     *   ① 回退路径是真会用的东西（灰度期翻开关），不能因为「新路径好看」就没人管；
     *   ② 新路径的横屏版式由 probe-table-ready.js 单独量（两栏不重叠 / 不出屏）。
     * 不带这个参数的话，#room-players 在一个隐藏的屏里，量出来全是 0 ——
     * 断言会「通过」，但什么都没证明。 */
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/?mode=local&tableready=0' });
    await sleep(1600);
    await evaluate(cdp, `localStorage.setItem('lxw_guide_seen_v1','1')`);
    await evaluate(cdp, `(function(){
      var b = document.getElementById('btn-create');
      if (b) b.click();
    })()`);
    await sleep(1600);
    const roomGeom = await evaluate(cdp, `(function(){
      var grid = document.getElementById('room-players');
      var hint = document.getElementById('room-hint');
      if (!grid) return { open: false };
      var gr = grid.getBoundingClientRect();
      /* 座位 = 网格的直接子元素（坐着的 + 空位），只有坐着的才带 .player-row */
      var seats = grid.children;
      var occupied = grid.querySelectorAll('.player-row').length;
      var last = seats.length ? seats[seats.length - 1].getBoundingClientRect() : null;
      var hr = hint && !hint.classList.contains('hidden') ? hint.getBoundingClientRect() : null;
      return {
        seats: seats.length,
        occupied: occupied,
        cols: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
        gridH: Math.round(gr.height), gridBottom: Math.round(gr.bottom),
        /* 正数 = 最后一行座位被容器裁掉多少（CSS px） */
        lastSeatCut: last ? Math.round(last.bottom - gr.bottom) : null,
        seatH: last ? Math.round(last.height) : null,
        canScroll: grid.scrollHeight > grid.clientHeight + 1,
        hintTop: hr ? Math.round(hr.top) : null,
        /* 正数 = 提示条压住了座位区 */
        hintOverGrid: hr && last ? Math.round(gr.bottom - hr.top) : null
      };
    })()`);
    console.log('room  ' + JSON.stringify(roomGeom));
    /* 满员判定：座位格子数 = 这个房间自己的上限（v82 起新建房间是 5，
     * 老 8 人房仍是 8 —— 读 room.cap 而不是写死 8）。这一段天然就是「满载」场景。 */
    if (roomGeom.open !== false) {
      eq(roomGeom.seats, 5, '★ 房间渲染满 5 个座位（满载场景）');
      eq(roomGeom.canScroll, false, '★ 5 个座位一屏放得下（不用滚）', JSON.stringify(roomGeom));
      ok(roomGeom.lastSeatCut <= 0, '★ 最后一个座位没被容器裁掉', JSON.stringify(roomGeom));
      ok(roomGeom.hintOverGrid <= 0, '★ 底部提示条不压座位区', JSON.stringify(roomGeom));
    }
    console.log('  截图 ' + (await shot(cdp, tag + '-room')));
    /* 退出房间，回到首页继续后面的步骤 */
    await evaluate(cdp, `(function(){ var b = document.getElementById('btn-leave'); if (b) b.click(); })()`);
    await sleep(900);

    /* 其它弹窗：规则 / 说明这类长内容弹窗在横屏（舞台仅 750 高）能不能完整显示。
     * 判据不是「卡片高度」，而是「卡片里所有按钮是否都在视口内且不是被裁的」——
     * .modal-card 是 overflow:hidden，撑破时按钮会消失而不是滚动。 */
    const MODAL = `(function(){
      var m = Array.prototype.filter.call(document.querySelectorAll('.modal'), function(x){
        return !x.classList.contains('hidden');
      })[0];
      if (!m) return { open: false };
      var card = m.querySelector('.modal-card');
      if (!card) return { open: true, card: null, id: m.id };
      var cr = card.getBoundingClientRect();
      var btns = Array.prototype.map.call(card.querySelectorAll('.btn, .guide-skip'), function(b){
        var r = b.getBoundingClientRect();
        return b.textContent.trim().slice(0, 6) + ':' + (r.bottom <= innerHeight && r.top >= 0 ? 'in' : 'OUT');
      });
      var body = card.querySelector('.guide-body, .rules-body, .modal-scroll');
      return {
        open: true, id: m.id,
        cardH: Math.round(cr.height), viewH: innerHeight,
        cardTop: Math.round(cr.top), cardBottom: Math.round(cr.bottom),
        cutByView: Math.round(cr.bottom - innerHeight),
        /* 卡内溢出：内容比卡片高 = 底部被 overflow:hidden 吃掉 */
        cardOverflow: card.scrollHeight - card.clientHeight,
        bodyCanScroll: body ? body.scrollHeight > body.clientHeight + 1 : null,
        btns: btns
      };
    })()`;
    for (const [btnId, name] of [['btn-rules', '首个可见弹窗']]) {
      const clicked = await evaluate(cdp, `(function(){ var b = document.getElementById('${btnId}'); if (!b) return false; b.click(); return true; })()`);
      await sleep(700);
      console.log('modal ' + name + ' ' + JSON.stringify(await evaluate(cdp, MODAL)));
      if (clicked) console.log('  截图 ' + (await shot(cdp, tag + '-rules')));
      await evaluate(cdp, `(function(){
        var m = Array.prototype.filter.call(document.querySelectorAll('.modal'), function(x){ return !x.classList.contains('hidden'); })[0];
        if (!m) return;
        var b = m.querySelector('.modal-close, .modal-x, [data-close]');
        if (b) b.click(); else m.classList.add('hidden');
      })()`);
      await sleep(400);
    }

    /* 战绩页：横屏下内容整块偏右？先隔 1.5s 再量一次，排除切屏动画中途取值 */
    const REC = `(function(){
      var s = document.getElementById('screen-records');
      if (!s || s.classList.contains('hidden')) return { open: false };
      var inner = s.querySelector('.rp-sum') || s.children[0];
      var ir = inner ? inner.getBoundingClientRect() : null;
      var sr = s.getBoundingClientRect();
      return {
        open: true,
        screenL: Math.round(sr.left), screenR: Math.round(sr.right),
        innerTag: inner ? (inner.className || inner.id) : null,
        innerL: ir ? Math.round(ir.left) : null, innerR: ir ? Math.round(ir.right) : null,
        innerW: ir ? Math.round(ir.width) : null,
        innerTransform: inner ? getComputedStyle(inner).transform : null,
        screenTransform: getComputedStyle(s).transform,
        scrollW: s.scrollWidth, clientW: s.clientWidth,
        overflowX: Math.round(s.scrollWidth - s.clientWidth),
        overflowY: Math.round(s.scrollHeight - s.clientHeight),
        kids: Array.prototype.map.call(s.children, function(k){
          var r = k.getBoundingClientRect();
          return (k.id || k.className) + '@' + Math.round(r.left) + '..' + Math.round(r.right) + ' w=' + Math.round(r.width) + ' pos=' + getComputedStyle(k).position;
        })
      };
    })()`;
    await evaluate(cdp, `(function(){ var b = document.getElementById('btn-rank-home') || document.getElementById('btn-records-home'); if (b) b.click(); })()`);
    await sleep(300);
    await evaluate(cdp, `(function(){ var b = document.getElementById('btn-records-home'); if (b) b.click(); })()`);
    await sleep(120);
    console.log('rec@120ms ' + JSON.stringify(await evaluate(cdp, REC)));
    await sleep(1500);
    console.log('rec@1.6s  ' + JSON.stringify(await evaluate(cdp, REC)));
    console.log('  截图 ' + (await shot(cdp, tag + '-records')));
    /* 回到首页，避免影响后面的榜单步骤 */
    await evaluate(cdp, `(function(){ var b = document.querySelector('#screen-records .rp-back, #btn-records-back'); if (b) b.click(); })()`);
    await sleep(500);

    /* 进不去房间也能看榜单：榜单入口在首页，本地模式下也能开 */
    const opened = await evaluate(cdp, `(function(){
      var b = document.getElementById('btn-rank-home');
      if (b) { b.click(); return 'clicked'; }
      return 'no-entry:' + Array.prototype.map.call(document.querySelectorAll('.entry-link'), function(e){
        return e.getAttribute('data-entry') || e.id;
      }).join(',');
    })()`);
    console.log('  榜单入口 ' + opened);
    await sleep(900);
    const rankGeom = await evaluate(cdp, GEOM);
    if (rankGeom && rankGeom.screen === 'screen-rank') {
      console.log('rank  ' + JSON.stringify(rankGeom));
      /* 榜单满载的检查放在 journey 里做：这条链路会先点「离开房间」，
       * 那个确认弹窗会盖住榜单页，量出来的结果是被遮挡后的版本 —— 这里的数不作数。 */
      console.log('  截图 ' + (await shot(cdp, tag + '-rank')));
    } else {
      console.log('rank  没打开（' + JSON.stringify(rankGeom) + '）');
    }
  }

  /* 未登录入口（screen-auth）只有不带 mode=local 才会出现 */
  for (const [w, h, tag] of [[844, 390, 'ls-auth'], [390, 844, 'pt-auth']]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' });
    await sleep(1800);
    /* 引导会盖住登录页，先关掉 */
    await evaluate(cdp, `(function(){ var s = document.querySelector('#guide-modal .guide-skip'); if (s) s.click(); })()`);
    await sleep(500);
    console.log('===== ' + tag + ' ' + w + '×' + h + ' =====');
    console.log('auth  ' + JSON.stringify(await evaluate(cdp, GEOM)));
    console.log('  截图 ' + (await shot(cdp, tag)));
  }

  cdp.close();
  try { edge.kill(); } catch (e) {}
  server.close();
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
