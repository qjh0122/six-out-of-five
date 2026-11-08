/**
 * 「5 秒内可以反悔」条（v136）
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 * 清除战绩是**唯一不可恢复**的玩家动作：点错一次，几十场记录没了。
 * 而在这之前它的保护只有一层确认框 —— 确认框防的是"手滑点错按钮"，
 * 防不了"我以为清的是这台设备、其实连云端一起清了"。
 * 真正能防住后者的只有一件事：**做完之后还能收回**。
 *
 * ── 为什么是「延迟执行」而不是「执行后回滚」────────────────────────
 * 设计稿写的是「执行 + 5 秒撤销」，实现做成了「5 秒后执行，期间可撤销」。
 * 原因是**云端那一步没有逆操作**：`resetMyStats` 把服务器上的战绩清零，
 * 没有任何接口能把它们写回去 —— 所谓"撤销"只可能是本机假装恢复，
 * 排行榜上已经空了。那种"撤销成功"比不提供撤销更坏。
 *
 * 延迟执行给出的是同一个用户收益（我按错了，能收回），而且：
 *   · 不需要快照与回滚，窗口期内数据**真的还在**，不存在"回滚失败"这条路；
 *   · 5 秒后不可恢复这件事是天然的，不用额外断言。
 *
 * ── 三条必须遵守的规矩（每一条都对应一次线上事故的形状）────────────
 * 1. **同一时刻只允许一个待撤销动作**。新的进来时，旧的必须立刻提交，
 *    不能因为"被覆盖了"就悄悄丢掉 —— 那等于用户点了清除却什么也没发生。
 * 2. **页面转入后台 / 关闭时立即提交**。否则用户以为删了、关掉 App，
 *    回来发现数据还在（或者更糟：以为删了，其实一直没删）。
 * 3. **条子渲染不出来时，动作也要照做**。DOM 缺失（比如旧缓存里的 HTML）
 *    是"少了个提示"，不是"取消了这个操作"。这里宁可立刻执行也不能静默丢弃。
 *
 * ── 注入 ──────────────────────────────────────────────────────────
 *   doc      —— 默认 document；测试传假对象
 *   timers   —— 默认 setTimeout/clearTimeout；测试传假的，避免真的等 5 秒
 *   duration —— 默认 5000ms
 *
 * 浏览器全局：`window.LXW.undoBar`
 */
(function (global) {
  'use strict';

  function create(opts) {
    opts = opts || {};
    var doc = opts.doc || global.document;
    var timers = opts.timers || {
      set: function (fn, ms) { return global.setTimeout(fn, ms); },
      clear: function (id) { global.clearTimeout(id); }
    };
    var DEFAULT_MS = typeof opts.duration === 'number' ? opts.duration : 5000;

    var pend = null;      // { msg, onUndo, onCommit, timer, ms }
    var bound = false;

    function el(id) { return doc && doc.getElementById ? doc.getElementById(id) : null; }

    function render() {
      var bar = el('undo-bar');
      var msg = el('undo-msg');
      var act = el('undo-act');
      if (!bar || !msg || !act) return false;
      msg.textContent = pend ? pend.msg : '';
      if (pend) bar.classList.remove('hidden');
      else bar.classList.add('hidden');
      return true;
    }

    /* 必须把待办对象**传进来**，不能在函数里读 pend：
     * commit/undo 的第一句就是 `pend = null`，那时候再读 pend 已经是空的，
     * 计时器永远清不掉。后果不是"多跑一个空回调"，是**提前把下一件事删了** ——
     * 老计时器到点时 commit() 拿到的是**新的** pend。
     * （这条是单测逼出来的：撤销之后计时器还在。） */
    function stopTimer(p) {
      if (p && p.timer !== null && p.timer !== undefined) {
        timers.clear(p.timer);
        p.timer = null;
      }
    }

    /** 真的把动作交出去。reason 只用于日志/断言，不改变行为。 */
    function commit(reason) {
      if (!pend) return false;
      var p = pend;
      pend = null;
      stopTimer(p);
      render();
      try {
        if (typeof p.onCommit === 'function') p.onCommit(reason);
      } catch (e) {
        /* 提交失败不能把条子留在屏幕上（它已经不再对应任何待办）。
         * 具体的报错由 onCommit 自己 flash —— 这里只保证状态机干净。 */
      }
      return true;
    }

    function show(cfg) {
      cfg = cfg || {};
      /* 规矩 1：旧的先结账。用 'superseded' 而不是静默丢弃，
       * 这样 onCommit 里能区分"到点了"和"被下一件事顶掉了"（日志不同）。 */
      if (pend) commit('superseded');

      var bar = el('undo-bar');
      var msg = el('undo-msg');
      var act = el('undo-act');
      /* 规矩 3：渲染不出来也要照做。 */
      if (!bar || !msg || !act) {
        if (typeof cfg.onCommit === 'function') cfg.onCommit('no-dom');
        return false;
      }

      var ms = typeof cfg.seconds === 'number' ? Math.round(cfg.seconds * 1000) : DEFAULT_MS;
      pend = {
        msg: cfg.msg || '',
        onUndo: cfg.onUndo,
        onCommit: cfg.onCommit,
        ms: ms,
        timer: null
      };
      act.textContent = cfg.action || '撤销';
      render();
      pend.timer = timers.set(function () { commit('timeout'); }, ms);
      return true;
    }

    function undo() {
      if (!pend) return false;          // 连点两下「撤销」：第二下是空操作，不能报错也不能再触发
      var p = pend;
      pend = null;
      stopTimer(p);
      render();
      try {
        if (typeof p.onUndo === 'function') p.onUndo();
      } catch (e) {
        /* 撤销里抛异常 = 状态没恢复干净，但条子必须消失：
         * 留着一条"可撤销"的条子而实际撤不了，比没有更误导。 */
      }
      return true;
    }

    /**
     * 立即结账。reason：
     *   'hidden'    —— 页面转入后台 / 关闭
     *   'navigate'  —— 用户已经离开这个屏
     *   'external'  —— 别的流程要求收尾（例如重新登录换了账号）
     */
    function flush(reason) { return commit(reason || 'flush'); }

    /* 规矩 2：把"转入后台"这条挂上。
     * 用 visibilitychange + pagehide 而不是 beforeunload —— 后者在移动端不可靠
     * （iOS 上经常不触发），而 pagehide 是 iOS 唯一能保证的顺序。
     * 两个都挂、都幂等，不会重复提交（commit 里 pend 先置空）。 */
    function bind() {
      if (bound || !doc || !doc.addEventListener) return;
      bound = true;
      doc.addEventListener('visibilitychange', function () {
        if (doc.visibilityState === 'hidden') flush('hidden');
      });
      global.addEventListener && global.addEventListener('pagehide', function () { flush('hidden'); });
    }

    bind();

    return {
      show: show,
      undo: undo,
      flush: flush,
      isPending: function () { return !!pend; },
      /* 测试用：读当前待办的文案与剩余时长，不改状态 */
      peek: function () { return pend ? { msg: pend.msg, ms: pend.ms } : null; }
    };
  }

  global.LXW = global.LXW || {};
  global.LXW.undoBar = create;

  if (typeof module !== 'undefined' && module.exports) module.exports = create;

})(typeof self !== 'undefined' ? self : this);
