/**
 * 回滚演练（R6）—— 真浏览器验「翻开关到底能不能退回去」
 *
 * 为什么单独写一个探针，而不是在各自的探针里顺手验一句：
 *
 *   `probe-table-ready.js` 验的是「`?tableready=0` 时回到房间页」，
 *   `probe-emoji.js` 验的是「开关开着时表情能用」。两者都只验了**自己那一半**，
 *   而线上出问题时值班的人要问的是另一个问题：
 *
 *     **我把两个开关都关掉，是不是真的回到了「这两个功能都没上线」的样子？**
 *
 *   这个问题只有「两个开关交叉」才能回答，所以必须有一个矩阵：
 *
 *     | 组合                    | 期望                                    |
 *     |-------------------------|-----------------------------------------|
 *     | 默认（都开）            | 牌桌准备态 + 顶栏有表情钮 + 发出去会飞   |
 *     | `?tableready=0`         | 独立房间页（退回 R1 的画面）             |
 *     | `?tableready=0` + 进桌  | 顶栏**仍有**表情钮 —— 两个开关正交       |
 *     | `?emoji=0`              | 顶栏无表情钮，且别人发的**不画**          |
 *     | `?emoji=abc`（笔误）    | 按 CONFIG 走 = 正常，不因为笔误关功能     |
 *
 * 三条容易漏掉的：
 *
 *   ① **「收」那一路必须单独验**。只验「按钮没了」是不够的 ——
 *      最糟的坏状态是「自己发不出去，却能看见别人发的飞过来」，
 *      那看起来像「我这台手机坏了」而不是「这个功能关了」。
 *      所以关掉之后要**从另一头注入一条事件**，确认动画层里没有节点。
 *   ② **正交性**。关 R2 不该连带把 R4 关掉（两个开关管两件事）。
 *      这一条只有交叉组合能测出来。
 *   ③ **非法值不许关功能**。`?emoji=abc` 必须按 CONFIG 走 ——
 *      否则一次分享链接被手抖改错，功能就悄悄消失了。
 *
 * 为什么用 URL 覆盖而不是改 config.js：不改文件、不重启、不用 try/finally 保证恢复。
 * 一个「验证回滚」的脚本如果自己需要回滚，它本身就是风险。
 *
 * 用法：node scripts/probe-rollback.js [宽] [高]
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
const SHOT_DIR = path.join(os.tmpdir(), 'lxw-rollback');
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

let cdp = null;
let evaluate = null;

async function shot(name) {
  if (!SHOTS) return '';
  /* 截图前统一收掉所有弹窗：新手引导 / 结算层会压在被测屏上面，
   * 拍出来的永远不是要看的那一屏。只在截图时做，断言仍然读真实 DOM。 */
  await evaluate('Array.prototype.forEach.call(document.querySelectorAll(".modal"),'
    + 'function(m){ m.classList.add("hidden"); }); "ok"');
  await sleep(80);
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const p = path.join(SHOT_DIR, name + '.png');
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  return p;
}

/** 打开一个带开关参数的页面（每次都清掉上一轮的房间，保证各阶段互不影响） */
async function boot(query) {
  await evaluate('(function(){ try { localStorage.removeItem("weile_rooms"); } catch(e){} return 1; })()');
  const url = 'http://127.0.0.1:' + PORT + '/?mode=local' + query;
  await cdp.send('Page.navigate', { url: url });
  await sleep(1500);
  /* 引导的「看过了」标记只在启动时读一次，所以设完必须再重载一遍，
   * 否则每个阶段的第一屏都会被新手引导盖住 —— 截图里只能看到引导，
   * 而断言全绿（断言读的是 DOM，不是像素）。这个坑在 R5 的探针里也踩过一次。 */
  await evaluate('localStorage.setItem("lxw_guide_seen_v1","1")');
  await cdp.send('Page.navigate', { url: url });
  await sleep(1600);
  await evaluate(WAIT_FN);
}

/** 建房，返回 roomId（停在房间页 / 准备态） */
async function createRoom() {
  await evaluate('(function(){ var b = document.getElementById("btn-create"); if (b) b.click(); return 1; })()');
  /* ★ v103 起「创建房间」先弹「本局打几把」，点了确认才真的开房。
   * 缺这一步 → 房间没建 → 后面所有断言都拿不到牌桌（脚本过期，不是功能坏）。 */
  await sleep(500);
  /* ★ 这个文件的 evaluate 是**单参数**的（evaluate(expr)），不要照抄别的探针写成
   * evaluate(cdp, expr) —— 那会把 cdp 对象当成 expression 传给 CDP，
   * 报 "Failed to deserialize params.expression"。 */
  await evaluate(`(function(){var b=document.getElementById('btn-create-confirm');if(b)b.click();})()`);
  await sleep(500);
  await sleep(1000);
  return evaluate(`(function(){
    var rooms = JSON.parse(localStorage.getItem('weile_rooms') || '{}');
    var id = Object.keys(rooms)[0] || null;
    window.__roomId = id;
    return id;
  })()`);
}

