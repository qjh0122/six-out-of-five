/**
 * 成就页的**接线**检查（node pwa/test/achievements-wiring.test.js）
 *
 * 判据层的测试全绿，页面照样可能是坏的 —— 因为「模块写对了」和「模块被挂上去了」
 * 是两件事。这个文件专门盯后面那件，而且只盯那些**不会报错**的断法：
 *
 *   1. 预缓存清单与 index.html 的脚本集合必须一一对应。
 *      少一个 → 离线打开时那个模块 404，game.js 开头是同步 IIFE，
 *      取不到 `window.LXW.xxx` 就是整页白屏（v108 拆模块时踩过一次）。
 *
 *   2. achievements.js 必须排在 stateMachine.js **之前**。
 *      反了的话状态机拿到的是 undefined，代码里有判空兜底，
 *      于是不报错、不崩溃、成就永远 0 —— 这是最难发现的一类失败。
 *
 *   3. 所有资源的 `?v=` 必须与 `<meta name="app-version">` 是同一个值。
 *      这个仓库改版本号要改 30 多处，漏一处就是「老内核拿旧缓存」，
 *      而症状是「我这儿明明是新的、他说还是老样子」。
 *
 *   4. 新增的屏幕必须登记进 showScreen 的 screens 数组。
 *      漏了的话 showScreen 只会隐藏别的页，目标页自己还带着 hidden ——
 *      表现是整屏空白（排行榜当年就这么白屏过）。
 *
 * 这些全是源码文本断言，跑起来 1 毫秒，但挡的是「上线才发现」的那一类问题。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const html = read('pwa/index.html');
const sw = read('pwa/sw.js');
const game = read('pwa/js/game.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) pass += 1;
  else { fail += 1; console.error('✗ ' + name + (extra ? ' — ' + extra : '')); }
}
function eq(a, b, name) {
  ok(a === b, name, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b));
}

/* ================================================================
 * 一、脚本集合 = 预缓存集合
 * ================================================================ */
function scriptsInHtml() {
  const out = [];
  const re = /<script src="\.\/js\/([\w.\-]+)\?/g;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}
function precachedJs() {
  const out = [];
  const re = /'\/js\/([\w.\-]+)'/g;
  let m;
  while ((m = re.exec(sw))) out.push(m[1]);
  return out;
}

const hs = scriptsInHtml();
const pc = precachedJs();

ok(hs.indexOf('achievements.js') >= 0, 'index.html 引了 achievements.js');
ok(hs.indexOf('achievementsView.js') >= 0, 'index.html 引了 achievementsView.js');
ok(pc.indexOf('achievements.js') >= 0, '★ sw.js 预缓存了 achievements.js（漏了它离线打牌不记成就）');
ok(pc.indexOf('achievementsView.js') >= 0, '★ sw.js 预缓存了 achievementsView.js（漏了它离线点成就是白屏）');

/* 双向差集：任何一边多出来都算不一致 */
const onlyHtml = hs.filter((f) => pc.indexOf(f) < 0);
const onlySw = pc.filter((f) => hs.indexOf(f) < 0);
eq(onlyHtml.length, 0, '★ index.html 引用的脚本都在预缓存清单里：' + (onlyHtml.join(',') || '（无差异）'));
eq(onlySw.length, 0, '★ 预缓存清单里的脚本都被 index.html 引用：' + (onlySw.join(',') || '（无差异）'));

/* 清单里不能有重复（重复写一个路径不会报错，但会让人以为改过了） */
eq(pc.length, new Set(pc).size, '预缓存清单没有重复项');
eq(hs.length, new Set(hs).size, 'index.html 没有重复引入同一个脚本');

/* ================================================================
 * 二、加载顺序：成就必须在状态机之前
 * ================================================================ */
eq(hs.indexOf('achievements.js') < hs.indexOf('stateMachine.js'), true,
  '★ achievements.js 排在 stateMachine.js 之前（反了成就永远 0，且不报错）');
eq(hs.indexOf('achievementsView.js') > hs.indexOf('stateMachine.js'), true,
  'achievementsView.js 在状态机之后（它只被 game.js 用，顺序不敏感，但保持可读）');
eq(hs.indexOf('game.js'), hs.length - 1, 'game.js 是最后一个（它要用前面所有模块）');

/* ================================================================
 * 三、版本号一致性
 * ================================================================ */
const vers = [];
const reV = /\?v=([\w.\-]+)/g;
let mv;
while ((mv = reV.exec(html))) vers.push(mv[1]);
const uniqV = Array.from(new Set(vers));
eq(uniqV.length, 1, '★ index.html 里所有 ?v= 是同一个值：' + uniqV.join(' / '));

const metaV = (/<meta name="app-version" content="([^"]+)">/.exec(html) || [])[1];
ok(!!metaV, 'index.html 有 app-version meta');
eq(metaV, uniqV[0], '★ meta 的 app-version 与资源 ?v= 一致（漏改一处 = 老内核拿旧缓存）');

