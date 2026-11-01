/**
 * 删除账号 / 云端档案（HTTP 接口）
 * 跑法：node server/test/delete-profile.test.js
 *
 * 背景：老实现是「先向 WS 要一个删除令牌，再凭令牌删」，而**签发令牌时不校验请求者身份**——
 * 谁拿到 playerId 就能要到一把能删掉别人数据的钥匙。整个流程已经废掉，
 * 现在只认 Bearer 令牌，playerId 一律从签名里解析。
 *
 * 这里锁死：
 *   1. 没令牌 / 令牌被改 / 拿别人的令牌，都删不到 A 的数据
 *   2. 请求体里填 A 的 playerId 完全无效（服务端只信令牌）
 *   3. 自己的令牌能删掉自己的账号与档案，删完就登不进来
 *   4. 重复删返回 removed=false
 */
'use strict';

const path = require('path');
const os = require('os');

process.env.PROFILE_FILE = path.join(os.tmpdir(), 'lxw-del-profiles-' + Date.now() + '.json');
process.env.SEED_FILE = path.join(os.tmpdir(), 'lxw-del-seed-' + Date.now() + '.json');
process.env.BACKUP_KEY = 'del-test-key-0123456789';
process.env.PORT = process.env.PORT || '3197';
const PORT = Number(process.env.PORT);

const { server, profiles } = require('../index.js');
const { httpAuth, registerPlayer, loginPlayer } = require('./helpers/account');

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

  /* -------------------- 建档 -------------------- */
  console.log('\n[建档：两个账号，A 先打一场]');
  const a = await registerPlayer(PORT, '要删的人');
  const b = await registerPlayer(PORT, '路人');
  // 直接造一条有战绩的档案（不用真打完一局）
  profiles.record(a.playerId, a.nickname, 5, Date.now(), 'r1', 1);
  ok(profiles.get(a.playerId) !== null, 'A 的档案已存在且有战绩');
  ok(profiles.accountOf(b.playerId) !== null, 'B 的账号也存在');

  /* -------------------- 冒充删除 -------------------- */
  console.log('\n[没有令牌，删不掉任何人]');
  let r = await httpAuth(PORT, 'POST', '/api/auth/delete', null, { playerId: a.playerId });
  eq(r.status, 401, '不带 Authorization → 401');
  ok(profiles.get(a.playerId) !== null, 'A 的档案还在');

  console.log('\n[令牌被改一位就作废]');
  const tampered = a.token.slice(0, -1) + (a.token.slice(-1) === 'A' ? 'B' : 'A');
  r = await httpAuth(PORT, 'POST', '/api/auth/delete', tampered, { playerId: a.playerId });
  eq(r.status, 401, '签名不符 → 401');
  ok(profiles.get(a.playerId) !== null, 'A 的档案还在');

  console.log('\n[拿 B 的合法令牌，也删不到 A —— 请求体里的 playerId 被无视]');
  r = await httpAuth(PORT, 'POST', '/api/auth/delete', b.token, { playerId: a.playerId, password: b.password });
  eq(r.status, 200, 'B 用自己的令牌请求成功（删的是 B 自己）');
  ok(profiles.get(a.playerId) !== null, 'A 的档案完好——这是老版本最严重的洞');
  ok(profiles.accountOf(b.playerId) === null, 'B 自己的账号被删掉了（令牌说谁是本人就是谁）');

  /* -------------------- 自己删自己 -------------------- */
  console.log('\n[自己的令牌能删掉自己的账号与档案]');
  r = await httpAuth(PORT, 'POST', '/api/auth/delete', a.token, { password: a.password });
  eq(r.status, 200, '返回 200');
  eq(r.json && r.json.removed, true, 'removed=true');
  ok(profiles.get(a.playerId) === null, '档案已删除');
  ok(profiles.accountOf(a.playerId) === null, '账号也已删除');

  console.log('\n[删完就登不进来，重复删返回 false]');
  const login = await loginPlayer(PORT, a.name, a.password);
  eq(login.status, 401, '原账号密码登录 → 401（账号已不存在）');
  r = await httpAuth(PORT, 'POST', '/api/auth/delete', a.token, { password: a.password });
  eq(r.status, 401, '账号已删 → 令牌失效，二次删除 401');

  /* 老令牌在账号被删后不能复活：me 会查不到账号 */
  r = await httpAuth(PORT, 'GET', '/api/auth/me', a.token, undefined);
  eq(r.status, 401, '/api/auth/me 对已删账号返回 401');

  console.log('\n[删掉的账号不会因为残留连接又冒出来]');
  ok(!profiles.findByAccountName(a.name), '账号名已从索引里摘掉，可以重新注册同名');

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error('测试异常:', e); process.exit(1); });
