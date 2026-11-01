/**
 * 临时探针：「上一局结算」胶囊 + 只读弹窗的真实布局量测
 * 用法：node scripts/probe-prev-result.js
 *
 * 为什么不走完整对局：这一轮要验的是**布局**（两颗胶囊挤不挤、弹窗内容溢不溢出），
 * 不是玩法逻辑 —— 逻辑由 pwa/test/prev-result.test.js 的 47 项静态断言守着。
 * 所以这里直接注入和 settleListEl 产出完全一致的结构，然后量真实盒模型。
 *
 * 量测项（都是「看起来对不对」看不出来的东西）：
 *   · 两颗胶囊是否在同一行、有没有被裁掉、加起来有没有超出 750 设计宽
 *   · 弹窗标题栏和内容区是否各自撑满、内容超高时是不是内容区在滚（而不是整卡溢出）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SRV_PORT = 3973;
const CDP_PORT = 9379;
/* 竖屏 / 横屏都能跑：node scripts/probe-prev-result.js 844x390
 * 这个弹窗在横屏是另一套排版（左栏汇总 + 右栏列表那套由 #stage 的 .wide 控制），
 * 但结算行本身还是同一份，颜色必须两边都能读。 */
const SIZE = (process.argv[2] || '').match(/^(\d+)x(\d+)$/);
const W = SIZE ? Number(SIZE[1]) : 390;
const H = SIZE ? Number(SIZE[2]) : 844;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SERVER_ENTRY = path.join(__dirname, '..', 'server', 'index.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxw-probe-'));
const SHOT_DIR = path.join(os.tmpdir(), SIZE ? 'lxw-shots-' + W + 'x' + H : 'lxw-shots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let edge = null, serverProc = null, serverLog = '', cdp = null;

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
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
        if (msg.error) w.reject(new Error(JSON.stringify(msg.error)));
        else w.resolve(msg.result);
      }
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => resolve({
      send(method, params) {
        return new Promise((res, rej) => {
          id += 1; waiting.set(id, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id, method, params: params || {} }));
        });
      },
      close() { try { ws.close(); } catch (e) {} }
    }));
  });
}

async function evaluate(expr) {
  try {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) {
      throw new Error(String(r.exceptionDetails.exception && r.exceptionDetails.exception.description
        || r.exceptionDetails.text));
    }
    return r.result && r.result.value;
  } catch (e) { throw new Error('页面求值失败: ' + e.message); }
}

async function shot(name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const f = path.join(SHOT_DIR, name + '.png');
  fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
  return f;
}

function startServer() {
  serverProc = spawn(process.execPath, [SERVER_ENTRY], {
    env: Object.assign({}, process.env, {
      PORT: String(SRV_PORT), HOST: '127.0.0.1',
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
    let tries = 0;
    (function tick() {
      tries += 1;
      http.get('http://127.0.0.1:' + SRV_PORT + '/api/health', (res) => { res.resume(); resolve(); })
        .on('error', () => {
          if (tries > 80) return reject(new Error('服务端没起来\n' + serverLog));
          setTimeout(tick, 250);
        });
    })();
  });
}

async function attachPage() {
  let page = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const list = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
      page = (list || []).find((t) => t.type === 'page');
      if (page) break;
    } catch (e) { /* 还没起来 */ }
  }
  if (!page) throw new Error('连不上 Edge CDP（端口被占用？）');
  cdp = await cdpConnect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 2, mobile: true
  });
}

/* 注入的就位态场景：房间页 + 4 个座位 + 两颗胶囊 */
const SCENE = `(function(){
  /* 首次访问会自动弹新手引导（guide-modal 在 MODAL_ORDER 里比 prev-result 更上层，
   * 不关掉的话截图和量测都被它盖住）。这里直接收掉，模拟「老玩家」状态。 */
  var guide = document.getElementById('guide-modal');
  if (guide) guide.classList.add('hidden');
  document.getElementById('stage').classList.remove('modal-open');

  ['screen-home','screen-game','screen-settle','screen-records','screen-rank','screen-auth']
    .forEach(function(id){ var e = document.getElementById(id); if (e) e.classList.add('hidden'); });
  var room = document.getElementById('screen-room');
  room.classList.remove('hidden');

  var grid = document.getElementById('room-players');
  grid.innerHTML = ['小王','老李','阿May','我'].map(function(n, i){
    return '<div class="player-row' + (i === 3 ? ' me' : '') + '" data-pid="p' + i + '">'
      + '<div class="pr-avatar" style="background:#c8a45c">' + n.charAt(0) + '</div>'
      + '<div class="pr-name">' + n + (i === 3 ? '<i class="pr-you">我</i>' : '') + '</div>'
      + '<div class="pr-score">—</div></div>';
  }).join('');
  document.getElementById('room-hint').textContent = '已经有 3 人进入下一局';
  document.querySelectorAll('#btn-prev-replay, #btn-prev-result')
    .forEach(function(b){ b.classList.remove('hidden'); });
  /* 就位态的真实形态（见 renderRoom）：结束本局藏起来，回结算页露出来。
   * 不照这个摆的话，截图里会多出一个真实界面上不存在的按钮。 */
  document.getElementById('btn-dissolve').classList.add('hidden');
  document.getElementById('btn-next-back').classList.remove('hidden');
  return 'ok';
})()`;

