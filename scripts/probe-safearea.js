/**
 * 底部安全区探针（一次性诊断 + 回归守卫）
 *
 * 真机反馈：「手机底部贴边」。横屏战绩页的「清除记录」下沿离屏幕底只有 ~20 CSS px，
 * 正好压在 home indicator 那一条 21px 的带子上。
 *
 * 原因不在布局，而在一条覆盖规则：
 *   .screen { padding-bottom: calc(var(--sa-bottom) + 120px) }   ← 默认留安全区
 *   .ls #screen-records { padding-bottom: 40px }                 ← 横屏改版时整体替换，
 *                                                                  把 --sa-bottom 一起丢了
 * 竖屏没被这条命中，所以「看起来只有横屏贴边」——但这不该靠读 CSS 判断，
 * 所以这个探针把每个屏**最靠下的可见元素**量出来，和模拟出来的安全区比。
 *
 * headless 里 env(safe-area-inset-*) 全是 0，量不出问题。做法是把
 * resize() 本来会写进 #stage 的 --sa-* 手动改成 iPhone 真机的值（设计像素）：
 *   横屏 844×390：底部 21 CSS px、左右各 47 CSS px（刘海在侧边）
 *   竖屏 390×844：顶部 47、底部 34
 * 断言只看「可见内容下沿 ≥ 安全区下沿 + 6 CSS px」，与具体机型无关。
 *
 * 用法：node scripts/probe-safearea.js
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', 'pwa');
const PORT = 3071;
const CDP = 9371;
const SHOT_DIR = path.join(os.tmpdir(), 'lxw-safearea');
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

async function evaluate(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.text) + ' :: ' + expr.slice(0, 120));
  return r.result && r.result.value;
}

/* 局部放大截图：改完之后「纪录条数字像被切了」这种判断只能靠放大看，
 * 靠 1080 宽整图猜会把 1px 的边框当成裁切。 */
async function shotRegion(cdp, name, rect, scale) {
  const r = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: scale || 3 }
  });
  if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
  const p = path.join(SHOT_DIR, name + '.png');
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  return p;
}

async function shot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
  const p = path.join(SHOT_DIR, name + '.png');
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  return p;
}

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

/* --------------------------------------------------------------------------
 * 量「最靠下的可见内容」= 距屏幕底部的余量（CSS px）。
 *
 * 必须按裁剪祖先求交：战绩列表在 overflow:auto 里，滚出容器的行 rect 会落到
 * 屏幕外面，直接取 max(bottom) 会得到 2000+ 的假值。
 * ------------------------------------------------------------------------ */
