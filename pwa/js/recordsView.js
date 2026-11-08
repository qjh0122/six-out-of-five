/**
 * 战绩这一整条线：战绩页 → 排行榜 → 玩家档案卡 → 回放 → 分享图 → 数据清理
 *
 * ── 为什么合成一个文件（而不是按页再拆三个）──────────────────────────
 * 它们共用同一份数据源，而且**互相调用得极密**：
 *   · `renderRecords` 要用 `cloudStats` / `cloudRows` / `playerNameOf`；
 *   · 打开回放要先 `replayPacksOf(room)` 找场次，关掉还要按原路重画；
 *   · 清理已注销账号（`purgeDeletedIdentities`）改完数据要重画**当前打开的那一层**，
 *     而那一层可能是战绩页、也可能是回放到一半的弹窗（`replayReopen` 记着怎么重开）。
 * 拆开只会把「同一条链路」切成三个文件来回跳，换来的是没有边界。
 *
 * ── 两个数据源的边界（这一块最容易搞错的事）─────────────────────────
 *   · **云端优先**：`cloudRecords` 那份缓存的 TTL 是 20 秒，重进页面不重复打接口；
 *     在途请求用 `cloudRecordsSeq` 序号丢弃过期响应（切人/离开页面后旧响应不能落地）。
 *   · **本机兜底**：`Records`（localStorage）在离线、隐私模式、接口挂了时顶上。
 *   · 两者口径必须一致 —— 服务端 `_persistSettlement` 与本机 `recordSettled`
 *     判「作废的局不计」用的是同一个 `room.voided`。
 *
 * ── 三个必须保留的细节（原注释已逐条搬来）─────────────────────────
 *   ① 分享图是**手画 canvas**（`drawShareCard`），不是截图 —— 没有 html2canvas 这种依赖；
 *   ② iOS 上 canvas 导出必须同步走 `toDataURL`，异步 `toBlob` 会丢用户手势上下文；
 *   ③ 清理已注销账号「查不到就什么都不做」：误删不可逆，而多留一次只是下次再问。
 *
 * ── 注入 ────────────────────────────────────────────────────────
 * 13 项：avatarInner / findPlayer / render / getMe / flash / showScreen /
 * packHistory / esc / el / netText / netCls / fmtTime / cardText + modalKit 三项。
 * （`seq` 不出现在注入里 —— 那是 `openProfile` 里的同名局部变量，不是顶层符号。）
 *
 * 浏览器全局：`window.LXW.recordsView`
 */
