/**
 * 三个「到点」回调体必须真的被执行过一次（v125 / QA 的 C2）
 * 跑法：node server/test/timers-expire.test.js
 *
 * 【这个文件防的是什么】
 * hub 里有六类定时器，其中三个的时长原本是硬编码常量：
 *   · 断线宽限 GRACE_MS 90 秒
 *   · 等人挂起 HOLD_TTL_MS 3 分钟（另有专门一条，见 hold-timer-clock.test.js）
 *   · 空房回收 ROOM_IDLE_MS 30 分钟
 *
 * 90 秒 / 30 分钟在 CI 里等于「永远不会发生」，所以**这三个回调体从来没有被执行过**。
 * 也就是说：那三段代码在仓库里存在了很久，但没人知道它们跑起来对不对。
 * 这不是覆盖率数字问题 —— 它是「线上唯一会判人离开 / 唯一会回收房间」的那条路径。
 *
 * 做法：把时长改成环境变量可覆写（照 SPLIT_TIMEOUT_MS 的现成范式），
 * 用 250ms 真等一次。**不引入假时钟** —— 零依赖原则下不值得为此加 sinon，
 * 而且假时钟会把「setTimeout 到底有没有被挂上」也一并假装掉。
 */
'use strict';

/* ★ v128：250ms → 1200ms。原来「120ms 时还没到点」只留 130ms 余量，
 * CI 上会被并发吃掉（BACKLOG C13）。放大窗口不改变判据。 */
process.env.GRACE_MS = '1200';
process.env.ROOM_IDLE_MS = '1200';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Hub } = require('../hub.js');
const SM = require('../../pwa/js/stateMachine.js');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lxw-expire-'));

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
  return room;
}

/* 这个文件里回收时长也很短，会跟「宽限到期」抢同一个房间。
 * 测宽限时把它摘掉，避免两个回调互相打断 —— 这不是绕过被测代码，
 * 而是把两件事分开测（回收另有专门的段落）。 */
function disarmRecycle(hub, roomId) {
  const t = hub.roomTimers.get(roomId);
  if (t) { clearTimeout(t); hub.roomTimers.delete(roomId); }
}

(async function main() {
  console.log('\n[1] 断线宽限到期 → 真的判了离开');
  {
    const hub = new Hub({ statePath: '', log: function () {} });
    const room = mkRoom('920001');
    hub.rooms.set('920001', room);
    disarmRecycle(hub, '920001');

    /* 走真实的断线路径：conns 里有这个连接 → onClose 才会 markDisconnected + _startGrace */
    const fake = {};
    hub.conns.set(fake, { roomId: '920001', playerId: 'pb' });
    hub.onClose(fake);

    const pb = SM.findPlayer(room, 'pb');
    eq(pb.connected, false, '断开那一刻被标成离线');
    ok(!pb.left, '★ 此刻还没判离开（宽限就是给他回来用的）');
    ok(hub.graceTimers.has('920001#pb'), '宽限计时器挂上了');

    await sleep(200);
    ok(!pb.left, '200ms 时仍然没判（1200ms 的宽限是真的在等）');

    await sleep(1200);   // 累计 ~1400ms
    ok(pb.left === true, '★★ 到点判了离开 —— 这个回调体第一次被执行到');
    ok(!hub.graceTimers.has('920001#pb'), '计时器自己清掉了（不会重复触发）');
  }

  console.log('\n[2] 宽限期内回来了 → 不许再判离开');
  {
    const hub = new Hub({ statePath: '', log: function () {} });
    const room = mkRoom('920002');
    hub.rooms.set('920002', room);
    disarmRecycle(hub, '920002');

    const fake = {};
    hub.conns.set(fake, { roomId: '920002', playerId: 'pb' });
    hub.onClose(fake);
    const pb = SM.findPlayer(room, 'pb');
    ok(!!hub.graceTimers.get('920002#pb'), '宽限挂上了');

    /* 模拟重连：清掉宽限（hub 在 resume 时就是这么做的），再等过宽限时长 */
    hub._clearGrace('920002', 'pb');
    ok(SM.reconnect(room, 'pb').ok === true, '走真实的重连路径');
    await sleep(1400);
    ok(pb.left !== true, '★★ 人是回来了，宽限到点也不许判离开');
    eq(pb.connected, true, '仍在线');
  }

  console.log('\n[3] 空房间回收 → 房间真的被删了');
  {
    const hub = new Hub({ statePath: '', log: function () {} });
    const room = mkRoom('920003');
    hub.rooms.set('920003', room);
    hub._armRoomRecycle('920003');
    ok(hub.rooms.has('920003'), '开始时房间在');

    await sleep(200);
    ok(hub.rooms.has('920003'), '200ms 时还在（1200ms 的回收是真的在等）');

    await sleep(1200);
    ok(!hub.rooms.has('920003'), '★★ 到点房间被回收 —— 这个回调体第一次被执行到');
    ok(!hub.roomTimers.has('920003'), '回收计时器已清');
  }

  console.log('\n[4] 房间里有活连接 → 到点不许回收');
  {
    const hub = new Hub({ statePath: '', log: function () {} });
    const room = mkRoom('920004');
    hub.rooms.set('920004', room);
    /* 一个活连接就够：还开着页面的人不该被「空房回收」清掉 */
    const keep = {};
    hub.conns.set(keep, { roomId: '920004', playerId: 'pa' });
    hub._armRoomRecycle('920004');
    await sleep(1400);   // 必须有活连接也不回收，但要等过回收时长
    ok(hub.rooms.has('920004'), '★★ 有人连着就不回收（这是 _anyLiveConn 的唯一作用）');
    eq(hub.roomTimers.has('920004'), false, '但计时器本身已经消耗掉了');
  }

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('========================================');
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  process.exit(fail ? 1 : 0);
})();