const BOTTOM = `(function(){
  var st = document.getElementById('stage');
  var tf = getComputedStyle(st).transform || 'none';
  var sc = 1;
  if (tf.indexOf('matrix') === 0) {
    sc = Number(tf.slice(tf.indexOf('(') + 1, tf.lastIndexOf(')')).split(',')[0]) || 1;
  }
  var scr = Array.prototype.filter.call(document.querySelectorAll('.screen'), function(s){
    return !s.classList.contains('hidden');
  })[0];
  if (!scr) return null;

  function clipOf(e){
    var r = e.getBoundingClientRect();
    var box = { l: r.left, t: r.top, r: r.right, b: r.bottom };
    var a = e.parentElement;
    while (a && a !== document.body) {
      var cs = getComputedStyle(a);
      var oy = cs.overflowY, ox = cs.overflowX;
      if (oy !== 'visible' || ox !== 'visible') {
        var ar = a.getBoundingClientRect();
        if (ox !== 'visible') { box.l = Math.max(box.l, ar.left); box.r = Math.min(box.r, ar.right); }
        if (oy !== 'visible') { box.t = Math.max(box.t, ar.top); box.b = Math.min(box.b, ar.bottom); }
      }
      a = a.parentElement;
    }
    return box;
  }

  var maxB = -1e9, who = '', whoCls = '';
  Array.prototype.forEach.call(scr.querySelectorAll('*'), function(e){
    if (e === scr) return;
    var cs = getComputedStyle(e);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return;
    /* 只量「内容」：叶子（无元素子节点）与按钮。
     * 整块容器（页脚、卡片、滚动区）的盒子本来就会铺到屏幕边 —— 那是背景，
     * 不是内容；拿它算下沿永远等于 0，量出来的「贴边」全是假的。 */
    if (e.firstElementChild && !/^(BUTTON|A|INPUT|TEXTAREA)$/.test(e.tagName)) return;
    var raw = e.getBoundingClientRect();
    if (raw.width < 2 || raw.height < 2) return;
    var b = clipOf(e).b;
    if (b <= 0 || b > innerHeight + 4) return;
    if (b > maxB) {
      maxB = b;
      who = e.id ? '#' + e.id : (e.className ? '.' + String(e.className).split(' ')[0] : e.tagName);
      whoCls = String(e.className || '');
    }
  });
  var raw = { screen: scr.id, scale: Math.round(sc * 1000) / 1000, vh: innerHeight,
    bottomEl: who, bottomElClass: whoCls, bottomCss: Math.round(maxB),
    gapCss: Math.round(innerHeight - maxB) };
  /* 各屏各自的纵向预算，用来解释「为什么这里会贴边」 */
  var trend = document.querySelector('.rp-trend');
  var sumcol = document.querySelector('.rp-sumcol');
  var list = document.getElementById('records-list');
  raw.trend = trend ? Math.round(trend.getBoundingClientRect().height) : null;
  raw.trendHidden = trend ? getComputedStyle(trend).display === 'none' : null;
  raw.sumcol = sumcol ? { client: sumcol.clientHeight, scroll: sumcol.scrollHeight } : null;
  /* 真实内容高（设计 px）与余量：scrollHeight 在内容比视口矮时等于视口，
   * 看不出「还差多少就满」，而横屏左栏的正是不许滚，余量必须为正。 */
  raw.sumFit = (function(){
    if (!sumcol || !sumcol.lastElementChild) return null;
    var top = sumcol.getBoundingClientRect().top;
    var last = sumcol.lastElementChild.getBoundingClientRect().bottom;
    var contentCss = last - top;
    return {
      content: Math.round(contentCss / sc),
      view: sumcol.clientHeight,
      slack: Math.round(sumcol.clientHeight - contentCss / sc)
    };
  })();
  /* 左栏每块的高度：横屏要「一屏装下不滚」，只报总和看不出是谁超了 */
  raw.sumKids = sumcol ? Array.prototype.map.call(sumcol.children, function(c){
    var r = c.getBoundingClientRect();
    return (c.id ? '#' + c.id : '.' + String(c.className).split(' ')[0]) + ':' + Math.round(r.height);
  }) : null;
  raw.list = list ? { client: list.clientHeight, scroll: list.scrollHeight } : null;
  /* 纪录条是否在内部被裁：.rp-bests 是 overflow:hidden，横屏把 padding 压到 8/6 之后
   * 「单场最高 +28分」的数字在真机截图里被切掉下半截 —— 量一下子节点有没有越界。 */
  /* 横屏左栏宽度与趋势条是否越界（设计 px） */
  raw.trendBar = (function(){
    var bar = document.getElementById('rp-trend-bar');
    var col = document.querySelector('.rp-sumcol');
    if (!bar || !col) return null;
    var br = bar.getBoundingClientRect(), cr = col.getBoundingClientRect();
    var kids = Array.prototype.slice.call(bar.children).map(function(k){ return k.getBoundingClientRect(); });
    var first = kids[0], last = kids[kids.length - 1];
    var d = function (css) { return Math.round(css / sc); };
    return {
      colW: d(cr.width), barW: d(br.width), n: kids.length,
      sqW: first ? d(first.width) : 0,
      overLeft: first ? d(cr.left - first.left) : null,
      overRight: last ? d(last.right - cr.right) : null
    };
  })();
  raw.bests = (function(){
    var box = document.getElementById('rp-bests');
    if (!box) return null;
    var br = box.getBoundingClientRect();
    var worst = 0, who = '';
    Array.prototype.forEach.call(box.querySelectorAll('*'), function(e){
      var r = e.getBoundingClientRect();
      if (r.height < 1) return;
      var over = r.bottom - br.bottom;
      if (over > worst) { worst = over; who = '.' + String(e.className).split(' ')[0]; }
    });
    var one = box.querySelector('.rp-best');
    var v = box.querySelector('.rp-best-v');
    return { h: Math.round(br.height), overCss: Math.round(worst * 10) / 10, who: who,
             scroll: box.scrollHeight, client: box.clientHeight,
             pad: one ? getComputedStyle(one).padding : null,
             bestH: one ? Math.round(one.getBoundingClientRect().height) : null,
             gapBelowValue: v ? Math.round((br.bottom - v.getBoundingClientRect().bottom) * 10) / 10 : null };
  })();
  raw.foot = (function(){
    var f = document.querySelector('.screen:not(.hidden) .rp-foot');
    if (!f) return null;
    var r = f.getBoundingClientRect();
    var cs = getComputedStyle(f);
    return { h: Math.round(r.height), top: Math.round(r.top), padB: cs.paddingBottom };
  })();
  return raw;
})()`;

