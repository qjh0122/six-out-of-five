/**
 * 换头像探针（真浏览器 / CDP）
 * 跑法：node scripts/probe-avatar.js [宽] [高]   例：node scripts/probe-avatar.js 390 844
 *      ZOOM=1 额外截图到系统临时目录
 *
 * 静态断言能证明「48 个格子都生成了 HTML」，但证明不了下面这些 ——
 * 而它们才是会进线上的问题：
 *
 *   1) **图真的画出来了**：`<img>` 的 naturalWidth 必须 > 0。data URI 拼错
 *      （比如忘了 encodeURIComponent、SVG 里漏个引号）时 DOM 结构完全正常，
 *      只是 48 个格子全空 —— 而 JS 不会报错。
 *   2) **48 格不重样**：把每格的 src 收起来去重，必须还是 48 个。
 *      形状 × 配色的取模写反时，界面上看不出任何异常，只是「有几款永远轮不到」。
 *   3) **默认高亮的那格 = 座位上那款**：`forPlayer` 在弹窗和座位两处各算一次，
 *      一处用 chosen、一处用 pid，就会出现「设置里高亮 A，座位上却是 B」。
 *   4) **点了真能换**：换完高亮要移动、顶部大图要跟着换。
 *      只断言「点了没报错」抓不到「POST 拼错路径 → 服务端 404 → 静默不生效」。
 *   5) **每格够大**：390 宽手机上 8 列，格子不能跌破 28 CSS px，
 *      否则手指点哪格都像点了隔壁。
 *
 * 服务端在这个探针里是**假**的：静态服务器自己接 POST /api/me/avatar，
 * 直接回 ok。这样验的是前端整条链路（点击 → 请求 → 本地会话 → 重画），
 * 而不用为了截图去跑真服务端 + 注册账号。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const W = Number(process.argv[2]) || 390;
const H = Number(process.argv[3]) || 844;
const PORT = 3049;
const CDP_PORT = 9359;
const ROOT = path.join(__dirname, '..', 'pwa');
const SHOTS = !!process.env.ZOOM;
const SHOT_DIR = path.join(os.tmpdir(), 'lxw-avatar-probe');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.webmanifest': 'application/manifest+json', '.json': 'application/json'
};

/* 假后端：只需要一个接口。其余 /api/* 一律 404 —— 让「拼错路径」这件事
 * 在探针里表现为失败，而不是被兜底掉。 */
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };

  if (url === '/api/me/avatar') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let id = '';
      try { id = (JSON.parse(body || '{}').avatar || ''); } catch (e) { return json(400, { ok: false, error: 'bad json' }); }
      if (!/^$|^a\d{1,2}$/.test(id)) return json(400, { ok: false, error: '没有这款头像' });
      lastAvatar = id;
      json(200, { ok: true, profile: { playerId: PID, nickname: '探针', avatar: id } });
    });
    return;
  }
  if (url.indexOf('/api/') === 0) return json(404, { ok: false, error: 'probe: no such api' });

  let p = decodeURIComponent(url);
  if (p === '/') p = '/index.html';
  const abs = path.join(ROOT, p);
  if (!abs.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(abs, (e, buf) => {
    if (e) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
    res.end(buf);
  });
});

