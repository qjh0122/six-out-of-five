/**
 * 战绩页回放入口探针（一次性诊断脚本，不进测试套件）
 *
 * 验的是「退房之后还能看刚才那把」这条链路的**视觉与可点性**：
 *   1) 有回放的记录上出现「看过程」，没有的不出现（不能留一个点不开的按钮）；
 *   2) 点击能打开回放弹窗，标题带日期而不是写死的「本局过程」；
 *   3) 回放内容渲染完整（组、赢家、每人手牌、加减分），且没有横向溢出。
 *
 * 为什么要真浏览器：这几处是 grid 两行布局 + 内联按钮，静态读代码看不出
 * 「按钮被挤掉」「第二行被 ellipsis 吃掉」这类问题。
 *
 * 用法：node scripts/probe-records.js [宽] [高] [输出目录]
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const W = Number(process.argv[2]) || 390;
const H = Number(process.argv[3]) || 844;
const OUT = process.argv[4] || path.join(os.tmpdir(), 'lxw-rec-' + Date.now());
const STATIC_PORT = 3041;
const CDP_PORT = 9351;
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

/* 造两份数据：
 *   记录 1 —— 带 sessionKey + handId，指向下面那份「整场」档案（3 把）；
 *   记录 2 —— 老格式，没有 replay、没有 sessionKey（模拟被 REPLAY_KEEP 剥掉的那种）。
 *
 * 为什么要造整场而不是一把：这次要验的正是「点进去看到的是整场，不是最后一把」。
 * 只造一把的话，旧实现和新实现看起来一模一样，探针就成了摆设。 */
function row(id, name, cards, d) { return { i: id, n: name, c: cards, d: d }; }
function grp(label, winner, type, rows) { return { l: label, w: winner, t: type, rows: rows }; }

