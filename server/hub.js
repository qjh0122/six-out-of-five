/**
 * 房间中心（服务端权威）
 *
 * 协议对齐前端 roomStore.js（请求 **20 种**，按用途分组）：
 *   身份   auth / rename
 *   房间   createRoom / joinRoom / leaveRoom / reconnect / peekRoom / addBot / getProfile
 *   对局   ready / start / submitGroups / restart
 *   结算   wantNext / unWantNext / proposeDissolve / voteDissolve / cancelDissolve
 *   其它   ping / emoji（表情与短语，只转发不落库）
 *
 *   推送 6 种： room / roomDeleted / ok / error / pong / emoji
 *
 * 规则与计分全部复用前端同一份 stateMachine.js / engine.js（双端同源），
 * 服务端只负责：连接与房间的绑定、权限、广播、断线宽限、档案聚合。
 */
'use strict';

const path = require('path');
const crypto = require('crypto');
const SM = require(path.join(__dirname, '..', 'pwa', 'js', 'stateMachine.js'));
const AI = require(path.join(__dirname, '..', 'pwa', 'js', 'ai.js'));
const CONFIG = require(path.join(__dirname, '..', 'pwa', 'js', 'config.js'));
/* 表情/短语白名单。**不在这里再抄一份**：与前端是同一个文件，
 * 少了这一条，加一张新表情就会变成「前端能点、服务端静默丢弃」。 */
const Emoji = require(path.join(__dirname, '..', 'pwa', 'js', 'emoji.js'));

const GRACE_MS = 90000;        // 断线宽限：90 秒。20 秒对移动网络太苛刻——切 WiFi/4G、
                               // 进电梯、地铁过隧道都很容易超过，人被踢出这局就白打了。
                               // 判弃后手牌仍保留，宽限内或本局未翻轮前都能回桌。
const AUTH_TIMEOUT_MS = Number(process.env.WS_AUTH_TIMEOUT_MS) || 30000; // 连上来却不鉴权的连接，30 秒后关掉。没有这条，
                               // 一个脚本可以开几万个空连接（不鉴权就不进房间，也不占内存上限之外的任何配额）。
const SPLIT_TIMEOUT_MS = Number(process.env.SPLIT_TIMEOUT_MS) || 60000;
/* 重连时给分牌阶段的人补的最低剩余时间。计时器按「首次进入分牌」起算且幂等，
 * 所以最后一秒才连回来的人眼看就要被判弃权；补到 15 秒他才来得及看清牌。 */
const MIN_RECONNECT_SPLIT_MS = Number(process.env.MIN_RECONNECT_SPLIT_MS) || 15000;
                                // 分牌超时：默认 60 秒。有人开着页面不提交（挂机）时，
                                // 超时自动「本回合弃权」，其他人不被卡死。
                                // 弃权者仍留在房间、下一把照常玩，只是本回合 0 分（还得照常付给赢家）。
                                // 测试用 SPLIT_TIMEOUT_MS 环境变量改短。
/* 人数上限不在这里定义。
 * 这里曾经有一份 `const MAX_PLAYERS = 8;` —— config.js 里也有一份。
 * 两份同时存在时，改一处等于没改：前端拦住第 6 个人、服务端还放行，
 * 或者反过来（服务端先拒、前端界面上还有空位）。与「原型手抄一份规则」是同一类错误。
 * 现在统一走 StateMachine.capOf(room)：新建的房间按建房时的上限，
 * 老房间按它自己建房当时那一档，改上限不会把正在进行的房间打乱。 */

/* ---------------------------- 心跳判活 ----------------------------
 *
 * 为什么必须有：WS 只有在对面正常关闭（FIN）或 RST 时才会收到 close 事件。
 * 移动端切后台被系统回收、进程被 kill -9、地铁进隧道、手机没电 ——
 * 这些场景**不会发 FIN**，服务端那条连接就一直躺着，直到 TCP 自己超时（可能是几十分钟）。
 *
 * 代价是三重的：
 *   · 每条僵尸连接占一个 fd 和一块收流缓冲；
 *   · 它还留在 `room.players` 里，`connected` 一直是 true，别人看不到他掉线；
 *   · `/api/health` 的 `conns` 把他算作在线 —— 发布前的实测就是这个样子：
 *     `rooms: 3, conns: 9`，重启后 0/0，9 条全是僵尸。
 *
 * 做法：每 30 秒给每条已鉴权连接发一个协议层 ping，连续两次收不到 pong 就关掉。
 * 之所以用**协议层** ping 而不是应用层 JSON：浏览器收到 ping 由网络层自动回 pong，
 * 不需要页面 JS 参与 —— App 切后台、JS 被挂起时仍然能应答。
 * 这样「页面在后台」和「连接已经死了」才区分得开，不会因为用户切个 App 就误踢。
 *
 * 时间账：30 秒 × 2 次 = 最慢 90 秒发现僵尸；发现后走正常断线路径，
 * 还有 GRACE_MS(90 秒) 宽限等他重连。也就是一个切后台的用户有约 3 分钟回来。 */
const HEARTBEAT_MS = Number(process.env.WS_HEARTBEAT_MS) || 30000;
const HEARTBEAT_MAX_MISS = 2;

const ROOM_IDLE_MS = 30 * 60 * 1000; // 空房间回收
/* 解散投票超时：与 stateMachine 里的 DISSOLVE_TIMEOUT_MS 对齐，测试可用环境变量改短。
 * 超时不代表「解散成功」，只是把投票作废 —— 房间回到正常对局，谁也没被扣分。 */
const DISSOLVE_TIMEOUT_MS = Number(process.env.DISSOLVE_TIMEOUT_MS) || SM.DISSOLVE_TIMEOUT_MS;

/* 进房 / 建房的频率限制（按连接算，不按玩家：
 * 换账号的成本比换连接高得多，按连接才能真正卡住脚本）。
 *
 * 为什么必须限：房间号是 6 位数字，空间只有 100 万；而 joinRoom 的回包
 * 会明确区分「房间不存在 / 房间已满 / 加入成功」，一个连接只要有耐心，
 * 就能把**当前所有在线房间号**一个个试出来，然后逐个混进去。每次尝试
 * 还要查表、算视图、必要时广播，成本远高于 ping。10 秒 10 次对真人绰绰有余
 * （正常玩家进一个房间只发一次），对枚举则慢到没有意义。 */
const JOIN_MAX = Number(process.env.JOIN_MAX) || 10;
const JOIN_WINDOW_MS = 10 * 1000;

/* 单连接消息限流（每秒窗口）。
 *
 * 之前整条协议没有任何消息级限流——进房限流只管 joinRoom/createRoom，
 * 其他请求随便刷。实测一条已登录连接在 1.4 秒内发了 1.3 万条请求，服务端
 * 全部照做。这本身是 CPU 浪费，更麻烦的是 ready / submitGroups 这类
 * **每收到一条就 _broadcast 一次**：一条连接刷 N 次，房间里 m 个人
 * 就收到 N×m 条推送，一个脚本足以让整桌（人多了是全服）变成流量放大器。
 *
 * 60 次/秒对真人远远够用：正常对局里玩家点一次才发一条，
 * 最密的操作（连点分牌槽位）也不发请求。心跳 ping 每 30 秒一条。
 * 超限先丢弃回包（客户端表现为超时），连续多个窗口超限就断开。 */
const MSG_MAX = Number(process.env.MSG_MAX) || 60;
const MSG_WINDOW_MS = 1000;
const MSG_STRIKE_MAX = 3;

/* 昵称清洗统一走 server/text.js：以前三处各写一遍，其中两处按**码元**截断，
 * 会把 emoji 切成孤立代理项（存进档案后前端显示成 `�`，而且再也改不回来）。 */
const { cleanNickname } = require('./text.js');
/* 房间快照：进程重启后把进行中的对局捞回来（见 roomsState.js 顶部）。 */
const roomsState = require('./roomsState.js');