/* 真机安全区（设计像素）：resize() 会把 CSS px ÷ scale 写进 --sa-* */
const SAFE = {
  ls: { t: 0, b: 40, l: 90, r: 90 },     // 21 CSS 底部 / 47 CSS 两侧 @ scale .52
  pt: { t: 90, b: 65, l: 0, r: 0 }       // 47 / 34 CSS @ scale .52
};

function applySafe(sa) {
  return `(function(){
    var st = document.getElementById('stage');
    st.style.setProperty('--sa-top', '${sa.t}px');
    st.style.setProperty('--sa-bottom', '${sa.b}px');
    st.style.setProperty('--sa-left', '${sa.l}px');
    st.style.setProperty('--sa-right', '${sa.r}px');
    return true;
  })()`;
}

/* 19 局的战绩种子：和真机截图同样的量级（有趋势条、列表要滚） */
function seedRecordsScript() {
  const now = Date.now();
  const list = [];
  for (let i = 0; i < 19; i++) {
    const net = [4, -24, 3, -6, 28, -5, 6, -2][i % 8];
    list.push({
      id: 'R' + i + '-' + i, roomId: 'R' + i, endedAt: now - i * 3600 * 1000,
      playerCount: 3, myStartScore: 20, myEndScore: 20 + net, myNet: net,
      endReason: i % 2 ? 'dissolve' : 'scoreZero', rounds: 2
    });
  }
  return `localStorage.setItem('lxw_records_v1', ${JSON.stringify(JSON.stringify(list))});
          localStorage.setItem('lxw_guide_seen_v1','1');
          localStorage.setItem('lxw_records_deduped_v2','1'); 'ok'`;
}

/* 横屏可读性的最后一道网：每个可见屏里**最小的那段真文字**是多少 CSS 像素。
 *
 * 25 章立过「横屏字号下限 12 CSS px」这条线，但它只写进了几张显式的
 * `max(Npx, var(--ls-fs-floor))` 规则里 —— 没被点名的选择器不会自动受它保护。
 * 26 章为了给「最近 10 局」腾高度，压了标题栏与各处留白，字号也跟着被动了一轮；
 * 这种改动从数值上看不出「有没有压过头」，只能从渲染结果反推。
 *
 * 只统计直接含文字节点的叶子（父容器的 font-size 不代表它自己的观感），
 * 并按 #stage 的实际 transform 换算成 CSS px —— computed font-size 是设计像素，
 * 不换算的话 844×390 上会把 20 设计 px 当成 20 CSS px，永远看不出问题。 */
