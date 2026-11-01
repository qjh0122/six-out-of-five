/**
 * 圆桌座位环几何测试
 * 跑法：node pwa/test/seat-ring.test.js
 *
 * 锁的是两件事：
 *   1. **按弧长均分**（不是按角度）—— 椭圆长轴端每度走过的长度是短轴端的 rx/ry ≈ 1.6 倍，
 *      按角度分时 5 人局侧面间距只有 103 设计px，而座位块要 112 宽，必然互相压住。
 *      这条以前是靠「看截图觉得糊」发现的，现在用弧长断言钉死。
 *   2. **环的高度预算** —— 环每高 1px，组槽就窄 1px、牌就小一点。
 *      h 一旦超过预算，竖屏三组就放不下（slotLayout 那套刚性账本会先撞下限）。
 *
 * 坐标系：全部是设计像素（#stage 是 750 宽的坐标系，transform 缩放不影响布局值）。
 */
'use strict';

const { readAll: readGameAll } = require('./helpers/gameSource');
const fs = require('fs');
const path = require('path');
const SeatRing = require('../js/seatRing.js');

const ROOT = path.join(__dirname, '..');
const W = 670;           // 竖屏 #game-top 的实际宽度（750 − 左右各 40 的内边距）
const SEAT_BLOCK_W = 112; // 座位块（头像 68 / 昵称块 ≤120）在环上占的宽度

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function near(a, b, tol) { return Math.abs(a - b) <= (tol == null ? 0.5 : tol); }

/* ---------------------------- 1. 角度表 ---------------------------- */
console.log('\n[1] 上弧张角与对称性');
ok(SeatRing.spanOf(1) === 0, '1 个对手：张角 0°（2 人局面对面坐）');
ok(SeatRing.spanOf(4) === 214, '4 个对手：张角 214°（202° 会让最外侧座位被裁 8px）');
ok(SeatRing.spanOf(9) === 224, '超过 5 个对手：退回 224°（老 8 人房兼容）');

{
  const L = SeatRing.layout({ w: W, n: 1 });
  ok(L.seats.length === 1 && near(L.seats[0].deg, 270), 'n=1 时只剩正上方一个座位');
  ok(near(L.seats[0].x, L.ring.cx, 0.6), 'n=1 的座位在正中（x = cx）');
}

for (let n = 2; n <= 5; n++) {
  const L = SeatRing.layout({ w: W, n });
  const degs = L.seats.map((s) => s.deg);
  const span = SeatRing.spanOf(n);
  const mean = degs.reduce((a, b) => a + b, 0) / degs.length;
  ok(near(mean, 270, 0.01), 'n=' + n + '：角度均值落在正上方 270°');
  ok(near(degs[0], 270 - span / 2, 0.4) && near(degs[n - 1], 270 + span / 2, 0.4),
    'n=' + n + '：首尾座位正好落在 [-span/2, +span/2] 两端');
  /* 左右镜像：第 i 个与倒数第 i 个相对 270° 对称（弧长均分本身是对称的，
   * 这条能抓住二分反解写歪的 bug —— 那种 bug 不改变首尾、只让中间座位偏向一侧） */
  let mirrorOk = true;
  for (let i = 0; i < n; i++) {
    if (!near(degs[i] + degs[n - 1 - i], 540, 0.05)) mirrorOk = false;
  }
  ok(mirrorOk, 'n=' + n + '：座位左右镜像对称');
}

/* ---------------------------- 2. 弧长均分（核心） ---------------------------- */
console.log('\n[2] 弧长均分 —— 相邻座位间距必须相等');
function arcBetween(ring, d0, d1) {
  /* 直接按椭圆弧长积分，和模块内部的算法不同源，避免「自己验自己」 */
  const N = 2000, a0 = d0 * Math.PI / 180, a1 = d1 * Math.PI / 180;
  let len = 0, px = ring.rx * Math.cos(a0), py = ring.ry * Math.sin(a0);
  for (let i = 1; i <= N; i++) {
    const a = a0 + (a1 - a0) * i / N;
    const x = ring.rx * Math.cos(a), y = ring.ry * Math.sin(a);
    len += Math.hypot(x - px, y - py);
    px = x; py = y;
  }
  return len;
}
for (let n = 2; n <= 5; n++) {
  const L = SeatRing.layout({ w: W, n });
  const degs = L.seats.map((s) => s.deg);
  const arcs = [];
  for (let i = 1; i < n; i++) arcs.push(arcBetween(L.ring, degs[i - 1], degs[i]));
  const mean = arcs.reduce((a, b) => a + b, 0) / arcs.length;
  const maxDev = Math.max.apply(null, arcs.map((a) => Math.abs(a - mean)));
  ok(maxDev <= 1.5, 'n=' + n + '：相邻弧长偏差 ≤ 1.5（' + arcs.map((a) => a.toFixed(1)).join(' / ') + '）', '最大偏差 ' + maxDev.toFixed(2));
  /* 反面对照：按角度均分的最大偏差是多少 —— 证明这条断言真的能分辨两种算法 */
  if (n === 5) {
    const ang = [];
    for (let i = 0; i < n; i++) ang.push(270 - 214 / 2 + 214 * i / (n - 1));
    const a2 = [];
    for (let i = 1; i < n; i++) a2.push(arcBetween(L.ring, ang[i - 1], ang[i]));
    const m2 = a2.reduce((a, b) => a + b, 0) / a2.length;
    const dev2 = Math.max.apply(null, a2.map((a) => Math.abs(a - m2)));
    ok(dev2 > 20, '反面对照：按角度均分时偏差高达 ' + dev2.toFixed(1) + '（说明这条断言有判别力）');
  }
}

