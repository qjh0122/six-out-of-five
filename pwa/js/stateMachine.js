/**
 * 房间状态机（纯逻辑，无持久化）
 *
 * 起点是策划文档 5.1 节，但**实现已经偏离了不少**（结算后的报名制、结束本局、
 * 弃权、宽限判弃都是后来加的）。两边不一致时以本文件的规则和测试为准，
 * 文档只作历史参考 —— 别拿它当行为依据。
 *
 *   WAITING → ROUND1_SPLIT(发牌后) → ROUND1_SETTLE(结算) → ROUND2_SPLIT → ROUND2_SETTLE
 *       → 第一轮打完 → 第二轮 ｜ 第二轮打完 → 下一把(重新发牌, 分数延续)
 *       → **打到建房时选定的把数上限才进 SETTLED**（endReason='handLimit'），
 *         上限存在 room.handLimit 上，续局沿用、房间内不可改。
 *       → ★ v103 起「有人分数 ≤0」**不再结束游戏**。分数可以跌成负数，人继续打，
 *         终局只认局数。理由：当时的 20 分本金扛不住几把（每把最坏 −17），
 *         不删这条，5/10/15/30 档全都会被爆分抢先截断，玩家选的局数等于没选。
 *         v106 把基准分改成 0 之后，这条规则更是**只剩下局数一个终局条件** ——
 *         没有「见底」可言了（详见 config.js 的 INITIAL_SCORE 注释）。
 *         异常终局只剩两种：在场人数 < MIN_PLAYERS（someoneLeft）、房主解散（dissolve）。
 *       → SETTLED 后**不再有房主一键开局**：每人各自点「开始下一局」报名，
 *         在房间页各自准备，全部报名者准备好就自动开下一局（分数重置 20 → ROUND1_SPLIT）。
 *         没报名的人不参与下一局，也不会挡住别人；报名可以撤回（unWantNext）。
 *       → 中途有人提请「结束本局」且全员同意 → 同样进 SETTLED。若这一局一分没打，
 *         标 voided（不写任何档案），打过分则按当前分数照记。
 *
 * 开局条件（两种）都是「全员准备」，没有房主特权：
 *   WAITING 里全员准备 → startGame ｜ SETTLED 里全员报名且都准备 → startNextRound
 *
 * 依赖：Card（发牌）、Engine（结算）、CONFIG（数值）。
 */
