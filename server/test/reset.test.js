/**
 * 运维清空接口测试：POST /api/admin/reset
 * 跑法：node server/test/reset.test.js
 *
 * 背景：线上人机测试留下的榜单需要能一键抹掉。
 * 线上主数据文件在项目目录之外（~/.lxw-appdata/profiles.json），
 * 改种子文件清不掉它——主文件「存在即权威」，所以必须有个运行时清空入口。
 *
 * 这里锁死四件事：
 *   1. 没有密钥不许清（否则任何人都能把榜单删了）
 *   2. 密钥错误不许清
 *   3. 只接受 POST（GET 会被链接预取/爬虫误触）
 *   4. 清空之后内存和文件都必须是空的——重启不能把数据带回来
 */
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');

const TMP = os.tmpdir();
const PROFILE_FILE = path.join(TMP, 'lxw-reset-profiles-' + Date.now() + '.json');
process.env.PROFILE_FILE = PROFILE_FILE;
process.env.SEED_FILE = path.join(TMP, 'lxw-reset-seed-' + Date.now() + '.json');
process.env.BACKUP_KEY = 'reset-test-key-abcdef123456';
process.env.PORT = process.env.PORT || '3199';
const PORT = Number(process.env.PORT);

const { server, hub, profiles } = require('../index.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + b + ', got ' + a); }

/** 发一个请求，返回 { status, body } */
function request(method, p, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: p, method: method, headers: headers || {}
    }, (res) => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(b); } catch (e) { /* 非 JSON 原样返回 */ }
        resolve({ status: res.statusCode, body: parsed, raw: b });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** 造几份有战绩的档案（等价于人机测试跑出来的样子） */
function seedProfiles() {
  profiles.record('bot-1', '机器人A', 26, Date.now(), '111111', 1);
  profiles.record('bot-2', '机器人B', -9, Date.now(), '111111', 2);
  profiles.record('bot-3', '机器人C', 12, Date.now(), '222222', 1);
  profiles.flush();
}

function main() {
  server.listen(PORT, '127.0.0.1', async () => {
    try {
      console.log('\n[准备] 造 3 份有战绩的档案');
      seedProfiles();
      let r = await request('GET', '/api/leaderboard');
      eq(r.body.list.length, 3, '榜单上有 3 份档案');
      ok(r.body.list.every(x => x.games > 0), '三份都带战绩（不是空壳档案）');

      console.log('\n[鉴权] 没有密钥不许清');
      r = await request('POST', '/api/admin/reset');
      eq(r.status, 403, '不带 x-backup-key → 403');
      ok(/x-backup-key/.test(r.body.error || ''), '错误信息点明缺密钥', r.body.error);
      r = await request('GET', '/api/leaderboard');
      eq(r.body.list.length, 3, '被拒绝后数据原封不动');

      console.log('\n[鉴权] 密钥错误不许清');
      r = await request('POST', '/api/admin/reset', { 'x-backup-key': 'wrong-key-wrong-key' });
      eq(r.status, 403, '错误密钥 → 403');
      r = await request('GET', '/api/leaderboard');
      eq(r.body.list.length, 3, '错误密钥也没有删掉任何东西');

      console.log('\n[方法] 只接受 POST');
      r = await request('GET', '/api/admin/reset', { 'x-backup-key': process.env.BACKUP_KEY });
      eq(r.status, 405, 'GET（哪怕带对密钥）→ 405，防被链接预取误触');
      r = await request('GET', '/api/leaderboard');
      eq(r.body.list.length, 3, 'GET 没有清掉数据');

      console.log('\n[清空] 正确密钥 → 清掉全部');
      r = await request('POST', '/api/admin/reset', { 'x-backup-key': process.env.BACKUP_KEY });
      eq(r.status, 200, '正确密钥 → 200');
      eq(r.body.cleared, 3, '回报清掉了 3 份档案', 'got=' + r.body.cleared);

      r = await request('GET', '/api/leaderboard');
      eq(r.body.list.length, 0, '榜单已空');
      eq(profiles.dump().length, 0, '内存里也空了（dump 为空）');

      console.log('\n[落盘] 清空必须立刻写进文件，重启不能把数据带回来');
      const disk = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
      eq(Object.keys(disk).length, 0, '主数据文件已写成 {}（不是等 500ms 延迟刷盘）');

      console.log('\n[单例] 清空后仍可正常记新场次');
      profiles.record('human-1', '真人1', 8, Date.now(), '333333', 1);
      profiles.flush();
      r = await request('GET', '/api/leaderboard');
      eq(r.body.list.length, 1, '清空之后新打的成绩照常入榜');
      eq(r.body.list[0].nickname, '真人1', '入榜的是新玩家');
    } catch (e) {
      fail++;
      console.log('  FAIL 异常: ' + (e && e.stack || e));
    } finally {
      console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
      try { hub.closeAll && hub.closeAll(); } catch (e) { /* 忽略 */ }
      try { profiles.flush(); } catch (e) { /* 忽略 */ }
      try { fs.unlinkSync(PROFILE_FILE); } catch (e) { /* 忽略 */ }
      process.exit(fail ? 1 : 0);
    }
  });
}

main();
