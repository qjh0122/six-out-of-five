/**
 * 房间快照（P2-3）的守卫
 *
 * 验收判据只有一条硬的：**打一半杀进程重启，重启后能继续且分数不丢。**
 * 而「能继续」要靠三样东西一起活下来：房间对象、座位令牌、计时器。
 * 少一样，玩家回来就是「房间不存在 / 你不在该房间 / 卡在等待提交」。
 *
 * 这里用「同一个文件 new 两个 Hub」模拟重启 —— 真实的 kill -9 在单测里没有稳定的
 * 复现姿势（进程内 hook 不到「断电那一刻」），而这条路径覆盖的正是重启后的读取分支。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Hub } = require('../hub.js');
const SM = require('../../pwa/js/stateMachine.js');
const roomsState = require('../roomsState.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lxw-rooms-'));
const FILE = path.join(DIR, 'rooms-state.json');

function makeRoom(roomId, pid, score) {
  const room = SM.newRoom(roomId, { id: pid, nickname: '甲' }, { handLimit: 3 });
  room.players[0].score = score;
  room.phase = SM.PHASE.ROUND1_SPLIT;
  room.round = 1;
  room.handCount = 2;
  return room;
}

console.log('\n[1] 快照模块本身');
{
  ok(roomsState.save(FILE, { rooms: [{ roomId: '1' }], tokens: [['1#a', 'tok']] }) === true, '写成功返回 true');
  const snap = roomsState.load(FILE);
  eq(snap.rooms.length, 1, '读回一间房');
  eq(snap.tokens[0][0], '1#a', '读回令牌');
  ok(!fs.existsSync(FILE + '.tmp'), '★ 没有残留 .tmp（原子写的标志）');

  fs.writeFileSync(FILE, '{"v":1,"rooms":[{"roomId":');   // 半截 JSON
  eq(roomsState.load(FILE), null, '★ 坏文件返回 null（不许挡住启动）');

  fs.writeFileSync(FILE, JSON.stringify({ v: 99, rooms: [] }));
  eq(roomsState.load(FILE), null, '★ 版本不认识也返回 null（不硬读新结构）');

  eq(roomsState.load(path.join(DIR, 'nope.json')), null, '文件不存在返回 null');
  ok(roomsState.save('', {}) === false, '没路径就不写，返回 false（不抛）');
}

console.log('\n[2] 重启：房间、分数、令牌都要活下来');
{
  fs.rmSync(FILE, { force: true });
  const h1 = new Hub({ statePath: FILE, log: function () {} });
  const room = makeRoom('654321', 'pa', 7);
  room.players[0].hand = [{ s: 'S', r: 3 }];
  h1.rooms.set('654321', room);
  const token = h1._issueToken('654321', 'pa');
  ok(h1._saveStateNow() === true, '落盘成功');

  const h2 = new Hub({ statePath: FILE, log: function () {} });   // ← 模拟重启
  const back = h2.rooms.get('654321');
  ok(!!back, '★ 重启后房间还在');
  eq(back.players[0].score, 7, '★ 分数没丢');
  eq(back.players[0].hand.length, 1, '手牌也回来了（否则回来没牌可打）');
  eq(back.phase, SM.PHASE.ROUND1_SPLIT, '阶段保持');
  eq(back.players[0].connected, false, '★ 连接一律置 false（重启那刻确实断了）');
  ok(h2._verifySeat('654321', 'pa', token), '★ 座位令牌有效 —— 否则玩家回不了座');
}

console.log('\n[3] 删房间要立刻落盘（否则重启后它会复活）');
{
  const h = new Hub({ statePath: FILE, log: function () {} });
  h._deleteRoom('654321');
  const snap = roomsState.load(FILE);
  eq(snap.rooms.filter(function (r) { return r.roomId === '654321'; }).length, 0, '★ 已删的房间不在快照里');
  const h3 = new Hub({ statePath: FILE, log: function () {} });
  eq(h3.rooms.has('654321'), false, '重启后也不会复活');
}

console.log('\n[4] 没配 statePath 时完全不落盘（单测里 new Hub() 不该留文件）');
{
  const h = new Hub({ log: function () {} });
  eq(h.statePath, '', 'statePath 为空');
  eq(h._saveStateNow(), false, '不写文件');
  eq(h._scheduleStateSave(), undefined, '去抖也不排（直接返回）');
}

console.log('\n[5] 接线：生产必须真的传这个路径');
{
  const index = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  ok(/ROOMS_STATE_FILE/.test(index), '★ 允许用 ROOMS_STATE_FILE 显式指定（测试/多实例）');
  ok(/path\.join\(path\.dirname\(profiles\.file\), 'rooms-state\.json'\)/.test(index),
    '★ 默认放在数据目录（和 profiles.json 同级，部署不会覆盖）');
  /* 这条是踩出来的：测试用 PROFILE_FILE 指到 tmp 里的档案时，快照也会落到 tmp，
   * 跨测试跑累积 —— e2e 因此捡到上一次剩下的 3 间房。 */
  ok(/process\.env\.PROFILE_FILE \? ''/.test(index), '★ 用 PROFILE_FILE 时默认不落盘（避免测试互相污染）');
  const hub = fs.readFileSync(path.join(__dirname, '..', 'hub.js'), 'utf8');
  ok(/this\._scheduleStateSave\(\);/.test(hub), '广播末尾排一次落盘（覆盖所有状态变化）');
  ok(/_deleteRoom\(roomId\) \{[\s\S]{0,120}this\._saveStateNow\(\);/.test(hub), '删房间立刻落盘');
}

fs.rmSync(DIR, { recursive: true, force: true });
console.log('\n----------------------------------------');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) process.exit(1);
