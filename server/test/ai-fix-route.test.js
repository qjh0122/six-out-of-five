/**
 * 人机局历史修正的**接口层**测试（不是数据层）
 * 跑法：node server/test/ai-fix-route.test.js
 *
 * 数据层的行为（搬走/撤销/重算/残值）由 ai-records.test.js 锁住。这里只验路由，
 * 而要验的重点全都来自一次真实事故（2026-10-30 上线当天）：
 *
 *   · mark 的 POST **必须显式给 keys**。原来的实现是「不给就重算全部候选」，
 *     而候选判据（playerCount − 落库人数）会随数据变化而漂移 —— 搬走一行，
 *     那个人的「最老流水」变新，原来能被窗口截断解释的缺口就变成解释不了，
 *     候选越算越多。当时连着 POST 两次，第二次的 4 个新 key 把 9 条真实战绩
 *     挪进了人机流水（15 条里 4 条无辜）。
 *   · 因此必须有 unmark（撤销）与 restore（快照覆盖）两条后路 —— 推断就是推断，
 *     判错了要能当场退回去。
 *   · 三条路由都必须走 x-backup-key，等长伪造也要拒。
 */
'use strict';

const path = require('path');
const os = require('os');

process.env.PROFILE_FILE = path.join(os.tmpdir(), 'lxw-aifix-profiles-' + Date.now() + '.json');
process.env.SEED_FILE = path.join(os.tmpdir(), 'lxw-aifix-seed-' + Date.now() + '.json');
process.env.BACKUP_KEY = 'aifix-test-key-0123456789';
process.env.PORT = process.env.PORT || '3198';
const PORT = Number(process.env.PORT);

