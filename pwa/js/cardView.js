/**
 * 牌面与牌型的「呈现层」：尺寸常量、牌型配色、牌面 DOM / HTML、飞牌动效
 *
 * ── 为什么单独成文件 ────────────────────────────────────────────────
 * 这一块是「所有屏都要用、但没有任何屏拥有它」的公共渲染：手牌区要牌面、
 * 组槽要牌面、结算卡要迷你牌面、飞牌动效要尺寸。它原来散在 game.js 的
 * 143~304 行和 2618 行，中间隔着两千多行不相干的东西。
 *
 * ── 两个必须说明的边界 ──────────────────────────────────────────────
 * ① **牌型判定不在这里。** `slotTypeOf` 只转发到 `Engine`，前端绝不重算 ——
 *    全仓只有一份规则实现（engine.js），王万能的解析择优也在那边。
 *    原型曾用 `r.t === 9` 这种裸数字，把牛 9 当成牛牛（随机 800 组里 18.5%）。
 *
 * ② **尺寸常量是设计常量，不是运行时测量。** `HAND_CARD_W` / `SLOT_CARD_W`
 *    是上限值，实际用多少由 `slotCardSize()` 按张数与可用高度现算 ——
 *    那部分在 game.js 里（它要读版式），不在这。
 *
 * ── 注入 ──────────────────────────────────────────────────────────
 * 只注入两个「本模块被调用时才需要、创建时还不存在」的函数：
 *   stageScale      —— 飞牌定位要用当前缩放（在 resize 里维护）
 *   onHandCardTap   —— 手牌点击（交互层）
 * 其余依赖（CONFIG / Engine / StateMachine / Card）都是全局，直接读。
 *
 * 浏览器全局：`window.LXW.cardView`
 */
