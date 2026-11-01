/**
 * 头像照片（P1b，默认关闭）：GET /api/avatar/<pid>?v= / POST /api/me/avatar/photo
 * 跑法：node server/test/avatar-photo.test.js
 *
 * 这一版界面上**没有**上传入口（CONFIG.AVATAR_UPLOAD = false），但服务端这套接口
 * 是完整的。之所以现在就把测试写足，是因为等开关真的打开时，这里任何一条错都不是
 * 「不好看」，而是「别人的照片能被随便拿走」或者「删了号照片还留在服务器上」。
 *
 * 锁死五件事：
 *   1. 版本号是唯一的访问凭据 —— 不带 v、带错的 v 一律 404，谁传过头像不可枚举
 *   2. 只认文件头，不信 Content-Type（`Content-Type: image/jpeg` + 一坨脚本也必须拒）
 *   3. 换了照片 = 版本号变 = URL 变（浏览器缓存不会把旧图钉死）
 *   4. 选了预设款就清掉照片（「最后一次动作生效」只有一条规则）
 *   5. ★ 删号连图一起删 —— 这是隐私承诺里最不能含糊的一条
 */
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');

const TMP = os.tmpdir();
const STAMP = Date.now();
process.env.PROFILE_FILE = path.join(TMP, 'lxw-avp-profiles-' + STAMP + '.json');
process.env.SEED_FILE = path.join(TMP, 'lxw-avp-seed-' + STAMP + '.json');
process.env.AVATAR_DIR = path.join(TMP, 'lxw-avp-avatars-' + STAMP);
process.env.PORT = process.env.PORT || '3221';
const PORT = Number(process.env.PORT);
const AVATAR_DIR = process.env.AVATAR_DIR;

