/**
 * 删号后的**身份抹除**端到端探针（node scripts/probe-delete-purge.js）
 *
 * 验证的是胶水，不是模块：SessionLog.scrub / Records.scrubReplays 各自的逻辑
 * 有 33 条单测钉住，服务端的种子重写与 alive 接口有 40 条。
 * 这里只剩一个问题 —— **它们真的会在用户打开战绩页时自己跑起来吗**。
 *
 * 流程（全程在真 Edge 里）：
 *   1. 起本地服务端（临时档案目录，不碰线上数据）
 *   2. HTTP 注册 A、B 两个账号；A 直接删号（这样服务端认为他已注销）
 *   3. 打开页面，把 B 的登录态和两份含 A 的副本注入 localStorage
 *   4. 刷新（让 boot 读到登录态）→ 点「我的战绩」→ 等 purge 跑完
 *   5. 读回 localStorage：A 的 id 与昵称必须为空，牌和分数必须还在
 *
 * 为什么不能只跑单测：单测里的 scrub 是被直接调用的。真实链路上它挂在
 * `openRecords()` 里，前面还有「有没有登录」「sharecode 拼得对不对」
 * 「返回的 JSON 形状对不对」三道坎，任何一道断了单测都还是绿的。
 *
 * 用法：node scripts/probe-delete-purge.js
 */
'use strict';

const http = require('http');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const SRV_PORT = 3026;
const CDP_PORT = 9337;

let serverProc = null;
function startApp() {
  serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(SRV_PORT),
      PROFILE_FILE: path.join(os.tmpdir(), 'lxw-purge-' + Date.now(), 'profiles.json'),
      SEED_FILE: path.join(os.tmpdir(), 'lxw-purge-seed-' + Date.now() + '.json')
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

function httpJson(method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const h = Object.assign({}, headers || {});
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = data.length; }
    const req = http.request({ host: '127.0.0.1', port: SRV_PORT, path: p, method, headers: h }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, json, raw: b });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
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
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

