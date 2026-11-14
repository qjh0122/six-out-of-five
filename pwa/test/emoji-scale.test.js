/**
 * 表情 / 短语的**跨设备尺寸与落点**
 * 跑法：node pwa/test/emoji-scale.test.js
 *
 * 这个文件守的是 2026-11-14 那两个 bug，它们都属于「单测全绿、真机上不对」：
 *
 * 1. **尺寸写死 CSS px**。#emoji-layer 是 fixed 全屏、不在 #stage 里，拿不到那圈
 *    transform: scale()。座位头像在手机竖屏是 35、电脑窗口是 57，而气泡一直是
 *    64 / 24 号字 —— 电脑上就变成「表情比头像还小、短语比座位名还小」。
 * 2. **落点正中对齐座位**。气泡中心 = 座位中心，于是短语气泡正好糊住对方头像，
 *    连名字一起挡掉。
 *
 * 静态断言能守的只有「代码长这样」，真正的像素与遮挡由 scripts/probe-emoji.js
 * 用真浏览器在 390×844 / 844×390 / 1366×768 / 1920×1080 四档量。
 * 这里守的是「别有人把 var(--emo-k) 改回写死的数字」。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { stripComments, parseBlocks } = require('../../scripts/lib/css-blocks');

const ROOT = path.join(__dirname, '..');
const cssRaw = fs.readFileSync(path.join(ROOT, 'css', 'emoji.css'), 'utf8');
const css = stripComments(cssRaw);
const jsRaw = fs.readFileSync(path.join(ROOT, 'js', 'seatSheetView.js'), 'utf8');
const js = stripComments(jsRaw);

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function rule(sel) {
  const b = parseBlocks(css).filter((x) => x.selector.replace(/\s+/g, ' ') === sel);
  return b.length ? b[b.length - 1].body : '';
}

console.log('\n[1] 尺寸必须跟着 --emo-k 走');
{
  const fly = rule('.emoji-fly');
  ok(/width:\s*calc\(64px \* var\(--emo-k/.test(fly), '★ 表情直径 = 64px × --emo-k（不是写死 64px）', fly.slice(0, 120));
  ok(/height:\s*calc\(64px \* var\(--emo-k/.test(fly), '表情高度同步缩放（长宽必须同源，否则会变椭圆）');

  const ph = rule('.emoji-fly.is-phrase .emoji-pop');
  ok(/font-size:\s*calc\(24px \* var\(--emo-k/.test(ph), '★ 短语字号 = 24px × --emo-k（用户报的就是这一条）', ph.slice(0, 160));
  ok(/padding:\s*calc\(10px \* var\(--emo-k/.test(ph), '内边距同步（只放大字号会让气泡显得挤）');
  ok(/border-radius:\s*calc\(18px \* var\(--emo-k/.test(ph), '圆角同步（不同步会变成「字很大、角很尖」）');

  const wrap = rule('.emoji-fly.is-phrase');
  ok(/max-width:\s*min\(calc\(460px \* var\(--emo-k/.test(wrap),
    '★ 宽度上限同步放大，且再与「视口宽 - 24」取小（320 档不会顶出屏幕）', wrap.slice(0, 160));
  const popRule = rule('.emoji-fly.is-phrase .emoji-pop');
  ok(/white-space:\s*normal/.test(popRule),
    '★ 允许折行（只在视口上限真的压下来时触发；换成 overflow:hidden 会截断句子）');
}

console.log('\n[2] 不许退回写死的尺寸');
{
  ok(!/^\.emoji-fly \{[^}]*width:\s*64px;/m.test(css), '★ .emoji-fly 不再有裸 width: 64px');
  ok(!/is-phrase \.emoji-pop \{[^}]*font-size:\s*24px;/m.test(css), '★ 短语气泡不再有裸 font-size: 24px');
}

console.log('\n[3] --emo-k 由舞台缩放反算');
{
  ok(/function stageScale\(\)/.test(js), '有 stageScale()');
  const body = js.slice(js.indexOf('function stageScale()'));
  ok(/getComputedStyle\(st\)\.transform/.test(body.slice(0, 400)), '读的是 #stage 的 computed transform（竖版 --pt-scale、横版 --ls-scale 都落在这里）');
  ok(/matrix/.test(body.slice(0, 400)), '按 matrix 取比例（不猜变量名）');
  ok(/Math\.max\(1,\s*stageScale\(\)\s*\/\s*0\.52\)/.test(js),
    '★ k = max(1, 舞台缩放 / 0.52)：只放大不缩小（手机观感已逐张确认，不陪小屏继续缩）');
  ok(/setProperty\('--emo-k',\s*k\)/.test(js), '把 k 写进外层节点的 --emo-k');

  /* 顺序是硬要求：offsetWidth 量的是「此刻的尺寸」，--emo-k 晚一步写进去，
   * 量到的就是上一版的 64 / 50，落点跟着偏。 */
  const setAt = js.indexOf("setProperty('--emo-k'");
  const measureAt = js.indexOf('var w = wrap.offsetWidth');
  ok(setAt > 0 && measureAt > setAt, '★ 先写 --emo-k、后量 offsetWidth（写反了量到旧尺寸）',
    'set=' + setAt + ' measure=' + measureAt);
}

console.log('\n[4] 落点贴在座位外侧，不压在座位上');
{
  ok(/var ty = toR\.top - h - gap;/.test(js), '★ 首选：气泡底边贴座位上方留 gap');
  ok(/if \(ty < 4\) ty = toR\.bottom \+ gap;/.test(js),
    '★ 顶部放不下就翻到座位下方（上排座位贴着屏幕边，不翻就会被 overflow:hidden 切掉）');
  ok(/var vw = window\.innerWidth/.test(js) && /vw - w - 4/.test(js), '水平方向夹进视口');

  ok(!/translate3d\(' \+ tx \+ 'px,' \+ \(ty - 8 \* k\)/.test(js),
    '★ 落定不再额外 -8px（那 8px 是「正中覆盖」时代的上浮量，会把 gap 抵消成负重叠）');
  ok(!/var ty = toR\.top \+ toR\.height \/ 2 - h \/ 2;/.test(js), '★ 落点不再用「座位中心」（那正是糊住头像的写法）');

  /* 夹取（横向进视口）+ 翻转（顶部放不下就往下）是两个独立动作，组合起来会撞车：
   * 320 宽那一档，气泡折两行后 83 高 → 翻到座位下方，同时被夹到屏幕左边 →
   * 正好压在左上邻居的头像上（实测 263 px²）。所以最后必须拿**最终矩形**再和
   * 真实头像比一次，挡着谁就推到谁下面。 */
  ok(/function coversAvatar\(y\)/.test(js), '★ 有 coversAvatar()：拿最终矩形比真实头像，算不出来的事只能量');
  ok(/ty = low \+ gap;/.test(js), '★ 挡住谁就推到谁下面（不是只翻一次就收手）');
  ok(/guard < 4; guard\+\+/.test(js), '推挤有次数上限（避免死循环）');
  ok(/vh - h - 4/.test(js), '纵向也夹进视口（推挤可能把气泡推到底部外面）');
}

console.log('\n[5] 起点的写法没被顺手改坏');
{
  ok(/var fx = fromR\.left \+ fromR\.width \/ 2 - w \/ 2;/.test(js), '起点仍是发言人座位居中（飞出去的那一下）');
}

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
