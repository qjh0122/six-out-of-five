/**
 * 弹窗机制：焦点进出 + Tab 圈定 + 返回键关闭
 *
 * ── 为什么单独成文件 ────────────────────────────────────────────────
 * 这是「12 个弹窗共用的一套开关」，而不是某一个屏的渲染。它原来夹在
 * 「确认框」和「声音开关」之间，两边都不属于它。抽出来之后，
 * 想知道「弹窗打开时焦点去哪了」只需要看这一个文件。
 *
 * ── 它的职责边界（很重要，改的时候别越界）─────────────────────────────
 * `showModalEl` / `hideModalEl` 是**所有弹窗的唯一开关入口**，只做四件事，
 * **不碰任何样式**：
 *   1. 打开时记下「打开前的焦点」，关闭时还回去（元素已不在 DOM 里就安静放弃）
 *   2. 打开时把焦点移进弹窗（[data-autofocus] 优先，其次第一个可聚焦元素）
 *   3. 关闭后如果还有别的弹窗开着，焦点交给那一层，不还到背景去
 *   4. Tab / Shift+Tab 在「最上层那个弹窗」内循环（见 game.js 的 bindEvents）
 *
 * 为什么不用 inert / aria-hidden 把背景摘掉：这两个都会牵动渲染与读屏树，
 * 而 #stage 里既有页面又有弹窗，一刀切下去容易把弹窗自己也关进笼子。
 * Tab 圈定已经能挡住「键盘跑到背后」，够用，改动面也最小。
 *
 * ── 不注入任何依赖 ────────────────────────────────────────────────
 * 只用 `$`（来自 gameUtils）。`modalReturnStack` / `modalStatePushed` 是
 * 模块私有状态 —— 外面只通过 `setModalStatePushed` 复位，不直接读写。
 *
 * 浏览器全局：`window.LXW.modalKit`
 */
