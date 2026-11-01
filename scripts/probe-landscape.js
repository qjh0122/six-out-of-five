/**
 * 横竖屏字号物理尺寸探针（一次性诊断，不进测试套件）
 *
 * 为什么需要：横屏 844×390 时 scale = 390/1440 ≈ 0.27，
 * 而设计稿字号是按 750 宽、竖屏 ~0.52 缩放定的。落差到底有多大，
 * 乘法能算出来，但“算出来的数”和“浏览器里真的渲染成几 px”不是一回事
 * （--tap-min 之类运行时写入的变量会反过来影响排版）。所以量。
 *
 * 用法：node scripts/probe-landscape.js
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', 'pwa');
const PORT = 3066;
const CDP = 9366;
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

async function measure(cdp, w, h, label) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
  await sleep(900);
  const out = await cdp.send('Runtime.evaluate', {
    expression: `(function(){
      var st = document.getElementById('stage');
      var cs = st ? getComputedStyle(st).transform : '';
      var m = /matrix\\(([-0-9.]+)/.exec(cs || '');
      var scale = m ? Number(m[1]) : 1;
      function px(sel){
        var e = document.querySelector(sel);
        if (!e) return null;
        var s = getComputedStyle(e);
        var r = e.getBoundingClientRect();
        var design = parseFloat(s.fontSize);
        return {
          sel: sel, designPx: Math.round(design*10)/10, realPx: Math.round(design*scale*10)/10,
          /* 物理点击热区：这两个数才是手指真正要命中的面积 */
          boxW: Math.round(r.width*10)/10, boxH: Math.round(r.height*10)/10
        };
      }
      return {
        viewport: { w: innerWidth, h: innerHeight },
        scale: Math.round(scale*1000)/1000,
        stageW: st ? Math.round(st.getBoundingClientRect().width) : null,
        items: [px('.auth-title'), px('.auth-note'), px('.btn'), px('.entry-link'), px('.entry-label')].filter(Boolean)
      };
    })()`, returnByValue: true
  });
  console.log('--- ' + label + ' ---');
  console.log(JSON.stringify(out.result.value, null, 1));
}

async function main() {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const edge = spawn(exe, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + CDP,
    '--user-data-dir=' + path.join(os.tmpdir(), 'lxw-ls-' + Date.now()),
    '--window-size=390,844', '--force-device-scale-factor=1', 'about:blank'
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
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/?mode=local' });
  await sleep(1800);

  await measure(cdp, 390, 844, '竖屏 390×844');
  await measure(cdp, 360, 640, '竖屏 360×640（小屏）');
  await measure(cdp, 844, 390, '横屏 844×390');
  await measure(cdp, 390, 844, '转回竖屏 390×844（切屏后）');

  cdp.close();
  try { edge.kill(); } catch (e) {}
  server.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
