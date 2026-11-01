/**
 * 战绩数据层回归测试（Node 直接跑：node test/records.test.js）
 *
 * 核心回归点：同一房间连打多把不能被判成重复丢弃。
 * 这是 v0.2 修的致命 bug —— 旧实现用「同 roomId + 10 分钟窗」判重，
 * 把同一房间的第二把起全部静默吞掉。
 */
'use strict';

/* ---------------- mock localStorage ---------------- */
function makeLS() {
  var map = Object.create(null);
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
    setItem: function (k, v) { map[k] = String(v); },
    removeItem: function (k) { delete map[k]; },
    clear: function () { map = Object.create(null); },
    _dump: function () { return map; }
  };
}

global.localStorage = makeLS();
var Records = require('../js/records.js');

/* ---------------- 断言工具 ---------------- */
var pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(actual, expected, name) {
  ok(actual === expected, name, 'expect ' + expected + ', got ' + actual);
}
function reset() { global.localStorage.clear(); }

/* 造一条记录：net 由结束分减初始分推出 */
function rec(opts) {
  var start = opts.start === undefined ? 20 : opts.start;
  var end = opts.end;
  return {
    roomId: opts.roomId,
    endedAt: opts.endedAt,
    myStartScore: start,
    myEndScore: end,
    myNet: end - start,
    rounds: opts.rounds,
    playerCount: opts.playerCount || 4,
    endReason: opts.endReason || 'scoreZero'
  };
}

var MIN = 60 * 1000;
var T0 = new Date('2026-10-28T20:00:00+08:00').getTime();

/* ================================================================
 * 场景 1：同一房间连打 5 把，每把间隔 3 分钟（远小于旧的 10 分钟窗）
 * 修复前：只有第 1 把能进，后 4 把全丢
 * 修复后：5 把全进
 * ================================================================ */
console.log('\n[场景 1] 同房间连打 5 把（间隔 3 分钟）');
reset();
for (var i = 1; i <= 5; i++) {
  var r = Records.add(rec({
    roomId: '123456',
    endedAt: T0 + (i - 1) * 3 * MIN,
    end: 20 + i,          // 每把都赢 1 分，净胜相同（最容易误判的情况）
    rounds: i             // 局次递增，这是修复的关键依据
  }));
  ok(r.added === true, '第 ' + i + ' 把写入成功', JSON.stringify(r));
}
eq(Records.all().length, 5, '战绩共 5 条');
eq(Records.stats().games, 5, '场次 = 5');
eq(Records.stats().totalNet, 1 + 2 + 3 + 4 + 5, '累计净胜累加正确');

/* ================================================================
 * 场景 2：同一把被写两次（结算页刷新 / 重连导致 endedAt 漂移 3 秒）
 * 局次相同 → 必须判重，只留 1 条
 * ================================================================ */
console.log('\n[场景 2] 同一把重复写入（局次相同，时间漂移 3 秒）');
reset();
Records.add(rec({ roomId: '888888', endedAt: T0, end: 26, rounds: 1 }));
var dup = Records.add(rec({ roomId: '888888', endedAt: T0 + 3000, end: 26, rounds: 1 }));
ok(dup.added === false && dup.reason === 'duplicate', '第二次写入被判重复', JSON.stringify(dup));
eq(Records.all().length, 1, '只保留 1 条');

/* 完全相同的 endedAt 也要判重 */
var dup2 = Records.add(rec({ roomId: '888888', endedAt: T0, end: 26, rounds: 1 }));
ok(dup2.added === false, 'endedAt 完全相同时也判重复');

/* ================================================================
 * 场景 3：老数据没有局次（rounds = 0）
 * 60 秒内 → 判重；超过 60 秒 → 视为不同把放行
 * ================================================================ */
