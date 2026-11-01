/**
 * 牌型特写探针（v83 R5）—— 真浏览器 / CDP
 *
 * 为什么静态断言不够：牌型特写是**纯视觉**的一段东西，
 * 「代码里有 is-big 这个类」和「屏幕上真的有一圈光、粒子真的从组里炸开」
 * 之间隔着好几件事，每一件都能让它变成看不见：
 *
 *   1) `.fx-pt` 的动画名写错 → 元素在但一直 opacity:0（等于没做）；
 *   2) 粒子层放在 `overflow: hidden` 的容器里 → 炸开一半被裁掉；
 *   3) 延迟没算上「逐组错峰」→ 第 3 组的粒子在它滑进屏幕之前就放完了；
 *   4) 横屏半径不收窄 → 粒子串到相邻那一组，看起来像界面抖了一下。
 *
 * 触发条件（哪个牌型该放特写）由 pwa/test/big-fx.test.js 守 ——
 * 那是「名字 → 颜色」的映射，不是视觉。本探针只负责「画出来了吗、画得对吗」。
 *
 * 用法：node scripts/probe-big-fx.js [宽] [高]
 *   竖屏：node scripts/probe-big-fx.js 390 844
 *   横屏：node scripts/probe-big-fx.js 844 390
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
const PORT = 3051;
const CDP_PORT = 9361;
const ROOT = path.join(__dirname, '..', 'pwa');
const SHOT_DIR = path.join(os.tmpdir(), 'lxw-big-fx');
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

/* 在页面里按 showResultModal 的输出结构造一屏结算明细。
 * 只造「结构与类名」，不复制渲染逻辑 —— 这里要验的是 CSS 会不会画，
 * 而不是 JS 会不会加类（后者在单测里）。 */