class Hub {
  constructor(options) {
    const opts = options || {};
    this.profiles = opts.profiles;
    this.log = opts.log || function () {};

    this.rooms = new Map();     // roomId -> room
    this.conns = new Map();     // WSClient -> { playerId, nickname, roomId }
    this.byPlayer = new Map();  // playerId -> WSClient（最近一次连接）
    this.graceTimers = new Map(); // "roomId#playerId" -> timer
    this.roomTimers = new Map();  // roomId -> 回收 timer
    this.splitTimers = new Map(); // "roomId#round#playerId" -> 分牌超时 timer
    /* 同 key -> 该计时器的起始时刻。只用来算「还剩多少」，
     * 重连时按剩余时间决定是否补时限（见 _refreshSplitDeadline）。 */
    this.splitStartedAt = new Map();
    this.dissolveTimers = new Map(); // roomId -> 解散投票超时 timer
    /* 座位恢复令牌："roomId#playerId" -> token。
     * 单独放一个 Map，不写进 player 对象——player 会被序列化进广播，
     * 一旦混进去等于广播给全房间，令牌就白做了。 */
    this._tokens = new Map();
    /* 连接 → 已鉴权的 playerId。WeakMap：连接断开自动回收，不用手工清。
     * **身份只认这里**：以前每个请求都从 payload.playerId 里取身份，
     * 而 playerId 在排行榜和房间广播里都是明文，等于谁都能冒充谁。
     * 现在必须先用登录令牌 auth 一次，之后请求体里的 playerId 一律无视。 */
    this._auth = new WeakMap();
    /* 连接 → 进房/建房计数，用于限流。WeakMap：连接断开自动回收。 */
    this._joinLimits = new WeakMap();
    /* 连接 → 消息速率计数。WeakMap：连接断开自动回收。
     * 以前整条协议**没有任何消息级限流**：一条已登录连接可以每秒推上万条
     * 请求。ready / submitGroups 这类每收到一条就 _broadcast 一次，
     * 一条连接就能把整桌（乃至全服）的广播量乘上去。 */
    this._msgLimits = new WeakMap();
    /* playerId → 上次发表情的时刻。用 Map（不是 WeakMap）：键是玩家而不是连接，
     * 否则开两个标签页就能绕过「2 秒一条」。容量按活跃人数收，见 emoji() 里的修剪。 */
    this._emojiLimits = new Map();
    /* 令牌 → playerId 的解析器，由 index.js 注入（真实签名校验）。
     * 默认返回空串：没注入就等于「谁都不能登录」，失败方向是安全的。 */
    this.resolveToken = opts.resolveToken || function () { return ''; };
    this.botSeq = 0;            // 全局机器人编号，保证 id 不重复

    /* 连接 → 心跳状态 { missed }。WeakMap：连接断开自动回收。
     * 不写进 conns 的 ctx 里：ctx 会被别处整体替换（见 auth），
     * 一旦重置就把欠账清了，僵尸连接反而更难被发现。 */
    this._hb = new WeakMap();
    /* 心跳定时器全局只有一个，不随房间数增长。unref：不阻止进程退出
     * （测试里经常 new Hub() 然后立刻结束，别让一个 interval 把 Node 挂着）。 */
    this._hbTimer = setInterval(() => this._heartbeat(), HEARTBEAT_MS);
    if (this._hbTimer.unref) this._hbTimer.unref();

    /* ---------------------------- 房间快照（P2-3） ----------------------------
     * 不传 statePath 就完全不落盘：单测里 new Hub() 几百次，
     * 不该因此多出一堆临时文件。生产由 index.js 传数据目录下的路径。 */
    this.statePath = opts.statePath || '';
    this._stateTimer = null;
    this._stateSaves = 0;      // 排障用：真写了几次
    if (this.statePath) this._restoreRooms();
  }

  /* ============================ 房间快照 ============================ */

  /** 启动时把上次的桌子捞回来。
   *
   * 恢复哪些：房间对象、座位令牌、回收计时器、分牌计时器。
   * **不恢复**：连接（全断了，玩家要自己重连回座）、限流计数（清零是对的）。
   *
   * 玩家的 `connected` 一律置 false —— 重启那一刻确实没有连接。
   * 客户端拿着令牌 `resume` 回来，走的是原来那条路，不需要新的协议。 */
  _restoreRooms() {
    const snap = roomsState.load(this.statePath);
    if (!snap) return 0;
    let n = 0;
    snap.rooms.forEach((room) => {
      try {
        if (!room.roomId || this.rooms.has(room.roomId)) return;
        (room.players || []).forEach((p) => { if (p) p.connected = false; });
        room.updatedAt = room.updatedAt || Date.now();
        this.rooms.set(room.roomId, room);
        this._armRoomRecycle(room.roomId);
        /* 广播一次把分牌计时器装回去（_armSplitTimers 是幂等的，且挂在 _broadcast 里）。
         * 此刻没有任何连接，这次广播只会落到 0 个客户端 —— 不会泄露手牌。 */
        this._broadcast(room.roomId);
        n += 1;
      } catch (e) {
        /* 单个房间恢复失败不该连累其他桌：跳过它，继续下一个。 */
        this.log('room restore failed', room.roomId, e && e.message);
      }
    });
    snap.tokens.forEach((pair) => {
      if (this.rooms.has(String(pair[0]).split('#')[0])) this._tokens.set(pair[0], pair[1]);
    });
    if (n) this.log('rooms restored', n, 'tokens', snap.tokens.length);
    return n;
  }

  /** 落盘（去抖）。高频调用只保留最后一次 —— 一局里每次提交都会广播。 */
  _scheduleStateSave() {
    if (!this.statePath || this._stateTimer) return;
    this._stateTimer = setTimeout(() => {
      this._stateTimer = null;
      this._saveStateNow();
    }, 400);
    if (this._stateTimer.unref) this._stateTimer.unref();
  }

  /** 立刻落盘。删房间这种「少了一张桌子」的变化不等去抖。 */
  _saveStateNow() {
    if (!this.statePath) return false;
    const rooms = [];
    this.rooms.forEach((room) => { rooms.push(room); });
    const ok = roomsState.save(this.statePath, {
      rooms: rooms,
      tokens: Array.from(this._tokens.entries())
    });
    this._stateSaves += 1;
    if (!ok) this.log('state save failed', this.statePath);
    return ok;
  }

  /* ============================ 连接生命周期 ============================ */

  attach(client) {
    /* 收到 pong 或任何一条业务消息，都算「对面还活着」。
     * 只认 pong 是不够的：有的中间层会吃掉控制帧但正常转发数据，
     * 那种连接业务上完全可用，不能因为心跳被拦就把它判死。 */
    this._hb.set(client, { missed: 0 });
    client.on('pong', () => { this._hb.set(client, { missed: 0 }); });
    client.on('message', (raw) => {
      this._hb.set(client, { missed: 0 });
      this.onMessage(client, raw);
    });
    client.on('close', () => this.onClose(client));

    /* 握手超时：连上来 30 秒还没 auth 的连接直接关掉。
     * 有这条才挡得住「开一大堆不鉴权的空连接」——这种连接既不占房间，
     * 也不触发任何容量判定，能一直躺着吃内存和 fd。 */
    const timer = setTimeout(() => {
      if (!this._pid(client)) this._kick(client, '连接未登录，已断开');
    }, AUTH_TIMEOUT_MS);
    if (timer.unref) timer.unref();
  }

  /**
   * 心跳判活：给每条已鉴权连接发协议层 ping，连续两轮收不到 pong 就关掉。
   *
   * **不能用 `_kick`**：那个会把 `kicked: true` 发给前端，前端据此「不再自动重连」。
   * 心跳失败恰恰是最该重连的场景（用户可能只是进了电梯），
   * 所以这里走普通 `close()`：前端 onclose 会照常 scheduleReconnect，
   * 服务端走正常断线路径 —— 标记 disconnected、广播、起 90 秒宽限期。
   * 也就是说「被判僵尸」的代价最多一次自动重连，不是丢号，也不是丢这局。
   */
  _heartbeat() {
    this.conns.forEach((ctx, client) => {
      const st = this._hb.get(client) || { missed: 0 };
      if (st.missed >= HEARTBEAT_MAX_MISS) {
        this.log('heartbeat timeout', (ctx && ctx.playerId) || '', st.missed);
        try { client.close(4001, 'heartbeat timeout'); } catch (e) { /* 连接已坏 */ }
        return;
      }
      st.missed += 1;
      this._hb.set(client, st);
      /* 帧都写不进去，说明 socket 已经坏了，不必再等下一轮 */
      if (!client.ping()) {
        try { client.close(4002, 'socket dead'); } catch (e) { /* 已断 */ }
      }
    });
  }

  /**
   * 单连接消息限额。返回 false 表示这一条应当被丢弃。
   *
   * 用「固定窗口 + 连续超限计数」而不是令牌桶：这里要挡的是脚本式的持续猛刷，
   * 不是平滑掉突发。固定窗口实现简单、状态小（两个数字），代价是窗口边界
   * 可能放过约 2 倍的瞬时量——对 60/秒 这个量级无所谓。
   *
   * 只在前几条超限时记一行日志，免得刷屏本身又成了一条新的攻击面。
   */
  _msgAllowed(client) {
    const now = Date.now();
    let st = this._msgLimits.get(client);
    if (!st) { st = { win: now, count: 0, strikes: 0, logged: false }; this._msgLimits.set(client, st); }
    if (now - st.win >= MSG_WINDOW_MS) {
      if (st.count > MSG_MAX) st.strikes++; else st.strikes = 0;
      st.win = now;
      st.count = 0;
      st.logged = false;
    }
    st.count++;
    if (st.count <= MSG_MAX) return true;
    if (!st.logged) {
      st.logged = true;
      this.log('msg rate limited', this._pid(client) || '(未登录)', st.count + '/' + MSG_WINDOW_MS + 'ms');
    }
    if (st.strikes >= MSG_STRIKE_MAX) {
      this._kick(client, '请求过于频繁，连接已断开');
    }
    return false;
  }

  onMessage(client, raw) {
    /* 连 JSON.parse 都要挡：解析本身就是 CPU 开销，
     * 放在限流之后才拦得住「构造超大 payload 猛推」这种打法。 */
    if (!this._msgAllowed(client)) return;

    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;

    const type = msg.type;
    const reqId = msg.reqId;
    const payload = msg.payload || {};

    if (type === 'ping') { this._push(client, { type: 'pong' }); return; }

    try {
      this._dispatch(client, type, payload, reqId);
    } catch (e) {
      this.log('handler error', type, e && e.message);
      this._fail(client, reqId, (e && e.message) || '服务异常');
    }
  }

  onClose(client) {
    const ctx = this.conns.get(client);
    if (!ctx) return;
    this.conns.delete(client);
    if (this.byPlayer.get(ctx.playerId) === client) this.byPlayer.delete(ctx.playerId);
    if (!ctx.roomId) return;

    const room = this.rooms.get(ctx.roomId);
    if (!room) return;

    // 同一玩家可能还有别的活连接（多标签页），此时不算掉线
    if (this._hasLiveConn(ctx.playerId, ctx.roomId)) return;

    SM.markDisconnected(room, ctx.playerId);
    this._broadcast(ctx.roomId);
    this._startGrace(ctx.roomId, ctx.playerId);
  }

  /* ============================ 协议分发 ============================ */

