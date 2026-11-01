/**
 * 令牌吊销 + 删号验密码（P1-5 / P1-6）
 * 跑法：node server/test/token-revoke.test.js
 *
 * 这两条以前是同一个病根：**「令牌只是一张签名纸」**。
 *   ① 令牌无状态，改密码 / 被停用 / 账号被删之后，旧令牌在 90 天有效期内
 *      照样能过验签 —— 「改密码踢下线」是句空话，手机被人拿走就等于号送人。
 *   ② 删号只看令牌不看密码，令牌存在浏览器里 90 天，借人用一下就能被删号。
 *
 * 现在：账号上挂一个令牌版本号 tv，改密码 / 停用都 +1；服务端每次比对，
 * 版本不一致即失效。删号要求当场输密码，并且复用登录失败限流
 * （否则删号接口会变成一条无视限流的密码爆破通道）。
 */
'use strict';

process.env.PROFILE_FILE = require('path').join(require('os').tmpdir(), 'lxw-tv-profiles-' + Date.now() + '.json');
process.env.SEED_FILE = require('path').join(require('os').tmpdir(), 'lxw-tv-seed-' + Date.now() + '.json');
process.env.PORT = process.env.PORT || '3205';
const PORT = Number(process.env.PORT);

const { server } = require('../index.js');
const { httpJson, httpAuth, registerPlayer } = require('./helpers/account');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

