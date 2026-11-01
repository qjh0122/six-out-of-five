/**
 * 清空排行榜（保留账号）：POST /api/admin/reset-stats
 * 跑法：node server/test/reset-stats.test.js
 *
 * 为什么需要它：原来的 /api/admin/reset 会**连账号一起清掉**，
 * 想让榜单归零就只能把所有人的账号删了——大家下次进游戏必须重新注册。
 * 「清空排行榜」和「清空全部数据」是两件事，混在一起的代价是所有人登不进来。
 *
 * 这里锁死四件事，第 3 条是核心：
 *   1. 鉴权与 reset 同源（同一把密钥、只接受 POST）
 *   2. 战绩真归零：榜单空、场次/净胜/连胜/最近流水全清
 *   3. ★ 账号还在：原账号 + 原密码能登录，昵称不变，改密码后也不再是「账号不存在」
 *   4. 立刻落盘：重启（新实例读同一个文件）不会把旧战绩带回来
 */
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');

const TMP = os.tmpdir();
const PROFILE_FILE = path.join(TMP, 'lxw-rst-profiles-' + Date.now() + '.json');
process.env.PROFILE_FILE = PROFILE_FILE;
process.env.SEED_FILE = path.join(TMP, 'lxw-rst-seed-' + Date.now() + '.json');
process.env.BACKUP_KEY = 'reset-stats-test-key-123456';
process.env.PORT = process.env.PORT || '3215';
const PORT = Number(process.env.PORT);

const { server, hub, profiles } = require('../index.js');
const { ProfileStore } = require('../profile.js');
const auth = require('../auth.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

function request(method, p, headers, body) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({}, headers || {});
    let payload = null;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: p, method: method, headers: h
    }, (res) => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(b); } catch (e) { /* 非 JSON 原样返回 */ }
        resolve({ status: res.statusCode, body: parsed, raw: b });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const KEY = process.env.BACKUP_KEY;

