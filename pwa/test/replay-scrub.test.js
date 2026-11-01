/**
 * 已注销玩家的**身份抹除**（node pwa/test/replay-scrub.test.js）
 *
 * 背景：删号能覆盖的边界是「服务端 + 本人的设备」。你和别人打过的回放副本存在
 * 对方的手机上，服务端碰不到 —— 唯一的清理时机是对方下次打开回放时，
 * 由他在本地把名字抹掉（见 docs/deletion-spec.md 方案 3）。
 *
 * 这里锁死五条契约，缺一条都算回归：
 *   1. owners() 把存储里出现过的 playerId 全部收齐、去重；
 *   2. scrub() 把已注销者的 id 与昵称清空，**牌和分数一个字节都不动**
 *      —— 回放的价值是「这把牌怎么走的」，不是「对手叫什么」；
 *   3. 组头的赢家字段（只有昵称、没有 id）跟着一起清，否则会渲染成
 *      「已注销玩家出了这些牌，小明赢」—— 人抹了、名字还在，等于没抹；
 *   4. 幂等：同一批 id 再抹一次是 0 改动（清理会在每次打开时跑）；
 *   5. 不该动的绝不碰：空名单、没打过交道的 id、老数据（i 有值但 n 为空）都不受影响。
 *
 * ★ 判据统一为「i 与 n 同时为空」= 已注销占位。只有 i 为空是「老数据没存 id」，
 *   那是「不知道名字」，不是「已注销」。这两个混起来，老记录会凭空变成
 *   「已注销玩家」——所以第 5 条不是凑数的。
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
    _raw: function () { return map; }
  };
}
global.localStorage = makeLS();

var SessionLog = require('../js/sessionLog.js');
var Records = require('../js/records.js');

var pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
function reset() { global.localStorage.clear(); }

/* 一局 3 个人：玩家E / 小明 / 要删的人（id 用可读的假 id，方便断言） */
function row(id, name, cards, d) {
  return { i: id, n: name, c: cards, d: d };
}
function pack(winnerName) {
  return {
    hands: 1,
    rounds: [{
      r: 1,
      groups: [{
        l: '单张比大小',
        w: winnerName,
        t: '',
        rows: [
          row('p-玩家E', '玩家E', ['A♠'], 4),
          row('p-ming', '小明', ['K♣'], 0),
          row('p-gone', '要删的人', ['Q♦'], -4)
        ]
      }]
    }]
  };
}
var KEY = 'r1#1000';

function seedSession() {
  reset();
  SessionLog.absorb({ key: KEY, roomId: 'r1', startedAt: 1000, packs: [pack('要删的人')] });
}

/* ================================================================
 * 1. SessionLog.owners()
 * ================================================================ */
console.log('\n[1] SessionLog.owners 收齐且去重');
seedSession();
var ids = SessionLog.owners().slice().sort();
eq(ids.length, 3, '三个人都在名单里');
/* 同 [5] 的顺序说明：默认 sort 按 UTF-16 码点，中文昵称排在 ASCII 之后。 */
eq(ids.join(','), 'p-gone,p-ming,p-玩家E', '去重后按 id 排序正确');

/* 再吸一场、人员重复：名单不应该变长 */
SessionLog.absorb({ key: 'r2#2000', roomId: 'r2', startedAt: 2000, packs: [pack('玩家E')] });
eq(SessionLog.owners().length, 3, '第二场是同一批人 → 名单长度不变');

/* ================================================================
 * 2. scrub：抹掉 id 与昵称，牌与分数不动
 * ================================================================ */
console.log('\n[2] scrub 抹身份，不碰牌和分数');
seedSession();
var before = SessionLog.load(KEY);
var res = SessionLog.scrub(['p-gone']);
eq(res.rows, 1, '改到了 1 行');
eq(res.winners, 1, '组头那个赢家也清了（它只有昵称，靠第一遍收集的线索对上）');

var after = SessionLog.load(KEY);
var g = after.packs[0].rounds[0].groups[0];
var gone = null, 玩家E = null;
g.rows.forEach(function (r) { if (r.d === -4) gone = r; if (r.i === 'p-玩家E') 玩家E = r; });
ok(!!gone && gone.i === '', '已注销者的 playerId 被清空');
ok(!!gone && gone.n === '', '已注销者的昵称被清空');
ok(!!gone && gone.c.join(' ') === 'Q♦', '★ 他出的牌原样保留（回放还得能看）');
ok(!!gone && gone.d === -4, '★ 他的分数原样保留');
ok(!!玩家E && 玩家E.n === '玩家E' && 玩家E.i === 'p-玩家E', '其他人一个字段都没动');
eq(g.w, '', '组头赢家被清空（否则会显示「要删的人 赢」）');
eq(g.l, '单张比大小', '组名不在清理范围内');

