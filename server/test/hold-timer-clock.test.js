/**
 * 「等个人」的定时器与数据必须同一个时间基准（v125 / QA 的 C1）
 * 跑法：node server/test/hold-timer-clock.test.js
 *
 * 【这个文件防的是什么】
 * 数据侧：`holdNextOf` 按 `holdNext.at + HOLD_TTL_MS` 判过期。
 * 定时器侧：`hub._armHoldTimer` 里写死 `setTimeout(..., SM.HOLD_TTL_MS)`。
 *
 * 两者在「第一次挂起」时恰好一致，所以平时看不出来。但 `setHoldNext` 是幂等的
 * —— 重复点「等人」**不会重置 at**（这是有测试保证的设计），
 * 而 `holdNext` handler 每次都会重挂定时器。于是：
 *
 *   第 0 秒   挂起         数据到期 = 180s，定时器 = 180s     ✔
 *   第 100 秒 房主再点一次  数据到期 = 180s，定时器 = 280s     ✘
 *
 * 中间那 100 秒里，挂起已经不再阻止开局，但没有任何广播 ——
 * 所有人看到的是「都就位了，就是不开」。单跑任何一条测试都是绿的。
 *
 * 【为什么这条必须存在】
 * 它不是「算错了」，而是**两处代码各自算了一遍同一个时间**。
 * 只断言其中一边（各有一条绿测试）永远发现不了。
 */
'use strict';

/* 三个时长在 hub 加载时读取 —— 必须在 require 之前设好。
 * 250ms 是「短到能真等」，又「长到不会因为一次 GC 抖动误判」。 */
/* ★ v128：250ms → 1200ms。原来「120ms 时还没到期」只留了 130ms 余量，
 * CI 上（同一台机器并发跑 5 个 job）这个余量会被吃掉，见 BACKLOG C13。
 * 放大的是窗口，不是判据。 */
process.env.HOLD_TTL_MS = '1200';
process.env.GRACE_MS = '250';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Hub } = require('../hub.js');
const SM = require('../../pwa/js/stateMachine.js');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lxw-holdclock-'));
const FILE = path.join(DIR, 'state.json');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function mkRoom(roomId) {
  const room = SM.newRoom(roomId, { id: 'pa', nickname: '甲' }, { handLimit: 3 });
  SM.joinRoom(room, { id: 'pb', nickname: '乙' });
  room.players.forEach((p) => { p.ready = true; });
  SM.startGame(room, 'pa');
  /* 直接推进到结算期：这两条与时间无关，只为拿到一个能挂起等人的房间。 */
  SM.proposeDissolve(room, 'pa');
  SM.activePlayers(room).slice(1).forEach((p) => SM.voteDissolve(room, p.id, true));
  return room;
}

