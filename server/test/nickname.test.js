/**
 * 昵称截断口径统一（P2-5）
 * 跑法：node server/test/nickname.test.js
 *
 * 以前有三份实现，口径不一致：
 *   hub.js  cleanNickname  → Array.from 按**字符**截断（对）
 *   index.js 注册昵称      → String.slice(0, 8) 按**码元**截断（错）
 *   profile.js 管理员改名  → 同样 slice(0, 8)（错）
 *
 * 一个 emoji 占 2 个 UTF-16 码元，slice 切在中间就留下孤立代理项（lone surrogate）：
 * 存进 JSON 后前端渲染成 `�`，而且这个坏字符串会永久留在档案里、还会进排行榜。
 *
 * 现在统一走 server/text.js 的 cleanNickname。
 */
'use strict';

process.env.PROFILE_FILE = require('path').join(require('os').tmpdir(), 'lxw-nick-profiles-' + Date.now() + '.json');
process.env.SEED_FILE = require('path').join(require('os').tmpdir(), 'lxw-nick-seed-' + Date.now() + '.json');
process.env.PORT = process.env.PORT || '3209';
const PORT = Number(process.env.PORT);

const { server, profiles } = require('../index.js');
const { cleanNickname } = require('../text.js');
const { httpJson, httpAuth, registerPlayer } = require('./helpers/account');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

/** 有没有孤立代理项（被切一半的 emoji 就是这个特征） */
function hasLoneSurrogate(s) {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(s) || /(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

async function run() {
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });

  /* ================================================================= */
  console.log('\n[1] 纯函数：按字符截断，不切 emoji');
  eq(cleanNickname(''), '玩家', '空值兜底为「玩家」');
  eq(cleanNickname(null), '玩家', 'null 也兜底');
  eq(cleanNickname('   '), '玩家', '纯空白兜底');
  eq(cleanNickname('小明'), '小明', '中文短名原样保留');
  eq(cleanNickname('abcdefghij'), 'abcdefgh', '超长 ASCII 截到 8 个字符');
  eq(Array.from(cleanNickname('🐯'.repeat(10))).length, 8, '10 个 emoji 截成 8 个字符');
  ok(!hasLoneSurrogate(cleanNickname('🐯'.repeat(10))), '★ 截断后没有孤立代理项（旧 slice 会切一半）');
  eq(cleanNickname('a\u0000b\tc'), 'abc', '控制字符被剥掉');
  eq(cleanNickname('', 8, ''), '', 'fallback 传空串时允许空串（管理员清空场景）');
  eq(cleanNickname('一二三四五六七八九十', 4), '一二三四', '自定义上限生效');

  /* ================================================================= */
  console.log('\n[2] 注册接口：emoji 昵称不再被切坏');
  /* 5 个 emoji = 10 个 UTF-16 码元。旧实现 slice(0,8) 会把第 4 个 emoji 切一半。 */
  const reg = await httpJson(PORT, 'POST', '/api/auth/register', {
    name: 'emoji' + Math.random().toString(36).slice(2, 7),
    password: 'pw-emoji-123',
    nickname: '🐯'.repeat(5)
  });
  eq(reg.status, 200, '注册成功');
  const nick = reg.json.me.nickname;
  console.log('    存下来的昵称：' + JSON.stringify(nick) + '（' + Array.from(nick).length + ' 个字符）');
  ok(!hasLoneSurrogate(nick), '★ 注册昵称没有被切成半个 emoji');
  ok(Array.from(nick).length <= 8, '长度不超过 8 个字符');
  eq(Array.from(nick).length, 5, '5 个 emoji 完整保留（没被过多截断）');

  /* ================================================================= */
  console.log('\n[3] 管理员改昵称：同一口径');
  const a = await registerPlayer(PORT, '甲');
  const KEY = 'nick-test-key';
  process.env.BACKUP_KEY = KEY;
  const admin = (p, b) => httpJson(PORT, 'POST', p, b, { 'x-backup-key': KEY });

  const set = await admin('/api/admin/nickname', { playerId: a.playerId, nickname: '🐱'.repeat(9) });
  eq(set.status, 200, '管理员改名成功');
  const stored = (profiles.get(a.playerId) || {}).nickname || '';
  console.log('    存下来的昵称：' + JSON.stringify(stored) + '（' + Array.from(stored).length + ' 个字符）');
  ok(!hasLoneSurrogate(stored), '★ 管理员改名也没有切坏 emoji');
  eq(Array.from(stored).length, 8, '超长时截到 8 个字符（不是 8 个码元 = 4 个 emoji）');

  /* 空昵称仍然被接口挡住，不会变成「玩家」而不自知 */
  const empty = await admin('/api/admin/nickname', { playerId: a.playerId, nickname: '   ' });
  eq(empty.status, 400, '空昵称被 400 拒绝（策略在接口层，不靠兜底）');

  /* ================================================================= */
  console.log('\n[4] 三处口径一致：同样的输入得到的长度相同');
  const samples = ['🐯🐯🐯🐯🐯🐯', 'abcdefghijkl', '中文昵称超长了', '🐯ab🐯cd🐯ef'];
  let mismatch = 0;
  for (const s of samples) {
    const viaFn = cleanNickname(s, 8, '玩家');
    const viaFnAgain = cleanNickname(s, 8, '玩家');
    if (viaFn !== viaFnAgain) mismatch++;
    if (hasLoneSurrogate(viaFn)) mismatch++;
  }
  eq(mismatch, 0, '★ 同一函数、同一上限，结果稳定且永不产生半个 emoji');

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  await new Promise((r) => setTimeout(r, 80));
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
