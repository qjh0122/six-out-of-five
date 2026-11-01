/**
 * 结算：牌型特写幕 → 逐组结算卡 → 结果轮播 → 结算页
 *
 * ── 为什么单独成文件 ────────────────────────────────────────────────
 * 这是「一局打完之后玩家看到的一切」，755 行，原来夹在「提交」和「战绩存档」
 * 中间。它有三段彼此串联但职责分明的时序：
 *
 *   ① 特写幕（PAT_FX）—— 赢家牌型的 1.6 秒演出。**先播完再画结算卡**：
 *      原型 `S.fx ? '' : plaqueHTML(SC, g)` 就是「有特写就把中央牌位顶掉」，
 *      盖在卡上播会把 3 秒阅读时间吃掉 1.7 秒。
 *   ② 结果轮播（seq）—— 每组一张卡，按住 3 秒自动往下走，也可以手动点。
 *   ③ 结算页（renderSettle）—— 总账、名次、原因、再来一把。
 *
 * ── 三条不能改的约束（改了就失真，原注释已逐条搬过来）──────────────
 *   · 牌型名**一律来自引擎**（g.winnerTypeName），这里只做「名字 → 配色/尺寸」；
 *   · 只给**赢家**的牌型放特写 —— 「这组里有豹子」不等于「豹子赢了」；
 *   · 特写与结算卡不同时出现（见 ①）。
 *
 * ── 注入 ────────────────────────────────────────────────────────
 *   render         —— 结算页在房间状态变化时要整页重画（game.js 主渲染）
 *   avatarInner    —— 结算卡里的座位头像（座位环那套，座位环渲染仍在 game.js）
 *   findPlayer / roomHasBot —— 纯查询
 *   modalKit 四项 / cardView 常量 —— 同名前缀解构，调用点零改动
 *
 * 浏览器全局：`window.LXW.settleView`
 */
