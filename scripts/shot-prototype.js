/**
 * 原型截图（一次性诊断脚本，不进测试套件）
 *
 * 用真 Edge（headless + CDP）打开 docs/prototypes/circle-table.html，
 * 逐条 eval 一段脚本切状态，再截图。为什么必须真浏览器：
 * 座位环是 JS 按可用宽高算出来的椭圆，静态读 CSS 看不出重叠。
 *
 * 用法：node scripts/shot-prototype.js [分组名...]
 *   不传 → 跑全部预设分组；分组定义见 GROUPS 常量。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CDP_PORT = 9444;
const SHOT_DIR = path.join(__dirname, '..', 'tmp-shots');
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
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || JSON.stringify(r.exceptionDetails).slice(0, 600));
  return r.result.value;
}

async function shot(cdp, name) {
  /* 只截设备那一块，并按 2 倍像素抓 —— 缩放后的整页截图看不清 21 设计px 的字 */
  const box = await evaluate(cdp, `(function(){
    var d = document.getElementById('device').getBoundingClientRect();
    return { x:Math.round(d.left), y:Math.round(d.top), width:Math.round(d.width), height:Math.round(d.height) };
  })()`);
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 2 } });
  if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
  const p = path.join(SHOT_DIR, name + '.png');
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  return p;
}

/* 每次切状态都走这里：切模式 → 等一帧 → 量一次越界。 */
const SET = (mode, extra) => `(function(){
  ${extra || ''}
  window.__proto.render();
  return true;
})()`;

/* 场景 A：①就见底 → 4 幕（分牌 / ①揭晓 / ①结算 / 局终）
   场景 B：无人见底 → 14 幕（3+1+2+1 两轮 + 局终），四种特写都在 B 里 */
const KB = `document.querySelector('#seg-scen [data-v="B"]').click();`;
const GROUPS = [
  ['pt-01divide', 'pt', `window.__proto.goto(0);`],
  ['pt-02reveal', 'pt', `window.__proto.goto(1);`],
  ['pt-03settle', 'pt', `window.__proto.goto(2);`],
  ['pt-04final', 'pt', `window.__proto.goto(3);`],
  ['pt-05emo', 'pt', `${KB} window.__proto.goto(2); document.querySelector('[data-seat="s1"]').click();`],
  ['pt-06stat', 'pt', `document.querySelector('[data-seat="me"]').click();`],
  ['pt-06b-stat-other', 'pt', `document.querySelector('[data-seat="s1"]').click(); document.querySelector('[data-tab="stat"]').click();`],
  ['pt-07fx-jh', 'pt', `${KB} window.__proto.goto(4);`],
  ['pt-08fx-bz', 'pt', `${KB} window.__proto.goto(6);`],
  ['pt-09break', 'pt', `${KB} window.__proto.goto(7);`],
  ['pt-10fx-wh', 'pt', `${KB} window.__proto.goto(12);`],
  ['pt-11end', 'pt', `${KB} window.__proto.goto(13);`],
  ['pt-12emo-send', 'pt', `window.__proto.goto(2); window.__proto.fire('s1','e2');`, 900],
  ['pt-13emo-send-phr', 'pt', `window.__proto.goto(0); window.__proto.fire('s0','p5');`, 900],
  ['pt-14emo-phr-tab', 'pt', `window.__proto.goto(2); document.querySelector('[data-seat="s1"]').click(); document.querySelector('[data-tab="phr"]').click();`],
  ['pt-15self-emo', 'pt', `window.__proto.goto(0); document.querySelector('[data-feltemo]').click();`],
  ['pt-16fly', 'pt', `window.__proto.goto(2); window.__proto.fire('s1','e6');`, 220],
  ['pt-17self', 'pt', `window.__proto.goto(0); window.__proto.fire('me','e3');`, 220],
  ['pt-18lands', 'pt', `window.__proto.goto(2); window.__proto.fire('s1','e6');`, 620],
  ['pt-19a-flyend', 'pt', `window.__proto.goto(2); window.__proto.fire('s1','e6');`, 455],
  ['pt-19b-bub', 'pt', `window.__proto.goto(2); window.__proto.fire('s1','e6');`, 560],
  ['ls-settle', 'ls', `${KB} window.__proto.goto(12);`],
  /* 横屏 5 人结算条是最挤的一档（5 行 + 标题 + 页脚），而且是最早出过「第 5 名被裁」的
   * 那一格。之前所有 ls 截图都带着表情面板，面板会盖住结算条 —— 这一格专拍「没有面板」的样子。 */
  ['ls-5settle', 'ls', `${KB} document.querySelector('#seg-n [data-v="5"]').click(); window.__proto.goto(2);`],
  ['ls-emo', 'ls', `${KB} window.__proto.goto(2); document.querySelector('[data-seat="s2"]').click();`],
  ['dk-settle', 'dk', `${KB} window.__proto.goto(2);`],
  ['dk-emo', 'dk', `document.querySelector('[data-seat="s2"]').click();`],
  ['dk-stat', 'dk', `document.querySelector('[data-seat="me"]').click();`],
  ['ls-stat', 'ls', `${KB} window.__proto.goto(12); document.querySelector('[data-seat="s1"]').click(); document.querySelector('[data-tab="stat"]').click();`],
  ['pt-5emo', 'pt', `document.querySelector('#seg-n [data-v="5"]').click(); window.__proto.goto(2); document.querySelector('[data-seat="s3"]').click();`],
  ['pt-5stat', 'pt', `document.querySelector('#seg-n [data-v="5"]').click(); document.querySelector('[data-seat="me"]').click();`],
  ['pt-2emo', 'pt', `document.querySelector('#seg-n [data-v="2"]').click(); window.__proto.goto(2); document.querySelector('[data-seat="s0"]').click();`]
];