  _dispatch(client, type, payload, reqId) {
    switch (type) {
      case 'auth': return this.auth(client, payload, reqId);
      case 'createRoom': return this.createRoom(client, payload, reqId);
      case 'joinRoom': return this.joinRoom(client, payload, reqId);
      case 'leaveRoom': return this.leaveRoom(client, reqId);
      case 'ready': return this.ready(client, payload, reqId);
      case 'rename': return this.rename(client, payload, reqId);
      case 'start': return this.start(client, reqId);
      case 'submitGroups': return this.submitGroups(client, payload, reqId);
      case 'beginRevise': return this.beginRevise(client, reqId);
      case 'cancelRevise': return this.cancelRevise(client, reqId);
      case 'restart': return this.restart(client, reqId);
      case 'wantNext': return this.wantNext(client, reqId);
      case 'unWantNext': return this.unWantNext(client, reqId);
      case 'setHandLimit': return this.setHandLimit(client, payload, reqId);
      case 'dropNext': return this.dropNext(client, payload, reqId);
      case 'proposeDissolve': return this.proposeDissolve(client, reqId);
      case 'voteDissolve': return this.voteDissolve(client, payload, reqId);
      case 'cancelDissolve': return this.cancelDissolve(client, reqId);
      case 'addBot': return this.addBot(client, reqId);
      case 'getProfile': return this.getProfile(client, payload, reqId);
      case 'reconnect': return this.reconnect(client, payload, reqId);
      case 'peekRoom': return this.peekRoom(client, payload, reqId);
      case 'emoji': return this.emoji(client, payload, reqId);
      default: return this._fail(client, reqId, '未知请求类型');
    }
  }

  /**
   * 登录握手。客户端连上 WS 后第一件事就是发它，之后这个连接才算「有身份」。
   * 令牌是 HTTP 登录拿到的，签名校验与登录态同源，所以 WS 不需要再存会话。
   */
  auth(client, payload, reqId) {
    const token = String(payload.token || '');
    const pid = String(this.resolveToken(token) || '');
    if (!pid) return this._fail(client, reqId, '登录已失效，请重新登录');
    const acct = this.profiles.accountOf(pid);
    if (!acct) return this._fail(client, reqId, '账号不存在，请重新注册');
    if (acct.disabled) return this._fail(client, reqId, '该账号已被停用，请联系管理员');

    this._auth.set(client, pid);
    const ctx = this.conns.get(client);
    if (ctx) ctx.playerId = pid;
    const prof = this.profiles.get(pid);
    this._ok(client, reqId, {
      playerId: pid,
      nickname: (prof && prof.nickname) || acct.name,
      avatar: (prof && prof.avatar) || '',
      photo: (prof && prof.photo) || ''
    });
  }

  /** 玩家的头像预设 id（没选过返回空串，客户端会按 id 哈希兜一款）。
   *  房间里的 player 对象是**快照**：建房/进房时拷一份，所以换头像后要回房间才生效 ——
   *  这比每次广播都去档案里查一次便宜，而且头像不是实时性要求高的东西。 */
  _avatarOf(playerId) {
    const p = this.profiles.get(playerId);
    return (p && p.avatar) || '';
  }

  /** 上传照片的版本号（P1b）。空串 = 没传过照片，用预设头像。
   *  和 _avatarOf 一样是**快照**：换照片后回房间才生效。 */
  _photoOf(playerId) {
    const p = this.profiles.get(playerId);
    return (p && p.photo) || '';
  }

  /** 当前连接的身份。未鉴权返回空串——调用方一律按「未登录」拒绝。
   *
   * 这里**每次都复查账号**（存在 + 未停用），不是只在握手时查一次：
   * 只在握手查的话，管理员把人停用了，他只要不断线就能一直打、一直被记战绩。
   * Map 查询，开销可以忽略。 */
  _pid(client) {
    const pid = String(this._auth.get(client) || '');
    if (!pid) return '';
    const acct = this.profiles.accountOf(pid);
    if (!acct) { this._auth.delete(client); this._kick(client, '账号不存在，请重新注册'); return ''; }
    if (acct.disabled) { this._auth.delete(client); this._kick(client, '该账号已被停用，请联系管理员'); return ''; }
    return pid;
  }

  /**
   * 强制断开某个玩家的所有连接（停用 / 删号时调用）。
   * 不这么做的话，被停用的人只要页面不刷新就能继续玩，战绩照记。
   */
  kickPlayer(playerId, reason) {
    const pid = String(playerId == null ? '' : playerId);
    if (!pid) return 0;
    let n = 0;
    this.conns.forEach((ctx, client) => {
      if (ctx.playerId !== pid) return;
      n += 1;
      this._kick(client, reason);
    });
    return n;
  }

  /** 发一条错误再关连接。先发后关、隔一拍，保证客户端真能看到原因。 */
  _kick(client, reason) {
    if (!client || client._kicked) return;
    client._kicked = true;
    this._push(client, { type: 'error', payload: { error: String(reason || '登录已失效'), kicked: true } });
    const c = client;
    const t = setTimeout(function () { try { c.close(4002, 'kicked'); } catch (e) { /* 已断 */ } }, 60);
    if (t.unref) t.unref();
  }

  createRoom(client, payload, reqId) {
    // 身份来自令牌，**不看** payload.playerId
    const playerId = this._pid(client);
    if (!playerId) return this._fail(client, reqId, '未登录，请先登录再开房');
    /* 建房与进房共用一个额度：两个都要防，而正常玩家一分钟也开不了几个房。
     * 建房比进房更贵（新建房间对象 + 挂回收计时器），刷起来是实打实的内存增长。 */
    if (this._joinLimited(client)) return this._fail(client, reqId, '操作太频繁了，请稍等几秒再试');
    // 昵称以档案里的为准：改名走「设置」而不是每次开房都传一遍，
    // 否则同一账号在不同设备上会有不同名字
    const nickname = cleanNickname(payload.nickname || (this.profiles.get(playerId) || {}).nickname);

    if (!this._checkCapacity()) return this._fail(client, reqId, '服务器繁忙，请稍后重试');

    // 已经在别的房间：先按「离开」处理，避免一个连接挂两个房间
    this._detachFromRoom(client);

    const roomId = this._genRoomId();
    /* 本局局数：只认建房这一刻送来的档位，而且必须过白名单。
     * 客户端传 7 / 'abc' / 什么都不传，一律按默认 10 建（见 SM.normalizeHandLimit）——
     * 建房不该因为一个下拉框失败，但也不能让脏参数把房间变成"永不结束"。
     * 进房之后再没人能改这个值：结束契约一旦可变，等于没有契约。 */
    const room = SM.newRoom(
      roomId,
      { id: playerId, nickname: nickname, avatar: this._avatarOf(playerId), photo: this._photoOf(playerId) },
      { handLimit: SM.normalizeHandLimit(payload.handLimit) }
    );
    this.rooms.set(roomId, room);
    this._armRoomRecycle(roomId);

    this._bind(client, playerId, nickname, roomId);
    this.profiles.ensure(playerId, nickname);

    this._ok(client, reqId, { room: this._view(room, playerId), token: this._issueToken(roomId, playerId) });
    this._broadcast(roomId);
    this.log('room created', roomId, nickname);
  }

  /**
   * 记一次「进房/建房」尝试，返回 true 表示该冷静一下了。
   * 窗口是滑动的：一直猛试就一直延长，真的停下来 10 秒才恢复。
   */
  _joinLimited(client) {
    const now = Date.now();
    const rec = this._joinLimits.get(client);
    if (!rec || now > rec.until) {
      this._joinLimits.set(client, { count: 1, until: now + JOIN_WINDOW_MS });
      return false;
    }
    rec.count += 1;
    rec.until = now + JOIN_WINDOW_MS;
    return rec.count > JOIN_MAX;
  }

  joinRoom(client, payload, reqId) {
    const roomId = String(payload.roomId || '').trim();
    const playerId = this._pid(client);
    if (!playerId) return this._fail(client, reqId, '未登录，请先登录再加入房间');
    if (this._joinLimited(client)) return this._fail(client, reqId, '操作太频繁了，请稍等几秒再试');
    if (!/^\d{6}$/.test(roomId)) return this._fail(client, reqId, '房间号格式不正确');

    const room = this.rooms.get(roomId);
    if (!room) return this._fail(client, reqId, '房间不存在');

    const existing = SM.findPlayer(room, playerId);
    if (existing && !existing.left) {
      // 同一玩家重复加入（刷新/重连）：认回原座位，但必须出示令牌。
      // roomId + playerId 都在房间广播里，只看这两项等于谁都能接管别人座位。
      if (!this._verifySeat(roomId, playerId, payload.token)) {
        return this._fail(client, reqId, '身份校验失败：座位不属于当前设备，请用原浏览器打开或重新加入');
      }
      existing.connected = true;
      existing.disconnectedAt = null;
      this._bind(client, playerId, existing.nickname, roomId);
      this._clearGrace(roomId, playerId);
      this._refreshSplitDeadline(roomId, playerId);   // 同 reconnect：刷新/重进也要补时限
      this._ok(client, reqId, { room: this._view(room, playerId), token: this._issueToken(roomId, playerId) });
      this._broadcast(roomId);
      return;
    }
    if (SM.activePlayers(room).length >= SM.capOf(room)) {
      return this._fail(client, reqId, '房间已满（最多 ' + SM.capOf(room) + ' 人）');
    }

    const nickname = cleanNickname(payload.nickname || (this.profiles.get(playerId) || {}).nickname);
    const res = SM.joinRoom(room, { id: playerId, nickname: nickname, avatar: this._avatarOf(playerId), photo: this._photoOf(playerId) });
    if (!res.ok) return this._fail(client, reqId, res.error || '加入失败');

    this._detachFromRoom(client);
    this._bind(client, playerId, nickname, roomId);
    this.profiles.ensure(playerId, nickname);
    this._armRoomRecycle(roomId);

    this._ok(client, reqId, { room: this._view(res.room, playerId), token: this._issueToken(roomId, playerId) });
    this._broadcast(roomId);
  }

