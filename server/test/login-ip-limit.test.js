/**
 * 登录限流的第二层：纯 IP 总闸（P2-10）
 * 跑法：node server/test/login-ip-limit.test.js
 *
 * 只按「账号名 + IP」计数有两个洞：
 *   ① 换 IP → 同一账号的失败次数清零，按账号锁锁不住；
 *   ② 同一 IP 换账号名撞库 → 每个账号各自独立计数，总量不受限。
 * 所以加一层「这个 IP 总共失败了多少次」。测试里把阈值调到 8 便于触发。
 */
'use strict';

process.env.PROFILE_FILE = require('path').join(require('os').tmpdir(), 'lxw-ip-profiles-' + Date.now() + '.json');
process.env.SEED_FILE = require('path').join(require('os').tmpdir(), 'lxw-ip-seed-' + Date.now() + '.json');
process.env.PORT = process.env.PORT || '3207';
process.env.LOGIN_IP_MAX = process.env.LOGIN_IP_MAX || '8';
const PORT = Number(process.env.PORT);

const { server } = require('../index.js');
const { httpJson, registerPlayer } = require('./helpers/account');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

async function run() {
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });
  console.log('\n服务端就绪 127.0.0.1:' + PORT + '（LOGIN_IP_MAX=' + process.env.LOGIN_IP_MAX + '）');

  /* 造 6 个真实账号，用来模拟「同一 IP 换着账号名撞库」 */
  const accounts = [];
  for (let i = 0; i < 6; i++) accounts.push(await registerPlayer(PORT, '甲' + i));
  ok(accounts.length === 6, '6 个测试账号已注册');

  /* ================================================================= */
  console.log('\n[1] 同一 IP、不同账号名连续失败 → 总量触发 IP 闸');
  /* 每个账号只错一次，所以「账号名 + IP」那层永远不会到 6 次；
   * 旧实现下这里会一直返回 401，永远锁不住。 */
  let lastStatus = 0;
  let attempts = 0;
  for (let i = 0; i < 12; i++) {
    const acc = accounts[i % accounts.length];
    const r = await httpJson(PORT, 'POST', '/api/auth/login', { name: acc.name, password: 'wrong-' + i });
    attempts++;
    lastStatus = r.status;
    if (r.status === 429) break;
  }
  console.log('    尝试 ' + attempts + ' 次后状态码 ' + lastStatus);
  eq(lastStatus, 429, '★ 换着账号名试也会被 IP 总闸拦住（旧实现这里永远是 401）');
  ok(attempts <= 10, '触发得不算太晚（阈值 ' + process.env.LOGIN_IP_MAX + '）', '尝试 ' + attempts + ' 次');

  /* ================================================================= */
  console.log('\n[2] 被拦期间，密码正确的请求同样被挡（这是闸，不是「错密码才挡」）');
  const goodOne = accounts[0];
  const blocked = await httpJson(PORT, 'POST', '/api/auth/login', { name: goodOne.name, password: goodOne.password });
  eq(blocked.status, 429, 'IP 被限流时正确密码也进不来（防止用它探测「密码对不对」）');

  /* ================================================================= */
  console.log('\n[3] 闸门有期限，且文案给出还要等多久');
  ok(blocked.json && typeof blocked.json.error === 'string' && /分钟后再试/.test(blocked.json.error),
    '错误文案说明等待时长', blocked.json && blocked.json.error);

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  await new Promise((r) => setTimeout(r, 80));
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
