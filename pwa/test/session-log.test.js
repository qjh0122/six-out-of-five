/**
 * 场次过程仓库（整场回放数据层）
 * 跑法：node pwa/test/session-log.test.js
 *
 * 守四件事：
 *   1) 攒得起来 —— 房间只发最近两把，客户端边看边攒，整场要齐；
 *   2) 不重复 —— 每次房间更新都会重发同一轮，同 (第几把, 第几轮) 只能存一份；
 *   3) 有上限 —— 场次数 / 把数 / 行数都封顶，否则一场下来能把 localStorage 顶满，
 *      而顶满的后果是整页战绩都读不出来（不只是回放丢）；
 *   4) 坏数据不炸 —— 这份数据会被用户改脏，进来一律裁剪，不能因为一条脏数据丢整场。
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

var pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
function reset() { global.localStorage.clear(); }

function row(name, cards, d, id) {
  return { i: id || ('p-' + name), n: name, c: cards, d: d };
}
function round(r, label) {
  return { r: r, groups: [{ l: label || '单张比大小', w: '玩家E', t: '', rows: [row('玩家E', ['A♠'], 2), row('我', ['K♣'], -2)] }] };
}
function pack(hands, extraRounds) {
  var rounds = [round(1)];
  if (extraRounds) rounds.push(round(2, '斗牛'));
  return { hands: hands, rounds: rounds };
}
function entry(key, packs, roomId) {
  return { key: key || '888999#1700000000000', roomId: roomId || '888999', startedAt: 1700000000000, packs: packs };
}

/* ---------------------------------------------------------------- */
console.log('\n[1] 场次身份：房号 + 房间创建时间');
eq(SessionLog.keyOf({ roomId: '888999', createdAt: 1700000000000 }), '888999#1700000000000', '正常房间');
eq(SessionLog.keyOf({ roomId: '888999' }), '888999#0', '缺 createdAt 也给出稳定 key（不能是 undefined）');
eq(SessionLog.keyOf(null), '', '没有房间 → 空串（调用方据此跳过）');
/* 同一个房号被回收后再建房，createdAt 不同 → 两份档案，不能拼成一场 */
ok(SessionLog.keyOf({ roomId: '888999', createdAt: 1 }) !== SessionLog.keyOf({ roomId: '888999', createdAt: 2 }),
  '★ 同房号不同创建时间 = 两场（房号会被回收，只按房号会拼错）');

/* ---------------------------------------------------------------- */
console.log('\n[2] 攒起来：只发一截，也要拼成整场');
reset();
eq(SessionLog.load('888999#1700000000000'), null, '一开始没有这场');
var a1 = SessionLog.absorb(entry(null, [pack(1, true)]));
eq(a1.added, 2, '第一把两轮都收下了');
/* 服务端只保留最近两条 → 下一次广播只会带来第 2 把，第 1 把已经不在 history 里了 */
SessionLog.absorb(entry(null, [pack(2, true)]));
SessionLog.absorb(entry(null, [pack(3, true)]));
var sess = SessionLog.load('888999#1700000000000');
ok(!!sess, '整场档案存在');
eq(sess.packs.length, 3, '★ 三把都在（服务端窗口只有两把，靠客户端攒齐）');
eq(sess.packs.map(function (p) { return p.hands; }).join(','), '1,2,3', '★ 把次升序，没有重号');
eq(sess.packs[0].rounds.map(function (r) { return r.r; }).join(','), '1,2', '把内轮次升序');
eq(SessionLog.describe(sess), '整场 3 把', '摘要文案');

/* ---------------------------------------------------------------- */
console.log('\n[3] 幂等：同一轮被广播很多次，只算一次');
var before = SessionLog.load('888999#1700000000000').packs.length;
var dup = SessionLog.absorb(entry(null, [pack(3, true)]));
eq(dup.added, 0, '★ 重复吸收不新增');
eq(SessionLog.load('888999#1700000000000').packs.length, before, '把数没变');
/* 半把重复：第 4 把只来了第 1 轮，再来一次仍是 1 轮 */
SessionLog.absorb(entry(null, [{ hands: 4, rounds: [round(1)] }]));
var again = SessionLog.absorb(entry(null, [{ hands: 4, rounds: [round(1)] }]));
eq(again.added, 0, '同一把同一轮重复也只算一次');
eq(SessionLog.load('888999#1700000000000').packs[3].rounds.length, 1, '半把就是半把（不无中生有）');

