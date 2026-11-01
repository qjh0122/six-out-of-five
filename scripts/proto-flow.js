/**
 * 流程验收（真浏览器点真按钮，不 mock）
 *
 * 只验「阶段」这一层，因为准备态是纯 UI 改造：底层的场景机 / 结算 / 退出都沿用原样，
 * 要证明的是「按钮点下去之后，S.phase 与 S.idx 走到了该去的地方」。
 *
 * 用法：node scripts/proto-flow.js
 */
'use strict';

const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const CDP_PORT = 9455;
const PAGE = 'file:///' + path.join(__dirname, '..', 'docs', 'prototypes', 'circle-table.html').replace(/\\/g, '/');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
        return new Promise((res, rej) => {
          id += 1; waiting.set(id, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id, method: m, params: p || {} }));
        });
      },
      close() { try { ws.close(); } catch (e) {} }
    }));
  });
}

async function evaluate(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description)
      || JSON.stringify(r.exceptionDetails).slice(0, 500));
  }
  return r.result.value;
}

const CLICK = (sel) => `(function(){
  var e = document.querySelector(${JSON.stringify(sel)});
  if (!e) throw new Error('missing ' + ${JSON.stringify(sel)});
  e.click(); return true;
})()`;

const STATE = `(function(){
  var S = window.__proto.S;
  return { phase:S.phase, idx:S.idx, rdy:S.rdy, others:Object.keys(S.rdyOthers||{}).length,
    cd:S.countdown, ask:S.ask, last:S.lastDelta,
    kind:(window.__proto.scenes()[S.idx]||{}).kind };
})()`;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  → ' + JSON.stringify(detail) : '')); }
}

