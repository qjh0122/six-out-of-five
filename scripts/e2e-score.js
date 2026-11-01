/**
 * 分数级 e2e（真浏览器 + 真 DOM + 独立复算）
 *
 * 为什么需要这条：现有的 25 条流程断言 + 55 组截图断言，**一条都没有验分数**。
 * 它们只回答「阶段走对了没」「东西放得下吗」，所以哪怕每人得失全错，也一直是绿的。
 * 而逐组结算要动的偏偏就是「什么时候写分数」——没有这条断言就是盲发。
 *
 * 这条脚本做三件事，缺一不可：
 *   ① 读**渲染出来的 DOM**（结算条每行的得失、座位卡的余额），不读内存变量；
 *   ② 在 Node 里用 `pwa/js/engine.js` **独立复算**同一个牌组的胜负与得分；
 *   ③ 断言三者一致：DOM == 引擎 == 逐组累加，且零和、名次单调、特写只给赢家。
 *
 * 只要这三条成立，「画面上显示的分数」就必然等于「线上引擎会算出的分数」。
 *
 * 用法：node scripts/e2e-score.js [--verbose]
 */
'use strict';

const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const Engine = require(path.join(__dirname, '..', 'pwa', 'js', 'engine.js'));

const CDP_PORT = 9457;
/* PROTO_FILE 只在做变异自测时用：把原型拷一份、故意改错一处分数，
 * 确认这条断言真的会红。默认永远打真原型。 */
const PROTO = process.env.PROTO_FILE
  ? path.resolve(process.env.PROTO_FILE)
  : path.join(__dirname, '..', 'docs', 'prototypes', 'circle-table.html');
const PAGE = 'file:///' + PROTO.replace(/\\/g, '/');
const VERBOSE = process.argv.includes('--verbose');
const CMP = { single: 'compareSingle', tenhalf: 'compareTenHalf', piaosanye: 'comparePiaoSanYe', douniu: 'compareDouNiu' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 覆盖矩阵：两个剧本（A 立刻见底 / B 打到第二轮）、四档人数、两种见底策略。
 * 人数 2 是最空的环、5 是最挤的一档；策略 keep 会缩 alive，是最容易出现
 * 「已出局的人还在结算条里分钱」的场景。 */
const MATRIX = [
  { scen: 'A', n: 5, policy: 'end' },
  { scen: 'A', n: 4, policy: 'end' },
  { scen: 'A', n: 3, policy: 'end' },
  { scen: 'A', n: 2, policy: 'end' },
  { scen: 'B', n: 5, policy: 'end' },
  { scen: 'B', n: 4, policy: 'end' },
  { scen: 'B', n: 3, policy: 'end' },
  { scen: 'B', n: 2, policy: 'end' },
  { scen: 'A', n: 5, policy: 'keep' },
  { scen: 'B', n: 5, policy: 'keep' }
];

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
      || JSON.stringify(r.exceptionDetails).slice(0, 600));
  }
  return r.result.value;
}

/* 在页面里走完全部场景，把每一幕「渲染出来的东西」抓回来。
 * 一次 evaluate 走完，避免几十次往返；goto() 内部是同步 render()，读完即准。 */
const WALK = `(function(){
  var P = window.__proto, SC = P.scenes(), out = [];
  function num(t){ if (t == null) return null; t = String(t).trim();
    if (!/^[+-]?\\d+$/.test(t)) return null; return parseInt(t, 10); }
  for (var i = 0; i < SC.length; i++){
    P.goto(i);
    var s = SC[i];
    var rec = { i:i, kind:s.kind, round:s.round, step:s.step,
                scores:s.scores, start:s.start, busts:(s.busts||[]).slice(), alive:(s.alive||[]).slice(),
                seats:{}, strip:null, final:null };
    [].forEach.call(document.querySelectorAll('.seat'), function(el){
      var key = el.getAttribute('data-seat');
      var sc = el.querySelector('.sc');
      rec.seats[key] = sc ? num(sc.textContent) : null;
    });
    /* 结算条只在 reveal / settle 两幕存在。final 幕虽然也带着 res（它要用最后那一组的胜负
     * 算谁是赢家），但托盘区画的是排行榜，不是结算条 —— 这里必须按 kind 判，不能只看 res。 */
    if (s.res && (s.kind === 'reveal' || s.kind === 'settle')){
      var rows = [].map.call(document.querySelectorAll('.sstrip .list .r'), function(r){
        var dl = r.querySelector('.dl');
        var ty = r.querySelector('.ty');
        return { p:r.getAttribute('data-p'), dlText: dl ? dl.textContent.trim() : null,
                 dl: dl ? num(dl.textContent) : null,
                 ty: ty ? ty.textContent.trim() : null,
                 win: (' ' + r.className + ' ').indexOf(' win ') >= 0,
                 spec: !!r.querySelector('.ty.spec') };
      });
      rec.strip = {
        mode: s.res.mode,
        rows: rows,
        resDelta: s.res.delta,
        resWinner: s.res.winner,
        fxKind: s.res.fx ? s.res.fx.kind : null,
        entries: s.res.entries.map(function(e){ return { k:e.k, cards:e.cards }; })
      };
    }
    if (s.kind === 'final'){
      var led = [];
      [].forEach.call(document.querySelectorAll('#design .ledger tr'), function(tr){
        var tds = [].slice.call(tr.querySelectorAll('td'));
        if (tds.length >= 2) led.push(tds.map(function(td){ return td.textContent.trim(); }));
      });
      rec.final = led;
    }
    out.push(rec);
  }
  return JSON.stringify(out);
})()`;