/* ---------------------------------------------------------------- */
console.log('\n[4] 上限：把数与场次数都封顶');
reset();
var many = [];
for (var i = 1; i <= 30; i++) many.push(pack(i));
SessionLog.absorb(entry(null, many));
var capped = SessionLog.load('888999#1700000000000');
eq(capped.packs.length, SessionLog.PACKS_MAX, '★ 每场最多 ' + SessionLog.PACKS_MAX + ' 把');
eq(capped.packs[0].hands, 30 - SessionLog.PACKS_MAX + 1, '★ 超出时丢最旧的，留下连续的尾巴');
eq(capped.packs[capped.packs.length - 1].hands, 30, '最新的那把一定在');

reset();
for (var s2 = 1; s2 <= 6; s2++) {
  SessionLog.absorb(entry('room' + s2 + '#1', [pack(1)]));
}
var inv = SessionLog.inspect();
eq(inv.length, SessionLog.SESSIONS_MAX, '★ 最多留 ' + SessionLog.SESSIONS_MAX + ' 场');

/* ---------------------------------------------------------------- */
console.log('\n[5] 坏数据不炸、也不污染');
reset();
eq(SessionLog.absorb(null).added, 0, 'null 入口直接忽略');
eq(SessionLog.absorb({ key: '' }).added, 0, '没有 key 的入口忽略');
eq(SessionLog.absorb(entry(null, [])).added, 0, '空 packs 忽略');
eq(SessionLog.absorb(entry(null, [{ hands: 1, rounds: [] }])).added, 0, '没有轮次的把忽略');
eq(SessionLog.load('888999#1700000000000'), null, '脏输入一条都没写进去');

/* 超长字段被裁剪，且不影响其它字段 */
var dirty = {
  key: 'dirty#1', roomId: 'dirty', startedAt: 1,
  packs: [{
    hands: 1,
    rounds: [{
      r: 1,
      groups: [{
        l: '这个玩法名字特别特别特别长应该被截断',
        w: '昵称也特别特别特别特别特别长',
        t: '类型名也很长很长很长',
        rows: [
          { i: 'x'.repeat(99), n: '名'.repeat(99), c: ['♠'.repeat(99)], d: '3' },
          { n: '第二行' }
        ]
      }]
    }]
  }]
};
SessionLog.absorb(dirty);
var d = SessionLog.load('dirty#1');
ok(!!d, '脏数据里合法的部分被保留');
var g0 = d.packs[0].rounds[0].groups[0];
ok(g0.l.length <= 10, '玩法名被截断', g0.l);
ok(g0.w.length <= 20, '昵称被截断', g0.w);
ok(g0.t.length <= 12, '类型名被截断', g0.t);
ok(g0.rows[0].i.length <= 24, 'id 被截断', g0.rows[0].i);
ok(g0.rows[0].c[0].length <= 6, '牌面文本被截断', g0.rows[0].c[0]);
eq(g0.rows[0].d, 3, '字符串数字被转成数字');
eq(g0.rows[1].c.length, 0, '缺 c 的行给空数组，不是 undefined');

/* 坏 JSON / 坏结构一律当空，不抛错 */
reset();
global.localStorage.setItem(SessionLog.KEY, '{不是 JSON');
eq(SessionLog.load('888999#1700000000000'), null, '坏 JSON 当空');
global.localStorage.setItem(SessionLog.KEY, '{"not":"array"}');
eq(SessionLog.load('888999#1700000000000'), null, '不是数组也当空');
eq(SessionLog.absorb(entry(null, [pack(1)])).added, 1, '★ 坏数据之后还能正常写入（不会永久卡死）；pack(1) 只有 1 轮');

/* ---------------------------------------------------------------- */
console.log('\n[6] 「我」的身份要活下来');
reset();
SessionLog.absorb(entry(null, [{
  hands: 1,
  rounds: [{
    r: 1,
    groups: [{ l: '单张比大小', w: '玩家E', t: '', rows: [row('玩家E', ['A♠'], 2, 'p-玩家E'), row('我', ['K♣'], -2, 'p-me')] }]
  }]
}]));
var meRows = SessionLog.load('888999#1700000000000').packs[0].rounds[0].groups[0].rows;
eq(meRows[1].i, 'p-me', '★ 行里保留了玩家 id（回放靠它标「我」，昵称会重名）');

