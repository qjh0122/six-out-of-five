/**
 * 逐组结算探针（一次性诊断脚本，不进测试套件）
 *
 * 验的是「一次结算里有 3 组，一幕一组自动推进」这件事：
 *   · 结算弹窗一出现只有 1 张组卡（不是一次铺满 3 张）
 *   · **不点任何东西**，3 秒后自己走到第 2 幕（?hold= 缩短到 0.6s 才跑得动）
 *   · 末幕之后自动关掉，接一张轮次交替卡（本轮各家净得 + 下一轮预告）
 *   · 交替卡自己也会消失
 *
 * 为什么必须真浏览器：这件事**全部**发生在计时器与真实布局之间 ——
 * 静态断言能查「有没有 setTimeout」，查不出「两个计时器同时推进两幕」
 * 「交替卡被之后的一次 render 顶掉」「进度条时长和文案说的时间不一致」。
 *
 * 用法：node scripts/probe-result-seq.js [宽] [高]
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const W = Number(process.argv[2]) || 390;
const H = Number(process.argv[3]) || 844;
const SRV_PORT = 3031;
const CDP_PORT = 9343;
const SHOTS = process.env.ZOOM !== '0';
const SHOT_DIR = path.join(os.tmpdir(), 'lxw-result-seq');

/* 补几个 AI。默认 3 个 = 4 人局；BOTS=4 是 5 人局（默认最大人数，
 * 也是结算卡最高的一档：5 家 × 5 张迷你牌）。 */
const BOTS = Number(process.env.BOTS || 3);

/* 探针节奏：0.6 秒一幕。**只影响等待**，内容与顺序都是真的。 */
const HOLD_S = 0.6;
const HOLD_MS = Math.round(HOLD_S * 1000);

let serverProc = null;
function startApp() {
  serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(SRV_PORT),
      PROFILE_FILE: path.join(os.tmpdir(), 'lxw-seq-' + Date.now(), 'profiles.json'),
      SEED_FILE: path.join(os.tmpdir(), 'lxw-seq-seed-' + Date.now() + '.json')
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
        if (tries > 60) return reject(new Error('服务端没起来'));
        setTimeout(tick, 250);
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
        close() { try { ws.close(); } catch (e) { /* 已关 */ } }
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
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}

/* 配牌：第一轮 6 张（十点半 2 / 单张 1 / 飘三叶 3），第二轮 6 张（单张 1 / 斗牛 5）。
 * 十点半那两张取「最小的非王」—— onSubmit 有一条爆点硬拦（有更好的打法时不让提交），
 * 随机配牌撞上爆点会让探针永远提交不了，看起来像「结算从来没触发」。 */
const PLACE_FN = `
  function handIds(){
    return [].slice.call(document.querySelectorAll('#hand .card-wrap img.card'))
      .map(function (i) { return i.dataset.cardId; }).filter(Boolean);
  }
  function tenths(id){
    var rank = Number(String(id).split('-')[1]);
    if (!(rank > 0)) return 990;
    if (rank >= 11 && rank <= 13) return 5;
    return rank * 10;
  }
  function isJoker(id){ return Number(String(id).split('-')[1]) === 15; }
  /* 十点半配牌：必须选一对**不爆**的，否则 onSubmit 会弹爆点拦截框
   * （blockBustSubmit：手里还有不爆的组合时不让提交），探针就永远提交不了 ——
   * 这一条踩过一次：随机撞上两张都是 6 以上，第一轮整段卡在 bust-modal 上，
   * 后面 30 多条断言全红，看起来像功能坏了。
   * 选法：所有不爆的对子里挑点数最高的一对（更接近十点半，也更像真人打牌）；
   * 一对都不剩（真·必爆）时就随便取两张小的 —— 那种情况下拦截框不会挡。 */
  function bestPair(ids){
    var plain = ids.filter(function (id) { return !isJoker(id); });
    var best = null;
    for (var i = 0; i < plain.length; i++) {
      for (var j = i + 1; j < plain.length; j++) {
        var sum = tenths(plain[i]) + tenths(plain[j]);
        if (sum > 105) continue;
        if (!best || sum > best.sum) best = { sum: sum, a: plain[i], b: plain[j] };
      }
    }
    if (!best) {
      plain.sort(function (a, b) { return tenths(a) - tenths(b); });
      best = { sum: 0, a: plain[0], b: plain[1] };
    }
    return best;
  }
`;