async function main() {
  startApp();
  await waitApp();
  console.log('应用服务 127.0.0.1:' + SRV_PORT);

  /* ---------------- 两个账号：A 会被删，B 是"对手的这台手机" ---------------- */
  /* 账号名上限 16 字符（服务端卡着），所以用短随机后缀而不是时间戳。 */
  const aName = 'g' + Math.random().toString(36).slice(2, 9);
  const bName = 'k' + Math.random().toString(36).slice(2, 9);
  const aReg = await httpJson('POST', '/api/auth/register', { name: aName, password: 'pw-abcdefgh', nickname: '要删的人' });
  const bReg = await httpJson('POST', '/api/auth/register', { name: bName, password: 'pw-abcdefgh', nickname: '对手' });
  if (aReg.status !== 200 || bReg.status !== 200) throw new Error('注册失败：' + aReg.raw + ' / ' + bReg.raw);
  /* 注册返回的形状是 {ok, token, me:{playerId,nickname}}，playerId 在 me 里。 */
  const A = { playerId: aReg.json.me.playerId, token: aReg.json.token, account: aName, password: 'pw-abcdefgh' };
  const B = { playerId: bReg.json.me.playerId, token: bReg.json.token, account: bName };
  console.log('A=' + A.playerId + '  B=' + B.playerId);

  /* A 走真实接口删号 —— 这样 /api/players/alive 会真的把他标成已注销 */
  const del = await httpJson('POST', '/api/auth/delete', { password: A.password }, { 'X-Session-Token': A.token });
  eq(del.status, 200, 'A 已通过真实接口删号');
  eq(!!(del.json && del.json.removed), true, 'removed=true');

  const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const userDir = path.join(os.tmpdir(), 'lxw-purge-edge-' + Date.now());
  const edge = spawn(exe, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + userDir,
    '--window-size=390,844',
    '--force-device-scale-factor=1',
    'about:blank'
  ], { stdio: 'ignore' });

  let page = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const list = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
      page = (list || []).find(function (t) { return t.type === 'page'; });
      if (page) break;
    } catch (e) { /* 还没起来 */ }
  }
  if (!page) throw new Error('Edge 没起来');

  const cdp = await cdpConnect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  async function evalIn(expr) {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面执行异常：' + JSON.stringify(r.exceptionDetails));
    return r.result && r.result.value;
  }

  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + SRV_PORT + '/' });
  await sleep(2500);

  /* ---------------- 注入：B 的登录态 + 两份含 A 的副本 ---------------- */
  const packs = [{
    hands: 1,
    rounds: [{
      r: 1,
      groups: [{
        l: '单张比大小',
        w: '要删的人',
        t: '',
        rows: [
          { i: A.playerId, n: '要删的人', c: ['Q♦'], d: -4 },
          { i: B.playerId, n: '对手', c: ['A♠'], d: 4 }
        ]
      }]
    }]
  }];

  const session = { token: B.token, playerId: B.playerId, name: B.account };
  await evalIn(`(function(){
    localStorage.setItem('lxw_session_v1', ${JSON.stringify(JSON.stringify(session))});
    var P = ${JSON.stringify(packs)};
    localStorage.setItem('lxw_sessions_v1', JSON.stringify([{ key: 'r1#1000', roomId: 'r1', startedAt: 1000, packs: P }]));
    localStorage.setItem('lxw_records_v1', JSON.stringify([{
      id: 'r1-1000', playerId: ${JSON.stringify(B.playerId)}, roomId: 'r1', endedAt: 1000, playerCount: 2,
      myStartScore: 20, myEndScore: 24, myNet: 4, endReason: 'scoreZero', rounds: 1,
      replay: P[0]
    }]));
    return 'ok';
  })()`);

  const seeded = await evalIn(`(function(){
    var s = JSON.parse(localStorage.getItem('lxw_sessions_v1') || '[]');
    var r = JSON.parse(localStorage.getItem('lxw_records_v1') || '[]');
    var row = (s[0] && s[0].packs[0].rounds[0].groups[0].rows[0]) || null;
    return { sessions: s.length, records: r.length, firstId: row && row.i };
  })()`);
  eq(seeded.sessions, 1, '注入：1 场回放');
  eq(seeded.records, 1, '注入：1 条战绩');
  eq(seeded.firstId, A.playerId, '注入：回放第一行就是 A');

  /* ---------------- 刷新，让 boot 读到登录态 ---------------- */
  await cdp.send('Page.reload');
  await sleep(3000);

  const booted = await evalIn(`(function(){
    return {
      home: !document.getElementById('screen-home').classList.contains('hidden'),
      auth: !document.getElementById('screen-auth').classList.contains('hidden'),
      btn: !!document.getElementById('btn-records')
    };
  })()`);
  console.log('  刷新后：首页 ' + booted.home + ' / 登录页 ' + booted.auth + ' / 战绩按钮 ' + booted.btn);
  ok(booted.home, '刷新后进到首页（登录态被接住了）');

  /* ---------------- 点「我的战绩」，让 purge 自己跑 ---------------- */
  await evalIn(`(function(){
    var b = document.getElementById('btn-records');
    if (b) b.click();
    return b ? 'clicked' : 'missing';
  })()`);
  await sleep(2500);

  /* ---------------- 读回，逐项核对 ---------------- */
  const after = await evalIn(`(function(){
    var s = JSON.parse(localStorage.getItem('lxw_sessions_v1') || '[]');
    var r = JSON.parse(localStorage.getItem('lxw_records_v1') || '[]');
    function pick(g) {
      var gone = null, me = null;
      (g.rows || []).forEach(function (x) {
        if (x.c && x.c[0] === 'Q♦') gone = x;
        if (x.c && x.c[0] === 'A♠') me = x;
      });
      return { w: g.w, gone: gone, me: me };
    }
    var gs = (s[0] && s[0].packs[0].rounds[0].groups[0]) || null;
    var gr = (r[0] && r[0].replay && r[0].replay.rounds[0].groups[0]) || null;
    return {
      sessionGroup: gs ? pick(gs) : null,
      recordGroup: gr ? pick(gr) : null,
      recordNet: r[0] ? r[0].myNet : null
    };
  })()`);

  const S = after.sessionGroup;
  const R = after.recordGroup;
  ok(!!S, '回放数据还在（不是整条被删掉）');
  ok(!!R, '战绩副本还在');

  if (S) {
    eq(S.gone && S.gone.i, '', '回放：A 的 playerId 被清空');
    eq(S.gone && S.gone.n, '', '回放：A 的昵称被清空');
    eq(S.gone && S.gone.c.join(' '), 'Q♦', '回放：A 出的牌还在');
    eq(S.gone && S.gone.d, -4, '回放：A 的分数还在');
    eq(S.w, '', '回放：组头「要删的人 赢」被清空');
    eq(S.me && S.me.n, '对手', '回放：对手（我自己）不受影响');
  }
  if (R) {
    eq(R.gone && R.gone.i, '', '战绩副本：A 的 playerId 被清空');
    eq(R.gone && R.gone.n, '', '战绩副本：A 的昵称被清空');
    eq(R.me && R.me.n, '对手', '战绩副本：我自己不受影响');
  }
  eq(after.recordNet, 4, '★ 我的净胜没变（删别人的身份不动我的分）');

  /* ---------------- 服务端侧的对照 ---------------- */
  const alive = await httpJson('GET', '/api/players/alive?ids=' + A.playerId + ',' + B.playerId, null, { 'X-Session-Token': B.token });
  eq(alive.status, 200, '/api/players/alive 可访问');
  eq((alive.json.dead || []).join(','), A.playerId, '服务端只把 A 标成已注销（B 不在名单里）');

  /* ---------------- 阶段 2：本人删号，本机两份副本必须一起清 ----------------
   *
   * 阶段 1 验的是「对手的设备上，A 的名字被抹掉」。
   * 阶段 2 验的是另一半：**A 自己的手机上，那两份副本有没有被清**。
   * 只做前者的话，删号的人自己重装/换号之前仍能在「我的战绩」里看到全部历史。
   *
   * 这一段刻意走真实 UI（账号页 → 删除按钮 → 密码 → 确定），
   * 因为要验的正是「按钮点下去以后，onDeleteAccount 有没有把 purge 传进去」。
   * 直接调函数验不了这条 —— 那等于绕开了被测的那一行。
   */
  console.log('\n[阶段 2] 本人删号 → 本机战绩与整场回放一起清');
  const cName = 'c' + Math.random().toString(36).slice(2, 9);
  const cReg = await httpJson('POST', '/api/auth/register', { name: cName, password: 'pw-abcdefgh', nickname: '自己删的人' });
  if (cReg.status !== 200) throw new Error('C 注册失败：' + cReg.raw);
  const C = { playerId: cReg.json.me.playerId, token: cReg.json.token, account: cName, password: 'pw-abcdefgh' };

  /* 模拟「另一台设备」：清空再注入 C 的东西，不带阶段 1 的残留 */
  await evalIn(`(function(){
    localStorage.clear();
    localStorage.setItem('lxw_session_v1', ${JSON.stringify(JSON.stringify({ token: C.token, playerId: C.playerId, name: C.account }))});
    var P = ${JSON.stringify(packs)};
    localStorage.setItem('lxw_sessions_v1', JSON.stringify([{ key: 'r2#2000', roomId: 'r2', startedAt: 2000, packs: P }]));
    localStorage.setItem('lxw_records_v1', JSON.stringify([{
      id: 'r2-2000', playerId: ${JSON.stringify(C.playerId)}, roomId: 'r2', endedAt: 2000, playerCount: 2,
      myStartScore: 20, myEndScore: 24, myNet: 4, endReason: 'scoreZero', rounds: 1, replay: P[0]
    }]));
    return 'ok';
  })()`);
  await cdp.send('Page.reload');
  await sleep(3000);

  const beforeDel = await evalIn(`(function(){
    return {
      rec: !!localStorage.getItem('lxw_records_v1'),
      sess: !!localStorage.getItem('lxw_sessions_v1'),
      home: !document.getElementById('screen-home').classList.contains('hidden')
    };
  })()`);
  ok(beforeDel.home, '删号前：C 已登录并停在首页');
  ok(beforeDel.rec && beforeDel.sess, '删号前：本机两份副本都在（否则后面的断言证明不了什么）');

  await evalIn(`(function(){ document.getElementById('btn-account').click(); return 1; })()`);
  await sleep(700);
  await evalIn(`(function(){ document.getElementById('btn-acc-delete').click(); return 1; })()`);
  await sleep(700);

  const modal = await evalIn(`(function(){
    var m = document.getElementById('confirm-modal');
    var s = document.getElementById('confirm-secret');
    return {
      open: m && !m.classList.contains('hidden'),
      title: document.getElementById('confirm-title').textContent,
      desc: document.getElementById('confirm-desc').textContent,
      secretShown: s && !s.classList.contains('hidden')
    };
  })()`);
  ok(modal.open, '确认框弹出来了');
  ok(modal.secretShown, '要求当场输密码');
  ok(/本机记录/.test(modal.desc), '文案提到了「本机记录」（用户有权知道删到什么程度）', modal.desc);
  ok(/其他玩家/.test(modal.desc), '文案提到了「会留在其他玩家设备上」（不装作能远程清掉）', modal.desc);

  await evalIn(`(function(){
    var s = document.getElementById('confirm-secret');
    s.value = ${JSON.stringify(C.password)};
    s.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-confirm-ok').click();
    return 1;
  })()`);
  await sleep(3500);

  const afterDel = await evalIn(`(function(){
    return {
      rec: !!localStorage.getItem('lxw_records_v1'),
      sess: !!localStorage.getItem('lxw_sessions_v1'),
      session: !!localStorage.getItem('lxw_session_v1'),
      authVisible: !document.getElementById('screen-auth').classList.contains('hidden')
    };
  })()`);
  eq(afterDel.rec, false, '★ 本机战绩被清空');
  eq(afterDel.sess, false, '★ 整场回放被清空');
  eq(afterDel.session, false, '登录态被清空');
  ok(afterDel.authVisible, '回到登录页');

  /* 服务端也确认一下：C 真的没了 */
  const cAlive = await httpJson('GET', '/api/players/alive?ids=' + C.playerId, null, { 'X-Session-Token': B.token });
  eq((cAlive.json.dead || []).join(','), C.playerId, '服务端确认 C 已注销');

  /* ---------------- 收尾 ---------------- */
  cdp.close();
  try { edge.kill(); } catch (e) { /* 已退 */ }
  try { serverProc.kill(); } catch (e) { /* 已退 */ }

  console.log('\n' + (fail === 0 ? '全部通过' : '有失败') + '：' + pass + ' 项通过，' + fail + ' 项失败');
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) {
  console.error('探针自身异常：', e);
  try { if (serverProc) serverProc.kill(); } catch (x) { /* 忽略 */ }
  process.exit(1);
});
