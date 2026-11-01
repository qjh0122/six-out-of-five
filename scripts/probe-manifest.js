/**
 * manifest / 图标在「每个请求都要带 sharecode」的网关下能不能真的装
 *
 * 为什么必须有这个探针（BACKLOG N2）：
 * 线上曾经是「页面全对、图标全裂」—— manifest.webmanifest 与 apple-touch-icon
 * 一律 403，表现是安卓装不出 WebAPK（桌面图标只是个带地址栏的快捷方式）、
 * iOS 加到桌面后图标是页面截图。而本地所有探针都是绿的，因为本地没有网关这一层。
 *
 * 更隐蔽的是：这类请求**不经过 Service Worker**。SW 只拦页面发起的 fetch，
 * 而 manifest 与图标是浏览器内部抓的 —— SW 里那套 withShare() 对它们无效。
 *
 * 第一版修法是「给图标 URL 拼 sharecode」，部署后实测没生效：网关校验完 query
 * 就把**它剥掉了**，服务端 `queryParam(req.url,'sharecode')` 永远是空。
 * 所以现在改成把图标内联成 data URI —— 不需要网络请求，天然绕开网关。
 *
 * 这个探针**起真实 server**（不是静态服务器），并额外验证一条：
 * `Page.getInstallabilityErrors` 必须为空 —— 那才是「真的能装」，
 * 只验 `getAppManifest().errors` 空只说明「解析没问题」。
 *
 * 用法：node scripts/probe-manifest.js
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const PORT = 3071;
const HOST = '127.0.0.1';
const SERVER_ROOT = path.join(__dirname, '..');
const CDP_PORT = 9387;
const CODE = 'PROBECODE123';
const SHOT_DIR = path.join(os.tmpdir(), 'lxw-manifest');

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + detail : '')); }
}
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

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const profFile = path.join(os.tmpdir(), 'lxw-mfprobe-' + Date.now() + '.json');
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: SERVER_ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), HOST: HOST, PROFILE_FILE: profFile
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  child.stdout.on('data', (d) => { out += String(d); });
  child.stderr.on('data', (d) => { out += String(d); });

  const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const edge = spawn(exe, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(os.tmpdir(), 'lxw-mf-edge-' + Date.now()),
    '--window-size=390,844',
    '--force-device-scale-factor=1',
    'about:blank'
  ], { stdio: 'ignore' });

  let page = null;
  const waitFor = async (fn, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (fn()) return true;
      await sleep(120);
    }
    return false;
  };

  try {
    const up = await waitFor(() => /listening on/.test(out), 12000);
    ok(up, '服务起来了（真 server，不是静态服务器）', out.slice(0, 200));
    if (!up) throw new Error('服务没起来');

    for (let i = 0; i < 40; i++) {
      await sleep(250);
      try {
        const list = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
        page = (list || []).find((t) => t.type === 'page');
        if (page) break;
      } catch (e) { /* 还没起来 */ }
    }
    if (!page) throw new Error('连不上 Edge CDP');

    const cdp = await cdpConnect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

    const evaluate = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) return { __error: String(r.exceptionDetails.text) };
      return r.result && r.result.value;
    };

    const URL_CODE = 'http://127.0.0.1:' + PORT + '/?sharecode=' + CODE;

    /* ================================================================
     * [1] 页面注入：三个 link 都要在，且 href 带码
     * ============================================================== */
    console.log('===== manifest / 图标（网关要求每个请求带 sharecode） =====');
    console.log('\n[1] 页面里的 <link> 必须是注入的、且带码');
    await cdp.send('Page.navigate', { url: URL_CODE });
    await sleep(2500);

    const links = await evaluate(`(function(){
      function one(rel){
        var l = document.querySelector('link[rel="' + rel + '"]');
        return l ? { href: l.getAttribute('href'), resolved: l.href } : null;
      }
      return {
        manifest: one('manifest'),
        apple: one('apple-touch-icon'),
        icon: one('icon'),
        count: document.querySelectorAll('link[rel="manifest"]').length
      };
    })()`);
    ok(links && links.manifest, '存在 <link rel="manifest">（由 head 脚本注入）', JSON.stringify(links));
    ok(links && links.manifest && links.manifest.href.indexOf('sharecode=' + CODE) >= 0,
      '★ manifest 的 href 带 sharecode（不带就 403）', links && links.manifest && links.manifest.href);
    ok(links && links.manifest && links.manifest.href.indexOf('http') !== 0,
      'href 是站内路径（不是绝对外链，网关才认）', links && links.manifest && links.manifest.href);
    ok(links && links.apple && links.apple.href.indexOf('sharecode=' + CODE) >= 0,
      '★ apple-touch-icon 也带码（iOS 靠它取图标）', links && links.apple && links.apple.href);
    ok(links && links.icon && links.icon.href.indexOf('sharecode=' + CODE) >= 0,
      '★ 声明了 favicon（以前完全没有，浏览器去请求 /favicon.ico 拿 404）', links && links.icon && links.icon.href);
    ok(links && links.count === 1,
      '只有一份 manifest link（静态那份已删掉，否则会重复抓取）', links && links.count);

    /* ================================================================
     * [2] manifest 内容：图标必须是 data URI
     * ============================================================== */
    console.log('\n[2] manifest 内部：图标全部内联，不留任何待抓 URL');
    const mf = await evaluate(`(async function(){
      var link = document.querySelector('link[rel="manifest"]');
      if (!link) return { err: 'no link' };
      var res = await fetch(link.href, { cache: 'no-store' });
      var text = await res.text();
      var doc = null;
      try { doc = JSON.parse(text); } catch (e) { return { err: 'bad json', text: text.slice(0, 120) }; }
      return {
        status: res.status,
        type: res.headers.get('content-type') || '',
        startUrl: doc.start_url,
        id: doc.id,
        hasScreens: 'screenshots' in doc,
        icons: (doc.icons || []).map(function(i){
          return { src: String(i.src).slice(0, 24), len: String(i.src).length, sizes: i.sizes, purpose: i.purpose };
        }),
        byteLen: text.length
      };
    })()`);
    ok(mf && mf.status === 200, 'manifest 能取到（200）', JSON.stringify(mf).slice(0, 200));
    ok(mf && /manifest\+json/.test(mf.type), 'Content-Type 是 manifest+json', mf && mf.type);
    ok(mf && mf.icons && mf.icons.length === 4, '4 张图标都在（含两张 maskable）', mf && mf.icons && mf.icons.length);
    ok(mf && mf.icons.every((i) => i.src.indexOf('data:image/png;base64,') === 0),
      '★ 4 张全部是 data URI（不再是会被网关 403 的 /icons/... 路径）',
      mf && JSON.stringify(mf.icons.map((i) => i.src)));
    /* 这条是上一版的死因：图标写着 /icons/... ，服务端拿不到码就拼不上，
     * 浏览器一抓就是 403。现在一个待抓 URL 都不该有。 */
    ok(mf && mf.icons.every((i) => i.src.indexOf('data:') >= 0 && i.src.indexOf('/icons/') < 0),
      '★ 没有任何一张还指向 /icons/（零网络请求）');
    ok(mf && mf.icons.filter((i) => i.purpose === 'maskable').length === 2,
      '两张 maskable 的 purpose 还在（否则自适应图标失效）', mf && JSON.stringify(mf.icons.map((i) => i.purpose)));
    ok(mf && !mf.hasScreens, '★ 响应里没有 screenshots（不内联 150KB，也不留 403 的死链）');
    ok(mf && mf.startUrl === '/', '★ start_url 保持 "/"（写死码会破坏轮换自愈）', mf && mf.startUrl);
    ok(mf && mf.id === '/', 'id 保持 "/"（改了等于换一个应用，已安装的认不出来）', mf && mf.id);
    /* 体积要有个数：图标内联后 manifest 会变大，但不能失控。
     * 43KB base64 + JSON 结构，给到 120KB 的余量。 */
    ok(mf && mf.byteLen > 20000 && mf.byteLen < 120000,
      'manifest 体积在合理区间（20–120KB，实际约 45KB）', mf && mf.byteLen);

    /* ================================================================
     * [3] 浏览器解析 + 可安装性
     * ============================================================== */
    console.log('\n[3] 浏览器解析结果（errors 必须为空）');
    let appMf = null;
    try {
      appMf = await cdp.send('Page.getAppManifest');
    } catch (e) { appMf = { __error: String(e && e.message) }; }
    ok(appMf && !appMf.__error, '能读到浏览器的 manifest 解析结果', appMf && appMf.__error);
    ok(appMf && Array.isArray(appMf.errors) && appMf.errors.length === 0,
      '★ 解析 errors 为空', appMf && JSON.stringify(appMf.errors).slice(0, 300));
    let parsedSrc = [];
    try {
      const data = appMf && appMf.data ? JSON.parse(appMf.data) : null;
      parsedSrc = data && Array.isArray(data.icons) ? data.icons.map((i) => String(i.src).slice(0, 24)) : [];
    } catch (e) { parsedSrc = []; }
    ok(parsedSrc.length === 4 && parsedSrc.every((u) => u.indexOf('data:image/png') === 0),
      '★ 浏览器拿到的也是 data URI', JSON.stringify(parsedSrc));
    ok(appMf && String(appMf.url || '').indexOf('manifest.webmanifest') >= 0,
      '抓的确实是 manifest.webmanifest', appMf && appMf.url);

    console.log('\n[4] 可安装性（这才是「真能装」，解析通过只说明「没写错」）');
    let inst = null;
    try {
      inst = await cdp.send('Page.getInstallabilityErrors');
    } catch (e) { inst = { __error: String(e && e.message) }; }
    ok(inst && !inst.__error, '能读到可安装性诊断', inst && inst.__error);
    ok(inst && Array.isArray(inst.installabilityErrors) && inst.installabilityErrors.length === 0,
      '★ installabilityErrors 为空（安卓能装出独立窗口，不是带地址栏的快捷方式）',
      inst && JSON.stringify(inst.installabilityErrors).slice(0, 300));

    /* ================================================================
     * [5] 无码环境（本地开发）行为一致
     * ============================================================== */
    console.log('\n[5] 没有码时（本地开发 / 无网关）退回裸路径，但 manifest 内容不变');
    await evaluate("try{localStorage.clear();sessionStorage.clear();}catch(e){}");
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' });
    await sleep(2200);

    const bare = await evaluate(`(async function(){
      var link = document.querySelector('link[rel="manifest"]');
      if (!link) return { err: 'no link' };
      var doc = await (await fetch(link.href, { cache: 'no-store' })).json();
      return {
        href: link.getAttribute('href'),
        icons: (doc.icons||[]).map(function(i){ return String(i.src).slice(0, 24); })
      };
    })()`);
    ok(bare && bare.href === '/manifest.webmanifest',
      '★ 无码时 href 是裸路径（本地没有网关，裸路径就是 200 —— 开发时也能测安装）', bare && bare.href);
    ok(bare && bare.icons && bare.icons.every((s) => s.indexOf('data:') === 0),
      '★ 无码时图标同样是 data URI（改写与 query 无关，两条路完全一致）', bare && bare.icons);

    /* ================================================================
     * [6] 源码级断言：静态 HTML 里不许再写死裸 href
     * ============================================================== */
    console.log('\n[6] 防复发：静态 HTML 里不许写死 <link rel="manifest" href="/...">');
    const html = fs.readFileSync(path.join(SERVER_ROOT, 'pwa', 'index.html'), 'utf8');
    /* 只认**行首**的 <link>：注释里提到 `<link rel="manifest">` 是在解释原因，
     * 不是真的标签。HTML 里的真实标签都在行首（可缩进），注释行前面有 ` * `。 */
    ok(!/^\s*<link[^>]+rel=["']manifest["']/im.test(html),
      '★ 没有静态 <link rel="manifest">（写了就会先发一次裸请求，第一发必然 403）');
    ok(!/^\s*<link[^>]+rel=["']apple-touch-icon["']/im.test(html),
      '★ 没有静态 apple-touch-icon link');
    ok(/createElement\('link'\)/.test(html) && /'manifest'/.test(html),
      '注入逻辑在 head 里（createElement link）');

    /* 截图留档：方便人眼确认页面没被这次改动弄坏 */
    try {
      await cdp.send('Page.navigate', { url: URL_CODE });
      await sleep(2000);
      const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const p = path.join(SHOT_DIR, 'manifest-ok-390x844.png');
      fs.writeFileSync(p, Buffer.from(s.data, 'base64'));
      console.log('\n截图：' + p);
    } catch (e) { /* 截图失败不影响断言 */ }

    cdp.close();
  } catch (e) {
    fail++;
    console.log('  异常：' + (e && e.message));
  } finally {
    try { edge.kill(); } catch (e) {}
    try { child.kill(); } catch (e) {}
    await sleep(400);
    try { fs.unlinkSync(profFile); } catch (e) {}
    console.log('\n========================================');
    console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(fail ? 1 : 0);
  }
}

main();