let pass = 0, fail = 0;
const fails = [];
function check(scope, name, cond, detail) {
  if (cond) { pass++; if (VERBOSE) console.log('  ok   ' + name); }
  else {
    fail++;
    const line = '[' + scope + '] ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '');
    fails.push(line);
    console.log('  FAIL ' + line);
  }
}

/* 引擎复算：入参就是 DOM 上那一组牌 */
function recompute(mode, entries) {
  const hands = entries.map((e) => ({
    id: e.k,
    hand: e.cards.map((c) => ({ rank: c[0], suit: c[1] }))
  }));
  const st = Engine.settleGroup(mode, hands);
  const cmp = Engine[CMP[mode]];
  if (typeof cmp !== 'function') throw new Error('引擎没有导出比较器：' + mode + ' → ' + CMP[mode]);
  const order = hands.slice().sort((a, b) => cmp(b.hand, a.hand)).map((h) => h.id);
  return { st, order, hands };
}

function auditRun(scope, run) {
  const startScores = run[0].scores;
  const acc = Object.assign({}, startScores);
  const seatKeys = Object.keys(startScores);

  let groups = 0;
  const applied = {};        // "R1G0" -> true，reveal / settle 是同一组，只算一次
  let lastFinal = null;

  for (const sc of run) {
    /* ---------- 每一幕：座位卡余额必须等于场景里记录的分 ---------- */
    for (const k of seatKeys) {
      check(scope, `#${sc.i} ${sc.kind} 座位卡 ${k} 显示 ${sc.scores[k]}`,
        sc.seats[k] === sc.scores[k], { dom: sc.seats[k], scene: sc.scores[k] });
    }

    if (!sc.strip) { if (sc.kind === 'final') lastFinal = sc; continue; }
    /* 兜底：结算条上一个人都没有，说明渲染层出问题了，不能静默跳过 */
    if (!sc.strip.rows.length) {
      check(scope, '#' + sc.i + ' ' + sc.kind + ' 结算条有行', false, { rows: 0, entries: sc.strip.entries.length });
      continue;
    }

    const mode = sc.strip.mode;
    const key = 'R' + sc.round + 'G' + sc.step;
    const eng = recompute(mode, sc.strip.entries);
    const isSettle = sc.kind === 'settle';

    /* ---------- 引擎自身：零和 ---------- */
    if (isSettle) {
      const sum = Object.keys(eng.st.deltas).reduce((a, k) => a + eng.st.deltas[k], 0);
      check(scope, key + ' 零和', sum === 0, sum);
      groups++;
    }

    /* ---------- 名次：DOM 行序 == 引擎比较器降序 ---------- */
    const domOrder = sc.strip.rows.map((r) => r.p);
    check(scope, key + ' 名次与引擎比较器一致', JSON.stringify(domOrder) === JSON.stringify(eng.order),
      { dom: domOrder, eng: eng.order });

    /* ---------- 赢家 ---------- */
    check(scope, key + ' 第一行就是引擎判的赢家', domOrder[0] === eng.st.winnerId,
      { dom: domOrder[0], eng: eng.st.winnerId });
    check(scope, key + ' 第一行挂了赢家底', sc.strip.rows[0].win === true);
    check(scope, key + ' 原型 res.winner == 引擎', sc.strip.resWinner === eng.st.winnerId,
      { proto: sc.strip.resWinner, eng: eng.st.winnerId });

    /* ---------- 特写标签只在赢家那一行 ---------- */
    for (let i = 1; i < sc.strip.rows.length; i++) {
      check(scope, key + ' 第 ' + (i + 1) + ' 行没有特殊标签', sc.strip.rows[i].spec === false);
    }
    check(scope, key + ' 特殊标签与特写同源', sc.strip.rows[0].spec === !!sc.strip.fxKind);

    /* ---------- 分数：核心三条 ---------- */
    for (const row of sc.strip.rows) {
      const p = row.p;
      if (isSettle) {
        check(scope, key + ' ' + p + ' DOM 得失 == 引擎', row.dl === eng.st.deltas[p],
          { dom: row.dl, eng: eng.st.deltas[p] });
        check(scope, key + ' ' + p + ' 原型 delta == 引擎', sc.strip.resDelta[p] === eng.st.deltas[p],
          { proto: sc.strip.resDelta[p], eng: eng.st.deltas[p] });
      } else {
        /* 揭晓幕还没结算，不能提前泄露得失 */
        check(scope, key + ' ' + p + ' 揭晓幕不显示得失', row.dl === null && row.dlText === '待结算',
          { text: row.dlText });
      }
      check(scope, key + ' ' + p + ' 牌型文案非空', !!row.ty && row.ty.length > 0, row.ty);
    }

    /* ---------- 逐组累加：场景分 == 上一幕 + 本组得失 ---------- */
    if (isSettle && !applied[key]) {
      applied[key] = true;
      for (const k of seatKeys) {
        const d = eng.st.deltas[k];
        /* 不在 deltas 里的人已经出局，不参与这一组：余额必须冻结在上一次的数值，
         * 而且那个数值必须 <= 0（「见底才出局」这件事的账目证据）。 */
        const want = (d === undefined) ? acc[k] : acc[k] + d;
        check(scope, key + ' ' + k + ' 累计 ' + acc[k] + ' → ' + want, sc.scores[k] === want,
          { scene: sc.scores[k], want, out: d === undefined });
        if (d === undefined) {
          check(scope, key + ' 未参与者 ' + k + ' 余额 <= 0（已出局）', acc[k] <= 0, acc[k]);
        }
        acc[k] = want;
      }
    }
  }

  /* ---------- 收口：终局分数 == 起始 + 所有组得失之和 ---------- */
  const finalScene = run[run.length - 1];
  for (const k of seatKeys) {
    check(scope, '终局 ' + k + ' 余额 == 起始 + Σ得失', finalScene.scores[k] === acc[k],
      { final: finalScene.scores[k], acc: acc[k] });
  }

  /* ---------- 有人见底时，余额必须 <= 0 ---------- */
  for (const sc of run) {
    if (!sc.busts || !sc.busts.length) continue;
    for (const k of sc.busts) {
      check(scope, '见底 ' + k + ' 余额 <= 0', sc.scores[k] <= 0, sc.scores[k]);
    }
    break;
  }

  return { groups, final: finalScene };
}

