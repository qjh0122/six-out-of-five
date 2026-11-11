/**
 * 通用小工具（纯函数，不碰应用状态）
 *
 * ── 为什么把它从 game.js 里拆出来 ────────────────────────────────────
 * 这些函数是「被所有人用、谁都不该拥有」的那一类：`$` / `el` / `esc` 几乎每个
 * 渲染函数都要调。它们原来散在 8000 行的 game.js 里，第一个函数在第 11 行、
 * `netText` 在第 3592 行、`cardText` 在第 1917 行 —— 找一条格式化规则等于翻三处。
 *
 * ── 拆分手法（本轮所有模块共用，写在最前面省得每个文件重讲一遍）──────
 * 不重写函数体，**逐字搬移**，外面套一层工厂：
 *
 *     window.LXW.utils = (function () { ...原函数... return { ... }; })();
 *
 * game.js 里再解构成同名局部变量：
 *
 *     var U = window.LXW.utils;
 *     var $ = U.$, el = U.el, esc = U.esc;
 *
 * 于是 **8000 行里所有调用点一个字都不用改**。这是本轮能拆得动的前提 ——
 * 换个思路「把 state 挂到命名空间上、调用点全改成 LXW.state.xxx」，改的是
 * 几千处调用，任何一处漏改都是运行时炸，而不是编译期报错。
 *
 * ── 这里的边界 ────────────────────────────────────────────────────
 * 只放**没有依赖、没有状态、输入输出确定**的函数。凡是要读 `state`、
 * 要发请求、要碰 DOM 事件的，一概不进这个文件 —— 它们各自有自己的模块。
 *
 * 浏览器全局：`window.LXW.utils`
 */