/** 加一个陪练并让他准备 —— 本地模式下走的就是真实的 joinRoom 路径 */
async function addPal() {
  await evaluate(`(function(){
    var id = window.__roomId;
    if (!id) return null;
    RoomStore.joinRoom(id, { id: 'probe-pal', nickname: '陪练' });
    return 1;
  })()`);
  await sleep(350);
  await evaluate(`(function(){
    var id = window.__roomId;
    if (!id) return null;
    RoomStore.setReady(id, 'probe-pal', true);
    return 1;
  })()`);
  await sleep(350);
}

async function readySelf() {
  await evaluate('(function(){ var b = document.getElementById("btn-ready"); if (b) b.click(); return 1; })()');
  await sleep(1300);
}

/** 页面结构快照：只回答「哪个页面在显示、准备件挂在哪、有没有表情钮」 */
const SNAP = `(function(){
  function vis(id){ var e = document.getElementById(id); if(!e) return null;
    var r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
  var b = document.getElementById('btn-ready');
  var emo = document.getElementById('btn-emoji');
  var acts = document.querySelector('#screen-room .room-actions') || document.querySelector('#ready-acts .room-actions');
  return {
    game: vis('screen-game'), room: vis('screen-room'),
    tableReady: vis('table-ready'),
    readyText: b ? (b.textContent || '').trim() : null,
    readyParent: (b && b.parentNode) ? (b.parentNode.id || b.parentNode.className) : null,
    actsParent: (acts && acts.parentNode) ? (acts.parentNode.id || acts.parentNode.className) : null,
    hasEmojiBtn: !!emo,
    emojiBtnVisible: emo ? (function(){ var r = emo.getBoundingClientRect(); return r.width > 0 && r.height > 0; })() : false,
    opps: document.querySelectorAll('#game-top .gt-opp').length,
    layerNodes: document.querySelectorAll('#emoji-layer .emoji-fly').length
  };
})()`;

