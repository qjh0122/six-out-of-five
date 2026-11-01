/**
 * 准备态长在牌桌上（v82 §3）—— 静态守卫
 *
 * 真浏览器行为由 scripts/probe-table-ready.js 验（33 条）。
 * 这里只守「结构还在不在」，因为它守的是那类**不会报错、只会静默变回旧行为**的改动：
 *   · 有人把 `if (tableReadyOn())` 从 render 里去掉 → 又回到独立房间页，单测全绿；
 *   · 有人忘了搬 `.room-actions` 而是 clone 一份 → 按钮点不动，静态测试看不出来（探针管）；
 *   · 有人删了 CONFIG.TABLE_READY → 回滚开关失效，出事时只能回滚版本号。
 *
 * 这两层各管一半，缺一半都会让「一句话回滚」变成一句空话。
 */
'use strict';

const { readAll: readGameAll } = require('./helpers/gameSource');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');
const js = readGameAll();
const cfg = fs.readFileSync(path.join(ROOT, 'js/config.js'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

console.log('\n[开关：一句话回滚]');
ok(/TABLE_READY\s*:\s*(true|false)/.test(cfg), 'config.js 有 TABLE_READY 开关');
ok(/function tableReadyFlag\(\)/.test(js), '有 tableReadyFlag()（读配置 + URL 覆盖）');
ok(/tableready/.test(js), '支持 ?tableready=0/1 运行时覆盖（灰度期不用发版就能验老路径）');
ok(/CONFIG\.TABLE_READY/.test(js), '运行时真的读了 CONFIG.TABLE_READY');

console.log('\n[牌桌里有准备层]');
const game = html.slice(html.indexOf('id="screen-game"'), html.indexOf('id="screen-settle"'));
ok(/id="table-ready"/.test(game), '#table-ready 在对局页里（不是另开一屏）');
ok(/id="ready-acts"/.test(game), '#ready-acts 在对局页里');
ok(/id="tr-head"/.test(game) && /id="tr-body"/.test(game) && /id="tr-card"/.test(game),
  '顶栏 / 正文 / 房间信息卡三个容器都在');
ok((html.match(/id="table-ready"/g) || []).length === 1, '#table-ready 只有一处（不重复定义）');

console.log('\n[搬节点，不复制节点]');
ok(/function mountTableReady\(\)/.test(js), '有 mountTableReady()');
ok(/appendChild\(roomTop\)/.test(js) && /appendChild\(actions\)/.test(js),
  '★ 用 appendChild 搬真实节点（cloneNode 出来的按钮点不动）');
ok(/if \(!head \|\| !body \|\| !acts \|\| !roomTop \|\| !hint \|\| !prevRow \|\| !actions\) return;/.test(js),
  '★ 任一容器缺失就整体不搬（半个迁移比不迁更糟）');
ok(/mountTableReady\(\);/.test(js), 'init 里真的调了');
/* 搬的时机：必须在 bindEvents 之后。先搬后绑也没错，但绑完再搬能保证
 * 以后有人把 bindEvents 改成「按位置取第 n 个」时不会静默失效。 */
ok(js.indexOf('bindEvents();') < js.indexOf('mountTableReady();'), '搬节点发生在 bindEvents 之后');

console.log('\n[路由：准备期只走牌桌一条路]');
ok(/if \(tableReadyOn\(\)\) \{ showReadyTable\(room\); return; \}/.test(js),
  'WAITING 阶段先判 tableReadyOn，再回落房间页');
ok(/if \(tableReadyOn\(\)\) \{ showReadyTable\(room, \{ nextWait: true \}\); return; \}/.test(js),
  '就位态（结算后点开始下一局）同样走牌桌');
ok(/exitReadyTable\(\);/.test(js), '进对局前会先退出准备态（否则牌桌和准备卡叠在一起）');
ok(/function exitReadyTable\(\)/.test(js), '有 exitReadyTable()');
/* 显隐只在一个地方做：散落到各处迟早漏一处 */
ok((js.match(/#table-ready'\)\.classList\.remove\('hidden'\)/g) || []).length === 1,
  '★ 只有一处把准备层显示出来（显隐不散落）');

console.log('\n[座位只画一套]');
ok(/renderTopBar\(room, me, room\.round, true, nextWait\)/.test(js),
  '准备态复用对局顶栏画座位（不另写一套座位样式）');
ok(/room\.phase === StateMachine\.PHASE\.WAITING \|\| nextWait/.test(js),
  '顶栏的「已准备/未准备」覆盖 WAITING 与就位态');
/* v87：这段判定搬进了 oppSeatState()（圆桌与旧顶栏共用一份）。
 * 断言从「整行字面量」改成「规则本身」—— 顺序仍然必须是 nextWait 先于 submitted。 */
ok(/text: ready \? '已准备' : \(nextWait && !p\.wantNext \? '还在结算' : '未准备'\)/.test(js),
  '★ 就位态里没报名的人标「还在结算」，不会被误读成未准备');

console.log('\n[复用而不是抄一份]');
ok(/function renderReadyCard\(room, opts\)/.test(js), '有 renderReadyCard()');
ok(/StateMachine\.ROUND_GROUPS\[1\]/.test(js), '两轮玩法从 StateMachine.ROUND_GROUPS 取，不写死字符串');
/* ★ v105：房间卡不再显示起始分。
 * 起始分改为 0 之后，「起始 0 分」既没信息量、又会让人以为兜里那几个 0 是筹码。
 * 断言跟着改成「这一行只说人话（人数 + 上限），不再拼起始分」。
 * 只盯 'tr-card-sub' 那一行，别扫全文 —— 注释里会提到旧文案。 */
ok(/act\.length \+ ' 人 · 上限 ' \+ cap/.test(js), '人数与上限都从变量取，不写死');
ok(!/'tr-card-sub[^\n]*INITIAL_SCORE/.test(js), '★ 房间卡那行不再拼起始分');
ok(/StateMachine\.capOf\(room\)/.test(js), '人数上限读 capOf(room)（老房间用老上限）');

console.log('\n[样式]');
ok(/\.table-ready\s*\{/.test(css), '有 .table-ready 布局');
ok(/\.tr-card\s*\{/.test(css), '有中央房间卡样式');
ok(/\.ls #screen-game\.is-ready/.test(css), '横屏单独一套两栏栅格（准备卡 | 动作条）');
ok(/\.ls #screen-game #game-top \{ grid-area: top/.test(css), '横屏顶栏区域没被改坏');

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