const cacheName = (/const CACHE_NAME = '([^']+)'/.exec(sw) || [])[1];
ok(!!cacheName, 'sw.js 有 CACHE_NAME');
ok(/v\d+$/.test(cacheName), 'CACHE_NAME 以版本号结尾：' + cacheName);

/* ================================================================
 * 四、屏幕登记
 * ================================================================ */
ok(html.indexOf('id="screen-achievements"') >= 0, 'index.html 里有成就页的 section');
ok(html.indexOf('id="ach-body"') >= 0, '成就页有内容容器');
/* v109 后半段：首页那个第 5 格合并进了战绩页标题栏（首页保持 4 列网格）。
 * 这里断言的是「入口存在且带数字」，位置换了不影响这条守卫的目的。 */
ok(html.indexOf('id="btn-ach-from-records"') >= 0, '战绩页标题栏有成就入口');
ok(html.indexOf('id="ach-entry-num"') >= 0, '入口上带「12/26」那个数字');
ok(html.indexOf('id="btn-ach-home"') < 0, '★ 首页不再有第 5 个入口（否则 4 列网格会换行）');
ok(html.indexOf('id="btn-ach-back"') >= 0, '成就页有返回按钮');

/* showScreen 的 screens 数组 */
const screensLine = (/var screens = \[([^\]]+)\]/.exec(game) || [])[1] || '';
ok(screensLine.indexOf("'screen-achievements'") >= 0,
  '★ showScreen 的 screens 数组登记了 screen-achievements（漏了就是整屏空白）');
/* 这段赋值是跨行的三元链，单行正则匹配不到 —— 用 [\s\S]{0,400} 放开换行 */
ok(/state\.screen = [\s\S]{0,400}'achievements'/.test(game), 'state.screen 认识 achievements 这一态');

/* 事件真的绑上了（拼写错一个 id 就是「点了没反应」） */
ok(game.indexOf("$('#btn-ach-from-records')") >= 0, '战绩页入口绑了点击');
ok(game.indexOf("$('#btn-ach-back')") >= 0, '返回按钮绑了点击');
ok(game.indexOf('[data-ach-open]') >= 0, '信息档里的成就行用委托绑定');

/* ================================================================
 * 五、双端同源：服务端引的必须是同一份
 * ================================================================ */
const profile = read('server/profile.js');
ok(profile.indexOf("'achievements.js'") >= 0, '服务端 require 的是 pwa/js/achievements.js');
ok(profile.indexOf('Ach.blank()') >= 0, '_blank 用 Ach.blank() 生成桶（不手抄字段）');
ok(profile.indexOf('Ach.mergeInto') >= 0, 'record 用 Ach.mergeInto 合并');

const sm = read('pwa/js/stateMachine.js');
ok(sm.indexOf('Ach.accumulate') >= 0, '状态机在结算时调 accumulate');
ok(sm.indexOf("require('./achievements.js')") >= 0, '状态机 require 的是同一份文件');

const hub = read('server/hub.js');
ok(hub.indexOf('room.achRun') >= 0, 'hub 从房间桶取增量');
ok(hub.indexOf('delete view.achRun') >= 0,
  '★ hub 的 _view 删掉了 achRun（不删就把每个人的牌型增量广播给全场）');

/* ================================================================
 * 六、引擎牌型名与成就清单不能各说各的
 * ================================================================ */
const ach = read('pwa/js/achievements.js');
/* 这五个字符串出现任意一个被改名，成就就永远拿不到 —— 至少保证它们在文件里 */
['10.5点', '同花顺', '豹子', '牛牛', '五花牛'].forEach(function (n) {
  ok(ach.indexOf("'" + n + "'") >= 0, '成就清单里有牌型名：' + n);
});
ok(ach.indexOf('BIG_TYPES') >= 0, '大牌型走 BIG_TYPES 白名单，不是散落的条件判断');

/* ================================================================
 * 汇总
 * ================================================================ */
/* 汇总格式必须能被 scripts/run-tests.js 的 `通过 N 项，失败 M 项` 正则取到。
 * 写成「N 项通过」的话，这个文件的几十条断言在总账里一直是 0 —— 数字小看不出来，
 * 但「131 文件 / N 断言」这句话会悄悄少算一整个文件。 */
console.log('\n' + (fail === 0 ? '全部通过' : '有失败'));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) process.exit(1);