(function (global) {
  'use strict';

  function create(deps) {
    deps = deps || {};
    var api = {};

    /* ---------------------------- 尺寸常量 ----------------------------
     * ★ 必须逐条写 `var`。它们是**常量**，不是赋值语句：
     *   漏掉 var 在严格模式下直接 TypeError（目录里的 'use strict' 是真的生效的），
     *   而 `node --check` 只查语法，看不出这个问题 —— 要等浏览器跑到这里才炸。 */
    var HAND_CARD_W = 168;                   // 手牌（扇形放大）
    var HAND_CARD_H = 236;
    var SLOT_CARD_W = 144;                   // 组槽内（上界：张数少的一组就用这个尺寸）
    var SLOT_CARD_H = 202;
    var MINI_CARD_W = 88;                    // 结算迷你牌面
    var MINI_CARD_H = 124;

    /* 手牌区可用宽度（确定性设计常量，零运行时测量）。
     * 与 style.css 的 --screen-pad-x: 40px 保持同一来源：750 - 40×2 = 670 设计px。 */
    var SCREEN_PAD_X = 40;
    var HAND_AREA_W = CONFIG.DESIGN_WIDTH - SCREEN_PAD_X * 2;

    /* ---------------------------- 组槽色彩编码（v2 定稿） ---------------------------- */
    var SLOT_COLOR = {
      single:    { hex: '#3D7EA6', soft: 'rgba(61,126,166,0.40)' },
      tenhalf:   { hex: '#F5C15C', soft: 'rgba(245,193,92,0.40)' },
      piaosanye: { hex: '#D65A5A', soft: 'rgba(214,90,90,0.40)' },
      douniu:    { hex: '#8A6BC7', soft: 'rgba(138,107,199,0.40)' }
    };
    var SLOT_SHORT_LABEL = { single: '比大小', tenhalf: '十点半', piaosanye: '飘三叶', douniu: '斗牛' };
    /* 标签条上的名字比槽位标题更短：四个标签要挤在一行 670 设计px 里 */
    var CHIP_LABEL = { single: '单张', tenhalf: '十点半', piaosanye: '飘三叶', douniu: '斗牛' };
    var SLOT_BADGE = { single: '\u2460', tenhalf: '\u2461', piaosanye: '\u2462', douniu: '\u2463' }; // ① ② ③ ④
    /* 每组一句话规则（桌带右下角的补充说明）：
     * 桌带吃满宽度之后右边本来是一片没来由的空白，用「这组怎么算赢」填上 ——
     * 新玩家不用翻规则页，老玩家也当提醒。文案与规则页保持一致，只取最短的一句。 */
    var SLOT_HINT = {
      single: '大王最大 · 同点比花色',
      tenhalf: '最接近 10.5 · 超了爆牌',
      piaosanye: '豹子 > 同花顺 > 同花 > 顺子',
      douniu: '三张凑 10 · 五花牛最大'
    };

    /* 大牌型（结算弹窗斜纹横幅）：豹子 / 同花顺 / 牛牛 / 五花牛 / 十点半 10.5 */
    var BIG_TYPES = ['豹子', '同花顺', '牛牛', '五花牛', '10.5点'];

    /* 牌型特写（v83）。键是**引擎 typeName 输出的原字符串**，不是自己判出来的牌型：
     * 规则只该有一份实现，这里只负责「这个名字用什么颜色、点什么动画」。
     * 键写错的最坏结果是少一段动画（走 BIG_TYPES 的静态横幅），不会算错输赢。
     *   color = 粒子色 / ring = 爆开时那一圈光晕
     *
     * ★ color 必须按「浅底上也看得见」来选，不能直接用原型那套高亮色。
     *   原型特效铺在深绿毡面上，浅金色很跳；结算弹窗是暖白底（#FFF7E8），
     *   #FFD978 打上去几乎是白的 —— 第一次截图里 12 颗粒子一颗都看不出来。
     *   所以这里统一用**深一档的同色系**，ring 保持半透明（它只在暗底上起作用）。 */
    var BIG_FX = {
      '豹子': { kind: 'bz', color: '#E0572B', ring: 'rgba(224,87,43,0.50)' },
      '同花顺': { kind: 'st', color: '#B8862B', ring: 'rgba(184,134,43,0.45)' },
      '牛牛': { kind: 'nn', color: '#B8862B', ring: 'rgba(184,134,43,0.45)' },
      '五花牛': { kind: 'wh', color: '#8B5CC7', ring: 'rgba(139,92,199,0.45)' },
      '10.5点': { kind: 'jh', color: '#1F8A66', ring: 'rgba(31,138,102,0.45)' }
    };

    /* ---------------------------- 组槽实时牌型（v92） ----------------------------
     * 放满就报牌型，不等结算。以前组槽只有「n/n 进度」，玩家把五张牌放进斗牛组之后
     * 要到结算弹窗才知道自己是牛几 —— 中间那段没有任何反馈，只能凭自己心算。
     *
     * 为什么只给飘三叶和斗牛：
     *   · 十点半已经在 slot-point 里实时报点数与爆不爆（这一组的牌型本身就是点数）；
     *   · 单张组只有一张牌，牌面就是答案，再贴一个胶囊是重复。
     * 这两组恰好是「组合成型」的玩法：三张/五张放齐之前说什么都没意义，
     * 放齐那一刻才是玩家最想知道「这是什么牌」的时候。
     *
     * ★ 判定一律走 Engine，本文件不重算牌型。全仓只有一份规则实现（engine.js），
     *   王万能的解析择优也在那边 —— 前端复算一次，口径迟早会和结算对不上。
     *
     * ★ 只在**放满**时报：飘三叶放 1 张必然判成「散牌」，报出来是噪音。
     */
    function slotTypeOf(key, cards) {
      var need = StateMachine.GROUP_COUNT[key];
      if (!need || !cards || cards.length !== need) return '';
      if (key === 'piaosanye') return Engine.piaoSanYeTypeName(cards) || '';
      if (key === 'douniu') return Engine.douNiuTypeName(cards) || '';
      return '';
    };

    /* 上一次真正写进 DOM 的牌型，用来判断「这一次是刚成手」。
     * ★ 只在 innerHTML 真的被重写时提交（见 game.js 的 renderSlots 末尾）：
     *   提前更新的话，「内容没变 → 跳过重写」的那一帧会把状态吃掉，
     *   下一帧就判不出「刚成手」，成手脉冲永远不放。
     * 换轮要清空（resetSlotTypeSeen），否则上一轮的「牛牛」
     * 会让下一轮第一次成手时被当成「没变」。
     *
     * ★ 值对象是**整个替换**的（renderSlots 里 `slotTypeSeen = nextTypeSeen`），
     *   所以这里交出 getter/setter，而不是把对象本身递出去 ——
     *   递出去的话外面赋值只会改外面那个变量，模块里读到的永远是初始那个 {}。 */
    var slotTypeSeen = {};
    var slotTypeRound = -1;
    function getSlotTypeSeen() { return slotTypeSeen; }
    function setSlotTypeSeen(v) { slotTypeSeen = v || {}; }
    function getSlotTypeRound() { return slotTypeRound; }
    function resetSlotTypeSeen(round) {
      slotTypeSeen = {};
      slotTypeRound = round;
    };

    /* ---------------------------- 牌面图片缓存 ---------------------------- */
    var cardImgCache = {};
    function getCardImg(card, w, h) {
      var key = card.suit + '-' + card.rank + '@' + w + 'x' + h;
      if (!cardImgCache[key]) {
        cardImgCache[key] = Card.drawCardDataURL(card, w * 2, h * 2);
      }
      return cardImgCache[key];
    };
    function cardImgEl(card, w, h, extraCls) {
      var img = document.createElement('img');
      img.src = getCardImg(card, w, h);
      img.className = 'card' + (extraCls ? ' ' + extraCls : '');
      img.draggable = false;
      img.style.width = w + 'px';
      img.style.height = h + 'px';
      img.dataset.cardId = card.suit + '-' + card.rank;
      if (Card.isJoker(card)) img.classList.add('joker-glow'); // 大王牌自带微光
      return img;
    };
    /* 槽位整块用字符串拼（配合「内容没变就不重写 innerHTML」），牌面也走字符串版本 */
    function cardImgHtml(card, w, h, extraCls) {
      var cid = card.suit + '-' + card.rank;
      return '<img class="card' + (extraCls ? ' ' + extraCls : '')
        + (Card.isJoker(card) ? ' joker-glow' : '')
        + '" src="' + getCardImg(card, w, h) + '" data-card-id="' + cid + '"'
        + ' draggable="false" style="width:' + w + 'px;height:' + h + 'px">';
    };

    /* 手牌卡片：外层 .card-wrap 负责扇形定位/选中上浮，内层 img 负责发牌飞入动画 */
    function handCardWrap(card) {
      var wrap = document.createElement('div');
      wrap.className = 'card-wrap';
      wrap.dataset.cardId = card.suit + '-' + card.rank;
      wrap.style.width = HAND_CARD_W + 'px';
      wrap.style.height = HAND_CARD_H + 'px';
      var img = cardImgEl(card, HAND_CARD_W, HAND_CARD_H);
      wrap.appendChild(img);
      // 点击只绑一次：节点会被 renderHand 复用，重复绑会一次点击触发多次
      img.addEventListener('click', function () { deps.onHandCardTap(wrap.dataset.cardId); });
      return wrap;
    };

    /* ---------------------------- 飞牌动效（ghost 克隆，不阻塞交互） ---------------------------- */
    function stageCoords(el) {
      var stage = document.querySelector('#stage');
      var sr = stage.getBoundingClientRect();
      /* 统一走 stageScale()，别在这里再 new 一次 DOMMatrix：
       * 那段没有 try，而 `new DOMMatrix('none')`（--pt-scale 还没生效、或老 WebView）
       * 会直接抛 SyntaxError —— 表现是「发牌动画放到一半整屏不动」，
       * 而这行代码离动画入口只有一层调用，堆栈里看不出和缩放有关。 */
      var scale = deps.stageScale();
      var r = el.getBoundingClientRect();
      return {
        x: (r.left - sr.left) / scale,
        y: (r.top - sr.top) / scale,
        w: r.width / scale,
        h: r.height / scale
      };
    };
    function flyCard(from, to, card, w, h, delay) {
      var screen = document.querySelector('#screen-game');
      var ghost = document.createElement('img');
      ghost.src = getCardImg(card, w, h);
      ghost.draggable = false;
      ghost.style.cssText = 'position:absolute;left:' + to.x + 'px;top:' + to.y + 'px;width:' + w + 'px;height:' + h + 'px;'
        + 'z-index:40;pointer-events:none;border-radius:16px;box-shadow:0 16px 32px rgba(0,0,0,0.45);'
        + 'transform:translate(' + (from.x - to.x) + 'px,' + (from.y - to.y) + 'px) scale(' + (from.w / w).toFixed(3) + ') rotate(' + ((delay || 0) % 2 ? 4 : -4) + 'deg);'
        + 'transition:transform 0.35s cubic-bezier(0,0,0.2,1);';
      screen.appendChild(ghost);
      void ghost.offsetWidth;
      ghost.style.transform = 'translate(0,0) scale(1) rotate(0)';
      ghost.addEventListener('transitionend', function () { if (ghost.parentNode) ghost.parentNode.removeChild(ghost); });
      setTimeout(function () { if (ghost.parentNode) ghost.parentNode.removeChild(ghost); }, 420);
    };

    /* ---------------------------- 结算迷你牌面 ---------------------------- */
    function miniCardsEl(cards) {
      var box = global.LXW.utils.el('div', 'result-cards');
      if (cards.length > 3) box.classList.add('compact'); // 5 张斗牛重叠排列，保证不撑破弹窗
      /* ★ 横屏要把迷你牌缩一档：.ls 里结算区只有 ~435 设计 px 高，
       * 88×124 的牌会把每一行顶到 150，两列各 3 行也放不下（实测溢出 199）。
       * 缩到 74×98 后行高 ~106，5 家两列三行正好装得下（74×104 还差 23）。
       * 判据读 #stage 的类，不读 matchMedia —— 版式是 JS 算出来的，
       * 两者偶发不一致时（旋转瞬间）以舞台自己的判断为准。 */
      var stage = document.querySelector('#stage');
      var ls = !!(stage && stage.classList.contains('ls'));
      var w = ls ? 74 : MINI_CARD_W;
      var h = ls ? 98 : MINI_CARD_H;
      cards.forEach(function (c) {
        box.appendChild(cardImgEl(c, w, h, 'mini-card'));
      });
      return box;
    };

  api.getSlotTypeSeen = getSlotTypeSeen;
  api.setSlotTypeSeen = setSlotTypeSeen;
  api.getSlotTypeRound = getSlotTypeRound;
  api.slotTypeOf = slotTypeOf;
  api.resetSlotTypeSeen = resetSlotTypeSeen;
  api.getCardImg = getCardImg;
  api.cardImgEl = cardImgEl;
  api.cardImgHtml = cardImgHtml;
  api.handCardWrap = handCardWrap;
  api.stageCoords = stageCoords;
  api.flyCard = flyCard;
  api.miniCardsEl = miniCardsEl;

  /* ---- 尺寸常量也必须导出 ----
   * ★ 它们在本模块里算了、也在本模块里用了（牌面视觉正常），
   *   但 game.js 要拿同一批数字做**布局math**（扇形排布、飞牌落点、组槽上界）。
   *   漏导出时外观一点问题都没有，只有布局那边拿到 undefined 算成 NaN ——
   *   典型的「肉眼看着对、位置全错」。以前就漏过这 8 个。 */
  api.HAND_CARD_W = HAND_CARD_W;
  api.HAND_CARD_H = HAND_CARD_H;
  api.SLOT_CARD_W = SLOT_CARD_W;
  api.SLOT_CARD_H = SLOT_CARD_H;
  api.MINI_CARD_W = MINI_CARD_W;
  api.MINI_CARD_H = MINI_CARD_H;
  api.SCREEN_PAD_X = SCREEN_PAD_X;
  api.HAND_AREA_W = HAND_AREA_W;

  api.SLOT_COLOR = SLOT_COLOR;
  api.SLOT_SHORT_LABEL = SLOT_SHORT_LABEL;
  api.CHIP_LABEL = CHIP_LABEL;
  api.SLOT_BADGE = SLOT_BADGE;
  api.SLOT_HINT = SLOT_HINT;
  api.BIG_TYPES = BIG_TYPES;
  api.BIG_FX = BIG_FX;

  return api;
  }

  global.LXW = global.LXW || {};
  global.LXW.cardView = create;

})(typeof self !== 'undefined' ? self : this);