async function main() {
  startApp();
  await waitApp();
  console.log('应用服务 :' + SRV_PORT);

  const userDir = path.join(os.tmpdir(), 'lxw-seq-edge-' + Date.now());
  const edge = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
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
      const p = (list || []).find((t) => t.type === 'page');
      if (p) { page = p; break; }
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

  const shot = async (name) => {
    if (!SHOTS) return '';
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = path.join(SHOT_DIR, name + '-' + W + 'x' + H + '.png');
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
    return f;
  };

  /* ★ 量布局前先把动画跳到最后。组卡的入场是 translateX(40px) → 0，
   * 在动画中途量，右边界比最终位置多出 20 设计 px —— 「横向溢出」会在
   * 完全正常的布局上红掉（这一条踩过）。getAnimations().finish() 把它按到终点，
   * 而且不影响后面的断言（进度条的时长是读 computedStyle，不是读动画进度）。 */
  const settleAnim = () => evaluate(`(function(){
    try {
      if (document.getAnimations) {
        document.getAnimations().forEach(function (a) { try { a.finish(); } catch (e) {} });
      }
    } catch (e) {}
    return 1;
  })()`);

  const meta = () => evaluate(`(function(){
    var m = document.getElementById('result-modal');
    var t = document.getElementById('result-title');
    var n = document.getElementById('result-next');
    var b = document.getElementById('btn-result-close');
    var g = document.getElementById('result-groups');
    var bar = document.querySelector('.result-seq-bar > i');
    return {
      open: !!(m && !m.classList.contains('hidden')),
      step: Number((m && m.dataset.step) || -1),
      steps: Number((m && m.dataset.steps) || -1),
      hold: Number((m && m.dataset.hold) || -1),
      title: t ? (t.textContent || '').trim() : '',
      next: n ? (n.textContent || '').trim() : '',
      btn: b ? (b.textContent || '').trim() : '',
      cards: g ? g.querySelectorAll('.result-group').length : -1,
      barAnim: bar ? getComputedStyle(bar).animationName : '',
      barDur: bar ? getComputedStyle(bar).animationDuration : ''
    };
  })()`);

  const brk = () => evaluate(`(function(){
    var m = document.getElementById('round-break-modal');
    var t = document.getElementById('rb-title');
    var n = document.getElementById('rb-next');
    var b = document.getElementById('rb-body');
    return {
      open: !!(m && !m.classList.contains('hidden')),
      title: t ? (t.textContent || '').trim() : '',
      next: n ? (n.textContent || '').trim() : '',
      rows: b ? b.querySelectorAll('.rb-row').length : -1,
      me: b ? b.querySelectorAll('.rb-row.me').length : -1,
      deltas: b ? [].slice.call(b.querySelectorAll('.rb-delta')).map(function(e){ return (e.textContent||'').trim(); }) : []
    };
  })()`);

  /* ---------------------------- 进牌桌 ---------------------------- */
  console.log('\n[1] 注册 → 建房 → 补 3 个 AI → 开局');
  /* `patternfx=0`：牌型特写幕会给「大牌型那一幕」多停 1.6 秒（v98）。
   * 那是**另有专门审计**的一件事（scripts/audit-pattern-fx.js 的 S4 特写幕），
   * 而这个探针验的是「自动推进的节奏」—— 不关掉的话，
   * 随机发到一次牛牛，这一节的 600ms 间隔断言就会变成 2200ms 而误报。 */
  const target = 'http://127.0.0.1:' + SRV_PORT + '/?hold=' + HOLD_S + '&patternfx=0';
  await cdp.send('Page.navigate', { url: target });
  await sleep(1600);
  /* 新手引导会自动弹，而它排在 Esc 关闭链最前面 —— 也会挡住牌桌 */
  await evaluate(`(function(){ try { localStorage.setItem('lxw_guide_seen_v1','1'); }catch(e){} return 1; })()`);
  await cdp.send('Page.navigate', { url: target });
  await sleep(1500);

  const flow = await evaluate(`(async function(){
    function click(id){ var b = document.getElementById(id); if (b) { b.click(); return true; } return false; }
    function vis(id){ var e = document.getElementById(id); return !!(e && !e.classList.contains('hidden')); }
    var r = {};
    /* 注册可能撞上单 IP 限流（429）→ 退到固定账号登录 */
    var tab = document.querySelector('[data-auth-tab="register"]');
    if (tab) tab.click();
    await new Promise(s => setTimeout(s, 250));
    document.getElementById('auth-name').value = 'seq' + Math.floor(Math.random() * 1000000);
    document.getElementById('auth-pass').value = 'probe123456';
    var nick = document.getElementById('auth-nick');
    if (nick && !nick.closest('.hidden')) nick.value = '探针';
    click('btn-auth-submit');
    await new Promise(s => setTimeout(s, 1800));
    r.registered = vis('screen-home');
    if (!r.registered) {
      var tl = document.querySelector('[data-auth-tab="login"]');
      if (tl) tl.click();
      await new Promise(s => setTimeout(s, 250));
      document.getElementById('auth-name').value = 'probezz9001';
      document.getElementById('auth-pass').value = 'probe123456';
      click('btn-auth-submit');
      await new Promise(s => setTimeout(s, 1800));
      r.loggedIn = vis('screen-home');
    }
    var ni = document.getElementById('nickname-input');
    if (ni) { ni.value = '探针'; ni.dispatchEvent(new Event('input', { bubbles: true })); }
    click('btn-create');
    await new Promise(s => setTimeout(s, 500));
    r.bots = 0;
    for (var i = 0; i < ${BOTS}; i++) {
      var b = document.getElementById('btn-add-bot');
      if (!b || b.classList.contains('hidden')) break;
      b.click();
      r.bots += 1;
      await new Promise(s => setTimeout(s, 700));
    }
    click('btn-ready');
    await new Promise(s => setTimeout(s, 1000));
    r.gameVisible = vis('screen-game');
    return r;
  })()`);
  console.log('  ' + JSON.stringify(flow));
  if (!flow || !flow.gameVisible) {
    console.log('⚠ 没进到牌桌，后面的断言不可信');
    edge.kill(); if (serverProc) serverProc.kill();
    process.exit(1);
  }

  /* 等分牌真的渲染出来 */
  for (let i = 0; i < 40; i++) {
    const n = await evaluate(`document.querySelectorAll('#slots .slot').length`);
    if (n >= 3) break;
    await sleep(250);
  }

  /* ---------------------------- 跑第一轮 ---------------------------- */
  console.log('\n[2] 第一轮配牌并提交');
  const r1 = await evaluate(`(async function(){
    ${PLACE_FN}
    var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    function vis(id){ var e = document.getElementById(id); return !!(e && !e.classList.contains('hidden')); }
    async function place(steps){
      for (var s = 0; s < steps.length; s++) {
        var chip = document.querySelector('.gchip[data-group="' + steps[s].group + '"]');
        if (chip) { chip.click(); await sleep(150); }
        for (var i = 0; i < (steps[s].ids || []).length; i++) {
          var c = document.querySelector('#hand .card-wrap img.card[data-card-id="' + steps[s].ids[i] + '"]')
            || document.querySelector('#hand .card-wrap img.card');
          if (!c) break;
          c.click();
          await sleep(150);
        }
      }
    }
    var ids = handIds();
    var pair = bestPair(ids);
    /* 剩下的 4 张：1 张给单张、3 张给飘三叶。用 filter 而不是 slice，
     * 避免挑中的那一对不在数组前两位时把同一张牌放两次。 */
    var rest = ids.filter(function (id) { return id !== pair.a && id !== pair.b; });
    await place([
      { group: 'tenhalf', ids: [pair.a, pair.b] },
      { group: 'single', ids: rest.slice(0, 1) },
      { group: 'piaosanye', ids: rest.slice(1, 4) }
    ]);
    var btn = document.getElementById('btn-submit');
    var canSubmit = !!(btn && !btn.disabled);
    if (canSubmit) btn.click();
    await sleep(400);
    var okb = document.getElementById('btn-confirm-ok');
    if (vis('confirm-modal') && okb) okb.click();
    /* 真被拦了就把弹窗收起来，让后面的日志能看清是「配牌问题」而不是「结算没来」。 */
    var busted = vis('bust-modal');
    if (busted) { var fx = document.getElementById('btn-bust-fix'); if (fx) fx.click(); }
    return { canSubmit: canSubmit, bustBlocked: busted, pair: pair.sum };
  })()`);
  console.log('  ' + JSON.stringify(r1));

  /* ---------------------------- [3][4] 一幕一组 + 自动推进 ----------------------------
   * ★ 这里不能「读一次 step 就睡 hold，再读一次」：序列从**弹窗出现的那一刻**就开始走，
   *   探针发现它的时候可能已经过去两三百毫秒，那点差会被误判成「跳过了一幕」。
   *   正确做法是从提交完成后就一直采样，把每一次 step 变化和时刻记下来。
   *
   * 截图故意不 await（拿不到就不存）：等它会把后面的采样顶后 100~300ms，
   * 而这里量的是节奏，探针自己不能成为节奏的一部分。 */
  console.log('\n[3] 结算弹窗：一幕一组，自己往前走');
  /* 先等它出现再开始采样。★ 不能把「现在没开」直接当成「已经放完了」——
   * 提交之后是 AI 的提交延迟 + 服务端结算 + WS 广播，弹窗要过一会儿才来；
   * 第一版就是这么写的，第一次采样读到「没开」直接退出循环，
   * 后面每条断言都对着 null 判，红得像功能没做。 */
  let m0 = null;
  let waited = 0;
  while (waited < 12000) {
    const s = await meta();
    if (s && s.open) { m0 = s; break; }
    await sleep(60); waited += 60;
  }
  const trace = [];
  let lastStep = -1;
  let shotStep1 = '';
  let shotStep3 = '';
  const tStart = Date.now();
  /* ★ 一个 4 人组的结算卡必须**不用滚**就能看完。
   * 这是横屏真正的坑：390 CSS 高 → 750 设计高，卡片顶到 max-height 之后
   * #result-groups 变成一个滚动区，第 4 家（常常就是赢家行）落在折叠线以下 ——
   * 而「卡片在视口内」这条断言照样绿，因为溢出发生在**卡内**。
   * ★ 必须在弹窗开着的时候量：放到序列放完之后量，元素已经 hidden，
   *   三个尺寸全是 0，断言就成了永真（第一版就是这么写的）。 */
  let fit = null;
  if (m0) {
    await settleAnim();
    fit = await evaluate(`(function(){
      var g = document.getElementById('result-groups');
      if (!g) return null;
      var card = g.closest('.modal-card');
      var modal = document.getElementById('result-modal');
      return {
        over: g.scrollHeight - g.clientHeight,
        sh: g.scrollHeight, ch: g.clientHeight, rows: g.querySelectorAll('.result-row').length,
        cardH: Math.round(card.getBoundingClientRect().height),
        cardMax: getComputedStyle(card).maxHeight,
        modalH: Math.round(modal.getBoundingClientRect().height),
        vh: innerHeight
      };
    })()`);
    console.log('  卡片尺寸：' + JSON.stringify(fit));
  }
  ok(fit && fit.rows === BOTS + 1 && fit.over <= 2,
    '★ ' + (BOTS + 1) + ' 人局的结算卡不用滚就能看完（溢出 ' + (fit && fit.over) + '）', fit);

  if (m0) {
    trace.push({ step: m0.step, at: 0 });
    lastStep = m0.step;
    shotStep1 = shot('seq-step1');
    while (Date.now() - tStart < 12000) {
      const s = await meta();
      const cur = s && s.open ? s.step : -2;
      if (cur !== lastStep) {
        trace.push({ step: cur, at: Date.now() - tStart });
        if (cur === 2) shotStep3 = shot('seq-step3');
        lastStep = cur;
      }
      if (cur === -2) break;
      await sleep(60);
    }
  }
  console.log('  采样：' + JSON.stringify(trace));

  const steps = trace.map((t) => t.step);
  ok(JSON.stringify(steps) === JSON.stringify([0, 1, 2, -2]),
    '★ 顺序是 0 → 1 → 2 → 关闭，一步不跳也不少', steps);
  ok(m0 && m0.steps === 3, '★ 第一轮拆成 3 幕（不是一次铺满）', m0 && m0.steps);
  ok(m0 && m0.cards === 1, '★ 每一幕只画 1 张组卡（实际 ' + (m0 && m0.cards) + '）');
  ok(m0 && /第 1\/3 组/.test(m0.title), '标题带「第 1/3 组」', m0 && m0.title);
  ok(m0 && m0.btn === '下一组', '按钮是「下一组」而不是「继续游戏」', m0 && m0.btn);
  ok(m0 && /下一组/.test(m0.next) && /秒后自动/.test(m0.next), '脚注说清「下一组 · N 秒后自动」', m0 && m0.next);
  ok(m0 && m0.hold === HOLD_MS, '节奏读到了 ?hold=（' + HOLD_MS + 'ms）', m0 && m0.hold);
  /* 进度条：时长必须等于 hold，不是 CSS 里写死的兜底值。
   * 文案里的秒数与它是同源的，所以这一条同时守「说几秒就跑几秒」。 */
  ok(m0 && m0.barAnim === 'seqBar' && Math.abs(parseFloat(m0.barDur) * 1000 - HOLD_MS) < 60,
    '★ 进度条时长 = 节奏（' + (m0 && m0.barDur) + ' vs ' + HOLD_MS + 'ms）', m0 && [m0.barAnim, m0.barDur]);

  /* 节奏：相邻两幕的间隔应该≈hold。松 260ms 是给采样间隔（60ms）+ CDP 往返留的余量，
   * 再松就测不出「根本没走」了 —— 这一条要抓的正是「停在第一幕」 */
  const gap01 = (trace[1] ? trace[1].at : 0) - (trace[0] ? trace[0].at : 0);
  const gap12 = (trace[2] ? trace[2].at : 0) - (trace[1] ? trace[1].at : 0);
  ok(gap01 >= HOLD_MS - 60 && gap01 <= HOLD_MS + 300, '★ 第 1→2 幕自己走的（' + gap01 + 'ms）', gap01);
  ok(gap12 >= HOLD_MS - 60 && gap12 <= HOLD_MS + 300, '★ 第 2→3 幕自己走的（' + gap12 + 'ms）', gap12);

  const closeAt = (trace[3] ? trace[3].at : 0);
  ok(closeAt > 0, '★ 末幕之后弹窗自己关掉（' + closeAt + 'ms 处）', closeAt);

  /* ---------------------------- [5] 交替卡 ---------------------------- */
  console.log('\n[5] 末幕之后 → 轮次交替卡');
  let b0 = null;
  let b0At = 0;
  for (let i = 0; i < 30; i++) {
    b0 = await brk();
    if (b0 && b0.open) { b0At = Date.now(); break; }
    await sleep(80);
  }
  /* 截图不 await：这张卡只停一个节奏（600ms），等一张截图就把「它自己会关」
   * 这件要测的事给测没了 —— 第一次就是这么红的（量到 353ms）。 */
  const shotBreak = shot('seq-break');
  ok(b0 && b0.open, '★ 第一轮打完插了一张轮次交替卡', b0);
  ok(b0 && b0.rows === BOTS + 1,
    '★ 卡上每家一行净得（' + (BOTS + 1) + ' 人局，实际 ' + (b0 && b0.rows) + ' 行）');
  ok(b0 && b0.me === 1, '我那一行有标记（金线），且只有一行', b0 && b0.me);
  ok(b0 && /第一轮结束/.test(b0.title), '标题「第一轮结束」', b0 && b0.title);
  ok(b0 && /单张|比大小/.test(b0.next) && /斗牛/.test(b0.next),
    '★ 预告下一轮的组顺序（单张 → 斗牛）', b0 && b0.next);
  ok(b0 && b0.deltas.length === BOTS + 1 && b0.deltas.every(function (d) { return /^[+-]?\d+$/.test(d); }),
    '净得是带符号的整数', b0 && b0.deltas);

  /* 净得之和必须为 0：零和局里「所有人加总」只能是 0，
   * 不是 0 就说明哪一组的 deltas 没加进去（或者加了两遍） */
  const sum = (b0.deltas || []).reduce(function (a, d) { return a + Number(d); }, 0);
  ok(sum === 0, '★ 各家净得加总为 0（零和：漏算/重复算都会露出来）', sum);

  /* 交替卡也要自己走：一局 5 次结算，每次都要人点一下就太吵了。
   * 计时从**第一次看到它开着**算起，不是从断言结束算起 —— 后者会被截图和
   * CDP 往返吃掉大半，看起来像「它根本没停」。 */
  let b1 = b0;
  let b1At = 0;
  const deadline = Date.now() + HOLD_MS * 4;
  while (Date.now() < deadline) {
    b1 = await brk();
    if (!b1.open) { b1At = Date.now(); break; }
    await sleep(50);
  }
  ok(b1 && !b1.open, '★ 交替卡自己消失（不用点）', b1);
  const brkHeld = b1At - b0At;
  ok(brkHeld >= HOLD_MS - 160 && brkHeld <= HOLD_MS + 420,
    '★ 交替卡停一个节奏就走（' + brkHeld + 'ms ≈ ' + HOLD_MS + 'ms）', brkHeld);

  /* ---------------------------- [6] 第二轮 ---------------------------- */
  console.log('\n[6] 第二轮照常能打');
  await sleep(400);
  const round2 = await evaluate(`(function(){
    return {
      douniu: !!document.querySelector('#slots .slot[data-game="douniu"]'),
      slots: document.querySelectorAll('#slots .slot').length,
      hand: document.querySelectorAll('#hand .card-wrap').length,
      anyModal: [].slice.call(document.querySelectorAll('.modal'))
        .filter(function (m) { return !m.classList.contains('hidden'); })
        .map(function (m) { return m.id; })
    };
  })()`);
  ok(round2 && round2.douniu, '★ 进到第二轮（斗牛组出现）', round2);
  ok(round2 && round2.anyModal.length === 0, '这一屏没有残留弹窗挡着牌桌', round2 && round2.anyModal);

  /* ---------------------------- [7] 第二轮：斗牛 5 张（最挤的一档） ----------------------------
   * 第一轮的「比大小」一家只有 1 张迷你牌，是最宽松的一档；
   * 真正会撑破卡片的是斗牛 —— 一家 5 张。这一节必须单独量，
   * 不然「4 行放得下」会给人一种「都放得下」的错觉。 */
  console.log('\n[7] 第二轮 · 斗牛 5 张');
  const r2 = await evaluate(`(async function(){
    ${PLACE_FN}
    var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    function vis(id){ var e = document.getElementById(id); return !!(e && !e.classList.contains('hidden')); }
    async function place(steps){
      for (var s = 0; s < steps.length; s++) {
        var chip = document.querySelector('.gchip[data-group="' + steps[s].group + '"]');
        if (chip) { chip.click(); await sleep(150); }
        for (var i = 0; i < (steps[s].ids || []).length; i++) {
          var c = document.querySelector('#hand .card-wrap img.card[data-card-id="' + steps[s].ids[i] + '"]')
            || document.querySelector('#hand .card-wrap img.card');
          if (!c) break;
          c.click();
          await sleep(140);
        }
      }
    }
    var ids = handIds();
    await place([
      { group: 'single', ids: ids.slice(0, 1) },
      { group: 'douniu', ids: ids.slice(1, 6) }
    ]);
    var btn = document.getElementById('btn-submit');
    var canSubmit = !!(btn && !btn.disabled);
    if (canSubmit) btn.click();
    await sleep(400);
    var okb = document.getElementById('btn-confirm-ok');
    if (vis('confirm-modal') && okb) okb.click();
    return { canSubmit: canSubmit, placed: document.querySelectorAll('#slots .card-box[data-card-id]').length };
  })()`);
  console.log('  ' + JSON.stringify(r2));

  /* 等第二轮的结算弹窗 */
  let m2 = null;
  let waited2 = 0;
  while (waited2 < 15000) {
    const s = await meta();
    if (s && s.open) { m2 = s; break; }
    await sleep(60); waited2 += 60;
  }
  ok(m2 && m2.steps === 2, '★ 第二轮拆成 2 幕（比大小 + 斗牛）', m2 && m2.steps);

  /* 走到第 2 幕（斗牛），量它 */
  if (m2 && m2.steps === 2 && m2.step === 0) {
    await evaluate(`document.getElementById('btn-result-close').click()`);
    await sleep(120);
  }
  const m2b = await meta();
  ok(m2b && m2b.step === 1, '点到第 2 幕（斗牛）', m2b);

  await settleAnim();
  const fit2 = await evaluate(`(function(){
    var g = document.getElementById('result-groups');
    if (!g) return null;
    var cards = g.querySelectorAll('.result-row .result-cards .mini-card');
    var firstRow = g.querySelector('.result-row');
    return {
      over: g.scrollHeight - g.clientHeight,
      sh: g.scrollHeight, ch: g.clientHeight,
      rows: g.querySelectorAll('.result-row').length,
      maxCards: Math.max.apply(null, [].slice.call(g.querySelectorAll('.result-row')).map(function (r) {
        return r.querySelectorAll('.mini-card').length;
      })),
      cardW: cards.length ? Math.round(cards[0].getBoundingClientRect().width) : 0,
      rowH: firstRow ? Math.round(firstRow.getBoundingClientRect().height) : 0,
      group: (g.querySelector('.result-group') || {}).dataset ? g.querySelector('.result-group').dataset.game : '',
      /* ★ 横向也要量：两列网格里 1fr 的最小值是内容宽度，
       * 5 张牌那一行会把列撑宽、整块从右边溢出卡片，分数被切掉 ——
       * 而纵向的 scrollHeight 完全看不出来（那是横向溢出）。 */
      gW: g.clientWidth, gR: Math.round(g.getBoundingClientRect().right),
      rowW: firstRow ? Math.round(firstRow.getBoundingClientRect().width) : 0,
      rowR: firstRow ? Math.round(firstRow.getBoundingClientRect().right) : 0,
      grpR: Math.round(g.querySelector('.result-group').getBoundingClientRect().right),
      overX: (function(){
        var box = g.getBoundingClientRect();
        var worst = 0;
        [].slice.call(g.querySelectorAll('.result-row')).forEach(function (r) {
          worst = Math.max(worst, r.getBoundingClientRect().right - box.right);
        });
        return Math.round(worst);
      })()
    };
  })()`);
  console.log('  斗牛卡尺寸：' + JSON.stringify(fit2));
  ok(fit2 && fit2.group === 'douniu', '第 2 幕确实是斗牛', fit2 && fit2.group);
  ok(fit2 && fit2.maxCards === 5, '★ 斗牛一家 5 张迷你牌', fit2 && fit2.maxCards);
  /* 一屏放不下时的退路是「滚」，但滚 + 3 秒自动推进 = 玩家根本看不到被滚掉的那一家。
   * 所以这条要求是硬的：不许靠滚。 */
  ok(fit2 && fit2.over <= 2, '★★ 斗牛 5 张也不用滚（溢出 ' + (fit2 && fit2.over) + '）', fit2);
  ok(fit2 && fit2.overX <= 2, '★★ 两列没有横向溢出（超出 ' + (fit2 && fit2.overX) + 'px）', fit2);
  /* 迷你牌在横屏被缩到 74 宽：不缩的话 5 张 + 名字 + 分数会把行撑出列宽，
   * 表现是分数被挤到下一行或右侧被切掉 —— 这一条守的就是那个「缩」真的生效了。 */
  if (W > H) {
    /* 竖屏是 88 设计宽 → 390 宽上约 46 CSS px。横屏必须明显更窄，
     * 否则 5 张牌那一行把列撑爆。阈值按「比竖屏窄一档」给，不写死 40 ——
     * 932×430 这种更宽的横屏缩放更大，写死会在另一档上假红。 */
    ok(fit2 && fit2.cardW > 0 && fit2.cardW <= 44,
      '★ 横屏迷你牌缩过一档（实测 ' + (fit2 && fit2.cardW) + ' CSS px，竖屏约 46）', fit2 && fit2.cardW);
  }
  const shotDn = await shot('seq-douniu');

  /* 收尾：把剩下的幕点完，确认没有残留 */
  for (let i = 0; i < 6; i++) {
    const s = await meta();
    if (!s || !s.open) break;
    await evaluate(`document.getElementById('btn-result-close').click()`);
    await sleep(120);
  }
  const closed = await meta();
  ok(closed && !closed.open, '点完之后弹窗真的关掉了（不会卡在最后一幕）', closed);

  /* ---------------------------- [8] 结算页：点行 = 这一把，点头像 = 这个人 ----------------------------
   * 这一节守的是**两个手势的分工**，而且它只能在这里验：
   *   · 点行 → 回放弹窗必须落在「刚打完的这一把」（.replay-pack.is-target 存在）
   *   · 点头像 → 玩家档案（不是回放）
   * 两条都不改任何数据，错了也不会崩 —— 只会让人点半天进不去想去的地方。
   *
   * 还顺手量一件只在真机上才看得出来的事：尾部箭头是绝对定位压在右内边距里的，
   * 它和净胜那列的字只差几个设计 px，压上去会被读成「负号」。 */
  console.log('\n[8] 结算页：点行 = 这一把，点头像 = 这个人');
  /* 交替卡上那颗按钮不是 .modal-x（它是「进入第二轮」的主按钮），
   * 所以这里单独点它 —— 它自己也会在一个节奏后消失，但探针不能等运气。 */
  await evaluate(`(function(){
    var m = document.getElementById('round-break-modal');
    if (m && !m.classList.contains('hidden')) {
      var b = document.getElementById('btn-rb-close');
      if (b) b.click();
    }
    return 1;
  })()`);
  /* ★ 为什么这里要主动「结束本局」：这一把只有两轮，而「第二轮打完且没人见底」
   * **不会**结算 —— 服务端直接 handCount+1 → dealAll 发下一把（见 stateMachine
   * 的轮次分支）。想站到结算页上，只有两条路：
   *   · 有人分数见底（要打好几把才凑得出来，探针等不起，也跑不稳）
   *   · 点「结束本局」（真人真实会走的一条路）
   * 而且 AI **不计入投票人**（dissolveVoters 只看真人 + 在线），
   * 所以这个房间里只有我一个人有票，点一下当场成立，不用等谁。
   *
   * 顺带说明这次跑的是哪条定位路径：结束的时候下一把已经发过牌了，
   * room.handId 指向**还没打完的那一把**，而过程数据里最后一把是刚打完的那把 ——
   * 于是 openReplayHere 走的是「定位不到 → 退回最后一把」这条兜底。
   * 精确命中的那条由 pwa/test/settle-replay.test.js 里对 replayTargetOf 的真跑守住。 */
  await evaluate(`(function(){
    var b = document.getElementById('btn-dissolve-game');
    if (b) b.click();
    return 1;
  })()`);
  await sleep(400);
  const dlg = await evaluate(`(function(){
    var m = document.getElementById('dissolve-modal');
    return !!(m && !m.classList.contains('hidden'));
  })()`);
  if (dlg) {
    await evaluate(`(function(){
      var b = document.getElementById('btn-dissolve-agree');
      if (b) b.click();
      return 1;
    })()`);
  }
  console.log('  结束本局：弹窗' + (dlg ? '出现并已同意' : '当场成立（只有我一个真人）'));

  let settleAt = -1;
  let settleTrace = [];
  for (let waited = 0; waited < 20000; waited += 120) {
    /* ★ 这里必须**区分「页面说没开」和「取值本身失败」**：
     * evaluate 出错时返回的是 { error } —— 一个对象，`if (vis)` 直接就是真，
     * 循环立刻 break，后面每条断言都对着空结构判。第一版就是这么红的。 */
    const vis = await evaluate(`(function(){
      var s = document.getElementById('screen-settle');
      return { vis: !!(s && !s.classList.contains('hidden')), rows: document.querySelectorAll('#settle-body .settle-row').length };
    })()`);
    settleTrace.push(Object.assign({ at: waited }, vis));
    if (vis && vis.vis && vis.rows > 0) { settleAt = waited; break; }
    await sleep(120);
  }
  if (settleAt < 0) console.log('  结算屏采样（最后 6 次）：' + JSON.stringify(settleTrace.slice(-6)));
  ok(settleAt >= 0, '★ 结束本局后进结算页且有行（等待 ' + settleAt + 'ms）', settleAt);
  /* 结算页的错峰入场（每行延迟 150ms）跑完再量，否则量到的是「飞进来一半」。 */
  await evaluate(`(function(){
    try {
      if (document.getAnimations) {
        document.getAnimations().forEach(function (a) { try { a.finish(); } catch (e) {} });
      }
    } catch (e) {}
    return 1;
  })()`);
  await sleep(200);

  const st = await evaluate(`(function(){
    var rows = [].slice.call(document.querySelectorAll('#settle-body .settle-row'));
    function cls(e) { return e ? (e.className || '') : ''; }
    var go = document.querySelector('#settle-body .settle-row .settle-go');
    var net = document.querySelector('#settle-body .settle-row .settle-net');
    var gb = go ? go.getBoundingClientRect() : null;
    var nb = net ? net.getBoundingClientRect() : null;
    var me = document.querySelector('#settle-body .settle-row.me');
    return {
      rows: rows.length,
      ranks: rows.filter(function (r) { return !!r.querySelector('.settle-rank'); }).length,
      /* 头像内容：真人/自己的行是 <img>，AI 在牌桌上是 🤖 —— 结算页必须同一套，
       * 否则同一局里同一个人两副面孔。两种都算「有头像」。 */
      avatars: rows.filter(function (r) {
        var k = r.querySelector('.settle-rank');
        return !!(k && k.querySelector('.avatar-img'));
      }).length,
      botFaces: rows.filter(function (r) {
        var k = r.querySelector('.settle-rank');
        return !!(k && k.textContent.indexOf('🤖') >= 0);
      }).length,
      crown: rows.filter(function (r) { return !!r.querySelector('.crown'); }).length,
      go: rows.filter(function (r) { return !!r.querySelector('.settle-go'); }).length,
      pos: rows.map(function (r) { var e = r.querySelector('.settle-pos'); return e ? e.textContent.trim() : ''; }),
      posFirst: (function () {
        var e = rows.length ? rows[0].querySelector('.settle-pos') : null;
        return e ? e.textContent.trim() : '';
      })(),
      aria: (function () {
        var e = rows.length ? rows[0].querySelector('.settle-rank') : null;
        return e ? { role: e.getAttribute('role'), tab: e.getAttribute('tabindex'), label: e.getAttribute('aria-label') } : null;
      })(),
      /* 列宽：冠军行是 72px 起，普通行 56px 起。
       * 断言的是「列数还是 4」—— 尾部箭头一旦进了 grid 就会变成第 5 列。 */
      cols: rows.length ? getComputedStyle(rows[0]).gridTemplateColumns : '',
      colsPlain: (function () {
        var p = rows.filter(function (r) { return !r.classList.contains('champion'); })[0];
        return p ? getComputedStyle(p).gridTemplateColumns : '';
      })(),
      rowH: rows.length ? Math.round(rows[0].getBoundingClientRect().height) : 0,
      /* 箭头整块落在右内边距里吗（净胜那列右边界距行右 19 设计 px） */
      gap: (gb && nb) ? Math.round(gb.left - nb.right) : -999,
      goHit: (function () {
        if (!gb) return '';
        var hit = document.elementFromPoint(Math.round(gb.left + gb.width / 2), Math.round(gb.top + gb.height / 2));
        return hit ? (cls(hit).split(' ')[0] || hit.tagName) : '';
      })(),
      hasMe: !!me,
      meRank: !!(me && me.querySelector('.settle-rank'))
    };
  })()`);
  /* 「一屏看全」要量的是**每一行和尾注都在视口里**，不是 #settle-body 的 scrollHeight：
   * 那个容器是 flex + max-height，scrollHeight 会把子元素外边距一起算进去
   * （实测 532，而内容明明只有 276 高），拿它当判据会在完全正常的页面上红掉。
   * 真机会出问题的地方只有一处：最后一行或尾注落到视口下面。 */
  const fitS = await evaluate(`(function(){
    var rows = [].slice.call(document.querySelectorAll('#settle-body .settle-row'));
    var tip = document.querySelector('#settle-body .settle-tip');
    var note = document.querySelector('#settle-body .settle-ai-note');
    function rb(e) { return e ? Math.round(e.getBoundingClientRect().bottom) : -1; }
    return {
      rows: rows.length,
      rowsBottom: rows.length ? rb(rows[rows.length - 1]) : -1,
      tipBottom: rb(tip),
      noteBottom: rb(note),
      vh: innerHeight,
      over: (function () { var b = document.getElementById('settle-body'); return b ? b.scrollHeight - b.clientHeight : -1; })()
    };
  })()`);
  console.log('  结算页：' + JSON.stringify(st));
  console.log('  结算页高度：' + JSON.stringify(fitS));
  ok(fitS && fitS.rowsBottom > 0 && fitS.rowsBottom <= fitS.vh,
    '★ 最后一行在视口内（底边 ' + (fitS && fitS.rowsBottom) + ' / 视口 ' + (fitS && fitS.vh) + '）', fitS);
  ok(fitS && fitS.noteBottom > 0 && fitS.noteBottom <= fitS.vh,
    '★ 尾注没被挤到视口外（底边 ' + (fitS && fitS.noteBottom) + '）', fitS);
  await shot('settle-row');
  ok(st && st.rows === BOTS + 1, '★ 结算页每家一行', st && st.rows);
  ok(st && st.ranks === st.rows, '★ 每一行都有头像（不再只有冠军有）', st && [st.ranks, st.rows]);
  ok(st && st.avatars + st.botFaces === st.rows,
    '★ 每一行都有头像内容（自己是 Avatar 图、AI 是 🤖），不是首字母色的圆',
    st && [st.avatars, st.botFaces, st.rows]);
  ok(st && st.botFaces === BOTS,
    '★ AI 在结算页也是 🤖（和牌桌座位、交替卡同一套面孔）', st && st.botFaces);
  ok(st && st.crown === 1, '冠军那一行有皇冠，且只有一行', st && st.crown);
  ok(st && st.pos[0] === '', '第 1 名不挂数字角标（皇冠已经说了）', st && st.pos);
  ok(st && st.pos.slice(1).join(',') === [2, 3, 4, 5].slice(0, BOTS).join(','),
    '★ 第 2 名起的角标 = 名次', st && st.pos);
  ok(st && st.go === st.rows, '每一行都有尾部箭头', st && st.go);
  /* 量的是 CSS px（getBoundingClientRect 已经过缩放），4 px 约等于 8 设计 px。 */
  ok(st && st.gap >= 4, '★ 箭头没有压到净胜那列（空隙 ' + (st && st.gap) + ' CSS px）', st && st.gap);
  ok(st && st.goHit !== 'settle-go',
    '★ 箭头 pointer-events:none，点它落在行上（实测落在 .' + (st && st.goHit) + '）', st && st.goHit);
  ok(st && st.aria && st.aria.role === 'button' && st.aria.tab === '0',
    '★ 头像是能聚焦的按钮（键盘用户才够得着）', st && st.aria);
  ok(st && st.aria && /第 1 名 /.test(st.aria.label || ''),
    '★ aria-label 带名次和名字（读屏看不到角标）', st && st.aria);
  /* 尾部箭头不许改变列宽：它不是 grid 子项，第一列应该还是 56 设计 px。 */
  ok(st && st.cols.split(' ').length === 4 && st.colsPlain.split(' ').length === 4,
    '★ 箭头没多出一列（普通行仍是 56px 起 4 列）', st && [st.cols, st.colsPlain]);
  ok(st && /^72px/.test(st.cols) && /^56px/.test(st.colsPlain),
    '冠军行 72px 起、普通行 56px 起（列宽没被箭头动过）', st && [st.cols, st.colsPlain]);

  /* 点行 → 这一把的回放。点名字（不是头像），走的是真实事件冒泡路径。 */
  const tapRow = await evaluate(`(function(){
    var name = document.querySelector('#settle-body .settle-row .settle-name');
    if (!name) return { err: '没有名字格' };
    name.click();
    return { clicked: true };
  })()`);
  await sleep(700);
  const rp = await evaluate(`(function(){
    var m = document.getElementById('replay-modal');
    var body = document.getElementById('replay-body');
    var packs = body ? [].slice.call(body.querySelectorAll('.replay-pack')) : [];
    var hit = body ? body.querySelector('.replay-pack.is-target') : null;
    return {
      open: !!(m && !m.classList.contains('hidden')),
      title: (document.getElementById('replay-title') || {}).textContent || '',
      sub: (document.getElementById('replay-sub') || {}).textContent || '',
      packs: packs.length,
      hands: packs.map(function (p) { return Number(p.dataset.hand); }),
      target: hit ? Number(hit.dataset.hand) : 0,
      flagged: hit ? /你点的这把/.test(hit.textContent) : false,
      scrollTop: body ? Math.round(body.scrollTop) : -1,
      /* 定位生效的证据：目标那一把的顶部应该贴着滚动区顶部（允许 0） */
      targetTop: hit ? Math.round(hit.getBoundingClientRect().top - body.getBoundingClientRect().top) : -999
    };
  })()`);
  console.log('  回放：' + JSON.stringify(rp) + ' / ' + JSON.stringify(tapRow));
  ok(rp && rp.open, '★ 点结算行 → 打开回放', [tapRow, rp && rp.open]);
  ok(rp && rp.target > 0, '★★ 落在了「这一把」上（.is-target 的 data-hand=' + (rp && rp.target) + '）', rp);
  ok(rp && rp.hands.indexOf(rp.target) === rp.hands.length - 1,
    '★ 定位的是最后一把（刚打完的那把）', rp && rp.hands);
  ok(rp && rp.flagged, '目标那把有「你点的这把」文字标记', rp && rp.flagged);
  ok(rp && rp.title === '这一局', '结算页进来写「这一局」，不是「上一局」', rp && rp.title);
  ok(rp && rp.targetTop >= -4 && rp.targetTop < 40,
    '★ 打开时滚到了这一把（目标顶部距滚动区顶 ' + (rp && rp.targetTop) + 'px）', rp);
  const shotReplay = await shot('settle-replay');

  /* 关掉回放，点头像 → 档案 */
  await evaluate(`document.getElementById('btn-replay-close').click()`);
  await sleep(400);
  const tapAv = await evaluate(`(function(){
    var av = document.querySelector('#settle-body .settle-row.me .settle-rank');
    if (!av) return { err: '没有「我」那一行' };
    av.click();
    return { clicked: true };
  })()`);
  await sleep(900);
  const pf = await evaluate(`(function(){
    var m = document.getElementById('profile-modal');
    var n = document.getElementById('profile-name');
    var rp = document.getElementById('replay-modal');
    return {
      open: !!(m && !m.classList.contains('hidden')),
      name: n ? (n.textContent || '').trim() : '',
      replayStillOpen: !!(rp && !rp.classList.contains('hidden'))
    };
  })()`);
  ok(pf && pf.open, '★ 点头像 → 玩家档案', [tapAv, pf && pf.open]);
  ok(pf && !pf.replayStillOpen, '★ 点头像没有顺手把回放也打开（两个手势没串）', pf);
  const shotProf = await shot('settle-profile');

  /* 键盘同一条路：Enter 落在头像上 = 点它 */
  await evaluate(`(function(){ var b = document.getElementById('btn-profile-close'); if (b) b.click(); return 1; })()`);
  await sleep(400);
  const keyOk = await evaluate(`(function(){
    var av = document.querySelector('#settle-body .settle-row.me .settle-rank');
    if (!av) return false;
    av.focus();
    av.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  await sleep(700);
  const pf2 = await evaluate(`!document.getElementById('profile-modal').classList.contains('hidden')`);
  ok(keyOk && pf2, '★ 头像上按回车也能开档案（键盘用户同一条路）', pf2);
  await evaluate(`(function(){ var b = document.getElementById('btn-profile-close'); if (b) b.click(); return 1; })()`);

  /* 收尾：确认回结算页时没有残留弹窗（这一屏要能回到「干净」状态） */
  await sleep(300);
  const rest = await evaluate(`(function(){
    return [].slice.call(document.querySelectorAll('.modal'))
      .filter(function (m) { return !m.classList.contains('hidden'); })
      .map(function (m) { return m.id; });
  })()`);
  ok(rest && rest.length === 0, '点完之后没有残留弹窗', rest);

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  const shots = await Promise.all([shotStep1, shotStep3, shotBreak, shotDn, shotReplay, shotProf]);
  shots.filter(Boolean).forEach(function (f) { console.log('截图: ' + f); });

  edge.kill();
  if (serverProc) serverProc.kill();
  if (fail) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  if (serverProc) serverProc.kill();
  process.exit(1);
});