/* ---------------------------- 3. 座位不互相压住（可见后果） ---------------------------- */
console.log('\n[3] 座位块不重叠');
for (let n = 1; n <= 5; n++) {
  const L = SeatRing.layout({ w: W, n });
  const sp = L.arcSpacing;
  ok(n === 1 || sp >= SEAT_BLOCK_W + 20,
    'n=' + n + '：最近的两个座位间距 ' + (n === 1 ? '—' : sp.toFixed(0)) + ' ≥ ' + (SEAT_BLOCK_W + 20));
  /* 更硬的一条：直接算两两座位中心的直线距离，块半宽 56 → 圆心距必须 > 112 */
  let minD = Infinity;
  for (let i = 0; i < L.seats.length; i++) {
    for (let j = i + 1; j < L.seats.length; j++) {
      minD = Math.min(minD, Math.hypot(L.seats[i].x - L.seats[j].x, L.seats[i].y - L.seats[j].y));
    }
  }
  ok(n === 1 || minD >= SEAT_BLOCK_W, 'n=' + n + '：两两中心最近距离 ' + (n === 1 ? '—' : minD.toFixed(0)) + ' ≥ 块宽 ' + SEAT_BLOCK_W);
}

/* ---------------------------- 4. 全部座位在块内 ---------------------------- */
console.log('\n[4] 不出块、不出屏');
for (let n = 1; n <= 5; n++) {
  const L = SeatRing.layout({ w: W, n });
  let inside = true, why = '';
  L.seats.forEach((s) => {
    const half = s.nmw / 2;
    if (s.x - half < 0 || s.x + half > L.w) { inside = false; why = 'x=' + s.x + ' nmw=' + s.nmw; }
  });
  ok(inside, 'n=' + n + '：座位块（含昵称）完整落在 ' + L.w + ' 宽内', why);
  ok(L.seats.every((s) => s.nmw >= 84 && s.nmw <= 120), 'n=' + n + '：昵称块宽被夹在 84~120');
  ok(L.seats.every((s) => s.y >= 20 && s.y <= L.h), 'n=' + n + '：座位纵向落在块内（顶部留 20 给头像上半圆）');
}

/* ---------------------------- 5. 纵向预算（与组槽争空间） ---------------------------- */
console.log('\n[5] 纵向预算');
{
  const L = SeatRing.layout({ w: W, n: 4 });
  ok(L.h === 466, ' 5 人局块高 h = 466（实测值，改大必须先重算组槽预算）', 'h=' + L.h);
  ok(L.h <= 470, 'h ≤ 470 —— 再多组槽就压到 530 以下，三组牌会撞到 56 宽下限');
  ok(L.me.y + SeatRing.MODES.portrait.meH <= L.h, '「我」那一格完整落在块内');
  ok(L.plaque.y > L.ring.cy - L.ring.ry && L.plaque.y < L.ring.cy + L.ring.ry, '中央状态牌在环内');
  ok(near(L.ring.rx / L.ring.ry, 1 / 0.615, 0.02), '环的宽高比保持 1 : 0.615（真实牌桌俯视比例）');
  /* 表情入口的中心点：88 半径 44，整个按钮必须落在块内 —— 出去会被 #game-top 裁掉一半 */
  ok(L.emoji.x + 44 <= L.w && L.emoji.x - 44 >= 0, '表情入口横向落在块内');
  ok(L.emoji.y + 44 <= L.h && L.emoji.y - 44 >= 0, '表情入口纵向落在块内');
  ok(L.emoji.y > L.me.y, '表情入口在「我」那一行之下（不压座位）');
  ok(L.felt.x >= 0 && L.felt.x + L.felt.w <= L.w, '毡面横向落在块内');
  ok(L.felt.y >= 0 && L.felt.y + L.felt.h <= L.h, '毡面纵向落在块内');
  /* 顶部座位块（高约 119）的上沿不能为负 —— 否则头像会被裁掉上半圆。
   * 必须**所有人数组**都验：5 人局最高的座位在 y≈83 看不出来，2 人局那个在 y≈62
   * 才是真正的边界情况（历史上就漏了这一档）。 */
  let worst = Infinity;
  for (const n of [1, 2, 3, 4, 5]) {
    const Ln = SeatRing.layout({ w: W, n });
    const topMost = Ln.seats.reduce((a, b) => (b.y < a.y ? b : a), Ln.seats[0]);
    worst = Math.min(worst, topMost.y);
    ok(topMost.y - 60 >= 0, 'n=' + n + '：最高座位的块上沿不出块（y=' + topMost.y + '）');
  }
}