async function main() {
  const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const edge = spawn(exe, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + path.join(os.tmpdir(), 'lxw-score-' + Date.now()),
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

  const boot = await evaluate(cdp, `(function(){
    if (!window.Engine) return 'no-engine';
    if (!window.__proto) return 'no-proto';
    return 'ok';
  })()`);
  if (boot !== 'ok') { console.error('原型没有正常启动：' + boot); cdp.close(); edge.kill(); process.exit(1); }

  const clickSeg = (id, v) => `(function(){
    var b = document.querySelector('#${id} [data-v="${v}"]');
    if (!b) throw new Error('missing ${id} ${v}');
    b.click(); return true;
  })()`;

  let totalGroups = 0;
  const summary = [];

  for (const cfg of MATRIX) {
    const scope = `${cfg.scen} · ${cfg.n}人 · ${cfg.policy}`;
    console.log('\n=== ' + scope + ' ===');
    await evaluate(cdp, clickSeg('seg-n', String(cfg.n)));
    await evaluate(cdp, clickSeg('seg-scen', cfg.scen));
    await evaluate(cdp, clickSeg('seg-policy', cfg.policy));
    await sleep(60);

    const raw = await evaluate(cdp, WALK);
    const run = JSON.parse(raw);
    const before = fail;
    const r = auditRun(scope, run);
    totalGroups += r.groups;
    summary.push({ scope, scenes: run.length, groups: r.groups, fail: fail - before });
    console.log('  幕数 ' + run.length + '、结算组数 ' + r.groups + '、断言失败 ' + (fail - before));
  }

  await evaluate(cdp, clickSeg('seg-policy', 'end'));
  await evaluate(cdp, clickSeg('seg-n', '5'));

  console.log('\n──────── 汇总 ────────');
  summary.forEach((s) => {
    console.log('  ' + s.scope.padEnd(22) + ' 幕 ' + String(s.scenes).padStart(2)
      + ' · 组 ' + String(s.groups).padStart(2) + ' · 失败 ' + s.fail);
  });
  console.log('  合计结算组数：' + totalGroups);
  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  if (fail) fails.slice(0, 20).forEach((l) => console.log('  · ' + l));

  cdp.close();
  edge.kill();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
