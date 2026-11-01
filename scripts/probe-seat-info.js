#!/usr/bin/env node
/**
 * 座位面板「信息档」尺寸探针
 *
 * 为什么单独写一个：要判断「信息档该不该内联整张战绩卡」，靠读代码定不了 ——
 * 必须知道内联之后面板会长到多少、在矮屏上会不会出屏。
 *
 * 量三样：
 *   1. 打开瞬间（「加载中…」）的面板高度 —— 定位就是**按这个高度**算的
 *   2. 内容填完之后的面板高度 —— 两者差多少，就是「定位算错」的量
 *   3. 面板矩形 vs 视口：顶/底有没有跑出去
 *
 * ★ 数据是**替身**：用 RoomStore.getProfile 的真实返回，但把 pid 换成一个
 *   种子档案里「有 27 场」的老玩家。这样量到的是真实 DOM、真实排版，
 *   唯一被替换的是「这是谁的档案」。布局探针只关心高度，不关心是谁。
 *   —— 别把它当集成测试读，它验的不是取数链路。
 *
 * 用法：
 *   node scripts/probe-seat-info.js            # 默认 390×844
 *   node scripts/probe-seat-info.js 360 640    # 矮屏才是关键档
 *   node scripts/probe-seat-info.js 728 348
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const W = Number(process.argv[2]) || 390;
const H = Number(process.argv[3]) || 844;
const SRV_PORT = 3061;      // 应用服务自己就带静态托管，不用另起一个静态服务
const CDP_PORT = 9371;
const ROOT = path.join(__dirname, '..', 'pwa');

/* 种子档案里场次最多的那位（27 场 / 14 胜 12 负 1 平 / 净胜 55 / 3 连败），
 * 用它保证「有战绩」这条分支被渲染出来 —— 新注册账号是 0 场，只会渲染空态。 */
const RICH_PID = 'pb99796cf5f4474f9';

const SEED_COPY = path.join(os.tmpdir(), 'lxw-seatinfo-' + Date.now() + '.json');
fs.copyFileSync(path.join(__dirname, '..', 'server', 'data', 'profiles.json'), SEED_COPY);

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
        return new Promise((res, rej) => {
          id += 1; waiting.set(id, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id, method: m, params: p || {} }));
        });
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

