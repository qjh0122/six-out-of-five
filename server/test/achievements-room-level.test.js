/**
 * 场级成就（node server/test/achievements-room-level.test.js）
 *
 * 2026-11-11 口径纠错：你咋这幸 / 我咋这霉 / 一夜暴富 三条从**把**改成**场**。
 *
 * 为什么需要这个文件单独守着：
 *
 *   1. 旧的把级实现（achievements.accumulateHand）按每一把判一次，
 *      表现为「全操 235 场却有 277 次」—— 玩家拿它跟场次比必然算不通。
 *   2. 把级桶 `meta.ach` 在一局里一个人都没拿牌型时是 null。
 *      场级判定如果写在 `if (run)` 里，那一场就静默漏记，且毫无痕迹。
 *      所以这里有一条专门断言「不传 ach 也要记」。
 *   3. 「净胜 > 100」是严格大于，100 整不算 —— 这是用户原话的边界。
 *
 * 判据独立：期望值全部写死，没有一处拿被测函数算期望。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), 'lxw-ach-room-' + Date.now());
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

let seq = 0;
function rec(pid, nick, net, meta) {
  seq += 1;
  return ps.record(pid, nick, net, 1700000000000 + seq * 1000, 'R' + seq, seq, meta);
}
function ach(pid) { return ps.achOf(pid) || {}; }

/* ================================================================
 * 一、你咋这幸（r9）：整场只有我一个人正分
 * ================================================================ */
{
  /* 同一场：甲 +10、乙 -5、丙 -5 → 正分 1 人、负分 2 人 */
  const meta = { playerCount: 3, posCount: 1, negCount: 2 };
  rec('u1', '甲', 10, meta);
  rec('u2', '乙', -5, meta);
  rec('u3', '丙', -5, meta);

  eq(ach('u1').r9, 1, '★ 整场唯一正分 → 你咋这幸 +1');
  eq(ach('u2').r9 || 0, 0, '负分的人拿不到你咋这幸');
  eq(ach('u3').r9 || 0, 0, '负分的人拿不到你咋这幸');
  eq(ach('u2').r10 || 0, 0, '负分有两个人 → 谁都不是「唯一负分」');
}

/* ================================================================
 * 二、我咋这霉（r10）：整场只有我一个人负分
 * ================================================================ */
{
  const meta = { playerCount: 3, posCount: 2, negCount: 1 };
  rec('u4', '丁', -10, meta);
  rec('u5', '戊', 5, meta);
  rec('u6', '己', 5, meta);

  eq(ach('u4').r10, 1, '★ 整场唯一负分 → 我咋这霉 +1');
  eq(ach('u5').r10 || 0, 0, '正分的人拿不到我咋这霉');
  eq(ach('u5').r9 || 0, 0, '正分有两个人 → 没有「唯一正分」');
}

/* ================================================================
 * 三、一夜暴富（r12）：整场净胜 > 100，严格大于
 * ================================================================ */
{
  rec('u7', '庚', 101, { playerCount: 2, posCount: 1, negCount: 1 });
  eq(ach('u7').r12, 1, '★ 净胜 101 → 一夜暴富 +1');

  rec('u8', '辛', 100, { playerCount: 2, posCount: 1, negCount: 1 });
  eq(ach('u8').r12 || 0, 0, '★ 净胜正好 100 不算（要求严格大于 100）');

  rec('u9', '壬', 99, { playerCount: 2, posCount: 1, negCount: 1 });
  eq(ach('u9').r12 || 0, 0, '净胜 99 不算');
}

/* ================================================================
 * 四、不依赖把级桶（这一条是最容易写错的地方）
 * ================================================================ */
{
  /* meta 里**没有 ach**：模拟「这一局一个人都没拿牌型」或老客户端 */
  rec('u10', '癸', 10, { playerCount: 3, posCount: 1, negCount: 2 });
  eq(ach('u10').r9, 1, '★ 没有把级桶时场级成就照样记（不受 if (run) 影响）');

  /* 同一档案再打一场，仍然只有他正分 → 累加而不是覆盖 */
  rec('u10', '癸', 12, { playerCount: 3, posCount: 1, negCount: 2 });
  eq(ach('u10').r9, 2, '第二场唯一正分 → 累加到 2');
}

/* ================================================================
 * 五、老调用方不传人数 → 宁少不多
 * ================================================================ */
{
  rec('u11', '子', 10, { playerCount: 3 });
  eq(ach('u11').r9 || 0, 0, '★ 没传 posCount → 不误记（宁少不多，与 _residual 同一取向）');
  rec('u12', '丑', -10, { playerCount: 3 });
  eq(ach('u12').r10 || 0, 0, '没传 negCount → 不误记');
}

/* ================================================================
 * 六、AI 局一条都不记（与战绩口径一致）
 * ================================================================ */
{
  rec('u13', '寅', 10, { playerCount: 3, posCount: 1, negCount: 2, hasBot: true });
  eq(ach('u13').r9 || 0, 0, '含 AI 的对局不记场级成就（战绩也不记，两套口径必须同时成立）');
  eq(ach('u13').r12 || 0, 0, '含 AI 的对局不记一夜暴富');
}

/* ================================================================
 * 七、把级统计已经空转（锁住「不许改回去」）
 * ================================================================ */
{
  const run = Ach.accumulateHand(null, [
    { id: 'x', score: 10 }, { id: 'y', score: -5 }, { id: 'z', score: -5 }
  ]);
  eq(Ach.runOf(run, 'x'), null, '★ accumulateHand 不再产生任何计数（口径已移到场级）');
  eq(Ach.runOf(run, 'y'), null, '负分者也没有桶');
}

/* ================================================================
 * 八、文档口径：卡片文案不许再出现「把」
 * ================================================================ */
{
  const names = ['第一次', '势不可挡', '十连胜', '背到极点', '衰神附体',
    '一夜暴富', '翻身农奴', '你咋这幸', '我咋这霉'];
  const bad = [];
  names.forEach(function (n) {
    const it = Ach.CATALOG.filter(function (x) { return x.name === n; })[0];
    if (!it) { bad.push(n + '(找不到)'); return; }
    if (/把/.test(it.desc)) bad.push(n);
  });
  eq(bad.join(','), '', '★ 这九条的文案里不再出现「把」（口径统一到场）');
}

console.log('\n----------------------------------------');
if (fail) {
  console.error('失败 ' + fail + ' 项，通过 ' + pass + ' 项');
  process.exit(1);
} else {
  console.log('通过 ' + pass + ' 项，失败 0 项');
}
