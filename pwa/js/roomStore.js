/**
 * 房间数据层（抽象接口 + 双传输实现）
 *
 * 动作类接口一律返回 Promise（{ok, ...}），同步读取类直接返回值。
 *
 *   房间   createRoom / joinRoom / leaveRoom / rename / addBot / getRoom / subscribe
 *   对局   setReady / startGame / submitGroups
 *   互动   sendEmoji（表情/短语，只转发不落库）/ onEmoji（订阅收到的）
 *   结算   wantNext（开始下一局）/ unWantNext（撤回报名）/ proposeDissolve /
 *          voteDissolve / cancelDissolve ｜ restart 仅为兼容旧客户端保留，新代码不要用
 *   档案   getProfile（查看玩家云端档案；local 模式返回 localUnsupported）/ canQueryProfile
 *   连接   reauth / reconnect / resume（整页重载后回座）/ peekRoom（只读快照）/ disconnect
 *          以及 onDisconnect / onOffline / onFatal 三个回调钩子
 *   环境   getMode
 *
 * 传输切换：
 *   - 默认 'ws'：跨设备 WebSocket 联机（连 ws(s)://当前host/ws，服务端为权威）
 *   - 'local'：同浏览器多标签页 BroadcastChannel + localStorage 演示（?mode=local）
 *
 * 后续接入微信云开发：只需新增一个 'cloud' 传输实现，接口签名不变。
 */