const MINFONT = `(function(){
  var LIST = window.__lxwFontList = [];
  var scr = Array.prototype.filter.call(document.querySelectorAll('.screen'), function(s){
    return !s.classList.contains('hidden');
  })[0];
  if (!scr) return null;
  var tf = getComputedStyle(document.getElementById('stage')).transform || 'none';
  var sc = tf.indexOf('matrix') === 0
    ? (Number(tf.slice(tf.indexOf('(') + 1, tf.lastIndexOf(')')).split(',')[0]) || 1) : 1;
  /* 图标不算「文字」：趋势色块里的 ▼ 是符号，皇冠与头像首字是图形，
   * 它们的含义由颜色/形状承载，字号裁到 7 CSS px 也不影响阅读。
   * 真正要守的是「读一句话」的那些元素。
   * v82 起准备态画在牌桌上，房间屏里出现的是对局页那套 .opp-avatar（头像首字），
   * 和 .avatar 同性质 —— 漏了它，「房间」这一屏的最小字会被头像首字顶成 9.2px，
   * 看起来像新的可读性问题，实际是同一个图形被换了 class。 */
  var ICONS = '.rp-t,.owner-crown,.avatar,.opp-avatar,.gt-me,.rp-empty-art,.rp-trend-axis';
  var worst = null;
  Array.prototype.forEach.call(scr.querySelectorAll('*'), function(e){
    if (e.closest && e.closest(ICONS)) return;
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
    var css = Math.round(design * sc * 10) / 10;
    var tag = (e.id ? '#' + e.id : e.className ? '.' + String(e.className).split(' ')[0] : e.tagName);
    if (LIST && css < 12) LIST.push({ px: css, design: design, sel: tag,
                                      text: (e.textContent || '').trim().slice(0, 10) });
    if (!worst || css < worst.px) {
      worst = { px: css, design: design, sel: tag,
                text: (e.textContent || '').trim().slice(0, 12) };
    }
  });
  if (LIST) {
    /* 去重（同类元素只留一条），按字号升序：一次把所有偏小的字列全，
     * 而不是「修好最小值 → 下一个变成最小值 → 再修」，那样要跑十几轮。 */
    var seen = {}, out = [];
    LIST.sort(function(a, b){ return a.px - b.px; }).forEach(function(it){
      var k = it.sel + '|' + it.px;
      if (seen[k]) return;
      seen[k] = 1; out.push(it);
    });
    worst.list = out.slice(0, 24);
  }
  return worst;
})()`;

async function measureScreen(cdp, label, tag, sa) {
  await evaluate(cdp, applySafe(sa));
  await sleep(120);
  const g = await evaluate(cdp, BOTTOM);
  const safeCss = Math.round(sa.b * g.scale);
  const need = safeCss + 6;
  console.log('  ' + label.padEnd(18) + ' 下沿 ' + String(g.gapCss).padStart(4) + ' CSS px  安全区 ' +
    String(safeCss).padStart(2) + '  最底元素 ' + g.bottomEl +
    (g.trend !== null ? '  趋势 ' + (g.trendHidden ? '隐藏' : g.trend + 'px') : '') +
    (g.sumcol ? '  左栏 ' + g.sumcol.client + '/' + g.sumcol.scroll : '') +
    (g.foot ? '  foot ' + g.foot.h + 'px padB=' + g.foot.padB : ''));
  ok(g.gapCss >= need, '★ ' + label + '：底部内容让开安全区（≥ ' + need + ' CSS px）',
    '实际 ' + g.gapCss + '，最底元素 ' + g.bottomEl);

  /* 横屏才量：竖屏的缩放是 1，字号就是设计值，25 章那条下限至今没延伸到竖屏。 */
  if (tag === 'ls') {
    const mf = await evaluate(cdp, MINFONT);
    if (mf) {
      console.log('    最小字号 ' + mf.px + ' CSS px（' + mf.design + ' 设计 px）' + mf.sel + ' 「' + mf.text + '」');
      if (process.env.ALLFONT && mf.list) {
        mf.list.forEach(function (it) {
          console.log('      · ' + String(it.px).padStart(4) + ' CSS px / ' + it.design + ' 设计 px  ' + it.sel + ' 「' + it.text + '」');
        });
      }
      ok(mf.px >= 11, '★ ' + label + '：横屏最小文字 ≥ 11 CSS px', mf.px + ' @ ' + mf.sel);
    }
  }
  return g;
}

