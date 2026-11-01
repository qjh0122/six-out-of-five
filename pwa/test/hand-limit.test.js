/**
 * 本局局数上限（handLimit）测试
 * 跑法：node pwa/test/hand-limit.test.js
 *
 * 这条需求只有三句话，但落地时有一个必踩的坑：**上限判定的位置**。
 * handCount 的 +1 发生在第 2 轮结算分支里，所以判定必须放在 +1 之前、
 * 拿「刚打完这一把」的序号去比。放错位置的两种症状：
 *   · 3 局房只打了 2 把就结账（玩家少玩一把）
 *   · 打完第 3 把还继续发第 4 把的牌（上限等于没有）
 * 这两条都在下面的用例里，写死。
 *
 * 另外锁住三条产品口径：
 *   · ★ v103：分数跌破 0 **不再结束游戏**，终局只认「打满选定的把数」
 *   · 结算后继续游戏沿用同一档位，分数回到 0（CONFIG.INITIAL_SCORE）、handCount 回到 1
 *   · 脏参数一律回落 10，建房不报错（0 也不例外，见下面的注释）
 */
'use strict';

const { readAll: readGameAll } = require('./helpers/gameSource');
const SM = require('../js/stateMachine.js');
const CONFIG = require('../js/config.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

function P(id) { return { id: id, nickname: id }; }

/* 建房 → 全员准备 → 开局。handLimit 由 opts 传，模拟建房时选的档位。 */
function makeRoom(ids, opts) {
  const room = SM.newRoom('R-HL', P(ids[0]), opts);
  ids.slice(1).forEach((id) => SM.joinRoom(room, P(id)));
  room.players.forEach((p) => { p.ready = true; });
  SM.startGame(room, ids[0]);
  /* 把初始分垫高：本文件只验「把数上限」，不想让随机牌面把谁打到很深的负分
   * 干扰分数断言。★ v103 起负分本身不会结束游戏，所以这只是为了断言好读，
   * 不是因为「怕爆分提前终止」。 */
  room.players.forEach((p) => { p.score = 200; });
  return room;
}

/* 按手牌顺序把 6 张牌分进本轮各组（够用即可，不比牌型大小） */
function buildGroups(hand, round) {
  const keys = SM.ROUND_GROUPS[round];
  const groups = {};
  let i = 0;
  keys.forEach((k) => {
    groups[k] = hand.slice(i, i + SM.GROUP_COUNT[k]);
    i += SM.GROUP_COUNT[k];
  });
  return groups;
}

/* 当前在场玩家全部提交 → 状态机内部会自动结算并翻轮/翻把 */
function allSubmit(room) {
  const round = room.round;
  SM.activePlayers(room).slice().forEach((p) => {
    SM.submitGroups(room, p.id, buildGroups(p.hand, round), round);
  });
}

/* 打完整的一把（2 轮），返回这把结束时的 phase */
function playOneHand(room) {
  const startHand = room.handCount;
  let guard = 0;
  while (room.handCount === startHand && room.phase !== SM.PHASE.SETTLED && guard < 6) {
    allSubmit(room);
    guard++;
  }
  return room.phase;
}

console.log('\n[档位与脏参数收敛]');
eq(SM.handLimitOf(SM.newRoom('R1', P('a'))), CONFIG.DEFAULT_HAND_LIMIT, '不传 opts → 默认 10');
eq(SM.normalizeHandLimit(15), 15, "数字 15 → 15");
eq(SM.normalizeHandLimit('15'), 15, "字符串 '15' 照收（表单控件送来的就是字符串）");
eq(SM.normalizeHandLimit(7), CONFIG.DEFAULT_HAND_LIMIT, '白名单外的 7 → 回落 10（不报错）');
eq(SM.normalizeHandLimit(null), CONFIG.DEFAULT_HAND_LIMIT, 'null → 10');
eq(SM.normalizeHandLimit(undefined), CONFIG.DEFAULT_HAND_LIMIT, 'undefined → 10');
eq(SM.normalizeHandLimit('abc'), CONFIG.DEFAULT_HAND_LIMIT, '非数字 → 10');
eq(SM.handLimitOf({ handLimit: 0 }), CONFIG.DEFAULT_HAND_LIMIT,
  '★ 0 也回落 10（v103 起 0 不再等于「不设上限」—— 那会变成永不结束）');
eq(SM.handLimitOf({ handLimit: -5 }), CONFIG.DEFAULT_HAND_LIMIT, '负数 → 10');
eq(SM.handLimitOf({}), CONFIG.DEFAULT_HAND_LIMIT, '老房间没有该字段 → 10');
ok(CONFIG.HAND_LIMITS.join(',') === '3,5,10,15,30', '档位就是产品要求的 3/5/10/15/30');

console.log('\n[3 局房：少打一把 / 多打一把 都不行]');
let room = makeRoom(['a', 'b'], { handLimit: 3 });
eq(room.handLimit, 3, '建房时写进 room.handLimit');
eq(room.handCount, 1, '开局是第一把');

const idAfterHand1 = (() => { playOneHand(room); return room.handId; })();
eq(room.phase, SM.PHASE.ROUND1_SPLIT, '第 1 把打完 → 正常发第 2 把的牌');
eq(room.handCount, 2, '第 2 把');

playOneHand(room);
eq(room.phase, SM.PHASE.ROUND1_SPLIT, '★ 第 2 把打完 → 仍然继续（不是 3 局却只打 2 把）');
eq(room.handCount, 3, '第 3 把');
const idBeforeLast = room.handId;

playOneHand(room);
eq(room.phase, SM.PHASE.SETTLED, '★ 第 3 把打完 → 进结算');
eq(room.endReason, 'handLimit', '结束原因是打满局数');
eq(room.handCount, 3, 'handCount 停在 3（没有虚增到 4）');
eq(room.handId, idBeforeLast, '★ 没有偷偷发第 4 把的牌（handId 不再递增）');
eq(room.round, 2, '轮次停在 2，结算页才能继续显示第二轮的明细');
ok(room.settledAt > 0, 'markSettled 写入了稳定结束时间');
ok(idAfterHand1 > 0 && idBeforeLast > idAfterHand1, 'handId 在把与把之间正常递增');

console.log('\n[结算后继续游戏：沿用档位、分数与把数归零]');
SM.activePlayers(room).forEach((p) => SM.wantNext(room, p.id));
SM.activePlayers(room).forEach((p) => SM.setReady(room, p.id, true));
const started = SM.autoStartIfReady(room);
ok(!!started && started.kind === 'next', '就位态凑齐 → 开了下一局');
eq(room.handLimit, 3, '★ 沿用建房时的 3，不被重置成默认 10');
eq(room.handCount, 1, '新一局从第 1 把开始');
eq(room.endReason, null, '结束原因清空');
eq(room.phase, SM.PHASE.ROUND1_SPLIT, '直接进第一轮分牌');
eq(room.players[0].score, CONFIG.INITIAL_SCORE, '分数重置回初始分');

console.log('\n[★ v103：分数跌破 0 不终止，照样打满局数]');
room = makeRoom(['a', 'b'], { handLimit: 3 });
room.players[1].score = -100;   // 深度负分：怎么赢都回不到正数
allSubmit(room);
eq(room.phase, SM.PHASE.ROUND2_SPLIT,
  '★ −100 分也照常进第二轮（旧实现这里就 SETTLED 了）');
eq(room.endReason, null, '★ 没有任何结束原因');
ok(room.players[1].score < 0, '负分保持为负（不会被夹到 0 或 20）');

/* 一路打完，确认最终仍由「打满 3 局」收尾，而不是被别的东西截断 */
let guard = 0;
while (room.phase !== SM.PHASE.SETTLED && guard < 10) { allSubmit(room); guard++; }
eq(room.phase, SM.PHASE.SETTLED, '★ 最终进结算');
eq(room.endReason, 'handLimit', '★ 结束原因是打满局数（不是 scoreZero）');
eq(room.handCount, 3, '★ 真打满了 3 把（不会因为负分提前收手）');
ok(room.players[1].score < 0, '打满时那个人可能还是负分 —— 这就是新的正常状态');
ok(room.bustedIds.length === 0, 'bustedIds 恒空（不再有见底出局）');

console.log('\n[5 人局也能按上限收口]');
room = makeRoom(['a', 'b', 'c', 'd', 'e'], { handLimit: 3 });
for (let i = 0; i < 2; i++) playOneHand(room);
eq(room.phase, SM.PHASE.ROUND1_SPLIT, '5 人局第 2 把打完照常继续');
playOneHand(room);
eq(room.phase, SM.PHASE.SETTLED, '5 人局第 3 把打完进结算');
eq(room.endReason, 'handLimit', '5 人局同样按 handLimit 收口');

console.log('\n[界面入口：建房必须先选局数，默认 10]');
/* 这一段是静态源码检查（不开浏览器）：规则层写得再对，只要哪条路径绕过弹窗
 * 直接建房，房间就会拿不到档位、按默认 10 走 —— 而玩家明明选了 30。
 * 这类回归在界面上完全看不出来，只能靠扫源码守住。 */
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const gameJs = readGameAll();

ok(/id="create-modal"[^>]*/.test(html), 'index.html 有建房弹窗 #create-modal');
ok(/id="hand-limit-row"/.test(html), '弹窗里有档位容器 #hand-limit-row');
ok(/id="btn-create-confirm"/.test(html), '弹窗里有「开始建房」');
ok(/id="btn-create-cancel"/.test(html), '弹窗里有「取消」（选错了能退出去）');
ok(/role="radiogroup"/.test(html), '档位容器有 radiogroup 语义（读屏能念出这是一组选项）');
ok(/CONFIG\.HAND_LIMITS/.test(gameJs), '档位列表来自 CONFIG，不在界面里另写一份');
ok(/createLimit = CONFIG\.DEFAULT_HAND_LIMIT/.test(gameJs),
  '★ 每次打开弹窗都重置成默认 10（不记上一次的选择）');
ok(/showModalEl\('create-modal'\)/.test(gameJs), '弹窗走统一入口 showModalEl（焦点进出才有效）');
ok(/\$\('#btn-create'\)\.addEventListener\('click', openCreateModal\)/.test(gameJs),
  '★ 首页「创建房间」只负责开弹窗，不直接建房');
ok(/RoomStore\.createRoom\(\{[^}]*\}, \{ handLimit: limit \}\)/.test(gameJs),
  '★ 建房请求真的带上了选中的档位');
ok(!/RoomStore\.createRoom\([^)]*\)\s*;?\s*\/\/\s*没有档位/.test(gameJs), '没有留下不带档位的建房调用');

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
