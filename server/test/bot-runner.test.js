/**
 * 后台「模拟对战」任务管理器（server/botRunner.js）
 * 跑法：node server/test/bot-runner.test.js
 *
 * 这里不打真实对局（那是 `scripts/probe-admin.js` 与命令行脚本的事），
 * 只锁住任务管理器自己的几条硬约束：
 *
 *   1. **入参收敛**：人数 2～5、局数只认 3/5/10/15/30、场数钳在 1～200。
 *      后台是给人填表单的，前端校验永远可以被绕过（直接打接口），
 *      所以真正的拦截必须在服务端这一层。
 *   2. **密码不落任何对象、不落盘**。这条是安全边界，不是风格问题：
 *      bot-jobs.json 是长期保留的历史文件，密码写进去就等于明文库存。
 *   3. **单任务并发**：第二个任务 409 并带回正在跑的 id —— 两个任务并行会
 *      互相污染排行榜基线（A 算「场次涨了几」时 B 也在涨）。
 *   4. **重启后不装活**：进程重启前还在 running 的任务必须标成 interrupted，
 *      否则页面会一直转圈等一个不存在的进度。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { BotRunner } = require('../botRunner.js');

const TMP = os.tmpdir();

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}
function tmpFile(tag) {
  return path.join(TMP, 'lxw-bot-' + tag + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.json');
}
/* 连不上的地址：让 _run 在第一次登录就失败，测试不必等真实对局 */
const DEAD_BASE = 'http://127.0.0.1:1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const P3 = [
  { account: 'a', password: 'pw111111' },
  { account: 'b', password: 'pw222222' },
  { account: 'c', password: 'pw333333' }
];