  leaveRoom(client, reqId) {
    const ctx = this.conns.get(client);
    if (!ctx || !ctx.roomId) { this._ok(client, reqId, {}); return; }

    const roomId = ctx.roomId;
    const room = this.rooms.get(roomId);
    ctx.roomId = null;
    if (!room) { this._ok(client, reqId, {}); return; }

    const res = SM.leaveRoom(room, ctx.playerId);
    this._ok(client, reqId, {});

    if (res.deleted) {
      this._deleteRoom(roomId);
      return;
    }
    this._broadcast(roomId);
  }

  ready(client, payload, reqId) {
    const found = this._requireRoom(client, reqId);
    if (!found) return;
    const res = SM.setReady(found.room, found.playerId, !!payload.ready);
    if (!res.ok) return this._fail(client, reqId, res.error);
    this._ok(client, reqId, {});
    this._maybeAutoStart(found.roomId);
    this._broadcast(found.roomId);
  }

  /* 结算页「开始下一局」：把我登记进下一局，然后回房间页。
   * 房间 phase 故意不动（还是 SETTLED）—— 见 stateMachine.wantNext 的注释：
   * 一旦推到 WAITING，所有没点的人会被广播顶出结算页。 */
  wantNext(client, reqId) {
    const found = this._requireRoom(client, reqId);
    if (!found) return;
    const res = SM.wantNext(found.room, found.playerId);
    if (!res.ok) return this._fail(client, reqId, res.error);
    this._ok(client, reqId, {});
    this._maybeAutoStart(found.roomId);
    this._broadcast(found.roomId);
  }

  /* 撤回「开始下一局」：退回结算页。
   * 不调 _maybeAutoStart —— 撤回只会让满足条件的人变少，不可能触发开局。 */
  unWantNext(client, reqId) {
    const found = this._requireRoom(client, reqId);
    if (!found) return;
    const res = SM.unWantNext(found.room, found.playerId);
    if (!res.ok) return this._fail(client, reqId, res.error);
    this._ok(client, reqId, {});
    this._broadcast(found.roomId);
  }

  /* 候场期改把数（C-3 / v117）：只改「下一场打几把」，不碰已经打完的结果。
   * 不调 _maybeAutoStart —— 改把数不会让任何人更接近开局。 */
  setHandLimit(client, payload, reqId) {
    const found = this._requireRoom(client, reqId);
    if (!found) return;
    const res = SM.setHandLimit(found.room, found.playerId, payload && payload.handLimit);
    if (!res.ok) return this._fail(client, reqId, res.error);
    this._ok(client, reqId, { handLimit: res.handLimit });
    this._broadcast(found.roomId);
  }

  /* 「不等他」：把一个已报名但一直不准备的人退回结算页。
   * 不踢人、不判弃 —— 只撤报名，所以他还在房间、名次还在。
   * 调用 _maybeAutoStart：这一步本身是「让人更接近开局」，必须接。 */
  dropNext(client, payload, reqId) {
    const found = this._requireRoom(client, reqId);
    if (!found) return;
    const targetId = String((payload && payload.targetId) || '');
    if (!targetId) return this._fail(client, reqId, '缺少要跳过的人');
    const res = SM.dropFromNext(found.room, found.playerId, targetId);
    if (!res.ok) return this._fail(client, reqId, res.error);
    this._ok(client, reqId, {});
    this._maybeAutoStart(found.roomId);
    this._broadcast(found.roomId);
  }

  /* 全员就绪 → 自动开局。
   *
   * 只在「用户表达了准备好了」的那几个入口调用（ready / wantNext / restart），
   * 不放进 _broadcast：补 AI 也会走广播，若在那里触发，房主先点了准备、
   * 再想补 3 个 AI，补第一个的瞬间就开局了 —— 剩下的根本补不进来。
   *
   * unWantNext 也**故意不调**：撤回只会让满足条件的人变少，不可能凑出一次开局。
   * 以后新增入口时先想清楚它是不是「让人更接近开局」，不是就别接进来。
   *
   * 具体开哪种局由状态机的 autoStartIfReady 决定（首次开局 / 结算后的下一局），
   * 服务端只负责善后：把没报名的人请出去。递归安全：开局后 phase 立刻改变，判定为 false。 */
  _maybeAutoStart(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const r = SM.autoStartIfReady(room);
    if (!r) return;
    if (r.kind === 'start') {
      this.log('auto start', roomId);
      return;
    }
    this.log('auto next round', roomId);
    this._evictFromRoom(roomId, r.removed, 'nextRoundStarted');
  }

  /* 把一些人从这个房间里请出去，并明确告诉他们原因。
   *
   * 不通知的后果：他们的界面还停在结算页，点「开始下一局」才收到「已经开始了」，
   * 而且连接仍绑在 roomId 上 —— 之后每次广播都会给他们推一份「自己不在名单里」的房间，
   * 前端既不能当观众也不能当玩家，只能瞎猜。
   * 复用 roomDeleted 事件（不新增协议类型），靠 reason 区分文案。 */
  _evictFromRoom(roomId, playerIds, reason) {
    if (!playerIds || !playerIds.length) return;
    playerIds.forEach((pid) => {
      const c = this.byPlayer.get(pid);
      if (!c) return;
      const ctx = this.conns.get(c);
      if (ctx && ctx.roomId === roomId) ctx.roomId = null;
      this._push(c, {
        type: 'roomDeleted',
        payload: { roomId: roomId, reason: reason }
      });
    });
  }

  rename(client, payload, reqId) {
    const found = this._requireRoom(client, reqId);
    if (!found) return;
    const nickname = cleanNickname(payload.nickname);
    if (!nickname || nickname === '玩家') return this._fail(client, reqId, '昵称不能为空');
    const res = SM.rename(found.room, found.playerId, nickname);
    if (!res.ok) return this._fail(client, reqId, res.error);
    // 同步连接上下文里的昵称（重连/档案落库都要用），并更新云端档案昵称
    this._bind(client, found.playerId, nickname, found.roomId);
    this.profiles.ensure(found.playerId, nickname);
    this._ok(client, reqId, {});
    this._broadcast(found.roomId);
  }

  /* 手动开局。**当前客户端已经不发这个请求了** —— 开局改成「全员准备即自动开局」
   * （见 _maybeAutoStart），房主点「开始游戏」那条路连同按钮一起下线。
   *
   * 保留它只有一个理由：装了旧版 PWA、SW 还没换缓存的老客户端还会发 start。
   * 让它们继续开得起来，比让它们卡在「点了没反应」好。
   * 什么时候能删：确认线上没有 start 请求之后（服务端日志里 grep 一次即可）。 */
  start(client, reqId) {
    const found = this._requireRoom(client, reqId);
    if (!found) return;
    const res = SM.startGame(found.room, found.playerId);
    if (!res.ok) return this._fail(client, reqId, res.error);

    // 开局时全员的准备状态已由状态机重置为 false，广播后前端会同步按钮态
    this._ok(client, reqId, {});
    this._broadcast(found.roomId);
  }

  submitGroups(client, payload, reqId) {
    const found = this._requireRoom(client, reqId);
    if (!found) return;
    const groups = payload.groups || {};
    const res = SM.submitGroups(found.room, found.playerId, groups);
    if (!res.ok) return this._fail(client, reqId, res.error);

    /* 他刚刚退出修改态（提交等于定稿）。之前给他挂的「改牌倒计时」如果还在，
     * 60 秒后会在回调里发现 submitted 为真而直接 return —— 但 Map 里那条记录
     * 会一直留到那时。顺手清掉，省得日志里出现幽灵任务。 */
    this._dropSplitTimer(found.roomId, found.room.round, found.playerId);

    this._ok(client, reqId, {});
    this._broadcast(found.roomId);
  }

  /*
   * 进入 / 退出「改一下」（v105）。
   *
   * 为什么要走服务端，而不是前端自己改个 state 就算：
   * 「正在修改」是**要不要结算**的输入之一（见 SM.isRoundLocked）。
   * 只写在客户端的话，服务端看不见，别人全提交的瞬间照样会把本轮结掉，
   * 用的是他还没改完的那份旧分组 —— 这正是要修的那个 bug。
   *
   * 顺带挂上分牌倒计时：他一旦进入修改态就不再是「已定稿」，
   * 原来「已提交就不挂计时器」的规则会让他掉线时把全桌吊死。
   * 超时的语义在 forfeitRound 里另有处理：有旧分组的人超时 = 放弃修改，
   * 按他交过的那份结算，不按弃权算。
   */
  beginRevise(client, reqId) {
    const found = this._requireRoom(client, reqId);
    if (!found) return;
    const res = SM.beginRevise(found.room, found.playerId);
    if (!res.ok) return this._fail(client, reqId, res.error);

    const p = SM.findPlayer(found.room, found.playerId);
    if (p) {
      this._armOneSplitTimer(found.room, p, found.room.round, SPLIT_TIMEOUT_MS, false);
    }
    this._ok(client, reqId, {});
    this._broadcast(found.roomId);
  }