(function (global) {
  'use strict';

  function create(deps) {
    deps = deps || {};
    var U = global.LXW.utils;
    var $ = U.$, el = U.el, esc = U.esc;
    var netText = U.netText, netCls = U.netCls, pad2 = U.pad2, fmtTime = U.fmtTime;
    var cardText = U.cardText, short = U.short, colorFor = U.colorFor;

    /* ★ state 必须注入，理由见 settleView.js 同处注释：模块是独立作用域。 */
    var state = deps.state;
    var avatarInner = deps.avatarInner, findPlayer = deps.findPlayer;
    var render = deps.render, getMe = deps.getMe, flash = deps.flash, showScreen = deps.showScreen;
    var packHistory = deps.packHistory;
    var showModalEl = deps.showModalEl, hideModalEl = deps.hideModalEl;
    var isShown = deps.isShown, pushModalState = deps.pushModalState;
    /* 「5 秒内可以反悔」条（v136）。可以没有 —— 单测/旧缓存里拿不到就是 null，
     * 那种情况下退回"立刻清除"，行为与 v135 一致，不会静默不删。 */
    var undoBar = deps.undoBar || null;
    /* 打开清除确认框时记下的场次数，给「将清除 N 场」用（v136）。 */
    var clearCount = 0;

  /* 结束原因的玩家侧措辞。三条必须在同一层级上，别一条一个说法：
   *   · 打满把数 / 有人离开 —— 打出来的结果
   *   · 提前结束         —— 有人主动收手
   * `scoreZero` 是 v103 前「有人见底即结束」留下的**老战绩措辞**，
   * 新局不会再产生这个值 —— 但两个月前的记录点开还得念得成人话，别删。
   * 原来第三条写「解散结束」，但入口早已改叫「结束本局」（房间不散、号还在、
   * 大家还能开下一局，见 index.html 的注释）。战绩里写「解散」等于告诉玩家
   * 他做了他没做的事 —— 同一件事两个名字，最容易被理解成「按错了」。
   * 不写「房主结束本局」：房主中途可能移交（next-round.test.js 有断言），
   * 事后写「房主」未必是当时那个人；而且这一行和净胜分同排，6 个字会挤。 */
  var END_REASON_TEXT = {
    scoreZero: '分数见底结束',
    someoneLeft: '有人离开结束',
    /* 打满建房时选的把数。这一行和净胜分同排，字数要跟相邻两条对齐（6 字）。 */
    handLimit: '打满把数结束',
    dissolve: '提前结束'
  };
  function endReasonText(r) { return END_REASON_TEXT[r] || '已结束'; } // 兜底绝不空白

  function renderTrend(recent) {
    var bar = $('#rp-trend-bar');
    var arr = recent || [];
    bar.innerHTML = '';
    var pad = Math.max(0, 10 - arr.length);
    bar.classList.toggle('fewer', pad > 0); // 不足 10 场：空槽补左侧、整条右对齐
    var i;
    for (i = 0; i < pad; i++) {
      var slot = el('i', 'rp-t empty');
      slot.setAttribute('aria-hidden', 'true');
      bar.appendChild(slot);
    }
    var GLYPH = { win: '\u25B2', lose: '\u25BC', flat: '\u2014' }; // ▲ ▼ —（颜色 + 形状双编码）
    var WORD = { win: '赢', lose: '输', flat: '平' };
    var labels = [];
    for (i = 0; i < arr.length; i++) {
      var kind = arr[i];
      var t = el('i', 'rp-t ' + kind, GLYPH[kind] || '\u2014');
      t.setAttribute('aria-hidden', 'true');
      bar.appendChild(t);
      labels.push(WORD[kind] || '');
    }
    bar.setAttribute('aria-label', labels.length
      ? ('最近 ' + labels.length + ' 场（左旧右新）：' + labels.join(' '))
      : '暂无对局');
  }

  function renderRecordRows(list) {
    var ul = $('#records-list');
    ul.innerHTML = '';
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      var li = el('li', 'rp-row');
      /* 含 AI 的场次：整行降一档亮度 + 一枚「含人机」徽标。
       * 不隐藏这些行 —— 用户要的是「看得出来是人机对战」，
       * 藏起来等于让他以为那一把没打。 */
      if (r.ai) li.classList.add('is-ai');
      var left = el('div', 'rp-row-left');
      left.appendChild(el('span', 'rp-time', fmtTime(r.endedAt)));
      left.appendChild(el('span', 'rp-people', (r.playerCount || 0) + ' 人'));
      if (r.ai) left.appendChild(el('span', 'rp-row-ai', '含人机'));
      var txt = netText(r.myNet);
      var net = el('span', 'rp-net ' + netCls(r.myNet), txt);
      if (txt.length > 4) net.style.fontSize = '34px'; // 超 4 位压缩字号（±999 以内不会发生）
      li.appendChild(left);
      li.appendChild(net);

      /* 第二行：结束原因 +「看过程」。回放只给最近 8 局留（Records.REPLAY_KEEP），
       * 更早的记录没有这个字段，那一行就只剩结束原因，不能留一个点不开的按钮。 */
      var sub = el('div', 'rp-sub-wrap');
      sub.appendChild(el('span', 'rp-sub', endReasonText(r.endReason)));
      if (r.replay || r.sessionKey) {
        /* 文案从「看过程」改成「看回放」：原来那三个字没说清里面是什么，
         * 点进去发现只有最后一把，人会以为数据丢了。
         * 新记录带 sessionKey（整场），老记录只有单把 replay，两种都能开。 */
        var btn = el('button', 'rp-replay', '看回放');
        btn.setAttribute('aria-label', '看回放：' + fmtTime(r.endedAt) + ' 这一场的牌面过程');
        btn.type = 'button';
        btn.addEventListener('click', (function (rec) {
          return function () { openSavedReplay(rec); };
        })(r));
        sub.appendChild(btn);
      }
      li.appendChild(sub);
      ul.appendChild(li);
    }
  }

  /* ---------------------------- 战绩数据源（云端优先，本机兜底） ----------------------------
   * v50 之前这一页只读本机 localStorage，而排行榜读的是服务端 profiles.json。
   * 两套数据互不相干，于是这三件事全都成立：
   *   「删了战绩，排行榜还在」   —— 删除只动了本机
   *   「换号后战绩里是别人的局」 —— 本机记录没有账号字段
   *   「排行榜有、战绩没有」     —— 那局你的手机没赶上结算画面（断线/切后台）
   *
   * 现在以云端为准，本机记录只剩两个用途：**离线兜底**，以及**回放的存放处**
   * （服务端不存逐轮明细，那是几 KB 一局的东西，不该进 profiles.json）。
   * 页脚那行字会跟着变，用户永远知道自己在看哪一份。
   */
  var cloudRecords = null;      // 最近一次成功取到的云端档案（null = 这号还没打过）
  var cloudRecordsOk = false;   // 是否至少成功取到过一次
  var cloudRecordsPid = '';     // ★ 这份缓存属于哪个账号
  var cloudRecordsErr = '';     // 最近一次失败原因；空串表示这次打开还没失败过
  var cloudRecordsAt = 0;       // 取到的时刻（毫秒）
  var cloudRecordsSeq = 0;      // 在途请求序号：重复打开 / 离开本页后旧响应丢弃
  var CLOUD_RECORDS_TTL = 20 * 1000;   // 20 秒内重复进入不重复打接口

  var EMPTY_STATS = {
    games: 0, totalNet: 0, wins: 0, losses: 0, flats: 0, winRate: 0,
    bestNet: 0, longestStreak: 0, longestLoseStreak: 0, aiGames: 0, recent: []
  };

  /* ---------------------------- 四态的状态机（build-states v1） ----------------------------
   * 唯一真源：`#screen-records[data-rstate]`，值域 {offline, fail, loading, empty, data}。
   * 唯一执行者：`setRecordsState(name)`。
   *
   * 为什么必须"只留一个执行者"：以前四处 `classList.toggle('hidden', …)` 散在
   * renderRecords() 里（#records-scroll / #records-data / #records-empty / #records-foot）。
   * 散着写不会立刻出错，但**加第四个态那天必定漏一处**，漏一处的表现就是两个态同屏叠着 ——
   * 而那正是这一轮要消灭的东西。所以显隐只从这里出去，别的函数一律不碰 classList。
   *
   * 互斥组（同一时刻只许一个载体可见）：loading | fail | empty | data。
   * 非互斥项：offline。它允许叠加在 data/empty 之上（is-strip 横条，内容照常显示），
   * 只有"本机 0 局且登录中"或正在 loading/fail 被它抢占时才独占（is-panel）。
   * 把离线塞进互斥组，等于"离线 + 有本机数据"时整页空 —— 玩家明明能看自己的战绩，
   * 却被告知没网。这是全站唯一的双显豁免，别处不得再开口子。
   */
  var RS = deps.recordsState || (global.LXW && global.LXW.recordsState) || null;
  var cloudRecordsErrKey = '';   // 失败原因对应的 ERR 表键（比一句中文可判、可分级）
  var cloudStatus = 0;           // 最近一次失败的服务端状态码（429 要单独一句话）
  var recordsHasData = false;    // 上次渲染时"确实有内容"（降级重试与上报口径都要它）
  var loadingSince = 0;          // 本轮加载开始的时刻（250ms 门槛 / 1s 慢文案的基准）
  var recordsEnterAt = 0;        // 进入战绩页的时刻（门槛从"进门"算，不从"渲染"算）
  var recordsStateNow = '';      // 最近一次落下的态（慢文案回调要判它有没有过时）
  var gateTimer = null;          // 250ms 门槛的定时器
  var slowTimer = null;          // 1s 慢文案的定时器

  /* 五个载体 id。data 态的载体是 #records-scroll + #records-data 两块，
   * 但**视为同一个载体只数一次**（现状两者同时可见是对的）。 */
  var CARRIERS = ['records-loading', 'records-fail', 'records-empty', 'records-scroll', 'records-offline'];

  function isOfflineNow() {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  }

  function recordsAvailable() {
    return (typeof Records !== 'undefined') && !!Records.available();
  }

  function clearStateTimers() {
    if (gateTimer) { clearTimeout(gateTimer); gateTimer = null; }
    if (slowTimer) { clearTimeout(slowTimer); slowTimer = null; }
  }

  /* 纯函数的兜底包装：旧缓存里没有 recordsState.js 时退回两态（有数据 / 没有）。
   * 这是兜底不是方案 —— 探针与单测都按四态验，缺模块会立刻红。 */
  function stateOf(input) {
    if (RS && RS.recordsStateOf) return RS.recordsStateOf(input);
    if (input.online === false) return 'offline';
    return input.hasData ? 'data' : 'empty';
  }

  function errKeyOfResult(res) {
    if (RS && RS.errKeyOf) return RS.errKeyOf(res);
    return 'err.net.timeout';
  }

  function errText(key) {
    var e = (RS && RS.ERR && RS.ERR[key]) || null;
    return e || { level: 'fatal', title: '', sub: '', actions: [] };
  }

  /* 上报**唯一入口**（ErrorReport.capture 自带 seenKeys 去重与 MAX_PER_SESSION，
   * 所以静默类这里不写节流 —— 写新节流就是重复造）。 */
  function reportErr(key, extra) {
    var e = errText(key);
    if (!e.report) return;
    try {
      if (typeof ErrorReport !== 'undefined' && ErrorReport && ErrorReport.capture) {
        var payload = { source: e.report.source };
        if (extra) {
          for (var k in extra) {
            if (Object.prototype.hasOwnProperty.call(extra, k) && extra[k] !== undefined) payload[k] = extra[k];
          }
        }
        ErrorReport.capture(e.report.kind || 'net', e.report.message || key, payload);
      }
    } catch (_) { /* silence: 上报自身绝不能再抛 */ }
  }

  function setStateText(box, title, sub) {
    if (!box) return;
    var t = box.querySelector('[data-rstate-title]');
    var s = box.querySelector('[data-rstate-sub]');
    if (t) t.textContent = title || '';
    if (s) s.textContent = sub || '';
  }

  function showOnlyCarriers(ids) {
    for (var i = 0; i < CARRIERS.length; i++) {
      var box = $('#' + CARRIERS[i]);
      if (!box) continue;
      box.classList.toggle('hidden', ids.indexOf(CARRIERS[i]) < 0);
    }
    /* #records-data 是 #records-scroll 里的同一载体，跟着一起切 */
    var data = $('#records-data');
    if (data) data.classList.toggle('hidden', ids.indexOf('records-scroll') < 0);
    /* 页脚跟着"有没有内容"走：空态、加载态、满屏失败态都不显示它。
     * 失败降级时内容在，页脚就在 —— 那句降级说明本身也是内容的一部分。 */
    var foot = $('#records-foot');
    if (foot) foot.classList.toggle('hidden', ids.indexOf('records-scroll') < 0);
  }

  /* 失败态的按钮是**签名**（design §①-b）：可重试类两个、不可恢复类一条出路、
   * malformed 一个都不给。所以按钮文案不写死在 HTML 里，由 ERR[key].actions 决定 ——
   * 写死在标签上等于把"哪一类错误"钉死，一改就漂。 */
  function renderFailActions(box, actions) {
    var primary = $('#btn-records-retry');
    var secondary = $('#btn-records-fail-create');
    var wrap = box ? box.querySelector('.rp-state__actions') : null;
    var a0 = actions[0], a1 = actions[1];
    if (primary) {
      primary.classList.toggle('hidden', !a0);
      if (a0) { primary.textContent = a0.label; primary.setAttribute('data-act', a0.act); }
    }
    /* 次要按钮只在真有第二条路时出现。只有一条出路时它就长成"主 + 次"的样子会
     * 暗示"还有另一条路"，而不可恢复类的全部意思就是"没有另一条路"。 */
    if (secondary) {
      secondary.classList.toggle('hidden', !a1);
      if (a1) { secondary.textContent = a1.label; secondary.setAttribute('data-act', a1.act); }
    }
    if (wrap) wrap.classList.toggle('hidden', !actions.length);
  }

  /**
   * 唯一的切态执行者。
   * @param {string} name 'offline'|'fail'|'loading'|'empty'|'data'
   * @param {object} [opt] errKey（fail 用）／form + base（offline 用）／status（429 换副文案）
   */
  function setRecordsState(name, opt) {
    opt = opt || {};
    var scr = $('#screen-records');
    if (!scr) return;
    var text = (RS && RS.STATE_TEXT) || {};

    if (name === 'loading') {
      /* 250ms 门槛：进屏后的这段时间**一个载体都不显示**（只有屏背景）。
       * 本地读常 200ms 内完成，先闪一下空态再切有数据是**最坏的闪** —— 它闪的是错的结论。
       * data-rstate 仍然写 loading：它是唯一真源，先说实话；显示可以晚 250ms。 */
      var gate = RS ? RS.STATE_DELAY_MS : 250;
      if (recordsEnterAt && (Date.now() - recordsEnterAt) < gate) {
        scr.setAttribute('data-rstate', 'loading');
        recordsStateNow = 'loading';
        showOnlyCarriers([]);
        if (gateTimer) clearTimeout(gateTimer);
        gateTimer = setTimeout(function () {
          gateTimer = null;
          setRecordsState('loading', opt);
        }, Math.max(0, gate - (Date.now() - recordsEnterAt)));
        return;
      }
    }
    if (gateTimer) { clearTimeout(gateTimer); gateTimer = null; }

    scr.setAttribute('data-rstate', name);
    recordsStateNow = name;

    if (name === 'loading') {
      var lg = text.loading || {};
      var box = $('#records-loading');
      showOnlyCarriers(['records-loading']);
      /* 慢文案只换副文案：标题不动、按钮不加、进度条不做（design §④-4）。
       * 没有可信的总量，编一个百分比等于撒谎；"87% 卡住"比"一直转"更让人焦虑。 */
      var since = loadingSince || (loadingSince = Date.now());
      var remain = (RS ? RS.STATE_SLOW_MS : 1000) - (Date.now() - since);
      if (slowTimer) { clearTimeout(slowTimer); slowTimer = null; }
      if (remain <= 0) {
        setStateText(box, lg.title, lg.slow);
      } else {
        setStateText(box, lg.title, lg.sub);
        slowTimer = setTimeout(function () {
          slowTimer = null;
          /* 状态已经换走了就别再改文案，否则"比平时慢一点"会落到成功态上 */
          if (recordsStateNow !== 'loading') return;
          setStateText($('#records-loading'), lg.title, lg.slow);
        }, remain);
      }
      return;
    }
    /* 离开加载态：两个计时器都必须清掉，否则旧 timer 会在两秒后把文案写进别的态 */
    clearStateTimers();

    if (name === 'fail') {
      var key = opt.errKey || 'err.net.timeout';
      var e = errText(key);
      var failBox = $('#records-fail');
      showOnlyCarriers(['records-fail']);
      /* 429 单独一句副文案：和 5xx 混在一档会让"服务器炸了"和"人太多"共用一句话 */
      var sub = (key === 'err.net.server' && Number(opt.status) === 429 && e.sub429) ? e.sub429 : e.sub;
      setStateText(failBox, e.title, sub);
      renderFailActions(failBox, e.actions || []);
      return;
    }

    if (name === 'offline') {
      var offBox = $('#records-offline');
      if (!offBox) return;
      var ot = text.offline || {};
      var form = opt.form === 'panel' ? 'panel' : 'strip';
      var base = opt.base || 'empty';
      var carriers = ['records-offline'];
      /* strip 形态下内容照常显示 —— 这是唯一的双显豁免 */
      if (form === 'strip') {
        if (base === 'data') carriers.push('records-scroll');
        else if (base === 'empty') carriers.push('records-empty');
      }
      showOnlyCarriers(carriers);
      offBox.classList.toggle('is-strip', form === 'strip');
      offBox.classList.toggle('is-panel', form === 'panel');
      /* 副文案**按形态取**（fix2 / F1）：panel 那一支底下是空的，
       * 说"先给你看这台设备上的记录"就是假话。仍是同一个块、同一张文案表，
       * 只是取值多了一档 —— 不是两块两套文案。 */
      setStateText(offBox, ot.title, (form === 'panel' && ot.subPanel) ? ot.subPanel : ot.sub);
      return;
    }

    if (name === 'empty') {
      var et = text.empty || {};
      showOnlyCarriers(['records-empty']);
      setStateText($('#records-empty'), et.title, et.sub);
      return;
    }

    showOnlyCarriers(['records-scroll']);
  }

  /* 离线用哪个形态：有内容 → 横条；没内容 → 看基础态是不是"空"。
   * · hasData → strip：内容照常显示，这是全站唯一的双显豁免。
   * · base=empty → strip：确实一条都没有（未登录语境，或账号档案已到手且 0 局），
   *   空态该露出来。
   * · base=loading / fail → panel：**我们还不知道**账号有没有数据
   *   （「本机 0 局 + 登录中 + 离线」就是这一支），此时露出空态等于替玩家下结论，
   *   而那张 0 分插画会读成"你这号没打过"。 */
  function offlineForm(hasData, base) {
    if (hasData) return 'strip';
    if (base === 'empty') return 'strip';
    return 'panel';
  }

  function failErrKey(avail) {
    if (!avail) return 'err.data.no_storage';
    return cloudRecordsErrKey || 'err.net.timeout';
  }

  function recordsPid() {
    if (typeof AuthStore !== 'undefined' && AuthStore.playerId) return AuthStore.playerId() || '';
    return '';
  }

  /* 云端战绩可用条件：有服务端（ws 模式）+ 已登录。
   * local 演示模式（?mode=local / file://）没有服务端，硬打接口只会拿到 404。 */
  function cloudRecordsReady() {
    if (typeof RoomStore === 'undefined' || !RoomStore.canQueryProfile || !RoomStore.canQueryProfile()) return false;
    return !!recordsPid();
  }

  /* 缓存是否还能用。
   * ★ 必须校验归属账号：退出登录 / 换了号之后，cloudRecordsOk 还是 true，
   * 不校验的话战绩页会继续显示**上一个账号**的云端数据 ——
   * 那正是这次要修的「串台」，只是换了个地方发生。 */
  function cloudRecordsValid() {
    if (!cloudRecordsOk) return false;
    if (cloudRecordsPid !== recordsPid()) return false;
    return cloudRecordsReady();
  }

  /* 云端档案 → 本页的聚合口径。字段名照抄服务端，只把 draws 映射成本页用的 flats。 */
  function cloudStats(p) {
    var rec = (p && p.recent) || [];
    var take = Math.min(10, rec.length);
    var recent = [];
    for (var i = take - 1; i >= 0; i--) {       // 服务端 recent 是新在前，趋势条要旧在新
      var v = Number(rec[i] && rec[i].net) || 0;
      recent.push(v > 0 ? 'win' : (v < 0 ? 'lose' : 'flat'));
    }
    return {
      games: Number(p && p.games) || 0,
      wins: Number(p && p.wins) || 0,
      losses: Number(p && p.losses) || 0,
      flats: Number(p && p.draws) || 0,
      winRate: Number(p && p.winRate) || 0,
      totalNet: Number(p && p.totalNet) || 0,
      bestNet: Number(p && p.bestNet) || 0,
      longestStreak: Number(p && p.longestStreak) || 0,
      longestLoseStreak: Number(p && p.longestLoseStreak) || 0,
      /* 含 AI 的场数：服务端单独记（不计入上面任何一个字段）。
       * 只用来写那一行说明，绝不参与汇总。 */
      aiGames: Number(p && p.aiGames) || 0,
      recent: recent
    };
  }

  /* 云端流水 → 列表行。
   * 回放不在服务端，按 roomId + endedAt 去本机那几份里对；
   * 对得上才显示「看过程」，对不上就只显示结束原因 —— 绝不造一个点不开的按钮。 */
  function cloudRows(p) {
    var rec = (p && p.recent) || [];
    var mine = {};
    if (typeof Records !== 'undefined' && Records.available()) {
      var locals = Records.all(recordsPid());   // 只在本账号的本机记录里找，别串号
      for (var j = 0; j < locals.length; j++) {
        mine[locals[j].roomId + '#' + locals[j].endedAt] = locals[j];
      }
    }
    var out = [];
    /* 两份流水（人类局 recent / 人机局 aiRecent）合并成一条时间线。
     * 为什么要合并：玩家要看的是「我最近打过什么」，而不是「两个抽屉」；
     * 人机局只是**标记不同**，不是另一个页面。排序按结束时间倒序，
     * 与 recent 自己的顺序无关（aiRecent 是另一份数组，不能假设两者交错正确）。 */
    function pushRow(r, isAi) {
      r = r || {};
      var hit = mine[String(r.roomId) + '#' + r.endedAt];
      out.push({
        endedAt: r.endedAt,
        myNet: Number(r.net) || 0,
        playerCount: Number(r.playerCount) || 0,
        endReason: r.endReason || null,
        ai: !!isAi,
        replay: (hit && hit.replay) || null,
        /* ★ sessionKey / handId 必须一起带过来。
         * 这里只搬了 replay，于是「整场档案攒得好好的、回放却只有一把」——
         * 因为 openSavedReplay 拿不到 sessionKey 就退回单把 replay，
         * 标题写成「那局」、副标题写成「这一把的过程」。
         * 云端只存流水（分数/把数），**回放从来不在服务端**，
         * 所以回放的入口字段必须从本机这条记录里对过来，漏一个就等于没有。 */
        sessionKey: (hit && hit.sessionKey) || '',
        handId: (hit && hit.handId) || 0
      });
    }
    for (var h = 0; h < rec.length; h++) pushRow(rec[h], false);
    var aiRec = (p && p.aiRecent) || [];
    for (var a = 0; a < aiRec.length; a++) pushRow(aiRec[a], true);
    out.sort(function (x, y) { return (Number(y.endedAt) || 0) - (Number(x.endedAt) || 0); });
    return out;
  }

  function loadCloudRecords(force) {
    if (!cloudRecordsReady()) return;
    /* 离线时**不发**注定失败的请求（build-states v1 R3）。8 秒空等对玩家是纯损失，
     * 而且"等完再报超时"会把离线误说成"服务器没应声" —— 原因说错，玩家就会去找错的东西。 */
    if (isOfflineNow()) return;
    if (!force && cloudRecordsOk && Date.now() - cloudRecordsAt < CLOUD_RECORDS_TTL) return;
    var seq = ++cloudRecordsSeq;
    var req = AuthStore.myRecords();
    if (!req || typeof req.then !== 'function') return;
    req.then(function (res) {
      if (seq !== cloudRecordsSeq) return;               // 已经离开 / 又发了一次
      if (res && res.ok !== false) {
        /* 200 但缺必需字段（totalNet / games 是 undefined）= 服务端契约变了的信号。
         * 这一条最该上报，但**不挡玩家**：页面按本机数据继续，说明只落在页脚那一行。 */
        if (RS && RS.profileLooksValid && !RS.profileLooksValid(res.profile || null)) {
          cloudRecordsErrKey = 'err.data.malformed';
          cloudRecordsErr = errText('err.data.malformed').sub;
          reportErr('err.data.malformed');
        } else {
          cloudRecords = res.profile || null;
          cloudRecordsOk = true;
          cloudRecordsPid = recordsPid();     // 记下这份数据属于谁
          cloudRecordsErr = '';
          cloudRecordsErrKey = '';
          cloudStatus = 0;
          cloudRecordsAt = Date.now();
        }
      } else {
        /* 只记原因、不弹 toast：战绩页降级到本机数据仍然可用，
         * 弹个「网络异常」只会让用户以为自己的数据没了。
         *
         * ★ 但"不打扰"不等于"不上报"，而且口径分两种：
         *   · 本机有数据 → 玩家什么都没感觉到 → 静默类（err.silent.profile）
         *   · 本机也没数据 → 这一屏已经坏了 → 按可重试/不可恢复报（带 status）
         * 分开的理由：前者我们要的是"这个周末有多少人是降级看的"，
         * 后者要的是"哪一档错误在真的挡人"。混成一档，两个问题都答不了。 */
        cloudRecordsErrKey = errKeyOfResult(res);
        cloudRecordsErr = (res && res.error) || '账号数据读取失败';
        cloudStatus = Number(res && res.status) || 0;
        reportErr(recordsHasData ? 'err.silent.profile' : cloudRecordsErrKey,
          { status: res && res.status });
      }
      if (state.screen === 'records') renderRecords();
    }).catch(function () {
      if (seq !== cloudRecordsSeq) return;
      cloudRecordsErrKey = 'err.net.timeout';
      cloudRecordsErr = '网络不太好';
      cloudStatus = 0;
      reportErr(recordsHasData ? 'err.silent.profile' : 'err.net.timeout');
      if (state.screen === 'records') renderRecords();
    });
  }

  function renderRecords() {
    var useCloud = cloudRecordsValid();
    var online = !isOfflineNow();
    /* 该用云端但还没回来的那一小会儿：显示加载态，别先闪一屏本机旧数据。
     * （本机旧数据在换了账号的场景下正是错误信息来源。）
     * ★ 离线时一律**不算加载**：加载依赖网络，断网时说「加载中」是骗人 ——
     * 玩家此刻该做的是连网，而不是在一个注定超时的转圈前面等 8 秒。
     *
     * 但 `loading` 恒为 false 会让"本机 0 局"看起来像"确实没有"，所以另留一个
     * `wouldLoad`（= 假如有网，这一屏会不会在加载）。离线时算横条形态用的是它：
     * 「本机没有」推不出「你账号没有」，没问过的不能替玩家下结论（fix1 / M4 反向）。 */
    var wouldLoad = !useCloud && !cloudRecordsErr && cloudRecordsReady();
    var loading = online && wouldLoad;
    var avail = recordsAvailable();
    var pid = recordsPid();
    /* 登录中：只看本账号的本机记录（这是「换号串数据」的修法）。
     * 未登录：没有账号可比，全部本机记录都给他看，否则老数据在界面上彻底消失。 */
    var scoped = pid ? pid : null;

    var st, rows;
    if (useCloud) {
      st = cloudStats(cloudRecords);
      rows = cloudRows(cloudRecords);
    } else if (avail && !loading) {
      st = Records.stats(scoped === null ? undefined : scoped);
      rows = Records.all(scoped === null ? undefined : scoped);
    } else {
      st = EMPTY_STATS;
      rows = [];
    }
    /* 只打过人机局的人也应该看到自己那几行 —— 否则「我明明打过」和
     * 「还没有战绩」两句话会同时成立，用户只会以为数据丢了。 */
    var hasData = st.games > 0 || rows.length > 0;
    recordsHasData = hasData;

    /* 显隐**不在这里**：全部收到 setRecordsState() 一处（build-states v1 §3.4）。
     * 以前这四行 toggle 散在这里，加第四个态那天必定漏掉一处，
     * 而漏掉一处的表现就是两个态同屏叠着。 */
    if (loading) { if (!loadingSince) loadingSince = Date.now(); } else { loadingSince = 0; }

    /* 标题栏右上角的成就数字（v109）。
     *
     * 只有云端档案到了才有准确值；本机模式 / 未登录 / 加载中 / 离线 / 失败这些
     * 状态下一律写「—/N」，**不写 0/N**（fix1 / M3）。
     * 0 是一个结论（"一个都没解锁"），而那些状态下我们并没有结论 ——
     * 用未知冒充零正是设计 §①-d 明令禁止的那件事，也是空态那张"0 分卡"的同一类错
     * （QA §3 反例③：数字真写了，只是它是假的）。
     * 分母照写（目录长度是确定值），形状不变 → 切态时不跳版；
     * 入口也不隐藏：空态（一场没打）时恰恰最该看见它。
     * 总数取自 achievements.js 的目录长度，不在这个文件里写死数字。 */
    var achNum = $('#ach-entry-num');
    if (achNum) {
      var total = (typeof window !== 'undefined' && window.Ach && window.Ach.TOTAL) || 26;
      /* 有云端档案才算"拿到了确定值"；0 也是确定值，不许被 || 吞掉 */
      var cnt = (useCloud && cloudRecords && typeof cloudRecords.achCount !== 'undefined')
        ? cloudRecords.achCount : null;
      achNum.textContent = (RS && RS.achLabel) ? RS.achLabel(cnt, total)
        : (cnt === null ? '—' : Number(cnt)) + '/' + total;
    }

    /* 页脚数据来源 +（失败降级时）行内那个小出口 */
    renderSourceLine(useCloud, hasData);

    if (!hasData) {
      /* 空态 / 加载态 / 失败态 / 离线态 —— 一个纯函数决定是哪一态（recordsState.js），
       * 这里只负责"按结果落 DOM"。250ms 门槛与 1s 慢文案都在 setRecordsState 里。
       *
       * ★ 变体 B-2（隐私模式「当前浏览器无法保存战绩」）已经从空态搬走：
       *   "这台设备存不了"不是"你还没打过"，用 0 分的插画去说"存不了"是在讲错的画面。
       *   它现在是失败 · 不可恢复类（err.data.no_storage），有自己的标题与单按钮。 */
      applyRecordsState(useCloud, hasData, avail, loading, online, wouldLoad);
      return;
    }

    $('#rp-sum').className = 'rp-sum ' + netCls(st.totalNet);
    $('#rp-net').textContent = netText(st.totalNet);
    $('#rp-games').textContent = st.games;
    $('#rp-winrate').textContent = st.winRate + '%';
    $('#rp-wins').textContent = st.wins;
    $('#rp-losses').textContent = st.losses;
    $('#rp-flats').textContent = st.flats;
    /* 云端流水最多留 20 条，而场次可能远多于 20：
     * 只写「共 N 局」会让人数不清列表里的行，把口径一起写上。 */
    var humanRows = 0;
    for (var hr = 0; hr < rows.length; hr++) if (!rows[hr].ai) humanRows++;
    $('#rp-list-count').textContent = '共 ' + st.games + ' 场'
      + (humanRows < st.games ? ' · 列表近 ' + humanRows + ' 场' : '');
    /* 人机局说明：数字来自服务端档案（aiGames），本地兜底模式退回数行数。
     *
     * 芯片上已经写着「含人机」，所以正文不再重复那三个字 —— 早先是
     * 「[含人机] 人机对局 2 局」，读起来是「含人机人机对局」。
     * aiRecent 同样只留 20 条，所以「N 局」可能多于列表里的行数；
     * 那种情况下把「列表近 M 场」也写上（和上面人类场那句同一个说法）。 */
    var aiCount = Number(st.aiGames) || (rows.length - humanRows);
    var aiRows = rows.length - humanRows;
    var aiNote = $('#rp-ai-note');
    if (aiNote) {
      var showAi = aiCount > 0;
      aiNote.classList.toggle('hidden', !showAi);
      if (showAi) {
        /* 三处都写「场」：aiCount 是场数、aiRows 也是场数。
         * 以前前半写「局」后半写「场」，同一行两个单位，读者会以为它们不是一回事。 */
        $('#rp-ai-note-text').textContent = aiCount + ' 场'
          + (aiRows < aiCount ? ' · 列表近 ' + aiRows + ' 场' : '')
          + ' · 不计入战绩与排行榜';
      }
    }
    /* 纪录条：单场最高沿用净胜的红/绿/灰口径（负分也是真实的最好成绩，不藏起来）；
     * 连胜/连败是次数，颜色写在 HTML 上（连胜红、连败绿），只换数字。 */
    var bestNet = st.bestNet || 0;
    $('#rp-best-net').textContent = netText(bestNet);
    $('#rp-best-net-wrap').className = 'rp-best-v ' + netCls(bestNet);
    $('#rp-best-win').textContent = st.longestStreak || 0;
    $('#rp-best-lose').textContent = st.longestLoseStreak || 0;
    renderTrend(st.recent);
    renderRecordRows(rows);
    /* 数据进来之后左栏高度才定，渐隐要在这时再对一次账（见 syncSumcolFade）。 */
    syncSumcolFade();
    /* 有内容的这一支也要走切态：离线 + 有数据时是"内容 + is-strip 横条"，
     * 失败降级时是"内容 + 页脚小出口"——两者都不许整页空掉。 */
    applyRecordsState(useCloud, hasData, avail, loading, online, wouldLoad);
  }

  /* ---------------------------- 切态的最后一厘米 ----------------------------
   * 纯函数只回答"是哪个态"，这里回答"落成什么样"。分出来是因为它有 5 个分支、
   * 每个分支的形态差异都值得单独一行注释，塞进 renderRecords() 会把它埋掉。 */
  function applyRecordsState(useCloud, hasData, avail, loading, online, wouldLoad) {
    var name = stateOf({
      online: online, cloudErr: cloudRecordsErr, cloudLoading: loading,
      hasData: hasData, avail: avail
    });

    if (name === 'offline') {
      /* 离线是**非互斥**项：有内容就只加一条横条（内容照常显示），
       * 没内容且本机代表不了你时才独占。这里的 base 是"假设有网时是哪一态"，
       * 用来决定横条下面该露出什么。
       *
       * ★ base 的 cloudLoading 必须传 `wouldLoad`（假如有网会不会在加载），
       *   不能传 `loading`（离线时恒为 false）。传错了会得出"有网也是空"，
       *   于是「本机 0 局 + 登录中 + 离线」被当成"账号确实 0 局" → 露出空态那张
       *   0 分插画。真相是我们**没问过**账号，只能说"不知道"（fix1 / M4 反向）。 */
      var base = stateOf({
        online: true, cloudErr: cloudRecordsErr, cloudLoading: wouldLoad,
        hasData: hasData, avail: avail
      });
      setRecordsState('offline', { form: offlineForm(hasData, base), base: base });
      return;
    }
    if (name === 'fail') {
      /* 失败态只有两种落法：独占屏（本机也没数据）或页脚降级（已在 renderSourceLine 里）。
       * 走到这里的一定是前者 —— 后者 recordsStateOf 返回的是 data。 */
      setRecordsState('fail', { errKey: failErrKey(avail), status: cloudStatus });
      return;
    }
    if (name === 'loading') { setRecordsState('loading'); return; }
    if (name === 'empty') { setRecordsState('empty'); return; }
    setRecordsState('data');
  }

  /* 页脚那一行：数据来源 + 失败降级时的行内出口。
   *
   * 为什么降级不占满屏：本机还有数据时，玩家的战绩**好好的在那儿**，
   * 用一整屏的"失败"把它盖住，等于因为一个附加数据的缺失而没收了主内容。 */
  function renderSourceLine(useCloud, hasData) {
    var src = $('#records-source');
    /* ★ 离线时**不给**这个出口（fix1 / M1）。
     * 「再读一次」在离线时是一个注定失败的动作：`loadCloudRecords()` 第一行就
     * return，点了什么都不会发生。留着它等于邀请玩家去点一个空按钮 ——
     * QA S9 的原话是"不该发注定失败的请求、也不该邀请玩家点它"。
     * 离线时真正的出路是横条里那个「重新载入」（恢复网络后才动作）。 */
    var onlineNow = !isOfflineNow();
    var degraded = onlineNow && !!cloudRecordsErr && hasData && recordsAvailable();
    if (src) {
      /* 说话顺序：离线 > 格式不符 > 用云端 > 降级 > 本机。
       *
       * 离线排第一，因为它换的不是措辞而是**原因**：「账号数据暂时读不到」在
       * 离线语境下是结果误报 —— 不是"读不到"，是**根本没发**（fix1 / M2）。
       * 也不能沿用横条那句「先把这台设备上的记录给你看」：同一屏同一句话说两遍，
       * 玩家会以为漏了什么。所以这一屏的页脚只说"这一份存在哪儿"。 */
      var text;
      if (!onlineNow) text = '只在这台设备上，换设备会丢';
      else if (cloudRecordsErrKey === 'err.data.malformed') text = errText('err.data.malformed').sub;
      else if (useCloud) text = '已保存到账号 · 换设备也在';
      else if (cloudRecordsErr && cloudRecordsReady()) text = '账号数据暂时读不到，先显示这台设备上的记录';
      else text = '只在这台设备上，换设备会丢';
      src.textContent = text;
    }
    var retry = $('#records-source-retry');
    if (!retry) return;
    var act = degraded ? (errText(cloudRecordsErrKey).actions || [])[0] : null;
    /* malformed 没有动作（页面按本机数据继续）—— 那就连按钮也不给，只留一句话 */
    retry.classList.toggle('hidden', !degraded || !act);
    if (!act) { retry.disabled = false; retry.classList.remove('is-busy'); return; }
    retry.textContent = act.label;
    retry.setAttribute('data-act', act.act);
    retry.disabled = false;
    retry.classList.remove('is-busy');
  }

  /* 横屏战绩页左栏（.rp-sumcol）是独立滚动容器，底部 26 设计像素的渐隐表示「下面还有」。
   * 但它是常驻样式：内容一屏装得下时，渐隐照样把最底下的「最近 10 场」方块洗掉半截 ——
   * 那是内容，不是提示。所以只在这个容器真的滚得动时才挂 .is-scroll。
   * 三处会改变高度：数据渲染完、窗口/朝向变化（resize）、字体加载完。 */
  function syncSumcolFade() {
    var col = document.querySelector('#records-data .rp-sumcol');
    if (!col) return;
    /* +2 是取整误差：clientHeight 是整数、scrollHeight 四舍五入，
     * 差 1px 就挂上渐隐会在「刚好装下」时误判。 */
    col.classList.toggle('is-scroll', col.scrollHeight > col.clientHeight + 2);
  }

  /* ---------------------------- 玩家战绩卡（账号档案） ----------------------------
   * 数据来源：ws 模式向服务端请求 getProfile（只读查询），服务端返回最近 50 条明细的聚合。
   * 与「我的战绩」页读的是同一份账号数据（profiles.json）——
   * 战绩页在 v51 改读账号数据后，这里不再有任何「两套数据」的来源说明，
   * 弹窗只标注「已保存到账号」。local 模式（?mode=local / file://）无服务端 → 只弹提示。
   * 三处入口：房间页座位卡 / 对局页对手座位卡（区分拖动与点击）/ 结束页玩家行。 */
  var profileSeq = 0;            // 在途请求序号：切人 / 关闭后旧响应直接丢弃

  function playerNameOf(pid) {
    var p = state.room ? findPlayer(state.room, pid) : null;
    return p ? p.nickname : '';
  }

  /* knownName：调用方已经知道昵称时直接传进来，省掉一次「先显示玩家、再跳成真名」的闪。
   * 排行榜就是这个场景 —— 榜上的人不在我房间，playerNameOf() 问不到。 */
  function openProfile(pid, knownName) {
    if (!pid) return;
    // AI 玩家没有云端档案，别弹一张空卡出去
    if (String(pid).indexOf('bot_') === 0) { flash('AI 玩家没有战绩'); return; }
    if (typeof RoomStore === 'undefined' || !RoomStore.canQueryProfile || !RoomStore.canQueryProfile()) {
      flash('本地演示模式暂不支持查看他人战绩');   // 本地演示（无服务端）直接提示，不弹空卡
      return;
    }
    var name = knownName || playerNameOf(pid) || '玩家';
    var seq = ++profileSeq;

    // 先用本地已知信息填充头部，加载期间不出现空白
    var pfAv = $('#profile-avatar');
    pfAv.innerHTML = avatarInner(pid, '', name.charAt(0) || '?', false);
    $('#profile-name').textContent = name;
    /* 看自己还是看别人，这张卡都是同一份服务端档案的同一种呈现，
     * 不再区分来源说明（早先这里写着「与本机战绩独立」，战绩页改读账号数据后那句话就不成立了）。 */
    $('#profile-source').textContent = '已保存到账号';
    $('#profile-body').innerHTML = '<p class="pf-loading">加载中…</p>';
    showModalEl('profile-modal');
    $('#stage').classList.add('modal-open');       // 阻止背景滚动（见 style.css）
    pushModalState();
    Sfx.play('select');

    RoomStore.getProfile(pid).then(function (res) {
      if (seq !== profileSeq) return;              // 已切到别的玩家 / 弹窗已关闭
      if (!res || res.ok === false) { renderProfileFail(res && res.error); return; }
      renderProfileBody(res.profile);
    }).catch(function () {
      if (seq !== profileSeq) return;
      renderProfileFail('网络异常，请稍后重试');
    });
  }

  function closeProfile() {
    profileSeq++;                                  // 使在途请求的响应失效
    hideModalEl('profile-modal');
    $('#stage').classList.remove('modal-open');
  }
  function renderProfileFail(msg) {
    $('#profile-body').innerHTML = '<div class="pf-empty">'
      + '<p class="pf-empty-title">加载失败</p>'
      + '<p class="pf-empty-sub">' + esc(msg || '请稍后重试') + '</p>'
      + '</div>';
  }

  /* 空态插画：内联 SVG（零图片、零 CDN） */
  var PF_EMPTY_SVG = '<svg viewBox="0 0 120 120" fill="none" role="img" aria-label="暂无战绩">'
    + '<circle cx="60" cy="60" r="52" fill="rgba(26,29,35,.04)"/>'
    + '<circle cx="60" cy="60" r="52" stroke="rgba(232,163,61,.55)" stroke-width="2.5" stroke-dasharray="9 8"/>'
    + '<rect x="38" y="32" width="44" height="56" rx="8" fill="#FFF7E8" stroke="#E8A33D" stroke-width="2.4"/>'
    + '<path d="M47 48h26M47 58h26M47 68h15" stroke="rgba(26,29,35,.26)" stroke-width="3" stroke-linecap="round"/>'
    + '</svg>';

  /* 战绩卡的正文标记 —— **全仓只有这一份**。
   *
   * 两个地方都用它：整张战绩卡（`#profile-body`）和牌桌座位面板的「信息档」（`#ss-info`）。
   *
   * 为什么合到一处（v107）：早先信息档自己抄了一份「三个数字 + 胜平负」，等于同一份档案
   * 有两个渲染源 —— 改一处必忘另一处；而且玩家点开摘要、再点「看完整战绩」，
   * 看到的**就是同样的那两行**，中间多出来的只有一次点击、一次请求和一次动画。
   * 那不是"概览 → 详情"，是同一个东西讲了两遍。
   *
   * 空态不在这里：整卡是一张插画（`PF_EMPTY_SVG`），座位面板里只该是一句话，
   * 由调用方各自决定更合适。 */
  function profileBodyHtml(profile) {
    if (!profile) return '';
    var cls = netCls(profile.totalNet);
    var html = '<div class="pf-stats">'
      + '<div class="pf-stat"><b>' + (profile.games || 0) + '</b><span>场次</span></div>'
      + '<div class="pf-stat"><b>' + (profile.winRate || 0) + '%</b><span>胜率</span></div>'
      + '<div class="pf-stat ' + cls + '"><b>' + netText(profile.totalNet || 0) + '</b><span>累计净胜</span></div>'
      + '</div>'
      + '<p class="pf-record">' + (profile.wins || 0) + ' 胜 · ' + (profile.losses || 0) + ' 负 · '
      + (profile.draws || 0) + ' 平</p>';

    var recent = (profile.recent || []).slice(0, 5);
    var streak = profile.currentStreak || 0;
    html += '<div class="pf-recent">'
      + '<div class="pf-recent-head"><span>最近 5 局</span>'
      + (streak > 1 ? '<em class="pf-streak">' + streak + ' 连胜</em>'
        : (streak < -1 ? '<em class="pf-streak down">' + (-streak) + ' 连败</em>' : ''))
      + '</div>';
    if (!recent.length) {
      html += '<p class="pf-recent-empty">暂无对局</p>';
    } else {
      html += '<ul class="pf-list">';
      recent.forEach(function (r) {
        html += '<li class="pf-row"><span class="pf-date">' + fmtTime(r.endedAt) + '</span>'
          + '<span class="pf-net ' + netCls(r.net) + '">' + netText(r.net) + '</span></li>';
      });
      html += '</ul>';
    }
    /* 旧文案断言「发布会把数据重置」——那是在数据还放在项目目录里的时候。
     * 现在档案在项目外的数据目录（~/.lxw-appdata），发布不会碰到它，
     * 那句话会让玩家以为每次更新战绩都清零。
     *
     * 两种情形分开说：这张卡看自己、也看别人。
     * 早先一句「战绩跟着账号走，换设备也在」对**别人的卡**是错的——玩家换不换设备
     * 跟别人没关系，读起来像在劝他自己换机。 */
    var isMe = !!(profile.playerId && profile.playerId === state.myId);
    html += '</div>';
    /* 成就入口（v109）。放在「最近 5 局」之后、那句 note 之前 ——
     * 放最底下会被「战绩跟着账号走」压住，玩家以为已经翻到底了。
     *
     * 模块取不到就整行不渲染（而不是渲染一个点了没反应的按钮）：
     * 老客户端缓存里没有 achievementsView.js，这条路径必须能安全退化。 */
    var AV = (typeof window !== 'undefined' && window.LXW) ? window.LXW.achievementsView : null;
    if (AV && typeof AV.entryRowHtml === 'function') html += AV.entryRowHtml(profile);
    html += '<p class="pf-note">'
      + (isMe ? '战绩跟着你的账号走，换设备也在。' : '只读查看，战绩保存在对方账号里。')
      + '</p>';
    return html;
  }

  function renderProfileBody(profile) {
    var body = $('#profile-body');
    if (!profile) {
      body.innerHTML = '<div class="pf-empty">' + PF_EMPTY_SVG
        + '<p class="pf-empty-title">暂无战绩记录</p>'
        + '<p class="pf-empty-sub">打完一局就会自动记下</p>'
        + '</div>';
      return;
    }

    // 服务端档案里的昵称是「最后一次使用的昵称」，以它为准
    if (profile.nickname) {
      $('#profile-name').textContent = profile.nickname;
      $('#profile-avatar').innerHTML = avatarInner(
        profile.playerId, profile.avatar, profile.nickname.charAt(0) || '?', false, profile.photo);
    }

    body.innerHTML = profileBodyHtml(profile);
  }

  /* ---------------------------- 战绩页导航 ---------------------------- */
  /* ---------------------------- 战绩分享图 ----------------------------
   * 直接 Canvas 绘制，不依赖截图或第三方库：分享图是拉新主要入口，
   * 必须在任何设备上都能本地生成，断网也能用。 */
  function drawShareCard(room) {
    if (!room) return null;
    var W = 750, H = 1000, S = 2;
    var cv = document.createElement('canvas');
    cv.width = W * S;
    cv.height = H * S;
    var ctx = cv.getContext('2d');
    if (!ctx) return null;
    ctx.scale(S, S);

    var FONT = '"PingFang SC", -apple-system, "Microsoft YaHei", sans-serif';
    var sorted = room.players.slice().sort(function (a, b) { return b.score - a.score; });
    var me = getMe(room);
    var net = me ? me.score - CONFIG.INITIAL_SCORE : 0;

    // 背景：牌桌绿渐变 + 顶部暖光晕
    var bg = ctx.createLinearGradient(0, 0, W * 0.6, H);
    bg.addColorStop(0, '#1E5A44');
    bg.addColorStop(1, '#0E2A20');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    var glow = ctx.createRadialGradient(W / 2, 40, 20, W / 2, 40, 430);
    glow.addColorStop(0, 'rgba(245,193,92,0.22)');
    glow.addColorStop(1, 'rgba(245,193,92,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, 520);

    // 标题
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#F5C15C';
    ctx.font = '800 62px ' + FONT;
    ctx.fillText('六选五', W / 2, 122);

    ctx.fillStyle = 'rgba(255,247,232,0.55)';
    ctx.font = '400 26px ' + FONT;
    ctx.fillText('房间 ' + room.roomId + ' · 第 ' + (room.handSeq || 1) + ' 场', W / 2, 170);

    // 我的净胜（大字）
    ctx.fillStyle = net > 0 ? '#FF5D5D' : (net < 0 ? '#3DDC84' : '#FFF7E8');
    ctx.font = '800 142px ' + FONT;
    ctx.fillText((net > 0 ? '+' : '') + net, W / 2, 344);

    ctx.fillStyle = 'rgba(255,247,232,0.62)';
    ctx.font = '400 30px ' + FONT;
    ctx.fillText('我的净胜', W / 2, 396);

    // 名次
    var myRank = 1;
    for (var i = 0; i < sorted.length; i++) {
      if (sorted[i].id === state.myId) { myRank = i + 1; break; }
    }
    ctx.fillStyle = '#F5C15C';
    ctx.font = '700 32px ' + FONT;
    ctx.fillText(sorted.length + ' 人局 · 第 ' + myRank + ' 名', W / 2, 452);

    // 分隔线
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(72, 506);
    ctx.lineTo(W - 72, 506);
    ctx.stroke();

    // 玩家名次列表
    var top = 566;
    var rowH = Math.min(80, Math.floor((H - top - 148) / Math.max(1, sorted.length)));
    sorted.forEach(function (p, idx) {
      var y = top + idx * rowH;
      var isMe = p.id === state.myId;

      ctx.textAlign = 'left';
      ctx.fillStyle = idx === 0 ? '#F5C15C' : 'rgba(255,247,232,0.45)';
      ctx.font = '800 34px ' + FONT;
      ctx.fillText(String(idx + 1), 80, y);

      ctx.fillStyle = isMe ? '#F5C15C' : 'rgba(255,247,232,0.92)';
      ctx.font = (isMe ? '700' : '500') + ' 32px ' + FONT;
      var name = String(p.nickname || '玩家');
      if (Array.from(name).length > 7) name = Array.from(name).slice(0, 7).join('') + '…';
      ctx.fillText(name, 142, y);

      ctx.textAlign = 'right';
      var sn = p.score - CONFIG.INITIAL_SCORE;
      ctx.fillStyle = sn > 0 ? '#FF5D5D' : (sn < 0 ? '#3DDC84' : 'rgba(255,247,232,0.7)');
      ctx.font = '700 32px ' + FONT;
      ctx.fillText((sn > 0 ? '+' : '') + sn, W - 80, y);
    });

    // 底部署名
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,247,232,0.35)';
    ctx.font = '400 24px ' + FONT;
    ctx.fillText('好友房 · 六张牌两轮分牌', W / 2, H - 50);

    try { return cv.toDataURL('image/png'); } catch (e) { return null; }
  }

  function onShare() {
    if (!state.room) return;
    var url = drawShareCard(state.room);
    if (!url) { flash('生成图片失败，请重试'); Sfx.play('error'); return; }
    var img = $('#share-img');
    if (img) img.src = url;
    showModalEl('share-modal');
    Sfx.play('win');
  }

  /* ---------------------------- 本局过程（回放，P3-7） ----------------------------
   * 数据来自服务端 room.history（最近 4 条 ≈ 两把）。四组玩法规则差异大，
   * 结算页只有分数变化，"刚才那把怎么输的"没法复现 —— 这里给逐轮明细：
   * 谁分了什么牌、比的是哪个玩法、谁赢、每人加减多少。
   *
   * 只展示公开信息：这些牌在结算那一刻本来就已经揭开，不是新的泄漏面。
   */
  /* 手牌文本：实时数据里是牌对象，存档里是已经转好的字符串。两种都要认。 */
  function handText(hand) {
    if (!Array.isArray(hand)) return '';
    var out = [];
    for (var i = 0; i < hand.length; i++) {
      var c = hand[i];
      out.push(typeof c === 'string' ? c : cardText(c));
    }
    return out.join(' ');
  }

  /* ---------------------------- 回放渲染 ----------------------------
   * 入参统一是 **packs**：[{ hands, rounds:[{ r, groups:[{l,w,t,rows}] }] }]。
   * 三个来源都能变成它：
   *   实时   → packHistory(room.history)
   *   整场   → SessionLog.load(key).packs
   *   老记录 → [rec.replay]（只有一把）
   * 以前这里是「把 live 和存档分成两个分支各走一遍」，加了整场之后三分支会互相打架，
   * 所以改成先归一到 packs 再渲染，只有一处写法。
   */
  function replayViews(packs) {
    var views = [];
    if (!packs || !packs.length) return views;
    var sorted = packs.slice().sort(function (a, b) { return (a.hands || 1) - (b.hands || 1); });
    for (var i = 0; i < sorted.length; i++) {
      var pack = sorted[i];
      var rounds = (pack.rounds || []).slice().sort(function (a, b) { return (a.r || 1) - (b.r || 1); });
      var roundViews = [];
      var myNet = 0;
      var hasMe = false;
      for (var j = 0; j < rounds.length; j++) {
        var rd = rounds[j];
        roundViews.push({
          r: rd.r || 1,
          groups: (rd.groups || []).map(function (g) {
            /* 已注销占位：i 与 n **同时**为空。只有 i 为空是「老数据没存 id」,
             * 名字照旧显示 —— 两者混起来会让老记录凭空变成「已注销玩家」。
             * 判据与 SessionLog.scrub 保持一致，改一处必须改两处。 */
            var hasAnon = false;
            var rows = (g.rows || []).map(function (w) {
              var anon = !w.i && !w.n;
              if (anon) hasAnon = true;
              return {
                name: anon ? '已注销玩家' : (w.n || '玩家'),
                anon: anon,
                cards: (w.c || []).join(' '),
                delta: w.d || 0,
                /* 「我」靠 id 认，不靠昵称 —— 昵称可以重名，重名时会把别人标成我。 */
                isMe: !!(w.i && state.myId && String(w.i) === String(state.myId))
              };
            });
            var meWin = false;
            for (var q = 0; q < rows.length; q++) {
              if (!rows[q].isMe) continue;
              hasMe = true;
              myNet += rows[q].delta;         // 这一把里我的净分（跨所有轮次累加）
              if (rows[q].delta > 0) meWin = true;
            }
            /* 组头的赢家只有昵称、没有 id。那个昵称属于已注销的人时 scrub 会把它
             * 清空，这里补一个占位 —— 否则会渲染成「 赢」，看着像坏了。 */
            return { label: g.l, winner: g.w || (hasAnon ? '已注销玩家' : ''), type: g.t, rows: rows, meWin: meWin };
          })
        });
      }
      views.push({
        hands: pack.hands || 1,
        /* no = 本局第几把（显示用），g = 局号。缺了就走回退：
         * no 没有就沿用身份号（老数据只能这样），g 没有就归 0（不分局）。 */
        no: Math.max(1, Math.round(Number(pack.no) || Number(pack.hands) || 1)),
        g: Math.max(0, Math.round(Number(pack.g) || 0)),
        rounds: roundViews,
        myNet: myNet,
        hasMe: hasMe
      });
    }
    return views;
  }

  /* @param {Array} packs  过程数据（已归一）
   * @param {Object} [opts] { targetHand }  打开时定位并把哪一把标成「你点的这把」 */
  function renderReplay(packs, opts) {
    var body = $('#replay-body');
    if (!body) return;
    if (packs === undefined) packs = packHistory((state.room && state.room.history) || []);
    /* 安全网：不管哪个入口进来，只渲染「你点的那一把」所在的那一局 */
    /* ★ v132 修：**标题必须和正文同源**。
     *
     * 上一版我在 openReplay 里"先收窄再算标题"，但战绩页那条入口不经过 openReplay ——
     * 它自己 setReplaySub(replaySubText(packs)) 之后才调 renderReplay，
     * 于是出现了「正文 3 把、右上角写 2 局 · 6 把」（用户截图实测）。
     *
     * 只在**真的收窄了**的时候重算：没收窄就保留调用方写的那句
     * （战绩页在老记录上写的是「只留下最后一把」，那是信息，不能被覆盖掉）。 */
    var lenBefore = packs.length;
    packs = useSameGame(packs, (opts && opts.targetHand) || 0);
    if (packs.length !== lenBefore && typeof setReplaySub === 'function' && typeof replaySubText === 'function') {
      setReplaySub(replaySubText(packs));
    }
    var views = replayViews(packs);
    if (!views.length) {
      body.innerHTML = '<p class="replay-empty">这一局没有留下过程记录。</p>';
      return;
    }
    var target = (opts && opts.targetHand) || 0;
    /* 整场档案会把同一个房间的前后**两局**装在一起（场次 key 是房号+建房时间，
     * 点「开始下一局」不会换房间）。这时候必须把局分开：不然第二局的「第 1 把」
     * 会跟第一局的「第 1 把」并排出现，读的人以为是重复数据。
     * 只有一局（或老数据没有 g）时不出这个标题 —— 多一行没有信息量的字，
     * 只是把本来就紧的弹窗再挤一点。 */
    var multiGame = false;
    for (var gi = 1; gi < views.length; gi++) {
      if (views[gi].g !== views[0].g) { multiGame = true; break; }
    }
    var lastG = null;
    var html = '';
    for (var i = 0; i < views.length; i++) {
      var v = views[i];
      if (multiGame && v.g !== lastG) {
        lastG = v.g;
        html += '<div class="replay-game-title">第 ' + (v.g + 1) + ' 局</div>';
      }
      var isTarget = !!target && v.hands === target;
      html += '<section class="replay-pack' + (isTarget ? ' is-target' : '') + '" data-hand="' + v.hands + '">';
      /* 每把右上角给出「我这把赢/输多少」：原来只有「第 8 把」三个字，
       * 读的人得把下面每一组的 +2/-1 自己加起来才知道这把自己是赚是亏。 */
      var netTxt = '';
      if (v.hasMe) netTxt = '我 ' + (v.myNet > 0 ? '+' : '') + v.myNet;
      /* ★ 显示用 no（本局第几把），**不是** hands。
       * hands 是 hid，跨局连续；拿它当标题就是「第二局从第 4 把开始」。 */
      html += '<header class="replay-pack-head">'
        + '<span class="replay-pack-no">第 ' + v.no + ' 把</span>'
        + (isTarget ? '<span class="replay-pack-flag">你点的这把</span>' : '')
        + (netTxt ? '<span class="replay-pack-net ' + (v.myNet > 0 ? 'up' : (v.myNet < 0 ? 'down' : 'flat')) + '">' + netTxt + '</span>' : '')
        + '</header>';
      for (var j = 0; j < v.rounds.length; j++) {
        var rd = v.rounds[j];
        html += '<div class="replay-round">';
        html += '<div class="replay-round-title">第 ' + rd.r + ' 轮</div>';
        for (var k = 0; k < rd.groups.length; k++) {
          var g = rd.groups[k];
          html += '<div class="replay-group">';
          html += '<div class="replay-line"><span class="replay-label">' + esc(g.label || '') + '</span>';
          /* 我赢的那几组写「我赢」—— 长昵称在这行本来就会被挤，
           * 而且自己赢的那一组是最先想确认的，写成自己的名字反而不显眼。 */
          html += '<span class="replay-winner' + (g.meWin ? ' is-me' : '') + '">'
            + (g.meWin ? '我赢' : (esc(g.winner || '') + ' 赢'))
            + (g.type ? '（' + esc(g.type) + '）' : '') + '</span></div>';
          for (var m = 0; m < g.rows.length; m++) {
            var r = g.rows[m];
            var d = r.delta || 0;
            var cls = d > 0 ? 'up' : (d < 0 ? 'down' : 'flat');
            html += '<div class="replay-row' + (r.isMe ? ' is-me' : '') + '">'
              + '<span class="replay-name">' + esc(r.name || '') + (r.isMe ? '<i class="replay-you">我</i>' : '') + '</span>'
              + '<span class="replay-cards">' + esc(r.cards) + '</span>'
              + '<span class="replay-delta ' + cls + '">' + (d > 0 ? '+' : '') + d + '</span>'
              + '</div>';
          }
          html += '</div>';
        }
        html += '</div>';
      }
      html += '</section>';
    }
    body.innerHTML = html;

    /* ★ 这里不能直接 scrollIntoView：此刻弹窗还是 hidden（display:none），
     * 元素没有布局，滚动调用是空转，看起来就是「没定位」。
     * 存下目标，等 showModalEl 之后再滚（见 scrollReplayToTarget）。 */
    replayTargetHand = target || 0;
    body.scrollTop = 0;
  }
  var replayTargetHand = 0;

  /* 回放副标题：这份过程里到底有什么。
   *
   * 一场档案（房号 + 建房时间）会横跨同一个房间里的多局 —— 点「开始下一局」
   * 不换房间，所以「整场 6 把」在跨局时是真的，但读的人会把它理解成
   * 「这一局我打了 6 把」。跨局就明写「2 局 · 6 把」，不跨局维持原话。 */
  function replaySubText(packs) {
    if (!packs || !packs.length) return '';
    var seen = {};
    var games = 0;
    for (var i = 0; i < packs.length; i++) {
      var g = Math.max(0, Math.round(Number(packs[i].g) || 0));
      if (!seen[g]) { seen[g] = true; games++; }
    }
    return games > 1 ? (games + ' 局 · ' + packs.length + ' 把') : ('整场 ' + packs.length + ' 把');
  }

  /* 弹窗显示之后再定位。roll 到「你点的那把」顶上，
   * 而不是滚到底 —— 人想看的是自己刚打完那一把的开头。 */
  function scrollReplayToTarget() {
    var body = $('#replay-body');
    if (!body || !replayTargetHand) return;
    var hit = body.querySelector('.replay-pack.is-target');
    if (!hit) return;
    if (hit.scrollIntoView) {
      try { hit.scrollIntoView({ block: 'start' }); return; } catch (e) { /* 老浏览器不支持参数 */ }
    }
    body.scrollTop = Math.max(0, hit.offsetTop - body.offsetTop - 8);
  }

  /* 标题右侧的小字：「共 9 把」这种事实描述，没有数据就不写。 */
  function setReplaySub(text) {
    var sub = $('#replay-sub');
    if (!sub) return;
    sub.textContent = text || '';
    sub.classList.toggle('hidden', !text);
  }

  /* 过程数据只有两个来源，顺序固定：本机场次档案（整场）优先，
   * 没有就退回服务端那份滚动窗口（只留最近几把）。
   * 抽成函数是因为「打开回放」和「打开回放并定位到这一把」必须是同一份数据 ——
   * 两个入口各读一遍，迟早出现「从底部按钮进来是 9 把，从结算行进来是 5 把」。 */
  function replayPacksOf(room) {
    var packs = null;
    if (room && typeof SessionLog !== 'undefined') {
      try {
        var sess = SessionLog.load(SessionLog.keyOf(room));
        if (sess && sess.packs && sess.packs.length) packs = sess.packs;
      } catch (e) { /* 读不到（配额满 / JSON 坏）就用回落那份 */ }
    }
    if (!packs) packs = packHistory((room && room.history) || []);
    return packs || [];
  }

  /* 把「想定位的那一把」落到实际存在的 pack 上，返回它的 hands；定位不到返回 0。
   *
   * 为什么要有兜底：结算页点行时拿的是 room.handId，而这个数字在「开下一把」
   * 之后会 +1 —— 别人抢先开了下一局、房间历史被裁掉、或者整场档案被清理过，
   * 都可能让这一把已经不在 packs 里。
   * 这时候退回**最后一把**，而不是不定位：结算页上点一下却停在整场开头，
   * 和弹「没有过程记录」一样，都是把「定位不到」说成「数据没有」。 */
  function replayTargetOf(packs, want) {
    if (!want || !packs || !packs.length) return 0;
    for (var i = 0; i < packs.length; i++) {
      if (packs[i].hands === want) return want;
    }
    return packs[packs.length - 1].hands || 0;
  }

  /* 按局收窄由 historyKit.sameGameOnly 提供（纯函数，可单测） */
  var sameGameOnly = deps.sameGameOnly;
  /* 老缓存里可能还没这个函数（两侧同一次发布，只有混装才会）：退回原样，绝不让弹窗崩。 */
  function useSameGame(packs, target) {
    return typeof sameGameOnly === 'function' ? sameGameOnly(packs, target) : (packs || []);
  }

  /* 房间内打开：优先用本机场次档案（整场），没有就退回服务端那份滚动窗口。
   * opts.prev：从就位态打开。此时复盘对象已经是「上一局」——
   * 还写「这一局」会让人以为正在打的那把已经打完了。
   * opts.targetHand：打开时定位并高亮哪一把（见 openReplayHere）。 */
  function openReplay(opts) {
    var isPrev = !!(opts && opts.prev);
    var room = state.room;
    var packs = replayPacksOf(room);
    var target = replayTargetOf(packs, (opts && opts.targetHand) || 0);
    /* 先按局收窄，再算标题 —— 否则标题还是「4 局 · 12 把」，正文却只剩一局 */
    packs = useSameGame(packs, target);
    var t = $('#replay-title');
    if (t) t.textContent = isPrev ? '上一局' : '这一局';
    setReplaySub(replaySubText(packs));
    renderReplay(packs, { targetHand: target });
    showModalEl('replay-modal');
    scrollReplayToTarget();   // 没给 targetHand 时目标为 0，不滚（行为和以前一致）
    pushModalState();
    /* 清理之后要重画一次，而且必须**重新从本机档案读**：
     * scrub 改的是磁盘上那份，内存里的 packs 还是清理前的，拿它重画等于什么都没变。
     * 定位要一起带过去 —— 清理完停在整场开头，等于把「我刚点的这一把」弄丢了。 */
    replayReopen = function () {
      var again = replayPacksOf(room);
      renderReplay(again, { targetHand: replayTargetOf(again, target) });
    };
    purgeDeletedIdentities();
  }

  /* 结算页 / 「上一局结算」弹窗里点某一行 = 看**这一把**的过程。
   *
   * 为什么需要这个入口：结算页底部那颗「回放」打开的是整场第 1 把，
   * 打满 9 把的人想知道「刚才那 3 组为什么这么算」，得自己往下滑到第 9 把。
   * 而结算页上唯一想确认的就是刚打完的这一把 —— 点哪里都应该直接落在这儿。
   *
   * 定位失败（见 replayTargetOf）退回最后一把；一盘过程都没留下就明说，
   * 不要打开一个空弹窗让人以为是加载失败。 */
  function openReplayHere() {
    var room = state.room;
    if (!room) return;
    var packs = replayPacksOf(room);
    if (!packs.length) { flash('这一局没有留下过程记录'); return; }
    /* handId 是这一把的编号（dealAll 里递增，不受重启影响）；
     * 老房间没有 handId 就退回 handCount —— 它只在「开下一把」时归 1，
     * 定位会偏，但比完全不给目标强。 */
    openReplay({ targetHand: room.handId || room.handCount || 0 });
    Sfx.play('select');
  }

  /* 从战绩页打开一场的回放（退房之后仍然能看）。
   * 优先走 SessionLog 的整场档案；老记录没有 sessionKey，只有单把 replay，就只显示那把。
   * 存档里的牌是字符串、且已经进过 localStorage，所以渲染路径必须 esc ——
   * 它和实时数据不同，理论上可以被用户自己改脏。 */
  function openSavedReplay(rec) {
    if (!rec) return;
    var sess = null;
    if (rec.sessionKey && typeof SessionLog !== 'undefined') {
      sess = SessionLog.load(rec.sessionKey);
    }
    var packs = sess ? sess.packs : (rec.replay ? [rec.replay] : []);
    if (!packs.length) { flash('这一局的过程没有留在本机'); return; }
    var t = $('#replay-title');
    if (t) t.textContent = fmtTime(rec.endedAt) + ' 这一局';
    /* 副标题只说**有什么**，不说「这一把的过程」这种等于没说的话。
     * 走单把兜底时必须讲清原因（老记录没存整场），否则用户会以为整场丢了。 */
    setReplaySub(sess ? replaySubText(packs) : '只留下最后一把');
    renderReplay(packs, { targetHand: rec.handId || 0 });
    showModalEl('replay-modal');
    scrollReplayToTarget();
    pushModalState();
    Sfx.play('select');
    /* 同 openReplay：重画必须从磁盘重新读。整场档案优先，
     * 没有就回到这条记录自带的单把副本（从本机战绩里重新取，拿清理后的那份）。 */
    replayReopen = function () {
      var again = null;
      try {
        if (rec.sessionKey && typeof SessionLog !== 'undefined') {
          var s2 = SessionLog.load(rec.sessionKey);
          if (s2) again = s2.packs;
        }
        if (!again && typeof Records !== 'undefined' && rec.id) {
          var list = Records.all();
          for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].id === rec.id && list[i].replay) { again = [list[i].replay]; break; }
          }
        }
      } catch (e) { /* 读不到就不重画，保持现状 */ }
      if (again && again.length) renderReplay(again, { targetHand: rec.handId || 0 });
    };
    purgeDeletedIdentities();
  }
  function closeReplay() {
    hideModalEl('replay-modal');
  }

  function closeShare() {
    hideModalEl('share-modal');
  }

  /* 平台能力探测：iOS / 微信内置浏览器不支持 <a download>，Web Share 支持情况也不同 */
  function isIOS() {
    var ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  function isWeChat() {
    return /MicroMessenger/i.test(navigator.userAgent || '');
  }
  function supportsDownload() {
    // iOS Safari / 微信内置浏览器都没有可用的 <a download>，用 UA 直接判，比探测更稳
    return !(isIOS() || isWeChat());
  }

  function onShareSave() {
    var img = $('#share-img');
    if (!img || !img.src) return;
    var fname = '六选五-' + (state.room ? state.room.roomId : '战绩') + '.png';

    // 能下载的平台（桌面 Chrome/Edge、Android Chrome）：直接触发下载，如实反馈结果
    if (supportsDownload()) {
      try {
        var a = document.createElement('a');
        a.href = img.src;
        a.download = fname;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        flash('已开始下载，请查看浏览器下载记录');
        return;
      } catch (e) {
        /* 平台不支持 a.download 时会抛（部分旧版安卓 WebView）。
         * 用户侧已经有准确的降级指引，所以这里只上报、不换文案。 */
        reportQuietly('shareSave', e);
        flash('下载失败，长按图片保存');
        return;
      }
    }

    /* 支持文件分享的浏览器都走系统面板。
     *
     * 原来这里卡了 `isIOS()`：Android Chrome 早就支持 canShare({files})，
     * 却因为这条判断掉进了"请长按图片保存"——功能明明有，用户却用不上。
     * 正确做法是只排除明确不支持的容器（微信内置浏览器），
     * 其余交给 canShare 自己判断，它是唯一有资格回答这个问题的 API。 */
    if (!isWeChat() && navigator.canShare) {
      fetch(img.src)
        .then(function (r) { return r.blob(); })
        .then(function (blob) {
          var file = new File([blob], fname, { type: 'image/png' });
          if (!navigator.canShare({ files: [file] })) {
            flash('长按图片即可保存到相册');
            return;
          }
          return navigator.share({ files: [file] }).catch(function () {
            // 用户取消分享不算失败，给个中性提示引导长按
            flash('长按图片即可保存到相册');
          });
        })
        .catch(function () {
          flash('长按图片即可保存到相册');
        });
      return;
    }

    // 微信内置浏览器 / 老 iOS：没有系统下载，老老实实告诉用户长按保存，不谎报
    flash('请长按图片保存到相册');
  }

  /* ---------------------------- 排行榜 ----------------------------
   * 数据来自服务端聚合（/api/leaderboard），和本机「我的战绩」是两套口径：
   * 本机记录只在本设备，排行榜是所有人共享的云端成绩。 */
  function openRank() {
    state.screen = 'rank';
    showScreen('screen-rank');
    renderRank();
  }

  function closeRank() {
    state.screen = '';
    showScreen('screen-home');
  }

  /* 网关要求所有请求都带 sharecode：不带参数的 /api/* 一律 403（连 /api/health 都是）。
   * 页面是用 ?sharecode=xxx 打开的，所以同源的 fetch 必须把这个参数带过去，
   * 否则排行榜永远「加载失败」——这个坑很隐蔽，用 curl 手动带参数测是测不出来的。 */
  /* 只上报、不额外弹错的小出口（v127）。
   *
   * 为什么不复用 game.js 的 reportBug：那是 game.js 闭包里的函数，两个模块互不可见。
   * 这里也**不需要**提示，因为调用点自己已经给了用户一句准确的话
   *（如「下载失败，长按图片保存」）—— 缺的只是"我们这边知道"。
   */
  function reportQuietly(where, e) {
    try {
      if (typeof ErrorReport !== 'undefined' && ErrorReport && ErrorReport.capture) {
        ErrorReport.capture('catch', '[' + where + '] ' + ((e && (e.message || String(e))) || 'unknown'), {
          source: 'recordsView.js',
          stack: e && e.stack
        });
      }
    } catch (_) { /* silence: 上报自身绝不能再抛 */ }
  }

  function apiQuery(extra) {
    var parts = [];
    try {
      var sc = new URLSearchParams(location.search || '').get('sharecode');
      if (sc) parts.push('sharecode=' + encodeURIComponent(sc));
    } catch (e) {}
    if (extra) {
      Object.keys(extra).forEach(function (k) {
        if (extra[k] === undefined || extra[k] === null || extra[k] === '') return;
        parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(extra[k]));
      });
    }
    return parts.length ? '?' + parts.join('&') : '';
  }

  /* 榜单失败：**独立块 #rank-fail**，不再改写 #rank-empty 的文案（build-states v1 §3.2/§3.4.7）。
   *
   * 以前失败只是把空态那句换成「排行榜加载失败，请检查网络后重试」，两个毛病：
   *   ① 等于把"接口挂了"伪装成"还没人上榜"，以后排查会一直以为是真的没人玩；
   *   ② 那句里带着禁用词「重试」，而它出现在一个**没有任何按钮**的提示里 ——
   *      玩家被告知可以重试，但屏上没有能点的东西。
   * 现在失败有自己的块、自己的按钮（刷新榜单），空态那句永远只说"还没人上榜"。 */
  function showRankFail() {
    var loading = $('#rank-loading');
    var emptyEl = $('#rank-empty');
    var failEl = $('#rank-fail');
    var bodyEl = $('#rank-body');
    var scrollEl = $('#rank-scroll');
    var e = errText('err.net.rank');
    if (loading) loading.classList.add('hidden');
    if (emptyEl) emptyEl.classList.add('hidden');
    if (bodyEl) bodyEl.classList.add('is-empty');
    if (scrollEl) scrollEl.classList.add('is-empty');
    if (!failEl) return;
    setStateText(failEl, e.title, e.sub);
    failEl.classList.remove('hidden');
  }

  async function renderRank() {
    var loading = $('#rank-loading');
    var listEl = $('#rank-list');
    var emptyEl = $('#rank-empty');
    var failEl = $('#rank-fail');
    /* 空态标记：榜单为空时提示语要**居中占满**列表区。
     * 不加这个类的话提示会贴着顶部走（.rank-tip 有 120px 上内边距），
     * 竖屏下面留出 70% 的空白 —— 全流程巡检在 6 个视口上量到同一处。 */
    var bodyEl = $('#rank-body');
    var scrollEl = $('#rank-scroll');
    if (loading) loading.classList.remove('hidden');
    if (listEl) { listEl.classList.add('hidden'); listEl.innerHTML = ''; }
    if (emptyEl) emptyEl.classList.add('hidden');
    if (failEl) failEl.classList.add('hidden');

    /* 离线时**不发**注定失败的请求（R3 / S9）。
     * 榜单没有自己的离线块 —— 再建一个块就是第五个载体，而离线态的载体只许
     * #records-offline 一个。这里用失败块说同一件事的上一句原因（"榜单没读上来"），
     * 一个字的文案都不新造。 */
    if (isOfflineNow()) {
      showRankFail();
      return;
    }

    var rows = [];
    var mine = null;
    var failed = false;
    try {
      // 带上自己的 id：榜单只给 top50，排在外面的人也得能看见自己第几
      var res = await fetch('/api/leaderboard' + apiQuery({ me: state.myId }), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      rows = (data && data.list) || [];
      mine = (data && data.me) || null;
    } catch (e) {
      // 接口挂了不能伪装成「还没人上榜」，否则以后排查会一直以为是真的没人玩
      failed = true;
      rows = [];
      /* 榜单是唯一"坏了会被人立刻看见"的接口，所以要上报（design §②-a）。
       * source 写明是 renderRank —— 同一句"读不到"，出自两个接口时要分得开。 */
      reportErr('err.net.rank', { status: (e && e.status) || 0 });
    }

    if (loading) loading.classList.add('hidden');
    if (bodyEl) bodyEl.classList.toggle('is-empty', !rows.length);
    /* 类同时挂到滚动容器上：.rp-scroll 是 flex 项、高度是确定的，
     * 只有它能给 #rank-body 一个「撑满并居中」的参照高度。 */
    if (scrollEl) scrollEl.classList.toggle('is-empty', !rows.length);
    if (failed) { showRankFail(); return; }
    if (!rows.length) {
      if (emptyEl) {
        /* 失败已经在上面分走了 —— 走到这里就一定是真的没人上榜 */
        emptyEl.textContent = '还没有人上榜，打完一局就会出现在这里';
        emptyEl.classList.remove('hidden');
      }
      return;
    }

    /* 一行榜单。isMe 用于高亮「我」——榜上找不到自己是最伤的一种小事 */
    function rankRowHtml(r, rank, isMe) {
      var medal = rank === 1 ? '🥇' : (rank === 2 ? '🥈' : (rank === 3 ? '🥉' : rank));
      var pid = String(r.playerId == null ? '' : r.playerId);
      /* 整行带 pid → 点一下看这个人的云端档案，和房间座位卡、结算页玩家行同一个出口。
       * data-nick 一起带上，是因为 openProfile 只能从当前房间里找昵称，
       * 而榜上的人多半不在我房间里 —— 不带的话卡片会先显示「玩家」再跳成真名。 */
      return '<li class="rank-row' + (rank <= 3 ? ' is-top' : '') + (isMe ? ' is-me' : '') + '"'
        + (pid ? ' data-pid="' + esc(pid) + '" data-nick="' + esc(r.nickname || '') + '"' : '')
        + '>'
        + '<span class="rank-no">' + medal + '</span>'
        + '<span class="rank-name">' + esc(r.nickname || '玩家')
        + (isMe ? '<i class="rank-you">我</i>' : '') + '</span>'
        + '<span class="rank-meta">' + (r.games || 0) + ' 场 · ' + (r.winRate || 0) + '%</span>'
        + '<span class="rank-net ' + netCls(r.totalNet || 0) + '">' + netText(r.totalNet || 0) + '</span>'
        + (pid ? '<span class="rank-go" aria-hidden="true">›</span>' : '')
        + '</li>';
    }

    var html = '';
    var mineInList = false;
    rows.forEach(function (r, i) {
      var isMe = !!(state.myId && String(r.playerId) === String(state.myId));
      if (isMe) mineInList = true;
      html += rankRowHtml(r, i + 1, isMe);
    });

    /* 排在 top50 之外：把自己的名次钉在榜尾，前面用一段省略号隔开。
     * 只在不增不减的地方「贴」一行，不改变别人的名次显示。 */
    if (mine && !mineInList) {
      html += '<li class="rank-gap" aria-hidden="true">· · ·</li>'
        + rankRowHtml(mine, mine.rank, true);
    }
    if (listEl) {
      listEl.innerHTML = html;
      listEl.classList.remove('hidden');
    }
  }

  /* ====================== 已注销玩家的本地清理 ======================
   *
   * 背景：删号能覆盖的边界是「服务端 + 本人的设备」。你和别人打过的回放副本
   * 存在**对方的手机上**，服务端碰不到 —— 唯一可行的清理时机，是对方下次
   * 打开战绩或回放的时候：问一句「这些人还在吗」，然后把他本地那份里的
   * 名字抹掉。这个函数就是那一步的调度。
   *
   * 四条必须守住的边界：
   *   1. **查不到就什么都不做**。离线、接口 500、返回畸形，统统保持原样。
   *      误删不可逆；而留着最多是多等一次，下次打开还会再问一遍。
   *   2. 一次最多问 50 个（服务端上限）。超了只查前 50，剩下的下次再查 ——
   *      不做分批并发，因为这件事一点都不急，而并发只会让失败路径更难想。
   *   3. 30 秒内不重复问。打开战绩页再点回放会连着触发两次，
   *      第二次的结果和第一次一样，白白多一次请求。
   *   4. 自己不用问。要是自己都注销了，这会儿根本看不到这个页面。
   */
  var purgeAskedAt = 0;
  var purgeInFlight = false;
  /* 回放弹窗此刻是怎么打开的（房间内 / 从战绩页打开）。
   * 清理完成后要按原样重画一次 —— 否则用户看到的是清理前渲染好的那份，
   * 会以为"没删掉"。存函数而不是存参数，是因为两条路径的入参形状不一样。 */
  var replayReopen = null;

  function replayOwners() {
    var ids = [];
    var seen = {};
    function push(list) {
      for (var i = 0; i < list.length; i++) {
        var id = String(list[i] || '');
        if (!id || seen[id]) continue;
        if (state.myId && id === String(state.myId)) continue;
        seen[id] = 1;
        ids.push(id);
      }
    }
    try { if (typeof SessionLog !== 'undefined' && SessionLog.owners) push(SessionLog.owners()); } catch (e) { /* 坏数据：跳过 */ }
    try { if (typeof Records !== 'undefined' && Records.owners) push(Records.owners()); } catch (e) { /* 同上 */ }
    return ids;
  }

  function purgeDeletedIdentities() {
    if (purgeInFlight) return;
    if (!cloudRecordsReady()) return;                       // 离线 / 本地演示模式
    if (Date.now() - purgeAskedAt < 30000) return;
    var ids = replayOwners();
    if (!ids.length) return;

    purgeInFlight = true;
    purgeAskedAt = Date.now();
    var batch = ids.slice(0, 50);

    /* 走 AuthStore 而不是裸 fetch：它会拼 sharecode、带 X-Session-Token。
     * 裸 fetch 在本地一切正常、到了线上被网关 403 —— 这条路径平时没有可见反馈
     * （清不掉就是没清掉，界面上看不出差别），所以更不能图省事。 */
    var req = (typeof AuthStore !== 'undefined' && AuthStore.playersAlive)
      ? AuthStore.playersAlive(batch)
      : Promise.resolve(null);

    req
      .then(function (data) {
        purgeInFlight = false;
        if (!data || data.ok !== true || !Array.isArray(data.dead) || !data.dead.length) return;
        var hit = 0;
        try { if (typeof SessionLog !== 'undefined' && SessionLog.scrub) hit += SessionLog.scrub(data.dead).rows; } catch (e) { /* 忽略 */ }
        try { if (typeof Records !== 'undefined' && Records.scrubReplays) hit += Records.scrubReplays(data.dead).rows; } catch (e) { /* 忽略 */ }
        if (!hit) return;
        /* 真的改到了才重画。没改到就重画会让页面莫名闪一下。 */
        try { if (state.screen === 'records') renderRecords(); } catch (e) { /* 忽略 */ }
        try {
          if (replayReopen && isShown($('#replay-modal'))) replayReopen();
        } catch (e) { /* 忽略 */ }
      })
      .catch(function () {
        /* 查不到就什么都不做 —— 但**必须留痕**（design §②-a 的 err.silent.purge）。
         * 误删不可逆，所以"没查成"也必须可追溯；这一条是静默类的标准形状：
         * 上报一条，页面一个像素都不动（玩家此刻正在看回放，不需要知道我们问了谁）。 */
        purgeInFlight = false;
        purgeAskedAt = 0;
        reportErr('err.silent.purge');
      });
  }

  /* ---------------------------- 四态里的按钮（唯一派发口） ----------------------------
   * data-act 是动作名，按钮上的字只是它的呈现。这样"哪个按钮干什么"只有一处答案：
   * 加一档错误不用改 HTML，改文案不用碰逻辑。
   * 反过来做（每个按钮一个 handler、文案写死在标签上）就会漂成
   * "重新登录"那个按钮其实调的是 retry —— 而这种错在界面上看不出来。 */
  function onErrAction(act) {
    if (act === 'retry') { retryCloudRecords(); return; }
    if (act === 'reload') { retryCloudRecords(); return; }   // 断网恢复后是同一个动作
    if (act === 'refresh') { renderRank(); return; }
    if (act === 'create') { onCreateFromRecords(); return; }
    if (act === 'login') { state.screen = 'auth'; showScreen('screen-auth'); return; }
    if (act === 'clear') { openClearModal(); return; }
  }

  /* 重试：必须**真的重发一次，且只发一次**（QA S6 用网络层计数验）。
   * 这里不做防抖、不做退避 —— 那是"玩家点了没反应"的另一种写法。 */
  function retryCloudRecords() {
    if (isOfflineNow()) {
      /* 离线时不发注定失败的请求（build-states v1 R3 / S9）。
       * 这一下点击要上报：断网下点按钮的次数是"该不该做真离线模式"的唯一依据。 */
      reportErr('err.net.offline');
      flash('现在没有网络，恢复后再试');
      renderRecords();
      return;
    }
    cloudRecordsErr = '';
    cloudRecordsErrKey = '';
    cloudStatus = 0;
    if (recordsHasData) {
      /* 降级重试：**内容不藏起来**（玩家正在看它），只让页脚那个小按钮自己变忙。
       * 把整屏换成"加载中"等于为了重读一份附加数据，没收他正在看的主内容。 */
      var btn = $('#records-source-retry');
      if (btn) { btn.disabled = true; btn.classList.add('is-busy'); btn.textContent = '读取中…'; }
      loadCloudRecords(true);
      return;
    }
    loadingSince = Date.now();     // 新的一轮：慢文案的 1 秒从这一刻重新算
    renderRecords();               // → 立即落加载态（早过了 250ms 门槛，不再压着）
    loadCloudRecords(true);
  }

  /* 断网 / 恢复由 game.js 的 online / offline 事件通知到这里（§3.5.2）。
   * 恢复时**先收条再重取**：条子留着会让人以为还没连上；不重取就会一直停在
   * 本机兜底那一份上，而玩家已经能连网了。两件事在同一个同步帧里做完，
   * 远在"500ms 内"的验收线之内。 */
  function onNetChange(online) {
    if (state.screen !== 'records') return;
    renderRecords();
    if (!online) return;
    cloudRecordsErr = '';
    cloudRecordsErrKey = '';
    cloudStatus = 0;
    /* force：刚恢复网络时那份缓存多半已经旧了，TTL 在这里是负资产 */
    loadCloudRecords(true);
  }

  function openRecords(from) {
    state.screen = 'records';
    state.recordsFrom = from === 'settle' ? 'settle' : 'home';
    cloudRecordsErr = '';          // 每次打开都允许重试一次云端（上一次的失败不代表现在也失败）
    cloudRecordsErrKey = '';
    cloudStatus = 0;
    /* 250ms 门槛从**进门**算，不从某次渲染算：换了屏、再进来，就是新的一轮。 */
    recordsEnterAt = Date.now();
    loadingSince = 0;
    clearStateTimers();
    renderRecords();
    /* 先出图再拉云端；回来时同一次渲染里替换。
     * ★ 离线时不发（R3/S9）：8 秒空等对玩家是纯损失，而且"等完再报超时"会把
     *   离线说成"服务器没应声"—— 原因说错，玩家就会去修错的东西。
     *   此时页面上是离线态，横条里那个「重新载入」才是主动重试的入口。 */
    if (!isOfflineNow()) loadCloudRecords(false);
    /* 顺手问一句「我回放里的人还有几个在」。不发等待、不挡渲染：
     * 查到了会把本机副本里的名字抹掉并重画，查不到（离线）就什么都不做。 */
    purgeDeletedIdentities();
    var sc = $('#records-scroll');
    if (sc) sc.scrollTop = 0;
    showScreen('screen-records');
  }

  function closeRecords() {
    state.screen = '';
    /* 离开这一屏就把两个计时器清掉：门槛 timer 会在别的屏上把数据行显示出来，
     * 慢文案 timer 会把"比平时慢一点"写进一个玩家已经离开的页面。 */
    clearStateTimers();
    recordsEnterAt = 0;
    loadingSince = 0;
    if (state.recordsFrom === 'settle' && state.room) { render(); return; } // 从结束页来 → 回结束页
    showScreen('screen-home');                                            // 从首页来 → 回首页
  }

  /* 空态「创建房间」：回首页并聚焦创建（昵称输入框） */
  function onCreateFromRecords() {
    state.screen = '';
    showScreen('screen-home');
    var input = $('#nickname-input');
    if (input) { try { input.focus(); } catch (e) {} }
  }

  /* ---------------------------- 清除战绩确认 ----------------------------
   * 关键点：默认**连云端一起清**。
   * 用户点「清除记录」时想的是「把我这个号的数据清掉」；只删本机不动服务器，
   * 回到排行榜还看得见战绩 —— 那正是这次要修的 bug。想保留云端可以取消勾选。 */
  function openClearModal() {
    var useCloud = cloudRecordsValid();
    var pid = recordsPid();
    var st = useCloud ? cloudStats(cloudRecords)
      : ((typeof Records !== 'undefined' && Records.available())
        ? Records.stats(pid || undefined) : EMPTY_STATS);
    if (!st.games) return;               // 无数据不弹（空态也看不到入口）
    /* 确认时要写一句「将清除 N 场」，而这个 N 只能来自这里 ——
     * 确认那一刻再去算一次，可能因为云端档案刷新而变，会让文案和刚才看到的不一致。 */
    clearCount = st.games;

    var canCloud = cloudRecordsReady();
    var box = $('#records-clear-cloud');
    var wrap = $('#records-clear-cloud-wrap');
    if (box) { box.checked = canCloud; box.disabled = !canCloud; }
    if (wrap) wrap.classList.toggle('is-off', !canCloud);

    $('#records-clear-count').textContent = '当前 ' + st.games + ' 场记录将被删除';
    showModalEl('records-clear-modal');
    pushModalState();
  }
  function closeClearModal() { hideModalEl('records-clear-modal'); }

  function onClearConfirmed() {
    var pid = recordsPid();
    var box = $('#records-clear-cloud');
    var withCloud = cloudRecordsReady() && !!(box && box.checked);
    var n = clearCount || 0;
    closeClearModal();

    /* 真正清：这一段是 v135 的老逻辑，一字未改，只是被挪进了"5 秒后"才调用。 */
    function doClear(reason) {
      var btn = $('#btn-records-clear-ok');
      if (btn) btn.disabled = true;

      function finish(ok, err) {
        if (btn) btn.disabled = false;
        if (!ok) { flash(err || '清除失败，请稍后再试'); return; }
        /* 云端清成功才动本机：反过来的话，一旦云端那步失败，
         * 用户会既丢了本机回放、又在排行榜上看见战绩，比原状更糟。 */
        try { Records.clear(pid || undefined); } catch (e) { /* 清不掉也不影响云端结果 */ }
        cloudRecords = null;
        cloudRecordsOk = false;
        cloudRecordsPid = '';
        cloudRecordsAt = 0;
        cloudRecordsErr = '';
        renderRecords();                   // 同一次渲染内切空态，不做转场，避免闪一帧旧数据
        flash(withCloud ? '战绩已清除 · 排行榜已同步' : '已清除这台设备上的记录');
        if (withCloud) loadCloudRecords(true);   // 拿回清零后的档案（games=0 → 空态）
      }

      if (!withCloud) { finish(true); return; }
      var req = (typeof AuthStore !== 'undefined' && AuthStore.resetMyStats) ? AuthStore.resetMyStats() : null;
      if (!req || typeof req.then !== 'function') { finish(false, '当前环境不支持清除账号战绩'); return; }
      req.then(function (res) {
        if (res && res.ok !== false) {
          /* 不在这里写 cloudRecords* —— finish() 会清掉，紧接着 loadCloudRecords(true)
           * 再取一次真正的清零后档案。多写一遍只会让人以为这份缓存被保留了。 */
          finish(true);
        } else {
          finish(false, (res && res.error) || '清除失败，请稍后重试');
        }
      }).catch(function () { finish(false, '网络不太好，请稍后再试'); });
    }

    /* 没有撤销条 = 老行为：立刻清。宁可清掉也不能点了没反应。 */
    if (!undoBar) { doClear('no-bar'); return; }

    /* 延迟执行，而不是"先删再回滚"。
     * 云端那一步没有逆操作（resetMyStats 清零之后没有任何接口写得回去），
     * 所谓"撤销"只能恢复本机，排行榜上已经空了 —— 那种假撤销比不给更坏。
     * 详情见 pwa/js/undoBar.js 顶部的注释。 */
    undoBar.show({
      msg: '将清除 ' + (n > 0 ? n + ' 场' : '全部') + '记录' + (withCloud ? '（含云端）' : '（仅本机）'),
      action: '撤销',
      seconds: 5,
      onUndo: function () {
        flash('已取消，记录还在');
      },
      onCommit: function (reason) {
        /* 五种 reason 都走到这里，而且都要**真清**：
         *   timeout     —— 正常到点
         *   hidden      —— 页面转后台（iOS 上这可能就是最后一次 JS 执行机会）
         *   navigate    —— 用户离开了战绩页
         *   superseded  —— 又点了一次清除，旧的被新的顶掉（旧的也得结账）
         *   no-dom      —— 条子渲染不出来（旧缓存），宁可立刻清也不能静默丢弃
         * 唯一让"不清"的路径是用户点了撤销，那条根本不进 onCommit。 */
        doClear(reason);
      }
    });
  }
    return {
      END_REASON_TEXT: END_REASON_TEXT,
      endReasonText: endReasonText,
      renderTrend: renderTrend,
      renderRecordRows: renderRecordRows,
      cloudRecords: cloudRecords,
      cloudRecordsOk: cloudRecordsOk,
      cloudRecordsPid: cloudRecordsPid,
      cloudRecordsErr: cloudRecordsErr,
      cloudRecordsAt: cloudRecordsAt,
      cloudRecordsSeq: cloudRecordsSeq,
      CLOUD_RECORDS_TTL: CLOUD_RECORDS_TTL,
      EMPTY_STATS: EMPTY_STATS,
      recordsPid: recordsPid,
      cloudRecordsReady: cloudRecordsReady,
      cloudRecordsValid: cloudRecordsValid,
      cloudStats: cloudStats,
      cloudRows: cloudRows,
      loadCloudRecords: loadCloudRecords,
      renderRecords: renderRecords,
      /* 四态（build-states v1）：唯一真源与唯一执行者，从外面也要够得着 ——
       * game.js 的 online/offline 事件要走 onNetChange，四态里的按钮要走 onErrAction。 */
      setRecordsState: setRecordsState,
      applyRecordsState: applyRecordsState,
      onErrAction: onErrAction,
      retryCloudRecords: retryCloudRecords,
      onNetChange: onNetChange,
      showRankFail: showRankFail,
      syncSumcolFade: syncSumcolFade,
      profileSeq: profileSeq,
      playerNameOf: playerNameOf,
      openProfile: openProfile,
      closeProfile: closeProfile,
      renderProfileFail: renderProfileFail,
      PF_EMPTY_SVG: PF_EMPTY_SVG,
      profileBodyHtml: profileBodyHtml,
      renderProfileBody: renderProfileBody,
      drawShareCard: drawShareCard,
      onShare: onShare,
      handText: handText,
      replayViews: replayViews,
      renderReplay: renderReplay,
      replayTargetHand: replayTargetHand,
      scrollReplayToTarget: scrollReplayToTarget,
      setReplaySub: setReplaySub,
      replayPacksOf: replayPacksOf,
      replayTargetOf: replayTargetOf,
      openReplay: openReplay,
      openReplayHere: openReplayHere,
      openSavedReplay: openSavedReplay,
      closeReplay: closeReplay,
      closeShare: closeShare,
      isIOS: isIOS,
      isWeChat: isWeChat,
      supportsDownload: supportsDownload,
      onShareSave: onShareSave,
      openRank: openRank,
      closeRank: closeRank,
      apiQuery: apiQuery,
      renderRank: renderRank,
      purgeAskedAt: purgeAskedAt,
      purgeInFlight: purgeInFlight,
      replayReopen: replayReopen,
      replayOwners: replayOwners,
      purgeDeletedIdentities: purgeDeletedIdentities,
      openRecords: openRecords,
      closeRecords: closeRecords,
      onCreateFromRecords: onCreateFromRecords,
      openClearModal: openClearModal,
      closeClearModal: closeClearModal,
      onClearConfirmed: onClearConfirmed
    };
  }

  global.LXW = global.LXW || {};
  global.LXW.recordsView = create;

})(typeof self !== 'undefined' ? self : this);
