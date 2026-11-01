/**
 * Service Worker 预缓存必须带 sharecode，且失败不能静默
 * 跑法：node pwa/test/sw-precache.test.js
 *
 * 背景（线上真实故障）：
 *   部署网关要求每一个请求都带 ?sharecode=xxx，不带一律 403。
 *   sw.js 的 PRECACHE 里全是裸路径（/js/game.js 之类），于是 install 时每一条都被 403；
 *   而当时的写法是 `cache.add(u).catch(function () { return null; })` —— 失败被完全吞掉。
 *   结果：SW 装得上、看上去一切正常，但离线缓存实际是空的，断网时什么都打不开，
 *   而且没有任何日志能看出来发生了什么。
 *
 * 这里锁三件事：
 *   1. 预缓存请求要拼上 SW 自己 URL 上的查询串（register 时由 index.html 带过来）
 *   2. 拼查询串要处理「原 URL 已有 ?」的情况（不能拼成 xxx?a=1?sharecode=2）
 *   3. 失败要留下清单，不能静默
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

/* ---------------------------- 抽出 withShare 做真实的行为断言 ---------------------------- */
/* 直接把源码里的 withShare 抠出来跑：比「assert 文件里有某个字符串」可信得多，
 * 尤其是「原 URL 已带 ?」这种真会出错的边界。 */
function extractFn(name) {
  const start = sw.indexOf('function ' + name + '(');
  if (start < 0) return null;
  let depth = 0, i = sw.indexOf('{', start);
  const bodyStart = i;
  for (; i < sw.length; i++) {
    if (sw[i] === '{') depth++;
    else if (sw[i] === '}') { depth--; if (depth === 0) break; }
  }
  return sw.slice(start, i + 1);
}

console.log('\n[1] withShare：查询串拼接');
{
  const src = extractFn('withShare');
  ok(!!src, 'sw.js 里存在 withShare()');
  ok(/PRECACHE\.map|withShare\(u\)/.test(sw), 'PRECACHE 是逐条经过 withShare 之后才 add 的');

  /* 用不同的 SHARE_QUERY 各造一个实例 */
  function makeWithShare(shareQuery) {
    // eslint-disable-next-line no-new-func
    return new Function('SHARE_QUERY', src + '; return withShare;')(shareQuery);
  }

  eq(makeWithShare('')(  '/js/game.js'), '/js/game.js', '没有 sharecode 时原样返回（本地开发不受影响）');
  eq(makeWithShare('?sharecode=AB12')('/js/game.js'), '/js/game.js?sharecode=AB12',
    '有 sharecode 时拼在裸路径后面');
  eq(makeWithShare('?sharecode=AB12')('/icons/icon-192.png'), '/icons/icon-192.png?sharecode=AB12',
    '图标同样要带（网关不区分静态/接口）');
  eq(makeWithShare('?sharecode=AB12')('/x.html?a=1'), '/x.html?a=1&sharecode=AB12',
    '★ 原 URL 已带查询串时用 & 而不是再添一个 ?');
  eq(makeWithShare('?sharecode=AB12')('/'), '/?sharecode=AB12', '根路径也能正确拼接');
}

console.log('\n[2] 失败不能静默');
{
  ok(!/cache\.add\(u\)\.catch\(function \(\) \{ return null; \}\)/.test(sw),
    '已经去掉「add 失败就 return null」的写法');
  ok(/__precacheReport/.test(sw), '把预缓存结果挂在 self.__precacheReport 上（可诊断）');
  ok(/console\.warn/.test(sw), '失败时打 console.warn（不再一声不响）');
  ok(/失败的?\s*' \+ failed\.length/.test(sw) || /failed\.length \+ '\/' \+ PRECACHE\.length/.test(sw),
    '警告里带失败条数（能一眼看出是「全挂」还是「个别资源」）');
  ok(/!SHARE_QUERY|未带 sharecode/.test(sw), '没带 sharecode 时警告会点明原因（否则只会看到一堆 403）');
  ok(/self\.skipWaiting\(\)/.test(sw), '仍然 skipWaiting —— 个别资源失败不能导致 SW 装不上');
}

console.log('\n[3] 离线兜底要忽略查询串');
{
  ok(/caches\.match\(req, \{ ignoreSearch: true \}\)/.test(sw),
    '导航离线兜底用 ignoreSearch（缓存键里带着 sharecode，换成别的查询串也要能命中）');
  ok(/caches\.match\('\/index\.html', \{ ignoreSearch: true \}\)/.test(sw),
    '/index.html 兜底同样忽略查询串');
  ok(/ignoreSearch: true/.test(sw.slice(sw.indexOf('isJsCss'))), 'js/css 分支本来就忽略查询串（未回退）');
}

