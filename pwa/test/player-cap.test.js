/**
 * 人数上限（2–5）与「老房间不受影响」
 * 跑法：node pwa/test/player-cap.test.js
 *
 * 为什么需要这个文件
 * -----------------
 * v82 把人数上限从 8 收到 5。这件事本身是改一个数字，但它有两个陷阱：
 *
 *   ① **上限在两个地方各写了一份**。`config.js` 有 `MAX_PLAYERS`，
 *      `server/hub.js` 自己还有一行 `const MAX_PLAYERS = 8`。改一处等于没改：
 *      前端拦住第 6 个人、服务端还放行。这和「原型手抄一份 engine.js 的判定」
 *      是同一类错误，只是这次抄的是一个数字 —— 数字也会漂。
 *
 *   ② **线上已有 8 人房**。改小上限后如果到处直接读 `CONFIG.MAX_PLAYERS`，
 *      正在打的 8 人房会当场出怪事：座位格子变成 5 个，第 6~8 人
 *      在房间里看不到自己（`slotCount` 变小、人还在 `players` 里）。
 *      所以上限要抄进房间（`room.cap`），读取一律走 `capOf(room)`。
 *
 * 这里把两条都钉住：谁再把上限写死一份、或者绕过 capOf 直接读配置，这个文件会红。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const SM = require('../js/stateMachine.js');
const CONFIG = require('../js/config.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + String(extra) : '')); }
}
function eq(a, b, name) { ok(a === b, name, JSON.stringify(a) + ' !== ' + JSON.stringify(b)); }

function P(id) { return { id: id, nickname: id }; }

console.log('[1] 配置里的人数上限是 5');

eq(CONFIG.MIN_PLAYERS, 2, '最少 2 人');
eq(CONFIG.MAX_PLAYERS, 5, '★ 最多 5 人（v82）');

console.log('\n[2] 上限只有一份：服务端不再自带常量');

{
  const hubSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'hub.js'), 'utf8');
  /* 注释里可以提到它（要解释为什么删），代码里不许再有。
   * 先把注释整段剥掉，再找残留 —— 否则改注释也会误伤。 */
  const code = hubSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(function (l) { return l.replace(/\/\/.*$/, ''); })
    .join('\n');
  ok(!/const\s+MAX_PLAYERS/.test(code), '★ hub.js 不再定义自己的 MAX_PLAYERS');
  ok(!/>=?\s*MAX_PLAYERS/.test(code), '★ hub.js 不用裸的 MAX_PLAYERS 做比较');
  ok(/SM\.capOf\(room\)/.test(code), '★ hub.js 改用 SM.capOf(room)');
}

console.log('\n[3] 新建的房间把当时的上限抄进 room.cap');

{
  const room = SM.newRoom('R-NEW', P('a'));
  eq(room.cap, 5, '★ 新房间 cap = 5');
  eq(SM.capOf(room), 5, 'capOf(新房间) = 5');

  /* 房主算 1 个，再补 4 个正好 5 人 */
  let joined = 1;
  for (const id of ['b', 'c', 'd', 'e']) {
    const r = SM.joinRoom(room, P(id));
    ok(r.ok, '第 ' + (joined + 1) + ' 个人还能进（' + id + '）', r && r.error);
    if (r.ok) joined++;
  }
  eq(joined, 5, '房间刚好坐满 5 人');
  const j6 = SM.joinRoom(room, P('f'));
  ok(!j6.ok, '★ 第 6 个人被拒');
  ok(/最多 5 人/.test(j6.error || ''), '★ 拒绝文案说清上限是 5', j6.error);
  eq(SM.activePlayers(room).length, 5, '房间里正好 5 人');
}

console.log('\n[4] 老 8 人房按自己建房时的上限走完，不会被新配置打乱');

{
  const room = SM.newRoom('R-OLD', P('a'));
  room.cap = 8;                       // 模拟「上限还是 8 的时候建的房间」

  let joined = 1;
  for (let i = 1; i < 8; i++) {
    const r = SM.joinRoom(room, P('p' + i));
    if (r.ok) joined++;
  }
  eq(joined, 8, '★ 老房间仍然能坐满 8 个人');
  eq(SM.activePlayers(room).length, 8, '在场 8 人');

  const j9 = SM.joinRoom(room, P('p9'));
  ok(!j9.ok, '第 9 个人被拒');
  ok(/最多 8 人/.test(j9.error || ''), '★ 文案按房间自己的上限说 8 人，不是 5 人', j9.error);

  /* 渲染侧的证据：座位数必须等于房间里的人，不能等于当前配置。
   * 这条是「第 6~8 人看不到自己的座位」那个事故的直接断言。 */
  eq(SM.roomSeats(room).length, 8, '★ 老房间里 8 个人都有座位（不会因为上限改成 5 就少画 3 个）');
  eq(SM.capOf(room), 8, 'capOf(老房间) = 8');
}

console.log('\n[5] 缺 cap 的房间（老数据 / 反序列化）退回当前配置');

{
  const room = SM.newRoom('R-NOCAP', P('a'));
  delete room.cap;
  eq(SM.capOf(room), 5, 'cap 缺失时退回 5，不会变成 undefined 让比较恒为假');
  eq(SM.capOf(null), 5, 'capOf(null) 也不炸');
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
if (fail > 0) process.exitCode = 1;
