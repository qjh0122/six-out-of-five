/**
 * 账号与登录
 * 跑法：node server/test/auth.test.js
 *
 * 覆盖四层：
 *   1. 密码哈希与令牌签名（纯函数，不启服务）
 *   2. 注册 / 登录的边界（重名、弱密码、大小写、误报同一句）
 *   3. 鉴权接口（me、改密码、令牌篡改、过期）
 *   4. 管理端（密钥鉴权、改昵称、重置密码、停用、删除）
 */
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.PROFILE_FILE = path.join(os.tmpdir(), 'lxw-auth-profiles-' + Date.now() + '.json');
process.env.SEED_FILE = path.join(os.tmpdir(), 'lxw-auth-seed-' + Date.now() + '.json');
process.env.BACKUP_KEY = 'auth-test-key-0123456789';
process.env.PORT = process.env.PORT || '3196';
const PORT = Number(process.env.PORT);
const KEY = process.env.BACKUP_KEY;

const { server, profiles } = require('../index.js');
const auth = require('../auth');
const { httpJson, httpAuth, httpAuthBearer, registerPlayer } = require('./helpers/account');

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

  /* ==================== 一、密码哈希 ==================== */
  console.log('\n[密码哈希]');
  {
    const hp = await auth.hashPassword('correct horse');
    ok(!!hp.salt && hp.salt.length === 32, 'salt 是 32 位 hex');
    ok(!!hp.hash && hp.hash.length === 64, 'hash 是 64 位 hex（scrypt 32 字节）');
    ok(hp.hash !== 'correct horse', '不存明文');
    ok(await auth.verifyPassword('correct horse', hp.salt, hp.hash), '正确密码通过');
    ok(!(await auth.verifyPassword('correct horsE', hp.salt, hp.hash)), '大小写不同不通过');
    ok(!(await auth.verifyPassword('', hp.salt, hp.hash)), '空密码不通过');
    ok(!(await auth.verifyPassword('correct horse', '', '')), '缺参数不通过（不抛异常）');

    const hp2 = await auth.hashPassword('correct horse');
    ok(hp2.salt !== hp.salt, '同密码两次注册 salt 不同');
    ok(hp2.hash !== hp.hash, '因此哈希也不同（不能靠比对哈希反推同密码）');

    /* 哈希必须是异步的：scryptSync 会把事件循环堵住 60ms，
     * 那 60ms 里所有 WebSocket 帧、心跳、出牌全部停摆。
     * 判据是「调用后立刻返回 Promise，而不是马上给出结果」。 */
    const p = auth.hashPassword('async check');
    ok(p && typeof p.then === 'function', 'hashPassword 返回 Promise（没有阻塞事件循环）');
    await p;
  }

  /* ==================== 二、令牌 ==================== */
  console.log('\n[令牌签名]');
  {
    const secret = 'x'.repeat(64);
    const t = auth.signToken('p123', secret);
    const p = auth.verifyToken(t, secret);
    ok(!!p && p.pid === 'p123', '正常令牌能解析出 playerId');

    ok(auth.verifyToken(t, 'y'.repeat(64)) === null, '换密钥后验签失败');
    ok(auth.verifyToken(t.slice(0, -1) + 'z', secret) === null, '签名改一位就失败');
    ok(auth.verifyToken('', secret) === null, '空令牌失败');
    ok(auth.verifyToken(null, secret) === null, 'null 令牌失败');
    ok(auth.verifyToken('abc', secret) === null, '没有点号的令牌失败');

    // 过期：签发时把 now 往前拨
    const old = auth.signToken('p123', secret, { now: Date.now() - 100 * 24 * 3600 * 1000 });
    ok(auth.verifyToken(old, secret) === null, '超过有效期的令牌失效');
    const fresh = auth.signToken('p123', secret, { now: Date.now() - 89 * 24 * 3600 * 1000 });
    ok(!!auth.verifyToken(fresh, secret), '快到期但没到期，仍然有效');

    // 篡改 payload（改 pid）必须导致验签失败
    const seg = t.split('.');
    const forged = Buffer.from(JSON.stringify({ pid: 'p999', iat: Date.now(), exp: Date.now() + 1e9 }))
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    ok(auth.verifyToken(forged + '.' + seg[1], secret) === null, '改 payload 里的 pid 会导致验签失败');
  }

  /* ---------- 滑动续期（「第一次登录后不用每次都登」靠这个） ---------- */
  console.log('\n[滑动续期]');
  {
    const secret = 'S'.repeat(64);
    const now = Date.now();
    const ttl = auth.TOKEN_TTL_MS;

    const justIssued = auth.verifyToken(auth.signToken('p1', secret, { now }), secret, { now });
    ok(auth.needsRenew(justIssued, { now }) === false, '刚签发的令牌不续（每次都换新令牌没意义）');

    // 寿命过半：剩下的不足一半 → 该续了
    const half = auth.verifyToken(auth.signToken('p1', secret, { now: now - ttl * 0.55 }), secret, { now });
    ok(auth.needsRenew(half, { now }) === true, '寿命过半的令牌要续期');

    const almostDone = auth.verifyToken(auth.signToken('p1', secret, { now: now - ttl * 0.99 }), secret, { now });
    ok(auth.needsRenew(almostDone, { now }) === true, '快过期的令牌要续期');

    const midLife = auth.verifyToken(auth.signToken('p1', secret, { now: now - ttl * 0.3 }), secret, { now });
    ok(auth.needsRenew(midLife, { now }) === false, '刚过三分之一还不续');

    ok(auth.needsRenew(null) === false, '空 payload 不抛异常');
    ok(auth.needsRenew({}) === false, '没有 exp 的 payload 不续');

    // 续出来的令牌是全新的一整程
    const renewed = auth.verifyToken(auth.signToken('p1', secret, { now }), secret, { now });
    ok(renewed.exp - renewed.iat === ttl, '新令牌是完整有效期，不是剩余时长');
  }

  /* ==================== 三、输入校验 ==================== */
  console.log('\n[输入校验]');
  {
    ok(!!auth.accountNameProblem(''), '空账号名被拒');
    ok(!!auth.accountNameProblem('a'), '1 个字符太短');
    ok(!!auth.accountNameProblem('a'.repeat(17)), '17 个字符太长');
    ok(!!auth.accountNameProblem('张三!'), '含非法符号被拒');
    ok(auth.accountNameProblem('小王') === null, '中文账号名可用');
    ok(auth.accountNameProblem('abc_123') === null, '字母数字下划线可用');
    ok(!!auth.passwordProblem('12345'), '5 位密码太短');
    /* 下限 v79 从 6 提到 8：新设的密码要 8 位，但**老密码 6 位仍然合法**。
     * 这两条必须同时成立 —— 只测「8 位可用」会漏掉「把老用户锁在门外」这个回归。 */
    ok(!!auth.passwordProblem('123456'), '6 位已不足以新设密码');
    ok(auth.passwordProblem('12345678') === null, '8 位密码可用');
    ok(auth.passwordProblem('123456', auth.LEGACY_MIN_PASSWORD_LEN) === null, '6 位仍可按历史下限校验（老账号）');
    eq(auth.MIN_PASSWORD_LEN, 8, '当下标准是 8 位');
    ok(!!auth.passwordProblem('a'.repeat(65)), '65 位密码太长');
  }

  /* ==================== 四、注册 / 登录 ==================== */
  console.log('\n[注册与登录]');
  const alice = await registerPlayer(PORT, '爱丽丝');
  ok(!!alice.token && !!alice.playerId, '注册成功，返回令牌与 playerId');
  ok(alice.nickname === '爱丽丝', '昵称已写入档案', alice.nickname);

  {
    // 重名：大小写不敏感
    const up = await httpJson(PORT, 'POST', '/api/auth/register', {
      name: alice.name.toUpperCase(), password: 'another-pass', nickname: '冒名'
    });
    eq(up.status, 409, '账号名大小写不同也算重名 → 409');

    const short = await httpJson(PORT, 'POST', '/api/auth/register', { name: 'newbie1', password: '123' });
    eq(short.status, 400, '弱密码 → 400');

    /* 6 位在新规则下也算弱密码（v79 把下限提到 8）。
     * 单独一条：这一档最容易在「只拦 5 位」的旧实现里漏掉。 */
    const six = await httpJson(PORT, 'POST', '/api/auth/register', { name: 'newbie2', password: '123456' });
    eq(six.status, 400, '6 位密码在新注册下也被拒');
    ok(six.json.error.indexOf('8') >= 0, '提示里说的是 8 位', six.json.error);

    /* 但登录**不能**因为这个新规则被拦。历史账号确实存在 6 位密码，
     * 登录侧一旦也套上 8 位下限，这些人就被锁在门外了。
     * 判据：短密码在登录时得到的是「密码不正确」(401)，而不是校验失败 (400)。 */
    const legacyReg = await httpJson(PORT, 'POST', '/api/auth/register', { name: 'legacy8', password: 'abc12345' });
    eq(legacyReg.status, 200, '8 位密码可以注册');
    const legacyShort = await httpJson(PORT, 'POST', '/api/auth/login', { name: 'legacy8', password: 'abc123' });
    eq(legacyShort.status, 401, '登录侧不校验密码长度（否则老账号进不来）');

    const bad = await httpJson(PORT, 'POST', '/api/auth/register', { name: 'a!b', password: '123456' });
    eq(bad.status, 400, '非法账号名 → 400');

    const get = await httpJson(PORT, 'GET', '/api/auth/register');
    eq(get.status, 405, 'GET 注册接口 → 405');
  }

  {
    const good = await httpJson(PORT, 'POST', '/api/auth/login', { name: alice.name, password: alice.password });
    eq(good.status, 200, '正确密码登录成功');
    ok(!!good.json.token, '返回新令牌');
    eq(good.json.me.playerId, alice.playerId, '登录拿到的还是同一个 playerId（换设备不掉战绩）');

    const wrong = await httpJson(PORT, 'POST', '/api/auth/login', { name: alice.name, password: 'wrong-pass' });
    eq(wrong.status, 401, '错误密码 → 401');

    const ghost = await httpJson(PORT, 'POST', '/api/auth/login', { name: 'nobody-here', password: 'whatever' });
    eq(ghost.status, 401, '不存在的账号 → 401');
    eq(ghost.json.error, wrong.json.error, '两种情况错误文案完全一致（不能用来枚举账号）');

    // 大小写不同的账号名也能登录（唯一性按小写，登录也应一致）
    const upper = await httpJson(PORT, 'POST', '/api/auth/login', {
      name: alice.name.toUpperCase(), password: alice.password
    });
    eq(upper.status, 200, '账号名大小写不影响登录');
  }

  /* ==================== 五、鉴权接口 ==================== */
  console.log('\n[/api/auth/me 与改密码]');
  {
    const me = await httpAuth(PORT, 'GET', '/api/auth/me', alice.token);
    eq(me.status, 200, '带令牌可取自己的身份');
    eq(me.json.me.playerId, alice.playerId, '返回正确 playerId');
    ok(!!me.json.me.account && me.json.me.account.name, '返回账号名');
    ok(JSON.stringify(me.json).indexOf('hash') < 0, '响应里没有密码哈希');

    const noTok = await httpAuth(PORT, 'GET', '/api/auth/me', null);
    eq(noTok.status, 401, '不带令牌 → 401');

    const badTok = await httpAuth(PORT, 'GET', '/api/auth/me', alice.token + 'x');
    eq(badTok.status, 401, '令牌被改 → 401');

    /* 两种头都要认。线上网关会把 Authorization 消费掉，所以前端走
     * X-Session-Token —— 但本地 curl 调试还在用 Bearer，不能丢。 */
    const byBearer = await httpAuthBearer(PORT, 'GET', '/api/auth/me', alice.token);
    eq(byBearer.status, 200, 'Authorization: Bearer 仍然可用（本地调试）');
    const byCustom = await httpAuth(PORT, 'GET', '/api/auth/me', alice.token);
    eq(byCustom.status, 200, 'X-Session-Token 可用（线上实际走的路径）');
    const both = await httpJson(PORT, 'GET', '/api/auth/me', null, {
      'X-Session-Token': alice.token, Authorization: 'Bearer fake-token'
    });
    eq(both.status, 200, '两个头同时存在时以 X-Session-Token 为准');

    /* 滑动续期：刚签发的令牌不该被换，寿命过半的令牌会被换成全新的一整程。
     * 这是「第一次登录后不用每次都登」的实际机制——打开游戏就顺手续一次。 */
    const secret = fs.readFileSync(
      path.join(path.dirname(profiles.file), 'auth-secret.txt'), 'utf8'
    ).trim();
    ok(!me.json.token, '刚签发的令牌不续期（响应里不带新令牌）');

    const oldTok = auth.signToken(alice.playerId, secret, { now: Date.now() - auth.TOKEN_TTL_MS * 0.8 });
    const renewed = await httpAuth(PORT, 'GET', '/api/auth/me', oldTok);
    eq(renewed.status, 200, '寿命过半的令牌仍然能通过校验（不是过期）');
    ok(!!renewed.json.token, '寿命过半 → 顺手下发新令牌');
    ok(renewed.json.token !== oldTok, '下发的是另一个令牌');
    const reparsed = auth.verifyToken(renewed.json.token, secret);
    ok(!!reparsed && reparsed.exp - reparsed.iat === auth.TOKEN_TTL_MS, '新令牌是完整一整程，不是剩余时长');
    const again = await httpAuth(PORT, 'GET', '/api/auth/me', renewed.json.token);
    eq(again.status, 200, '换来的新令牌立刻可用');
    ok(!again.json.token, '再调一次就不再续，避免每次都换');

    // 改密码
    const wrongOld = await httpAuth(PORT, 'POST', '/api/auth/password', alice.token,
      { oldPassword: 'nope-nope', newPassword: 'brand-new-pass' });
    eq(wrongOld.status, 403, '原密码不对 → 403');

    const weakNew = await httpAuth(PORT, 'POST', '/api/auth/password', alice.token,
      { oldPassword: alice.password, newPassword: '123' });
    eq(weakNew.status, 400, '新密码太弱 → 400');

    const changed = await httpAuth(PORT, 'POST', '/api/auth/password', alice.token,
      { oldPassword: alice.password, newPassword: 'brand-new-pass' });
    eq(changed.status, 200, '改密码成功');
    ok(!!changed.json.token, '改完下发新令牌');

    const oldLogin = await httpJson(PORT, 'POST', '/api/auth/login', { name: alice.name, password: alice.password });
    eq(oldLogin.status, 401, '旧密码失效');
    const newLogin = await httpJson(PORT, 'POST', '/api/auth/login', { name: alice.name, password: 'brand-new-pass' });
    eq(newLogin.status, 200, '新密码可登录');
    alice.password = 'brand-new-pass';
    alice.token = newLogin.json.token;
  }

  /* ==================== 六、管理端 ==================== */
  console.log('\n[管理端]');
  {
    const noKey = await httpAuth(PORT, 'GET', '/api/admin/users', null);
    eq(noKey.status, 403, '不带密钥 → 403');

    const badKey = await httpJson(PORT, 'GET', '/api/admin/users', undefined, { 'x-backup-key': 'nope' });
    eq(badKey.status, 403, '错误密钥 → 403');

    const list = await httpJson(PORT, 'GET', '/api/admin/users', undefined, { 'x-backup-key': KEY });
    eq(list.status, 200, '正确密钥可列出用户');
    ok(Array.isArray(list.json.list) && list.json.list.length >= 1, '列表非空');
    const row = list.json.list.find((u) => u.playerId === alice.playerId);
    ok(!!row, '目标用户出现在列表里');
    ok(!!row && row.account === alice.name, '列表里带账号名');
    ok(JSON.stringify(list.json).indexOf('hash') < 0, '列表不含密码哈希');

    // 改昵称
    const ren = await httpJson(PORT, 'POST', '/api/admin/nickname',
      { account: alice.name, nickname: '新名字' }, { 'x-backup-key': KEY });
    eq(ren.status, 200, '改昵称成功');
    eq((profiles.get(alice.playerId) || {}).nickname, '新名字', '档案昵称已更新');
    eq((profiles.accountOf(alice.playerId) || {}).name, alice.name, '账号名没被动过（否则人就登不进来了）');

    // 管理员重置密码（用户忘记密码时唯一的出路）
    const reset = await httpJson(PORT, 'POST', '/api/admin/password',
      { account: alice.name, password: 'admin-set-pass' }, { 'x-backup-key': KEY });
    eq(reset.status, 200, '重置密码成功');
    const afterReset = await httpJson(PORT, 'POST', '/api/auth/login', { name: alice.name, password: 'admin-set-pass' });
    eq(afterReset.status, 200, '用管理员设的密码能登录');

    // 停用
    const dis = await httpJson(PORT, 'POST', '/api/admin/disable',
      { account: alice.name, disabled: true }, { 'x-backup-key': KEY });
    eq(dis.status, 200, '停用成功');
    const blocked = await httpJson(PORT, 'POST', '/api/auth/login', { name: alice.name, password: 'admin-set-pass' });
    eq(blocked.status, 401, '停用后登录被拒');
    ok(blocked.json.error.indexOf('停用') >= 0, '错误文案说明是被停用', blocked.json.error);

    const meWhileOff = await httpAuth(PORT, 'GET', '/api/auth/me', alice.token);
    eq(meWhileOff.status, 403, '停用后旧令牌也取不到身份');

    // 恢复
    await httpJson(PORT, 'POST', '/api/admin/disable', { account: alice.name, disabled: false }, { 'x-backup-key': KEY });
    const back = await httpJson(PORT, 'POST', '/api/auth/login', { name: alice.name, password: 'admin-set-pass' });
    eq(back.status, 200, '恢复后可以登录');

    // 删除
    const del = await httpJson(PORT, 'POST', '/api/admin/delete', { account: alice.name }, { 'x-backup-key': KEY });
    eq(del.status, 200, '管理员删除用户成功');
    ok(profiles.accountOf(alice.playerId) === null, '档案与账号都没了');

    const unknown = await httpJson(PORT, 'POST', '/api/admin/delete', { account: 'ghost-user' }, { 'x-backup-key': KEY });
    eq(unknown.status, 404, '删不存在的用户 → 404');
  }

  /* ==================== 七、登录限流 ==================== */
  console.log('\n[登录限流]');
  {
    const bob = await registerPlayer(PORT, '鲍勃');
    let last = null;
    for (let i = 0; i < 7; i++) {
      last = await httpJson(PORT, 'POST', '/api/auth/login', { name: bob.name, password: 'wrong-' + i });
    }
    eq(last.status, 429, '连续错误 7 次后被限流 → 429');
    ok(last.json.error.indexOf('分钟') >= 0, '提示还要等多久', last.json.error);

    // 限流期间即使密码正确也进不来（否则限流等于没限）
    const correctWhileBlocked = await httpJson(PORT, 'POST', '/api/auth/login',
      { name: bob.name, password: bob.password });
    eq(correctWhileBlocked.status, 429, '限流期内正确密码也被挡');
  }

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error('测试异常:', e); process.exit(1); });