/* 准备态：房间长在牌桌上之后的各个状态 */
GROUPS.push(
  ['pt-ready', 'pt', `window.__proto.ready(null,null);`],
  ['pt-ready-partial', 'pt', `window.__proto.ready(null,null); window.__proto.toggleReady();`, 380],
  ['pt-ready-last', 'pt', `window.__proto.ready(7,null);`],
  ['pt-ready-all', 'pt', `window.__proto.ready(null,null);
    window.__proto.S.rdy = true;
    window.__proto.S.rdyOthers = {s0:1,s1:1,s2:1,s3:1};
    window.__proto.S.countdown = 3; window.__proto.S.cdOn = true; window.__proto.render();`],
  ['pt-ready-ask', 'pt', `window.__proto.ready(null,null); window.__proto.S.ask = 'leave'; window.__proto.render();`],
  ['pt-play-ask', 'pt', `window.__proto.goto(2); window.__proto.S.ask = 'leave'; window.__proto.render();`],
  ['pt-ready-2', 'pt', `document.querySelector('#seg-n [data-v="2"]').click(); window.__proto.ready(null,null);`],
  ['pt-ready-3', 'pt', `document.querySelector('#seg-n [data-v="3"]').click(); window.__proto.ready(null,null);`],
  ['pt-ready-4', 'pt', `document.querySelector('#seg-n [data-v="4"]').click(); window.__proto.ready(null,null);`],
  ['ls-ready', 'ls', `window.__proto.ready(null,null);`],
  ['ls-ready-3', 'ls', `document.querySelector('#seg-n [data-v="3"]').click(); window.__proto.ready(null,null);`],
  ['dk-ready', 'dk', `window.__proto.ready(null,null);`]
);

/* 8 人局是面板最挤的一档：座位环几乎顶满画布，四个方向都可能塞不下。
   固定测环上 7 个方位（左 / 上 / 右 / 下都有），三端各一遍。 */
/* 人数收敛到 2~5 之后，最挤的一档变成 5 人局：环上 4 个方位俯屏都要放得下面板 */
const FOUR = ['s0','s1','s2','s3'];
[['pt','pt'], ['ls','ls'], ['dk','dk']].forEach(function(pair){
  var pre = pair[0], mode = pair[1];
  FOUR.forEach(function(k){
    GROUPS.push([pre + '-5' + k, mode,
      `document.querySelector('#seg-n [data-v="5"]').click(); window.__proto.goto(2); document.querySelector('[data-seat="${k}"]').click();`]);
  });
});

