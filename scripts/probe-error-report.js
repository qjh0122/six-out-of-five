/**
 * 错误上报链路探针（R6 灰度准备）
 *
 * R6 的验收标准里有一条是「24 小时灰度，盯 errorReport 里的新错误类型」。
 * 这句话要能执行，前提是三件事都真的成立：
 *
 *   ① **每条日志都带版本号**。灰度 = 新旧版本同时在跑，日志里没有 `[20261031b]`
 *      就分不清「这个错是这次改出来的，还是上个版本就有的」—— 那「盯」等于瞎盯。
 *   ② **限流真的挡得住**。上报接口不需要登录（报错最可能发生在启动阶段），
 *      所以它天然是攻击面；挡不住的话，灰度期一次前端死循环就能把日志打满，
 *      真正的新错误被埋在噪声里。
 *   ③ **注入不进日志**。message 来自玩家浏览器，里面可以有换行和控制字符。
 *      不剥的话，一条 message 就能往日志里伪造几行假记录 —— 事后排查会被带偏。
 *
 * 这三件事都不是「代码看起来对」能证明的，必须真起服务、真发请求、真读 stdout。
 * 所以这个探针不用 mock，直接 spawn `server/index.js` 并抓它的输出。
 *
 * 用法：node scripts/probe-error-report.js
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const PORT = 3061;
const HOST = '127.0.0.1';
const SERVER_ROOT = path.join(__dirname, '..');
/* 版本号**从 index.html 读**，不在这里写死。
 * 写死的话，发版忘了改这一行，探针会拿着一个不存在的版本号去断言「日志里有它」，
 * 而它永远绿 —— 恰好掩盖了「版本号没同步」这个真问题。 */
const META_HTML = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'index.html'), 'utf8');
const VERSION = (META_HTML.match(/name="app-version"[^>]*content="([^"]+)"/) || [])[1] || '';

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function post(body, raw) {
  return new Promise((resolve) => {
    const payload = raw !== undefined ? raw : JSON.stringify(body);
    const req = http.request({
      host: HOST, port: PORT, path: '/api/client-error', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch (e) { /* 非 JSON 也算结果 */ }
        resolve({ status: res.statusCode, body: b, json: json });
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: String(e && e.message) }));
    req.end(payload);
  });
}