/* 块宽不变时 h 与人数无关（h 只由 rx/ry 决定，座位多少不改块高）——
 * 否则人数一变整页牌面尺寸就跳一下，玩家会以为屏幕抖了。
 *
 * ★ v89 的唯一例外是 2 人局（n = 1）：它要多一条对战条，「我」下移 16，
 *   块高就得多 16。这是刻意的，不是回归 —— 所以这里只锁 3~5 人一致，
 *   并单独断言 2 人局正好多 16（多一个数就会在别处撞到裁切）。 */
{
  const hs = [2, 3, 4, 5].map((n) => SeatRing.layout({ w: W, n }).h);
  ok(new Set(hs).size === 1, '人数 3~5 时块高一致（不随人数跳动）', hs.join(','));
  const duelH = SeatRing.layout({ w: W, n: 1 }).h;
  ok(duelH - hs[0] === 16,
    '2 人局的块高就是基准 +16（对战条与「我」下移 16 的代价，多一个数都算错）',
    duelH + ' vs ' + hs[0]);
}

/* ---------------------------- 6. 边界与健壮性 ---------------------------- */
console.log('\n[6] 边界');
{
  const z = SeatRing.layout({ w: W, n: 0 });
  ok(z.seats.length === 0 && z.h === 466, 'n=0（房间里只有我）：无座位，块高不变');
  const many = SeatRing.layout({ w: W, n: 7 });
  ok(many.seats.length === 7 && many.seats.every((s) => isFinite(s.x) && isFinite(s.y)),
    '老 8 人房（7 个对手）：不产生 NaN');
  ok(many.arcSpacing < SeatRing.layout({ w: W, n: 4 }).arcSpacing,
    '人越多间距越小（7 人时最挤，说明 span 上限 224 起了作用）');
  const a = SeatRing.layout({ w: W, n: 4 });
  const b = SeatRing.layout({ w: W, n: 4 });
  ok(JSON.stringify(a) === JSON.stringify(b), '同参数两次调用结果完全一致（纯函数）');
  const narrow = SeatRing.layout({ w: 380, n: 4 });
  ok(narrow.ring.rx > 100 && narrow.seats.every((s) => s.x >= 0 && s.x <= narrow.w),
    '窄容器（380 宽）下环仍然成立，座位不越界');
}

/* ---------------------------- 6b. 横屏（左桌右盘，v88） ---------------------------- */
console.log('\n[6b] 横屏版式（landscape）');
{
  /* 横屏左栏的实际宽度：1624 设计宽 − 800px 列 − 26 gap…其实就是列宽 800，
   * 探针 scripts/probe-table.js 1024×768 量到 --gt-h=550，与这里一致。 */
  const L = SeatRing.layout({ w: 800, n: 4, mode: 'landscape' });
  ok(L.mode === 'landscape' && L.w === 800, 'mode 与宽度原样带回（调用方靠它写 CSS）');
  ok(L.h === 550, '横屏 5 人局块高 550（800 宽 → rx 340 / ry 209）', 'h=' + L.h);
  ok(L.ring.rx === 340 && L.ring.ry === 209, 'rx/ry 与竖屏同一套比例（0.615），只是 w 更大');
  ok(L.seats.length === 4 && L.seats.every((s) => s.x >= 0 && s.x <= 800),
    '座位都在 800 宽的块内');
  /* 座位块宽 112（头像 68 + 昵称 ≤120），最外侧座位的块边缘不能出界 */
  ok(L.seats.every((s) => s.x - s.nmw / 2 >= 0 && s.x + s.nmw / 2 <= 800),
    '最外侧座位的昵称块不出块边界（被裁的是文字中间，最难看）');
  ok(L.arcSpacing > 200, '横屏弧长间距 > 200（比竖屏的更松，人多了也压不住）',
    'arc=' + Math.round(L.arcSpacing));
  ok(L.emoji.x + 44 <= L.w && L.emoji.y + 44 <= L.h, '表情入口整块在块内');

  /* maxH：窄横屏 / 平板分屏时左栏会变矮，桌子必须自己缩回来。
   * 缩的是 rx（ry 跟着 ratio），不是只砍 ry —— 只砍 ry 会把桌子压成扁椭圆。 */
  const fit = SeatRing.layout({ w: 800, n: 4, mode: 'landscape', maxH: 460 });
  ok(fit.h <= 460, '给了 maxH 之后块高不超上限（' + fit.h + ' ≤ 460）');
  ok(fit.h >= 440, '但也不无谓地缩（贴着上限，不浪费空间）', 'h=' + fit.h);
  ok(near(fit.ring.ry / fit.ring.rx, 209 / 340, 0.02), 'maxH 缩回时仍保持椭圆比例（不是压成扁的）');
  ok(fit.seats.every((s) => s.x >= 0 && s.x <= 800), '缩回后座位仍在块内');

  /* maxH 给得比 padding 还小 → 不能算出负数或 NaN（真机上见过 rx 变 −12 的桌子） */
  const tiny = SeatRing.layout({ w: 800, n: 4, mode: 'landscape', maxH: 100 });
  ok(tiny.ring.rx > 0 && tiny.ring.ry > 0 && isFinite(tiny.h), 'maxH 不合理时仍返回正数几何（不死循环）');

  /* 横屏与竖屏同一人数下，座位数必须一致 —— 版式只该改尺寸，不该改规则 */
  ok(SeatRing.layout({ w: 800, n: 4, mode: 'landscape' }).seats.length
    === SeatRing.layout({ w: 670, n: 4, mode: 'portrait' }).seats.length,
  '同一人数在两种版式下座位数相同');
}

