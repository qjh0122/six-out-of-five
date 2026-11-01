/**
 * 开局 3 秒倒计时（纯静态解析，不开浏览器）
 * 跑法：node pwa/test/start-countdown.test.js
 *
 * 这一项是**故意默认关着**的（docs/circle-table-rollout-status.md §3.3 第 11 项）：
 * 线上「全员准备即开」比倒计时快，也没有「第 3 个人干等第 5 个人点准备」那种尴尬。
 * 那 3 秒是给评审 / 录屏用的，所以做成 `?countdown=1`。
 *
 * 于是这个文件守的不是「功能好不好用」，而是三条**不能破的边界**：
 *   1. 默认必须是关的 —— 有人把 CONFIG 改成 true，线上每一次开局都会多 2.2 秒；
 *   2. 它**不许碰时序**：牌是服务端发的，这里只加一层遮罩。
 *      一旦有人在 countdown 里 await 服务端、或者把它塞进 autoStartIfReady，
 *      三个人的开局就会被最慢的那一次网络请求拖住；
 *   3. 每个房间只放一次、点一下能跳过。render() 每次广播都跑，
 *      少了守卫的话对手点个准备倒计时就从头再来。
 */
'use strict';

const { readAll: readGameAll } = require('./helpers/gameSource');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const gameJs = readGameAll();
const css = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');
const smJs = fs.readFileSync(path.join(ROOT, 'js', 'stateMachine.js'), 'utf8');
const cfgJs = fs.readFileSync(path.join(ROOT, 'js', 'config.js'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
/* 取一个具名函数的函数体（从 `function name(` 到下一个缩进两格的收尾大括号）。
 * game.js 全是 ES5 函数声明 + 两格缩进，这个足够稳。 */
function fnBody(name) {
  const start = gameJs.indexOf('function ' + name + '(');
  if (start < 0) return '';
  const end = gameJs.indexOf('\n  }', start);
  return end < 0 ? '' : gameJs.slice(start, end);
}

/* ---------- 1. 默认必须是关的 ---------- */
console.log('\n[1] 默认关闭（这是产品决定，不是没做完）');
ok(/START_COUNTDOWN:\s*false/.test(cfgJs), '★ CONFIG.START_COUNTDOWN 默认 false');
{
  const body = fnBody('startCountdownFlag');
  ok(!!body, 'startCountdownFlag() 存在（与 CONFIG 的键同名，rollback-contract 要求）');
  ok(/get\('startcountdown'\)/.test(body), '参数名与 CONFIG 键对齐：?startcountdown=0|1');
  ok(/'1'\)\s*return true/.test(body), '?startcountdown=1 能强制打开（录屏 / 评审用）');
  ok(/'0'\)\s*return false/.test(body), '?startcountdown=0 能强制关掉（排障：确认是不是它）');
  ok(/return\s+!!CONFIG\.START_COUNTDOWN/.test(body), '不带参数时听 CONFIG 的（不是硬编码 true）');
  /* URL 优先于 CONFIG，和 ?seatring / ?tableready 的说法保持一致 */
  ok(body.indexOf("q === '1'") < body.indexOf('CONFIG.START_COUNTDOWN'),
    'URL 的 1 判定在 CONFIG 之前（灰度期能单机先看）');
}

