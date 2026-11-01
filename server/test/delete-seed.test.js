/**
 * 删号的**收尾**两件事 + 已注销玩家查询（node server/test/delete-seed.test.js）
 *
 * 这一组守的是「删号之后，痕迹不会自己长回来」：
 *
 *   1. **种子文件也要跟着删**。种子是容器重建时唯一的恢复来源，而 remove()
 *      只写主文件。于是存在一个窗口：A 删号后、下一次 npm run backup 之前，
 *      容器重建一次 → 种子把 A 的档案原样恢复 → 账号能登录、战绩全在。
 *      用户以为自己删干净了，其实没有。这条测试就是钉住那个窗口关掉了。
 *
 *   2. **连接要立刻断**。hub 的 _pid() 每次取身份都复查账号，所以 A 下一次
 *      操作会被踢——但那叫「懒踢」：他停在结算页不动，连接就一直挂着、
 *      座位一直占着。删号应该当场断（管理端那条路早就这么做了，用户自助
 *      删号这条路没有，两条路必须长得一样）。
 *
 *   3. **已注销玩家查询接口只回 dead**。它被用来让对方的设备在本地抹掉
 *      已注销者的名字；如果连「谁还活着」也一起回，它就成了
 *      「给一个 id 就能探测有没有这个人」的枚举通道。
 */
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.PROFILE_FILE = path.join(os.tmpdir(), 'lxw-seed-del-profiles-' + Date.now() + '.json');
const SEED = path.join(os.tmpdir(), 'lxw-seed-del-seed-' + Date.now() + '.json');
process.env.SEED_FILE = SEED;
process.env.BACKUP_KEY = 'seed-del-test-key-0123456789';
process.env.PORT = process.env.PORT || '3198';
const PORT = Number(process.env.PORT);

const { server, hub, profiles } = require('../index.js');
const { httpAuth, registerPlayer } = require('./helpers/account');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

function readSeed() {
  try { return JSON.parse(fs.readFileSync(SEED, 'utf8')); } catch (e) { return null; }
}

/* 记下每一次踢人。真实的 kickPlayer 会遍历连接表发消息，
 * 这里没有 WS 连接，所以包一层既验证「被调到了」，又不影响原行为。 */
const kicked = [];
const origKick = hub.kickPlayer.bind(hub);
hub.kickPlayer = function (pid, reason) {
  kicked.push({ pid: String(pid), reason: reason });
  return origKick(pid, reason);
};

