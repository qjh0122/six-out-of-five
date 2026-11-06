/**
 * 「下一局为什么开不了」的文案表（v126）
 *
 * ── 为什么单独成文件
 * 状态机给出原因码（`SM.nextRoundGate`），但**话怎么说**是视图的事。
 * 以前这段判断散在 game.js 的 `renderRoom` 里（一长串 if/else），
 * 结算页的 `settleView` 又自己拼了一遍 —— 两处口径一旦分叉，
 * 就会出现「就位态说在等张三、结算页说没人上场」。
 *
 * 放在这里之后：
 *   · 一张表对应一个 code，没有第二个分支；
 *   · 测试能直接 `require` 它，断言「表的 key 集合 === GATE_CODES 的 key 集合」——
 *     以后加第 6 个否决条件时，只改状态机不改这张表的提交会立刻红；
 *   · 不用 grep 源码判断「视图渲染了几个原因」（那种守卫挡不住换个写法）。
 *
 * ── 为什么要有「阶段」这个参数
 * 同一句「人不够」，在两张屏上说的不是同一件事：
 *   · 结算页（settle）：我还没报名，所以要说「点开始下一局就开」；
 *   · 就位态（ready）：我已经报名了，所以要说「还差 N 人，可以补 AI」。
 * 用一句话糊住两种情况，必然在其中一种里指错方向。
 *
 * 浏览器全局：`window.LXW.nextRoundHints`；Node 里 `module.exports` 直接可用。
 */
(function (global, factory) {
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else {
    global.LXW = global.LXW || {};
    global.LXW.nextRoundHints = mod;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 昵称截断：长昵称会把整行挤成两行，而这两屏都没有多余高度。
   * 单独一个函数而不是内联 slice，是为了让测试能验证「最多两个名字 + 等 N 人」。 */
  function shortName(n) {
    var s = String(n == null ? '' : n).trim();
    if (!s) return '他';
    return s.length > 4 ? s.slice(0, 4) : s;
  }

  function whoText(list) {
    var names = (list || []).map(function (p) { return shortName(p && p.nickname); });
    if (!names.length) return '';
    if (names.length <= 2) return names.join('、');
    return names.slice(0, 2).join('、') + ' 等 ' + names.length + ' 人';
  }

  /* 「在等谁」——必须把**我自己**说成「你」。
   *
   * 这条不是措辞偏好。旧文案「还在等你」在真机上报过一个洞：
   * 最后那个没表态的人看到「已经有 2 人进入下一把」，他不知道自己是那个
   * 卡住整桌的人。改成第三人称点名（「等 旅探84 点…」）同样不行 ——
   * 玩家读自己的昵称要慢半拍，而这正是需要他立刻反应的那一秒。 */
  function waitingText(ctx) {
    var myId = ctx.myId;
    var all = ctx.pending || [];
    var mine = !!myId && all.some(function (p) { return p && p.id === myId; });
    var others = myId ? all.filter(function (p) { return !p || p.id !== myId; }) : all;
    var who = whoText(others);

    if (mine && who) return '还在等你和 ' + who + ' 点「开始下一局」';
    if (mine) return '还在等你点「开始下一局」';
    if (who) return '等 ' + who + ' 点「开始下一局」…';
    return '等其他人点「开始下一局」…';
  }

  /* 一张表，一个 code 一条。**不许在这里写条件分支** ——
   * 一有分支，测试断言的「枚举等值」就退化成「这段代码里出现过这个词」。 */
  var HINTS = {
    OK: function () {
      /* 正常情况下看不到这句：code 一旦是 OK，服务端当场就发牌了。
       * 留着是因为「没有文案」会让这一行变成空白，比一句过渡语更像坏了。 */
      return '人齐了，正在发牌…';
    },

    HOLD: function (ctx) {
      if (ctx.isOwner) return '你在等朋友进来 · 人齐了点「人齐了，开牌」';
      return '房主在等朋友进来，先不开牌';
    },

    NEED_PLAYERS: function (ctx) {
      var joined = Math.max(0, Number(ctx.joined) || 0);
      var need = Math.max(2, Number(ctx.need) || 2);
      var lack = Math.max(1, need - joined);
      /* 掉线的人单独点名：他不是「还在犹豫」，是根本没连接。
       * 不点名的话，玩家会去等一个不会动的人 —— 这正是这个版本要修的东西。 */
      var off = ctx.offline && ctx.offline.length
        ? ' · ' + whoText(ctx.offline) + '已掉线'
        : '';

      if (joined === 0) {
        /* 一个人都没上场：别说「补 AI」。
         * 2 人房要补 2 只，会造出「0 个真人 + 2 只 AI 自己打、真人在旁边看」的空转局。
         * 真正的路就在旁边那颗主按钮上 —— 按下它 joined 就变 1，
         * 那时候再说「补 AI」才是对的（补 1 只就够）。 */
        return '这一局还没人上场 · 点「开始下一局」就开' + off;
      }
      if (ctx.isOwner) {
        return '还差 ' + lack + ' 人才能开 · 可以先补 AI 队友，或等朋友进来' + off;
      }
      return '还差 ' + lack + ' 人才能开 · 房主可以补 AI 队友' + off;
    },

    WAITING_OTHERS: function (ctx) {
      return waitingText(ctx);
    },

    WAITING_OFFLINE: function (ctx) {
      var who = whoText(ctx.offline && ctx.offline.length ? ctx.offline : ctx.pending);
      /* 「等他重连」和「不等他」都写出来：前者是希望，后者是出口。
       * 只说前者，全桌会一直盯着一个黑掉的头像。 */
      return (who ? who + ' ' : '有人 ') + '掉线了 · 等他重连，或者补 AI 队友继续';
    }
  };

  /* 视图唯一入口。
   *
   * @param {string} code  SM.GATE_CODES 里的值
   * @param {object} ctx   { stage, isOwner, pending, offline, joined, need }
   * @returns {string}     给玩家看的一句话；未知 code 返回空串（不编话） */
  function hintFor(code, ctx) {
    ctx = ctx || {};
    var f = HINTS[code];
    if (!f) return '';
    return f(ctx);
  }

  /* 供守卫用：这张表覆盖了哪些 code。
   * 测试拿它与 SM.GATE_CODES 比对 —— 两边不等值就是「状态机多了一个否决条件，
   * 但玩家看不到原因」，那正是 v121 的 bug 形态。 */
  function codes() {
    return Object.keys(HINTS);
  }

  return { hintFor: hintFor, codes: codes, whoText: whoText };
});
