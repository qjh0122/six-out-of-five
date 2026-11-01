/**
 * 第一轮「十点半优先」的浏览器侧验证 + 截图
 *
 * 规则：十点半组必须优先做成不爆的组合；能凑 10.5 就优先 10.5。
 * 违背时在**放牌那一刻**提醒（不拦截），并且槽位上常驻显示点数与爆点状态。
 *
 * 为什么不能只靠单测：tenhalf-priority.test.js 证明的是「判定对不对」，
 * 但这个需求有一半是「提醒出得来、在正确的位置、颜色和牌桌一致」——
 * 那部分只有渲染出来才看得见。所以这里真跑一局：
 *   1) 从手牌里挑一对「怎么算都爆」的牌放进十点半组
 *      → 断言红色 toast + 槽位 .is-bust + 点数胶囊 .slot-point.bust + 截图
 *   2) 若手牌里正好有 10.5 的组合，再放一次
 *      → 断言绿色胶囊 .slot-point.best + 没有警告
 *
 * 用法：node scripts/probe-tenhalf.js
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', 'pwa');
const PORT = 3075;
const CDP = 9375;
const SHOT_DIR = path.join(os.tmpdir(), 'lxw-tenhalf');
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
    const pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      }
    };
    ws.onerror = reject;
    ws.onopen = () => resolve({
      send(method, params) {
        return new Promise((res, rej) => {
          const mid = ++id;
          pending.set(mid, { res, rej });
          ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
        });
      },
      close() { ws.close(); }
    });
  });
}

async function evaluate(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: expr, awaitPromise: true, returnByValue: true
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception || {}).description);
  return r.result.value;
}

async function shot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
  const p = path.join(SHOT_DIR, name + '.png');
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  return p;
}

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

/* 单张点数（十分之一）：A=1、J/Q/K=半点、2~10 面值。
 * 王按 0.5 估 —— 这是**下界**（王可以解析成更大的牌），
 * 所以「下界都超过 10.5」的组合一定真爆，不会误报。 */
function tenths(cid) {
  const rank = Number(String(cid).split('-')[1]);
  if (rank === 14) return 10;
  if (rank >= 11) return 5;
  return rank * 10;
}

/* 进到第一轮分牌页。返回 6 张手牌的 card-id（失败返回 null） */
async function enterSplit(cdp) {
  /* 本地演示模式只有一个人，而开局要求 2 人 —— 补 AI 在 local 下是禁用的
   * （canAddBot 要求 RoomStore.getMode() === 'ws'）。为了不引入真服务端 + 注册账号
   * 那一整套，这里把 MIN_PLAYERS 临时改成 1（只在这条测试路径上生效，不改产品代码）。
   * 发牌、分组、落牌、提交校验都不看人数的下限，单人局能完整走完分牌页。 */
  await evaluate(cdp, `localStorage.setItem('lxw_guide_seen_v1','1')`);
  await evaluate(cdp, `window.CONFIG && (window.CONFIG.MIN_PLAYERS = 1)`);
  await evaluate(cdp, `document.getElementById('btn-create').click()`);
  /* ★ v103 起「创建房间」只弹「本局打几把」，点了确认才真的开房。
   * 少这一步 → 房间根本没建 → 后面点 btn-ready 什么都不会发生 →
   * enterSplit 返回 null → 探针把「建房失败」误报成「牌不好」。 */
  await sleep(500);
  await evaluate(cdp, `(function(){var b=document.getElementById('btn-create-confirm');if(b)b.click();})()`);
  await sleep(500);
  await sleep(900);
  await evaluate(cdp, `document.getElementById('btn-ready').click()`);
  await sleep(1800);
  const ids = await evaluate(cdp, `Array.prototype.map.call(
    document.querySelectorAll('#hand .card-wrap[data-card-id]'),
    function(e){ return e.dataset.cardId; })`);
  return (ids && ids.length === 6) ? ids : null;
}

/* 把两张牌放进十点半组：先点槽位设为目标组，再点手牌 */
async function placePair(cdp, a, b) {
  /* 槽位的点击委托只认 .card-box（见 game.js 的 #slots 监听）：
   * 点标签/点空白都不触发，必须点格子本身。空格子 → onSlotTap(key)（切当前组），
   * 有牌的格子 → onSlotCardTap（收回）。 */
  await evaluate(cdp, `(function(){
    var s = document.querySelector('#slots .slot[data-game="tenhalf"]');
    var box = s && s.querySelector('.card-box');
    if (box) box.click();
  })()`);
  await sleep(200);
  for (const cid of [a, b]) {
    await evaluate(cdp, `(function(){
      var w = document.querySelector('#hand .card-wrap[data-card-id="${cid}"] img');
      if (w) w.click();
    })()`);
    await sleep(420);
  }
  await sleep(380);
}

