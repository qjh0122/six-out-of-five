/**
 * 默认 10 局 + 负分继续打（v103 真机验证）
 *
 * 这一档改的是**终局规则**：把「有人分数 ≤0 就结束」删掉，只认建房时选的局数。
 * 静态那一半由 pwa/test/group-settle.test.js / hand-limit.test.js 锁死；
 * 这个探针只验静态测试永远测不到的：
 *
 *   1. **默认档真的是 10**：打开建房弹窗什么都不点，直接开始建房 → 顶栏「第 1/10 把」
 *   2. 10 局真的能打完 10 把（以前 20 分本金撑不到，3~4 把就被爆分截断）
 *   3. ★ 中途有人分数变成负数时，**人还在牌桌上**（不是被踢进结算屏）
 *   4. 打满 10 把 → 结算页，说明是「打满 10 局」，而不是「有人分数输到底」
 *   5. 结算列表里不出现「（见底）」这种已经不存在的状态
 *
 * 为什么必须是 10 局而不是 3 局：
 *   负分要打到某个人本金见底才出现，2 人局每把波动 ±5~8 分，第 3 把常常还不够；
 *   而 10 局这个默认档几乎必然在中间出现负分 —— 正好是本轮改动的靶心。
 *
 * 用法：node scripts/probe-ten-hands.js [宽] [高] [截图目录]
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const W = Number(process.argv[2]) || 390;
const H = Number(process.argv[3]) || 844;
const OUT = process.argv[4] || path.join(__dirname, '..', 'tmp-shots', 'ten-hands');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SERVER_ENTRY = path.join(__dirname, '..', 'server', 'index.js');
const SRV_PORT = 3974;
const CDP_PORT = 9374;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxw-ten-'));

const LIMIT = 10;        // 默认档（不点任何档位按钮）
const BOTS = 1;          // 2 人局：每人每组只付一份，回合最短
const MAX_ROUNDS = 26;   // 10 把 = 20 轮，留余量

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

let serverProc = null;
let serverLog = '';
let edge = null;
let cdp = null;
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try { edge && edge.kill(); } catch (e) {}
  try { serverProc && serverProc.kill(); } catch (e) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 句柄未释放 */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

