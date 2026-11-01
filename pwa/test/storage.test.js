/**
 * 存储收口的守卫（node pwa/test/storage.test.js）
 *
 * 这件事的验收判据只有一条硬的：**`pwa/js` 里不许再出现直接读写 localStorage 的代码**。
 * 但「把 35 处换成一个函数」这种重构，坏起来全都不报错：
 *
 *   1. 键名写错一个字符 → 读到的永远是空，表现为「设置没用」，但不抛异常；
 *   2. 迁移把 local 的键搬到 session（或反过来）→ 换标签页数据就没了；
 *   3. write 在配额满时抛出去 → 一个辅助信息的写失败把建房流程一起带走；
 *   4. 迁移把旧键删了却没写进新键 → 老用户的数据凭空消失，而且只发生一次，最难复现。
 *
 * 所以这里不只测「函数能跑」，还测「不改写调用点就不会复发」：
 * 用真实文件系统扫 pwa/js，把第 1 条变成一条会红的断言。
 */
'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

/* 绝不 require 全局那份：那会把 Node 进程里不存在的 localStorage 一起带进来。
 * 这里每一个实例都塞自己的内存桩 —— 跑的是**同一份实现**，只是换了 backing。 */
const Store = require('../js/storage.js');

/** 最小的 localStorage 桩：够用，且能模拟「配额满」与「隐私模式直接抛」 */
function memBacking(opts) {
  const o = opts || {};
  const map = new Map(o.seed || []);
  return {
    _map: map,
    get length() { return map.size; },
    key(i) { return Array.from(map.keys())[i] || null; },
    getItem(k) {
      if (o.throwOnRead) throw new Error('SecurityError');
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (o.throwOnWrite) throw new Error('QuotaExceededError');
      map.set(k, String(v));
    },
    removeItem(k) {
      if (o.throwOnRemove) throw new Error('SecurityError');
      map.delete(k);
    }
  };
}

const ROOT = path.join(__dirname, '..');

console.log('\n[1] 键清单本身');
const KEYS = Store.KEYS;
const names = Object.keys(KEYS);
ok(names.length >= 15, '键清单覆盖当前全部物理键（' + names.length + ' 个）');
ok(names.every((n) => /^lxw_/.test(KEYS[n])), '所有键都以 lxw_ 前缀（清缓存时按前缀清，不会误伤同域别的应用）');
ok((() => {
  const vals = names.map((n) => KEYS[n]);
  return new Set(vals).size === vals.length;
})(), '★ 没有两个名字指向同一个物理键（同一个键两个名字 = 迟早有一边忘了改）');
ok(names.every((n) => /_v[0-9]+$/.test(KEYS[n])), '所有键都带 _v<N> 结构版本号');

console.log('\n[2] read / write / remove / list 契约');
{
  const back = memBacking();
  const s = Store.create(back, memBacking());
  ok(s.read('lxw_x_v1', 'fallback') === 'fallback', '读不到时返回默认值，不是 undefined');
  ok(s.write('lxw_x_v1', 'v1') === true, '写成功返回 true');
  ok(s.read('lxw_x_v1') === 'v1', '读回刚写的值');
  ok(s.writeJson('lxw_j_v1', { a: 1 }) === true, 'writeJson 能写对象');
  ok(s.readJson('lxw_j_v1', null).a === 1, 'readJson 能读回对象');
  ok(s.readJson('lxw_j_v1_bad', { safe: 1 }).safe === 1, '键不存在时 readJson 返回默认值');
  back.setItem('lxw_bad_v1', '{not json');
  ok(s.readJson('lxw_bad_v1', { safe: 2 }).safe === 2, '坏 JSON 当没有（留着坏数据只会每读必错）');
  ok(s.read('lxw_x_v1', null, 'session') === null, '★ local 写的键在 session 里读不到（kind 不许串）');
  s.write('lxw_s_v1', 'sv', 'session');
  ok(s.read('lxw_s_v1', null, 'session') === 'sv', 'session 独立可读写');
  ok(s.read('lxw_s_v1') === null, '★ session 写的键在 local 里也读不到');
  ok(s.remove('lxw_x_v1') === true && s.read('lxw_x_v1') === null, 'remove 之后读不到');
  ok(s.remove('lxw_never_v1') === true, '删不存在的键也返回 true（幂等）');
  const list = s.list();
  ok(list.some((e) => e.key === 'lxw_j_v1') && typeof list[0].size === 'number', 'list 能列出键与体积');
  ok(list.length && list[0].size >= list[list.length - 1].size, 'list 按体积倒序（排障先看谁最大）');
}