const { server, profiles } = require('../index.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

/** 通用请求：body 是 Buffer 时按二进制发（头像上传走这条） */
function request(method, p, headers, body) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({}, headers || {});
    let payload = null;
    if (Buffer.isBuffer(body)) {
      payload = body;
      h['Content-Length'] = payload.length;
    } else if (body !== undefined) {
      payload = Buffer.isBuffer(body) ? body : JSON.stringify(body);
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let parsed = null;
        try { parsed = JSON.parse(buf.toString('utf8')); } catch (e) { /* 非 JSON（图片 / 404 文本） */ }
        resolve({ status: res.statusCode, body: parsed, buf: buf, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/* 一张「像 JPEG」的最小字节流：只要文件头对，存储层就认（它不做图像解码） */
function fakeJpeg(seed, size) {
  return Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(size || 96, seed || 7)]);
}

async function main() {
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.listen(PORT, '127.0.0.1', resolve);
  });

  console.log('\n[准备] 两个账号');
  const c1 = await profiles.createAccount('avp_a', 'avp_a123456', '甲');
  const c2 = await profiles.createAccount('avp_b', 'avp_b123456', '乙');
  ok(c1.ok && c2.ok, '两个账号都建好了');
  const p1 = c1.playerId, p2 = c2.playerId;

  const l1 = await request('POST', '/api/auth/login', null, { name: 'avp_a', password: 'avp_a123456' });
  const l2 = await request('POST', '/api/auth/login', null, { name: 'avp_b', password: 'avp_b123456' });
  eq(l1.status, 200, '甲登录成功');
  eq(l2.status, 200, '乙登录成功');
  const H1 = { 'x-session-token': l1.body.token };
  const H2 = { 'x-session-token': l2.body.token };

  /* ---------------------------------------------------------------- */
  console.log('\n[1] 上传：鉴权与内容校验');
  let r = await request('POST', '/api/me/avatar/photo', { 'Content-Type': 'image/jpeg' }, fakeJpeg(1));
  eq(r.status, 401, '没登录不能传（401）');

  r = await request('POST', '/api/me/avatar/photo', Object.assign({ 'Content-Type': 'image/jpeg' }, H1), Buffer.from('not an image at all'));
  eq(r.status, 400, '★ 内容不是 JPEG/PNG → 400（只信文件头，不信 Content-Type）');
  ok(/JPEG|PNG/.test((r.body && r.body.error) || ''), '错误里说清楚支持什么格式');

  r = await request('POST', '/api/me/avatar/photo', Object.assign({ 'Content-Type': 'image/jpeg' }, H1), Buffer.alloc(400 * 1024, 9));
  eq(r.status, 413, '★ 超过 300KB → 413（不做无限大的落盘）');

  r = await request('GET', '/api/me/avatar/photo', H1);
  eq(r.status, 405, '上传接口只接受 POST');

  /* ---------------------------------------------------------------- */
  console.log('\n[2] 上传成功与取回');
  const jpeg = fakeJpeg(3, 200);
  r = await request('POST', '/api/me/avatar/photo', Object.assign({ 'Content-Type': 'image/jpeg' }, H1), jpeg);
  eq(r.status, 200, '上传成功');
  const v1 = r.body && r.body.version;
  ok(!!v1 && /^[0-9a-z]+$/.test(v1), '回包里带版本号（' + v1 + '）');
  eq(profiles.get(p1).photo, v1, '★ 版本号写进了档案（重启后靠它继续拼 URL）');
  eq(profiles.getSelf(p1).photo, v1, '★ 对外档案里也有（前端档案卡要用）');

  r = await request('GET', '/api/avatar/' + p1 + '?v=' + v1);
  eq(r.status, 200, '★ 带对版本号能取回图');
  eq(r.headers['content-type'], 'image/jpeg', 'Content-Type 按文件头给（不是按客户端说的）');
  ok(r.buf.length === jpeg.length, '字节数一致（没有被转码走样）');
  ok(/immutable/.test(r.headers['cache-control'] || '') && /max-age=31536000/.test(r.headers['cache-control'] || ''),
    '★ 强缓存一年 + immutable（URL 里有版本号，换图就换 URL）');
  eq(r.headers['x-content-type-options'], 'nosniff', '带 nosniff（不让浏览器猜类型）');

  console.log('\n[3] 版本号就是访问凭据');
  r = await request('GET', '/api/avatar/' + p1);
  eq(r.status, 404, '★★ 不带 v → 404（「谁传过头像」不可枚举）');
  r = await request('GET', '/api/avatar/' + p1 + '?v=deadbeef');
  eq(r.status, 404, '★★ 带错的 v → 404');
  r = await request('GET', '/api/avatar/' + p2 + '?v=' + v1);
  eq(r.status, 404, '★ 拿甲的版本号去取乙的 → 404（版本号不是通行证）');
  r = await request('GET', '/api/avatar/not_exist?v=' + v1);
  eq(r.status, 404, '不存在的玩家 → 404');
  r = await request('PUT', '/api/avatar/' + p1 + '?v=' + v1, {}, Buffer.from('x'));
  eq(r.status, 405, '取图接口不接受 PUT');

  /* ---------------------------------------------------------------- */
  console.log('\n[4] 换一张 = 换版本号 = 换 URL');
  /* 同一毫秒内两次上传可能拿到同一个版本号（时间戳精度），所以稍等一下。
   * 这不是妥协，而是真实约束：客户端本来也不会一秒换两张头像。 */
  await new Promise((res) => setTimeout(res, 5));
  const jpeg2 = fakeJpeg(5, 300);
  r = await request('POST', '/api/me/avatar/photo', Object.assign({ 'Content-Type': 'image/jpeg' }, H1), jpeg2);
  eq(r.status, 200, '第二次上传成功');
  const v2 = r.body.version;
  ok(v2 !== v1, '★ 版本号变了（' + v1 + ' → ' + v2 + '）：缓存不会被旧图钉死');

  r = await request('GET', '/api/avatar/' + p1 + '?v=' + v2);
  ok(r.buf.length === jpeg2.length, '新 URL 拿到的是新图');
  r = await request('GET', '/api/avatar/' + p1 + '?v=' + v1);
  eq(r.status, 404, '★ 旧版本号立刻失效（旧链接不能继续取到新图）');

  /* ---------------------------------------------------------------- */
  console.log('\n[5] 选预设 = 清照片（最后一次动作生效）');
  r = await request('POST', '/api/me/avatar', Object.assign({ 'Content-Type': 'application/json' }, H1), { avatar: 'a12' });
  eq(r.status, 200, '选了预设 a12');
  eq(profiles.get(p1).avatar, 'a12', '预设记下了');
  eq(profiles.get(p1).photo, '', '★★ 照片被清掉（两套头像不会同时生效）');
  r = await request('GET', '/api/avatar/' + p1 + '?v=' + v2);
  eq(r.status, 404, '★ 照片链接也跟着失效');

  /* ---------------------------------------------------------------- */
  console.log('\n[6] 举报');
  r = await request('POST', '/api/me/avatar/report', Object.assign({ 'Content-Type': 'application/json' }, H2), { target: p1, reason: '头像不当' });
  eq(r.status, 200, '乙能举报甲的头像');
  r = await request('POST', '/api/me/avatar/report', Object.assign({ 'Content-Type': 'application/json' }, H2), { target: p2 });
  eq(r.status, 400, '★ 不能举报自己');
  r = await request('POST', '/api/me/avatar/report', Object.assign({ 'Content-Type': 'application/json' }, H2), { target: 'p_nobody' });
  eq(r.status, 404, '举报不存在的玩家 → 404');
  const logFile = path.join(AVATAR_DIR, 'reports.log');
  ok(fs.existsSync(logFile) && /target=/.test(fs.readFileSync(logFile, 'utf8')), '举报落到了 reports.log（留痕）');

  /* ---------------------------------------------------------------- */
  console.log('\n[7] ★ 删号连图一起删');
  await new Promise((res) => setTimeout(res, 5));
  r = await request('POST', '/api/me/avatar/photo', Object.assign({ 'Content-Type': 'image/jpeg' }, H2), fakeJpeg(8, 128));
  eq(r.status, 200, '乙传了一张照片');
  const vB = r.body.version;
  const fileB = fs.readdirSync(AVATAR_DIR).filter(f => f.indexOf('.img') > 0);
  ok(fileB.length >= 1, '磁盘上确实有图片文件（' + fileB.length + ' 个）');

  r = await request('POST', '/api/auth/delete', Object.assign({ 'Content-Type': 'application/json' }, H2), { password: 'avp_b123456' });
  eq(r.status, 200, '乙删号成功');
  const left = fs.readdirSync(AVATAR_DIR).filter(f => f.indexOf('.img') > 0);
  ok(left.length === 0 || !left.some(f => f.indexOf(p2) === 0),
    '★★ 照片文件随账号一起删掉了（隐私承诺：删号之后服务器上不留图）');
  r = await request('GET', '/api/avatar/' + p2 + '?v=' + vB);
  eq(r.status, 404, '★ 删号后原链接也取不到了');

  /* ---------------------------------------------------------------- */
  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('========================================');

  try { fs.rmSync(AVATAR_DIR, { recursive: true, force: true }); } catch (e) { /* 临时目录 */ }
  try { fs.unlinkSync(process.env.PROFILE_FILE); } catch (e) { /* 临时文件 */ }
  try { fs.unlinkSync(process.env.SEED_FILE); } catch (e) { /* 临时文件 */ }
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); try { server.close(); } catch (x) {} process.exit(1); });