  cancelRevise(client, reqId) {
    const found = this._requireRoom(client, reqId);
    if (!found) return;
    const res = SM.cancelRevise(found.room, found.playerId);
    if (!res.ok) return this._fail(client, reqId, res.error);
    /* 恢复定稿状态后可能全桌就齐了（stateMachine 里已调 settleIfAllIn），
     * 无论结没结算都要广播 —— 别人屏幕上的「正在改」标记得撤掉。 */
    this._ok(client, reqId, {});
    this._broadcast(found.roomId);
  }

  restart(client, reqId) {
    const found = this._requireRoom(client, reqId);
    if (!found) return;
    const res = SM.restart(found.room, found.playerId);
    if (!res.ok) return this._fail(client, reqId, res.error);
    this._ok(client, reqId, {});
    this._maybeAutoStart(found.roomId);
    this._broadcast(found.roomId);
  }

  proposeDissolve(client, reqId) {
    const found = this._requireRoom(client, reqId);
    if (!found) return;
    const res = SM.proposeDissolve(found.room, found.playerId);
    if (!res.ok) return this._fail(client, reqId, res.error);
    this._ok(client, reqId, {});
    this._syncDissolveTimer(found.roomId);
    this._broadcast(found.roomId);
  }

  /* 发起人撤销解散投票。没有它，点错一次就只能干等 30 秒超时。 */
  cancelDissolve(client, reqId) {
    const found = this._requireRoom(client, reqId);
    if (!found) return;
    const res = SM.cancelDissolve(found.room, found.playerId);
    if (!res.ok) return this._fail(client, reqId, res.error);
    this._ok(client, reqId, {});
    this._syncDissolveTimer(found.roomId);
    this._broadcast(found.roomId);
  }

  voteDissolve(client, payload, reqId) {
    const found = this._requireRoom(client, reqId);
    if (!found) return;
    const res = SM.voteDissolve(found.room, found.playerId, !!payload.agree);
    if (!res.ok) return this._fail(client, reqId, res.error);
    this._ok(client, reqId, {});
    this._syncDissolveTimer(found.roomId);
    this._broadcast(found.roomId);
  }

  /* 让定时器状态与房间状态对齐：
   *   投票进行中 → 按「本轮 startedAt」挂一个；已经挂过就不重挂（否则每次广播都把 30 秒续上，永远不超时）
   *   投票已结束 → 清掉
   * 三个入口（发起/投票/取消）都调它，避免哪天新增一条路径忘了收尾。 */
  _syncDissolveTimer(roomId) {
    const room = this.rooms.get(roomId);
    const d = room && room.dissolve;
    if (!room || !d || !d.active) { this._clearDissolve(roomId); return; }

    const armed = this.dissolveTimers.get(roomId);
    if (armed && armed.startedAt === d.startedAt) return;   // 同一轮投票，已挂
    if (armed) { clearTimeout(armed.timer); this.dissolveTimers.delete(roomId); }

    // 剩余时间按 startedAt 算：重连/服务重启后补挂也不会「重新给满 30 秒」
    const remain = Math.max(0, (d.startedAt || Date.now()) + DISSOLVE_TIMEOUT_MS - Date.now());
    const timer = setTimeout(() => {
      this.dissolveTimers.delete(roomId);
      const cur = this.rooms.get(roomId);
      if (!cur) return;
      if (!SM.expireDissolve(cur, Date.now(), DISSOLVE_TIMEOUT_MS)) return;  // 期间已被同意/拒绝/取消
      this.log('dissolve expired (no quorum in time)', roomId);
      this._broadcast(roomId);
    }, remain);
    if (timer.unref) timer.unref();
    this.dissolveTimers.set(roomId, { timer: timer, startedAt: d.startedAt });
  }

  _clearDissolve(roomId) {
    const armed = this.dissolveTimers.get(roomId);
    if (armed) { clearTimeout(armed.timer); this.dissolveTimers.delete(roomId); }
  }

  /**
   * 房主补一个 AI 玩家。
   * 为什么限定在 WAITING 与 SETTLED：对局中加人会瞬间改变在场人数与结算口径，
   * 既破坏公平也让「人数不足结束」的判断变得不可预期。
   * 而**结算期**加人没有这个问题（这一把已经算完了），它恰好是「剩 1 人开不了下一把」
   * 这个死锁的唯一出路 —— 那一把还没开始，补进来只是为了凑够人数。
   */
  addBot(client, reqId) {
    const found = this._requireRoom(client, reqId);
    if (!found) return;
    const room = found.room;

    if (room.ownerId !== found.playerId) return this._fail(client, reqId, '只有房主可以补 AI');
    const wasSettled = room.phase === SM.PHASE.SETTLED;
    if (room.phase !== SM.PHASE.WAITING && !wasSettled) {
      return this._fail(client, reqId, '对局已开始，无法补 AI');
    }

    const active = SM.activePlayers(room);
    if (active.length >= SM.capOf(room)) return this._fail(client, reqId, '房间已满（最多 ' + SM.capOf(room) + ' 人）');

    this.botSeq += 1;
    const botId = 'bot_' + this.botSeq;
    const botCount = active.filter(function (p) { return p.isBot; }).length;
    const nickname = '机器人' + (botCount + 1);

    const res = SM.joinRoom(room, { id: botId, nickname: nickname, isBot: true });
    if (!res.ok) return this._fail(client, reqId, res.error);
    /* 结算期补的 AI 不参与**已经打完**的那一把，所以不能标 handHadBot ——
     * 标了这一把会被判成「含 AI 局」，战绩与排行榜口径都会跟着变。
     * 下一把开局时 startNextRound 会按当时的座位重算这个标记。 */
    if (!wasSettled) {
      /* 中途补进来的 AI 也算「这一把含 AI」——它立刻参与后续分牌与计分。
       * 快照只在开局时做（见 SM.startGame），所以这里必须补一刀。 */
      room.handHadBot = true;
    } else {
      /* 结算期补的 AI 要直接进「下一把」的名单：先报名，再准备（顺序不能反 ——
       * wantNext 会把 ready 归 false）。 */
      SM.wantNext(room, botId);
    }
    SM.setReady(room, botId, true); // AI 永远准备好

    this._ok(client, reqId, { botId: botId });
    /* ★ 补完 AI 可能**已经够人数了**，必须接一下自动开局。
     *
     * 这个缺口以前看不见：正常路径上补 AI 都在 WAITING，补完还要房主点「开始」；
     * 或者是结算期补完，房主接着就点「开始下一局」—— 那一下会触发。
     * C-3b 之后多了一条合法路径：**房主自己不报名，只补 AI**，
     * 两张 AI 各自在结算期自动报名，人数就够了。不在这里推一把，
     * 牌局永远不开，而房主正在旁听、什么动作都做不了（旁听者不能解散、不能准备）。
     * 顺序同 wantNext / ready：先推进，再广播推进后的状态。 */
    this._maybeAutoStart(found.roomId);
    this._broadcast(found.roomId);
  }

  getProfile(client, payload, reqId) {
    // 看别人的档案是公开行为（座位卡点开那页），但也要先登录
    if (!this._pid(client)) return this._fail(client, reqId, '未登录');
    const pid = String(payload.playerId || '');
    const prof = pid ? this.profiles.get(pid) : null;
    /* 成就桶随档案卡一起下发。
     *
     * 为什么不再开一个 getAchievements 协议：信息档底部要显示「成就 12/26」，
     * 点进去还是这个人的成就 —— 而一次点击只发生一次。开两条协议的结果是
     * 「点了头像、再点成就」要发两次请求，中间那段空白还得自己补加载态。
     *
     * profiles.get() 走的是 _public，里面只有 achCount（排行榜要轻）；
     * 明细必须单独取，所以这里显式补一份。 */
    if (prof) prof.ach = this.profiles.achOf(pid) || null;
    this._ok(client, reqId, { profile: prof });
  }

  reconnect(client, payload, reqId) {
    const roomId = String(payload.roomId || '');
    const playerId = this._pid(client);
    if (!playerId) return this._fail(client, reqId, '未登录，请重新登录');
    const room = this.rooms.get(roomId);
    if (!room) return this._fail(client, reqId, '房间已结束');

    if (!this._verifySeat(roomId, playerId, payload.token)) {
      return this._fail(client, reqId, '身份校验失败：座位不属于当前设备，请重新加入房间');
    }

    const res = SM.reconnect(room, playerId);
    if (!res.ok) return this._fail(client, reqId, res.error);

    const p = SM.findPlayer(room, playerId);
    /* 只有「从别的房间过来」才需要先退掉旧房间。
     * 如果这个连接本来就绑在同一个房间上（重复 reconnect / 心跳抖动后的重试），
     * 走 _detachFromRoom 会执行一次真正的 leaveRoom——对局中等于自己判自己弃局，
     * 2 人局还会直接把这局判掉。 */
    const ctx = this.conns.get(client);
    if (ctx && ctx.roomId && ctx.roomId !== roomId) this._detachFromRoom(client);
    this._bind(client, playerId, p ? p.nickname : '', roomId);
    this._clearGrace(roomId, playerId);
    /* 分牌阶段重连：若只剩几秒就超时，补到最短时限，否则玩家会觉得「一进来就被判弃权」 */
    this._refreshSplitDeadline(roomId, playerId);

    this._ok(client, reqId, { room: this._view(room, playerId), token: this._issueToken(roomId, playerId) });
    this._broadcast(roomId);
  }

