/**
 * 表情 / 短语清单：一份，两端共用
 * 跑法：node pwa/test/emoji.test.js
 *
 * 这个文件守的不是「表情好不好看」，而是三件会静默出错的事：
 *
 * 1. **清单与素材必须对得上**。13 个 id 各自要有一张真图；改名或删图之后
 *    界面会渲染出一个 404 的空格子，而 JS 不会报错。
 * 2. **白名单只有一份**。服务端 hub.js 必须 require 这个模块，而不是自己抄一份 id 表 ——
 *    这个仓库被「两处配置」咬过两次（hub.js 私抄 MAX_PLAYERS、原型手抄 engine.js）。
 * 3. **上新文件别忘了发出去**。index.html 要引到、sw.js 要预缓存到，
 *    否则离线时面板是空的，而在线一切正常 —— 这种问题只在断网时才暴露。
 */
'use strict';

const { readAll: readGameAll } = require('./helpers/gameSource');
const fs = require('fs');
const path = require('path');
const Emoji = require('../js/emoji.js');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

console.log('\n[1] 清单本身');
{
  eq(Emoji.list().length, 13, '13 张表情');
  eq(Emoji.phrases().length, 8, '8 条短语');
  eq(Emoji.BROADCAST, '*', '全场目标常量是 *（不用 all，避免撞上真实 playerId）');
  eq(Emoji.MIN_INTERVAL_MS, 2000, '限流 2 秒一条');

  const ids = Emoji.list().map((e) => e.id).concat(Emoji.phrases().map((p) => p.id));
  eq(new Set(ids).size, ids.length, '表情与短语之间没有重复 id');
  ok(Emoji.list().every((e) => /^e\d+$/.test(e.id)), '表情 id 形状 eN');
  ok(Emoji.phrases().every((p) => /^p\d+$/.test(p.id)), '短语 id 形状 pN');
  ok(ids.every((id) => id.length <= Emoji.ID_MAX_LEN), '所有 id 不超过 ID_MAX_LEN（服务端先按长度挡一道）');
  ok(Emoji.list().every((e) => e.name && e.name.length > 0), '每张表情都有名字（读屏要念）');
  ok(Emoji.phrases().every((p) => p.text && p.text.trim() === p.text), '短语没有首尾空格');
}

console.log('\n[2] 素材文件真的存在');
{
  for (const e of Emoji.list()) {
    const abs = path.join(ROOT, e.src.replace('./', ''));
    ok(fs.existsSync(abs), '素材存在：' + e.file, abs);
    if (fs.existsSync(abs)) {
      const stat = fs.statSync(abs);
      ok(stat.size > 2000, e.file + ' 不是空文件（' + stat.size + ' B）');
    }
  }
  ok(Emoji.list().every((e) => e.src.indexOf('./assets/emoji/') === 0), 'src 指向 ./assets/emoji/');
}

console.log('\n[3] 校验函数是白名单，不是黑名单');
{
  ok(Emoji.isValid('e0'), '合法表情 id');
  ok(Emoji.isValid('p7'), '合法短语 id');
  ok(!Emoji.isValid('e13'), 'e13 不在清单里 → 非法');
  ok(!Emoji.isValid(''), '空串 → 非法');
  ok(!Emoji.isValid(null), 'null → 非法');
  ok(!Emoji.isValid(undefined), 'undefined → 非法');
  ok(!Emoji.isValid('e0 '), '带空格 → 非法');
  ok(!Emoji.isValid('toString'), '不吃原型链上的键（必须是自有属性）');
  ok(!Emoji.isValid('__proto__'), '__proto__ → 非法');
  eq(Emoji.get('e5').name, '大哭', 'get 取到名字');
  eq(Emoji.get('nope'), null, 'get 未知 id 返回 null');
  ok(Emoji.isPhrase('p3') && !Emoji.isPhrase('e3'), 'isPhrase 分得清两类');
  eq(Emoji.label('p3'), '包开挂了先。', '短语 label 是原文');
  eq(Emoji.label('e3'), '疑惑', '表情 label 是名字');
}

console.log('\n[4] 白名单只有一份（防「两处配置」）');
{
  const hub = fs.readFileSync(path.join(ROOT, '..', 'server', 'hub.js'), 'utf8');
  ok(/require\(path\.join\(__dirname,[^)]*'pwa',\s*'js',\s*'emoji\.js'\)\)/.test(hub),
    'hub.js 是 require 这个模块，不是自己抄一份');
  ok(!/'e0-dizzy'|"e0-dizzy"/.test(hub), 'hub.js 里没有硬编码的表情文件名');
  ok(/Emoji\.isValid\(/.test(hub), '服务端用的是同一个 isValid');
}