async function main() {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const edge = spawn(exe, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + CDP,
    '--user-data-dir=' + path.join(os.tmpdir(), 'lxw-sa-' + Date.now()),
    '--window-size=844,390', '--force-device-scale-factor=1', 'about:blank'
  ], { stdio: 'ignore' });

  let page = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const l = await getJson('http://127.0.0.1:' + CDP + '/json/list');
      page = (l || []).find((t) => t.type === 'page');
      if (page) break;
    } catch (e) {}
  }
  if (!page) { console.error('连不上 Edge'); edge.kill(); process.exit(1); }
  const cdp = await cdpConnect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  /* 只跑指定视口：node scripts/probe-safearea.js 844x390 390x844 */
  const only = process.argv.slice(2).filter((a) => /^\d+x\d+$/.test(a));
  for (const [w, h, tag] of [[844, 390, 'ls'], [932, 430, 'ls'], [667, 375, 'ls'], [390, 844, 'pt']]) {
    if (only.length && only.indexOf(w + 'x' + h) < 0) continue;
    const sa = SAFE[tag];
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/?mode=local' });
    await sleep(1600);
    await evaluate(cdp, seedRecordsScript());
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/?mode=local' });
    await sleep(1600);

    console.log('\n===== ' + w + '×' + h + ' (' + tag + ') =====');

    /* 首页 */
    await measureScreen(cdp, '首页', tag, sa);

    /* 战绩 */
    await evaluate(cdp, `document.getElementById('btn-records-home').click()`);
    await sleep(900);
    const rec = await measureScreen(cdp, '战绩', tag, sa);
    console.log('    纪录条 ' + JSON.stringify(rec.bests) + '  趋势条 ' + JSON.stringify(rec.trendBar));
    console.log('    左栏预算 ' + JSON.stringify(rec.sumcol) + '  余量 ' + JSON.stringify(rec.sumFit) + '  ' + JSON.stringify(rec.sumKids));
    /* 只有横屏的左栏是「自己的滚动容器、却要求不许滚」；
     * 竖屏是整页一起滚（.rp-scroll），左栏不需要余量。 */
    if (tag === 'ls') {
      ok(rec.sumFit && rec.sumFit.slack >= 8, '★ 战绩左栏一屏装下（余量 ≥ 8 设计 px，不许滚）', JSON.stringify(rec.sumFit));
    }
    console.log('    截图 ' + (await shot(cdp, tag + '-' + w + '-records')));
    if (process.env.ZOOM) {
      const lb = await evaluate(cdp, `(function(){
        var c = document.querySelector('.rp-sumcol').getBoundingClientRect();
        return { x: Math.round(c.left), y: Math.round(c.top), width: Math.round(c.width), height: Math.round(c.height) };
      })()`);
      console.log('    放大 ' + (await shotRegion(cdp, tag + '-' + w + '-sumcol', lb, 3)));
    }

    /* 排行榜 */
    await evaluate(cdp, `document.getElementById('btn-rank-home').click()`);
    await sleep(1200);
    await measureScreen(cdp, '排行榜', tag, sa);
    console.log('    截图 ' + (await shot(cdp, tag + '-' + w + '-rank')));

    /* 房间（1 人 + 3 个 AI，座位表下半部分贴到底要看的是它） */
    await evaluate(cdp, `document.getElementById('btn-rank-back').click()`);
    await sleep(600);
    await evaluate(cdp, `document.getElementById('btn-create').click()`);
    /* ★ v103 起「创建房间」先弹「本局打几把」，点了确认才真的开房。
     * 缺这一步 → 房间没建 → 后面所有断言都拿不到牌桌（脚本过期，不是功能坏）。 */
    await sleep(500);
    await evaluate(cdp, `(function(){var b=document.getElementById('btn-create-confirm');if(b)b.click();})()`);
    await sleep(500);
    await sleep(1200);
    await evaluate(cdp, `(function(){ var b=document.getElementById('btn-add-bot'); if(b) b.click(); })()`);
    await sleep(300);
    await evaluate(cdp, `(function(){ var b=document.getElementById('btn-add-bot'); if(b) b.click(); })()`);
    await sleep(300);
    await evaluate(cdp, `(function(){ var b=document.getElementById('btn-add-bot'); if(b) b.click(); })()`);
    await sleep(900);
    const room = await measureScreen(cdp, '房间', tag, sa);
    console.log('    座位 ' + JSON.stringify(await evaluate(cdp, `(function(){
      var g = document.getElementById('room-players');
      var r = g.getBoundingClientRect();
      return { cols: getComputedStyle(g).gridTemplateColumns.split(' ').length,
               seats: g.children.length,
               client: g.clientHeight, scroll: g.scrollHeight,
               top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight };
    })()`)));
    console.log('    截图 ' + (await shot(cdp, tag + '-' + w + '-room')));
    void room;
  }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('截图目录 ' + SHOT_DIR);
  cdp.close();
  edge.kill();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
