/**
 * 「离开房间 / 弃局离开」确认框探针（一次性诊断脚本，不进测试套件）
 *
 * 用途：用真 Edge（headless + CDP）走一遍
 *   注册 → 建房（WAITING）→ 点「离开」→ 开局 → 点「离开」
 * 然后读确认框里真实渲染出来的标题与正文，回答两个问题：
 *   ① 等待中 vs 对局中，文案分开了吗？
 *   ② 对局中的文案到底有没有写出「第几轮 / 多少分」？
 *
 * 为什么必须真浏览器：这段文案是 onLeave 里按**服务端快照**拼的，
 * 还要经过 `#confirm-desc { white-space: pre-line }` 渲染（换行会不会丢）。
 * 静态读源码只能确认字符串拼对了，确认不了「玩家眼里看到什么」。
 *
 * 用法：node scripts/probe-leave.js [宽] [高]
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const W = Number(process.argv[2]) || 390;
const H = Number(process.argv[3]) || 844;
const PORT = 3022;
const SRV_PORT = 3023;
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

let serverProc = null;
function startApp() {
  serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(SRV_PORT),
      PROFILE_FILE: path.join(os.tmpdir(), 'lxw-lv-' + Date.now(), 'profiles.json'),
      SEED_FILE: path.join(os.tmpdir(), 'lxw-lv-seed-' + Date.now() + '.json')
    }),
    stdio: 'ignore'
  });
}

function waitApp() {
  return new Promise((resolve, reject) => {
    let tries = 0;
    (function tick() {
      tries += 1;
      http.get('http://127.0.0.1:' + SRV_PORT + '/api/health', (res) => {
        res.resume();
        resolve();
      }).on('error', () => {
        if (tries > 60) return reject(new Error('应用服务没起来'));
        setTimeout(tick, 200);
      });
    })();
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

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

async function main() {
  server.listen(PORT, '127.0.0.1');
  startApp();
  await waitApp();
  console.log('应用服务 127.0.0.1:' + SRV_PORT + '  视口 ' + W + '×' + H);

  const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const userDir = path.join(os.tmpdir(), 'lxw-lv-edge-' + Date.now());
  const edge = spawn(exe, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + userDir,
    '--window-size=' + W + ',' + H,
    '--force-device-scale-factor=1',
    '--autoplay-policy=no-user-gesture-required',
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
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + SRV_PORT + '/' });
  await sleep(1800);

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) return { error: String(r.exceptionDetails.text) };
    return r.result && r.result.value;
  };

  console.log('\n[1] 注册并建房');
  const reg = await evaluate(`(async function(){
    function click(sel){ var b=document.querySelector(sel); if(b){ b.click(); return true; } return false; }
    var tab = document.querySelector('[data-auth-tab="register"]');
    if (tab) tab.click();
    await new Promise(s=>setTimeout(s,250));
    var name = 'lvprobe' + Math.floor(Math.random()*100000);
    document.getElementById('auth-name').value = name;
    document.getElementById('auth-pass').value = 'probe123456';
    var nick = document.getElementById('auth-nick');
    if (nick && !nick.closest('.hidden')) nick.value = '探针';
    document.getElementById('btn-auth-submit').click();
    await new Promise(s=>setTimeout(s,1800));
    var homeVisible = !document.getElementById('screen-home').classList.contains('hidden');
    if (!homeVisible) return { account: name, homeVisible: false,
      err: (document.getElementById('auth-err')||{}).textContent || null };
    var n = document.getElementById('nickname-input');
    if (n) { n.value = '探针'; n.dispatchEvent(new Event('input',{bubbles:true})); }
    document.getElementById('btn-create').click();
    await new Promise(s=>setTimeout(s,900));
    return {
      account: name,
      /* v82 起准备态画在牌桌上，房间页在默认配置下是隐藏的。
       * 判「进到准备态了吗」要两个都认，只认 screen-room 会把正常流程判成失败。 */
      roomVisible: !document.getElementById('screen-room').classList.contains('hidden')
        || !document.getElementById('table-ready').classList.contains('hidden'),
      myId: (window.LXWState && window.LXWState.myId) || null
    };
  })()`);
  console.log(JSON.stringify(reg));
  ok(reg && reg.roomVisible === true, '建房成功，进入准备态');

  /* 读确认框：标题 + 正文（innerText 才有 pre-line 之后的真实换行） */
  const readDialog = `(function(){
    var m = document.getElementById('confirm-modal');
    var t = document.getElementById('confirm-title');
    var d = document.getElementById('confirm-desc');
    return {
      visible: !!(m && !m.classList.contains('hidden')),
      title: t ? t.textContent : null,
      text: d ? d.textContent : null,
      innerText: d ? d.innerText : null
    };
  })()`;

  console.log('\n[2] 等待中点「离开」→ 应该是「离开房间」');
  const waitLeave = await evaluate(`(async function(){
    document.getElementById('btn-leave').click();
    await new Promise(s=>setTimeout(s,1200));
    return ${readDialog};
  })()`);
  console.log(JSON.stringify(waitLeave));
  ok(waitLeave && waitLeave.visible === true, '确认框弹出来了');
  ok(waitLeave && waitLeave.title === '离开房间', '等待阶段标题是「离开房间」（不是弃局）',
    waitLeave && waitLeave.title);
  ok(waitLeave && /确定要离开当前房间吗/.test(waitLeave.text || ''), '正文是「确定要离开当前房间吗」');
  ok(waitLeave && !/弃局/.test(waitLeave.text || ''), '等待阶段正文不提弃局');

  console.log('\n[3] 关掉弹窗 → 准备 → 补 AI → 开局');
  const startFlow = await evaluate(`(async function(){
    document.getElementById('btn-confirm-cancel').click();
    await new Promise(s=>setTimeout(s,250));
    var r = {};
    /* 补 AI 在准备之前：全员准备即开局，顺序反了会在第一个 AI 进来时就开局 */
    r.bots = 0;
    for (var i = 0; i < 12; i++) {
      var b = document.getElementById('btn-add-bot');
      if (!b || b.classList.contains('hidden')) break;
      b.click(); r.bots += 1;
      await new Promise(s=>setTimeout(s,650));
    }
    /* 最后准备 → 自动开局（「开始游戏」按钮已删） */
    document.getElementById('btn-ready').click();
    await new Promise(s=>setTimeout(s,1200));
    r.gameVisible = !document.getElementById('screen-game').classList.contains('hidden');
    var ph = document.getElementById('phase-label');
    r.phase = ph ? ph.textContent : null;
    return r;
  })()`);
  console.log(JSON.stringify(startFlow));
  ok(startFlow && startFlow.gameVisible === true, '进入对局页');

  console.log('\n[4] ★ 对局中点「离开」→ 应该是「弃局离开？」+ 第几轮 + 分数');
  const midLeave = await evaluate(`(async function(){
    var btn = document.getElementById('btn-leave-game');
    btn.click();
    /* 忙碌态必须在 click() 返回的**同一拍**读：onLeave 是 async，
     * 同步段（含 pressBusy）在 click() 内就跑完了，之后才 await 网络。
     * 本机 RTT 只有几毫秒，等 100ms 再读早就还原了。 */
    var busyText = btn.textContent;
    var busyDisabled = btn.disabled;
    await new Promise(s=>setTimeout(s,1500));
    var d = ${readDialog};
    d.busyText = busyText;
    d.busyDisabled = busyDisabled;
    d.btnTextAfter = btn.textContent;
    return d;
  })()`);
  console.log(JSON.stringify(midLeave));
  ok(midLeave && midLeave.visible === true, '确认框弹出来了');
  ok(midLeave && midLeave.title === '弃局离开？', '★ 对局中标题是「弃局离开？」', midLeave && midLeave.title);
  ok(midLeave && /第 1 轮正在进行/.test(midLeave.text || ''), '★ 正文写出「第 1 轮正在进行」',
    midLeave && midLeave.text);
  ok(midLeave && /现在 \d+ 分/.test(midLeave.text || ''), '★ 正文写出当前分数', midLeave && midLeave.text);
  ok(midLeave && /算弃局/.test(midLeave.text || ''), '正文点明「算弃局」');
  ok(midLeave && /其他人这局也会就此结束/.test(midLeave.text || ''), '正文说明会连累其他人');
  ok(midLeave && !/没连上服务端核对/.test(midLeave.text || ''),
    '本地联调路径拿得到快照，不该出现「没连上服务端」提示');
  /* 忙碌态：点下去的一瞬间按钮应该变成「核对中…」且 disabled。
   * 这条不是洁癖——2.5 秒的无反馈正是「点了没用」的典型观感。 */
  ok(midLeave && midLeave.busyText === '核对中…', '★ 核对期间按钮显示「核对中…」',
    midLeave && midLeave.busyText);
  ok(midLeave && midLeave.busyDisabled === true, '核对期间按钮是 disabled（挡住连点）');
  /* 断言的原文案是「离开」，但按钮早就改成了「离开房间」（对局页两个出口并排之后加的区分）。
   * 这条要判的是「忙碌态之后文案回到原样」，具体回到哪个词跟着按钮自己的文案走。
   * 写死「离开」只会让它一直红着 —— 一条长期红的断言，最后没人会再看它。 */
  ok(midLeave && midLeave.btnTextAfter === '离开房间', '弹窗出来后按钮文案还原成「离开房间」',
    midLeave && midLeave.btnTextAfter);

  /* 换行：desc 里若有 \n，innerText 应该真的有换行（pre-line 生效） */
  const lines = (midLeave && midLeave.innerText || '').split('\n').filter((s) => s.trim()).length;
  ok(lines === 1, '没有多余的「没核对上」那行（本机联调拿得到快照）');

  console.log('\n[5] 取消离开 → 人还在对局里');
  const cancel = await evaluate(`(async function(){
    document.getElementById('btn-confirm-cancel').click();
    await new Promise(s=>setTimeout(s,400));
    var m = document.getElementById('confirm-modal');
    return {
      dialogGone: !!(m && m.classList.contains('hidden')),
      gameVisible: !document.getElementById('screen-game').classList.contains('hidden')
    };
  })()`);
  console.log(JSON.stringify(cancel));
  ok(cancel && cancel.dialogGone === true, '取消后弹窗关闭');
  ok(cancel && cancel.gameVisible === true, '★ 取消离开不会把人踢回首页');

  /* 收尾：真的离开，并把探针账号删掉，别在种子文件里留垃圾 */
  await evaluate(`(async function(){
    var t = localStorage.getItem('weile_session_v1') || '';
    var tok = '';
    try { tok = (JSON.parse(t) || {}).token || ''; } catch(e) {}
    await fetch('/api/auth/delete', {
      method:'POST',
      headers:{'Content-Type':'application/json','X-Session-Token':tok},
      body: JSON.stringify({ password:'probe123456' })
    }).catch(function(){});
    return true;
  })()`);

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  cdp.close();
  try { edge.kill(); } catch (e) {}
  try { serverProc.kill(); } catch (e) {}
  server.close();
  await sleep(200);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  try { serverProc && serverProc.kill(); } catch (x) {}
  process.exit(1);
});