(async function main() {
  console.log('\n[0] TTL 真的被环境变量接住了（否则下面的等待全部失真）');
  eq(SM.HOLD_TTL_MS, 1200, '★ stateMachine 读到了 HOLD_TTL_MS=1200');

  console.log('\n[1] 同一次挂起：定时器到期时刻 === 数据到期时刻');
  {
    const hub = new Hub({ statePath: '', log: function () {} });
    const room = mkRoom('800001');
    hub.rooms.set('800001', room);
    ok(SM.setHoldNext(room, 'pa', true).ok === true, '房主挂起成功');
    const dataExpire = SM.holdNextOf(room).at + SM.HOLD_TTL_MS;
    const timerExpire = hub._armHoldTimer('800001');
    ok(Math.abs(timerExpire - dataExpire) <= 5,
      '★ 定时器与数据指向同一时刻（差 ≤5ms）',
      'timer=' + timerExpire + ' data=' + dataExpire);
    hub._clearHoldTimer('800001');
  }

  console.log('\n[1b] 协议上真的下发了「绝对到期时刻」（前端才有东西可显示）');
  {
    const hub = new Hub({ statePath: '', log: function () {} });
    const room = mkRoom('800011');
    hub.rooms.set('800011', room);
    SM.setHoldNext(room, 'pa', true);

    const view = hub._view(room, 'pa');
    eq(view.holdNextEndsAt, room.holdNext.at + SM.HOLD_TTL_MS,
      '★ 下发 holdNextEndsAt（绝对时刻，与分牌倒计时同一口径）');
    ok(typeof view.now === 'number', '★ 同时下发 now —— 客户端靠它扣掉设备时钟偏差');

    /* 非房主也要收得到：等不等是整桌的事，不是「只有房主需要知道」。 */
    const viewB = hub._view(room, 'pb');
    eq(viewB.holdNextEndsAt, view.holdNextEndsAt, '★ 其他人也看得到（不然他们不知道为什么点了没反应）');

    SM.setHoldNext(room, 'pa', false);
    eq(hub._view(room, 'pa').holdNextEndsAt, undefined, '没挂起时不下发（不制造死数据）');
  }

  console.log('\n[2] 重复点「等人」不得延长任何东西（这就是那个 bug 的形状）');
  {
    const hub = new Hub({ statePath: '', log: function () {} });
    const room = mkRoom('800002');
    hub.rooms.set('800002', room);
    SM.setHoldNext(room, 'pa', true);
    const first = hub._armHoldTimer('800002');

    /* 把 at 往前挪 120ms，模拟「过了 120ms 房主又点了一次」。
     * 直接改字段而不是真等，是为了让这条断言与机器快慢无关。 */
    room.holdNext.at -= 120;
    eq(SM.setHoldNext(room, 'pa', true).ok, true, '重复挂起仍是幂等成功（不报错）');
    const second = hub._armHoldTimer('800002');

    /* 判据是「定时器仍然等于数据」——
     * 把 at 往回挪之后两边**同时**提前，这恰恰是同基准的表现；
     * 旧实现会让定时器按 now + TTL 重算，比数据晚整整 120ms。 */
    const dataExpire2 = room.holdNext.at + SM.HOLD_TTL_MS;
    ok(Math.abs(second - dataExpire2) <= 5,
      '★★ 第二次挂起后，定时器仍与数据指向同一时刻',
      'timer=' + second + ' data=' + dataExpire2);
    ok(second <= first,
      '★★ 重复点「等人」不会把到期时间往后推（旧实现会晚 120ms）',
      'first=' + first + ' second=' + second + ' 差=' + (second - first) + 'ms');
    ok(SM.holdNextLeftMs(room) < SM.HOLD_TTL_MS,
      '★ 数据侧的剩余时间也确实变短了（两边同时变，不是各走各的）',
      'left=' + SM.holdNextLeftMs(room));
    hub._clearHoldTimer('800002');
  }

  console.log('\n[3] 到点之后：真等一次，房间必须自己放开');
  {
    const hub = new Hub({ statePath: '', log: function () {} });
    const room = mkRoom('800003');
    hub.rooms.set('800003', room);
    /* 两个人都在、都报了名，只差「房主说了先别开」这一条 ——
     * 放行之后应当当场发牌。顺序不能反：先把挂起设上，再断言开不了。 */
    room.players.forEach((p) => SM.wantNext(room, p.id));
    SM.setHoldNext(room, 'pa', true);
    eq(SM.canStartNext(room), false, '挂起期间开不了（这是挂起的全部作用）');

    hub._armHoldTimer('800003');
    await sleep(200);
    ok(!!SM.holdNextOf(room), '120ms 时还没到期（这个时长是真的在等）');

    await sleep(1200);   // 累计 ~1400ms > 1200ms
    eq(SM.holdNextOf(room), null, '★★ 到点后 holdNextOf 返回 null（数据侧放行）');
    eq(room.phase, 'ROUND1_SPLIT', '★★ 到点触发自动开局 —— 这就是到期回调体第一次被执行到');
    eq(SM.playingPlayers(room).length, 2, '两个人都在打，没人被挂起带走');
  }

  console.log('\n[4] 放行之后不得留下定时器（否则下一局会莫名「时间到」）');
  {
    const hub = new Hub({ statePath: '', log: function () {} });
    const room = mkRoom('800004');
    hub.rooms.set('800004', room);
    SM.setHoldNext(room, 'pa', true);
    hub._armHoldTimer('800004');
    SM.setHoldNext(room, 'pa', false);       // 房主自己放行
    hub._clearHoldTimer('800004');            // handler 里做的事
    eq(hub.holdTimers.has('800004'), false, '★ 定时器已清');
    eq(hub._armHoldTimer('800004'), 0, '★ 没在挂起时 _armHoldTimer 返回 0（不空挂）');
  }

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('========================================');
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  process.exit(fail ? 1 : 0);
})();