async function main() {
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.listen(PORT, '127.0.0.1', resolve);
  });

  console.log('\n[准备] 两个真实账号 + 若干战绩');
  const c1 = await profiles.createAccount('alice', 'alice123456', '爱丽丝');
  const c2 = await profiles.createAccount('bob', 'bob123456', '鲍勃');
  ok(c1.ok === true && c2.ok === true, '两个账号都建好了', JSON.stringify([c1, c2]));
  const p1 = { playerId: c1.playerId };
  const p2 = { playerId: c2.playerId };
  profiles.record(p1.playerId, '爱丽丝', 26, Date.now(), '111111', 1);
  profiles.record(p1.playerId, '爱丽丝', 12, Date.now(), '222222', 2);
  profiles.record(p2.playerId, '鲍勃', -9, Date.now(), '111111', 1);
  profiles.flush();

  let r = await request('GET', '/api/leaderboard');
  eq(r.body.list.length, 2, '榜单上有 2 个人');
  const aliceRow = r.body.list.find(x => x.nickname === '爱丽丝');
  ok(!!aliceRow && aliceRow.games === 2, '爱丽丝 2 场');
  ok(!!aliceRow && aliceRow.totalNet === 38, '爱丽丝净胜 38（26+12）');

  /* ---------------------------------------------------------------- */
  console.log('\n[鉴权] 与 reset 同源');
  r = await request('POST', '/api/admin/reset-stats');
  eq(r.status, 403, '不带 x-backup-key → 403');
  r = await request('POST', '/api/admin/reset-stats', { 'x-backup-key': 'nope-nope-nope' });
  eq(r.status, 403, '错误密钥 → 403');
  r = await request('GET', '/api/admin/reset-stats', { 'x-backup-key': KEY });
  eq(r.status, 405, 'GET（带对密钥）→ 405，防链接预取误触');
  r = await request('GET', '/api/leaderboard');
  eq(r.body.list.length, 2, '三次被拒之后数据原封不动');
  eq(r.body.list.find(x => x.nickname === '爱丽丝').games, 2, '战绩也还在');

  /* ---------------------------------------------------------------- */
  console.log('\n[清空] 正确密钥 → 战绩归零');
  r = await request('POST', '/api/admin/reset-stats', { 'x-backup-key': KEY });
  eq(r.status, 200, '正确密钥 → 200');
  eq(r.body.cleared, 2, '回报重置了 2 份档案');
  eq(r.body.mode, 'stats', '★ 回包 mode=stats（能确认调的是「只清战绩」这个入口）');

  r = await request('GET', '/api/leaderboard');
  eq(r.body.list.length, 0, '榜单已空（有战绩的才上榜）');

  const a = profiles.data.get(p1.playerId);
  ok(!!a, '★ 档案对象还在（没被整份删掉）');
  eq(a.games, 0, '场次归零');
  eq(a.totalNet, 0, '净胜归零');
  eq(a.wins, 0, '胜场归零');
  eq(a.currentStreak, 0, '连胜归零');
  eq(a.longestStreak, 0, '最长连胜归零');
  eq(a.recent.length, 0, '最近流水清空');
  eq(a._seen, undefined, '幂等键也清了（旧场次已不存在，留着白占名额）');

  /* ---------------------------------------------------------------- */
  console.log('\n[★ 核心] 账号必须还在，而且能照常登录');
  eq(a.nickname, '爱丽丝', '昵称保留');
  ok(!!a.account, '账号对象还在');
  eq(profiles.findByAccountName('alice') && profiles.findByAccountName('alice').playerId,
    p1.playerId, '按账号名仍能查到（_byName 索引没被清）');

  r = await request('POST', '/api/auth/login', null, { name: 'alice', password: 'alice123456' });
  eq(r.status, 200, '★ 原账号 + 原密码登录成功');
  ok(!!(r.body && r.body.token), '拿到了新令牌');
  eq(r.body && r.body.me && r.body.me.playerId, p1.playerId,
    '登录拿回的还是同一个 playerId（战绩历史不会断）');
  eq(r.body && r.body.me && r.body.me.nickname, '爱丽丝', '登录回包里的昵称也还在');

  r = await request('POST', '/api/auth/login', null, { name: 'bob', password: 'bob123456' });
  eq(r.status, 200, '第二个账号也能登录');

  /* 大小写不敏感这条也要活着 */
  r = await request('POST', '/api/auth/login', null, { name: 'ALICE', password: 'alice123456' });
  eq(r.status, 200, '大小写不同的账号名仍能登录');

  /* 错误密码仍然是错误密码——不要因为「账号还在」就把校验绕过去 */
  r = await request('POST', '/api/auth/login', null, { name: 'alice', password: 'wrong-pass' });
  ok(r.status === 401 || r.status === 403, '错密码仍被拒（' + r.status + '）');

  /* ---------------------------------------------------------------- */
  /* 这一步很容易漏：清成 0 场之后，档案看上去就和「只 ensure 过、从没打过」的
   * 僵尸档案一模一样。如果 prune() 不豁免「有账号」的那批，清空排行榜就会在
   * 几次记录之后把大家的账号一起扫掉——用户会发现「清了个榜，号没了」。
   * prune 现在第 342 行有 `if (p.account) return;`，这里锁住它。 */
  console.log('\n[★ 关键] 清成 0 场之后不能被 prune 当僵尸档案扫掉');
  const pruned = profiles.prune();
  eq(pruned.length, 0, '★ prune 一份都没删（有账号的一律豁免）');
  ok(!!profiles.data.get(p1.playerId), '★ 爱丽丝的档案还在');
  ok(!!profiles.data.get(p2.playerId), '★ 鲍勃的档案还在');
  eq(profiles.data.size, 2, '两份档案都还在');
  r = await request('POST', '/api/auth/login', null, { name: 'alice', password: 'alice123456' });
  eq(r.status, 200, '★ prune 之后再登录照样成功');

  /* ---------------------------------------------------------------- */
  console.log('\n[落盘] 立刻写文件，重启不能把旧战绩带回来');
  const disk = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
  eq(Object.keys(disk).length, 2, '文件里还有 2 份档案（不是 {}）');
  const diskA = disk[p1.playerId];
  ok(!!diskA, '文件里有爱丽丝');
  eq(diskA.games, 0, '★ 文件里的战绩也归零了（不是等 500ms 延迟刷盘）');
  ok(!!diskA.account, '★ 文件里的账号信息仍在（salt/hash 没丢）');

  /* 新实例读同一个文件 = 模拟重启 */
  /* 构造函数里同步跑完 _load()，这条路等价于「进程重启后读同一个主文件」 */
  const fresh = new ProfileStore({ file: PROFILE_FILE, seedFile: null });
  const freshA = fresh.data.get(p1.playerId);
  ok(!!freshA, '重启后档案还在');
  eq(freshA.games, 0, '重启后战绩仍是 0');
  eq(freshA.nickname, '爱丽丝', '重启后昵称还在');

  /* 重启后还能登录：直接用 auth 校验口令 */
  const okPw = await auth.verifyPassword('alice123456', freshA.account.salt, freshA.account.hash);
  ok(okPw === true, '★ 重启后原密码仍能校验通过（账号没被清）');

  /* ---------------------------------------------------------------- */
  console.log('\n[对比] reset 与 reset-stats 是两件事');
  ok(aliceRow && aliceRow.games === 2, '上面清空前确实有战绩（不是空跑假通过）');
  r = await request('POST', '/api/admin/reset', { 'x-backup-key': KEY });
  eq(r.status, 200, '全清入口也能用');
  eq(r.body.mode, 'all', '★ 全清回包 mode=all（两个入口能区分开）');
  eq(r.body.cleared, 2, '全清清掉 2 份');
  eq(profiles.findByAccountName('alice'), null, '★ 全清之后账号没了（这正是 reset-stats 不该发生的事）');

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  try { hub.closeAll && hub.closeAll(); } catch (e) { /* 忽略 */ }
  try { profiles.flush(); } catch (e) { /* 忽略 */ }
  try { fs.unlinkSync(PROFILE_FILE); } catch (e) { /* 忽略 */ }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
