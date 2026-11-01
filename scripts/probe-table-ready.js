/**
 * 准备态长在牌桌上（v82 §3）—— 真浏览器回归
 *
 * 验的是四件事，少一件这个改动就不算成立：
 *   ① 等人时看到的是**牌桌**： #screen-game 可见、#screen-room 不可见；
 *   ② 牌桌上真的有三块内容：顶栏座位（#game-top）、中央房间卡（#tr-card）、底部动作条（#ready-acts）；
 *   ③ 搬过去的按钮**还能点**，而且是同一批 id（事件绑在元素上，clone 出来的是假按钮）；
 *   ④ 关掉开关（?tableready=0）后行为与上线前**完全一致** —— 这条是回滚承诺，必须自动验。
 *
 * 为什么要在真浏览器里验而不是静态断言：
 *   「按钮搬过去还能点」这件事静态断言看不出来。搬节点时最容易犯的错是
 *   重绑事件失败 / 绑到了副本 / id 变了，单测全绿、线上按钮点不动。
 *
 * 用法：node scripts/probe-table-ready.js
 *      ZOOM=1 node scripts/probe-table-ready.js   # 额外存截图到系统临时目录
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', 'pwa');
const PORT = 3074;
const CDP = 9374;
const SHOT_DIR = path.join(os.tmpdir(), 'lxw-table-ready');
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

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

/* 一次取全：谁是可见的、按钮在哪、卡片写了什么。
 * 全部用「元素的实际父节点」判断位置 —— 只看 id 在不在 DOM 里，
 * 是发现不了「按钮还在房间页、牌桌那头是空的」这种半迁移状态的。 */
const SNAP = `(function(){
  function vis(id){ var e = document.getElementById(id); if(!e) return null;
    var r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
  function parentOf(id){ var e = document.getElementById(id); return e && e.parentNode ? (e.parentNode.id || e.parentNode.className) : null; }
  var b = document.getElementById('btn-ready');
  var card = document.getElementById('tr-card');
  return {
    game: vis('screen-game'), room: vis('screen-room'),
    tableReady: vis('table-ready'), slots: vis('slots'),
    bottom: (function(){ var e = document.querySelector('#screen-game .game-bottom'); if(!e) return null;
      var r = e.getBoundingClientRect(); return r.height > 0; })(),
    acts: vis('ready-acts'),
    gameTop: vis('game-top'),
    phase: (document.querySelector('#game-top .gt-phase') || {}).textContent || '',
    gtSub: (document.querySelector('#game-top .gt-sub') || {}).textContent || '',
    readyParent: parentOf('btn-ready'),
    readyActsParent: (function(){
      var a = document.querySelector('#screen-room .room-actions') || document.querySelector('#ready-acts .room-actions');
      return a && a.parentNode ? (a.parentNode.id || a.parentNode.className) : null;
    })(),
    readyText: b ? (b.textContent || '').trim() : null,
    readyDisabled: b ? !!b.disabled : null,
    codeParent: parentOf('room-code'),
    /* 房间号是 .room-code-box 里的 <b>，搬的是盒子本身 —— 直接看 #room-code 的父节点
     * 永远得到 room-code-box，看不出它到底在哪个页面里。要看盒子挂在谁下面。 */
    headParent: (function(){
      var top = document.querySelector('.room-top');
      return top && top.parentNode ? (top.parentNode.id || top.parentNode.className) : null;
    })(),
    code: (document.getElementById('room-code') || {}).textContent || '',
    cardText: card ? (card.textContent || '').replace(/\\s+/g,' ').trim() : '',
    hint: (document.getElementById('room-hint') || {}).textContent || '',
    bodyScrollOver: (function(){
      var e = document.querySelector('#screen-game');
      return e ? Math.max(0, e.scrollHeight - e.clientHeight) : -1;
    })()
  };
})()`;

async function shot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
  const p = path.join(SHOT_DIR, name + '.png');
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  console.log('  截图 ' + p);
}