async function main() {
  server.listen(PORT);
  const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ['--headless=new', '--remote-debugging-port=' + CDP_PORT, '--no-first-run',
      '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
      '--user-data-dir=' + path.join(os.tmpdir(), 'lxw-rb-' + Date.now()), 'about:blank'],
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

  cdp = await cdpConnect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
  evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __error: String(r.exceptionDetails.text) };
    return r.result && r.result.value;
  };

  console.log('===== ' + W + '×' + H + ' 回滚演练 =====');

  /* ===================== ① 基线：两个开关都开 ===================== */
  console.log('\n[1] 基线（TABLE_READY + EMOJI 都开）');
  await boot('');
  const rid = await createRoom();
  ok(!!rid, '建出房间', JSON.stringify(rid));
  await addPal();

  const base = await evaluate(SNAP);
  ok(base && base.tableReady === true, '★ 准备态画在牌桌上（R2 生效）', JSON.stringify(base));
  ok(base && base.game === true && base.room === false, '牌桌在显示、房间页收起');
  /* 搬的是 `.room-actions` 整条动作栏（`#btn-ready` 只是它里面的按钮），
   * 所以要看**动作栏的父节点**，不是按钮的父节点 —— 按钮的父节点永远是
   * room-actions，跟搬没搬无关。这里差点写成「看按钮父节点」，那会永远红。 */
  ok(/ready-acts|table-ready/.test(String(base && base.actsParent)),
    '★ 准备动作栏已经搬到牌桌面板上', String(base && base.actsParent));
  if (SHOTS) console.log('    截图：' + (await shot('01-baseline-ready')));

  await readySelf();
  const inGame = await evaluate(SNAP);
  ok(inGame && inGame.opps >= 1, '两个人准备好了 → 进牌桌', JSON.stringify(inGame));
  ok(inGame && inGame.hasEmojiBtn === true, '★ 顶栏有表情入口（R4 生效）');
  if (SHOTS) console.log('    截图：' + (await shot('01-baseline-playing')));

  /* 发一条真实的：点 UI，走完整链路 */
  const flew = await evaluate(`(function(){
    document.getElementById('btn-emoji').click();
    return new Promise(function(res){
      __wait(function(){ return document.querySelectorAll('#emoji-grid .emoji-cell').length > 0; }, 2000).then(function(){
        var cell = document.querySelectorAll('#emoji-grid .emoji-cell')[0];
        if (!cell) return res({ noCell: true });
        cell.click();
        __wait(function(){ return document.querySelector('#emoji-layer .emoji-fly'); }, 1500).then(function(n){
          res({ flew: !!n });
        });
      });
    });
  })()`);
  ok(flew && flew.flew === true, '★ 开关开着时会飞（对照组，否则后面「不飞」证明不了什么）', JSON.stringify(flew));

  /* ===================== ② 只关 R2：退回房间页 ===================== */
  console.log('\n[2] 只关准备态（?tableready=0）→ 应退回独立的房间页');
  await boot('&tableready=0');
  await createRoom();
  await addPal();
  const legacy = await evaluate(SNAP);
  ok(legacy && legacy.room === true, '★ 回到独立的房间页', JSON.stringify(legacy));
  ok(legacy && legacy.tableReady === false, '★ 牌桌上不再画准备态');
  ok(/screen-room/.test(String(legacy && legacy.actsParent)),
    '★ 准备动作栏仍在房间页里（没有被搬走）', String(legacy && legacy.actsParent));
  if (SHOTS) console.log('    截图：' + (await shot('02-tableready-off')));

  /* 回滚路径的按钮必须是「活的」—— 搬节点最容易出的错是搬过去还能点、
   * 搬回来变成死节点（事件跟着旧父级一起丢了）。 */
  await readySelf();
  const legacyClick = await evaluate(`(function(){
    var b = document.getElementById('btn-ready');
    return { text: b ? (b.textContent || '').trim() : null };
  })()`);
  ok(legacyClick && /取消准备/.test(String(legacyClick.text)),
    '★ 回滚路径的准备按钮同样真的能点', JSON.stringify(legacyClick));

  /* ===================== ③ 正交性：关 R2 不影响 R4 ===================== */
  console.log('\n[3] 正交性：关了准备态，进桌后表情入口应该还在');
  await addPal();   // 保险（上一步可能还没进桌）
  await readySelf();
  const cross = await evaluate(SNAP);
  ok(cross && cross.opps >= 1, '在 tableready=0 下也能正常进牌桌', JSON.stringify(cross));
  ok(cross && cross.hasEmojiBtn === true,
    '★ 顶栏仍有表情入口（两个开关管两件事，不互相牵连）', JSON.stringify(cross));

  /* ===================== ④ 只关 R4：入口没了，「收」也要关 ===================== */
  console.log('\n[4] 只关表情（?emoji=0）→ 无入口，且别人发的也不画');
  await boot('&emoji=0');
  await createRoom();
  await addPal();
  /* ★ 必须在「准备之前」量准备态：一旦开局，`#table-ready` 本来就会被收起来
   *   （它只服务于等人那一屏）。在开局之后量，会得到 false ——
   *   那不是「开关被连带关掉」，只是「这一屏已经过去了」。 */
  const preReady = await evaluate(SNAP);
  ok(preReady && preReady.tableReady === true,
    '★ 准备态没被连带关掉（关表情不影响 R2）', JSON.stringify(preReady));

  await readySelf();
  const noEmo = await evaluate(SNAP);
  ok(noEmo && noEmo.opps >= 1, '仍然能正常进牌桌（关掉表情不影响开局）', JSON.stringify(noEmo));
  ok(noEmo && noEmo.hasEmojiBtn === false, '★ 顶栏没有表情入口');

  /* 「收」这一路：从另一头注入一条，模拟同桌的人发表情过来。
   * 走的是 RoomStore 的公开接口（线上别人发过来也最终落到同一个回调），
   * 不给游戏代码加测试钩子 —— 探针越少碰内部实现，验的东西越接近线上。 */
  const injected = await evaluate(`(function(){
    var ok = RoomStore.sendEmoji(window.__roomId, 'probe-pal', '*', 'e6');
    return { sent: ok };
  })()`);
  await sleep(600);
  const afterInject = await evaluate(SNAP);
  ok(injected && injected.sent === true, '注入的那一条确实发出去了（不是被节流挡掉）', JSON.stringify(injected));
  ok(afterInject && afterInject.layerNodes === 0,
    '★ 关掉后别人的表情不画（只藏入口会变成「我能看不能发」）', JSON.stringify(afterInject));
  if (SHOTS) console.log('    截图：' + (await shot('03-emoji-off')));

  /* ===================== ⑤ 两个都关：回到「这两个功能都没上线」 ===================== */
  console.log('\n[5] 两个都关（?tableready=0&emoji=0）');
  await boot('&tableready=0&emoji=0');
  await createRoom();
  await addPal();
  const both = await evaluate(SNAP);
  ok(both && both.room === true && both.tableReady === false, '★ 房间页 + 无牌桌准备态', JSON.stringify(both));
  ok(/screen-room/.test(String(both && both.actsParent)), '★ 准备件在房间页里');
  await readySelf();
  const bothIn = await evaluate(SNAP);
  ok(bothIn && bothIn.hasEmojiBtn === false, '★ 进桌后也没有表情入口');

  /* ===================== ⑥ 笔误不许关功能 ===================== */
  console.log('\n[6] 非法值（?emoji=abc）→ 按 CONFIG 走，不因为笔误关掉功能');
  await boot('&emoji=abc');
  await createRoom();
  await addPal();
  await readySelf();
  const typo = await evaluate(SNAP);
  ok(typo && typo.hasEmojiBtn === true,
    '★ 认不出的一律按 CONFIG（开）—— 分享链接被改错不该让功能消失', JSON.stringify(typo));

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  cdp.close();
  try { edge.kill(); } catch (e) { /* 已经退出 */ }
  server.close();
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); });
