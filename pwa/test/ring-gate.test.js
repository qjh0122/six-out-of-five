/**
 * 圆桌闸门测试（v105）
 * 跑法：node pwa/test/ring-gate.test.js
 *
 * 这个文件替掉的是 seat-ring.test.js 里那批**读源码字符串**的断言
 * （`/var RING_MIN_SCALE = 0\.5;/`）。字符串断言只证明「这行字还在」，
 * 证明不了「800×360 到底进没进」。现在判定是一个纯函数，机型落档可以直接跑表。
 *
 * 锁三件事：
 *   1. 三个机型族（iPhone / 安卓 / 电脑）的代表尺寸，支持/不支持与理由都要对；
 *   2. 单调性 —— 同一个宽高比下，窗口变大不会反而失去支持（这条能抓住
 *      「阈值写反成了 >」这类一眼看不出的错）；
 *   3. 接线 —— game.js 真的调了 RingGate，且字号/热区按缩放反算（不是写死）。
 */
'use strict';

const { readAll: readGameAll } = require('./helpers/gameSource');
const fs = require('fs');
const path = require('path');
const RingGate = require('../js/ringGate.js');

const ROOT = path.join(__dirname, '..');
const GAME = readGameAll();
const CSS = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');
const EMOJI = fs.readFileSync(path.join(ROOT, 'css', 'emoji.css'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

/* 视口 → (landscape, stageH, scale) 的复算。照抄 game.js resize() 的两条分支，
 * 只保留和档位判定有关的部分：
 *   横屏：scale = min(h/750, w/1624)，封顶 1.35；stageH = h/scale
 *   竖屏：scale = w/750；stageH = h/scale
 * 抄一份是**故意的**：独立实现才能抓出「game.js 改了公式但闸门没跟上」。 */
function geom(w, h, cap) {
  const landscape = w >= h || (h / w) < 1000 / 750;
  let scale;
  if (landscape) {
    scale = h / 750;
    if (w / scale < 1624) scale = w / 1624;
    if (cap && scale > 1.35) scale = 1.35;
  } else {
    scale = w / 750;
  }
  return { landscape, scale, stageH: h / scale };
}

/* 只认 <script src=...> 的位置：head 里有一条 <link rel=preload href=./js/game.js>，
 * 用 indexOf 直接比会把 preload 当成「已经加载了 game.js」。 */
function scriptAt(html, name) {
  const m = html.match(new RegExp('<script src="[^"]*/' + name + '\.js'));
  return m ? m.index : -1;
}

function judge(w, h, cap) {
  const g = geom(w, h, cap);
  return {
    landscape: g.landscape,
    scale: Math.round(g.scale * 1000) / 1000,
    stageH: Math.round(g.stageH),
    on: RingGate.flag(g),
    why: RingGate.explain(g)
  };
}

/* ------------------------- 1. 三族代表尺寸 ------------------------- */
console.log('\n[1] iPhone / 安卓 / 电脑 三族的代表尺寸');

const ON = [
  ['iPhone 14/15 竖', 390, 844],
  ['iPhone 14/15 横', 844, 390],
  ['iPhone 15 Pro Max 竖', 430, 932],
  ['iPhone 15 Pro Max 横', 932, 430],
  ['iPhone 12 mini 横（812×375，scale 正好 0.5）', 812, 375],
  ['iPhone SE 2/3 竖（375×667）', 375, 667],
  ['安卓 360×800 竖', 360, 800],
  ['安卓 360×640 竖', 360, 640],
  ['安卓 800×360 横（v105 新进）', 800, 360],
  ['Pixel 7 915×412 横', 915, 412],
  ['Z Fold 外屏 882×344 横（v105 新进）', 882, 344],
  ['iPad 横 1024×768', 1024, 768],
  ['电脑窗口 1280×720', 1280, 720],
  ['电脑窗口 1920×947（24" 1080p 内容区）', 1920, 947],
  ['电脑窗口 2560×1307（27" 1440p）', 2560, 1307],
  ['电脑窗口 1092×522（半屏窗口）', 1092, 522]
];
ON.forEach(function (r) {
  const j = judge(r[1], r[2]);
  ok(j.on, r[0] + ' → 上圆桌', JSON.stringify(j));
});

const OFF = [
  ['iPhone SE 1 代 竖 320×568', 320, 568, 'scale'],
  ['iPhone SE 2/3 横 667×375', 667, 375, 'scale'],
  ['iPhone SE 1 代 横 568×320', 568, 320, 'scale'],
  ['安卓 360×640 横 640×360', 640, 360, 'scale'],
  ['iPad 竖 768×1024（4:3，设计高只有 1000）', 768, 1024, 'stage-h'],
  ['iPad Pro 竖 1024×1366', 1024, 1366, 'stage-h']
];
OFF.forEach(function (r) {
  const j = judge(r[1], r[2]);
  ok(!j.on, r[0] + ' → 不上圆桌', JSON.stringify(j));
  /* 不只是「没上」，还要是**对的那条**理由：判错的理由会让下一个人改错开关 */
  ok(j.why.indexOf(r[3]) === 0, r[0] + ' 的拒绝理由 = ' + r[3], j.why);
});

/* ------------------------- 2. 边界与单调性 ------------------------- */
console.log('\n[2] 边界与单调性');

ok(RingGate.MIN_SCALE === 0.44, '尺度下限 0.44（>=0.44 上桌，<0.44 不上）');
ok(RingGate.MIN_STAGE_H.landscape === 700, '横屏结构性闸门 700');
ok(RingGate.MIN_STAGE_H.portrait === 1200, '竖屏结构性闸门 1200');

/* 首帧：还没量出来 → 放行。返回 false 会让第一帧走 v86 版式、第二帧再换桌子（闪一下） */
ok(RingGate.flag({ landscape: true, stageH: 0, scale: 0 }) === true, '首帧（stageH=0）放行，不闪');
ok(RingGate.flag({ landscape: false, stageH: 0, scale: 0 }) === true, '首帧竖屏同样放行');
ok(RingGate.explain({ landscape: true, stageH: 0, scale: 0 }) === 'first-paint', '首帧理由 = first-paint');

/* stageH 够但 scale 没量到：不该判死（原实现就是 `if (lastStageScale && ...)`） */
ok(RingGate.flag({ landscape: true, stageH: 750, scale: 0 }) === true, 'scale 未量到时不因尺度判死');

/* 阈值两侧各差一点点 */
ok(RingGate.flag({ landscape: true, stageH: 750, scale: 0.44 }) === true, 'scale = 0.44 正好进');
ok(RingGate.flag({ landscape: true, stageH: 750, scale: 0.4399 }) === false, 'scale = 0.4399 不进');
ok(RingGate.flag({ landscape: true, stageH: 700, scale: 0.6 }) === true, 'stageH = 700 正好进');
ok(RingGate.flag({ landscape: true, stageH: 699, scale: 0.6 }) === false, 'stageH = 699 不进');
ok(RingGate.flag({ landscape: false, stageH: 1200, scale: 0.6 }) === true, '竖屏 stageH = 1200 正好进');
ok(RingGate.flag({ landscape: false, stageH: 1199, scale: 0.6 }) === false, '竖屏 stageH = 1199 不进');

/* 单调性：固定在某个宽高比上，把窗口按比例放大，支持不能从「能」变「不能」。 */
const RATIOS = [16 / 9, 2.09, 19.5 / 9, 4 / 3, 2.17];
let monoBad = [];
RATIOS.forEach(function (r) {
  let prev = null;
  for (let h = 240; h <= 1600; h += 10) {
    const w = Math.round(h * r);
    const on = judge(w, h, true).on;
    if (prev === true && on === false) monoBad.push(w + '×' + h + ' @' + r.toFixed(2));
    prev = on;
  }
});
ok(monoBad.length === 0, '同宽高比下窗口变大不会反而失去支持', monoBad.slice(0, 5).join(' / '));

/* ------------------------- 3. 接线 ------------------------- */
console.log('\n[3] 接线：闸门、字号、热区');

ok(/RingGate\.flag\(\{[\s\S]{0,120}?landscape: isLandscape,[\s\S]{0,120}?stageH: lastStageH,[\s\S]{0,120}?scale: lastStageScale/.test(GAME),
  '★ seatRingFlag() 把三个量交给 RingGate，不再自己写阈值');
ok(!/RING_MIN_SCALE|RING_MIN_STAGE_H|RING_MIN_LS_NARROW_H/.test(GAME),
  'game.js 里不再留闸门阈值（只留档位分界 RING_MIN_LS_STAGE_H / RING_COMPACT_BELOW）');
ok(/lastStageH = stageH;/.test(GAME) && /lastStageScale = scale;/.test(GAME),
  'resize() 仍会把舞台高与实际缩放记给闸门用');
ok(/ringGate\.js\?v=/.test(HTML), 'index.html 加载 js/ringGate.js');
ok(scriptAt(HTML, 'ringGate') < scriptAt(HTML, 'seatRing'),
  'ringGate 在 seatRing 之前加载（game.js 两者都用，顺序反了会 undefined）');
ok(scriptAt(HTML, 'ringGate') < scriptAt(HTML, 'game'), 'ringGate 在 game.js 之前加载（head 里那条 preload 不算）');

/* 字号：写死 = 在 0.48 的横屏上 9.6 CSS px。必须按 scale 反算。 */
ok(/--seat-name/.test(GAME) && /--seat-name/.test(CSS), '座位昵称字号走 --seat-name（JS 反算 → CSS 使用）');
ok(/--seat-score/.test(GAME) && /--seat-score/.test(CSS), '分数走 --seat-score');
ok(/--seat-me/.test(GAME) && /--seat-me/.test(CSS), '「我的分」数字走 --seat-me');
ok(!/#game-top\.gt-ring \.opp-name \{ width: 100%; font-size: 20px/.test(CSS),
  '★ .opp-name 不再写死 20px（旧写死在 0.48 上只有 9.6 CSS）');

/* 热区：表情入口接 --tap-min。写死 88 在 scale 0.48 上只有 42 CSS px。 */
ok(/width: max\(88px, var\(--tap-min, 88px\)\)/.test(CSS), '★ .gt-emo 接上 --tap-min（热区由构造保证 ≥44）');
ok(/width: max\(92px, var\(--tap-min, 92px\)\)/.test(CSS), '紧凑档表情入口同样接 --tap-min');
/* 这一条是实际踩过的坑：#stage.ls .gt-emo 与 #game-top.gt-ring .gt-emo 特异性相同
 * （1 id + 2 class），而前者在 emoji.css 里更靠后 —— 写死 88 会把圆桌那条 max() 盖掉。
 * 真机上看到的是 computed 仍是 88px，而 --tap-min 已经是 92px。 */
ok(/#stage\.ls \.gt-emo \{ width: max\(88px, var\(--tap-min, 88px\)\)/.test(EMOJI),
  '★ 横屏那条 #stage.ls .gt-emo 也是 max()（否则盖掉圆桌那条，热区又变回 88）');
/* ★ 这条正则**不能依赖行尾**（v107 踩过）。
 * 原来写的是 `/\n\.gt-emo \{\n  flex: .../`，只认 LF。而这条链路上任何一次
 * `git stash` / `git checkout` 都会按 core.autocrlf 把文件写成 CRLF ——
 * 于是 `{` 后面变成 `\r\n`，`\{\n` 匹配不上，一条与设计毫无关系的守卫突然变红。
 * 它该守的是「这个块里有 width: max(88px, var(--tap-min, 88px))」，不是「文件是 LF」。 */
ok(/\r?\n\.gt-emo \{\r?\n  flex: 0 0 auto;\r?\n(?:[^\n]*\r?\n)*?  width: max\(88px, var\(--tap-min, 88px\)\)/.test(EMOJI),
  '基础 .gt-emo 也接 --tap-min（88 只是下界）');

/* 反算的数值校验：按 game.js 里那四条目标值算一遍，看最差的档位是否达标 */
const TARGETS = { name: 10.4, score: 12, label: 7.8, me: 14 };
const BASE = { name: 20, score: 24, label: 15, me: 34 };
const SCALES = [0.44, 0.48, 0.5, 0.52, 0.573, 0.672, 0.841, 1.35];
let textBad = [];
SCALES.forEach(function (s) {
  Object.keys(TARGETS).forEach(function (k) {
    const px = Math.max(BASE[k], Math.ceil(TARGETS[k] / s)) * s;
    if (px < TARGETS[k] - 0.001) textBad.push(k + '@' + s + '=' + px.toFixed(2));
  });
});
ok(textBad.length === 0, '★ 每个支持档位上，座位文字都踩得到 CSS 目标值', textBad.join(' '));

/* 现代机型一个像素都不许动：scale >= 0.525 时四个值必须等于原设计值 */
const untouched = [0.52, 0.549, 0.573].every(function (s) {
  return Math.max(20, Math.ceil(10.4 / s)) === 20 &&
         Math.max(24, Math.ceil(12 / s)) === 24 &&
         Math.max(15, Math.ceil(7.8 / s)) === 15 &&
         Math.max(34, Math.ceil(14 / s)) === 34;
});
ok(untouched, '★ 现有主力机型（scale 0.52~0.573）字号一个像素都不动');
ok(Math.max(20, Math.ceil(10.4 / 0.48)) === 22, '800×360（0.48）昵称 20 → 22 设计px = 10.56 CSS');
ok(Math.max(20, Math.ceil(10.4 / 0.44)) === 24, '下限档（0.44）昵称 20 → 24 设计px = 10.56 CSS');

/* ===================================================================
 * 朝向判定（v106）：窄高的电脑窗口要走横向版式
 * ===================================================================
 * 起因：桌面把窗口拉成「左右分屏」（960×1040）时 w<h 被判成竖屏，
 * 而竖版设计高 = 750 × 高宽比 = 813 < 1000 —— 版式装不下，
 * 实测组槽溢出 195 设计px、牌面缩到 60×84（全场最小）。
 *
 * 这一节锁两件事：
 *   A. 手机 / 平板 的朝向一个都没改判（这是用户的原话：不许破坏横竖屏）；
 *   B. 真的该改判的窄高窗口改判了，且理由可量。
 * =================================================================== */

/* 手机与平板的朝向表。改判任何一行都会红 —— 这就是「不破坏」的可执行形式。 */
const ORIENT = [
  ['iPhone SE 1 竖', 320, 568, 'P'],
  ['iPhone SE 1 横', 568, 320, 'L'],
  ['iPhone SE2/3 竖', 375, 667, 'P'],
  ['iPhone SE2/3 横', 667, 375, 'L'],
  ['iPhone 14/15 竖', 390, 844, 'P'],
  ['iPhone 14/15 横', 844, 390, 'L'],
  ['iPhone 15PM 竖', 430, 932, 'P'],
  ['iPhone 15PM 横', 932, 430, 'L'],
  ['安卓 360×640 竖', 360, 640, 'P'],
  ['安卓 360×640 横', 640, 360, 'L'],
  ['安卓 360×800 竖', 360, 800, 'P'],
  ['安卓 360×800 横', 800, 360, 'L'],
  ['Pixel 7 竖', 412, 915, 'P'],
  ['Pixel 7 横', 915, 412, 'L'],
  ['Z Fold 外屏 竖', 344, 882, 'P'],
  ['Z Fold 外屏 横', 882, 344, 'L'],
  ['iPad 竖 768×1024', 768, 1024, 'P'],
  ['iPad 竖 820×1180', 820, 1180, 'P'],
  ['iPad Pro 竖 1024×1366', 1024, 1366, 'P'],
  ['iPad 横 1024×768', 1024, 768, 'L']
];
let orientBad = [];
ORIENT.forEach(function (r) {
  const want = r[3] === 'L';
  if (RingGate.isLandscape(r[1], r[2]) !== want) {
    orientBad.push(r[0] + ' ' + r[1] + '×' + r[2] + ' 应为 ' + r[3]);
  }
});
ok(orientBad.length === 0, '★ 手机 / 平板的横竖判定一个都没改（20 个视口）', orientBad.join('; '));

/* 这才是根因证明：所有手机竖屏的高宽比都远在 1.333 之上。
 * 只要这条成立，改判据在数学上就碰不到手机 —— 不是「测过没坏」，是「不可能坏」。 */
const PHONE_PORTRAITS = [[320, 568], [375, 667], [390, 844], [430, 932],
  [360, 640], [360, 800], [412, 915], [344, 882]];
const minRatio = Math.min.apply(null, PHONE_PORTRAITS.map(function (d) { return d[1] / d[0]; }));
ok(minRatio >= 1.6, '★ 手机竖屏最小高宽比 ' + minRatio.toFixed(2) + ' ≥ 1.6（离阈值 1.333 有余量）');
ok(RingGate.PORTRAIT_MIN_RATIO === 1000 / 750, '阈值就是 1000/750（竖版设计高的下限反推，不是拍的）');

/* 平板竖屏恰好卡在等号上：768/1024 = 4/3 = 1000/750，`<` 不成立 → 仍是竖版。
 * 这一条最脆（差一点就会把 iPad 竖屏改判），单独钉住。 */
ok(!RingGate.isLandscape(768, 1024), 'iPad 竖屏 768×1024 恰好等于阈值仍走竖版（不是 >= 的锅）');

/* 桌面窄高窗口：真的改判了 */
[[960, 1040], [960, 940], [720, 780], [800, 820]].forEach(function (d) {
  if (d[0] < d[1]) {
    ok(RingGate.isLandscape(d[0], d[1]), '窄高窗口 ' + d[0] + '×' + d[1] + ' 改走横向版式');
  }
});
/* 横竖相等（正方形窗口）仍算横版，与旧行为一致 */
ok(RingGate.isLandscape(800, 800), '正方形窗口仍走横版（与旧判据一致）');
ok(!RingGate.isLandscape(0, 0), '没量到时返回竖版（首帧不炸）');

/* 接线：game.js 不许自己再判一次朝向，值是 RingGate 给的 */
ok(/isLandscapePhone\s*=\s*RingGate\.isLandscape\(/.test(GAME), '★ game.js 的朝向判定取自 RingGate');
ok(!/isLandscapePhone\s*=\s*availW\s*>=\s*availH/.test(GAME), 'game.js 里不再有第二份朝向判据');

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + '  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail === 0 ? 0 : 1);
