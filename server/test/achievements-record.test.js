/**
 * 成就落库（node server/test/achievements-record.test.js）
 *
 * 统计在状态机里算（pwa/test/achievements.test.js 管那一层），
 * 这个文件只管**从房间桶到档案**这一段，也就是最容易出「不报错但数字错」的地方：
 *
 *   1. 一条流水只并一次（重复广播 / 断线重连都会让 record 被同一场调多次）；
 *   2. **AI 局一条都不记** —— 人机局不进战绩，也就不该进成就，
 *      两套口径必须同时成立，否则会出现「成就 30 次牛牛，战绩 0 场」；
 *   3. R7（翻身农奴）依赖 update **之前**的连胜与最高分，
 *      代码里那三行如果挪到 counter 后面就永远判不到 —— 这里专门钉住；
 *   4. 备份（dump）必须带上成就桶，漏了它跑一次 backup 就全清零；
 *   5. 清战绩要连成就一起清（resetStatsOf 从 _blank 取字段表）。
 *
 * 判据独立：期望值全部写死，没有一处拿被测函数算期望。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), 'lxw-ach-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });

const FILE = path.join(TMP, 'profiles.json');
const SEED = path.join(TMP, 'no-seed.json');   // 故意不存在：不读真实种子

const { ProfileStore } = require('../profile.js');
const Ach = require(path.join(__dirname, '..', '..', 'pwa', 'js', 'achievements.js'));

const ps = new ProfileStore({ file: FILE, seedFile: SEED });

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) pass += 1;
  else { fail += 1; console.error('✗ ' + name + (extra ? ' — ' + extra : '')); }
}
function eq(a, b, name) {
  ok(a === b, name, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b));
}

/* 每次 record 用不同的 roomSeq，避开幂等键；endedAt 也给不同值 */
let seq = 0;
function rec(pid, nick, net, meta) {
  seq += 1;
  return ps.record(pid, nick, net, 1700000000000 + seq * 1000, 'R' + seq, seq, meta);
}

/* 一个「第一轮三组全赢」的房间桶（结构直接手写，不调 accumulate —— 那是另一个文件的职责） */
function runSweep() {
  return { t: { th: 1 }, n: { tenhalf: 3 }, s1: 1, sw: 1, since: 1700000000000 };
}

/* ================================================================
 * 一、基础合并
 * ================================================================ */
rec('p1', '玩家A', 3, { playerCount: 3, endReason: 'handLimit', ach: runSweep() });
const a1 = ps.achOf('p1');
eq(a1.t.th, 1, '十点半次数写进档案');
eq(a1.n.tenhalf, 3, '分母写进档案');
eq(a1.s1, 1, '通吃写进档案');
eq(a1.since, 1700000000000, 'since 取房间桶给的时刻');

/* 第二局：再并一次 → 累加 */
rec('p1', '玩家A', 2, { playerCount: 3, endReason: 'handLimit', ach: runSweep() });
eq(ps.achOf('p1').t.th, 2, '第二局累加，不是覆盖');
eq(ps.achOf('p1').s1, 2, '通吃也累加');

/* ================================================================
 * 二、没传 ach 的老调用方：不能崩，也不能把已有成就清零
 * ================================================================ */
rec('p1', '玩家A', 1, { playerCount: 3, endReason: 'handLimit' });
eq(ps.achOf('p1').t.th, 2, '★ 没传 ach 时成就原样保留（老客户端 / 老调用路径）');

/* ================================================================
 * 三、AI 局不记成就
 * ================================================================ */
rec('p2', '玩家B', 4, { playerCount: 2, endReason: 'handLimit', hasBot: true, ach: runSweep() });
const b = ps.achOf('p2');
eq(b.t.th || 0, 0, '★ 人机局不记牌型成就');
eq(b.s1 || 0, 0, '人机局也不记通吃');
eq(ps.get('p2').aiGames, 1, '人机局本身照常记进 aiGames（口径没被带偏）');

/* ================================================================
 * 四、幂等：同一场重复落库，成就也只并一次
 * ================================================================ */
const dupRun = { t: { lp: 1 }, n: { piaosanye: 3 }, s1: 0, sw: 0 };
const before = ps.achOf('p3');
eq(before === undefined || before === null, true, 'p3 还没有档案');

ps.record('p3', '玩家C', 2, 1700000123000, 'SAME', 7, { playerCount: 3, endReason: 'handLimit', ach: dupRun });
ps.record('p3', '玩家C', 2, 1700000123000, 'SAME', 7, { playerCount: 3, endReason: 'handLimit', ach: dupRun });
ps.record('p3', '玩家C', 2, 1700000123000, 'SAME', 7, { playerCount: 3, endReason: 'handLimit', ach: dupRun });
eq(ps.achOf('p3').t.lp, 1, '★ 三次重复落库，豹子只记 1 次');
eq(ps.get('p3').games, 1, '场次也只记 1 场（同一把幂等键）');

/* ================================================================
 * 五、R7 翻身农奴：必须用更新**前**的连胜与最高分
 * ================================================================ */
rec('p4', '玩家D', -3, { playerCount: 3, endReason: 'handLimit' });   // 1 负
rec('p4', '玩家D', -3, { playerCount: 3, endReason: 'handLimit' });   // 2 负
rec('p4', '玩家D', -3, { playerCount: 3, endReason: 'handLimit' });   // 3 负
eq(ps.get('p4').currentStreak, -3, '已经连败 3 把');
eq(ps.get('p4').bestNet, -3, '此时个人最高是 -3（全负的人也有最好的那一场）');
eq(ps.achOf('p4').r7 || 0, 0, '连败期间还没触发翻身农奴');