let PID = 'probe_avatar_1';
let lastAvatar = null;      // 最近一次收到的 avatar（验证请求真的发出去了）

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
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = path.join(SHOT_DIR, name + '-' + W + 'x' + H + '.png');
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
    return f;
  };
  const goto = async (url) => {
    await cdp.send('Page.navigate', { url });
    await sleep(700);
    await evaluate(WAIT_FN);
  };

  console.log('\n[0] 准备：一个已登录的会话（头像选过 a9）');
  await goto('http://127.0.0.1:' + PORT + '/index.html');
  await evaluate(`localStorage.setItem('lxw_session_v1', JSON.stringify({
    token: 'probe-token', playerId: '${PID}', nickname: '探针', avatar: 'a9'
  }))`);
  /* 同时把「新手引导看过了」标上：引导会自动弹，而它排在 Esc 关闭链最前面 ——
   * 不标掉这一位，后面按 Esc 关的是引导而不是头像，看起来像「Esc 坏了」。 */
  await evaluate(`localStorage.setItem('lxw_guide_seen_v1', '1')`);
  await goto('http://127.0.0.1:' + PORT + '/index.html');
  const hasAuth = await evaluate(`!!(window.AuthStore && AuthStore.session())`);
  ok(hasAuth === true, '会话已就位（AuthStore.session() 有值）');
  ok(await evaluate(`document.getElementById('guide-modal').classList.contains('hidden')`),
    '新手引导没弹（标记已读，否则它会抢在 Esc 关闭链最前面）');

  const screen = await evaluate(`(function(){
    var ids = ['screen-auth','screen-home','screen-room','screen-game'];
    for (var i=0;i<ids.length;i++){ var e=document.getElementById(ids[i]); if(e && !e.classList.contains('hidden')) return ids[i]; }
    return '';
  })()`);
  console.log('  当前屏幕：' + screen);

  console.log('\n[1] 打开换头像');
  await evaluate(`document.getElementById('btn-account').click()`);
  await sleep(300);
  ok(await evaluate(`!document.getElementById('account-modal').classList.contains('hidden')`),
    '账号卡打开了');
  await evaluate(`document.getElementById('btn-acc-avatar').click()`);
  await sleep(400);
  ok(await evaluate(`!document.getElementById('avatar-modal').classList.contains('hidden')`),
    '★ 从账号卡点「换头像」能打开 #avatar-modal');

  console.log('\n[2] 48 格都真的画出来了');
  const cells = await evaluate(`(function(){
    var out = Array.prototype.map.call(document.querySelectorAll('#av-grid [data-av]'), function(b){
      var im = b.querySelector('img');
      return {
        id: b.getAttribute('data-av'),
        src: im ? im.getAttribute('src') : '',
        nw: im ? im.naturalWidth : 0,
        on: b.classList.contains('is-on'),
        rect: b.getBoundingClientRect()
      };
    });
    return { n: out.length, uniq: new Set(out.map(function(o){return o.src;})).size,
             broken: out.filter(function(o){return o.nw <= 0;}).map(function(o){return o.id;}),
             ons: out.filter(function(o){return o.on;}).map(function(o){return o.id;}),
             minSide: Math.min.apply(null, out.map(function(o){return Math.min(o.rect.width, o.rect.height);})),
             squash: Math.max.apply(null, out.map(function(o){
               return Math.abs(o.rect.width - o.rect.height) / Math.max(o.rect.width, o.rect.height);
             })),
             /* 相邻两行是否叠在一起：格子自己可以是正圆，但行高被 grid 压扁时
              * 48 个圆会竖着摞起来 —— 看起来像「糊成一团」，而宽高比查不出来。 */
             overlap: (function(){
               var worst = 0;
               for (var i = 0; i + 8 < out.length; i++) {
                 worst = Math.max(worst, out[i].rect.bottom - out[i + 8].rect.top);
               }
               return worst;
             })() };
  })()`);
  ok(cells && cells.n === 48, '★ 48 个格子（实际 ' + (cells && cells.n) + '）');
  ok(cells && cells.broken.length === 0, '★★ 48 张图全部加载成功（naturalWidth > 0）',
    cells && JSON.stringify(cells.broken));
  ok(cells && cells.uniq === 48, '★★ 48 张图两两不同（去重后还是 48）', cells && ('实际 ' + cells.uniq));
  ok(cells && cells.minSide >= 28, '★ 每格 ≥28 CSS px（8 列在 ' + W + ' 宽上仍可点）',
    cells && ('实际 ' + (cells && cells.minSide && cells.minSide.toFixed(1))));
  /* 圆必须还是圆：横屏只有 390 高，容器一挤，grid 的默认 stretch 会把每格
   * 压成竖椭圆 —— 列数、类名、图片加载全都正常，只是「看着不对」。 */
  ok(cells && cells.squash <= 0.06, '★★ 每格仍是正圆（宽高比偏差 ≤6%，横屏不被压扁）',
    cells && ('最大偏差 ' + (cells.squash * 100).toFixed(1) + '%'));
  ok(cells && cells.overlap <= 0.5, '★★ 相邻两行不重叠（行高没被 grid 压扁）',
    cells && ('重叠 ' + cells.overlap.toFixed(1) + ' CSS px'));

  /* 高亮必须是「看得见的金圈」：只断言 is-on 这个类名，抓不到
   * 「box-shadow 被 overflow 裁掉 / 被后面更具体的规则覆盖」—— 那种情况下
   * 类名在、用户却看不出哪一格是当前用的。 */
  const ring = await evaluate(`(function(){
    var on = document.querySelector('#av-grid .is-on');
    if (!on) return null;
    return { shadow: getComputedStyle(on).boxShadow,
             w: on.getBoundingClientRect().width,
             cur: document.querySelector('#av-current').getBoundingClientRect().width };
  })()`);
  ok(ring && /245, 193, 92/.test(ring.shadow), '★★ 选中格真的画出了金色外圈（不是只有一个类名）',
    ring && ring.shadow);
  ok(ring && ring.cur > ring.w, '★ 顶部预览比格子大一档（一样大就分不清「当前用的」和「可选的」）',
    ring && ('预览 ' + ring.cur.toFixed(1) + ' vs 格子 ' + ring.w.toFixed(1)));

  console.log('\n[3] 默认高亮 = 选过的那一款');
  ok(cells && cells.ons.length === 1 && cells.ons[0] === 'a9',
    '★ 只有一格高亮，且正是会话里存的 a9', cells && JSON.stringify(cells.ons));
  const cur = await evaluate(`(function(){
    var im = document.querySelector('#av-current img');
    return im ? im.getAttribute('data-avatar') : '';
  })()`);
  ok(cur === 'a9', '#av-current 上的大图也是 a9（实际 ' + cur + '）');

  console.log('\n[4] 点一格就换');
  await evaluate(`document.querySelector('#av-grid [data-av="a31"]').click()`);
  const changed = await evaluate(`__wait(function(){
    var on = document.querySelector('#av-grid .is-on');
    return on && on.getAttribute('data-av') === 'a31' ? 'a31' : null;
  }, 3000)`);
  ok(changed === 'a31', '★ 点了 a31 之后高亮移过去了');
  ok(lastAvatar === 'a31', '★ 请求真的发到了 /api/me/avatar（body.avatar = ' + lastAvatar + '）');
  const cur2 = await evaluate(`(function(){
    var im = document.querySelector('#av-current img');
    return im ? im.getAttribute('data-avatar') : '';
  })()`);
  ok(cur2 === 'a31', '★ 顶部大图跟着换了（不是只有格子变了）');
  const stored = await evaluate(`JSON.parse(localStorage.getItem('lxw_session_v1') || '{}').avatar`);
  ok(stored === 'a31', '★ 本地会话也记下了（刷新后还是这款）');

  console.log('\n[5] 随机一个');
  await evaluate(`document.getElementById('btn-av-random').click()`);
  await sleep(500);
  const after = await evaluate(`(function(){
    var ons = document.querySelectorAll('#av-grid .is-on');
    return { n: ons.length, id: ons.length ? ons[0].getAttribute('data-av') : '' };
  })()`);
  ok(after && after.n === 1, '★ 随机之后仍然只有一格高亮（不会留下两个选中态）');
  ok(after && /^a\d+$/.test(after.id), '随机落在合法款上（' + (after && after.id) + '）');
  const shot1 = await shot('avatar-modal');

  console.log('\n[6] 关闭方式');
  await evaluate(`document.getElementById('btn-av-close').click()`);
  await sleep(250);
  ok(await evaluate(`document.getElementById('avatar-modal').classList.contains('hidden')`),
    '点「关闭」能关');
  ok(await evaluate(`!document.getElementById('account-modal').classList.contains('hidden')`),
    '★ 关掉头像后账号卡还在（不是一层全关掉）');

  await evaluate(`document.getElementById('btn-acc-avatar').click()`);
  await sleep(300);
  await evaluate(`document.getElementById('avatar-modal').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
  await sleep(250);
  ok(await evaluate(`document.getElementById('avatar-modal').classList.contains('hidden')`),
    '点遮罩能关');

  await evaluate(`document.getElementById('btn-acc-avatar').click()`);
  await sleep(300);
  /* 用合成事件派发，不走 Input.dispatchKeyEvent：后者在 headless 里
   * 要额外带 rawKeyDown/unmodifiedText，少一个参数就静默不触发，
   * 而这里要验的是**页面自己的 keydown 处理**，直接派发更贴近被测对象。 */
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))`);
  await sleep(250);
  ok(await evaluate(`document.getElementById('avatar-modal').classList.contains('hidden')`),
    '★ Esc 能关（键盘用户不必去找按钮）');

  console.log('\n[7] 上传照片开关（P1b，默认关）');
  /* 默认这一版：整行不该出现。不是 disabled，是**不渲染** ——
   * 灰掉的按钮会让人反复点，还会被读屏念出来。 */
  await evaluate(`document.getElementById('btn-acc-avatar').click()`);
  await sleep(350);
  ok(await evaluate(`!document.getElementById('avatar-modal').classList.contains('hidden')`),
    '默认配置下面板照常能开（上传是附加功能，不能因为它关着就开不了面板）');
  ok(await evaluate(`document.getElementById('av-photo-row').classList.contains('hidden')`),
    '★ 默认配置下上传那一行不出现（不是灰掉，是整行隐藏）');

  await goto('http://127.0.0.1:' + PORT + '/index.html?avatarupload=1');
  await evaluate(`document.getElementById('btn-account').click()`);
  await sleep(250);
  await evaluate(`document.getElementById('btn-acc-avatar').click()`);
  await sleep(350);
  const onRow = await evaluate(`(function(){
    var r = document.getElementById('av-photo-row');
    return { hidden: r.classList.contains('hidden'),
             h: Math.round(r.getBoundingClientRect().height),
             hasBtn: !!document.getElementById('btn-av-upload'),
             fileAccept: (document.getElementById('av-file')||{}).accept || '' };
  })()`);
  ok(onRow && onRow.hidden === false && onRow.h > 0,
    '★ ?avatarupload=1 时上传那一行真的出现了（高 ' + (onRow && onRow.h) + ' CSS px）');
  ok(onRow && onRow.hasBtn, '有「上传照片」按钮');
  ok(onRow && /image\/jpeg,image\/png/.test(onRow.fileAccept),
    '文件选择器只收 JPEG/PNG（accept = ' + (onRow && onRow.fileAccept) + '）');
  const shot2 = await shot('avatar-modal-upload-on');

  await goto('http://127.0.0.1:' + PORT + '/index.html?avatarupload=0');
  await evaluate(`document.getElementById('btn-account').click()`);
  await sleep(250);
  await evaluate(`document.getElementById('btn-acc-avatar').click()`);
  await sleep(350);
  ok(await evaluate(`document.getElementById('av-photo-row').classList.contains('hidden')`),
    '★ ?avatarupload=0 时那一行又藏回去了（开关两个方向都通）');

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (shot1) console.log('截图: ' + shot1);
  if (shot2) console.log('截图: ' + shot2);
  console.log('========================================');

  try { cdp.close(); } catch (e) { /* ignore */ }
  edge.kill();
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); try { server.close(); } catch (x) {} process.exit(1); });