const SEED_FN = `window.__seedFx = function () {
  var modal = document.getElementById('result-modal');
  var wrap = document.getElementById('result-groups');
  var title = document.getElementById('result-title');
  if (!modal || !wrap) return { error: 'missing #result-modal / #result-groups' };
  /* 首次进入会弹新手引导，它压在结算弹窗上面 —— 截图里只能看到引导。
   * 第一次进入时弹，退出引导后还会被首屏流程再预约一次，所以必须能重复调。 */
  window.__isolateResult = function () {
    Array.prototype.forEach.call(document.querySelectorAll('.modal'), function (m) {
      if (m.id !== 'result-modal') m.classList.add('hidden');
    });
    document.getElementById('result-modal').classList.remove('hidden');
  };
  window.__isolateResult();
  if (title) title.textContent = '第一轮结算';
  wrap.innerHTML = '';

  function makeGroup(isBig, bigName) {
    var d = document.createElement('div');
    d.className = 'result-group' + (isBig ? ' is-big' : '');
    if (isBig) {
      d.dataset.big = 'bz';
      /* 与 game.js 的 BIG_FX['豹子'] 保持一致；写死一份是为了让探针在没有
       * 房间的情况下也能验 CSS。两边对不上时，看截图就知道（颜色不对）。 */
      d.style.setProperty('--fx-color', '#E0572B');
      d.style.setProperty('--fx-ring', 'rgba(224,87,43,0.50)');
      var b = document.createElement('div');
      b.className = 'result-banner';
      b.textContent = bigName + '！';
      d.appendChild(b);
      var burst = document.createElement('div');
      burst.className = 'fx-burst';
      for (var i = 0; i < 12; i++) {
        var pt = document.createElement('i');
        pt.className = 'fx-pt';
        pt.style.setProperty('--a', (i * 30) + 'deg');
        pt.style.setProperty('--d', (0.18 + (i % 4) * 0.04).toFixed(2) + 's');
        burst.appendChild(pt);
      }
      d.appendChild(burst);
    }
    var head = document.createElement('div');
    head.className = 'result-head';
    head.innerHTML = '<span class="slot-badge">3</span>'
      + '<span class="result-head-label">' + (isBig ? '飘三叶' : '十点半') + '</span>'
      + '<span class="result-head-winner">赢家 <b>甲</b></span>';
    d.appendChild(head);
    var rows = document.createElement('div');
    rows.className = 'result-rows';
    ['甲', '乙', '丙'].forEach(function (n, k) {
      var row = document.createElement('div');
      row.className = 'result-row';
      row.innerHTML = '<span class="rn">' + (k === 0 ? '👑 ' : '') + n + '</span>'
        + '<span class="rt"><span class="rt-type">' + (isBig ? '豹子' : '10 点') + '</span></span>'
        + '<span class="rd ' + (k === 0 ? 'pos' : 'neg') + '">' + (k === 0 ? '+6' : '-3') + '</span>';
      rows.appendChild(row);
    });
    d.appendChild(rows);
    wrap.appendChild(d);
    return d;
  }

  makeGroup(true, '豹子');
  makeGroup(false, '');
  makeGroup(false, '');
  modal.classList.remove('hidden');
  return { groups: wrap.children.length };
};`;

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

  console.log('===== ' + W + '×' + H + ' 牌型特写探针 =====');
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/?mode=local' });
  await sleep(1400);

  /* 真机（iOS / Android）的滚动条是 overlay，不占布局宽度；
   * Windows headless 会画一条 13px 的实体滚动条，把容器内容宽度挤小 13px，
   * 于是「组比容器宽 13px」这条断言会在**完全正常的布局**上红掉。
   * 这里把滚动条宽度清零，让测量环境与真机一致 —— 不是放宽标准，
   * 是不想让桌面滚动条替真机说谎。 */
  await evaluate("(function(){var s=document.createElement('style');s.textContent='*::-webkit-scrollbar{width:0;height:0}';document.head.appendChild(s);})()");

  const seeded = await evaluate('(function(){' + SEED_FN + '; return window.__seedFx(); })()');
  ok(seeded && seeded.groups === 3, '结算明细里造出 3 组（1 组带特写）', JSON.stringify(seeded));

  /* ★ 必须等入场动画（groupIn 0.3s + 逐组错峰 0.7s）全部结束再量布局。
   * groupIn 的起始帧是 translateX(40px)：在 120ms 时量，组还在从右边往里滑，
   * 右边界比最终位置多出 20+ 设计 px —— 于是「组超出了容器」这条会在
   * **完全正常的布局**上红掉。这个坑我踩了一次，记在这里。 */
  /* 粒子只在 0.18~1.28s 之间可见。先截一帧「正在炸」的，
   * 否则整轮探针留下的截图里一颗粒子都看不到，等于没验证过视觉。 */
  await sleep(620);
  await evaluate('window.__isolateResult && window.__isolateResult()');
  await sleep(60);
  await shot('big-fx-burst-' + W + 'x' + H);
  await sleep(880);
  const r = await evaluate(`(function(){
    var modal = document.getElementById('result-modal');
    var wrap = document.getElementById('result-groups');
    var big = wrap.querySelector('.result-group.is-big');
    if (!big) return { error: 'no .is-big' };
    var banner = big.querySelector('.result-banner');
    var burst = big.querySelector('.fx-burst');
    var pts = burst ? Array.prototype.slice.call(burst.querySelectorAll('.fx-pt')) : [];
    var after = getComputedStyle(big, '::after');
    var rect = big.getBoundingClientRect();
    var wrect = wrap.getBoundingClientRect();
    var mrect = modal.getBoundingClientRect();
    /* 结算弹窗的容器是 .modal-card（不是 .modal-box） */
    var scroll = wrap.closest('.modal-card') || wrap;
    return {
      groups: wrap.children.length,
      bigCount: wrap.querySelectorAll('.result-group.is-big').length,
      bigKind: big.dataset.big || '',
      banner: banner ? { w: banner.getBoundingClientRect().width, h: banner.getBoundingClientRect().height, text: banner.textContent } : null,
      ptCount: pts.length,
      ptAnim: pts.length ? getComputedStyle(pts[0]).animationName : '',
      ptDuration: pts.length ? getComputedStyle(pts[0]).animationDuration : '',
      ptDelay: pts.length ? getComputedStyle(pts[0]).animationDelay : '',
      ptColor: pts.length ? getComputedStyle(pts[0]).backgroundColor : '',
      angles: pts.map(function(p){ return p.style.getPropertyValue('--a'); }),
      afterAnim: after.animationName,
      afterBg: after.boxShadow,
      rect: { l: rect.left, t: rect.top, w: rect.width, h: rect.height, r: rect.right, b: rect.bottom },
      wrapW: wrect.width,
      modalW: mrect.width,
      /* 不用 scrollWidth - clientWidth 判横向溢出：Windows 上垂直滚动条会占 15px，
       * 两者天然差 15，会把每个正常弹窗都报成「溢出」。
       * 真正的判据是「能不能横着滚」—— 试着滚一下再看 scrollLeft。 */
      culprits: (function(){
        var box = wrap.closest('.modal-card') || wrap;
        var cb = box.getBoundingClientRect();
        var out = [];
        Array.prototype.forEach.call(box.querySelectorAll('*'), function(n){
          var b = n.getBoundingClientRect();
          if (b.right > cb.right + 0.5 && b.width > 0) out.push((n.className || n.tagName) + ':' + b.right.toFixed(0) + '>' + cb.right.toFixed(0));
        });
        return out.slice(0, 6);
      })(),
      scrollLeftMax: scroll ? (function(){ var b = scroll.scrollLeft; scroll.scrollLeft = 9999; var v = scroll.scrollLeft; scroll.scrollLeft = b; return v; })() : 0,
      burstCenter: burst ? (function(){
        var br = burst.getBoundingClientRect();
        return { x: br.left + br.width / 2, y: br.top + br.height / 2 };
      })() : null,
      groupCount: document.querySelectorAll('.result-group').length,
      modalShown: !modal.classList.contains('hidden')
    };
  })()`);

  if (r && r.__error) { ok(false, '页面取值失败', r.__error); }
  else if (r && r.error) { ok(false, '页面结构不符', r.error); }
  else {
    ok(r.groups === 3, '三组都画出来了');
    ok(r.modalShown === true, '结算弹窗真的显示着（不是只有一个隐藏的 DOM）');
    ok(r.bigCount === 1, '只有一组带 is-big');
    ok(r.bigKind === 'bz', 'data-big 记录了牌型种类');

    /* 20 设计 px 字号 + 5px 上下内边距，在 390 宽（缩放 0.52）下约 18 CSS px。
     * 阈值取 14 而不是 20：那是设计 px 与 CSS px 混淆过一次的地方。 */
    ok(r.banner && r.banner.h >= 14, '横幅有实际高度（' + (r.banner ? r.banner.h.toFixed(1) : 0) + 'px）');
    ok(r.banner && r.banner.text.indexOf('豹子') === 0, '横幅文字是牌型名');

    ok(r.ptCount === 12, '粒子刚好 12 个');
    ok(r.ptAnim === (W > H ? 'fxBurstTight' : 'fxBurst'),
      '粒子动画名与朝向匹配（' + r.ptAnim + '）');
    ok(r.ptDuration && parseFloat(r.ptDuration) > 0.2, '动画时长不是被压成 0（' + r.ptDuration + '）');
    ok(r.ptDelay && parseFloat(r.ptDelay) >= 0.18, '首个粒子有延迟，等组滑进来再炸（' + r.ptDelay + '）');
    ok(/rgb/.test(r.ptColor || ''), '粒子有颜色（' + r.ptColor + '）');
    ok(new Set(r.angles).size === 12, '12 个角度互不相同（' + new Set(r.angles).size + ' 个）');

    ok(r.afterAnim === 'fxHalo', '边框光晕在跑（' + r.afterAnim + '）');
    ok(r.afterBg && r.afterBg !== 'none', '光晕有实际阴影');

    ok(r.rect.w > 0 && r.rect.h > 0, '特写组有实际尺寸');
    ok(r.rect.l >= -1 && r.rect.r <= W + 1, '组没有横向出屏（' + r.rect.l.toFixed(0) + '~' + r.rect.r.toFixed(0) + ' / ' + W + '）');
    ok(r.scrollLeftMax <= 0, '弹窗不能横向滚动（scrollLeft 最大 ' + r.scrollLeftMax + '，越界元素 ' + JSON.stringify(r.culprits) + '）');
    ok(r.burstCenter && r.burstCenter.x > r.rect.l && r.burstCenter.x < r.rect.r,
      '粒子从组中心出发，不在屏幕左上角');

    /* 竖屏半径 74：组高要够，否则粒子会越过组边界压到相邻行上 */
    if (W < H) {
      ok(r.rect.h > 148, '竖屏组高够放 74px 的爆发半径（' + r.rect.h.toFixed(0) + 'px）');
    } else {
      ok(r.rect.h > 76, '横屏用 38px 半径，组高够（' + r.rect.h.toFixed(0) + 'px）');
    }

    /* 组数说明：本轮 3 组都结算了，不该出现「剩下 N 组没有进行」那句 */
    ok(r.groupCount === 3, '页面里没有多余的组');
  }

  /* 截图前再收一次别的弹窗：新手引导是首屏流程的一部分，
   * 会在 seed 之后的某个时刻被自己的定时器弹出来，压在结算层上面。
   * 不重新收一遍，截出来的永远是引导页 —— 而断言全绿（测的是 DOM，不是截图）。 */
  await evaluate('window.__isolateResult && window.__isolateResult()');
  await sleep(400);
  const p = await shot('big-fx-' + W + 'x' + H);
  if (p) console.log('\n  截图：' + p);

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('========================================');

  await cdp.send('Page.close').catch(() => {});
  cdp.close();
  edge.kill();
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); server.close(); process.exit(1); });