  /**
   * 只读快照。给客户端「点离开前先核对一次最新进度」用。
   *
   * 为什么不能直接用 reconnect：reconnect 会顺带补分牌时限（_refreshSplitDeadline）、
   * 重新绑定连接、下发新座位令牌。客户端只是想知道「现在是第几轮」，
   * 走 reconnect 就意味着反复点「离开 / 取消」能一直被补时限——等于凭空多出分牌时间。
   * 读状态就该是纯读：不改房间、不动计时器、不下发令牌。
   */
  peekRoom(client, payload, reqId) {
    const playerId = this._pid(client);
    if (!playerId) return this._fail(client, reqId, '未登录，请重新登录');
    const roomId = String(payload.roomId || '') || String((this.conns.get(client) || {}).roomId || '');
    if (!roomId) return this._fail(client, reqId, '房间已结束');
    const room = this.rooms.get(roomId);
    if (!room) return this._fail(client, reqId, '房间已结束');
    if (!SM.findPlayer(room, playerId)) return this._fail(client, reqId, '你不在这个房间里');
    this._ok(client, reqId, { room: this._view(room, playerId) });
  }

  /* ============================ 表情 / 短语 ============================
   * 只做三件事：校验、限流、转发。**不落库、不进房间对象、不进回放**。
   *
   * 为什么不塞进 room 状态再走 _broadcast：
   *   · room 一有变化就整包重发（每个玩家都要重绘整桌），而表情 1.6 秒就消失，
   *     为它重绘牌桌完全不划算；
   *   · room 会被 _persistSettlement 落库、也会进回放，表情进去就成了脏数据。
   * 所以这里旁路推给同房间的连接 —— 这也是它「不影响战绩与排行榜」的原因。
   *
   * 校验全部**静默丢弃**而不是回错误：表情是锦上添花，回一行「操作太频繁」
   * 只会让人去点第二次；而且错误回包会走 reqId 通道，界面得为它写一套提示。
   */
  emoji(client, payload, reqId) {
    const ctx = this.conns.get(client);
    if (!ctx || !ctx.playerId || !ctx.roomId) return;
    const room = this.rooms.get(ctx.roomId);
    if (!room) return;

    const id = String(payload.id || '');
    if (id.length > Emoji.ID_MAX_LEN || !Emoji.isValid(id)) return;

    /* to 必须是本房间的人，或者是 '*'（全场）。
     * 不校验的话，一个请求能把表情推到任何房间 —— 转发范围由收件人决定，
     * 这里只保证「发给谁」这个字段本身合法。 */
    const to = String(payload.to || Emoji.BROADCAST);
    if (to !== Emoji.BROADCAST && !room.players.some(function (p) { return p.id === to; })) return;

    const now = Date.now();
    const last = this._emojiLimits.get(ctx.playerId) || 0;
    if (now - last < Emoji.MIN_INTERVAL_MS) return;      // 2 秒一条，超限静默丢弃
    this._emojiLimits.set(ctx.playerId, now);
    /* 长期在线的服务端不能让这张表只增不减：把 1 分钟没发过的人清掉即可
     * （清掉之后最坏结果是这个人多获得一次「立即发送」的机会，无成本）。 */
    if (this._emojiLimits.size > 2000) {
      const cutoff = now - 60000;
      this._emojiLimits.forEach((ts, pid) => { if (ts < cutoff) this._emojiLimits.delete(pid); });
    }

    const out = JSON.stringify({
      type: 'emoji',
      payload: { from: ctx.playerId, to: to, id: id, at: now }
    });
    /* 只推给同房间的人，且**包括发送者自己**：发送端不做乐观渲染，
     * 这样「我看到的表情」与「别人看到的表情」走的是同一条路径，
     * 不会出现「自己这边有、别人那边没有」却查不出原因的情况。 */
    this.conns.forEach((c, sock) => {
      if (c.roomId !== ctx.roomId) return;
      this._push(sock, out);
    });
  }

  /* ============================ 座位令牌 ============================ */
  _seatKey(roomId, playerId) { return roomId + '#' + playerId; }

  /* 签发/复用恢复令牌。玩家建房或入房时下发，客户端存 localStorage，重连时带回。 */
  _issueToken(roomId, playerId) {
    const key = this._seatKey(roomId, playerId);
    let t = this._tokens.get(key);
    if (!t) {
      t = crypto.randomBytes(16).toString('hex');
      this._tokens.set(key, t);
    }
    return t;
  }

