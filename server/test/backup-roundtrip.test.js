/**
 * 备份 → 种子 → 恢复 的往返测试
 * 跑法：node server/test/backup-roundtrip.test.js
 *
 * 为什么单独建一个套件：
 *   `persist.test.js` 测的是「ProfileStore 自己怎么读写文件」，
 *   而真正决定「灾难恢复能不能救回来」的是**备份脚本那条转换**——
 *   `dump()` 输出数组 → `buildSeedMap()` 转成 map → 写进种子文件。
 *   这一环以前没有任何测试，于是漏字段可以一路活到线上：
 *   脚本把 `account` 丢了，种子恢复出来的档案没有登录凭据，
 *   全员"账号不存在"，而所有现有测试都是绿的。
 *
 * 所以这里按两条线锁：
 *   正向——带上 account 的往返必须能登录；
 *   反向——故意去掉 account 时必须复现出"登不进去"，证明断言真的在拦。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { ProfileStore } = require('../profile');
const { buildSeedMap } = require('../../scripts/backup-leaderboard');

const TMP = path.join(os.tmpdir(), 'lxw-roundtrip-' + Date.now());
const LIVE_FILE = path.join(TMP, 'live', 'profiles.json');   // 主文件（在"容器里"）
const GONE_FILE = path.join(TMP, 'gone', 'profiles.json');   // 容器重建后：这个路径不存在
const SEED_OK = path.join(TMP, 'seed-with-account.json');
const SEED_BAD = path.join(TMP, 'seed-without-account.json');

fs.mkdirSync(TMP, { recursive: true });

const quiet = function () {};

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { pass += 1; console.log('  PASS  ' + label); }
  else { fail += 1; console.log('  FAIL  ' + label); }
}

const ACCOUNT = 'huizhang';
const BASE_AT = 1700000000000;   // 固定的基线时间戳，不用 Date.now()（断言才好写死）
const PASSWORD = 'correct-horse-9';

async function main() {
  /* ---------------------------------------------------------------
   * 1. 线上那一刻：主文件里有账号 + 战绩
   * --------------------------------------------------------------- */
  console.log('\n[1] 造一份"线上主文件"');
  const live = new ProfileStore({ file: LIVE_FILE, seedFile: SEED_OK, log: quiet });
  const created = await live.createAccount(ACCOUNT, PASSWORD, '会飞的长颈鹿');
  ok(created.ok, '账号建好了');
  const pid = created.playerId;

  /* 第一场带上成就增量：备份漏字段这种事已经发生过三次（account、ai*、
   * 以及 ach —— 漏了 ach，容器一重建所有人成就归零，而账号、战绩、榜单全好着，
   * 最容易归因成「成就功能有 bug」）。所以从这一场开始就让它非空。 */
  live.record(pid, '会飞的长颈鹿', 7, Date.now(), '654321', 1, {
    playerCount: 3, endReason: 'handLimit', posCount: 1, negCount: 2,
    ach: { vs: 3, vsn: 5, v: 1, t: { th: 2 }, n: { tenhalf: 6 } }
  });
  /* 一场人机局：aiGames / aiRecent 也必须过一遍备份脚本。
   * 白名单逐字段复制的漏字段已经发生过两次（account、ai*），这里各留一条断言。 */
  live.record(pid, '会飞的长颈鹿', 30, Date.now() + 1000, '654322', 2,
    { playerCount: 3, endReason: 'scoreZero', hasBot: true });
  /* 冻一份成就基线（重放起点）。发布时的顺序就是：先开事件日志，再冻基线。 */
  live.stampAchBase(BASE_AT);
  live.flush();
  ok(fs.existsSync(LIVE_FILE), '主文件已落盘');
  ok(!!live.accountOf(pid), '主文件里账号在（salt/hash 齐全）');

  /* ---------------------------------------------------------------
   * 2. 发布前跑备份脚本：dump → buildSeedMap → 写种子
   * --------------------------------------------------------------- */
  console.log('\n[2] 备份脚本的转换（这一步就是以前漏 account 的地方）');
  const dumped = live.dump();
  const map = buildSeedMap(dumped);

  ok(Object.keys(map).length === 1, '转出 1 条档案');
  const row = map[pid];
  ok(!!row, 'playerId 作为键，没被数组下标取代');
  ok(!!row.account, '★ account 被保留（漏了它 = 灾备失效）');
  ok(!!(row.account && row.account.salt), 'salt 在');
  ok(!!(row.account && row.account.hash), 'hash 在');
  ok(row.account && row.account.name === ACCOUNT, '账号名一致');
  ok(row.games === 1, '战绩字段也在（不只有账号）');
  ok(row.recent && row.recent.length === 1, 'recent 流水一并备份');
  ok(row.aiGames === 1, '★ aiGames 被保留（漏了它，恢复后「含人机」那行就没了）');
  ok(row.aiRecent && row.aiRecent.length === 1, '★ aiRecent 流水一并备份');
  ok(row.aiRecent && row.aiRecent[0] && row.aiRecent[0].ai === true, 'aiRecent 里带 ai 标记');
  ok(typeof row.longestLoseStreak === 'number', 'longestLoseStreak 也在（同一类白名单漏字段）');
  ok(row.ach && row.ach.vs === 3, '★ 成就桶跟着备份走了（漏了它 = 重建后所有人成就归零）');
  ok(row.ach && row.ach.t && row.ach.t.th === 2, '★ 牌型命中也在（嵌套结构整份带上）');
  ok(row.achBase && row.achBase.at === BASE_AT, '★ 成就基线（重放起点）也备份了');
  ok(row.achBase && row.achBase.counts && row.achBase.counts.vs === 3,
    '基线里是冻结的计数快照');

  fs.writeFileSync(SEED_OK, JSON.stringify(map), 'utf8');

  /* ---------------------------------------------------------------
   * 3. 容器重建：主文件路径不存在，只靠种子恢复
   * --------------------------------------------------------------- */
  console.log('\n[3] 模拟容器重建后启动（主文件不存在，只用种子）');
  ok(!fs.existsSync(GONE_FILE), '主文件确实不存在（这就是重建后的状态）');

  const restored = new ProfileStore({ file: GONE_FILE, seedFile: SEED_OK, log: quiet });
  ok(restored.restoredFromSeed === true, '走了种子恢复分支');

  const acct = restored.accountOf(pid);
  ok(!!acct, '★ 恢复出来的档案带着账号（以前这里是 null）');
  ok(acct && acct.name === ACCOUNT, '账号名正确');
  ok(restored.get(pid).games === 1, '战绩也恢复了');
  /* 用 data.get 而不是 get()：后者返回的是 _public（对外视图，不含原始 ach 桶） */
  const restRaw = restored.data.get(pid);
  ok(restRaw.ach && restRaw.ach.vs === 3,
    '★ 成就也恢复了（不是「账号在、成就是 0」的半截恢复）');
  ok(restRaw.achBase && restRaw.achBase.at === BASE_AT,
    '★ 成就基线也恢复了 —— 没有它，重放器只能从 0 起算');

  console.log('\n[4] 关键一步：恢复之后还能不能登录');
  const login = await restored.login(ACCOUNT, PASSWORD);
  ok(login.ok, '★ 用原密码能登进来（灾备的真正验收标准）');
  ok(login.ok && login.playerId === pid, '登回来的是同一个 playerId（战绩不会断）');

  const bad = await restored.login(ACCOUNT, 'wrong-password');
  ok(!bad.ok, '错误密码依然被拒（恢复没有把校验弄松）');

  /* ---------------------------------------------------------------
   * 5. 反向验证：把 account 拿掉，必须复现出"登不进去"
   *    这一条是为了证明上面那串 PASS 不是空转
   * --------------------------------------------------------------- */
  console.log('\n[5] 反向验证：故意去掉 account，断言必须能抓到');
  const brokenMap = buildSeedMap(dumped);
  Object.keys(brokenMap).forEach(function (k) { delete brokenMap[k].account; });
  fs.writeFileSync(SEED_BAD, JSON.stringify(brokenMap), 'utf8');

  const lost = new ProfileStore({
    file: path.join(TMP, 'gone2', 'profiles.json'),
    seedFile: SEED_BAD,
    log: quiet
  });
  ok(lost.accountOf(pid) === null, '没有 account 时 accountOf 返回 null（正是线上会发生的）');
  const lostLogin = await lost.login(ACCOUNT, PASSWORD);
  ok(!lostLogin.ok, '没有 account 时登录失败 —— 与"全员登不进来"的现场一致');
  ok(lost.get(pid) && lost.get(pid).games === 1, '战绩还在，但没人认领它（孤儿档案）');

  /* 反向：把 ach 拿掉，恢复出来的成就必须是空的 —— 证明上面那条断言不是空转 */
  const noAch = buildSeedMap(dumped);
  Object.keys(noAch).forEach(function (k) { delete noAch[k].ach; delete noAch[k].achBase; });
  const wipedFile = path.join(TMP, 'seed-no-ach.json');
  fs.writeFileSync(wipedFile, JSON.stringify(noAch), 'utf8');
  const wiped = new ProfileStore({
    file: path.join(TMP, 'gone3', 'profiles.json'),
    seedFile: wipedFile,
    log: quiet
  });
  const wipedRaw = wiped.data.get(pid);
  ok(!!wipedRaw && ((wipedRaw.ach && wipedRaw.ach.vs) || 0) === 0,
    '★ 种子不带 ach → 恢复后成就归零（这正是「备份漏 ach」的现场）');
  ok(!!wipedRaw && !wipedRaw.achBase, '★ 种子不带 achBase → 恢复后没有重放起点');

  /* ---------------------------------------------------------------
   * 6. 种子文件本身的自洽性
   * --------------------------------------------------------------- */
  console.log('\n[6] 种子文件的形状');
  const onDisk = JSON.parse(fs.readFileSync(SEED_OK, 'utf8'));
  ok(!Array.isArray(onDisk), '是对象 map 而不是数组（数组会被当成下标当 playerId）');
  ok(Object.keys(onDisk)[0] === pid, '键就是 playerId');
  ok(JSON.stringify(onDisk).indexOf('_seen') < 0, '不含 _seen（与 flush 口径一致）');
}

main().then(function () {
  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('========================================');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
}).catch(function (e) {
  console.error('测试自身崩了：', e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (x) {}
  process.exit(1);
});