(function (global, factory) {
  var Card = (typeof require === 'function') ? require('./card.js') : global.Card;
  var Engine = (typeof require === 'function') ? require('./engine.js') : global.Engine;
  var CONFIG = (typeof require === 'function')
    ? require('./config.js')
    : (typeof global !== 'undefined' && global.CONFIG ? global.CONFIG : Engine.CONFIG);
  var mod = factory(Card, Engine, CONFIG);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = mod;
  } else {
    global.StateMachine = mod;
  }
})(typeof self !== 'undefined' ? self : this, function (Card, Engine, CONFIG) {
  'use strict';

  var PHASE = {
    WAITING: 'WAITING',          // 等待中（可加入/准备）
    ROUND1_SPLIT: 'ROUND1_SPLIT', // 第一轮分牌
    ROUND1_SETTLE: 'ROUND1_SETTLE', // 第一轮结算
    ROUND2_SPLIT: 'ROUND2_SPLIT', // 第二轮分牌
    ROUND2_SETTLE: 'ROUND2_SETTLE', // 第二轮结算
    SETTLED: 'SETTLED'           // 结账（有人输完）
  };

  var GROUP_LABEL = {
    single: '单张比大小',
    tenhalf: '十点半',
    piaosanye: '飘三叶',
    douniu: '斗牛'
  };

  var ROUND_GROUPS = {
    1: ['single', 'tenhalf', 'piaosanye'],
    2: ['single', 'douniu']
  };

  var GROUP_COUNT = {
    single: 1, tenhalf: 2, piaosanye: 3, douniu: 5
  };

  function findPlayer(room, playerId) {
    for (var i = 0; i < room.players.length; i++) {
      if (room.players[i].id === playerId) return room.players[i];
    }
    return null;
  }

  function activePlayers(room) {
    return room.players.filter(function (p) { return !p.left; });
  }

  /* 这个房间自己的人数上限。
   * 读 room.cap 而不是 CONFIG.MAX_PLAYERS：上限是可以改小的（8 → 5），
   * 但线上正在进行的房间必须按它建的时候那一档走完，
   * 否则第 5 个人之后的座位会在渲染时消失（slotCount 变小、人还在 players 里）。
   * room.cap 缺失时（老数据 / 反序列化后）退回当前配置。 */
  function capOf(room) {
    return (room && room.cap) || CONFIG.MAX_PLAYERS;
  }

  /* 本局把数（"局数"）的白名单档位。前后端同源，别在两处各写一份。 */
  function handLimitOptions() {
    return (CONFIG.HAND_LIMITS && CONFIG.HAND_LIMITS.length)
      ? CONFIG.HAND_LIMITS
      : [3, 5, 10, 15, 30];
  }

  /* 客户端送进来的档位收敛成白名单里的一个值。
   *   · 缺省 / null / '' / 'abc' / 7 这类脏值 → 默认 10，**不报错**：
   *     建房不该因为一个下拉框把人挡在门外，但也绝不能因为脏参数
   *     让房间变成"永不结束"（那比报错更难查）。
   *   · '15' 这种字符串照收 —— 表单控件送过来的就是字符串。 */
  function normalizeHandLimit(v) {
    var def = CONFIG.DEFAULT_HAND_LIMIT || 10;
    var n = Number(v);
    if (!isFinite(n) || Math.floor(n) !== n) return def;
    return handLimitOptions().indexOf(n) >= 0 ? n : def;
  }

  /* 这个房间自己的把数上限。
   * 和 capOf 同一个道理：读 room.handLimit 而不是 CONFIG —— 老房间（本地缓存里的、
   * 或上线前建的）没有这个字段时回落到默认 10，不能让它当场"永远打不完"。
   *
   * ★ v103 去掉了「0 = 不设上限 → Infinity」这条回滚分支。
   *   删掉爆分终止之后，Infinity 不再等于"回到老行为"，而是**永不结束**：
   *   分数可以无限为负，没有任何东西会让 phase 变成 SETTLED。
   *   所以 0 / 负数 / NaN 现在一律回落默认档 —— 宁可多打十把，也不能让房间
   *   卡在一个永远打不完的状态里（那种 bug 玩家只能杀进程）。
   *   回滚的正确做法是 git revert，不是一个神奇参数。 */
  function handLimitOf(room) {
    var v = room && room.handLimit;
    if (typeof v === 'number' && isFinite(v) && v > 0) return v;
    return normalizeHandLimit(null);
  }

  /* 房间页的座位表 = 在场的人。
   *
   * 单独抽出来是因为 `room.players` 和「座位上坐着谁」在这两个阶段含义不同：
   *   · WAITING：离开的人直接从这个数组里删掉，两者等价；
   *   · SETTLED：离开只置 left=true（分数还要参与结算），人**还留在数组里**。
   * 于是直接拿 room.players 当座位表会出两个错：
   *   1) 已经走了的人仍占着一个座位 —— 界面在说谎；
   *   2) 满 8 人时有人离开、又进来一个新人，players 变成 9，
   *      而格子只有 MAX_PLAYERS=8 个 —— 第 9 个（往往正是刚进来的那个新人）
   *      根本画不出来，他自己在房间里看不到自己的座位。
   * 座位表只认「在场」，人名单（分数、结算）才认「全部」。 */
  function roomSeats(room) {
    return room ? activePlayers(room) : [];
  }

  /*
   * 房主不在场时把所有权交出去。
   *
   * 开局本身已经不看房主（全员准备即开），但**补 AI**、以及对外的房主标识
   * 还挂在 ownerId 上；ownerId 指向一个已经离开的人时，房间就没人能补 AI，
   * 少人局只能干等。优先交给在场真人，没有真人再交给任意在场者
   * （AI 至少不会让界面卡住）。
   */
  function ensureLiveOwner(room) {
    if (!room) return false;
    var cur = findPlayer(room, room.ownerId);
    if (cur && !cur.left) return false;      // 原房主还在，不动
    var pool = activePlayers(room);
    if (!pool.length) return false;          // 一个人都不剩，交给回收流程
    var humans = pool.filter(function (p) { return !p.isBot; });
    var next = humans.length ? humans[0] : pool[0];
    if (!next || next.id === room.ownerId) return false;
    room.ownerId = next.id;
    room.updatedAt = Date.now();
    return true;
  }

  function freshGroups() {    return {
      round1: { single: [], tenhalf: [], piaosanye: [] },
      round2: { single: [], douniu: [] }
    };
  }

  /* 发牌：一副 52 张洗牌，每人 6 张（left 玩家不参与发牌） */
  function dealAll(room) {
    /* ★ 发牌 = 一把的起点，这里给这一把分一个永不重复的号。
     * 三个起手路径（开局 / 自动连下一把 / 结算页「开下一把」）都走这里，
     * 所以它是唯一的计数点。handCount 会在重启时归 1，不能当身份。 */
    room.handId = (room.handId || 0) + 1;
    var deck = Card.createDeck();
    Card.shuffle(deck);
    room.players.forEach(function (p) {
      if (p.left) { p.hand = []; return; }
      p.hand = deck.splice(0, CONFIG.CARDS_PER_PLAYER);
      p.groups = freshGroups();
      p.submitted = { round1: false, round2: false };
      p.resubmits = { round1: 0, round2: 0 };  // 本轮已改过几次（限 1 次）
      p.revising = null;      // 正在改的轮次号（见 beginRevise）；null = 没有在改
      p.forfeitRound = null;  // 新一把重新可玩，清掉上一把的弃权标记
      /* ★ v103 起没有任何路径会把 out 置为 true（「见底出局」这条规则已删除）。
       * 这里留着是为了**老记录**：回放两个月前的对局时，那个 true 还得读得出来，
       * 也得在开下一把时清掉，否则老局回放会把「上把出局」带到新的这一把上。
       * 新局恒为 false —— 谁要是又在别处把它设成 true，那就是规则被加回来了。 */
      p.out = false;
    });
  }

  /* opts.handLimit：建房时选的本局局数（把数上限）。只在这一刻可定，
   * 进房之后任何人都改不了 —— 结束契约一旦可变，等于没有契约。 */
  function newRoom(roomId, owner, opts) {
    var now = Date.now();
    owner.ready = false;
    owner.left = false;
    owner.connected = true;       // 在线状态（断线健壮性）
    owner.disconnectedAt = null;  // 断线时间戳（用于宽限判定）
    owner.leftAtRound = null;     // 判弃时所在的轮次（重连时校验手牌是否还有效）
    owner.score = CONFIG.INITIAL_SCORE;
    owner.hand = [];
    owner.groups = freshGroups();
    owner.submitted = { round1: false, round2: false };
    owner.resubmits = { round1: 0, round2: 0 };  // 本轮已改过几次（限 1 次）
    owner.revising = null;      // 正在改的轮次号（见 beginRevise）
    owner.wantNext = false;     // 报名下一局（见 wantNext）
    owner.joinedLate = false;   // 是不是「结算期才进来、没打上一局」的人
    owner.out = false;          // ★ v103 起恒为 false（不再有见底出局），字段只为老回放兼容保留
    return {
      roomId: roomId,
      ownerId: owner.id,
      /* 建房时把「当时的人数上限」抄进房间。
       * 之后 MAX_PLAYERS 再改（8 → 5），老房间不受影响：它按自己建的时候那一档继续。
       * 不写这一行会有两种事故，任选一种：老 8 人房被新上限卡住、或者
       * 6~8 号座位在渲染时直接消失（slotCount 变小、人还在 players 里）。 */
      cap: CONFIG.MAX_PLAYERS,
      /* 本局最多打几把（一把 = 2 轮）。到顶即结账，**这是唯一的正常终局**
       * （v103 起；爆分不再能提前收手，只剩人数不足 / 中途解散两条异常收尾）。
       * 写在房间上而不是读 CONFIG：局数是**这一间房**的规则，
       * 也是「结算后继续游戏沿用同一档位」的唯一依据（续局只重置分数，
       * 不碰这个字段）。 */
      handLimit: normalizeHandLimit(opts && opts.handLimit),
      phase: PHASE.WAITING,
      round: 1,
      handCount: 1,
      /* 本房间第几场（每次进入结算 +1，永不重置）。handCount 会在开下一局时
       * 重置为 1，不能当作战绩身份（谁都能触发开下一局，不再是某一个人的动作）；
       * handSeq 才用于区分同一房间的不同场次。 */
      handSeq: 0,
      /* 本房间第几把（dealAll 递增，永不重置）。handCount 会回到 1，
       * handSeq 只在结算时 +1，都不能当「这一把」的身份。 */
      handId: 0,
      resultSeq: 0,
      players: [owner],
      results: { round1: null, round2: null },
      lastResult: null,
      /* 逐轮回放（P3-7）。results 只保留"当前这一把"，下一把 dealAll 会覆盖，
       * 所以每轮结算时先收进 history。保留 4 条 ≈ 最近两把，够回看"刚才那把怎么输的"。
       * 只存 id / nickname / hand 三样，不存 entries 里的中间判定过程 ——
       * 这些数据每次广播都会随 _view 下发，留全量会把推送撑大一倍。 */
      history: [],
      /* 结账原因：'handLimit'(打满局数) / 'someoneLeft'(人数不足) / 'dissolve'(中途解散)。
       * 老记录里还可能出现 'scoreZero'（v103 前的「有人见底」）——
       * 只用于历史战绩与回放展示，新局永远不会再产生这个值。 */
      endReason: null,
      /* 本局出局的人。★ v103 起恒为空数组：不再有「见底出局」这回事，
       * 字段只为老记录回放兼容而保留（老局里可能真有值）。 */
      bustedIds: [],
      groupsDone: 0,              // 最近一次结算算完的组数（v103 起恒等于本轮组总数）
      /* 这一把作废：一分没打就结束出来的结算不进任何档案。
       * 注意判据是「有没有分数变化」，不是「是不是被解散的」——
       * 一局可能已经打了好几把，那些分是真赢真输的，作废等于抹掉战绩。
       * 见 finishDissolve 里的说明。 */
      voided: false,
      /* 这一局有没有真的加减过分（settleRound 里置真，开局归零）。
       * 结算时用它算 voided —— 比「分数是否都回到 20」准，
       * 后者会把「先赢 1 分又输 1 分」这种真打完的局误判成没打。 */
      anyScoreChange: false,
      settledAt: null,            // 进入 SETTLED 的时刻（一次性写入，本机战绩幂等键用）
      dissolve: { active: false, initiatorId: null, startedAt: 0, votes: {},
                  lastReason: null, lastAt: 0 }, // 解散投票（lastReason: rejected/cancelled/expired）
      createdAt: now,
      updatedAt: now
    };
  }

  /* 加入房间
   *
   * ★ 只有两个窗口能进：还没开打（WAITING），和**上一局结算完、下一局还没开**（SETTLED）。
   *
   * 结算期必须放行 —— 否则这个房间从第一局打完起就**再也进不来人**：
   *   开局后 phase 一路在 ROUND1/2_SPLIT → SETTLED 之间来回，
   *   除了 newRoom 那一刻，**再也没有任何地方把 phase 写回 WAITING**。
   *   于是「打牌中」被拒、「结算中」也被拒，朋友实际上是被永久锁在门外
   *   （真机上就是这么被报回来的：房主点了「开始下一局」在房间里等人，朋友进不来）。
   *
   * 结算期进来的人，语义是「我是来打下一局的」：
   *   · wantNext = true —— 不带这个标记，startNextRound 的 `room.players = joiners`
   *     会把他**静默丢掉**（他明明在房间里，新一局开始时却凭空消失）；
   *   · ready 仍是 false —— 还是要自己点一次「准备」，和所有人一样，
   *     不替他做「我准备好了」这个决定；
   *   · joinedLate = true —— 他没打上一局：前端据此不弹上一局结算、分数不写成「上局」。
   */
  function joinRoom(room, player) {
    if (!room) return { ok: false, error: '房间不存在' };
    var settling = room.phase === PHASE.SETTLED;
    if (room.phase !== PHASE.WAITING && !settling) {
      return { ok: false, code: 'ROOM_PLAYING', error: '这局正在打，等这局结束再进来' };
    }
    if (activePlayers(room).length >= capOf(room)) {
      return { ok: false, error: '房间已满（最多 ' + capOf(room) + ' 人）' };
    }

    var existing = findPlayer(room, player.id);
    if (existing && !existing.left) return { ok: true, room: room }; // 已加入，幂等

    /* 结算期里「中途离开过」的人还能回来：上面那个幂等分支只认 left=false，
     * 而 left 的人如果只走「新建」路径，会拿到一个已经存在的座位对象 ——
     * 状态还是 left，之后点什么都回「你已经离开这一局了」，等于卡死在房间里。 */
    var p = existing || player;
    /* joinedLate 只对「结算期第一次进来」的人成立。
     * 中途离开过、又在结算期回来的老玩家**打过上一局**（分数已经被结算改过），
     * 不能把他当成新人：否则他会看不到上一局结算、座位上也看不到自己真正的分数。 */
    var isNewcomer = !existing;
    p.ready = false;
    p.wantNext = settling;
    p.joinedLate = settling && isNewcomer;
    p.left = false;
    p.connected = true;
    p.disconnectedAt = null;
    p.leftAtRound = null;
    /* ★ 分数只在「房间里的新面孔」身上初始化，不能无条件重置。
     * 旧实现无条件 `p.score = INITIAL_SCORE`，于是：中途离开时 7 分 → 结算期点回来变回基准分，
     * 结算页显示基准分，而档案里记的是「7 − 基准分」—— 玩家看到的账和排行榜的账对不上。
     * （基准分 v106 起是 0，所以症状从「显示 20、档案记 −13」变成「显示 0、档案记 +7」，
     *   不一致本身没有变，这条限制照样成立。）
     * 真正的「新一局分数归零」由 startNextRound 统一负责（它对全员重置），这里不需要代劳。 */
    if (isNewcomer || typeof p.score !== 'number' || !isFinite(p.score)) {
      p.score = CONFIG.INITIAL_SCORE;
    }
    p.hand = [];
    p.groups = freshGroups();
    p.submitted = { round1: false, round2: false };
    p.resubmits = { round1: 0, round2: 0 };  // 本轮已改过几次（限 1 次）
    p.revising = null;
    p.forfeitRound = null;
    p.out = false;   // 结算期进来的人不是「上把出局者」
    if (!existing) room.players.push(p);
    room.updatedAt = Date.now();
    return { ok: true, room: room };
  }

  /* 离开房间 */
  function leaveRoom(room, playerId) {
    if (!room) return { room: null, deleted: false };
    // 清理该玩家在解散投票中的票（避免残留脏数据）
    if (room.dissolve && room.dissolve.votes) {
      delete room.dissolve.votes[playerId];
    }
    if (room.phase === PHASE.WAITING) {
      room.players = room.players.filter(function (p) { return p.id !== playerId; });
      room.updatedAt = Date.now();
      if (room.players.length === 0) {
        return { room: null, deleted: true };
      }
      if (room.ownerId === playerId) {
        room.ownerId = room.players[0].id; // 房主转移
      }
      // 投票进行中且房间里已无玩家 → 作废
      if (room.dissolve && room.dissolve.active && room.players.length === 0) {
        room.dissolve.active = false;
        room.dissolve.initiatorId = null;
      }
      return { room: room, deleted: false };
    }
    // 对局中：视为弃局，分数冻结，本局后续结算不再参与
    var p = findPlayer(room, playerId);
    if (p) {
      p.left = true;
      p.ready = false;
      p.connected = false;
      /* 人都走了，别再留着「正在改」的标记 —— 它会让 isRoundLocked 一直判他未定稿，
       * 而 activePlayers 虽然已经排除 left，但删除账号/回收房间这类路径会复用这个对象。 */
      p.revising = null;
      room.updatedAt = Date.now();
    }
    // 人数不足（对局中）即结束本局，避免剩 1 人无限计分
    maybeEndGame(room);
    /* 走的人可能正是**最后一个没提交的**。剩下的人其实早已全部提交，
     * 但「全员提交 → 结算」这个判断是由提交的人触发的，而那个人已经走了：
     * 分牌超时只给「未提交且未离开」的人挂计时器，此时一个都不剩。
     * 不在这里补一刀，整桌会永久停在分牌阶段（实测复现过）。 */
    settleIfAllIn(room);
    // 投票进行中且剩余在场（未弃局）玩家为空 → 作废
    if (room.dissolve && room.dissolve.active && activePlayers(room).length === 0) {
      room.dissolve.active = false;
      room.dissolve.initiatorId = null;
    }
    // 走的人是房主时把所有权交给还在的人，否则房间里没人能补 AI
    ensureLiveOwner(room);
    return { room: room, deleted: false };
  }

  function setReady(room, playerId, ready) {
    if (!room) return { ok: false, error: '房间不存在' };
    var p = findPlayer(room, playerId);
    if (!p) return { ok: false, error: '你不在该房间' };
    /* 两个阶段可以准备：
     *   · WAITING      —— 房间首次开局前的准备
     *   · SETTLED+wantNext —— 结算期里已经点了「开始下一局」的人，在房间页的准备
     * 第二种是新增的：房间 phase 故意停在 SETTLED（否则没点的人结算页会被顶掉），
     * 但那些人已经在打下一局的准备流程里，不能拿「对局已开始」把他们挡住。 */
    var inNextRound = room.phase === PHASE.SETTLED && p.wantNext && !p.left;
    if (room.phase !== PHASE.WAITING && !inNextRound) {
      return {
        ok: false,
        error: room.phase === PHASE.SETTLED ? '先点「开始下一局」再准备' : '对局已开始'
      };
    }
    p.ready = !!ready;
    room.updatedAt = Date.now();
    return { ok: true, room: room };
  }

  function canStart(room) {
    if (!room || room.phase !== PHASE.WAITING) return false;
    var act = activePlayers(room);
    if (act.length < CONFIG.MIN_PLAYERS) return false;
    return act.every(function (p) { return p.ready; });
  }

  /* 房内改昵称：只改 player.nickname，广播后全员可见。
   * 长度校验由调用方（hub 的 cleanNickname）做，这里只做基本兜底。 */
  function rename(room, playerId, nickname) {
    if (!room) return { ok: false, error: '房间不存在' };
    var p = findPlayer(room, playerId);
    if (!p) return { ok: false, error: '你不在该房间' };
    if (p.left) return { ok: false, error: '已弃局' };
    var s = String(nickname == null ? '' : nickname).trim();
    if (!s) return { ok: false, error: '昵称不能为空' };
    p.nickname = s;
    room.updatedAt = Date.now();
    return { ok: true, room: room };
  }

  /* 首次开局（内部入口；对外由 autoStartIfReady 在全员准备时调用） */
  function startGame(room, ownerId) {
    if (!room) return { ok: false, error: '房间不存在' };
    if (room.dissolve && room.dissolve.active) return { ok: false, error: '结束本局的提议还在等大家表态' };
    ensureLiveOwner(room); // 房主已离开时先把所有权交给在场的人，否则下一轮没人能补 AI
    /* ownerId 只是**内部一致性约束**，不是产品规则：开局早已没有房主闸门，
     * 对外唯一的触发点是 autoStartIfReady（全员准备即开）。
     * 这里留着它，是防止有人绕过自动开局直接点名让别人开。
     * 看到的「只有房主可以开局」是开发者才会撞到的报错，正常玩不会出现。 */
    if (room.ownerId !== ownerId) return { ok: false, error: '只有房主可以开局' };
    if (!canStart(room)) return { ok: false, error: '需至少 ' + CONFIG.MIN_PLAYERS + ' 人且全部准备' };
    room.round = 1;
    room.handCount = 1;
    room.results = { round1: null, round2: null };
    room.lastResult = null;
    room.endReason = null;
    room.voided = false;    // 新一把重新可记
    room.anyScoreChange = false;
    room.bustedIds = [];    // 新一局没人出局（上一局的见底标记不能带过来）
    room.groupsDone = 0;
    /* 本把是否有人机参与 —— 结算落档的口径依据（含 AI 的局不计入战绩）。
     * 开局时按当前座位快照一次；中途补进来的 AI 由 hub.addBot 置 true。
     * 必须**每把重置**：上一把有人机不代表这一把也有，反之同理。 */
    room.handHadBot = room.players.some(function (p) { return !!p.isBot; });
    dealAll(room);
    room.phase = PHASE.ROUND1_SPLIT;
    room.updatedAt = Date.now();
    return { ok: true, room: room };
  }

  /* ==========================================================================
   * 草稿分组操作（纯函数）
   *
   * 分牌界面从「点牌选中 → 再够到顶部点空槽」改成「点牌直接落进当前组」之后，
   * 「放进哪一组」变成一段必须每点一次就跑的逻辑。放在这里而不是散在界面代码里：
   *   - 组名 / 每组张数 / 哪几组参与本轮，全在这里，界面不用重复抄一遍规则
   *   - 纯函数，可以在 Node 里直接测，不用起浏览器
   * 注意：这些只在本地草稿上用，服务端计分仍然只认 submitGroups 的那份数据。
   * ========================================================================== */

  /* ==========================================================================
   * 第一轮「十点半优先」—— 放牌时的规则检查
   *
   * 规则（用户 2026-10-30 确认）：
   *   · 第一轮的十点半组（2 张）必须优先做成**不爆**的组合；
   *   · 只要能不爆，就不许放会爆的组合；能凑 10.5 就优先凑 10.5
   *     （不要求刚好 10.5，只要不爆）；
   *   · 其余两组（比大小 / 飘三叶）不受这条约束，玩家自由搭配。
   *
   * 为什么必须在放牌时就查：engine 里爆点是**直接判负**的
   * （compareTenHalf：未爆 > 爆；双爆才比爆得少），而十点半组只有 2 张 ——
   * 任意两张和超过 10.5 就爆，这不是边缘情况，是分牌阶段最常见的失误。
   * 等提交后才在结算页告诉玩家「你这组 13 点」，已经输掉了这一组。
   *
   * 放在状态机而不是界面里：王（joker）在十点半里要**解析成某张牌**再算点数
   * （见 engine.resolveTenHalf），这套解析只在 engine 里有一份。界面再写一遍
   * 必然会和结算算法跑偏，而跑偏的后果是「提醒说 10.5，结算算成 11」。
   * ========================================================================== */
  var TENHALF_MAX_TENTHS = 105;   // 10.5 点 = 105 个十分之一

  /* 两张牌的点数（十分之一）与是否爆。王的最优解析由 engine 负责。 */
  function tenHalfPair(cards) {
    if (!cards || cards.length !== 2) return null;
    return { points: Engine.tenHalfTotal(cards), bust: Engine.tenHalfBust(cards) };
  }

  /* 在候选池里挑「最优的两张」：能不动就不爆（取点数最大的），全都爆就取爆得最少的。
   * 同点数不比花色 —— 这里回答的是「值不值得换」，不是「谁赢」。 */
  function bestTenHalfPair(pool) {
    var best = null;
    for (var i = 0; i < pool.length; i++) {
      for (var j = i + 1; j < pool.length; j++) {
        var cur = tenHalfPair([pool[i], pool[j]]);
        if (!cur) continue;
        var better = !best
          || (best.bust && !cur.bust)
          || (best.bust === cur.bust && (cur.bust ? cur.points < best.points : cur.points > best.points));
        if (better) best = { points: cur.points, bust: cur.bust, cards: [pool[i], pool[j]] };
      }
    }
    return best;
  }

  /* 十点半组的当前状态 + 是否违规。返回 null 表示「没什么要说的」。
   *
   * kind 只剩两种，都是「爆」，而且都只在**手里还留着不爆的选择**时出现：
   *   · 'must-bust' —— 刚放进去的那张，配手里任何一张都会爆，但换两张还能不爆；
   *   · 'bust'      —— 组已满且爆了，换一张（或换一对）就能不爆。
   *
   * ★ 判定口径（2026-10-30 与用户确认）：**存在不爆的打法、玩家却选了爆的**才提示。
   *   整手怎么配都爆 → 一个字都不说。那种局面提示也换不出更好的，
   *   说了只是告诉玩家「你运气差」，还挡住他看牌。
   *   不爆 → 同样不返回任何东西（'miss' 一档已删，见函数末尾）。 */
  function tenHalfAdvice(round, groups, hand) {
    if (round !== 1) return null;                       // 只有第一轮有十点半组
    var placed = (groups && groups.tenhalf) || [];
    if (!placed.length) return null;                    // 还没开始放，谈不上违规
    /* 传入的是「整手牌」，这里自己把已经放进十点半组的那张剔掉 ——
     * 让调用方去算「剩余手牌」是重复劳动，而且一旦漏了就变成「自己和自己配对」，
     * 提示会说「换 10♠ 能到 10.5」而那个 10♠ 就是玩家刚放下的那张。 */
    var used = {};
    for (var k = 0; k < placed.length; k++) used[placed[k].suit + '-' + placed[k].rank] = 1;
    var rest = (hand || []).filter(function (c) {
      return !used[c.suit + '-' + c.rank];
    });
    var pool = placed.concat(rest);
    if (pool.length < 2) return null;

    var best = bestTenHalfPair(pool);
    if (!best) return null;

    if (placed.length === 1) {
      /* 只放了一张时，正常挑第二张不该被打扰 —— 只有「配什么都不行」才提示。 */
      for (var i = 0; i < rest.length; i++) {
        var p = tenHalfPair([placed[0], rest[i]]);
        if (p && !p.bust) return null;
      }
      /* 配哪张都爆。但整手本身可能还有不爆的组合（这张放错了组）——那才值得说一句。
       * 整手怎么配都爆就闭嘴：他换也换不出更好的，提示只剩「你运气差」这层意思。 */
      if (best.bust) return null;
      return { kind: 'must-bust', points: null, bust: true, placed: placed.slice(), best: best };
    }

    var cur = tenHalfPair(placed);
    if (!cur) return null;

    if (cur.bust) {
      /* 有不爆的替换方案 → 这一组还有救，必须说（也就是用户要的那一种提示）；
       * 怎么换都爆 → 不说。曾经有一档 'worse-bust'（只能从 20 点降到 19 点），
       * 已删除：整手必爆时，把爆点从 20 修到 19 不改变胜负，只改变噪音。 */
      if (!best.bust) {
        return { kind: 'bust', points: cur.points, bust: true, placed: placed.slice(), best: best };
      }
      return null;
    }

    /* 没爆 → 一律不提示。
     *
     * 这一档原本有个 'miss'：组没爆，但手里能凑 10.5 却没凑，会说一句「能凑 10.5，用 X + Y」。
     * 它被撤掉了，理由是**那不叫纠错，叫替玩家打牌**：
     *
     *   · 第一轮三组是互相抢牌的。他把那张 10 留给飘三叶去凑豹子，
     *     十点半拿 9 点，总分可能比「十点半 10.5 + 飘三叶散牌」更高；
     *   · 「不爆」已经是被约束的底线，剩下的每一组点数是策略空间 ——
     *     一旦界面告诉你「这样能到 10.5」，竞技性就没了：每局的最优解由程序宣布。
     *
     * 所以只有一种情况值得打断玩家：**这一组已经会输**（爆点）。
     * 没爆就是合格，怎么摆是他的事。 */
    return null;
  }

  /* 从 fromKey 之后按顺序找第一个没填满的组；fromKey 为空则从头找。找不到返回 null */
  function nextOpenGroup(round, groups, fromKey) {
    var keys = ROUND_GROUPS[round];
    if (!keys) return null;
    var list = groups || {};
    var start = fromKey ? keys.indexOf(fromKey) : -1;
    for (var i = 1; i <= keys.length; i++) {
      var k = keys[(start + i) % keys.length];
      if ((list[k] || []).length < GROUP_COUNT[k]) return k;
    }
    return null;
  }

  /* 本轮是否已经全部填满 */
  function groupsFull(round, groups) {
    return nextOpenGroup(round, groups, null) === null;
  }

  /*
   * 把一张牌放进分组。
   * preferKey 指定目标组；该组已满则自动顺延到下一个没满的组（连点手牌时很顺手），
   * 全满返回 ok:false —— 不能让界面出现「点了没反应」。
   */
  function placeCard(round, groups, card, preferKey) {
    if (!card) return { ok: false, error: '没有这张牌' };
    var keys = ROUND_GROUPS[round];
    if (!keys) return { ok: false, error: '本轮没有分组' };
    var key = null;
    if (preferKey && keys.indexOf(preferKey) >= 0
      && (groups[preferKey] || []).length < GROUP_COUNT[preferKey]) {
      key = preferKey;
    } else {
      key = nextOpenGroup(round, groups, preferKey || null);
    }
    if (!key) return { ok: false, error: '都填满了，可以提交了' };
    groups[key] = (groups[key] || []).concat([card]);
    return { ok: true, key: key, full: groups[key].length >= GROUP_COUNT[key] };
  }

  /* 把某张牌从它所在的组里取回来（点槽里的牌 = 收回手牌） */
  function removeCard(round, groups, card) {
    if (!card) return { ok: false };
    var at = locateCard(groups, ROUND_GROUPS[round] || [], card);
    if (!at) return { ok: false };
    groups[at.key].splice(at.idx, 1);
    return { ok: true, key: at.key };
  }

  /* 在分组里定位一张牌 → { key, idx }；找不到返回 null。
   * 抽出来是因为「收回」和「交换」都要它，各写一遍迟早有一份少判一层。 */
  function locateCard(groups, keys, card) {
    if (!groups || !card) return null;
    for (var i = 0; i < keys.length; i++) {
      var arr = groups[keys[i]] || [];
      for (var j = 0; j < arr.length; j++) {
        if (arr[j] && arr[j].suit === card.suit && arr[j].rank === card.rank) {
          return { key: keys[i], idx: j };
        }
      }
    }
    return null;
  }

  /*
   * 交换两张牌的位置（拖动一张槽牌落到另一张槽牌上）。
   *
   * 为什么需要独立的原语：六张牌全部入组之后，三组都满了 ——
   * 这时候想把「单张」里那张和「飘三叶」里那张对调，用现有的
   * removeCard + placeCard 组合是做不到的：目标组满，placeCard 直接拒绝。
   * 玩家只能「先收回一张到手牌 → 把另一张挪到空位 → 再把手里那张放回最后一个空位」，
   * 三步，而且中间那步会让牌区出现肉眼可见的空洞。
   *
   * 交换**不需要任何容量校验**：两组的张数一进一出，交换前后完全相等。
   * 所以这里只要确认两张牌真的在不同组里、且都找得到。
   * 同组内交换直接拒绝 —— 组内顺序不参与任何结算，换了等于没换，
   * 悄悄当成成功会让人以为自己调整了什么。
   */
  function swapCards(round, groups, a, b) {
    if (!a || !b) return { ok: false, error: '缺少牌' };
    if (a.suit === b.suit && a.rank === b.rank) return { ok: false, error: '这是同一张牌' };
    var keys = ROUND_GROUPS[round] || [];
    var at = locateCard(groups, keys, a);
    var bt = locateCard(groups, keys, b);
    if (!at || !bt) return { ok: false, error: '牌不在分组里' };
    if (at.key === bt.key) return { ok: false, error: '同一组内交换没有意义' };
    groups[at.key][at.idx] = b;
    groups[bt.key][bt.idx] = a;
    return { ok: true, from: at.key, to: bt.key };
  }

  /* ==========================================================================
   * 「本轮定稿了没有」—— 判定全员到齐的唯一口径（v105）
   *
   * 进入修改态（beginRevise）时 `submitted` **仍然是 true**：服务端还留着一份
   * 有效的旧分组当兜底，这是有意的，超时的时候靠它按旧分组结算。
   * 但那份旧分组不能拿来当「他定稿了」的证据 —— 于是出现了这条 bug：
   *
   *   甲提交 → 点「改一下」→ 正在重新摆牌
   *   乙、丙提交 → 最后一个人触发 allSubmitted
   *   甲的 submitted 还是 true → 立刻结算，用的是甲**还没改完的那份旧分组**
   *
   * 甲的意图明明是「我要改」，却被自己上一版代表结算了，而且全程没有任何提示。
   * 所以判据必须多一层：正在改 = 没定稿，别人全交也得等。
   *
   * ★ 三处「到齐」判定全走这一个函数（submitGroups / forfeitRound / settleIfAllIn）。
   *   以前是三份手抄的同一句话，注释里还专门写着「口径要与另外两处保持一致」——
   *   那说明它已经在靠人记着了。改成一处，以后加条件只改这里。
   * ========================================================================== */
  function isRoundLocked(p, round) {
    if (!p) return false;
    if (p.forfeitRound === round) return true;              // 弃权 = 定稿（空分组参与比牌）
    if (!(p.submitted && p.submitted['round' + round])) return false;
    return p.revising !== round;                            // 正在改 = 未定稿
  }

  /*
   * 进入「改一下」。
   *
   * 为什么要在服务端记一笔，而不是只在前端改个 state：
   * 「是否在改」决定了**这一刻能不能结算**，是规则的一部分，不是视觉状态。
   * 只写在 game.js 里的话，服务端根本不知道有人在改，照样会把本轮结掉。
   *
   * 额度与 submitGroups 里那段「已修改过一次」共用同一个计数器 resubmits，
   * 但这里**不消耗**额度 —— 点开看一眼又退回来（cancelRevise）不该扣掉唯一一次机会。
   */
  function beginRevise(room, playerId) {
    if (!room) return { ok: false, error: '房间不存在' };
    var p = findPlayer(room, playerId);
    if (!p) return { ok: false, error: '你不在该房间' };
    if (p.left) return { ok: false, error: '已弃局' };
    var round = room.round;
    if (room.phase !== (round === 1 ? PHASE.ROUND1_SPLIT : PHASE.ROUND2_SPLIT)) {
      return { ok: false, error: '当前不是分牌阶段' };
    }
    var rkey = 'round' + round;
    if (p.forfeitRound === round) return { ok: false, error: '本回合已超时弃权，不能再改' };
    if (!p.submitted[rkey]) return { ok: false, error: '还没提交，不用改' };
    if ((p.resubmits[rkey] || 0) >= 1) return { ok: false, error: '本轮已修改过一次，不能再改' };
    if (p.revising === round) return { ok: true, room: room };   // 已经在改，幂等

    p.revising = round;
    room.updatedAt = Date.now();
    /* 不做「有人在改 → 全员到齐」的重判：他刚从「已交」变成「未定稿」，
     * 只可能让到齐更难成立，不可能让它成立。 */
    return { ok: true, room: room };
  }

  /* 放弃这次修改，回到「已提交（旧分组）」。
   * 不消耗 resubmits —— 额度是给「真的改了一次」算的。 */
  function cancelRevise(room, playerId) {
    if (!room) return { ok: false, error: '房间不存在' };
    var p = findPlayer(room, playerId);
    if (!p) return { ok: false, error: '你不在该房间' };
    var round = room.round;
    if (p.revising !== round) return { ok: true, room: room };   // 本来就没在改，幂等

    p.revising = null;
    room.updatedAt = Date.now();
    /* ★ 这里**必须**重判一次到齐：他刚才在改的时候，别的人可能已经全部提交了，
     * 都在等他。取消修改 = 立刻恢复定稿状态，这时候就该结算了。
     * 少了这一句，全桌会一起干等到分牌超时。 */
    settleIfAllIn(room);
    return { ok: true, room: room };
  }

  /* 提交当前轮分组。groups 形如 {single:[card], tenhalf:[...], piaosanye:[...]} */
  function submitGroups(room, playerId, groups) {
    if (!room) return { ok: false, error: '房间不存在' };
    var p = findPlayer(room, playerId);
    if (!p) return { ok: false, error: '你不在该房间' };
    var round = room.round;
    if (room.phase !== (round === 1 ? PHASE.ROUND1_SPLIT : PHASE.ROUND2_SPLIT)) {
      return { ok: false, error: '当前不是分牌阶段' };
    }
    if (p.left) return { ok: true, room: room }; // 弃局者无需提交

    /* 已弃权本回合就不再收分组。
     * forfeitRound 会把 submitted 置 true 并把四条分组清空，如果这里不拦，
     * 往下走就是「已提交 → 允许修改一次」那条通道 —— 玩家（或改过的客户端/AI）
     * 可以把空分组换成真牌，弃权之后照样参与比牌，超时弃权的约束等于没有。 */
    if (p.forfeitRound === round) {
      return { ok: false, error: '本回合已超时弃权，不能提交分组' };
    }

    /*
     * 已提交后再提交 = 修改，允许一次。
     * 以前的实现是「静默忽略并返回成功」——玩家以为改好了，实际还是旧分组在计分，
     * 这种「假成功」比直接报错更糟。
     */
    var rkey = 'round' + round;
    var revising = !!p.submitted[rkey];
    if (revising && (p.resubmits[rkey] || 0) >= 1) {
      return { ok: false, error: '本轮已修改过一次，不能再改' };
    }

    // 校验张数（每组必须填满）
    var groupKeys = ROUND_GROUPS[round];
    for (var i = 0; i < groupKeys.length; i++) {
      var key = groupKeys[i];
      var need = GROUP_COUNT[key];
      var got = groups[key] || [];
      if (got.length !== need) {
        return { ok: false, error: '每组必须填满指定张数（' + GROUP_LABEL[key] + ' 需 ' + need + ' 张）' };
      }
    }

    // 校验是否正好用了手上的 6 张牌（无重复、无缺失）
    var all = [];
    groupKeys.forEach(function (key) { all = all.concat(groups[key] || []); });
    if (all.length !== CONFIG.CARDS_PER_PLAYER) return { ok: false, error: '必须用满 6 张牌' };
    var ids = {};
    for (var j = 0; j < all.length; j++) {
      var cid = all[j].suit + '-' + all[j].rank;
      if (ids[cid]) return { ok: false, error: '存在重复牌' };
      ids[cid] = true;
    }
    var handIds = {};
    p.hand.forEach(function (c) { handIds[c.suit + '-' + c.rank] = true; });
    for (var cid2 in ids) {
      if (!handIds[cid2]) return { ok: false, error: '存在手牌以外的牌' };
    }

    /* 只落**本轮**的分组。第 2 轮只打 单张 + 斗牛，
     * 旧实现把 groups 里四条键原样拷进来，于是第一轮那两条（tenhalf / piaosanye）
     * 会跟着第二轮一起写进档案 —— 校验范围只看本轮两组，这两个字段既不会被校验
     * 也不会被结算读取，但档案里就出现了「这一局他手里并没有的那些牌」。
     * 回放、导出、以后有谁按 group 遍历统计时都会撞上这份脏数据，成本为零就直接清掉。 */
    var saved = { single: [], tenhalf: [], piaosanye: [], douniu: [] };
    groupKeys.forEach(function (key) { saved[key] = (groups[key] || []).slice(); });
    p.groups['round' + round] = saved;
    p.submitted[rkey] = true;
    if (revising) p.resubmits[rkey] = (p.resubmits[rkey] || 0) + 1;
    /* ★ 交完就退出修改态。漏了这一句，提交之后 p.revising 还停在 round 上，
     * 于是 isRoundLocked 永远判他「没定稿」—— 全桌等一个已经交了的人，直到超时。 */
    p.revising = null;
    room.updatedAt = Date.now();

    // 所有「未弃局、未弃权」的人都定稿后，自动结算。
    // 弃权者（本回合超时/主动放弃）不算在等待名单里——否则他会卡死整桌。
    // 「正在改」的人也不算定稿——否则会拿他的旧分组替他把本轮结掉（见 isRoundLocked）。
    var act = activePlayers(room);
    var allSubmitted = act.every(function (q) {
      return isRoundLocked(q, round);
    });
    if (allSubmitted) {
      settleRound(room, round);
    }
    return { ok: true, room: room, revised: revising };
  }

  /*
   * 本回合弃权（分牌超时 / 主动放弃）。
   *
   * 与「弃局（left）」的关键区别：弃权者**仍留在房间里**，下一把照常参与，
   * 只是本回合按「空分组」处理——结算时各组都当「弃权」，向赢家正常付分、自己不得分。
   * 这样挂机的人既不会卡死整桌，也绝不比手动玩的人占便宜（躺赢被彻底杜绝）。
   */
  function forfeitRound(room, playerId) {
    if (!room) return { ok: false, error: '房间不存在' };
    var p = findPlayer(room, playerId);
    if (!p) return { ok: false, error: '你不在该房间' };
    if (p.left) return { ok: false, error: '已弃局' };
    var round = room.round;
    if (room.phase !== (round === 1 ? PHASE.ROUND1_SPLIT : PHASE.ROUND2_SPLIT)) {
      return { ok: false, error: '当前不是分牌阶段' };
    }

    /*
     * ★ 正在改、但手上有一份已提交的旧分组：超时不是「弃权」，是「放弃修改」。
     *
     * 他明明交过牌，凭什么按弃权（空分组）罚他？弃权是给「一次都没交过、
     * 整轮挂机」的人准备的惩罚。一个已经交了、只是点开修改后没来得及改完的人，
     * 该按他交过的那份算——否则「点过一次改一下」反而比「什么都不做」更亏，
     * 以后没人敢用这个功能。
     *
     * 这个分支必须排在下面「已提交，无需弃权」之前：那句话会直接 return false，
     * 超时计时器的回调判到 false 就什么都不做，全桌就此停摆。
     */
    if (p.submitted['round' + round] && p.revising === round) {
      p.revising = null;
      room.updatedAt = Date.now();
      settleIfAllIn(room);          // 他一恢复定稿，可能全桌就齐了
      return { ok: true, room: room, droppedRevise: true };
    }

    if (p.submitted['round' + round]) return { ok: false, error: '已提交，无需弃权' };

    // 空分组 = 各组都「弃权」，settleGroup 会把它过滤出候选集、但照常向赢家付分
    p.groups['round' + round] = {
      single: [], tenhalf: [], piaosanye: [], douniu: []
    };
    p.submitted['round' + round] = true;
    p.forfeitRound = round;
    p.revising = null;              // 弃权同时退出修改态，别留一个悬空的 round 号
    room.updatedAt = Date.now();

    // 弃权也推进结算判定：其余在场未弃局者都提交（或弃权）后即结算
    var act = activePlayers(room);
    var allSubmitted = act.every(function (q) {
      return isRoundLocked(q, round);
    });
    if (allSubmitted) {
      settleRound(room, round);
    }
    return { ok: true, room: room };
  }

  /* 结算某一轮（内部） */
  function settleRound(room, round) {
    var groupKeys = ROUND_GROUPS[round];
    var results = [];

    /* 结算了就不存在「正在改」。正常路径上这时候已经没人处于修改态
     * （有人改就不会结算），这里兜的是异常路径：超时放弃修改、
     * 或某个旧客户端没走 beginRevise/cancelRevise 就改了本地状态。
     * 留一个悬空的 round 号，下一轮 isRoundLocked 就可能判错人。 */
    room.players.forEach(function (p) { p.revising = null; });

    for (var gi = 0; gi < groupKeys.length; gi++) {
      var key = groupKeys[gi];
      var pool = activePlayers(room);
      if (!pool.length) break;
      var entries = pool.map(function (p) {
        return { id: p.id, nickname: p.nickname, hand: (p.groups['round' + round] || {})[key] || [] };
      });
      var r = Engine.settleGroup(key, entries);
      // 应用分数增减（left 玩家不在 entries 内，分数冻结）
      for (var pid in r.deltas) {
        var pp = findPlayer(room, pid);
        if (pp) pp.score += r.deltas[pid];
        /* ★ 「这一局到底打没打」的唯一判据：**有没有一轮真的动过分**。
         *
         * 不要拿「分数是否都等于 20」当判据（那是以前的写法）：
         * 甲先赢 1 分又输 1 分、乙反过来，一局真打完了，两个人最后都正好 20 ——
         * 按分数判会把这一局当「一分没打」作废掉，玩家的真实输赢就没了。
         * 反过来，0 分变动才是真的什么都没发生（全员平、或牌面完全对消）。
         * 这个标记只增不减，startGame / startNextRound 时归零。 */
        if (r.deltas[pid]) room.anyScoreChange = true;
      }
      r.group = key;
      r.label = GROUP_LABEL[key];
      r.winnerNickname = (findPlayer(room, r.winnerId) || {}).nickname || r.winnerId;
      results.push(r);

      /* ★ v103：这里原本是「组级见底就 break + 整局结账」（v83 的写法）。
       *
       * 现在**不判也不 break 了**：分数跌破 0 只表示这个人这一把输得比本金多，
       * 不再终止游戏 —— 终局只认「打满建房时选的把数」（或人数不足 / 中途解散）。
       * 为什么要去掉：20 分本金扛不住几把，实测每把波动 ±5~8 分、最坏 −17 分，
       * 于是 5 / 10 / 15 / 30 档基本都被爆分抢先截断，玩家选的局数形同虚设。
       *
       * 副作用全是好的：
       *   · 本轮所有组一定全部算完 → results.length 恒等于组总数；
       *   · p.out / bustedIds / groupsDone 永远停在初值（那些字段现在只为
       *     老数据/回放兼容而存在，新局不会再有值）；
       *   · 顺带修掉一个老的不公平：以前第 1 组见底的人，后面两组的输赢
       *     直接蒸发，同一个人换个座位顺序最终分就不一样了。 */
    }
    room.results['round' + round] = results;
    room.lastResult = { round: round, groups: results };
    room.resultSeq = (room.resultSeq || 0) + 1;

    /* 归档进 history 供「本局过程」回看（P3-7）。
     * 放在这里而不是结算页渲染时做：结算是唯一的真相时刻，
     * 之后再想补就只剩 lastResult 一条了 —— 而 results 下一把会被 dealAll 覆盖掉。 */
    room.history = room.history || [];
    room.history.push({
      hand: room.handCount,
      /* ★ 把次身份：hid（handId）。
       * 为什么不能只用 hand：handCount 在「开下一把」时会被重置为 1，
       * 于是重启后的第 3 把和第 1 把的 hand 都是 1，两把的过程会被拼成一条，
       * 回放里出现两个「第 1 把 · 第 1 轮」。
       * handId 在 dealAll 里递增，每一把一个，不受重启影响。 */
      hid: room.handId || 1,
      round: round,
      at: Date.now(),
      /* bustedIds：谁在这轮「见底出局」。
       * ★ v103 起恒为空数组 —— 不再有这回事，字段只为老记录回放兼容而保留
       *   （老局里可能真有值，删字段会让老回放读到 undefined）。
       * 注意别改成「从 deltas 反推负分者」：老局里有人本来就负（离开后冻结），反推会算错人。 */
      bustedIds: [],
      groups: results.map(function (g) {
        return {
          group: g.group,
          label: g.label,
          winnerId: g.winnerId,
          winnerNickname: g.winnerNickname,
          winnerTypeName: g.winnerTypeName,
          deltas: g.deltas,
          entries: (g.entries || []).map(function (e) {
            /* ★ nickname 必须在这里补回来，不能直接抄 e.nickname。
             * Engine.settleGroup 返回的 entries 只有 { id, hand, typeName, decider }，
             * **没有 nickname** —— 以前这里写的是 `nickname: e.nickname`，拿到 undefined，
             * 于是 history 里的名字全是空串。表现为：回放里每行只剩「6♣ +2」，
             * 左边整列空着，牌认得出、人认不出，看起来像数据被截断了一半。
             * 这个字段从加进来的那天起就没对过（一直没人看，所以一直没被发现）。 */
            var p = findPlayer(room, e.id);
            return { id: e.id, nickname: (p && p.nickname) || e.nickname || '', hand: e.hand };
          })
        };
      })
    });
    if (room.history.length > 4) room.history = room.history.slice(-4);

    /* ★ v103：这里原本是「爆分收口」——busted 非空就 SETTLED + endReason='scoreZero'。
     * 现在整段删掉，终局只剩下面两条路：
     *   · 第 2 轮打完且手数够了   → handLimit（唯一正常终局）
     *   · 人数不足 / 房主解散     → someoneLeft / dissolve（异常终局）
     * 分数跌破 0 的人照样继续打，最终分可以是负数，净胜 = 最终分 − 初始分。 */
    room.bustedIds = [];
    room.groupsDone = results.length;

    if (round === 1) {
      room.round = 2;
      room.phase = PHASE.ROUND2_SPLIT;
    } else {
      /* 第二轮打完 = 这一把真正结束（v103 起没有「无人见底」这个前置条件，
       * 分数跌破 0 的人也在打）。先判「把数上限」，再决定发不发下一把。
       *
       * ★ 判定必须放在 handCount += 1 **之前**：此刻 handCount 还是刚打完这一把的序号。
       *   放到后面就变成「打完第 N 把时序号已是 N+1」，症状是 3 局房少打一把，
       *   或者非要打到第 4 把才停 —— 这是本次改动唯一的硬骨头，测试就盯这里。
       * ★ 结束时不翻轮：room.round 停在 2，结算页才能继续显示这一把第二轮的明细
       *   （与爆分路径完全一致）。 */
      if (room.handCount >= handLimitOf(room)) {
        room.bustedIds = [];
        room.groupsDone = results.length;
        room.phase = PHASE.SETTLED;
        room.endReason = 'handLimit';
        markSettled(room);
        return;
      }
      room.handCount += 1;
      room.round = 1;
      dealAll(room);
      room.phase = PHASE.ROUND1_SPLIT;
    }
    room.updatedAt = Date.now();
  }

  /**
   * 当前回合「该提交的人都到齐了」就立刻结算，返回是否真的结算了。
   *
   * 抽出来是因为有两个触发点：主动离开（leaveRoom）与断线超时判弃（finalizeLeave）。
   * 以前只有后者写了这段，于是「最后那个没提交的人点离开」会把整桌永久留在分牌阶段：
   * 剩下的人早已全部提交，却没有任何人会再触发一次「全员提交」判定，
   * 而分牌超时只给「未提交且未离开」的人挂计时器 —— 此时一个都不剩。
   *
   * 「到齐」的口径统一走 isRoundLocked()，不再各写一份：
   * 已提交且不在修改中，或本回合已弃权。
   * （以前这里、submitGroups、forfeitRound 是三份手抄的同一句话，
   *  v105 加「正在改不算定稿」时改成了一处，以后加条件只改那个函数。）
   */
  function settleIfAllIn(room) {
    if (!room) return false;
    if (room.phase !== PHASE.ROUND1_SPLIT && room.phase !== PHASE.ROUND2_SPLIT) return false;
    var rd = room.round;
    var act = activePlayers(room);
    if (!act.length) return false;   // 人都走光了，交给 maybeEndGame / 房间回收
    var allIn = act.every(function (q) {
      return isRoundLocked(q, rd);
    });
    if (!allIn) return false;
    settleRound(room, rd);
    return true;
  }

  /* 一手牌的唯一身份：「场次:把:轮」。
   * 客户端的分牌草稿 / 已放牌用这个键判重，**不能只用 round**：
   * 换手有两条路径，round 都会回到 1，于是「上一把第 1 轮」和「这一把第 1 轮」的 round 完全相同，
   * 草稿判重误认为没换手 —— 牌区留着上一把已放满的牌（点不动、拖不回），
   * 手牌却是新发的 6 张，且牌区全满导致一张都放不进去，整轮分牌卡死。
   *   · restart()：结算页「开下一把」，round=1、handCount=1，靠 handSeq +1 区分（永不重置）
   *   · settleRound(2) 就地续局：round=2→1，handCount +1，靠 handCount 区分
   * 三个分量缺一不可，别为了「看起来简洁」删掉任何一个。 */
  function handKey(room) {
    return (room.handSeq || 0) + ':' + (room.handCount || 1) + ':' + room.round;
  }

  /* ==========================================================================
   * 结算 → 下一局（报名制）
   *
   * 旧行为：房主一人点「开下一把」，整个房间立刻重置发牌。问题不在重置本身，
   * 而在于**结算页变成了房主一个人的闸门** —— 房主手快点一下，正在看回放、
   * 正在存战绩图的人当场被顶出结算页，刚打出来的分数连看都没看清。
   *
   * 现在拆成两步，谁都不被别人拖着走：
   *   1) 每人各自点「开始下一局」→ 登记进下一局，回到房间页（房间号不变）
   *   2) 在房间页各自点「准备」→ 已进入的人全部准备好就开局
   *
   * ★ 关键设计：整段过程 room.phase 一直是 SETTLED。
   * 如果把 phase 推到 WAITING，服务端广播会把所有没点的人强行切出结算页 ——
   * 那正是要解决的问题。代价是「就位态」这个界面不能直接用 renderRoom 的 WAITING 分支，
   * 前端要按 wantNext 分叉渲染（见 game.js render() 与 renderRoom(room, { nextWait })）。
   * ========================================================================== */

  /* 结算期里「已进入下一局」的人。AI 在 markSettled 时就预置了 wantNext，所以也算在内。 */
  function nextRoundPlayers(room) {
    if (!room || room.phase !== PHASE.SETTLED) return [];
    return room.players.filter(function (p) { return p.wantNext && !p.left; });
  }

  /* 下一局能不能开：已进入的人不少于最少人数，且这些人全部已准备。
   * 注意分母是「已进入的人」而不是「房间里的人」—— 没点的人不参与下一局，
   * 自然也不该挡住别人开局。 */
  function canStartNext(room) {
    var list = nextRoundPlayers(room);
    if (list.length < CONFIG.MIN_PLAYERS) return false;
    return list.every(function (p) { return p.ready; });
  }

  /* 点「开始下一局」：登记 + 回到房间页。ready 归 false，因为用户要的是
   * 「回房间后各自再点一次准备」，不是点一下就算就绪。 */
  function wantNext(room, playerId) {
    if (!room) return { ok: false, error: '房间不存在' };
    if (room.phase !== PHASE.SETTLED) {
      return { ok: false, error: '新的一局已经开始了，等这局打完再玩', code: 'NEXT_STARTED' };
    }
    var p = findPlayer(room, playerId);
    if (!p) return { ok: false, error: '你不在该房间' };
    if (p.left) return { ok: false, error: '你已经离开这一局了' };
    p.wantNext = true;
    p.ready = false;
    room.updatedAt = Date.now();
    return { ok: true, room: room };
  }

  /* 撤回「开始下一局」：误点之后能退回结算页。
   *
   * 以前这个动作没有出口 —— wantNext 一旦置真，除了开局和离开房间没人能改回来。
   * 「准备」可以取消，「报名」却不能取消，同一屏上两个按钮一个能反悔一个不能，
   * 点错就只能退房重进。
   *
   * 只在还没开局时允许。就位态的定义就是「还没开」，所以正常情况下不会撞上；
   * 撞上了（别人刚好凑齐并已开局）就返回明确原因，让前端照常 flash，
   * 不能静默失败 —— 玩家会以为自己退回来了，其实没有。 */
  function unWantNext(room, playerId) {
    if (!room) return { ok: false, error: '房间不存在' };
    if (room.phase !== PHASE.SETTLED) {
      return { ok: false, error: '新的一局已经开始了，这一局打完再看', code: 'NEXT_STARTED' };
    }
    var p = findPlayer(room, playerId);
    if (!p) return { ok: false, error: '你不在该房间' };
    if (p.left) return { ok: false, error: '你已经离开这一局了' };
    if (!p.wantNext) return { ok: true, room: room };   // 幂等：连点两次不算错
    p.wantNext = false;
    /* 准备跟着一起撤。留着 ready 会造出一个自相矛盾的状态：
     * 人不在下一局里，却带着「已准备」标记，下次报名时直接就绪，
     * 别人看到的就是「他刚进来就准备好了」。 */
    p.ready = false;
    room.updatedAt = Date.now();
    return { ok: true, room: room };
  }

  /* 真正开下一局：只带已进入的人，分数重置，重新发牌。
   * 返回 removed 让调用方去通知那些没点的人 —— 他们已经不在这个房间里了，
   * 不通知的话他们的界面会停在结算页，点「开始下一局」才发现晚了。
   *
   * 这里必须继续调 dealAll()：它同时负责重置 submitted / groups / hand /
   * resubmits / forfeitRound。少了它，新一局第一轮每个人都带着上一局的「已提交」，
   * 牌桌会卡在「等待提交」——这是本次改造最容易漏的一处。 */
  function startNextRound(room) {
    if (!room) return { ok: false, error: '房间不存在' };
    if (!canStartNext(room)) return { ok: false, error: '还没到开下一局的条件' };

    var joiners = nextRoundPlayers(room);
    var keepIds = joiners.map(function (p) { return p.id; });
    var removed = room.players
      .filter(function (p) { return !p.left && keepIds.indexOf(p.id) < 0; })
      .map(function (p) { return p.id; });

    room.players = joiners;
    room.players.forEach(function (p) {
      p.score = CONFIG.INITIAL_SCORE;
      p.ready = false;
      p.wantNext = false;
      p.joinedLate = false;   // 新一局他也是「打过的人」了，结算弹窗要照常给他
      p.resubmits = { round1: 0, round2: 0 };
      p.revising = null;      // 开下一把：谁都不在「正在改」的状态里
      p.out = false;          // 新一局人人重新上场
    });
    room.round = 1;
    room.handCount = 1;
    room.results = { round1: null, round2: null };
    room.lastResult = null;
    room.endReason = null;
    room.voided = false;    // 新一局所有老状态归零，包括「上一把作废」这个标记
    room.anyScoreChange = false;
    room.bustedIds = [];
    room.groupsDone = 0;
    room.handHadBot = room.players.some(function (p) { return !!p.isBot; });   // 同上：每把重算
    room.settledAt = null;                                  // 新一局清空，下一局重新写
    room.dissolve = { active: false, initiatorId: null, startedAt: 0, votes: {},
                      lastReason: null, lastAt: 0 };
    ensureLiveOwner(room);   // 房主可能没点进来 → 所有权交给留下的人，否则没人能补 AI / 发起解散
    dealAll(room);
    room.phase = PHASE.ROUND1_SPLIT;
    room.updatedAt = Date.now();
    return { ok: true, room: room, removed: removed };
  }

  /* 兼容旧客户端：缓存里还留着「开下一把」按钮的版本，点的是 restart。
   * 它的语义是「房主一键开下一局」，这里翻译成「我进入下一局 + 我算准备好了」
   * —— 旧页面在结算期没有准备按钮，不替它把 ready 置上，那个人会永远凑不齐。
   * 条件满足时由服务端随后自动开局（见 hub 的 _maybeAutoStart）。 */
  function restart(room, ownerId) {
    var r = wantNext(room, ownerId);
    if (!r.ok) return r;
    var p = findPlayer(room, ownerId);
    if (p) p.ready = true;
    room.updatedAt = Date.now();
    return { ok: true, room: room };
  }

  /* 「全员就绪就开局」的统一入口。
   *
   * 特意**不**塞进 setReady / wantNext 内部：状态机是纯规则层，
   * setReady 一旦自己推进阶段，所有「先造房间、再逐个置状态、最后调用 startGame」
   * 的单元测试都会在中间被打断。由调用方在合适时机显式调一次：
   *   · 服务端 hub：准备 / 开始下一局 / 旧版 restart 之后
   *   · 本地演示 roomStore：同样的三个位置
   * 补 AI 之后故意不调 —— 房主先点了准备再想补 3 个 AI，补第一个的瞬间就开局了。
   *
   * 返回 null 表示没开；否则返回 { kind, removed } 让调用方去处理善后。 */
  function autoStartIfReady(room) {
    if (!room) return null;
    if (canStart(room)) {
      var r1 = startGame(room, room.ownerId);
      return r1.ok ? { kind: 'start', removed: [] } : null;
    }
    if (canStartNext(room)) {
      var r2 = startNextRound(room);
      return r2.ok ? { kind: 'next', removed: r2.removed || [] } : null;
    }
    return null;
  }

  /* 发起解散：任意在场玩家皆可发起（不限房主） */
  /* 解散投票的「有效投票人」：在场 + 真人 + 连接中。
   * 机器人和掉线真人都不计入 quorum——它们永远不会应答投票，
   * 一旦计入就会永久卡在「等待其他玩家同意」（这是实际踩到的坑）。 */
  function dissolveVoters(room) {
    return activePlayers(room).filter(function (p) {
      return !p.isBot && p.connected !== false;
    });
  }

  /* 有效投票人是否已全部同意 */
  function dissolveAllAgreed(room) {
    if (!room.dissolve) return false;
    var voters = dissolveVoters(room);
    if (!voters.length) return false;
    for (var i = 0; i < voters.length; i++) {
      if (room.dissolve.votes[voters[i].id] !== true) return false;
    }
    return true;
  }

  /* 结束本局投票的有效期：30 秒还没凑齐同意就自动作废。
   * 不设它的话，一个人点「结束本局」之后其他人不表态（挂机、走开、网络半断），
   * 房间就永久停在「等待其他玩家同意」。这段时间 phase 还留在对局阶段，
   * 报名、准备、开下一局全都会被挡住 —— 只能所有人退房重开。 */
  var DISSOLVE_TIMEOUT_MS = 30 * 1000;

  /* 解散成立 → 直接结算，本局结束 */
  function finishDissolve(room) {
    room.phase = PHASE.SETTLED;
    /* 作废与否不在这里算 —— 统一由 markSettled() 写（三条结束路径的唯一收口，
     * 见那里的说明）。这里再算一遍就又多出一份「同一件事两种判据」。 */
    /* endReason 一并写：结算页据此说明「为什么结束」。
     * 以前这里是空的，玩家点完同意跳到结算页只看到一堆分数，没人解释发生了什么。 */
    room.endReason = 'dissolve';
    room.dissolve.active = false;
    room.dissolve.initiatorId = null;
    room.dissolve.startedAt = 0;
    room.dissolve.lastReason = 'agreed';
    room.dissolve.lastAt = Date.now();
    markSettled(room);
    return { ok: true, room: room, settled: true };
  }

  /* 内部统一出口：把投票作废（拒绝 / 取消 / 超时都走这里，别再各写一遍字段） */
  function dropDissolve(room, reason) {
    room.dissolve.active = false;
    room.dissolve.initiatorId = null;
    room.dissolve.startedAt = 0;
    room.dissolve.votes = {};
    /* 留一个原因给界面用：「被否决」「发起人取消」「超时」都结束投票，
     * 但玩家看到的提示不该一样 —— 以前这三种统一 flash「解散被否决」，超时也这么说，纯属误导。 */
    room.dissolve.lastReason = reason || null;
    room.dissolve.lastAt = Date.now();
    room.updatedAt = Date.now();
  }

  /* 发起人主动取消。没有这个出口时，点错了就只能干等超时。 */
  function cancelDissolve(room, playerId) {
    if (!room) return { ok: false, error: '房间不存在' };
    if (!room.dissolve || !room.dissolve.active) return { ok: false, error: '当前没有进行中的提议' };
    if (room.dissolve.initiatorId !== playerId) return { ok: false, error: '只有发起人可以取消' };
    dropDissolve(room, 'cancelled');
    return { ok: true, room: room };
  }

  /* 超时作废。返回 true 表示「本次调用真的把投票关掉了」，服务端据此决定要不要广播。
   * 纯函数、只看传进来的 now，所以能被单测直接驱动（给一个假时间即可）；
   * timeoutMs 允许服务端用环境变量改短（测试里不必真等 30 秒）。 */
  function expireDissolve(room, now, timeoutMs) {
    if (!room || !room.dissolve || !room.dissolve.active) return false;
    var at = room.dissolve.startedAt || 0;
    if (!at) return false;                                  // 老房间/未记录起点，不猜
    var limit = timeoutMs || DISSOLVE_TIMEOUT_MS;
    if ((now || Date.now()) - at < limit) return false;
    dropDissolve(room, 'expired');
    return true;
  }

  function proposeDissolve(room, playerId) {
    if (!room) return { ok: false, error: '房间不存在' };
    if (room.phase === PHASE.SETTLED) return { ok: false, error: '对局已结账' };
    var act = activePlayers(room);
    if (!act.some(function (p) { return p.id === playerId; })) return { ok: false, error: '你不在该房间' };
    // 已在投票中：幂等返回
    if (room.dissolve && room.dissolve.active) return { ok: true, room: room };
    room.dissolve = {
      active: true,
      initiatorId: playerId,
      startedAt: Date.now(),   // 超时作废的起点（expireDissolve 用）
      votes: {}
    };
    room.dissolve.votes[playerId] = true; // 发起者默认同意
    room.updatedAt = Date.now();
    // 房间里只剩发起者一个有效投票人（典型：单人 + AI 补位）→ 不必等，直接解散
    if (dissolveAllAgreed(room)) return finishDissolve(room);
    return { ok: true, room: room };
  }

  /* 投票解散：agree 为真=同意，为假=拒绝 */
  function voteDissolve(room, playerId, agree) {
    if (!room) return { ok: false, error: '房间不存在' };
    if (!room.dissolve || !room.dissolve.active) return { ok: false, error: '当前没有进行中的提议' };
    var act = activePlayers(room);
    if (!act.some(function (p) { return p.id === playerId; })) return { ok: false, error: '你不在该房间' };
    agree = !!agree;
    room.dissolve.votes[playerId] = agree;
    if (agree === false) {
      // 有人拒绝 → 解散被否决，作废投票
      dropDissolve(room, 'rejected');
      return { ok: true, room: room, rejected: true };
    }
    // 有效投票人全员同意 → 立即进入结算
    if (dissolveAllAgreed(room)) return finishDissolve(room);
    room.updatedAt = Date.now();
    return { ok: true, room: room };
  }

  /* 统一的「进入结算」收口：写稳定结束时间 + 递增本房间场次序号。
   * settledAt 只写一次（结算页停留期间的其它操作会刷新 updatedAt，不能当身份用）；
   * handSeq 同样只在新结算时 +1，重复进入结算不会重复计数。 */
  function markSettled(room) {
    if (!room.settledAt) {
      room.settledAt = Date.now();
      room.handSeq = (room.handSeq || 0) + 1;
      /* ★ 作废与否在这里判，因为这里是三条结束路径**唯一的收口**：
       *   打满局数（settleRound）／ 人数不足（maybeEndGame）／ 结束本局（finishDissolve）
       * 全都调它。写在别处一定会漏 —— 以前只有 finishDissolve 写，
       * 于是「一分没打、对手掉线」这条路上 voided 永远是 false，
       * 两个人各被记一场「净胜 0」的平局：场次 +1、胜率被稀释、连胜被清成 0。
       *
       * 判据是「有没有一轮真的加减过分」（anyScoreChange），不是「分数是否都等于基准分」：
       * 甲先赢 1 分又输 1 分、乙反过来，一局真打完，两人最后都正好等于基准分，
       * 按分数判会把这局作废掉，玩家的真实输赢就没了。
       *
       * 分数比对作为**兜底**保留，不当作定义：万一以后有哪条路径改了分却忘了置
       * anyScoreChange，兜底还能拦住「真的赢了却被作废」这种更糟的错。
       * 两个条件都不成立，才算「这一局什么都没发生」。
       *
       * 写进 `if (!room.settledAt)` 里：结算后分数不再变化，判一次就够，
       * 也避免结算页停留期间的重复广播反复重算。 */
      room.voided = !room.anyScoreChange && !room.players.some(function (p) {
        return (Number(p.score) || 0) !== CONFIG.INITIAL_SCORE;
      });
    }
    /* 机器人不会点「开始下一局」，但它还坐在房间里。
     * 不在这里预置，单人 + AI 的玩家结算后会发现自己一个人凑不齐最少人数，
     * 而三个 AI 明明还在座位上。语义和 addBot 里那句「AI 永远准备好」一致。 */
    room.players.forEach(function (p) {
      if (p.isBot && !p.left) { p.wantNext = true; p.ready = true; }
    });
    /* 结算这一刻再把「座位上有没有 AI」并进去。
     * 为什么要并：开局快照只覆盖「开局时已经在座」的情况，
     * 而 AI 是房主随时可以补的（补完立刻参与后面的分牌与计分）。
     * 用「或」而不是「等于」：中途被移除的 AI 也该让这一把算「含 AI」。 */
    room.handHadBot = !!room.handHadBot || room.players.some(function (p) { return !!p.isBot; });
    room.updatedAt = Date.now();
  }

  /* 人数不足即结束：对局中在场人数 < MIN_PLAYERS 时，本局提前结束（进入结算页） */
  function maybeEndGame(room) {
    if (room.phase === PHASE.WAITING) return; // 等待中掉线已在服务端移除，不在此处理
    if (room.phase === PHASE.SETTLED) return; // 已结束（如解散/结账），不覆盖原因
    if (activePlayers(room).length < CONFIG.MIN_PLAYERS) {
      room.phase = PHASE.SETTLED;
      room.endReason = 'someoneLeft';
      markSettled(room);
    }
  }

  /* 标记玩家断线（宽限计时开始，暂不判弃） */
  function markDisconnected(room, playerId) {
    if (!room) return { ok: false, error: '房间不存在' };
    var p = findPlayer(room, playerId);
    if (!p) return { ok: false, error: '玩家不在房间' };
    p.connected = false;
    p.disconnectedAt = Date.now();
    room.updatedAt = Date.now();
    return { ok: true, room: room };
  }

  /* 重连：宽限内恢复在线；若已判弃（left）则拒绝 */
  function reconnect(room, playerId) {
    if (!room) return { ok: false, error: '房间不存在' };
    var p = findPlayer(room, playerId);
    if (!p) return { ok: false, error: '玩家不在房间' };
    if (p.left) {
      // 已判弃（宽限超时）后仍允许回桌，前提是本局还在打、且没翻到下一轮：
      //   - 手牌在 finalizeLeave 里已保留，所以回来能直接接上
      //   - 翻轮后手牌内容已失效（是上一轮的牌），让他参与新一轮会算错分，必须挡住
      if (room.phase === PHASE.SETTLED) return { ok: false, error: '本局已结束，请等下一把' };
      if (p.leftAtRound !== room.round) return { ok: false, error: '本局已进入下一轮，请等下一把' };
      p.left = false;
      p.ready = false;
    }
    p.connected = true;
    p.disconnectedAt = null;
    room.updatedAt = Date.now();
    return { ok: true, room: room };
  }

  /* 宽限到期：真正判弃，并判定人数不足即结束本局；释放卡死的“等待提交”界面 */
  function finalizeLeave(room, playerId) {
    if (!room) return { ok: false, error: '房间不存在' };
    var p = findPlayer(room, playerId);
    if (!p) return { ok: false, error: '玩家不在房间' };

    /*
     * 等待阶段：直接把这个座位从座位表里摘掉。
     * 否则它会以「已弃局」的形态一直占着位置——ownerId 指着一个不在的人，
     * 剩下的真人就**再也补不进 AI**（addBot 只认房主），少人局只能干等；
     * 空座位还占着 8 人上限，房间要闲置 30 分钟才被回收。
     * 注意这里不是因为「开不了局」—— 开局早已不看房主（见文件头）。
     */
    if (room.phase === PHASE.WAITING) {
      room.players = room.players.filter(function (q) { return q.id !== playerId; });
      room.updatedAt = Date.now();
      if (room.players.length === 0) return { ok: true, room: null, deleted: true };
      ensureLiveOwner(room);
      return { ok: true, room: room, removed: true };
    }

    p.left = true;
    p.ready = false;
    p.connected = false;
    // 手牌**不清空**：清空后即便人回来了也没牌可打，等于把「掉线」变成「永久出局」。
    // 判弃期间结算会按 activePlayers 过滤掉他，手牌留着不会影响计分。
    p.leftAtRound = room.round;
    room.updatedAt = Date.now();

    // 走的人若在解散投票里投过票，票要一并清掉，否则剩下的人永远凑不齐
    if (room.dissolve && room.dissolve.active) {
      delete room.dissolve.votes[playerId];
      if (room.dissolve.initiatorId === playerId) room.dissolve.initiatorId = null;
    }

    maybeEndGame(room); // 人数不足 → 提前结束
    // 未结束且其余在场玩家已全部提交当前轮 → 立即结算，释放卡死界面
    var settledNow = settleIfAllIn(room);
    if (settledNow || room.phase === PHASE.ROUND1_SPLIT || room.phase === PHASE.ROUND2_SPLIT) {
      // 走了一个人之后，剩下的人可能已经全部同意解散了
      if (room.dissolve && room.dissolve.active && dissolveAllAgreed(room)) {
        return finishDissolve(room);
      }
    }

    ensureLiveOwner(room);
    return { ok: true, room: room };
  }

  return {
    PHASE: PHASE,
    GROUP_LABEL: GROUP_LABEL,
    ROUND_GROUPS: ROUND_GROUPS,
    GROUP_COUNT: GROUP_COUNT,
    nextOpenGroup: nextOpenGroup,
    groupsFull: groupsFull,
    placeCard: placeCard,
    removeCard: removeCard,
    swapCards: swapCards,
    locateCard: locateCard,
    tenHalfPair: tenHalfPair,
    tenHalfAdvice: tenHalfAdvice,
    TENHALF_MAX_TENTHS: TENHALF_MAX_TENTHS,
    findPlayer: findPlayer,
    activePlayers: activePlayers,
    capOf: capOf,
    handLimitOf: handLimitOf,
    normalizeHandLimit: normalizeHandLimit,
    handLimitOptions: handLimitOptions,
    roomSeats: roomSeats,
    newRoom: newRoom,
    joinRoom: joinRoom,
    leaveRoom: leaveRoom,
    setReady: setReady,
    canStart: canStart,
    rename: rename,
    startGame: startGame,
    submitGroups: submitGroups,
    beginRevise: beginRevise,
    cancelRevise: cancelRevise,
    isRoundLocked: isRoundLocked,
    forfeitRound: forfeitRound,
    handKey: handKey,
    restart: restart,
    wantNext: wantNext,
    unWantNext: unWantNext,
    nextRoundPlayers: nextRoundPlayers,
    canStartNext: canStartNext,
    startNextRound: startNextRound,
    autoStartIfReady: autoStartIfReady,
    proposeDissolve: proposeDissolve,
    cancelDissolve: cancelDissolve,
    expireDissolve: expireDissolve,
    DISSOLVE_TIMEOUT_MS: DISSOLVE_TIMEOUT_MS,
    ensureLiveOwner: ensureLiveOwner,
    dissolveVoters: dissolveVoters,
    voteDissolve: voteDissolve,
    markDisconnected: markDisconnected,
    reconnect: reconnect,
    finalizeLeave: finalizeLeave
  };
});
