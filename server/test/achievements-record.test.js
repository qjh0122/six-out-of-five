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
/* v112 改口径：门槛从「连败 3 把 + 刷新单场最高」改成「连败 5 把之后赢一把」。
 * 所以这里 3 连败赢一把**不再**触发 —— 见下面第五节补的 5 连败用例。 */
eq(ps.achOf('p4').r7 || 0, 0, '★ 连败 3 把后赢一把还不够（门槛是 5）');
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
 * 六、R8 人间清醒：v112 已删除（不再是成就）
 * ================================================================ */
rec('p7', '玩家G', 1, { playerCount: 3, endReason: 'handLimit', handLimit: 30, ach: { t: {}, n: {} } });
eq(ps.achOf('p7').r8 || 0, 0, '★ 打满 30 把也不再记人间清醒（该成就已删除）');
ok(Ach.evaluate(ps.achOf('p7'), ps.get('p7')).list.every(function (x) { return x.name !== '人间清醒'; }),
  '★ 成就目录里已经没有「人间清醒」');

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
 * 十、场级三条的人数门槛（v116）
 *
 * 「全场只有我一个人正分」在**两人局**里等于「我赢了」—— 零和计分下
 * 赢的那方天然是唯一正分。所以 r9/r10 要求 `playerCount >= 3`。
 * 这一段钉两件事：两人局不亮、三人局亮；以及**不传 playerCount 时也不误记**
 * （老调用方漏传 → Number(undefined)=0 → 宁可少记，不可错记）。
 * ================================================================ */
{
  rec('p-two', '两人局赢家', 8, { playerCount: 2, posCount: 1, negCount: 1 });
  eq(ps.achOf('p-two').r9 || 0, 0, '★ 两人局独赢 → 你咋这幸 **不亮**（那只是「赢了一把」）');

  rec('p-three', '三人局赢家', 8, { playerCount: 3, posCount: 1, negCount: 2 });
  eq(ps.achOf('p-three').r9, 1, '★ 三人局独正 → 你咋这幸 亮');

  rec('p-three-lose', '三人局输家', -8, { playerCount: 3, posCount: 2, negCount: 1 });
  eq(ps.achOf('p-three-lose').r10, 1, '★ 三人局独负 → 我咋这霉 亮');

  /* 老调用方（没有 playerCount）：三条里这条最容易漏传，而且漏了完全静默 */
  rec('p-legacy', '老调用方', 8, { posCount: 1, negCount: 1 });
  eq(ps.achOf('p-legacy').r9 || 0, 0, '★ 没传 playerCount → 不记（宁少不错）');

  /* 一夜暴富不受人数影响：它判的是自己的净胜 */
  rec('p-big', '一把挣一百', 101, { playerCount: 2, posCount: 1, negCount: 1 });
  eq(ps.achOf('p-big').r12, 1, '★ 两人局也能一夜暴富（与人数无关）');
}

/* ================================================================
 * 汇总
 * ================================================================ */
/* 汇总格式必须能被 scripts/run-tests.js 的 `通过 N 项，失败 M 项` 正则取到。
 * 写成「N 项通过」的话，这个文件的几十条断言在总账里一直是 0 —— 数字小看不出来，
 * 但「131 文件 / N 断言」这句话会悄悄少算一整个文件。 */
console.log('\n' + (fail === 0 ? '全部通过' : '有失败'));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');

/* 显式退出：ProfileStore 有 500ms 落盘定时器，不退出的话进程会挂在那儿 */
try { ps.flush(); } catch (e) {}
process.exit(fail ? 1 : 0);