/* 弹窗内容：和 settleListEl 的产出逐字一致 */
const MODAL = `(function(){
  var players = [
    { n: '小王', s: 24, left: false },
    { n: '老李', s: 20, left: false },
    { n: '阿May', s: 19, left: true },
    { n: '我',  s: 17, left: false }
  ];
  var html = '<div class="settle-inner"><div class="settle-list">';
  players.forEach(function(p, i){
    var net = p.s - 20;
    var me = p.n === '我';
    html += '<div class="settle-row' + (i === 0 ? ' champion' : '') + (me ? ' me' : '') + '" data-pid="p' + i + '"'
      + ' style="animation-delay:' + ((i === 0 ? 0 : 200) + i * 150) + 'ms">'
      + (i === 0
          ? '<div class="settle-rank champion-rank" style="background:#c8a45c">小<span class="crown">🏆</span></div>'
          : '<div class="settle-rank">' + (i + 1) + '</div>')
      + '<div class="settle-name">' + p.n + (p.left ? '（弃局）' : '')
      +   (me ? '<i class="settle-you">我</i>' : '') + '</div>'
      + '<div class="settle-score">' + p.s + ' 分</div>'
      + '<div class="settle-net ' + (net > 0 ? 'up' : net < 0 ? 'down' : 'flat') + '">'
      +   (net > 0 ? '+' + net : String(net)) + '</div>'
      + '</div>';
  });
  html += '</div><p class="settle-tip">本局提前结束，按当前分数结账。</p></div>';
  document.getElementById('prev-result-body').innerHTML = html;
  document.getElementById('prev-result-modal').classList.remove('hidden');
  document.getElementById('stage').classList.add('modal-open');
  return 'ok';
})()`;

const MEASURE_CAPS = `(function(){
  var row = document.querySelector('.room-prev-row');
  var caps = [].slice.call(document.querySelectorAll('.room-prev'));
  var stage = document.getElementById('stage');
  var sr = stage.getBoundingClientRect();
  return {
    stageW: Math.round(sr.width),
    rowW: Math.round(row.getBoundingClientRect().width),
    rowOverflow: row.scrollWidth - row.clientWidth,
    caps: caps.map(function(b){
      var r = b.getBoundingClientRect();
      return { text: b.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height),
               x: Math.round(r.left), right: Math.round(r.right),
               clipped: b.scrollWidth > b.clientWidth + 1,
               oneLine: b.getBoundingClientRect().height < 80 };
    }),
    sameRow: Math.abs(caps[0].getBoundingClientRect().top - caps[1].getBoundingClientRect().top) < 2,
    gapPx: Math.round(caps[1].getBoundingClientRect().left - caps[0].getBoundingClientRect().right),
    beyondStage: caps.some(function(b){ return b.getBoundingClientRect().right > sr.right + 1; })
  };
})()`;