console.log('\n[3] 永不抛（隐私模式 / 配额满 / 存储被禁用）');
{
  const throwing = Store.create(memBacking({ throwOnWrite: true }), memBacking({ throwOnWrite: true }));
  let threw = false;
  let r;
  try { r = throwing.write('lxw_x_v1', '1'); } catch (e) { threw = true; }
  ok(!threw, '★ 写失败不抛异常（抛出去会把建房/结算主流程一起带走）');
  ok(r === false, '写失败返回 false');
  ok(throwing.available() === false, '写不进去时 available() 为 false');

  const noRead = Store.create(memBacking({ throwOnRead: true }), null);
  ok(noRead.read('lxw_x_v1', 'dflt') === 'dflt', '读抛异常时返回默认值');
  ok(noRead.available() === true, 'available 只探写，不因读抛而误判禁用');

  const none = Store.create(null, null);
  ok(none.read('lxw_x_v1', 'd') === 'd' && none.write('lxw_x_v1', '1') === false, '完全没有 storage 时退化不炸');
  ok(none.list().length === 0, '没有 storage 时 list 返回空数组');
}

console.log('\n[4] 迁移：旧键搬新键，且不丢数据');
{
  const local = memBacking({ seed: [['weile_rooms', '{"r1":{}}'], ['weile_touch', '{"roomId":"r1"}'], ['lxw_bgm_v1', '0']] });
  const session = memBacking({ seed: [['weile_myid', 'p123'], ['weile_nickname', '阿叁'], ['weile_version_reloaded', '20261001a']] });
  const s = Store.create(local, session);
  const res = s.migrate();
  ok(local.getItem(KEYS.ROOMS) === '{"r1":{}}', 'local 的 weile_rooms → lxw_rooms_v1（值原样）');
  ok(session.getItem(KEYS.MY_ID) === 'p123', '★ session 的 weile_myid 仍落在 session（搬错 storage = 换标签页身份就变）');
  ok(session.getItem(KEYS.NICK_SESSION) === '阿叁' && local.getItem(KEYS.NICK_SESSION) === null, 'session 的昵称没有被搬进 local');
  ok(session.getItem(KEYS.VERSION_RELOADED) === '20261001a', 'session 的版本重载标记搬对了');
  ok(local.getItem(KEYS.SOUND) === '0', '★ 老 BGM 开关「关」→ 声音总开关也是「关」（不然升级后突然开始响）');
  ok(local.getItem(KEYS.BGM_LEGACY) === null, '旧键删掉了（两套键并存才是真正的债）');
  ok(res.moved.length >= 5, 'moved 清单能报出搬了哪些（' + res.moved.length + ' 个）');

  const again = s.migrate();
  ok(again.moved.length === 0 && again.kept.length === 0, '★ 迁移幂等：第二次跑什么都不做');
  ok(session.getItem(KEYS.NICK_SESSION) === '阿叁', '幂等跑之后数据还在');
}
{
  const local = memBacking({ seed: [['weile_rooms', 'old'], ['lxw_rooms_v1', 'new']] });
  const s = Store.create(local, memBacking());
  s.migrate();
  ok(local.getItem('lxw_rooms_v1') === 'new', '★ 新键已有值时不被旧键覆盖（新版写的那份更新）');
  ok(local.getItem('weile_rooms') === null, '旧键照样删掉（否则下一个读的人又要猜哪个准）');
}
{
  const local = memBacking({ seed: [['weile_rooms', 'v']], throwOnWrite: true });
  const s = Store.create(local, memBacking());
  const res = s.migrate();
  ok(res.kept.indexOf('weile_rooms') >= 0, '★ 写不进时保留旧键并报 kept（下次启动再试，而不是直接丢）');
  ok(local.getItem('weile_rooms') === 'v', '写不进时旧数据还在');
}

console.log('\n[5] 调用点收口（这条才是真正的验收判据）');
{
  const files = fs.readdirSync(path.join(ROOT, 'js')).filter((f) => f.endsWith('.js'));
  const bad = [];
  files.forEach((f) => {
    if (f === 'storage.js') return;
    const src = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
    const hits = src.split('\n').filter((line) => /(local|session)Storage\s*\.\s*(get|set|remove)Item/.test(line));
    if (hits.length) bad.push(f + '(' + hits.length + ')');
  });
  ok(bad.length === 0, '★ pwa/js 下除 storage.js 外没有直接读写 localStorage/sessionStorage', bad.join(' '));
}

console.log('\n[6] 接线（漏了就整页退化，而且只有真实安装用户会遇到）');
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const iStore = html.indexOf('js/storage.js');
  const iBoot = html.indexOf("var KEY = Store.KEYS.SHARE_CODE");
  ok(iStore >= 0, 'index.html 引了 js/storage.js');
  ok(iStore >= 0 && iBoot > iStore, '★ storage.js 在「分享码自愈」之前加载（晚一步那段就拿不到 Store）');
  ok(!/src="\.\/js\/storage\.js"[^>]*\bdefer\b/.test(html), 'storage.js 不能 defer（内联脚本比 defer 早）');
  ok(sw.indexOf("'/js/storage.js'") >= 0, 'sw.js 的 PRECACHE 里有 storage.js（离线也要能起）');
}

console.log('\n----------------------------------------');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) process.exit(1);