console.log('\n[5] 上新文件要「发得出去」（index.html / sw.js）');
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  ok(/<script src="\.\/js\/emoji\.js/.test(html), 'index.html 引了 js/emoji.js');
  ok(/<link rel="stylesheet" href="\.\/css\/emoji\.css/.test(html), 'index.html 引了 css/emoji.css');
  /* 顺序：roomStore 里的 sendEmoji 会用 Emoji 校验 id，必须后加载 */
  ok(html.indexOf('js/emoji.js') < html.indexOf('js/roomStore.js'), 'emoji.js 在 roomStore.js 之前加载');
  ok(sw.indexOf("'/js/emoji.js'") >= 0, 'sw.js 预缓存 js/emoji.js');
  ok(sw.indexOf("'/css/emoji.css'") >= 0, 'sw.js 预缓存 css/emoji.css');
  let missing = 0;
  for (const e of Emoji.list()) {
    if (sw.indexOf("'/assets/emoji/" + e.file + "'") < 0) { missing++; console.log('       缺：' + e.file); }
  }
  eq(missing, 0, '13 张表情全部进了预缓存');
  /* v89：面板从「居中弹窗」改成「点谁弹谁」的浮层，根节点 id 随之变成 seat-sheet */
  ok(/id="seat-sheet"/.test(html), '面板根节点在 HTML 里（#seat-sheet）');
  ok(!/id="emoji-modal"/.test(html), '旧的全屏表情弹窗已经拆掉（不再有两个入口）');
  ok(/id="emoji-layer"/.test(html), '飞行动画层在 HTML 里');
  /* 动画层必须在 #stage 外面：里面的话 rect 是缩放后的坐标 */
  ok(html.indexOf('id="emoji-layer"') > html.indexOf('id="toast"'), '动画层在 #stage 之后（与弹窗一起在舞台外的前提）');
}

console.log('\n[6] 回滚开关 CONFIG.EMOJI / ?emoji=0');
{
  const cfg = fs.readFileSync(path.join(ROOT, 'js', 'config.js'), 'utf8');
  const GAME = readGameAll();
  ok(/EMOJI:\s*true/.test(cfg), 'config.js 里有 EMOJI 开关（灰度期第一动作是翻开关，不是回滚版本）');

  /* ★ 只关一半最糟：自己发不出去、却能看见别人发，用户会以为手机坏了。
   *   所以三处必须一起关 —— 顶栏入口、手动打开、以及「收」那一路。
   *   判据从「有几处 return」升级成「三处都走同一个判定函数」：
   *   数次数只能证明「关了几处」，证明不了「用的是同一个说法」。 */
  ok(/function emojiFlag\s*\(/.test(GAME), '有统一的 emojiFlag() 判定函数');
  ok(/get\(\s*'emoji'\s*\)/.test(GAME), '★ 支持 ?emoji=0/1 运行时覆盖（与 ?tableready 对称）');
  ok(/return CONFIG\.EMOJI !== false;/.test(GAME), '默认值仍取 CONFIG.EMOJI');

  const guards = [
    /* v87：入口的 html 抽进了 emojiBtnHtml()（圆桌与旧顶栏共用一份），
     * 判据跟着落到那个函数体里 —— 断言的意图没变：开关关掉时入口不存在。 */
    ['顶栏入口', /function emojiBtnHtml[\s\S]{0,120}?!emojiFlag\(\)\) return '';/],
    ['手动打开面板', /if \(!emojiFlag\(\)\) return;\s*\/\/ 开关关掉时/],
    ['收到别人的表情', /if \(!emojiFlag\(\)\) return;\s*\n\s*if \(!ev \|\| !ev\.id/]
  ];
  guards.forEach(function (g) {
    ok(g[1].test(GAME), '★ 关掉时「' + g[0] + '」也关（走 emojiFlag）');
  });

  /* 反例：运行时判断不许绕过 emojiFlag 直接读 CONFIG.EMOJI。
   * 这正是「开关只关了一半」最容易复发的地方 —— 加新分支时顺手写 CONFIG.EMOJI === false，
   * 单测照样绿（数次数那条也能过），但 ?emoji=0 在那一处不生效。
   * 只允许出现在 emojiFlag() 自己的默认值里。 */
  const bypass = GAME.match(/CONFIG\.EMOJI === false/g) || [];
  ok(bypass.length === 0, '★ 没有绕过 emojiFlag 直接读 CONFIG.EMOJI 的判断（' + bypass.length + ' 处）',
    '出现即说明又有了「开关只关一半」的新分支');
}

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) process.exitCode = 1;
