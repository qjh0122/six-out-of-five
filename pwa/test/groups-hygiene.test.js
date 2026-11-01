/**
 * 分组落库的「数据卫生」测试
 * 跑法：node pwa/test/groups-hygiene.test.js
 *
 * 锁的是一件不影响输赢、但会让档案慢性变脏的事：
 * **第 2 轮只打「单张 + 斗牛」，可第一轮那两条分组会被原样带进 p.groups.round2。**
 *
 * 为什么值得单独一个文件：
 *   它不会被结算读到（结算按 ROUND_GROUPS 只取本轮两组），也不会让别的断言变红，
 *   属于「跑一整天也不会有人发现」的问题 —— 只能靠一条明确的断言盯着。
 *   而它一旦存在，档案里就会出现「这一局他手里并没有的那些牌」：
 *   回放按 group 遍历、导出、以后谁写个「统计十点半手牌分布」的分析，都会先撞上这份脏数据。
 *
 * ★ 时序很关键：第二轮最后一个人提交会立刻结算，结算之后 `dealAll` 会把全员 groups
 *   重置成空（下一把重新分牌）。所以断言必须在「本轮已落库、但还没结算」这个窗口里做 ——
 *   用 2 人局，让 A 先提交 B 后提交，A 的分组就停在那个窗口里。
 */
'use strict';

const SM = require('../js/stateMachine.js');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + label); }
  else { fail += 1; console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, label) { ok(a === b, label, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

function startRoom(roomId, ids) {
  const room = SM.newRoom(roomId, { id: ids[0], nickname: '玩家' + ids[0] });
  ids.slice(1).forEach(function (id) { SM.joinRoom(room, { id: id, nickname: '玩家' + id }); });
  ids.forEach(function (id) { SM.setReady(room, id, true); });
  SM.startGame(room, ids[0]);
  return room;
}

function groupsOf(room, id) {
  const p = SM.findPlayer(room, id);
  return { single: [p.hand[0]], tenhalf: [p.hand[1], p.hand[2]], piaosanye: [p.hand[3], p.hand[4], p.hand[5]] };
}

function groupsOfRound2(room, id) {
  const p = SM.findPlayer(room, id);
  return { single: [p.hand[0]], douniu: [p.hand[1], p.hand[2], p.hand[3], p.hand[4], p.hand[5]] };
}

console.log('\n[第 2 轮只该留下本轮的组]');

{
  const ids = ['A', 'B'];
  const room = startRoom('900101', ids);
  ids.forEach(function (id) { SM.submitGroups(room, id, groupsOf(room, id)); });
  eq(room.round, 2, '第一轮全部提交后进入第二轮');
  eq(room.phase, SM.PHASE.ROUND2_SPLIT, '阶段是第二轮分牌');

  /* 第一轮的两组必须留着 —— 结算页要回看第一轮怎么分的 */
  const a = SM.findPlayer(room, 'A');
  eq(a.groups.round1.tenhalf.length, 2, '第一轮的十点半分组留在 round1（留给回看）');
  eq(a.groups.round1.piaosanye.length, 3, '第一轮的飘三叶分组留在 round1');

  /* 只提交 A，停在「已落库但未结算」的窗口 */
  SM.submitGroups(room, 'A', groupsOfRound2(room, 'A'));
  eq(room.phase, SM.PHASE.ROUND2_SPLIT, 'B 还没提交，所以还没结算（窗口有效）');

  eq(a.groups.round2.single.length, 1, '第二轮的单张 1 张');
  eq(a.groups.round2.douniu.length, 5, '第二轮的斗牛 5 张');
  eq(a.groups.round2.tenhalf.length, 0, '★ 第二轮的 tenhalf 是空的（不再带第一轮的旧牌）');
  eq(a.groups.round2.piaosanye.length, 0, '★ 第二轮的 piaosanye 是空的');

  /* 四条键必须都在：前端按固定形状读，少一个键会变成 undefined 上的 .length */
  eq(Object.keys(a.groups.round2).sort().join(','), 'douniu,piaosanye,single,tenhalf',
    '第二轮的分组对象仍是四条键齐全的固定形状');

  /* 第一轮不能被顺手清掉 */
  eq(a.groups.round1.tenhalf.length, 2, '★ 第一轮的分组没有被第二轮影响');

  /* B 提交 → 结算，走完整条链路，确认清空逻辑不影响正常结算 */
  SM.submitGroups(room, 'B', groupsOfRound2(room, 'B'));
  ok(room.phase === SM.PHASE.ROUND1_SPLIT || room.phase === SM.PHASE.SETTLED,
    '两轮打完照常推进（下一把重新分牌 / 分见底直接结账）', 'phase=' + room.phase);
  ok((room.results.round2 || []).length === 2, '★ 第二轮两组都结算了（清空旧组没有影响结算）', 
    'round2 结果数=' + (room.results.round2 || []).length);
}

console.log('\n[客户端多塞了本轮的组，也不会落库]');

{
  /* 恶意/改过的客户端完全可以在第二轮请求里多带 tenhalf / piaosanye。
   * 这两个字段不在本轮的校验范围（校验只看 single + douniu），所以既不会报错，
   * 也不该被写进档案 —— 否则等于「多带什么就存什么」。 */
  const ids = ['A', 'B'];
  const room = startRoom('900102', ids);
  ids.forEach(function (id) { SM.submitGroups(room, id, groupsOf(room, id)); });
  eq(room.round, 2, '进入第二轮');

  const p = SM.findPlayer(room, 'A');
  const dirty = groupsOfRound2(room, 'A');
  dirty.tenhalf = [p.hand[1], p.hand[2]];          // 多带两条第一轮才有的组
  dirty.piaosanye = [p.hand[3], p.hand[4], p.hand[5]];
  const r = SM.submitGroups(room, 'A', dirty);
  eq(r.ok, true, '多带无关组不影响提交成功（不在校验范围）');
  eq(p.groups.round2.tenhalf.length, 0, '★ 多带的 tenhalf 被丢弃，没写进档案');
  eq(p.groups.round2.piaosanye.length, 0, '★ 多带的 piaosanye 被丢弃');
  eq(p.groups.round2.douniu.length, 5, '本轮的斗牛照常落库');
}

console.log('\n[第一轮的分组形状不受影响]');

{
  const ids = ['A', 'B'];
  const room = startRoom('900103', ids);
  SM.submitGroups(room, 'A', groupsOf(room, 'A'));      // 只提 A，停在窗口里
  const p = SM.findPlayer(room, 'A');
  eq(Object.keys(p.groups.round1).sort().join(','), 'douniu,piaosanye,single,tenhalf', '第一轮也是四条键齐全');
  eq(p.groups.round1.douniu.length, 0, '第一轮的 douniu 是空的（第二轮才用）');
  eq(p.groups.round1.single.length, 1, '第一轮的单张 1 张');
  eq(p.groups.round1.tenhalf.length, 2, '第一轮的十点半 2 张');
  eq(p.groups.round1.piaosanye.length, 3, '第一轮的飘三叶 3 张');
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
if (fail > 0) process.exitCode = 1;