/* ---------- 2. 不许碰时序 ---------- */
console.log('\n[2] 不碰时序：牌还是服务端发的那一套');
ok(!/countdown/i.test(smJs), 'stateMachine.js 里一个字都没提倒计时（规则层不该知道界面仪式）');
{
  const body = fnBody('maybeCountdown');
  ok(!!body, 'maybeCountdown() 存在');
  ok(!/send\(|fetch\(|await |then\(/.test(body), '★ maybeCountdown 不调接口、不等网络（只判两个条件就放）');
}
{
  const body = fnBody('playCountdown');
  ok(!/send\(|fetch\(|await |then\(/.test(body), '★ playCountdown 同一套：纯本地计时器，不等任何响应');
  ok(/setTimeout\(step, COUNT_HOLD\)/.test(body), '节奏只有一个来源 COUNT_HOLD');
  ok(/clearTimeout/.test(fnBody('stopCountdown')), 'stopCountdown 会真的停表（不留孤儿定时器）');
}

/* ---------- 3. 只放一次 + 只放第一把 ---------- */
console.log('\n[3] 每个房间一次、只在开局那一把');
{
  const body = fnBody('maybeCountdown');
  ok(/room\.handCount !== 1/.test(body), '★ 只在第一把（handCount === 1），换局不再弹');
  ok(/cd\.room === room\.roomId\)\s*return/.test(body), '★ 同一个房间不重播（render 每次广播都跑）');
  ok(/cd\.room = room\.roomId/.test(body), '记下房间号，换房间才会再放');
  ok(/!startCountdownFlag\(\)/.test(body), '开关关着时直接返回');
}
{
  const body = fnBody('maybeCountdown');
  ok(/guide-modal/.test(body) && /classList\.contains\('hidden'\)\)\s*\{ cd\.room = room\.roomId; return; \}/.test(body),
    '★ 新手引导开着时整局都不放（而且照样记房间号，免得引导关掉后从半路冒出来）');
  const gi = body.indexOf('guide-modal');
  const gi2 = body.indexOf('cd.room = room.roomId');
  ok(gi > 0 && gi2 > gi, '引导判定在「记房间号 + 播」之前');
}
{
  const body = fnBody('cleanupRoom');
  ok(/stopCountdown\(\)/.test(body), '★ 离开房间要停表（遮罩是 inset:0，留着会盖住下一个房间）');
  ok(/cd\.room = ''/.test(body), '离开房间清掉房间号（同房重进能再放一次）');
}

/* ---------- 4. 四拍内容 + 能跳过 ---------- */
console.log('\n[4] 四拍：3 / 2 / 1 / 开始');
{
  const m = /var COUNT_STEPS = \[([^\]]*)\]/.exec(gameJs);
  ok(!!m, 'COUNT_STEPS 是一个数组（不是散在代码里的字符串）');
  if (m) {
    const items = m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, ''));
    ok(items.length === 4 && items.join('') === '321开始',
      '四拍正好是 3 / 2 / 1 / 开始（实际 ' + items.join(' / ') + '）');
  }
  ok(/var COUNT_HOLD = 560/.test(gameJs), '每拍 560ms（4 拍 ≈ 2.2 秒，比 3 秒短 —— 没人真在数）');
  const body = fnBody('playCountdown');
  ok(/box\.onclick = function \(\) \{ stopCountdown\(\); \}/.test(body), '★ 点一下能跳过（仪式不该拦着想快的人）');
  /* 重启 keyframes：只改 class 不会重跑动画，4 拍里只有第一拍会动 */
  ok(/classList\.remove\('tick'\)[\s\S]{0,80}?void box\.offsetWidth[\s\S]{0,80}?classList\.add\('tick'\)/.test(body),
    '★ 先摘 class、强制回流、再挂上（否则后三拍静止换字，看起来像卡住）');
  ok(/Sfx\.play\('select'/.test(body), '每拍有声音（开局那一下的仪式感主要在声音上）');
}

/* ---------- 5. 接线：元素、样式、调用点 ---------- */
console.log('\n[5] 接线（防止「写了没人调」）');
ok(/<div id="countdown"[^>]*class="countdown hidden"/.test(html), '#countdown 默认 hidden');
ok(/<b id="cd-num">/.test(html), '有 #cd-num 这个数字位');
ok(!/id="countdown"[^>]*class="[^"]*\bmodal\b/.test(html),
  '★ 不是 .modal（它没有焦点陷阱、不参与 Esc 链，modal-a11y 的计数不该被它改）');
ok(!/countdown/.test((/var MODAL_ORDER = \[([\s\S]*?)\]/.exec(gameJs) || ['', ''])[1]),
  '也不进 MODAL_ORDER（不是弹窗，没有层级要管）');
ok(/maybeCountdown\(room\);/.test(fnBody('render')) || /maybeCountdown\(room\)/.test(gameJs),
  'render() 里真的调了');
{
  /* 必须挂在 renderGame 之后：放前面的话 renderGame 抛异常会留下一个挂在屏幕上的遮罩 */
  const r = fnBody('render');
  const iG = r.indexOf('renderGame(room)');
  const iC = r.indexOf('maybeCountdown(room)');
  ok(iG > 0 && iC > iG, '★ 调用点在 renderGame 之后（渲染失败不会留下遮罩）',
    'renderGame@' + iG + ' maybeCountdown@' + iC);
}
ok(/\.countdown \{[\s\S]{0,400}?z-index: 60/.test(css), 'CSS: .countdown 压在所有弹窗（z-index 50）之上');
ok(/\.countdown\.hidden \{ display: none; \}/.test(css), 'CSS: .hidden 真的能把它藏起来');
ok(/@keyframes cdPop/.test(css), 'CSS: 有 cdPop 入场动画');
ok(/prefers-reduced-motion: reduce\)[\s\S]{0,120}?\.countdown\.tick b \{ animation: none; \}/.test(css),
  'CSS: 减少动态时只关动画，**不关换字**（节奏不是动画）');

/* ---------- 6. 不做的那一半，写清楚为什么 ---------- */
console.log('\n[6] 「房主现在开局」没做 —— 这是有意的');
{
  /* 产品上开局按钮是**被删掉**的（index.html 里留了说明）。加回来要改 canStart 的规则，
   * 而那套规则是服务端权威的，会连带影响 autoStartIfReady、wantNext、补 AI 三条路径。 */
  ok(/开局按钮已移除/.test(html), 'index.html 里那条「开局按钮已移除」的说明还在');
  ok(!/btn-start-now/.test(html) && !/btn-start-now/.test(gameJs), '没有偷偷加回「现在开局」按钮');
  ok(/if \(!canStart\(room\)\) return \{ ok: false/.test(smJs),
    'startGame 仍然要求 canStart（全员准备），没有被倒计时这项改动松绑');
}

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