/* ---------------------------------------------------------------- */
console.log('\n[7] 清空');
reset();
SessionLog.absorb(entry(null, [pack(1)]));
ok(SessionLog.clear() === true, 'clear 返回 true');
eq(SessionLog.inspect().length, 0, '★ 清空后一场都不剩');

/* ---------------------------------------------------------------- */
console.log('\n[8] 配额：封顶之后到底占多少字节');

/* 上一节只证明「有上限」，证明不了「上限够小」。
 * 所以这里真的把四个上限全部拉满、序列化一次，量出字节数。
 * 5 MB 是 localStorage 的常见配额，而**配额满了的后果不是回放丢，是整页战绩都读不出来**，
 * 所以这条线必须留出大头给别的 key。 */
reset();
function worstGroup() {
  var rows = [];
  for (var i = 0; i < 12; i++) {
    rows.push({ i: 'g' + 'x'.repeat(22), n: '名'.repeat(20), c: ['10♠', '10♥', '10♣', '10♦', 'J♠', 'J♥'], d: -999 });
  }
  return { l: '单张对子顺金花牛', w: '名'.repeat(20), t: '五花牛牛牛牛牛牛牛', rows: rows };
}
function worstPack(hands) {
  var rounds = [];
  for (var r = 1; r <= 4; r++) {
    var gs = [];
    for (var g = 0; g < 6; g++) gs.push(worstGroup());
    rounds.push({ r: r, groups: gs });
  }
  return { hands: hands, rounds: rounds };
}
for (var ws = 1; ws <= SessionLog.SESSIONS_MAX; ws++) {
  var wp = [];
  for (var wh = 1; wh <= SessionLog.PACKS_MAX; wh++) wp.push(worstPack(wh));
  SessionLog.absorb(entry('worst' + ws + '#1', wp, 'worst' + ws));
}
var worstRaw = global.localStorage.getItem(SessionLog.KEY) || '';
var worstBytes = Buffer.byteLength(worstRaw, 'utf8');
console.log('    最坏情况（' + SessionLog.SESSIONS_MAX + ' 场 × ' + SessionLog.PACKS_MAX +
  ' 把 × 4 轮 × 6 组 × 12 行 × 6 张牌）= ' + Math.round(worstBytes / 1024) + ' KB，' +
  '预算 ' + Math.round(SessionLog.BYTES_MAX / 1024) + ' K 码元');
/* 这条是**先红后绿**的：结构上限单独存在时这里是 5333 KB —— 直接顶穿 5 MB。
 * 所以真正兜底的是 writeAll 里的按体积削峰，不是那几个 MAX 常量。 */
ok(worstRaw.length <= SessionLog.BYTES_MAX,
  '★ 四个结构上限全部拉满，削峰后仍落在字节预算内',
  worstRaw.length + ' / ' + SessionLog.BYTES_MAX);
ok(worstBytes < 1.5 * 1024 * 1024,
  '★ 最坏情况也占不到 5 MB 的三分之一（给别的 key 留够余量）',
  Math.round(worstBytes / 1024) + ' KB');
/* 被削之后必须是「还能用」，不是「清空」—— 回放至少要有最近那把。 */
var worstLoaded = SessionLog.load(SessionLog.inspect()[0].key);
ok(!!worstLoaded && worstLoaded.packs.length >= 1, '★ 削峰之后最新那场仍然读得出来（不是一刀清空）',
  worstLoaded && worstLoaded.packs.length);
ok(worstLoaded && worstLoaded.packs[0].rounds.length >= 1, '削峰之后最早留下的那把也还有轮次可看');

/* 配额真的爆了（setItem 抛 QuotaExceededError）时，不能把异常抛回调用方 ——
 * absorb 是在 WebSocket 消息回调里被调的，抛出会把整条消息处理链打断。 */
reset();
var realSet = global.localStorage.setItem;
global.localStorage.setItem = function () { throw new Error('QuotaExceededError'); };
var quotaThrew = false;
try { SessionLog.absorb(entry(null, [pack(1)])); } catch (e) { quotaThrew = true; }
global.localStorage.setItem = realSet;
ok(!quotaThrew, '★ 写不进去时 absorb 不抛错（否则会打断 WebSocket 回调）', quotaThrew);
ok(SessionLog.load('888999#1700000000000') === null, '写失败就是没存上，load 老实返回 null（不编数据）');
ok(SessionLog.absorb(entry(null, [pack(1)])).added === 1, '配额恢复后还能继续存');

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
