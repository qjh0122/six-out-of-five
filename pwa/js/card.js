/**
 * 牌模型工具：一副 54 张牌（52 + 大王 + 小王）、洗牌、发牌、Canvas 绘制牌面（牌背）。
 * 与 engine.js 共享同一牌数据结构：
 *   card = { suit: 'joker', rank: 15 | 14.5 }        ← 大王 / 小王
 *   card = { suit: 'spade'|'heart'|'club'|'diamond', rank: 2..14 }
 *   rank: 11=J, 12=Q, 13=K, 14=A, 15=大王(suit='joker')
 *
 * ★ 小王为什么用 rank 14.5 而不是新花色：两张王的功能完全一样（都是万能牌），
 *   引擎里所有「这是不是王」的判断都写成 `suit === 'joker'`，加起来二十多处。
 *   给小王另起一个花色（joker2）意味着每一处都要拆成两个判断，漏一处就是
 *   「小王当不了赖子」的静默 bug。共用一个花色、只让 rank 差半个点，
 *   则「是不是王」的判定一个字都不用动 —— **大小王都在 14 以上时功能自动一致**。
 *   14.5 这半个点也不是随手取的：A 占着 14、大王占着 15，小王必须严格落在
 *   两者之间（用 14 会和 A 撞，比花色时 joker 不在 SUIT_ORDER 里，反而比真牌小）。
 */
