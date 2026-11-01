/**
 * 我的战绩（云端，与排行榜同源）：GET /api/me/records · POST /api/me/reset-stats
 * 跑法：node server/test/me-records.test.js
 *
 * 为什么要有这两个接口：
 * 战绩页原来只读本机 localStorage，排行榜读 profiles.json，两套数据互不相干。
 * 于是「删了战绩排行榜还在」「换号后战绩里是别人的局」「断线那局排行榜有、战绩没有」
 * 全都成立。修法是让战绩页读**同一份**服务器档案，删也必须能落到服务器。
 *
 * 这个文件锁六件事：
 *   1. 鉴权：没令牌 401，有令牌只返回自己的
 *   2. 字段齐：战绩页要的指标一个不缺，流水里带人数与结束原因
 *   3. 流水 20 条：自己看自己给足，别人只看 5 条（不抄别人流水）
 *   4. 单场最高：全负时取那个负数，不能是 0（0 是「平局」的语义）
 *   5. ★ 只清自己的：另一个人的战绩一根毫毛都不动
 *   6. 落盘：重启后清零后的状态还在（不会把旧战绩带回来）
 */
'use strict';

const path = require('path');
const os = require('os');
const http = require('http');

const TMP = os.tmpdir();
const PROFILE_FILE = path.join(TMP, 'lxw-merec-profiles-' + Date.now() + '.json');
process.env.PROFILE_FILE = PROFILE_FILE;
process.env.SEED_FILE = path.join(TMP, 'lxw-merec-seed-' + Date.now() + '.json');
process.env.BACKUP_KEY = 'me-records-test-key-123456';
process.env.PORT = process.env.PORT || '3217';
const PORT = Number(process.env.PORT);