(function (global) {
  'use strict';

  function create(deps) {
    deps = deps || {};
    var U = global.LXW.utils;
    var $ = U.$, el = U.el, esc = U.esc;
    var netText = U.netText, netCls = U.netCls, pad2 = U.pad2, fmtTime = U.fmtTime;
    var cardText = U.cardText, short = U.short, colorFor = U.colorFor;

    /* ★ state 必须注入：模块是独立作用域，看不到 game.js 里那个 state。
     *   漏了不会在加载时报错，只会在用到它的那一行 ReferenceError ——
     *   而房间订阅回调被 roomStore 的 try/catch 裹着，错误连控制台都不进，
     *   表现就是「点了没反应」。 */
    var state = deps.state;
    var BIG_FX = deps.BIG_FX, BIG_TYPES = deps.BIG_TYPES;
    var cardImgHtml = deps.cardImgHtml, cardImgEl = deps.cardImgEl;
    var miniCardsEl = deps.miniCardsEl;
    var SLOT_BADGE = deps.SLOT_BADGE, SLOT_COLOR = deps.SLOT_COLOR, SLOT_SHORT_LABEL = deps.SLOT_SHORT_LABEL;

    var bindScrollFadeOnce = deps.bindScrollFadeOnce, syncScrollFade = deps.syncScrollFade;
    var showModalEl = deps.showModalEl, hideModalEl = deps.hideModalEl;

    var render = deps.render, avatarInner = deps.avatarInner;
    var findPlayer = deps.findPlayer, roomHasBot = deps.roomHasBot;

  /* ---------------------- 牌型特写幕（v98，原型 .fx 层移植） ----------------------
   * 原型 docs/prototypes/circle-table.html 里有一整层 .fx，在结算**前面**播：
   *   旋转的 conic 金环（920，7s 无限） + 三道扩散冲击波（0/0.14/0.28s）
   *   + 14 颗粒子沿各自射线飞 170~305 + 赢家的牌 104/94/84 宽逐张砸下来
   *   + 108px 牌型大字从 2.3 倍缩进来 +（豹子/五花牛）震桌。
   *
   * ★ v83~v97 只落了它的「组内版」：结算卡里一条 20px 的金色胶囊 +
   *   12 颗飞 74px 的粒子 + 一圈描边。那不是特写，是提示 ——
   *   所以玩家会说「看不到原型里那个动画」。这一节补的就是那一下。
   *
   * 三条与原型的对齐点（不改就失真）：
   *   ① 只给**赢家的牌型**放（原型那张牌型表也只对 winner 求值），
   *      「这组里有豹子」不等于「豹子赢了」；
   *   ② 牌型名一律来自引擎（g.winnerTypeName），这里只做「名字 → 配色/尺寸」；
   *   ③ 特写播放时**没有结算卡** —— 原型 `S.fx ? '' : plaqueHTML(SC, g)`
   *      就是「有特写就把中央牌位顶掉」。所以先播 1.7 秒，再画卡，
   *      结算卡那 3 秒阅读时间一秒不少（盖在卡上播会把阅读时间吃掉 1.7 秒）。
   */
  var PAT_FX_MS = 1600;   // 牌 0.42s + 大字 0.2s 延迟 + 0.52s / 粒子 1.05s → 视觉 1.25s 走完，留一拍呼吸
                          // 上限按原型的自我约束：「超过 1.6 秒就会烦」（一局要放 3~5 次）
  var pat = { timer: 0, out: 0, done: null, step: -1, heroAt: -1 };

  /* 粒子两色交错 —— 与 halo / lbl 的三套色同源，但 CSS 表达不了「同一个元素阵里
   * 单双号不同色」，所以写在 --pc 上由 JS 决定。 */
  function patPtColor(kind, i) {
    if (kind === 'wh') return i % 2 ? '#D9A6FF' : '#FFD978';
    if (kind === 'bz') return i % 2 ? '#FF8A6A' : '#FFD978';
    return i % 2 ? '#FFE08A' : '#FFC15C';
  }

  /* 牛牛要圈出「凑成 10 的那三张」。算法与原型 niuTrio 逐字一致，
   * 但只用它**挑高亮**，不用它判牌型 —— 判牌型仍然是引擎的事。
   * 五张已经是牛牛时，任取一组和为 10 的三张都成立（剩下两张也必然是 10 的倍数），
   * 所以这里不需要和引擎的择优完全同步。 */
  function patTrio(cards) {
    if (!cards || cards.length !== 5) return [];
    var v = cards.map(function (c) { return Engine.douNiuPoint(c); });
    for (var i = 0; i < 5; i++)
      for (var j = i + 1; j < 5; j++)
        for (var k = j + 1; k < 5; k++)
          if ((v[i] + v[j] + v[k]) % 10 === 0) return [i, j, k];
    return [];
  }

  /* 三个开关，任一关掉就不放这一幕：CONFIG / ?patternfx=0 / 系统「减少动态效果」。
   * ?patternfx=0 是给探针的 —— 特写会把结算弹窗推迟 1.7 秒，
   * 那些只验「结算卡内容」的用例没必要陪着等。
   * ★ 函数名与参数名必须按 rollback-contract 的规则来（<键名小写>Flag / 键名去下划线）：
   *   那一套契约会把 config.js 功能开关区块里的每个 KEY 都扫一遍，
   *   名字不对就等于「这个开关在灰度期关不掉」。`?fx=0` 是手敲的短写法。 */
  function patternFxFlag() {
    var q = '';
    try {
      var sp = new URLSearchParams(location.search || '');
      q = sp.get('patternfx') || sp.get('fx') || '';
    } catch (e) { q = ''; }
    if (q === '0') return false;
    if (q === '1') return true;
    /* 系统开了「减少动态效果」：不是功能开关，但结论一样 —— 不放这一幕。
     * 放在 0/1 之后，`?patternfx=1` 仍然能强制打开（探针要拍得到）。 */
    try {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    } catch (e) { /* 老 WebView 没有 matchMedia，按「没开」处理 */ }
    return CONFIG.PATTERN_FX;
  }

  /* 幕上大字。引擎给的正式名字是「10.5点」，而原型幕上写的就是「10.5」——
   * 十点半这一组的牌型名本身就是点数，再加个「点」字等于把同一个意思说两遍，
   * 而且 5 个字放在 96px 上会把「10.5点」挤成和五张牌等宽的一长条。
   * 只改显示，不改查表用的名字（BIG_FX / 结算行都用引擎名）。 */
  function patLabel(typeName) {
    return typeName === '10.5点' ? '10.5' : typeName;
  }

  function buildPatternFx(typeName, kind, cards) {
    var box = $('#pattern-fx');
    if (!box || !cards || !cards.length) return null;
    var n = cards.length;
    /* 牌宽：5 张要并排塞进 750 设计宽（5×84 + 4×12 = 468），
     * 3 张给 94、2 张给 104。高度按全站统一的 202/144 比例算，不另设。 */
    var cw = n >= 5 ? 84 : (n === 3 ? 94 : 104);
    var ch = Math.round(cw * 202 / 144);
    var mk = kind === 'nn' ? patTrio(cards) : (kind === 'wh' ? [0, 1, 2, 3, 4] : []);

    var html = '<div class="pat-scrim"></div><div class="pat-core"><div class="pat-halo"></div>';
    [0, 0.14, 0.28].forEach(function (d) {
      html += '<i class="pat-wave" style="--d:' + d + 's"></i>';
    });
    for (var i = 0; i < 14; i++) {
      html += '<i class="pat-pt" style="--a:' + Math.round(i * 360 / 14) + 'deg;--r:'
        + (170 + (i % 4) * 45) + 'px;--d:' + ((i % 5) * 0.05).toFixed(2) + 's;--pc:'
        + patPtColor(kind, i) + '"></i>';
    }
    html += '<div class="pat-cards">';
    cards.forEach(function (c, ci) {
      var on = mk.indexOf(ci) >= 0;
      html += '<div class="pat-cd' + (on ? ' is-mk' : '') + '" style="--d:' + (ci * 0.09).toFixed(2) + 's">'
        + cardImgHtml(c, cw, ch, 'pat-card')
        + (on && kind === 'nn' ? '<span class="pat-mkb">10</span>' : '')
        + '</div>';
    });
    html += '</div><div class="pat-lbl">' + esc(patLabel(typeName)) + '</div></div>';

    box.dataset.kind = kind;
    box.dataset.type = typeName;
    box.dataset.cards = String(n);
    box.innerHTML = html;
    return box;
  }

  function playPatternFx(typeName, kind, cards, onDone) {
    var box = buildPatternFx(typeName, kind, cards);
    if (!box) { if (onDone) onDone(); return; }
    if (pat.timer) { clearTimeout(pat.timer); pat.timer = 0; }
    if (pat.out) { clearTimeout(pat.out); pat.out = 0; }
    pat.done = onDone;
    box.classList.remove('hidden', 'is-out');
    box.classList.toggle('is-shake', kind === 'bz' || kind === 'wh');
    box.dataset.step = String(pat.step);
    /* 结算卡让开：不是收掉弹窗（探针会看到「反复开关」、读屏也会被打断），
     * 只是把那张暖白卡淡到 opacity:0，位置与可点击区域原样保留。 */
    var m = $('#result-modal');
    if (m) m.classList.add('is-hero');
    pat.timer = setTimeout(function () { pat.timer = 0; endPatternFx(); }, PAT_FX_MS);
  }

  function endPatternFx() {
    if (pat.timer) { clearTimeout(pat.timer); pat.timer = 0; }
    var box = $('#pattern-fx');
    var done = pat.done;
    pat.done = null;
    /* 结算卡和幕布同时开始过渡（都是 0.22s）—— 先撤 is-hero 再淡出幕布，
     * 两件事在同一个 tick 里发生，观感就是「光散开，账露出来」。 */
    var m = $('#result-modal');
    if (m) m.classList.remove('is-hero');
    if (!box || box.classList.contains('hidden')) { if (done) done(); return; }
    box.classList.add('is-out');
    pat.out = setTimeout(function () {
      pat.out = 0;
      box.classList.add('hidden');
      box.classList.remove('is-out', 'is-shake');
      if (done) done();
    }, 220);
  }

  /** 硬清（新结算接管 / 离开房间）：不回调，直接把幕收掉。 */
  function stopPatternFx() {
    if (pat.timer) { clearTimeout(pat.timer); pat.timer = 0; }
    if (pat.out) { clearTimeout(pat.out); pat.out = 0; }
    pat.done = null;
    pat.step = -1;
    pat.heroAt = -1;
    var box = $('#pattern-fx');
    if (box) {
      box.classList.add('hidden');
      box.classList.remove('is-out', 'is-shake');
      box.innerHTML = '';
    }
    /* 硬清时结算卡必须立刻回来：这里没有淡出过程，留着 is-hero 就是一张空弹窗。 */
    var m = $('#result-modal');
    if (m) m.classList.remove('is-hero');
  }

  /* 一组一张卡。从 showResultModal 里拆出来，是为了逐组结算能「一幕只画一组」——
   * 两处各抄一份的话，「赢家行金底」「比 10」「×2 标记」这些慢慢就会跑偏，
   * 而结算卡是玩家唯一会盯着看很久的界面。 */
  function resultGroupCard(g, gi) {
    var color = SLOT_COLOR[g.group] || SLOT_COLOR.single;
    var div = el('div', 'result-group');
    div.dataset.game = g.group;
    div.style.setProperty('--slot-color', color.hex);
    div.style.setProperty('--slot-soft', color.soft);
    div.style.animationDelay = (gi * 350) + 'ms'; // 逐组揭晓 0.35s 错峰

    /* 牌型特写（v83）：只有「赢家的牌型属于这几种」才放，不是「这一组里有特殊牌」。
     * 一局要结算 3~5 次，每次放两三个特写就没法看了。
     *
     * ★ 判定走 winnerTypeName 而不是自己重算牌型：那是引擎 typeName() 的输出，
     *   全仓只有一份规则实现。这里只做「名字 → 颜色/动画」的映射，
     *   映射不到就不放特写 —— 最坏的结果是少一个动画，不会算错人。
     *   （原型里曾用 `r.t === 9` 这种裸数字，牛 9 和牛牛编码相同，
     *    结果牛 9 赢了也放牛牛特写，随机 800 组里 18.5%。） */
    var big = BIG_FX[g.winnerTypeName] || null;
    if (big) {
      div.classList.add('is-big');
      div.dataset.big = big.kind;
      div.style.setProperty('--fx-color', big.color);
      div.style.setProperty('--fx-ring', big.ring);

      var banner = el('div', 'result-banner', g.winnerTypeName + '！');
      div.appendChild(banner);

      /* 粒子层：12 个点绕中心爆开。用 <i> 而不是伪元素，是因为
       * 每个点的角度要靠 --a 单独控制，一个伪元素只能有一个角度。
       * ★ 延迟必须把「这一组的入场错峰」算进去（gi × 0.35s）：
       *   不算的话第 3 组的粒子会在它还没滑进屏幕时就在屏幕外炸完了，
       *   玩家只看到一组牌和几颗早已消失的点。 */
      var burst = el('div', 'fx-burst');
      var burstAt = gi * 0.35 + 0.18;
      for (var bi = 0; bi < 12; bi++) {
        var pt = el('i', 'fx-pt');
        pt.style.setProperty('--a', (bi * 30) + 'deg');
        pt.style.setProperty('--d', (burstAt + (bi % 4) * 0.04).toFixed(2) + 's');
        burst.appendChild(pt);
      }
      div.appendChild(burst);
    } else if (BIG_TYPES.indexOf(g.winnerTypeName) >= 0) {
      /* 名字在名单里但没有特效映射（以后引擎加了新牌型）—— 横幅照旧放，
       * 只是不动。少了这一支，新牌型会连横幅一起消失。 */
      div.appendChild(el('div', 'result-banner', g.winnerTypeName + '！'));
    }

    var head = el('div', 'result-head');
    // 计分档标记：让玩家知道为什么这一组多付（十点半满点 / 飘三叶按场上豹子数加成）
    var x2 = '';
    if (g.group === 'tenhalf' && g.winPoints > CONFIG.TENHALF_WIN) x2 = '10.5 ×' + g.winPoints;
    else if (g.group === 'piaosanye' && g.winPoints > CONFIG.PIAOSANYE_WIN) x2 = '豹子 ×' + g.winPoints;
    head.innerHTML = '<span class="slot-badge">' + (SLOT_BADGE[g.group] || '') + '</span>'
      + '<span class="result-head-label">' + esc(SLOT_SHORT_LABEL[g.group] || g.label) + '</span>'
      + (x2 ? '<span class="result-head-x2">' + esc(x2) + '</span>' : '')
      + '<span class="result-head-winner">赢家 <b>' + esc(g.winnerNickname) + '</b></span>';
    div.appendChild(head);

    var rows = el('div', 'result-rows');
    g.entries.forEach(function (en) {
      var p = findPlayer(state.room, en.id);
      var name = p ? (p.nickname || '?') : (en.id || '?');
      var delta = g.deltas[en.id] || 0;
      var row = el('div', 'result-row');
      if (en.id === g.winnerId) row.classList.add('win-row'); // 赢家行：金底 + 王冠

      var cards = miniCardsEl(en.hand || []);

      var info = el('div', 'result-info');
      var rn = el('div', 'rn', (en.id === g.winnerId ? '👑 ' : '') + name);
      var rt = el('div', 'rt');   // 单张的牌面即迷你牌，不再重复类型名
      if (g.group !== 'single') {
        rt.appendChild(el('span', 'rt-type', en.typeName));
        /* 同点数/同牛型时到底在比哪张牌：十点半比那张贡献最大的（10.5 就是那张 10），
         * 斗牛比五张里最大的那张（有大王就取除王以外最大的那张）。不写出来的话，玩家只会看到「都 10.5 凭什么他赢」。
         * 做成独立的小徽标：斗牛那行左边有 5 张迷你牌，行宽很紧，
         * 早先拼成一整句会在「比」和牌面之间折断，很难看。 */
        if (en.decider && (g.group === 'tenhalf' || g.group === 'douniu')) {
          rt.appendChild(el('span', 'rt-cmp', '比 ' + en.decider));
        }
      }
      info.appendChild(rn);
      info.appendChild(rt);

      var rd = el('div', 'rd ' + (delta >= 0 ? 'pos fp' : 'neg fn'), (delta >= 0 ? '+' : '') + delta);
      row.appendChild(cards);
      row.appendChild(info);
      row.appendChild(rd);
      rows.appendChild(row);
    });
    div.appendChild(rows);
    return div;
  }

  /* -------------------- 逐组结算的场景推进（v89 §13.1 / §13.2） --------------------
   * 一次结算里有 2~3 组，**一组一幕、自动推进** —— 不是一次把三组铺满。
   *
   * 为什么序列在客户端而不是服务端：结算是**原子**的（一组算完立刻应用分数，
   * 中途不能插进别的操作）。拆成多次广播，网络抖动时就会出现「A 组到了、B 组还在路上」，
   * 玩家看到的总分是错的。服务端一次给全量，客户端负责一幕一幕放 ——
   * 放的是同一份数据，只是节奏不同。
   *
   * 三条硬约束（都是实际会撞到的）：
   *   ① **新结算要接管旧序列**：一局 5 次结算，上一轮的 3 秒还没走完，
   *      下一轮就可能已经算完并广播过来了。不接管就会两套计时器同时推进两幕。
   *   ② **离开房间 / 离开这一屏要停表**：不停的话计时器会在结算页上
   *      把上一局的结算弹窗又弹起来，看着像「结算页自己刷新了」。
   *   ③ **点一下能跳过等待，但不能跳过内容**：一局 5 次结算、每次 3 秒
   *      是 15 秒强制观看；而加 5 个「确认」按钮又是 5 次点击。折中是
   *      「自动走 + 点一下立刻走」，两个方向都快。 */
  var SEQ_HOLD = 3000;
  var seq = { seq: 0, step: 0, timer: 0, brk: 0, result: null };

  /* 3 秒是默认节奏。探针要跑得快，用 ?hold=<秒> 覆盖 ——
   * 只影响**等待**，不影响内容与顺序，所以「自动推进」这件事仍然是被真验过的。 */
  function seqHold() {
    var v = 0;
    try { v = parseFloat(new URLSearchParams(location.search || '').get('hold') || '0'); } catch (e) { v = 0; }
    if (!(v > 0)) return SEQ_HOLD;
    return Math.max(120, Math.round(Math.min(20, v) * 1000));
  }

  function stopResultSeq() {
    if (seq.timer) { clearTimeout(seq.timer); seq.timer = 0; }
    seq.seq = 0;
    seq.result = null;
    seq.step = 0;
    /* 特写幕跟着序列一起收：新结算接管时上一幕的光环可能还在转，
     * 不收掉就会出现「两张桌子同时亮着」。 */
    stopPatternFx();
  }

  function closeBreakCard() {
    if (seq.brk) { clearTimeout(seq.brk); seq.brk = 0; }
    hideModalEl('round-break-modal');
  }

  /** 开始 / 接管一段结算序列。seqId = room.resultSeq（同一段重复调用是幂等的）。 */
  function playResult(result, seqId) {
    if (!result || !result.groups || !result.groups.length) return;
    if (seq.seq === seqId) return;      // 同一段已经在放，别重头再来
    stopResultSeq();
    closeBreakCard();
    seq.seq = seqId;
    seq.result = result;
    seq.step = 0;
    renderResultStep();
  }

  /* 秒数的写法统一走这里：3 秒写成「3 秒」、0.6 秒写成「0.6 秒」。
   * 文案里的数字必须和进度条的时长同源（都是 hold），否则改节奏会让
   * 「说 3 秒、实际 0.6 秒」这种自相矛盾堂而皇之地留在界面上。 */
  function seqSecs(ms) {
    var v = ms / 1000;
    return (Math.round(v * 10) % 10 === 0 ? String(Math.round(v)) : v.toFixed(1)) + ' 秒';
  }

  /** 末幕之后该说什么 —— 三种结局，文案不能混着写。 */
  function seqLastText(result, hold) {
    var all = (StateMachine.ROUND_GROUPS || {})[result.round] || [];
    var s = seqSecs(hold);
    /* ★ v103：这一条原本写「有人见底 · X 秒后结账」，对应「组级见底就 break」的老规则。
     * 现在结算一定会把本轮所有组算完，所以 groups.length 恒等于组总数，走不到这里。
     * 保留 + 改成中性文案，是为了兜住两种边缘：老战绩回放（服务端存的历史
     * groups 可能真的是短的）和以后万一再引入「某一组中止」。不删是因为
     * 删掉后端回来一条短 groups，这里就会错说成「本轮结束」。 */
    if (result.groups.length < all.length) return '本轮提前结束 · ' + s + '后结账';
    if (result.round !== 1) return '本轮结束 · ' + s + '后结账';
    return '本轮结束 · ' + s + '后进入第二轮';
  }

  function renderResultStep() {
    var result = seq.result;
    if (!result) return;
    var groups = result.groups;
    var i = Math.min(seq.step, groups.length - 1);
    var last = i === groups.length - 1;
    var g = groups[i];
    var big = BIG_FX[g.winnerTypeName] || null;

    /* 上一幕的特写还没播完就有人点了「下一组」：先把幕收掉，
     * 否则上一手的光环会盖在新一幕的结算卡上（一整层白色大字，谁也读不了）。 */
    if (pat.timer && pat.step !== i) stopPatternFx();

    /* 这一幕要不要放特写：只给赢家的大牌型，且这一幕还没放过。
     * `pat.step` 是哨子 —— 同一步可能因为「跳过后重画」被再进一次。 */
    var heroNow = !!(big && pat.step !== i && patternFxFlag());


    /* 标题带上「第几组 / 共几组」：一幕一组时，玩家最需要知道的是
     * 「还有几组没看」，而不是「这是第几轮」（轮次在分牌时就已经知道了）。 */
    $('#result-title').textContent = '第' + (result.round === 1 ? '一' : '二') + '轮结算'
      + (groups.length > 1 ? ' · 第 ' + (i + 1) + '/' + groups.length + ' 组' : '');

    var wrap = $('#result-groups');
    wrap.innerHTML = '';
    /* gi 传 0：一幕只有一组，替它算一个 0.35s 的入场错峰只会白等 0.35 秒。 */
    wrap.appendChild(resultGroupCard(groups[i], 0));

    /* ★ v103：这段原本是「组级见底（v83）—— 本轮只结算了一部分组时，
     * 必须明说剩下的没进行」。新规则下本轮一定全部算完，skipped 恒为 0。
     * 保留是因为老战绩回放的 groups 可能真的短；文案改成中性，不再指名「有人见底」。
     * 总数从状态机读，不在前端写死 3 / 2：组数是可以变的规则，不是界面常量。
     * ★ 只在**末幕**说：第一幕就顶一句「剩下 2 组没进行」，
     *   而下一幕又画出一组，自相矛盾。 */
    var allGroups = (StateMachine.ROUND_GROUPS || {})[result.round] || [];
    var skipped = allGroups.length - groups.length;
    if (last && skipped > 0) {
      wrap.appendChild(el('p', 'result-abort-note',
        '本轮剩下 ' + skipped + ' 组没有进行。'));
    }

    var modal = $('#result-modal');
    var hold = seqHold();
    /* 有特写这一幕要**多停一个特写时长**：前 1.6 秒全被幕布盖着，
     * 不延长的话玩家还没看清分数就自动翻页了（3 秒里只剩 1.4 秒可读）。
     * 进度条、脚注文案、自动推进的定时器全部读这同一个 total，
     * 所以不会出现「文案说 3 秒、条子跑 4.6 秒」。 */
    var total = hold + (heroNow ? PAT_FX_MS : 0);

    /* 序列信息落在 data-* 上：探针要能在不开内部变量的前提下读到
     * 「现在第几幕、总共几幕、这一幕停多久」，而不是靠解析标题文字。
     * data-hold 是这一幕**真实**的停留（含特写），data-hero 标明多出来的那一段是特写。 */
    modal.dataset.step = String(i);
    modal.dataset.steps = String(groups.length);
    modal.dataset.hold = String(total);
    modal.dataset.hero = heroNow ? '1' : '0';
    modal.dataset.round = String(result.round);
    modal.dataset.big = big ? big.kind : '';
    /* ★ 必须挂在模态框上，不能挂 #result-groups：进度条是它的**兄弟**节点，
     * 自定义属性只向下继承 —— 挂在组容器上时，进度条读不到，
     * 永远退回 CSS 里的兜底 3000ms（实测就是这样：文案说 3 秒、节奏改 0.6 秒，
     * 条子还是慢慢跑 3 秒）。 */
    modal.style.setProperty('--hold', total + 'ms');
    $('#result-next').textContent = last ? seqLastText(result, total) : '下一组 · ' + seqSecs(total) + '后自动';
    $('#btn-result-close').textContent = last ? '继续游戏' : '下一组';

    if (modal.classList.contains('hidden')) showModalEl('result-modal');

    /* 特写幕盖在结算卡上播。
     *
     * ★ 为什么不是「先播特写、播完再弹卡」（原型那样：S.fx ? '' : plaqueHTML）：
     *   原型的结算明细是**牌桌下方那条常驻列表**，收掉中央牌位不影响看分数；
     *   而线上的结算卡本身就是这一屏的全部内容。收起再弹出会有两个问题：
     *   ① 中间那一下「卡没了」—— 一张白卡瞬间消失再回来，比任何动画都更抢眼；
     *   ② 一幕一组时这会发生 2~3 次/轮，玩家会以为界面在闪。
     *   所以卡照常先画好，特写作为一整层幕布压在它上面 1.6 秒（幕布 0.86+ 不透明，
     *   白卡透不出来），停留时间同步延长 —— 观感就是「先给你看这一手，再给你看账」。
     *
     * 音效也在这里起手：原来那声 +220ms 的 win 是配组内横幅的，
     * 现在横幅要等 1.6 秒才露出来，声音会比画面早到一个身位。 */
    if (heroNow) {
      var win = null;
      for (var wi = 0; wi < g.entries.length; wi++) {
        if (g.entries[wi].id === g.winnerId) win = g.entries[wi];
      }
      pat.step = i;
      pat.heroAt = i;
      Sfx.play('win', 1.12);
      playPatternFx(g.winnerTypeName, big.kind, (win && win.hand) || [], null);
    } else if (i === 0) {
      Sfx.play('settle');
    }
    /* ★ 大牌型那一幕仍用固定音高 1.12：它表达的是「这一手很漂亮」，
     *   不该跟着第几幕变调（变调表达的是「进度」，两个意思混在一起就都听不出来了）。
     * 这一幕已经响过（特写起手那一声），不再补一次 —— 不然 1.6 秒里响两次。 */
    if (!heroNow && i > 0 && !BIG_FX[groups[i].winnerTypeName]) {
      Sfx.play('win', 1 + i * 0.05);
    }

    if (seq.timer) clearTimeout(seq.timer);
    seq.timer = setTimeout(function () { seq.timer = 0; advanceResult(); }, total);
  }

  /** 往前走一幕；已经是末幕就收尾。点击与倒计时都走这里，保证只有一条路径。 */
  function advanceResult() {
    if (!seq.result) { hideModalEl('result-modal'); return; }
    var last = seq.step >= seq.result.groups.length - 1;
    if (!last) {
      if (seq.timer) { clearTimeout(seq.timer); seq.timer = 0; }
      seq.step += 1;
      renderResultStep();
      return;
    }
    finishResultSeq();
  }

  function finishResultSeq() {
    var r = seq.result;
    stopResultSeq();
    hideModalEl('result-modal');
    /* 第一轮打完、而且**真的进了第二轮**才插交替卡。
     * 三种「没有第二轮」的情况都靠下面几条挡掉：打满把数提前结束（phase 直接 SETTLED）、
     * 有人离开、以及解散。在结算页上弹一张「第二轮开始」是最荒唐的错位。 */
    if (r && r.round === 1 && maybeBreakCard(r)) return;
    render();
  }

  /* ------------------------- 轮次交替卡（§13.2） ------------------------- */
  function roundNet(result) {
    /* 按 deltas 加总，**不用「两次分数快照相减」**：中途加入/离开的人分数是冻结的，
     * 快照相减会把「冻结」算成 0 —— 那正好看起来像「他一分没输赢」，
     * 而实际上他根本没打。 */
    var net = {};
    result.groups.forEach(function (g) {
      var d = g.deltas || {};
      for (var pid in d) net[pid] = (net[pid] || 0) + d[pid];
    });
    return net;
  }

  /** @returns {boolean} 真的插了卡（没插的话调用方要自己 render） */
  function maybeBreakCard(result) {
    var room = state.room;
    if (!room) return false;
    if (room.round !== 2) return false;
    if (room.phase !== StateMachine.PHASE.ROUND2_SPLIT) return false;
    var all = (StateMachine.ROUND_GROUPS || {})[1] || [];
    if (result.groups.length < all.length) return false;

    var net = roundNet(result);
    /* 排序用「本轮净得」而不是总分：这一屏讲的是**这一轮**，
     * 按总分排会让上一轮领先的人一直排在最上面，看不出这一轮谁赢麻了。 */
    var ids = Object.keys(net).sort(function (a, b) { return net[b] - net[a]; });
    if (!ids.length) return false;

    var body = $('#rb-body');
    body.innerHTML = '';
    ids.forEach(function (pid) {
      var p = findPlayer(room, pid);
      var name = (p && p.nickname) || pid;
      var d = net[pid];
      var row = el('div', 'rb-row');
      row.dataset.pid = pid;
      var av = el('span', 'rb-av');
      av.innerHTML = avatarInner(pid, p && p.avatar, (name.charAt(0) || '?'), !!(p && p.isBot), p && p.photo);
      row.appendChild(av);
      row.appendChild(el('span', 'rb-name', name));
      row.appendChild(el('span', 'rb-delta ' + (d > 0 ? 'pos fp' : (d < 0 ? 'neg fn' : 'flat')), netText(d)));
      if (pid === state.myId) row.classList.add('me');
      body.appendChild(row);
    });

    var next = (StateMachine.ROUND_GROUPS || {})[2] || [];
    $('#rb-sub').textContent = '本轮各家净得';
    /* 两行说两件事：**先比什么**（原来只说「3 秒后发牌」，玩家不知道第二轮先比哪组），
     * 再**什么时候开始**。塞一行会在「→ 斗牛」和「分数延续」之间折断，
     * 折出来的第二行只有四个字，看着像一句没写完的话。 */
    var l1 = next.length
      ? '下一轮 · ' + next.map(function (k) { return SLOT_SHORT_LABEL[k] || k; }).join(' → ')
      : '下一轮';
    /* 组名是常量表里的固定词，不含用户输入，直接拼是安全的；
     * 但**别**把玩家昵称拼进来 —— 那是唯一的外部字符串。 */
    $('#rb-next').innerHTML = '<span class="rb-next-l">' + esc(l1) + '</span>'
      + '<span class="rb-next-l">分数延续 · ' + esc(seqSecs(seqHold())) + '后开始</span>';
    $('#rb-title').textContent = '第' + (result.round === 1 ? '一' : '二') + '轮结束';

    var m = $('#round-break-modal');
    m.dataset.hold = String(seqHold());
    showModalEl('round-break-modal');

    if (seq.brk) clearTimeout(seq.brk);
    seq.brk = setTimeout(function () { seq.brk = 0; closeBreakCard(); render(); }, seqHold());
    return true;
  }

  /* ---------------------------- 结账页 ---------------------------- */
  /* 结算列表：结算页和「上一局结算」弹窗共用这一份渲染。
   * 两边各画一套的问题不是麻烦，是会慢慢跑偏 —— 排名规则、冠军行、弃局标记、
   * 「我」胶囊，任何一处改了漏一边，同一局就会看到两个说法。 */
  /* 结算排名（v104 定的口径，别在渲染里再算一遍）。
   *
   * 两条规则必须同时成立，否则「谁是冠军」会变成运气问题：
   *   ① 中途弃局的人**不计名次**，统一排在末尾。他们的分数在离开那一刻就冻结了，
   *      可能仍然是全场最高 —— 以前直接按分数取首行，于是走了的人戴着皇冠。
   *   ② 其余人**同分并列同名次**（1,1,3 竞赛式排名）。以前 Array.sort 是稳定的，
   *      并列第一会按**入座顺序**取胜者：同分不同座位，冠军是不同的人，
   *      而界面上一个字都没说这是并列。
   *
   * 返回 [{ p, rank, champion, abandoned }]。rank 从 1 起；弃局者 rank = 0（不参与名次）。
   * 冠军 = 所有 rank === 1 的人，**可以不止一个**。
   */
  function settleRank(players) {
    var byScore = function (a, b) { return b.score - a.score; };
    var playing = players.filter(function (p) { return !p.left; }).sort(byScore);
    var gone = players.filter(function (p) { return !!p.left; }).sort(byScore);
    var rows = [];
    var prevScore = null, prevRank = 0;
    playing.forEach(function (p, i) {
      /* 同分沿用上一名的名次；prevScore 用 null 判「还没有上一名」，
       * 不能写 `prevScore !== p.score` —— 分数可能真是 0 或负数。 */
      var rank = (prevScore !== null && p.score === prevScore) ? prevRank : i + 1;
      prevScore = p.score; prevRank = rank;
      rows.push({ p: p, rank: rank, champion: rank === 1, abandoned: false });
    });
    gone.forEach(function (p) {
      rows.push({ p: p, rank: 0, champion: false, abandoned: true });
    });
    /* tied：这个名次是不是被两个人以上占了。渲染要用它决定角标要不要标并列
     *（第 2 名并列时两个「2」本身已经是并列的写法，所以只加类、不加字）。 */
    var counts = {};
    rows.forEach(function (r) { if (r.rank) counts[r.rank] = (counts[r.rank] || 0) + 1; });
    rows.forEach(function (r) { r.tied = !!r.rank && counts[r.rank] > 1; });
    return rows;
  }

  function settleListEl(room) {
    var rows = settleRank(room.players);
    /* 并列冠军要单独说一句「并列」：两颗皇冠并排，看着像「两个人并列」，
     * 也可能是「奖杯漏了名次数字」。加一枚胶囊就不会误读。 */
    var championCount = rows.filter(function (r) { return r.champion; }).length;
    var list = el('div', 'settle-list');
    rows.forEach(function (r, i) {
      var p = r.p;
      var row = el('div', 'settle-row');
      if (r.champion) row.classList.add('champion');
      if (r.abandoned) row.classList.add('is-abandoned');
      if (p.id === state.myId) row.classList.add('me');
      row.dataset.pid = p.id;   // 点头像 → 查看该玩家档案；点行 → 看这一把回放
      row.style.animationDelay = ((i === 0 ? 0 : 200) + i * 150) + 'ms';

      /* ★ 每一行都是「头像 + 名次角标」，不再只有冠军有头像。
       * 结算页是这一局的最终结果，而牌桌上每个座位都是头像 ——
       * 一行数字 + 一行图，会被读成两套东西（「同一个人的头像突然变了」）。
       * 角标放在左下角，是因为皇冠要占上面那个角。
       * 头像同时是「看这个人」的入口（点它 = 档案），和牌桌上点座位同一套手势；
       * 点行的其他地方 = 看**这一把**的回放（见 openReplayHere）。 */
      var rank = el('div', 'settle-rank' + (r.champion ? ' champion-rank' : '') + (r.abandoned ? ' is-gone' : '') + (p.isBot ? ' is-bot' : ''));
      /* 头像本身是个按钮：行里有两个动作，只有把「看档案」做成能聚焦的控件，
       * 键盘用户才有办法表达「我要看的是这个人」。
       * aria 标签写全「第 N 名 + 谁」，因为读屏用户看不到角标和皇冠。
       * 并列时念「并列第 N 名」；弃局的人没有名次，念「已离开」——
       * 这一句是唯一能告诉读屏用户「他不在排名里」的地方（视觉上靠沉底 + 「—」角标）。 */
      rank.setAttribute('role', 'button');
      rank.setAttribute('tabindex', '0');
      var rankText;
      if (r.abandoned) rankText = '已离开，不计名次';
      else if (championCount > 1 && r.rank === 1) rankText = '并列第 1 名';
      else rankText = '第 ' + r.rank + ' 名';
      rank.setAttribute('aria-label', rankText + ' ' + (p.nickname || '?') + '，查看档案');
      /* isBot 必须和座位（.avatar）、交替卡（.rb-av）传同一个值。
       * 传 false 的话 AI 会拿到一套「默认预设头像」，而它在牌桌上是 🤖 ——
       * 同一局里同一个人两副面孔，正是这一行改造要消灭的那个问题。 */
      rank.innerHTML = avatarInner(p.id, p.avatar, (p.nickname || '?').charAt(0), !!p.isBot, p.photo);
      if (r.champion) {
        rank.appendChild(el('span', 'crown', '🏆'));
      } else if (r.abandoned) {
        /* 弃局者的角标写一根横杠，不写数字：他没有名次，
         * 写任何数字（包括「4」）都是在说「你排第 4」——那是撒谎。 */
        rank.appendChild(el('span', 'settle-pos is-out', '—'));
      } else {
        rank.appendChild(el('span', 'settle-pos' + (r.tied ? ' is-tie' : ''), String(r.rank)));
      }
      /* 名字里直接带「我」胶囊，和排行榜那一行同一套语言。
       * 以前只有一圈金色描边，而冠军行本身就是金色渐变底 ——
       * 两种金挤在一起，等于没标。现在靠「胶囊」说话，不靠颜色说话。
       * 名字前也不再挂第二个奖牌：头像那颗「首字母 + 皇冠」已经在说「冠军」了，
       * 一排两个奖牌只会让人分不清哪个是名次、哪个是身份。 */
      var me = p.id === state.myId;
      /* 两个标记互斥，所以用三元而不是两个判断：
       *   · left = 人走了（分数冻结、沉到列表末尾、不计名次）
       *   · out  = v103 前的「分数 ≤ 0 当场出局」，**新局恒为 false**。
       *     留着这一支只为老战绩回放：两个月前的记录里可能真有 out=true，
       *     删了那一行会念成「正常打完的」。
       * 文案只写「弃局」，不写「不计名次」：名字列在 320 宽下会省略号，
       * 「不计名次」这件事由角标「—」和沉底位置承担，说两遍反而挤掉名字。 */
      var tag = p.left ? '（弃局）' : (p.out ? '（见底）' : '');
      var name = el('div', 'settle-name', (p.nickname || '?') + tag);
      if (me) name.appendChild(el('i', 'settle-you', '我'));
      /* 并列冠军的「并列」胶囊：两颗皇冠并排，可能被读成「奖杯漏了名次」。
       * 只给冠军挂 —— 第 2 名并列时两个「2」本身就是并列的写法。 */
      if (r.champion && championCount > 1) name.appendChild(el('i', 'settle-tie', '并列'));
      var score = el('div', 'settle-score', p.score + ' 分');
      /* 净胜走 netCls / netText，和战绩卡、排行榜、玩家档案完全同一套：
       *   netText(0) = '0'（不带符号）   netCls(0) = 'flat'（中性灰）
       * 以前这里按「净胜非负」分成两态，把 0 归进了赢的那一档 —— 净胜 0 显示成
       * 红色，看着像赢了；而同一个 0 在排行榜是灰的。两套说法，只能有一个对。 */
      var net = p.score - CONFIG.INITIAL_SCORE;
      var netEl = el('div', 'settle-net', netText(net));
      netEl.className = 'settle-net ' + netCls(net);
      row.appendChild(rank); row.appendChild(name); row.appendChild(score); row.appendChild(netEl);
      /* 一个淡淡的箭头：不提示的话没人知道这一行能点（以前点了是看档案，
       * 现在点了是看这一把的回放 —— 两种情况都需要一个「可点」的信号）。 */
      row.appendChild(el('span', 'settle-go', '›'));
      /* 复盘提示只挂在「我」这一行，且只在卡片内部多一行 ——
       * 不单起一张卡，是因为它说的就是这一行的分，隔开就说不清归属了。 */
      if (me) {
        var recheck = recheckEl(room);
        if (recheck) row.appendChild(recheck);
      }
      list.appendChild(row);
    });
    return list;
  }

  /* ------------------------- 这一把分得怎么样 -------------------------
   *
   * 「理论上最高 +6 · 你拿了 +2」。
   *
   * 为什么要有：对手的牌永远是暗的，玩家此前**没有任何通道**知道自己分得好不好 ——
   * 赢了不知道是分法好还是运气，输了也一样。同类游戏（斗地主、麻将）都有复盘，
   * 这游戏 60 种分法比它们复杂得多，却只能靠「下次试试另一种」自学。
   *
   * 为什么只给自己算：这是复盘，不是排行榜。给别人挂一行最优分，
   * 结算页会变成公开处刑，玩家会去比较「他运气真好」，反而偏离「看自己的决策」。
   *
   * 为什么读 room.history 而不是 p.groups：下一把 dealAll 会覆盖 groups，
   * 而结算页渲染时已经是「这一把打完」。history 是唯一同时带手牌和每组 deltas 的地方。
   */
  function recheckEl(room) {
    var BL = (typeof window !== 'undefined') ? window.BestLine : null;
    /* 老客户端缓存里可能没有这个模块（sw 还没换）：整块不显示，不要白屏也不要报错。 */
    if (!BL || typeof BL.ofHand !== 'function') return null;
    var pid = state.myId;
    if (!pid) return null;

    /* ★ 取「刚打完的那一把」由 bestLine.lastHandRounds 负责，**不能用 room.handId**。
     * 实测踩过：结算页读到 handId=2，而 history 里那两条的 hid 都是 1 →
     * 过滤出 0 条，复盘行整块消失，而页面其余部分完全正常、没有任何报错。
     * 原因与取舍写在 bestLine.lastHandRounds 的注释里（handId 是「当前这把」，
     * 而结算页展示的是「上一把」）。 */
    var rounds = BL.lastHandRounds(room.history);

    var rec = null;
    try { rec = BL.ofHand(rounds, pid); } catch (e) { rec = null; }
    if (!rec) return null;

    var box = el('div', 'settle-recheck');
    if (rec.diff <= 0) {
      /* 实际 = 最优（diff 理论上不可能 <0，真出现说明枚举漏了分法 —— 那就别报「最优」，
       * 免得给玩家一个「你的实际分比理论最高还高」的荒唐结论）。 */
      if (rec.diff === 0) {
        box.appendChild(el('span', 'sr-note', '这一把分到了理论最高'));
        box.appendChild(el('span', 'sr-val', netText(rec.best)));
      }
      return box;
    }

    box.appendChild(el('span', 'sr-key', '理论最高'));
    box.appendChild(el('span', 'sr-val', netText(rec.best)));
    box.appendChild(el('span', 'sr-sep', '·'));
    box.appendChild(el('span', 'sr-key', '你拿了'));
    box.appendChild(el('span', 'sr-val ' + (rec.actual > 0 ? 'up' : (rec.actual < 0 ? 'down' : 'flat')), netText(rec.actual)));
    /* 差 3 分以上补一句 —— 1~2 分属于正常波动，每次都说会让提示变成噪音。
     * 用「再想想」而不是「你亏了」：亏不亏取决于运气，这个数字衡量的是决策。 */
    if (rec.diff >= 3) box.appendChild(el('span', 'sr-hint', '差 ' + rec.diff + ' 分，分牌可以再想想'));
    box.setAttribute('title', '按这一把所有人摊开的牌，重新枚举你的分法算出来的最好结果');
    return box;
  }

  /* 结算尾注拆成两段，因为两个地方要的量不一样：
   *   结算页   —— 原因 + 算法说明（第一次看的人需要知道净胜怎么算的）
   *   回看弹窗 —— 只要原因（回来查上一局分数的人，不需要再被教一遍公式）
   * 合并着写会导致弹窗里那半句在窄容器折成两行，公式的尾巴孤零零掉到第二行。 */
  function settleReasonText(room) {
    var why;
    /* ★ v103 起 'scoreZero' 不会再由新局产生（负分不结束游戏），
     * 这条分支只为**老战绩**留着 —— 战绩页点开两个月前的对局，
     * 那句原因还得念得成人话。别顺手删。 */
    if (room.endReason === 'scoreZero') why = '有人分数输到底，本局结束。';
    else if (room.endReason === 'someoneLeft') why = '有玩家离开，本局提前结束。';
    /* 打满把数：这是**正常收尾**，不是事故。文案别写成「提前结束」那种口气，
     * 顺带把把数报出来 —— 玩家需要知道自己是打满了 10 把，而不是被谁掐断的。 */
    else if (room.endReason === 'handLimit') {
      var lim = StateMachine.handLimitOf(room);
      /* v113：这里原来写「打满 N 局」—— 同一句话里「局」出现两次，
       * 而顶栏一直说「第 N/M 把」。术语统一成「把」，整场才叫「局」。 */
      why = isFinite(lim) ? ('打满 ' + lim + ' 把，本局结束。') : '打满预定把数，本局结束。';
    }
    /* 中途结束本局：以前这里没有分支，玩家点完同意跳到结算页，
     * 只看到一堆分数和自己没变的净胜，没人解释这一局为什么就完了。 */
    else if (room.endReason === 'dissolve') why = '本局提前结束，按当前分数结账。';
    else why = '';

    /* ★ 「算不算战绩」和「为什么结束」是两件事，不能绑在同一个分支上。
     * 三种结束原因都可能一分没打（对手掉线、谈崩了直接结束），
     * 而以前「不计入战绩」只写在 dissolve 分支里 —— 于是走「有人离开」的作废局，
     * 玩家看到一排 0 分、一句「本局提前结束」，却不知道这局根本没进档案。 */
    if (!room.voided) return why;
    return room.endReason === 'dissolve'
      ? '本局一分还没打就结束了，不计入战绩。'
      : why + '一分还没打，不计入战绩。';
  }

  function settleTipText(room) {
    /* 作废局不算净胜，就别再拿「净胜 = 最终分 − 20」把人往「我拿了多少」上引。
     * 那一排 0 不代表打平，代表什么都没发生。 */
    if (room.voided) return settleReasonText(room);
    /* 基准是 0 时公式退化成「净胜 = 最终分」，就照实写 ——
     * 写「− 初始 0 分」是在拿一个不存在的减数折腾人。
     * 保留 base 分支是为了这个参数哪天真被改成非 0 时，这句话不会变成错的。 */
    var base = CONFIG.INITIAL_SCORE;
    return settleReasonText(room)
      + (base ? ('净胜 = 最终分 − 初始 ' + base + ' 分') : '净胜 = 最终分');
  }

  function renderSettle(room) {
    var body = $('#settle-body');
    body.innerHTML = '';
    /* 内层包一层：让「列表 + 尾注」作为一个整体居中，
     * 而不是各自靠上排、把空白全堆在中间。 */
    var inner = el('div', 'settle-inner');
    inner.appendChild(settleListEl(room));
    inner.appendChild(el('p', 'settle-tip', settleTipText(room)));
    /* 含 AI 的局不算战绩 —— 这一句必须在结算页说。
     * 玩家此刻最想知道的就是「我这把算不算」，等到打开战绩页才发现没这一局，
     * 只会以为数据丢了。语气与净胜公式那行一致（一行小字），不另起一块。 */
    if (roomHasBot(room)) {
      inner.appendChild(el('p', 'settle-ai-note', '本局含 AI · 不计入战绩与排行榜'));
    }
    /* ★ v113（A-3）：下一把分数归零要**明说**。
     * 玩家看到「开始下一把」会默认分数延续（整场本来就是连着打的），
     * 开局后发现自己从 0 开始，第一反应是「我的分丢了」。
     * 只在「打满把数」这种还有下一把的场合显示 —— 中途解散/有人离开时没有下一把，
     * 写这句话只会让人以为还能接着打。 */
    if (room.endReason === 'handLimit') {
      inner.appendChild(el('p', 'settle-reset-note', '下一把分数从 0 分重新开始'));
    }
    body.appendChild(inner);
    /* 结算列表在横屏是滚动的（.ls #screen-settle .settle-body 有 max-height + overflow-y:auto），
     * 而移动端滚动条是隐藏的 —— 不挂底部渐隐的话，第 5 行会被硬切成半行（844×390 实测），
     * 看起来像渲染坏了，而不是「下面还能滑」。 */
    bindScrollFadeOnce(body);
    /* 立刻量一次是量不准的：innerHTML 刚换上，布局还没落定，
     * clientHeight 此时可能是 0 → more 恒为 false → 渐隐永远不挂。
     * 用 rAF 等一帧再量，外加一次 setTimeout 兜住 rAF 被节流的情况。 */
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () { syncScrollFade(body); });
    }
    setTimeout(function () { syncScrollFade(body); }, 80);

    /* 结算页不再有「只有房主能开」的按钮：按钮对所有人可见（见 index.html #btn-next），
     * 这里只负责告诉还没点的人——已经有人进下一局了。
     * 这一句解决的是「我该不该点」的犹豫：看到别人已经在等，
     * 就知道不点的话这一局跟自己无关了。 */
    var joined = StateMachine.nextRoundPlayers(room).length;
    $('#settle-wait').textContent = joined > 0
      ? '已经有 ' + joined + ' 人进入下一把'
      : '';
  }

  /* 就位态回看上一局结算：只读弹窗，不写任何状态。
   * 它存在的理由不是「多加一个入口」，而是「回结算页」那颗按钮走的是 unWantNext ——
   * 想看一眼上局拿了几分，代价是撤回报名、把全员准备打回，另外几个人得重新等。
   * 看一眼数据不该有代价。 */
  function openPrevResult() {
    var room = state.room;
    if (!room || room.phase !== StateMachine.PHASE.SETTLED) return;
    var body = $('#prev-result-body');
    body.innerHTML = '';
    var inner = el('div', 'settle-inner');
    inner.appendChild(settleListEl(room));
    /* 只放原因，不放算法公式 —— 公式是给第一次看结算页的人解释用的，
     * 这里玩家是回来查分数的，不需要再被教一遍（而且窄容器里会折成两行）。 */
    var reason = settleReasonText(room);
    if (reason) inner.appendChild(el('p', 'settle-tip', reason));
    body.appendChild(inner);
    showModalEl('prev-result-modal');
  }

  function closePrevResult() { hideModalEl('prev-result-modal'); }
    return {
      PAT_FX_MS: PAT_FX_MS,
      pat: pat,
      patPtColor: patPtColor,
      patTrio: patTrio,
      patternFxFlag: patternFxFlag,
      patLabel: patLabel,
      buildPatternFx: buildPatternFx,
      playPatternFx: playPatternFx,
      endPatternFx: endPatternFx,
      stopPatternFx: stopPatternFx,
      resultGroupCard: resultGroupCard,
      SEQ_HOLD: SEQ_HOLD,
      seq: seq,
      seqHold: seqHold,
      stopResultSeq: stopResultSeq,
      closeBreakCard: closeBreakCard,
      playResult: playResult,
      seqSecs: seqSecs,
      seqLastText: seqLastText,
      renderResultStep: renderResultStep,
      advanceResult: advanceResult,
      finishResultSeq: finishResultSeq,
      roundNet: roundNet,
      maybeBreakCard: maybeBreakCard,
      settleRank: settleRank,
      settleListEl: settleListEl,
      settleReasonText: settleReasonText,
      settleTipText: settleTipText,
      renderSettle: renderSettle,
      openPrevResult: openPrevResult,
      closePrevResult: closePrevResult
    };
  }

  global.LXW = global.LXW || {};
  global.LXW.settleView = create;

})(typeof self !== 'undefined' ? self : this);
