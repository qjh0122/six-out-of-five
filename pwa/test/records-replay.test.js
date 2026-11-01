/**
 * 回放留存（P3-7 剩项）数据层回归测试
 *
 * 背景：房间内的「本局过程」来自服务端 room.history，一退房就没了。
 * 现在结算时把精简副本写进本机战绩，战绩页可以点「看过程」回看。
 *
 * 这个文件守两件事：
 *   1) 结构校验 —— replay 是外部传进来的二维结构，一个字段漏检查就能把
 *      localStorage 配额撑满，而配额满了会让整页战绩都读不出来（不只是回放丢）；
 *   2) 体积上限 —— 只给最近 REPLAY_KEEP 局留回放，更早的剥字段、留记录。
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

var pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
function eq(actual, expected, name) {
  ok(actual === expected, name, 'expect ' + expected + ', got ' + actual);
}
function reset() { global.localStorage.clear(); }

var seq = 0;
function base(extra) {
  seq += 1;
  var r = {
    id: 'R' + seq,
    roomId: 'R' + seq,
    endedAt: 1700000000000 + seq * 60000,
    playerCount: 4,
    myStartScore: 20,
    myEndScore: 26,
    myNet: 6,
    endReason: 'scoreZero',
    rounds: 1
  };
  if (extra) for (var k in extra) r[k] = extra[k];
  return r;
}
function oneRound(handNo, roundNo) {
  return {
    hands: handNo || 1,
    rounds: [{
      r: roundNo || 1,
      groups: [
        { l: '比大小', w: '玩家E', t: '', rows: [{ n: '玩家E', c: ['A♠'], d: 2 }, { n: 'sam', c: ['3♦'], d: -2 }] },
        { l: '十点半', w: 'sam', t: '10.5', rows: [{ n: 'sam', c: ['10♥', 'K♣'], d: 2 }, { n: '玩家E', c: ['7♥', '2♠'], d: -2 }] }
      ]
    }]
  };
}

console.log('\n[1] 基本写入与读回');
reset();
var add1 = Records.add(base({ replay: oneRound(1, 1) }));
eq(add1.added, true, '带 replay 的记录写入成功');
var a0 = Records.all()[0];
ok(!!a0.replay, '读回来还带着 replay');
eq(a0.replay.hands, 1, 'hands 保留');
eq(a0.replay.rounds.length, 1, '轮次数量保留');
eq(a0.replay.rounds[0].groups.length, 2, '组数量保留');
eq(a0.replay.rounds[0].groups[0].l, '比大小', '组名保留');
eq(a0.replay.rounds[0].groups[0].rows[0].c[0], 'A♠', '手牌字符串保留');
eq(a0.replay.rounds[0].groups[0].rows[1].d, -2, '负数分保留');

console.log('\n[2] 没有 replay 的记录不该多一个字段');
reset();
Records.add(base());
var b0 = Records.all()[0];
ok(!Object.prototype.hasOwnProperty.call(b0, 'replay'), '无 replay 时字段整个不存在（不留 null）');
eq(b0.myNet, 6, '其它字段照常');

console.log('\n[3] 脏数据一律忽略，不能把整条记录带崩');
reset();
var bads = [
  null, undefined, 'x', 42, [], {},
  { hands: 1 },                       // 没有 rounds
  { hands: 1, rounds: 'nope' },       // rounds 不是数组
  { hands: 1, rounds: [] },           // 空
  { hands: 1, rounds: [{}] },         // 没有 groups
  { hands: 1, rounds: [{ groups: [] }] }
];
var allBad = true;
for (var i = 0; i < bads.length; i++) {
  reset();
  Records.add(base({ replay: bads[i] }));
  var got = Records.all()[0];
  if (!got) { allBad = false; break; }                    // 记录本身不能丢
  if (Object.prototype.hasOwnProperty.call(got, 'replay')) { allBad = false; break; }
}
ok(allBad, '11 种脏 replay 全部被丢弃，记录本身保留');

console.log('\n[4] 超量结构被裁剪');
reset();
var big = {
  hands: 9,
  rounds: []
};
for (var r = 1; r <= 10; r++) {
  var groups = [];
  for (var g = 0; g < 10; g++) {
    var rows = [];
    for (var p = 0; p < 20; p++) {
      rows.push({ n: 'p' + p, c: ['A♠', '2♥', '3♣', '4♦', '5♠', '6♥', '7♣', '8♦', '9♠'], d: p });
    }
    groups.push({ l: '组' + g, w: 'w' + g, t: 't' + g, rows: rows });
  }
  big.rounds.push({ r: r, groups: groups });
}
Records.add(base({ replay: big }));
var c0 = Records.all()[0].replay;
eq(c0.rounds.length, 4, '轮次裁到 4');
eq(c0.rounds[0].groups.length, 6, '组裁到 6');
eq(c0.rounds[0].groups[0].rows.length, 12, '人员行裁到 12');
eq(c0.rounds[0].groups[0].rows[0].c.length, 6, '每人手牌裁到 6 张');
/* 上面这条构造的是「4 轮 × 6 组 × 12 人 × 6 张」的理论上限，约 16KB —— 现实到不了
 * （一局最多 2 轮、最多 8 人），但它必须有个天花板，否则一个异常房间就能写进 1MB。
 * 下限在下一段按真实上限单独验。 */
