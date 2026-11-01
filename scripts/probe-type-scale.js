/**
 * 字号阶梯探针（一次性诊断脚本，不进测试套件）
 *
 * 用途：回答「窄屏上的字是不是反而更小」。
 *
 * 为什么要真浏览器：牌桌整体按 750 设计宽做 `transform: scale()`，
 * 所以 CSS 里写 21px 的字，在 320 宽屏上实际只有 21 × (320/750) = 8.96 CSS px。
 * 而 `@media (max-width: 360px)` 又把这个 21px 改成 19px —— 如果它是历史残留，
 * 就会让「缩放最小」的 320 屏拿到「字号也最小」的双重缩小。静态读 CSS 看不出来。
 *
 * 用法：node scripts/probe-type-scale.js
 *   三档竖屏（320×568 / 390×844 / 430×932）自动跑完，本地起静态服务，不碰线上。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 3022;
const CDP_PORT = 9334;
const ROOT = path.join(__dirname, '..', 'pwa');

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

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find((p) => fs.existsSync(p)) || 'msedge';

/* 待测元素：类名 → 注入用的 HTML。要覆盖「被媒体查询改过」和「没被改过」两类，
 * 才能看出差异到底来自媒体查询还是来自舞台缩放。 */
const TARGETS = [
  ['slot-label', '<div class="slot-label">组</div>'],
  ['slot-progress', '<div class="slot-progress">0/3</div>'],
  ['opp-name', '<div class="opp-name">玩家名字</div>'],
  ['opp-score', '<div class="opp-score">20</div>'],
  ['gt-sub', '<div class="gt-sub">第 1 局 · 分牌</div>'],
  ['gt-phase', '<div class="gt-phase">分牌</div>'],
  ['gt-me-label', '<div class="gt-me-label">我的总分</div>'],
  ['gt-me-score', '<div class="gt-me"><div class="gt-score">20</div></div>'],
  ['result-head', '<div class="result-head">本轮结果</div>'],
  ['result-rd', '<div class="result-row"><div class="rd">1</div></div>'],
  ['settle-name', '<div class="settle-row"><div class="settle-name">玩家</div></div>']
];

const SIZES = [[320, 568], [360, 640], [390, 844], [430, 932]];