const MEASURE_MODAL = `(function(){
  var card = document.querySelector('#prev-result-modal .modal-card');
  var body = document.getElementById('prev-result-body');
  var cr = card.getBoundingClientRect();
  var stage = document.getElementById('stage').getBoundingClientRect();
  return {
    cardW: Math.round(cr.width), cardH: Math.round(cr.height),
    cardBottomOverflow: Math.round(cr.bottom - stage.bottom),
    bodyOverflowY: body.scrollHeight - body.clientHeight,
    bodyScrollable: getComputedStyle(body).overflowY,
    cardsFit: cr.top >= stage.top - 1 && cr.bottom <= stage.bottom + 1,
    rows: document.querySelectorAll('#prev-result-body .settle-row').length,
    hasTip: !!document.querySelector('#prev-result-body .settle-tip'),
    championStyled: (function(){
      var c = document.querySelector('#prev-result-body .settle-row.champion');
      if (!c) return 'no-champion';
      var n = c.querySelector('.settle-net');
      var nm = c.querySelector('.settle-name');
      return getComputedStyle(n).fontSize + ' / ' + getComputedStyle(n).color
        + ' ｜ name.color=' + getComputedStyle(nm).color
        + ' ｜ row.bg=' + getComputedStyle(c).backgroundImage.slice(0, 60);
    })(),
    meBadge: !!document.querySelector('#prev-result-body .settle-you'),
    /* ★ 对比度：这一项是补上的盲区。
     * 这个弹窗的字以前是「暖白 on 浅灰」，实拍整屏糊成一片，而当时所有断言
     * （行数、不溢出、名字没被截断）全部通过 —— 布局对、颜色错，量不出来。
     * 所以这里按 WCAG 算真实比值：把行底（纯色或渐变取平均）合成到卡片底色上，
     * 再和每个文字元素的实际 color 比。低于 3:1 就是「看不清」，不是「风格问题」。
     *
     * ★ 注意：这段代码是**字符串**（送去 CDP 求值），而外层是模板字符串，
     *   所以这里一个反斜杠都不能有 —— 正则里的 \( 会被模板字符串吃掉变成 (，
     *   /rgba?\(([^)]+)\)/ 于是变成 /rgba?(([^)]+))/，捕获组多出一对括号，
     *   parseFloat("(255") 得 NaN，整列对比度算出来是 null。
     *   （第一版就是这么写的，探针自己报了 13 个 null，反而是它救了它。）
     *   下面全部改成 indexOf / slice，不依赖转义。 */
    contrast: (function(){
      function parse(c){
        var s = String(c);
        var i = s.indexOf('(');
        if (i < 0) return null;
        var p = s.slice(i + 1).split(')')[0].split(',').map(function(x){ return parseFloat(x); });
        if (p.length < 3 || isNaN(p[0]) || isNaN(p[1]) || isNaN(p[2])) return null;
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 && !isNaN(p[3]) ? p[3] : 1 };
      }
      function over(fg, bg){
        var a = fg.a === undefined ? 1 : fg.a;
        return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a),
                 b: fg.b * a + bg.b * (1 - a), a: 1 };
      }
      function lum(c){
        function ch(v){ v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
        return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
      }
      function ratio(fg, bg){
        if (!fg || !bg) return null;
        var L1 = lum(fg), L2 = lum(bg);
        var hi = Math.max(L1, L2), lo = Math.min(L1, L2);
        return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
      }
      function colorStops(str){
        var out = [], pos = 0, s = String(str || '');
        while (true) {
          var a = s.indexOf('rgb', pos);
          if (a < 0) break;
          var b = s.indexOf(')', a);
          if (b < 0) break;
          var p = parse(s.slice(a, b + 1));
          if (p) out.push(p);
          pos = b + 1;
        }
        return out;
      }
      var cardBg = parse(getComputedStyle(card).backgroundColor);
      var out = [];
      [].slice.call(document.querySelectorAll('#prev-result-body .settle-row')).forEach(function(row, i){
        var cs = getComputedStyle(row);
        var own = parse(cs.backgroundColor) || { r: 0, g: 0, b: 0, a: 0 };
        var base = over(own, cardBg);
        var stops = colorStops(cs.backgroundImage);
        if (stops.length) {   /* 冠军行是渐变：取所有色标的平均值再合成 */
          var acc = { r: 0, g: 0, b: 0, a: 0 };
          stops.forEach(function(s){ acc.r += s.r; acc.g += s.g; acc.b += s.b; acc.a += s.a; });
          var n = stops.length;
          base = over({ r: acc.r / n, g: acc.g / n, b: acc.b / n, a: acc.a / n }, cardBg);
        }
        ['settle-name', 'settle-score', 'settle-net'].forEach(function(cls){
          var e = row.querySelector('.' + cls);
          if (!e) return;
          out.push({ row: i + 1, part: cls, ratio: ratio(parse(getComputedStyle(e).color), base) });
        });
      });
      var tip = document.querySelector('#prev-result-body .settle-tip');
      if (tip) out.push({ row: 'tip', part: 'settle-tip', ratio: ratio(parse(getComputedStyle(tip).color), cardBg) });
      return out;
    })(),
    /* 两类「看起来只是有点怪」但其实是盒子算错的问题：
     *   1) 名次圆溢出到名字上 —— .settle-rank 是定宽圆，列比它窄就压过去，不报错
     *   2) 名字被省略号截断 —— 有 text-overflow: ellipsis，截了也不报错 */
    overlaps: (function(){
      var bad = [];
      [].slice.call(document.querySelectorAll('#prev-result-body .settle-row')).forEach(function(row, i){
        var rank = row.querySelector('.settle-rank');
        var name = row.querySelector('.settle-name');
        if (!rank || !name) { bad.push('第' + (i + 1) + '行缺少 rank/name'); return; }
        var rr = rank.getBoundingClientRect(), nr = name.getBoundingClientRect();
        if (rr.right > nr.left + 0.5) {
          bad.push('第' + (i + 1) + '行名次圆压住名字 ' + Math.round(rr.right - nr.left) + 'px');
        }
        if (name.scrollWidth > name.clientWidth + 1) {
          bad.push('第' + (i + 1) + '行名字被截断（需要 ' + name.scrollWidth + 'px，只有 ' + name.clientWidth + 'px）');
        }
      });
      return bad;
    })()
  };
})()`;