(function (global) {
  'use strict';

  var api = {};

  /* ---------------------------- DOM 便捷 ---------------------------- */
  function $(sel) { return document.querySelector(sel); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  };

  /* esc 的唯一职责是「把数据塞进 HTML 前，先让它可以安全地塞进去」。
   * 所以要处理两类输入：① 危险字符 ② 根本不是字符串的东西。
   * 第二类以前直接 String() —— 于是 undefined / null 会变成页面上看得见的
   * 字面量「undefined」「null」（结算结果缺 winnerNickname、昵称为 null 时都会出现）。
   * 这里统一转空串：数据异常时宁可留白，也不要让玩家读到内部字段名。 */
  function esc(s) {
    if (s === undefined || s === null) return '';
    return String(s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  };

  /* ---------------------------- 头像配色 ---------------------------- */
  var AVATAR_COLORS = ['#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#1abc9c', '#3498db', '#9b59b6', '#e84393'];
  function colorFor(id) {
    var h = 0;
    for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  };
  /* 昵称截断：只防「真的放不下」，正常长度一律完整显示。
   *
   * 原来是 `name.length > 4` 就截成 4 个字 —— 按**字符数**算，对一个 8 个半角字母的
   * 英文名是误伤：座位名块有 80~132px（seatRing 的 nmw），20px 字号下
   * 8 个半角完全放得下，却被截成「Playe…」。
   * 中文名同样吃亏：5 个中文 = 100px，也在 112px 之内，同样被截。
   *
   * 改成按**显示宽度**估算（全角 2、半角 1），上限 12 个等效半角 ——
   * 约等于 6 个中文或 12 个英文。超过才截，且保留 CSS 的 ellipsis 兜底：
   * 容器更窄时（窄屏 / 人多）它按真实像素收尾，这里只管「别没事就截」。
   * 按码点迭代，emoji 不会被切成两个问号。 */
  var SHORT_W = 12;
  function short(name) {
    var chars = Array.from(String(name == null ? '' : name));
    var w = 0, out = '';
    for (var i = 0; i < chars.length; i++) {
      var cw = chars[i].codePointAt(0) > 0x2e7f ? 2 : 1;   // 0x2E7F 之后基本是 CJK / 全角 / emoji
      if (w + cw > SHORT_W) return out + '…';
      w += cw;
      out += chars[i];
    }
    return out;
  }

  /* 一行放不下时**缩字号**，而不是截字。返回目标字号（设计 px）。
   *
   * 为什么要有这个函数：`short()` 只能按「估算的字宽」决定截不截，它没有
   * 真实像素 —— 同样 6 个字，在 132px 的座位里富余、在 80px 的座位里溢出，
   * 它算不出来。座位名的真正约束是「这一格到底有多宽」，只能实测。
   *
   * 缩字号比截字好在：**名字是身份**。「示例玩家…」和「示例玩家甲」在牌桌上
   * 是两个人还是一人被判错，代价比字小一号大得多。所以能缩就缩，缩到底
   * （floorFs）还放不下才交给 CSS 省略号 —— 那是物理极限，不是懒得做。
   *
   * 线性近似：字宽 ∝ 字号，所以 `baseFs × avail / textW` 一步就到位。
   * 三个入参只要有一个非正（还没布局 / 没量到）就原样返回，绝不猜。
   */
  function fitFont(baseFs, availW, textW, floorFs) {
    var b = Number(baseFs), a = Number(availW), t = Number(textW), f = Number(floorFs);
    if (!(b > 0)) return 0;
    if (!(a > 0) || !(t > 0)) return b;       // 没量到：保持原字号
    if (t <= a) return b;                     // 放得下：一个像素都不动
    if (!(f > 0) || f > b) f = b * 0.5;       // 没给下限 / 下限比原字号还大：按半号保底
    var want = b * a / t;
    return want < f ? f : want;
  }

  /* ---------------------------- 数值与时间格式 ---------------------------- */
  function netText(n) {
    if (n > 0) return '+' + n;
    if (n < 0) return String(n);   // 自带负号
    return '0';                    // 平：不带符号
  };
  function netCls(n) {
    if (n > 0) return 'up';
    if (n < 0) return 'down';
    return 'flat';
  };
  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function fmtTime(ts) {
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '--';
    var body = pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    // 200 条记录会跨年，非同年补年份（spec §10.3）
    return d.getFullYear() === new Date().getFullYear() ? body : (d.getFullYear() + '-' + body);
  };

  /* ---------------------------- 牌名 ---------------------------- */
  var SUIT_CHAR = { spade: '\u2660', heart: '\u2665', club: '\u2663', diamond: '\u2666' };
  function cardText(c) {
    if (!c) return '?';
    /* 两张王同为 suit='joker'，靠 rank 分：15 = 大王、14.5 = 小王。
     * 判据写成 rank >= 14.5（而不是 === 15）是为了兜住『suit 丢了但 rank 还在』的脏数据。 */
    if (c.suit === 'joker' || c.rank >= 14.5) return c.rank >= 15 ? '大王' : '小王';
    var r = c.rank === 14 ? 'A'
      : c.rank === 13 ? 'K'
      : c.rank === 12 ? 'Q'
      : c.rank === 11 ? 'J'
      : String(c.rank);
    return r + (SUIT_CHAR[c.suit] || '');
  };

  /* ---- 导出 ----
   * ★ 函数一律写成 `function 名字()` 声明，而不是 `api.名字 = function`：
   *   仓库里几十条源码守卫用的是 `/function (\w+)\(/` 这类正则。
   *   换成赋值形式，守卫会集体变红 —— 而那些守卫守的是设计意图
   *   （「这条规则必须写成独立纯函数」），不该为了重构去改它们。 */
  api.$ = $;
  api.el = el;
  api.esc = esc;
  api.AVATAR_COLORS = AVATAR_COLORS;
  api.colorFor = colorFor;
  api.short = short;
  api.fitFont = fitFont;
  api.netText = netText;
  api.netCls = netCls;
  api.pad2 = pad2;
  api.fmtTime = fmtTime;
  api.SUIT_CHAR = SUIT_CHAR;
  api.cardText = cardText;

  global.LXW = global.LXW || {};
  global.LXW.utils = api;
  /* v111 起 esc 只有这一份实现，其它模块（avatar / achievementsView）在浏览器里
   * 取 LXW.utils，在 Node 测试里 require 本文件 —— 所以这里要能被 require。 */
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof self !== 'undefined' ? self : this);