ok(JSON.stringify(c0).length < 20 * 1024, '理论上限构造也 < 20KB', JSON.stringify(c0).length);

console.log('\n[4b] 按真实上限（8 人 / 2 轮 / 3 组）构造，单局应该只有 1KB 上下');
reset();
var real = { hands: 1, rounds: [] };
for (var rr = 1; rr <= 2; rr++) {
  var gs = [];
  var gnames = rr === 1 ? ['比大小', '十点半', '飘三叶'] : ['比大小', '斗牛'];
  for (var gi = 0; gi < gnames.length; gi++) {
    var ps = [];
    /* 8 人分进 3 组：3 / 3 / 2；第二轮 1 / 7 */
    var cnt = rr === 1 ? (gnames[gi] === '飘三叶' ? 2 : 3) : (gi === 0 ? 1 : 7);
    for (var pi = 0; pi < cnt; pi++) {
      ps.push({ n: '玩家' + pi, c: ['10♥', 'K♣', 'A♠', '9♦', '3♠', '大王'], d: pi % 3 === 0 ? 2 : -2 });
    }
    gs.push({ l: gnames[gi], w: '玩家' + gi, t: '牛牛', rows: ps });
  }
  real.rounds.push({ r: rr, groups: gs });
}
Records.add(base({ replay: real }));
var realJson = JSON.stringify(Records.all()[0].replay);
ok(realJson.length < 4096, '真实上限的单局回放 < 4KB（实际 ' + realJson.length + 'B）', realJson.length);
eq(Records.all()[0].replay.rounds.length, 2, '两轮都在');

console.log('\n[5] 超长字符串被截断');
reset();
Records.add(base({
  replay: {
    hands: 1,
    rounds: [{
      r: 1,
      groups: [{
        l: '一二三四五六七八九十十一十二',
        w: '昵称'.repeat(40),
        t: '牌型'.repeat(30),
        rows: [{ n: '名'.repeat(60), c: ['AB'.repeat(20)], d: 0 }]
      }]
    }]
  }
}));
var d0 = Records.all()[0].replay.rounds[0].groups[0];
eq(d0.l.length, 10, '组名截到 10 字');
eq(d0.w.length, 20, '赢家昵称截到 20 字');
eq(d0.t.length, 12, '牌型名截到 12 字');
eq(d0.rows[0].n.length, 20, '玩家昵称截到 20 字');
eq(d0.rows[0].c[0].length, 6, '单张牌文本截到 6 字');

console.log('\n[6] 只有最近 ' + Records.REPLAY_KEEP + ' 局留回放，更早的剥字段但留记录');
reset();
var total = Records.REPLAY_KEEP + 5;
for (var n = 0; n < total; n++) {
  Records.add(base({ replay: oneRound(1, 1) }));
}
var list = Records.all();
eq(list.length, total, '记录一条不少');
var withReplay = 0, withoutReplay = 0;
for (var m = 0; m < list.length; m++) {
  if (list[m].replay) withReplay++; else withoutReplay++;
}
eq(withReplay, Records.REPLAY_KEEP, '恰好 ' + Records.REPLAY_KEEP + ' 局带回放');
eq(withoutReplay, total - Records.REPLAY_KEEP, '多出来的 ' + (total - Records.REPLAY_KEEP) + ' 局没有回放');
ok(!!list[0].replay, '最新一局有回放');
ok(!list[list.length - 1].replay, '最旧一局没有回放');

console.log('\n[7] 配额安全：' + Records.LIMIT + ' 局全塞满时总体积可控');
reset();
for (var q = 0; q < Records.LIMIT; q++) {
  Records.add(base({ replay: oneRound(1, 1) }));
}
var raw = global.localStorage.getItem(Records.KEY) || '';
var kb = Math.round(raw.length / 1024);
/* 8 局 × 约 1.5KB ≈ 12KB，加 192 局纯记录 ≈ 30KB。留 100KB 余量给浏览器。
 * 这条断言的意义不是「现在正好多大」，而是防止有人把 REPLAY_KEEP 调大或
 * 把整份 room.history 直接塞进来 —— 那会一脚踩到 5MB 配额上。 */
ok(raw.length < 100 * 1024, Records.LIMIT + ' 局全带战绩时总占用 < 100KB（实际 ' + kb + 'KB）', kb + 'KB');
eq((raw.match(/"replay"/g) || []).length, Records.REPLAY_KEEP, '磁盘上只有 ' + Records.REPLAY_KEEP + ' 份回放');

console.log('\n' + '='.repeat(48));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