/* 对局页底部按钮行：把「离开」改成「离开房间」之后还挤不挤得下 */
const GAME_SCENE = `(function(){
  ['screen-home','screen-room','screen-settle','screen-records','screen-rank','screen-auth']
    .forEach(function(id){ var e = document.getElementById(id); if (e) e.classList.add('hidden'); });
  document.getElementById('screen-game').classList.remove('hidden');
  document.getElementById('btn-revise').classList.add('hidden');   // 改一次只在提交后短暂出现
  return 'ok';
})()`;

const MEASURE_GAME = `(function(){
  var row = document.querySelector('.game-actions');
  var btns = [].slice.call(row.querySelectorAll('.btn')).filter(function(b){
    return !(b.closest && b.closest('.hidden'));
  });
  var rr = row.getBoundingClientRect();
  return {
    rowW: Math.round(rr.width),
    rowOverflow: row.scrollWidth - row.clientWidth,
    btns: btns.map(function(b){
      var r = b.getBoundingClientRect();
      return { text: b.textContent.trim(), w: Math.round(r.width),
               clipped: b.scrollWidth > b.clientWidth + 1 };
    }),
    submitW: Math.round(document.getElementById('btn-submit').getBoundingClientRect().width),
    anyClipped: btns.some(function(b){ return b.scrollWidth > b.clientWidth + 1; })
  };
})()`;

