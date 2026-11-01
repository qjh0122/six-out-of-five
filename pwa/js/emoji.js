/**
 * 表情与短语的**唯一清单**（双端同源）
 *
 * 为什么单独抽一个模块，而不是前端写一份、服务端再抄一份：
 * 「表情 id 白名单」是典型的**两处配置、一处改漏就出事**的地方 ——
 * 前端加了一张新表情、服务端白名单没跟上，表现是「点了一下什么都没发生」，
 * 而且只在线上发生。这个仓库已经被同类问题咬过一次（hub.js 私抄 MAX_PLAYERS、
 * 原型手抄一份 engine.js），所以这里从一开始就只有一份。
 *
 *   前端 <script src="js/emoji.js"> → global.Emoji
 *   服务端 require('..//pwa/js/emoji.js') → 校验 id 就调 Emoji.isValid()
 *
 * 协议（服务端只转发、不落库）：
 *   C→S  { type:'emoji', payload:{ to:'*' | playerId, id:'e3' | 'p3' } }
 *   S→C  { type:'emoji', payload:{ from:playerId, to, id, at } }
 *
 *   · to = '*' 表示全场（自己也能看到自己发的）；
 *   · id 覆盖两类：e0~e12 表情图，p0~p7 固定短语。
 *   · **短语也是固定清单，没有自由输入** —— 这是刻意的：
 *     一旦允许打字，就需要敏感词过滤、举报、封禁一整套东西，
 *     而这里的短语本来就是「懒得打字时的一键嘴替」。
 */
(function (global, factory) {
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = mod;
  } else {
    global.Emoji = mod;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 13 张，用参考截图裁出来的位图（scripts/crop-emoji.py）。
   * 素材替换时只改 png 与这里的 file，业务代码不用动。 */
  var EMOJI = [
    { id: 'e0', file: 'e0-dizzy.png', name: '头晕' },
    { id: 'e1', file: 'e1-devil.png', name: '恶魔' },
    { id: 'e2', file: 'e2-money.png', name: '财迷' },
    { id: 'e3', file: 'e3-confused.png', name: '疑惑' },
    { id: 'e4', file: 'e4-love.png', name: '花痴' },
    { id: 'e5', file: 'e5-cry.png', name: '大哭' },
    { id: 'e6', file: 'e6-grin.png', name: '龇牙' },
    { id: 'e7', file: 'e7-angry.png', name: '生气' },
    { id: 'e8', file: 'e8-smug.png', name: '得意' },
    { id: 'e9', file: 'e9-sweat.png', name: '流汗' },
    { id: 'e10', file: 'e10-rage.png', name: '暴怒' },
    { id: 'e11', file: 'e11-shock.png', name: '惊讶' },
    { id: 'e12', file: 'e12-grit.png', name: '咬牙' }
  ];

  /* 8 条固定短语。文案与原型一致，改文案只改这里。 */
  var PHRASES = [
    { id: 'p0', text: '朋友，看你打牌可真费劲。' },
    { id: 'p1', text: '快点吧，牌在你手上都下崽了。' },
    { id: 'p2', text: '你咋能这幸的。' },
    { id: 'p3', text: '包开挂了先。' },
    { id: 'p4', text: '一哈乏了。' },
    { id: 'p5', text: '小树不修不直溜，人不修理哏赳赳。' },
    { id: 'p6', text: '呦，跑挺快呀！' },
    { id: 'p7', text: '哈哈，真爽，太过瘾了。' }
  ];

  var ASSET_DIR = './assets/emoji/';
  var BY_ID = {};
  var i;
  for (i = 0; i < EMOJI.length; i++) {
    EMOJI[i].kind = 'emoji';
    EMOJI[i].src = ASSET_DIR + EMOJI[i].file;
    BY_ID[EMOJI[i].id] = EMOJI[i];
  }
  for (i = 0; i < PHRASES.length; i++) {
    PHRASES[i].kind = 'phrase';
    BY_ID[PHRASES[i].id] = PHRASES[i];
  }

  /* 全场目标常量：前后端都写 '*'，不写 'all' ——
   * 'all' 有可能撞上某个真实 playerId（服务端 playerId 是随机串，理论上可能）。 */
  var BROADCAST = '*';

  /* 限流：同一个人 2 秒只能发 1 条。表情是「锦上添花」，
   * 刷屏的代价远大于多等 2 秒 —— 这也是服务端唯一的节流点。 */
  var MIN_INTERVAL_MS = 2000;

  return {
    EMOJI: EMOJI,
    PHRASES: PHRASES,
    BROADCAST: BROADCAST,
    MIN_INTERVAL_MS: MIN_INTERVAL_MS,
    /* id 最长 4 个字符（e12 / p7），服务端据此先做长度上限再查表 */
    ID_MAX_LEN: 4,

    list: function () { return EMOJI; },
    phrases: function () { return PHRASES; },
    get: function (id) { return BY_ID[id] || null; },
    isValid: function (id) { return Object.prototype.hasOwnProperty.call(BY_ID, id); },
    isPhrase: function (id) {
      var e = BY_ID[id];
      return !!(e && e.kind === 'phrase');
    },
    /* 发给对方的显示文案：表情用名字（读屏要念「对方发来一个 大哭」），短语就是原文 */
    label: function (id) {
      var e = BY_ID[id];
      if (!e) return '';
      return e.kind === 'phrase' ? e.text : e.name;
    }
  };
});