function buildSeed(myId) {
  const me = myId || 'probe-me';
  const meRow = (cards, d) => row(me, '我', cards, d);

  /* 一把 = 2 轮（第 1 轮 3 组、第 2 轮 2 组），和真实配置一致 */
  const hand = (no, big) => ({
    hands: no,
    rounds: [
      { r: 1, groups: [
        grp('单张比大小', '玩家E', '', big
          ? [row('p-玩家E', '玩家E', ['A♠'], 2), meRow(['K♣'], -1), row('p-sam', 'sam', ['3♦'], -1)]
          : [row('p-玩家E', '玩家E', ['A♠'], 2), meRow(['K♣'], -1)]),
        grp('十点半', 'sam', '10.5', [row('p-sam', 'sam', ['10♥', 'K♣'], 4), meRow(['7♥', '2♠'], -2)]),
        grp('飘三叶', '我', '豹子', [meRow(['9♠', '9♥', '9♣'], 6), row('p-sam', 'sam', ['A♠', 'A♥', '5♦'], -6)])
      ] },
      { r: 2, groups: [
        grp('单张比大小', '我', '', [meRow(['大王'], 2), row('p-玩家E', '玩家E', ['4♠'], -2)]),
        grp('斗牛', 'sam', '牛牛', [row('p-sam', 'sam', ['10♠', 'J♥', 'Q♣', 'K♦', 'A♠'], 9), meRow(['2♠', '5♥', '8♣', '9♦', '大王'], -9)])
      ] }
    ]
  });

  const sessionKey = 'R0#1700000000000';
  const sessions = [{
    key: sessionKey,
    roomId: 'R0',
    startedAt: 1700000000000,
    updatedAt: Date.now(),
    packs: [hand(1, true), hand(2, false), hand(3, true)]
  }];

  const now = Date.now();
  const records = [
    {
      id: 'R0-1', roomId: 'R0', endedAt: now, playerCount: 3,
      myStartScore: 20, myEndScore: 15, myNet: -5, endReason: 'scoreZero',
      rounds: 3, handId: 3, sessionKey: sessionKey,
      /* 单把副本也留着：它现在是「场次档案丢了」时的兜底 */
      replay: hand(3, true)
    },
    {
      id: 'R1-2', roomId: 'R1', endedAt: now - 3600 * 1000, playerCount: 4,
      myStartScore: 20, myEndScore: 26, myNet: 6, endReason: 'dissolve',
      rounds: 2
    }
  ];
  return { records, sessions };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  await new Promise((r) => server.listen(STATIC_PORT, '127.0.0.1', r));

  const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const userDir = path.join(os.tmpdir(), 'lxw-rec-edge-' + Date.now());
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

  /* 先跑一次本地演示模式：只有它会给「我」生成一个 id（会话级），
   * 回放里的「我」是按 id 认的，没有 id 就验不了高亮。 */
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + STATIC_PORT + '/?mode=local' });
  await sleep(1800);
  const myId = await evaluate(`Store.read(Store.KEYS.MY_ID, null, 'session') || ''`);

  const seed = buildSeed(myId);
  await evaluate(`localStorage.setItem('lxw_records_v1', ${JSON.stringify(JSON.stringify(seed.records))});
                  localStorage.setItem('lxw_sessions_v1', ${JSON.stringify(JSON.stringify(seed.sessions))});
                  localStorage.setItem('lxw_guide_seen_v1','1');
                  localStorage.setItem('lxw_records_deduped_v2','1');
                  'ok'`);
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + STATIC_PORT + '/?mode=local' });
  await sleep(1800);

  console.log('视口 ' + W + '×' + H + '  截图目录 ' + OUT);

  console.log('\n[1] 打开「我的战绩」');
  await evaluate(`document.getElementById('btn-records-home').click()`);
  await sleep(700);
  const listInfo = await evaluate(`(function(){
    var rows = document.querySelectorAll('#records-list .rp-row');
    var btns = document.querySelectorAll('#records-list .rp-replay');
    var r0 = rows[0] ? rows[0].getBoundingClientRect() : null;
    var b0 = btns[0] ? btns[0].getBoundingClientRect() : null;
    var sub0 = rows[0] ? rows[0].querySelector('.rp-sub') : null;
    return {
      rows: rows.length,
      replayBtns: btns.length,
      rowW: r0 ? Math.round(r0.width) : 0,
      btnW: b0 ? Math.round(b0.width) : 0,
      btnH: b0 ? Math.round(b0.height) : 0,
      btnInsideRow: !!(r0 && b0 && b0.left >= r0.left - 1 && b0.right <= r0.right + 1),
      subClipped: sub0 ? (sub0.scrollWidth > sub0.clientWidth + 1) : null,
      btnText: btns[0] ? btns[0].textContent : null
    };
  })()`);
  console.log('    ' + JSON.stringify(listInfo));
  const shotList = await shot('records-list.png');
  console.log('    图：' + shotList);

  ok(listInfo && listInfo.rows === 2, '两条记录都渲染出来了', listInfo && listInfo.rows);
  ok(listInfo && listInfo.replayBtns === 1, '★ 只有带回放的那条有「看回放」', listInfo && listInfo.replayBtns);
  ok(listInfo && /看回放/.test(listInfo.btnText || ''), '按钮文案是「看回放」', listInfo && listInfo.btnText);
  ok(listInfo && listInfo.btnInsideRow, '按钮没有溢出记录行');
  ok(listInfo && listInfo.btnH >= 28, '按钮热区不低于 28 屏幕px', listInfo && listInfo.btnH);
  ok(listInfo && listInfo.subClipped === false, '结束原因没被 ellipsis 吃掉');

  console.log('\n[2] 点「看回放」：要看到整场，不是最后一把');
  await evaluate(`document.querySelector('#records-list .rp-replay').click()`);
  await sleep(600);
  const replayInfo = await evaluate(`(function(){
    var m = document.getElementById('replay-modal');
    var t = document.getElementById('replay-title');
    var sub = document.getElementById('replay-sub');
    var body = document.getElementById('replay-body');
    var packs = body.querySelectorAll('.replay-pack');
    var target = body.querySelector('.replay-pack.is-target');
    var meRows = body.querySelectorAll('.replay-row.is-me');
    var overflowX = 0;
    body.querySelectorAll('.replay-row').forEach(function(el){
      if (el.scrollWidth > el.clientWidth + 1) overflowX++;
    });
    var br = body.getBoundingClientRect();
    return {
      open: !m.classList.contains('hidden'),
      title: t ? t.textContent : null,
      sub: sub ? sub.textContent : null,
      subHidden: sub ? sub.classList.contains('hidden') : null,
      packs: packs.length,
      targets: body.querySelectorAll('.replay-pack.is-target').length,
      targetHand: target ? target.getAttribute('data-hand') : null,
      hands: Array.prototype.map.call(packs, function(x){ return x.getAttribute('data-hand'); }).join(','),
      groups: body.querySelectorAll('.replay-group').length,
      rows: body.querySelectorAll('.replay-row').length,
      meRows: meRows.length,
      youPills: body.querySelectorAll('.replay-you').length,
      up: body.querySelectorAll('.replay-delta.up').length,
      down: body.querySelectorAll('.replay-delta.down').length,
      overflowX: overflowX,
      empty: !!body.querySelector('.replay-empty'),
      bodyH: Math.round(br.height),
      scrollTop: Math.round(body.scrollTop),
      scrollable: body.scrollHeight > body.clientHeight + 1
    };
  })()`);
  console.log('    ' + JSON.stringify(replayInfo));
  const shotReplay = await shot('records-replay.png');
  console.log('    图：' + shotReplay);

  ok(replayInfo && replayInfo.open === true, '回放弹窗打开了');
  ok(replayInfo && /这一局/.test(replayInfo.title || ''), '标题写「这一局」（而不是只有一把的「那局」）', replayInfo && replayInfo.title);
  ok(replayInfo && replayInfo.sub === '整场 3 把', '副标题写清楚整场几把', replayInfo && replayInfo.sub);
  ok(replayInfo && replayInfo.packs === 3, '★ 整场 3 把都渲染了（以前只有最后一把）', replayInfo && replayInfo.packs);
  ok(replayInfo && replayInfo.hands === '1,2,3', '★ 把次从 1 到 3 连续，没有重号也没有跳号', replayInfo && replayInfo.hands);
  ok(replayInfo && replayInfo.targets === 1 && replayInfo.targetHand === '3', '★ 你点的那一把被标了出来', replayInfo && (replayInfo.targetHand + '/' + replayInfo.targets));
  ok(replayInfo && replayInfo.groups === 15, '三把共 15 组都在', replayInfo && replayInfo.groups);
  ok(replayInfo && replayInfo.rows === 32, '32 行玩家明细', replayInfo && replayInfo.rows);
  ok(replayInfo && replayInfo.meRows === 15 && replayInfo.youPills === 15, '★ 每一组里「我」那一行都被标了出来', replayInfo && (replayInfo.meRows + '/' + replayInfo.youPills));
  ok(replayInfo && replayInfo.up > 0 && replayInfo.down > 0, '红涨绿跌都出现了');
  ok(replayInfo && replayInfo.overflowX === 0, '没有横向溢出（手牌多也不挤破行）');
  ok(replayInfo && replayInfo.empty === false, '不是空态');
  ok(replayInfo && replayInfo.scrollTop > 0, '★ 打开就定位到你点的那把（不是永远停在第一把）', replayInfo && replayInfo.scrollTop);

  console.log('\n[3] 关闭');
  await evaluate(`document.getElementById('btn-replay-close').click()`);
  await sleep(400);
  const closed = await evaluate(`document.getElementById('replay-modal').classList.contains('hidden')`);
  ok(closed === true, '能关掉');

  await cdp.send('Page.close').catch(() => {});
  cdp.close();
  try { edge.kill(); } catch (e) {}
  server.close();

  console.log('\n' + '='.repeat(48));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