console.log('\n[场景 3] 老数据缺局次，窄窗口兜底');
reset();
Records.add(rec({ roomId: '777777', endedAt: T0, end: 22, rounds: 0 }));
var legacyNear = Records.add(rec({ roomId: '777777', endedAt: T0 + 20 * 1000, end: 22, rounds: 0 }));
ok(legacyNear.added === false, '缺局次且 20 秒内 → 判重复');
var legacyFar = Records.add(rec({ roomId: '777777', endedAt: T0 + 5 * MIN, end: 22, rounds: 0 }));
ok(legacyFar.added === true, '缺局次但间隔 5 分钟 → 视为不同把放行');
eq(Records.all().length, 2, '最终 2 条');

/* ================================================================
 * 场景 4：不同房间互不影响
 * ================================================================ */
console.log('\n[场景 4] 不同房间同一时刻');
reset();
Records.add(rec({ roomId: '111111', endedAt: T0, end: 23, rounds: 1 }));
var other = Records.add(rec({ roomId: '222222', endedAt: T0, end: 18, rounds: 1 }));
ok(other.added === true, '不同房间同时结算都能写入');
eq(Records.all().length, 2, '共 2 条');

/* ================================================================
 * 场景 5：聚合指标
 * ================================================================ */
console.log('\n[场景 5] 聚合指标');
reset();
Records.add(rec({ roomId: 'A1', endedAt: T0 + 0 * MIN, end: 25, rounds: 1 }));  // +5 胜
Records.add(rec({ roomId: 'A1', endedAt: T0 + 3 * MIN, end: 18, rounds: 2 }));  // -2 负
Records.add(rec({ roomId: 'A1', endedAt: T0 + 6 * MIN, end: 20, rounds: 3 }));  //  0 平
Records.add(rec({ roomId: 'A1', endedAt: T0 + 9 * MIN, end: 22, rounds: 4 }));  // +2 胜
var st = Records.stats();
eq(st.games, 4, '场次 4');
eq(st.wins, 2, '胜 2');
eq(st.losses, 1, '负 1');
eq(st.flats, 1, '平 1');
eq(st.totalNet, 5, '累计净胜 5');
eq(st.bestNet, 5, '最佳单局 +5');
eq(st.currentStreak, 1, '当前连胜 1（最新一把是胜）');
eq(st.longestStreak, 1, '最长连胜 1');
eq(st.recent.length, 4, '趋势条 4 格');
eq(st.recent[3], 'win', '趋势条最右是最新一把（胜）');

/* ================================================================
 * 场景 5b：纪录指标（单场最高 / 最长连胜 / 最长连败）
 * 时间顺序（旧 → 新）：+9 胜、+3 胜、-2、-1、-4、0 平、+6 胜、-3、-5
 *   最长连胜 = 2（开头两把）
 *   最长连败 = 3（中间三把；最后的 -3、-5 只有 2）
 *   单场最高 = +9
 *   平局必须打断连胜/连败，否则 -4 会被 0 接上继续算
 * ================================================================ */
console.log('\n[场景 5b] 纪录指标');
reset();
var seq = [9, 3, -2, -1, -4, 0, 6, -3, -5];
seq.forEach(function (net, i) {
  Records.add(rec({ roomId: 'B1', endedAt: T0 + i * MIN, end: 20 + net, rounds: i + 1 }));
});
var s2 = Records.stats();
eq(s2.games, 9, '9 场');
eq(s2.bestNet, 9, '单场最高 = +9（不是最近一把，也不是平均值）');
eq(s2.longestStreak, 2, '最长连胜 2');
eq(s2.longestLoseStreak, 3, '最长连败 3（平局把连胜连败都打断）');
/* v111 口径统一：连败用负数表示（+N 连胜 / -N 连败 / 0 刚平或没打）。
 * 以前本机这份算的是「连胜计数」（输了就 0），而云端档案算的是带符号的 ——
 * 战绩卡的渲染代码里明明有 `streak < -1 → N 连败` 这一支，
 * 也就是说**本地兜底路径从来没显示过连败**。收口时把口径对齐到云端那份。 */
eq(s2.currentStreak, -2, '最新连续两把是负 → -2（连败用负数，与云端档案同一口径）');