/* 牌数、轮数这些结构字段也不能变 */
eq(after.packs.length, before.packs.length, '把数不变');
eq(after.packs[0].rounds.length, before.packs[0].rounds.length, '轮数不变');

/* ================================================================
 * 3. 幂等
 * ================================================================ */
console.log('\n[3] 幂等：同一批 id 再抹一次是 0 改动');
var again = SessionLog.scrub(['p-gone']);
eq(again.rows, 0, '第二次 0 行');
eq(again.winners, 0, '第二次 0 个赢家');
var again2 = SessionLog.load(KEY);
eq(again2.packs[0].rounds[0].groups[0].rows.length, 3, '行数还是 3（不是删行，是清字段）');

/* ================================================================
 * 4. 不该动的绝不碰
 * ================================================================ */
console.log('\n[4] 空名单 / 不认识的 id / 老数据 都不受影响');
seedSession();
eq(SessionLog.scrub([]).rows, 0, '空名单 → 0 改动');
eq(SessionLog.scrub(null).rows, 0, 'null → 0 改动（不抛异常）');
eq(SessionLog.scrub(['p-nobody']).rows, 0, '名单里的人在回放里不存在 → 0 改动');
eq(SessionLog.owners().length, 3, '三次空转之后名单还是 3 个人（没有误删）');

/* 老数据：i 有值但 n 为空 —— 这是「不知道名字」，不是「已注销」。
 * 它不会被清（id 不在名单里），渲染时也不会被当成已注销占位。 */
reset();
SessionLog.absorb({
  key: KEY, roomId: 'r1', startedAt: 1000,
  packs: [{ hands: 1, rounds: [{ r: 1, groups: [{ l: 'x', w: '', t: '', rows: [{ i: 'p-old', n: '', c: ['A♠'], d: 1 }] }] }] }]
});
SessionLog.scrub(['p-gone']);
var old = SessionLog.load(KEY).packs[0].rounds[0].groups[0].rows[0];
eq(old.i, 'p-old', '老数据的 id 还在');
eq(old.n, '', '老数据的空昵称还是空（没有被改写成别的）');

/* ================================================================
 * 5. Records.scrubReplays：每条战绩自带的那把副本
 * ================================================================ */
console.log('\n[5] 本机战绩里的 replay 副本同样要抹');
reset();
Records.add({
  id: 'r1-1000',
  playerId: 'p-me',
  roomId: 'r1',
  endedAt: 1000,
  playerCount: 3,
  myStartScore: 20,
  myEndScore: 24,
  myNet: 4,
  endReason: 'scoreZero',
  rounds: 1,
  replay: pack('要删的人')
});
/* 顺序说明：`sort()` 是默认的 UTF-16 码点比较，中文昵称排在 ASCII 之后，
 * 所以 p-玩家E 落在 p-ming 后面。这里断言的是「三个 id 一个不少」，
 * 用 join 只是为了让失败信息可读 —— 顺序本身不是被测行为。 */
var rIds = Records.owners().slice().sort();
eq(rIds.join(','), 'p-gone,p-ming,p-玩家E', '战绩副本里的三个 id 都收齐了');

var rres = Records.scrubReplays(['p-gone']);
eq(rres.rows, 1, '改到了 1 行');
eq(rres.winners, 1, '组头赢家也清了');

var rec = Records.all('p-me')[0];
var rowGone = null, rowMing = null;
rec.replay.rounds[0].groups[0].rows.forEach(function (r) {
  if (r.d === -4) rowGone = r;
  if (r.i === 'p-ming') rowMing = r;
});
ok(!!rowGone && rowGone.i === '' && rowGone.n === '', '副本里已注销者的身份被清空');
ok(!!rowGone && rowGone.c.join(' ') === 'Q♦', '副本里的牌保留');
ok(!!rowMing && rowMing.n === '小明', '副本里其他人不受影响');
eq(rec.myNet, 4, '★ 我的净胜没变（删别人的身份不该动我的分）');
eq(rec.replay.rounds[0].groups[0].w, '', '副本的组头赢家也清了');

var rAgain = Records.scrubReplays(['p-gone']);
eq(rAgain.rows, 0, '副本清理同样幂等');

/* ================================================================
 * 汇总
 * ================================================================ */
console.log('\n' + (fail === 0 ? '全部通过' : '有失败') + '：' + pass + ' 项通过，' + fail + ' 项失败');
if (fail) process.exit(1);