const { server, profiles } = require('../index.js');
const { ProfileStore } = require('../profile.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

function request(method, p, headers, body) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({}, headers || {});
    let payload = null;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: method, headers: h }, (res) => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(b); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, body: parsed, raw: b });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.listen(PORT, '127.0.0.1', resolve);
  });

  console.log('\n[准备] 两个账号，分别打若干局');
  const c1 = await profiles.createAccount('me_a', 'me_a123456', '甲');
  const c2 = await profiles.createAccount('me_b', 'me_b123456', '乙');
  ok(c1.ok && c2.ok, '两个账号都建好了');
  const p1 = c1.playerId, p2 = c2.playerId;

  const t0 = Date.now() - 3600 * 1000;
  /* 甲：25 局，全负（单场最高必须是那个最接近 0 的负数，而不是 0） */
  for (let i = 0; i < 25; i++) {
    profiles.record(p1, '甲', -(i + 1), t0 + i * 60000, '5000' + i, 1, { playerCount: 3, endReason: 'scoreZero' });
  }
  /* 乙：8 局，全赢（用来验「别人的流水只给 5 条」） */
  for (let i = 0; i < 8; i++) {
    profiles.record(p2, '乙', 39, t0 + i * 60000, '6000' + i, 1, { playerCount: 3, endReason: 'scoreZero' });
  }
  profiles.flush();

  /* ---------------------------------------------------------------- */
  console.log('\n[鉴权] 没有令牌不许看');
  let r = await request('GET', '/api/me/records');
  eq(r.status, 401, '不带令牌 → 401');
  r = await request('GET', '/api/me/records', { 'x-session-token': 'not-a-real-token' });
  eq(r.status, 401, '伪令牌 → 401');

  const login = await request('POST', '/api/auth/login', null, { name: 'me_a', password: 'me_a123456' });
  eq(login.status, 200, '甲登录成功');
  const TK = login.body.token;
  const H = { 'x-session-token': TK };

  /* ---------------------------------------------------------------- */
  console.log('\n[字段] 战绩页要的指标一个不缺');
  r = await request('GET', '/api/me/records', H);
  eq(r.status, 200, '带令牌 → 200');
  const me = r.body && r.body.profile;
  ok(!!me, '回包里有 profile');
  eq(me && me.playerId, p1, '★ 返回的是自己（不认请求里的 id，只看令牌）');
  eq(me.games, 25, '场次 25');
  eq(me.wins, 0, '胜场 0');
  eq(me.losses, 25, '负场 25');
  eq(me.draws, 0, '平局 0');
  eq(me.winRate, 0, '胜率 0%');
  eq(me.totalNet, -325, '累计净胜 -325（1+2+…+25）');
  ok(typeof me.longestLoseStreak === 'number', '★ 有 longestLoseStreak 字段（不再只有连胜）');
  eq(me.longestLoseStreak, 25, '最长连败 25');
  eq(me.longestStreak, 0, '最长连胜 0');
  ok(typeof r.body.serverTime === 'number', '回包带 serverTime（前端可核时钟偏差）');

  console.log('\n[★ 单场最高] 全负的人也要给真实的最好成绩');
  eq(me.bestNet, -1, '★ 单场最高 = -1（不是 0，0 代表平局）');

  console.log('\n[流水] 自己看自己给 20 条，带人数与结束原因');
  ok(Array.isArray(me.recent), 'recent 是数组');
  eq(me.recent.length, 20, '★ 自己看自己 20 条（战绩页要 10 条趋势 + 一屏列表）');
  const top = me.recent[0];
  eq(top.roomId, '500024', '★ 最新一条在最前（第 25 局，roomId 500024）');
  eq(top.net, -25, '最新一条净胜 -25');
  eq(top.playerCount, 3, '★ 流水里带人数（战绩页要显示「3 人」）');
  eq(top.endReason, 'scoreZero', '★ 流水里带结束原因');

  console.log('\n[隐私] 别人的流水只给 5 条');
  const other = profiles.get(p2);
  eq(other.recent.length, 5, '★ 看别人的档案只给 5 条（不把整份流水抄出去）');
  eq(other.games, 8, '但聚合指标仍然完整');

  /* ---------------------------------------------------------------- */
  console.log('\n[清空] 只清自己，不动别人');
  r = await request('POST', '/api/me/reset-stats', H);
  eq(r.status, 200, 'POST → 200');
  eq(r.body && r.body.profile && r.body.profile.games, 0, '回包里的场次已归零');

  r = await request('GET', '/api/me/records', H);
  eq(r.body.profile.games, 0, '再查：场次 0');
  eq(r.body.profile.totalNet, 0, '净胜 0');
  eq(r.body.profile.longestLoseStreak, 0, '最长连败 0');
  eq(r.body.profile.bestNet, 0, '单场最高 0');
  eq(r.body.profile.recent.length, 0, '流水清空');

  /* ★ 这才是「删了战绩排行榜还在」的正解：删完榜单同步 */
  r = await request('GET', '/api/leaderboard');
  const ids = (r.body.list || []).map(x => x.playerId);
  ok(ids.indexOf(p1) === -1, '★ 清空后甲从排行榜消失');
  eq(ids.indexOf(p2) !== -1, true, '★ 乙还在榜上（只清自己）');
  eq(r.body.list.find(x => x.playerId === p2).games, 8, '★ 乙的战绩一点没动');

  console.log('\n[鉴权] 清空只接受 POST');
  r = await request('GET', '/api/me/reset-stats', H);
  eq(r.status, 405, 'GET → 405（防链接预取误触）');

  /* ---------------------------------------------------------------- */
  console.log('\n[落盘] 清零后重启不会把旧战绩带回来');
  const reopened = new ProfileStore({ file: PROFILE_FILE, seedFile: process.env.SEED_FILE });
  const after = reopened.data.get(p1);
  ok(!!after, '重启后档案还在');
  eq(after && after.games, 0, '★ 重启后场次仍是 0');
  eq(after && after.account && after.account.name, 'me_a', '★ 账号信息没丢');

  console.log('\n[老档案] 没有 longestLoseStreak 的存量数据要按当前连败补一个下限');
  const legacy = reopened.ensure('legacy_p', '老玩家');
  legacy.games = 3;
  legacy.currentStreak = -3;
  delete legacy.longestLoseStreak;
  reopened._ensureDerived(legacy);
  eq(legacy.longestLoseStreak, 3, '★ 正处在 3 连负 → 最长连败至少是 3（不会显示 0）');

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  if (fail) process.exitCode = 1;
  setTimeout(() => process.exit(fail ? 1 : 0), 200);
}

main().catch((e) => {
  console.error('[测试异常]', e);
  process.exit(1);
});
