/**
 * 对局页的座位交互：点头像弹面板（表情 / 短语 / 信息）+ 表情收发与播报
 *
 * ── 为什么单独成文件 ────────────────────────────────────────────────
 * 554 行，全部围绕「点一个人的头像」这一件事：怎么区分「拖动座位条」和
 * 「点座位」、「面板贴着座位弹在哪」、「发出去的表情怎么在别人屏幕上播」。
 * 它原来是牌桌渲染的邻居，但两者的生命周期完全不同 —— 牌桌每次广播重画，
 * 面板却要在重画之间保持打开。混在一起最容易踩的就是「重画把面板冲掉」。
 *
 * ── 三个已经踩过的坑（原注释逐条保留）─────────────────────────────
 *   ① 座位条 .gt-opps 是横向滚动容器：全程移动 < 8px 才算点击，
 *      拖动后 450ms 内抑制合成 click（移动端同一手势会再发 click）。
 *   ② 面板内所有点击走**事件委托**：13 个表情 + 8 条短语 + N 个人各绑一个监听，
 *      每开一次就多 20 多个闭包，开几十次就是内存泄漏现场。
 *   ③ 信息档内容是**异步**来的，填完必须 `placeSeatSheet()` 重新定位 ——
 *      不重排就会按「加载中」那个矮盒子定位，然后往下长出去（矮横屏直接出屏）。
 *
 * ── 注入 ────────────────────────────────────────────────────────
 * 只有 7 项，而且都是纯查询/纯渲染：avatarInner / profileBodyHtml / getMe /
 * flash / stageScale / esc / short。面板自己持有全部内部状态
 * （ssPid / ssTab / emojiTarget / oppTap），不向外部暴露。
 *
 * 浏览器全局：`window.LXW.seatSheetView`
 */
