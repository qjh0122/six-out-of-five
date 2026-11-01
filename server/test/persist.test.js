/**
 * 战绩持久化测试
 * 跑法：node server/test/persist.test.js
 *
 * 要保证的三件事：
 *   1. 正常重启（进程退出再起）→ 数据还在
 *   2. 容器被重建（主文件消失）→ 用随包上传的种子恢复
 *   3. 主文件存在但为空 → 视为人工清空，**不要**用种子反向还原
 *
 * 这三条决定了「发布会不会把榜单抹掉」，所以每种情况都要单独锁住。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const crypto = require('crypto');

const TMP = path.join(os.tmpdir(), 'lxw-persist-' + Date.now());
const DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

/*
 * 种子文件必须指到临时目录（SEED_FILE）。
 * 以前的写法是直接写 server/data/profiles.json、跑完再还原——问题是测试中途崩了
 * 或者被 Ctrl+C，真实种子就被测试数据覆盖了，而它是容器重建时唯一的恢复来源。
 * 现在改成"根本不碰"，并且末尾校验一次真实种子没被动过。
 */
/* 指向**样例**种子，不是真实档案：真实 profiles.json 已从仓库出库（公开仓库不存真实账号）。
 * 这条路径不能省 —— 若指向一个不存在的文件，hashFile() 返回 null，
 * 下面「跑完之后种子一字节没变」就退化成 null === null：测试照绿，保护为零。 */
const REAL_SEED = path.join(__dirname, '..', 'data', 'profiles.example.json');
const SEED = path.join(TMP, 'seed.json');
const realSeedHashBefore = hashFile(REAL_SEED);

function hashFile(f) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); }
  catch (e) { return null; }
}

process.env.DATA_DIR = DATA_DIR;
process.env.SEED_FILE = SEED;
const { ProfileStore } = require('../profile.js');

function writeSeed(obj) {
  fs.mkdirSync(path.dirname(SEED), { recursive: true });
  fs.writeFileSync(SEED, JSON.stringify(obj), 'utf8');
}
function clearMain() {
  const main = path.join(DATA_DIR, 'profiles.json');
  if (fs.existsSync(main)) fs.unlinkSync(main);
  return main;
}

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

const SAMPLE = {
  p1: {
    playerId: 'p1', nickname: '备份玩家', games: 5, wins: 3, losses: 2, draws: 0,
    totalNet: 12, currentStreak: 2, longestStreak: 3, bestNet: 9,
    recent: [{ endedAt: 1, net: 5, roomId: 'R1' }], updatedAt: 1
  }
};

console.log('\n[1] 主文件不存在 + 种子有数据 → 用种子恢复');

clearMain();
writeSeed(SAMPLE);
let store = new ProfileStore();
ok(store.file.indexOf(DATA_DIR) === 0, '主文件落在 DATA_DIR 下（项目外）', store.file);
ok(store.restoredFromSeed === true, '标记为「从种子恢复」');
ok(store.top(10).length === 1, '恢复出 1 位玩家');
ok(store.top(10)[0].nickname === '备份玩家', '昵称正确');
ok(store.top(10)[0].totalNet === 12, '净胜正确');

console.log('\n[2] 恢复后立刻写回主文件');
store.flush();
ok(fs.existsSync(store.file), '主文件已生成');
const written = JSON.parse(fs.readFileSync(store.file, 'utf8'));
ok(Object.keys(written).length === 1, '主文件里有 1 条记录');

console.log('\n[3] 进程重启（新实例读主文件）→ 数据还在');
let again = new ProfileStore();
ok(again.restoredFromSeed === false, '这次不是从种子恢复，读的是主文件');
ok(again.top(10).length === 1, '数据还在');

console.log('\n[4] 主文件存在但为空 → 尊重清空，不还原种子');
fs.writeFileSync(store.file, '{}', 'utf8');
let cleared = new ProfileStore();
ok(cleared.restoredFromSeed === false, '不判定为从种子恢复');
ok(cleared.top(10).length === 0, '榜单是空的（人工清空生效）');

console.log('\n[5] 容器重建：主文件消失 → 种子再次兜底');
clearMain();
let rebuilt = new ProfileStore();
ok(rebuilt.top(10).length === 1, '又恢复了 1 位玩家');
ok(rebuilt.restoredFromSeed === true, '标记为从种子恢复');

console.log('\n[6] 种子为空时不会把已有数据抹掉');
clearMain();
writeSeed({});
let emptySeed = new ProfileStore();
ok(emptySeed.top(10).length === 0, '空种子 → 从空开始，不报错');

console.log('\n[7] 结算写入 + 重启不丢');
clearMain();
writeSeed({});
let live = new ProfileStore();
/* ★ 复用同一个 endedAt：它是 room.settledAt，在 markSettled 里只写一次。
 * 下面 [8] 要用它模拟「同一场被重复广播」，那时带的必然是**同一个值**。
 * 以前这里写的是 Date.now()，每条都不同 —— 在幂等键只有「房间#场次」时无所谓，
 * 加上时刻之后它就不再代表同一场了（见 server/test/idempotency-key.test.js）。 */