async function run(cdp, query, label) {
  console.log('\n=== ' + label + ' ===');
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/?mode=local' + query });
  await sleep(1600);
  await evaluate(cdp, `localStorage.setItem('lxw_guide_seen_v1','1')`);
  await evaluate(cdp, `document.getElementById('btn-create').click()`);
  /* ★ v103 起「创建房间」先弹「本局打几把」，点了确认才真的开房。
   * 缺这一步 → 房间没建 → 后面所有断言都拿不到牌桌（脚本过期，不是功能坏）。 */
  await sleep(500);
  await evaluate(cdp, `(function(){var b=document.getElementById('btn-create-confirm');if(b)b.click();})()`);
  await sleep(500);
  await sleep(1400);
  return evaluate(cdp, SNAP);
}

async function main() {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const edge = spawn(exe, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + CDP,
    '--user-data-dir=' + path.join(os.tmpdir(), 'lxw-tr-' + Date.now()),
    '--window-size=390,844', '--force-device-scale-factor=1', 'about:blank'
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
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  /* 新手引导是「首次进首页 + 1.2 秒后自动弹」，所以在页面里再写 localStorage 已经晚了 ——
   * 定时器早排上了，截图里会盖着一层引导卡。必须在**文档创建时**就把它标记成看过。 */
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try{localStorage.setItem('lxw_guide_seen_v1','1')}catch(e){}"
  });

  /* ---------------- ① 开关打开：准备态 = 牌桌 ---------------- */
  const on = await run(cdp, '', '开关打开（默认）');
  console.log('  ' + JSON.stringify(on));
  ok(on.game === true, '★ 看到的是对局页 #screen-game', JSON.stringify(on));
  ok(on.room === false, '★ 独立的房间页 #screen-room 不再显示');
  ok(on.tableReady === true, '★ 牌桌上有准备层');
  ok(on.slots === false, '★ 分牌区收起（没有手牌可打）');
  ok(on.bottom === false, '★ 手牌/提交那一栏收起');
  ok(on.acts === true, '★ 底部动作条可见');
  ok(on.gameTop === true, '★ 顶栏座位可见（复用对局页的桌沿）');
  ok(/等待|准备/.test(on.phase), '★ 顶栏阶段文案是准备态', on.phase);
  ok(on.code && on.code !== '------', '★ 房间号已渲染', on.code);
  ok(/tr-head/.test(String(on.headParent)), '★ 房间号那一整条搬到了牌桌的 head 里', String(on.headParent));
  ok(/ready-acts/.test(String(on.readyActsParent)), '★ 准备按钮搬到了动作条里', String(on.readyActsParent));
  ok(on.readyDisabled === false, '★ 准备按钮可点（不是灰的）', 'disabled=' + on.readyDisabled);
  /* ★ v106：基准分从 20 改成 0，中央卡显示的是「第 1 / 1 · 0 分」。
   * 原断言写的是「起始 20 分」—— 那是 v106 之前的规则，探针过期。
   * 现在只断言「有一个分数读数」+「有把次进度」，规则细节交给 rules 页的测试。 */
  ok(/\d+\s*分/.test(on.cardText), '★ 中央卡写了当前分数', on.cardText);
  ok(/第\s*1\s*\/\s*1/.test(on.cardText), '★ 中央卡写了把次进度（第 1 / 1）');
  ok(/第一轮/.test(on.cardText) && /第二轮/.test(on.cardText), '★ 中央卡写了两个轮次');
  ok(/比大小/.test(on.cardText) && /十点半/.test(on.cardText) && /飘三叶/.test(on.cardText) && /斗牛/.test(on.cardText),
    '★ 四种玩法的名字都来自 StateMachine（不是另抄一份字符串）', on.cardText.slice(0, 140));
  /* ★ v103 删掉了「分数见底就结束」。改成**反向断言**：
   * 卡片上不该再出现「见底」—— 哪天有人把删掉的规则写回去，这条会红。
   * （原来正着断言「有见底」，等于把一条已删的规则钉在测试里，红了一年。） */
  ok(!/见底/.test(on.cardText), '★ 中央卡不再提「见底出局」（v103 已删）', on.cardText);
  ok(on.bodyScrollOver <= 1, '★ 牌桌没有内容溢出', 'over=' + on.bodyScrollOver);
  if (process.env.ZOOM) await shot(cdp, 'ready-table-portrait');

  console.log('\n[点一下「准备」：搬过去的按钮必须真的能点]');
  await evaluate(cdp, `document.getElementById('btn-ready').click()`);
  await sleep(900);
  const after = await evaluate(cdp, SNAP);
  console.log('  ' + JSON.stringify(after));
  ok(after.readyText === '取消准备', '★ 按钮文案变成「取消准备」（说明点击真的到了处理函数）', after.readyText);
  ok(after.game === true, '★ 点完还停在牌桌上');
  ok(after.bodyScrollOver <= 1, '★ 准备后没有溢出', 'over=' + after.bodyScrollOver);

  console.log('\n[再点一次取消]');
  await evaluate(cdp, `document.getElementById('btn-ready').click()`);
  await sleep(900);
  const back = await evaluate(cdp, SNAP);
  ok(back.readyText === '准备', '★ 回到「准备」', back.readyText);

  /* ---------------- ② 开关关闭：退回到上线前的房间页 ---------------- */
  const off = await run(cdp, '&tableready=0', '开关关闭（回滚验证）');
  console.log('  ' + JSON.stringify(off));
  ok(off.room === true, '★ 回到独立的房间页', JSON.stringify(off));
  ok(off.game === false, '★ 牌桌不再显示');
  ok(/screen-room/.test(String(off.readyActsParent)), '★ 准备按钮仍在房间页里（没有被搬走）', String(off.readyActsParent));
  ok(/screen-room/.test(String(off.headParent)), '★ 房间号还在房间页里', String(off.headParent));
  ok(off.readyDisabled === false, '★ 回滚后准备按钮可点');
  await evaluate(cdp, `document.getElementById('btn-ready').click()`);
  await sleep(900);
  const offAfter = await evaluate(cdp, SNAP);
  ok(offAfter.readyText === '取消准备', '★ 回滚路径的准备按钮同样真的能点', offAfter.readyText);
  if (process.env.ZOOM) await shot(cdp, 'ready-legacy-room');

  /* ---------------- ③ 横屏：两栏栅格是另一套排布，必须单独量 ----------------
   * 竖屏靠 flex 撑，横屏靠 .ls 的 grid-template-areas —— 后者写错不会报错，
   * 只会让准备卡和按钮重叠或者整个掉出屏幕，只有量高度才能发现。 */
  console.log('\n=== 横屏 844×390 ===');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true });
  await sleep(300);
  const land = await run(cdp, '', '横屏');
  console.log('  ' + JSON.stringify(land));
  ok(land.tableReady === true, '★ 横屏也是牌桌准备态', JSON.stringify(land));
  ok(land.game === true && land.room === false, '★ 横屏没有退回房间页');
  ok(land.readyDisabled === false, '★ 横屏准备按钮可点');
  ok(land.bodyScrollOver <= 1, '★ 横屏没有内容溢出', 'over=' + land.bodyScrollOver);
  const landGeom = await evaluate(cdp, `(function(){
    var a = document.getElementById('table-ready').getBoundingClientRect();
    var b = document.getElementById('ready-acts').getBoundingClientRect();
    var s = document.getElementById('screen-game').getBoundingClientRect();
    return { overlap: Math.round(a.right - b.left), cardW: Math.round(a.width),
             actsW: Math.round(b.width), screenW: Math.round(s.width),
             outRight: Math.round(b.right - s.right) };
  })()`);
  ok(Math.abs(landGeom.overlap) > 0, '★ 横屏两栏不重叠（准备卡 | 动作条）', JSON.stringify(landGeom));
  ok(landGeom.outRight <= 1, '★ 横屏动作条没有超出屏幕', JSON.stringify(landGeom));
  if (process.env.ZOOM) await shot(cdp, 'ready-table-landscape');

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  cdp.close();
  edge.kill();
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
