/**
 * 圆桌「上不上」的闸门（纯函数，不碰 DOM）
 *
 * 为什么单独成文件：v87–v104 这段判定一直散在 game.js 的 seatRingFlag() 里，
 * 五条阈值（1200 / 700 / 0.47 / 0.5 / 1000）挤在同一个 if 里，只能靠**读源码字符串**
 * 的断言来守（seat-ring.test.js 里 `var RING_MIN_SCALE = 0.5;` 这类）。
 * 字符串断言证明不了判定对不对，只证明「这行字还在」。抽出来之后，
 * 每一条机型落在哪一档是可以直接跑的表。
 *
 * ★ v105 的两处改动，都是为了「iPhone / 安卓横屏 / 电脑」三族真的能用：
 *
 *   1. **触摸尺度闸门（scale ≥ 0.5）撤销**。它原本守的是「表情入口 88 设计px
 *      × scale ≥ 44 CSS」这一件事 —— 而 v105 把 .gt-emo 接上了 --tap-min，
 *      热区由构造保证 ≥44，这条阈值的**唯一理由**就没有了。
 *      代价是 800×360（scale 0.48）以前被它挡在门外：安卓横屏最常见的那一档
 *      根本没有桌子。现在放进来了。
 *
 *   2. 下限改为 **0.44**，理由从「热区」换成「这张桌子还看不看得出是一张桌子」：
 *      0.44 时牌 104×146 设计px → 46×64 CSS（与不上桌时同一个尺寸，不亏），
 *      头像 68 → 30 CSS。再往下（667×375 = 0.411）座位块只有 46 CSS 宽，
 *      而一个带昵称的块要 112 设计px —— 名字必定被截成两三个字，那不是「支持」。
 *
 * ★ 没变的：两条结构性闸门。竖屏 1200（4:3 平板竖屏的设计高只有 1000，
 *   组槽放不下）、横屏 700（四区网格要 761，758 的预算装不进 692 的右栏）。
 *   这两条是几何事实，不随尺度走。
 *
 * ★ 首帧放行：scale / stageH 还没算出来时返回 true。返回 false 会让第一次渲染
 *   走 v86 版式，第二次 resize 再换成圆桌 —— 用户看到的是一进牌桌闪一下。
 */
(function (global, factory) {
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = mod;
  } else {
    global.RingGate = mod;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 结构性闸门：设计高分档。竖屏 1200 / 横屏 700，见文件头的说明。 */
  var MIN_STAGE_H = { landscape: 700, portrait: 1200 };

  /* 绝对下限：低于这个缩放，桌子整体小到失去意义（见文件头第 2 条）。
   * 0.44 正好卡在「800×360 的 0.48 之上、667×375 的 0.411 之下」。 */
  var MIN_SCALE = 0.44;

  /* 竖版版式的最低高宽比 = 1000 / 750。
   *
   * 竖版的设计宽固定 750，所以竖版画布的设计高是**算出来的**：
   *   设计高 = 视口高 / (视口宽 / 750) = 750 × 高宽比
   * 竖版首页与牌桌要 ≥1000 设计px 才装得下，于是「高宽比 ≥ 1000/750」就是
   * 竖版版式的成立前提。
   *
   * 桌面把窗口拉成窄高（左右分屏）时高宽比只有 1.0~1.3 —— 竖版必然溢出
   * （960×1040 实测组槽溢出 195 设计px、牌面缩到 60×84 全场最小）。
   * 这类窗口改走横向版式。 */
  var PORTRAIT_MIN_RATIO = 1000 / 750;

  /* 走横向版式（.ls）吗？
   *
   *   w ≥ h            → 横屏 / 桌面宽窗口
   *   高宽比 < 1.333   → 窄高的桌面窗口（左右分屏），竖版装不下
   *
   * ★ 为什么不写 `w >= 900` 这类绝对阈值：那样会连带改判平板竖屏（1024 宽），
   *   而平板竖屏是**明确不支持**的一档。用派生量做判据，手机与平板一个都不改判：
   *     iPhone 竖 390/844 = 2.16 ✓竖版   iPad 竖 768/1024 = 4/3（恰在等号）✓竖版
   *     iPad Pro 竖 1024/1366 = 1.334 ✓竖版   Pixel 7 竖 412/915 = 2.22 ✓竖版
   *   全部手机竖屏的高宽比都 ≥1.6，离 1.333 有足够余量。 */
  function isLandscape(w, h) {
    w = Number(w) || 0;
    h = Number(h) || 0;
    if (!(w > 0) || !(h > 0)) return false;
    return w >= h || (h / w) < PORTRAIT_MIN_RATIO;
  }

  /* 判定。opt = { landscape, stageH, scale }
   *   landscape —— 是否走横向版式（game.js 的 isLandscapePhone，由本文件的 isLandscape() 给）
   *   stageH    —— 舞台设计高（resize 里算的 lastStageH）
   *   scale     —— 舞台缩放（lastStageScale）
   * 返回 true = 上圆桌。 */
  function flag(opt) {
    opt = opt || {};
    var stageH = Number(opt.stageH) || 0;
    var scale = Number(opt.scale) || 0;
    /* 首帧：还没量出来，先放行（理由见文件头） */
    if (!(stageH > 0)) return true;
    if (stageH < (opt.landscape ? MIN_STAGE_H.landscape : MIN_STAGE_H.portrait)) return false;
    /* scale 为 0 时只跳尺度这一条：高度已经够、缩放没量到，不该因此判死 */
    if (scale > 0 && scale < MIN_SCALE) return false;
    return true;
  }

  /* 为什么没上桌。只给 DIAG 面板与探针用 —— 玩家侧不显示，
   * 但「为什么这台机器没有桌子」是这一块最常被问的问题，得有一处能答。 */
  function explain(opt) {
    opt = opt || {};
    var stageH = Number(opt.stageH) || 0;
    var scale = Number(opt.scale) || 0;
    if (!(stageH > 0)) return 'first-paint';
    var need = opt.landscape ? MIN_STAGE_H.landscape : MIN_STAGE_H.portrait;
    if (stageH < need) return 'stage-h ' + Math.round(stageH) + '<' + need;
    if (scale > 0 && scale < MIN_SCALE) return 'scale ' + Math.round(scale * 1000) / 1000 + '<' + MIN_SCALE;
    return 'ok';
  }

  return {
    MIN_STAGE_H: MIN_STAGE_H,
    MIN_SCALE: MIN_SCALE,
    PORTRAIT_MIN_RATIO: PORTRAIT_MIN_RATIO,
    isLandscape: isLandscape,
    flag: flag,
    explain: explain
  };
});
