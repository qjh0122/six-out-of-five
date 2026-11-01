/**
 * 头像预设库（v89 · 设计稿 §9.2 / P1a）
 *
 * 为什么不是「上传照片」：上传要配举报入口、审核与处置流程，没有那三样就开上传
 * 等于把风险直接放给全桌（§9.3 自己也这么写）。而「昵称首字 + 哈希色」的问题是
 * 五个人里两个都叫「阿」时头像一模一样 —— 玩家认人靠的是头像，不是字。
 *
 * 48 款 = 8 种底纹 × 6 组双色。纯 SVG（data URI），不走网络：
 *   · 不占 PRECACHE 体积，不产生 48 个请求；
 *   · 任何 dpr 下都清晰（矢量），不会像位图那样在高分屏糊；
 *   · 后台/色弱/夜间都不依赖图片内容，对比度由调色板保证。
 *
 * 没选过头像的人（老账号、AI）按 playerId 哈希落到某一款上 ——
 * 一上线就「人人有头像」，不需要每个人先去设置页点一次。
 */
(function (global, factory) {
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = mod;
  } else {
    global.Avatar = mod;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 6 组双色：底色深、图色亮，保证在任何桌面上都看得清轮廓。
   * 不是纯随机配色 —— 底色都压到 L≈25%，五种头像并排时不会有一款特别刺眼。 */
  var PALETTES = [
    ['#1E5F4B', '#F5C15C'],   // 松绿 + 金（牌桌主色）
    ['#123A5C', '#7FD1C1'],   // 深蓝 + 青
    ['#3A1F4E', '#F29BA5'],   // 紫 + 粉
    ['#4A2A12', '#FFD79A'],   // 棕 + 米
    ['#0F3B3B', '#9BE7C4'],   // 墨绿 + 薄荷
    ['#2B2F52', '#C9B6FF']    // 藏蓝 + 薰衣草
  ];

  var SHAPES = ['split', 'dots', 'rings', 'waves', 'checker', 'rays', 'arcs', 'diamond'];
  var COUNT = PALETTES.length * SHAPES.length;   // 48

  /* 形状画在 64×64 的 viewBox 里，只用一个前景色 + 透明度层，
   * 这样换调色板不用重画形状，48 款只需要 8 段几何。 */
  var GEOM = {
    split: '<path d="M0 64L64 0v64z" fill="{c}" opacity="0.9"/>'
      + '<circle cx="18" cy="18" r="9" fill="{c}" opacity="0.55"/>',
    dots: '<g fill="{c}" opacity="0.85">'
      + '<circle cx="16" cy="16" r="7"/><circle cx="42" cy="26" r="7"/>'
      + '<circle cx="24" cy="45" r="7"/><circle cx="50" cy="50" r="5"/></g>',
    rings: '<g fill="none" stroke="{c}" stroke-width="5" opacity="0.85">'
      + '<circle cx="32" cy="32" r="10"/><circle cx="32" cy="32" r="21"/></g>'
      + '<circle cx="32" cy="32" r="4" fill="{c}"/>',
    waves: '<g fill="none" stroke="{c}" stroke-width="6" stroke-linecap="round" opacity="0.85">'
      + '<path d="M-4 22q14-12 28 0t28 0"/><path d="M-4 40q14-12 28 0t28 0"/></g>',
    checker: '<g fill="{c}" opacity="0.8"><rect x="0" y="0" width="24" height="24"/>'
      + '<rect x="40" y="0" width="24" height="24"/><rect x="20" y="20" width="24" height="24"/>'
      + '<rect x="0" y="40" width="24" height="24"/><rect x="40" y="40" width="24" height="24"/></g>',
    rays: '<g fill="{c}" opacity="0.8">'
      + '<path d="M32 32L32 0h10z"/><path d="M32 32L64 32v10z"/>'
      + '<path d="M32 32L32 64H22z"/><path d="M32 32L0 32v-10z"/></g>'
      + '<circle cx="32" cy="32" r="7" fill="{c}"/>',
    arcs: '<path d="M0 64a32 32 0 0 1 64 0z" fill="{c}" opacity="0.85"/>'
      + '<path d="M12 64a20 20 0 0 1 40 0z" fill="#000" opacity="0.22"/>',
    diamond: '<path d="M32 6l26 26-26 26L6 32z" fill="{c}" opacity="0.88"/>'
      + '<path d="M32 20l12 12-12 12-12-12z" fill="#000" opacity="0.2"/>'
  };

  function valid(id) {
    var s = String(id == null ? '' : id);
    if (!/^a\d{1,2}$/.test(s)) return false;
    var n = Number(s.slice(1));
    return n >= 0 && n < COUNT;
  }

  function indexOf(id) {
    return valid(id) ? Number(String(id).slice(1)) : -1;
  }

  /* 稳定哈希：同一个 playerId 永远是同一款，跟设备/登录顺序无关。
   * 31 是质数，够把「probe12345 / probe12346」这类相近 id 打散。 */
  function hashOf(pid) {
    var s = String(pid == null ? '' : pid);
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h;
  }

  /* 这个玩家「实际用哪一款」：选过就用选的，没选过按 id 哈希 */
  function forPlayer(pid, chosen) {
    var i = indexOf(chosen);
    if (i < 0) i = hashOf(pid) % COUNT;
    return 'a' + i;
  }

  function spec(i) {
    var n = ((i % COUNT) + COUNT) % COUNT;
    var shape = SHAPES[n % SHAPES.length];
    var pal = PALETTES[Math.floor(n / SHAPES.length) % PALETTES.length];
    return { id: 'a' + n, shape: shape, bg: pal[0], fg: pal[1] };
  }

  var CACHE = {};

  /* 一款头像的 data URI。size 只影响内联宽高，矢量本身不变 ——
   * 同一个 id 不同尺寸不需要重新编码（浏览器按 CSS 缩放即可）。 */
  function dataUri(id) {
    var i = indexOf(id);
    if (i < 0) return '';
    if (CACHE[i]) return CACHE[i];
    var s = spec(i);
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">'
      + '<rect width="64" height="64" fill="' + s.bg + '"/>'
      + GEOM[s.shape].replace(/\{c\}/g, s.fg)
      + '</svg>';
    /* encodeURIComponent 而不是 base64：可读、体积小 1/3，且不用 btoa（老 WebView 上
     * btoa 对非 Latin1 会抛 InvalidCharacterError）。 */
    CACHE[i] = 'data:image/svg+xml,' + encodeURIComponent(svg);
    return CACHE[i];
  }

  /* 直接可用的 <img>。cls 用来挂尺寸类（.av-68 / .av-44 …）。
   * alt 留空：头像是装饰，名字就在旁边（读屏不该重复念一遍）。 */
  function img(pid, chosen, cls) {
    var id = forPlayer(pid, chosen);
    return '<img class="avatar-img' + (cls ? ' ' + cls : '') + '"'
      + ' src="' + dataUri(id) + '" data-avatar="' + id + '" alt="" aria-hidden="true" draggable="false">';
  }

  /* 上传照片的地址（P1b）。
   * v 是版本号，同时是**唯一**的访问凭据：服务端只认「和档案里一致的那个 v」，
   * 不带 v 一律 404 —— 于是这个 URL 一旦泄露，泄露的也只是当时那一版。
   * encodeURIComponent 是防 pid 里出现奇怪字符（服务端虽然只生成 p_数字）。 */
  function photoUrl(pid, v) {
    var p = String(pid == null ? '' : pid);
    var ver = String(v == null ? '' : v);
    if (!p || !ver) return '';
    return '/api/avatar/' + encodeURIComponent(p) + '?v=' + encodeURIComponent(ver);
  }

  /* 上传照片渲染成 <img>。和预设款共用 .avatar-img 的尺寸/圆形裁切，
   * 只多一个 data-photo —— 探针靠它区分「预设」和「照片」。 */
  function photoImg(pid, v, cls) {
    var url = photoUrl(pid, v);
    if (!url) return '';
    return '<img class="avatar-img is-photo' + (cls ? ' ' + cls : '') + '"'
      + ' src="' + url + '" data-photo="' + esc(String(v)) + '" alt="" aria-hidden="true"'
      + ' draggable="false" loading="lazy" decoding="async">';
  }

  /* 转义只留一份：js/gameUtils.js（v111 去重）。这里不再自己处理
   * & < > " ' 五个字符 —— 抄一份的后果是改一处忘一处，两个页面显示不一样。 */
  var U = (typeof LXW !== 'undefined' && LXW.utils) || null;
  if (!U && typeof require === 'function') {
    try { U = require('./gameUtils.js'); } catch (e) { U = null; }
  }
  function esc(s) { return U ? U.esc(s) : ''; }

  /**
   * 把一张原图裁成正方形并缩到 size（P1b 的客户端压缩）。
   *
   * 为什么在客户端压：原图动辄 3~5MB，服务端上限 300KB。传上去再拒，
   * 用户等的是十几秒的失败；本地 200ms 压完，传的是 15KB。
   * 「短边铺满 + 居中裁切」而不是拉伸：拉扁的人脸比裁掉两边更难看。
   *
   * 纯函数，方便单测：只算裁剪矩形，不碰 canvas。
   * @returns {{sx:number, sy:number, side:number}}
   */
  function coverRect(sw, sh) {
    var w = Number(sw) || 0;
    var h = Number(sh) || 0;
    if (w <= 0 || h <= 0) return { sx: 0, sy: 0, side: 0 };
    var side = Math.min(w, h);
    return { sx: Math.round((w - side) / 2), sy: Math.round((h - side) / 2), side: side };
  }

  function list() {
    var out = [];
    for (var i = 0; i < COUNT; i++) {
      var s = spec(i);
      out.push({ id: s.id, shape: s.shape, bg: s.bg, fg: s.fg, src: dataUri(s.id) });
    }
    return out;
  }

  return {
    COUNT: COUNT,
    PALETTES: PALETTES,
    SHAPES: SHAPES,
    valid: valid,
    indexOf: indexOf,
    forPlayer: forPlayer,
    dataUri: dataUri,
    img: img,
    photoUrl: photoUrl,
    photoImg: photoImg,
    coverRect: coverRect,
    list: list
  };
});