const T1 = 1761800000000;
live.record('p9', '新玩家', 6, T1, 'R9', 1);
live.record('p9', '新玩家', -2, T1 + 1000, 'R9', 2);
live.flush();
let afterRestart = new ProfileStore();
const p9 = afterRestart.top(10).find(function (x) { return x.playerId === 'p9'; });
ok(!!p9, '重启后新玩家还在');
ok(p9 && p9.games === 2, '场次 2');
ok(p9 && p9.wins === 1, '胜场 1');
ok(p9 && p9.totalNet === 4, '净胜 4');

console.log('\n[8] 同一场重复结算不会重复记');
const dup = live.record('p9', '新玩家', 6, T1, 'R9', 1);
ok(dup.recorded === false, '重复写入被幂等挡掉');
ok(live.top(10).find(function (x) { return x.playerId === 'p9'; }).games === 2, '场次没有变成 3');
/* 反过来：房间号被回收、场次号撞上，但结算时刻不同 → 这是另一场真打的牌，必须记 */
const reuse = live.record('p9', '新玩家', 3, T1 + 86400000, 'R9', 1);
ok(reuse.recorded !== false, '★ 同房间同场次但结算时刻不同 → 算新的一场，不被误挡');
ok(live.top(10).find(function (x) { return x.playerId === 'p9'; }).games === 3, '★ 场次变成 3');

console.log('\n[9] 这个测试不能动真实种子文件');
ok(realSeedHashBefore !== null, '仓库里的种子文件存在');
ok(hashFile(REAL_SEED) === realSeedHashBefore, '跑完之后真实种子一字节没变（以前是写完再还原，崩了就废了）');
ok(new ProfileStore().seedFile.indexOf(TMP) === 0, '种子路径确实被指到临时目录', new ProfileStore().seedFile);

/* ==========================================================================
 * [10] 主文件损坏：留档 + 用种子恢复，绝不静默覆盖
 *
 * 旧行为是「解析失败 → 当不存在 → 回退种子」。问题是它同时会把这个坏文件
 * 原地覆盖掉：玩家在发布后新写的战绩全没了，连人工抢救的副本都没留下，
 * 而且日志里一个字都没有。
 * ========================================================================== */
console.log('\n[10] 主文件损坏 → 改名留档 + 从种子恢复');
clearMain();
writeSeed(SAMPLE);
{
  const main = path.join(DATA_DIR, 'profiles.json');
  fs.writeFileSync(main, '{ 这不是 JSON', 'utf8');   // 半截写坏的样子
  const msgs = [];
  const broken = new ProfileStore({ log: (m) => msgs.push(m) });
  ok(broken.top(10).length === 1, '损坏后仍用种子恢复出数据');
  ok(broken.restoredFromSeed === true, '标记为从种子恢复');
  const dirFiles = fs.readdirSync(DATA_DIR).filter((f) => f.indexOf('profiles.json.corrupt-') === 0);
  ok(dirFiles.length === 1, '坏文件被改名保留（不是被覆盖）', dirFiles.join(','));
  if (dirFiles.length) {
    const kept = fs.readFileSync(path.join(DATA_DIR, dirFiles[0]), 'utf8');
    ok(kept === '{ 这不是 JSON', '留档内容就是原来那个坏文件，一字节没动');
  }
  ok(msgs.some((m) => m.indexOf('损坏') >= 0), '日志里明确说了「数据文件损坏」', msgs.join(' | '));
}

console.log('\n[11] 空文件也按损坏处理（不是「人工清空」）');
clearMain();
writeSeed(SAMPLE);
{
  const main = path.join(DATA_DIR, 'profiles.json');
  fs.writeFileSync(main, '', 'utf8');
  const blank = new ProfileStore({ log: () => {} });
  /* 空文件与「内容是 {}」必须区分开：前者是写坏的，后者是运维主动清空。
   * 把空文件当成清空，等于一次断电就把榜单抹了。 */
  ok(blank.top(10).length === 1, '空文件不会把榜单清空（回退种子）');
  blank.flush();   // 从种子恢复后是延迟落盘的，这里显式刷一次再读
  const mainAfter = JSON.parse(fs.readFileSync(main, 'utf8'));
  ok(Object.keys(mainAfter).length === 1, '主文件已被恢复写回');
}

console.log('\n[12] flush 与 dump 都不写 _seen（两个口径一致）');
clearMain();
writeSeed({});
{
  const s = new ProfileStore({ log: () => {} });
  s.record('pX', '甲', 3, Date.now(), 'R1', 1);
  s.flush();
  const onDisk = fs.readFileSync(s.file, 'utf8');
  ok(onDisk.indexOf('_seen') < 0, 'flush 落盘的文件里没有 _seen（幂等键只是会话内去重）');
  const dumped = JSON.stringify(s.dump());
  ok(dumped.indexOf('_seen') < 0, 'dump 同样不含 _seen（以前两边不一致，文件体积对不上）');
  ok(JSON.parse(onDisk).pX.games === 1, '该有的战绩字段一个不少');
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