const SLOT_STATE = `(function(){
  var s = document.querySelector('#slots .slot[data-game="tenhalf"]');
  if (!s) return null;
  var p = s.querySelector('.slot-point');
  var t = document.getElementById('toast');
  return {
    bust: s.classList.contains('is-bust'),
    point: p ? p.textContent.trim() : null,
    pointBust: p ? p.classList.contains('bust') : false,
    pointBest: p ? p.classList.contains('best') : false,
    toastVisible: t ? !t.classList.contains('hidden') : false,
    /* 文字有没有被裁：scrollWidth > clientWidth 就是横向溢出（被 max-width 卡住），
     * 这种情况在横屏更容易出现 —— 舞台缩放后 640 设计 px 只有 ~333 CSS px。 */
    toastOverflow: t ? (t.scrollWidth > t.clientWidth + 1 || t.scrollHeight > t.clientHeight + 1) : false,
    toastBox: t ? { w: Math.round(t.getBoundingClientRect().width), h: Math.round(t.getBoundingClientRect().height) } : null,
    toastClass: t ? t.className : '',
    toastText: t ? t.textContent.trim() : ''
  };
})()`;

/* 让页面自己判一次「这组爆了，但手里还有不爆的打法」。
 * 不在脚本里算：王（joker）要先解析成某张牌，那套解析只有 engine 有一份，
 * 脚本另写一份必然和结算跑偏（而跑偏的后果是「脚本说不该拦、界面拦了」）。 */
function adviceExpr(pair, hand) {
  return `(function(){
    function mk(id){ var p = id.split('-'); return { suit: p[0], rank: Number(p[1]) }; }
    var pick = ${JSON.stringify(pair)}.map(mk);
    var all = ${JSON.stringify(hand)}.map(mk);
    var a = StateMachine.tenHalfAdvice(1, { tenhalf: pick }, all);
    return a ? { kind: a.kind, points: a.points } : null;
  })()`;
}

/* 从另外两组里挑一张「换进十点半就不爆」的牌。
 * 返回 { drop, add }：把 drop 从十点半取出来，把 add 放进去。
 * 六张牌全在槽里（手牌是空的），所以「换牌」在界面上是两组对调一张。 */
function swapExpr(pair, hand) {
  return `(function(){
    function mk(id){ var p = id.split('-'); return { suit: p[0], rank: Number(p[1]) }; }
    function same(a, b){ return a.suit === b.suit && a.rank === b.rank; }
    var pr = ${JSON.stringify(pair)}.map(mk);
    var all = ${JSON.stringify(hand)}.map(mk);
    for (var i = 0; i < 2; i++) {
      var drop = pr[i], keep = pr[1 - i];
      for (var j = 0; j < all.length; j++) {
        var c = all[j];
        if (same(c, pr[0]) || same(c, pr[1])) continue;
        var p = StateMachine.tenHalfPair([keep, c]);
        if (p && !p.bust) {
          return { drop: drop.suit + '-' + drop.rank, add: c.suit + '-' + c.rank, points: p.points };
        }
      }
    }
    return null;
  })()`;
}