async function main() {
  const srvOut = [];
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(SRV_PORT),
      /* ★ 复制一份种子档案给临时实例用：既拿到「有战绩」的数据，
       * 又完全不动 server/data/profiles.json（那是灾备种子，不能被试跑污染）。 */
      PROFILE_FILE: SEED_COPY,
      SEED_FILE: path.join(os.tmpdir(), 'lxw-seatinfo-seed')
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  app.stdout.on('data', (d) => srvOut.push(String(d)));
  app.stderr.on('data', (d) => srvOut.push(String(d)));

  const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ['--headless=new', '--remote-debugging-port=' + CDP_PORT, '--no-first-run', '--disable-gpu', 'about:blank'],
    { stdio: 'ignore' });

  let page = null;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      const list = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
      page = (list || []).find((t) => t.type === 'page');
      if (page) break;
    } catch (e) { /* 还没起来 */ }
  }
  if (!page) { console.error('连不上 Edge CDP'); edge.kill(); app.kill(); process.exit(1); }

  const cdp = await cdpConnect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 2, mobile: true
  });

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __error: String(r.exceptionDetails.text) };
    return r.result && r.result.value;
  };
  const SHOT_DIR = path.join(__dirname, '..', 'tmp-shots', 'seat-info');
  const shot = async (name) => {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const p = path.join(SHOT_DIR, name + '-' + W + 'x' + H + '.png');
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    return p;
  };

  console.log('===== ' + W + '×' + H + ' 座位面板 · 信息档尺寸 =====');

  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + SRV_PORT + '/' });
  await sleep(1900);
  await evaluate('localStorage.setItem("lxw_guide_seen_v1","1")');
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + SRV_PORT + '/' });
  await sleep(1800);

  /* ---------- 注册 + 建房 ---------- */
  const setup = await evaluate(`(async function(){
    var sleep = function(ms){ return new Promise(function(s){ setTimeout(s, ms); }); };
    function el(id){ return document.getElementById(id); }
    var tab = document.querySelector('[data-auth-tab="register"]');
    if (tab) tab.click();
    await sleep(250);
    el('auth-name').value = 'seatinfo' + Math.floor(Math.random()*100000);
    el('auth-pass').value = 'probe123456';
    var nick = el('auth-nick');
    if (nick && !nick.closest('.hidden')) nick.value = '量尺';
    el('btn-auth-submit').click();
    await sleep(1800);
    if (el('screen-home').classList.contains('hidden')) {
      return { err: (el('auth-err')||{}).textContent || '注册失败' };
    }
    /* 昵称必须先填：建房读的就是这个输入框，空着会被拦下（而且不报错，只是没反应） */
    var ni = el('nickname-input');
    if (ni) { ni.value = '量尺'; ni.dispatchEvent(new Event('input', { bubbles: true })); }
    el('btn-create').click();
    await sleep(500);
    /* v99 起建房要走一道「本局打几局」弹窗，默认 10 局已经在，直接确认 */
    var go = el('btn-create-confirm');
    if (go && !el('create-modal').classList.contains('hidden')) { go.click(); }
    await sleep(1400);
    function vis(id){ var e = el(id); return !!e && !e.classList.contains('hidden'); }
    var top = document.getElementById('game-top');
    return {
      ok: true,
      inRoom: vis('screen-room') || vis('screen-game') || vis('table-ready') || !!top,
      which: ['screen-room S','screen-game S','table-ready S','#game-top S']
        .filter(function(x,i){ return [vis('screen-room'), vis('screen-game'), vis('table-ready'), !!top][i]; }),
      gtMe: !!document.querySelector('#game-top .gt-me')
    };
  })()`);
  if (!setup || setup.ok !== true) {
    console.error('前置失败：', JSON.stringify(setup), '\n', srvOut.join('').slice(0, 800));
    edge.kill(); app.kill(); process.exit(1);
  }
  ok(setup.inRoom === true, '注册 + 建房，进入准备态', JSON.stringify(setup));

  /* ---------- 补一个 AI + 准备 → 真正开局（顶栏座位只在开局后才有） ---------- */
  const started = await evaluate(`(async function(){
    var sleep = function(ms){ return new Promise(function(s){ setTimeout(s, ms); }); };
    var bot = document.getElementById('btn-add-bot');
    if (bot && !bot.classList.contains('hidden')) { bot.click(); await sleep(900); }
    var rdy = document.getElementById('btn-ready');
    if (rdy) { rdy.click(); await sleep(1400); }
    function vis(id){ var e = document.getElementById(id); return !!e && !e.classList.contains('hidden'); }
    return {
      gtMe: !!document.querySelector('#game-top .gt-me'),
      seats: document.querySelectorAll('#game-top .gt-opp').length,
      botBtnHidden: !!(bot && bot.classList.contains('hidden')),
      screens: [].slice.call(document.querySelectorAll('.screen'))
        .filter(function(x){ return !x.classList.contains('hidden'); }).map(function(x){ return x.id; }),
      readyTxt: rdy ? rdy.textContent : null,
      phase: (window.LXWState && window.LXWState.room && window.LXWState.room.phase) || null,
      players: (window.LXWState && window.LXWState.room && window.LXWState.room.players || []).length,
      bodyTop: (document.querySelector('#screen-game .gt-opps') ? 'has-gt-opps' : 'no-gt-opps')
    };
  })()`);
  ok(started && started.gtMe, '补 AI + 准备 → 开局，顶栏出现自己的座位', JSON.stringify(started));

  /* ---------- 取一份真实的有战绩档案，然后把它当成「任何人的」返回 ---------- */
  const prep = await evaluate(`(async function(){
    var r = await RoomStore.getProfile('${RICH_PID}');
    if (!r || r.ok === false || !r.profile) return { err: '拿不到种子档案', got: r };
    var real = r.profile;
    window.__origGetProfile = RoomStore.getProfile;
    /* ★ 故意慢 400ms：要量到「加载中」那一刻面板按多小的盒子定位，
     * 才能证明「内容填完有没有重新定位」。即时 resolve 的话两个状态叠在一起，
     * 这条证据就消失了 —— 而它正是这次改动最容易出错的地方。 */
    RoomStore.getProfile = function(){
      return new Promise(function(res){ setTimeout(function(){ res({ ok: true, profile: real }); }, 400); });
    };
    return { games: real.games, net: real.totalNet, recent: (real.recent || []).length };
  })()`);
  ok(prep && prep.games > 0, '替身档案就位（有战绩分支才会被渲染）', JSON.stringify(prep));
  if (!prep || !prep.games) { edge.kill(); app.kill(); process.exit(1); }

  /* ---------- 点自己 → 面板（自己只有信息档） ---------- */
  const m = await evaluate(`(async function(){
    var sleep = function(ms){ return new Promise(function(s){ setTimeout(s, ms); }); };
    var me = document.querySelector('#game-top .gt-me');
    if (!me) return { err: '顶栏没有自己的座位' };
    me.click();
    await sleep(60);
    var sheet = document.getElementById('seat-sheet');
    var info  = document.getElementById('ss-info');
    if (sheet.classList.contains('hidden')) return { err: '点自己没有打开面板' };
    var loadingH = sheet.offsetHeight;
    var loadingInfoH = info.offsetHeight;
    var lr = sheet.getBoundingClientRect();
    var loadingTop = Math.round(lr.top), loadingBottom = Math.round(lr.bottom);
    await sleep(1100);
    var r = sheet.getBoundingClientRect();
    var ir = info.getBoundingClientRect();
    return {
      loadingTop: loadingTop,
      loadingBottom: loadingBottom,
      loadingSheetH: loadingH,
      loadingInfoH: loadingInfoH,
      sheetH: sheet.offsetHeight,
      infoH: info.offsetHeight,
      infoScrollH: info.scrollHeight,
      infoClientH: info.clientHeight,
      rect: { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) },
      infoRect: { top: Math.round(ir.top), bottom: Math.round(ir.bottom) },
      vh: window.innerHeight, vw: window.innerWidth,
      /* 设计像素口径：面板和舞台都在 #stage 里，一起被 transform: scale() 缩放，
       * offsetTop / offsetHeight / stage.offsetHeight 三者的单位一致，可以直接比。
       * 混用 getBoundingClientRect（CSS 像素）和 offsetHeight（设计像素）是这类
       * 探针最常见的假阳性来源。 */
      design: {
        sheetTop: sheet.offsetTop,
        sheetH: sheet.offsetHeight,
        stageH: document.getElementById('stage').offsetHeight,
        stageW: document.getElementById('stage').offsetWidth
      },
      tabs: [].slice.call(sheet.querySelectorAll('#ss-tabs [data-ss-tab]')).map(function(b){ return b.textContent; }),
      tabsHidden: document.getElementById('ss-tabs').classList.contains('hidden'),
      hasMoreBtn: !!info.querySelector('[data-ss-full]'),
      blocks: {
        stats: !!info.querySelector('.pf-stats'),
        record: !!info.querySelector('.pf-record'),
        recent: !!info.querySelector('.pf-recent'),
        note: !!info.querySelector('.pf-note')
      }
    };
  })()`);

  if (!m || m.err) {
    console.error('测量失败：', JSON.stringify(m));
    edge.kill(); app.kill(); process.exit(1);
  }

  console.log('\n[面板]');
  console.log('  打开瞬间高度      ' + m.loadingSheetH + '（信息档 ' + m.loadingInfoH
    + '），落点 top ' + m.loadingTop + ' / bottom ' + m.loadingBottom);
  console.log('  内容填完高度      ' + m.sheetH + '（信息档 ' + m.infoH + '）');
  console.log('  高度变化          ' + (m.sheetH - m.loadingSheetH) + ' 设计px（加载中 → 填充）');
  console.log('  设计像素口径      top ' + m.design.sheetTop + ' + 高 ' + m.design.sheetH
    + ' = ' + (m.design.sheetTop + m.design.sheetH) + '，舞台高 ' + m.design.stageH);
  console.log('  面板矩形          top ' + m.rect.top + ' / bottom ' + m.rect.bottom + '（视口高 ' + m.vh + '）');
  console.log('  信息档            高 ' + m.infoH + '，scrollHeight ' + m.infoScrollH + ' / clientHeight ' + m.infoClientH);
  console.log('  分档              [' + m.tabs.join(', ') + ']  分档条隐藏=' + m.tabsHidden);
  console.log('  含「看完整战绩」   ' + m.hasMoreBtn);
  console.log('  区块              ' + JSON.stringify(m.blocks));

  console.log('  截图              ' + (await shot('self-info')));

  console.log('\n[判定]');
  ok(m.rect.top >= -1, '面板顶没跑出视口', 'top=' + m.rect.top);
  ok(m.rect.bottom <= m.vh + 1, '面板底没跑出视口', 'bottom=' + m.rect.bottom + ' vs ' + m.vh);
  ok(m.infoScrollH - m.infoClientH <= 1, '信息档内容没被裁（自身不溢出）',
    'scrollH=' + m.infoScrollH + ' clientH=' + m.infoClientH);
  /* 单档时不该出现「只有一个选项的切换条」——它看起来能点，点下去什么都不会变 */
  ok(m.tabs.length > 1 || m.tabsHidden, '只有一档时分档条隐藏', 'tabs=' + JSON.stringify(m.tabs));
  /* 整张卡该有的四块，一块都不能少（少了就等于又退回「摘要」） */
  ok(m.blocks.stats && m.blocks.record && m.blocks.recent && m.blocks.note,
    '信息档 = 整张战绩卡（四个区块齐全）', JSON.stringify(m.blocks));
  ok(!m.hasMoreBtn, '没有再嵌一层「看完整战绩」');
  /* ★ 守「异步填充后必须重排」。
   * 不能用「落点变了」当判据 —— 盒子变高，底边自己就会往下走，那是自证，恒真。
   * 真正有判别力的是**夹取不变量**：placeSeatSheet 把 top 夹在 [pad, 舞台高 − 面板高 − pad]。
   * 内容变高后如果不重排，top 还是按「加载中」那个矮盒子算的，于是
   * top + 高 会超过 舞台高 − pad —— 在矮屏上就是实打实的出屏。 */
  var PAD = 16;
  ok(m.sheetH > m.loadingSheetH,
    '前置：填充把面板撑高了（否则下面那条验不出东西）',
    'loading=' + m.loadingSheetH + ' final=' + m.sheetH);
  ok(m.design.sheetTop >= PAD - 0.5 && m.design.sheetTop + m.design.sheetH <= m.design.stageH - PAD + 0.5,
    '★ 面板完整落在舞台内并留出 ' + PAD + 'px 边距（说明填充后重排过）',
    'top=' + m.design.sheetTop + ' 底=' + (m.design.sheetTop + m.design.sheetH)
    + ' 上限=' + (m.design.stageH - PAD));

  console.log('\n结论：' + (fail === 0 ? '尺寸可容纳' : '有 ' + fail + ' 项不可容纳'));
  console.log('（通过 ' + pass + ' 项，失败 ' + fail + ' 项）');

  edge.kill();
  app.kill();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