/* ---------------------- [6c] 紧凑竖屏（16:9 手机，v90） ---------------------- */
console.log('\n[6c] 紧凑竖屏（375×667 / 360×640）');
{
  const SlotLayout = require('../js/slotLayout.js');
  const M = SeatRing.MODES.portraitCompact;
  ok(!!M, '有 portraitCompact 这一档');
  ok(M.avatar === 56 && M.avatar < SeatRing.MODES.portrait.avatar, '头像 68 → 56（座位块跟着矮）');
  ok(near(M.ratio, 0.52, 0.001) && M.ratio < SeatRing.MODES.portrait.ratio,
    '椭圆压扁（0.615 → 0.52）—— 桌面变「横长」，不是缩成一颗小圆桌');

  /* ★ 这一档的全部意义在**高度账本**上，所以先算账再谈几何。
   * 16:9 手机的舞台设计高恒为 1334（750 × 667/375），与像素密度无关。 */
  const STAGE = 1334, PAD = 48, BOTTOM = 468;   // 留白 / 手牌+操作+组标签（探针实测）
  const hs = {};
  for (let n = 1; n <= 5; n++) hs[n] = SeatRing.layout({ w: W, n, mode: 'portraitCompact' }).h;
  ok(Object.keys(hs).every((n) => hs[n] === 404), '所有人数的块高都是 404（2 人局的对战条不再撑高）',
    JSON.stringify(hs));
  ok(hs[1] === hs[4], '2 人局与 5 人局同高（duelMeDy = 0，省下的 14px 正好是斗牛那 2 个像素的来源）');

  const avail = STAGE - PAD - (404 + 8) - BOTTOM;
  ok(avail === 406, '组槽可用高 406（探针实测 clientHeight 也是 406）', 'avail=' + avail);

  /* 文档 §11 对 3 张组的要求是 ≥110×154 —— 在这一档**算术上不可能**：
   * 那要组槽 518，也就是环 ≤ 292，比 404 再矮 112，桌子会缩成一颗小圆。
   * 所以这一档的验收线是「≥82×115，且斗牛 5 张明显优于被它替换掉的 v86（62×87）」。 */
  const maxH = SlotLayout.maxCardHeight(avail, true);
  ok(maxH >= 115, '三张组牌高预算 ' + maxH + ' ≥ 115', 'maxH=' + maxH);
  [1, 2, 3, 5].forEach(function (n) {
    const c = SlotLayout.cardSize(n, {
      dense: true, bandInnerW: 666, capW: 144, maxCardH: maxH,
      widthRatio: SlotLayout.ringWidthRatio(n), minW: SlotLayout.ringMinCardW(n)
    });
    ok(c.w >= 82 && c.h >= 115, n + ' 张组牌面 ' + c.w + '×' + c.h + ' ≥ 82×115');
  });
  ok(SlotLayout.RING_EXTRA_H_COMPACT === (404 + 8) - 194,
    'RING_EXTRA_H_COMPACT 与环高对得上（' + SlotLayout.RING_EXTRA_H_COMPACT + ' = 412 − 194）');

  /* 几何三件套：不出块、不互相压、不压中央牌。中央牌按紧凑档的**真实尺寸**算：
   * CSS 里 .rt-compact 把它缩到 300×~85（阶段 34 / 副标 16 / 进度 22）。 */
  const PW = 300, PH = 85, BLK_H = 107, BLK_W = 112;
  for (let n = 1; n <= 5; n++) {
    const L = SeatRing.layout({ w: W, n, mode: 'portraitCompact' });
    const inside = L.seats.every((x) => x.x - x.nmw / 2 >= 0 && x.x + x.nmw / 2 <= L.w);
    ok(inside, n + ' 个对手：座位块（含昵称）不出 ' + L.w + ' 宽');
    let minD = Infinity;
    for (let i = 0; i < L.seats.length; i++) {
      for (let j = i + 1; j < L.seats.length; j++) {
        minD = Math.min(minD, Math.hypot(L.seats[i].x - L.seats[j].x, L.seats[i].y - L.seats[j].y));
      }
    }
    ok(minD >= BLK_W, n + ' 个对手：两两中心最近 ' + (minD === Infinity ? '—' : Math.round(minD)) + ' ≥ 块宽 ' + BLK_W);
    const topEdge = Math.min.apply(null, L.seats.map((x) => x.y)) - BLK_H / 2;
    ok(topEdge >= 0, n + ' 个对手：顶部座位块上沿 ' + Math.round(topEdge) + ' ≥ 0（头像不被裁）');
    /* 中央牌 vs 座位：矩形相交。横向本来就允许压（环压扁后内圈座位离牌心 185），
     * 真正兜住的是纵向 —— 这条一旦红，真机上就是「头像压住『已提交 3/5』」。 */
    const hit = L.seats.filter((x) =>
      Math.abs(x.x - L.plaque.x) < PW / 2 + BLK_W / 2
      && Math.abs(x.y - L.plaque.y) < PH / 2 + BLK_H / 2);
    ok(hit.length === 0, n + ' 个对手：中央牌没压住任何座位', hit.map((x) => x.x + ',' + x.y).join(' '));
    ok(L.me.y >= L.felt.y + L.felt.h - 2, n + ' 个对手：「我」在毡面下沿之外');
    ok(L.emoji.x + 46 <= L.w && L.emoji.y + 46 <= L.h && L.emoji.y > L.me.y,
      n + ' 个对手：表情入口（92 设计px）整块在块内且在「我」之下');
    ok(L.plaque.y + PH / 2 < L.me.y, n + ' 个对手：中央牌不顶到「我」');
  }
}