async function main() {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const edge = spawn(exe, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + CDP,
    '--user-data-dir=' + path.join(os.tmpdir(), 'lxw-th-' + Date.now()),
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
  /* 视口可传：node scripts/probe-tenhalf.js 844x390
   * 横屏的槽位面积更小、字号又要过 --ls-fs-floor，警告与胶囊必须两头都看过。 */
  const only = (process.argv[2] || '').match(/^(\d+)x(\d+)$/);
  const VW = only ? Number(only[1]) : 390;
  const VH = only ? Number(only[2]) : 844;
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 2, mobile: true });

  /* 随机手牌不一定含「必爆」的一对（多数情况含），最多重开 4 局 */
  let ids = null, bustPair = null, bestPair = null;
  for (let attempt = 0; attempt < 4 && !bustPair; attempt++) {
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/?mode=local' });
    await sleep(1500);
    ids = await enterSplit(cdp);
    if (!ids) continue;

    for (let i = 0; i < ids.length && !bustPair; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const sum = tenths(ids[i]) + tenths(ids[j]);
        if (sum > 105 && !bustPair) bustPair = [ids[i], ids[j]];
        if (sum === 105 && !bestPair) bestPair = [ids[i], ids[j]];
      }
    }
    if (!bustPair) { console.log('  （这一局没有必爆的一对，重开）'); }
  }

  console.log('\n[1] 把手牌里「怎么算都爆」的一对放进十点半');
  ok(!!bustPair, '找到一对会爆的牌', JSON.stringify(bustPair));
  if (bustPair) {
    console.log('    手牌 ' + ids.join(' , ') + '   放进去 ' + bustPair.join(' + '));
    await placePair(cdp, bustPair[0], bustPair[1]);
    const st = await evaluate(cdp, SLOT_STATE);
    console.log('    槽位 ' + JSON.stringify(st));
    ok(st.bust, '★ 槽位进入爆点态（.is-bust）');
    ok(st.pointBust, '★ 点数胶囊是红色 bust 样式');
    ok(!!st.point && st.point.indexOf('爆') >= 0, '★ 胶囊上写着「爆 N 点」', st.point);
    ok(st.toastVisible, '★ 放牌时弹出了提示');
    ok(st.toastClass.indexOf('warn') >= 0, '★ 提示是红色 warn 语气（不是金色普通提示）', st.toastClass);
    ok(/爆/.test(st.toastText), '★ 文案说清了「爆了」', st.toastText);
    ok(/会输/.test(st.toastText), '★ 并说明后果（这组会输）', st.toastText);
    /* ★ 不点名换哪两张：第一轮三组互相抢牌，手里往往有好几组都能不爆，
     * 挑哪组是玩家的策略。文案里出现花色或「X + Y」就说明又在当教练了。 */
    ok(!/[♠♥♣♦]/.test(st.toastText), '★ 文案里不出现具体牌（不替玩家选方案）', st.toastText);
    ok(st.toastText.indexOf(' + ') < 0, '★ 也没有「A + B」式的搭配建议', st.toastText);
    eq(st.toastOverflow, false, '★ 警告文字没有被裁掉', JSON.stringify(st.toastBox));
    /* 玩家点回十点半组（想看清那两张牌）时它同时是 .is-active 和 .is-bust。
     * 只加 class 模拟选中态 —— 真去点那个格子会触发 onSlotCardTap（把牌收回）。 */
    await evaluate(cdp, `document.querySelector('#slots .slot[data-game="tenhalf"]').classList.add('is-active')`);
    const barColor = await evaluate(cdp, `getComputedStyle(
      document.querySelector('#slots .slot[data-game="tenhalf"]')).borderLeftColor`);
    eq(barColor, 'rgb(255, 93, 93)', '★ 爆点组被选为当前组时，左侧竖条仍是红的', barColor);
    await evaluate(cdp, `document.querySelector('#slots .slot[data-game="tenhalf"]').classList.remove('is-active')`);
    console.log('    截图 ' + (await shot(cdp, 'tenhalf-bust')));
  }

  console.log('\n[2] 恰好 10.5 的一对：绿色胶囊、不该有警告');
  /* 10.5 需要「10 + 半点」或「王 + 10」，随机六张里不一定有 —— 重开直到凑到为止。
   * 注意必须**每一局重新找**：上一局的 bestPair 重开后早就不在手牌里了。 */
  let hit = null;
  /* 10.5 的组合（10 + J/Q/K，或王 + 10）在六张里出现的概率约三成，
   * 8 次都抽不到的概率 ~6% —— 够稳，又不至于卡太久。 */
  for (let attempt = 0; attempt < 8 && !hit; attempt++) {
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/?mode=local' });
    await sleep(1500);
    const ids2 = await enterSplit(cdp);
    if (!ids2) continue;
    for (let i = 0; i < ids2.length && !hit; i++) {
      for (let j = i + 1; j < ids2.length; j++) {
        if (tenths(ids2[i]) + tenths(ids2[j]) === 105) { hit = [ids2[i], ids2[j]]; break; }
      }
    }
    if (hit) console.log('    手牌 ' + ids2.join(' , ') + '   放进去 ' + hit.join(' + '));
  }
  if (!hit) {
    console.log('  SKIP  8 局都没抽到 10.5 的组合（概率问题，不是功能问题）');
  } else {
    await placePair(cdp, hit[0], hit[1]);
    const st = await evaluate(cdp, SLOT_STATE);
    console.log('    槽位 ' + JSON.stringify(st));
    eq(st.bust, false, '★ 10.5 不进入爆点态');
    ok(st.pointBest, '★ 胶囊是绿色 best 样式', st.point);
    eq(st.point, '10.5', '★ 胶囊显示 10.5');
    ok(!st.toastVisible || st.toastClass.indexOf('warn') < 0, '★ 没有红色警告', st.toastClass);
    console.log('    截图 ' + (await shot(cdp, 'tenhalf-best')));
  }

  /* ★ 这一条是「不替玩家打牌」的核心：不爆就不提示。
   *
   * 构造一局同时满足两件事的手牌：手里有能凑 10.5 的一对，
   * 但玩家先放的一对是「不爆、也没到 10.5」的（比如 9 + K = 9.5）。
   * 旧版本这时会弹「手里能凑 10.5 · 用 10♠ + K」—— 等于宣布最优解，
   * 而玩家可能是故意把那张 10 留给飘三叶。现在必须一声不响。 */
  console.log('\n[2b] 不爆但没凑到 10.5：完全不提示');
  let calm = null;
  for (let attempt = 0; attempt < 10 && !calm; attempt++) {
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/?mode=local' });
    await sleep(1500);
    const ids4 = await enterSplit(cdp);
    if (!ids4) continue;
    for (let i = 0; i < ids4.length && !calm; i++) {
      for (let j = i + 1; j < ids4.length && !calm; j++) {
        const s2 = tenths(ids4[i]) + tenths(ids4[j]);
        if (s2 > 105 || s2 === 105) continue;          // 要「不爆但不是满分」的一对
        /* 整手牌里还得真有 10.5 的另一对，否则这一局本来就没得选，测不出东西 */
        let better = false;
        for (let k = 0; k < ids4.length && !better; k++) {
          for (let l = k + 1; l < ids4.length; l++) {
            if (k === i || k === j || l === i || l === j) continue;
            if (tenths(ids4[k]) + tenths(ids4[l]) === 105) { better = true; break; }
          }
        }
        if (better) calm = { pick: [ids4[i], ids4[j]], points: s2 / 10, hand: ids4 };
      }
    }
    if (calm) console.log('    手牌 ' + ids4.join(' , ') + '   放了 ' + calm.pick.join(' + ')
      + '（' + calm.points + ' 点，手里另有 10.5 的组合）');
  }
  if (!calm) {
    console.log('  SKIP  10 局都没抽到「选了不爆但非满分、且另有 10.5」的手牌');
  } else {
    await placePair(cdp, calm.pick[0], calm.pick[1]);
    const st = await evaluate(cdp, SLOT_STATE);
    console.log('    槽位 ' + JSON.stringify(st));
    eq(st.bust, false, '不进入爆点态');
    eq(st.toastVisible, false, '★ 一声不响（不提示「其实能到 10.5」）',
      st.toastClass + ' / ' + st.toastText);
    ok(st.point && st.point.indexOf('爆') < 0, '★ 胶囊只报点数，不下判断', st.point);
    console.log('    截图 ' + (await shot(cdp, 'tenhalf-calm')));
  }

  console.log('\n[3] 提着爆点去提交：当场被拦住（本轮改动的核心）');
  /* 用户 2026-10-30：「现在只是硬凑爆点牌会提示，但是提交还是可以正常提交，这不对，
   * 应该阻止提交」。所以这里验四件事：
   *   a) 点「结束本局」之后**不弹**提交确认框，改弹 #bust-modal；
   *   b) 拦截框只有「去改」一个出口（没有「就这样提交」）；
   *   c) 点「去改」回来：牌还在，当前组就是十点半，能立刻换牌；
   *   d) 换成不爆的组合之后再提交，正常弹确认框。
   *
   * 只在「手里还有不爆的打法」时才拦，所以这一局得自己挑出来：
   * 用页面里的 StateMachine 复核（王要先解析成某张牌，脚本这边算不出来）。
   * 挑不到就重开 —— 不是功能失败，是手牌不配合。 */
  let blocked = null;
  for (let attempt = 0; attempt < 8 && !blocked; attempt++) {
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/?mode=local' });
    await sleep(1500);
    const ids3 = await enterSplit(cdp);
    if (!ids3) continue;
    let pair3 = null;
    for (let i = 0; i < ids3.length && !pair3; i++) {
      for (let j = i + 1; j < ids3.length; j++) {
        if (tenths(ids3[i]) + tenths(ids3[j]) > 105) { pair3 = [ids3[i], ids3[j]]; break; }
      }
    }
    if (!pair3) continue;
    await placePair(cdp, pair3[0], pair3[1]);
    const adv = await evaluate(cdp, adviceExpr(pair3, ids3));
    if (!adv || adv.kind !== 'bust') {
      console.log('    这局的爆点救不回来（' + JSON.stringify(adv) + '）→ 按口径不该拦，重开');
      continue;
    }
    /* 剩下 4 张依次点进去：放满十点半后 activeGroup 会自动顺延到飘三叶，
     * 再满就轮到比大小 —— 正好把三组填满。 */
    const rest = ids3.filter((c) => pair3.indexOf(c) < 0);
    for (const cid of rest) {
      await evaluate(cdp, `(function(){
        var w = document.querySelector('#hand .card-wrap[data-card-id="${cid}"] img');
        if (w) w.click();
      })()`);
      await sleep(260);
    }
    await sleep(400);
    const filled = await evaluate(cdp, `Array.prototype.map.call(
      document.querySelectorAll('#slots .slot'), function(s){
        return s.dataset.game + ':' + s.querySelectorAll('.card-box[data-card-id]').length;
      }).join(' ')`);
    await evaluate(cdp, `document.getElementById('btn-submit').click()`);
    await sleep(500);
    const r = await evaluate(cdp, `(function(){
      var c = document.getElementById('confirm-modal');
      var b = document.getElementById('bust-modal');
      return {
        confirmShown: c ? !c.classList.contains('hidden') : false,
        bustShown: b ? !b.classList.contains('hidden') : false,
        bustTitle: b ? document.getElementById('bust-title').textContent : '',
        bustText: b ? document.getElementById('bust-desc').textContent : '',
        filledCards: document.querySelectorAll('#slots .card-box[data-card-id]').length
      };
    })()`);
    if (r.bustShown) blocked = { filled: filled, pair: pair3, hand: ids3, adv: adv, r: r };
  }

  ok(!!blocked, '找到「爆了但手里还有不爆打法」的一局', blocked ? blocked.filled : '8 局都没抽到');
  if (blocked) {
    console.log('    手牌 ' + blocked.hand.join(' , ') + '   十点半放了 ' + blocked.pair.join(' + ')
      + '（' + (blocked.adv.points / 10) + ' 点，爆）');
    console.log('    分组 ' + blocked.filled);
    console.log('    拦截框 ' + JSON.stringify(blocked.r.bustText));
    eq(blocked.r.confirmShown, false, '★ 没有弹出提交确认框（提交根本没走到那一步）');
    ok(blocked.r.bustShown, '★ 弹出爆点拦截框 #bust-modal');
    ok(/爆/.test(blocked.r.bustTitle) || /爆/.test(blocked.r.bustText), '★ 标题/正文里说清了「爆了」');
    ok(/会输/.test(blocked.r.bustText), '★ 并说明后果（这一组会输）', blocked.r.bustText);
    ok(/换/.test(blocked.r.bustText), '★ 明确要求改（不是只说「不能提交」）', blocked.r.bustText);
    ok(!/[♠♥♣♦]/.test(blocked.r.bustText), '★ 不点名换哪张（不替玩家打牌）', blocked.r.bustText);
    eq(blocked.r.filledCards, 6, '牌还在槽位上（拦的是提交，不是把人的东西清掉）');
    console.log('    截图 ' + (await shot(cdp, 'tenhalf-blocked')));

    /* c) 「去改」：合上框、当前组回到十点半、牌一张不少 */
    console.log('\n[3b] 点「去改」：回到可编辑，能立刻换牌');
    const btnCount = await evaluate(cdp,
      `document.querySelectorAll('#bust-modal button').length`);
    eq(btnCount, 1, '★ 拦截框只有一个按钮（没有「就这样提交」这种后路）');
    await evaluate(cdp, `document.getElementById('btn-bust-fix').click()`);
    await sleep(450);
    const after = await evaluate(cdp, `(function(){
      var b = document.getElementById('bust-modal');
      var s = document.querySelector('#slots .slot[data-game="tenhalf"]');
      return {
        bustShown: b ? !b.classList.contains('hidden') : false,
        activeTenHalf: s ? s.classList.contains('is-active') : false,
        filledCards: document.querySelectorAll('#slots .card-box[data-card-id]').length
      };
    })()`);
    eq(after.bustShown, false, '★ 框合上了');
    ok(after.activeTenHalf, '★ 当前组切回十点半（合上就能动手改，不用自己找）');
    eq(after.filledCards, 6, '牌一张没少');

    /* d) 真去换一张：从别的组借一张能让十点半不爆的牌
     *    （手牌此刻是空的，6 张全在槽里，所以换牌等于两组对调一张） */
    console.log('\n[3c] 换成不爆的组合后再提交：正常放行');
    const swap = await evaluate(cdp, swapExpr(blocked.pair, blocked.hand));
    ok(!!swap, '找到一张能救十点半的牌', JSON.stringify(swap));
    if (swap) {
      const done = await evaluate(cdp, `(function(){
        function slotOf(id){
          var all = document.querySelectorAll('#slots .card-box[data-card-id]');
          for (var i = 0; i < all.length; i++) if (all[i].dataset.cardId === id) return all[i];
          return null;
        }
        var d = slotOf(${JSON.stringify('%DROP%')});
        if (!d) return { step: 'drop' };
        d.click();                                   /* 十点半那张回手里 */
        var a = slotOf(${JSON.stringify('%ADD%')});
        if (!a) return { step: 'add' };
        a.click();                                   /* 借来的那张也回手里 */
        var hd = document.querySelector('#hand .card-wrap[data-card-id="${'%DROP%'}"] img');
        if (!hd) return { step: 'handDrop' };
        hd.click();                                  /* 放回它原来的组 */
        var box = document.querySelector('#slots .slot[data-game="tenhalf"] .card-box:not([data-card-id])');
        if (box) box.click();                        /* 把当前组切回十点半 */
        var ha = document.querySelector('#hand .card-wrap[data-card-id="${'%ADD%'}"] img');
        if (!ha) return { step: 'handAdd' };
        ha.click();
        return { step: 'ok' };
      })()`.replace(/%DROP%/g, swap.drop).replace(/%ADD%/g, swap.add));
      eq(done.step, 'ok', '换牌流程走完（取回 → 对调 → 归位）', JSON.stringify(done));
      await sleep(500);
      const st2 = await evaluate(cdp, `(function(){
        var s = document.querySelector('#slots .slot[data-game="tenhalf"]');
        var p = s ? s.querySelector('.slot-point') : null;
        return {
          bust: s ? s.classList.contains('is-bust') : null,
          point: p ? p.textContent.trim() : null,
          filled: document.querySelectorAll('#slots .card-box[data-card-id]').length
        };
      })()`);
      console.log('    十点半 ' + JSON.stringify(st2));
      eq(st2.bust, false, '★ 十点半不再爆（' + st2.point + '）');
      eq(st2.filled, 6, '六张仍然各在各的组里');
      await evaluate(cdp, `document.getElementById('btn-submit').click()`);
      await sleep(500);
      const okDlg = await evaluate(cdp, `(function(){
        var c = document.getElementById('confirm-modal');
        var b = document.getElementById('bust-modal');
        if (!c || c.classList.contains('hidden')) return null;
        return { title: document.getElementById('confirm-title').textContent,
                 desc: document.getElementById('confirm-desc').textContent,
                 bustShown: b ? !b.classList.contains('hidden') : false };
      })()`);
      ok(!!okDlg, '★ 改好之后提交正常弹确认框（拦截不误伤）', JSON.stringify(okDlg));
      if (okDlg) {
        ok(/确认提交/.test(okDlg.title), '确认框标题正确', okDlg.title);
        eq(okDlg.bustShown, false, '没再弹拦截框');
        eq(okDlg.desc.indexOf('爆'), -1, '★ 确认框里不再有爆点警告（那件事已经在门口解决了）',
          okDlg.desc);
        console.log('    截图 ' + (await shot(cdp, 'tenhalf-submit-ok')));
        await evaluate(cdp, `document.getElementById('btn-confirm-cancel').click()`);
      }
    }
  }


  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('========================================');
  cdp.close();
  edge.kill();
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