(function (global, factory) {
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = mod;
  } else {
    global.Card = mod;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SUITS = ['spade', 'heart', 'club', 'diamond'];
  var SUIT_SYMBOL = { spade: '\u2660', heart: '\u2665', club: '\u2663', diamond: '\u2666' };
  var SUIT_COLOR = { spade: '#1A1D23', heart: '#D62828', club: '#1A1D23', diamond: '#D62828' };
  var RANK_LABEL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

  /* 大小王的 rank：两个都 > 14，靠大小分先后 */
  var BIG_JOKER_RANK = 15;
  var SMALL_JOKER_RANK = 14.5;

  function rankLabel(rank) { return RANK_LABEL[rank] || String(rank); }
  function isJoker(card) { return card.suit === 'joker'; }
  function isBigJoker(card) { return isJoker(card) && card.rank >= BIG_JOKER_RANK; }
  function isSmallJoker(card) { return isJoker(card) && card.rank < BIG_JOKER_RANK; }

  function createDeck() {
    var deck = [];
    for (var s = 0; s < SUITS.length; s++) {
      for (var r = 2; r <= 14; r++) {
        deck.push({ suit: SUITS[s], rank: r });
      }
    }
    deck.push({ suit: 'joker', rank: BIG_JOKER_RANK });     // 大王
    deck.push({ suit: 'joker', rank: SMALL_JOKER_RANK });   // 小王
    return deck;
  }

  /* 取 [0, n) 的随机整数。
   *
   * 为什么不用 Math.random：发牌由**服务端**执行，牌序是这局唯一的秘密。
   * Math.random 是可预测的伪随机（V8 是 xorshift128+，拿到足够输出就能反推状态），
   * 理论上能算出别人手里是什么牌。这里改用系统随机源，拿不到才退回 Math.random
   * （老浏览器 / 极端环境），失败方向是「和以前一样」，不会打不开页面。
   *
   * 用拒绝采样而不是直接取模：`rnd % n` 在 n 不整除 2^32 时会让小的下标概率偏高，
   * 52 张牌偏一点点也是可测的。 */
  function randInt(n) {
    if (n <= 1) return 0;
    try {
      var c = (typeof globalThis !== 'undefined' && globalThis.crypto) ||
              (typeof crypto !== 'undefined' ? crypto : null);
      if (c && c.getRandomValues) {
        var buf = new Uint32Array(1);
        var limit = Math.floor(4294967296 / n) * n;
        for (var k = 0; k < 64; k++) {
          c.getRandomValues(buf);
          if (buf[0] < limit) return buf[0] % n;
        }
      }
      /* Node 端（服务端发牌）走 randomInt，同样是无偏的 */
      if (typeof require === 'function') {
        var nc = require('crypto');
        if (nc && nc.randomInt) return nc.randomInt(n);
      }
    } catch (e) { /* 落到下面的兜底 */ }
    return Math.floor(Math.random() * n);
  }

  /* Fisher-Yates 洗牌 */
  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = randInt(i + 1);
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  function cardId(card) { return card.suit + '-' + card.rank; }
  function cardEqual(a, b) { return a.suit === b.suit && a.rank === b.rank; }
  function sortCardsDesc(cards) {
    var ORDER = { spade: 4, heart: 3, club: 2, diamond: 1 };
    return cards.slice().sort(function (a, b) {
      if (a.rank !== b.rank) return b.rank - a.rank; // 大王 15 / 小王 14.5，自然排最前
      return (ORDER[b.suit] || 0) - (ORDER[a.suit] || 0);
    });
  }

  /* ------------------------- Canvas 绘制牌面 ------------------------- */
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* 大王牌面：暖白纸底 + 中央彩色小丑 + 左上/右下红黑 JOKER 角标。
   * 尽量贴近现实扑克的大王：尖顶铃铛帽 + 圆脸彩妆小丑 + 彩色衣服，
   * 左上「JOKER」红字、右下「JOKER」黑字（斜对角，符合常见牌面）。 */
  /* 大王 / 小王共用一套画法，只换调色板。
   * 大王 = 彩色（红蓝 + 金铃铛），小王 = 黑白（墨黑 + 中灰）—— 这是现实扑克的区分方式，
   * 也是玩家一眼能认出来的方式。牌面尺寸只有 96~140px，再塞「大王/小王」四个字会糊，
   * 所以身份靠配色 + 结算面板上的牌名（cardLabel）两处一起交代。 */
  var JOKER_PALETTE_BIG = {
    main: '#D62828', alt: '#1A6BB0', gold: '#F5C15C', goldLine: '#B47F22',
    dark: '#7A4B00', face: '#FFF8EE', faceLine: '#C9B28A'
  };
  var JOKER_PALETTE_SMALL = {
    main: '#2E2E2E', alt: '#8C8C8C', gold: '#C4C4C4', goldLine: '#9A9A9A',
    dark: '#5A5A5A', face: '#FAFAFA', faceLine: '#C0C0C0'
  };
  function drawJoker(ctx, w, h, small) {
    var P = small ? JOKER_PALETTE_SMALL : JOKER_PALETTE_BIG;
    var cMain = P.main, cAlt = P.alt, cGold = P.gold, cGoldLine = P.goldLine;
    var cDark = P.dark, cFace = P.face, cFaceLine = P.faceLine;
    var cInk = '#1A1D23';
    /* 腮红 / 嘴 / 鼻只有大王上色：小王是黑白牌，带红点会立刻「认错牌」。 */
    var cCheek = small ? 'rgba(90,90,90,0.30)' : 'rgba(214,40,40,0.5)';
    var cMouth = small ? '#555555' : '#BB3333';
    var cNose = small ? '#777777' : '#E0563E';
    var r = Math.max(4, Math.round(w * 0.08));
    roundRect(ctx, 0, 0, w, h, r);

    // 暖白纸底（与普通牌一致，保证整副牌风格统一）
    var bg = ctx.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, '#FFFFFF');
    bg.addColorStop(1, '#F4F1E8');
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.lineWidth = Math.max(1, Math.round(w * 0.012));
    ctx.strokeStyle = '#D9D9D9';
    ctx.stroke();

    var cx = w * 0.5, cy = h * 0.52;
    var u = w * 0.01; // 相对单位，便于按牌尺寸缩放

    /* ---- 中央彩色小丑 ---- */
    // 身体：彩色上衣（红蓝对半，与帽子呼应）
    ctx.fillStyle = cMain;
    ctx.beginPath();
    ctx.moveTo(cx - 26 * u, h * 0.86);
    ctx.lineTo(cx - 14 * u, cy + 6 * u);
    ctx.lineTo(cx, cy + 6 * u);
    ctx.lineTo(cx, h * 0.86);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = cAlt;
    ctx.beginPath();
    ctx.moveTo(cx, h * 0.86);
    ctx.lineTo(cx, cy + 6 * u);
    ctx.lineTo(cx + 14 * u, cy + 6 * u);
    ctx.lineTo(cx + 26 * u, h * 0.86);
    ctx.closePath();
    ctx.fill();

    // 上衣下摆横条装饰
    ctx.fillStyle = cDark;
    ctx.fillRect(cx - 26 * u, h * 0.80, 52 * u, 3 * u);

    // 头：白脸圆
    ctx.fillStyle = cFace;
    ctx.beginPath();
    ctx.arc(cx, cy - 2 * u, 20 * u, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1.5 * u;
    ctx.strokeStyle = cFaceLine;
    ctx.stroke();

    // 眼睛：两个黑点
    ctx.fillStyle = cInk;
    ctx.beginPath();
    ctx.arc(cx - 7 * u, cy - 6 * u, 2.4 * u, 0, Math.PI * 2);
    ctx.arc(cx + 7 * u, cy - 6 * u, 2.4 * u, 0, Math.PI * 2);
    ctx.fill();

    // 腮红：两团红
    ctx.fillStyle = cCheek;
    ctx.beginPath();
    ctx.arc(cx - 11 * u, cy + 1 * u, 3.5 * u, 0, Math.PI * 2);
    ctx.arc(cx + 11 * u, cy + 1 * u, 3.5 * u, 0, Math.PI * 2);
    ctx.fill();

    // 嘴巴：上翘微笑弧线
    ctx.strokeStyle = cMouth;
    ctx.lineWidth = 2 * u;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, cy + 1 * u, 6 * u, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();

    // 鼻子：小红圆
    ctx.fillStyle = cNose;
    ctx.beginPath();
    ctx.arc(cx, cy - 2 * u, 2.6 * u, 0, Math.PI * 2);
    ctx.fill();

    // 尖顶帽：左红右蓝，帽顶一个铃铛球
    ctx.fillStyle = cMain;
    ctx.beginPath();
    ctx.moveTo(cx - 20 * u, cy - 14 * u);
    ctx.lineTo(cx, cy - 38 * u);
    ctx.lineTo(cx + 20 * u, cy - 14 * u);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = cAlt;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 38 * u);
    ctx.lineTo(cx + 20 * u, cy - 14 * u);
    ctx.lineTo(cx + 8 * u, cy - 14 * u);
    ctx.closePath();
    ctx.fill();

    // 帽顶铃铛球（一个，挂在帽尖正中）
    ctx.fillStyle = cGold;
    ctx.beginPath();
    ctx.arc(cx, cy - 40 * u, 4.5 * u, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1 * u;
    ctx.strokeStyle = cGoldLine;
    ctx.stroke();

    // 帽檐
    ctx.fillStyle = cDark;
    ctx.fillRect(cx - 21 * u, cy - 15 * u, 42 * u, 3 * u);

    // 领结（下巴下方，蓝色蝴蝶结）
    ctx.fillStyle = cAlt;
    ctx.beginPath();
    ctx.moveTo(cx, cy + 8 * u);
    ctx.lineTo(cx - 6 * u, cy + 5 * u);
    ctx.lineTo(cx - 6 * u, cy + 11 * u);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx, cy + 8 * u);
    ctx.lineTo(cx + 6 * u, cy + 5 * u);
    ctx.lineTo(cx + 6 * u, cy + 11 * u);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy + 8 * u, 2 * u, 0, Math.PI * 2);
    ctx.fill();

    /* ---- 左上角标：红色 JOKER ---- */
    ctx.fillStyle = cMain;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = 'bold ' + Math.round(w * 0.15) + 'px system-ui, sans-serif';
    ctx.fillText('JOKER', w * 0.06, h * 0.05);

    /* ---- 右下角标：黑色 JOKER（旋转 180°，与左上斜对角） ---- */
    ctx.save();
    ctx.translate(w, h);
    ctx.rotate(Math.PI);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = cInk;
    ctx.font = 'bold ' + Math.round(w * 0.15) + 'px system-ui, sans-serif';
    ctx.fillText('JOKER', w * 0.06, h * 0.05);
    ctx.restore();

    // 30° 半透明白高光斜条（塑封光泽，与普通牌一致）
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
    ctx.globalAlpha = 0.10;
    ctx.fillStyle = '#FFFFFF';
    ctx.translate(w * 0.5, h * 0.5);
    ctx.rotate(-Math.PI / 6);
    ctx.fillRect(-w, -h * 0.14, w * 2.6, h * 0.16);
    ctx.restore();
  }

  /**
   * 绘制一张牌到 canvas 并返回 dataURL。
   * 普通牌：暖白纸感渐变底 + 左上/右下点数花色 + 中央大花色水印与高光斜条。
   */
  function drawCardDataURL(card, w, h) {
    var canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d');

    if (isJoker(card)) {
      drawJoker(ctx, w, h, isSmallJoker(card));
      return canvas.toDataURL('image/png');
    }

    var r = Math.max(4, Math.round(w * 0.08));
    roundRect(ctx, 0, 0, w, h, r);

    // 纸感：极淡暖渐变
    var bg = ctx.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, '#FFFFFF');
    bg.addColorStop(1, '#F4F1E8');
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.lineWidth = Math.max(1, Math.round(w * 0.012));
    ctx.strokeStyle = '#D9D9D9';
    ctx.stroke();

    var color = SUIT_COLOR[card.suit];
    var sym = SUIT_SYMBOL[card.suit];
    var label = rankLabel(card.rank);

    // 中央大花色水印（4% 透明度、同色、错位，制造印刷层次）
    ctx.save();
    ctx.globalAlpha = 0.04;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = Math.round(w * 0.60) + 'px system-ui, sans-serif';
    ctx.fillText(sym, w * 0.5 + w * 0.03, h * 0.52 + h * 0.03);
    ctx.restore();

    // 中央大花色主符号
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = Math.round(w * 0.52) + 'px system-ui, sans-serif';
    ctx.fillText(sym, w * 0.5, h * 0.52);

    // 左上 / 右下角标（点数 + 花色竖排）
    ctx.fillStyle = color;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.font = 'bold ' + Math.round(w * 0.24) + 'px system-ui, sans-serif';
    ctx.fillText(label, w * 0.08, h * 0.05);
    ctx.font = Math.round(w * 0.22) + 'px system-ui, sans-serif';
    ctx.fillText(sym, w * 0.08, h * 0.30);

    ctx.save();
    ctx.translate(w, h);
    ctx.rotate(Math.PI);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = 'bold ' + Math.round(w * 0.24) + 'px system-ui, sans-serif';
    ctx.fillText(label, w * 0.08, h * 0.05);
    ctx.font = Math.round(w * 0.22) + 'px system-ui, sans-serif';
    ctx.fillText(sym, w * 0.08, h * 0.30);
    ctx.restore();

    // 30° 半透明白高光斜条（塑封光泽）
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
    ctx.globalAlpha = 0.10;
    ctx.fillStyle = '#FFFFFF';
    ctx.translate(w * 0.5, h * 0.5);
    ctx.rotate(-Math.PI / 6);
    ctx.fillRect(-w, -h * 0.14, w * 2.6, h * 0.16);
    ctx.restore();

    return canvas.toDataURL('image/png');
  }

  /* 牌背：深蓝底 + 内框花纹（纯代码，无需图片资源） */
  function drawCardBackDataURL(w, h) {
    var canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d');
    var r = Math.max(4, Math.round(w * 0.08));
    roundRect(ctx, 0, 0, w, h, r);
    ctx.fillStyle = '#1f4b8f';
    ctx.fill();
    ctx.lineWidth = Math.max(1, Math.round(w * 0.012));
    ctx.strokeStyle = '#123059';
    ctx.stroke();

    var pad = Math.round(w * 0.12);
    roundRect(ctx, pad, pad, w - pad * 2, h - pad * 2, r);
    ctx.strokeStyle = '#d8c88a';
    ctx.lineWidth = Math.max(1, Math.round(w * 0.02));
    ctx.stroke();

    ctx.fillStyle = '#d8c88a';
    ctx.beginPath();
    var cx = w / 2, cy = h / 2, s = Math.round(w * 0.22);
    ctx.moveTo(cx, cy - s);
    ctx.lineTo(cx + s, cy);
    ctx.lineTo(cx, cy + s);
    ctx.lineTo(cx - s, cy);
    ctx.closePath();
    ctx.fill();

    return canvas.toDataURL('image/png');
  }

  return {
    SUITS: SUITS,
    SUIT_SYMBOL: SUIT_SYMBOL,
    SUIT_COLOR: SUIT_COLOR,
    RANK_LABEL: RANK_LABEL,
    rankLabel: rankLabel,
    isJoker: isJoker,
    isBigJoker: isBigJoker,
    isSmallJoker: isSmallJoker,
    BIG_JOKER_RANK: BIG_JOKER_RANK,
    SMALL_JOKER_RANK: SMALL_JOKER_RANK,
    createDeck: createDeck,
    shuffle: shuffle,
    cardId: cardId,
    cardEqual: cardEqual,
    sortCardsDesc: sortCardsDesc,
    drawCardDataURL: drawCardDataURL,
    drawCardBackDataURL: drawCardBackDataURL
  };
});