/* 全负时单场最高取「最不惨的那把」，不能因为最大值 ≤0 就退化成 0 */
reset();
[-2, -1, -4].forEach(function (net, i) {
  Records.add(rec({ roomId: 'B2', endedAt: T0 + i * MIN, end: 20 + net, rounds: i + 1 }));
});
var s3 = Records.stats();
eq(s3.bestNet, -1, '全是负分时，单场最高 = -1（最大净胜，不吞成 0）');
eq(s3.longestStreak, 0, '没有胜场 → 最长连胜 0');
eq(s3.longestLoseStreak, 3, '最长连败 3');

/* 全胜：连败必须是 0，不能因为初始值或兜底变成 1 */
reset();
[1, 2, 3].forEach(function (net, i) {
  Records.add(rec({ roomId: 'B3', endedAt: T0 + i * MIN, end: 20 + net, rounds: i + 1 }));
});
eq(Records.stats().longestLoseStreak, 0, '全胜 → 最长连败 0');
eq(Records.stats().longestStreak, 3, '全胜 → 最长连胜 3');

/* ================================================================
 * 场景 6：容量上限与清空
 * ================================================================ */
console.log('\n[场景 6] 上限与清空');
reset();
/* 205 个不同房间（局次都从 1 起）：验证容量截断，不是验证判重 */
for (var k = 0; k < 205; k++) {
  Records.add(rec({ roomId: 'R' + k, endedAt: T0 + k * MIN, end: 20 + (k % 5), rounds: 1 }));
}
eq(Records.all().length, Records.LIMIT, '超出后截断到上限 ' + Records.LIMIT);
eq(Records.all()[0].roomId, 'R204', '保留的是最新的（R204 在最前）');
ok(Records.all()[Records.LIMIT - 1].roomId === 'R5', '最旧被淘汰（R0~R4 已移出）');

Records.clear();
eq(Records.all().length, 0, '清空后无记录');
ok(global.localStorage.getItem(Records.KEY) === null, '存储键已移除');

/* 清空后仍能正常写入并判重 */
Records.add(rec({ roomId: 'X1', endedAt: T0, end: 24, rounds: 1 }));
var afterClearDup = Records.add(rec({ roomId: 'X1', endedAt: T0 + 2000, end: 24, rounds: 1 }));
ok(afterClearDup.added === false, '清空后判重逻辑依然生效');
eq(Records.all().length, 1, '清空后写入正常');

/* ================================================================
 * 场景 7：脏数据不炸
 * ================================================================ */
console.log('\n[场景 7] 脏数据容错');
reset();
global.localStorage.setItem(Records.KEY, 'not-a-json');
eq(Records.all().length, 0, '非 JSON 当空处理');
eq(Records.stats().games, 0, '聚合不抛错');
ok(Records.add(null).added === false, 'null 被拒绝');
ok(Records.add({ roomId: '', endedAt: 0 }).added === false, '缺房间号与时间被拒绝');

/* ================================================================
 * 表情条数（v82 R4）：只有计数，没有内容；缺失 ≠ 0
 * ================================================================ */
console.log('\n[场景 N] 雷达撤掉之后：配套字段不许再被写进磁盘');
reset();
var r1 = rec({ roomId: '654321', endedAt: T0, end: 23, rounds: 1 });
/* 就算调用方硬塞进来（老版本缓存回灌、别处复用写入函数），白名单也只该收
 * 「这一局打成什么样」。myEmoji / handMs / myFold 曾经撑起战绩页那张牌风雷达，
 * 雷达已经是废功能：留着它们等于让一条没人读的数据在磁盘上一直长下去，
 * 而且下次有人看到字段就会以为还有界面在用。 */
r1.myEmoji = 4;
r1.handMs = 42000;
r1.myFold = 2;
Records.add(r1);

var only = Records.all().filter(function (x) { return x.roomId === '654321'; })[0];
ok(only && only.myNet !== undefined, '（前置）这一条正常落盘了');
ok(only && !('myEmoji' in only), '★ myEmoji 不落盘');
ok(only && !('handMs' in only), '★ handMs 不落盘');
ok(only && !('myFold' in only), '★ myFold 不落盘（主动收手已整块撤掉）');

/* ---------------- 汇总 ---------------- */
console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail === 0 ? 0 : 1);