async function main() {
  const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const edge = spawn(exe, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(os.tmpdir(), 'lxw-proto-' + Date.now()),
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

  const errs = await evaluate(cdp, `(function(){
    return { hasProto: !!window.__proto, scenes: window.__proto ? window.__proto.scenes().length : 0 };
  })()`);
  console.log('boot ' + JSON.stringify(errs));

  const only = process.argv.slice(2);
  for (const [name, mode, code, wait] of GROUPS) {
    if (only.length && !only.some((o) => name.indexOf(o) >= 0)) continue;
    await evaluate(cdp, `(function(){
      window.__proto.S.mode = ${JSON.stringify(mode === 'pt' ? 'portrait' : mode === 'ls' ? 'landscape' : 'desktop')};
      window.__proto.S.panel = null; window.__proto.S.pick = null; window.__proto.S.fx = null;
      window.__proto.S.bubble = {}; window.__proto.S.bubbleSeq = {};   /* 别让上一组的气泡串到这一组 */
      window.__proto.S.ask = null; window.__proto.S.toast = null;
      ${code}
    })()`);
    await sleep(wait || 700);
    const info = await evaluate(cdp, `(function(){
      var S = window.__proto.S;
      var d = document.getElementById('design');
      var r = d.getBoundingClientRect();
      var designW = (S.mode === 'portrait') ? 750 : 1624;   /* 横屏/桌面是 1624 宽，按 750 算会把设计px 放大 2.17 倍 */
      var k = r.width / designW;
      var over = [];
      [].forEach.call(d.querySelectorAll('.seat,.sstrip,.panel,.fx,.brk,.acts,.band,.feltbtn,.room,.ask,.toast'), function(el){
        var b = el.getBoundingClientRect();
        if (b.width < 1) return;
        var sides = [];
        if (b.left < r.left - 1) sides.push('L' + Math.round((r.left - b.left) / k));
        if (b.right > r.right + 1) sides.push('R' + Math.round((b.right - r.right) / k));
        if (b.top < r.top - 1) sides.push('T' + Math.round((r.top - b.top) / k));
        if (b.bottom > r.bottom + 1) sides.push('B' + Math.round((b.bottom - r.bottom) / k));
        if (sides.length) over.push((el.className || el.tagName).split(' ')[0] + ':' + sides.join(','));
      });
      /* 内容溢出：外层框在画布内、但自己的内容被撑出框外（横屏结算条就栽在这）。
       * 容差必须是 0。以前是「大于 3px」才报，而横屏 5 人结算条恰好溢出 3px，
       * 第 5 行副标题被裁半截却一直是绿的 —— 容差不该等于已知缺陷的尺寸。 */
      var inner = [];
      [].forEach.call(d.querySelectorAll('.sstrip,.panel,.brk,.band'), function(el){
        var ov = el.scrollHeight - el.clientHeight;
        if (ov > 0) inner.push((el.className || '').split(' ')[0] + ':h+' + Math.round(ov / k));
      });
      var r1 = d.querySelector('.sstrip .r');
      var l1 = d.querySelector('.sstrip .list');
      var w1 = r1 ? [].map.call(r1.children, function(c){ return Math.round(c.getBoundingClientRect().width / k); }) : [];
      return { idx:S.idx, kind:(window.__proto.scenes()[S.idx]||{}).kind,
        total:window.__proto.scenes().length, over:over.slice(0,6),
        inner:inner.slice(0,4),
        flyer: (function(){ var f = d.querySelector('.flyer'); if (!f) return false;
          var fb = f.getBoundingClientRect();
          return { x:Math.round((fb.left - r.left)/k), y:Math.round((fb.top - r.top)/k), w:Math.round(fb.width/k) }; })(),
        bubbles: Object.keys(window.__proto.S.bubble),
        bface: (function(){ var b = d.querySelector('.bub.face'); if (!b) return null;
          var bb = b.getBoundingClientRect();
          return { x:Math.round((bb.left - r.left)/k), y:Math.round((bb.top - r.top)/k), w:Math.round(bb.width/k) }; })(),
        anch: (function(){
          /* 面板到底压没压住「被点的那个人」——8 人局四个方向都塞不进时最可能的翻车点 */
          var pe = d.querySelector('.panel'); if (!pe) return null;
          var key = window.__proto.S.panel && window.__proto.S.panel.key; if (!key) return null;
          var se = d.querySelector('[data-seat="' + key + '"] .av'); if (!se) return null;
          var sb = se.getBoundingClientRect(), pb = pe.getBoundingClientRect();
          var ox = Math.max(0, Math.min(sb.right, pb.right) - Math.max(sb.left, pb.left));
          var oy = Math.max(0, Math.min(sb.bottom, pb.bottom) - Math.max(sb.top, pb.top));
          var aw = Math.round(sb.width / k);
          return { key:key, av:aw, cover:Math.round(ox * oy / (k * k)), ratio:+(ox*oy/(sb.width*sb.height)).toFixed(2) };
        })(),
        panel: (function(){ var pe = d.querySelector('.panel'); if (!pe) return null;
          var pb = pe.getBoundingClientRect();
          var gb = pe.querySelector('.grid');
          return { x:Math.round((pb.left - r.left)/k), y:Math.round((pb.top - r.top)/k),
            w:Math.round(pb.width/k), h:Math.round(pb.height/k),
            gridScroll: gb ? Math.round(gb.scrollHeight) : null,
            gridClient: gb ? Math.round(gb.clientHeight) : null }; })(),
        box: (function(){
          var q = function(sel){ var e = d.querySelector(sel); if (!e) return null;
            var b = e.getBoundingClientRect();
            return { y:Math.round((b.top - r.top)/k), h:Math.round(b.height/k) }; };
          return { felt:q('.felt'), card:q('.rminfo .card'), acts:q('.acts'), room:q('.room') };
        })(),
        listW: l1 ? Math.round(l1.clientWidth) : null,
        listH: l1 ? Math.round(l1.clientHeight) : null,
        rowsH: l1 ? Math.round(l1.scrollHeight) : null,
        w1: w1 };
    })()`);
    console.log(name.padEnd(20) + JSON.stringify(info));
    console.log('  ' + (await shot(cdp, name)));
  }

  cdp.close();
  edge.kill();
}

main().catch((e) => { console.error(e); process.exit(1); });