(function (global) {
  'use strict';

  function create(deps) {
    deps = deps || {};
    var U = global.LXW.utils;
    var $ = U.$, el = U.el, esc = U.esc, short = U.short;
    var colorFor = U.colorFor, netText = U.netText, netCls = U.netCls, cardText = U.cardText;

    /* ★ state 必须注入，理由见 settleView.js 同处注释：模块是独立作用域。 */
    var state = deps.state;
    var avatarInner = deps.avatarInner, profileBodyHtml = deps.profileBodyHtml;
    var getMe = deps.getMe, flash = deps.flash, stageScale = deps.stageScale;

  /* ---------------------------- 对局页座位：区分「拖动」与「点击」 ----------------------------
   * 座位条 .gt-opps 是横向滚动容器，手指滑动时不能误弹战绩卡。
   * 规则：全程移动距离 < 8px 才算点击；拖动后 450ms 内抑制合成 click（移动端同一手势会再发 click）。
   * 命中目标 .gt-opp（对手）和 .gt-me（右上角自己）一视同仁 —— 点自己也要能看战绩。 */
  var PROF_TAP_SEL = '.gt-opp, .gt-me';
  var oppTap = { x: 0, y: 0, moved: false, suppressUntil: 0 };

  function bindOppSeatTap() {
    var top = $('#game-top');
    if (!top) return;
    top.addEventListener('touchstart', function (e) {
      var t = e.touches && e.touches[0];
      if (!t) return;
      oppTap.x = t.clientX; oppTap.y = t.clientY; oppTap.moved = false;
    }, { passive: true });
    top.addEventListener('touchmove', function (e) {
      var t = e.touches && e.touches[0];
      if (!t) return;
      if (Math.abs(t.clientX - oppTap.x) > 8 || Math.abs(t.clientY - oppTap.y) > 8) oppTap.moved = true;
    }, { passive: true });
    top.addEventListener('touchend', function (e) {
      var t = e.changedTouches && e.changedTouches[0];
      oppTap.suppressUntil = Date.now() + 450;
      if (oppTap.moved || !t) return;                      // 拖动过 → 不弹卡
      var hit = document.elementFromPoint ? document.elementFromPoint(t.clientX, t.clientY) : null;
      /* 表情钮必须先判：这一条后面会把紧随其后的合成 click 压掉 450ms，
       * 若不在 touchend 里处理，移动端这个按钮会变成「点了没反应」。 */
      var emo = hit && hit.closest ? hit.closest('#btn-emoji') : null;
      if (emo) { openEmojiSheet(); return; }
      var card = hit && hit.closest ? hit.closest(PROF_TAP_SEL) : null;
      /* v89：点座位不再直接弹战绩卡，而是弹「贴着他的面板」——
       * 战绩只是其中一档，另两档是表情与短语（设计稿 §6.1）。 */
      if (card && card.dataset.pid) openSeatSheet(card.dataset.pid, card);
    }, { passive: true });
    top.addEventListener('click', function (e) {
      if (Date.now() < oppTap.suppressUntil) return;       // 移动端触摸后紧跟的合成 click
      var emo = e.target.closest ? e.target.closest('#btn-emoji') : null;
      if (emo) { openEmojiSheet(); return; }
      var card = e.target.closest ? e.target.closest(PROF_TAP_SEL) : null;
      if (card && card.dataset.pid) openSeatSheet(card.dataset.pid, card);
    });
  }

  /* ============================ 表情 / 短语（v82 R4） ============================
   * 链路：RoomStore.sendEmoji →（ws 服务端旁路广播 / local BroadcastChannel）→
   *        RoomStore.onEmoji → playEmoji()
   *
   * **不做乐观渲染**：自己发的那条也从同一条回程路径回来。这样「我能看见、
   * 别人看不见」这类只在一个方向上出错的问题，自测时立刻暴露 —— 自己都看不见
   * 就说明链路断了，而不是「看起来成功了」。
   *
   * 服务端只转发、不落库：表情 1.6 秒就消失，进回放/云同步只会变成脏数据。
   */
  var emojiTarget = null;        // '*' 或某个 playerId
  var emojiLastSend = 0;         // 客户端 2 秒节流（服务端还有一层，这里只为给出提示）

  function emojiReady() {
    return typeof Emoji !== 'undefined' && Emoji && typeof Emoji.isValid === 'function';
  }

  /* 表情开关的运行时覆盖：?emoji=0 / ?emoji=1。
   *
   * 为什么要有，而 `CONFIG.EMOJI` 不够：**回滚能力必须对称**。
   * 准备态那个开关有 `?tableready=0`，值班的人改个 URL 就能验老路径；
   * 表情没有的话，"关掉表情会看到什么"这件事只能靠改 config.js 再部署一次
   * 才能验 —— 而灰度期最不该做的事就是"为了验证回滚再发一次版"。
   *
   * 三种人用得上：
   *   ① 值班的人 —— 单台设备上验一遍退回去的样子，不影响别人；
   *   ② 探针 —— 「关掉开关后行为与 R3 一致」这句承诺必须能被自动验证
   *      （scripts/probe-rollback.js）；
   *   ③ 排障 —— 玩家说"表情发不出去"，先让他 ?emoji=0 看是不是这一块的问题。
   *
   * 只认 0/1，其余一律按 CONFIG 走 —— 与 tableReadyFlag 同一条规矩：
   * 一个笔误不该把功能关掉。 */
  function emojiFlag() {
    var q = '';
    try { q = new URLSearchParams(location.search || '').get('emoji') || ''; } catch (e) { q = ''; }
    if (q === '0') return false;
    if (q === '1') return true;
    return CONFIG.EMOJI !== false;
  }

  /* 座位锚点：顶栏里带 data-pid 的那一格（对手在 .gt-opps，自己在 .gt-me）。
   * 不用 document.querySelector('[data-pid="..."]')：playerId 是外部字符串，
   * 直接拼进选择器会被引号/方括号打断，遍历比对最稳且人数最多 5 个。 */
  function seatRect(pid) {
    var top = $('#game-top');
    if (!top || !pid) return null;
    var all = top.querySelectorAll('[data-pid]');
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute('data-pid') === String(pid)) return all[i].getBoundingClientRect();
    }
    return null;
  }

  function emojiOthers() {
    var room = state.room;
    if (!room || !room.players) return [];
    return room.players.filter(function (p) { return p.id !== state.myId && !p.left; });
  }

  /* ★ 这里原本有 renderEmojiTargets()：面板顶部一行「全 全场 / 机器人1 / 机器人2…」，
   * 让人在面板里再选一次发给谁。2026-11-14 删掉，理由两条：
   *
   *   ① 目标在**入口**就已经确定了，那一行是重复提问。点桌面表情钮进来必然是全场
   *      （面板标题已经写着「发给全场 / 所有人都看得到」），点某个人头像进来必然是
   *      他（标题就是他名字）—— 同一件事问两遍，第二遍还允许改主意，反而让人怀疑
   *      「我刚点的到底发给谁」。
   *   ② 它和标题区冲突。标题说「机器人3」，下面那行高亮的却是「全场」，两个都像
   *      当前选中项，玩家不知道该信哪个。
   *
   * 删掉之后 `emojiTarget` 完全由 `ssPid` 决定（见 renderSeatSheet 里那一行），
   * 只有一条赋值路径，不可能出现「标题一个人、实发另一个人」。 */

  function renderEmojiGrid() {
    var box = $('#emoji-grid');
    if (!box || !emojiReady()) return;
    var list = Emoji.list();
    var html = '';
    for (var i = 0; i < list.length; i++) {
      html += '<button class="emoji-cell" type="button" data-emoji="' + list[i].id + '"'
        + ' aria-label="' + esc(list[i].name) + '">'
        + '<img src="' + list[i].src + '" alt="" aria-hidden="true" draggable="false"></button>';
    }
    box.innerHTML = html;
  }

  function renderEmojiPhrases() {
    var box = $('#emoji-phr');
    if (!box || !emojiReady()) return;
    var list = Emoji.phrases();
    var html = '';
    for (var i = 0; i < list.length; i++) {
      html += '<button class="phrase-row" type="button" data-emoji="' + list[i].id + '">'
        + esc(list[i].text) + '</button>';
    }
    box.innerHTML = html;
  }

  /* ======================= 统一浮层面板（v89 · 设计稿 §6.1）=======================
   *
   * 早先是两个互不相干的入口：底部表情 sheet（#emoji-modal）+ 战绩弹窗（openProfile）。
   * 同一件事（看这个人 / 对他做个表情）要玩家自己记住从哪儿进，而且表情面板
   * 永远不知道该发给谁 —— 得先选「发给谁」再选表情。
   *
   * 现在只有一张面板，**对着谁**由「点了谁」决定：
   *   点对手 → 表情 / 短语 / 信息 三档，面板贴着他弹（右 → 左 → 下 → 上）
   *   点自己 → 只有信息档（自己给自己发表情没有意义）
   *   点表情钮 → 对着「全场」，只有表情 / 短语两档
   *
   * 面板是 #stage 里的绝对定位元素（设计像素坐标），不是 fixed 弹窗 ——
   * 贴着座位要求它跟着舞台缩放走，而 #stage 有 transform: scale()。
   * ★ 表情飞行动画仍然在 #stage 外面（见 index.html 注释），两套坐标各管各的。 */
  var ssPid = null;        // 面板当前对着谁；null = 全场
  var ssAnchorEl = null;   // 锚点（被点的座位 / 表情钮），重排时重新定位
  var ssTab = 'emoji';     // 当前档：emoji / phr / info

  function ssPlayer(pid) {
    var room = state.room;
    if (!room || !pid) return null;
    for (var i = 0; i < room.players.length; i++) {
      if (room.players[i].id === pid) return room.players[i];
    }
    return null;
  }

  function seatSheetOpen() {
    /* 不要叫 el —— 会遮蔽顶层那个造 DOM 的 el() 工具函数（ui.test 有专门一条守这个） */
    var sheet = $('#seat-sheet');
    return !!(sheet && !sheet.classList.contains('hidden'));
  }

  /* 落点：右 → 左 → 下 → 上。
   * 为什么是这个顺序：右手持机时「右边」最容易看到且不遮住牌桌左半；
   * 左右都放不下才落上下 —— 上下会盖住组槽或座位，代价更大。
   * 四个方向都放不下（极小屏）就把面板夹回舞台内，宁可稍微压一点锚点，
   * 也不能让面板跑到屏幕外（那比位置难看严重得多）。 */
  function placeSeatSheet() {
    var sheet = $('#seat-sheet');
    var anchor = ssAnchorEl;
    if (!sheet || sheet.classList.contains('hidden')) return;
    var sc = stageScale() || 1;
    var stage = $('#stage');
    var sr = stage.getBoundingClientRect();
    var sw = stage.offsetWidth || 750;
    var sh = stage.offsetHeight || 1624;
    var w = sheet.offsetWidth || 520;
    var h = sheet.offsetHeight || 400;
    var pad = 16;
    var gap = 18;
    var left, top, side;

    if (anchor && anchor.getBoundingClientRect) {
      var ar = anchor.getBoundingClientRect();
      var ax = (ar.left - sr.left) / sc;
      var ay = (ar.top - sr.top) / sc;
      var aw = ar.width / sc;
      var ah = ar.height / sc;
      if (ax + aw + gap + w <= sw - pad) {
        side = 'right'; left = ax + aw + gap; top = ay + ah / 2 - h / 2;
      } else if (ax - gap - w >= pad) {
        side = 'left'; left = ax - gap - w; top = ay + ah / 2 - h / 2;
      } else if (ay + ah + gap + h <= sh - pad) {
        side = 'below'; left = ax + aw / 2 - w / 2; top = ay + ah + gap;
      } else {
        side = 'above'; left = ax + aw / 2 - w / 2; top = ay - gap - h;
      }
      /* 缩放原点朝锚点：弹出来的方向要「从那个人身上长出来」，而不是从中间炸开 */
      sheet.style.setProperty('--ss-origin',
        (side === 'right' ? '0%' : side === 'left' ? '100%' : '50%')
        + ' ' + (side === 'below' ? '0%' : side === 'above' ? '100%' : '50%'));
    } else {
      side = 'center'; left = (sw - w) / 2; top = (sh - h) / 2;
    }

    left = Math.max(pad, Math.min(left, sw - w - pad));
    top = Math.max(pad, Math.min(top, sh - h - pad));
    sheet.style.left = Math.round(left) + 'px';
    sheet.style.top = Math.round(top) + 'px';
    sheet.setAttribute('data-side', side);
  }

  /* 信息档 = **整张战绩卡**（`profileBodyHtml`），不再是「摘要 + 看完整战绩」。
   *
   * 为什么改（v107，用户反馈）：原来这里放三个数字 + 胜平负，再给一个「看完整战绩」
   * 按钮。点进去之后，那张卡的头两行**和刚才一模一样**，多出来的只有一次点击、
   * 一次请求和一次动画。玩家以为自己在「进详情」，其实只是在同一个东西上又点了一下。
   *
   * 现在点一次就看到全部。面板本来就有 max-height + 内部滚动（emoji.css 的
   * `.seat-sheet` / `.ss-info`），内容再高也兜得住；但**填完必须重新定位**，
   * 原因见下面 placeSeatSheet() 那处注释。
   *
   * 空态仍然分开：这里一句话就够，整卡那张才需要插画。 */
  function renderSeatInfo(pid) {
    var box = $('#ss-info');
    if (!box || !pid) return;
    var p = ssPlayer(pid);
    if (p && p.isBot) {
      box.innerHTML = '<p class="ss-note">AI 玩家没有战绩记录。补齐人头用的，走了也不留痕。</p>';
      placeSeatSheet();
      return;
    }
    if (typeof RoomStore === 'undefined' || !RoomStore.canQueryProfile || !RoomStore.canQueryProfile()) {
      box.innerHTML = '<p class="ss-note">本地演示模式看不了别人的战绩。</p>';
      placeSeatSheet();
      return;
    }
    box.innerHTML = '<p class="pf-loading">加载中…</p>';
    RoomStore.getProfile(pid).then(function (res) {
      if (ssPid !== pid || !seatSheetOpen()) return;   // 已经切到别人 / 面板关了
      if (!res || res.ok === false) {
        box.innerHTML = '<p class="ss-note">' + esc((res && res.error) || '加载失败') + '</p>';
        placeSeatSheet();
        return;
      }
      var pr = res.profile;
      if (!pr) {
        box.innerHTML = '<p class="ss-note">还没有战绩，打完一局就有了。</p>';
        placeSeatSheet();
        return;
      }
      box.innerHTML = profileBodyHtml(pr);
      /* ★ 内容变高之后必须重新定位。
       * placeSeatSheet() 是拿 sheet.offsetHeight 算落点的，而这里的内容是异步填的 ——
       * 打开那一刻量到的是「加载中…」的高度。不重算的话，面板会按一个矮盒子定位，
       * 然后向下长出一大截，在矮屏上直接出屏。 */
      placeSeatSheet();
    }).catch(function () {
      if (ssPid !== pid) return;
      box.innerHTML = '<p class="ss-note">网络异常，稍后再试。</p>';
      placeSeatSheet();
    });
  }

  function setSeatTab(tab) {
    var g = $('#emoji-grid'), ph = $('#emoji-phr'), info = $('#ss-info');
    var allowed = { emoji: 1, phr: 1, info: 1 };
    ssTab = allowed[tab] ? tab : 'emoji';
    var tabs = document.querySelectorAll('#ss-tabs [data-ss-tab]');
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute('data-ss-tab') === ssTab;
      tabs[i].classList.toggle('is-on', on);
      tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    if (g) g.classList.toggle('hidden', ssTab !== 'emoji');
    if (ph) ph.classList.toggle('hidden', ssTab !== 'phr');
    if (info) info.classList.toggle('hidden', ssTab !== 'info');
    /* 换档会换掉整块内容（表情格子 ↔ 整张战绩卡），面板高度随之变化，
     * 而面板是按高度算落点的 —— 不重排就会「按上一档的盒子贴在新内容上」。 */
    placeSeatSheet();
    if (ssTab === 'info' && ssPid) renderSeatInfo(ssPid);
  }

  /* 重建面板内容：标题区 + tab 条 + 当前档。
   * 每次都重建 tab 条（不是 hide/show）—— 对着自己时只有一档，对着对手时三档，
   * 两套按钮留在 DOM 里靠 hidden 切换，迟早会出现「点了不存在的那一档」。 */
  function renderSeatSheet() {
    var sheet = $('#seat-sheet');
    if (!sheet) return;
    var me = getMe(state.room);
    var isSelf = !!(ssPid && me && ssPid === me.id);
    var p = ssPlayer(ssPid);
    var name = p ? (p.nickname || '玩家') : '全场';

    var av = $('#ss-avatar');
    if (av) {
      /* 没选座位（发给全场）时用「全」字 + 桌面绿底；
       * 选了座位就跟座位卡同一款头像 —— 面板头和座位长得一致，
       * 才不会出现「点了 A 弹出、标题却是另一个图案」的错位感。 */
      if (ssPid) {
        av.innerHTML = avatarInner(ssPid, p && p.avatar, (name.charAt(0) || '?'), !!(p && p.isBot), p && p.photo);
        av.classList.toggle('is-bot', !!(p && p.isBot));
      } else {
        av.textContent = '全';
        av.classList.remove('is-bot');
      }
    }
    var nm = $('#ss-name');
    if (nm) nm.textContent = ssPid ? name : '发给全场';
    var sub = $('#ss-sub');
    if (sub) {
      sub.textContent = !ssPid ? '所有人都看得到'
        : (p && p.isBot ? 'AI 玩家' : (p ? (p.score | 0) + ' 分' : ''));
    }

    /* 能不能发：自己不能发给自己；开关关了也不给这两档（连入口都不留，
     * 与「?emoji=0 时按钮直接不渲染」同一个口径）。 */
    var canEmoji = emojiFlag() && (ssPid ? !isSelf : true);
    var canInfo = !!ssPid;
    var tabs = [];
    if (canEmoji) tabs.push({ key: 'emoji', label: '表情' }, { key: 'phr', label: '短语' });
    if (canInfo) tabs.push({ key: 'info', label: '信息' });
    if (!tabs.length) tabs.push({ key: 'emoji', label: '表情' });

    var bar = $('#ss-tabs');
    if (bar) {
      var html = '';
      tabs.forEach(function (t) {
        html += '<button class="emoji-tab" type="button" role="tab" data-ss-tab="' + t.key + '"'
          + ' aria-selected="false">' + t.label + '</button>';
      });
      bar.innerHTML = html;
      /* 只有一档时把分档条整个藏掉（v107）。
       * 点自己、或者关掉表情开关时，面板里就剩「信息」一档 —— 一个只有一个选项的
       * 切换条不是导航，是装饰：它看起来能点、点下去什么都不会变。
       * 分档本身仍然保留（setSeatTab / ssTab 那套逻辑不动），只是不再显示。 */
      bar.classList.toggle('hidden', tabs.length <= 1);
    }

    if (canEmoji) {
      /* 发给谁 = 面板对着谁，**只此一处赋值**。
       * ssPid 为空（桌面表情钮那条路）就是全场；点了某个人就是他。
       * 面板里不再有第二个地方能改它 —— 详见上面 renderEmojiTargets 的删除说明。 */
      emojiTarget = ssPid || Emoji.BROADCAST;
      renderEmojiGrid();
      renderEmojiPhrases();
    }
    var want = ssTab;
    if (!tabs.some(function (t) { return t.key === want; })) want = tabs[0].key;
    setSeatTab(want);
  }

  /* 打开面板。pid 为空 = 对全场（表情钮那条路）。 */
  function openSeatSheet(pid, anchor) {
    if (!state.roomId || !state.myId) return;
    var me = getMe(state.room);
    var isSelf = !!(pid && me && pid === me.id);
    if (!pid && !emojiFlag()) return;                 // 全场面板只服务表情
    if (!pid && emojiOthers().length === 0) { flash('桌上只有你一个人'); return; }
    if (pid && !isSelf && emojiFlag() && !emojiReady() && !ssPlayer(pid)) return;
    ssPid = pid || null;
    ssAnchorEl = anchor || null;
    ssTab = isSelf ? 'info' : (emojiFlag() ? 'emoji' : 'info');
    renderSeatSheet();
    var sheet = $('#seat-sheet'), bd = $('#seat-sheet-bd');
    if (bd) bd.classList.remove('hidden');
    if (sheet) {
      sheet.classList.remove('hidden');
      /* 先让内容落定再量宽高 —— offsetWidth 拿到 0 会把面板贴到左上角 */
      placeSeatSheet();
      placeSeatSheet();
    }
    Sfx.play('select');
  }

  function closeSeatSheet() {
    var sheet = $('#seat-sheet'), bd = $('#seat-sheet-bd');
    if (sheet) sheet.classList.add('hidden');
    if (bd) bd.classList.add('hidden');
    ssPid = null;
    ssAnchorEl = null;
  }

  /* 保留旧名字：表情钮、键盘、以及外部调试调用都还走它。
   * 它现在的含义是「打开对全场的那张面板」。 */
  function openEmojiSheet() {
    if (!emojiFlag()) return;                // 开关关掉时连键盘/脚本调起来也不开
    if (!emojiReady()) { flash('表情没加载出来，刷新试试'); return; }
    openSeatSheet(null, $('#btn-emoji'));
  }

  /* 真发一条。三道闸的顺序有讲究：
   *   ① 客户端 2 秒节流 —— 先给提示，不要让人以为点漏了（服务端那条是静默丢弃）；
   *   ② 传输层返回 false —— 表示连接不在（ws）或本地限流（local），这时才说「没发出去」；
   *   ③ 发送成功就关面板 —— 面板盖着牌桌时看不见表情飞到谁那儿，等于白发。 */
  function sendEmojiNow(id) {
    if (!emojiReady() || !state.roomId || !state.myId) return;
    if (!Emoji.isValid(String(id))) return;
    var now = Date.now();
    if (now - emojiLastSend < Emoji.MIN_INTERVAL_MS) {
      flash('慢一点，2 秒只能发一条');
      return;
    }
    emojiLastSend = now;
    var to = emojiTarget || Emoji.BROADCAST;
    var sent = RoomStore.sendEmoji(state.roomId, state.myId, to, id);
    if (!sent) { flash('没发出去，检查一下网络'); return; }
    closeSeatSheet();
  }

  /* 收到一条（自己发的也走这里）。过滤规则与「谁能看见」一致：
   * 全场、发给我、我发的 —— 其余（发给第三方的）不显示。 */
  function onEmojiEvent(ev) {
    /* 回滚开关要把「收」也一起关掉：只藏入口的话，自己发不出去却能看见别人发，
     * 看起来就像「我这台手机坏了」，而不是「这个功能关了」。 */
    if (!emojiFlag()) return;
    if (!ev || !ev.id || !emojiReady() || !Emoji.isValid(String(ev.id))) return;
    var mine = ev.from === state.myId;
    var forMe = ev.to === Emoji.BROADCAST || ev.to === state.myId;
    if (!mine && !forMe) return;
    playEmoji(ev);
  }

  /* 舞台这一刻的实际缩放。竖版走 --pt-scale、横版走 --ls-scale，变量名不同，
   * 但两者最终都落在 #stage 的 transform 上 —— 读 matrix 是最不容易随实现变化出错的路。
   * 读不到（transform: none / 老浏览器）就当 1，退化成 v148 的样子。 */
  function stageScale() {
    var st = document.getElementById('stage');
    if (!st) return 1;
    var m = window.getComputedStyle(st).transform;
    if (!m || m === 'none') return 1;
    var hit = m.match(/matrix\(([^)]+)\)/);
    if (!hit) return 1;
    var v = parseFloat(hit[1].split(',')[0]);
    return (isFinite(v) && v > 0) ? v : 1;
  }

  function playEmoji(ev) {
    var layer = $('#emoji-layer');
    if (!layer) return;
    var entry = Emoji.get(ev.id);
    if (!entry) return;

    var fromR = seatRect(ev.from);
    var toR = (ev.to && ev.to !== Emoji.BROADCAST) ? seatRect(ev.to) : null;
    /* 顶栏没画出来（比如人在战绩页）：这条就不显示了，不抛错、不排队 ——
     * 表情是「此刻」的东西，补播一条 3 秒前的表情比不播更奇怪。 */
    if (!fromR && !toR) return;
    if (!fromR) fromR = toR;
    if (!toR) toR = fromR;

    /* 尺寸跟着**舞台缩放**走，不是写死 CSS px（2026-11-14）。
     *
     * #emoji-layer 是 fixed 全屏、不在 #stage 里，拿不到那圈 transform: scale()，
     * 于是座位头像在手机竖屏是 35 CSS px、电脑窗口是 57，而气泡一直是 64 / 24 号字。
     * 电脑上就变成「表情比头像还小、短语比座位名还小」。
     *
     * 0.52 是手机竖屏的基准（62 设计 px 的座圈 ≈ 32 CSS px，实测头像 35）。
     * 取 max(1, ·) 表示**只放大不缩小**：手机上的观感已经逐张确认过，不陪小屏继续缩。 */
    var k = Math.max(1, stageScale() / 0.52);
    k = Math.round(k * 100) / 100;

    /* 同时最多 6 条：服务端虽然限到 2 秒一条，但 5 个人一起发就是 5 条同时，
     * 再加自己一条正好。超了就丢最老的，节点数不跟着房间人数涨。 */
    while (layer.children.length >= 6) layer.removeChild(layer.firstChild);

    /* 结构是「外层管位置、内层管弹一下」。
     * ★ 两层不是讲究，是必须：CSS 动画会**整个覆盖** transform。
     *   第一版把「回弹」和「位移」都写在同一个元素上，回弹动画一跑，
     *   位移就被改回 identity —— 表情会瞬间跳回屏幕左上角再消失。
     *   探针第一次跑就抓到了（rect 恒等于 0,0，而 inline style 是对的）。 */
    var wrap = document.createElement('div');
    wrap.className = 'emoji-fly' + (entry.kind === 'phrase' ? ' is-phrase' : '');
    var item;
    if (entry.kind === 'phrase') {
      item = document.createElement('span');
      item.textContent = entry.text;
    } else {
      item = document.createElement('img');
      item.src = entry.src;
      item.alt = entry.name;
      item.draggable = false;
    }
    item.className = 'emoji-pop';
    wrap.appendChild(item);
    /* 必须在 append 之前写：下面马上要 offsetWidth —— 尺寸得先定下来。 */
    wrap.style.setProperty('--emo-k', k);

    /* 起点必须**在没有过渡的情况下**先落定，否则每一条表情都会从屏幕左上角
     * 飞过来 —— 因为「插入时写下 transform」在浏览器看来也是一次属性变化，
     * 过渡的起点是 identity。做法：临时关掉过渡 → 写起点 → 强制布局提交
     * → 恢复过渡 → 下一帧写终点。只写起点不提交，等于什么都没做。 */
    wrap.style.transition = 'none';
    wrap.style.opacity = '0.25';
    layer.appendChild(wrap);

    /* 尺寸必须先量：短语气泡的宽度由文案决定，算不出「居中」的偏移。 */
    var w = wrap.offsetWidth || 64;
    var h = wrap.offsetHeight || 64;
    var fx = fromR.left + fromR.width / 2 - w / 2;
    var fy = fromR.top + fromR.height / 2 - h / 2;
    var tx = toR.left + toR.width / 2 - w / 2;

    /* ★ 落点不再「盖在座位上」，而是**贴在座位上方**（2026-11-14）。
     *
     * 原来是正中覆盖：气泡中心 = 座位中心，于是「包开挂了先。」正好糊住对方头像，
     * 连名字一起挡掉 —— 用户第二张截图就是它。表情是给人看的，不该先把人挡住。
     *
     * 规则：底边贴在座位上方留 gap；顶部放不下（上排座位贴着屏幕边）就翻到座位
     * 下方，宁可压桌面也不压头像和名字；水平方向居中后夹进视口，避免被
     * #emoji-layer 的 overflow:hidden 切掉一截。 */
    var gap = Math.round(6 * k);
    var ty = toR.top - h - gap;
    var vw = window.innerWidth || document.documentElement.clientWidth || 0;
    var vh = window.innerHeight || document.documentElement.clientHeight || 0;
    if (vw > w) tx = Math.min(Math.max(tx, 4), vw - w - 4);
    if (ty < 4) ty = toR.bottom + gap;

    /* ★ 再和每个座位头像比一次，挡着谁就推到谁下面。
     *
     * 为什么光有「翻转」不够：320 宽那一档，气泡折两行后高 83，顶部放不下 → 翻到
     * 座位下方；可它同时被横向夹到屏幕左边（居中放不下），于是正好压在左上那个
     * 邻居的头像上（实测重叠 263 px²）。夹取和翻转是两个独立动作，组合起来会撞车，
     * 只能拿最终矩形去跟真实头像比 —— 算不出来，量得出来。 */
    function coversAvatar(y) {
      var avs = document.querySelectorAll('#game-top .opp-avatar');
      var lowest = -1;
      for (var i = 0; i < avs.length; i++) {
        var b = avs[i].getBoundingClientRect();
        if (tx < b.right && tx + w > b.left && y < b.bottom && y + h > b.top) {
          if (b.bottom > lowest) lowest = b.bottom;
        }
      }
      return lowest;
    }
    for (var guard = 0; guard < 4; guard++) {
      var low = coversAvatar(ty);
      if (low < 0) break;
      ty = low + gap;
    }
    if (vh > h) ty = Math.min(Math.max(ty, 4), vh - h - 4);

    wrap.style.transform = 'translate3d(' + fx + 'px,' + fy + 'px,0) scale(0.72)';
    void wrap.offsetWidth;                 // 提交起点
    wrap.style.transition = '';            // 交还给 CSS 里的那条过渡

    var raf = window.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); };
    raf(function () {
      /* 落定就用 ty，不再额外 -8：那 8px 是「正中覆盖」时代的上浮量，
       * 现在 ty 已经按「座位外侧留 gap」算好，再抬一次会把 gap 吃掉
       * （实测 gap 6 被抵消成 -2，气泡边缘压进座位 2px）。 */
      wrap.style.transform = 'translate3d(' + tx + 'px,' + ty + 'px,0) scale(1)';
      wrap.style.opacity = '1';
    });

    setTimeout(function () { wrap.classList.add('is-landed'); }, 430);
    setTimeout(function () {
      wrap.style.opacity = '0';
      wrap.style.transform = 'translate3d(' + tx + 'px,' + (ty - 34 * k) + 'px,0) scale(1)';
    }, 1500);
    setTimeout(function () {
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    }, 1900);
  }

  /* 面板内的所有点击都用委托：13 个表情 + 8 条短语 + N 个人如果各绑一个
   * 监听，面板每开一次就多 20 多个闭包（打开/关闭几十次就是内存泄漏现场）。 */
  function bindSeatSheet() {
    var sheet = $('#seat-sheet');
    if (!sheet) return;
    var close = $('#btn-ss-close');
    if (close) close.addEventListener('click', closeSeatSheet);
    /* 遮罩点击关闭：遮罩是半透明的，能看见被点的人，所以关掉它不算「丢失上下文」 */
    var bd = $('#seat-sheet-bd');
    if (bd) bd.addEventListener('click', closeSeatSheet);

    /* 面板内所有点击走委托：13 个表情 + 8 条短语，各绑一个监听
     * 就是「每开一次面板多 20 个闭包」的内存泄漏现场（v83 定下的规矩）。 */
    sheet.addEventListener('click', function (e) {
      var tab = e.target.closest ? e.target.closest('[data-ss-tab]') : null;
      if (tab) { setSeatTab(tab.getAttribute('data-ss-tab')); return; }
      /* 信息档现在就是整张战绩卡，没有「看完整战绩」这一跳了（v107）。
       * 那个按钮和它对应的 data-ss-full 处理分支一起删掉 —— 留着就是死代码，
       * 下一轮改到这里的人会以为还有第二条路径要维护。 */
      var cell = e.target.closest ? e.target.closest('[data-emoji]') : null;
      if (cell) sendEmojiNow(cell.getAttribute('data-emoji'));
    });

    /* Esc 关闭：面板不是全屏弹窗，没有「返回键」兜底，桌面上按 Esc 是最接近的手势 */
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && seatSheetOpen()) { closeSeatSheet(); }
    });

    /* 收到表情（两种传输同一个入口，只注册一次） */
    if (typeof RoomStore !== 'undefined' && RoomStore.onEmoji) {
      RoomStore.onEmoji(onEmojiEvent);
    }
  }
    return {
      PROF_TAP_SEL: PROF_TAP_SEL,
      oppTap: oppTap,
      bindOppSeatTap: bindOppSeatTap,
      emojiTarget: emojiTarget,
      emojiLastSend: emojiLastSend,
      emojiReady: emojiReady,
      emojiFlag: emojiFlag,
      seatRect: seatRect,
      emojiOthers: emojiOthers,
      renderEmojiGrid: renderEmojiGrid,
      renderEmojiPhrases: renderEmojiPhrases,
      ssPid: ssPid,
      ssAnchorEl: ssAnchorEl,
      ssTab: ssTab,
      ssPlayer: ssPlayer,
      seatSheetOpen: seatSheetOpen,
      placeSeatSheet: placeSeatSheet,
      renderSeatInfo: renderSeatInfo,
      setSeatTab: setSeatTab,
      renderSeatSheet: renderSeatSheet,
      openSeatSheet: openSeatSheet,
      closeSeatSheet: closeSeatSheet,
      openEmojiSheet: openEmojiSheet,
      sendEmojiNow: sendEmojiNow,
      onEmojiEvent: onEmojiEvent,
      playEmoji: playEmoji,
      bindSeatSheet: bindSeatSheet
    };
  }

  global.LXW = global.LXW || {};
  global.LXW.seatSheetView = create;

})(typeof self !== 'undefined' ? self : this);