const { server, profiles } = require('../index.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

const BASE = 'http://127.0.0.1:' + PORT;
const KEY = process.env.BACKUP_KEY;
const SC = '?sharecode=TESTCODE';

function call(method, path_, body, key) {
  return fetch(BASE + path_ + SC, {
    method: method,
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      key === undefined ? { 'x-backup-key': KEY } : (key ? { 'x-backup-key': key } : {})
    ),
    body: body === undefined ? undefined : JSON.stringify(body)
  }).then((r) => r.json().then((j) => ({ status: r.status, json: j })));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async function main() {
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  await wait(60);

  /* 造两个人的三场局：前两场是**两个真人**（playerCount 2 且两人都落库 → 没有空座位），
   * 第三场 playerCount=3 但只有一个人落库 → 无法用「窗口截断」解释
   * → suggestAiGames 只该把第三场列成候选。
   * 前两场如果只记一个人，它们自己也会成为候选（gap 1），候选数就不是 1 了。 */
  profiles.record('pfix', '修', 6, 1000, '550001', 1, { playerCount: 2, endReason: 'scoreZero' });
  profiles.record('pfix2', '修二', -6, 1000, '550001', 1, { playerCount: 2, endReason: 'scoreZero' });
  profiles.record('pfix', '修', -4, 2000, '550002', 2, { playerCount: 2, endReason: 'scoreZero' });
  profiles.record('pfix2', '修二', 4, 2000, '550002', 2, { playerCount: 2, endReason: 'scoreZero' });
  profiles.record('pfix', '修', 20, 9000, '550003', 3, { playerCount: 3, endReason: 'scoreZero' });

  console.log('\n[1] GET 只列候选，一个字节都不改');
  const g1 = await call('GET', '/api/admin/mark-ai-games');
  eq(g1.status, 200, 'GET 200');
  eq(g1.json.dryRun, true, '标了 dryRun');
  eq((g1.json.candidates || []).length, 1, '★ 找到 1 个候选');
  eq(g1.json.candidates[0].key, '550003#9000', '候选就是那一场');
  eq(profiles.get('pfix').games, 3, '★ GET 之后档案没变（还是 3 场）');

  console.log('\n[2] POST 不给 keys → 400，且绝不自己重算候选');
  const noKeys = await call('POST', '/api/admin/mark-ai-games', { apply: true });
  eq(noKeys.status, 400, '★ 没有 keys 被拒');
  ok(/keys/.test(noKeys.json.error || ''), '错误信息点明要 keys', noKeys.json.error);
  eq(profiles.get('pfix').games, 3, '★ 被拒之后数据也没动');

  console.log('\n[3] POST 给 keys → 搬走，且重复调用是幂等的');
  const applied = await call('POST', '/api/admin/mark-ai-games', { apply: true, keys: ['550003#9000'] });
  eq(applied.status, 200, 'POST 200');
  eq(applied.json.moved, 1, '搬走 1 条');
  eq(applied.json.profiles, 1, '涉及 1 份档案');
  eq(profiles.get('pfix').games, 2, '★ 场次 3 → 2');
  eq(profiles.get('pfix').totalNet, 2, '★ 净胜 6-4 = 2');
  eq(profiles.get('pfix').aiGames, 1, 'aiGames 记 1');

  const again = await call('POST', '/api/admin/mark-ai-games', { apply: true, keys: ['550003#9000'] });
  eq(again.json.moved, 0, '★ 同一批 keys 再调一次移动 0 条（幂等）');
  eq(profiles.get('pfix').aiGames, 1, 'aiGames 没有被加成 2');

  /* 这一步是事故的复现形态：如果接口还允许「不给 keys 就重算」，
   * 上面那次重复调用会搬走更多东西。这里显式确认候选**没有**变成 2 个以上。 */
  const g2 = await call('GET', '/api/admin/mark-ai-games');
  ok((g2.json.candidates || []).every((c) => c.key !== '550003#9000'),
    '★ 搬走的那场不再出现在候选里（推断输入已变，所以候选必须冻结）');

  console.log('\n[4] unmark 撤销：判错了能退回去');
  const undo = await call('POST', '/api/admin/unmark-ai-games', { keys: ['550003#9000'] });
  eq(undo.status, 200, '撤销 200');
  eq(undo.json.moved, 1, '搬回 1 条');
  const back = profiles.getSelf('pfix');
  eq(back.games, 3, '★ 场次回到 3');
  eq(back.totalNet, 22, '★ 净胜回到 22');
  eq(back.aiGames, 0, '★ aiGames 归零');
  eq(back.aiRecent.length, 0, '★ 人机流水清空');

  const undoNoKeys = await call('POST', '/api/admin/unmark-ai-games', {});
  eq(undoNoKeys.status, 400, '撤销不给 keys 也是 400');

  console.log('\n[5] restore：用备份快照整体覆盖');
  const snap = profiles.dump();
  profiles.record('pfix', '修', 5, 20000, '550009', 9, { playerCount: 2, endReason: 'scoreZero' });
  eq(profiles.get('pfix').games, 4, '先制造一条「不该存在」的场次');

  const rs = await call('POST', '/api/admin/restore', { profiles: snap });
  eq(rs.status, 200, 'restore 200');
  eq(rs.json.count, 2, '覆盖了 2 份档案（修 + 修二）');
  eq(profiles.get('pfix').games, 3, '★ 覆盖后回到 3 场');
  eq(profiles.get('pfix').totalNet, 22, '★ 净额也回去了');

  const rsBad = await call('POST', '/api/admin/restore', { profiles: [] });
  eq(rsBad.status, 400, '空快照被拒');
  const rsBad2 = await call('POST', '/api/admin/restore', { nope: 1 });
  eq(rsBad2.status, 400, '形状不对被拒');

  console.log('\n[6] 三条路由都要密钥');
  for (const p of ['/api/admin/mark-ai-games', '/api/admin/unmark-ai-games', '/api/admin/restore']) {
    const noKey = await call(p === '/api/admin/mark-ai-games' ? 'GET' : 'POST', p,
      p === '/api/admin/mark-ai-games' ? undefined : { keys: ['x'], profiles: [] }, null);
    eq(noKey.status, 403, p + ' 不带密钥被拒');
    const fake = await call(p === '/api/admin/mark-ai-games' ? 'GET' : 'POST', p,
      p === '/api/admin/mark-ai-games' ? undefined : { keys: ['x'], profiles: [] }, 'x'.repeat(KEY.length));
    eq(fake.status, 403, p + ' 等长伪造密钥被拒');
  }

  console.log('\n' + '='.repeat(40));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
