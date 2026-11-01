/**
 * 前端错误上报接口（P3-5）
 * 跑法：node server/test/client-error.test.js
 *
 * 这个接口和别的接口不一样：它**不需要登录**。因为最需要看见的报错
 * 恰恰发生在登录之前（启动阶段、SW 缓存了坏掉的旧脚本）。
 * 代价是它必须自己扛住滥用，所以这里的重点是边界而不是"能收能存"：
 *
 *  - 只收 POST、只收 JSON；
 *  - 按 IP 限流 40 条/分钟，超了 429（否则"上报"自己就是攻击面）；
 *  - 超长 message / stack / 带换行的伪造日志都不能把服务端怎么样。
 */
'use strict';

const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.PORT) || 3393;
const TMP_PROFILE = path.join(os.tmpdir(), 'lxw-clienterr-test-' + process.pid + '.json');
process.env.PORT = String(PORT);
process.env.PROFILE_FILE = TMP_PROFILE;

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

function post(body, ct) {
  return new Promise((resolve) => {
    const data = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/api/client-error', method: 'POST',
      headers: { 'Content-Type': ct || 'application/json', 'Content-Length': data.length }
    }, (res) => {
      let buf = '';
      res.on('data', (d) => buf += d);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, json: json });
      });
    });
    req.on('error', (e) => resolve({ status: 0, json: null, err: e.message }));
    req.write(data);
    req.end();
  });
}

async function main() {
  const { server } = require('../index.js');
  if (!server.listening) await new Promise((r) => server.once('listening', r));

  /* ---------------------------------------------------------------- */
  console.log('\n[1] 正常上报（不需要登录）');
  const r1 = await post({
    kind: 'error',
    message: 'TypeError: x is not a function',
    source: 'game.js', lineno: 120, colno: 8,
    stack: 'at foo (game.js:120:8)\n    at bar (game.js:200:3)',
    version: '20261029e', path: '/', ua: 'Mozilla/5.0'
  });
  eq(r1.status, 200, '200');
  eq(r1.json && r1.json.ok, true, 'ok:true');

  /* ---------------------------------------------------------------- */
  console.log('\n[2] 方法与时序约束');
  {
    const g = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: PORT, path: '/api/client-error' }, (res) => {
        let b = ''; res.on('data', (d) => b += d); res.on('end', () => resolve(res.statusCode));
      }).on('error', () => resolve(0));
    });
    eq(g, 405, 'GET → 405');

    const bad = await post({ message: 'x' }, 'text/plain');
    eq(bad.status, 415, '非 JSON 的 Content-Type → 415');

    const broken = await post('{not json');
    eq(broken.status, 400, 'JSON 解析失败 → 400');
  }

  /* ---------------------------------------------------------------- */
  console.log('\n[3] 畸形输入不能把服务端怎么样');
  {
    const r = await post({ message: null });
    ok(r.status === 200 || r.status === 400, 'message 为 null 时不崩（' + r.status + '）');

    /* 请求体上限是 16KB（BODY_MAX）。超限时必须回一个**可读的状态码**：
     * 以前服务端直接 destroy，客户端只看到 ECONNRESET，上游重试会拿同一个大包反复重发。 */
    const huge = await post({
      message: 'A'.repeat(50000),
      stack: 'B'.repeat(200000),
      source: 'C'.repeat(20000)
    });
    eq(huge.status, 400, '★ 超限（250KB）返回 400 而不是断连（断连时客户端拿不到状态码）');

    /* 16KB 以内、但字段本身超长的，要正常收下并由服务端截断 */
    const longField = await post({
      message: 'A'.repeat(2000),
      stack: 'B'.repeat(6000),
      source: 'C'.repeat(2000)
    });
    eq(longField.status, 200, '10KB 以内正常收下');

    /* 换行注入：message 里塞伪造的日志行。服务端要剥控制字符，
     * 否则攻击者能往日志里写任意内容。这里只验它不崩 + 正常 200。 */
    const inject = await post({
      message: 'oops\n2026-01-01 INFO [admin] 用户已被提升为管理员\n',
      stack: 'x\r\ny\rz'
    });
    eq(inject.status, 200, '带换行/回车的 message 不报错');
  }

  /* ---------------------------------------------------------------- */
  console.log('\n[4] ★ 限流：同 IP 40 条/分钟');
  {
    /* 上面已经发了几条，这里继续发到超额 */
    let firstBlocked = 0;
    for (let i = 0; i < 50; i++) {
      const r = await post({ message: 'flood-' + i });
      if (r.status === 429) { firstBlocked = i + 1; break; }
    }
    ok(firstBlocked > 0, '★ 连续轰炸最终被限流（第 ' + firstBlocked + ' 次触发 429）');
    ok(firstBlocked <= 45, '限流阈值没有形同虚设（触发点 ' + firstBlocked + '）');

    const after = await post({ message: 'after-block' });
    eq(after.status, 429, '被限后仍然 429');
  }

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  try { fs.unlinkSync(TMP_PROFILE); } catch (e) {}
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('测试异常：', e && e.stack || e);
  try { fs.unlinkSync(TMP_PROFILE); } catch (err) {}
  process.exit(1);
});