function get(pathname) {
  return new Promise((resolve) => {
    http.get({ host: HOST, port: PORT, path: pathname }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', (e) => resolve({ status: 0, error: String(e && e.message) }));
  });
}

async function main() {
  const profFile = path.join(os.tmpdir(), 'lxw-errprobe-' + Date.now() + '.json');
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: SERVER_ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), HOST: HOST, PROFILE_FILE: profFile
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let out = '';
  child.stdout.on('data', (d) => { out += String(d); });
  child.stderr.on('data', (d) => { out += String(d); });

  const waitFor = async (fn, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (fn()) return true;
      await sleep(100);
    }
    return false;
  };

  try {
    const up = await waitFor(() => /listening on/.test(out), 12000);
    console.log('===== 错误上报链路 =====');
    ok(up, '服务起来了（真起，不是 mock）', out.slice(0, 200));
    if (!up) throw new Error('服务没起来');

    /* ---------------- ① 一条普通的错误 ---------------- */
    console.log('\n[1] 一条普通错误：日志里必须能按版本过滤');
    const before = out.length;
    const r1 = await post({
      kind: 'error',
      message: 'TypeError: Cannot read properties of null',
      source: '/js/game.js', lineno: 1234, colno: 56,
      stack: 'TypeError: xxx\n  at render (game.js:1234:56)',
      version: VERSION, path: '/', ua: 'probe'
    });
    await sleep(400);
    const seg1 = out.slice(before);
    ok(r1.status === 200 && r1.json && r1.json.ok === true, '接口返回 200 ok', JSON.stringify(r1).slice(0, 160));
    ok(/\[client-error\]/.test(seg1), '日志里出现 [client-error] 标记');
    ok(seg1.indexOf('[' + VERSION + ']') >= 0,
      '★ 日志带版本号 [' + VERSION + '] —— 灰度期就靠它区分新旧版本', seg1.slice(0, 200));
    ok(/game\.js:1234/.test(seg1), '日志带来源与行号');
    ok(/at render/.test(seg1), 'stack 打出来了（排查要靠它）');

    /* ---------------- ② 老客户端不报 version ---------------- */
    console.log('\n[2] 老客户端（不带 version）不许报错');
    const before2 = out.length;
    const r2 = await post({ kind: 'error', message: 'legacy client error', path: '/' });
    await sleep(300);
    const seg2 = out.slice(before2);
    ok(r2.status === 200, '没有 version 也照收（老客户端不该被拒）', JSON.stringify(r2));
    ok(/\[client-error\]/.test(seg2) && /legacy client error/.test(seg2), '日志正常写入');

    /* ---------------- ③ 换行注入 ---------------- */
    console.log('\n[3] message 里的换行不许伪造日志行');
    const before3 = out.length;
    const fake = 'boom\n2026-01-01T00:00:00.000Z [client-error] error 伪造的一条';
    const r3 = await post({ kind: 'error', message: fake, version: VERSION, path: '/' });
    await sleep(300);
    const seg3 = out.slice(before3);
    ok(r3.status === 200, '含换行的 message 被正常受理');
    /* 判据必须是「行首是不是注入的那个假时间戳」。
     * 上一版写成「以时间戳开头且含伪造文字」—— 那条**真**日志也满足
     * （换行压平后原文就在真行里面），于是永远红。探针自己也会写错，
     * 所以这条注释留在这里：先证明断言对，再信它的红绿。 */
    const forged = seg3.split('\n').filter((l) => /^2026-01-01T/.test(l));
    ok(forged.length === 0, '★ 没有伪造出独立日志行（换行被压平）', JSON.stringify(forged));
    ok(seg3.split('\n').length <= 3, '这一次上报只产生 1~2 行日志（' + seg3.split('\n').length + ' 行）',
      '行数暴涨就是注入成功了');
    ok(/boom/.test(seg3) && /伪造的一条/.test(seg3), '原文仍在同一行里（不是被整条丢掉）');

    /* ---------------- ④ 超长字段 ---------------- */
    console.log('\n[4] 超长 message 会被截断');
    const before4 = out.length;
    const r4 = await post({ kind: 'error', message: 'X'.repeat(600), version: VERSION, path: '/' });
    await sleep(300);
    const seg4 = out.slice(before4);
    const line = seg4.split('\n').find((l) => /XXXX/.test(l)) || '';
    ok(r4.status === 200, '超长 message 照收');
    ok(line.length > 0 && line.length < 600, '★ 日志单行被截断（实测 ' + line.length + ' 字符）');
    ok(line.indexOf('…') >= 0, '截断处有省略号（能看出来被截了，不会误以为原文就这么短）');

    /* ---------------- ⑤ 方法与格式 ---------------- */
    /* ★ 必须放在限流之前跑。限流是按 IP 计数的，一旦打满，
     *   后面的 405/400 全都会先被 429 挡掉 —— 断言会红，但红的不是被测行为。
     *   这个顺序错误第一版就踩了，记在这里。 */
    console.log('\n[5] 错误用法不该 500');
    const g = await get('/api/client-error');
    ok(g.status === 405, 'GET 返回 405（只接受 POST）', String(g.status));
    const bad = await post(null, '{ this is not json');
    ok(bad.status === 400, '坏 JSON 返回 400（不是崩掉）', String(bad.status));

    /* ---------------- ⑥ 限流 ---------------- */
    console.log('\n[6] 限流：连发会被挡');
    let limited = 0, accepted = 0;
    for (let i = 0; i < 60; i++) {
      const r = await post({ kind: 'error', message: 'flood ' + i, version: VERSION, path: '/' });
      if (r.status === 429) limited++;
      else if (r.status === 200) accepted++;
    }
    ok(limited > 0, '★ 超量后被 429 挡住（' + accepted + ' 条通过 / ' + limited + ' 条被挡）',
      '挡不住的话，一次前端死循环就能把日志刷满');
    ok(accepted <= 45, '放行的条数在上限附近（' + accepted + ' ≤ 45）', '上限太大会失去意义');

    /* ---------------- ⑦ 上报没把服务搞挂 ---------------- */
    console.log('\n[7] 折腾一圈之后服务仍然健康');
    const h = await get('/api/health');
    ok(h.status === 200, '/api/health 仍然 200', String(h.status).slice(0, 80));
    let hj = null;
    try { hj = JSON.parse(h.body); } catch (e) { /* ignore */ }
    ok(hj && hj.ok === true, 'health 返回结构正常');
    /* health 里的 pwa 字段是「线上现在跑的是哪个前端版本」，灰度期第一眼看它 */
    ok(!!VERSION, 'index.html 里有 meta[name=app-version]（版本号的唯一出处）', VERSION);
    ok(hj && hj.pwa === VERSION,
      '★ health 的 pwa == meta 版本（' + (hj && hj.pwa) + '）—— 与日志里的版本号同源，灰度才能对账',
      JSON.stringify(hj).slice(0, 200));

    /* ---------------- 灰度期怎么盯：给出真能粘的命令 ---------------- */
    /* 这一段只打印、不计数。用 ok(true, ...) 把命令行当「通过的断言」
     * 会让开头的「通过 N 项」虚高 —— 那些是给人抄的说明，不是验证结果。 */
    console.log('\n[8] 灰度期可直接粘的命令（格式已被上面几条验证过）');
    console.log('    按版本过滤：  grep "[client-error].*\\[' + VERSION + '\\]" <日志文件>');
    console.log('    只看新错：    grep "\\[client-error\\]" <日志文件> | grep -v "\\[' + VERSION + '\\]"');
    console.log('    线上版本：    curl -s <域名>/api/health | grep pwa');
    console.log('    回滚演练：    node scripts/probe-rollback.js');
  } finally {
    try { child.kill(); } catch (e) { /* 已经退出 */ }
    try { fs.unlinkSync(profFile); } catch (e) { /* 可能没生成 */ }
  }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); });