  /*
   * 座位校验。只用 roomId + playerId 是不够的——这两项都在房间广播里，
   * 同房间任何人打开控制台就能拿到，进而接管别人的座位并看到其手牌。
   * 令牌由服务端随机生成、只下发给本人，才真正区分「我是我」。
   */
  _verifySeat(roomId, playerId, token) {
    const stored = this._tokens.get(this._seatKey(roomId, playerId));
    if (!stored) return false;
    const given = String(token == null ? '' : token);
    if (given.length !== stored.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(stored));
    } catch (e) {
      return false;
    }
  }

  /* 座位令牌到此为止。删除云端档案的令牌已经整体移除——
   * 那条老路的问题不在令牌本身，而在「签发时不校验请求者身份」，
   * 谁拿到 playerId 就能要到一把能删任何人数据的钥匙。
   * 删档现在只走 HTTP /api/auth/delete，身份由 Bearer 令牌解析，无法冒充。 */

  /* ============================ 广播与档案 ============================ */

  /**
   * 生成「某人视角」的房间副本。
   *
   * 必须做这一步：状态机里的 room 是单份共享对象，所有玩家的手牌和分组都挂在上面的
   * `players[i].hand / groups`。直接整份下发等于把所有人的牌面广播给全场，
   * 界面只画牌背，但数据就在客户端内存里，打开控制台就能看到别家牌。
   *
   * 规则：
   *   - 自己：手牌与分组完整下发
   *   - 别人：`hand` 清空、`groups` 清空（`submitted` 保留，前端要靠它显示"等谁"）
   *   - 未知视角（未绑定玩家）：所有人手牌都清空
   * 结算揭晓不依赖这里——前端用的是 `lastResult`，那一份是打完的牌，可以公开。
   */
  _view(room, viewerId) {
    const view = Object.assign({}, room);
    view.players = room.players.map((p) => {
      const out = Object.assign({}, p);
      if (!viewerId || p.id !== viewerId) {
        out.hand = [];
        out.groups = {};
      }
      return out;
    });

    /* 内部字段不下发。
     * achRun 是成就采集的临时桶（见 SM.settleRound 的注释），前端一个字都用不到。
     * 不删的后果有两个：每帧广播多带一份对象；以及别人的牌型增量跟着发出去 ——
     * 结算页公开的只是「赢家牌型」，这里会把「每个人这轮是什么牌型」全带上。 */
    delete view.achRun;

    /* 分牌倒计时：把「我这轮还剩多久」一并发给本人。
     *
     * 以前这个时刻只活在服务端的 setTimeout 里，玩家完全看不到 —— 60 秒一到
     * 直接被判「本回合弃权」（本回合不收分，还得照付各组赢家），界面才事后告诉他。
     * 对「一部手机开三个容器轮着操作」的人几乎是必踩：切过去打别人的那几十秒，
     * 这边已经悄悄到点，回来只看到一句「你已超时弃权」。
     *
     * 只发给本人、且只在自己还没提交时发（提交后计时器连同起始时刻一起被清掉），
     * 所以不泄露任何别人的信息。`now` 一起下发是为了让客户端扣掉时钟偏差：
     * 设备时间不准时，纯用本地 Date.now() 算的倒计时会整体偏掉。 */
    if (viewerId) {
      const startedAt = this.splitStartedAt.get(room.roomId + '#' + room.round + '#' + viewerId);
      if (startedAt) {
        view.splitEndsAt = startedAt + SPLIT_TIMEOUT_MS;
        view.now = Date.now();
      }
    }
    return view;
  }

  _broadcast(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    // 先让 AI 把该做的动作做完，再推给前端，避免真人看到「AI 迟迟不动」
    this._autoBots(room);
    /* ★ 分牌计时器必须挂在 _autoBots **之后**：翻轮（ROUND1→ROUND2）是 AI 提交
     * 触发的，挂在前面等于按「翻轮前」的阶段判断，第二轮永远挂不上。
     * 后果不只是少一个倒计时 —— 没有计时器就没有超时弃权，
     * 第二轮里谁都不先动手，整桌就一直卡着（谁离开谁丢分），房间也不会被回收
     * （有活连接，走不到 idle 回收）。挪到后面之后，
     * 「进入分牌阶段就挂计时器」对第一轮和第二轮才是同一句话。
     * 幂等由 _armOneSplitTimer(…, true) 保证，重复调用不会重计时。 */
    this._armSplitTimers(room);
    this._persistSettlement(room);
    /* 每一处状态变化最后都会走到广播，所以快照挂在这里最省事：
     * 不需要在 20 多个动作里各补一行（那样漏一个就是「某类变化重启后丢」）。 */
    this._scheduleStateSave();

    this.conns.forEach((ctx, client) => {
      if (ctx.roomId !== roomId) return;
      const text = JSON.stringify({
        type: 'room',
        payload: { roomId: roomId, room: this._view(room, ctx.playerId) }
      });
      this._push(client, text);
    });

    // 全员离开且无人连接 → 回收
    if (room.players.every(function (p) { return p.left; }) && !this._anyLiveConn(roomId)) {
      this._deleteRoom(roomId);
    }
  }

  /**
   * 推进 AI：准备 + 出牌。
   * 每次只做一个动作就重新判断状态（提交可能触发结算、进入下一轮或下一把），
   * 用 guard 防止异常情况下死循环。
   */
  _autoBots(room) {
    let guard = 0;
    let changed = false;
    while (guard++ < 16) {
      let acted = false;

      if (room.phase === SM.PHASE.WAITING) {
        room.players.forEach((p) => {
          if (p.isBot && !p.left && !p.ready) { p.ready = true; acted = true; }
        });
      }

      if (room.phase === SM.PHASE.ROUND1_SPLIT || room.phase === SM.PHASE.ROUND2_SPLIT) {
        const round = room.round;
        for (let i = 0; i < room.players.length; i++) {
          const p = room.players[i];
          if (!p.isBot || p.left) continue;
          if (p.submitted['round' + round]) continue;
          const groups = AI.decide(p.hand, round);
          const r = SM.submitGroups(room, p.id, groups);
          if (!r.ok) {
            // 兜底：AI 分组异常时让这台机器按「弃局」处理，走正常的减员流程，
            // 绝不能把整局卡在「等 AI 提交」上。
            this.log('bot submit failed, mark left', p.id, r.error);
            try { SM.leaveRoom(room, p.id); } catch (e) {}
            acted = true;
            break;
          }
          acted = true;
          break; // 状态已变，回到循环顶部重新判断阶段
        }
      }

      if (!acted) break;
      changed = true;
    }
    return changed;
  }

  /* 结算落档：同一房间同一场次只记一次（handSeq 是稳定身份）
   *
   * 口径（重要，改之前先想清楚）：
   *   以前是 `if (p.left || p.isBot) return;` —— 中途离开的人**本场不落库**。
   *   于是「输定了就点离开房间」等于免罚：排行榜净胜、最长连胜都能这么刷。
   *   现在改成**按离开时的分数照记**：离开只是退出对局，不抹掉已经打完的部分。
   *   弃局者的分数在 SM.leaveRoom 那一刻就冻结了（结算只对 activePlayers 加减分），
   *   所以这里取到的 score 正好就是「他离开时桌面上那个分数」，不需要额外快照。
   *
   * 为什么不是「记成一场输」：那会冤枉网络掉线的人——他可能正赢着。
   * 为什么不是「记 0 分」：0 分等于没输没赢，仍然是免罚，别人照样能靠它洗掉连败。
   */
  _persistSettlement(room) {
    if (room.phase !== SM.PHASE.SETTLED) return;
    if (room._profiledSeq === room.handSeq) return;
    room._profiledSeq = room.handSeq;

    /* ★ 作废的一把不落库。
     *
     * 判据是「这一局有没有真的加减过分」，不是「是不是被结束的」——
     * 分数**每一轮结算就在加减**，一局可能已经打了好几把，那些分是真赢真输的。
     *   · 一轮都没动过分 → 什么都没发生 → 作废，不写档案。
     *     挡的是最荒唐的情形：两个人开局、对手手机没电掉线，留下的人
     *     档案里就多一场「净胜 0」的平局：场次 +1、胜率被稀释、连胜被清成 0。
     *   · 打过任何一轮 → 照当前分数落库（和正常结算同一套算法）。
     *     这种情况作废等于把玩家已经打出来的战绩抹掉，比原来更糟。
     * 幂等标记照设：这一把就算过去了，不要每次广播都重新判断一遍。
     *
     * room.voided 由 SM.markSettled() 统一写 —— 那是三条结束路径（打满局数 /
     * 人数不足 / 结束本局）唯一的收口。**不要在这里自己再算一遍**：
     * 以前就是这样，导致「有人掉线」那条路上 voided 恒为 false，守卫等于没有。
     */
    if (room.voided) return;

    const endedAt = room.settledAt || Date.now();
    /* 人数与结束原因要跟着流水一起落库：战绩页每行都要显示它们，
     * 而战绩页现在读的就是这份档案（不再读本机记录）。
     * endReason 的口径与前端 endReasonOf 保持一致：状态机没给就按解散算。 */
    /* hasBot：本把有没有 AI 参与。由状态机维护（开局快照 + 结算时并集，
     * 见 SM.startGame / startNextRound / markSettled），这里只读。
     * 口径由用户定：**含 AI 的对局不计入战绩、不影响积分与排行榜**，
     * 只进 player.aiRecent 供战绩页标注。所以它必须跟着 meta 一起落到 record。 */
    const hasBot = !!room.handHadBot || room.players.some(function (p) { return !!p.isBot; });
    const meta = {
      playerCount: room.players.length,
      hasBot: hasBot,
      endReason: (room.endReason === 'scoreZero' || room.endReason === 'someoneLeft'
        || room.endReason === 'dissolve' || room.endReason === 'handLimit')
        ? room.endReason : 'dissolve',
      /* 成就增量：状态机每轮结算时按**玩家**分桶累加在 room.achRun 上
       * （见 SM.settleRound → Ach.accumulate）。它是整局累计，
       * 所以只能在这里一次性合并 —— 每把合并会让同一份桶被重复计入。
       * 取不到（这一局没人拿大牌型、或老客户端没加载成就模块）就是 null，
       * record 会跳过成就部分，战绩照记。 */
      ach: null,
      /* 建房时选的把数：判「打满 30 把」这类成就用（R8 人间清醒）。
       * 不传的话 record 里 Number(undefined) 得 0，那条成就永远拿不到。 */
      handLimit: Number(room.handLimit) || 0
    };
    const achRun = room.achRun;
    room.players.forEach((p) => {
      if (p.isBot) return;                       // AI 不进人类档案
      /* 账号已被删除的人不能再落任何记录：profiles.record 内部会 ensure()，
       * 把一个刚被「删除账号」的人原地复活成一条没有账号的幽灵档案，
       * 它会带着这场战绩永久留在排行榜上。 */
      if (!this.profiles.accountOf(p.id)) return;
      const net = (Number(p.score) || 0) - CONFIG.INITIAL_SCORE;
      /* 每人取自己那一桶。取不到就传 null —— **绝不能传整个 achRun**：
       * 那会把别人的牌型记到这个人头上（第一版就是这么错的，
       * 两人局的端到端测试直接量出来了）。 */
      const one = (achRun && achRun.byPid) ? { ach: achRun.byPid[String(p.id)] || null } : {};
      this.profiles.record(p.id, p.nickname, net, endedAt, room.roomId, room.handSeq,
        Object.assign({}, meta, one));
    });
    /* 桶已经并进每个人的档案，清掉。不清的后果是下一局把这些数再加一遍：
     * 同一份 session 里连开两局，「牛魔王」直接翻倍。 */
    room.achRun = null;
  }

  /* ============================ 断线与回收 ============================ */

  /* 分牌超时：进入 SPLIT 阶段后，给「未提交、未弃权、在线」的真人挂倒计时。
   * 幂等：已存在同 key 的计时器就跳过，避免每次广播都重新计时。
   * key 带 round，翻轮后旧 key 自然失配（回调里校验 room.round，不符即丢弃）。 */
  _armSplitTimers(room) {
    if (room.phase !== SM.PHASE.ROUND1_SPLIT && room.phase !== SM.PHASE.ROUND2_SPLIT) return;
    const round = room.round;
    // 翻轮/新一把后，上一轮遗留的孤儿 timer 作废并清掉，避免在 Map 里堆积到超时才删
    this._clearStaleSplitTimers(room.roomId, round);
    room.players.forEach((p) => this._armOneSplitTimer(room, p, round, SPLIT_TIMEOUT_MS, true));
  }

  /**
   * 给单个玩家挂分牌倒计时。
   * @param {number} delayMs 本轮的时长（正常是 SPLIT_TIMEOUT_MS，重连补时限时会短一些）
   * @param {boolean} idempotent true = 已有同 key 计时器就不动
   */
  _armOneSplitTimer(room, p, round, delayMs, idempotent) {
    if (p.left || p.isBot) return;                       // 弃局者/AI 不挂
    /* ★ v105：判「定稿」不再只看 submitted。
     * 进入修改态的人 submitted 仍然是 true（旧分组还在），但他已经不是「已交」了 ——
     * 别人全提交时不会结算（见 SM.isRoundLocked），这时他必须**自己**有个倒计时，
     * 否则一边卡着全桌、一边没有任何人会来解。
     * 超时的语义也不同：有旧分组的人超时 = 放弃修改，按已交的那份算，不按弃权罚。 */
    if (SM.isRoundLocked(p, round)) return;              // 已定稿（含已弃权）不挂
    const key = room.roomId + '#' + round + '#' + p.id;
    if (idempotent && this.splitTimers.has(key)) return; // 幂等
    if (this.splitTimers.has(key)) {
      clearTimeout(this.splitTimers.get(key));
      this.splitTimers.delete(key);
    }
    const timer = setTimeout(() => {
      this.splitTimers.delete(key);
      this.splitStartedAt.delete(key);
      const cur = this.rooms.get(room.roomId);
      if (!cur) return;
      if (cur.round !== round) return;                   // 已翻轮，本计时器作废
      if (cur.phase !== SM.PHASE.ROUND1_SPLIT && cur.phase !== SM.PHASE.ROUND2_SPLIT) return;
      const q = SM.findPlayer(cur, p.id);
      if (!q || q.left || q.connected === false) return; // 已离场/断线（断线走 grace）
      if (SM.isRoundLocked(q, round)) return;            // 已定稿（含「取消修改」后恢复定稿的）
      /* 注意「正在改」的人会走到下面这一句。forfeitRound 内部认这个状态：
       * 有旧分组 → 只放弃修改（按旧分组算），没交过 → 才真弃权。别在这里提前 return。 */
      this.log('split timeout, forfeit round', room.roomId, p.id, round);
      const res = SM.forfeitRound(cur, p.id);
      if (res.ok) this._broadcast(room.roomId);
    }, delayMs);
    if (timer.unref) timer.unref();
    this.splitTimers.set(key, timer);
    /* 起点不是「现在」，而是按本轮实际时长反推出来的：
     * 正常情况 delayMs === SPLIT_TIMEOUT_MS，反推结果就等于 now；
     * 但重连补时限时 delayMs 只有 MIN_RECONNECT_SPLIT_MS（生产是 15 秒），
     * 若仍把 now 记成起点，那么 startedAt + SPLIT_TIMEOUT_MS 会比**真实截止晚 45 秒**。
     * 这个值原本没人读，所以一直没人发现；现在它要下发给前端算倒计时，
     * 不改的话玩家会看到「还剩 45 秒」然后当场被判弃权。 */
    this.splitStartedAt.set(key, Date.now() + delayMs - SPLIT_TIMEOUT_MS);
  }

  /**
   * 重连补时限（P2-11）。
   *
   * 分牌计时器是**幂等**的——从「首次进入分牌阶段」起算，之后谁重连都不重置。
   * 好处是不会被「连接抖一下就重新计时」拖住，坏处是：第 59 秒才连回来的人
   * 只剩 1 秒就会被判弃权，看起来像「一进来就输分」。
   * 所以重连成功后，若剩余时间不足 MIN_RECONNECT_SPLIT_MS，就把他的计时器
   * 续到该下限——只补自己这一个 key，不影响别人的倒计时。
   */
  _refreshSplitDeadline(roomId, playerId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    if (room.phase !== SM.PHASE.ROUND1_SPLIT && room.phase !== SM.PHASE.ROUND2_SPLIT) return;
    const round = room.round;
    const key = roomId + '#' + round + '#' + playerId;
    if (!this.splitTimers.has(key)) return;              // 已提交/机器人，没有计时器
    const startedAt = this.splitStartedAt.get(key) || 0;
    const remain = startedAt + SPLIT_TIMEOUT_MS - Date.now();
    if (remain >= MIN_RECONNECT_SPLIT_MS) return;        // 时间还够，不干预
    const p = SM.findPlayer(room, playerId);
    if (!p) return;
    this._armOneSplitTimer(room, p, round, MIN_RECONNECT_SPLIT_MS, false);
    this.log('split deadline refreshed on reconnect', roomId, playerId, Math.round(remain));
  }

  _clearSplitTimers(roomId) {
    const prefix = roomId + '#';
    this.splitTimers.forEach((_t, key) => {
      if (key.indexOf(prefix) === 0) {
        clearTimeout(_t);
        this.splitTimers.delete(key);
        this.splitStartedAt.delete(key);
      }
    });
  }

  /* 清掉「不是当前 round」的孤儿 timer（翻轮/下一把后旧 round 的计时器已无意义） */
  _clearStaleSplitTimers(roomId, curRound) {
    const prefix = roomId + '#' + curRound + '#';
    this.splitTimers.forEach((_t, key) => {
      if (key.indexOf(roomId + '#') === 0 && key.indexOf(prefix) !== 0) {
        clearTimeout(_t);
        this.splitTimers.delete(key);
        this.splitStartedAt.delete(key);   // 起始时刻表跟着一起清，别留孤儿
      }
    });
  }

  /* 摘掉某个人的分牌倒计时（提交 / 定稿时用）。
   * 与 _clearStaleSplitTimers 的分工：那个按轮次批量清，这个只清一个人。 */
  _dropSplitTimer(roomId, round, playerId) {
    const key = roomId + '#' + round + '#' + playerId;
    if (this.splitTimers.has(key)) {
      clearTimeout(this.splitTimers.get(key));
      this.splitTimers.delete(key);
    }
    this.splitStartedAt.delete(key);
  }

  _startGrace(roomId, playerId) {
    const key = roomId + '#' + playerId;
    this._clearGrace(roomId, playerId);
    const timer = setTimeout(() => {
      this.graceTimers.delete(key);
      const room = this.rooms.get(roomId);
      if (!room) return;
      const p = SM.findPlayer(room, playerId);
      if (!p || p.connected || p.left) return; // 期间已回来
      const res = SM.finalizeLeave(room, playerId);
      if (res && res.deleted) { this._deleteRoom(roomId); return; }
      this._broadcast(roomId);
    }, GRACE_MS);
    if (timer.unref) timer.unref();
    this.graceTimers.set(key, timer);
  }

  _clearGrace(roomId, playerId) {
    const key = roomId + '#' + playerId;
    const t = this.graceTimers.get(key);
    if (t) { clearTimeout(t); this.graceTimers.delete(key); }
  }

  _armRoomRecycle(roomId) {
    const old = this.roomTimers.get(roomId);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      this.roomTimers.delete(roomId);
      if (!this._anyLiveConn(roomId)) {
        this.log('room recycled (idle)', roomId);
        this._deleteRoom(roomId);
      }
    }, ROOM_IDLE_MS);
    if (timer.unref) timer.unref();
    this.roomTimers.set(roomId, timer);
  }

  _deleteRoom(roomId) {
    this.rooms.delete(roomId);
    /* 少了一张桌子是「立刻要落盘」的变化：等到去抖窗口过去再崩，
     * 重启后这张已经解散的桌子会复活。 */
    this._saveStateNow();
    this._tokens.forEach((_v, key) => { if (key.indexOf(roomId + '#') === 0) this._tokens.delete(key); });
    this._clearSplitTimers(roomId);
    this._clearDissolve(roomId);
    /* 断线宽限 timer 也要清。以前漏了：房间删掉后 90 秒里那些 timer 还会醒来，
     * 拿着已经不存在的房间去跑 finalizeLeave（回调里虽然有 `if (!room) return` 兜底，
     * 但在 Map 里白挂 90 秒、每删一个房间就多几条僵尸 timer，属于慢性泄漏）。 */
    this.graceTimers.forEach((_t, key) => {
      if (key.indexOf(roomId + '#') === 0) { clearTimeout(_t); this.graceTimers.delete(key); }
    });
    const t = this.roomTimers.get(roomId);
    if (t) { clearTimeout(t); this.roomTimers.delete(roomId); }
    // 通知该房间残留连接
    const text = JSON.stringify({ type: 'roomDeleted', payload: { roomId: roomId } });
    this.conns.forEach((ctx, client) => {
      if (ctx.roomId === roomId) {
        ctx.roomId = null;
        this._push(client, text);
      }
    });
  }

  /* ============================ 工具 ============================ */

  _push(client, data) {
    if (!client || !client.alive) return;
    client.send(typeof data === 'string' ? data : JSON.stringify(data));
  }

  _ok(client, reqId, payload) {
    this._push(client, { type: 'ok', reqId: reqId, payload: payload || {} });
  }

  _fail(client, reqId, error) {
    this._push(client, { type: 'error', reqId: reqId, payload: { error: String(error || '请求失败') } });
  }

  _bind(client, playerId, nickname, roomId) {
    this.conns.set(client, { playerId: playerId, nickname: nickname, roomId: roomId });
    this.byPlayer.set(playerId, client);
  }

  _detachFromRoom(client) {
    const ctx = this.conns.get(client);
    if (!ctx || !ctx.roomId) return;
    const roomId = ctx.roomId;
    const room = this.rooms.get(roomId);
    ctx.roomId = null;
    if (!room) return;
    if (!this._hasLiveConn(ctx.playerId, roomId)) {
      const res = SM.leaveRoom(room, ctx.playerId);
      if (res.deleted) { this._deleteRoom(roomId); return; }
    }
    this._broadcast(roomId);
  }

  _requireRoom(client, reqId) {
    const ctx = this.conns.get(client);
    if (!ctx || !ctx.roomId) { this._fail(client, reqId, '你不在房间中'); return null; }
    const room = this.rooms.get(ctx.roomId);
    if (!room) { this._fail(client, reqId, '房间已结束'); return null; }
    if (!SM.findPlayer(room, ctx.playerId)) { this._fail(client, reqId, '你不在该房间'); return null; }
    return { room: room, playerId: ctx.playerId, roomId: ctx.roomId };
  }

  _hasLiveConn(playerId, roomId) {
    let hit = false;
    this.conns.forEach((ctx) => {
      if (ctx.playerId === playerId && ctx.roomId === roomId) hit = true;
    });
    return hit;
  }

  _anyLiveConn(roomId) {
    let hit = false;
    this.conns.forEach((ctx) => { if (ctx.roomId === roomId) hit = true; });
    return hit;
  }

  _checkCapacity() {
    return this.rooms.size < 5000; // 单进程保护，防止异常膨胀
  }

  _genRoomId() {
    for (let i = 0; i < 300; i++) {
      const id = String(Math.floor(100000 + Math.random() * 900000));
      if (!this.rooms.has(id)) return id;
    }
    // 极端拥挤时线性找空号
    for (let n = 100000; n <= 999999; n++) {
      const id = String(n);
      if (!this.rooms.has(id)) return id;
    }
    throw new Error('房间号已耗尽');
  }

  stats() {
    /* ★ `conns` 是**连接数**，不是在线人数。
     *
     * 移动端切后台、进程被杀、地铁进隧道这些都不发 FIN，一条僵尸连接能挂很久。
     * 发布前的实测就是这样：`rooms: 3, conns: 9`，进程重启后 0/0 ——
     * 那 9 条全是僵尸，一个活人都没有。所以运维看板不能只看 conns。
     *
     * `online` 是「真的坐在房间里、没弃局、连接还在」的**去重真人**数，
     * 这才是回答「现在有没有人在玩」的那个数。AI 不算。 */
    let online = 0;
    const seen = new Set();
    this.rooms.forEach((room) => {
      (room.players || []).forEach((p) => {
        if (!p || p.isBot || p.left || p.connected === false) return;
        if (seen.has(p.id)) return;
        seen.add(p.id);
        online += 1;
      });
    });
    return { rooms: this.rooms.size, conns: this.conns.size, online: online };
  }
}

module.exports = { Hub, GRACE_MS };