/* 第 4 把赢 +12（新高），带一个空的成就桶 */
rec('p4', '玩家D', 12, { playerCount: 3, endReason: 'handLimit', ach: { t: {}, n: {} } });
eq(ps.achOf('p4').r7, 1, '★ 连败 3 把后打出新高 → 翻身农奴 +1');
eq(ps.get('p4').bestNet, 12, '最高分同时被更新（顺序对了才会两个都对）');

/* 反向：没连败时打出新高，不该触发 */
rec('p5', '玩家E', 5, { playerCount: 3, endReason: 'handLimit' });
rec('p5', '玩家E', 9, { playerCount: 3, endReason: 'handLimit', ach: { t: {}, n: {} } });
eq(ps.achOf('p5').r7 || 0, 0, '连胜中打出新高不算翻身农奴');

/* 反向：连败 3 把但没创新高（输得少了一点，仍是负的），也不该触发 */
rec('p6', '玩家F', -5, { playerCount: 3, endReason: 'handLimit' });
rec('p6', '玩家F', -5, { playerCount: 3, endReason: 'handLimit' });
rec('p6', '玩家F', -5, { playerCount: 3, endReason: 'handLimit' });
rec('p6', '玩家F', -4, { playerCount: 3, endReason: 'handLimit', ach: { t: {}, n: {} } });
eq(ps.achOf('p6').r7 || 0, 0, '★ 连败后仍是负分 → 不算「单场最高」');

/* ================================================================
 * 六、R8 人间清醒：只认「真的打满 30 把」
 * ================================================================ */
rec('p7', '玩家G', 1, { playerCount: 3, endReason: 'handLimit', handLimit: 30, ach: { t: {}, n: {} } });
eq(ps.achOf('p7').r8, 1, '30 把打满 → 人间清醒 +1');

rec('p8', '玩家H', 1, { playerCount: 3, endReason: 'handLimit', handLimit: 10, ach: { t: {}, n: {} } });
eq(ps.achOf('p8').r8 || 0, 0, '10 把的局不算（门槛是 30）');

rec('p9', '玩家I', 1, { playerCount: 3, endReason: 'dissolve', handLimit: 30, ach: { t: {}, n: {} } });
eq(ps.achOf('p9').r8 || 0, 0, '★ 选了 30 把但中途解散 → 不算打满');

/* ================================================================
 * 七、对外档案：数量 vs 明细
 * ================================================================ */
const self = ps.getSelf('p1');
ok(!!self && !!self.ach, 'getSelf 带完整成就桶（成就页要用）');
eq(self.ach.t.th, 2, '明细里的数字与档案一致');

const pub = ps.get('p1');
eq(pub.ach, undefined, '★ 对外档案**不带**明细（排行榜一次要带全部人，几十 KB 不值）');
eq(pub.achCount, self.achCount, '但数量一致（信息档要显示 12 / 26）');
eq(pub.achTotal, Ach.TOTAL, '总数取自同一份目录');

/* 一个成就都没解锁的人 */
const zero = ps.get('p9');
ok(zero.achCount >= 0, 'achCount 是数字，不是 undefined');

/* 不存在的玩家 */
eq(ps.achOf('nobody'), null, 'achOf 对不存在的人返回 null，不抛');

/* ================================================================
 * 八、备份与重置
 * ================================================================ */
const dumped = ps.dump();
const d1 = dumped.filter(function (x) { return x.playerId === 'p1'; })[0];
ok(!!d1, 'dump 里有 p1');
ok(!!d1 && !!d1.ach, '★ dump 带 ach —— 漏了它跑一次备份就全清零');
eq(d1 && d1.ach.t.th, 2, '备份里的数字与线上一致');

/* restoreFrom 能吃回这份快照（灾备回滚路径） */
ps.resetStatsOf('p1');
eq(ps.achOf('p1').t.th || 0, 0, '清战绩时成就一起清空');
const rr = ps.restoreFrom(dumped);
ok(rr && rr.ok !== false, 'restoreFrom 接受 dump 的快照');
eq(ps.achOf('p1').t.th, 2, '★ 从快照恢复后成就回来了（否则灾备等于把成就烧掉）');

/* ================================================================
 * 九、老档案（没有 ach 字段）
 * ================================================================ */
const oldGuy = ps.ensure('p-old', '老玩家');
delete oldGuy.ach;
ps.ensure('p-old', '老玩家');            // ensure 会跑 _ensureDerived
ok(!!ps.achOf('p-old'), '★ 老档案被补上空成就桶（成就页不会读到 undefined）');
eq(ps.achOf('p-old').t && Object.keys(ps.achOf('p-old').t).length, 0, '补出来的桶是空的');

/* ================================================================
 * 汇总
 * ================================================================ */
console.log('\n' + (fail === 0 ? '全部通过' : '有失败') + '：' + pass + ' 项通过，' + fail + ' 项失败');

/* 显式退出：ProfileStore 有 500ms 落盘定时器，不退出的话进程会挂在那儿 */
try { ps.flush(); } catch (e) {}
process.exit(fail ? 1 : 0);
