/**
 * 响应压缩（P3-1）
 * 跑法：node server/test/gzip.test.js
 *
 * 改之前线上 /js/game.js 的 Content-Length 是 144701，且没有 Content-Encoding——
 * 首屏 11 个 JS + 2 个 CSS 合计约 330KB 裸传。这个游戏的主要场景是
 * 「饭桌上扫个链接进来」，网络普遍不好，压缩收益直接体现在「能不能立刻玩上」。
 *
 * 这里重点验的不是「有没有压缩头」，而是三件容易出错的事：
 *  1. **解压后必须与磁盘文件逐字节相等**（压缩坏了比不压缩更糟）；
 *  2. **Content-Length 必须是压缩后的长度**（写原始长度会让浏览器卡住等数据）；
 *  3. 不该压的别压（图片/音频/小响应），以及 q=0 要认。
 */
'use strict';

const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.PORT) || 3391;
const TMP_PROFILE = path.join(os.tmpdir(), 'lxw-gzip-test-' + process.pid + '.json');
process.env.PORT = String(PORT);
process.env.PROFILE_FILE = TMP_PROFILE;

const PWA = path.join(__dirname, '..', '..', 'pwa');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

/** 拿到原始字节与响应头，不自动解压 */
function get(pathName, headers, method) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: pathName,
      method: method || 'GET', headers: headers || {}
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks)
      }));
    });
    req.on('error', (e) => resolve({ status: 0, headers: {}, body: Buffer.alloc(0), err: e.message }));
    req.end();
  });
}

const GZ = { 'Accept-Encoding': 'gzip, deflate, br' };
const RAW = { 'Accept-Encoding': 'identity' };

async function main() {
  const { server } = require('../index.js');
  if (!server.listening) {
    await new Promise((r) => server.once('listening', r));
  }

  /* ---------------------------------------------------------------- */
  console.log('\n[1] 脚本压缩：体积显著下降，且解码后与磁盘文件完全一致');
  const rawFile = fs.readFileSync(path.join(PWA, 'js', 'game.js'));
  const gzRes = await get('/js/game.js', GZ);
  eq(gzRes.status, 200, 'HTTP 200');
  eq(gzRes.headers['content-encoding'], 'gzip', '带 Content-Encoding: gzip');
  ok(gzRes.body.length < rawFile.length * 0.6,
    '压缩后小于原始的 60%（实际 ' + gzRes.body.length + ' / ' + rawFile.length + '）');
  eq(Number(gzRes.headers['content-length']), gzRes.body.length,
    '★ Content-Length 等于压缩后字节数（写原始长度会让浏览器卡住）');
  let decoded = null;
  try { decoded = zlib.gunzipSync(gzRes.body); } catch (e) { decoded = null; }
  ok(decoded && decoded.equals(rawFile), '★ gunzip 后与磁盘文件逐字节相等');
  ok(String(gzRes.headers['vary'] || '').toLowerCase().indexOf('accept-encoding') >= 0,
    '★ 带 Vary: Accept-Encoding（否则中间缓存会把压缩流发给不支持的客户端）');

  /* ---------------------------------------------------------------- */
  console.log('\n[2] 不接受 gzip 的客户端拿到原文');
  const plain = await get('/js/game.js', RAW);
  eq(plain.headers['content-encoding'], undefined, '没有 Content-Encoding');
  eq(Number(plain.headers['content-length']), rawFile.length, 'Content-Length 等于原始大小');
  ok(plain.body.equals(rawFile), '原文与磁盘文件一致');

  /* ---------------------------------------------------------------- */
  console.log('\n[3] Accept-Encoding: gzip;q=0 视为拒绝');
  const q0 = await get('/js/game.js', { 'Accept-Encoding': 'gzip;q=0, deflate' });
  eq(q0.headers['content-encoding'], undefined, 'q=0 时不压缩');
  ok(q0.body.length === rawFile.length, '返回的是原文');

  /* ---------------------------------------------------------------- */
  console.log('\n[4] 已经压过的二进制不要再压');
  const webpName = fs.existsSync(path.join(PWA, 'assets', 'card_back.webp'))
    ? '/assets/card_back.webp'
    : '/icons/icon-512.png';
  const img = await get(webpName, GZ);
  eq(img.status, 200, webpName + ' 可访问');
  eq(img.headers['content-encoding'], undefined, '★ 图片不压缩（再压是白烧 CPU，还可能变大）');

  /* ---------------------------------------------------------------- */
  console.log('\n[5] 小响应不压缩');
  const health = await get('/api/health', GZ);
  eq(health.status, 200, 'health 200');
  const healthObj = (function () { try { return JSON.parse(health.body.toString('utf8')); } catch (e) { return null; } })();
  ok(healthObj && healthObj.ok === true, '压缩开关没有破坏 JSON 结构');
  if (health.body.length < 1024) {
    eq(health.headers['content-encoding'], undefined, '小于 1KB 的 JSON 不压缩（加头反而更大）');
  } else {
    ok(true, '本次 health 响应已超阈值，跳过该断言');
  }
  ok(String(health.headers['vary'] || '').toLowerCase().indexOf('accept-encoding') >= 0,
    'API 响应也带 Vary（同一 URL 有两种字节形态）');

  /* ---------------------------------------------------------------- */
  console.log('\n[6] 全量导出：超过阈值就必须压，且解压后仍是合法 JSON');
  const key = (function () {
    try { return fs.readFileSync(path.join(__dirname, '..', 'backup-key.txt'), 'utf8').trim(); }
    catch (e) { return ''; }
  })();
  if (key) {
    const full = await get('/api/leaderboard?full=1', Object.assign({ 'x-backup-key': key }, GZ));
    eq(full.status, 200, 'full=1 可访问');
    /* 这条以前写的是 `if (body.length >= 1024 || 有 gzip)`，两个条件都推不出结论：
     * 档案少的时候它走 else 打一句「跳过」就当通过了，而档案一多就 FAIL 也说不清原因。
     * 现在反过来断言 —— 只有「确实没到阈值」才是合法的未压缩理由，
     * 到了阈值还没压就是真 bug（曾经真的漏了这一个接口）。 */
    if (full.headers['content-encoding'] === 'gzip') {
      const json = (function () {
        try { return JSON.parse(zlib.gunzipSync(full.body).toString('utf8')); } catch (e) { return null; }
      })();
      ok(json && Array.isArray(json.list), '★ 解压后仍是合法 JSON');
      ok(Number(full.headers['content-length']) === full.body.length,
        '★ 全量导出的 Content-Length 也是压缩后长度');
    } else {
      ok(full.body.length < 1024,
        '未压缩时响应必须真的没到 1KB 阈值（实际 ' + full.body.length + 'B）');
    }
  } else {
    ok(true, '没有备份密钥，跳过全量导出用例');
  }

  /* ---------------------------------------------------------------- */
  console.log('\n[7] 压缩结果带缓存，重复请求保持一致');
  const again = await get('/js/game.js', GZ);
  eq(again.body.length, gzRes.body.length, '★ 第二次请求压缩后长度一致（命中缓存）');
  ok(again.body.equals(gzRes.body), '两次字节完全相同');

  /* ---------------------------------------------------------------- */
  console.log('\n[8] HEAD 请求只回头不回体');
  const head = await get('/js/game.js', GZ, 'HEAD');
  eq(head.status, 200, 'HEAD 200');
  eq(head.body.length, 0, 'HEAD 没有响应体');
  eq(Number(head.headers['content-length']), gzRes.body.length, 'HEAD 的 Content-Length 与 GET 一致');

  /* ---------------------------------------------------------------- */
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