async function main() {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log('静态服务 127.0.0.1:' + PORT);

  const userDir = path.join(require('os').tmpdir(), 'lxw-probe-ts-' + Date.now());
  const edge = spawn(EDGE, [
    '--headless=new',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + userDir,
    '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--hide-scrollbars',
    'about:blank'
  ], { stdio: 'ignore' });

  let cdp = null;
  try {
    let list = null;
    for (let i = 0; i < 80 && !list; i += 1) {
      try { list = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list'); } catch (e) { await sleep(250); }
    }
    if (!list || !list.length) throw new Error('Edge 没起来');
    /* 只认 type==='page' 的 target：Edge 装过扩展时 list[0] 可能是扩展的后台页，
     * 在它上面导航会得到一个和本站无关的 document（踩过）。 */
    const page = list.find((t) => t.type === 'page' && /^(about:|http:)/.test(t.url || ''));
    if (!page) throw new Error('找不到可用的页面 target');
    cdp = await cdpConnect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const rows = [];
    for (const [w, h] of SIZES) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: w, height: h, deviceScaleFactor: 2, mobile: true
      });
      await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/index.html' });
      await sleep(1400);

      const expr = `(function(){
        var stage = document.getElementById('stage');
        var m = getComputedStyle(stage).transform;
        var scale = 1;
        if (m && m !== 'none') { var n = m.match(/matrix\\(([^)]+)\\)/); if (n) scale = parseFloat(n[1].split(',')[0]); }
        var host = document.getElementById('screen-game') || document.body;
        var out = { scale: scale, wide: stage.classList.contains('wide-stage'),
                    compact: stage.classList.contains('compact-v'), items: [],
                    stageH: stage.getBoundingClientRect().height / scale,
                    mqW: window.matchMedia('(max-width: 360px)').matches,
                    mqH: window.matchMedia('(max-height: 620px) and (orientation: portrait)').matches };
        var specs = JSON.parse(${JSON.stringify(JSON.stringify(TARGETS))});
        for (var i = 0; i < specs.length; i++) {
          var box = document.createElement('div');
          box.style.cssText = 'position:absolute;left:-9999px;top:0;';
          box.innerHTML = specs[i][1];
          host.appendChild(box);
          var el = box.firstElementChild;
          var target = el.querySelector('.rd') || el.querySelector('.gt-score') || el.querySelector('.settle-name') || el;
          out.items.push({ key: specs[i][0], size: parseFloat(getComputedStyle(target).fontSize) });
          host.removeChild(box);
        }
        return JSON.stringify(out);
      })()`;

      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
      if (r.exceptionDetails) {
        throw new Error('页面内脚本报错：' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description
          || r.exceptionDetails.text));
      }
      const data = JSON.parse(r.result.value);
      rows.push({ w, h, data });
    }

    /* 输出交叉表：行 = 元素，列 = 各档屏 */
    const keys = TARGETS.map((t) => t[0]);
    const head = ['元素'.padEnd(16)].concat(rows.map((r) => (r.w + '×' + r.h).padStart(16))).join(' | ');
    console.log('\n舞台缩放 |' + rows.map((r) => (' scale=' + r.data.scale.toFixed(4)).padStart(16)).join(' | '));
    console.log('设计高   |' + rows.map((r) => (' ' + Math.round(r.data.stageH) + 'px').padStart(16)).join(' | '));
    console.log('compact-v|' + rows.map((r) => (r.data.compact ? ' 是' : ' 否').padStart(16)).join(' | '));
    console.log('@w≤360   |' + rows.map((r) => (r.data.mqW ? ' 命中(已删)' : ' —').padStart(16)).join(' | '));
    console.log('@h≤620   |' + rows.map((r) => (r.data.mqH ? ' 命中(已删)' : ' —').padStart(16)).join(' | '));
    console.log(head);
    console.log('-'.repeat(head.length));
    for (const k of keys) {
      const cells = rows.map((r) => {
        const it = r.data.items.find((x) => x.key === k);
        const design = it ? it.size : NaN;
        const phys = design * r.data.scale;
        return (design + 'px→' + phys.toFixed(1)).padStart(16);
      });
      console.log(k.padEnd(16) + ' | ' + cells.join(' | '));
    }

    /* 一致性判定：以「纯缩放基线」为参照，而不是拍一个绝对值。
     * 固定 750 设计宽的画布，物理字号必然 ∝ 屏幕宽，所以 430/320 = 34% 的极差
     * 是**架构本身的结果**，不是缺陷。真正的缺陷是某个元素超过这条基线 ——
     * 那说明 CSS 里还有机型专属的字号覆盖（曾经有，让 .result-rd 到过 63%）。 */
    const scales = rows.map((r) => r.data.scale);
    const baseline = Math.max(...scales) / Math.min(...scales) - 1;
    console.log('\n纯缩放基线：' + (baseline * 100).toFixed(1)
      + '%（' + Math.max(...scales).toFixed(4) + ' / ' + Math.min(...scales).toFixed(4) + '）');
    console.log('超出基线 5 个百分点即视为存在机型专属字号覆盖：\n');
    let bad = 0;
    for (const k of keys) {
      const phys = rows.map((r) => {
        const it = r.data.items.find((x) => x.key === k);
        return it ? it.size * r.data.scale : NaN;
      }).filter((n) => isFinite(n));
      const lo = Math.min(...phys), hi = Math.max(...phys);
      const spread = lo > 0 ? (hi - lo) / lo : 0;
      const over = spread > baseline + 0.05;
      if (over) bad += 1;
      console.log('  ' + k.padEnd(16) + lo.toFixed(1) + ' ~ ' + hi.toFixed(1)
        + '  (' + (spread * 100).toFixed(0) + '%)'
        + (over ? '  <<< 超基线，存在机型专属覆盖' : '  ok'));
    }
    console.log('\n超基线元素数：' + bad + ' / ' + keys.length
      + (bad === 0 ? '  —— CSS 里已无机型专属字号覆盖' : ''));
  } finally {
    if (cdp) cdp.close();
    try { edge.kill(); } catch (e) {}
    server.close();
  }
}

main().catch((e) => { console.error('探针失败：', e.message); process.exit(1); });