/* ---------------------- [6d] 桌面宽横屏（1280×800 / 1024×768，v91） ---------------------- */
console.log('\n[6d] 桌面宽横屏（desktop）');
{
  const SlotLayout = require('../js/slotLayout.js');
  const M = SeatRing.MODES.desktop;
  ok(!!M, '有 desktop 这一档');
  ok(M.avatar === 80 && M.avatar > SeatRing.MODES.landscape.avatar,
    '头像 68 → 80（大窗口里桌子该更大，原型这一档给的是 86）');
  ok(M.ratio > SeatRing.MODES.landscape.ratio, 'ratio 0.615 → 0.66（纵向有余量，桌子更接近正圆）',
    'ratio=' + M.ratio);

  /* ★ 这一档的必要性不在几何本身，而在**右栏的高度账本**。
   * 1280×800：scale = 1280/1624 = 0.788 → 舞台设计高 1015（不是手机的 750）。
   * v88 的三行右栏把 chips 88 + 手牌 268 + 操作 88 全堆在右栏 → 组槽只剩 497，
   * 三张牌被高度卡成 105×147；同一窗口关闭圆桌时组槽有 770、牌 144×202。
   * v91 把这 444 挪进左栏桌下的第三行，组槽回到 591。 */
  const STAGE_H = 1015, PAD = 48, HAND = 268, BARS = 88, GAPS = 20;
  const slotsV88 = STAGE_H - PAD - (HAND + BARS * 2) - GAPS;      // 三行右栏
  const slotsV91 = STAGE_H - PAD - HAND - BARS - GAPS;            // 四区（chips/acts 进左栏）
  ok(slotsV91 - slotsV88 === 88, '四区比三行右栏多出整整一条 chips 的高度（+88）',
    slotsV88 + ' → ' + slotsV91);
  ok(slotsV91 >= 580, '组槽可用高 ' + slotsV91 + ' ≥ 580（探针实测 591）');

  const maxH = SlotLayout.maxCardHeight(slotsV91, true);
  ok(maxH >= 178, '三张组牌高预算 ' + maxH + ' ≥ 178（v88 是 147）', 'maxH=' + maxH);
  [1, 2, 3].forEach(function (n) {
    const c = SlotLayout.cardSize(n, {
      dense: true, bandInnerW: 714, capW: 144, maxCardH: maxH,
      widthRatio: SlotLayout.ringWidthRatio(n), minW: SlotLayout.ringMinCardW(n)
    });
    ok(c.w >= 110 && c.h >= 154, n + ' 张组牌面 ' + c.w + '×' + c.h + ' ≥ 110×154（文档 §11 这条线，v88 桌面档不达标）');
  });
  const d5 = SlotLayout.cardSize(5, {
    dense: true, bandInnerW: 714, capW: 144, maxCardH: maxH,
    widthRatio: SlotLayout.ringWidthRatio(5), minW: SlotLayout.ringMinCardW(5)
  });
  ok(d5.w >= 82 && d5.h >= 115, '斗牛 5 张 ' + d5.w + '×' + d5.h + ' ≥ 82×115');

  /* 几何：左栏 800 宽、块高 620，塞进 1015 高的左栏还有 300 余量给 chips 与操作条。 */
  const L = SeatRing.layout({ w: 800, n: 4, mode: 'desktop' });
  ok(L.h === 608, '桌面 5 人局块高 608（800 宽 → rx 348 / ry 230）', 'h=' + L.h);
  ok(L.ring.rx === 348 && L.ring.ry === 230, 'rx 仍由左栏宽度定（800 定死），只有 ratio 变大');
  ok(L.h + 88 + 88 <= 1015 - 48, '环 608 + chips 88 + 操作 88 ≤ 左栏 967（不会把 tag 条挤出格子）',
    (L.h + 176) + ' ≤ 967');

  const BLK_W = 136, BLK_H = 126;
  for (let n = 1; n <= 5; n++) {
    const G = SeatRing.layout({ w: 800, n, mode: 'desktop' });
    ok(G.seats.every((s) => s.x - s.nmw / 2 >= 0 && s.x + s.nmw / 2 <= 800),
      n + ' 个对手：座位块（含昵称 ≤132）不出 800 宽');
    let minD = Infinity;
    for (let i = 0; i < G.seats.length; i++) {
      for (let j = i + 1; j < G.seats.length; j++) {
        minD = Math.min(minD, Math.hypot(G.seats[i].x - G.seats[j].x, G.seats[i].y - G.seats[j].y));
      }
    }
    ok(minD >= BLK_W, n + ' 个对手：两两中心最近 ' + (minD === Infinity ? '—' : Math.round(minD)) + ' ≥ 块宽 ' + BLK_W);
    const topEdge = Math.min.apply(null, G.seats.map((s) => s.y)) - BLK_H / 2;
    ok(topEdge >= 0, n + ' 个对手：顶部座位块上沿 ' + Math.round(topEdge) + ' ≥ 0（头像不被裁）');
    ok(G.emoji.x + 44 <= G.w && G.emoji.y + 44 <= G.h, n + ' 个对手：表情入口整块在块内');
  }

  /* 分档判据与接线：stageH ≥ 1000 走 desktop，< 1000 走 narrow —— 同一条线，互补两支。 */
  const gj = readGameAll();
  const css = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');
  ok(/function ringDesktop\(\) \{[\s\S]{0,200}?lastStageH >= RING_MIN_LS_STAGE_H/.test(gj),
    'ringDesktop() 与 ringNarrow() 用同一条线（stageH 1000）的互补两支');
  ok(/classList\.toggle\('rt-desktop', isLandscape && ringDesktop\(\)\)/.test(gj),
    'renderTopBar 会把 rt-desktop 挂到 #screen-game 上');
  ok(/classList\.remove\('rt-desktop'\)/.test(gj), '回滚到 v86 时必须摘掉 .rt-desktop');
  ok(/\.ls #screen-game\.rt-narrow,\s*\.ls #screen-game\.rt-desktop \{/.test(css),
    'CSS 里两档共用同一条四区网格规则（不是复制一份）');
  ok(!/\.rt-desktop #slots\[data-twocol/.test(css),
    '★ 桌面档不走两列组槽（右栏 798 宽，三行各 190 比两列各 322 划算）');
}

/* ---------------------------- 7. 有没有被挂进页面 ---------------------------- */
console.log('\n[7] 接线（防止「写了没引用」)');
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  ok(/js\/seatRing\.js\?v=/.test(html), 'index.html 以带版本号的方式引用了 seatRing.js');
  ok(/\/js\/seatRing\.js/.test(sw), 'sw.js 的预缓存清单里有 seatRing.js');
  /* 只在 <script src> 里比先后 —— 全文 indexOf 会被注释里的「game.js」骗过去
   * （这个文件的大段注释里到处都在提 game.js）。 */
  const tagOrder = (name) => html.indexOf('<script src="./js/' + name + '.js?v=');
  ok(tagOrder('seatRing') > 0 && tagOrder('seatRing') < tagOrder('game'),
    'seatRing.js 的 <script> 排在 game.js 之前（game.js 是同步 IIFE，晚一步就 ReferenceError）');

  /* 矮屏守门：圆桌吃 264 设计px，16:9 手机的组槽扛不住（三组按最小牌高也要 308，
   * 扣完只剩 262）。没有这道闸，第三组会被裁进不可见滚动区 —— slotLayout 那个老 bug 复活。 */
  const gj = readGameAll();
  /* 竖屏两档：1200 是「有没有环」，1500 是「正常环还是紧凑环」。
   * 分开两条常量而不是一条 1500 的闸门，是因为 16:9 手机（设计高 1332）
   * 现在要**上环**（紧凑档），只是不再用 466 那一份几何。
   *
   * ★ v105：1200 这条从 game.js 搬到了 js/ringGate.js（连同横屏 700 与尺度下限）。
   *   这里改成「读模块的真实值 + 断言 game.js 真的把量交给它」——
   *   比原来那种 `/var RING_MIN_STAGE_H = 1200;/` 的字符串断言强，
   *   因为字符串断言在阈值被改成 1000 时照样绿（只要那行字还在）。 */
  const RingGate = require('../js/ringGate.js');
  ok(RingGate.MIN_STAGE_H.portrait === 1200, '有矮屏闸门 RingGate.MIN_STAGE_H.portrait = 1200');
  ok(/var RING_COMPACT_BELOW = 1500;/.test(gj), '有紧凑档分界 RING_COMPACT_BELOW = 1500');
  ok(/RingGate\.flag\(\{[\s\S]{0,120}?stageH: lastStageH/.test(gj),
    'seatRingFlag() 把 stageH 交给 RingGate 判定（矮于闸门时座位环不开，退回 v86 版式）');
  ok(/lastStageH = stageH;/.test(gj), 'resize() 会把舞台高记下来给闸门用');

  /* 横屏闸门（v87 一档 → v89 拆两档）：iPhone 横屏的设计高恒为 750（1624 × 高宽比），
   * v88 的三行右栏要装「手牌+操作」468 与三组 305（合计 831），装不下；
   * v89 换成四区 + 两列两行之后 750 够用。
   * v105 起横屏的尺度下限从 0.5 降到 0.44：0.5 那条守的是「表情入口 88×scale ≥ 44」，
   * 而 .gt-emo 现在接了 --tap-min，热区由构造保证 —— 阈值失去理由，改成按桌子本身定。 */
  ok(/var RING_MIN_LS_STAGE_H = 1000;/.test(gj), '平板横屏档 RING_MIN_LS_STAGE_H = 1000（三行右栏）');
  ok(RingGate.MIN_STAGE_H.landscape === 700, '窄横屏结构性闸门 RingGate.MIN_STAGE_H.landscape = 700（四区 + 两列）');
  ok(/RingGate\.flag\(\{[\s\S]{0,120}?landscape: isLandscape/.test(gj), '横屏不够高时座位环不开（判定在 RingGate）');
  ok(RingGate.MIN_SCALE === 0.44, '尺度下限 RingGate.MIN_SCALE = 0.44（800×360 的 0.48 进得来）');
  ok(/RingGate\.flag\(\{[\s\S]{0,160}?scale: lastStageScale/.test(gj),
    'scale 交给 RingGate 判定（667×375 = 0.411 仍不进）');
  ok(/lastStageScale = scale;/.test(gj), 'resize() 会把实际缩放记下来给尺度闸门用');
  /* 四档：横屏按设计高分两档（1015+ 宽横屏 / 750 窄横屏）、竖屏按高度分两档。 */
  ok(/mode: isLandscape\s*\? \(ringDesktop\(\) \? 'desktop' : 'landscape'\)\s*: \(ringCompact\(\) \? 'portraitCompact' : 'portrait'\)/.test(gj),
    'ringGeom 四档选版式（桌面宽横屏 / 窄横屏 / 紧凑竖屏 / 正常竖屏）');
  ok(/function ringCompact\(\) \{[\s\S]{0,160}?lastStageH < RING_COMPACT_BELOW/.test(gj),
    'ringCompact() 判据与闸门同源（都读 lastStageH）');
  ok(/classList\.toggle\('rt-compact'/.test(gj), '紧凑档把 .rt-compact 挂到顶栏上（CSS 靠它隔离）');
  ok(/classList\.remove\('rt-compact'\)/.test(gj), '回滚到 v86 时必须摘掉 .rt-compact（否则残留类会缩下一版式）');
  ok(/SlotLayout\.RING_EXTRA_H_COMPACT/.test(gj), '紧凑档用自己那份环吃掉的高度判 dense');

  /* 横屏的网格重排必须真的存在于 CSS —— 只改 JS 不改 CSS 的话，桌子会占满整宽、
   * 把组槽挤到 200 以下（这是 v88 第一次跑探针时的实际结果）。 */
  const css = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');
  ok(/\.ls #screen-game\.rt-ring \{[\s\S]{0,1600}?"top slots"\s+"top bottom"/.test(css),
    'CSS 有横屏「左桌右盘」网格（桌子跨两行、组槽与手牌进右栏）');
  ok(/\.ls #screen-game\.rt-ring\.is-ready \{[\s\S]{0,200}?"top ready"/.test(css),
    '准备态也用同一套网格（局内局外不跳版式）');
  /* 网格已改成上下两行之后，right 栏的 slots 与 bottom 不再共享行高，
   * 因此 bottom 必须按内容取高 —— 用 height:100% 会把 #hand 压扁（实测 91 高）。 */
  ok(/\.rt-ring \.game-bottom \{\s*height: auto;/.test(css), '横屏 bottom 按内容取高（不压扁手牌）');
}

/* ---------------------------- 8. v89 窄横屏：四区网格与两列组槽 ---------------------------- */
console.log('\n[8] 窄横屏（iPhone 横屏）四区网格 + 两列组槽');
{
  const gj = readGameAll();
  const css = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');

  /* 跨度表：两轮都必须是「两行」。值 = 占几列，没列出的组默认整行。
   * 这张表是 v89 的全部排版意图 —— 改错一个数字，牌面立刻从 104×146 掉回 64×90。 */
  const m = /var TWO_COL_SPAN = \{([\s\S]*?)\};/.exec(gj);
  ok(!!m, '有 TWO_COL_SPAN 表（本轮哪几组占几列）');
  if (m) {
    ok(/1:\s*\{\s*single:\s*1,\s*tenhalf:\s*1,\s*piaosanye:\s*2\s*\}/.test(m[1]),
      '第一轮：比大小｜十点半 各占 1 列、飘三叶整行（3 张要 328，半行只有 322）');
    ok(/2:\s*\{\s*single:\s*2,\s*douniu:\s*2\s*\}/.test(m[1]),
      '第二轮：比大小整行、斗牛整行（5 张要 552，半行绝无可能）');
  }

  /* 列间距必须两边一致：JS 用它算单元格宽、CSS 用它排版。只改一处会让牌比格子宽。 */
  const gapJs = /var TWO_COL_GAP = (\d+);/.exec(gj);
  ok(!!gapJs, '有两列间距常量 TWO_COL_GAP');
  ok(/\.rt-narrow #slots\[data-twocol="1"\] \{[\s\S]{0,260}?column-gap: 10px/.test(css),
    'CSS 的两列 column-gap 与 JS 常量一致（10px）', gapJs ? 'JS ' + gapJs[1] : '');
  if (gapJs) {
    ok(Number(gapJs[1]) === 10, 'TWO_COL_GAP 就是 10（不是随手写的另一个数）', gapJs[1]);
  }

  /* 四区网格：桌子跨两行、组槽与手牌进右栏、标签条与操作条落到底部一行。
   * v91 起 `.rt-desktop` 与它共用同一条规则（同一个网格，只差两列组槽与桌子几何），
   * 选择器是两个类并列 —— 断言里两个都要认，否则半边掉队没人发现。 */
  ok(/\.ls #screen-game\.rt-narrow,\s*\.ls #screen-game\.rt-desktop \{[\s\S]{0,700}?"chips acts"/.test(css),
    'CSS 有四区网格（"top slots" / "top hand" / "chips acts"）');
  ok(/\.rt-narrow \.game-bottom,\s*\.ls #screen-game\.rt-desktop \.game-bottom \{ display: contents; \}/.test(css),
    '★ .game-bottom 用 display:contents 让 chips/hand/actions 各自落到不同格子（不搬 DOM）');
  ok(/\.rt-narrow #group-chips,\s*\.ls #screen-game\.rt-desktop #group-chips \{ grid-area: chips/.test(css),
    '#group-chips 落到左下角');
  ok(/\.rt-narrow #hand,\s*\.ls #screen-game\.rt-desktop #hand \{ grid-area: hand/.test(css),
    '#hand 落到右栏第二行');
  ok(/\.rt-narrow \.game-actions,\s*\.ls #screen-game\.rt-desktop \.game-actions \{ grid-area: acts/.test(css),
    '操作条落到右下角');
  ok(/grid-template-rows: minmax\(0, 1fr\) auto auto/.test(css),
    '行高是「组槽吃弹性 + 手牌/操作按内容」——用 fr 会把 #hand 压扁（v88 踩过）');

  /* 半宽格子必须把组信息压成一行，否则「十点半 · 2张」折 3 行把行撑高 26px，
   * 第一轮组槽就溢出（352 > 326）。这一条是探针实测出来的，不是预防性写的。 */
  ok(/\.rt-narrow #slots\[data-twocol="1"\] \.slot\[data-span="1"\] \.slot-label \{ display: none; \}/.test(css),
    '半宽格子里藏组名（左下角标签条已有名字与计数）');
  ok(/\.rt-narrow #slots\[data-twocol="1"\] \.slot-meta-main \{ flex-wrap: nowrap/.test(css),
    '组信息不许折行（折行 = 撑高整行 = 组槽溢出）');

  /* 接线：档位判定 → 类名 → data 属性 → 行数 */
  ok(/function ringNarrow\(\) \{[\s\S]{0,160}?lastStageH < RING_MIN_LS_STAGE_H/.test(gj),
    'ringNarrow() 判定窄横屏档（700 ≤ 设计高 < 1000）');
  ok(/slotTwoCol = ringNarrow\(\) && seatRingFlag\(\)/.test(gj),
    '★ 只在圆桌真的开着时切两列（回滚不改排法）');
  ok(/classList\.toggle\('rt-narrow', isLandscape && ringNarrow\(\)\)/.test(gj),
    'renderTopBar 会把 rt-narrow 挂到 #screen-game 上');
  ok(/getAttribute\('data-twocol'\) !== twoWant/.test(gj), '组槽会写 data-twocol（CSS 靠它切网格）');
  ok(/maxCardHeight\(availH, slotDense, slotTwoCol \? 2 : 0\)/.test(gj),
    '★ 两列档按 2 行算牌高（传 3 会让牌一直按三行缩，白缩 26%）');
  ok(/slotCardSize\(count, span\)/.test(gj), 'renderSlots 把跨度传给 cardSize（半宽格按单元格宽均分）');
  ok(/span === 1\) bandW = Math\.floor\(\(bandW - TWO_COL_GAP\) \/ 2\)/.test(gj),
    '半宽格用单元格宽算牌宽（用整行宽会让 3 张牌挤出格子）');
}

/* ---------------------------- 9. 2 人局对战条 ---------------------------- */
console.log('\n[9] 2 人局对战条（单挑才画）');
{
  const one = SeatRing.layout({ w: W, n: 1 });
  const many = SeatRing.layout({ w: W, n: 4 });
  ok(!!one.vs, 'n=1（2 人局）给了 vs 坐标');
  ok(many.vs === null,
    'n=4（5 人局）没有 vs —— 那块地方要留给中央牌报「已提交 3/5」');
  if (one.vs) {
    ok(one.vs.h === 56, '对战条高 56 设计 px', one.vs.h);
    ok(one.plaque.y - many.plaque.y === 34, '2 人局中央牌下移 34（给条子腾缝）',
      String(one.plaque.y - many.plaque.y));
    ok(one.me.y - many.me.y === 16, '2 人局「我」下移 16', String(one.me.y - many.me.y));
    ok(one.h - many.h === 16, '★ 块高同步 +16（不然「我」会被 #game-top 裁掉）',
      String(one.h - many.h));
    /* 座位块半高 ≈60（头像 68 + 昵称 22 + 分数 25）。条子必须落在它下沿之外 */
    const seatBottom = one.seats[0].y + 60;
    ok(one.vs.y - one.vs.h / 2 > seatBottom, '条子在顶部座位下沿之外（不压头像）',
      (one.vs.y - one.vs.h / 2) + ' > ' + seatBottom);
    ok(one.vs.y + one.vs.h / 2 < one.plaque.y - 40, '条子在中央牌上沿之外（不压牌子）',
      (one.vs.y + one.vs.h / 2) + ' < ' + (one.plaque.y - 40));
    ok(one.vs.x === one.plaque.x, '条子与中央牌同一列（都在 cx）');
  }

  const gj = readGameAll();
  const css = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');
  ok(/function vsBarHtml/.test(gj), '有 vsBarHtml 渲染器');
  ok(/html \+= vsBarHtml\(room, me, g\)/.test(gj), 'ringTopHtml 会把对战条画进顶栏');
  ok(/分差 <b>/.test(gj), '对战条上有「分差」这个数（这才是单挑唯一要紧的数字）');
  ok(/Math\.abs\(ms - os\)/.test(gj), '分差取绝对值（落后时不显示负数）');
  ok(/\.gt-vs \{/.test(css) && /\.gt-vs \.vs-mid/.test(css), 'CSS 有 .gt-vs 与它的中段');
}

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