(async function main() {
  let exitCode = 0;
  try {
    startServer();
    await waitServer();

    edge = spawn(EDGE, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars',
      '--remote-debugging-port=' + CDP_PORT,
      '--user-data-dir=' + path.join(TMP, 'edge-profile'),
      '--window-size=' + W + ',' + H,
      '--force-device-scale-factor=1', 'about:blank'
    ], { stdio: 'ignore' });

    await attachPage();
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + SRV_PORT + '/' });

    /* 等 boot 完成：readyState 完整之后，首屏可能还会因为版本自检 reload 一次，
     * 所以要连着一段时间都稳定才算活稳（journey.js 同一个坑）。 */
    let booted = false, stableSince = 0;
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      try {
        const st = await evaluate("(function(){return {rs:document.readyState, screens:document.querySelectorAll('[id^=\"screen-\"]').length};})()");
        if (st && st.rs === 'complete' && st.screens >= 7) {
          if (!stableSince) stableSince = Date.now();
          if (Date.now() - stableSince > 1800) { booted = true; break; }
        } else { stableSince = 0; }
      } catch (e) { stableSince = 0; }
    }
    if (!booted) {
      let diag = null;
      try {
        diag = await evaluate("(function(){return {url:location.href, rs:document.readyState, title:document.title, bodyLen:(document.body?document.body.innerHTML.length:-1), home:(function(){var e=document.getElementById('screen-home');return e?e.className:'no-el';})(), screens:[].slice.call(document.querySelectorAll('[id^=\"screen-\"]')).map(function(e){return e.id+(e.classList.contains('hidden')?'(h)':'(SHOW)');}), toast:(function(){var t=document.querySelector('.toast,.flash');return t?t.textContent:'';})()};})()");
      } catch (e) { diag = { evalError: e.message }; }
      console.error('  诊断: ' + JSON.stringify(diag, null, 2));
      console.error('  服务端日志尾部: ' + serverLog.slice(-800));
      throw new Error('页面没 boot 起来');
    }

    console.log('\n[1] 就位态两颗胶囊');
    await evaluate(SCENE);
    await sleep(400);   // 等入场动画（breathe 循环，位置不受影响）
    const caps = await evaluate(MEASURE_CAPS);
    console.log('  ' + JSON.stringify(caps, null, 2).replace(/\n/g, '\n  '));
    console.log('  截图：' + await shot('prev-caps'));

    console.log('\n[2] 上一局结算弹窗');
    await evaluate(MODAL);
    await sleep(900);   // 等 modalIn 动画（行内错峰已关，这里只等卡片本身）
    const modal = await evaluate(MEASURE_MODAL);
    console.log('  ' + JSON.stringify(modal, null, 2).replace(/\n/g, '\n  '));
    console.log('  截图：' + await shot('prev-modal'));

    /* 结论 */
    console.log('\n[3] 对局页底部按钮行（「离开」→「离开房间」之后挤不挤）');
    await evaluate(GAME_SCENE);
    await sleep(300);
    const game = await evaluate(MEASURE_GAME);
    console.log('  ' + JSON.stringify(game, null, 2).replace(/\n/g, '\n  '));
    console.log('  截图：' + await shot('game-actions'));

    const problems = [];
    if (!caps.sameRow) problems.push('两颗胶囊不在同一行');
    if (caps.beyondStage) problems.push('胶囊超出 stage 右边界（被裁）');
    if (caps.rowOverflow > 1) problems.push('胶囊行横向溢出 ' + caps.rowOverflow + 'px');
    if (caps.caps.some((c) => c.clipped)) problems.push('有胶囊文字被自身裁切');
    if (!modal.cardsFit) problems.push('弹窗卡片超出 stage 上下边界 ' + modal.cardBottomOverflow + 'px');
    if (modal.bodyScrollable !== 'auto') problems.push('弹窗内容区 overflow-y 不是 auto');
    if (modal.rows !== 4) problems.push('结算行数量不对：' + modal.rows);
    if (!modal.hasTip) problems.push('尾注没渲染');
    if (!modal.meBadge) problems.push('「我」胶囊没渲染');
    if (modal.overlaps && modal.overlaps.length) {
      modal.overlaps.forEach(function (s) { problems.push(s); });
    }
    /* 对比度：3:1 是这条线。低于它的东西在 screenshot 里看着「有」，真机上看着「没有」。 */
    var dim = (modal.contrast || []).filter(function (c) { return c.ratio < 3; });
    if (dim.length) {
      dim.forEach(function (c) {
        problems.push('第 ' + c.row + ' 行 .' + c.part + ' 对比度只有 ' + c.ratio + ':1（< 3:1，看不清）');
      });
    }
    var weakest = (modal.contrast || []).slice().sort(function (a, b) { return a.ratio - b.ratio; })[0];
    console.log('  最低对比度：' + (weakest ? (weakest.ratio + ':1（第 ' + weakest.row + ' 行 .' + weakest.part + '）') : '无'));
    if (game.rowOverflow > 1) problems.push('对局页按钮行溢出 ' + game.rowOverflow + 'px');
    if (game.anyClipped) problems.push('对局页有按钮文字被裁');
    if (game.submitW < 150) problems.push('「再选 6 张牌」被挤到 ' + game.submitW + 'px（主操作不该比次要按钮还窄）');

    console.log('\n========================================');
    if (problems.length) {
      console.log('发现 ' + problems.length + ' 个问题：');
      problems.forEach((p) => console.log('  ✗ ' + p));
      exitCode = 1;
    } else {
      console.log('布局全部通过：胶囊同行不溢出、弹窗卡片不出界、内容区可滚');
    }
    console.log('========================================');
  } catch (e) {
    console.error('\n探针失败: ' + e.message);
    exitCode = 1;
  } finally {
    try { cdp && cdp.close(); } catch (e) { /* ignore */ }
    try { edge && edge.kill(); } catch (e) { /* ignore */ }
    try { serverProc && serverProc.kill(); } catch (e) { /* ignore */ }
    await sleep(300);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    process.exit(exitCode);
  }
})();