async function run() {
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });
  console.log('\n服务端就绪 127.0.0.1:' + PORT + '  种子 ' + SEED);

  /* -------------------- 建档 -------------------- */
  console.log('\n[建档：A / B，A 打一场，种子里先有这两个人]');
  const a = await registerPlayer(PORT, '种子测试A');
  const b = await registerPlayer(PORT, '种子测试B');
  profiles.record(a.playerId, a.nickname, 7, Date.now() - 5000, 'r1', 1);
  profiles.record(b.playerId, b.nickname, -7, Date.now() - 5000, 'r1', 1);

  ok(profiles.writeSeed() === true, 'writeSeed() 返回 true');
  let seed = readSeed();
  ok(!!seed, '种子文件已生成且是合法 JSON');
  ok(!!seed && !!seed[a.playerId], '种子里有 A');
  ok(!!seed && !!seed[b.playerId], '种子里有 B');
  eq(Object.keys(seed || {}).length, 2, '种子里正好两条');
  ok(!!seed[a.playerId].account, '种子带着 account（否则容器重建后所有人登不进来）');
  ok(seed[a.playerId]._seen === undefined, '种子不带 _seen 幂等键（与主文件同口径）');

  /* -------------------- 删号 -------------------- */
  console.log('\n[删号：种子必须跟着删，连接必须当场断]');
  const before = kicked.length;
  let r = await httpAuth(PORT, 'POST', '/api/auth/delete', a.token, { password: a.password });
  eq(r.status, 200, '删号成功');
  eq(r.json && r.json.removed, true, 'removed=true');

  seed = readSeed();
  ok(!!seed, '种子文件还在（不是被删掉了）');
  eq(!!(seed && seed[a.playerId]), false, '★ 种子里的 A 没了 —— 容器重建也恢复不回来');
  ok(!!(seed && seed[b.playerId]), '★ B 还在（只删自己的）');
  eq(Object.keys(seed || {}).length, 1, '种子里只剩一条');

  eq(kicked.length, before + 1, 'kickPlayer 被调了一次');
  eq(kicked[kicked.length - 1].pid, a.playerId, '踢的是 A 的连接');
  ok(/删/.test(kicked[kicked.length - 1].reason || ''), '原因里说清了是删号', kicked[kicked.length - 1].reason);

  ok(profiles.has(a.playerId) === false, 'has(A) 为 false');
  ok(profiles.has(b.playerId) === true, 'has(B) 仍为 true');

  /* 主文件与种子必须同一口径：不允许出现「主文件删了、种子还在」的分叉 */
  const mainFile = process.env.PROFILE_FILE;
  let main = null;
  try { main = JSON.parse(fs.readFileSync(mainFile, 'utf8')); } catch (e) { /* 可能还没落盘 */ }
  if (main) {
    eq(!!main[a.playerId], false, '主文件里也没有 A（两份口径一致）');
  }

  /* -------------------- 令牌已失效 -------------------- */
  console.log('\n[删完之后，旧令牌当场作废]');
  r = await httpAuth(PORT, 'POST', '/api/auth/delete', a.token, { password: a.password });
  eq(r.status, 401, '再用旧令牌删一次 → 401（不是 200 removed:false）');

  /* -------------------- 重复 remove 幂等 -------------------- */
  console.log('\n[remove 本身幂等]');
  eq(profiles.remove(a.playerId), false, '第二次 remove 返回 false');
  eq(profiles.remove(''), false, '空 id 返回 false（不会误删）');

  /* -------------------- alive 接口 -------------------- */
  console.log('\n[/api/players/alive：只回 dead，不回活人信息]');
  r = await httpAuth(PORT, 'GET', '/api/players/alive?ids=' + a.playerId + ',' + b.playerId, b.token);
  eq(r.status, 200, '200');
  eq(Array.isArray(r.json && r.json.dead), true, 'dead 是数组');
  eq((r.json.dead || []).join(','), a.playerId, 'dead 里只有 A');
  eq(r.json.checked, 2, 'checked=2（查了两个）');
  eq(Object.keys(r.json || {}).filter(function (k) { return k !== 'ok' && k !== 'dead' && k !== 'checked'; }).length, 0,
    '★ 响应里没有别的字段（不带存活者的任何信息）');

  r = await httpAuth(PORT, 'GET', '/api/players/alive?ids=' + b.playerId, b.token);
  eq((r.json.dead || []).length, 0, 'B 还活着 → dead 为空');

  r = await httpAuth(PORT, 'GET', '/api/players/alive', b.token);
  eq(r.status, 200, '不带 ids → 200');
  eq((r.json.dead || []).length, 0, '不带 ids → dead 为空');
  eq(r.json.checked, 0, 'checked=0');

  r = await httpAuth(PORT, 'GET', '/api/players/alive?ids=,,,%20%20,', b.token);
  eq(r.json.checked, 0, '全是空白和逗号 → 一个都不查');

  /* 去重：同一个 id 传三次只查一次 */
  r = await httpAuth(PORT, 'GET', '/api/players/alive?ids=' + b.playerId + ',' + b.playerId + ',' + b.playerId, b.token);
  eq(r.json.checked, 1, '重复 id 去重');

  /* 未登录 */
  r = await httpAuth(PORT, 'GET', '/api/players/alive?ids=' + b.playerId, null);
  eq(r.status, 401, '不带令牌 → 401（不能变成匿名探测接口）');

  /* 上限 */
  const many = [];
  for (let i = 0; i < 51; i++) many.push('p' + i);
  r = await httpAuth(PORT, 'GET', '/api/players/alive?ids=' + many.join(','), b.token);
  eq(r.status, 400, '超过 50 个 → 400');

  const fifty = many.slice(0, 50);
  r = await httpAuth(PORT, 'GET', '/api/players/alive?ids=' + fifty.join(','), b.token);
  eq(r.status, 200, '正好 50 个 → 200');
  eq((r.json.dead || []).length, 50, '这 50 个都不存在 → 全是 dead');

  /* 只接受 GET */
  r = await httpAuth(PORT, 'POST', '/api/players/alive?ids=' + b.playerId, b.token, {});
  eq(r.status, 405, 'POST → 405');

  /* -------------------- writeSeed 的健壮性 -------------------- */
  console.log('\n[writeSeed：目录不存在时自己建、不抛]');
  const deep = path.join(os.tmpdir(), 'lxw-deep-' + Date.now(), 'a', 'b', 'seed.json');
  const { ProfileStore } = require('../profile.js');
  const store = new ProfileStore({ file: path.join(os.tmpdir(), 'lxw-deep-main-' + Date.now() + '.json'), seedFile: deep });
  eq(store.writeSeed(), true, '父目录不存在也能写成功');
  ok(fs.existsSync(deep), '文件确实落地了');
  ok(!fs.existsSync(deep + '.tmp'), '临时文件被 rename 掉，没留下 .tmp');

  /* ================================================================ */
  console.log('\n' + (fail === 0 ? '全部通过' : '有失败') + '：' + pass + ' 项通过，' + fail + ' 项失败');
  try { fs.unlinkSync(SEED); } catch (e) { /* 清理 */ }
  process.exit(fail ? 1 : 0);
}

run().catch(function (e) {
  console.error('测试自身异常：', e);
  process.exit(1);
});