async function run() {
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });
  console.log('\n服务端就绪 127.0.0.1:' + PORT);

  /* ================================================================= */
  console.log('\n[1] 基线：新令牌能用');
  const a = await registerPlayer(PORT, '甲');
  let me = await httpAuth(PORT, 'GET', '/api/auth/me', a.token);
  eq(me.status, 200, '注册后 /me 正常');
  eq(me.json.me.playerId, a.playerId, '认的是同一个人');

  /* ================================================================= */
  console.log('\n[2] 改密码 → 旧令牌立刻作废（这条是本轮的核心）');
  const chg = await httpAuth(PORT, 'POST', '/api/auth/password', a.token, {
    oldPassword: a.password,
    newPassword: 'newpw-' + a.password
  });
  eq(chg.status, 200, '改密码成功');
  ok(!!(chg.json && chg.json.token), '响应里下发了新令牌');
  const newToken = chg.json.token;

  const oldAfter = await httpAuth(PORT, 'GET', '/api/auth/me', a.token);
  eq(oldAfter.status, 401, '★ 旧令牌再来 /me 被拒（以前这里会 200）');
  eq(oldAfter.json.error, '密码已修改，请重新登录', '错误文案点明原因，不是笼统的「失效」');

  const newAfter = await httpAuth(PORT, 'GET', '/api/auth/me', newToken);
  eq(newAfter.status, 200, '当前设备拿新令牌继续用，不用重登');

  /* 旧密码登录必须失败、新密码必须成功——版本号不能把密码本身弄坏 */
  const loginOld = await httpJson(PORT, 'POST', '/api/auth/login', { name: a.name, password: a.password });
  eq(loginOld.status, 401, '旧密码登不进来');
  const loginNew = await httpJson(PORT, 'POST', '/api/auth/login', { name: a.name, password: 'newpw-' + a.password });
  eq(loginNew.status, 200, '新密码能登录');

  /* ================================================================= */
  console.log('\n[3] WebSocket 那条路也要认版本号');
  /* 只堵 HTTP 是不够的：ws 用的是 resolveToken，若不查版本，
   * 拿着旧令牌照样能 auth 成功并占住座位。 */
  const wsOld = await wsAuthResult(PORT, a.token);
  eq(wsOld, false, '★ 旧令牌 ws auth 被拒（以前能连上）');
  const wsNew = await wsAuthResult(PORT, newToken);
  eq(wsNew, true, '新令牌 ws auth 正常');

  /* ================================================================= */
  console.log('\n[4] 停用账号 → 令牌失效');
  const b = await registerPlayer(PORT, '乙');
  const BACKUP_KEY = 'test-backup-key-0123456789';
  process.env.BACKUP_KEY = BACKUP_KEY;
  /* 管理端密钥是启动时读的，这里直接用运行时值构造请求头 */
  const admin = (path, body) => httpJson(PORT, 'POST', path, body, { 'x-backup-key': BACKUP_KEY });

  const dis = await admin('/api/admin/disable', { playerId: b.playerId, disabled: true });
  eq(dis.status, 200, '管理员停用成功');
  const bAfter = await httpAuth(PORT, 'GET', '/api/auth/me', b.token);
  eq(bAfter.status, 403, '★ 被停用后令牌失效（403 停用）');
  const bLogin = await httpJson(PORT, 'POST', '/api/auth/login', { name: b.name, password: b.password });
  eq(bLogin.status, 401, '停用后也登不进来');

  await admin('/api/admin/disable', { playerId: b.playerId, disabled: false });
  const bRestored = await httpAuth(PORT, 'GET', '/api/auth/me', b.token);
  eq(bRestored.status, 401, '恢复账号后**旧令牌**仍然无效（版本号已经加过了）');
  const bRelogin = await httpJson(PORT, 'POST', '/api/auth/login', { name: b.name, password: b.password });
  eq(bRelogin.status, 200, '但重新登录就能用（版本号已跟上）');

  /* ================================================================= */
  console.log('\n[5] 删号必须验密码（P1-6）');
  const c = await registerPlayer(PORT, '丙');

  const noPw = await httpAuth(PORT, 'POST', '/api/auth/delete', c.token, {});
  eq(noPw.status, 403, '★ 不带密码删号被拒（以前直接删成功）');
  const stillThere = await httpAuth(PORT, 'GET', '/api/auth/me', c.token);
  eq(stillThere.status, 200, '账号还在，没被删掉');

  const wrongPw = await httpAuth(PORT, 'POST', '/api/auth/delete', c.token, { password: 'definitely-wrong' });
  eq(wrongPw.status, 403, '密码错删号被拒');
  eq(wrongPw.json.error, '密码不正确', '文案说明是密码问题');
  const stillThere2 = await httpAuth(PORT, 'GET', '/api/auth/me', c.token);
  eq(stillThere2.status, 200, '密码错也不会误删');

  /* 只凭令牌、连 JSON 都不带的请求一律挡在门外：删号是 POST + JSON 接口 */
  const noJson = await httpJson(PORT, 'POST', '/api/auth/delete', null, { 'X-Session-Token': c.token });
  eq(noJson.status, 415, '非 JSON 请求被 415 挡住（CSRF 面）');

  const goodPw = await httpAuth(PORT, 'POST', '/api/auth/delete', c.token, { password: c.password });
  eq(goodPw.status, 200, '密码对 → 删号成功');
  eq(goodPw.json.removed, true, '服务端确认删除');
  const gone = await httpAuth(PORT, 'GET', '/api/auth/me', c.token);
  eq(gone.status, 401, '删完令牌立即失效');

  /* ================================================================= */
  console.log('\n[6] 删号接口复用登录失败计数（不能被当成爆破通道）');
  const d = await registerPlayer(PORT, '丁');
  let last = null;
  for (let i = 0; i < 8; i++) {
    last = await httpAuth(PORT, 'POST', '/api/auth/delete', d.token, { password: 'wrong' + i });
  }
  ok(last.status === 429 || last.status === 403, '连续错密码被限流或拒绝（不是 200）', 'got ' + last.status);
  const dAlive = await httpAuth(PORT, 'GET', '/api/auth/me', d.token);
  eq(dAlive.status, 200, '反复试错之后账号依然完好');

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  await new Promise((r) => setTimeout(r, 80));
  process.exit(fail ? 1 : 0);
}

/** 用令牌连 ws 做 auth，返回是否认证成功。
 *  必须带 reqId 并等**明确回包**：只看「有没有收到 kicked 错误」会把
 *  静默拒绝误判成成功（第一版就这么错了一次）。 */
function wsAuthResult(port, token, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch (e) {}
      resolve(v);
    };
    const timer = setTimeout(() => done(false), timeoutMs || 2000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'auth', reqId: 1, payload: { token: token } }));
    });
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === 'ok' && m.reqId === 1) done(true);
      else if (m.type === 'error' && m.reqId === 1) done(false);
    });
    ws.addEventListener('close', () => done(false));
    ws.addEventListener('error', () => done(false));
  });
}

run().catch((e) => { console.error(e); process.exit(1); });
