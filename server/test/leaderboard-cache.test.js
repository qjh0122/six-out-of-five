/**
 * 榜单缓存失效 + 异步写盘（P2-8 / P2-9）
 * 跑法：node server/test/leaderboard-cache.test.js
 *
 * P2-9：`/api/leaderboard` 每次请求都全表遍历 + sort。加了缓存，
 *        但缓存最怕的是「改了数据忘了失效」——界面上看不出错，只是数据旧了。
 *        所以这里**逐条**走过每一个会改动榜单的公开路径，断言榜单立刻反映变化。
 *
 * P2-8：定时落盘从 writeFileSync 改成异步队列。要验两件事：
 *        ① 异步写最终确实落盘（不是「没写但没人发现」）；
 *        ② 连续多次写不会互相踩坏（串行队列的意义）。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP = path.join(os.tmpdir(), 'lxw-cache-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
const FILE = path.join(TMP, 'profiles.json');

const { ProfileStore } = require('../profile.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const store = new ProfileStore({ file: FILE, seedFile: path.join(TMP, 'no-seed.json') });

  /* ================================================================= */
  console.log('\n[1] 缓存确实生效（同一份数据不重复排序）');
  store.record('pA', '甲', 5, Date.now(), 'r1', 1);
  store.record('pB', '乙', 3, Date.now(), 'r1', 2);
  const s1 = store._standings();
  const s2 = store._standings();
  ok(s1 === s2, '★ 连续两次取榜单拿到**同一个数组引用**（真的走了缓存）');
  eq(s1.length, 2, '两个有战绩的人都在榜上');
  eq(s1[0].playerId, 'pA', '按净胜排序：甲在前');

  /* ================================================================= */
  console.log('\n[2] 每一条改动路径都必须让缓存失效');
  /* ① 再记一局，名次变化 */
  store.record('pB', '乙', 20, Date.now(), 'r1', 3);
  let list = store._standings();
  ok(list !== s1, 'record() 后缓存被重建（不是旧数组）');
  eq(list[0].playerId, 'pB', '★ 乙 反超后立刻排第一（没有显示旧榜单）');

  /* ② 改昵称 */
  store.setNickname('pB', '乙改名了');
  list = store._standings();
  eq(list[0].nickname, '乙改名了', '★ setNickname 后榜单里的昵称同步更新');

  /* ③ ensure 带来的首次昵称写入 */
  store.ensure('pC', '丙');
  store.record('pC', '丙', 1, Date.now(), 'r1', 4);
  ok(store._standings().some((x) => x.playerId === 'pC'), '新玩家进榜');

  /* ④ 删档 */
  store.remove('pA');
  ok(!store._standings().some((x) => x.playerId === 'pA'), '★ remove 后立刻从榜上消失');

  /* ⑤ prune 清僵尸档案（无战绩无账号的才会被清，这里造一个） */
  store.ensure('pZombie', '僵尸');
  const removed = store.prune();
  ok(removed.indexOf('pZombie') >= 0, 'prune 清掉了零战绩僵尸');
  ok(!store._standings().some((x) => x.playerId === 'pZombie'), '僵尸本来就不在榜上，榜仍然正确');

  /* ⑥ 全量重置 */
  store.reset();
  eq(store._standings().length, 0, '★ reset 后榜单为空');

  /* ================================================================= */
  console.log('\n[3] rankOf 与 top 用的是同一份缓存');
  const s3 = new ProfileStore({ file: path.join(TMP, 'p2.json'), seedFile: path.join(TMP, 'no-seed.json') });
  s3.record('x1', '一', 10, Date.now(), 'r2', 1);
  s3.record('x2', '二', 5, Date.now(), 'r2', 2);
  s3.record('x3', '三', 1, Date.now(), 'r2', 3);
  const top2 = s3.top(2);
  eq(top2.length, 2, 'top(2) 截断正确');
  eq(top2[0].playerId, 'x1', '第一名正确');
  const rk = s3.rankOf('x3');
  eq(rk.rank, 3, 'rankOf 名次正确');
  eq(rk.total, 3, 'total 是完整榜单人数');

  /* ================================================================= */
  console.log('\n[4] 异步写盘：数据最终真的落到磁盘');
  const s4 = new ProfileStore({ file: path.join(TMP, 'p4.json'), seedFile: path.join(TMP, 'no-seed.json') });
  s4.record('y1', '玩家一', 7, Date.now(), 'r3', 1);
  s4._flushAsync();
  await s4._writeQueue;
  await wait(30);
  const raw = fs.readFileSync(path.join(TMP, 'p4.json'), 'utf8');
  const parsed = JSON.parse(raw);
  ok(!!parsed.y1, '★ 异步写完之后文件里确实有这条档案');
  eq(parsed.y1.totalNet, 7, '净胜正确');
  ok(!('_seen' in parsed.y1), '_seen 幂等键没有写进文件（与 dump 口径一致）');

  /* ================================================================= */
  console.log('\n[5] 连续多次异步写：串行队列不能互相踩坏');
  /* 同步版每次都是整文件覆盖，谁后写谁算。异步版如果并发跑，
   * 两次写会抢同一个 .tmp 文件，rename 可能搬走半截内容。
   * 这里连发 5 次，最后文件必须是**完整可解析**的，且是最新快照。 */
  for (let i = 0; i < 5; i++) {
    s4.record('y2', '玩家二', i + 1, Date.now(), 'r4', i + 1);
    s4._flushAsync();
  }
  await s4._writeQueue;
  await wait(50);
  const raw2 = fs.readFileSync(path.join(TMP, 'p4.json'), 'utf8');
  let parsed2 = null;
  try { parsed2 = JSON.parse(raw2); } catch (e) { /* 解析失败就是踩坏了 */ }
  ok(parsed2 !== null, '★ 5 次连续写之后文件仍是完整 JSON（没有被写坏）');
  eq(parsed2 && parsed2.y2 && parsed2.y2.games, 5, '最新快照的场次数正确');
  ok(!fs.existsSync(path.join(TMP, 'p4.json.tmp')), '没有残留 .tmp 临时文件');

  /* ================================================================= */
  console.log('\n[6] 同步 flush 仍然可用（退出前/单测里要立刻读到文件）');
  const s5 = new ProfileStore({ file: path.join(TMP, 'p5.json'), seedFile: path.join(TMP, 'no-seed.json') });
  s5.record('z1', '同步', 2, Date.now(), 'r5', 1);
  s5.flush();
  const raw3 = JSON.parse(fs.readFileSync(path.join(TMP, 'p5.json'), 'utf8'));
  ok(!!raw3.z1, 'flush() 之后立刻读得到（同步语义没变）');

  /* 清理 */
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
