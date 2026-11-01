/**
 * 「一场打完 → 房主开下一把 → 再打一场」的战绩写入联调测试
 * 跑法：node test/settle.test.js
 *
 * 验证的事：同一房间打完两场，战绩必须写进两条。
 * 旧实现因为 handCount 在 restart 时归 1 + 10 分钟判重窗，第二场会被静默丢弃。
 */
'use strict';

function makeLS() {
  var map = Object.create(null);
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
    setItem: function (k, v) { map[k] = String(v); },
    removeItem: function (k) { delete map[k]; },
    clear: function () { map = Object.create(null); }
  };
}
global.localStorage = makeLS();

var SM = require('../js/stateMachine.js');
var Records = require('../js/records.js');
var CONFIG = require('../js/config.js');

var pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + b + ', got ' + a); }

function player(id, nick) {
  return {
    id: id, nickname: nick, ready: true, left: false, connected: true,
    disconnectedAt: null, score: CONFIG.INITIAL_SCORE, hand: [],
    groups: null, submitted: { round1: false, round2: false }
  };
}

/* 把当前房间状态转成一条战绩（与 game.js 的 recordSettled 同口径） */
function recordOf(room, me) {
  return {
    id: room.roomId + '-' + room.settledAt,
    roomId: room.roomId,
    endedAt: room.settledAt,
    playerCount: room.players.length,
    myStartScore: CONFIG.INITIAL_SCORE,
    myEndScore: me.score,
    myNet: me.score - CONFIG.INITIAL_SCORE,
    endReason: room.endReason || 'dissolve',
    rounds: room.handSeq || room.handCount || 1
  };
}

function meOf(room) { return room.players.filter(function (p) { return p.id === 'p1'; })[0]; }

/* 真实两场之间至少隔几分钟，测试里给几毫秒即可让 settledAt 区分开 */
function wait(ms) { var t = Date.now(); while (Date.now() - t < ms) {} }

/* ================================================================
 * 第一场：两人开局，对手离开 → 人数不足结算
 * ================================================================ */
console.log('\n[第一场] 两人开局，对手离开触发结算');
var room = SM.newRoom('123456', player('p1', '甲'));
eq(room.handSeq, 0, '新房间 handSeq 从 0 起');

var j = SM.joinRoom(room, player('p2', '乙'));
ok(j.ok === true, '第二人加入成功', JSON.stringify(j));
room = j.room;

SM.setReady(room, 'p1', true);
SM.setReady(room, 'p2', true);
var s = SM.startGame(room, 'p1');
ok(s.ok === true, '房主开局成功', JSON.stringify(s));
room = s.room;
eq(room.phase, SM.PHASE.ROUND1_SPLIT, '进入第一轮分牌');

var lv = SM.leaveRoom(room, 'p2');
room = lv.room;
eq(room.phase, SM.PHASE.SETTLED, '对手离开后进入结算');
eq(room.handSeq, 1, '第一场 handSeq = 1');
ok(!!room.settledAt, 'settledAt 已写入');
var settledAt1 = room.settledAt;

var r1 = Records.add(recordOf(room, meOf(room)));
ok(r1.added === true, '第一场战绩写入成功', JSON.stringify(r1));
eq(Records.all().length, 1, '战绩 1 条');

/* 重复写同一场（结算页刷新）必须被判重 */
var r1dup = Records.add(recordOf(room, meOf(room)));
ok(r1dup.added === false, '同一场重复写入被判重');

/* ================================================================
 * 第二场：报名制重开，handCount 归 1，但 handSeq 必须保留
 * ================================================================ */
console.log('\n[第二场] 报名 + 准备 → 自动开下一场');
room.players.push(player('p3', '丙'));
SM.wantNext(room, 'p1');
SM.setReady(room, 'p1', true);
SM.wantNext(room, 'p3');
SM.setReady(room, 'p3', true);
var started2 = SM.autoStartIfReady(room);
ok(!!started2 && started2.kind === 'next', '两人都就绪 → 自动开第二场');

eq(room.handCount, 1, 'handCount 被重置为 1（旧实现撞车的根源）');
eq(room.handSeq, 1, 'handSeq 保留上一场的值，不重置');
ok(room.settledAt === null, 'settledAt 已清空，等待新一场');

/* 再让对局以人数不足结束 */
wait(5);
var lv2 = SM.leaveRoom(room, 'p3');
room = lv2.room;
eq(room.phase, SM.PHASE.SETTLED, '第二场进入结算');
eq(room.handSeq, 2, '第二场 handSeq = 2');
ok(room.settledAt > settledAt1, '第二场 settledAt 晚于第一场');

var r2 = Records.add(recordOf(room, meOf(room)));
ok(r2.added === true, '第二场战绩写入成功（旧实现这里会被丢弃）', JSON.stringify(r2));
eq(Records.all().length, 2, '战绩共 2 条');

var st = Records.stats();
eq(st.games, 2, '场次 = 2');
ok(st.recent.length === 2, '趋势条 2 格');

/* ================================================================
 * 第三场：连续第三次重开，仍未重置
 * ================================================================ */
console.log('\n[第三场] 再来一次，序号继续递增');
room.players.push(player('p4', '丁'));
SM.wantNext(room, 'p1');
SM.setReady(room, 'p1', true);
SM.wantNext(room, 'p4');
SM.setReady(room, 'p4', true);
ok(!!SM.autoStartIfReady(room), '第三场开局成功');
eq(room.handSeq, 2, '第三场开始前 handSeq 仍为 2');
wait(5);
room = SM.leaveRoom(room, 'p4').room;
eq(room.handSeq, 3, '第三场 handSeq = 3');
var r3 = Records.add(recordOf(room, meOf(room)));
ok(r3.added === true, '第三场战绩写入成功');
eq(Records.all().length, 3, '战绩共 3 条');

/* 三场都保留，且时间倒序 */
var all3 = Records.all();
eq(all3[0].rounds, 3, '最新一条是第三场');
eq(all3[2].rounds, 1, '最旧一条是第一场');

/* ================================================================
 * 解散投票结算也要递增序号
 * ================================================================ */
console.log('\n[解散投票] 投票通过也算一场');
var room2 = SM.newRoom('654321', player('a1', '甲'));
var j2 = SM.joinRoom(room2, player('a2', '乙'));
room2 = j2.room;
SM.setReady(room2, 'a1', true);
SM.setReady(room2, 'a2', true);
room2 = SM.startGame(room2, 'a1').room;
SM.proposeDissolve(room2, 'a1');
var v1 = SM.voteDissolve(room2, 'a1', true);
room2 = v1.room;
var v2 = SM.voteDissolve(room2, 'a2', true);
room2 = v2.room;
eq(room2.phase, SM.PHASE.SETTLED, '全员同意后结算');
eq(room2.handSeq, 1, '解散结算同样计入场次');

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail === 0 ? 0 : 1);