console.log('\n[4] 注册时把查询串带给 SW');
{
  ok(/serviceWorker\.register\(swUrl\)/.test(html), 'index.html 用变量 swUrl 注册');
  ok(/swUrl\s*=\s*'\/sw\.js'\s*\+\s*\(location\.search/.test(html),
    "swUrl 拼上了 location.search —— 否则 /sw.js 本身在生产网关就会 403");
  ok(sw.indexOf('self.location.href') >= 0, 'SW 从自己的 URL 取查询串（与注册方式对应）');
}

/* PRECACHE 清单解析（[5]、[6] 两处都要用，抽出来只写一遍）。
 * 解析前先剥掉注释：清单里带注释是好事（每加一条说明为什么），但注释里只要出现
 * 一对单引号（比如写 `typeof X === 'undefined'` 这种代码片段），就会被下面抓条目的正则
 * 当成一条资源，于是「每条都是绝对路径」无故变红。这不是放松断言 —— 剥完注释之后，
 * 清单里的每一条仍然必须是绝对路径。真踩过：加 sessionLog.js 时写的注释里带了引号。 */
const PRECACHE_ENTRIES = (function () {
  const m = sw.match(/const PRECACHE = \[([\s\S]*?)\];/);
  if (!m) return null;
  const body = m[1]
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  return (body.match(/'[^']+'/g) || []).map((s) => s.slice(1, -1));
})();

console.log('\n[5] 预缓存清单本身');
{
  ok(PRECACHE_ENTRIES !== null, '能解析出 PRECACHE 清单');
  const entries = PRECACHE_ENTRIES || [];
  ok(entries.length >= 25, '清单里有 ' + entries.length + ' 条资源');
  ok(entries.every((u) => u.charAt(0) === '/'), '每条都是绝对路径（SW 作用域在根，相对路径容易踩坑）');
  ok(entries.indexOf('/js/slotLayout.js') >= 0, '新增的 js/slotLayout.js 已收录（否则离线时组槽尺寸算不出来）');
  ok(entries.indexOf('/js/sessionLog.js') >= 0, '★ 新增的 js/sessionLog.js 已收录（否则离线回放退化成单把）');
  ok(entries.indexOf('/index.html') >= 0, '收录了 index.html（导航离线兜底靠它）');
  ok(entries.every((u) => u.indexOf('?') < 0), '清单里不写死查询串（由 withShare 统一拼）');
}

console.log('\n[6] 清单与磁盘对账（防止加了文件忘了收录）');
{
  /* 清单是手写的，加 js/css 文件时必须想起来补一条。忘了的话**不会报任何错**：
   * 联网时 js/css 走 network-first 照样能取到，只有断网时才发现缺，
   * 表现是「某个功能离线悄悄没了」。v56 的 sessionLog.js 就是这么漏掉的
   * （离线时整场回放静默退化成「只能看单把」，而它正是那次的核心功能）。
   * 所以别再靠记性 —— 直接和目录树对账。
   * ai.js 排除：它只在 server/hub.js 里 require，前端根本不下载。 */
  const entries = PRECACHE_ENTRIES || [];
  const jsOnDisk = fs.readdirSync(path.join(ROOT, 'js')).filter((f) => f.slice(-3) === '.js');
  ok(jsOnDisk.length >= 10, 'js/ 目录可读（' + jsOnDisk.length + ' 个脚本）');

  const jsMissing = jsOnDisk.filter((f) => f !== 'ai.js' && entries.indexOf('/js/' + f) < 0);
  ok(jsMissing.length === 0, '★ 前端加载的每个 js 都在清单里', '缺: ' + jsMissing.join(', '));

  const ghostJs = entries.filter((u) => u.indexOf('/js/') === 0 && jsOnDisk.indexOf(u.slice(4)) < 0);
  ok(ghostJs.length === 0, '★ 反向：清单里没有已删/改名的手写路径', '多: ' + ghostJs.join(', '));

  const cssOnDisk = fs.readdirSync(path.join(ROOT, 'css')).filter((f) => f.slice(-4) === '.css');

  /* flex-gap-fallback.css 豁免，理由有三条，缺一条都不成立：
   *   1. 它**不是所有人都加载**的 —— 只有检测到「不支持 flex gap」的老内核
   *      才会被 index.html 里的脚本动态插入 link（见 probe-flex-gap.js 的 A 段）。
   *   2. 收录了也**命中不了**：PRECACHE 里存的键带 ?sharecode=，
   *      而动态加载的 URL 带 ?v=（跟随 app-version），js/css 又走 network-first
   *      且没带 ignoreSearch —— 两边永远不是同一个键。
   *   3. 收了就要让剩下 99% 的用户在 install 时白下一份用不到的样式。
   * 如果哪天它变成无条件加载，这条豁免就必须删掉。 */
  const CSS_OPTIONAL = ['flex-gap-fallback.css'];
  const cssMissing = cssOnDisk.filter(
    (f) => CSS_OPTIONAL.indexOf(f) < 0 && entries.indexOf('/css/' + f) < 0);
  ok(cssMissing.length === 0, '★ css 同样对账', '缺: ' + cssMissing.join(', '));

  /* 豁免项本身也要盯住：它必须真的存在于磁盘上（改名了要有人知道），
   * 而且必须真的不在清单里（否则说明有人「顺手补上了」，那条注释就过期了）。 */
  const optionalOnDisk = CSS_OPTIONAL.filter((f) => cssOnDisk.indexOf(f) >= 0);
  ok(optionalOnDisk.length === CSS_OPTIONAL.length,
    '免责的 css 都还在磁盘上', '缺: ' + CSS_OPTIONAL.filter((f) => cssOnDisk.indexOf(f) < 0).join(', '));
  const wronglyListed = CSS_OPTIONAL.filter((f) => entries.indexOf('/css/' + f) >= 0);
  ok(wronglyListed.length === 0, '免责的 css 没有又被加回清单（加回就说明按需加载被改掉了）',
    wronglyListed.join(', '));
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
