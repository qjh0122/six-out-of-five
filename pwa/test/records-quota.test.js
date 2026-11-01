/**
 * 本机战绩的**配额降级**行为（node pwa/test/records-quota.test.js）
 *
 * 背景（BACKLOG D7）：localStorage 满的时候，旧实现是
 *   setItem 抛异常 → catch → return false → 调用方 `catch (e) {}` 吞掉。
 * 玩家能观察到的唯一现象是「刚才那把在战绩里没有」，而日志里一个字都没有。
 *
 * 现在的契约是三条，缺一条都算回归：
 *   1. 配额不够时**先腾地方**：丢掉老记录，把这一局写进去（返回 trimmed:true）
 *   2. 腾了还写不进，才返回 writeFailed —— 而且**不能抛异常**
 *   3. 裁剪永远保留最新的那一头（列表本来就是倒序，裁剪必须从尾部砍）
 *
 * 为什么这类测试要用「带容量的 mock」而不是真的塞 5MB：
 * 真塞 5MB 只能验证「不崩」，验证不了「裁掉的是最老的、留下的是最新的」。
 * 容量可控的 mock 才能把三种结果都逼出来。
 */
'use strict';

/* ---------------- 带容量上限的 mock localStorage ---------------- */
var map = Object.create(null);
var budget = Infinity;

function usage() {
  var total = 0;
  for (var k in map) total += k.length + String(map[k]).length;
  return total;
}

global.localStorage = {
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
  setItem: function (k, v) {
    v = String(v);
    var add = k.length + v.length;
    if (Object.prototype.hasOwnProperty.call(map, k)) add -= k.length + String(map[k]).length;
    if (usage() + add > budget) {
      var e = new Error('QuotaExceededError');
      e.name = 'QuotaExceededError';
      throw e;
    }
    map[k] = v;
  },
  removeItem: function (k) { delete map[k]; },
  clear: function () { map = Object.create(null); }
};

var Records = require('../js/records.js');

var pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

var MIN = 60 * 1000;
var T0 = new Date('2026-10-30T20:00:00+08:00').getTime();

function rec(i, extraBytes) {
  var r = {
    roomId: 'R' + i, endedAt: T0 + i * MIN, myStartScore: 20, myEndScore: 20 + (i % 5),
    myNet: (i % 5), rounds: i + 1, playerCount: 4, endReason: 'scoreZero'
  };
  if (extraBytes) r.endReason = 'scoreZero' + new Array(extraBytes + 1).join('x');
  return r;
}

function reset() {
  map = Object.create(null);
  budget = Infinity;
  global.localStorage.clear();
}

/* ================================================================
 * 场景 1：容量还有一点，但装不下完整的 31 条 → 裁掉老的，这局要保住
 * ================================================================ */
console.log('\n[场景 1] 配额不足 → 裁剪后写入，返回 trimmed');
reset();
for (var i = 0; i < 30; i++) {
  var r = Records.add(rec(i, 40));
  if (!r.added) { console.log('  预置失败于 i=' + i + '：' + r.reason); break; }
}
eq(Records.all().length, 30, '预置 30 条成功');

var before = usage();
budget = before + 60;          // 余量够写一条新记录，但不够写第 31 条
var res31 = Records.add(rec(30, 40));
eq(res31.added, true, '配额不足时这一局仍然记下来了');
eq(res31.trimmed, true, '并且明确告诉调用方「裁掉了一部分」');
eq(Records.KEY in map, true, '数据还在盘里');
ok(Records.all().length < 31, '总量被封顶', 'now=' + Records.all().length);
var top = Records.all()[0];
eq(top.endedAt, T0 + 30 * MIN, '最新的一局在最前面（裁的是尾部，不是头部）');
ok(Records.all().length >= 10, '裁到一半还会尽力保留一段历史', 'now=' + Records.all().length);

/* ================================================================
 * 场景 2：别的 key 把额度吃光 → 怎么写都写不进，必须返回 writeFailed 且不抛
 *
 * 为什么这里只放 3 条记录：如果记录本身已经占了大部分额度，
 * 「裁到 10 条」自然就会腾出空间，永远走不到 writeFailed 那一支。
 * 真正写不进去的形态是「额度被别的 key 占死、战绩本身很小」
 * —— 也就是同一个域下别的模块往 localStorage 里塞了东西。
 * ================================================================ */
console.log('\n[场景 2] 额度被别的 key 吃光 → writeFailed（不抛异常）');
reset();
for (var j = 0; j < 3; j++) Records.add(rec(j, 40));
map.junk = new Array(800).join('y');   // 直接写进去，绕过预算（模拟「已经存在的别的 key」）
budget = usage() + 15;                 // 只够 available() 的探针，不够任何一次真实写入
ok(usage() <= budget, '仍在预算内（垃圾已写入）', 'usage=' + usage() + ' budget=' + budget);

var threw = false;
var resHard = null;
try { resHard = Records.add(rec(99, 40)); } catch (e) { threw = true; }
eq(threw, false, '配额耗尽不抛异常（否则会打断对局主流程）');
eq(resHard.added, false, '这一局确实没写进去');
eq(resHard.reason, 'writeFailed', '原因明确为 writeFailed，便于上层提示');

/* ================================================================
 * 场景 3：写入成功时不带 trimmed，避免调用方误报
 * ================================================================ */
console.log('\n[场景 3] 正常写入不带 trimmed 标记');
reset();
var okRes = Records.add(rec(1));
eq(okRes.added, true, '正常写入成功');
eq(okRes.trimmed === undefined, true, '没有多余标记（不误报「存储紧张」）');

/* ================================================================
 * 场景 4：clear 的返回值仍是布尔
 * ================================================================ */
console.log('\n[场景 4] clear 仍返回布尔');
reset();
Records.add(rec(1));
eq(Records.clear(), true, 'clear 返回 true');
eq(Records.all().length, 0, '清空生效');

/* ---------------- 汇总 ---------------- */
console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail === 0 ? 0 : 1);