(function (global, factory) {
  // 同目录的 stateMachine.js。之前写成 '../core/stateMachine.js' 是不存在的路径，
  // 浏览器里因为 require 不存在而走 global 分支，从没报错，但 Node 下直接就抛。
  var StateMachine = (typeof require === 'function') ? require('./stateMachine.js') : global.StateMachine;
  var mod = factory(StateMachine);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = mod;
  } else {
    global.RoomStore = mod;
  }
})(typeof self !== 'undefined' ? self : this, function (StateMachine) {
  'use strict';

  function detectMode() {
    if (typeof window !== 'undefined' && window.location) {
      var m = /[?&]mode=([a-z]+)/.exec(window.location.search);
      if (m && m[1] === 'local') return 'local';
      if (m && m[1] === 'ws') return 'ws';
      // file:// 协议没有可连的 ws host，双击 index.html 自动走本地模式（BroadcastChannel 多标签页）
      if (window.location.protocol === 'file:') return 'local';
    }
    return 'ws';
  }

  var MODE = detectMode();

  /* 订阅者抛异常的统一出口（v127）。
   *
   * 这里的 catch **必须继续往下走**（一个订阅者挂了，不该让别的订阅者收不到广播），
   * 但也**不能什么都不做**：v108 那个 `ReferenceError: state is not defined`
   * 就是死在这几个空 catch 里（见 docs/REVIEW.md 的 v108 段），
   * 表现是「界面从此再也不更新」，而控制台一片安静、服务端零记录 ——
   * 一个「渲染函数写错了一个变量名」的问题，最后是靠人肉复现才找到的。
   *
   * 所以规矩改成：**吞掉可以，但必须留痕**（上报 + 控制台）。
   * 「留痕」不是「重新抛」—— 重抛会把一次局部渲染失败升级成整条广播失败。
   */
  function reportSubscriber(where, e) {
    var msg = (e && (e.message || String(e))) || 'unknown';
    try {
      if (typeof ErrorReport !== 'undefined' && ErrorReport && ErrorReport.capture) {
        ErrorReport.capture('subscriber', '[' + where + '] ' + msg, {
          source: 'roomStore.js',
          stack: e && e.stack
        });
      }
    } catch (_) { /* silence: 上报自身绝不能再抛 */ }
    try {
      if (typeof console !== 'undefined' && console.error) console.error('[lxw subscriber]', where, e);
    } catch (_) { /* silence: 没有 console 的极老 WebView，本来就没地方打日志 */ }
  }

  /* ============================ 本地实现（BroadcastChannel + localStorage） ============================ */
  function createLocalStore(StateMachine) {
    /* 物理键与降级逻辑都在 js/storage.js；这里只拿名字（下面有兜底常量，
     * 万一 storage.js 没加载也只是退化成旧行为，不至于整页白）。 */
    var ST = (typeof LXW !== 'undefined' && LXW.Store) ? LXW.Store : null;
    if (!ST && typeof require === 'function') {
      try { ST = require('./storage.js'); } catch (e) { ST = null; }
    }
    var LS_ROOMS = ST ? ST.KEYS.ROOMS : 'lxw_rooms_v1';
    var LS_TOUCH = ST ? ST.KEYS.ROOMS_TOUCH : 'lxw_rooms_touch_v1';
    var ROOM_TTL = 2 * 60 * 60 * 1000;
    var subs = {};
    var lastTouch = {};
    var channel = null;
    /* 表情订阅者与限流表。演示模式也照服务端那套做（2 秒一条），
     * 否则同一份界面在两种传输下给人的手感不一样。 */
    var emojiCbs = [];
    var lastEmojiAt = {};

    function safeParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }
    function loadRooms() {
      var raw = ST ? ST.read(LS_ROOMS, '') : '';
      var map = safeParse(raw) || {};
      var now = Date.now();
      for (var k in map) if (map[k] && now - (map[k].updatedAt || 0) > ROOM_TTL) delete map[k];
      return map;
    }
    function saveRooms(map) { if (ST) ST.writeJson(LS_ROOMS, map); }
    function getRoom(roomId) { if (!roomId) return null; return loadRooms()[roomId] || null; }
    function touch(roomId, ts) { if (ST) ST.writeJson(LS_TOUCH, { roomId: roomId, ts: ts }); }
    function emit(roomId, room) {
      var list = subs[roomId] || [];
      for (var i = 0; i < list.length; i++) { try { list[i](room); } catch (e) { reportSubscriber('emit', e); } }
    }
    function emitEmoji(ev) {
      for (var i = 0; i < emojiCbs.length; i++) { try { emojiCbs[i](ev); } catch (e) { reportSubscriber('emitEmoji', e); } }
    }
    function publish(roomId, room) {
      var map = loadRooms(); map[roomId] = room; saveRooms(map);
      var ts = Date.now(); lastTouch[roomId] = ts; touch(roomId, ts);
      if (channel) { try { channel.postMessage({ type: 'room', roomId: roomId }); } catch (e) {} }
      emit(roomId, room);
    }

    try {
      if (typeof BroadcastChannel !== 'undefined') {
        channel = new BroadcastChannel('weile_rooms');
        channel.onmessage = function (e) {
          if (!e || !e.data) return;
          if (e.data.type === 'room') {
            var room = getRoom(e.data.roomId);
            if (room) emit(e.data.roomId, room);
          } else if (e.data.type === 'emoji' && e.data.payload) {
            /* 表情不写 localStorage、不进 room：它只有 1.6 秒寿命，
             * 落盘只会让别的标签页在刷新后「重播」一条早就过期的话。 */
            emitEmoji(e.data.payload);
          }
        };
      }
    } catch (e) { channel = null; }

    try {
      window.addEventListener('storage', function (e) {
        if (e.key === LS_TOUCH) {
          var info = safeParse(e.newValue);
          if (info && info.roomId) {
            lastTouch[info.roomId] = info.ts;
            var room = getRoom(info.roomId);
            if (room) emit(info.roomId, room);
          }
        }
      });
    } catch (e) {}

    try {
      setInterval(function () {
        var tsInfo = ST ? ST.readJson(LS_TOUCH, null) : null;
        if (!tsInfo || !tsInfo.roomId) return;
        if (lastTouch[tsInfo.roomId] !== tsInfo.ts) {
          lastTouch[tsInfo.roomId] = tsInfo.ts;
          var room = getRoom(tsInfo.roomId);
          if (room) emit(tsInfo.roomId, room);
        }
      }, 500);
    } catch (e) {}

    function subscribe(roomId, cb) {
      if (!subs[roomId]) subs[roomId] = [];
      subs[roomId].push(cb);
      return function () { subs[roomId] = subs[roomId].filter(function (f) { return f !== cb; }); };
    }
    function genRoomId(len) {
      len = len || 6; var s = '';
      for (var i = 0; i < len; i++) s += Math.floor(Math.random() * 10);
      return s;
    }
    function uniqueRoomId(len) {
      var id, map;
      do { id = genRoomId(len); map = loadRooms(); } while (map[id]);
      return id;
    }

    return {
      createRoom: function (player, opts) {
        var roomId = uniqueRoomId();
        var room = StateMachine.newRoom(roomId, player, opts);
        publish(roomId, room);
        return room;
      },
      joinRoom: function (roomId, player) {
        var room = getRoom(roomId);
        var res = StateMachine.joinRoom(room, player);
        if (res.ok) publish(roomId, res.room);
        return res;
      },
      leaveRoom: function (roomId, playerId) {
        var room = getRoom(roomId);
        var res = StateMachine.leaveRoom(room, playerId);
        if (res.deleted) {
          var map = loadRooms(); delete map[roomId]; saveRooms(map);
          touch(roomId, Date.now());
          if (channel) { try { channel.postMessage({ type: 'room', roomId: roomId }); } catch (e) {} }
          emit(roomId, null);
          return { ok: true, room: null, deleted: true };
        }
        if (res.room) publish(roomId, res.room);
        return { ok: true, room: res.room, deleted: false };
      },
      setReady: function (roomId, playerId, ready) {
        var room = getRoom(roomId);
        var res = StateMachine.setReady(room, playerId, ready);
        if (!res.ok) return res;
        /* 本地演示没有服务端替我们判断「全员就绪」，得自己走一遍。
         * 先 publish 一次准备状态，再尝试自动开局 —— 顺序反了的话，
         * 其它标签页会直接看到牌桌、跳过「已准备」那一帧。 */
        publish(roomId, room);
        if (StateMachine.autoStartIfReady(room)) publish(roomId, room);
        return res;
      },
      /* 候场期改把数（C-3 / v117）。本地模式没有服务端广播，改完 publish 一次即可。
       * 不碰 autoStartIfReady：改把数不会让任何人更接近开局。 */
      setHandLimit: function (roomId, playerId, handLimit) {
        var room = getRoom(roomId);
        var res = StateMachine.setHandLimit(room, playerId, handLimit);
        if (!res.ok) return res;
        publish(roomId, room);
        return res;
      },
      /* 「等个人」（v122）。本地模式要自己判一次开局：解除等待之后，
       * 人都齐了就该立刻开 —— 服务端那边是 hub.holdNext 里调的同一句。 */
      holdNext: function (roomId, playerId, on) {
        var room = getRoom(roomId);
        var res = StateMachine.setHoldNext(room, playerId, on);
        if (!res.ok) return res;
        publish(roomId, room);
        if (StateMachine.autoStartIfReady(room)) publish(roomId, room);
        return res;
      },
      wantNext: function (roomId, playerId) {
        var room = getRoom(roomId);
        var res = StateMachine.wantNext(room, playerId);
        if (!res.ok) return res;
        publish(roomId, room);
        if (StateMachine.autoStartIfReady(room)) publish(roomId, room);
        return res;
      },
      /* 撤回「开始下一局」。不需要 autoStartIfReady：撤回只会让报名的人变少。 */
      unWantNext: function (roomId, playerId) {
        var room = getRoom(roomId);
        var res = StateMachine.unWantNext(room, playerId);
        if (!res.ok) return res;
        publish(roomId, room);
        return res;
      },
      /* 「不等他」/「这一把先不打」（v114 / v121）。
       * 本地模式下这条一直缺着 —— 于是本地模式里那颗按钮点了没反应，
       * 而 ws 模式里它压根没接到对外接口上（见下面的 dropNext）。
       * 现在补上：和 ws 一样，改完 publish 一次，必要时顺手判一次开局。 */
      dropNext: function (roomId, playerId, targetId) {
        var room = getRoom(roomId);
        var res = StateMachine.dropFromNext(room, playerId, targetId);
        if (!res.ok) return res;
        publish(roomId, room);
        if (StateMachine.autoStartIfReady(room)) publish(roomId, room);
        return res;
      },
      rename: function (roomId, playerId, nickname) {
        var res = StateMachine.rename(getRoom(roomId), playerId, nickname);
        if (res.ok) publish(roomId, res.room);
        return res;
      },
      startGame: function (roomId, ownerId) {
        var res = StateMachine.startGame(getRoom(roomId), ownerId);
        if (res.ok) publish(roomId, res.room);
        return res;
      },
      submitGroups: function (roomId, playerId, groups) {
        var res = StateMachine.submitGroups(getRoom(roomId), playerId, groups);
        if (res.ok) publish(roomId, res.room);
        return res;
      },
      /* 进入 / 退出「改一下」（v105）。本地模式也要跑一遍状态机，
       * 否则断网单机时「正在改」这个状态在本地不存在，行为和联机不一致。 */
      beginRevise: function (roomId, playerId) {
        var res = StateMachine.beginRevise(getRoom(roomId), playerId);
        if (res.ok) publish(roomId, res.room);
        return res;
      },
      cancelRevise: function (roomId, playerId) {
        var res = StateMachine.cancelRevise(getRoom(roomId), playerId);
        if (res.ok) publish(roomId, res.room);
        return res;
      },
      restart: function (roomId, ownerId) {
        var room = getRoom(roomId);
        var res = StateMachine.restart(room, ownerId);
        if (!res.ok) return res;
        publish(roomId, room);
        if (StateMachine.autoStartIfReady(room)) publish(roomId, room);
        return res;
      },
      proposeDissolve: function (roomId, playerId) {
        var res = StateMachine.proposeDissolve(getRoom(roomId), playerId);
        if (res.ok) publish(roomId, res.room);
        return res;
      },
      voteDissolve: function (roomId, playerId, agree) {
        var res = StateMachine.voteDissolve(getRoom(roomId), playerId, agree);
        if (res.ok) publish(roomId, res.room);
        return res;
      },
      cancelDissolve: function (roomId, playerId) {
        var res = StateMachine.cancelDissolve(getRoom(roomId), playerId);
        if (res.ok) publish(roomId, res.room);
        return res;
      },
      /* 本地演示模式没有服务端，也就没有 AI 玩家 */
      addBot: function () {
        return { ok: false, error: '本地演示模式不支持 AI 补位' };
      },
      getRoom: getRoom,
      subscribe: subscribe,
      /* 表情/短语：与 ws 模式同一套语义 —— 校验过就广播，超限静默丢弃。
       * 演示模式没有服务端，「自己这条」由本地直接回调；其它标签页靠
       * BroadcastChannel 收到（BroadcastChannel 不会回投给发送它的那个实例）。 */
      sendEmoji: function (roomId, fromId, to, id) {
        var E = (typeof Emoji !== 'undefined') ? Emoji : null;
        if (!E || !E.isValid(String(id))) return false;
        var now = Date.now();
        if (now - (lastEmojiAt[fromId] || 0) < E.MIN_INTERVAL_MS) return false;
        lastEmojiAt[fromId] = now;
        var ev = { from: String(fromId || ''), to: String(to || E.BROADCAST), id: String(id), at: now };
        emitEmoji(ev);
        if (channel) { try { channel.postMessage({ type: 'emoji', roomId: roomId, payload: ev }); } catch (e) {} }
        return true;
      },
      onEmoji: function (cb) {
        emojiCbs.push(cb);
        return function () { emojiCbs = emojiCbs.filter(function (f) { return f !== cb; }); };
      },
      /* 本地演示模式没有长连接可断，但订阅要摘掉：
       * 换账号后还收着上一个号的对局回调，界面会串到别人的房间里。 */
      disconnect: function () {
        subs = {};
        lastTouch = {};
      },
      /* 本地演示模式（?mode=local / file://）没有服务端，也就没有云端档案 */
      getProfile: function () {
        return {
          ok: false,
          localUnsupported: true,
          error: '本地演示模式暂不支持查看他人战绩'
        };
      }
    };
  }

  /* ============================ WebSocket 实现（跨设备联机，服务端权威） ============================ */
  function createWsStore() {
    var socket = null;
    var subs = {};
    var roomsCache = {};
    var pending = {};
    var reqSeq = 0;
    var disconnectCbs = [];
    var fatalCbs = [];
    var emojiCbs = [];
    var heartbeatTimer = null;
    var missedPongs = 0;
    var disconnected = false;
    // 断线重连状态（仅 ws 模式使用）
    var GRACE_MS = 90000;        // 与服务端一致的宽限（毫秒）；两侧必须同步改
    var currentRoomId = null;    // 最近一次加入的房间，用于重连
    var currentPlayerId = null;
    var offlineCbs = [];
    var reconnecting = false;
    var reconnectTimer = null;
    var reconnectAttempts = 0;
    var reconnectStartTs = 0;

    /* 座位恢复令牌：服务端签发，只下发给本人。
     * 重连/刷新回座时带上它——只靠 roomId + playerId 不够，
     * 那两项都会出现在房间广播里，同房间的人能拿去接管别人的座位。 */
    var ST2 = (typeof LXW !== 'undefined' && LXW.Store) ? LXW.Store : null;
    if (!ST2 && typeof require === 'function') {
      try { ST2 = require('./storage.js'); } catch (e) { ST2 = null; }
    }
    var RESUME_KEY = ST2 ? ST2.KEYS.RESUME : 'lxw_resume_v1';

    function loadResume() {
      return ST2 ? ST2.readJson(RESUME_KEY, null) : null;
    }
    function saveResume(roomId, playerId, token) {
      if (!token || !roomId || !playerId) return;
      if (ST2) {
        ST2.writeJson(RESUME_KEY, {
          roomId: String(roomId), playerId: String(playerId), token: String(token)
        });
      }
    }
    function resumeTokenFor(roomId, playerId) {
      var r = loadResume();
      if (!r) return null;
      if (String(r.roomId) !== String(roomId) || String(r.playerId) !== String(playerId)) return null;
      return r.token || null;
    }
    function clearResume(roomId, playerId) {
      var r = loadResume();
      if (!r) return;
      if (roomId && String(r.roomId) !== String(roomId)) return;
      if (playerId && String(r.playerId) !== String(playerId)) return;
      if (ST2) ST2.remove(RESUME_KEY);
    }

    function wsUrl() {
      var proto = (typeof location !== 'undefined' && location.protocol === 'https:') ? 'wss:' : 'ws:';
      return proto + '//' + location.host + '/ws';
    }

    function stopHeartbeat() {
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      /* 连接已经换了（或要换），上一轮探活的判决定时器必须作废，
       * 否则它会对着新 socket 误判一次 */
      if (pingProbeTimer) { clearTimeout(pingProbeTimer); pingProbeTimer = null; }
    }

  function startHeartbeat() {
    stopHeartbeat();
    missedPongs = 0;
    heartbeatTimer = setInterval(function () {
      if (!socket || socket.readyState !== 1) return;
      try { socket.send(JSON.stringify({ type: 'ping' })); } catch (e) {}
      missedPongs++;
      // 连续 2 个心跳周期（约 60s）未收到 pong → 判定连接已死，主动关闭以触发重连
      if (missedPongs >= 2) {
        try { socket.close(); } catch (e) {}
      }
    }, 30000);
  }

  function triggerDisconnect(reason) {
    if (disconnected) return;
    disconnected = true;
    stopHeartbeat();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    reconnecting = false;
    if (socket) { try { socket.close(); } catch (e) {} socket = null; }
    // 彻底掉线：通知 UI 退回首页并提示（reason 可选，用于说明「本局已结束」这类非网络原因）
    for (var i = 0; i < offlineCbs.length; i++) { try { offlineCbs[i](reason); } catch (e) { reportSubscriber('offline', e); } }
  }

  function fireTransient() {
    for (var i = 0; i < disconnectCbs.length; i++) { try { disconnectCbs[i](); } catch (e) { reportSubscriber('disconnect', e); } }
  }

  /* ==================== 前后台切换时把连接「叫醒」（P4-1） ====================
   * 真实场景：群里点进来打牌 → 切出去回一条微信 → 切回来接着出牌。
   * iOS 上切出去几十秒，WebSocket 有相当概率被系统掐掉，而浏览器的 close
   * 事件依赖浏览器自己发现：好情况切回来立刻收到 close，走退避重连（1~2 秒）；
   * 坏情况连接半开（NAT 超时 / 休眠唤醒），readyState 仍是 1，客户端以为还连着。
   *
   * 那时唯一的出路只有心跳：30 秒一拍、连续 2 拍没 pong 才 close —— 最坏 60 秒。
   * 这期间桌面停在旧状态，玩家看得见别人的牌却点不动，也不知道该不该等。
   * 它不报错、不提示，最后只会变成一句模糊的「这游戏有点卡」。
   *
   * 所以回到前台就自己确认一次：发个 ping（成本为零），2.5 秒没回音就判定
   * 连接已死、主动关掉走正常重连。 */
  var pingProbeTimer = null;

  function dropAndReconnect() {
    if (disconnected || reconnecting) return;
    missedPongs = 0;
    if (socket) {
      /* close 监听器里有 scheduleReconnect()，这里不重复调，避免叠两条重连链 */
      try { socket.close(); } catch (e) { /* 已关也走同一条路 */ }
    } else {
      scheduleReconnect();
    }
  }

  function confirmAlive() {
    if (disconnected) return;
    missedPongs = 0;                        // 后台期间攒的心跳欠账不能拿来判死
    if (!socket || socket.readyState >= 2) { scheduleReconnect(); return; }
    if (socket.readyState === 0) return;    // 正在建连，等 open 自己往下走
    try {
      socket.send(JSON.stringify({ type: 'ping' }));
    } catch (e) {
      dropAndReconnect();
      return;
    }
    if (pingProbeTimer) clearTimeout(pingProbeTimer);
    pingProbeTimer = setTimeout(function () {
      pingProbeTimer = null;
      if (socket && socket.readyState === 1) dropAndReconnect();
    }, 2500);
  }

  /* pageshow.persisted 对应另一个真实场景：点了页面里的外链再返回。
   * Safari 会把页面原样从 bfcache 里复活 —— DOM 和牌桌都还在，但连接一定是死的，
   * 而且 readyState 可能仍停在 1（ping 也收不到回音），所以这里直接重建。 */
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') confirmAlive();
    });
  }
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('pageshow', function (e) {
      if (e && e.persisted) dropAndReconnect();
    });
  }

  /* 断线后自动重连：退避重试 ensureConnected，open 后发送 reconnect；超 GRACE 仍失败则彻底掉线 */
  function scheduleReconnect() {
    if (reconnecting || disconnected) return; // 已在重试或已判定彻底掉线
    reconnecting = true;
    reconnectStartTs = Date.now();
    reconnectAttempts = 0;
    fireTransient(); // 通知 UI：连接断开，正在尝试重连
    attemptReconnect();
  }

  function attemptReconnect() {
    ensureConnected().then(function () {
      return request({
        type: 'reconnect',
        payload: {
          roomId: currentRoomId,
          playerId: currentPlayerId,
          token: resumeTokenFor(currentRoomId, currentPlayerId)
        }
      });
    }).then(function (res) {
      if (res && res.token) saveResume(currentRoomId, currentPlayerId, res.token);
      // 重连成功：服务端会广播房间，订阅回调刷新界面（无需重订阅）
      reconnecting = false;
      reconnectTimer = null;
      reconnectAttempts = 0;
    }).catch(function (err) {
      var msg = (err && err.message) || '';
      // 服务端明确拒绝（房间已结束 / 本局已翻轮）→ 重试也不会成功，立即收尾，
      // 否则玩家要干等 90 秒才知道这局已经回不去了。
      if (msg.indexOf('本局') >= 0 || msg.indexOf('房间') >= 0) {
        reconnecting = false;
        triggerDisconnect(msg);
        return;
      }
      var elapsed = Date.now() - reconnectStartTs;
      if (elapsed >= GRACE_MS) {
        // 超过宽限仍失败 → 彻底掉线
        reconnecting = false;
        triggerDisconnect();
        return;
      }
      reconnectAttempts++;
      var delay = Math.min(1000 * Math.pow(1.5, reconnectAttempts), 5000);
      reconnectTimer = setTimeout(attemptReconnect, delay);
    });
  }

    function ensureConnected() {
      return new Promise(function (resolve, reject) {
        if (socket && socket.readyState === 1) return resolve(socket);
        if (socket && socket.readyState === 0) { // 正在连接
          socket.addEventListener('open', function () { resolve(socket); }, { once: true });
          socket.addEventListener('error', function () { reject(new Error('连接失败')); }, { once: true });
          return;
        }
        var s;
        try { s = new WebSocket(wsUrl()); }
        catch (e) { reject(new Error('无法建立连接')); return; }
        socket = s;
        disconnected = false;
        var timeout = setTimeout(function () { reject(new Error('连接超时')); }, 8000);
        s.addEventListener('open', function () {
          /* 先出示登录令牌。服务端此后按令牌认定「我是谁」，
           * 请求体里的 playerId 一律不采信——老版本正是靠它冒充别人的。 */
          try {
            var tk = (typeof AuthStore !== 'undefined' && AuthStore.token()) || '';
            if (tk) s.send(JSON.stringify({ type: 'auth', payload: { token: tk } }));
          } catch (e) { /* 令牌取不到就由服务端拒绝，不在这里拦 */ }
          clearTimeout(timeout); startHeartbeat(); resolve(s);
        });
        s.addEventListener('error', function () { clearTimeout(timeout); reject(new Error('连接失败')); });
        s.addEventListener('message', function (ev) { handleMessage(ev.data); });
        s.addEventListener('close', function () {
          /* 只处理「当前这条连接」的关闭。
           * 主动换连接时（登录后 reauth 会用新连接替换旧的），旧连接的 close
           * 事件是**晚一步**才到的；不判这一句的话，它会把刚建好的新连接置空，
           * 于是新连接变成没人管的孤儿，界面表现为「一连上就掉线」。 */
          if (socket !== s) return;
          socket = null;
          stopHeartbeat();
          scheduleReconnect(); // 断线不直接判死，先尝试自动重连
        });
      });
    }

    function handleMessage(raw) {
      var data;
      try { data = JSON.parse(typeof raw === 'string' ? raw : raw.data); } catch (e) { return; }
      if (!data) return;
      if (data.type === 'room') {
        var room = data.payload && data.payload.room;
        var roomId = data.payload && data.payload.roomId;
        if (room && roomId) {
          roomsCache[roomId] = room;
          (subs[roomId] || []).forEach(function (cb) { try { cb(room); } catch (e) { reportSubscriber('subscribe:room', e); } });
        }
      } else if (data.type === 'roomDeleted') {
        var rid = data.payload && data.payload.roomId;
        /* 把 payload 一起交给订阅者：服务端现在用同一个事件表达两件事 ——
         * 房间真被回收，和「下一局开始了、你不在名单里」。文案完全不同，
         * 只传 null 的话前端只能猜。 */
        if (rid) { delete roomsCache[rid]; (subs[rid] || []).forEach(function (cb) { try { cb(null, data.payload); } catch (e) { reportSubscriber('subscribe:deleted', e); } }); }
      } else if (data.type === 'ok') {
        var p = pending[data.reqId];
        if (p) { delete pending[data.reqId]; p.resolve(data.payload || {}); }
      } else if (data.type === 'error') {
        var q = pending[data.reqId];
        if (q) { delete pending[data.reqId]; q.reject(new Error((data.payload && data.payload.error) || '请求失败')); }
        else if (data.reqId != null) {
          /* 有 reqId，但本地已经没有对应请求了 —— 这是一个**迟到的回包**：
           * request() 8 秒超时会把它从 pending 里删掉，服务端随后才回。
           * 它跟连接状态毫无关系，绝不能走下面的 fatal 分支，
           * 否则「某个请求慢了一次」就会让玩家看到「连接已被服务端关闭」甚至被弹回登录页。直接丢弃。 */
          if (typeof console !== 'undefined' && console.debug) console.debug('[ws] 丢弃迟到回包 reqId=' + data.reqId);
        } else {
          /* 没有 reqId 的错误是**连接级**的：握手鉴权失败、或管理员停用/删号后被踢。
           * 以前这里直接丢弃 —— 于是被停用的人会不停自动重连、永远失败，
           * 而界面上一句话都不说，人只会觉得「点了没反应」。 */
          var fatalMsg = (data.payload && data.payload.error) || '连接已被服务端关闭';
          if (data.payload && data.payload.kicked) {
            /* 被踢就别再自动重连了，否则每 2 秒弹一次同样的错误。
             * 光置 reconnecting=false 不够：下面 s0.close() 会触发 close 监听器，
             * 那个监听器会无条件 scheduleReconnect() —— 于是刚被踢就立刻又连一次，
             * 服务端再拒一次，循环往复。用 disconnected 这个「彻底掉线」标志把重连彻底关掉
             * （重新登录时 ensureConnected 会把它复位）。 */
            var s0 = socket;
            socket = null;
            reconnecting = false;
            disconnected = true;
            try { clearTimeout(reconnectTimer); } catch (e) { /* 忽略 */ }
            try { if (s0) s0.close(); } catch (e) { /* 忽略 */ }
          }
          fatalCbs.forEach(function (fn) { try { fn(fatalMsg); } catch (e) { reportSubscriber('fatal', e); } });
        }
      } else if (data.type === 'emoji') {
        /* 服务端旁路推来的表情/短语。**必须放在这里集中分支**：
         * 老客户端收到不认识的消息时不会崩（最后那个 else 什么都不做），
         * 但会因为「什么都没发生」而让用户以为对方没发 —— 所以新字段一律走显式分支。 */
        var ev = data.payload || {};
        if (ev.id) emojiCbs.forEach(function (fn) { try { fn(ev); } catch (e) { reportSubscriber('emoji:push', e); } });
      } else if (data.type === 'pong') {
        missedPongs = 0;
        /* 回前台探活的那一枪有回音了，撤掉 2.5s 的判决定时器 */
        if (pingProbeTimer) { clearTimeout(pingProbeTimer); pingProbeTimer = null; }
      }
    }

    /* 登录/注册成功后必须重建连接。
     *
     * 真正的风险不是「打开页面就会连」——**首次打开的访客并不会建连**：
     * game.js 的 init() 在没有 session 时直接 showScreen('screen-auth') 就 return，
     * 路径上没有任何 ensureConnected 调用，全仓也只有本文件一处 new WebSocket。
     *
     * 风险在于「连接在令牌为空时建立」：ensureConnected 的 open 回调是
     *   `var tk = AuthStore.token(); if (tk) send({type:'auth'})`
     * —— 令牌为空时它**什么也不发**，这条连接就是一条未鉴权连接；
     * 服务端对未鉴权连接只有 30 秒宽限（AUTH_TIMEOUT_MS），到点就踢：
     * 提示「连接未登录，已断开」，客户端置成彻底掉线、界面退回登录页。
     * 而 ensureConnected 看到 readyState === 1 就复用现成连接、不会补发 auth，
     * 于是这个坑的形态是「登录明明成功了，30 秒后却像被登出」。
     *
     * 所以登录成功后一律调 reauth()：无论当前有没有连接、连接处于什么状态，
     * 都换一条**新的**（open 时必定带上令牌的）连接。
     * 不要按某一条具体用户路径去推理「这里不可能有旧连接」——
     * 此前到底是哪个入口先建了连接，一直没有被完全证实。
     */
    function reauth() {
      if (typeof AuthStore === 'undefined' || !AuthStore.token()) return Promise.resolve(null);
      disconnected = false;   // 被踢过也能靠这次重连复位，否则断线判定会一直是「彻底掉线」
      /* 顺序很重要：**先摘掉再关**。
       * 反过来的话，close 若同步派发（部分实现/测试替身就是同步的），
       * 监听器会看到 socket === s，于是先把 socket 置空、再 scheduleReconnect()，
       * 结果是我这边又建了一条 —— 两条连接抢同一个身份。 */
      var old = socket;
      socket = null;
      try { if (old) old.close(); } catch (e) { /* 已经断了 */ }
      return ensureConnected().catch(function () { return null; });
    }

    function request(msg) {
      return ensureConnected().then(function (s) {
        var reqId = ++reqSeq;
        return new Promise(function (resolve, reject) {
          var timer = setTimeout(function () {
            if (pending[reqId]) { delete pending[reqId]; reject(new Error('请求超时')); }
          }, 8000);
          pending[reqId] = {
            resolve: function (v) { clearTimeout(timer); resolve(v); },
            reject: function (e) { clearTimeout(timer); reject(e); }
          };
          s.send(JSON.stringify(Object.assign({ reqId: reqId }, msg)));
        });
      });
    }

    return {
      /* 登录/注册成功后换一条「带令牌」的连接 —— 未鉴权连接 30 秒必被服务端踢，见上面 reauth 注释 */
      reauth: reauth,
      createRoom: function (player, opts) {
        return request({ type: 'createRoom', payload: { playerId: player.id, nickname: player.nickname, handLimit: opts && opts.handLimit } })
          .then(function (res) {
            if (res.room) {
              currentRoomId = res.room.roomId;
              currentPlayerId = player.id;
              saveResume(currentRoomId, currentPlayerId, res.token);
            }
            return res.room || null;
          });
      },
      joinRoom: function (roomId, player) {
        return request({
          type: 'joinRoom',
          payload: {
            roomId: roomId,
            playerId: player.id,
            nickname: player.nickname,
            token: resumeTokenFor(roomId, player.id)
          }
        })
          .then(function (res) {
            currentRoomId = roomId;
            currentPlayerId = player.id;
            saveResume(roomId, player.id, res.token);
            return { ok: true, room: res.room };
          })
          .catch(function (e) { return { ok: false, error: e.message }; });
      },
      leaveRoom: function () {
        /* ★ v128 修：以前这里是 `return r`（服务端回的空对象），于是
         *   **成功时返回 `{}`、失败时返回 `{ok:true}`** —— 一个方法两种形状，
         *   而且"成功"那个反而没有 ok。
         *
         *   一直没出事，只是因为唯一的调用方（game.js 的退出房间）不看返回值。
         *   下一个人照其他请求的惯例写一句 `if (!res.ok) flash('离开失败')`，
         *   就会在**成功退出之后**弹错误 —— 这正是"接起来才坏"的那类缝。
         *
         *   统一成 `{ok:true}`，并且**失败也报成功**：退房是尽力而为，
         *   连接已经断了也算退出（房间有断线宽限和回收兜底）。
         *   让用户在断网时卡在房间里，比"偷偷少发一条 leaveRoom"更糟。 */
        return request({ type: 'leaveRoom' })
          .catch(function () { return null; })
          .then(function () {
            clearResume(currentRoomId, currentPlayerId);
            return { ok: true };
          });
      },
      setReady: function (roomId, playerId, ready) {
        return request({ type: 'ready', payload: { ready: !!ready } })
          .then(function () { return { ok: true }; })
          .catch(function (e) { return { ok: false, error: e.message }; });
      },
      rename: function (roomId, playerId, nickname) {
        return request({ type: 'rename', payload: { nickname: nickname } })
          .then(function () { return { ok: true }; })
          .catch(function (e) { return { ok: false, error: e.message }; });
      },
      startGame: function (roomId, ownerId) {
        return request({ type: 'start' })
          .then(function () { return { ok: true }; })
          .catch(function (e) { return { ok: false, error: e.message }; });
      },
      submitGroups: function (roomId, playerId, groups) {
        return request({ type: 'submitGroups', payload: { groups: groups } })
          .then(function () { return { ok: true }; })
          .catch(function (e) { return { ok: false, error: e.message }; });
      },
      beginRevise: function () {
        return request({ type: 'beginRevise' })
          .then(function () { return { ok: true }; })
          .catch(function (e) { return { ok: false, error: e.message }; });
      },
      cancelRevise: function () {
        return request({ type: 'cancelRevise' })
          .then(function () { return { ok: true }; })
          .catch(function (e) { return { ok: false, error: e.message }; });
      },
      restart: function (roomId, ownerId) {
        return request({ type: 'restart' })
          .then(function () { return { ok: true }; })
          .catch(function (e) { return { ok: false, error: e.message }; });
      },
      wantNext: function (roomId, playerId) {
        return request({ type: 'wantNext' })
          .then(function () { return { ok: true }; })
          .catch(function (e) { return { ok: false, error: e.message }; });
      },
      setHandLimit: function (roomId, handLimit) {
        return request({ type: 'setHandLimit', payload: { handLimit: handLimit } })
          .then(function (r) { return { ok: true, handLimit: (r && r.handLimit) }; })
          .catch(function (e) { return { ok: false, error: e.message }; });
      },
      /* 「等个人」（v122）：挂起 / 解除房主的「先别开牌」。
       * on 必须走 payload —— 服务端读 msg.payload.on，放顶层会永远收到 false，
       * 于是点「等个人」等于立刻放行（v117 / v121 各踩过一次同类）。 */
      holdNext: function (roomId, on) {
        return request({ type: 'holdNext', payload: { on: !!on } })
          .then(function (r) { return { ok: true, leftMs: (r && r.leftMs) || 0 }; })
          .catch(function (e) { return { ok: false, error: e.message }; });
      },
      dropNext: function (roomId, playerId, targetId) {
        /* ★ payload 这一层不能省。服务端读的是 msg.payload.targetId，
         * 写成顶层 targetId 会得到 undefined → 「缺少要跳过的人」。
         * v117 的 setHandLimit 踩过一模一样的坑，这里又踩了一次 ——
         * 两次都是「单测只看源码里有没有那个名字」，只有真点一次才会露。 */
        return request({ type: 'dropNext', payload: { targetId: targetId } })
          .then(function () { return { ok: true }; })
          .catch(function (e) { return { ok: false, error: e.message }; });
      },
      unWantNext: function (roomId, playerId) {
        return request({ type: 'unWantNext' })
          .then(function () { return { ok: true }; })
          .catch(function (e) { return { ok: false, error: e.message }; });
      },
      proposeDissolve: function (roomId, playerId) {
        return request({ type: 'proposeDissolve' })
          .then(function () { return { ok: true }; })
          .catch(function (e) { return { ok: false, error: e.message }; });
      },
      voteDissolve: function (roomId, playerId, agree) {
        return request({ type: 'voteDissolve', payload: { agree: !!agree } })
          .then(function () { return { ok: true }; })
          .catch(function (e) { return { ok: false, error: e.message }; });
      },
      cancelDissolve: function (roomId, playerId) {
        return request({ type: 'cancelDissolve' })
          .then(function () { return { ok: true }; })
          .catch(function (e) { return { ok: false, error: e.message }; });
      },
      /* 房主补一个 AI 玩家（仅等待阶段可用） */
      addBot: function () {
        return request({ type: 'addBot' })
          .then(function (res) { return { ok: true, botId: (res && res.botId) || null }; })
          .catch(function (e) { return { ok: false, error: e.message }; });
      },
      getRoom: function (roomId) { return roomsCache[roomId] || null; },
      /* 查看玩家云端档案：服务端只读查询，返回 {ok, profile|null} */
      getProfile: function (playerId) {
        return request({ type: 'getProfile', payload: { playerId: String(playerId || '') } })
          .then(function (res) { return { ok: true, profile: (res && res.profile) || null }; })
          .catch(function (e) { return { ok: false, error: e.message }; });
      },
      /* 删档已经改走 HTTP /api/auth/delete（见 authStore.deleteAccount）。
       * 老的两步流程「要令牌 → 凭令牌删」整体移除：签发令牌时不校验请求者身份，
       * 谁拿到 playerId 都能要到一把能删任何人数据的钥匙。 */
      /** 主动断开长连接（退出登录时用）：否则旧连接仍以上一个账号的身份挂在服务端 */
      disconnect: function () {
        stopHeartbeat();
        try { clearTimeout(reconnectTimer); } catch (e) { /* 忽略 */ }
        reconnecting = false;
        currentRoomId = null;
        currentPlayerId = null;
        /* 回座凭据属于走掉的这个人，一起丢掉；下次是另一个人登录，
         * 留着它只会让「回座」拿别人的座位号去问服务端。 */
        clearResume();
        if (socket) {
          var s = socket;
          socket = null;
          try { s.close(); } catch (e) { /* 忽略 */ }
        }
      },
      onDisconnect: function (cb) {
        disconnectCbs.push(cb);
        return function () { disconnectCbs = disconnectCbs.filter(function (f) { return f !== cb; }); };
      },
      /* 连接级致命错误（鉴权失败 / 被停用踢线）。界面拿到后要把人送回登录页，
       * 而不是让他停在一个再也连不上的首页上。 */
      onFatal: function (cb) {
        fatalCbs.push(cb);
        return function () { fatalCbs = fatalCbs.filter(function (f) { return f !== cb; }); };
      },
      /*
       * 页面重载 / 切后台被系统回收后「回座」。
       *
       * 和 reconnect 的区别：reconnect 是同一页面内的网络抖动重试，
       * 内存里还留着 currentRoomId；这里是整页重来，只能靠 localStorage 里的
       * 座位令牌认出「我本来在哪一桌」。做不成这件事的话，手机来个电话、
       * 手滑刷新一次，这局就白打了——哪怕服务端那个座位还热着。
       */
      resume: function (playerId) {
        var r = loadResume();
        if (!r || !r.roomId || !r.token) return Promise.resolve({ ok: false, reason: 'no-resume' });
        if (playerId && String(r.playerId) !== String(playerId)) {
          // 本机身份变了（清过缓存 / 换了设备），旧座位已经不属于这个身份
          clearResume();
          return Promise.resolve({ ok: false, reason: 'identity-changed' });
        }
        currentRoomId = r.roomId;
        currentPlayerId = r.playerId;
        return request({
          type: 'reconnect',
          payload: { roomId: r.roomId, playerId: r.playerId, token: r.token }
        }).then(function (res) {
          if (!res || !res.room) { clearResume(); return { ok: false, reason: 'no-room' }; }
          saveResume(r.roomId, r.playerId, res.token || r.token);
          return { ok: true, roomId: r.roomId, room: res.room };
        }).catch(function (e) {
          var msg = (e && e.message) || '';
          // 只有服务端明确拒绝才丢弃记录；网络问题是临时的，留着下次还能试
          if (msg.indexOf('房间') >= 0 || msg.indexOf('本局') >= 0 ||
              msg.indexOf('身份') >= 0 || msg.indexOf('不在') >= 0) {
            clearResume();
          }
          return { ok: false, reason: 'rejected', error: msg };
        });
      },
      // 只读快照：只取当前房间状态，不动座位令牌、不补分牌时限
      peekRoom: function (roomId) {
        return request({ type: 'peekRoom', payload: { roomId: roomId } })
          /* 服务端回包只有 `{ room }`，没有 `ok` 字段——不在这里归一化，
           * 调用方拿到的是 `res.ok === undefined`，会被当成失败。 */
          .then(function (res) { return { ok: true, room: res && res.room || null }; })
          .catch(function (e) { return { ok: false, error: e.message }; });
      },
      // 断线重连（内部自动调用，也对外暴露以便测试/手动触发）
      reconnect: function (roomId, playerId) {
        return request({
          type: 'reconnect',
          payload: {
            roomId: roomId,
            playerId: playerId,
            token: resumeTokenFor(roomId, playerId)
          }
        })
          .then(function (res) {
            if (res && res.token) saveResume(roomId, playerId, res.token);
            return res || {};
          })
          .catch(function (e) { return { ok: false, error: e.message }; });
      },
      // 彻底掉线（重连宽限内仍失败）回调
      onOffline: function (cb) {
        offlineCbs.push(cb);
        return function () { offlineCbs = offlineCbs.filter(function (f) { return f !== cb; }); };
      },
      subscribe: function (roomId, cb) {
        if (!subs[roomId]) subs[roomId] = [];
        subs[roomId].push(cb);
        return function () { subs[roomId] = subs[roomId].filter(function (f) { return f !== cb; }); };
      },
      /* 表情/短语：**发完就不管**，不等回包。
       * 服务端对超限/非法 id 一律静默丢弃（见 hub.emoji），这里没有 Promise 可等；
       * 返回 false 只表示「连接不在，压根没发出去」。 */
      sendEmoji: function (roomId, fromId, to, id) {
        var E = (typeof Emoji !== 'undefined') ? Emoji : null;
        if (!E || !E.isValid(String(id))) return false;
        if (!socket || socket.readyState !== 1) return false;
        try {
          socket.send(JSON.stringify({
            type: 'emoji',
            payload: { to: String(to || E.BROADCAST), id: String(id) }
          }));
          return true;
        } catch (e) { return false; }
      },
      onEmoji: function (cb) {
        emojiCbs.push(cb);
        return function () { emojiCbs = emojiCbs.filter(function (f) { return f !== cb; }); };
      }
    };
  }

  var local = createLocalStore(StateMachine);
  var ws = createWsStore();

  /* ============================ 对外接口（Promise 归一化） ============================ */
  return {
    getMode: function () { return MODE; },

    /* opts.handLimit：本局把数（把数上限）。只在这一刻能定，之后房间内不可改。 */
    createRoom: function (player, opts) {
      return MODE === 'local' ? Promise.resolve(local.createRoom(player, opts)) : ws.createRoom(player, opts);
    },
    joinRoom: function (roomId, player) {
      return MODE === 'local' ? Promise.resolve(local.joinRoom(roomId, player)) : ws.joinRoom(roomId, player);
    },
    leaveRoom: function (roomId, playerId) {
      return MODE === 'local' ? Promise.resolve(local.leaveRoom(roomId, playerId)) : ws.leaveRoom();
    },
    setReady: function (roomId, playerId, ready) {
      return MODE === 'local' ? Promise.resolve(local.setReady(roomId, playerId, ready)) : ws.setReady(roomId, playerId, ready);
    },
    rename: function (roomId, playerId, nickname) {
      return MODE === 'local' ? Promise.resolve(local.rename(roomId, playerId, nickname)) : ws.rename(roomId, playerId, nickname);
    },
    startGame: function (roomId, ownerId) {
      return MODE === 'local' ? Promise.resolve(local.startGame(roomId, ownerId)) : ws.startGame(roomId, ownerId);
    },
    submitGroups: function (roomId, playerId, groups) {
      return MODE === 'local' ? Promise.resolve(local.submitGroups(roomId, playerId, groups)) : ws.submitGroups(roomId, playerId, groups);
    },
    /* 进入 / 退出「改一下」。必须走这条路而不是只改本地 state ——
     * 「正在改」决定了服务端能不能结算本轮（SM.isRoundLocked），
     * 客户端单方面改个变量，服务端并不知道。 */
    beginRevise: function (roomId, playerId) {
      return MODE === 'local' ? Promise.resolve(local.beginRevise(roomId, playerId)) : ws.beginRevise(roomId, playerId);
    },
    cancelRevise: function (roomId, playerId) {
      return MODE === 'local' ? Promise.resolve(local.cancelRevise(roomId, playerId)) : ws.cancelRevise(roomId, playerId);
    },
    restart: function (roomId, ownerId) {
      return MODE === 'local' ? Promise.resolve(local.restart(roomId, ownerId)) : ws.restart(roomId, ownerId);
    },
    /* 结算页「开始下一局」：登记进下一局，回房间页。 */
    wantNext: function (roomId, playerId) {
      return MODE === 'local' ? Promise.resolve(local.wantNext(roomId, playerId)) : ws.wantNext(roomId, playerId);
    },
    /* 候场期改把数：只改「下一场打几把」，服务端会校验「结算期 + 房主」。 */
    setHandLimit: function (roomId, playerId, handLimit) {
      return MODE === 'local'
        ? Promise.resolve(local.setHandLimit(roomId, playerId, handLimit))
        : ws.setHandLimit(roomId, handLimit);
    },
    /* 就位态「回结算页」：撤回报名。 */
    unWantNext: function (roomId, playerId) {
      return MODE === 'local' ? Promise.resolve(local.unWantNext(roomId, playerId)) : ws.unWantNext(roomId, playerId);
    },
    /* 「等个人」（v122）：房主挂起 / 解除「先别开牌」。 */
    holdNext: function (roomId, playerId, on) {
      return MODE === 'local'
        ? Promise.resolve(local.holdNext(roomId, playerId, on))
        : ws.holdNext(roomId, on);
    },
    /* ★ v121 补上的缺口：「不等他」与「这一把先不打」。
     *
     * 这两颗按钮从 v114 / v121 起就挂在 `RoomStore.dropNext(...)` 上，
     * 而对外接口里**从来没有过这个名字** —— ws 对象里那个方法一直没被接出来，
     * local 那边更是连实现都没有。于是点下去是「RoomStore.dropNext is not a function」，
     * 被 catch 吞成一句「网络不太稳，再试一次」。
     *
     * 为什么一直没被发现：单测断言的是「roomStore.js 里有 `dropNext: function (...)`
     * 这一行」—— 它匹配到了 ws 对象里那份，界面用的却是对外那份。
     * 又一个「守卫站错层级」。真机上它只表现为「点了没反应」。
     * journey 里现在有一次端到端的点击（[7d2]），会真的把它点出来。 */
    dropNext: function (roomId, playerId, targetId) {
      return MODE === 'local'
        ? Promise.resolve(local.dropNext(roomId, playerId, targetId))
        : ws.dropNext(roomId, playerId, targetId);
    },
    proposeDissolve: function (roomId, playerId) {
      return MODE === 'local' ? Promise.resolve(local.proposeDissolve(roomId, playerId)) : ws.proposeDissolve(roomId, playerId);
    },
    voteDissolve: function (roomId, playerId, agree) {
      return MODE === 'local' ? Promise.resolve(local.voteDissolve(roomId, playerId, agree)) : ws.voteDissolve(roomId, playerId, agree);
    },
    cancelDissolve: function (roomId, playerId) {
      return MODE === 'local' ? Promise.resolve(local.cancelDissolve(roomId, playerId)) : ws.cancelDissolve(roomId, playerId);
    },
    addBot: function () {
      return MODE === 'local' ? Promise.resolve(local.addBot()) : ws.addBot();
    },
    /* 登录/注册成功后换一条「带令牌」的连接（未鉴权连接 30 秒必被服务端踢，见 ws.reauth 注释）。
     * local 演示模式没有服务端，直接空转。 */
    reauth: function () {
      return MODE === 'local' ? Promise.resolve(null) : ws.reauth();
    },
    getRoom: function (roomId) {
      return MODE === 'local' ? local.getRoom(roomId) : ws.getRoom(roomId);
    },
    subscribe: function (roomId, cb) {
      return MODE === 'local' ? local.subscribe(roomId, cb) : ws.subscribe(roomId, cb);
    },
    /* 表情/短语。两种传输语义一致：合法就发，超限静默丢弃，永不落库。 */
    sendEmoji: function (roomId, fromId, to, id) {
      return MODE === 'local' ? local.sendEmoji(roomId, fromId, to, id) : ws.sendEmoji(roomId, fromId, to, id);
    },
    onEmoji: function (cb) {
      return MODE === 'local' ? local.onEmoji(cb) : ws.onEmoji(cb);
    },
    /* 云端档案只在 ws 模式可用（local 模式没有服务端） */
    canQueryProfile: function () { return MODE === 'ws'; },
    getProfile: function (playerId) {
      return MODE === 'local' ? Promise.resolve(local.getProfile(playerId)) : ws.getProfile(playerId);
    },
    /* 删档已改走 HTTP（authStore.deleteAccount）：WS 侧的「要令牌再删」整体下线 */
    onDisconnect: function (cb) {
      // 本地模式无断线概念，注册为 no-op
      return MODE === 'ws' ? ws.onDisconnect(cb) : function () {};
    },
    reconnect: function (roomId, playerId) {
      return MODE === 'local' ? Promise.resolve({ ok: true }) : ws.reconnect(roomId, playerId);
    },
    /* 只读快照（离开房间前核对进度用）。本地演示模式读内存里那份就够了。 */
    peekRoom: function (roomId) {
      return MODE === 'local'
        ? Promise.resolve({ ok: true, room: local.getRoom(roomId) })
        : ws.peekRoom(roomId);
    },
    /* 刷新/重载后凭本地令牌回座；本地演示模式没有服务端座位概念，直接跳过 */
    resume: function (playerId) {
      return MODE === 'local' ? Promise.resolve({ ok: false, reason: 'local-mode' }) : ws.resume(playerId);
    },
    onOffline: function (cb) {
      // 本地模式无断线概念，注册为 no-op
      return MODE === 'ws' ? ws.onOffline(cb) : function () {};
    },
    /* 连接级致命错误（鉴权失败 / 被管理员停用后踢线），界面要据此把人送回登录页 */
    onFatal: function (cb) {
      return MODE === 'ws' ? ws.onFatal(cb) : function () {};
    },
    /* 主动断开长连接（退出登录 / 删号时用）。
     * 必须挂在门面上：WS 在连上那一刻就完成了认证，只清 localStorage 的话，
     * 这条连接会继续以上一个账号的身份挂在服务端——同一台设备换人接手时，
     * 对方点一下还在替前一个人的号打牌。 */
    disconnect: function () {
      if (MODE === 'ws') { ws.disconnect(); return; }
      local.disconnect();
    }
  };
});
