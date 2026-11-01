/**
 * 六选五 v0.1 —— 网页预览版主控制器（渲染 + 交互 + 状态订阅）
 *
 * 依赖全局：Engine / Card / CONFIG / StateMachine / RoomStore / Sfx
 * 数据层：RoomStore（多标签页同步，注释标明“此处替换为云开发 watch”）
 */
(function () {
  'use strict';

  /* ---------------------------- 基础工具（gameUtils.js） ----------------------------
   * 已拆到 js/gameUtils.js。这里解构成同名局部变量 ——
   * 于是下面几千行里的 $() / el() / esc() / cardText() 一个字都不用改。
   *
   * ★ 这就是本轮拆分的总手法：**只搬定义，不动调用点**。
   *   反过来做（把 state 挂到命名空间、调用点全改成 LXW.state.xxx）要改几千处，
   *   漏一处就是运行时炸，而不是编译期报错 —— 那种改动没人敢做第二次。 */
  var U = window.LXW.utils;
  var $ = U.$, el = U.el, esc = U.esc;
  /* 成就页渲染器（v109）。它是**对象**不是工厂（见 achievementsView.js 顶部：
   * 它没有注入需求，所以直接执行并挂到 LXW）。调用点里仍然判空 ——
   * 老客户端缓存的 index.html 没有这个脚本，这里拿到 undefined。 */
  var AV = window.LXW.achievementsView;
  var AVATAR_COLORS = U.AVATAR_COLORS, colorFor = U.colorFor, short = U.short;
  var netText = U.netText, netCls = U.netCls, pad2 = U.pad2, fmtTime = U.fmtTime;
  var SUIT_CHAR = U.SUIT_CHAR, cardText = U.cardText;

  /* ---------------------------- 牌面呈现（cardView.js） ----------------------------
   * 注入的两个函数在本文件后半部分，是 function 声明 —— 提升到 IIFE 顶部，
   * 所以这里拿到的是函数本体而不是 undefined，不需要延迟包装。 */
  var CardView = window.LXW.cardView({
    stageScale: stageScale,
    onHandCardTap: onHandCardTap
  });
  var HAND_CARD_W = CardView.HAND_CARD_W, HAND_CARD_H = CardView.HAND_CARD_H;
  var SLOT_CARD_W = CardView.SLOT_CARD_W, SLOT_CARD_H = CardView.SLOT_CARD_H;
  var MINI_CARD_W = CardView.MINI_CARD_W, MINI_CARD_H = CardView.MINI_CARD_H;
  var SCREEN_PAD_X = CardView.SCREEN_PAD_X, HAND_AREA_W = CardView.HAND_AREA_W;
  var SLOT_COLOR = CardView.SLOT_COLOR, SLOT_SHORT_LABEL = CardView.SLOT_SHORT_LABEL;
  var CHIP_LABEL = CardView.CHIP_LABEL, SLOT_BADGE = CardView.SLOT_BADGE, SLOT_HINT = CardView.SLOT_HINT;
  var BIG_TYPES = CardView.BIG_TYPES, BIG_FX = CardView.BIG_FX;
  var slotTypeOf = CardView.slotTypeOf, resetSlotTypeSeen = CardView.resetSlotTypeSeen;
  var stageCoords = CardView.stageCoords, flyCard = CardView.flyCard;
  var handCardWrap = CardView.handCardWrap, miniCardsEl = CardView.miniCardsEl;
  var getCardImg = CardView.getCardImg, cardImgEl = CardView.cardImgEl, cardImgHtml = CardView.cardImgHtml;

  /* 默认昵称。原来两处各写一遍 '玩家' + myId.slice(-4)，myId 为空串时
   * 退化成光秃秃的「玩家」—— 桌上一圈人都叫「玩家」就分不清谁是谁。
   * 空 id 说明「还没拿到身份」，此时「我」比「玩家」准确。 */
  function defaultNick() {
    var tail = String(state.myId || '').slice(-4);
    return tail ? '玩家' + tail : '我';
  }


  /* ---------------------------- 本机身份 ----------------------------
   * 身份**来自账号**（docs/product-spec-l0-records.md §2）：
   *   - 登录后 playerId 由服务端账号决定，存在 localStorage 的会话里。
   *     换浏览器 / 换手机重新登录，拿回的是同一个 playerId，战绩不断。
   *   - 未登录时不再生成随机 id：没有身份的请求服务端一律拒绝，
   *     所以这个函数只负责「把会话里的 id 取出来」，取不到就是空串。
   *   - ?mode=local 演示模式保留按标签页独立（同一浏览器开多个标签页当多个玩家），
   *     但它同样需要账号——服务端不接受未登录的请求。
   * 房间数据在 RoomStore 用 localStorage（跨标签页共享）。 */
  /* 物理键一律来自 Storage（js/storage.js）—— 键名只允许在那里出现一次。
   * 昵称仍存 local（不是 session）：后者生命周期只有当前标签页，
   * iOS 从主屏打开或页面被系统回收后重开就清空，正是「昵称设好又没了」的原因。 */
  var ST = (typeof LXW !== 'undefined' && LXW.Store) ? LXW.Store : null;
  var SS_UID = ST ? ST.KEYS.MY_ID : 'lxw_myid_v1';
  var LS_NICK = ST ? ST.KEYS.NICK : 'lxw_nickname_v1';

  function demoMultiTab() {
    // 演示 / 本地联调：?mode=local 或直接双击（file://）
    try {
      if (/[?&]mode=local/.test(location.search || '')) return true;
      return location.protocol === 'file:';
    } catch (e) { return false; }
  }
  function uid() {
    return 'p' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }
  function getMyId() {
    /* 演示模式（?mode=local / file://）跑的是纯本地状态机，没有服务端、也没有账号，
     * 保留「按标签页生成一个临时 id」的老行为，否则本地演示会被登录墙彻底堵死。
     * 生产路径上这个分支进不去（URL 里没有 mode=local 且不是 file://）。 */
    if (demoMultiTab()) {
      var sid = ST ? ST.read(SS_UID, '', 'session') : '';
      if (!sid) { sid = uid(); if (ST) ST.write(SS_UID, sid, 'session'); }
      return sid;
    }
    if (typeof AuthStore !== 'undefined') {
      var pid = AuthStore.playerId();
      if (pid) return pid;
    }
    return '';
  }
  /* 昵称：登录后以账号档案里的为准；首页输入框允许临时改，
   * 改名会随 createRoom 一起写回云端档案（服务端 profiles.ensure）。 */
  function getNickname() {
    if (demoMultiTab()) {
      return ST ? ST.read(ST.KEYS.NICK_SESSION, '') : '';
    }
    var n = ST ? ST.read(LS_NICK, '') : '';
    if (!n && typeof AuthStore !== 'undefined') n = AuthStore.nickname();
    return n || '';
  }
  function setNickname(n) {
    var v = n || '';
    if (demoMultiTab()) {
      if (ST) ST.write(ST.KEYS.NICK_SESSION, v, 'session');
      return;
    }
    if (ST) ST.write(LS_NICK, v);
    /* 生产路径同时写一份 session：放在这个标签页里，SW 接管后自动 reload 时
     * 首帧要立刻显示昵称（local 会读，但输入框里那半句还没提交的草稿只有 session 有）。 */
    if (ST) ST.write(ST.KEYS.NICK_SESSION, v, 'session');
    if (typeof AuthStore !== 'undefined') AuthStore.setNickname(v);
  }

  /* ---------------------------- 应用状态 ---------------------------- */
  /* 「现在正忙，别刷新」的唯一判据，给 Service Worker 更新用。
   *
   * 分牌阶段的草稿只活在内存里：新版本 SW 接管后如果立刻 reload，
   * 已经放好的 6 张牌会被清空，玩家只看到「牌没了」。
   * 所以页面里的 controllerchange 会先问这里一句，忙就等下一轮再刷。 */
  window.LXWBusy = function () {
    var ph = state.room && state.room.phase;
    return ph === StateMachine.PHASE.ROUND1_SPLIT || ph === StateMachine.PHASE.ROUND2_SPLIT;
  };

  /* ── 应用状态（v111 整理）────────────────────────────────────────────
   *
   * **为什么还是扁平结构，没有改成 state.session / state.room / state.split**
   *
   * 分类本身有价值（下三段就是这么分的），但「套一层对象」要给 250 处调用点
   * 全改成 `state.split.groups`，任何一处漏改都是运行时炸而不是编译期报错 ——
   * v108 拆 game.js 的教训摆在那儿：只搬定义、不动调用点，才敢说零行为变化。
   * 这里要解决的真正问题是「跨屏污染」，而它的成因是**没人负责清**，
   * 不是字段没分组。所以这一轮做的是两件有判别力的事：
   *   1. 每个字段写进字面量（以前 justDealt / absorbSig / dissolveWasActive
   *      是首次赋值时动态挂上的，看代码的人根本不知道有这个字段）；
   *   2. 三个时机各有一个具名重置函数（见下面的 resetSplitState 等），
   *      并由 pwa/test/state-reset.test.js 守着「每加一个字段都必须归位」。
   *
   * 分三组的判据是**生命周期**，不是模块：
   *   · session —— 这次打开页面期间有效（登录身份、当前屏、页面来处）
   *   · room    —— 跟着房间走（进房建、退房清）
   *   · split   —— 跟着当前这一轮分牌走（每轮重开）
   */
  var state = {
    /* ---- session：本次打开 ---- */
    myId: null,          // 登录后由账号决定；退出登录才清（不随进退房清）
    screen: '',          // 当前页面（'records' 时房间订阅不改写界面）
    recordsFrom: 'home', // 战绩页来处：home / settle（返回时回到来处）
    suppressTap: false,  // 刚拖完一张牌，压掉浏览器补发的那次 click

    /* ---- room：当前房间 ---- */
    roomId: null,
    room: null,
    unsub: null,          // 房间订阅的解绑函数（退房必须调，否则上一个房间继续推）
    resultSeqShown: 0,    // 这一轮已经揭晓到第几组（逐组错峰）
    lastMeScore: null,    // 上一屏「我」的净胜，用来判断结算是否变化
    settleCelebrated: false, // 本把的特写/庆祝是否已放过
    recordKey: null,      // 本局是否已写过本机记录（内存双保险，配合 Records 幂等）
    dissolveWasActive: false, // 上一次快照里「结束本局」提案是否在进行（提案消失时提示一次）

    /* ---- split：当前这一轮的分牌 ---- */
    groups: {},        // 当前轮分组草稿
    draftKey: null,    // 草稿归属键「场次:轮次」，见 draftKeyOf()
    activeGroup: null, // 当前落点组（点手牌就直接进这里），随轮次重置
    reviseRound: -1,   // 本轮正在「改一次」时为该轮次号，否则 -1
    justDealt: false,  // 刚发牌（用来只播一次发牌音效）
    absorbSig: null    // 已吸收过的 history 签名（防重复吸收）
  };

  var STATE_DEFAULT = {
    screen: '', recordsFrom: 'home', suppressTap: false,
    roomId: null, room: null, unsub: null, resultSeqShown: 0,
    lastMeScore: null, settleCelebrated: false, recordKey: null, dissolveWasActive: false,
    groups: {}, draftKey: null, activeGroup: null, reviseRound: -1, justDealt: false, absorbSig: null
  };

  /* 三个重置时机。**每加一个 state 字段，必须同时加进对应的 reset 与 STATE_DEFAULT**，
   * 否则 state-reset.test.js 会红 —— 这条守卫是这次整理留下的唯一长期资产。 */
  function resetSplitState() {
    state.groups = emptyGroups();
    state.draftKey = null;
    state.activeGroup = null;
    state.reviseRound = -1;
    state.justDealt = false;
    state.absorbSig = null;
  }
  function resetRoomState() {
    state.roomId = null;
    state.room = null;
    state.unsub = null;   // 解绑由调用方先做（cleanupRoom 里先 unsub() 再进这里）
    state.resultSeqShown = 0;
    state.lastMeScore = null;
    state.settleCelebrated = false;
    state.recordKey = null;
    state.dissolveWasActive = false;
  }
  function resetSessionState() {
    state.screen = '';
    state.recordsFrom = 'home';
    state.suppressTap = false;
  }

  /* 建房弹窗里当前选中的把数。只在「建房 → 关弹窗」这一小段时间有意义，
   * 但必须放在模块层（不是弹窗 DOM 的 data 上）：请求发出后弹窗已经关了，
   * 异步回调里还要读它。 */
  var createLimit = CONFIG.DEFAULT_HAND_LIMIT;

  /* ---------------------------- 状态工具 ---------------------------- */
  function getMe(room) {
    for (var i = 0; i < room.players.length; i++) {
      if (room.players[i].id === state.myId) return room.players[i];
    }
    return null;
  }
  function emptyGroups() {
    return { single: [], tenhalf: [], piaosanye: [], douniu: [] };
  }
  /*
   * 当前能否编辑分组。
   * 已提交后仍允许「改一次」：点错一张牌只能认命的体验太差。
   * 进入修改态时（state.reviseRound === 本轮），界面回到可编辑，提交按钮变成「重新提交」。
   */
  function canEdit(room, me, round) {
    if (!me || me.left) return false;
    if (room.phase !== StateMachine.PHASE.ROUND1_SPLIT && room.phase !== StateMachine.PHASE.ROUND2_SPLIT) return false;
    var submitted = !!(me.submitted && me.submitted['round' + round]);
    if (!submitted) return true;
    return state.reviseRound === round;
  }

  function canRevise(me, round) {
    if (!me || !me.resubmits) return false;
    return (me.resubmits['round' + round] || 0) < 1;
  }

  function getCurrentGroups(room, me) {
    var round = room.round;
    if (me && me.submitted && me.submitted['round' + round] && state.reviseRound !== round) {
      return me.groups['round' + round] || emptyGroups();
    }
    return state.groups;
  }
  /* 一手牌的草稿身份（场次:轮次，纯函数在 stateMachine 里，有单测兜着）。
   *
   * 这里只用 room.round 当判重键是错的，而且踩过：
   * 「开下一把」会把 round 重置回 1，于是草稿永远不会被清，
   * 牌区原样留着**上一把**已经放好的 6 张牌（全满 1/1 2/2 3/3），手牌却是刚发的 6 张新牌。
   * 结果：牌区里的牌不在 me.hand 里 → cardFromId 查不到 → 点了拖了都没反应；
   * 牌区又全满 → 新手牌一张也放不进去。整轮分牌直接卡死。
   */
  function ensureDraft(room) {
    var key = StateMachine.handKey(room);
    if (state.draftKey !== key) {
      /* 新一手 → 分牌级状态整体归位（v111）。以前是逐行手写，只清了 5 个字段；
       * 现在一个函数管全，新加字段只要进 resetSplitState 就不会漏。 */
      resetSplitState();
      state.justDealt = (room.round === 1); // 新一手才播发牌动效
      state.draftKey = key;
      state.activeGroup = StateMachine.nextOpenGroup(room.round, state.groups, null);
      // 牌区/顶栏的「内容没变就不重绘」缓存也一起作废，避免换手后误判成同一屏
      lastSlotsHtml = null;
      lastTopHtml = null;
    }
    pruneStaleDraft(room);
  }

  /* 兜底自愈：草稿里不允许出现「手牌里没有的牌」。
   * 任何还没查出来的状态漂移（换手时序、断线重连拿到旧快照、以后新增的重置路径）
   * 都会表现成「牌区的牌点不动、手牌的牌放不进」——玩家只能重建房间。
   * 这里每帧把对不上的草稿位剪掉，牌区自动退回空位，最差也只是要重新分一次。 */
  function pruneStaleDraft(room) {
    var me = getMe(room);
    if (!me || !me.hand || !me.hand.length) return; // 旁观/已弃局无手牌，无从校验
    var inHand = {};
    me.hand.forEach(function (c) { inHand[c.suit + '-' + c.rank] = true; });

    var keys = Object.keys(state.groups || {});
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var arr = state.groups[k] || [];
      var kept = arr.filter(function (c) { return inHand[c.suit + '-' + c.rank]; });
      if (kept.length !== arr.length) state.groups[k] = kept;
    }
  }
  function phaseLabel(p) {
    return {
      WAITING: '等待中', ROUND1_SPLIT: '第一轮分牌', ROUND1_SETTLE: '第一轮结算',
      ROUND2_SPLIT: '第二轮分牌', ROUND2_SETTLE: '第二轮结算', SETTLED: '结束'
    }[p] || p;
  }
  function findPlayer(room, id) {
    for (var i = 0; i < room.players.length; i++) if (room.players[i].id === id) return room.players[i];
    return null;
  }

  /* ---------------------------- 屏幕切换 ---------------------------- */
  function showScreen(id) {
    /* 首屏防闪的 .no-session 到这里就该退场了：从此以后页面可见性完全由 .hidden 决定。
     * 不摘掉的话，它那两条 !important 会把 showScreen 的所有切换都压住
     * （表现：永远停在登录页或永远停在首页，怎么点都不动）。幂等，多调几次无所谓。 */
    document.documentElement.classList.remove('no-session');
    // 注意：新增页面必须登记在这里，否则 showScreen 只会把它前面的页面隐藏掉，
    // 目标页自身仍带 hidden → 表现为整屏空白（排行榜曾经就是这样白屏的）。
    var screens = ['screen-auth', 'screen-home', 'screen-room', 'screen-game', 'screen-settle', 'screen-records', 'screen-rank', 'screen-achievements'];
    // 三态与 state.screen 对齐：不在房间订阅重渲染里被顶回别的页面
    state.screen = id === 'screen-auth' ? 'auth'
      : (id === 'screen-records' ? 'records'
      : (id === 'screen-rank' ? 'rank'
      : (id === 'screen-achievements' ? 'achievements' : '')));
    for (var i = 0; i < screens.length; i++) {
      var screenEl = $('#' + screens[i]);
      var show = screens[i] === id;
      screenEl.classList.toggle('hidden', !show);
      screenEl.classList.toggle('enter', show); // 动效规格 6：新页右侧滑入（只动 .screen transform，安全）
    }
    /* 离开对局页就把分牌倒计时的 interval 停掉，别让它每秒白跑一次 */
    if (id !== 'screen-game') stopSplitTick();
  }

  var toastTimer = null;
  /* tone（可选）：
   *   'warn' —— 红色，会输的那种错（十点半爆了）。
   * 不传就是普通金色，留给日常提示 —— 两种语气各自有明确含义，
   * 别拿颜色当装饰，否则真出问题时玩家已经不看了。 */
  function flash(msg, tone) {
    var t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (tone ? ' ' + tone : '');
    clearTimeout(toastTimer);
    /* 警告多留 0.8 秒：它说的是「这一组会输」，比「这组已经满了」需要更多阅读时间。 */
    toastTimer = setTimeout(function () { t.classList.add('hidden'); }, tone ? 2600 : 1800);
  }

  /* 收起还没到时间的 toast。目前只有一处用：爆点拦截框弹出来的时候。
   * 那张 toast 说的是同一件事（放牌那一刻已经说过一次），留着它会在横屏上
   * 贴在弹窗底部叠成一团 —— 弹窗已经把话说完了，不需要再来一条同义提示。 */
  function hideToast() {
    var t = $('#toast');
    if (!t) return;
    clearTimeout(toastTimer);
    t.classList.add('hidden');
  }

  /* 服务端说「你没有身份」的几种说法。这类错误弹个 toast 是不够的：
   * 玩家被留在首页，而唯一的账号入口藏在房间里，他没有任何路径回到登录页，
   * 只会一下下点「开始游戏」并且一直被拒。 */
  function authFatalMsg(msg) {
    return /未登录|登录已失效|账号不存在|已被停用/.test(String(msg || ''));
  }

  /* 统一的房间操作失败处理：身份没了就回登录页，其余照旧 toast + 错误音 */
  function flashRoomError(res) {
    var msg = (res && res.error) || '操作失败';
    if (authFatalMsg(msg)) { gotoAuth(msg); return true; }
    flash(msg);
    Sfx.play('error');
    return false;
  }

  /* ---------------------------- 主渲染入口 ---------------------------- */
  /* ===== 开局 3 秒倒计时（?countdown=1 演示模式，默认关）=====
   *
   * 这是**唯一**一个故意不默认开启的功能性改动，原因写在 CONFIG.START_COUNTDOWN 上：
   * 线上「全员准备即开」比倒计时快，而那 3 秒是给评审 / 录屏用的（文档 §3.3）。
   *
   * 三条硬约束：
   *   1. **不改时序**。牌在服务端已经发了，这只是盖在牌桌上的一层遮罩，
   *      所以不需要碰 stateMachine、也不需要碰服务端的开局路径。
   *   2. **每个房间只放一次**。render() 每次广播都会跑，没有这个守卫的话，
   *      对手点个准备、发个表情，倒计时就会从头再来。
   *   3. **点一下能跳过**。仪式不该拦着想快的人；跳过后也不会再弹（同上一条）。
   */
  var COUNT_STEPS = ['3', '2', '1', '开始'];
  var COUNT_HOLD = 560;          // 每一拍；4 拍共 2.24 秒，比 3 秒短 —— 没人真在数
  var cd = { room: '', timer: 0, i: 0 };

  /* 名字与参数都跟 CONFIG 的键对齐（START_COUNTDOWN → startCountdownFlag / ?startcountdown=0|1）：
   * rollback-contract 那条测试要求 config 里每个开关都有同名的运行时覆盖，
   * 好让线上出问题时**不改文件**也能退回老路径。 */
  function startCountdownFlag() {
    var q = '';
    try { q = new URLSearchParams(location.search || '').get('startcountdown') || ''; } catch (e) { q = ''; }
    if (q === '1') return true;
    if (q === '0') return false;
    return !!CONFIG.START_COUNTDOWN;
  }

  function stopCountdown() {
    if (cd.timer) { clearTimeout(cd.timer); cd.timer = 0; }
    /* 变量名不能叫 el —— game.js 顶部有同名工具函数，遮蔽了以后在别处误调会
     * 报「el is not a function」（ui.test.js 有一条专门守这个）。 */
    var box = $('#countdown');
    if (box) box.classList.add('hidden');
  }

  function playCountdown() {
    var box = $('#countdown');
    var num = $('#cd-num');
    if (!box || !num) return;
    cd.i = 0;
    box.classList.remove('hidden');
    box.onclick = function () { stopCountdown(); };
    var step = function () {
      if (cd.i >= COUNT_STEPS.length) { stopCountdown(); return; }
      var txt = COUNT_STEPS[cd.i];
      num.textContent = txt;
      num.classList.toggle('go', txt === '开始');
      /* 重启同一条 keyframes：只改 class 不会重跑，必须先摘掉、强制回流、再挂上。
       * 少了这一步，4 拍里只有第一拍有动画，后面三拍是静止换字 —— 看起来像卡住了。 */
      box.classList.remove('tick');
      void box.offsetWidth;
      box.classList.add('tick');
      Sfx.play('select', txt === '开始' ? 1.25 : 1);
      cd.i += 1;
      cd.timer = setTimeout(step, COUNT_HOLD);
    };
    step();
  }

  function maybeCountdown(room) {
    if (!startCountdownFlag() || !room) return;
    if (room.handCount !== 1) return;          // 只放「开这一局」的第一把
    if (cd.room === room.roomId) return;       // 同一个房间不重播
    /* 新手引导正开着就**这一局都不放**（照样记房间号，免得引导关掉之后又从半路冒出来）。
     * 第一次玩游戏的人此刻最该看的是「六张牌怎么分」，而不是一个 3。
     * 真机截图里这两层叠在一起：倒计时压在引导卡上，两个都看不清。 */
    var guide = $('#guide-modal');
    if (guide && !guide.classList.contains('hidden')) { cd.room = room.roomId; return; }
    cd.room = room.roomId;
    playCountdown();
  }

  function render() {
    var room = state.room;
    // 战绩页 / 排行榜 / 登录页停留期间不被房间订阅打断（返回时会重算一次界面）
    // 登录页尤其要拦：退出登录后残留的房间广播会把界面顶回首页，看起来像「没退成功」
    if (state.screen === 'records' || state.screen === 'rank' || state.screen === 'auth') return;
    if (!room) { showScreen('screen-home'); return; }

    /* 结算结果弹窗（每次结算 resultSeq 递增）。
     * 结算期才进来的人（joinedLate）没打上一局，不能给他弹上一局的结算 ——
     * 他刚点「加入房间」就看见一张别人的成绩单，只会以为「我一进来就结算了」。
     * 这里仍然把 resultSeq 记成已展示，避免下一屏或下一次广播又弹一次。 */
    if (room.lastResult && room.resultSeq && state.resultSeqShown !== room.resultSeq) {
      state.resultSeqShown = room.resultSeq;
      var meJoin = getMe(room);
      /* 逐组结算：一次结算里有 2~3 组，交给序列器一幕一幕放。
       * joinedLate 的人不弹 —— 他刚点「加入房间」就看见一张别人的成绩单，
       * 只会以为「我一进来就结算了」。 */
      if (!(meJoin && meJoin.joinedLate)) playResult(room.lastResult, room.resultSeq);
    }

    if (room.phase !== StateMachine.PHASE.SETTLED) {
      state.settleCelebrated = false;
      state.recordKey = null;
    state.absorbSig = null;   // 换房间了，签名短路要重置，否则新房间的第一轮会被误判为「已收」 // 离开结算（重开下一把）→ 允许记录下一局
    }

    if (room.phase === StateMachine.PHASE.SETTLED) {
      hideModalEl('dissolve-modal'); // 结算页隐藏解散弹窗
      state.dissolveWasActive = false; // 进入结算即投票已结（同意或重开），避免后续误报"被否决"
      /* 注意：recordSettled 不在这里 —— 它挂在 attachRoom 的订阅回调上（absorbRoom），
       * 因为 render() 在战绩 / 排行 / 登录页会早退，而收录不能受屏幕形态影响。
       * 这里只负责画界面。 */
      /* 结算期两种界面，靠 wantNext 分叉（房间 phase 故意停在 SETTLED，
       * 见 stateMachine.wantNext 的注释）：
       *   · 点了「开始下一局」→ 房间页（就位态，房间号不变）
       *   · 没点 → 结算页，照常看回放 / 生成战绩图 / 看结算数据 */
      var meSettled = getMe(room);
      if (meSettled && meSettled.wantNext && !meSettled.left) {
        if (tableReadyOn()) { showReadyTable(room, { nextWait: true }); return; }
        showScreen('screen-room');
        renderRoom(room, { nextWait: true });
        return;
      }
      showScreen('screen-settle');
      renderSettle(room);
      if (!state.settleCelebrated) {
        state.settleCelebrated = true;
        /* ★ v113（A-4）：庆祝音改用**与名次同一份**结果（settleRank）。
         *
         * 旧写法自己排一次序、取第一个，与名单口径有两处不一致：
         *   ① 不过滤弃局者 —— 弃局的人分数可能还挂在高位，他一走，
         *      「冠军」在名单上让给了别人，声音却按他算；
         *   ② 不认并列 —— 两人同分并列第一时，只有排在前面的那个有声音。
         * 同一个事实两个来源，早晚要分岔；这里改成只留一份。 */
        var _champs = settleRank(room.players).filter(function (r) { return r.champion; });
        if (_champs.some(function (r) { return r.p.id === state.myId; })) {
          setTimeout(function () { Sfx.play('win'); }, 500); // 我赢时的庆祝音（P2）
        }
      }
      return;
    }
    // 非结账状态：刷新解散投票弹窗（可能处于投票进行中）
    renderDissolve(room);
    if (room.phase === StateMachine.PHASE.WAITING) {
      if (tableReadyOn()) { showReadyTable(room); return; }
      showScreen('screen-room');
      renderRoom(room);
      return;
    }
    // 分牌阶段
    exitReadyTable();
    showScreen('screen-game');
    ensureDraft(room);
    renderGame(room);
    /* 开局倒计时（默认关）。放在 renderGame **之后**：同一个同步任务里两件事都会在
     * 下一帧一起画出来，视觉上就是「牌发下来、遮罩同时盖上来」；而放前面的话，
     * renderGame 万一抛异常就会留下一个挂在屏幕上的倒计时。
     * 牌在下面已经画好了，摘掉遮罩就是发牌那一帧。 */
    maybeCountdown(room);
  }

  /* ---------------------------- 首页 ---------------------------- */
  function renderHome() { /* 静态，仅初始化昵称 */ }

  /* ---------------------------- 房间页 ---------------------------- */
  /* opts.nextWait：结算期的「就位态」——已经点了「开始下一局」的人看到的房间页。
   * 复用同一个屏和同一套座位卡，只换数据来源与提示语；
   * 另外写一个渲染函数会让两种房间页的样式慢慢跑偏。 */
  function renderRoom(room, opts) {
    var nextWait = !!(opts && opts.nextWait);
    $('#room-code').textContent = room.roomId;
    var list = $('#room-players');
    list.innerHTML = '';

    /* 座位表在两种等待页里必须长得一模一样 —— 这是被报回来的问题：
     *   「新开一局的等待页」= 8 格（1 人 + 7 张邀请卡）
     *   「继续下一把再回房间」= 只画已进入下一局的人，3 个人就只剩 3 格
     * 同一个房间、同一个 renderRoom，两次进来看起来像两个页面。
     *
     * 根因是座位来源和数据来源被绑在一起了：就位态拿 nextRoundPlayers() 当座位表，
     * 而那个函数回答的是「谁报名了」，不是「房间里有谁」。人数一变，整张网格跟着重排。
     *
     * 现在两边都按「房间里的全部玩家 + 补满 MAX_PLAYERS 的邀请卡」画：
     *   · 还没点「开始下一局」的人不消失，状态写「还在结算…」——
     *     看得懂是他在看回放，不是掉线、也不是被踢；
     *   · 空位照旧是邀请卡、照旧能点：它做的是分享房间（链接/系统分享面板），
     *     跟「这一刻能不能入房」是两件事。
     * 只有「状态文案」和「分数前缀」按 nextWait 各换一句，结构完全一致。 */
    /* 座位表用 roomSeats（= 在场的人），不是 room.players：
     * 结算期离开的人 left=true 但仍留在 room.players 里（分数要结算），
     * 直接拿它当座位表会让「已经走了的人」占着格子；满员时更糟 ——
     * 8 人里有 1 个走了、又进来 1 个新人，players 变 9 而格子只有 8，
     * 第 9 个（正好是那个新人）画不出来，他自己在房间里看不到自己的座位。 */
    var seats = StateMachine.roomSeats(room);
    /* 座位格子数跟**这个房间自己的上限**走，不是跟当前配置走。
     * 上限改小（8 → 5）之后，老 8 人房里的人一个都不能少画：
     * 用 CONFIG.MAX_PLAYERS 会让第 6~8 个人在房间里看不到自己的座位。 */
    var slotCount = StateMachine.capOf ? StateMachine.capOf(room) : (room.cap || CONFIG.MAX_PLAYERS);
    for (var seat = 0; seat < slotCount; seat++) {
      var p = seats[seat];
      if (p) {
        /* 就位态里「还没报名」= 人还在结算页。他不是缺席，只是还没决定。 */
        var joined = nextWait ? !!p.wantNext : true;
        var row = el('div', 'player-row');
        if (p.id === state.myId) row.classList.add('me');
        if (!joined) row.classList.add('pending');
        row.dataset.pid = p.id;   // 点座位卡 → 查看该玩家战绩（委托监听，见 bindEvents）

        var avatar = el('div', 'avatar');
        if (p.isBot) {
          // AI 座位用机器人图标区分，避免被当成真人
          avatar.textContent = '🤖';
          avatar.classList.add('is-bot');
        } else {
          avatar.innerHTML = avatarInner(p.id, p.avatar, (p.nickname || '?').charAt(0), false, p.photo);
        }
        if (p.id === room.ownerId) {
          var crown = el('span', 'owner-crown', '👑');
          avatar.appendChild(crown);
        }
        var name = el('div', 'player-name', p.nickname);
        var status = el('div', 'player-status');
        if (!joined) {
          status.className = 'player-status pending';
          status.textContent = '还在结算…';
        } else if (p.ready) {
          status.className = 'player-status ready';
          status.textContent = '已准备 ✓';
        } else {
          status.textContent = '等待中…';
        }
        /* 分数：就位态显示的是**上一局的最终分**（新局还没开始，分数没重置）。
         * 前缀写「上局」而不是「分」——同样占一行、同样有数字，
         * 但不会被读成「下一局已经扣过分了」。之前这里写的是「—」，等于把分数藏了。 */
        var score = el('div', 'player-score',
          ((nextWait && !p.joinedLate) ? '上局 ' : '分 ') + p.score);
        row.appendChild(avatar); row.appendChild(name); row.appendChild(status); row.appendChild(score);
        /* 自己的座位角落挂一个「改昵称」铅笔。
         * 座位卡统一成「点谁 = 看谁的战绩」之后，改名不能再藏在卡片的点击上
         *（同一张卡两种行为，玩家猜不到，也点不准）；改名只对自己有意义，
         * 就给它一个自己独立的热区。 */
        if (p.id === state.myId) {
          var editBtn = el('button', 'player-edit', '✎');
          editBtn.type = 'button';
          editBtn.setAttribute('aria-label', '改昵称');
          editBtn.setAttribute('title', '改昵称');
          row.appendChild(editBtn);
        }
        list.appendChild(row);
      } else {
        var invite = el('div', 'invite-card');
        var plus = el('div', 'plus', '＋');
        var txt = el('div', 'invite-txt', '邀请好友');
        invite.appendChild(plus);
        invite.appendChild(txt);
        invite.addEventListener('click', onCopy);
        list.appendChild(invite);
      }
    }

    var me = getMe(room);
    var readyBtn = $('#btn-ready');
    readyBtn.textContent = me && me.ready ? '取消准备' : '准备';
    /* 自愈：每次房间广播都把它放开一次。pressBusy 已经在 finally 里还了 disabled，
     * 这条是兜底 —— 万一哪条路径把 restore 整段跳过（页面被切走、promise 没续上），
     * 下一次广播（别人准备、有人进房）就能把按钮救回来，不用刷新页面。
     * 只在不处于 busy 时放开，避免请求在途时被重复点击。 */
    if (!readyBtn.dataset.busy) readyBtn.disabled = false;

    var isOwner = room.ownerId === state.myId;
    /* 分母跟着阶段走：就位态只算已进入下一局的人，否则「还差 N 人」
     * 会把还在结算页看回放的人算进去，永远等不到。 */
    var act = nextWait ? StateMachine.nextRoundPlayers(room) : StateMachine.activePlayers(room);
    var allReady = act.length > 0 && act.every(function (q) { return q.ready; });

    var hint = $('#room-hint');
    hint.classList.toggle('ready', false);
    if (room.dissolve && room.dissolve.active) {
      hint.textContent = '正在等大家表态要不要结束本局…';
    } else if (act.length < CONFIG.MIN_PLAYERS) {
      hint.textContent = nextWait
        ? '还差 ' + (CONFIG.MIN_PLAYERS - act.length) + ' 人才能开下一局，等其他人点「开始下一局」'
        : '还差 ' + (CONFIG.MIN_PLAYERS - act.length) + ' 人才能开局，可以点「补 AI 队友」一个人先玩';
    } else if (!allReady) {
      hint.textContent = nextWait ? '等待其他人准备…' : '等待所有玩家准备…';
    } else {
      hint.textContent = '全部准备好，马上开始';
      hint.classList.add('ready');
    }

    // 补 AI：仅房主、等待阶段或结算期（就位态）、未满员、且没有解散投票在进行
    var addBotBtn = $('#btn-add-bot');
    if (addBotBtn) {
      var canAddBot = isOwner
        && (room.phase === StateMachine.PHASE.WAITING
          || (room.phase === StateMachine.PHASE.SETTLED && !!nextWait))
        && StateMachine.activePlayers(room).length < StateMachine.capOf(room)
        && !(room.dissolve && room.dissolve.active)
        && RoomStore.getMode() === 'ws';
      addBotBtn.classList.toggle('hidden', !canAddBot);
    }

    /* 就位态的两颗胶囊。都只在 nextWait 出现，理由各不一样：
     *   · 「看上一局过程」必须确实有东西可看 —— 点了弹出「这一局没有留下过程记录」，
     *     比没有这个按钮更糟。history 便宜先查；只有它空的时候才去翻本机场次档案（要读 localStorage）。
     *   · 「上一局结算」只要这一局确实结了就有：分数和 endReason 都在 room 上，
     *     不依赖存档。就位态本身保证 phase === SETTLED，不用再判。 */
    var prevBtn = $('#btn-prev-replay');
    var prevResBtn = $('#btn-prev-result');
    /* 结算期才进来的人（joinedLate）没有上一局：给他「上一局结算 / 看上一局过程」
     * 等于把别人的成绩单摆在一个说自己没打的人面前 —— 他会以为这局是自己打的。
     * 他只该看到这一件事：准备，等着开下一局。 */
    var meLate = !!(me && me.joinedLate);
    var canPrev = false;
    if (nextWait && !meLate) {
      canPrev = packHistory(room.history || []).length > 0;
      if (!canPrev && typeof SessionLog !== 'undefined') {
        var pvSess = SessionLog.load(SessionLog.keyOf(room));
        canPrev = !!(pvSess && pvSess.packs && pvSess.packs.length);
      }
    }
    if (prevBtn) prevBtn.classList.toggle('hidden', !canPrev);
    if (prevResBtn) prevResBtn.classList.toggle('hidden', !nextWait || meLate);

    /* 就位态的两个出口要对调：
     *   「结束本局」→ 藏起来。这一刻 phase 还是 SETTLED，点它必然被拒
     *                （状态机回「对局已结账」），留着就是一个只会报错的按钮。
     *   「回结算页」→ 露出来。误点了「开始下一局」得有地方反悔，
     *                而且回结算页还能看回放 / 存战绩图。 */
    var disBtn = $('#btn-dissolve');
    if (disBtn) disBtn.classList.toggle('hidden', nextWait);
    var backBtn = $('#btn-next-back');
    if (backBtn) backBtn.classList.toggle('hidden', !nextWait);
  }

  /* ====================== 准备态：画在牌桌上（v82） ======================
   *
   * 目标只有一个：房间里等人时看到的就是这张牌桌，不再是另开一页。
   * 做法上刻意「少做」—— 三件事一件都没新写：
   *   · 座位      用对局页已有的顶栏（#game-top）。它本来就把每个人的
   *               「已准备 / 未准备」画在头像角标上了，准备态重复画一遍
   *               只会得到两套会慢慢跑偏的座位样式。
   *   · 按钮      **搬**（appendChild）房间页的 .room-prev-row / .room-actions，
   *               id 一个不改。事件绑在元素上，cloneNode 出来的按钮点不动；
   *               journey 脚本也是按 id 点的。
   *   · 谁准备/还差几人/哪个按钮该露   全部复用 renderRoom，一行判断都没抄。
   * 这样翻 CONFIG.TABLE_READY 时，行为与开关上线前完全一致（节点没被搬，房间页照旧）。
   *
   * 为什么不搬整个座位网格（#room-players）：顶栏已经把坐位画在桌面上了，
   * 再摆一张 2 列网格等于同一屏两套座位表 —— 玩家会不知道哪个才是「在场的人」。
   * 空位的「邀请好友」入口由顶栏右上角那颗按钮承担，不另画邀请卡。
   */
  var tableReadyMounted = false;

  /* 开关的运行时覆盖：?tableready=0 / ?tableready=1。
   * 存在的理由不是给玩家用，是给两种人用：
   *   ① 灰度期值班的人 —— 不想等发版、也不能让所有人一起回退时，改 URL 就能验证老路径；
   *   ② 探针 —— 「关掉开关后行为与上线前一致」这句话必须能被自动验证。
   * 只认 0/1，其余一律按 CONFIG 走，避免一个笔误把功能关掉。 */
  function tableReadyFlag() {
    var q = '';
    try { q = new URLSearchParams(location.search || '').get('tableready') || ''; } catch (e) { q = ''; }
    if (q === '0') return false;
    if (q === '1') return true;
    return !!CONFIG.TABLE_READY;
  }

  function mountTableReady() {
    if (tableReadyMounted) return;
    if (!tableReadyFlag()) return;
    var head = $('#tr-head'), body = $('#tr-body'), acts = $('#ready-acts');
    var roomTop = $('#screen-room .room-top');
    var hint = $('#room-hint');
    var prevRow = $('#screen-room .room-prev-row');
    var actions = $('#screen-room .room-actions');
    /* 任何一个容器缺失就整体不搬：半搬的状态比不搬更糟 ——
     * 会出现「房间号在牌桌上、准备按钮还在房间页」这种两个页面各一半的画面。 */
    if (!head || !body || !acts || !roomTop || !hint || !prevRow || !actions) return;
    head.appendChild(roomTop);
    body.appendChild(hint);
    acts.appendChild(prevRow);
    acts.appendChild(actions);
    tableReadyMounted = true;
  }

  function tableReadyOn() { return !!(tableReadyFlag() && tableReadyMounted); }

  /* 进入准备态。调用方只管「现在该准备」，隐藏/显示由这里统一做 ——
   * 分散在 render 的各个分支里，迟早会漏一处，表现为「牌桌和准备卡叠在一起」。 */
  function showReadyTable(room, opts) {
    var nextWait = !!(opts && opts.nextWait);
    showScreen('screen-game');
    $('#table-ready').classList.remove('hidden');
    $('#ready-acts').classList.remove('hidden');
    $('#screen-game').classList.add('is-ready');
    $('#slots').classList.add('hidden');
    var bottom = $('#screen-game .game-bottom');
    if (bottom) bottom.classList.add('hidden');
    var me = getMe(room);
    if (me) renderTopBar(room, me, room.round, true, nextWait);
    renderRoom(room, opts);
    renderReadyCard(room, opts);
  }

  /* 退出准备态。对局页的每一处显隐都收在这里，别在 renderGame 里补 ——
   * 从准备态进对局只有一条路（phase 变了），但万一以后多一条，这里漏了就是白屏。 */
  function exitReadyTable() {
    var tr = $('#table-ready'), acts = $('#ready-acts');
    if (!tr || tr.classList.contains('hidden')) return;
    tr.classList.add('hidden');
    acts.classList.add('hidden');
    $('#screen-game').classList.remove('is-ready');
    $('#slots').classList.remove('hidden');
    var bottom = $('#screen-game .game-bottom');
    if (bottom) bottom.classList.remove('hidden');
  }

  /* 中央那张房间信息卡：人数与把数上限 / 两轮怎么打 / 我的战绩。
   * 只放「开打前需要知道的」，不放规则全文 —— 规则页还在，这里再抄一遍
   * 会把中间那块毡面填满，反而没有牌桌的感觉。
   *
   * ★ 这里曾经写「起始 20 分」。v105 把基准改成 0 之后那句话就成了「起始 0 分」，
   *   既没信息量、又容易让人误以为兜里那几个 0 是筹码。起始分不是玩家需要知道的变量，
   *   直接不写 —— 分数永远从 0 起算，净胜就是最终分。 */
  function renderReadyCard(room, opts) {
    var card = $('#tr-card');
    if (!card) return;
    var nextWait = !!(opts && opts.nextWait);
    var act = nextWait ? StateMachine.nextRoundPlayers(room) : StateMachine.activePlayers(room);
    var cap = StateMachine.capOf(room);
    var me = getMe(room);

    function line(k, v) {
      return '<div class="tr-line"><span class="tr-k">' + esc(k) + '</span>'
        + '<span class="tr-v">' + esc(v) + '</span></div>';
    }
    var r1 = (StateMachine.ROUND_GROUPS[1] || []).map(function (k) { return SLOT_SHORT_LABEL[k]; }).join(' → ');
    var r2 = (StateMachine.ROUND_GROUPS[2] || []).map(function (k) { return SLOT_SHORT_LABEL[k]; }).join(' → ');

    /* 「我的战绩」只写这一把的分数与名次，不写胜率 —— 胜率是战绩页的事，
     * 这里放个 0% 或 100% 会让刚进房的人以为自己在被打分。 */
    var rankTxt = '—';
    if (me && me.score != null) {
      var sorted = room.players.slice().sort(function (a, b) { return b.score - a.score; });
      var at = -1;
      for (var i = 0; i < sorted.length; i++) if (sorted[i].id === me.id) { at = i; break; }
      rankTxt = (at >= 0 ? '第 ' + (at + 1) + ' / ' + sorted.length + ' · ' : '') + me.score + ' 分';
    }

    card.innerHTML = ''
      + '<div class="tr-card-head">'
      + '<span class="tr-card-title">' + (nextWait ? '准备下一局' : '等大家准备') + '</span>'
      /* 这里原来写「4/5 人」，而圆桌中央牌写「已准备 3/4」—— 两个 n/m 并排出现、
       * 长得一样，含义却一个是「在场 / 上限」、一个是「已准备 / 在场」。
       * 现在第一个改成「4 人 · 上限 5」，不再用斜杠形式，两个数字一眼能分开。
       * 末尾那句「· 起始 20 分」v105 去掉了，理由见函数头注释。 */
      + '<span class="tr-card-sub">' + act.length + ' 人 · 上限 ' + cap + '</span>'
      + '</div>'
      + '<div class="tr-lines">'
      + line('第一轮', r1)
      + line('第二轮', r2)
      /* ★ v103：这一行原来写「见底：分数 ≤ 0 出局，最后一人胜出」。
       * 那条规则已经删了（负分继续打、打到把数为止），继续挂着就是骗人。
       * 换成「本局打几把」—— 这才是现在唯一决定这局什么时候结束的东西，
       * 也是玩家进房后最该知道的一个数。 */
      + line('本局', StateMachine.handLimitOf(room) + ' 把 · 打满为止')
      + line('我的战绩', rankTxt)
      + '</div>'
      /* ★ v114（B-1）「不等他」：只有**我已准备**、且确实有人报了名却没准备时才出现。
       * 放在信息卡里而不是底部按钮条 —— 那条在横屏只有约 0.52 缩放，
       * 再加一颗按钮会把它挤成两行（实测过：9.9px 那一档就是这么来的）。 */
      + skipWaitHtml(room, me, nextWait);
  }

  /* 「不等他」按钮的标记。命名成函数是为了让 renderReadyCard 只读一行。 */
  function staleNextPlayers(room, me, nextWait) {
    if (!nextWait || !me || !me.ready || !me.wantNext) return [];
    return StateMachine.nextRoundPlayers(room).filter(function (p) {
      return !p.ready && p.id !== me.id;
    });
  }
  function skipWaitHtml(room, me, nextWait) {
    var stale = staleNextPlayers(room, me, nextWait);
    if (!stale.length) return '';
    return '<button type="button" class="tr-skip" data-skip-next="' + esc(stale[0].id) + '">'
      + '不等 ' + esc(short(stale[0].nickname || '他')) + '，就我们开'
      + (stale.length > 1 ? '（还有 ' + (stale.length - 1) + ' 人）' : '')
      + '</button>';
  }

  /* 发起「不等他」。要确认一次：这一下会把对方退回结算页，
   * 虽然人还在房间、名次还在，但他会错过这一把。 */
  function onSkipStale(targetId) {
    if (!state.room || blockedOffline()) return;
    var target = null;
    var list = state.room.players || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === targetId) { target = list[i]; break; }
    var who = (target && target.nickname) || '他';
    askConfirm('不等 ' + who + ' 了？',
      '他会退回结算页，这一把不参加；人还在房间里，名次和分数都保留，这一把打完还能再报名。',
      async function () {
        var res = await RoomStore.dropNext(state.roomId, state.myId, targetId);
        if (!res || !res.ok) { flash((res && res.error) || '操作失败'); Sfx.play('error'); return; }
      });
  }

  /* ---------------------------- 对局页 ---------------------------- */
  function renderGame(room) {
    var me = getMe(room);
    if (!me) { render(); return; }
    var round = room.round;
    // 下游渲染只认「锁定态」：正在改一次时按可编辑处理，槽位/手牌要重新可点
    var locked = !canEdit(room, me, round);
    var groups = getCurrentGroups(room, me);

    // 当前组可能指向已经填满/不属于本轮的组（换手、改一次之后），渲染前先校准
    if (!locked) {
      var valid = StateMachine.ROUND_GROUPS[round] || [];
      if (valid.indexOf(state.activeGroup) < 0) {
        state.activeGroup = StateMachine.nextOpenGroup(round, groups, null) || valid[0] || null;
      }
    }

    renderTopBar(room, me, round, locked);
    renderGroupChips(round, groups, locked);
    renderSlots(room, me, round, locked, groups);
    renderHand(room, me, round, locked, groups);
    updateSubmit(room, me, round, locked, groups);
  }

  /*
   * 手牌正上方的「当前组」标签条。
   * 原来的交互是「点牌选中 → 手伸到屏幕上方点空槽」，单手够不到；
   * 现在点标签选组、点手牌直接落进去，整段操作都在拇指区。
   * 标签同时当进度条用（n/need），省掉回头数牌。
   */
  function renderGroupChips(round, groups, locked) {
    var bar = $('#group-chips');
    if (!bar) return;
    if (locked) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
    bar.classList.remove('hidden');

    var keys = StateMachine.ROUND_GROUPS[round] || [];
    var placed = 0;
    var html = '';
    keys.forEach(function (key) {
      var need = StateMachine.GROUP_COUNT[key];
      var got = (groups[key] || []).length;
      placed += got;
      var color = SLOT_COLOR[key] || SLOT_COLOR.single;
      var cls = 'gchip';
      if (key === state.activeGroup) cls += ' is-active';
      if (got >= need) cls += ' is-full';
      html += '<button type="button" class="' + cls + '" data-group="' + key + '"'
        + ' style="--slot-color:' + color.hex + '"'
        + ' aria-pressed="' + (key === state.activeGroup ? 'true' : 'false') + '">'
        + '<span class="gchip-label">' + esc(CHIP_LABEL[key] || key) + '</span>'
        + '<b class="gchip-count">' + got + '/' + need + '</b>'
        + '</button>';
    });
    if (placed > 0) {
      html += '<button type="button" class="gchip gchip-clear" data-clear="1"'
        + ' aria-label="清空重排：把已放的牌全部收回手牌">清空</button>';
    }
    bar.innerHTML = html;
  }

  /* 清空：把已放的牌全部收回手牌，从头再分（点错一堆时比一张张取回快得多） */
  function onClearGroups() {
    var room = state.room, me = getMe(room);
    if (!room || !me) return;
    var round = room.round;
    if (!canEdit(room, me, round)) return;
    var total = 0;
    Object.keys(state.groups).forEach(function (k) { total += (state.groups[k] || []).length; });
    if (total === 0) return;
    resetSplitState();
    state.activeGroup = StateMachine.nextOpenGroup(round, state.groups, null);
    Sfx.play('deal', 0.97);
    flash('已清空，重新分');
    render();
  }

  /* 对局页顶部 = 一块玻璃信息面板 + 一条可横滑的对手座位卡。
   *
   * 这里跟首页底部入口共用同一套「玻璃卡片」语言（深绿半透明底 + 1px 白描边 +
   * 顶部高光），因为之前的顶栏是一串灰字 + 一条金色分隔线 + 原生滚动条，
   * 跟改好的首页完全不像同一个 App。同时修掉三个真正的毛病：
   *   1. 每张座位卡里「✓已提交」气泡 和「●已提交」状态文字 说的是同一件事，
   *      气泡还压在卡片右上角的描边上、和隔壁卡打架 —— 现在只留一处状态药丸；
   *   2. 3 张牌背 + ×6 纯装饰（每家人数恒定 6，牌背只有 3 张会误导成 3 张），
   *      挤掉了名字宽度；删掉后名字和分数各归其位，一列数字对齐像记分牌；
   *   3. 座位条的原生横向滚动条（灰白粗条）直接隐藏，改右缘渐隐提示可滑。 */
  function renderTopBar(room, me, round, submitted, nextWait) {
    var top = $('#game-top');
    /* 圆桌座位环（v87）：整块顶栏换成一张桌子。
     * 开关走 seatRingFlag()（CONFIG.SEAT_RING + URL ?seatring=0/1），关掉之后
     * 继续走下面那条 v86 的路径 —— 一个像素都不差，这是回滚的前提。 */
    if (seatRingFlag()) {
      var ring = ringGeom(top, room);
      if (top) {
        top.classList.add('gt-ring');
        /* 块高由几何算出来，写进 CSS 变量给样式用 —— 不要在 CSS 里再写一遍 450，
         * 那样两个人各改一半就是错位。 */
        top.style.setProperty('--gt-h', ring.h + 'px');
        /* 横屏要换的**不是顶栏自己**，而是 #screen-game 的网格（桌子占左栏、
         * 组槽与手牌进右栏）。类挂在父级而不是 #game-top 上，是因为 grid-template-areas
         * 只有容器说了算；写在顶栏上无处可落。 */
        if (top.parentNode) {
          top.parentNode.classList.toggle('rt-ring', isLandscape);
          /* 窄横屏（iPhone 横屏）走四区网格 + 两列组槽；平板继续 v88 的三行右栏。
           * 两个类共用 #game-top.gt-ring 那一整套桌子样式，不复制。 */
          top.parentNode.classList.toggle('rt-narrow', isLandscape && ringNarrow());
          /* 桌面宽横屏（v91）与窄横屏同一个四区网格，但不走两列组槽 ——
           * 右栏 798 宽、591 高，三行各 190，比拆成两列（各 322 宽）划算得多。 */
          top.parentNode.classList.toggle('rt-desktop', isLandscape && ringDesktop());
        }
        /* 紧凑档挂在顶栏自己身上：要缩的是座位头像、中央牌、对战条这一批**块内**的东西，
         * 与父级的网格无关（竖屏没有网格重排）。 */
        top.classList.toggle('rt-compact', !isLandscape && ringCompact());
      }
      finishTopBar(room, me, ringTopHtml(room, me, round, nextWait, ring), submitted);
      return;
    }
    if (top) {
      top.classList.remove('gt-ring');
      top.classList.remove('rt-compact');
      top.style.removeProperty('--gt-h');
      if (top.parentNode) {
        top.parentNode.classList.remove('rt-ring');
        top.parentNode.classList.remove('rt-narrow');
        top.parentNode.classList.remove('rt-desktop');
      }
    }
    var waiting = room.phase === StateMachine.PHASE.WAITING;
    /* 副标题三档：
     *   就位态   —— 上一把打完了，先说房号，再提「上一把第 N 把」；
     *   等待中   —— 这一把还没开始，写「第 0 把」是假信息，只写房号；
     *   对局中   —— 第几把 · 房号（原样）。 */
    var subHtml = nextWait
      ? '房间 <b>' + esc(room.roomId) + '</b><i class="gt-sep">·</i>已打 ' + handProgressText(room)
      : (waiting
        ? '房间 <b>' + esc(room.roomId) + '</b><i class="gt-sep">·</i>' + StateMachine.activePlayers(room).length + ' 人'
        : '第 ' + handProgressText(room) + '<i class="gt-sep">·</i>房间 <b>' + esc(room.roomId) + '</b>');
    /* 座位搬到桌面上之后，顶栏不再是一张张玻璃卡片，而是「桌沿」：
     *   上排 —— 阶段（最大）/ 第几把·房号（次要） ；右端 —— 我的座位（头像 + 我的分）
     *   下排 —— 对手头像条，直接贴毡面，状态用头像描边色 + 角标表示。 */
    /* 表情入口放在「我的分」左边：这一行右端本来只有一格，
     * 在它左边加一个圆钮既不打乱布局，也不会随人数变化而漂。
     * ★ 每次 renderTopBar 都会重建这个节点，事件必须用委托（见 bindOppSeatTap）。
     * ★ 回滚开关 CONFIG.EMOJI = false（或 URL 带 ?emoji=0）：整条链路都是纯新增的，
     *   但万一灰度期要退，光藏按钮不够 —— 别人的表情还会飞过来。所以这个开关也管
     *   「收不收」（见 onEmojiEvent），两处一起关掉才算真的回到 R3。
     *   ★ 必须走 emojiFlag() 而不是直接读 CONFIG：否则查 URL 的那条路径
     *     只在别处生效，这里仍按 CONFIG 画按钮 —— 就是经典的「开关只关了一半」。 */
    var emojiBtn = emojiBtnHtml('');

    var html = '<div class="gt-row1">'
      + '<div class="gt-info">'
      + '<span class="gt-phase-row">'
      + '<span class="gt-phase">' + esc(nextWait ? '准备中' : phaseLabel(room.phase)) + '</span>'
      + '<span class="gt-timer hidden" id="gt-timer"></span>'
      + '</span>'
      + '<span class="gt-sub">' + subHtml + '</span>'
      + '</div>'
      /* 表情入口（CONFIG.EMOJI = false 时是空串，这一行就只剩我自己的座位） */
      + emojiBtn
      /* 右上角这格是我自己的座位，带上 data-pid 走和对手座位卡同一套点击逻辑：
       * 点自己也能看自己的战绩（以前这里没有 data-pid，点上去什么都不会发生，
       * 而点别人却能弹卡 —— 同一屏两套手感）。 */
      + '<div class="gt-me" data-pid="' + esc(me.id) + '"'
      + ' title="' + esc((me.nickname || '我') + ' · ' + me.score + ' 分 · 点看我的战绩') + '">'
      + '<div class="opp-avatar is-me">' + avatarInner(me.id, me.avatar, '我', false, me.photo) + '</div>'
      + '<div class="gt-me-body">'
      + '<span class="gt-me-label">我的分</span>'
      + '<b class="gt-score">' + me.score + '</b>'
      + '</div>'
      + '</div>'
      + '</div>';
    html += '<div class="gt-opps">';
    room.players.forEach(function (p) {
      if (p.id === state.myId) return;
      var stt = oppSeatState(p, room, round, nextWait);
      var st = stt.text;
      var stCls = stt.cls;
      var badge = stt.badge;

      /* 状态文字不占位了，但不能只靠颜色 —— 角标给符号、title 给完整文字 */
      html += '<div class="gt-opp st-' + stCls + '" data-pid="' + esc(p.id) + '"'
        + ' title="' + esc((p.nickname || '') + ' · ' + p.score + ' 分 · ' + st) + '">'
        + oppAvatarHtml(p, badge)
        + '<div class="opp-main">'
        + '<span class="opp-name">' + esc(short(p.nickname)) + '</span>'
        + '<span class="opp-score">' + p.score + '</span>'
        + '</div>'
        + '</div>';
    });
    html += '</div>';

    finishTopBar(room, me, html, submitted);
  }

  /* 顶栏收尾：写 DOM（内容不变就跳过）+ 分数滚动 + 渐隐提示 + 倒计时。
   * 抽出来是因为「旧顶栏」和「圆桌环」是两套 html，收尾必须**逐字一致**。
   * 复制一份的后果：以后只改了一处，另一处就悄悄少一样（比如分数不滚了）。 */
  function finishTopBar(room, me, html, submitted) {
    var top = $('#game-top');
    if (!top) return;

    /* 顶栏每次点牌都会整块重算。内容和上次完全一样就跳过重建
     *（分数/阶段/状态都在 html 里，变了自然会重建）。删掉 3 张牌背 <img> 之后
     * 7 个人也只剩十来个节点，低端机"点一下卡一下"的源头一起消失了。 */
    if (html !== lastTopHtml) {
      top.innerHTML = html;
      lastTopHtml = html;

      // 我的分数字滚动（涨红跌绿闪色一次）
      var scoreEl = top.querySelector('.gt-score');
      if (scoreEl) {
        var prev = state.lastMeScore;
        if (prev !== null && prev !== me.score) {
          animateScore(scoreEl, prev, me.score);
        }
        state.lastMeScore = me.score;
      }
    }

    // 对手座位条重渲染后重新判定左右渐隐状态
    updateOppScrollHint();

    /* 分牌倒计时：截止时刻由服务端下发（只给本人、只在**未定稿**时给）。
     *
     * ★ 判据用 isRoundLocked，不用 submitted（v106）。点开「改一下」之后
     * submitted 仍然是 true（服务端还留着一份旧分组兜底），但他人已经不是定稿状态 ——
     * 服务端正在给他计时（hub.beginRevise 里挂的），超时按「放弃修改」处理。
     * 这里要是还按 submitted 把倒计时藏起来，玩家会在毫无提示的情况下被超时，
     * 回来发现「我改到一半的牌没了」，还以为是自己点错了。 */
    syncSplitTimer(room, StateMachine.isRoundLocked(me, room.round));
  }
  var lastTopHtml = null;

  /* ============================ 圆桌座位环（v87） ============================
   *
   * 这一版只改**骨架**：顶栏整块换成一张桌子 —— 对手坐在椭圆环的上弧上，
   * 中央是公共状态牌（房号 / 阶段 / 倒计时 / 提交进度），「我」在环下沿。
   * 组槽与手牌的结构没动，只是被挤窄了（组槽 816 → ~550，牌面 139×195 → 117×164）。
   *
   * 为什么只做竖屏：横屏要「左桌右盘」重排（桌子占左栏、组槽搬到右栏手牌上方），
   * 那是另一件事，留给 v88。横屏玩家这一版看到的就是 v86 的版式，
   * 所以开关对他们是空操作，不会出现「转个屏就换了个游戏」。
   *
   * 几何全在 js/seatRing.js（纯函数 + 单测）。这里只负责把数字变成 DOM。
   */
  /* 竖屏圆桌分两档（v90 拆开，与横屏的 v89 拆法同源）：
   *
   *   ≥1500 → portrait（19.5:9，390×844 起）：环 466，组槽 537。
   *   1200~1500 → portraitCompact（16:9，375×667 / 360×640）：环 404，组槽 406。
   *   <1200 → 不上圆桌。
   *
   * 为什么 16:9 必须单独一档：它的舞台**设计高恒为 ~1332**（750 × 高宽比），
   * 比 19.5:9 少 291。用正常环（466）扣完只剩 344 给组槽，三组牌被压到 68×95，
   * 比它替换掉的 v86 版式（109×153）还小 —— 这正是原来那道 1500 闸门要挡的事，
   * 挡法却是「整档退回 v86」。现在改成「环和牌按比例一起缩」：
   * 环 404 + 组槽 406 → 三张组 82×115、斗牛 5 张 90×126（v86 是 62×87）。
   *
   * 1200 是 4:3 平板竖屏（1024×768 → 设计高 1000）的上界：它宽度够、高度不够，
   * 这一版不给它圆桌（真要用得先改「竖屏设计宽 750」这条前提，是另一件事）。
   *
   * ★ v105 起「上不上」的阈值全部搬进 js/ringGate.js（竖屏 1200 / 横屏 700 /
   *   尺度下限 0.44），这里只留**档位分界**（用哪一份几何），不再留闸门数字。
   *   两边混在一起是上一版的坑：改档位的人会顺手改到闸门，改闸门的人不知道
   *   自己动的是「这台机器能不能玩」。 */
  /* 竖屏正常档的下界。低于它就是紧凑档（16:9 一族）。
   * 与 .compact-v 同一条线不是巧合：紧凑档要做的正是短屏压缩那一套，
   * 只是它缩的是环与牌的比例。 */
  var RING_COMPACT_BELOW = 1500;

  /* 横屏圆桌分两档（v89 拆开）：
   *
   *   ≥1000 → v88 的「三行右栏」：组槽在上、手牌与操作条在下，桌子占左栏。
   *   700~1000 → v89 的「四区 + 两列两行」：组标签条与操作条落到左下角，
   *              组槽改成两列（比大小｜十点半 / 飘三叶整行；第二轮 比大小整行 / 斗牛整行）。
   *
   * ★ 为什么窄横屏必须换排法：844×390 的设计高恒为 750（= 1624 × 高宽比），
   *   右栏要竖着装 chips 88 + 三组 305 + 手牌操作 368 = 761，只有 692 —— 差 69。
   *   硬挤的结果是组槽 232 高、三组各 70，牌 60×84 设计 px（33×47 CSS，认不出）。
   *   两列两行把纵向从 3×102 变成 2×158，牌回到 104×146，与不上圆桌时持平。
   *
   * ★ 触摸尺度是**另一条判据**，不再借「1000」兼顾两件事：这里只管「用哪一档几何」，
   *   「这台机器上不上得了桌」在 js/ringGate.js。两件事分开之后各自的阈值可以单独动。 */
  var RING_MIN_LS_STAGE_H = 1000;

  function seatRingFlag() {
    var q = '';
    /* URL 覆盖与 ?tableready / ?emoji 同一套说法：?seatring=0 排障、=1 灰度期单机先试。
     * 必须查 URL 而不是只读 CONFIG，否则 CONFIG 一关就没有任何「单机先看」的办法。 */
    try { q = new URLSearchParams(location.search || '').get('seatring') || ''; } catch (e) { q = ''; }
    if (q === '0') return false;
    /* ★ 1 直接放行，**越过下面的闸门** —— 这是排障/灰度的强制开关：
     *   想在小横屏或矮屏上硬看一次圆桌时不该被挡住（后果自己承担：组槽会溢出，
     *   组槽的滚动条在这套皮肤里看不见，第三组会像「消失」了）。 */
    if (q === '1') return true;
    /* 闸门（v105 起由 RingGate 一处判定：竖屏 1200 / 横屏 700 / 尺度 0.44）。
     * 放在 1 之后、CONFIG 之前：既不是「开关写死」，也不会让 0/1 与 CONFIG 的关系变模糊。 */
    if (!RingGate.flag({
      landscape: isLandscape,
      stageH: lastStageH,
      scale: lastStageScale
    })) return false;
    return CONFIG.SEAT_RING;
  }

  /* 窄横屏档位：走四区网格 + 两列组槽。只影响横屏，竖屏与平板不受影响。 */
  function ringNarrow() {
    return isLandscape && lastStageH > 0 && lastStageH < RING_MIN_LS_STAGE_H;
  }

  /* 竖屏紧凑档（16:9 一族）：环和牌一起按比例缩。见 RING_COMPACT_BELOW 的说明。 */
  function ringCompact() {
    return !isLandscape && lastStageH > 0 && lastStageH < RING_COMPACT_BELOW;
  }

  /* 桌面 / 平板宽横屏（v91）：与 ringNarrow() 互补的另一半。
   *
   * 判据仍是 stageH ≥ 1000 —— 与窄横屏同一条线，不是新阈值：
   *   1280×800 → scale 0.788 → stageH 1015；1024×768 → 0.63 → 1219。
   * 这一档左栏 800 宽、967 高，比 iPhone 横屏（800×702）多出 265+ 设计px。
   * 桌子按 `desktop` 几何放大到 608，多出来的空间交给网格（.rt-desktop 四区），
   * 于是右栏只服务组槽与手牌，牌面从 105×147 回到 127×178。
   *
   * ★ 为什么不是「上不封顶地放大桌子」：rx 由左栏宽度算（800 定死），ratio 一高
   *   桌子就变成正圆、ry 涨，但右栏一张牌也不会变大 —— 真正缺高度的是右栏。
   *   26 英寸以上的窗口 stageH 会到 1219，那时左栏空得更多，但牌面早被 capW 144 卡住，
   *   再改这里只是徒增一档没人验的几何。 */
  function ringDesktop() {
    return isLandscape && lastStageH >= RING_MIN_LS_STAGE_H;
  }

  function ringGeom(top, room) {
    var n = 0;
    if (room && room.players) {
      room.players.forEach(function (p) { if (p.id !== state.myId) n++; });
    }
    /* clientWidth 在 #screen-game 还 hidden 时是 0 —— 退回默认值
     *（竖屏 670 = 750 减左右内边距，横屏 800 = 左栏列宽），
     * 否则第一次渲染会把环算成 320 宽的迷你桌子。 */
    var w = (top && top.clientWidth) || (isLandscape ? 800 : 670);
    var maxH = 0;
    if (isLandscape && top && top.parentNode) {
      /* 横屏的桌子住在左栏，左栏高 = #screen-game 的内容高（减去上下 padding）。
       * 这一条是给窄横屏与平板分屏用的：列宽固定 800 时桌子恒为 550 高，
       * 但左栏可能只有 500 —— 不缩回来，「我」那一格会被 grid 裁掉。 */
      var pe = top.parentNode;
      var cs = window.getComputedStyle(pe);
      maxH = (pe.clientHeight || 0)
        - (parseFloat(cs.paddingTop) || 0)
        - (parseFloat(cs.paddingBottom) || 0);
      if (!(maxH > 320)) maxH = 0;
    }
    return SeatRing.layout({
      w: w,
      n: n,
      /* 四档：横屏按档位分「窄横屏（750 预算）/ 桌面宽横屏（1015+ 预算）」；
       * 竖屏按高度分正常 / 紧凑。判据与 seatRingFlag() 的闸门同源，
       * 两处都读 lastStageH，不会出现「闸门放行了却没换成紧凑几何」的错位。 */
      mode: isLandscape
        ? (ringDesktop() ? 'desktop' : 'landscape')
        : (ringCompact() ? 'portraitCompact' : 'portrait'),
      maxH: maxH
    });
  }

  /* 对手座位状态：一处实现，两套版式共用。
   * 复制两份的后果不是「字不一样」，而是某一版漏掉一条规则 ——
   * 最典型的是 nextWait 必须先于 submitted 判断，漏了就会在就位态写「已提交」。 */
  function oppSeatState(p, room, round, nextWait) {
    if (p.left) return { text: '已离开', cls: 'left', badge: '—' };
    if (p.connected === false) return { text: '掉线中', cls: 'off', badge: '!' };
    if (room.phase === StateMachine.PHASE.WAITING || nextWait) {
      var ready = !!p.ready;
      return {
        text: ready ? '已准备' : (nextWait && !p.wantNext ? '还在结算' : '未准备'),
        cls: ready ? 'ready' : 'idle',
        badge: ready ? '✓' : ''
      };
    }
    if (p.forfeitRound === round) return { text: '已弃权', cls: 'forfeit', badge: '✕' };
    /* ★ 已提交之后又点了「改一下」：这人不是「已提交」，是「还在改」（v105）。
     * 必须放在 submitted 之前判 —— 此刻两个字段同时为真，顺序反了就永远显示「已提交」，
     * 而真相恰恰相反：全桌正在等他，他是唯一没定稿的那个。
     * 不显示出来，其他人只会觉得「都交齐了怎么还不开」。 */
    if (p.revising === round) return { text: '正在改', cls: 'thinking', badge: '…' };
    if (p.submitted['round' + round]) return { text: '已提交', cls: 'submitted', badge: '✓' };
    return { text: '分牌中', cls: 'thinking', badge: '' };
  }

  function oppAvatarHtml(p, badge) {
    var bot = !!p.isBot;
    return '<div class="opp-avatar' + (bot ? ' is-bot' : '') + '">'
      + avatarInner(p.id, p.avatar, bot ? '' : (p.nickname || '?').charAt(0), bot, p.photo)
      + (badge ? '<i class="opp-badge">' + badge + '</i>' : '')
      + '</div>';
  }

  /* 头像内容：真人用预设图（没选过就按 id 哈希落到一款），AI 保持 🤖。
   *
   * 为什么 AI 不用预设图：预设图是为了让人认出「这是谁」，AI 没有这个需求；
   * 反过来，机器人和真人长得一样才是事故 —— 虚线描边 + 机器人图标是唯一
   * 一眼可辨的记号，不能为了视觉统一把它换掉。
   *
   * 为什么还要 fallback：avatar.js 是新加的脚本，老 Service Worker 缓存里
   * 可能还没有它。这时候退化成昵称首字，而不是整块空白。 */
  function avatarInner(pid, chosen, fallbackChar, isBot, photo) {
    if (isBot) return '🤖';
    if (typeof Avatar === 'undefined') return esc(fallbackChar || '?');
    /* 上传的照片优先于预设（P1b）。两套不会长期并存 —— 服务端在「选预设」时
     * 会清掉照片，但房间里存的是**快照**，换头像后旧快照里两样都可能在，
     * 所以这里必须有一条确定的优先级：照片赢。 */
    if (photo) return Avatar.photoImg(pid, photo, '');
    return Avatar.img(pid, chosen, '');
  }

  /* 表情入口。style 参数只在圆桌上用（绝对定位到桌面右下角）；
   * 旧顶栏它是 flex 里的一格，不需要位置。 */
  function emojiBtnHtml(style) {
    if (!emojiFlag()) return '';
    return '<button id="btn-emoji" class="gt-emo" type="button" aria-label="发表情或短语"'
      + (style ? ' style="' + style + '"' : '') + '>'
      + '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">'
      + '<path d="M4.2 6.1A2.6 2.6 0 0 1 6.8 3.5h10.4a2.6 2.6 0 0 1 2.6 2.6v6.6a2.6 2.6 0 0 1-2.6 2.6h-6.4L6.4 18.6v-3.3h.4a2.6 2.6 0 0 1-2.6-2.6z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>'
      + '<circle cx="9.2" cy="9.2" r="1.1" fill="currentColor"/>'
      + '<circle cx="14.8" cy="9.2" r="1.1" fill="currentColor"/>'
      + '</svg></button>';
  }

  /* 提交进度：谁交了、谁还没交。
   * 这是净增能力，不是搬迁 —— v86 之前想知道「还有谁没提交」只能等，
   * 或者去房间页猜。房号所以排在最前：玩家念房号给朋友听的时候正盯着桌子。 */
  function ringProgress(room, round, nextWait) {
    var total = 0;
    var done = 0;
    var isReadyPhase = nextWait || room.phase === StateMachine.PHASE.WAITING;
    room.players.forEach(function (p) {
      if (p.left) return;
      total++;
      if (isReadyPhase) {
        if (p.ready || (nextWait && p.wantNext)) done++;
      } else if (StateMachine.isRoundLocked(p, round)) {
        /* ★ 口径必须与「能不能结算」完全一致，所以直接用状态机那一个函数。
         * 以前这里写的是 `p.submitted[...]`，于是「点了改一下、正在重新摆牌」的人
         * 会被算成已完成 —— 顶栏显示「已提交 4/4」，可这一轮就是不结算。
         * 玩家看到满格不动，只会以为卡死了。 */
        done++;
      }
    });
    return { total: total, done: done, readyPhase: isReadyPhase };
  }

  /* 顶栏的「第几把」带上分母，让玩家随时看得见结束点还有多远。
   *   有上限 → 「3/10 把」；上限是 Infinity（回滚态 room.handLimit=0）→ 只有「3 把」，
   *   绝不能出现「3/Infinity 把」这种把实现细节漏给玩家的写法。
   * 两处顶栏（圆桌牌匾 / 普通玻璃顶栏）共用这一份，改口径只改这里。 */
  function handProgressText(room) {
    var n = room.handCount || 1;
    var limit = StateMachine.handLimitOf(room);
    return isFinite(limit) ? (n + '/' + limit + ' 把') : (n + ' 把');
  }

  function ringPlaqueHtml(room, round, nextWait, g) {
    var waiting = room.phase === StateMachine.PHASE.WAITING;
    var subHtml = nextWait
      ? '房间 <b>' + esc(room.roomId) + '</b><i class="gt-sep">·</i>已打 ' + handProgressText(room)
      : (waiting
        ? '房间 <b>' + esc(room.roomId) + '</b><i class="gt-sep">·</i>' + StateMachine.activePlayers(room).length + ' 人'
        : '第 ' + handProgressText(room) + '<i class="gt-sep">·</i>房间 <b>' + esc(room.roomId) + '</b>');
    var pr = ringProgress(room, round, nextWait);
    var dots = '';
    for (var i = 0; i < pr.total; i++) {
      dots += '<i class="' + (i < pr.done ? 'on' : '') + '"></i>';
    }
    return '<div class="gt-plaque" style="left:' + g.plaque.x + 'px;top:' + g.plaque.y + 'px">'
      + '<span class="gt-sub">' + subHtml + '</span>'
      + '<span class="gt-plaque-phase">'
      + '<b class="gt-phase">' + esc(nextWait ? '准备中' : phaseLabel(room.phase)) + '</b>'
      /* 倒计时节点必须存在且 id 不变：tickSplitTimer 只改它的文本，不重绘顶栏 */
      + '<span class="gt-timer hidden" id="gt-timer"></span>'
      + '</span>'
      + '<span class="gt-prog">' + (pr.readyPhase ? '已准备' : '已提交') + ' ' + pr.done + '/' + pr.total
      + '<span class="gt-dots">' + dots + '</span></span>'
      + '</div>';
  }

  /* 2 人局对战条：你 20 · 分差 4 · 对手 20。
   *
   * 为什么单挑需要它：2 人局桌上只有一个对手坐在正上方，毡面中间是**全屏最显眼的一片空**；
   * 而这一局唯一真正要紧的数字是分差 —— 不给它，玩家每次都要自己拿两个分数做减法。
   * 多人局不加：那时中央牌要占着这块地方报「已提交 3/5」，多一条横幅只会打架。
   *
   * 坐标来自 SeatRing.layout 的 vs（只在 n === 1 时非空），不在这里算 ——
   * 「牌子下移多少、条子放多高」是几何，必须和座位环一起被单测钉住。 */
  function vsBarHtml(room, me, g) {
    if (!g || !g.vs) return '';
    var opp = null;
    room.players.forEach(function (p) { if (p.id !== state.myId) opp = p; });
    if (!opp) return '';
    var ms = me.score | 0;
    var os = opp.score | 0;
    var diff = Math.abs(ms - os);
    var lead = ms > os ? 'me' : (ms < os ? 'opp' : 'tie');
    return '<div class="gt-vs is-' + lead + '"'
      + ' style="left:' + g.vs.x + 'px;top:' + g.vs.y + 'px;height:' + g.vs.h + 'px">'
      + '<span class="vs-side"><i>你</i><b>' + ms + '</b></span>'
      + '<span class="vs-mid">分差 <b>' + diff + '</b></span>'
      + '<span class="vs-side vs-opp"><i>' + esc(short(opp.nickname) || '对手') + '</i><b>' + os + '</b></span>'
      + '</div>';
  }

  function ringTopHtml(room, me, round, nextWait, g) {
    var html = '<div class="gt-felt" style="left:' + g.felt.x + 'px;top:' + g.felt.y
      + 'px;width:' + g.felt.w + 'px;height:' + g.felt.h + 'px"></div>';

    /* .gt-opps 这个类名保留：它现在是「座位层」而不是「可横滑的座位条」，
     * 但有 3 个探针和一条「弹窗打开时锁住座位条滚动」的样式挂在上面，
     * 改名等于给将来留一个「改了名字忘了改那边」的坑。 */
    html += '<div class="gt-opps">';
    var i = 0;
    room.players.forEach(function (p) {
      if (p.id === state.myId) return;
      var s = g.seats[i++];
      if (!s) return;
      var stt = oppSeatState(p, room, round, nextWait);
      html += '<div class="gt-opp st-' + stt.cls + '" data-pid="' + esc(p.id) + '"'
        + ' style="left:' + s.x + 'px;top:' + s.y + 'px;--nmw:' + s.nmw + 'px"'
        + ' title="' + esc((p.nickname || '') + ' · ' + p.score + ' 分 · ' + stt.text) + '">'
        + oppAvatarHtml(p, stt.badge)
        + '<span class="opp-name">' + esc(short(p.nickname)) + '</span>'
        + '<span class="opp-score">' + p.score + '</span>'
        + '</div>';
    });
    html += '</div>';

    html += ringPlaqueHtml(room, round, nextWait, g);
    html += vsBarHtml(room, me, g);

    /* 环下沿的「我」。data-pid 让它和对手座位走同一套点击（点自己也能看战绩） */
    html += '<div class="gt-me" data-pid="' + esc(me.id) + '"'
      + ' style="left:' + g.me.x + 'px;top:' + g.me.y + 'px"'
      + ' title="' + esc((me.nickname || '我') + ' · ' + me.score + ' 分 · 点看我的战绩') + '">'
      + '<div class="opp-avatar is-me">' + avatarInner(me.id, me.avatar, '我', false, me.photo) + '</div>'
      + '<div class="gt-me-body">'
      + '<span class="gt-me-label">我的分</span>'
      + '<b class="gt-score">' + me.score + '</b>'
      + '</div>'
      + '</div>';

    /* 减半是为了让按钮以 g.emoji 为中心。half 不能再写死 44 —— v105 起直径是
     * max(88|92, --tap-min)，小横屏上会到 92~97，写死 44 会让它偏出几个像素。
     * --emo-half 由 resize() 按同一套规则算出来，两边不会各自漂。 */
    html += emojiBtnHtml('left:calc(' + g.emoji.x + 'px - var(--emo-half, 44px));top:calc('
      + g.emoji.y + 'px - var(--emo-half, 44px))');
    return html;
  }


  /* ---------------------------- 分牌倒计时 ----------------------------
   * 只在分牌阶段、且我还没提交时出现。为什么必须有：服务端到点会直接判
   * 「本回合弃权」（不收分、还得照付各组赢家），而以前界面上一句话都没有，
   * 玩家是事后才看到结果的 —— 对「一部手机切三个容器轮着操作」的人基本必踩。
   *
   * 数字每秒跳，所以只改文本、不重绘顶栏：整块重绘会让正在点的按钮失焦，
   * 也会打断手牌上正在跑的动画。 */
  var splitEndsLocal = 0;    // 已扣掉时钟偏差的截止时刻（本地时间轴）
  var splitTickTimer = null;

  function stopSplitTick() {
    if (splitTickTimer) { clearInterval(splitTickTimer); splitTickTimer = null; }
  }

  function tickSplitTimer() {
    /* 不要叫 el —— 会遮蔽顶层那个造 DOM 的 el() 工具函数（ui.test 有专门一条守这个） */
    var chip = $('#gt-timer');
    if (!chip || !splitEndsLocal) { stopSplitTick(); return; }
    var left = Math.max(0, Math.ceil((splitEndsLocal - Date.now()) / 1000));
    chip.textContent = left > 0 ? ('剩 ' + left + ' 秒') : '时间到';
    chip.classList.toggle('is-warn', left <= 15);
    if (left <= 0) stopSplitTick();
  }

  function syncSplitTimer(room, locked) {
    stopSplitTick();
    splitEndsLocal = 0;
    var chip = $('#gt-timer');
    if (!chip) return;
    var ends = Number((room && room.splitEndsAt) || 0);
    if (locked || !ends) { chip.classList.add('hidden'); return; }
    /* 服务端时间 − 本地时间 = 时钟偏差。设备时间被手动改过、或时区设错时，
     * 纯按本地算的倒计时会整体偏掉，甚至一进来就显示「时间到」。 */
    var skew = (Number(room.now) || Date.now()) - Date.now();
    splitEndsLocal = ends - skew;
    chip.classList.remove('hidden');
    tickSplitTimer();
    splitTickTimer = setInterval(tickSplitTimer, 1000);
  }

  /* 对手座位条可滑动方向提示：内容超宽时加右缘渐隐，滑到边缘取消对应侧渐隐 */
  function updateOppScrollHint() {
    var bar = document.querySelector('.gt-opps');
    if (!bar) return;
    var scrollable = bar.scrollWidth > bar.clientWidth + 1;
    var atStart = bar.scrollLeft <= 4;
    var atEnd = bar.scrollLeft + bar.clientWidth >= bar.scrollWidth - 4;
    bar.classList.toggle('can-scroll', scrollable);
    bar.classList.toggle('at-start', scrollable && !atStart);
    bar.classList.toggle('at-end', scrollable && atEnd);
  }

  /* 我的分数字滚动（P2）：旧值 → 新值 0.5s，结束按涨/跌闪色一次 */
  function animateScore(el, from, to) {
    var start = performance.now();
    var dur = 500;
    var cls = to >= from ? 'pos' : 'neg';
    function step(now) {
      var t = Math.min(1, (now - start) / dur);
      el.textContent = String(Math.round(from + (to - from) * t));
      if (t < 1) { requestAnimationFrame(step); }
      else {
        el.classList.add(cls);
        setTimeout(function () { el.classList.remove(cls); }, 500);
      }
    }
    requestAnimationFrame(step);
  }

  var lastSlotsHtml = null;

  /* 一组里摆 n 张牌时每张能有多大。
   * 桌带是满宽的（牌在左、组信息右对齐），张数少的组用最大尺寸，
   * 「斗牛 5 张」这种就按剩余宽度均分 —— 不会再把牌挤出桌带。
   *
   * 尺寸不再写死：纵向要给三组都留够地方，所以先量组槽真实可用高再反推
   * （算法在 js/slotLayout.js，纯函数、有单测）。上限仍是 144×202，
   * 大屏（390×844 等 19.5:9）算下来正好顶到上限 —— 表现与改前完全一致。
   * 矮屏（16:9 手机 / 横屏）另走 dense 排法，组信息挪到牌右侧，见 style.css。 */
  var BAND_INNER_W = HAND_AREA_W - 18 * 2 - 5;   // 670 − 左右内边距 − 左色条/右描边

  var slotDense = false;       // 矮屏：桌带改成「牌在左、组信息在右」一行
  var slotBudgetH = null;      // 单组允许的最大牌高（设计px）；null = 牌桌还没显示，先按原尺寸
  var isLandscape = false;     // 横屏版式（.ls）：桌带宽度不再等于竖屏的 670，要现量
  /* 最近一次 resize() 量到的舞台高（设计px）。座位环要不要上，除了看开关还要看它 ——
   * 圆桌撑不开的矮屏必须退回 v86 版式，否则第三组牌会被裁掉（见 js/ringGate.js）。 */
  var lastStageH = 0;
  /* 最近一次 resize() 的实际缩放（= 屏宽 / 设计宽，横屏按 1624 宽那套算）。
   * 座位环的第二道闸门要它：667×375 的设计高 913 ≥ 700，但 scale 0.41 会让
   * 88 设计 px 的表情入口只剩 36 CSS px。只靠「设计高」这一个数看不出来。 */
  var lastStageScale = 0;
  /* 窄横屏的两列组槽（v89）。跟 slotDense 一样是排法档位，跟着 resize() 走。 */
  var slotTwoCol = false;
  /* 每轮「哪一组占几列」。值 = 占几列；没列出的组默认整行（2 列）。
   * 两轮都是两行，行高一致 —— 换轮时牌不会跳动。 */
  var TWO_COL_SPAN = {
    1: { single: 1, tenhalf: 1, piaosanye: 2 },
    2: { single: 2, douniu: 2 }
  };
  var TWO_COL_GAP = 10;   // 与 CSS `#slots[data-twocol="1"]` 的 column-gap 一致（测试反查）

  /* 桌带内宽：竖屏是个常量（750 减屏幕内边距），横屏是「左栏实际宽度」。
   * 横屏左栏比 670 宽，继续用常量会让 5 张的「斗牛」组白白留一条空毡面。 */
  function slotBandInnerW() {
    if (!isLandscape) return BAND_INNER_W;
    var slots = $('#slots');
    var w = slots ? slots.clientWidth : 0;
    /* 18×2 是 .slot 左右内边距，5 是左侧色条 + 右描边 —— 与竖屏常量同一口径 */
    return w > 0 ? (w - 18 * 2 - 5) : BAND_INNER_W;
  }

  function recomputeSlotBudget() {
    var slots = $('#slots');
    if (!slots) { slotBudgetH = null; return; }
    var want = slotDense ? '1' : '0';
    if (slots.getAttribute('data-dense') !== want) slots.setAttribute('data-dense', want);
    var twoWant = slotTwoCol ? '1' : '0';
    if (slots.getAttribute('data-twocol') !== twoWant) slots.setAttribute('data-twocol', twoWant);
    var availH = slots.clientHeight;   // 设计像素（#stage 的 transform 不影响布局值）
    /* 两列两行时纵向只分两行 —— 传 2 而不是 3，否则牌会被按「三行」算得偏小 */
    slotBudgetH = availH ? SlotLayout.maxCardHeight(availH, slotDense, slotTwoCol ? 2 : 0) : null;
  }

  /* span：这一组占几列（只在窄横屏的两列档里有意义；1 = 半宽，2/其它 = 整行）。
   * 半宽时桌带内宽要按单元格算，否则 3 张牌会按整行的宽去均分、旁边白白多出半行。 */
  function slotCardSize(n, span) {
    var ring = seatRingFlag();
    var bandW = slotBandInnerW();
    if (slotTwoCol && span === 1) bandW = Math.floor((bandW - TWO_COL_GAP) / 2);
    return SlotLayout.cardSize(n, {
      dense: slotDense,
      bandInnerW: bandW,
      capW: SLOT_CARD_W,
      maxCardH: slotBudgetH,
      /* 圆桌版：组槽被压矮后牌先被高度卡住，横向比例要按张数给 ——
       * n≤3 时 0.6 够用，n=5 时 0.6 会把斗牛压到 69×97（低于 82×115 的下限）。
       * minW 是最后一道硬线：比例算出来更小、但桌带放得下时抬到下限。
       *
       * ★ v90：这道硬线不只圆桌要。320×568 这一档圆桌**故意不开**（scale 0.427，
       * 表情入口只剩 39 CSS px），退回 v86 版式之后斗牛只有 62×87 —— 同一个病、
       * 同一个方子：dense 下 0.55 的横向比例只是「给组信息留位置」的手段，
       * 而这里桌带明明放得下 82，就该放到 82。canDo 那道判断会挡住「放不下还硬抬」，
       * 所以对宽屏是空操作。 */
      widthRatio: ring ? SlotLayout.ringWidthRatio(n) : null,
      minW: ring ? SlotLayout.ringMinCardW(n) : (slotDense ? SlotLayout.ringMinCardW(n) : 0)
    });
  }

  /*
   * 槽位整块用字符串拼，内容没变就不重写 innerHTML。
   * 原来每次点牌都 new 一堆 div/img + 逐个加监听，四组最多 12 张牌面全部重建；
   * 现在内容相同直接跳过，内容变了也是一次赋值，点击交给 #slots 上的委托。
   *
   * 结构：一条满宽的「桌带」= 左边一组牌 + 右下角对齐的组信息。
   * 之前每组只有 max-content 宽、挤在左侧 60%，右边 264px 是一片没来由的空毡面。
   */
  /* 十分之一整数 → 展示用点数：105 → 10.5、95 → 9.5、200 → 20。
   * 用整数是为了和 engine 同口径（那边整套都用十分之一，避免 0.1+0.2 的浮点误差）。 */
  function fmtTenths(t) {
    var v = t / 10;
    return v % 1 === 0 ? String(v) : v.toFixed(1);
  }

  function renderSlots(room, me, round, submitted, groups) {
    var slots = $('#slots');
    recomputeSlotBudget();   // 可用高变了（转屏/换机型）牌尺寸就要重算，每次渲染都过一遍
    var keys = StateMachine.ROUND_GROUPS[round] || [];
    var active = state.activeGroup;
    var spanMap = slotTwoCol ? TWO_COL_SPAN[round] : null;
    /* 局粒度而不是轮粒度：新一局从第 1 轮重新开始，只用 round 判断的话
     * 会和上一局末的第 1 轮撞上，成手脉冲就少放一次。 */
    var freshKey = round + ':' + (room.handCount || 0);
    if (CardView.getSlotTypeRound() !== freshKey) resetSlotTypeSeen(freshKey);
    var html = '';
    var nextTypeSeen = {};
    keys.forEach(function (key) {
      var count = StateMachine.GROUP_COUNT[key];
      /* 窄横屏两列档：半宽的组按单元格宽均分牌，整行的按整行宽 */
      var span = spanMap ? (spanMap[key] || 2) : 0;
      var size = slotCardSize(count, span);
      var cards = groups[key] || [];
      var color = SLOT_COLOR[key] || SLOT_COLOR.single;
      var isActive = !submitted && key === active;

      /* 十点半组：满 2 张就常驻显示点数，爆了点红。
       * 只在「放牌那一刻弹一次 toast」不够 —— 玩家放完可能先去看别的组，
       * 回头已经忘了刚才那句警告。常驻的「13 爆」是他提交前最后一道自检。 */
      var pair = (key === 'tenhalf' && cards.length === 2)
        ? StateMachine.tenHalfPair(cards) : null;
      var bustNow = !!(pair && pair.bust);

      /* 放满即报牌型（v92）。没放满还是 n/n 进度条 —— 满组不需要进度。 */
      var typeName = slotTypeOf(key, cards);
      /* 十点半的「牌型」就是点数，所以它不贴胶囊（见 slotTypeOf 的注释）。
       * 但 **10.5 是这一组的满分**，和豹子/牛牛/五花牛一样是大牌型 ——
       * 以前它在组牌阶段只有一颗绿的「10.5」徽标，没有成手光晕也没有脉冲，
       * 反而成了四个大牌型里唯一一个「凑到顶了却毫无动静」的（v93 补）。
       *
       * 做法是给 typeFresh 一个**合成名**：seen 表里记 '10.5点'，
       * 胶囊仍然由 typeName 决定（为空 → 照旧走 n/n 进度），
       * 于是组光晕 / 牌型色 / 徽标脉冲都能复用同一套判定，
       * 不需要为了十点半再养一份 slotTypeSeen。 */
      var bestNow = !!(pair && !pair.bust && pair.points === StateMachine.TENHALF_MAX_TENTHS);
      var seenKey = typeName || (bestNow ? '10.5点' : '');
      var typeFx = typeName ? (BIG_FX[typeName] || null)
        : (bestNow ? BIG_FX['10.5点'] : null);
      nextTypeSeen[key] = seenKey;
      var typeFresh = !!(seenKey && CardView.getSlotTypeSeen()[key] !== seenKey);

      html += '<div class="slot' + (isActive ? ' is-active' : '') + (bustNow ? ' is-bust' : '')
        + (typeFresh && typeFx ? ' is-fresh' : '')
        + '" data-game="' + key + '"'
        + (spanMap ? ' data-span="' + span + '"' : '')
        + ' style="--slot-color:' + color.hex + ';--slot-soft:' + color.soft
        + (typeFx ? ';--fx-color:' + typeFx.color : '') + '">'
        + '<div class="slot-boxes">';

      for (var i = 0; i < count; i++) {
        var boxStyle = 'width:' + size.w + 'px;height:' + size.h + 'px';
        if (cards[i]) {
          html += '<div class="card-box" data-group="' + key + '"'
            + ' data-card-id="' + cards[i].suit + '-' + cards[i].rank + '" style="' + boxStyle + '">'
            + cardImgHtml(cards[i], size.w, size.h)
            + '</div>';
        } else {
          // 只点亮「当前组」的空位：这是手牌会落进去的地方，
          // 其余组也发光的话满屏都是可落点，反而看不出该点哪
          html += '<div class="card-box empty' + (isActive ? ' highlight' : '') + '"'
            + ' data-group="' + key + '" style="' + boxStyle + '"></div>';
        }
      }
      html += '</div>'
        + '<div class="slot-meta">'
        + '<div class="slot-meta-main">'
        + '<span class="slot-badge">' + esc(SLOT_BADGE[key] || '') + '</span>'
        + '<span class="slot-label">' + esc(SLOT_SHORT_LABEL[key] || key) + ' · ' + count + '张</span>'
        + (typeName
          /* 牌型胶囊。大牌型（BIG_FX 里那 5 个）另挂 is-big，组色换成牌型色，
           * 并且只在**刚成手**那一次播放脉冲（is-new）。 */
          ? '<span class="slot-type' + (BIG_FX[typeName] ? ' is-big' : '')
            + (typeFresh ? ' is-new' : '') + '">' + esc(typeName) + '</span>'
          : '<span class="slot-progress' + (cards.length === count ? ' full' : '') + '">'
            + cards.length + '/' + count + '</span>')
        /* 10.5 是这组的满分：给它和「不爆」不同的颜色，玩家一眼能看出自己凑到了顶。
         * 刚凑到 10.5 的那一帧再挂 is-new，让徽标自己也弹一下 ——
         * 它与豹子/牛牛/五花牛胶囊上的 slotTypePop 是同一个动作。 */
        + (pair
          ? '<span class="slot-point'
            + (pair.bust ? ' bust' : (pair.points === StateMachine.TENHALF_MAX_TENTHS ? ' best' : ''))
            + (bestNow && typeFresh ? ' is-new' : '')
            + '">' + (pair.bust ? '爆 ' : '') + fmtTenths(pair.points) + '</span>'
          : '')
        + '</div>'
        + '<span class="slot-hint">' + esc(SLOT_HINT[key] || '') + '</span>'
        + '</div></div>';
    });

    if (html !== lastSlotsHtml) {
      slots.innerHTML = html;
      lastSlotsHtml = html;
      /* ★ 只有真的写进 DOM 之后才提交「见过的牌型」。见 slotTypeSeen 的注释。 */
      CardView.setSlotTypeSeen(nextTypeSeen);   // 整体替换，见 cardView.js 的 getter/setter 说明
    }
  }

  /* 只重画组槽：resize 改了缩放或 dense 排法之后，牌尺寸要按新预算重算。
   * 不走 render() —— 它顺手会弹结算框，窗口一抖就弹一次，不合适。 */
  function refreshSlotLayout() {
    var screen = $('#screen-game');
    if (!screen || screen.classList.contains('hidden')) return;
    var room = state.room;
    if (!room) return;
    var me = getMe(room);
    if (!me) return;
    var round = room.round;
    lastSlotsHtml = null;   // 尺寸可能变了，必须重写 innerHTML（否则「内容没变就跳过」会留旧尺寸）
    renderSlots(room, me, round, !canEdit(room, me, round), getCurrentGroups(room, me));
  }

  /* 盯住组槽自身高度。
   * 只在 resize() 里重算不够：实测横屏（812×375）下标签条先折行再收回，
   * 组槽从 461 长到 611，牌却停在按 461 算出来的 96×134。
   * 字体加载、安全区变化、标签条换行都会造成同样的事，所以让容器自己报高度。 */
  var slotRO = null;
  function watchSlotResize() {
    if (typeof ResizeObserver !== 'function') return;   // 老浏览器退回：仍有 resize() 那次重算
    var slots = $('#slots');
    if (!slots || slotRO) return;
    var lastH = -1;
    slotRO = new ResizeObserver(function () {
      var h = slots.clientHeight;
      if (h === lastH) return;
      lastH = h;
      refreshSlotLayout();
      /* 组槽高度变了 → 牌面尺寸也变了，调试侧栏上那个「牌面」要跟着刷新
       * （不然面板会停在上一次 resize 的数字上，比不显示更误导）。 */
      updateDev();
    });
    slotRO.observe(slots);
  }

  function renderHand(room, me, round, submitted, groups) {
    var hand = $('#hand');

    /* ---- 状态文案（弃局 / 弃权 / 已提交 / 已放完） ---- */
    var statusHtml = null;
    if (me.left) {
      statusHtml = '<div class="hand-status">你已弃局，等待本局结束</div>';
    } else if (me.forfeitRound === round) {
      /* 说清代价：弃权不是「本回合 0 分」这种无损状态，
       * 各组都当放弃，自己不收分但照样向赢家付分。原文案「计 0 分」
       * 会让人以为挂机没损失，正好把规则说反了。 */
      statusHtml = '<div class="hand-status">你已超时弃权：本回合不收分，仍要照付各组赢家，等待结算…</div>';
    } else if (submitted) {
      var oppOff = room.players.some(function (p) { return p.id !== state.myId && p.connected === false && !p.left; });
      statusHtml = '<div class="hand-status waiting"><span class="pulse-dot"></span>等待其他玩家提交…' + (oppOff ? '（对方掉线，重连中或本局将结束）' : '') + '</div>';
    }

    var placedIds = {};
    Object.keys(groups).forEach(function (k) {
      (groups[k] || []).forEach(function (c) { placedIds[c.suit + '-' + c.rank] = true; });
    });
    var handCards = statusHtml ? [] : me.hand.filter(function (c) { return !placedIds[c.suit + '-' + c.rank]; });
    if (!statusHtml && handCards.length === 0) {
      statusHtml = '<div class="hand-status">已全部放入分组，请提交</div>';
    }
    if (statusHtml) {
      // 同一段文案反复重写 innerHTML 会打断正在跑的 CSS 动画，值一样就别动
      if (hand.dataset.status !== statusHtml) {
        hand.innerHTML = statusHtml;
        hand.dataset.status = statusHtml;
      }
      hand.dataset.mode = 'status';
      return;
    }
    delete hand.dataset.status;
    // 从「状态文案」切回手牌：文案节点是直接写进 innerHTML 的，不复用逻辑管不到它
    if (hand.dataset.mode === 'status') {
      hand.innerHTML = '';
      hand.dataset.mode = 'cards';
    }

    /* ---- 手牌重叠布局：等高平铺 ----
     * 宽度用确定性设计常量 HAND_AREA_W（670），不做 transform 舞台上的运行时 clientWidth 测量，
     * 避免 SW 新旧混存 / 浏览器时机差异拿到非 670 的缩放相关值导致间距错乱。 */
    var n = handCards.length;
    var handW = HAND_AREA_W;
    // 露出条带钳制在 [80, 110]：任何异常情况下角标仍可读（≥80 设计px），且不会过疏
    var visibleW = n > 1 ? Math.max(80, Math.min(110, Math.floor((handW - HAND_CARD_W) / (n - 1)))) : 0;
    var totalW = (n - 1) * visibleW + HAND_CARD_W;
    var offsetX = Math.max(0, Math.round((handW - totalW) / 2));

    /* 节点复用：每点一张牌都重建 6 个 <img> 是低端机上「点了半天没反应」的主因。
     * 这里只增删有变化的节点，其余的只改 left/transform（浏览器只做合成，不重建）。 */
    var existing = {};
    for (var ci = hand.children.length - 1; ci >= 0; ci--) {
      var ch = hand.children[ci];
      var cid0 = ch.dataset ? ch.dataset.cardId : null;
      if (cid0) existing[cid0] = ch;
    }
    var keep = {};
    handCards.forEach(function (c) { keep[c.suit + '-' + c.rank] = true; });
    Object.keys(existing).forEach(function (cid) {
      if (!keep[cid] && existing[cid].parentNode === hand) hand.removeChild(existing[cid]);
    });

    var justDealt = state.justDealt;
    state.justDealt = false;

    handCards.forEach(function (card, i) {
      var cid = card.suit + '-' + card.rank;
      var isNew = !existing[cid];
      var wrap = existing[cid] || handCardWrap(card);

      wrap.style.left = (offsetX + i * visibleW) + 'px';
      // 等高平铺：手牌统一高度，不做扇形上下错落（更整齐、落点稳定）
      wrap.style.transform = 'translateY(0px)';
      wrap.style.zIndex = 10 + i;

      var img = wrap.querySelector('img.card');
      if (justDealt && isNew && img) {
        img.classList.add('deal-in');                 // 发牌飞入（作用在内层 img，不破坏扇形定位）
        img.style.animationDelay = (i * 80) + 'ms';
        setTimeout(function () { Sfx.play('deal'); }, i * 80 + 300);
      }
      // 顺序也要对：DOM 顺序决定同 z-index 时的层叠，重排只发生在位置真的变了的时候
      if (hand.children[i] !== wrap) hand.insertBefore(wrap, hand.children[i] || null);
    });
    hand.dataset.mode = 'cards';
  }

  function updateSubmit(room, me, round, locked, groups) {
    var btn = $('#btn-submit');
    var reviseBtn = $('#btn-revise');
    var keys = StateMachine.ROUND_GROUPS[round];
    var revising = state.reviseRound === round;

    /* 「改一下」这一个按钮有两个语义，共用同一个位置（v105）：
     *   已提交 → 「改一下」：进入修改态
     *   修改态 → 「不改了」：放弃修改，退回已提交的那份旧分组
     *
     * 为什么必须给「不改了」这个出口：进入修改态之后他**不再算定稿**，
     * 全桌都在等他（见 SM.isRoundLocked）。没有后悔出口的话，误点一下就只能
     * 真改一次（消耗掉唯一一次修改额度）才能让这一轮走完。
     *
     * 为什么复用按钮而不是新增：底部就两个位置，都在拇指区，
     * 塞第三个按钮的代价是把另外两个挤小，不值。
     *
     * 顺带修掉一个老毛病：原来这里只 toggle hidden、不管文案，
     * 于是「改一下」进过一次修改态之后就再也显示不出来 —— 现在统一在
     * 这里写 textContent，显示什么只取决于当前状态。 */
    if (reviseBtn) {
      var showRevise = revising || (locked && canRevise(me, round));
      reviseBtn.classList.toggle('hidden', !showRevise);
      reviseBtn.textContent = revising ? '不改了' : '改一下';
    }

    if (locked) {
      btn.disabled = true;
      btn.textContent = '已提交';
      return;
    }

    var missing = [];
    var totalMissing = 0;
    keys.forEach(function (k) {
      var need = StateMachine.GROUP_COUNT[k];
      var got = (groups[k] || []).length;
      var left = need - got;
      if (left > 0) {
        totalMissing += left;
        missing.push({ label: SLOT_SHORT_LABEL[k] || k, left: left });
      }
    });
    if (totalMissing === 0) {
      btn.disabled = false;
      btn.textContent = revising ? '重新提交' : '提交分组';
    } else {
      btn.disabled = true;
      // 动态指引：只差一组时点名，多组时给总数
      btn.textContent = missing.length === 1
        ? ('还差「' + missing[0].label + '」' + missing[0].left + ' 张')
        : ('再选 ' + totalMissing + ' 张牌');
    }
  }

  function groupsSummary(round, groups) {
    var keys = StateMachine.ROUND_GROUPS[round];
    var parts = [];
    keys.forEach(function (k) {
      var cards = groups[k] || [];
      var need = StateMachine.GROUP_COUNT[k];
      var names = cards.map(cardText).join(' ');
      /* 牌型名跟在牌名后面（v92）：这是提交前最后一眼，玩家要确认的不只是
       * 「放了哪几张」，还有「这手是什么牌」。以前这里只有牌名，
       * 想确认自己是牛几得自己在脑子里凑十。
       *
       * ★ 判定走 Engine.typeName（全仓唯一实现），前端不复算；
       * ★ 单张组不给：Engine 对 single 返回的就是那张牌的名字，和前面的牌名重复。
       */
      var typeText = '';
      if (cards.length === need && k !== 'single') {
        var tn = Engine.typeName(k, cards);
        if (tn) typeText = ' · ' + tn;
      }
      parts.push((SLOT_SHORT_LABEL[k] || k) + '：' + (names || '空') + typeText);
    });
    return parts.join('\n');
  }

  /* 进入「改一次」：把已提交的分组拷进本地草稿，界面回到可编辑。
   *
   * ★ v105 修的那个 bug 就出在这个函数里：
   *   以前它只设 state.reviseRound（纯前端变量）就完事了。服务端那边
   *   `submitted` 还是 true、也完全不知道有人在改，于是别人全部提交的那一刻
   *   「全员到齐」成立，本轮当场结算 —— 用的是**他还没改完的那份旧分组**。
   *   他连提交都没点，分数就已经按旧牌算好了，全程没有任何提示。
   *
   *   现在第一步是让服务端进入「修改中」状态（RoomStore.beginRevise），
   *   它会把这个玩家从「已定稿」里摘出来，别人全交也得等。
   */
  async function onRevise() {
    var room = state.room, me = getMe(room);
    if (!room || !me) return;
    var round = room.round;

    // 已经在修改态 = 这次点击的意思是「不改了」
    if (state.reviseRound === round) return onCancelRevise();

    if (!canRevise(me, round)) { flash('本轮已改过一次'); return; }
    var submitted = me.groups && me.groups['round' + round];
    if (!submitted) return;

    var restore = pressBusy($('#btn-revise'), '准备中…');
    if (!restore) return;
    try {
      var res = await RoomStore.beginRevise(room.roomId, state.myId);
      if (!res || !res.ok) {
        flash((res && res.error) || '进不了修改，稍后再试');
        Sfx.play('error');
        return;
      }
    } catch (e) {
      flash('网络不太稳，稍后再试');
      Sfx.play('error');
      return;
    } finally {
      restore();
    }

    state.groups = {
      single: (submitted.single || []).slice(),
      tenhalf: (submitted.tenhalf || []).slice(),
      piaosanye: (submitted.piaosanye || []).slice(),
      douniu: (submitted.douniu || []).slice()
    };
    state.reviseRound = round;
    state.activeGroup = StateMachine.nextOpenGroup(round, state.groups, null);
    Sfx.play('select');
    render();
  }

  /* 放弃这次修改，退回「已提交（旧分组）」。
   * 不消耗修改额度 —— 点开看一眼又退回来，不该算「改过一次」。 */
  async function onCancelRevise() {
    var room = state.room, me = getMe(room);
    if (!room || !me) return;
    var round = room.round;
    if (state.reviseRound !== round) return;

    var restore = pressBusy($('#btn-revise'), '撤回中…');
    if (!restore) return;
    try {
      var res = await RoomStore.cancelRevise(room.roomId, state.myId);
      if (!res || !res.ok) {
        flash((res && res.error) || '撤回不了，稍后再试');
        Sfx.play('error');
        return;
      }
    } catch (e) {
      flash('网络不太稳，稍后再试');
      Sfx.play('error');
      return;
    } finally {
      restore();
    }

    /* 草稿留在原地不清：万一是手滑点错，再点「改一下」时状态还在。
     * 真正决定界线的是 reviseRound 与 canEdit() —— 清成空分组反而会让
     * 槽位一瞬间全空、看起来像牌被没收了。 */
    state.reviseRound = -1;
    Sfx.play('select', 0.95);
    render();
  }

  /* ---------------------------- 交互：分牌 ---------------------------- */
  function cardFromId(room, cid) {
    // 服务端按视角下发，别家手牌是空的；先查自己，再兜底全房间（本地演示模式房间是完整的）
    var me = getMe(room);
    if (me && me.hand) {
      for (var i = 0; i < me.hand.length; i++) {
        if ((me.hand[i].suit + '-' + me.hand[i].rank) === cid) return me.hand[i];
      }
    }
    for (var j = 0; j < room.players.length; j++) {
      var h = room.players[j].hand || [];
      for (var k = 0; k < h.length; k++) if ((h[k].suit + '-' + h[k].rank) === cid) return h[k];
    }
    return null;
  }

  /*
   * 第一轮「十点半优先」被违背时的提示。
   *
   * 只提醒、不拦截：牌照样放进池子，玩家自己决定要不要换。
   * 理由是这个原则约束的是「怎么搭配」，不是「不许操作」——
   * 挡住会让人以为界面坏了（尤其连点时目标组会自动顺延，玩家未必想放这组）。
   *
   * ★ 只在一种处境里出声：**手里还有不爆的打法，玩家却选了爆的**。
   *   整手怎么配都爆时不提示 —— stateMachine 那边直接返回 null，走不到这里。
   */
  function warnTenHalf(adv) {
    var msg;
    if (adv.kind === 'must-bust') {
      /* 能到这里只剩一种：这张放十点半配哪张都爆，但换两张还能不爆。
       * （「整手怎么配都爆」已在 stateMachine 里静默，不会到界面。） */
      msg = '这张放十点半，配哪张都会爆 · 换一张';
    } else {
      /* ★ 只说「会输」，**不点名换哪两张**。
       *
       * 之前这里写的是「换 8♠ + 2♦ 能到 10」—— 而 best 是全手牌里点数最大的那个不爆组合，
       * 等于每局都由程序宣布最优解。第一轮三组互相抢牌，手里往往有好几组都能不爆，
       * 挑哪一组是玩家的策略（把那张 10 让给飘三叶凑豹子，十点半退到 9 点也可能是对的）。
       * 现在只回答两件事：这组会输、手里还有不爆的组合 —— 剩下的他自己算。
       *
       * 「还有救」这一句仍然保留，因为「爆了就必输」和「爆了但能救」是两种处境，
       * 不说清楚他会以为已经没救了，直接放弃这一组。 */
      msg = '十点半爆了（' + fmtTenths(adv.points) + ' 点）· 这组会输，手里有不爆的组合';
    }
    flash(msg, 'warn');
    Sfx.play('error');
    nudgeTenHalf();
  }

  /*
   * 落牌：把一张手牌放进某组。
   * 组满了不报错，自动顺延到下一个没填满的组（连点时不用回头改目标）；
   * 全满才失败——不能让界面出现「点了没反应」。
   * 先量坐标、再改数据、再 render、最后飞牌：render 之后槽位已经重排，量不到原来的位置。
   */
  function placeCardTo(cid, preferKey, strict) {
    var room = state.room, me = getMe(room);
    if (!room || !me) return;
    var round = room.round;
    if (!canEdit(room, me, round)) return;
    var card = cardFromId(room, cid);
    if (!card) return;

    // 拖到一个已经满的组：明确拒绝，不要"顺手"放到别组——手上明明指着这一组
    if (strict && preferKey && (state.groups[preferKey] || []).length >= StateMachine.GROUP_COUNT[preferKey]) {
      flash('这组已经满了');
      Sfx.play('error');
      return;
    }

    var srcEl = $('#hand [data-card-id="' + cid + '"]');
    var source = srcEl ? stageCoords(srcEl) : null;

    var res = StateMachine.placeCard(round, state.groups, card, preferKey);
    if (!res.ok) {
      flash(res.error || '放不进去了');
      Sfx.play('error');
      return;
    }

    var slot = document.querySelector('#slots .slot[data-game="' + res.key + '"]');
    var empties = slot ? slot.querySelectorAll('.card-box.empty') : [];
    var target = empties.length ? stageCoords(empties[0]) : null;

    // 只有「当前组满了」才自动跳到下一个空位组；没满就钉住，
    // 这样第二轮点「斗牛」会一直往斗牛里放，直到凑满 5 张为止。
    var resList = state.groups[res.key] || [];
    if (resList.length >= StateMachine.GROUP_COUNT[res.key]) {
      var next = StateMachine.nextOpenGroup(round, state.groups, res.key);
      state.activeGroup = next || res.key;
    } else {
      state.activeGroup = res.key;
    }

    Sfx.play('deal', 1.03); // 入槽 +3% 变调
    render();

    /* 第一轮放下这张之后立刻按「十点半优先」检查一次。
     * 放在 render 之后：玩家要先看到牌落进去，再被告知这组爆了；
     * 顺序反过来像「牌没放下就报错」。
     * 传整手牌，让状态机自己剔掉已放入的那张（见 tenHalfAdvice 的注释）。 */
    if (round === 1) {
      var adv = StateMachine.tenHalfAdvice(round, state.groups, me.hand);
      if (adv) warnTenHalf(adv);
    }
    // 飞过去的牌要和落点那张一样大：矮屏上槽内的牌已经缩到 ~115 宽，
    // 还按 144 飞就会先大后小地「跳」一下
    var flySize = slotCardSize(StateMachine.GROUP_COUNT[res.key] || 1);
    if (source && target) flyCard(source, target, card, flySize.w, flySize.h, 0);
  }

  function onHandCardTap(cid) {
    // 拖拽松手后浏览器还会补一个 click，别当成第二次点击
    if (state.suppressTap) { state.suppressTap = false; return; }
    var room = state.room, me = getMe(room);
    if (!me || me.left) return;
    if (!canEdit(room, me, room.round)) return;
    placeCardTo(cid, state.activeGroup);
  }

  /* 点组里的空位 = 把这一组设为「当前组」，之后点手牌就往这里放 */
  function onSlotTap(key) {
    var room = state.room, me = getMe(room);
    if (!me || me.left) return;
    var round = room.round;
    if (!canEdit(room, me, round)) return;
    if (state.activeGroup === key) {
      flash('已经是这一组了，点手牌就放进来');
    } else {
      state.activeGroup = key;
      Sfx.play('select');
    }
    render();
  }

  /* ---------------------------- 交互：拖拽上牌 ----------------------------
   * 点标签/点手牌已经能完整走完流程；拖拽是给习惯"甩牌"的人的第二条路。
   * 用 pointer 事件（鼠标/触摸一套代码），阈值 10px 才算拖——
   * 否则一次轻点会被判定成"拖到原地"，反而放不进去。 */
  var dragState = null;

  function dragThreshold() { return 10; }

  function stageScale() {
    var stage = $('#stage');
    if (!stage) return 1;
    var cs = getComputedStyle(stage);
    var m = cs.transform;
    /* 'none' 是**正常可能**的取值（--pt-scale 还没被 JS 写进去的那一瞬间），
     * 但 new DOMMatrix('none') 会抛 SyntaxError。所以先判掉，再交给 try 兜住老内核。 */
    if (!m || m === 'none') return 1;
    try { return new DOMMatrix(m).a || 1; } catch (e) { return 1; }
  }

  /* 焦点是不是落在一个「会唤出软键盘」的控件上。
   *
   * 只给 resize() 用：键盘弹起会把布局视口压掉一半，那是真的变小了，
   * 但「要不要切紧凑版式」是个跟屏幕大小无关的纯视觉决定，不该跟着键盘抖动。
   *
   * contenteditable 也算：以后要是把昵称输入改成富文本那一类，这里不用再改。
   * 用 tagName 大写比较而不是 `instanceof`：跨 iframe / 老 WebView 都更稳。 */
  function isTypingTarget(node) {
    if (!node || !node.tagName) return false;
    var tag = node.tagName.toUpperCase();
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') {
      /* 按钮型的 input 不会唤出键盘，别把它们算进来 */
      var t = String(node.type || 'text').toLowerCase();
      return t !== 'button' && t !== 'submit' && t !== 'reset' && t !== 'checkbox' && t !== 'radio'
        && t !== 'range' && t !== 'color' && t !== 'file';
    }
    return node.isContentEditable === true;
  }

  /*
   * 拖拽入口现在同时认手牌和槽里的牌：
   * - 手牌 .card-wrap（from:'hand'）拖到某组=入组，拖回手牌区=原地不动
   * - 槽牌 .card-box[data-card-id]（from:'slot'）拖到别的组=换组，拖回手牌区=收回
   */
  function onHandPointerDown(e) {
    if (e.button != null && e.button !== 0) return;   // 只认左键/单指
    var room = state.room;
    var me = room ? getMe(room) : null;
    if (!room || !me || me.left) return;
    if (!canEdit(room, me, room.round)) return;
    var t = e.target && e.target.closest ? e.target : null;
    var wrap = t ? t.closest('#hand .card-wrap') : null;
    var from = 'hand', fromKey = null;
    if (!wrap || !wrap.dataset.cardId) {
      var box = t ? t.closest('#slots .card-box[data-card-id]') : null;
      if (!box || !box.dataset.cardId) return;
      wrap = box;
      from = 'slot';
      fromKey = box.dataset.group || null;
    }
    dragState = {
      cid: wrap.dataset.cardId,
      wrap: wrap,
      from: from,
      fromKey: fromKey,
      x0: e.clientX,
      y0: e.clientY,
      x: e.clientX,
      y: e.clientY,
      ghost: null,
      overCard: null,     // 落点若是另一张牌，记那个元素（一对一交换）
      slotKey: null,
      overHand: false,
      moved: false
    };
  }

  function onHandPointerMove(e) {
    if (!dragState) return;
    dragState.x = e.clientX;
    dragState.y = e.clientY;
    if (!dragState.moved) {
      var dx = e.clientX - dragState.x0;
      var dy = e.clientY - dragState.y0;
      if (dx * dx + dy * dy < dragThreshold() * dragThreshold()) return;
      startDrag();
    }
    if (e.cancelable) e.preventDefault();
    moveGhost();
    highlightDropTarget();
  }

  function startDrag() {
    var d = dragState;
    var card = cardFromId(state.room, d.cid);
    if (!card) { dragState = null; return; }
    d.moved = true;
    var scale = stageScale();
    var isSlot = d.from === 'slot';
    /* 槽内的牌按当前预算渲染，未必是 144×202；幽灵牌要跟手上那张一模一样，
     * 否则一拖起来尺寸就跳。直接量源节点最准，也自动跟着以后任何尺寸改动走。 */
    var gw = isSlot ? (d.wrap.offsetWidth || SLOT_CARD_W) : HAND_CARD_W;
    var gh = isSlot ? (d.wrap.offsetHeight || SLOT_CARD_H) : HAND_CARD_H;
    var ghost = document.createElement('img');
    ghost.className = 'card drag-ghost';
    ghost.src = getCardImg(card, gw, gh);
    ghost.style.width = Math.round(gw * scale) + 'px';
    ghost.style.height = Math.round(gh * scale) + 'px';
    ghost.draggable = false;
    document.body.appendChild(ghost);
    d.ghost = ghost;
    d.wrap.classList.add('is-dragging');
    document.body.classList.add('is-dragging');
    Sfx.play('select', 1.02);
    moveGhost();
  }

  function moveGhost() {
    var d = dragState;
    if (!d || !d.ghost) return;
    d.ghost.style.left = d.x + 'px';
    d.ghost.style.top = d.y + 'px';
  }

  function clearDropHighlight() {
    /* 两种落点反馈一起清：整组接收（.slot.drop-hover）与一对一替换（.card-box.drop-swap）。
     * 用一个选择器捞两家，省得以后再加一种又漏掉一处。 */
    var marked = document.querySelectorAll('#slots .slot.drop-hover, #slots .card-box.drop-swap');
    for (var i = 0; i < marked.length; i++) {
      marked[i].classList.remove('drop-hover');
      marked[i].classList.remove('drop-swap');
    }
    var hand = $('#hand');
    if (hand) hand.classList.remove('drop-hover');
  }

  /* 手指下面是什么落点：某一张牌（交换）、某个组（换组/入组）、还是手牌区（收回）。
   * 用 elementFromPoint 而不是 mouseover，因为幽灵牌 pointer-events:none，
   * 被拖着的牌本身不会遮挡判定。
   *
   * ★ 必须先判「牌」再判「组」：槽牌本身就住在组里，组的矩形把牌整个包住，
   *   判反了「落到某张牌上」永远会被解析成「落到这个组」，交换就永远触发不了。 */
  function highlightDropTarget() {
    var d = dragState;
    if (!d) return;
    var under = document.elementFromPoint(d.x, d.y);
    if (!under) return;

    var box = under.closest ? under.closest('#slots .card-box[data-card-id]') : null;
    var overCard = (box && box.dataset.cardId !== d.cid) ? box : null;
    /* 同一组的牌之间不换：组内顺序不参与任何结算（比的是牌型，与排列无关），
     * 换了等于没换。亮起一张牌再答应「换好了」，是在骗人。 */
    if (overCard && d.from === 'slot' && box.dataset.group === d.fromKey) overCard = null;

    var slot = under.closest ? under.closest('#slots .slot') : null;
    var key = slot ? slot.dataset.game : null;

    // 落到另一张牌上 = 一对一交换，不再当成「换组」
    if (overCard) key = null;
    // 拖槽牌时：落点是它自己所在的组（且没落在别的牌上）等于没移动，不亮
    else if (d.from === 'slot' && key === d.fromKey) key = null;

    var overHand = !!(under.closest && under.closest('#hand'));
    // 拖槽牌回手牌区=收回；拖手牌时手牌区不是落点（原地），不亮
    if (d.from !== 'slot') overHand = false;

    if (overCard !== d.overCard || key !== d.slotKey || overHand !== d.overHand) {
      clearDropHighlight();
      if (overCard) overCard.classList.add('drop-swap');
      if (key) slot.classList.add('drop-hover');
      if (overHand) { var h = $('#hand'); if (h) h.classList.add('drop-hover'); }
      d.overCard = overCard;
      d.slotKey = key;
      d.overHand = overHand;
    }
  }

  function endDrag(commit) {
    var d = dragState;
    dragState = null;
    if (!d || !d.moved) return;                 // 没移动过 = 普通点击，交给 click 处理
    if (d.ghost && d.ghost.parentNode) d.ghost.parentNode.removeChild(d.ghost);
    if (d.wrap) d.wrap.classList.remove('is-dragging');
    document.body.classList.remove('is-dragging');
    clearDropHighlight();
    // 松手后浏览器还会补发一次 click，这里压掉，否则会「拖一张、又多放一张」
    state.suppressTap = true;
    setTimeout(function () { state.suppressTap = false; }, 400);

    if (!commit) return;

    // 拖槽牌回手牌区 = 收回手牌
    if (d.overHand && d.from === 'slot') {
      removeCardFromSlots(d.fromKey, d.cid);
      return;
    }
    /* 落到另一张牌上 = 两张互换位置（v105）。
     * 必须排在「换组」之前：落到牌上时 d.slotKey 已经被显式置成 null，
     * 漏了这一条就会掉进下面那句 return，表现成「拖过去没反应」。 */
    if (d.overCard && d.overCard.dataset) {
      swapByDrag(d.cid, d.from, d.overCard.dataset.cardId);
      return;
    }
    if (!d.slotKey) return;

    // 槽牌拖到另一个组 = 换组（先取回再落）；手牌拖到组 = 入组
    if (d.from === 'slot' && d.fromKey && d.fromKey !== d.slotKey) {
      moveSlotCard(d.fromKey, d.cid, d.slotKey);
      return;
    }
    placeCardTo(d.cid, d.slotKey, true);
  }

  function onHandPointerUp() { endDrag(true); }
  function onHandPointerCancel() { endDrag(false); }

  /* 点标签切组（和点槽位空位等价，但标签永远在拇指区） */
  function setActiveGroup(key) {
    if (!key || state.activeGroup === key) return;
    state.activeGroup = key;
    Sfx.play('select');
    render();
  }

  /* 把某张槽牌收回手牌（点一下 or 拖回手牌区，同一个出口） */
  function removeCardFromSlots(key, cid) {
    var room = state.room, me = getMe(room);
    if (!room || !me || me.left) return;
    var round = room.round;
    if (!canEdit(room, me, round)) return;
    var card = cardFromId(room, cid);
    if (!card) return;
    if (!StateMachine.removeCard(round, state.groups, card).ok) return;

    // 捕获起点（槽内牌位）
    var slot = document.querySelector('#slots .slot[data-game="' + key + '"]');
    var source = null;
    if (slot) {
      var srcEl = slot.querySelector('[data-card-id="' + cid + '"]');
      if (srcEl) source = stageCoords(srcEl);
    }

    // 取回后把当前组切到这一组：接着点手牌就能原地补一张
    state.activeGroup = key;
    Sfx.play('deal', 0.97); // 撤牌 -3% 变调
    render();

    // 牌飞回手牌原位（ghost 克隆，0.3s 镜像）
    if (source) {
      var hand = $('#hand');
      var dstEl = hand.querySelector('[data-card-id="' + cid + '"]');
      if (dstEl) flyCard(source, stageCoords(dstEl), card, HAND_CARD_W, HAND_CARD_H, 0);
    }
  }

  /* 槽牌拖到另一个组：先取回、再落进目标组，避免同一张牌出现在两个组 */
  function moveSlotCard(fromKey, cid, toKey) {
    var room = state.room, me = getMe(room);
    if (!room || !me || me.left) return;
    var round = room.round;
    if (!canEdit(room, me, round)) return;
    var card = cardFromId(room, cid);
    if (!card) return;

    // 目标组满了：明确拒绝（和手牌拖到满组的语义一致）
    if ((state.groups[toKey] || []).length >= StateMachine.GROUP_COUNT[toKey]) {
      flash('这组已经满了');
      Sfx.play('error');
      return;
    }

    if (!StateMachine.removeCard(round, state.groups, card).ok) return;
    var res = StateMachine.placeCard(round, state.groups, card, toKey);
    if (!res.ok) {
      // 回滚：placeCard 失败就把牌放回原组，不能让牌凭空消失
      StateMachine.placeCard(round, state.groups, card, fromKey);
      flash(res.error || '放不进去了');
      Sfx.play('error');
      return;
    }

    state.activeGroup = toKey;
    Sfx.play('deal', 1.03);
    render();
  }

  /*
   * 一次拖拽换两张牌的位置（v105）。
   *
   * 为什么必须有这条路：六张牌全部入组之后三组都是满的，没有任何空位。
   * 想调整「哪张进单张、哪张进飘三叶」只能走
   * 「收回一张到手牌 → 把另一张挪进空出来的位 → 再把手里那张放回最后一个空位」，
   * 三步，而且中间那步牌区会出现一个肉眼可见的空洞。
   *
   * 两种情形共用一个出口：
   *   slot → slot  真正互换（两组张数一进一出，交换前后相等，不需要容量校验）
   *   hand → slot  手牌这张顶掉槽里那张，被顶掉的回到手牌
   * 同组内交换在落点判定阶段就被挡掉了（组内顺序不参与结算），所以这里不会收到。
   */
  function swapByDrag(cidA, fromA, cidB) {
    var room = state.room, me = getMe(room);
    if (!room || !me || me.left) return;
    var round = room.round;
    if (!canEdit(room, me, round)) return;
    var a = cardFromId(room, cidA);
    var b = cardFromId(room, cidB);
    if (!a || !b) return;

    var targetKey = null;

    if (fromA === 'slot') {
      var r = StateMachine.swapCards(round, state.groups, a, b);
      if (!r.ok) { flash(r.error || '换不了'); Sfx.play('error'); return; }
      targetKey = r.to;                  // 我被放进了落点牌原来那一组
    } else {
      /* 手牌 → 槽：先记下落点牌在哪个组的第几位，再把它取回，
       * 手牌这张补进同一组。placeCard 会追加到组末尾 —— 组内顺序不影响结算，不必保位。 */
      var keys = StateMachine.ROUND_GROUPS[round] || [];
      var at = StateMachine.locateCard(state.groups, keys, b);
      if (!at) return;
      targetKey = at.key;
      if (!StateMachine.removeCard(round, state.groups, b).ok) return;
      var res = StateMachine.placeCard(round, state.groups, a, targetKey);
      if (!res.ok) {
        // 回滚：手牌那张没放进去，就把被顶掉的放回原组，不能让一张牌凭空消失
        StateMachine.placeCard(round, state.groups, b, targetKey);
        flash(res.error || '换不了');
        Sfx.play('error');
        return;
      }
    }

    state.activeGroup = targetKey;
    Sfx.play('select', 1.06);   // 交换比入组轻，不抢发牌音的戏
    render();
  }

  function onSlotCardTap(key, card) {
    removeCardFromSlots(key, card.suit + '-' + card.rank);
  }

  async function onSubmit() {
    var room = state.room, me = getMe(room);
    if (!me || me.left) return;
    var round = room.round;
    if (!canEdit(room, me, round)) return;
    var groups = getCurrentGroups(room, me);
    var keys = StateMachine.ROUND_GROUPS[round];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if ((groups[k] || []).length !== StateMachine.GROUP_COUNT[k]) {
        flash('每组必须填满指定张数'); Sfx.play('error'); return;
      }
    }

    /* ★ 爆点**拦截**，不是第二遍提醒。
     *
     * 用户 2026-10-30：「现在只是硬凑爆点牌会提示，但是提交还是可以正常提交，这不对，
     * 应该阻止提交」。放牌那一刻的 toast 是劝，这里是门 —— 到这一步已经没机会再调了。
     *
     * 只在「手里还有不爆的打法」时拦（tenHalfAdvice 返回 kind:'bust' 就是这个意思）：
     * 整手怎么配都爆的局面它返回 null，一个字都不说、也照常放行 ——
     * 那种时候挡住他，等于逼他改一个改不出更好结果的方案（用户 2026-10-30 早先口径）。
     *
     * 判据放在 StateMachine 而不是这里：王（joker）要先解析成某张牌再算点数，
     * 那套解析只有 engine 有一份，界面再写一遍必然和结算跑偏。
     */
    if (round === 1) {
      var bustAdv = StateMachine.tenHalfAdvice(1, groups, me.hand);
      if (bustAdv && bustAdv.kind === 'bust') { blockBustSubmit(bustAdv); return; }
    }

    /* 提交不可撤销地决定这一轮分数，先让玩家核对一遍。
     * 爆点已经在上一步被拦住了，所以这里的确认框只剩「三组填了什么」。 */
    var revising = state.reviseRound === round;
    askConfirm(
      revising ? '确认重新提交？' : '确认提交分组？',
      groupsSummary(round, groups) + (revising ? '\n\n修改机会只有一次。' : ''),
      function () { doSubmit(room, groups, revising); }
    );
  }

  /* 抖一下十点半那一组：连点两次也要有反馈，所以先摘再加强制重排（不然动画不重放）。 */
  function nudgeTenHalf() {
    var slot = document.querySelector('#slots .slot[data-game="tenhalf"]');
    if (!slot) return;
    slot.classList.remove('nudge');
    void slot.offsetWidth;
    slot.classList.add('nudge');
  }

  /* 爆点拦截弹窗：只有一个「去改」，**没有**「就这样提交」。
   *
   * 为什么不留后路：「能不爆就不许爆」是第一轮的规则（第 30 章），不是建议。
   * 留一个「坚持提交」等于把规则降级成提示 —— 而「提示归提示、照样能提交」
   * 正是用户 2026-10-30 要我改掉的那个问题。
   *
   * 顺手把当前组切回十点半：弹窗说的是这一组，合上之后要能立刻动手改。
   * render() 要放在 showModalEl 之前 —— 它会重建槽位，先弹框再渲染会把
   * 刚挂上的 nudge 动画和「当前组」高亮一起冲掉。 */
  function blockBustSubmit(adv) {
    state.activeGroup = 'tenhalf';
    /* 不弹 toast：弹窗已经把话说完了，再来一条同义提示只会在横屏上贴着弹窗底部
     * 叠成一团（844×390 实测）。声音和槽位抖动负责「你被拦了」这层即时反馈，
     * 放牌那一次的 toast 也顺手收起来 —— 它说的是同一件事。 */
    Sfx.play('error');
    hideToast();
    render();
    /* 标题已经说了「十点半爆了」，正文不再重复那半句 —— 只补点数、后果、该怎么办。 */
    $('#bust-desc').textContent = '这组 ' + fmtTenths(adv.points) + ' 点，会输。'
      + '手里还有不爆的组合，换掉一张再提交。';
    showModalEl('bust-modal');
    pushModalState();
    nudgeTenHalf();
  }

  async function doSubmit(room, groups, revising) {
    if (blockedOffline()) return;
    var restore = pressBusy($('#btn-submit'), '提交中…');
    if (!restore) return;
    try {
      var res = await RoomStore.submitGroups(room.roomId, state.myId, groups);
      if (!res || !res.ok) {
        flash((res && res.error) || '提交失败');
        Sfx.play('error');
        render();
        return;
      }
      state.reviseRound = -1;
      Sfx.play('submit');
      // 状态经 subscribe 回调已更新，再渲染一次兜底
      render();
    } catch (e) {
      flash('网络不太稳，再提交一次');
      Sfx.play('error');
    } finally {
      /* 顺序不能反：pressBusy 的 restore() 会把 disabled 打回「点下去那一刻的值」。
       * 先 render 再 restore，屏幕上就会留下一个写着「已提交」却还能按的按钮
       * （按下去被 canEdit 拦住，什么都不会发生，所以很难被发现）。
       * 先还按钮、再渲染，让 render 的写入永远是最后一句。 */
      restore();
      render();
    }
  }

  /* ---------------------------- 结算（settleView.js） ----------------------------
   * 牌型特写幕 / 结果轮播 / 结算页 已拆到 js/settleView.js（755 行）。
   * 注入项里 render / avatarInner 是本文件的 function 声明（提升），
   * 且模块在原位置创建 —— 前面所有 var 已初始化，两头都安全。 */
  var Settle = window.LXW.settleView({
    state: state,
    BIG_FX: BIG_FX, BIG_TYPES: BIG_TYPES,
    cardImgHtml: cardImgHtml, cardImgEl: cardImgEl, miniCardsEl: miniCardsEl,
    SLOT_BADGE: SLOT_BADGE, SLOT_COLOR: SLOT_COLOR, SLOT_SHORT_LABEL: SLOT_SHORT_LABEL,
    /* ★ 下面 5 个必须包一层，不能直接写 `showModalEl: showModalEl`。
     *   它们的赋值（modalKit / historyKit 的解构）在本行**之后**，而 `var` 不提升值：
     *   直接传引用 = 把那一刻的 undefined 传进去，之后外面再怎么赋值也改不到模块里
     *   （模块开头就把 deps.x 存成了局部变量）。后果不是报错，是静默失效 ——
     *   结算页的分享 / 上一把弹窗打不开、滚动渐隐不生效、有没有机器人判错。
     *   包一层就变成「调用时才去看」，参数透传、返回值透传。
     *   只对**函数**有用；常量（BIG_FX 这类）没法这么救，只能靠把创建点排在赋值之后。 */
    bindScrollFadeOnce: function () { return bindScrollFadeOnce.apply(null, arguments); },
    syncScrollFade: function () { return syncScrollFade.apply(null, arguments); },
    showModalEl: function () { return showModalEl.apply(null, arguments); },
    hideModalEl: function () { return hideModalEl.apply(null, arguments); },
    roomHasBot: function () { return roomHasBot.apply(null, arguments); },
    render: render, avatarInner: avatarInner,
    findPlayer: findPlayer
  });
  var PAT_FX_MS = Settle.PAT_FX_MS, pat = Settle.pat, patPtColor = Settle.patPtColor;
  var patTrio = Settle.patTrio, patternFxFlag = Settle.patternFxFlag, patLabel = Settle.patLabel;
  var buildPatternFx = Settle.buildPatternFx, playPatternFx = Settle.playPatternFx, endPatternFx = Settle.endPatternFx;
  var stopPatternFx = Settle.stopPatternFx, resultGroupCard = Settle.resultGroupCard, SEQ_HOLD = Settle.SEQ_HOLD;
  var seq = Settle.seq, seqHold = Settle.seqHold, stopResultSeq = Settle.stopResultSeq;
  var closeBreakCard = Settle.closeBreakCard, playResult = Settle.playResult, seqSecs = Settle.seqSecs;
  var seqLastText = Settle.seqLastText, renderResultStep = Settle.renderResultStep, advanceResult = Settle.advanceResult;
  var finishResultSeq = Settle.finishResultSeq, roundNet = Settle.roundNet, maybeBreakCard = Settle.maybeBreakCard;
  var settleRank = Settle.settleRank, settleListEl = Settle.settleListEl, settleReasonText = Settle.settleReasonText;
  var settleTipText = Settle.settleTipText, renderSettle = Settle.renderSettle, openPrevResult = Settle.openPrevResult;
  var closePrevResult = Settle.closePrevResult;


  /* ---------------------------- 历史与战绩数据成形（historyKit.js） ----------------------------
   * live 房间 → 存档 → 本机记录 的纯数据转换已拆到 js/historyKit.js（一行 DOM 都不碰）。
   * 注入的四个都是本文件的 function 声明（提升），可以直接传引用。 */
  var History = window.LXW.historyKit({
    state: state,
    getMe: getMe,
    /* ★ getter，不是直接传引用：recordsPid 现在住在 recordsView 里，而 recordsView
     * 又依赖这里的 packHistory —— 两个模块互相需要。直接传值的话，创建本模块那一刻
     * recordsPid 还是 undefined（var 不提升值），传进去就是个死值，
     * 结算写本机战绩时「归属哪个账号」会永远是 undefined。 */
    recordsPid: function () { return recordsPid(); },
    flash: flash
  });
  var endedAtOf = History.endedAtOf, endReasonOf = History.endReasonOf;
  var slimRound = History.slimRound, packHistory = History.packHistory;
  var absorbHistory = History.absorbHistory, slimReplay = History.slimReplay;
  var roomHasBot = History.roomHasBot, recordSettled = History.recordSettled;
  var noticeRecordsWrite = History.noticeRecordsWrite;

  /* ---- 战绩数据源与战绩页渲染 → js/recordsView.js ---- */

  /* ---------------------------- 账号与设置（accountView.js） ----------------------------
   * 登录 / 注册 / 账号卡 / 改密码 / 头像 / 改名 / 注销已拆到 js/accountView.js。
   *
   * ★ 模块**在这个位置创建**（而不是像 utils 那样放文件顶部）：
   *   注入项里 LS_NICK 是 var 定义的常量，var 不提升值 —— 放在顶部创建时它还是
   *   undefined，传进去就是个死值。在原位置创建则前面所有 var 都已初始化、
   *   后面所有 function 又都被提升，两头都安全。 */
  var Account = window.LXW.accountView({
    LS_NICK: LS_NICK,
    state: state,
    flash: flash, showScreen: showScreen, renderRoom: renderRoom,
    getMe: getMe, getMyId: getMyId, setNickname: setNickname,
    recordsPid: function () { return recordsPid.apply(null, arguments); },
    cleanupRoom: cleanupRoom,
    handleInvite: handleInvite, readInviteRoom: readInviteRoom,
    tryResumeRoom: tryResumeRoom, blockedOffline: blockedOffline,
    /* ★ 同上：这四个的赋值在本行之后（modalKit / recordsView 的解构），
     *   直接传会得到 undefined。原因与后果见 settleView 创建处那段注释。 */
    showModalEl: function () { return showModalEl.apply(null, arguments); },
    hideModalEl: function () { return hideModalEl.apply(null, arguments); },
    pushModalState: function () { return pushModalState.apply(null, arguments); },
    askConfirm: askConfirm
  });
  var setAuthMode = Account.setAuthMode, showAuthError = Account.showAuthError, hideAuthError = Account.hideAuthError;
  var gotoAuth = Account.gotoAuth, enterApp = Account.enterApp, submitAuth = Account.submitAuth;
  var fmtJoin = Account.fmtJoin, fillAccountInfo = Account.fillAccountInfo, openAccount = Account.openAccount;
  var closeAccount = Account.closeAccount, openPwdModal = Account.openPwdModal, closePwdModal = Account.closePwdModal;
  var avatarUploadFlag = Account.avatarUploadFlag, myAvatarId = Account.myAvatarId, renderAvatarGrid = Account.renderAvatarGrid;
  var openAvatarModal = Account.openAvatarModal, closeAvatarModal = Account.closeAvatarModal, pickAvatar = Account.pickAvatar;
  var loadImage = Account.loadImage, compressAvatar = Account.compressAvatar, pickAvatarPhoto = Account.pickAvatarPhoto;
  var dropAvatarPhoto = Account.dropAvatarPhoto, syncLocalAvatar = Account.syncLocalAvatar, submitPwd = Account.submitPwd;
  var onLogout = Account.onLogout, leaveAccountState = Account.leaveAccountState, onDeleteAccount = Account.onDeleteAccount;
  var openRename = Account.openRename, closeRename = Account.closeRename, onRenameOk = Account.onRenameOk;


  /* ---- 战绩页 / 档案卡 / 回放 / 排行 / 分享 → js/recordsView.js ----
   * 创建点不在这里：本段依赖 modalKit 的 showModalEl / isShown 等，
   * 那些是 var（不提升值），必须等它们初始化完才能创建模块。
   * 创建语句见下方「弹窗机制」之后。 */

  /* ---------------------------- 解散投票弹窗 ---------------------------- */
  function renderDissolve(room) {
    var d = room.dissolve;
    var active = !!(d && d.active);
    if (active) {
      var initiator = findPlayer(room, d.initiatorId);
      var initiatorName = initiator ? initiator.nickname : '有人';
      // 票数分母只算有效投票人（真人 + 在线），AI 不投票，
      // 用它算分母会显示「1/3」这种永远凑不齐的进度。
      var voters = StateMachine.dissolveVoters(room);
      var voted = 0;
      voters.forEach(function (p) { if (d.votes[p.id] === true) voted++; });
      var isInitiator = d.initiatorId === state.myId;
      $('#dissolve-title').textContent = isInitiator ? '你提请结束本局' : '有人提请结束本局';
      /* 说清三件事，而且要分两种情形说 —— 玩家点「同意」之前最想知道的
       * 就是「我这一局算不算数」：
       *   已经打过分  → 按当前分数结账，照常计入战绩（分是真打出来的，不能赖）
       *   一分没打    → 不计入战绩，房间保留、还能开下一局
       * 再加一句超时兜底，免得有人在等一个永远不来的同意。 */
      /* ★ 判据换成 anyScoreChange（服务端在每一次真正加减分时置位），
       * 不再拿「分数是否都等于基准分」当代理。
       *
       * 那个代理本来就是错的：赢一把再输一把，净胜回到 0，就会被告知「这一局一分还没打」。
       * 基准是 20 时它错得比较隐蔽（要正好回到 20），v105 把基准改成 0 之后
       * 0 成了每天都会路过的值，这个错会被经常撞上。
       * 换成真正的判据不带任何额外成本 —— 字段本来就在 room 里随广播下发。 */
      var played = !!room.anyScoreChange;
      var tail = played
        ? '。同意后本局立即结束，按当前分数结账，照常计入战绩。'
        : '。这一局一分还没打，结束后不计入战绩，房间保留、还能开下一局。';
      tail += '30 秒内未全员同意会自动取消。';
      if (isInitiator) {
        // 发起者本人已默认同意，不弹投票按钮，但给一个「取消」出口
        $('#dissolve-desc').textContent = '等待其他玩家同意…（' + voted + '/' + voters.length + '）' + tail;
        $('#btn-dissolve-agree').classList.add('hidden');
        $('#btn-dissolve-reject').classList.add('hidden');
        $('#btn-dissolve-cancel').classList.remove('hidden');
      } else {
        $('#dissolve-desc').textContent = '发起人：' + initiatorName
          + '，等待全员同意（' + voted + '/' + voters.length + '）' + tail;
        $('#btn-dissolve-agree').classList.remove('hidden');
        $('#btn-dissolve-reject').classList.remove('hidden');
        $('#btn-dissolve-cancel').classList.add('hidden');
      }
      showModalEl('dissolve-modal');
    } else {
      // 投票已结束：若此前处于投票中且当前未结账，说明被否决/取消/超时。
      // 三种原因在界面上要分开说 —— 以前一律「解散被否决」，超时也这么提示。
      if (state.dissolveWasActive && room.phase !== StateMachine.PHASE.SETTLED) {
        var why = d && d.lastReason;
        flash(why === 'expired' ? '结束本局的提议超时，已自动取消'
          : why === 'cancelled' ? '发起人撤回了'
          : '有人拒绝，本局继续');
      }
      hideModalEl('dissolve-modal');
    }
    state.dissolveWasActive = active;
  }

  /* ---------------------------- 通用确认弹窗 ---------------------------- */
  var confirmOnOk = null;
  var confirmNeedSecret = false;   // 这次确认是否要求先输密码（删号）

  function closeConfirm() {
    hideModalEl('confirm-modal');
    var sec = $('#confirm-secret');
    if (sec) { sec.value = ''; sec.classList.add('hidden'); }
    confirmNeedSecret = false;
    confirmOnOk = null;
  }

  var confirmBusy = false;
  var confirmBusyText = '处理中…';

  function askConfirm(title, desc, onOk, opts) {
    $('#confirm-title').textContent = title;
    $('#confirm-desc').textContent = desc;
    confirmOnOk = onOk;
    confirmBusyText = (opts && opts.busyText) || '处理中…';
    /* 敏感操作（删号）要先输密码：直接在确认框里给一个输入框，
     * 比再弹一层 prompt 好——prompt 在手机上会被键盘顶掉，而且密码是明文显示。 */
    var sec = $('#confirm-secret');
    confirmNeedSecret = !!(opts && opts.secret);
    if (sec) {
      sec.value = '';
      sec.classList.toggle('hidden', !confirmNeedSecret);
      /* 要输密码时把默认焦点钉在密码框上（data-autofocus 优先于「第一个可聚焦元素」）；
       * 不需要密码时去掉它，焦点回到「取消」—— 这个框里可能挂着删号，别让回车落在「确定」上。 */
      if (confirmNeedSecret) sec.setAttribute('data-autofocus', '');
      else sec.removeAttribute('data-autofocus');
      if (confirmNeedSecret) setTimeout(function () { try { sec.focus(); } catch (e) {} }, 30);
    }
    showModalEl('confirm-modal');
    pushModalState();
  }

  /* 确认框以前是「点一下就先关掉，再执行回调」。删账号这种要发网络请求的操作，
   * 于是变成：弹窗立刻消失、慢网下十几秒没有任何反馈，人只会以为没点上并反复点。
   * 现在改成等回调真的跑完再关，期间按钮置灰并显示进行中的文案。 */
  async function onConfirmOk() {
    var btn = $('#btn-confirm-ok');
    var fn = confirmOnOk;
    if (!fn) { closeConfirm(); return; }
    if (confirmBusy) return;                 // 连点不再发第二次请求
    /* 要求输密码时先本地挡一道：空密码没必要发请求，也不用占登录失败额度。
     * 校验本身在服务端，这里只是省一次往返。 */
    var secret = '';
    if (confirmNeedSecret) {
      var sec = $('#confirm-secret');
      secret = sec ? String(sec.value || '') : '';
      if (!secret) {
        flash('请输入登录密码');
        if (sec) { try { sec.focus(); } catch (e) {} }
        return;
      }
    }
    confirmBusy = true;
    var oldText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = confirmBusyText; }
    try {
      await fn(secret);
    } catch (e) {
      /* 回调自己已经 toast 过；这里只保证弹窗不会卡在「处理中」 */
    } finally {
      confirmBusy = false;
      if (btn) { btn.disabled = false; btn.textContent = oldText; }
      closeConfirm();
    }
  }

  /* ---------------------------- 弹窗机制（modalKit.js） ----------------------------
   * 焦点进出 / Tab 圈定 / 返回键关闭已拆到 js/modalKit.js。
   * 同样是解构成同名局部变量，下面 500 多处调用点一个字都不用改。 */
  var Modal = window.LXW.modalKit;
  var MODAL_FOCUSABLE = Modal.MODAL_FOCUSABLE, MODAL_ORDER = Modal.MODAL_ORDER;
  var isShown = Modal.isShown, modalFocusables = Modal.modalFocusables, topModalId = Modal.topModalId;
  var focusEl = Modal.focusEl;
  var syncScrollFade = Modal.syncScrollFade, bindScrollFadeOnce = Modal.bindScrollFadeOnce;
  var syncModalScrollFade = Modal.syncModalScrollFade;
  var showModalEl = Modal.showModalEl, hideModalEl = Modal.hideModalEl;
  var pushModalState = Modal.pushModalState;

  /* ---------------------------- 战绩 / 档案 / 回放 / 排行（recordsView.js） ----------------------------
   * 1237 行已拆到 js/recordsView.js。**创建点必须在这里**，不在它原来待的位置：
   * 它要用 modalKit 的 showModalEl / hideModalEl / isShown / pushModalState，
   * 而那几个是 `var`（不提升值）—— 在原来那个位置（战绩页渲染处）创建时它们还是
   * undefined，于是所有弹窗开关都会静默失效（不报错，就是点了没反应）。
   *
   * 这也是本轮唯一一处「不能就地创建」的模块，原因写在 .tmp-deps.js 的依赖分析里：
   * 依赖项有定义行号，只要有一项在当前行之后且是 var，就得往后挪。 */
  var Records = window.LXW.recordsView({
    state: state,
    avatarInner: avatarInner, findPlayer: findPlayer,
    render: render, getMe: getMe, flash: flash, showScreen: showScreen,
    packHistory: packHistory,
    showModalEl: showModalEl, hideModalEl: hideModalEl,
    isShown: isShown, pushModalState: pushModalState
  });
  var END_REASON_TEXT = Records.END_REASON_TEXT, endReasonText = Records.endReasonText, renderTrend = Records.renderTrend;
  var renderRecordRows = Records.renderRecordRows, cloudRecords = Records.cloudRecords, cloudRecordsOk = Records.cloudRecordsOk;
  var cloudRecordsPid = Records.cloudRecordsPid, cloudRecordsErr = Records.cloudRecordsErr, cloudRecordsAt = Records.cloudRecordsAt;
  var cloudRecordsSeq = Records.cloudRecordsSeq, CLOUD_RECORDS_TTL = Records.CLOUD_RECORDS_TTL, EMPTY_STATS = Records.EMPTY_STATS;
  var recordsPid = Records.recordsPid, cloudRecordsReady = Records.cloudRecordsReady, cloudRecordsValid = Records.cloudRecordsValid;
  var cloudStats = Records.cloudStats, cloudRows = Records.cloudRows, loadCloudRecords = Records.loadCloudRecords;
  var renderRecords = Records.renderRecords, syncSumcolFade = Records.syncSumcolFade, profileSeq = Records.profileSeq;
  var playerNameOf = Records.playerNameOf, openProfile = Records.openProfile, closeProfile = Records.closeProfile;
  var renderProfileFail = Records.renderProfileFail, PF_EMPTY_SVG = Records.PF_EMPTY_SVG, profileBodyHtml = Records.profileBodyHtml;
  var renderProfileBody = Records.renderProfileBody, drawShareCard = Records.drawShareCard, onShare = Records.onShare;
  var handText = Records.handText, replayViews = Records.replayViews, renderReplay = Records.renderReplay;
  var replayTargetHand = Records.replayTargetHand, scrollReplayToTarget = Records.scrollReplayToTarget, setReplaySub = Records.setReplaySub;
  var replayPacksOf = Records.replayPacksOf, replayTargetOf = Records.replayTargetOf, openReplay = Records.openReplay;
  var openReplayHere = Records.openReplayHere, openSavedReplay = Records.openSavedReplay, closeReplay = Records.closeReplay;
  var closeShare = Records.closeShare, isIOS = Records.isIOS, isWeChat = Records.isWeChat;
  var supportsDownload = Records.supportsDownload, onShareSave = Records.onShareSave, openRank = Records.openRank;
  var closeRank = Records.closeRank, apiQuery = Records.apiQuery, renderRank = Records.renderRank;
  var purgeAskedAt = Records.purgeAskedAt, purgeInFlight = Records.purgeInFlight, replayReopen = Records.replayReopen;
  var replayOwners = Records.replayOwners, purgeDeletedIdentities = Records.purgeDeletedIdentities, openRecords = Records.openRecords;
  var closeRecords = Records.closeRecords, onCreateFromRecords = Records.onCreateFromRecords, openClearModal = Records.openClearModal;
  var closeClearModal = Records.closeClearModal, onClearConfirmed = Records.onClearConfirmed;

  /* ---------------------------- 声音开关 ---------------------------- */
  /* 首页角落和房间页各有一个图标，共用这一段逻辑；状态由 Sfx 存在 localStorage。
     **这是「声音」总开关，不是「背景音乐」开关**：早先只停 BGM，
     玩家进牌桌后发牌声/选牌声照旧响，于是报「关了还有声音」。 */
  function syncAudioToggles() {
    var on = !Sfx || typeof Sfx.isSoundEnabled !== 'function' ? true : Sfx.isSoundEnabled();
    var list = document.querySelectorAll('[data-audio-toggle]');
    for (var i = 0; i < list.length; i++) {
      var btn = list[i];
      btn.classList.toggle('is-off', !on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.setAttribute('aria-label', on ? '声音（开）' : '声音（关）');
      var son = btn.querySelector('.au-on');
      var soff = btn.querySelector('.au-off');
      if (son) son.classList.toggle('hidden', !on);
      if (soff) soff.classList.toggle('hidden', on);
    }
  }

  function onToggleAudio() {
    if (!Sfx || typeof Sfx.setSoundEnabled !== 'function') return;
    var on = Sfx.setSoundEnabled(!Sfx.isSoundEnabled());
    syncAudioToggles();
    flash(on ? '声音已开' : '声音已关');
  }

  /* ---------------------------- 弱网：断网提示 + 按钮忙碌态 ----------------------------
   * 以前这两个都没有：断网后界面毫无动静，玩家看到的就是"点了没反应"，
   * 于是连点四下，四个请求一起排队。现在：
   *   1. 断网立刻在顶部亮一条提示（navigator.onLine）
   *   2. 点击后按钮当场变"创建中…"并禁用，同一个按钮在跑完之前不再响应
   *   3. 网络明明断着就别发请求，直接告诉玩家，省掉 8 秒超时等待
   */
  function setNetBanner(online) {
    var b = $('#net-banner');
    if (!b) return;
    b.classList.toggle('hidden', online !== false);
  }

  function isOffline() {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  }

  /* 断网时直接拦下，别让玩家干等一个注定超时的请求 */
  function blockedOffline() {
    if (!isOffline()) return false;
    flash('现在没有网络，恢复后再试');
    Sfx.play('error');
    return true;
  }

  /*
   * 进入忙碌态。返回 restore 函数；如果这个按钮已经在跑（重复点击）返回 null。
   * 文案只在"没被别人改过"时还原——render() 可能已经把按钮改成新状态（准备/取消准备）。
   */
  function pressBusy(btn, label) {
    if (!btn) return function () {};
    if (btn.dataset.busy === '1') return null;
    btn.dataset.busy = '1';
    var prevDisabled = btn.disabled;
    var prevText = btn.textContent;
    btn.disabled = true;
    btn.classList.add('is-busy');
    btn.textContent = label;
    return function restore() {
      delete btn.dataset.busy;
      btn.classList.remove('is-busy');
      /* disabled **必须无条件还回去**：它没有人接管 —— render() 只写文案，从来不写 disabled。
       *
       * 原来这两行是绑在一起判断的（「文案被别人改了就整块不管」），
       * 结果是：请求在途的那几秒里只要来一次房间广播（别人准备 / 有人进房 / 自己这单的回包），
       * render() 就把「准备中…」改回「准备」，await 续上时文案已经不等于 label，
       * 还原被整块跳过 —— disabled 永久留在按钮上，看起来写着「准备」，其实点不动。
       * 真机上「他说准备不了」就是这个：弱网下 ready 请求 8 秒超时，这期间别人准备过。
       * 探针 scripts/probe-ready-button.js 在本地模式里每次点击都能复现。 */
      btn.disabled = prevDisabled;
      if (btn.textContent === label) btn.textContent = prevText;
    };
  }

  /* ---------------------------- 动作 ---------------------------- */
  function readNickname() {
    var v = $('#nickname-input').value.trim() || getNickname() || defaultNick();
    setNickname(v);
    return v;
  }

  /* ---------------------------- 邀请链接 ----------------------------
   * 目标：好友点开链接就能进房，不用再问「房间号多少」再手输 6 位。
   * 链接形如 ...?room=123456；打开后自动填号并直接尝试加入。 */
  function inviteLink(roomId) {
    try {
      var u = new URL(location.href);
      u.hash = '';
      // 关键：保留原有 query（如分享凭据 sharecode），只追加 room，
      // 否则好友点开链接会因缺少访问凭据被打回 403。
      u.searchParams.set('room', String(roomId));
      return u.toString();
    } catch (e) {
      return location.origin + location.pathname + location.search + (location.search ? '&' : '?') + 'room=' + encodeURIComponent(roomId);
    }
  }

  function readInviteRoom() {
    try {
      var sp = new URLSearchParams(location.search || '');
      var r = String(sp.get('room') || '').trim();
      if (/^\d{6}$/.test(r)) return r;
    } catch (e) { /* 老浏览器不支持 URLSearchParams 时静默跳过 */ }
    return null;
  }

  /* 抹掉 URL 里的 room 参数，避免刷新或返回时重复触发加入 */
  function clearInviteParam() {
    try {
      var u = new URL(location.href);
      if (!u.searchParams.has('room')) return;
      u.searchParams.delete('room');
      history.replaceState(null, '', u.toString());
    } catch (e) {}
  }

  async function handleInvite() {
    var roomId = readInviteRoom();
    if (!roomId) return;

    var input = $('#room-input');
    if (input) input.value = roomId;

    flash('正在进入好友房间 ' + roomId + '…');
    try {
      await onJoin();
      clearInviteParam();
    } catch (e) {
      // 加入失败（房间已结束等）时保留房间号在输入框，用户可手动重试
      clearInviteParam();
    }
  }

  /* 收录：把房间状态里「该落盘的东西」落盘。和 render 彻底解耦 ——
   * render() 在战绩页 / 排行榜 / 登录页会直接 return，而那几页恰恰是
   * 「人在看别的页、房里还在打」的时候。挂在订阅回调上，屏幕形态就影响不到收录了。
   * 两件事都是幂等的：absorbHistory 按签名短路，recordSettled 按 state.recordKey。 */
  function absorbRoom(r) {
    absorbHistory(r);
    recordSettled(r);
  }

  function attachRoom(roomId, room) {
    cleanupRoom();
    state.roomId = roomId;
    state.room = room;
    state.unsub = RoomStore.subscribe(roomId, function (r, meta) {
      if (r === null) {
        cleanupRoom();
        showScreen('screen-home');
        /* 两种「房间没了」要说两句话：
         *   · 别人开了下一局、而我没点 → 我不是被踢，是这一局本来就没我；
         *   · 房间真的被回收 → 已退出。
         * 都回首页，但原因不同，玩家需要知道自己错过了什么。 */
        /* v114（B-3）：被挤出去的人要知道「怎么回来」。
         * 以前只说「你没赶上」，听起来像这桌散了 —— 其实这一局打完之后，
         * 用房号还能进来（房间没销毁）。把房号带上，他就有下一步动作。 */
        flash(meta && meta.reason === 'nextRoundStarted'
          ? ('新的一局已经开始了，你没赶上；这局打完用房号 ' + (state.roomId || '') + ' 还能进')
          : '已退出房间');
      } else {
        state.room = r;
        absorbRoom(r);
        render();
      }
    });
    /* 刷新 / 从分享链接重进时，房间状态是直接带进来的，没有订阅回包可等 ——
     * 这里补一次，否则「刷新时正好停在结算页」那一局不会记进本机战绩。 */
    absorbRoom(room);
    render();
  }

  function cleanupRoom() {
    if (state.unsub) { state.unsub(); state.unsub = null; }
    closeProfile();                 // 离开房间时顺手收起战绩卡（在途请求随序号失效）
    /* 房间级 + 分牌级字段一次性归位（v111）。
     * 以前这里是逐行手写的，漏过三个：justDealt / absorbSig / dissolveWasActive ——
     * 它们不在字面量里，是靠首次赋值挂上去的，所以「该清哪些」根本没清单可对照。 */
    resetRoomState();
    resetSplitState();
    /* 逐组结算的计时器要在这里停掉：停表时机是「离开这一屏」，
     * 不停的话它会在下一个房间/结算页上把上一局的结算弹窗又弹起来。 */
    stopResultSeq();
    closeBreakCard();
    /* 倒计时同理：遮罩是 position:absolute + inset:0，留在 DOM 上会盖住下一个房间
     * 或首页，看起来像「整屏点不动了」。房间号一起清掉，换房重进才能再放一次。 */
    stopCountdown();
    cd.room = '';
    /* 组槽牌型记忆一起清：换房/新局重进时，上一局的「牛牛」若没清掉，
     * 新局第一次成手会被判成「没变」，成手脉冲就少放一次。 */
    resetSlotTypeSeen(-1);
    /* 离开房间时不能停留在战绩页（否则房间订阅重渲染会被拦住）。
     * 注意 suppressTap 也在这里归位：它只在「拖牌后那一次 click」有意义，
     * 留到下一个房间会让第一次点击被吞掉。 */
    resetSessionState();
  }

  /* ---------------------------- 建房：先选本局把数 ----------------------------
   * 产品口径（2026-10-31）：档位 3/5/10/15/30，**不选就是 10**。
   * 一把 = 两轮，写进 room.handLimit 之后房间内不可改，
   * 结算后续把沿用同一档位 —— 所以这个值只在这里选一次。
   *
   * ★ 现在会记住上一次的选择（v110，P1-2）。
   *
   * 改之前这里的注释写的是「每次打开都重置成 10，不记上一次」，理由是：
   * 「记了之后，第二个来开房的人拿到的是上一局留下的档位，而他从没选过」。
   * 那个顾虑是真的，但它只在一个前提下成立：分不清「系统选的」和「我选的」。
   * 现在弹窗一打开就有一个高亮选中的档位，玩家看到的是「这次打 15 把」（可以改），
   * 不是「系统背着我设了 15」。
   *
   * 反过来，不记的代价是实打实的：常打长局的人每开一局都要多点一次，
   * 而多数人常年只用同一个档位。所以改成记住，并守两条硬约束：
   *   · 记忆值必须**在 CONFIG.HAND_LIMITS 里**才采用（改档位列表后老记忆自动失效；
   *     拿一个已下架的档位去建房会被服务端拒，玩家只看到「创建失败」）
   *   · 读写都包 try：隐私模式下 localStorage 会抛，抛了就当没记忆，不能因此开不了房
   */
  var HAND_LIMIT_KEY = ST ? ST.KEYS.HAND_LIMIT : 'lxw_hand_limit_v1';

  function readSavedLimit() {
    var raw = ST ? ST.read(HAND_LIMIT_KEY, '') : '';
    if (!raw) return 0;
    var n = Number(raw);
    /* 必须是列表里的档位。这里不做「取最近的合法值」那种聪明事 ——
     * 猜错了玩家会打到一个自己没选的把数上，比回落默认更糟。 */
    return (CONFIG.HAND_LIMITS || []).indexOf(n) >= 0 ? n : 0;
  }

  function saveLimit(n) {
    if (ST) ST.write(HAND_LIMIT_KEY, String(n)); // 写不进（隐私模式）就当没记住
  }

  function openCreateModal() {
    Sfx.unlock();
    createLimit = readSavedLimit() || CONFIG.DEFAULT_HAND_LIMIT;
    renderHandLimitChips();
    showModalEl('create-modal');
  }

  /* 档位按钮按 CONFIG.HAND_LIMITS 现场生成（HTML 里不放死的那一份）。
   * 用 radiogroup + aria-checked 而不是原生 radio：原生 radio 要自己画
   * 焦点环和选中圆点，而这里的选中态就是整块底色，用按钮更直接。 */
  function renderHandLimitChips() {
    var row = $('#hand-limit-row');
    if (!row) return;
    var list = (CONFIG.HAND_LIMITS && CONFIG.HAND_LIMITS.length) ? CONFIG.HAND_LIMITS : [3, 5, 10, 15, 30];
    row.innerHTML = '';
    list.forEach(function (n) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hand-limit-chip';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('data-limit', String(n));
      btn.setAttribute('aria-checked', n === createLimit ? 'true' : 'false');
      btn.setAttribute('aria-label', n + ' 把');
      if (n === createLimit) btn.classList.add('is-on');
      var num = document.createElement('span');
      num.className = 'hl-num';
      num.textContent = String(n);
      var unit = document.createElement('span');
      unit.className = 'hl-unit';
      /* 默认档标一个「默认」，让人知道不改也能开 —— 否则会有人以为必须选一个 */
      unit.textContent = (n === CONFIG.DEFAULT_HAND_LIMIT) ? '把 · 默认' : '把';
      btn.appendChild(num); btn.appendChild(unit);
      btn.addEventListener('click', function () {
        if (createLimit === n) return;
        createLimit = n;
        Sfx.play('select');
        /* 只翻选中态，不重建 DOM：重建会把刚被点的按钮从文档里摘掉，
         * 键盘焦点会掉到 body 上，读屏读到的是「什么都没发生」。 */
        var chips = row.querySelectorAll('.hand-limit-chip');
        for (var i = 0; i < chips.length; i++) {
          var on = Number(chips[i].getAttribute('data-limit')) === createLimit;
          chips[i].classList.toggle('is-on', on);
          chips[i].setAttribute('aria-checked', on ? 'true' : 'false');
        }
      });
      row.appendChild(btn);
    });
  }

  function closeCreateModal() { hideModalEl('create-modal'); }

  /* 点「开始建房」：关弹窗 → 走原来的建房流程。
   * 刻意**不在弹窗里等请求**：建房失败时 flash 是挂在页面层的 toast，
   * 弹窗盖在上面时玩家根本看不见它，只会以为按钮没反应。 */
  async function onCreateConfirm() {
    if (blockedOffline()) return;
    var limit = createLimit;
    /* 记住的是**这次真的提交出去的**档位，不是「点过的最后一个」——
     * 点了 15 又取消、下次打开却默认 15，那不是「记住选择」，是「记住犹豫」。 */
    saveLimit(limit);
    closeCreateModal();
    var restore = pressBusy($('#btn-create'), '创建中…');
    if (!restore) return;
    try {
      var room = await RoomStore.createRoom({ id: state.myId, nickname: readNickname() }, { handLimit: limit });
      if (!room) { flash('创建房间失败'); Sfx.play('error'); return; }
      attachRoom(room.roomId, room);
      Sfx.play('submit');
    } catch (e) {
      flash((e && e.message) || '创建失败，检查一下网络');
      Sfx.play('error');
    } finally {
      restore();
    }
  }

  async function onJoin() {
    Sfx.unlock();
    var roomId = $('#room-input').value.trim();
    if (!/^\d+$/.test(roomId) || roomId.length !== CONFIG.ROOM_ID_LENGTH) {
      flash('请输入 ' + CONFIG.ROOM_ID_LENGTH + ' 位数字房间号'); Sfx.play('error'); return;
    }
    if (blockedOffline()) return;
    var restore = pressBusy($('#btn-join'), '进房中…');
    if (!restore) return;
    try {
      var res = await RoomStore.joinRoom(roomId, { id: state.myId, nickname: readNickname() });
      if (!res.ok) { flashRoomError(res); return; }
      attachRoom(roomId, res.room);
    } catch (e) {
      flash((e && e.message) || '进房失败，检查一下网络');
      Sfx.play('error');
    } finally {
      restore();
    }
  }

  /* ★ v114（B-2）：开下一把之前，先让「最急的人」看一眼代价。
   * 只要还有人停在结算页（没报名），一旦已报名的人全部准备好，
   * 那一把就会立刻开始，还在结算页的人会被挤出去 —— 他自己不会知道。
   * 所以「我要准备」这一步加一次确认，把人数和后果说清。
   * 只在「还没准备 → 准备」这个方向上问，取消准备不问。 */
  function onReady() {
    var me = getMe(state.room);
    if (!me) return;
    if (blockedOffline()) return;
    /* 只管「结算后的就位态」（phase 仍是 SETTLED + 我已报名）。
     * 首次开局的准备不在此列：那时大家都在房间里等着，没有人会被挤出去。 */
    if (!me.ready && state.room.phase === StateMachine.PHASE.SETTLED && me.wantNext) {
      var waiting = (state.room.players || []).filter(function (p) {
        return !p.left && !p.wantNext;
      }).length;
      if (waiting > 0) {
        askConfirm('现在就开下一把？',
          '还有 ' + waiting + ' 人停在结算页。全部准备好就会立刻开局，他们会被挤出去，这一把打完才能再进来。',
          function () { return doReady(); });
        return;
      }
    }
    doReady();
  }

  async function doReady() {
    var me = getMe(state.room);
    if (!me) return;
    var restore = pressBusy($('#btn-ready'), me.ready ? '取消中…' : '准备中…');
    if (!restore) return;
    try {
      var res = await RoomStore.setReady(state.roomId, state.myId, !me.ready);
      if (res && !res.ok) flashRoomError(res);
    } catch (e) {
      flash('网络不太稳，再试一次');
    } finally {
      restore();
    }
  }

  /* 房主补一个 AI 队友：凑不齐人时也能马上开一局 */
  async function onAddBot() {
    if (!state.room) return;
    if (blockedOffline()) return;
    var restore = pressBusy($('#btn-add-bot'), '添加中…');
    if (!restore) return;
    try {
      var res = await RoomStore.addBot();
      if (!res || !res.ok) {
        flash((res && res.error) || '补 AI 失败');
        Sfx.play('error');
        return;
      }
      Sfx.play('select');
    } catch (e) {
      flash('网络不太稳，再试一次');
    } finally {
      restore();
    }
  }

  /* 结算页 →「开始下一局」。
   * 点完不是立刻发牌，而是把我登记进下一局、切到房间页（房间号不变），
   * 到那边再各自点准备。没点的人完全不受影响，继续留在结算页。 */
  async function onNextRound() {
    if (blockedOffline()) return;
    var restore = pressBusy($('#btn-next'), '进入中…');
    if (!restore) return;
    try {
      var res = await RoomStore.wantNext(state.roomId, state.myId);
      if (!res.ok) {
        /* 「新的一局已经开始了」不是故障，是时序 —— 别人比我先点完。
         * 用 toast 说清就行，不弹红色报错：玩家没做错任何事，
         * 而且他还能继续看自己的结算数据与回放。 */
        flash(res.error || '暂时进不去，稍后再试');
      }
    } catch (e) {
      flash('网络不太稳，再试一次');
    } finally {
      restore();
    }
  }

  /* 就位态「回结算页」：撤回报名。
   * 存在的理由是「反悔」——「开始下一局」以前是个单向门，点错只能退房重进。
   * 撤回后界面由订阅回调自然重绘回结算页，这里不用手工切屏。 */
  async function onNextBack() {
    if (blockedOffline()) return;
    var restore = pressBusy($('#btn-next-back'), '撤回中…');
    if (!restore) return;
    try {
      var res = await RoomStore.unWantNext(state.roomId, state.myId);
      if (!res.ok) {
        /* 撞上「新的一局已经开始了」不是故障：别人刚好凑齐并开了局。
         * 这时把他留在房间页只会看到一个已经不属于他的界面，直接刷新到当前真实状态。 */
        flash(res.error || '撤回不了，稍后再试');
      }
    } catch (e) {
      flash('网络不太稳，再试一次');
    } finally {
      restore();
    }
  }

  /* 离开前向服务端要一次最新房间快照。
   *
   * 为什么要多这一趟：本地 state.room 是 WS 推过来的，可能落后。
   * 手机上切后台再切回来、或者网络抖一下，很容易出现「本地还显示等待中、
   * 服务端其实已经在分牌」的错位。这时界面会给一个毫无预警的
   * 「离开房间」，玩家点确定，一局就默默算成了弃局——分数照扣。
   * 判定「算不算弃局」这件事只能以服务端为准。
   *
   * 走 peekRoom 而不是 reconnect：后者会补分牌时限，反复点「离开 / 取消」
   * 就能一直续命。读状态不能带副作用。
   *
   * 拿不到快照（离线 / 超时 / 座位已失效）不算失败：退回本地快照，
   * 但文案里要说清「没核对上」，别让玩家以为系统已经确认过。 */
  function fetchRoomSnapshot() {
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        resolve(null);
      }, 2500);
      var p;
      try { p = RoomStore.peekRoom(state.roomId); } catch (e) { p = null; }
      if (!p || typeof p.then !== 'function') {
        clearTimeout(timer);
        resolve(null);
        return;
      }
      p.then(function (res) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve((res && res.ok && res.room) || null);
      }, function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(null);
      });
    });
  }

  /* 取第一个「真正看得见」的按钮。
   * 判据是祖先链上有没有 .hidden —— 只判元素自己的 class 不够：
   * .screen 隐藏时子按钮自己身上没有 hidden，但它并没有显示出来。 */
  function firstShown(ids) {
    for (var i = 0; i < ids.length; i++) {
      var b = $('#' + ids[i]);
      if (b && !(b.closest && b.closest('.hidden'))) return b;
    }
    return null;
  }

  async function onLeave() {
    if (!state.roomId) return;
    if (blockedOffline()) return;
    /* 核对进度要走一趟网络，最长 2.5 秒。这期间按钮必须有反馈——
     * 「点了没反应」和「点了没生效」在手机上分不出来，人只会反复点。
     * 三个入口（房间页 / 对局页 / 结算页）共用一个 onLeave，按**当前可见的那个**给忙碌态。
     * 以前这里是按 phase 猜的：`phase !== WAITING` 就取 #btn-leave-game。
     * 但结算页和就位态都是 SETTLED，人在结算页时猜出来的却是对局页那颗 ——
     * 忙碌态加到一个 display:none 的按钮上，玩家点的那个一点反应都没有，
     * 于是再点一次，被连点短路静默吞掉。请求没重发，人已经困惑了。 */
    var btn = firstShown(['btn-leave', 'btn-leave-game', 'btn-back-room']);
    var restore = pressBusy(btn, '核对中…');
    if (!restore) return;                     // 连点：上一个还在核对，忽略这一次
    var snap = null;
    try {
      snap = await fetchRoomSnapshot();
    } finally {
      restore();
    }
    if (!state.roomId) return;                // 核对期间房间已结束/已退出
    /* 对局中和等待中的后果完全不同，文案必须分开写。
     * 「离开房间」在对局中等价于弃局：本场按当前分数记入战绩（不是免费走人），
     * 而且剩下的人会被判定「人数不足，本局结束」——这个代价得先讲清楚。 */
    var room = snap || state.room || null;
    var fresh = !!snap;
    var ph = room && room.phase;
    var mid = !!ph && ph !== StateMachine.PHASE.WAITING && ph !== StateMachine.PHASE.SETTLED;
    var title = mid ? '弃局离开？' : '离开房间';
    var desc;
    if (mid) {
      /* 把「第几轮、多少分」写出来：只说「按当前分数」太抽象，
       * 玩家没法判断这一走要赔掉多少，也就更容易误点。 */
      var roundNo = Number(room.round) > 0 ? Number(room.round) : 1;
      var me = null;
      var ps = room.players || [];
      for (var i = 0; i < ps.length; i++) {
        if (ps[i] && String(ps[i].id) === String(state.myId)) { me = ps[i]; break; }
      }
      var scoreTxt = me && typeof me.score === 'number' ? ('现在 ' + me.score + ' 分') : '当前分数';
      desc = '第 ' + roundNo + ' 轮正在进行。现在离开算弃局：本场按你' + scoreTxt +
        '记入战绩，其他人这局也会就此结束。';
    } else {
      desc = '确定要离开当前房间吗？';
    }
    /* 本地演示模式（?mode=local）本来就没有服务端可核对，不该报这句话 */
    if (!fresh && RoomStore.getMode && RoomStore.getMode() === 'ws') {
      desc += '\n（没连上服务端核对最新进度，以上按本地画面判断。）';
    }
    askConfirm(title, desc, async function () {
      await RoomStore.leaveRoom(state.roomId, state.myId);
      cleanupRoom();
      showScreen('screen-home');
    }, { busyText: '离开中…' });
  }

  async function onProposeDissolve() {
    if (!state.room) return;
    if (blockedOffline()) return;
    var btn = state.room.phase === StateMachine.PHASE.WAITING ? $('#btn-dissolve') : $('#btn-dissolve-game');
    var restore = pressBusy(btn, '提交中…');
    if (!restore) return;
    try {
      var res = await RoomStore.proposeDissolve(state.roomId, state.myId);
      if (!res.ok) { flashRoomError(res); return; }
      Sfx.play('submit');
      render(); // 经 subscribe 更新兜底
    } catch (e) {
      flash('网络不太稳，再试一次');
    } finally {
      restore();
    }
  }

  async function onVoteDissolve(agree) {
    if (!state.room) return;
    hideModalEl('dissolve-modal'); // 投票后先收起弹窗
    var res = await RoomStore.voteDissolve(state.roomId, state.myId, agree);
    if (!res.ok) { flashRoomError(res); return; }
    Sfx.play('submit');
    render();
  }

  /* 发起人撤销解散。以前没有这个出口：点错一次就只能等 30 秒超时，
   * 或者干脆退房重进。 */
  async function onCancelDissolve() {
    if (!state.room) return;
    hideModalEl('dissolve-modal');
    var res = await RoomStore.cancelDissolve(state.roomId, state.myId);
    if (!res.ok) { flashRoomError(res); return; }
    Sfx.play('submit');
    flash('已撤回');
    render();
  }

  async function onCopy() {
    if (!state.room) return;
    var roomId = state.room.roomId;
    var link = inviteLink(roomId);
    var text = '【六选五】点链接直接进房：' + link + '\n房间号 ' + roomId + '（打不开就手动输号）';

    /* 有 Web Share 就先调系统分享面板。
     *
     * 为什么值得多这一段：iOS 上「复制链接」之后用户还要切到微信、找群、粘贴，
     * 一共四步；系统分享面板直接列出微信，两步到位。而邀请是这类游戏唯一的传播路径，
     * 每多一步都会掉人。
     *
     * 两个必须注意的点：
     *  1. 必须在**点击回调的同步段**里调用（这里在第一个 await 之前），
     *     否则 Safari 会判定为非用户手势并直接 reject；
     *  2. AbortError 是用户主动取消，不是失败 —— 不能再弹「已复制」的提示。 */
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({
          title: '六选五 · 联机扑克',
          text: '来一局？房间号 ' + roomId,
          url: link
        });
        return;
      } catch (e) {
        if (e && (e.name === 'AbortError' || e.code === 20)) return;
        /* 其他错误（不支持/参数非法/权限拒绝）往下走剪贴板兜底 */
      }
    }

    // 优先用异步 Clipboard API，await 到真实结果，失败再回退 execCommand 并校验返回值
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        flash('邀请链接已复制，发给好友点开就能进');
        return;
      } catch (e) {
        // 非 https 或非用户手势上下文会 reject，走下面的 execCommand 兜底
      }
    }

    // 兜底：execCommand('copy')，返回值 false 就是真没复制成功，不能谎报
    var ok = false;
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ok = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) {
      ok = false;
    }

    if (ok) {
      flash('邀请链接已复制，发给好友点开就能进');
    } else {
      flash('复制失败，房间号 ' + roomId + '，请手动记下');
    }
  }

  /* ---------------------------- 缩放适配 ---------------------------- */
  /* 尺寸读不到时的重试计数：页面刚从后台恢复、或渲染树被系统回收后重建的那一两帧，
   * clientWidth/Height 会读到 0。不重试就永远停在「没算过缩放」的状态。 */
  var resizeRetries = 0;
  var RESIZE_RETRY_MAX = 5;
  /* 上一次成功写入的容器尺寸。用来判断「容器变了但没收到 resize」——
   * ResizeObserver 每次都触发，靠这两个值做幂等，避免无谓重排。 */
  var lastVpW = 0, lastVpH = 0;
  var vpWatchTimer = 0;

  /* ---------------------------- 禁止页面缩放 ---------------------------- */
  /* 牌桌是整体按 750 设计空间缩放的（#stage 的 transform），手牌、组槽、拖拽命中区
   * 全部按那套像素算死。浏览器再叠一层页面缩放，后果是牌变小、命中区整体偏移，
   * 拖牌时点不中——而且缩放状态会一直留着，玩家只能自己双指捏回去，很浪费时间。
   *
   * 三处必须一起改，少一处就会漏：
   *   1) <meta viewport> 的 user-scalable=no / maximum-scale —— Android Chrome 认；
   *   2) CSS 的 touch-action: pan-x pan-y —— **不能写 manipulation**，它等于
   *      pan-x pan-y pinch-zoom，把捏合放大明确交还给浏览器了；
   *   3) 这里。iOS Safari 从 iOS 10 起**故意忽略** user-scalable=no（无障碍政策），
   *      对 touch-action 的 pinch-zoom 支持也不完整，只有拦手势事件才真的有效。
   *
   * 为什么全局拦 touchmove 不影响性能：页面本身 overflow:hidden 不滚动，手牌区和槽位
   * 已经是 touch-action:none，所以绝大多数 touchmove 本来就不该被浏览器消费；
   * 监听器第一句就判触点数量，单指路径立刻返回，不进 preventDefault 分支。
   *
   * 代价说清楚：这是**牺牲了页面级缩放的无障碍能力**换手感。牌桌有自己的缩放体系
   * （整页缩放），真正的无障碍替代是「牌面放大」这类设置项，属于产品决定，不在这里做。 */
  function lockPageZoom() {
    /* Safari 私有手势事件：双指一落就直接改页面缩放，必须 preventDefault。
     * passive 必须是 false，否则 preventDefault 会被浏览器忽略。 */
    ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (name) {
      document.addEventListener(name, function (e) {
        if (e.cancelable !== false) e.preventDefault();
      }, { passive: false });
    });

    /* 双指 touchmove：只有两个及以上触点才拦，单指完全不受影响。
     * 不拦 touchstart 是有意的 —— 拦了会让 iOS 上的点击延迟、双击判定变脆。 */
    document.addEventListener('touchmove', function (e) {
      if (e.touches && e.touches.length > 1 && e.cancelable !== false) e.preventDefault();
    }, { passive: false });
  }

  /* ---------------------------- 现场诊断：?diag=1 ----------------------------
   * 真机上没有控制台，而「底部多一条色带」这类问题的全部证据就是几个数字：
   * 四种来源的视口高各是多少、舞台实际铺到哪一行、屏幕本身多高。
   * 带 ?diag=1 打开，左上角常驻一块读数；不带参数时这段完全不执行（DOM 都不建）。
   * 定位完就让人把参数去掉，不用等发版。 */
  var DIAG = /(?:^|[?&])diag=1(?:&|$)/.test(location.search || '');
  var diagEl = null;
  function updateDiag(lines) {
    if (!DIAG) return;
    if (!diagEl) {
      diagEl = el('div', 'diag-panel');
      document.body.appendChild(diagEl);
    }
    diagEl.textContent = lines.join('\n');
  }

  /* ---------------------------- 调试侧栏：?dev=1 ----------------------------
   * 只留「看档位 + 翻开关」两件事，见 config.js 里 DEV_PANEL 那段注释。
   * 原型侧栏里的场景 A·B / 播放整局 / `window.__proto` 钩子**一律不做** ——
   * 那是评审工具，而且每一个都能在正式包里造出一条「跳过服务端」的入口。
   *
   * 为什么挂在 body 上而不是 #stage 里：舞台是 transform: scale 的，
   * 面板跟着缩会在 320 宽的小屏上变成 6px 的字 —— 与 .diag-panel 同一条理由。
   *
   * ★ 元素只在 ?dev=1 时才创建。不带参数时这段只有两个空变量，
   *   否则「正式包里有没有调试入口」这件事就只能靠读代码确认。 */
  var devEl = null;
  var devRowsEl = null;

  function devPanelFlag() {
    var q = '';
    try {
      var sp = new URLSearchParams(location.search || '');
      /* 两个名字都认：`?devpanel=1` 是**与 CONFIG 键同名**的规范写法（回滚契约
       * pwa/test/rollback-contract.test.js 按这个规则扫描所有开关），
       * `?dev=1` 是手敲/文档里用的短写法。两者等价，谁在前都不影响判定。 */
      q = sp.get('devpanel') || sp.get('dev') || '';
    } catch (e) { q = ''; }
    if (q === '0') return false;
    if (q === '1') return true;
    return CONFIG.DEV_PANEL;
  }

  /* 当前圆桌档位。四个 mode 名与 seatRing.js 的 MODES 一一对应 ——
   * 面板上写错名字比不写更坏：真机会被这张表误导。 */
  function devRingMode() {
    if (!isLandscape) return ringCompact() ? 'portraitCompact' : 'portrait';
    return ringDesktop() ? 'desktop' : 'landscape';
  }

  /* 实测牌面（设计 px）。#slots 在舞台上，getBoundingClientRect 给的是缩放后的
   * CSS px，除回 scale 才是「文档 §11 那套 110×154 / 82×115」的同一把尺子。 */
  function devCardBox() {
    var c = document.querySelector('#slots .slot .card');
    if (!c || !lastStageScale) return '';
    var r = c.getBoundingClientRect();
    if (!r.width) return '';
    return Math.round(r.width / lastStageScale) + '×' + Math.round(r.height / lastStageScale);
  }

  function updateDev() {
    if (!devPanelFlag()) return;
    if (!devEl) {
      devEl = el('div', 'dev-panel');
      var head = el('div', 'dev-panel-head', '调试 · 版式');
      var btns = el('div', 'dev-panel-btns');
      /* 三个 URL 开关各一个按钮，点一下翻转并刷新 —— 手机上改地址栏是最费劲的一步。
       * 走 location.href 而不是 location.reload()：开关是 URL 参数，刷新不带上改动等于没点。 */
      [
        ['seatring', '圆桌', true],
        ['startcountdown', '倒计时', false],
        ['emoji', '表情', true]
      ].forEach(function (it) {
        var b = el('button', 'dev-panel-btn', it[1]);
        b.type = 'button';
        b.dataset.q = it[0];
        b.dataset.label = it[1];
        btns.appendChild(b);
      });
      var copy = el('button', 'dev-panel-btn', '复制');
      copy.type = 'button';
      copy.dataset.copy = '1';
      btns.appendChild(copy);
      var shut = el('button', 'dev-panel-btn', '×');
      shut.type = 'button';
      shut.dataset.shut = '1';
      btns.appendChild(shut);
      head.appendChild(btns);
      devRowsEl = el('div', 'dev-panel-rows');
      devEl.appendChild(head);
      devEl.appendChild(devRowsEl);
      document.body.appendChild(devEl);
      /* 事件用委托挂一次就够：面板复用同一个节点，重写 innerHTML 不会丢监听。 */
      devEl.addEventListener('click', function (ev) {
        var t = ev.target;
        if (!t || t.tagName !== 'BUTTON') return;
        if (t.dataset.shut) { devEl.classList.add('hidden'); return; }
        if (t.dataset.copy) {
          var txt = devRowsEl.textContent || '';
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(txt);
            t.textContent = '已复制';
            setTimeout(function () { t.textContent = '复制'; }, 1200);
          }
          return;
        }
        var key = t.dataset.q;
        if (!key) return;
        var on = !/1/.test(t.dataset.on || '0');
        try {
          var u = new URL(location.href);
          u.searchParams.set(key, on ? '1' : '0');
          location.href = u.toString();
        } catch (e) { /* file:// 下不支持 URL 构造时什么都不做（面板仍然可读） */ }
      });
    }
    var slots = $('#slots');
    /* 组槽在首页/房间里是 hidden，clientHeight 为 0 —— 写「0」会让人以为
     * 「组槽被压成零高」，而这个面板恰恰是用来判断这类事的，所以要写「—」。 */
    var slotsH = slots && slots.clientHeight ? slots.clientHeight : '—';
    var rows = [
      ['版式', (isLandscape ? '横屏' : '竖屏') + ' · ' + devRingMode() + (seatRingFlag() ? '' : '（圆桌关）')],
      ['舞台', Math.round(lastStageH) + ' 设计高 · scale ' + (lastStageScale || 0).toFixed(3)],
      ['组槽', (slotDense ? 'dense' : 'normal')
        + (slotTwoCol ? ' · 两列' : '') + ' · ' + slotsH],
      ['牌面', devCardBox() || '—']
    ];
    devRowsEl.textContent = '';
    rows.forEach(function (r) {
      var row = el('div', 'dev-panel-row');
      /* 钩子后面补一个空格：<i> 与 <b> 之间只有 CSS 的间距，textContent 拼起来
       * 会变成「版式竖屏」—— 而这个面板的「复制」按钮就是把人眼看到的这串发出去。 */
      row.appendChild(el('i', '', r[0] + ' '));
      row.appendChild(el('b', '', String(r[1])));
      devRowsEl.appendChild(row);
    });
    /* 按钮上的 on/off 直接读 URL，不读 CONFIG —— 用户要看到的是「这一页实际生效的那个值」。 */
    var q = {};
    try {
      var sp = new URLSearchParams(location.search || '');
      q = { seatring: sp.get('seatring'), startcountdown: sp.get('startcountdown'), emoji: sp.get('emoji') };
    } catch (e) { q = {}; }
    Array.prototype.forEach.call(devEl.querySelectorAll('.dev-panel-btn[data-q]'), function (b) {
      var k = b.dataset.q;
      var v = q[k];
      if (v !== '0' && v !== '1') {
        /* 没在 URL 里写 → 显示 CONFIG 的默认值：seatring 还要过闸门，直接问判定函数 */
        v = (k === 'seatring' ? seatRingFlag() : k === 'emoji' ? emojiFlag() : startCountdownFlag()) ? '1' : '0';
      }
      b.dataset.on = v;
      /* 标签前缀存在 data-label 里、每次重建整串 —— 直接在 textContent 上做替换
       * 会在第二次 updateDev 时叠成「圆桌 ·开 ·开」。 */
      b.textContent = (b.dataset.label || '') + (v === '1' ? ' ·开' : ' ·关');
    });
  }

  /* 量一次 `100vh` 到底是多少 CSS px。
   *
   * 为什么不直接在 CSS 里写 100vh 就完事：竖版舞台要先知道「该不该信它」——
   * 浏览器里工具栏没收起时 100vh 会比可视高大（那是假的大，会白裁底部留白），
   * 只有 standalone + 竖屏这一档它才是真屏高。判断需要数字，所以先量，再由 JS 决定。
   * 用绝对定位 + left:-99999px 量，不参与布局，也不会撑出滚动条。 */
  function measureUnitH() {
    if (!document.body) return 0;
    var p = document.createElement('div');
    p.style.cssText = 'position:absolute;left:-99999px;top:0;width:1px;height:100vh;';
    document.body.appendChild(p);
    var h = Math.round(p.getBoundingClientRect().height);
    document.body.removeChild(p);
    return h > 0 ? h : 0;
  }

  function resize() {
    var vp = document.getElementById('viewport');
    var stage = document.getElementById('stage');
    if (!vp || !stage) return;

    /* ★ 先读容器尺寸，并且**在读安全区之前**就判有效性。
     *
     * 为什么必须有这道门：下面 isPortraitPhone / isLandscapePhone 的判定用的是
     * `availW < availH` 和 `Math.min(availW, availH) <= 520`。
     * 一旦 vh 读到 0，availH 就是 0 或负数（真机还要再减上下安全区，必然是负数），
     * 两个判定会同时落空成「横屏手机」这一支，于是
     *     scale = Math.min(availW / 750, availH / 1440) = 0（无安全区）或负数（有安全区）
     *     stageW = vw / scale = Infinity 或上万的负数
     * `transform: scale(0)` 把整个 750×1624 的舞台缩成 0 像素，屏幕上**只剩背景色**；
     * 带安全区的真机上 scale 是负数，舞台被镜像缩到看不见，同样是整屏空白。
     * 而且它**不会自愈** —— 此后没有新的 resize 事件，用户只能刷新。
     * 这就是「同一部手机开 Safari/Edge/PWA 三个容器打牌，切出去再切回来整屏空白」的成因：
     * 多开时内存压力最大，iOS 最容易在后台挂起期间回收渲染树、恢复瞬间布局尚未完成。
     * （实测：320/390 视口下把 clientHeight 打到 0，改坏前写进去的是 `scale(0)`。）
     *
     * 所以：尺寸无效时**保留上一次算好的缩放**，并安排重试，绝不带着 0 往下算。 */
    /* 视口尺寸取 getBoundingClientRect 而不是 clientHeight。
     * 原因：iOS「添加到主屏幕」后，clientHeight 偶尔比真实视口小一截
     * （灵动岛 / 实时活动那条安全区不计入），而这个值还决定 stageH ——
     * 一旦读小，不只是舞台矮一截露底，连 `.compact-v`（stageH < 1500）都会被误触发，
     * 小屏压缩样式凭空挂到正常的 Pro Max 上。rect 走的是布局几何，不经过那层读数。 */
    var vpRect = vp.getBoundingClientRect();
    var vw = Math.round(vpRect.width) || vp.clientWidth;
    var vh = Math.round(vpRect.height) || vp.clientHeight;
    if (!(vw > 0) || !(vh > 0)) {   // 写成 !(x > 0) 是为了同时挡住 NaN
      if (resizeRetries < RESIZE_RETRY_MAX) {
        resizeRetries++;
        setTimeout(resize, 80);
      }
      return;
    }
    resizeRetries = 0;
    lastVpW = vw;
    lastVpH = vh;

    /* PWA（添加到主屏幕）标记。CSS 只在 standalone 下启用 `min-height` 兜底，
     * 浏览器里不加 —— 工具栏弹出时 100vh 会大于可视高，裁掉底部设计留白。 */
    var standalone = (window.navigator.standalone === true) ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);

    /* ★ standalone 下用「物理屏高」校正视口读数 —— 这是底部那条色带的第二个成因。
     *
     * 第一个成因（上一版已修）是 JS 把视口高写成像素死值；这一道防的是**读数本身**就小：
     * 加到主屏幕后，iOS 偶尔把布局视口报成「屏高 − 56」（键盘收起后没恢复、实时活动
     * 占位残留等都会发生），此时 `100%` 和 `100vh` 全都跟着变小，光靠 CSS 反算救不回来 ——
     * 舞台矮掉的那一截露出 #viewport 的底色，就是用户看到的那条平直色带。
     *
     * 为什么敢信 screen.height：standalone 的定义就是「应用独占整块屏」，
     * 没有工具栏、没有地址栏，屏幕高就是内容区高。浏览器里绝不能这么干
     * （screen.height 是整个显示器），所以严格限定在 standalone + 竖版。
     *
     * 两个护栏，防止把分屏/多任务误判成全屏：
     *   · 只往上修（screenH > vh），读数偏大时不动；
     *   · 只修「差得不多」的（≤ 18%），差太多说明这个窗口本来就不是全屏。 */
    var screenH = 0;        // 采纳的校正值（0 = 没校正），只给 ?diag=1 看
    var vhSrc = 'vp rect';  // 高度是哪条来源给的，同样只给诊断看
    if (standalone && vw < vh) {
      /* ★ iOS 26 的坑（WebKit bug 313800）：standalone 下 `100%`、`dvh`、`svh`、
       * `visualViewport`、`innerHeight` 常常一起报「比整屏矮一个状态栏」的值，
       * 唯一还报真屏高的是 `100vh` / `100lvh`。而这一版之前只用 rect 和
       * screen.height 两条来源，两条都矮时就无解 —— 底部那条色带一直修不掉，
       * 根因在这里。所以补第三条：现场量一次 `100vh` 是多少像素。
       * 仍然沿用两条护栏：只往上修、只修差得少的（≤18%，分屏/多任务窗口不动）。 */
      var cands = [
        { h: (window.screen && window.screen.height) ? Math.round(window.screen.height) : 0, src: 'screen' },
        { h: measureUnitH(), src: '100vh' }
      ];
      for (var ci = 0; ci < cands.length; ci++) {
        if (cands[ci].h > vh && cands[ci].h - vh <= Math.round(vh * 0.18)) {
          vh = cands[ci].h;
          screenH = cands[ci].h;
          vhSrc = cands[ci].src;
        }
      }
    }

    /* ★ 把「真实屏高」交给 CSS —— 这是色带的第二半原因，以前完全没做。
     *
     * 上面就算把 vh 校正成 852，舞台也长不起来：`#stage` 的百分比高度、
     * `#viewport` 的 inset:0、`html/body` 的 height 全挂在**布局视口**上（852 报成 796 时
     * 它们一起是 796），而 body 上那句 `overflow: hidden` 会在 796 处把超出的 56px 裁掉。
     * 于是「JS 算对了、CSS 也画了，但被父级裁没了」—— 探针断言 rect 通过、屏幕上仍是色带。
     *
     * 现在四层（html / body / #viewport / #stage）统一读 --vp-h，谁也不会再裁谁。
     * 浏览器里 vh 就等于可视高，所以这条改动对浏览器打开零影响。 */
    document.documentElement.style.setProperty('--vp-h', vh + 'px');

    // 1) 读取真实安全区像素（env(safe-area-inset-*) 在 standalone/PWA 下对 17 Pro Max 灵动岛返回约 47~59px）
    var probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:-99999px;top:-99999px;'
      + 'padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);'
      + 'padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right);';
    document.body.appendChild(probe);
    var cs = getComputedStyle(probe);
    var saTop = parseFloat(cs.paddingTop) || 0;
    var saBottom = parseFloat(cs.paddingBottom) || 0;
    var saLeft = parseFloat(cs.paddingLeft) || 0;
    var saRight = parseFloat(cs.paddingRight) || 0;
    document.body.removeChild(probe);

    // 1.5) iOS/Android PWA standalone 下若 env() 异常返回 0，用灵动岛/刘海最小安全高度兜底
    //      只在竖版生效：横版时灵动岛在**侧边**（走 saLeft/saRight），
    //      这里再垫 47 会把可用高压掉 47px —— 舞台缩小、四周露底色，正是真机上
    //      「横屏一进去就四周留白」的一半原因。
    if (standalone && vw < vh) saTop = Math.max(saTop, 47);

    // 2) 扣除安全区后的可用绘制区（容器尺寸已在函数开头读过并校验）
    var availW = vw - saLeft - saRight;
    var availH = vh - saTop - saBottom;

    /* 安全区把整个可用区吃光（极窄窗口 / 折叠屏过渡态）时同样是无效输入 */
    if (!(availW > 0) || !(availH > 0)) return;

    /* 4) 三种模式：
     *    A. 手机竖屏：按宽度铺满，高度自适应到屏幕边缘，舞台从屏幕原点铺到屏幕底部
     *       （含上下安全区条带，条带用牌桌背景填充），内容用 --sa-top/--sa-bottom
     *       换算成的设计像素 padding 自行避开灵动岛 / home indicator。
     *    B. 手机横屏：固定 1624×750 画布等比居中（= 竖版 750×1624 转 90°），
     *       多出来的宽度用来分栏（.ls），不缩放字号。安全区并进居中偏移。
     *       —— 老方案是「设计高压到 1440、宽按 vw/scale 铺满、内容限宽 750 居中」，
     *       那会让 844×390 的 scale 掉到 0.271、牌桌缩成屏宽 24% 的窄柱，
     *       已在 REVIEW 21.3 记档并废弃。读到「1440 / max-width 750」就是过期说明。
     *    C. 桌面/大窗口：等比居中（一个居中的竖版画面），不变形、不拉伸。
     */
    // 机型判定（只看朝向，不再按短边猜设备）：
    //   宽屏（宽 ≥ 高）：手机横屏 / 平板横屏 / 电脑窗口，全部走横向版式 .ls
    //     （v106 起还包含「窄高的电脑窗口」——判据见 RingGate.isLandscape）
    //   竖版（宽 < 高）：手机竖屏 / 窄高的电脑窗口，走原来的竖版
    // 旧版把「短边 > 520」的宽屏判成「桌面」，套一个居中的竖版画面 ——
    // 结果手机上比例稍大一点、平板上、电脑上都是「中间一条、四周留白」。
    /* v106：竖版版式的设计高是**算出来的** —— `750 × (视口高 / 视口宽)`，
     * 也就是 `750 × 高宽比`；竖版要 ≥1000 设计px 才装得下，所以前提是
     * 「高宽比 ≥ 1000/750 = 1.333」。桌面把窗口拉成窄高（左右分屏 960×1040、
     * 720×780）时高宽比只有 1.0~1.3，竖版必然溢出 —— 实测 960×1040 组槽溢出
     * 195 设计px、牌面 60×84（全场最小）。这类窗口改走横向版式。
     * 判据与理由都在 ringGate.js 的 isLandscape()，这里只取值。 */
    var isLandscapePhone = RingGate.isLandscape(availW, availH);

    var scale, stageW = CONFIG.DESIGN_WIDTH, stageH, left, top;

    /* 横屏画布：1624×750 —— 正好是竖版 750×1624 转 90°。
     *
     * 老做法是把设计高压到 1440、宽按 vw/scale 铺满，结果 844×390 时
     * scale = 390/1440 = 0.271，字号被腰斩（22 设计 px → 6 CSS px），
     * 牌桌缩成屏宽 24% 的一条窄柱（见 REVIEW 21.3 的实测表）。
     *
     * 现在按 1624×750 取小：844×390 得 min(0.520, 0.520) = 0.52，
     * **与竖屏同一档缩放** —— 字不会变小，多出来的宽度用来放第二栏。
     * 两个方向都是 0.52 不是巧合：844/1624 = 390/750 = 0.52，
     * 手机上常见的 19.5:9 屏（812×375、932×430）同样几乎正好贴边。 */
    var LS_DESIGN_W = 1624;
    var LS_DESIGN_H = 750;

    if (!isLandscapePhone) {
      /* 竖版：宽度 750 设计像素固定，**高度交给 CSS 反算**（#stage:not(.ls)）。
       *
       * 这里只把比例交出去，不再写 `height = vh / scale` 这个像素死值。
       * 原因见 style.css 里 #stage 的注释：iOS PWA standalone 下 clientHeight 有时
       * 比真实视口小，死值会让舞台矮一截、底部露出纯色条。CSS 的 100% 取的是
       * 布局视口，不经过 JS 读数，系统怎么报都不会错。
       * scale 仍然用 availW 算（要减掉左右安全区），所以左右仍由 JS 定位。 */
      scale = availW / CONFIG.DESIGN_WIDTH;
      stageH = vh / scale;
      left = saLeft;
      top = 0;
      stage.style.setProperty('--pt-scale', scale);
      /* 高度不在这里写。以前这里写过一个 `--pt-h`（当时给 #stage.pwa 的 min-height 用），
       * v81 起统一由 `--vp-h` 承担（写在 <html> 上，四层一起读），
       * 留着它只会让人以为"还有一个高度变量在生效"。 */
      stage.style.setProperty('--sa-top', (saTop / scale) + 'px');
      stage.style.setProperty('--sa-bottom', (saBottom / scale) + 'px');
      stage.style.setProperty('--sa-left', '0px');
      stage.style.setProperty('--sa-right', '0px');
    } else {
      /* 横向：**两个方向都铺满**，画布按需要延伸出去。
       *
       * 旧做法是「固定 1624×750、等比居中」，等比缩放必然留白：
       * 屏幕比例 2.17 时还算贴边，一旦是 4:3 平板（1.33）或电脑窗口（1.6），
       * 左右/上下就露出一条底色带 —— 真机上看到的就是「中间一块、四周留白」。
       *
       * 现在改成：高度先行定 scale（保证 750 的设计预算不变），
       * 宽度不够 1624 时退回按宽度定；然后把舞台尺寸反算成「视口 / scale」，
       * 于是 stageW×scale === 视口宽、stageH×scale === 视口高，铺满且不变形。
       * 安全区不再并进居中偏移（那正是两侧露底色的原因），改回写成
       * --sa-left/right 交给 .screen 的 padding —— 背景铺到屏幕边缘，内容避开刘海。 */
      scale = availH / LS_DESIGN_H;
      if (availW / scale < LS_DESIGN_W) scale = availW / LS_DESIGN_W;
      /* 超大屏上限：4K 显示器上按高度铺满会把 28 设计 px 的正文放大到 60+ CSS px，
       * 观感像把手机投屏。超过 1.35 就停手，剩下的用页面底色兜（居中留白可控）。 */
      if (scale > 1.35) scale = 1.35;
      /* ★ 这里**不再**把 stageW/stageH 写成像素。
       *
       * 真机上出现过「横屏底部一条深色带」：舞台尺寸是这一刻算出来的死值，
       * 之后容器变高（浏览器收起底栏、应用内 WebView 换高度）却没收到 resize 事件，
       * 死值就停在旧高度上，底部露出 #viewport 的底色。
       * 现在横向的宽高完全交给 CSS 反算（#stage.ls 的 calc(100% / --ls-scale)），
       * 铺满由样式保证；JS 只负责把比例这一个数字给出去，算错了也只会「密度不准」，
       * 不会露出底来。 */
      stage.style.setProperty('--ls-scale', scale);
      /* 这两个值仍然算出来给后面的判定用（compact-v / ls-tight 看的是设计像素高度），
       * 但不再写进 style。 */
      stageW = vw / scale;
      stageH = vh / scale;
      left = 0;
      top = 0;
      stage.style.setProperty('--sa-top', (saTop / scale) + 'px');
      stage.style.setProperty('--sa-bottom', (saBottom / scale) + 'px');
      stage.style.setProperty('--sa-left', (saLeft / scale) + 'px');
      stage.style.setProperty('--sa-right', (saRight / scale) + 'px');
    }

    /* 最后一道闸：无论前面怎么算，非正 / 非有限的 scale 一律不许写进 DOM。
     * 写进去就是把「算错了」变成「整屏空白」，而后者用户只能靠刷新自救。 */
    if (!isFinite(scale) || scale <= 0) return;

    // 触摸热区兜底：任何机型下按钮/输入框的物理边长都不小于 44px（横屏缩得再小也点得中）
    var tapMin = Math.max(88, Math.ceil(44 / scale));
    stage.style.setProperty('--tap-min', tapMin + 'px');
    /* 横屏走自己的版式（.ls），不再套用桌面宽窗的「缩小的竖版」规则 ——
     * 那套规则会把内容限宽 750 设计像素、居中在 1624 的画布里，
     * 等于把横屏又缩回一根窄柱。 */
    isLandscape = isLandscapePhone;
    stage.classList.toggle('ls', isLandscapePhone);
    /* PWA（添加到主屏幕）标记。CSS 只在 standalone 下启用 `min-height: 100vh` 兜底，
     * 浏览器里不加 —— 工具栏弹出时 100vh 会大于可视高，裁掉底部设计留白。 */
    stage.classList.toggle('pwa', Boolean(standalone));
    /* .wide-stage（桌面宽窗的「缩小的竖版」规则）已经不用了：横版全走 .ls。
     * 仍然显式移除，避免旧缓存里的 class 残留。 */
    stage.classList.remove('wide-stage');

    if (isLandscapePhone) {
      /* 横向：宽高与缩放全部由 CSS 反算（#stage.ls），这里清掉竖版写下的内联值，
       * 否则内联样式优先级更高，会把「铺满」又变回死值。 */
      stage.style.width = '';
      stage.style.height = '';
      stage.style.transform = '';
      stage.style.left = '';
      stage.style.top = '';
    } else {
      /* 竖版同理：宽高与缩放交给 CSS（#stage:not(.ls) 用 --pt-scale 反算），
       * 只保留 left —— 它要减掉左右安全区（竖屏通常为 0，折叠屏/分屏不为 0）。 */
      stage.style.width = '';
      stage.style.height = '';
      stage.style.transform = '';
      stage.style.left = Math.round(left) + 'px';
      stage.style.top = '0px';
    }

    /* 短屏压缩（战绩页 spec §1.3）：纵向预算 < 1500 设计像素时启用 .compact-v，
     * 命中 320×568 / 360×640 竖屏与横屏 1440，不命中 390 及以上竖屏。
     * 只压缩战绩页的间距与字号，不改 DOM 结构。 */
    /* ★ 正在输入时不重算版式档位。
     *
     * #viewport 是 `fixed; inset: 0`，安卓键盘一弹出，布局视口直接被压掉一半，
     * `ResizeObserver` 触发 resize()，stageH 从 1624 掉到 1000 出头 →
     * `compact-v` 被挂上。用户看到的是：在登录页/改名弹窗里一打字，整页字号和间距
     * 突然缩一档；收起键盘又弹回来，一进一出整页抖两下。
     *
     * 为什么判「输入焦点」而不是「键盘高度」：键盘高度各家不同（还有悬浮键盘、
     * 外接键盘、输入法候选栏），而「现在有没有在输入」是确定的事实。
     * 也**不拦 stageH 的缩放计算** —— 屏幕确实变小了，缩小是对的，用户也需要输入框
     * 留在可见区域里；只有「要不要切到紧凑版式」这层纯视觉决策不该跟着键盘动。
     *
     * 两个类一起挡：.ls-tight 看的也是 stageH，同一个原因。 */
    var typing = isTypingTarget(document.activeElement);
    if (!typing) {
      stage.classList.toggle('compact-v', stageH < 1500);
      /* 横屏且纵向预算紧张（≈2.17:1 的手机横屏，stageH 正好 750）：
       * 战绩左栏四块内容 538 > 可视 470，趋势图必然落到折叠线下、要滑才看得到。
       * 手机上「每看一次都要滑」的代价大于趋势图本身的信息量 —— 这张图表达的是
       * 每局净胜走势，而右边列表逐局列了净胜和颜色，信息是重叠的。
       * 宽屏（平板/电脑，stageH 900+）不触发，趋势照常显示。 */
      stage.classList.toggle('ls-tight', isLandscapePhone && stageH < 900);
    }

    /* 组槽排法与牌尺寸跟着舞台高度走。
     * 判定看「组槽真正能用的高度」而不是屏幕有多大：真正决定放不放得下的是
     * 组槽可用高 = stageH − 777 − 圆桌多吃的那 264，跟屏幕多少 dpi 无关。
     *
     * ★ v87：圆桌座位环开着时，stageH 没变但组槽少了 264 —— 拿 stageH 判会得出
     *   「不用 dense」，然后三组硬挤进 552 的高度、第三组被裁。所以这里改走
     *   isDenseAt(可用高)；座位环关掉时它与原来的 isDense(stageH) 结论一致。 */
    lastStageH = stageH;
    lastStageScale = scale;
    /* 座位文字按 scale 反算设计字号（v105）：
     *
     * 圆桌在 800×360 这一档 scale 只有 0.48，而昵称写死 20 设计px → 9.6 CSS px。
     * 「上了桌子但名字读不出来」和「不上桌子」是一样坏的，所以这里不写死设计字号，
     * 而是**按 CSS 目标反算**：
     *   --seat-name   20      → 保证 ≥10.4 CSS px
     *   --seat-score  22/24   → 保证 ≥12 CSS px（分数是桌上第二重要的数）
     *   --seat-label  15      → 保证 ≥7.8 CSS px（「我的分」这类小标，装饰性）
     *   --seat-me     30/34   → 保证 ≥14 CSS px
     * 与 --tap-min 同一个思路：**尺寸跟着缩放走，而不是假设缩放是 1**。
     * 现代机型（scale ≥ 0.525）四个值都等于原设计值，一个像素都不动；
     * 只有被压到 0.44~0.52 的小横屏才会被抬起来（最多 +4 设计px，块高够）。 */
    (function seatText() {
      function bump(base, minCss) { return Math.max(base, Math.ceil(minCss / scale)); }
      var cpt = ringCompact();
      stage.style.setProperty('--seat-name', bump(20, 10.4) + 'px');
      stage.style.setProperty('--seat-score', bump(cpt ? 22 : 24, 12) + 'px');
      stage.style.setProperty('--seat-label', bump(15, 7.8) + 'px');
      stage.style.setProperty('--seat-me', bump(cpt ? 30 : 34, 14) + 'px');
      /* 表情按钮的半径：与 CSS 的 max(88|92, --tap-min) 同一套规则。
       * 两边必须同步 —— 一处写了 max() 另一处写死，按下去就会跳（见 emoji.css 那条注释）。 */
      stage.style.setProperty('--emo-half', (Math.max(cpt ? 92 : 88, tapMin) / 2) + 'px');
    })();
    /* 圆桌多吃的高度只对竖屏成立：横屏的桌子在左栏，组槽仍是右栏那一条，
     * 高度一分不少（v88 的「左桌右盘」）。这里不减，横屏组槽预算才不会被算小。 */
    var ringExtra = 0;
    if (seatRingFlag() && !isLandscape) {
      ringExtra = ringCompact() ? SlotLayout.RING_EXTRA_H_COMPACT : SlotLayout.RING_EXTRA_H;
    }
    slotDense = SlotLayout.isDenseAt(SlotLayout.slotsHeight(stageH) - ringExtra);
    /* 窄横屏 + 圆桌 = 两列两行（v89）。只在圆桌真的开着时切 ——
     * 关掉圆桌（回滚）时组槽必须还是原来的三行，否则「翻开关」会顺带改排法。 */
    slotTwoCol = ringNarrow() && seatRingFlag();
    refreshSlotLayout();

    /* 舞台尺寸变了 → 战绩左栏的可用高也变了，重新判定要不要给它挂渐隐。
     * 竖屏没有 .rp-sumcol 的滚动语义（整页一起滚），这里查不到就直接返回。 */
    syncSumcolFade();

    if (DIAG) {
      var vv = window.visualViewport;
      var scr = window.screen || {};
      var srect = stage.getBoundingClientRect();
      updateDiag([
        '屏 ' + scr.width + '×' + scr.height + '   dpr ' + (window.devicePixelRatio || 1),
        'vp rect ' + vw + '×' + Math.round(vpRect.height) + '   client ' + vp.clientWidth + '×' + vp.clientHeight,
        'inner ' + window.innerWidth + '×' + window.innerHeight
          + '   vv ' + (vv ? Math.round(vv.width) + '×' + Math.round(vv.height) : '-')
          + '   100vh ' + measureUnitH(),
        'sa T' + Math.round(saTop) + ' B' + Math.round(saBottom)
          + ' L' + Math.round(saLeft) + ' R' + Math.round(saRight)
          + '   standalone ' + (standalone ? 'Y' : 'N')
          + '   vh ' + vh + ' 来源 ' + vhSrc,
        /* 这三个高度必须都等于 --vp-h；任何一个更小，就是它在裁舞台（第 33 章反过来
         * 漏掉的那一环：探针只看 stage 的 rect，看不出父级把像素裁掉了）。 */
        '--vp-h ' + vh + '   html ' + Math.round(document.documentElement.getBoundingClientRect().height)
          + '   body ' + Math.round(document.body.getBoundingClientRect().height),
        'stage ' + Math.round(stageW) + '×' + Math.round(stageH)
          + ' → 底 ' + Math.round(srect.bottom) + ' / 屏 ' + (scr.height || '?')
          + '   scale ' + scale.toFixed(3)
      ]);
    }

    /* 调试侧栏跟着 resize 走：档位、舞台、组槽都是这里定下来的。
     * 放在 DIAG 之后 —— 面板要读 lastStageH / lastStageScale，那两行在上面刚写完。 */
    updateDev();
  }

  /* ---------------------------- 座位交互与表情（seatSheetView.js） ----------------------------
   * 点头像弹面板 / 表情收发播报 已拆到 js/seatSheetView.js（554 行）。
   * 只注入 7 项，全是纯查询或纯渲染；面板内部状态（ssPid / ssTab / oppTap）不向外暴露。 */
  var Seat = window.LXW.seatSheetView({
    state: state,
    avatarInner: avatarInner, profileBodyHtml: profileBodyHtml,
    getMe: getMe, flash: flash, stageScale: stageScale
  });
  var PROF_TAP_SEL = Seat.PROF_TAP_SEL, oppTap = Seat.oppTap, bindOppSeatTap = Seat.bindOppSeatTap;
  var emojiTarget = Seat.emojiTarget, emojiLastSend = Seat.emojiLastSend, emojiReady = Seat.emojiReady;
  var emojiFlag = Seat.emojiFlag, seatRect = Seat.seatRect, emojiOthers = Seat.emojiOthers;
  var renderEmojiTargets = Seat.renderEmojiTargets, renderEmojiGrid = Seat.renderEmojiGrid, renderEmojiPhrases = Seat.renderEmojiPhrases;
  var ssPid = Seat.ssPid, ssAnchorEl = Seat.ssAnchorEl, ssTab = Seat.ssTab;
  var ssPlayer = Seat.ssPlayer, seatSheetOpen = Seat.seatSheetOpen, placeSeatSheet = Seat.placeSeatSheet;
  var renderSeatInfo = Seat.renderSeatInfo, setSeatTab = Seat.setSeatTab, renderSeatSheet = Seat.renderSeatSheet;
  var openSeatSheet = Seat.openSeatSheet, closeSeatSheet = Seat.closeSeatSheet, openEmojiSheet = Seat.openEmojiSheet;
  var sendEmojiNow = Seat.sendEmojiNow, onEmojiEvent = Seat.onEmojiEvent, playEmoji = Seat.playEmoji;
  var bindSeatSheet = Seat.bindSeatSheet;

  /* ---------------------------- 事件绑定与初始化 ---------------------------- */
  function bindEvents() {
    /* 这一层只负责「把每一屏的事件交给它自己的函数」，不再写具体绑定。
     * v79 把 570 行的单函数拆成了 12 个分屏 binder，定位成本降了但函数没变短 ——
     * 因为它把 17 个函数装在自己肚子里（仍然 786 行）。
     * v111 把它们抬到模块级（见下一段），于是这里变成一张目录：
     * 改哪一屏，只读下面那一段里的哪一个函数。 */
    bindTableControls();
    bindGuide();
    setupInstallGuide();
    bindProfileCards();
    bindRename();
    bindSeatSheet();
    bindRecordsNav();
    bindAuthScreen();
    bindAccountScreen();
    bindSettleActions();
    bindKeyboard();
    bindViewportAndLifecycle();
  }

  /* ---------------------- 事件绑定的分屏函数（v111 抬到模块级）----------------------
   *
   * 它们原来是 `bindEvents()` 内部的嵌套函数。分屏之后「读」的问题解决了，
   * 但函数本身没短：bindEvents 仍然是 786 行，因为它把 17 个函数**装**在肚子里。
   *
   * 这一轮只做一件事：把它们抬到模块作用域（纯移动 + 去掉 2 格缩进），
   * 于是 bindEvents 变成一张「哪一屏交给谁」的目录。
   * 为什么不顺手拆成多个文件：这些函数几乎都直接读写 game.js 的 state /
   * 渲染缓存 / 弹窗栈，拆文件就得像 v108 那样逐个建注入契约，收益远小于风险。
   *
   * 三个共享状态跟着抬上来，否则抬出去的函数读不到：
   *   GUIDE_TOTAL / guideStep —— 引导步进；achBackScreen —— 成就页返回目标。
   */
  var GUIDE_TOTAL = 4;
  var guideStep = 0;
  var achBackScreen = 'screen-home';

  /* ---------------------- 新手分步引导（P3-8） ----------------------
   * 4 屏、一屏一句。原来的「玩法规则」是一整屏密集文字，写法没问题，
   * 但新玩家第一次上手读不下去 —— 而十点半的口径、王的三重身份，
   * 恰恰是最需要一句一句讲清的地方。
   *
   * 分工：引导负责「让人看懂」，完整规则负责「查细节」，两者不互相替代。
   * 最后一屏的按钮变成「看完整规则」，从这里跳过去。 */

  function renderGuide() {
    var steps = document.querySelectorAll('#guide-body .guide-step');
    for (var i = 0; i < steps.length; i++) {
      if (i === guideStep) steps[i].removeAttribute('hidden');
      else steps[i].setAttribute('hidden', '');
    }
    var dots = $('#guide-dots');
    if (dots) {
      /* 三态：已过 / 当前 / 未到。原来只有 on 一档，进度条看不出「还剩几步」 */
      var dh = '';
      for (var j = 0; j < GUIDE_TOTAL; j++) {
        var dc = j === guideStep ? 'on' : (j < guideStep ? 'done' : '');
        dh += '<i class="' + dc + '"></i>';
      }
      dots.innerHTML = dh;
    }
    /* 第一步没有「上一步」，就真的把它藏掉（display:none），让主按钮占满整行。
     * 早先用 visibility:hidden 占位是为了防按钮横向跳动，代价是第一屏左半边空着，
     * 一个红按钮孤零零挂在右边，看着像布局塌了。 */
    var prev = $('#guide-prev');
    if (prev) prev.hidden = guideStep === 0;
    var next = $('#guide-next');
    if (next) next.textContent = guideStep === GUIDE_TOTAL - 1 ? '看完整规则' : '下一步';
    /* 每步正文长短不同，换步之后重新判断要不要渐隐 */
    syncScrollFade(document.querySelector('#guide-body'));
  }

  function openGuide() {
    guideStep = 0;
    renderGuide();
    showModalEl('guide-modal');
    pushModalState();
    Sfx.play('select');
  }

  function closeGuide() {
    hideModalEl('guide-modal');
    if (ST) ST.write(ST.KEYS.GUIDE_SEEN, '1'); // 隐私模式写不进也无所谓：下次再看一遍引导
  }

  /* 对局主操作：建房 / 加入 / 准备 / 补 AI / 解散 / 离开 / 提交 / 分牌拖拽 / 结算弹窗按钮 */
  function bindTableControls() {
    /* 建房不再直接发请求：先弹「本局打几把」，选完才开房（默认 10）。 */
    $('#btn-create').addEventListener('click', openCreateModal);
    $('#btn-create-confirm').addEventListener('click', onCreateConfirm);
    $('#btn-create-cancel').addEventListener('click', closeCreateModal);
    $('#btn-join').addEventListener('click', onJoin);
    $('#btn-ready').addEventListener('click', onReady);
    /* 「不等他」用委托：按钮是渲染出来的，每次重建，不能逐个绑定。 */
    var trCard = $('#tr-card');
    if (trCard) {
      trCard.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('[data-skip-next]') : null;
        if (!btn) return;
        onSkipStale(btn.getAttribute('data-skip-next'));
      });
    }
    $('#btn-add-bot').addEventListener('click', onAddBot);
    $('#btn-dissolve').addEventListener('click', onProposeDissolve);
    $('#btn-dissolve-agree').addEventListener('click', function () { onVoteDissolve(true); });
    $('#btn-dissolve-reject').addEventListener('click', function () { onVoteDissolve(false); });
    $('#btn-dissolve-cancel').addEventListener('click', function () { onCancelDissolve(); });
    $('#btn-leave').addEventListener('click', onLeave);
    $('#btn-submit').addEventListener('click', onSubmit);
    /* 结算弹窗这颗按钮 = 「下一组」/「继续游戏」。它**不是关闭**：
     * 一幕一组时，点掉当前这一幕应该看到下一幕，而不是把整轮结算都关掉。
     * 倒数计时走的是同一个函数（advanceResult），所以「自动」和「手点」
     * 不会有两条不一样的路。 */
    $('#btn-result-close').addEventListener('click', function () { advanceResult(); });
    /* 特写幕：点一下就结束（不是「点一下跳过这一幕」）。
     * 一局 5 次结算、每次最多 1.7 秒，连出两次大牌型就是 3.4 秒强制观看；
     * 但也不能点掉内容 —— 跳过只把幕收掉，立刻画这一幕的结算卡。 */
    var patBox = $('#pattern-fx');
    if (patBox) {
      patBox.addEventListener('click', function () { if (pat.timer) endPatternFx(); });
    }
    $('#btn-rb-close').addEventListener('click', function () { closeBreakCard(); render(); });
    /* 点遮罩也关：这张卡是「过渡通知」，不是给人做决定的地方 ——
     * 挡住不让关，只会让人以为牌桌卡死了。 */
    $('#round-break-modal').addEventListener('click', function (e) {
      if (e.target === e.currentTarget) { closeBreakCard(); render(); }
    });
    /* 卡上点名字也能看档案：和结算页、排行榜同一套手势 */
    $('#rb-body').addEventListener('click', function (e) {
      var row = e.target.closest ? e.target.closest('.rb-row') : null;
      if (row && row.dataset.pid) openProfile(row.dataset.pid);
    });
    $('#btn-next').addEventListener('click', onNextRound);
    $('#btn-revise').addEventListener('click', onRevise);
    // 分牌：标签选组 + 点手牌直落（主路径），拖拽进组（可选路径）
    $('#group-chips').addEventListener('click', function (e) {
      var chip = e.target.closest ? e.target.closest('.gchip') : null;
      if (!chip) return;
      if (chip.dataset.clear) { onClearGroups(); return; }
      setActiveGroup(chip.dataset.group);
    });
    $('#hand').addEventListener('pointerdown', onHandPointerDown);
    // 槽里的牌也支持拖拽（拖到别的组=换组，拖回手牌区=收回）；委托，因为 innerHTML 会重写
    $('#slots').addEventListener('pointerdown', onHandPointerDown);
    document.addEventListener('pointermove', onHandPointerMove);
    document.addEventListener('pointerup', onHandPointerUp);
    document.addEventListener('pointercancel', onHandPointerCancel);

    /* 槽位点击走委托：整块 innerHTML 会被重写，绑在节点上的监听会跟着一起没 */
    $('#slots').addEventListener('click', function (e) {
      if (!state.room) return;
      // 拖槽牌松手后浏览器补发的 click 要吞掉，否则「拖走/收回」又被当成一次点击再触发
      if (state.suppressTap) { state.suppressTap = false; return; }
      var box = e.target.closest ? e.target.closest('.card-box') : null;
      if (!box) return;
      var key = box.dataset.group;
      if (!key) return;
      if (box.dataset.cardId) {
        var card = cardFromId(state.room, box.dataset.cardId);
        if (card) onSlotCardTap(key, card);
      } else {
        onSlotTap(key);
      }
    });
    // 声音开关：首页角落 + 房间页各一个，都是静态节点，直接绑即可
    var audioBtns = document.querySelectorAll('[data-audio-toggle]');
    for (var ai = 0; ai < audioBtns.length; ai++) {
      audioBtns[ai].addEventListener('click', onToggleAudio);
    }
    $('#btn-back-room').addEventListener('click', onLeave);
    $('#btn-copy').addEventListener('click', onCopy);
    $('#btn-dissolve-game').addEventListener('click', onProposeDissolve);
    /* 对局页以前没有「离开」入口：想退出只能关掉页面，等 90 秒被判弃局。
     * 「发起解散」和「自己离开」是两件事——解散要全员同意，离开只用自己决定。 */
    $('#btn-leave-game').addEventListener('click', onLeave);
  }

  /* 新手引导的四个按钮 + 首次自动弹一次（步进状态在 bindEvents 作用域里，见上） */
  function bindGuide() {
    $('#btn-rules').addEventListener('click', openGuide);
    $('#guide-skip').addEventListener('click', closeGuide);
    $('#guide-prev').addEventListener('click', function () {
      if (guideStep > 0) { guideStep--; renderGuide(); Sfx.play('select'); }
    });
    $('#guide-next').addEventListener('click', function () {
      if (guideStep < GUIDE_TOTAL - 1) {
        guideStep++;
        renderGuide();
        Sfx.play('select');
        return;
      }
      /* 引导与完整规则互斥：先关引导，再用统一入口打开规则层。
       * 规则层此刻本来就是关着的，所以 showModalEl 走的是「从关到开」那一下，焦点归还目标会正常记下。 */
      closeGuide();
      showModalEl('rules-modal');
      pushModalState();
    });

    /* 首次进首页自动弹一次。
     * 延迟 1.2 秒而不是立刻：先让首屏渲染和首页动画走完，上来就盖一层弹窗很凶。
     * 已经清过缓存的老玩家也会被弹一次，这是可接受的代价 —— 一次点击就能关掉。 */
    try {
      if (!(ST && ST.read(ST.KEYS.GUIDE_SEEN, ''))) {
        setTimeout(function () {
          if (state.roomId) return;                                        // 已经在房间里就不打扰
          if (!$('#guide-modal').classList.contains('hidden')) return;      // 已经开着（用户手动点了）
          openGuide();
        }, 1200);
      }
    } catch (e) { /* 隐私模式禁 storage：不自动弹，但「玩法规则」按钮照常可用 */ }

    $('#btn-rules-close').addEventListener('click', function () {
      hideModalEl('rules-modal');
    });
  }

  /* 安装引导条：三种环境的行为各在各的分支里，这里只做绑定 */
  function setupInstallGuide() {
    /* ---------------------------- PWA 安装引导 ----------------------------
     * 以前完全没有这一块：页面能装成 App（manifest + SW + 图标都齐），
     * 但界面上没有任何入口，玩家永远只会把它当网页用，每次都要重新打开链接。
     *
     * 三种情况分开处理，因为「怎么装」在两端的答案完全不同：
     *   · Chrome / Edge：收到 beforeinstallprompt（index.html 头部已提前接住），
     *     点「安装」直接弹系统安装框 —— 这是一条真正的一键路径；
     *   · iOS Safari：没有这个事件，也不允许页面主动触发安装，
     *     只能告诉用户「分享 → 添加到主屏幕」。所以按钮文案改成「怎么做」，点开展开步骤；
     *   · 微信内置浏览器：装不了（它自己的 X5 内核），干脆不显示，免得教用户做一件做不到的事。
     * 已经装过（独立窗口运行）就永远不显示。 */
    (function setupInstallGuide() {
      var bar = $('#install-bar');
      var textEl = $('#install-text');
      var goEl = $('#install-go');
      var stepsEl = $('#install-steps');
      if (!bar || !textEl || !goEl) return;

      var DISMISS_KEY = ST ? ST.KEYS.INSTALL_DISMISSED : 'lxw_install_dismissed_v1';
      var DISMISS_MS = 30 * 24 * 60 * 60 * 1000;   // 「不再提示」按 30 天算，不是永久

      function standalone() {
        try {
          if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
        } catch (e) { /* 老内核没有 matchMedia 也不影响后面的 navigator.standalone */ }
        return navigator.standalone === true;   // iOS 专有：从主屏幕图标启动
      }
      function ua() { return navigator.userAgent || ''; }
      function isWeChat() { return /MicroMessenger/i.test(ua()); }
      function isIOS() {
        if (/iPad|iPhone|iPod/.test(ua())) return true;
        /* iPadOS 13+ 的 UA 伪装成 macOS，只能靠「有触摸」来认 */
        return /Macintosh/.test(ua()) && navigator.maxTouchPoints > 1;
      }
      function dismissed() {
        var t = Number(ST ? ST.read(DISMISS_KEY, '') : '') || 0;
        return t > 0 && (Date.now() - t) < DISMISS_MS;
      }

      var mode = '';   // 'prompt' | 'ios'

      function render() {
        if (!mode || standalone() || dismissed()) { bar.classList.add('hidden'); return; }
        if (mode === 'prompt') {
          textEl.textContent = '添加到桌面，下次一点就开';
          goEl.textContent = '安装';
          goEl.classList.remove('hidden');
        } else {
          textEl.textContent = '添加到主屏幕，像 App 一样打开';
          goEl.textContent = '怎么做';
          goEl.classList.remove('hidden');
        }
        bar.classList.remove('hidden');
      }

      /* 展开 / 收起「分享 → 添加到主屏幕」的分步说明。
       * force=true 表示直接展开（用于 prompt() 被浏览器拒绝时的兜底）。 */
      function showSteps(force) {
        if (!stepsEl) return;
        var open = force === true || stepsEl.classList.contains('hidden');
        stepsEl.textContent = open
          ? '① 点浏览器底部工具栏的「分享」图标（方框 + 向上箭头）；'
            + '② 在弹出菜单里往下找「添加到主屏幕」；③ 点右上角「添加」。'
          : '';
        stepsEl.classList.toggle('hidden', !open);
        textEl.textContent = open ? '加到桌面只要三步：' : '添加到主屏幕，像 App 一样打开';
      }

      function usePrompt() {
        var ev = window.__lxwInstallPrompt;
        if (!ev || typeof ev.prompt !== 'function') return false;
        var ret = null;
        try { ret = ev.prompt(); } catch (e) { return false; }
        /* ★ prompt() 在 Chrome 里是「返回 Promise、被拒绝时抛 NotAllowedError」。
         * 只包 try/catch 抓不到那种异步拒绝 —— 它会变成一条未处理的 Promise 拒绝
         *（实测：headless 里点一下就冒一条 NotAllowedError，还会被 errorReport 上报）。
         * 拒绝通常意味着「这次点击没被算作用户手势」，此时退回文字步骤，别让按钮点了没反应。 */
        if (ret && typeof ret.catch === 'function') {
          ret.catch(function () { showSteps(true); });
        }
        /* userChoice 只有 Chrome 系给。选「稍后」不要当成永久拒绝 ——
         * 只在本次会话里收起，下次打开还能再提示一次。 */
        if (ev.userChoice && typeof ev.userChoice.then === 'function') {
          ev.userChoice.then(function (choice) {
            if (choice && choice.outcome === 'accepted') window.__lxwInstallPrompt = null;
            bar.classList.add('hidden');
          }).catch(function () { /* 拿不到选择结果就什么都不做 */ });
        } else {
          bar.classList.add('hidden');
        }
        return true;
      }

      $('#btn-install').addEventListener('click', function () {
        Sfx.play('select');
        if (mode === 'prompt' && usePrompt()) return;
        /* iOS（或还没拿到事件）：展开文字步骤，再点一次收起 */
        showSteps(false);
      });
      $('#btn-install-x').addEventListener('click', function () {
        bar.classList.add('hidden');
        if (ST) ST.write(DISMISS_KEY, String(Date.now())); // 隐私模式：下次还会出现
      });

      /* 事件可能比脚本晚到（SW 装好之后才满足安装条件），所以监听而不是只在启动时查一次 */
      window.addEventListener('lxw:installable', function () {
        mode = 'prompt';
        render();
      });
      window.addEventListener('appinstalled', function () {
        mode = '';
        bar.classList.add('hidden');
        if (ST) ST.remove(DISMISS_KEY);
        flash('已添加到桌面');
      });

      if (standalone()) return;                 // 已经装过了，什么都不用做
      if (isWeChat()) return;                   // 微信里装不了，别教用户做白工
      if (window.__lxwInstallPrompt) mode = 'prompt';
      /* iOS 上任何浏览器都没有 beforeinstallprompt，统一走「分享 → 添加到主屏幕」那一套；
       * 安卓上没拿到事件 = 还不满足安装条件（比如没走 HTTPS），先不显示，免得点了一下没反应。 */
      else if (isIOS()) mode = 'ios';
      else return;
      render();
    })();
  }

  /* 玩家战绩卡 / 通用确认框 / 爆点拦截框 */
  function bindProfileCards() {
    /* 玩家战绩卡（三处入口共用一张卡）：
     *   房间页座位卡 / 对局页对手座位卡 / 结束页玩家行 —— 都是委托监听，避免重渲染丢绑定 */
    $('#btn-profile-close').addEventListener('click', closeProfile);
    $('#profile-modal').addEventListener('click', function (e) {
      if (e.target === e.currentTarget) closeProfile();   // 点遮罩关闭
    });
    $('#room-players').addEventListener('click', function (e) {
      /* 座位卡上的行为只有一条规则：点谁 = 看谁的战绩，**包括自己**。
       * 以前是「点自己 = 改昵称、点别人 = 看战绩」—— 同一张卡两种行为，
       * 玩家点了自己的名字想看看战绩，弹出来的却是改名框。
       * 改名挪到卡片角落那支铅笔（.player-edit），先拦它。 */
      var edit = e.target.closest ? e.target.closest('.player-edit') : null;
      if (edit) { openRename(); return; }
      var row = e.target.closest ? e.target.closest('.player-row') : null;
      if (row && row.dataset.pid) openProfile(row.dataset.pid);
    });
    /* 结算行的两个手势（结算页和「上一局结算」弹窗同一套）：
     *   头像 → 看这个人（和牌桌上点座位是同一个手势，同一个入口）
     *   行的其他地方 → 看**这一把**的过程（见 openReplayHere）
     * 之所以把「档案」收窄到只剩头像：整行原来都在跳档案，而结算页上
     * 十次有九次是想确认刚才那把怎么算的。头像在行里只占最左边 56px，
     * 「查人」得瞄着点，「查过程」随手点哪里都行 —— 按真实意图分配面积。 */
    function bindSettleRowTap(bodySel) {
      var body = $(bodySel);
      if (!body) return;
      body.addEventListener('click', function (e) {
        if (!e.target.closest) return;
        var row = e.target.closest('.settle-row');
        if (!row) return;
        var rank = e.target.closest('.settle-rank');
        if (rank && row.dataset.pid) { openProfile(row.dataset.pid); return; }
        openReplayHere();
      });
      /* 键盘同一套：头像是个 role=button，回车/空格等价于点它。
       * 行本身不抢焦点 —— 一行里有两个动作，让 Tab 停在「行」上说不清是哪个。 */
      body.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
        if (!e.target.closest) return;
        var rank = e.target.closest('.settle-rank');
        if (!rank) return;
        var row = rank.closest('.settle-row');
        if (!row || !row.dataset.pid) return;
        e.preventDefault();   // 空格不滚屏
        openProfile(row.dataset.pid);
      });
    }
    bindSettleRowTap('#settle-body');
    bindSettleRowTap('#prev-result-body');
    bindOppSeatTap();
    $('#btn-confirm-ok').addEventListener('click', onConfirmOk);
    $('#btn-confirm-cancel').addEventListener('click', closeConfirm);
    /* 爆点拦截框唯一的出口：合上、回到十点半那一组继续改。
     * 没有第二个按钮 —— 见 blockBustSubmit 上方关于「不留后路」的说明。 */
    $('#btn-bust-fix').addEventListener('click', function () {
      hideModalEl('bust-modal');
      state.activeGroup = 'tenhalf';
      render();
      nudgeTenHalf();
    });
  }

  function bindRename() {
    /* 房内改昵称 */
    $('#btn-rename-ok').addEventListener('click', onRenameOk);
    $('#btn-rename-cancel').addEventListener('click', closeRename);
    $('#rename-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); onRenameOk(); }
    });
    $('#rename-modal').addEventListener('click', function (e) {
      if (e.target === e.currentTarget) closeRename();   // 点遮罩关闭
    });
  }

  /* ---------------------------- 成就页（v109） ----------------------------
   * 数据来源：RoomStore.getProfile(pid)。服务端档案里带 ach 桶
   * （见 hub.getProfile 的注释），自己看自己也走同一条路，只是标题不同。
   *
   * 为什么不复用 /api/me/records：那条路只在 HTTP 登录态下可用，
   * 而成就页从房间里的座位卡也能打开 —— 那时未必还连着 HTTP 会话，
   * 但 WS 一定是连着的（否则看不到座位）。
   */

  /* 当前停在哪一屏。用来决定「从成就页返回时回到哪儿」：
   * 从首页进来就回首页，从座位卡进来就回房间 —— 玩家点的是座位上的头像，
   * 回到首页等于把他踢出了房间。 */
  function currentScreenId() {
    var ids = ['screen-home', 'screen-room', 'screen-game', 'screen-settle', 'screen-records', 'screen-rank'];
    for (var i = 0; i < ids.length; i++) {
      /* 别用 el 当变量名：el 是本文件的 DOM 构造函数，遮蔽它会让
       * ui.test.js 的「代码卫生」守卫变红，也更容易在改动时误用。 */
      var scr = $('#' + ids[i]);
      if (scr && !scr.classList.contains('hidden')) return ids[i];
    }
    return 'screen-home';
  }

  function openAchievements(pid, from) {
    var isMe = !pid || pid === state.myId;
    achBackScreen = from || 'screen-home';
    $('#ach-title').textContent = isMe ? '我的成就' : '成就';
    $('#ach-body').innerHTML = '<p class="rank-tip">正在加载…</p>';
    showScreen('screen-achievements');
    if (typeof RoomStore === 'undefined' || !RoomStore.canQueryProfile || !RoomStore.canQueryProfile()) {
      $('#ach-body').innerHTML = '<p class="rank-tip">本地演示模式看不了成就。</p>';
      return;
    }
    RoomStore.getProfile(pid || state.myId).then(function (res) {
      /* 加载期间可能已经返回了。这时整屏已切走，再往里写就是往隐藏页写 ——
       * 不报错，但下次进来会先闪一下上一次的内容。 */
      if (state.screen !== 'achievements') return;
      if (!res || res.ok === false) {
        $('#ach-body').innerHTML = '<p class="rank-tip">' + esc((res && res.error) || '加载失败') + '</p>';
        return;
      }
      var pr = res.profile;
      if (!pr) {
        $('#ach-body').innerHTML = '<p class="rank-tip">还没有数据，打完一局就有了。</p>';
        return;
      }
      if (!AV) {                       // 老客户端缓存里没有这个模块：明确告知，别白屏
        $('#ach-body').innerHTML = '<p class="rank-tip">页面版本太旧，刷新一次再看。</p>';
        return;
      }
      $('#ach-body').innerHTML = AV.pageHtml(pr, window.Ach, { isMe: isMe });
      if ($('#ach-scroll')) $('#ach-scroll').scrollTop = 0;
    }).catch(function () {
      if (state.screen !== 'achievements') return;
      $('#ach-body').innerHTML = '<p class="rank-tip">网络异常，稍后再试。</p>';
    });
  }

  function closeAchievements() {
    showScreen(achBackScreen || 'screen-home');
  }

  /* 战绩页与排行榜入口（榜单行用委托：innerHTML 每次重写） */
  function bindRecordsNav() {
    /* 战绩页（L0 本机战绩） */
    $('#btn-records-home').addEventListener('click', function () { openRecords('home'); });
    $('#btn-rank-home').addEventListener('click', openRank);
    $('#btn-rank-back').addEventListener('click', closeRank);
    /* 成就页：入口在战绩页标题栏右上角（v109 把首页那个第 5 格合并过来了）。
     * 传 'screen-records' 作为返回目标 —— 玩家是从战绩页点进来的，返回要回那儿。 */
    $('#btn-ach-from-records').addEventListener('click', function () {
      openAchievements(state.myId, 'screen-records');
    });
    $('#btn-ach-back').addEventListener('click', closeAchievements);
    /* 成就页：座位信息档底部那一行（内容由 profileBodyHtml 动态生成，所以用委托）。
     * 挂在 document 上而不是面板上：档案卡有两个宿主（.profile-box / .ss-info），
     * 分别绑一次会漏掉以后新加的第三个。 */
    document.addEventListener('click', function (e) {
      var hit = e.target && e.target.closest ? e.target.closest('[data-ach-open]') : null;
      if (!hit) return;
      var pid = hit.getAttribute('data-ach-open');
      if (!pid) return;
      /* 先把座位面板关掉：成就页是整屏，留一个浮层压在上面会挡住返回按钮。 */
      try { closeSeatSheet(); } catch (err) { /* 面板本来就没开 */ }
      openAchievements(pid, currentScreenId());
    });
    /* 排行榜行 → 看这个人的云端档案。委托监听：榜单每次拉取都整块 innerHTML 重写，
     * 逐行绑事件会在第一次刷新后全部失效（房间座位卡当初就踩过这个坑）。
     * 榜尾那行「我在 50 名外」也带 data-pid，点自己就看我自己的档案。 */
    $('#rank-list').addEventListener('click', function (e) {
      var row = e.target.closest ? e.target.closest('.rank-row') : null;
      if (row && row.dataset.pid) openProfile(row.dataset.pid, row.dataset.nick);
    });
  }

  function bindAuthScreen() {
    /* 登录 / 注册：登录与注册两个 tab 都用事件委托，
     * 因为底部提示那行是 innerHTML 动态替换的，直接绑会在替换后失效。 */
    $('#screen-auth').addEventListener('click', function (e) {
      var tab = e.target.closest ? e.target.closest('[data-auth-tab]') : null;
      if (tab) { setAuthMode(tab.getAttribute('data-auth-tab')); Sfx.play('select'); }
    });
    $('#btn-auth-submit').addEventListener('click', submitAuth);
    /* 忘记密码：就地展开一段说明，不弹窗。
     * 这个游戏不绑手机号、没有邮箱，服务端也没有任何自助找回的接口 ——
     * 与其让玩家反复试密码、以为号废了，不如直接告诉他「找管理员重置，战绩不丢」。 */
    $('#btn-forgot').addEventListener('click', function () {
      var box = $('#auth-forgot-note');
      var open = box.classList.contains('hidden');
      box.classList.toggle('hidden', !open);
      Sfx.play('select');
    });
    var authPass = $('#auth-pass');
    authPass.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submitAuth(); }
    });
    $('#auth-name').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); authPass.focus(); }
    });
  }

  function bindAccountScreen() {
    /* 我的账号 */
    $('#btn-account').addEventListener('click', openAccount);
    $('#btn-acc-close').addEventListener('click', closeAccount);
    $('#account-modal').addEventListener('click', function (e) {
      if (e.target === e.currentTarget) closeAccount();
    });
    $('#btn-acc-pwd').addEventListener('click', openPwdModal);
    $('#btn-acc-avatar').addEventListener('click', openAvatarModal);
    $('#btn-av-close').addEventListener('click', closeAvatarModal);
    $('#avatar-modal').addEventListener('click', function (e) {
      if (e.target === e.currentTarget) closeAvatarModal();
    });
    /* 委托而不是给 48 个格子各挂一个监听：
     * 格子是每次打开时重画的，直接绑会随重画一起失效（或者要在重画时重绑一遍）。 */
    $('#av-grid').addEventListener('click', function (e) {
      var cell = e.target.closest ? e.target.closest('[data-av]') : null;
      if (cell) pickAvatar(cell.getAttribute('data-av'));
    });
    $('#btn-av-upload').addEventListener('click', function () {
      var f = $('#av-file');
      if (f) f.click();
    });
    $('#av-file').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      /* 选完立刻清空 input.value：不清的话「同一个文件再选一次」不会触发 change，
       * 用户会以为点了没反应。 */
      try { e.target.value = ''; } catch (err) { /* 忽略 */ }
      if (f) pickAvatarPhoto(f);
    });
    $('#btn-av-drop').addEventListener('click', dropAvatarPhoto);
    $('#btn-av-random').addEventListener('click', function () {
      if (typeof Avatar === 'undefined') return;
      pickAvatar('a' + Math.floor(Math.random() * Avatar.COUNT));
    });
    $('#btn-acc-logout').addEventListener('click', onLogout);
    $('#btn-acc-delete').addEventListener('click', onDeleteAccount);
    $('#btn-pwd-ok').addEventListener('click', submitPwd);
    $('#btn-pwd-cancel').addEventListener('click', closePwdModal);
    $('#pwd-modal').addEventListener('click', function (e) {
      if (e.target === e.currentTarget) closePwdModal();
    });
    $('#pwd-new').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submitPwd(); }
    });
  }

  /* 结算页与回放 / 分享 / 上一把成绩 */
  function bindSettleActions() {
    $('#btn-records').addEventListener('click', function () { openRecords('settle'); });
    $('#btn-share').addEventListener('click', onShare);
    $('#btn-replay').addEventListener('click', function () { openReplay(); });
    /* 就位态的回放入口。按钮本身会被 renderRoom 显示/隐藏，
     * 监听在初始化时就绑上（屏幕是常驻的，只是切换显隐）。 */
    $('#btn-prev-replay').addEventListener('click', function () { openReplay({ prev: true }); });
    $('#btn-prev-result').addEventListener('click', openPrevResult);
    $('#btn-prev-result-close').addEventListener('click', closePrevResult);
    /* 点遮罩关闭，和回放弹窗同一套。判定必须用 e.target === e.currentTarget：
     * 监听挂在 .modal 上，点在卡片内部时 target 会变成卡片里的某个元素。 */
    $('#prev-result-modal').addEventListener('click', function (e) {
      if (e.target === e.currentTarget) closePrevResult();
    });
    /* 弹窗里的玩家行也能点 —— 结算页能点，这里为什么不能点。
     * 手势与结算页完全一致（头像 = 档案，行 = 这一把的过程），
     * 所以两边的监听是同一个函数（bindSettleRowTap），不在这里重复绑。 */
    $('#btn-next-back').addEventListener('click', onNextBack);
    $('#btn-replay-close').addEventListener('click', closeReplay);
    /* 点遮罩关闭。全站 12 个弹窗里，内容型的那几个（分享图、玩家档案、账号卡、
     * 改密码、改昵称）早就支持点外面关，只有回放是例外 —— 它是最该支持的那种：
     * 玩家只是想瞄一眼过程，看完随手点一下空白处就该退出去。
     * 判定必须用 e.target === e.currentTarget：监听挂在 .modal 上，
     * 点在卡片内部时 target 会变成卡片里的某个元素，否则点内容也会误关。 */
    $('#replay-modal').addEventListener('click', function (e) {
      if (e.target === e.currentTarget) closeReplay();
    });
    $('#btn-share-save').addEventListener('click', onShareSave);
    $('#btn-share-close').addEventListener('click', closeShare);
    $('#share-modal').addEventListener('click', function (e) {
      if (e.target === e.currentTarget) closeShare();
    });
    $('#btn-records-back').addEventListener('click', closeRecords);
    $('#btn-records-create').addEventListener('click', onCreateFromRecords);
    $('#btn-records-clear').addEventListener('click', openClearModal);
    $('#btn-records-clear-ok').addEventListener('click', onClearConfirmed);
    $('#btn-records-clear-cancel').addEventListener('click', closeClearModal);
    $('#room-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') onJoin();
    });
    $('#nickname-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') onCreate();
    });
    // 每次输入即时持久化昵称：SW 接管导致首访后页面自动 reload 时，
    // 会话内刚输入的昵称能从 session 那份读回，避免被清成默认「玩家xxxx」。
    $('#nickname-input').addEventListener('input', function (e) {
      setNickname((e.target.value || '').trim());
    });
  }

  /* Esc 关最上层弹窗（顺序即层级顺序）+ Tab 圈定 + 返回键 */
  function bindKeyboard() {
    // Esc / 移动端返回键关闭弹窗（通用确认、玩法规则、清除战绩、玩家战绩卡、改昵称）
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      /* 爆点拦截框排最前：它只在提交被挡下的那一刻出现，是当时唯一的一层。 */
      if (!$('#bust-modal').classList.contains('hidden')) { hideModalEl('bust-modal'); return; }
      if (!$('#profile-modal').classList.contains('hidden')) { closeProfile(); return; }
      if (!$('#rename-modal').classList.contains('hidden')) { closeRename(); return; }
      if (!$('#records-clear-modal').classList.contains('hidden')) { closeClearModal(); return; }
      /* 建房选把数：只在首页，是最外层的那一个（进来就没人叠它） */
      if (!$('#create-modal').classList.contains('hidden')) { closeCreateModal(); return; }
      if (!$('#confirm-modal').classList.contains('hidden')) { closeConfirm(); return; }
      /* 引导和完整规则会互相切换，所以先关引导：它更可能是当前那一层。
       * 关掉即视为「看过了」，不再自动弹 —— 用户按了 Esc 就是明确表态。 */
      if (!$('#guide-modal').classList.contains('hidden')) { closeGuide(); return; }
      if (!$('#replay-modal').classList.contains('hidden')) { closeReplay(); return; }
      /* 和回放同一层：两个都是「瞄一眼就退」的内容型弹窗，放在同一位置，
       * 不会因为它们互相叠而抢先后。 */
      if (!$('#prev-result-modal').classList.contains('hidden')) { closePrevResult(); return; }
      if (!$('#rules-modal').classList.contains('hidden')) { hideModalEl('rules-modal'); return; }
      /* 换头像叠在账号卡上面，所以要先于 account 判一次 */
      if (!$('#avatar-modal').classList.contains('hidden')) { closeAvatarModal(); return; }
      /* 补上这两个：以前 Esc 关不掉改密码和账号卡，键盘用户只能去点按钮。
       * pwd 在前，因为它叠在账号卡上面；只加不删，上面几条的优先级一点没动。 */
      if (!$('#pwd-modal').classList.contains('hidden')) { closePwdModal(); return; }
      if (!$('#account-modal').classList.contains('hidden')) { closeAccount(); return; }
      /* 交替卡与结算弹窗原来**不在** Esc 链里（结算是必看的，关掉等于跳过）。
       * v89 改成一幕一组后，Esc 的含义变成「下一幕」—— 跳过的只是一次等待，
       * 不是跳过内容；而交替卡本来就是过渡通知，直接关掉。 */
      if (!$('#round-break-modal').classList.contains('hidden')) { closeBreakCard(); render(); return; }
      if (!$('#result-modal').classList.contains('hidden')) { advanceResult(); return; }
    });

    /* Tab 圈定：弹窗打开时把 Tab / Shift+Tab 关在「最上层那个弹窗」里。
     * 不加这一段的话，键盘用户按两下 Tab 焦点就跑到弹窗背后的首页按钮上了 ——
     * 屏幕上还显示着弹窗、焦点却在背后，这是最难自己发现的一类可用性问题
     *（眼睛看不见焦点，读屏又已经不在念弹窗了）。
     * 用 capture 阶段：弹窗内部的输入框自己处理按键时，Tab 仍然先过这里。 */
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      var id = topModalId();
      if (!id) return;
      var list = modalFocusables($('#' + id));
      if (!list.length) return;
      var first = list[0];
      var last = list[list.length - 1];
      var idx = -1;
      for (var i = 0; i < list.length; i++) if (list[i] === document.activeElement) { idx = i; break; }
      /* idx < 0 = 焦点根本不在弹窗里（刚打开还没搬进去、或用户点了背景）：
       * 也要接住 —— 一个 Tab 就该回到弹窗里，而不是从页面顶部重新开始。 */
      if (e.shiftKey) {
        if (idx <= 0) { e.preventDefault(); focusEl(last); }
      } else if (idx < 0 || idx === list.length - 1) {
        e.preventDefault();
        focusEl(first);
      }
    }, true);
    window.addEventListener('popstate', function () {
      Modal.setModalStatePushed(false);
      /* 顺序有讲究：先关上层（确认框、改密码），再关下层（账号弹窗）。
       * 只关一部分会留下「按返回没反应」的死状态——账号弹窗是最后加的，
       * 之前漏在这里，手机上按返回键关不掉它。 */
      closeConfirm();
      closePwdModal();
      closeProfile();
      closeRename();
      closeClearModal();
      closeCreateModal();
      closeAccount();
      closeGuide();
      closeReplay();
      hideModalEl('rules-modal');
    });
  }

  /* 视口尺寸自愈与前后台切换：只重算缩放，不碰状态 */
  function bindViewportAndLifecycle() {
    // 移动端自动播放限制：第一次触摸解锁音频
    document.addEventListener('touchstart', function () { Sfx.unlock(); }, { passive: true });
    document.addEventListener('mousedown', function () { Sfx.unlock(); });

    // 断网/恢复：顶部提示条跟着切（WS 自己的重连提示在 init 里另挂）
    window.addEventListener('offline', function () {
      setNetBanner(false);
      flash('网络已断开');
    });
    window.addEventListener('online', function () {
      setNetBanner(true);
      flash('网络已恢复');
    });

    window.addEventListener('resize', resize);
    window.addEventListener('resize', updateOppScrollHint);
    window.addEventListener('orientationchange', function () { setTimeout(resize, 200); });

    /* 输入框失焦后再量一次。
     *
     * resize() 在有焦点时**故意不切** compact-v / ls-tight（见那里的说明）。
     * 但键盘收起不一定派发 resize（iOS 尤其不可靠），若一直没人再量一次，
     * 那一次被跳过的档位判定就永久丢了 —— 小屏手机上会一直停在「非紧凑」版式。
     * 这里在焦点离开输入控件后补一次，代价是一次 resize()，不涉及任何状态变化。 */
    document.addEventListener('blur', function (e) {
      if (isTypingTarget(e.target)) setTimeout(resize, 60);   // 等布局从键盘态恢复
    }, true);

    /* 视口尺寸自愈：容器变了就重算，不管 resize 事件有没有派发。
     *
     * 真机上「横屏底部一条深色带」的成因就是这个缺口：浏览器收起底栏、应用内 WebView
     * 改高度、分屏拖拽、PWA 从后台恢复，都可能让视口变大而**不派发 resize**。
     * 舞台原来是用当时算出的像素值写死的，没人重算就停在旧高度。
     * 这里用 ResizeObserver 盯 #viewport 自己的盒子 —— 容器一变必然触发，与事件无关。 */
    function syncViewportSize() {
      var vp = document.getElementById('viewport');
      if (!vp) return;
      if (vp.clientWidth === lastVpW && vp.clientHeight === lastVpH) return;
      resize();
      updateOppScrollHint();
    }
    if (typeof ResizeObserver === 'function') {
      var vpEl = document.getElementById('viewport');
      if (vpEl) {
        new ResizeObserver(function () {
          clearTimeout(vpWatchTimer);
          vpWatchTimer = setTimeout(syncViewportSize, 30);
        }).observe(vpEl);
      }
      if (window.visualViewport && window.visualViewport.addEventListener) {
        /* visualViewport 与布局视口不总是同步（捏合、键盘、地址栏收放），
         * 它变了但布局没变时不用重排，syncViewportSize 里的幂等判断会挡住。 */
        window.visualViewport.addEventListener('resize', syncViewportSize);
        window.visualViewport.addEventListener('scroll', syncViewportSize);
      }
      /* 回到前台必须重算一次缩放。
       * iOS 上「切到 Safari、再切回 Edge / PWA」这类动作会改变视口高度（地址栏收放、
       * 安全区重算），却**不一定触发 resize 事件**；而缩放是一组按当时视口算死的像素值。
       * 不重算的后果是牌桌被裁掉一截或整体缩小。反过来说，如果后台期间渲染树被系统回收、
       * 恢复那一帧尺寸读到 0，这次重算也正好把上一次的错值纠正回来（resize 内部对 0 值有重试）。 */
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState !== 'visible') return;
        resize();
        /* 后台期间 setInterval 会被浏览器节流（最狠能到一分钟一次），
         * 切回来时必须立刻把倒计时刷成真实剩余时间 —— 否则玩家看到的是过期数字：
         * 显示「还剩 50 秒」，其实早过了 60 秒的点，人已经被判弃权。
         * 这正好是「一部手机切三个容器」的常态，不能靠 interval 自己醒过来。 */
        tickSplitTimer();
      });
      /* bfcache 复活（点了页面里的外链再返回）同理：DOM 原样还在，但视口是旧的 */
      window.addEventListener('pageshow', function (e) {
        if (e && e.persisted) resize();
      });
      // 对手座位条滚动（scroll 不冒泡，用 capture 阶段捕获）时刷新左右渐隐
      document.addEventListener('scroll', function (e) {
        if (e.target && e.target.classList && e.target.classList.contains('gt-opps')) {
          updateOppScrollHint();
        }
      }, true);

      // 双保险：SW 接管会触发 controllerchange → 页面 reload（index.html 内联脚本），
      // 本监听器注册更早、先执行，reload 前把昵称输入框当前值再持久化一次。
      if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('controllerchange', function () {
          var input = $('#nickname-input');
          if (input) setNickname((input.value || '').trim());
        });
      }
    }
  }

  function init() {
    state.myId = getMyId();
    /* 禁页面缩放要早于任何手势发生，所以放在 init 最前面（早于 bindEvents）
     * 而不是等进对局页 —— 首页被捏合放大后，一进游戏就是放大的状态，
     * 那时再锁已经晚了：玩家得先手动捏回去。 */
    lockPageZoom();
    bindEvents();
    /* 准备态的节点搬迁必须在 bindEvents 之后、第一次 render 之前：
     * 先绑再搬，事件跟着元素走（搬的是同一个节点，不是副本），一次都不用重绑。 */
    mountTableReady();
    syncAudioToggles();   // 上次关过音乐的话，图标一进来就得是「关」的样子
    setNetBanner(!isOffline()); // 冷启动就是断网（PWA 常见）时先亮提示
    resize();
    watchSlotResize();
    setAuthMode('login');

    // 联机断线（瞬断/抖动）：提示正在重连，不退出当前场景（重连由 RoomStore 内部负责）
    RoomStore.onDisconnect(function () {
      flash('网络波动，正在重连…');
    });
    // 彻底掉线：服务端给了原因就照说，否则按超时处理
    RoomStore.onOffline(function (reason) {
      if (state.roomId || state.room) {
        cleanupRoom();
        showScreen('screen-home');
      }
      flash(reason || '掉线时间过长，已退出本局');
    });
    /* 连接级致命错误：握手鉴权被拒、或被管理员停用/删号后踢下线。
     * 这类情况重连多少次都没用，必须清掉本地会话回登录页，
     * 否则界面会停在一个再也连不上的首页上，一句话都不解释。 */
    RoomStore.onFatal(function (msg) {
      if (state.room || state.roomId) cleanupRoom();
      AuthStore.logout();
      state.myId = '';
      gotoAuth(msg);
    });

    /* 本地演示模式（?mode=local / file://）跑的是纯本地状态机，没有服务端、
     * 也没有账号。别用它挡登录墙——否则演示模式彻底进不去了。 */
    if (demoMultiTab()) {
      state.myId = getMyId();
      showScreen('screen-home');
      return;
    }

    // 没有登录态 → 首屏就是登录页，别让玩家点了「创建房间」才发现没身份
    if (!AuthStore.session()) {
      showScreen('screen-auth');
      return;
    }

    // 有登录态 → 先给首页（瞬间可用），再后台向服务端确认令牌是否还有效。
    // 弱网/离线时**不踢人**：只有明确 401/403 才回登录页。
    var nick = getNickname();
    $('#nickname-input').value = nick || defaultNick();
    showScreen('screen-home');

    AuthStore.refresh().then(function (st) {
      if (st === 'expired') { gotoAuth(AuthStore.lastError() || '登录已失效，请重新登录'); return; }
      var fresh = getNickname();
      if (fresh && !($('#nickname-input').value || '').trim()) $('#nickname-input').value = fresh;

      // 带 ?room= 的邀请链接优先：这是「朋友拉我进新房间」的明确意图，
      // 不能被「回到上次那个房间」拽回去。
      if (readInviteRoom()) { handleInvite(); return; }

      // 没有任何邀请参数时，尝试回到刷新前的房间（手机来电话、切后台被回收、手滑刷新）
      tryResumeRoom();
    });
  }

  /*
   * 刷新后自动回座。靠 localStorage 里的座位令牌向服务端认回自己，
   * 成功就直接进房（等待中回到房间页、对局中回到牌桌、结算中回到结算页，由 render 判断）。
   * 失败必须**安静**——用户可能只是新开了一个页面，不该弹一堆错误。
   */
  async function tryResumeRoom() {
    var res;
    try {
      res = await RoomStore.resume(state.myId);
    } catch (e) {
      return; // 回座只是尽力而为，失败不影响正常使用
    }
    if (!res || !res.ok || !res.room) return;
    attachRoom(res.roomId, res.room);
    flash('已回到房间 ' + res.roomId);
  }


  init();
})();
