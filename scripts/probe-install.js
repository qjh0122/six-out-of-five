/**
 * 安装引导条 / 忘记密码说明 的渲染探针（一次性诊断脚本，不进测试套件）
 *
 * 为什么需要它：这个页面跑在 750 宽的设计空间里（#stage 整体 scale），
 * CSS 里写的 px 会再乘约 0.52 才是屏幕像素。新加的两个块（首页安装条、登录页忘记密码）
 * 都是「一行文字 + 一个按钮」的结构，最容易出的问题是：
 *   · 文案太长被裁（nowrap / ellipsis）；
 *   · 整条超出视口宽度；
 *   · 竖屏把首页挤到需要滚动，横屏落进网格空位。
 * 这些在单测里一条都看不见，只能量渲染后的屏幕像素。
 *
 * 用法：node scripts/probe-install.js [宽] [高] [输出目录]
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const W = Number(process.argv[2]) || 390;
const H = Number(process.argv[3]) || 844;
const OUT = process.argv[4] || path.join(os.tmpdir(), 'lxw-install-' + Date.now());
const STATIC_PORT = 3033;
const CDP_PORT = 9343;
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

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  await new Promise((r) => server.listen(STATIC_PORT, '127.0.0.1', r));

  const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const userDir = path.join(os.tmpdir(), 'lxw-inst-edge-' + Date.now());
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
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 2, mobile: true
  });
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + STATIC_PORT + '/' });
  await sleep(2400);

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) return { error: String(r.exceptionDetails.text) };
    return r.result && r.result.value;
  };

  async function shot(name) {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const p = path.join(OUT, name);
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    return p;
  }

  console.log('视口 ' + W + '×' + H + '  截图目录 ' + OUT);

  /* 竖屏 390 宽会走 .compact-v；横屏会走 .ls（首页变两列网格） */
  const isLs = W > H;

  /* ============================ 一、登录页：忘记密码 ============================ */
  console.log('\n[登录页] 忘记密码的按钮与说明');
  await evaluate(`(function(){
    document.getElementById('guide-modal').classList.add('hidden');
    document.getElementById('btn-forgot').click();
  })()`);
  await sleep(300);

  const authRead = `(function(){
    var btn = document.getElementById('btn-forgot');
    var note = document.getElementById('auth-forgot-note');
    var card = document.querySelector('#screen-auth .auth-card');
    var bottomNote = document.getElementById('auth-note');
    function r(el){ if(!el) return null; var b=el.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height),
               left: Math.round(b.left), right: Math.round(b.right),
               top: Math.round(b.top), bottom: Math.round(b.bottom) }; }
    return {
      btn: r(btn), note: r(note), card: r(card), bottomNote: r(bottomNote),
      btnVisible: btn ? btn.offsetParent !== null : null,
      noteOpen: note ? !note.classList.contains('hidden') : null,
      btnText: btn ? btn.textContent.trim() : null,
      noteText: note ? note.textContent.trim().slice(0, 24) : null,
      noteClipped: note ? (note.scrollWidth > note.clientWidth + 1) : null,
      bottomText: bottomNote ? bottomNote.textContent.trim() : null,
      bottomClipped: bottomNote ? (bottomNote.scrollWidth > bottomNote.clientWidth + 1) : null,
      vw: window.innerWidth, vh: window.innerHeight
    };
  })()`;

  const a = await evaluate(authRead);
  const imgAuth = await shot('auth-forgot.png');
  console.log('    按钮 ' + a.btn.w + '×' + a.btn.h + '  说明 ' + a.note.w + '×' + a.note.h
    + '  图：' + imgAuth);
  ok(a.btnVisible === true, '登录态显示「忘记密码怎么办？」');
  ok(a.noteOpen === true, '点一下就展开说明（默认收起）');
  ok(a.noteClipped === false, '说明文字没有被横向裁切');
  ok(a.bottomClipped === false, '底注文字没有被横向裁切');
  ok(a.note.left >= -1 && a.note.right <= a.vw + 1, '说明块没有超出视口宽度',
    JSON.stringify(a.note));
  ok(a.btn.h >= 30, '「忘记密码」的点击高度 ≥ 30 屏幕px', a.btn.h);

  /* 切到注册态：按钮要消失，底注要换成「不绑手机号，忘了只能找管理员」 */
  await evaluate(`document.querySelector('[data-auth-tab="register"]').click()`);
  await sleep(260);
  const reg = await evaluate(`(function(){
    var btn = document.getElementById('btn-forgot');
    var note = document.getElementById('auth-note');
    return {
      btnVisible: btn ? btn.offsetParent !== null : null,
      bottomText: note ? note.textContent.trim() : '',
      bottomClipped: note ? (note.scrollWidth > note.clientWidth + 1) : null
    };
  })()`);
  await shot('auth-register.png');
  ok(reg.btnVisible === false, '注册态不显示「忘记密码」（没有旧密码可忘）');
  ok(/管理员/.test(reg.bottomText), '★ 注册态底注明说「忘了只能找管理员重置」', reg.bottomText);
  ok(reg.bottomClipped === false, '注册态底注没被裁切', reg.bottomText);

  /* ============================ 二、首页：安装引导条 ============================ */
  console.log('\n[首页] 安装引导条');
  await evaluate(`(function(){
    document.getElementById('screen-auth').classList.add('hidden');
    var home = document.getElementById('screen-home');
    home.classList.remove('hidden');
    var bar = document.getElementById('install-bar');
    bar.classList.remove('hidden');
    document.getElementById('install-text').textContent = '添加到桌面，下次一点就开';
    document.getElementById('install-go').textContent = '安装';
  })()`);
  await sleep(320);

  const homeRead = `(function(){
    var bar = document.getElementById('install-bar');
    var main = document.getElementById('btn-install');
    var txt = document.getElementById('install-text');
    var go = document.getElementById('install-go');
    var x = document.getElementById('btn-install-x');
    var links = document.querySelector('.entry-links');
    var inner = document.querySelector('#screen-home .home-inner');
    function r(el){ if(!el) return null; var b=el.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height),
               left: Math.round(b.left), right: Math.round(b.right),
               top: Math.round(b.top), bottom: Math.round(b.bottom) }; }
    return {
      bar: r(bar), main: r(main), txt: r(txt), go: r(go), x: r(x),
      links: r(links), inner: r(inner),
      txtClipped: txt ? (txt.scrollWidth > txt.clientWidth + 1) : null,
      xClipped: x ? (x.scrollWidth > x.clientWidth + 1) : null,
      pageOverflow: inner ? (inner.scrollHeight - inner.clientHeight) : null,
      text: txt ? txt.textContent.trim() : null,
      goText: go ? go.textContent.trim() : null,
      vw: window.innerWidth, vh: window.innerHeight
    };
  })()`;

  const h = await evaluate(homeRead);
  const imgHome = await shot('home-install-prompt.png');
  console.log('    条 ' + h.bar.w + '×' + h.bar.h + '  「' + h.text + '」 + 「' + h.goText + '」'
    + '  图：' + imgHome);
  ok(h.bar.left >= -1 && h.bar.right <= h.vw + 1, '安装条没有超出视口宽度',
    JSON.stringify({ left: h.bar.left, right: h.bar.right, vw: h.vw }));
  ok(h.txtClipped === false, '主文案没有被裁切', h.text);
  ok(h.xClipped === false, '关闭按钮的 × 没被裁切');
  ok(h.main.h >= 34, '主操作行高 ≥ 34 屏幕px（好点）', h.main.h);
  ok(h.x.w >= 26, '关闭按钮宽 ≥ 26 屏幕px', h.x.w);
  ok(h.go.w > 24 && h.go.right <= h.bar.right + 1, '「安装」胶囊在自己那一行内',
    JSON.stringify(h.go));
  ok(!isLs || h.bar.right <= h.vw + 1, '横屏下安装条落在右列内');

  /* iOS 模式：文案换掉、点一下展开三步说明。
   * 注意必须先清掉 __lxwInstallPrompt —— headless Edge 真的会收到 beforeinstallprompt，
   * 有它的时候点按钮走的是「弹系统安装框」，而不是展开步骤（iOS 上永远没有这个事件）。 */
  await evaluate(`(function(){
    window.__lxwInstallPrompt = null;
    document.getElementById('install-text').textContent = '添加到主屏幕，像 App 一样打开';
    document.getElementById('install-go').textContent = '怎么做';
    document.getElementById('btn-install').click();
  })()`);
  await sleep(300);
  const iosRead = `(function(){
    var steps = document.getElementById('install-steps');
    var bar = document.getElementById('install-bar');
    function r(el){ if(!el) return null; var b=el.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height),
               left: Math.round(b.left), right: Math.round(b.right),
               top: Math.round(b.top), bottom: Math.round(b.bottom) }; }
    return {
      steps: r(steps), bar: r(bar),
      open: steps ? !steps.classList.contains('hidden') : null,
      text: steps ? steps.textContent.trim().slice(0, 18) : '',
      stepsOverflowY: steps ? (steps.scrollHeight - steps.clientHeight) : null,
      vw: window.innerWidth
    };
  })()`;
  const s = await evaluate(iosRead);
  const imgIos = await shot('home-install-ios.png');
  console.log('    展开后 条 ' + s.bar.w + '×' + s.bar.h + '  步骤 ' + s.steps.w + '×' + s.steps.h
    + '  图：' + imgIos);
  ok(s.open === true, '点「怎么做」展开分步说明');
  ok(s.steps.right <= s.vw + 1 && s.steps.left >= -1, '分步说明没有超出视口');
  ok(s.stepsOverflowY <= 0, '分步说明没有被纵向裁切', s.stepsOverflowY);
  ok(s.bar.h > h.bar.h, '展开后整条变高（第二行真的排进去了）', s.bar.h + ' vs ' + h.bar.h);
  ok(/分享/.test(s.text), '说明里提到了「分享」这一步', s.text);

  /* 收起再点关闭：整条要消失并写入 30 天免打扰 */
  await evaluate(`(function(){ document.getElementById('btn-install-x').click(); })()`);
  await sleep(220);
  const closed = await evaluate(`(function(){
    return {
      hidden: document.getElementById('install-bar').classList.contains('hidden'),
      stamp: (function(){ try { return Number(localStorage.getItem('lxw_install_dismissed_v1')) || 0; }
                          catch (e) { return -1; } })()
    };
  })()`);
  ok(closed.hidden === true, '点 × 收起安装条');
  ok(closed.stamp > 0, '★ 写下「不再提示」的时间戳（30 天后才会再出现）', closed.stamp);

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('截图目录：' + OUT);
  console.log('========================================');

  cdp.close();
  edge.kill();
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