(function (global) {
  'use strict';

  var api = {};
  var $ = global.LXW.utils.$;

  /* 可聚焦选择器单独抽成常量：测试要能定位到它，别在两处手抄同一个字符串 */
  var MODAL_FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), '
    + 'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  /* 弹窗的「叠层顺序」（从最上层到最下层）。
   * 前 7 个沿用原来 Esc 处理里的既有优先级，**没有调换**；pwd 排在 account 之前是因为
   * 改密码是叠在账号卡上打开的，它才是那一层；后 3 个（分享图 / 结算 / 解散）原来不在
   * Esc 链里，但 Tab 圈定必须认得它们，否则它们开着时键盘照样能跑到背后。
   * 「最上层」= 这份列表里第一个不是 hidden 的。Esc 关闭和 Tab 圈定共用同一份判断。 */
  var MODAL_ORDER = ['bust-modal', 'profile-modal', 'rename-modal', 'records-clear-modal', 'confirm-modal',
    'guide-modal', 'replay-modal', 'prev-result-modal', 'rules-modal', 'avatar-modal', 'pwd-modal', 'account-modal',
    /* seat-sheet 是「点谁弹谁」的浮层面板：不叠在任何弹窗上（座位被弹窗盖住时点不到它），
     * 排在 share-modal 旁边这一档就够。v89 起它取代了原来的 emoji-modal。 */
    'seat-sheet', 'share-modal', 'round-break-modal', 'result-modal', 'dissolve-modal',
    /* 建房选局数：只在首页出现，理论上不与任何弹窗叠层。排在最后只是为了
     * 让它被 Tab 圈定/焦点归还认得 —— 不登记的话它开着时键盘能跑到背后。 */
    'create-modal'];

  var modalReturnStack = [];   // [{ id, el }]：打开弹窗前焦点在哪，关闭时按层还回去

  function isShown(el) { return !!(el && !el.classList.contains('hidden')); }

  /* 弹窗内的可聚焦元素。要滤掉 disabled / hidden / 处在 .hidden 容器里的
   * —— 解散弹窗的三个按钮就是「同意/拒绝/取消」轮流藏两个，不滤会圈到看不见的按钮上。 */
  function modalFocusables(box) {
    if (!box) return [];
    var all = box.querySelectorAll(MODAL_FOCUSABLE);
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var n = all[i];
      if (n.disabled || n.hidden) continue;
      if (n.closest && n.closest('.hidden')) continue;
      out.push(n);
    }
    return out;
  };

  /* 当前最上层的弹窗 id，没有就返回 '' */
  function topModalId() {
    for (var i = 0; i < MODAL_ORDER.length; i++) {
      if (isShown($('#' + MODAL_ORDER[i]))) return MODAL_ORDER[i];
    }
    return '';
  };

  /* 焦点搬运单独抽出来：preventScroll 是必须的 —— 弹窗在小屏上内部可滚动，
   * 默认的 focus() 会把弹窗内容滚一下，视觉上是「刚一打开就自己跳了」。 */
  function focusEl(el) {
    if (!el || typeof el.focus !== 'function') return;
    try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) { /* 真拿不到焦点就算了 */ } }
  };

  /* 长内容弹窗的「下面还有」提示 -------------------------------------------------
   * 引导与规则的正文在横屏下装不完（实测：规则正文 1252 设计高、可视 343，滚掉 909），
   * 而移动端滚动条平时是隐藏的 —— 玩家看到的最后一行正好断在半句上，没有任何「还有」的暗示。
   * 这里在**真能滚**的时候加一层底部渐隐，滚到底就撤掉，免得最后一行被渐隐蒙住。 */
  function syncScrollFade(el) {
    if (!el) return;
    var more = (el.scrollHeight - el.clientHeight - el.scrollTop) > 4;
    el.classList.toggle('scroll-fade', more);
  };
  /* 给任意滚动容器挂上渐隐（幂等）。结算列表与弹窗正文共用这一套，
   * 免得「规则能滚有提示、结算能滚没提示」这种不一致。 */
  function bindScrollFadeOnce(node) {
    if (!node || node.__fadeBound) return;
    node.__fadeBound = true;
    node.addEventListener('scroll', function () { syncScrollFade(node); }, { passive: true });
  };
  function syncModalScrollFade(root) {
    if (!root) return;
    var list = root.querySelectorAll('.guide-body, .rules-body');
    for (var i = 0; i < list.length; i++) {
      bindScrollFadeOnce(list[i]);
      syncScrollFade(list[i]);
    }
  };

  function showModalEl(id) {
    var m = $('#' + id);
    if (!m) return;
    /* 只在「从关到开」这一下记归还目标。结算弹窗会连着弹（第 1 轮 / 第 2 轮），
     * 每次都重新记的话，第二次记下的就是弹窗里的「继续游戏」，关了之后焦点会落到一个
     * 已经不可见的按钮上。
     * 用栈而不是一个变量：改密码是叠在账号卡上打开的，只记一个值的话，
     * 关掉改密码就把账号卡那层的归还目标冲掉了，最后关账号卡时焦点回不到原处。 */
    if (!isShown(m)) {
      var cur = document.activeElement;
      modalReturnStack.push({
        id: id,
        el: (cur && cur !== document.body && !m.contains(cur)) ? cur : null
      });
    }
    m.classList.remove('hidden');
    /* 弹窗刚显示时才知道正文有没有超出可视高度（隐藏时 scrollHeight 是 0） */
    syncModalScrollFade(m);

    /* 焦点移进弹窗。延迟 30ms 是因为部分弹窗打开时才注入内容
     * （结算弹窗、玩家战绩卡都是先 innerHTML 再显示），立刻找可能一个按钮都还没有。 */
    var pick = m.querySelector('[data-autofocus]');
    if (!pick) {
      var list = modalFocusables(m);
      pick = list.length ? list[0] : null;
    }
    if (pick) setTimeout(function () { if (isShown(m)) focusEl(pick); }, 30);
  };

  function hideModalEl(id) {
    var m = $('#' + id);
    if (!m || !isShown(m)) return;
    m.classList.add('hidden');

    /* 把自己的那一层从栈里摘掉。正常情况它就在栈顶，但还是从栈尾往前找一遍 ——
     * 上层先被关掉（比如 popstate 一次性关好几层）时，顺序不一定和打开时相反。 */
    var mine = null;
    for (var i = modalReturnStack.length - 1; i >= 0; i--) {
      if (modalReturnStack[i].id === id) { mine = modalReturnStack.splice(i, 1)[0]; break; }
    }
    /* 上面还压着一层（账号卡上叠了确认框、确认框上叠了改密码）时，焦点不能还回背景：
     * 那一层还开着，它才是用户眼里「当前在操作的东西」。
     * 但也不能原地不动 —— 元素被 classList 加上 hidden 之后浏览器不会主动交还焦点，
     * 焦点就停在一个已经看不见的按钮上，键盘用户下一次 Tab 等于从虚空开始数。
     * 所以把焦点搬进剩下那层：同样 [data-autofocus] 优先，其次第一个可聚焦元素。 */
    var below = topModalId();
    if (below) {
      var box = $('#' + below);
      var into = box ? box.querySelector('[data-autofocus]') : null;
      if (!into && box) {
        var restList = modalFocusables(box);
        into = restList.length ? restList[0] : null;
      }
      if (into) focusEl(into);
      return;
    }
    modalReturnStack.length = 0;
    /* 归还目标可能已经被重渲染掉了（房间页/牌桌每次广播都重写 innerHTML）。
     * 不在 DOM 里就安静放弃 —— 为了还焦点抛异常，代价比丢焦点大得多。 */
    if (mine && mine.el && document.body.contains(mine.el)) focusEl(mine.el);
  };

  // 移动端返回键关闭弹窗：首个弹窗打开时 push 一条历史记录，返回时经 popstate 收起
  var modalStatePushed = false;
  function pushModalState() {
    if (modalStatePushed) return;
    modalStatePushed = true;
    try { history.pushState({ weileModal: true }, ''); } catch (e) {}
  };
  /* popstate 处理里要把它复位。用 setter 而不是把变量递出去：
   * 递出去的话外面赋值只改外面那个变量，模块里读到的永远是初始的 false，
   * 于是返回键关闭一次之后就再也 push 不进去了。 */
  function setModalStatePushed(v) { modalStatePushed = !!v; }

  /* ---- 导出 ----
   * ★ 函数一律写成 `function 名字()` 声明再在这里挂出去，理由见 gameUtils.js 的同名注释。
   *
   * ★ 这一块曾经整个丢了（改写函数声明形式时被吞掉），后果是 `api` 剩一个空对象：
   *   `window.LXW.modalKit` 存在、能 `require`、源码里每个 `function showModalEl(` 也都在，
   *   所以源码级断言全绿；但 game.js 解构出来的 `showModalEl` 是 undefined，
   *   一点建房/账号/规则……**所有弹窗都没反应**（TypeError 只进控制台，界面看起来就是"点了没变"）。
   *   现在由 test/module-contract.test.js 守着：模块导出的名字必须覆盖 game.js 解构走的每一个名字。 */
  api.MODAL_FOCUSABLE = MODAL_FOCUSABLE;
  api.MODAL_ORDER = MODAL_ORDER;
  api.isShown = isShown;
  api.modalFocusables = modalFocusables;
  api.topModalId = topModalId;
  api.focusEl = focusEl;
  api.syncScrollFade = syncScrollFade;
  api.bindScrollFadeOnce = bindScrollFadeOnce;
  api.syncModalScrollFade = syncModalScrollFade;
  api.showModalEl = showModalEl;
  api.hideModalEl = hideModalEl;
  api.pushModalState = pushModalState;
  api.setModalStatePushed = setModalStatePushed;

  global.LXW.modalKit = api;

})(typeof self !== 'undefined' ? self : this);