(async () => {
  console.log('\n[入参收敛]');
  {
    const r = new BotRunner({ base: () => DEAD_BASE, storeFile: '' });

    let err = null;
    try { r.normalize({ players: [P3[0]], rooms: 1, handsPerRoom: 3 }); } catch (e) { err = e; }
    ok(!!err && /至少需要 2 个玩家/.test(err.message), '1 个人 → 拒绝（MIN_PLAYERS=2）', err && err.message);

    err = null;
    const six = P3.concat([{ account: 'd', password: 'x1' }, { account: 'e', password: 'x2' }, { account: 'f', password: 'x3' }]);
    try { r.normalize({ players: six, rooms: 1, handsPerRoom: 3 }); } catch (e) { err = e; }
    ok(!!err && /最多 5 个玩家/.test(err.message), '6 个人 → 拒绝（MAX_PLAYERS=5）', err && err.message);

    err = null;
    try { r.normalize({ players: [{ account: 'a', password: 'x' }, { account: 'b', password: '' }], rooms: 1, handsPerRoom: 3 }); } catch (e) { err = e; }
    ok(!!err && /没填密码/.test(err.message), '缺密码 → 拒绝', err && err.message);

    err = null;
    try { r.normalize({ players: [{ account: 'a', password: 'x1' }, { account: 'a', password: 'x2' }], rooms: 1, handsPerRoom: 3 }); } catch (e) { err = e; }
    ok(!!err && /重复/.test(err.message), '同一账号选两遍 → 拒绝（一个账号只能占一个座位）', err && err.message);

    const t1 = r.normalize({ players: P3, rooms: 999, handsPerRoom: 7 });
    ok(t1.rooms === 200, '场数 999 被钳到 200', t1.rooms);
    ok(t1.handsPerRoom === 3, '非法局数 7 回落到 3（建房白名单）', t1.handsPerRoom);

    const t2 = r.normalize({ players: P3, rooms: 0, handsPerRoom: 15 });
    ok(t2.rooms === 1, '场数 0 被抬到 1', t2.rooms);
    ok(t2.handsPerRoom === 15, '合法局数 15 保留', t2.handsPerRoom);

    const t3 = r.normalize({ players: P3, rooms: 2, handsPerRoom: 5, pace: [300, 100] });
    ok(t3.pace[0] === 100 && t3.pace[1] === 300, '节奏区间反着填会被摆正', t3.pace);
  }

  console.log('\n[密码不落对象、不落盘]');
  {
    const storeFile = tmpFile('store');
    const r = new BotRunner({ base: () => DEAD_BASE, storeFile: storeFile });
    const job = r.start({ players: P3, rooms: 1, handsPerRoom: 3 });
    const flat = JSON.stringify(job);
    ok(flat.indexOf('pw111111') < 0 && flat.indexOf('pw333333') < 0, 'start 返回的 job 里搜不到密码');
    ok(job.players.length === 3 && job.players[0].account === 'a', 'job.players 只留账号名');

    await sleep(1500);   // 让 _run 去失败一遍，顺带走完落盘
    let raw = '';
    try { raw = fs.readFileSync(storeFile, 'utf8'); } catch (e) { raw = ''; }
    ok(!!raw, '任务历史已落盘');
    ok(raw.indexOf('pw111111') < 0, '★ 落盘文件里没有密码（安全边界）');
    try { fs.unlinkSync(storeFile); } catch (e) { /* 忽略 */ }
  }

  console.log('\n[单任务并发]');
  {
    const r = new BotRunner({ base: () => DEAD_BASE, storeFile: '' });
    const first = r.start({ players: P3, rooms: 1, handsPerRoom: 3 });
    let err = null;
    try { r.start({ players: P3, rooms: 1, handsPerRoom: 3 }); } catch (e) { err = e; }
    ok(!!err && err.code === 'BUSY', '第二个任务被拒，code=BUSY', err && err.code);
    ok(!!err && err.jobId === first.id, '拒绝时带回正在跑的任务 id', err && err.jobId);
    ok(r.runningId === first.id, 'runningId 指向第一个任务');
    await sleep(1500);
  }

  console.log('\n[失败要落成 failed 而不是把进程带走]');
  {
    const r = new BotRunner({ base: () => DEAD_BASE, storeFile: '' });
    const job = r.start({ players: P3, rooms: 2, handsPerRoom: 3 });
    await sleep(2500);
    const got = r.get(job.id);
    ok(!!got && got.status === 'failed', '连不上服务 → 任务 failed', got && got.status);
    ok(!!got && !!got.error, '失败原因写进了 error', got && got.error);
    ok(r.runningId === '', '失败后 runningId 释放，可以再起新任务');
  }

  console.log('\n[重启后不装活]');
  {
    const storeFile = tmpFile('resume');
    const now = Date.now();
    fs.writeFileSync(storeFile, JSON.stringify({
      savedAt: now,
      jobs: [
        { id: 'job-old-running', status: 'running', createdAt: now - 60000, startedAt: now - 60000, endedAt: 0,
          spec: { rooms: 1, handsPerRoom: 3, playerCount: 2 }, players: [{ account: 'a' }, { account: 'b' }],
          progress: { roomsDone: 0, roomsTotal: 1, handsDone: 0, handsTotal: 3, phase: '第 1 场' }, rooms: [], hands: [], error: '' },
        { id: 'job-old-done', status: 'done', createdAt: now - 120000, startedAt: now - 120000, endedAt: now - 110000,
          spec: { rooms: 1, handsPerRoom: 3, playerCount: 2 }, players: [{ account: 'a' }, { account: 'b' }],
          progress: { roomsDone: 1, roomsTotal: 1, handsDone: 3, handsTotal: 3, phase: '完成' }, rooms: [], hands: [], error: '' }
      ]
    }));

    const r = new BotRunner({ base: () => DEAD_BASE, storeFile: storeFile });
    const list = r.list();
    const running = list.find((j) => j.id === 'job-old-running');
    const done = list.find((j) => j.id === 'job-old-done');
    ok(!!running && running.status === 'interrupted', '上次还在 running 的 → interrupted', running && running.status);
    ok(!!running && /中断/.test(running.progress.phase), '进度文案也改成「中断」', running && running.progress.phase);
    ok(!!done && done.status === 'done', '已完成的不受影响', done && done.status);
    ok(r.runningId === '', '恢复历史后不会误判为「有任务在跑」');
    try { fs.unlinkSync(storeFile); } catch (e) { /* 忽略 */ }
  }

  console.log('\n[取消]');
  {
    const r = new BotRunner({ base: () => DEAD_BASE, storeFile: '' });
    const a = r.cancel('job-not-exist');
    ok(!a.ok && a.code === 'NOTFOUND', '取消不存在的任务 → NOTFOUND', a.code);

    const job = r.start({ players: P3, rooms: 1, handsPerRoom: 3 });
    const c = r.cancel(job.id);
    ok(c.ok && c.job.status === 'cancelling', '运行中的任务 → cancelling', c.job && c.job.status);
    await sleep(1200);
    const after = r.get(job.id);
    ok(!!after && after.status === 'cancelled', '最终落成 cancelled', after && after.status);

    const again = r.cancel(job.id);
    ok(!again.ok && again.code === 'NOT_RUNNING', '已结束的任务不能再取消', again.code);
  }

  console.log('\n[历史条数有上限]');
  {
    const now = Date.now();
    const many = [];
    for (let i = 0; i < 60; i++) {
      many.push({ id: 'job-' + i, status: 'done', createdAt: now - i * 1000, startedAt: now, endedAt: now,
        spec: { rooms: 1, handsPerRoom: 3, playerCount: 2 }, players: [], progress: {}, rooms: [], hands: [], error: '' });
    }
    const storeFile = tmpFile('cap');
    fs.writeFileSync(storeFile, JSON.stringify({ savedAt: now, jobs: many }));
    const r = new BotRunner({ base: () => DEAD_BASE, storeFile: storeFile });
    ok(r.list().length <= 40, '历史最多保留 40 条，不会无限涨', r.list().length);
    try { fs.unlinkSync(storeFile); } catch (e) { /* 忽略 */ }
  }

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
