/**
 * 本机战绩的账号隔离（v50 修的「换号后战绩里是别人的局」）
 *
 * 事故现场：同一台手机先后登过两个号。战绩页读的是 localStorage，
 * 而 v50 之前的记录**没有账号字段**，于是两个号的局混在同一个列表里。
 * 表现就是「排行榜上是我今天的 +39，战绩里却是别人 -18 的旧局」。
 *
 * 这个文件锁四件事：
 *   1. 写入带 playerId，读的时候能按账号过滤
 *   2. 老记录（没有 playerId）不归属任何账号，不会混进别人的视图
 *   3. clear(pid) 只清这个号的，另一个号和我自己的回放都不受牵连
 *   4. 不传 playerId 时行为与 v50 之前一致（不破坏测试与排查口径）
 */
'use strict';

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

var T0 = Date.UTC(2026, 9, 28, 12, 0, 0);
var seq = 0;
function rec(extra) {
  seq++;
  var o = {
    roomId: String(100000 + seq),
    endedAt: T0 + seq * 60000,
    playerCount: 3,
    myStartScore: 100,
    myEndScore: 100 + (extra && extra.net !== undefined ? extra.net : 5),
    rounds: 1,
    endReason: 'scoreZero'
  };
  if (extra) for (var k in extra) o[k] = extra[k];
  return o;
}

/* ------------------------------------------------------------------ */
console.log('\n[1] 两个账号各自的记录互不干扰');
reset();
Records.add(rec({ playerId: 'pa', net: 39 }));
Records.add(rec({ playerId: 'pa', net: -18 }));
Records.add(rec({ playerId: 'pb', net: -21 }));

eq(Records.all().length, 3, '不传参：三条都在（迁移/排查口径不变）');
eq(Records.all('pa').length, 2, "★ 甲只有自己那 2 条");
eq(Records.all('pb').length, 1, '★ 乙只有自己那 1 条');
eq(Records.all('pc').length, 0, '★ 没打过的账号是空列表，不会捡到别人的');

eq(Records.stats('pa').games, 2, '甲场次 2');
eq(Records.stats('pa').totalNet, 21, '甲净胜 39-18=21');
eq(Records.stats('pb').totalNet, -21, '乙净胜 -21');
eq(Records.stats('pc').games, 0, '空账号场次 0（不报错）');

/* ------------------------------------------------------------------ */
console.log('\n[2] 老记录没有 playerId —— 不归属任何人');
reset();
Records.add(rec({ playerId: 'pa', net: 10 }));
/* 直接塞一条 v50 之前格式的记录：没有 playerId 字段 */
var legacy = rec({ net: -18 });
delete legacy.playerId;
Records.add(legacy);

eq(Records.all().length, 2, '不传参：新旧都在');
eq(Records.all('pa').length, 1, '★ 甲只看到自己的 1 条，老记录不算他的');
eq(Records.all('pb').length, 0, "★ 老记录也不被别人捡走（它谁也不属于）");

/* ------------------------------------------------------------------ */
console.log('\n[3] clear(pid) 只清这个账号');
reset();
Records.add(rec({ playerId: 'pa', net: 1 }));
Records.add(rec({ playerId: 'pa', net: 2 }));
Records.add(rec({ playerId: 'pb', net: 3 }));
Records.add(rec({ net: 4 }));                    // 无主的老记录

eq(Records.clear('pa'), true, 'clear("pa") 返回 true');
eq(Records.all('pa').length, 0, '★ 甲的记录清空了');
eq(Records.all('pb').length, 1, '★ 乙的记录还在');
eq(Records.all().length, 2, '★ 老记录也还在（不是全清）');
eq(Records.stats('pa').games, 0, '甲的聚合归零');

eq(Records.clear('pb'), true, 'clear("pb") 返回 true');
eq(Records.all('pb').length, 0, '乙也清空');
eq(Records.all().length, 1, '只剩那条无主的老记录');

/* ------------------------------------------------------------------ */
console.log('\n[4] clear() 不传参 = 全清（含老记录与迁移标记）');
eq(Records.clear(), true, 'clear() 返回 true');
eq(Records.all().length, 0, '★ 一条不剩');
eq(global.localStorage.getItem(Records.KEY), null, '★ key 直接删掉了，不留一个 "[]"');

/* ------------------------------------------------------------------ */
console.log('\n[5] 写入仍照旧幂等，且不会串号');
reset();
var a1 = Records.add(rec({ playerId: 'pa', roomId: '777777', endedAt: T0, rounds: 1, net: 5 }));
var a2 = Records.add(rec({ playerId: 'pa', roomId: '777777', endedAt: T0 + 2000, rounds: 1, net: 5 }));
eq(a1.added, true, '第一次写入成功');
eq(a2.added, false, '同房间同局次 2 秒后 → 判重复');
/* 换个人打同一间房：不是同一个人，不该被甲的记录挡掉 */
var b1 = Records.add(rec({ playerId: 'pb', roomId: '777777', endedAt: T0 + 3000, rounds: 1, net: -5 }));
eq(b1.added, true, '★ 另一个人进同一房间 → 正常写入（幂等是按人算的）');
eq(Records.all('pb').length, 1, '乙拿到自己那条');

/* ------------------------------------------------------------------ */
console.log('\n[6] playerId 不会在磁盘上留空字符串');
reset();
Records.add(rec({ playerId: '', net: 1 }));
var raw = JSON.parse(global.localStorage.getItem(Records.KEY));
eq(raw.length, 1, '写进去了');
eq(Object.prototype.hasOwnProperty.call(raw[0], 'playerId'), false,
  '★ 空 playerId 整个字段不写（老记录保持「无主」，不占体积）');

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
if (fail) process.exitCode = 1;
