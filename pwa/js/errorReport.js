/**
 * 前端错误上报（P3-5）
 *
 * 为什么需要：线上玩家 JS 抛异常时服务端一无所知。PWA 让这件事更糟 ——
 * Service Worker 缓存了旧版 JS 后，错误只在用户端复现，而且**每次打开都发生**，
 * 而服务端日志一片安静，你连"有人在用"都判断不了。
 *
 * 设计上的取舍：
 *  - **不引第三方 SDK**。几十行 sendBeacon 足够定位问题，服务端日志用 grep 就能查。
 *  - **每会话最多 10 条**，同一 message 只报一次。一个渲染循环里的异常一秒能抛几百次，
 *    不节流的话上报本身就会把服务端打满。
 *  - **不做重试**。上报是尽力而为，失败就放弃；为了"确保上报成功"而加队列和重试，
 *    等于在游戏里塞一个额外的可靠性系统，不划算。
 *  - **字段全部截断**。stack 动辄几千字，先把体积压住。
 *
 * 这个文件刻意不依赖任何其他模块，要在最早期加载 —— game.js 里的启动异常也要能报到。
 */
(function (global, factory) {
  var mod = factory(global);
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else global.ErrorReport = mod;
})(typeof self !== 'undefined' ? self : this, function (global) {

  var MAX_PER_SESSION = 10;   // 单会话上限
  var MAX_MESSAGE = 300;
  var MAX_STACK = 800;
  var MAX_SOURCE = 160;

  var sentCount = 0;
  var seenKeys = Object.create(null);

  function trim(v, n) {
    var s = String(v == null ? '' : v);
    return s.length > n ? s.slice(0, n) : s;
  }

  /** 版本号取自 meta，和 health 里那个 pwa 字段同源，方便把报错和发版对上 */
  function version() {
    try {
      if (typeof document === 'undefined') return '';
      var m = document.querySelector('meta[name="app-version"]');
      return m ? String(m.getAttribute('content') || '') : '';
    } catch (e) { return ''; }
  }

  function sharecode() {
    try {
      if (typeof location === 'undefined') return '';
      return new URLSearchParams(location.search || '').get('sharecode') || '';
    } catch (e) { return ''; }
  }

  /** 网关要求所有请求带 sharecode，漏了就是 403，上报会静默丢失 */
  function endpoint() {
    var sc = sharecode();
    return sc ? '/api/client-error?sharecode=' + encodeURIComponent(sc) : '/api/client-error';
  }

  /**
   * 发送。优先 sendBeacon：页面要卸载时（用户直接杀掉）fetch 会被取消，beacon 不会。
   * beacon 返回 false（浏览器决定不发）时退回 fetch + keepalive。
   */
  function send(payload) {
    var body = JSON.stringify(payload);
    var url = endpoint();
    try {
      if (typeof navigator !== 'undefined' && navigator.sendBeacon && typeof Blob !== 'undefined') {
        var blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon(url, blob)) return true;
      }
    } catch (e) { /* 某些浏览器在隐私模式下会抛，继续走 fetch */ }
    try {
      if (typeof fetch !== 'function') return false;
      var p = fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true
      });
      if (p && typeof p.catch === 'function') p.catch(function () {});
      return true;
    } catch (e) { return false; }
  }

  /**
   * 记录一条。返回 true 表示真的发出去了。
   * dedupe 的 key 用「类型 + message」，不含 stack —— 同一处异常在不同帧里
   * stack 可能略有差异，光靠 stack 去重会漏。
   */
  function capture(kind, message, extra) {
    /* 整个函数包在 try 里：它跑在**错误处理路径上**，
     * 一旦自己抛异常就会把原始错误吞掉，问题反而更难查。
     * 调用方（install 里的监听器）虽然也有 try，但直接调 capture 的路径也得安全。 */
    try {
      if (sentCount >= MAX_PER_SESSION) return false;
      var msg = trim(message, MAX_MESSAGE);
      if (!msg) return false;
      var key = String(kind || 'error') + '|' + msg;
      if (seenKeys[key]) return false;
      seenKeys[key] = 1;
      sentCount++;

      var ex = extra || {};
      return send({
        kind: trim(kind || 'error', 20),
        message: msg,
        source: trim(ex.source, MAX_SOURCE),
        lineno: Number(ex.lineno) || 0,
        colno: Number(ex.colno) || 0,
        stack: trim(ex.stack, MAX_STACK),
        version: version(),
        path: trim(typeof location !== 'undefined' ? location.pathname : '', 120),
        ua: trim(typeof navigator !== 'undefined' ? navigator.userAgent : '', 200)
      });
    } catch (e) {
      return false;
    }
  }

  function install() {
    if (!global || typeof global.addEventListener !== 'function') return false;

    /* 捕获阶段监听：资源（img/script）加载失败不冒泡，冒泡阶段收不到。
     * 这类错误没有 ev.message，ev.target 是那个元素。 */
    global.addEventListener('error', function (ev) {
      try {
        if (ev && ev.message) {
          capture('error', ev.message, {
            source: ev.filename,
            lineno: ev.lineno,
            colno: ev.colno,
            stack: ev.error && ev.error.stack
          });
        } else if (ev && ev.target && ev.target.tagName) {
          var el = ev.target;
          capture('resource', '资源加载失败：' + (el.src || el.href || el.tagName), {});
        }
      } catch (e) { /* 上报自己绝不能再抛 */ }
    }, true);

    global.addEventListener('unhandledrejection', function (ev) {
      try {
        var r = ev && ev.reason;
        var msg = (r && (r.message || String(r))) || '未处理的 Promise 拒绝';
        capture('rejection', msg, { stack: r && r.stack });
      } catch (e) { /* 同上 */ }
    });

    return true;
  }

  /* 浏览器里加载即生效。node 里（测试）不自动装，由调用方控制。 */
  if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
    install();
  }

  return {
    install: install,
    capture: capture,
    endpoint: endpoint,
    /* 仅供测试：重置计数与去重表 */
    _reset: function () { sentCount = 0; seenKeys = Object.create(null); },
    _stats: function () { return { sent: sentCount, seen: Object.keys(seenKeys).length }; }
  };
});