function startServer() {
  serverProc = spawn(process.execPath, [SERVER_ENTRY], {
    env: Object.assign({}, process.env, {
      PORT: String(SRV_PORT),
      HOST: '127.0.0.1',
      PROFILE_FILE: path.join(TMP, 'profiles.json'),
      SEED_FILE: path.join(TMP, 'seed.json')
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const collect = (b) => { serverLog = (serverLog + b.toString()).slice(-4000); };
  serverProc.stdout.on('data', collect);
  serverProc.stderr.on('data', collect);
}

function waitServer() {
  return new Promise((resolve, reject) => {
    let n = 0;
    (function tick() {
      n += 1;
      http.get('http://127.0.0.1:' + SRV_PORT + '/api/health', (res) => { res.resume(); resolve(); })
        .on('error', () => {
          if (n > 80) return reject(new Error('服务端没起来\n' + serverLog));
          setTimeout(tick, 250);
        });
    })();
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
const PAGE_HELPERS = [
  '(function(){',
  '  var J = window.__hls = window.__hls || {};',
  '  J.vis = function(id){ var e = document.getElementById(id); return !!(e && !e.classList.contains("hidden")); };',
  '  J.handCount = function(){ return document.querySelectorAll("#hand .card-wrap").length; };',
  '  J.chips = function(){',
  '    return [].slice.call(document.querySelectorAll("#group-chips .gchip[data-group]")).map(function(c){',
  '      var m = /(\\d+)\\/(\\d+)/.exec(((c.querySelector(".gchip-count") || {}).textContent || ""));',
  '      return { key: c.dataset.group, got: m ? Number(m[1]) : -1, need: m ? Number(m[2]) : -1,',
  '               full: c.classList.contains("is-full") };',
  '    });',
  '  };',
  '  J.closeResult = function(){',
  '    var clicked = 0;',
  '    for (var i = 0; i < 12; i++) {',
  '      var m = document.getElementById("result-modal");',
  '      if (m && !m.classList.contains("hidden")) {',
  '        var b = document.getElementById("btn-result-close");',
  '        if (b) { b.click(); clicked++; continue; }',
  '      }',
  '      var k = document.getElementById("round-break-modal");',
  '      if (k && !k.classList.contains("hidden")) {',
  '        var kb = document.getElementById("btn-rb-close");',
  '        if (kb) { kb.click(); clicked++; continue; }',
  '      }',
  '      break;',
  '    }',
  '    return clicked > 0;',
  '  };',
  '  J.resultOpen = function(){',
  '    var m = document.getElementById("result-modal");',
  '    return !!(m && !m.classList.contains("hidden"));',
  '  };',
  '  J.cardOf = function(img){',
  '    var w = img && img.closest ? img.closest(".card-wrap") : null;',
  '    var id = w && w.dataset ? w.dataset.cardId : "";',
  '    if (!id) return null;',
  '    var p = id.split("-");',
  '    return { suit: p[0], rank: Number(p[1]) };',
  '  };',
  '  J.pickTenHalf = function(imgs){',
  '    var placed = [];',
  '    var boxes = document.querySelectorAll("#slots .slot[data-game=\\"tenhalf\\"] .card-box[data-card-id]");',
  '    for (var i = 0; i < boxes.length; i++) {',
  '      var p = boxes[i].dataset.cardId.split("-");',
  '      placed.push({ suit: p[0], rank: Number(p[1]) });',
  '    }',
  '    var cards = imgs.map(function(im){ return J.cardOf(im); });',
  '    var k, m, pr;',
  '    if (placed.length === 1) {',
  '      for (k = 0; k < cards.length; k++) {',
  '        if (!cards[k]) continue;',
  '        pr = StateMachine.tenHalfPair([placed[0], cards[k]]);',
  '        if (pr && !pr.bust) return imgs[k];',
  '      }',
  '    }',
  '    for (k = 0; k < cards.length; k++) {',
  '      if (!cards[k]) continue;',
  '      for (m = 0; m < cards.length; m++) {',
  '        if (m === k || !cards[m]) continue;',
  '        pr = StateMachine.tenHalfPair([cards[k], cards[m]]);',
  '        if (pr && !pr.bust) return imgs[k];',
  '      }',
  '    }',
  '    return imgs[0];',
  '  };',
  '  J.fillStep = function(){',
  '    J.closeResult();',
  '    var cs = [].slice.call(document.querySelectorAll("#group-chips .gchip[data-group]"));',
  '    var target = null;',
  '    for (var i = 0; i < cs.length; i++) {',
  '      if (!cs[i].classList.contains("is-full")) { target = cs[i]; break; }',
  '    }',
  '    if (!target) return { done: true, chips: J.chips() };',
  '    target.click();',
  '    var imgs = [].slice.call(document.querySelectorAll("#hand .card-wrap img"));',
  '    if (!imgs.length) return { done: false, stuck: true, hand: 0, chips: J.chips() };',
  '    var img = target.dataset.group === "tenhalf" ? J.pickTenHalf(imgs) : imgs[0];',
  '    img.click();',
  '    return { done: false, key: target.dataset.group, hand: J.handCount(), chips: J.chips() };',
  '  };',
  '  J.submitState = function(){',
  '    var b = document.getElementById("btn-submit");',
  '    if (!b) return { exists: false };',
  '    return { exists: true, disabled: !!b.disabled, text: (b.textContent || "").trim() };',
  '  };',
  '  J.clickSubmit = function(){',
  '    var b = document.getElementById("btn-submit");',
  '    if (!b || b.disabled) return false;',
  '    b.click(); return true;',
  '  };',
  '  J.confirmOpen = function(){',
  '    var c = document.getElementById("confirm-modal");',
  '    return !!(c && !c.classList.contains("hidden"));',
  '  };',
  '  J.clickConfirmOk = function(){',
  '    if (!J.confirmOpen()) return false;',
  '    document.getElementById("btn-confirm-ok").click(); return true;',
  '  };',
  '  J.sub = function(){',
  '    var e = document.querySelector(".gt-sub");',
  '    return e ? (e.textContent || "").trim() : "";',
  '  };',
  '  /* 结算屏的结构指纹：按钮 id 顺序 + 可见 + 尺寸。',
  '   * 比断言某个类名更狠 —— 连「按钮被 CSS 裁成 0 高」都能抓到。 */',
  '  J.settleSign = function(){',
  '    var ids = ["btn-next", "btn-share", "btn-replay", "btn-records", "btn-back-room"];',
  '    return {',
  '      onSettle: J.vis("screen-settle"),',
  '      title: ((document.querySelector("#screen-settle .ribbon-title") || {}).textContent || "").trim(),',
  '      body: ((document.getElementById("settle-body") || {}).textContent || "").trim().slice(0, 400),',
  '      wait: ((document.getElementById("settle-wait") || {}).textContent || "").trim(),',
  '      btns: ids.map(function(id){',
  '        var e = document.getElementById(id);',
  '        if (!e) return { id: id, exists: false };',
  '        var r = e.getBoundingClientRect();',
  '        return { id: id, exists: true, text: (e.textContent || "").trim(),',
  '                 w: Math.round(r.width), h: Math.round(r.height),',
  '                 top: Math.round(r.top), bottom: Math.round(r.bottom),',
  '                 inView: r.top >= 0 && r.bottom <= window.innerHeight + 1 && r.width > 0 && r.height > 0,',
  '                 disabled: !!e.disabled };',
  '      }),',
  '      vh: window.innerHeight',
  '    };',
  '  };',
  '})();'
].join('\n');
async function main() {
  if (!fs.existsSync(EDGE)) {
    console.log('[SKIP] 没找到 Edge：' + EDGE);
    process.exit(2);
  }
  fs.mkdirSync(OUT, { recursive: true });

  startServer();
  await waitServer();
  console.log('服务端 :' + SRV_PORT + '（档案在临时目录）');

  edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(TMP, 'edge-profile'),
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
  if (!page) { console.error('连不上 Edge CDP'); process.exit(1); }

  cdp = await cdpConnect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 2, mobile: true
  });

  /* 引导看过 + 关 SW（SW 接管会 reload，正好落在建房后房间就没了） */
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: '(function(){'
      + 'try{ localStorage.setItem("lxw_guide_seen_v1","1"); }catch(e){}'
      + 'try{ var f={register:function(){return Promise.reject(new Error("probe: sw off"));},'
      + 'addEventListener:function(){},removeEventListener:function(){},'
      + 'getRegistrations:function(){return Promise.resolve([]);},'
      + 'controller:null,ready:Promise.resolve({active:null})};'
      + 'Object.defineProperty(navigator,"serviceWorker",{get:function(){return f;},configurable:true}); }catch(e){}'
      + '})();'
  });

  const evaluate = async (expr) => {
    try {
      const r = await cdp.send('Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: true
      });
      if (r.exceptionDetails) return null;
      return r.result && r.result.value;
    } catch (e) { return null; }
  };

  async function waitFor(expr, timeoutMs, label) {
    const deadline = Date.now() + (timeoutMs || 8000);
    while (Date.now() < deadline) {
      const v = await evaluate(expr);
      if (v) return true;
      await sleep(120);
    }
    if (label) console.log('  ! 等待超时：' + label);
    return false;
  }

  async function shot(name) {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const p = path.join(OUT, name);
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    return p;
  }

  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + SRV_PORT + '/' });
  await waitFor('document.readyState === "complete"', 15000, '首屏');
  for (let i = 0; i < 40; i++) {
    const age = await evaluate('performance.now()');
    if (typeof age === 'number' && age > 1500) break;
    await sleep(250);
  }
  await evaluate(PAGE_HELPERS);

  /* 额外两个页面内工具：
   *   scoresNow —— 牌桌上所有人的分数（自己 .gt-score，对手 .opp-score）
   *   settleTxt —— 结算列表的分数列（判断有没有负分 / 「（见底）」） */
  await evaluate([
    '(function(){',
    '  var J = window.__hls = window.__hls || {};',
    '  J.scoresNow = function(){',
    '    return [].slice.call(document.querySelectorAll(".gt-score, .opp-score")).map(function(e){',
    '      var n = Number(String(e.textContent || "").replace(/[^0-9-]/g, ""));',
    '      return isNaN(n) ? null : n;',
    '    }).filter(function(v){ return v !== null; });',
    '  };',
    '  J.settleTxt = function(){',
    '    var body = document.getElementById("screen-settle");',
    '    var rows = [].slice.call(document.querySelectorAll("#screen-settle .settle-score"))',
    '      .map(function(e){ return (e.textContent || "").trim(); });',
    '    return { all: body ? (body.textContent || "") : "", rows: rows };',
    '  };',
    '  return true;',
    '})();'
  ].join('\n'));
  console.log('视口 ' + W + '×' + H + '  截图目录 ' + OUT);

  /* ------------------------- [1] 注册 ------------------------- */
  console.log('\n[1] 注册新账号');
  const stamp = String(Date.now()).slice(-8);
  const account = 'tenh' + stamp;
  const nickname = '十局' + stamp.slice(-2);
  await waitFor('!!document.getElementById("btn-auth-submit")', 10000, '登录表单');
  const reg = await evaluate([
    '(async function(){',
    '  function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }',
    '  var tab = document.querySelector("[data-auth-tab=register]");',
    '  if (tab) tab.click();',
    '  await sleep(200);',
    '  document.getElementById("auth-name").value = ' + JSON.stringify(account) + ';',
    '  document.getElementById("auth-pass").value = "probe123456";',
    '  var n = document.getElementById("auth-nick");',
    '  if (n) n.value = ' + JSON.stringify(nickname) + ';',
    '  return "ready";',
    '})()'
  ].join('\n'));
  ok(reg === 'ready', '切到注册并填好表单');
  await evaluate('document.getElementById("btn-auth-submit").click()');
  ok(await waitFor('__hls.vis("screen-home")', 15000, '注册后没进首页'), '注册成功 → 首页');

  /* ------------------------- [2] 建房：不选档位 → 默认 10 ------------------------- */
  console.log('\n[2] 建房：什么都不选，直接「开始建房」→ 看默认是不是 10');
  await evaluate('document.getElementById("btn-create").click()');
  await sleep(350);
  const defOn = await evaluate([
    '(function(){',
    '  var on = document.querySelector("#hand-limit-row .hand-limit-chip.is-on");',
    '  return on ? (on.textContent || "").replace(/\\s+/g, "") : null;',
    '})()'
  ].join('\n'));
  ok(!!defOn && defOn.indexOf(String(LIMIT)) === 0, '★ 弹窗默认选中 ' + LIMIT + '（一下都没点）', defOn);
  ok(await waitFor('__hls.vis("create-modal")', 3000, '建房弹窗没出来'), '建房先弹档位框');

  await evaluate('document.getElementById("btn-create-confirm").click()');
  const READY_DRAWN = '__hls.vis("table-ready") || __hls.vis("screen-room")';
  ok(await waitFor(READY_DRAWN, 10000, '建房后没进准备态'), '★ 确认后直接建房（默认档不用额外点）');

  const IN_TABLE = [
    '(function(){',
    '  var g = document.getElementById("screen-game");',
    '  return !!(g && !g.classList.contains("hidden")',
    '    && document.querySelectorAll("#slots .slot").length > 0',
    '    && document.querySelectorAll("#hand .card-wrap").length > 0);',
    '})()'
  ].join('\n');

  for (let i = 0; i < BOTS; i++) {
    await evaluate('document.getElementById("btn-add-bot").click()');
    await sleep(450);
  }
  await evaluate('document.getElementById("btn-ready").click()');
  ok(await waitFor(IN_TABLE, 15000, '全员准备后没开局'), '补 1 个 AI + 准备 → 开局');

  const sub1 = await evaluate('__hls.sub()');
  ok(/1\/10 把/.test(String(sub1 || '')), '★ 顶栏是「第 1/10 把」（默认档真的写进房间了）', sub1);

  /* ------------------------- [3] 打满 10 把，中途盯负分 ------------------------- */
  console.log('\n[3] 一路打：10 把，中途谁变负分都不许结束');

  let negAt = -1;          // 第一次看到负分时打到第几轮
  let roundsDone = 0;

  for (let r = 0; r < MAX_ROUNDS; r++) {
    if (await evaluate('__hls.vis("screen-settle")')) break;
    await evaluate('__hls.closeResult()');
    await sleep(150);
    if (await evaluate('__hls.vis("screen-settle")')) break;

    if (!await waitFor('__hls.chips().length >= 2', 12000, '组标签没出来')) break;
    for (let step = 0; step < 10; step++) {
      const snap = await evaluate('__hls.fillStep()');
      if (!snap || snap.done || snap.stuck) break;
      await sleep(60);
    }
    const state = await evaluate('({ hand: __hls.handCount(), chips: __hls.chips(), submit: __hls.submitState() })');
    if (!state || state.hand !== 0) { console.log('    第 ' + (r + 1) + ' 轮分牌没完成'); break; }
    if (state.submit && state.submit.disabled) { console.log('    第 ' + (r + 1) + ' 轮提交按钮禁用'); break; }
    if (!await evaluate('__hls.clickSubmit()')) { console.log('    第 ' + (r + 1) + ' 轮点不到提交'); break; }
    if (await waitFor('__hls.confirmOpen()', 4000, null)) {
      await evaluate('__hls.clickConfirmOk()');
    }
    await waitFor('__hls.resultOpen() || __hls.vis("screen-settle")', 15000, null);
    await evaluate('__hls.closeResult()');
    await sleep(250);
    roundsDone += 1;

    /* 每轮结算完读一次分数：负分一旦出现，立刻确认「人还在打牌」。
     * 只记第一次 —— 后面每轮都负分，重复断言没有信息量。 */
    const sc = await evaluate('__hls.scoresNow()');
    if (negAt < 0 && Array.isArray(sc) && sc.some((v) => v < 0)) {
      negAt = roundsDone;
      const onTable = await evaluate('__hls.vis("screen-game")');
      const onSettle = await evaluate('__hls.vis("screen-settle")');
      const subNow = await evaluate('__hls.sub()');
      console.log('    第 ' + roundsDone + ' 轮出现负分：' + JSON.stringify(sc) + '  顶栏「' + subNow + '」');
      ok(onTable || onSettle, '★ 出现负分的那一刻还在对局里（旧实现会被踢进结算屏）', 'onTable=' + onTable);
      if (onTable) {
        ok(/\/10 把/.test(String(subNow || '')), '★ 顶栏仍然报「第 N/10 把」（没有变成「已结束」）', subNow);
        console.log('    图：' + (await shot('negative-onscreen.png')));
      }
    }
  }

  ok(negAt > 0, '★ 这一局真的出现过负分（第 ' + negAt + ' 轮）—— 不然这条探针没验到靶心');
  ok(roundsDone >= 4, '真的打了很多轮（本轮实际 ' + roundsDone + ' 轮）');
  ok(await evaluate('__hls.vis("screen-settle")'), '★ 最终进入结算屏');

  /* ------------------------- [4] 结算页：打满 10 局 ------------------------- */
  console.log('\n[4] 结算页：说明必须是「打满 10 局」');
  await sleep(900);   // settle-row 错峰淡入
  const sign = await evaluate('__hls.settleSign()');
  const body = String((sign && sign.body) || '');
  const txt = await evaluate('__hls.settleTxt()');
  const all = String((txt && txt.all) || '');

  console.log('    结算说明尾部：「' + body.slice(-50) + '」');
  ok(/打满 10 局/.test(body), '★ 说明写着「打满 10 局，本局结束」', body.slice(-60));
  ok(!/分数输到底/.test(body), '★ 没有「有人分数输到底」那种旧结束原因');
  ok(!/见底/.test(all), '★ 结算列表里没有人被标「见底」（这个状态已经不存在）');
  ok(!/提前结束/.test(body), '打满不是「提前结束」，文案没有事故口气');

  const rows = (txt && txt.rows) || [];
  const negRows = rows.filter((s) => /-\d/.test(s));
  console.log('    结算分数列：' + JSON.stringify(rows));
  ok(rows.length === 2, '结算列表两个人都在（没有谁被踢出去）', JSON.stringify(rows));
  ok(negRows.length > 0, '★ 结算页正常显示负分（' + (negRows.join(' / ') || '无') + '）');

  const btns = (sign && sign.btns) || [];
  ok(btns.length >= 5, '结算按钮还是五颗', JSON.stringify(btns.map((b) => b.id)));
  ok(btns.every((b) => b.inView), '★ 按钮全在视口内', JSON.stringify(btns.filter((b) => !b.inView)));
  const nextBtn = btns.find((b) => b.id === 'btn-next');
  ok(!!nextBtn && /开始下一局/.test(nextBtn.text), '「开始下一局」还在（能接着打）', nextBtn && nextBtn.text);
  console.log('    图：' + (await shot('settle-ten-hands.png')));

  /* ------------------------- [5] 续局仍然是 10 ------------------------- */
  console.log('\n[5] 点「开始下一局」→ 档位必须还是 10');
  await evaluate('document.getElementById("btn-next").click()');
  ok(await waitFor(READY_DRAWN, 10000, '没回准备态'), '「开始下一局」可用');
  const subWait = await evaluate('__hls.sub()');
  ok(/已打 10\/10 把/.test(String(subWait || '')), '就位态顶栏写着「已打 10/10 把」', subWait);

  cdp.close();
  cleanup();
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  await sleep(100);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); cleanup(); process.exit(1); });