async function main() {
  const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const edge = spawn(exe, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(os.tmpdir(), 'lxw-flow-' + Date.now()),
    '--window-size=1500,1000', '--force-device-scale-factor=1', '--allow-file-access-from-files',
    'about:blank'
  ], { stdio: 'ignore' });

  let page = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
      page = (list || []).find((t) => t.type === 'page');
      if (page) break;
    } catch (e) {}
  }
  if (!page) { console.error('连不上 Edge'); edge.kill(); process.exit(1); }

  const cdp = await cdpConnect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: PAGE });
  await sleep(1200);

  console.log('\n[1] 打开即准备态（房间）');
  let s = await evaluate(cdp, STATE);
  check('初始 phase=ready', s.phase === 'ready', s);
  check('初始 0 人准备', s.rdy === false && s.others === 0, s);

  console.log('\n[2] 点「准备」→ 其他人陆续就绪 → 3s 倒计时 → 自动发牌');
  await evaluate(cdp, CLICK('[data-actry]'));
  await sleep(120);
  s = await evaluate(cdp, STATE);
  check('自己已准备', s.rdy === true, s);
  /* 4 个对手按 650 + i*700 陆续就绪（最后一个 2.75s），之后才开始 3s 倒计时 */
  await sleep(3400);
  s = await evaluate(cdp, STATE);
  check('全员就绪后进入倒计时', s.phase === 'ready' && s.cd >= 1, s);
  await sleep(3000);
  s = await evaluate(cdp, STATE);
  check('倒计时走完自动进入对局', s.phase === 'play', s);
  check('停在第 1 幕（分牌）', s.idx === 0 && s.kind === 'divide', s);
  check('倒计时已归零', s.cd === 0 && s.ask === null, s);

  console.log('\n[2b] 倒计时中可以直接点「开始游戏」提前开局');
  await evaluate(cdp, `window.__proto.ready(null,null)`);
  await evaluate(cdp, CLICK('[data-actry]'));
  await sleep(3400);
  s = await evaluate(cdp, STATE);
  check('已在倒计时', s.phase === 'ready' && s.cd >= 1, s);
  await evaluate(cdp, CLICK('[data-actry]'));
  await sleep(200);
  s = await evaluate(cdp, STATE);
  check('提前开始生效', s.phase === 'play', s);

  console.log('\n[3] 局终 →「再来一局」→ 回准备态并记下上局净得');
  await evaluate(cdp, `window.__proto.goto(window.__proto.scenes().length - 1)`);
  await sleep(150);
  s = await evaluate(cdp, STATE);
  check('停在局终', s.kind === 'final', s);
  await evaluate(cdp, CLICK('[data-again]'));
  await sleep(150);
  s = await evaluate(cdp, STATE);
  check('回到准备态', s.phase === 'ready', s);
  check('上局净得已记录', typeof s.last === 'number', s);
  check('准备状态已重置', s.rdy === false && s.others === 0, s);

  console.log('\n[4] 准备态「退出房间」：先弹确认，取消不生效，确认才走');
  await evaluate(cdp, CLICK('[data-leave]'));
  await sleep(120);
  s = await evaluate(cdp, STATE);
  check('弹出确认', s.ask === 'leave', s);
  await evaluate(cdp, CLICK('[data-askno]'));
  await sleep(120);
  s = await evaluate(cdp, STATE);
  check('取消后关掉确认、仍在准备态', s.ask === null && s.phase === 'ready', s);
  await evaluate(cdp, CLICK('[data-leave]'));
  await sleep(100);
  await evaluate(cdp, CLICK('[data-askyes]'));
  await sleep(150);
  s = await evaluate(cdp, STATE);
  check('确认后回到准备态', s.phase === 'ready' && s.ask === null, s);

  console.log('\n[5] 对局中「退出」：确认后本局作废、回准备态');
  await evaluate(cdp, `window.__proto.goto(2)`);
  await sleep(120);
  await evaluate(cdp, CLICK('[data-leave]'));
  await sleep(120);
  s = await evaluate(cdp, STATE);
  check('对局中也能弹确认', s.ask === 'leave', s);
  await evaluate(cdp, CLICK('[data-askyes]'));
  await sleep(150);
  s = await evaluate(cdp, STATE);
  check('退出后回准备态', s.phase === 'ready', s);
  check('退出时记下本局净得', typeof s.last === 'number', s);

  console.log('\n[6] 侧栏「播放整局」仍然是对局态；再回准备界面不串味');
  await evaluate(cdp, `document.getElementById('btn-play').click()`);
  await sleep(300);
  s = await evaluate(cdp, STATE);
  check('播放后 phase=play', s.phase === 'play', s);
  await evaluate(cdp, `document.getElementById('btn-play').click()`);
  await evaluate(cdp, `document.getElementById('btn-ready').click()`);
  await sleep(200);
  s = await evaluate(cdp, STATE);
  check('回到准备态', s.phase === 'ready', s);

  console.log('\n[7] 人数 2~5：每个档位准备态都放得下');
  for (const n of ['2', '3', '4', '5']) {
    await evaluate(cdp, `document.querySelector('#seg-n [data-v="${n}"]').click()`);
    await sleep(120);
    const info = await evaluate(cdp, `(function(){
      var d = document.getElementById('design'), r = d.getBoundingClientRect();
      var S = window.__proto.S, k = r.width / 750;
      var bad = [];
      [].forEach.call(d.querySelectorAll('.seat,.room,.rminfo,.acts'), function(el){
        var b = el.getBoundingClientRect();
        if (b.width < 1) return;
        if (b.left < r.left - 1 || b.right > r.right + 1 || b.top < r.top - 1 || b.bottom > r.bottom + 1) {
          bad.push((el.className||'').split(' ')[0]);
        }
      });
      var seatN = d.querySelectorAll('.seat').length;
      return { n:S.n, seatN:seatN, bad:bad };
    })()`);
    check(n + ' 人：座位数=' + info.seatN + '、无越界', info.seatN === Number(n) && info.bad.length === 0, info);
  }

  await evaluate(cdp, `document.querySelector('#seg-n [data-v="5"]').click()`);
  await sleep(800);

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败\n');
  cdp.close();
  edge.kill();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
