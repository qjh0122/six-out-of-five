/**
 * 本机战绩数据层（L0 · 纯 localStorage，零网络请求）
 *
 * 设计原则（见 docs/product-spec-l0-records.md §3）：
 *   1. 只存原始记录，聚合随时算 —— 以后加指标不改数据结构
 *   2. 单 key 存储，最多保留最近 200 局，超出淘汰最旧
 *   3. 任何读写异常（隐私模式 / 配额满 / 脏数据）一律静默降级，绝不影响对局
 *
 * 对外接口：
 *   Records.add(record) -> {added:boolean, reason?:string, trimmed?:boolean}
 *       写入一条。返回 trimmed:true 表示「记下了，但配额不够、丢掉了更早的记录」，
 *       调用方应当提示用户一次（不能静默）。
 *       写入一条。幂等三层：
 *         a) 同 roomId + 同 endedAt → 视为同一局重复
 *         b) 同 roomId + 同局次(rounds) 且 endedAt 相差 < 10 分钟 → 同一把被写了两次
 *         c) 老数据缺局次时收窄到 60 秒窗口
 *       注意：局次不同一律视为不同的一把，不受时间窗影响（否则同房间连打会被吞）。
 *       跳过时返回 {added:false, reason:'duplicate'}
 *   Records.all(playerId?)  -> Array    全部/某账号的记录，按 endedAt 倒序（最新在最前）
 *       不传 playerId = 全部记录（迁移、排查用）；传了就只返回该账号的。
 *       **老版本写下的记录没有 playerId**，它们不归属任何账号，只在「未登录」视图里出现。
 *   Records.dedupe(force) -> {ran, removed}  存量重复迁移（默认只跑一次，force=true 强制重跑）
 *   Records.stats(playerId?) -> Object  聚合指标（场次 / 胜负平 / 胜率 / 净胜 / 单场最高 /
 *                                       当前连胜 / 最长连胜 / 最长连败 / 最近 10 局）
 *   Records.clear(playerId?) -> boolean 清空。传 playerId = 只清该账号；不传 = 全清。
 *   Records.available() -> boolean      localStorage 可用性（隐私模式返回 false）
 *   Records.KEY / Records.LIMIT / Records.DUP_WINDOW_MS   便于测试与排查
 *
 * ★ 这个模块已经不是战绩的权威数据源了。
 *   权威数据在服务端（profiles.json，与排行榜同一份），由 /api/me/records 提供；
 *   这里退化为两件事：**离线兜底**，以及**回放仓库**（服务端不存逐轮明细）。
 *   保留 playerId 字段是为了让兜底数据也能按账号隔离 —— v50 之前没有这个字段，
 *   同一台手机换账号登录时，两个号的局会混进同一个列表，
 *   表现为「我的战绩里是别人的数据」。
 *
 * 记录字段：id / playerId / roomId / endedAt / playerCount / myStartScore / myEndScore /
 *          myNet / endReason / rounds / replay(可选)
 * 同时支持 Node require（测试用，可在 global 上挂 mock localStorage）与浏览器全局变量。
 */
(function (global, factory) {
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = mod;
  } else {
    global.Records = mod;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var KEY = 'lxw_records_v1';
  var LIMIT = 200;
  /* 同房间「同一把」的时间窗：结算页停留 / 重连 / 别人操作都会让 updatedAt 漂移，
   * 同一把被写两次时 endedAt 会有秒级差异，故同局次 + 窗口内一律视为重复。 */
  var DUP_WINDOW_MS = 10 * 60 * 1000;
  /* 老数据（没有局次字段）缺失可靠区分依据，只认 60 秒内的近似：
   * 六选五一把不可能 60 秒内打完，所以这个窄窗口不会误吞连打。 */
  var LEGACY_DUP_WINDOW_MS = 60 * 1000;
  /* v2：判重引入局次，必须用新逻辑重跑一次存量迁移
   * （v1 只看 10 分钟窗口，会把同一房间连打的真实记录误删）。 */
  var DEDUPE_FLAG = 'lxw_records_deduped_v2';

  /* ---------------------------- 存储访问（全部容错） ---------------------------- */
  function store() {
    try {
      // 每次调用都重新取，便于测试注入 mock / 运行期被禁用时及时降级
      if (typeof localStorage === 'undefined' || !localStorage) return null;
      return localStorage;
    } catch (e) {
      return null;
    }
  }

  function available() {
    var ls = store();
    if (!ls) return false;
    try {
      var probe = '__lxw_probe__';
      ls.setItem(probe, '1');
      ls.removeItem(probe);
      return true;
    } catch (e) {
      return false; // 隐私模式 / 配额满 / 被策略禁用
    }
  }

  function rawRead() {
    var ls = store();
    if (!ls) return null;
    try { return ls.getItem(KEY); } catch (e) { return null; }
  }

  /* 写入磁盘。返回值是**三态**，不是布尔：
   *   'ok'      —— 完整写入
   *   'trimmed' —— 配额不够，丢了一部分老记录才写进去（这一局保住了，历史缩水）
   *   false     —— 怎么写都写不进（隐私模式 / 配额被别的 key 占满）
   *
   * 为什么要有 trimmed 这一档：以前的实现是 try/catch 一把梭，配额一满就 return false，
   * 于是「这局打完了，战绩页里没有」—— 而且没有任何提示。玩家能观察到的现象是
   * 「战绩偶尔会丢一局」，归因成本极高。
   * 现在的策略是**先自己腾地方**：列表本来就是 endedAt 倒序，slice(0,n) 天然保留最新的。
   * 两段降级（一半 → 10 条）足够应付「同一个 key 撑爆 5MB」这个场景，
   * 因为单条记录不含回放时只有几百字节，10 条之后还没空间说明是别的 key 占的，再砍也没用。 */
  function rawWrite(list) {
    var ls = store();
    if (!ls) return false;
    try {
      ls.setItem(KEY, JSON.stringify(list));
      return 'ok';
    } catch (e) {
      /* 降级时把回放一起丢掉：回放是体积大头（一轮明细几十张牌），
       * 而它只是「可以再看一遍」，战绩本身才是不能丢的。 */
      var lean = function (arr) {
        return arr.map(function (r) {
          if (!r || !r.replay) return r;
          var c = {};
          for (var k in r) { if (k !== 'replay') c[k] = r[k]; }
          return c;
        });
      };
      var tries = [
        lean(list.slice(0, Math.max(10, Math.ceil(list.length / 2)))),
        lean(list.slice(0, 10))
      ];
      for (var i = 0; i < tries.length; i++) {
        try {
          ls.setItem(KEY, JSON.stringify(tries[i]));
          return 'trimmed';
        } catch (e2) { /* 继续下一档 */ }
      }
      return false;
    }
  }

  /* ---------------------------- 记录规范化 ---------------------------- */
  function num(v, dflt) {
    var n = Number(v);
    return isFinite(n) ? n : dflt;
  }

  /* ---------------- 回放留存（P3-7 剩项：退房之后还能回看「刚才那把」） ----------------
   * 房间内的回放来自服务端 room.history，一退房就没了。而「刚才那把我是怎么输的」
   * 恰恰是扑克类游戏最核心的复盘动作。
   *
   * 存在本机而不是云端档案，三个理由：
   *   1) 语义一致 —— 这是「我的复盘」，换设备看不到旧战绩，也就看不到旧回放；
   *   2) 不碰档案体积 —— profiles.json 是单文件存储，每份档案多 3KB 会直接拉低天花板；
   *   3) 零隐私面 —— 数据本来就已经在结算那一刻公开过，只写到自己的浏览器里。
   *
   * 体积控制是硬要求：LIMIT 是 200 局，一局回放约 3KB，全留就是 600KB。
   * 所以只给最近 REPLAY_KEEP 条留回放，更早的在写入时剥掉（记录本身还在）。 */
  var REPLAY_KEEP = 8;
  var REPLAY_MAX_ROUNDS = 4;
  var REPLAY_MAX_GROUPS = 6;
  var REPLAY_MAX_ROWS = 12;

  function clip(v, max) {
    if (v === null || v === undefined) return '';
    var s = String(v);
    return s.length > max ? s.slice(0, max) : s;
  }

  /* 回放是外部传进来的结构，必须自己裁一遍。
   * 真实形状是四层：把 → 轮 → 组 → 行，每层都有上限
   *   （8 个玩家 × 6 张牌；2 轮；每轮最多 REPLAY_MAX_GROUPS 组；每组最多 REPLAY_MAX_ROWS 行）。
   * 一个字段漏检查，一次写入就能把配额撑满，而配额满了会让整页战绩都读不出来。
   * 所以下面每一层都**先按上限截断、再校验**，不信任入参的任何长度。 */
  function saneReplay(r) {
    if (!r || !Array.isArray(r.rounds)) return null;
    var rounds = [];
    for (var i = 0; i < r.rounds.length && rounds.length < REPLAY_MAX_ROUNDS; i++) {
      var rd = r.rounds[i];
      if (!rd || !Array.isArray(rd.groups)) continue;
      var groups = [];
      for (var j = 0; j < rd.groups.length && groups.length < REPLAY_MAX_GROUPS; j++) {
        var g = rd.groups[j];
        if (!g) continue;
        var rows = [];
        var src = Array.isArray(g.rows) ? g.rows : [];
        for (var k = 0; k < src.length && rows.length < REPLAY_MAX_ROWS; k++) {
          var w = src[k];
          if (!w) continue;
          var cards = [];
          if (Array.isArray(w.c)) {
            for (var m = 0; m < w.c.length && cards.length < 6; m++) cards.push(clip(w.c[m], 6));
          }
          /* i 要保留：单把副本是老记录的唯一来源，
           * 丢了它就永远标不出「我」。 */
          rows.push({ i: clip(w.i, 24), n: clip(w.n, 20), c: cards, d: Math.round(num(w.d, 0)) });
        }
        groups.push({ l: clip(g.l, 10), w: clip(g.w, 20), t: clip(g.t, 12), rows: rows });
      }
      if (groups.length) rounds.push({ r: Math.max(1, Math.round(num(rd.r, 1)) || 1), groups: groups });
    }
    if (!rounds.length) return null;
    return { hands: Math.max(1, Math.round(num(r.hands, 1)) || 1), rounds: rounds };
  }

  /* 只保留最近 REPLAY_KEEP 条的回放。list 必须是 endedAt 倒序。
   * 注意是「删 replay 字段」而不是删记录 —— 战绩本身要留着。 */
  function trimReplays(list) {
    for (var i = REPLAY_KEEP; i < list.length; i++) {
      if (list[i] && list[i].replay) delete list[i].replay;
    }
  }

  function normalize(r) {
    if (!r || typeof r !== 'object') return null;
    var roomId = (r.roomId === null || r.roomId === undefined) ? '' : String(r.roomId);
    var endedAt = Math.round(num(r.endedAt, 0));
    if (!roomId || !(endedAt > 0)) return null; // 无房间号或无结束时间 → 脏数据丢弃

    var startScore = Math.round(num(r.myStartScore, 0));
    var endScore = Math.round(num(r.myEndScore, 0));
    var net = Math.round(num(r.myNet, endScore - startScore));

    var out = {
      id: String(r.id || (roomId + '-' + endedAt)),
      roomId: roomId,
      endedAt: endedAt,
      playerCount: Math.max(0, Math.round(num(r.playerCount, 0))),
      myStartScore: startScore,
      myEndScore: endScore,
      myNet: net,
      endReason: typeof r.endReason === 'string' && r.endReason ? r.endReason : null,
      rounds: Math.max(0, Math.round(num(r.rounds, 0))),
      /* 把次与场次身份：「看回放」要能找到整场的那份归档，
       * 并定位到你点的那一把。没有就整个字段不写。
       * 注意：这里是个**白名单**，漏一个字段就会在读写一轮后被静默丢掉。 */
      handId: Math.max(0, Math.round(num(r.handId, 0)))
    };
    var sk = (r.sessionKey === null || r.sessionKey === undefined) ? '' : String(r.sessionKey);
    if (sk) out.sessionKey = clip(sk, 40);
    /* 归属账号：没有就整个字段不写，老版本留下的记录因此保持「无主」，
     * 不会被误算进当前账号的视图里（那正是「战绩里是别人的数据」的成因）。 */
    var pid = (r.playerId === null || r.playerId === undefined) ? '' : String(r.playerId);
    if (pid) out.playerId = pid;
    /* 含 AI 的对局标记。云端档案把它单独放在 aiRecent 里；
     * 本机这份（离线兜底）没有第二份数组，就用一个布尔把同一件事记住，
     * 统计时再排除 —— 两边的**口径**必须一致，否则离线时会多算几场。 */
    if (r.ai === true) out.ai = true;
    var replay = saneReplay(r.replay);
    if (replay) out.replay = replay;   // 没有就整个字段不写，别在磁盘上留一堆 null
    return out;
  }

  /* 排序：endedAt 倒序（最新在最上）；同毫秒按 id 兜底，保证顺序稳定 */
  function sortDesc(list) {
    return list.sort(function (a, b) {
      if (b.endedAt !== a.endedAt) return b.endedAt - a.endedAt;
      if (a.id === b.id) return 0;
      return a.id < b.id ? 1 : -1;
    });
  }

  function sameGame(a, b) {
    if (!a || !b) return false;
    /* 归属账号不同的两条，永远不是「同一局」。
     * 少了这一句，同一台设备上两个账号先后打过同一间房的同一场次时，
     * 后写的那条会被前一个人的记录当成重复静默吞掉 —— 这是加了账号隔离之后
     * 才暴露出来的：以前的记录根本不带账号，无从比较，问题一直被掩盖着。 */
    if (String(a.playerId || '') !== String(b.playerId || '')) return false;
    if (String(a.roomId) !== String(b.roomId)) return false;
    if (Number(a.endedAt) !== Number(b.endedAt)) return false;
    /* 结束时间戳相同但局次不同 → 仍是两把（极短时间内连续结算时时间戳可能撞毫秒）。
     * 局次是比时间戳更可靠的同一性依据。 */
    var ra = Number(a.rounds) || 0;
    var rb = Number(b.rounds) || 0;
    if (ra > 0 && rb > 0 && ra !== rb) return false;
    return true;
  }

  /* 同一把的「近似重复」：同房间 + 同局次 + 时间接近。
   * 关键约束：局次（rounds = 房间内第几把）不同时，一定是两把不同的局，
   * 绝不能被时间窗吞掉 —— 早期实现只看 10 分钟窗口，导致同一房间连打时
   * 第二把起全部被判为重复静默丢弃。 */
  function nearDuplicate(a, b) {
    if (!a || !b) return false;
    if (String(a.playerId || '') !== String(b.playerId || '')) return false;   // 同上：跨账号永不判重
    if (String(a.roomId) !== String(b.roomId)) return false;
    var ra = Number(a.rounds) || 0;
    var rb = Number(b.rounds) || 0;
    var gap = Math.abs(Number(a.endedAt) - Number(b.endedAt));
    if (ra > 0 && rb > 0) {
      if (ra !== rb) return false;      // 局次不同 = 不同一把，必须写入
      return gap < DUP_WINDOW_MS;       // 同局次才可能是同一次结束被写了两次
    }
    // 任一方是老数据（缺局次）：只认秒级近似，宁可多记也不误吞连打
    return gap < LEGACY_DUP_WINDOW_MS;
  }

  /* ---------------------------- 读取（脏数据一律当空） ---------------------------- */
  function readAll() {
    var raw = rawRead();
    if (!raw) return [];
    var parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { return []; } // 非 JSON：视为空，不抛错
    if (!parsed || !Array.isArray(parsed)) return [];
    var out = [];
    for (var i = 0; i < parsed.length; i++) {
      var n = normalize(parsed[i]);
      if (n) out.push(n);
    }
    return sortDesc(out);
  }

  /* ---------------------------- 存量重复迁移（只跑一次） ----------------------------
   * 早期版本写入时用的判重窗口过宽，历史数据里可能已经有同局两条（roomId 相同、
   * endedAt 相差几分钟、净胜相同）。这里复用 nearDuplicate 的正判定（同房间 + 同局次
   * + 时间窗）归并，并额外要求 myNet 相同，避免误删同一房间里的真实连续对局。
   * 注意：即便是 v2 迁移，也无法恢复早期被静默丢弃的局次——那些记录从未落盘。 */
  function dedupe(force) {
    var ls = store();
    if (!ls) return { ran: false, removed: 0 };
    if (!force) {
      try {
        if (ls.getItem(DEDUPE_FLAG)) return { ran: false, removed: 0 }; // 已经跑过，不重复扫
      } catch (e) { return { ran: false, removed: 0 }; }
    }

    var asc = readAll().sort(function (a, b) { return a.endedAt - b.endedAt; }); // 升序 → 先到先留
    var kept = [];
    var removed = 0;
    for (var i = 0; i < asc.length; i++) {
      var r = asc[i];
      var dup = false;
      for (var j = 0; j < kept.length; j++) {
        if (nearDuplicate(kept[j], r) && kept[j].myNet === r.myNet) { dup = true; break; }
      }
      if (dup) { removed++; continue; }
      kept.push(r);
    }

    if (removed > 0) {
      sortDesc(kept);
      if (kept.length > LIMIT) kept.length = LIMIT;
      rawWrite(kept);
    }
    try { ls.setItem(DEDUPE_FLAG, '1'); } catch (e) {}
    return { ran: true, removed: removed };
  }

  /* 归属过滤：不传 = 全部（迁移/排查用）；传了 = 只该账号。
   * 老记录没有 playerId 字段，比较时统一折算成空串，于是它们只在「不传」时出现——
   * 不会悄悄混进任何一个账号的战绩。 */
  function ownedBy(r, pid) {
    return String((r && r.playerId) || '') === String(pid);
  }

  function all(playerId) {
    // 首次读取时清一次历史重复（标记位保证只跑一次；已跑过则只做一次 getItem 判断，零额外解析）
    dedupe(false);
    var list = readAll();
    if (playerId === undefined || playerId === null) return list;
    var pid = String(playerId);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (ownedBy(list[i], pid)) out.push(list[i]);
    }
    return out;
  }

  /* ---------------------------- 写入 ---------------------------- */
  function add(record) {
    var entry = normalize(record);
    if (!entry) return { added: false, reason: 'invalid' };
    if (!available()) return { added: false, reason: 'unavailable' };

    var list = all();
    for (var i = 0; i < list.length; i++) {
      // 幂等第一层：同一局（roomId + endedAt 完全一致）
      if (sameGame(list[i], entry)) return { added: false, reason: 'duplicate' };
      // 幂等第二层（数据层兜底）：同房间且结束时间相差 < 10 分钟 → 同一局
      if (nearDuplicate(list[i], entry)) return { added: false, reason: 'duplicate' };
    }
    list.push(entry);
    sortDesc(list);
    if (list.length > LIMIT) list.length = LIMIT; // 只留最近 200 条
    trimReplays(list);                            // 回放只给最近几条，防止配额被撑满
    var w = rawWrite(list);
    if (!w) return { added: false, reason: 'writeFailed' };
    /* trimmed = 这局记下了，但为了腾地方丢掉了一些更早的记录。调用方应当提示一次。 */
    return w === 'trimmed' ? { added: true, trimmed: true } : { added: true };
  }

  /* ---------------------------- 聚合（实时算，不落库） ---------------------------- */
  function stats(playerId) {
    /* 含 AI 的局不计入任何统计（与云端档案同一口径，见 server/profile.js）。
     * 它们在列表里照样显示，只是带 is-ai 标记。 */
    var list = all(playerId).filter(function (r) { return !r.ai; });
    var n = list.length;
    var wins = 0, losses = 0, flats = 0, totalNet = 0, bestNet = 0;

    for (var i = 0; i < n; i++) {
      var net = list[i].myNet;
      if (net > 0) wins++;
      else if (net < 0) losses++;
      else flats++;
      totalNet += net;
      if (i === 0 || net > bestNet) bestNet = net;
    }

    // 当前连胜：从最新一局往回数，遇到 负 / 平 立即断
    var currentStreak = 0;
    for (var j = 0; j < n; j++) {
      if (list[j].myNet > 0) currentStreak++;
      else break;
    }

    // 最长连胜 / 最长连败：按时间正序（旧 → 新）扫一遍。
    // 口径：只看净胜正负；**平局把连胜和连败都打断**（与 currentStreak 一致）。
    var longestStreak = 0, longestLoseStreak = 0, winRun = 0, loseRun = 0;
    for (var k = n - 1; k >= 0; k--) {
      var v = list[k].myNet;
      if (v > 0) {
        winRun++;
        loseRun = 0;
        if (winRun > longestStreak) longestStreak = winRun;
      } else if (v < 0) {
        loseRun++;
        winRun = 0;
        if (loseRun > longestLoseStreak) longestLoseStreak = loseRun;
      } else {
        winRun = 0;
        loseRun = 0;
      }
    }

    // 最近 10 局：取倒序前 10 条，再反转成正序（左旧右新，可直接渲染趋势条）
    var recent = [];
    var take = Math.min(10, n);
    for (var m = take - 1; m >= 0; m--) {
      var rv = list[m].myNet;
      recent.push(rv > 0 ? 'win' : (rv < 0 ? 'lose' : 'flat'));
    }

    return {
      games: n,
      wins: wins,
      losses: losses,
      flats: flats,
      winRate: n ? Math.round(wins / n * 100) : 0,
      totalNet: totalNet,
      bestNet: n ? bestNet : 0,
      currentStreak: currentStreak,
      longestStreak: longestStreak,
      longestLoseStreak: longestLoseStreak,
      recent: recent
    };
  }

  /**
   * 清空。传 playerId = 只清这个账号的，不传 = 全清。
   *
   * 为什么要分：这台手机可能先后登过好几个号（测试、家人共用）。
   * 「清空我的战绩」不该顺手把别人的也删掉。
   *
   * 注意这里只动本机。云端战绩要走 /api/me/reset-stats ——
   * v50 之前删本机不动云端，才会出现「删了战绩排行榜还在」。
   */
  function clear(playerId) {
    var ls = store();
    if (!ls) return false;
    try {
      if (playerId === undefined || playerId === null) {
        ls.removeItem(KEY);
        ls.removeItem(DEDUPE_FLAG); // 一并清掉迁移标记，下次重新累积时仍能正常判重
        return true;
      }
      var pid = String(playerId);
      var keep = [];
      var src = readAll();
      for (var i = 0; i < src.length; i++) {
        if (!ownedBy(src[i], pid)) keep.push(src[i]);
      }
      if (!keep.length) {
        // 清完一条不剩：直接删 key，别留一个 "[]" 占着位置
        ls.removeItem(KEY);
        return true;
      }
      return !!rawWrite(keep);
    } catch (e) { return false; }
  }

  /* ==================== 已注销玩家的身份抹除（replay 部分） ====================
   *
   * 与 SessionLog.scrub 同一件事、同一套判据，只是对象不同：
   * SessionLog 存的是「整场」的过程，这里存的是每条战绩自带的那一把副本。
   * 两处都有 `i`（playerId）和 `n`（昵称），都可能在别人手机上长期躺着，
   * 所以清理必须两边一起做 —— 只清一处等于没清。
   *
   * 判据仍是「i 和 n 同时为空」= 已注销占位（理由见 SessionLog 里那段注释）。
   */

  function eachReplayRow(list, fn) {
    (Array.isArray(list) ? list : []).forEach(function (r) {
      var rp = r && r.replay;
      if (!rp || !Array.isArray(rp.rounds)) return;
      rp.rounds.forEach(function (rd) {
        if (!rd || !Array.isArray(rd.groups)) return;
        rd.groups.forEach(function (g) {
          if (!g || !Array.isArray(g.rows)) return;
          g.rows.forEach(function (w) {
            if (w) fn(w, g);
          });
        });
      });
    });
  }

  /** 本机战绩（含每条自带的那把副本）里出现过的所有 playerId，去重。 */
  function owners() {
    var seen = Object.create(null);
    var out = [];
    eachReplayRow(readAll(), function (w) {
      var id = String(w.i || '');
      if (id && !seen[id]) { seen[id] = 1; out.push(id); }
    });
    return out;
  }

  /**
   * 把已注销的玩家从每条战绩的 replay 副本里抹掉并写回。
   * @returns {{rows:number, winners:number}} 实际改动数
   */
  function scrubReplays(deadIds) {
    var dead = Object.create(null);
    var src = Array.isArray(deadIds) ? deadIds : [];
    var n = 0;
    for (var d = 0; d < src.length; d++) {
      var id = String(src[d] || '');
      if (id) { dead[id] = 1; n += 1; }
    }
    if (!n) return { rows: 0, winners: 0 };

    var list = readAll();
    if (!list.length) return { rows: 0, winners: 0 };

    /* 先收集昵称再用：清完 row.n 就再也对不上组头的赢家了（同 SessionLog）。 */
    var deadNames = Object.create(null);
    eachReplayRow(list, function (w) {
      var id = String(w.i || '');
      var nm = String(w.n || '');
      if (id && nm && dead[id]) deadNames[nm] = 1;
    });

    var hitRows = 0;
    var hitWinners = 0;
    eachReplayRow(list, function (w, g) {
      var id = String(w.i || '');
      if (id && dead[id]) { w.i = ''; w.n = ''; hitRows += 1; }
      if (g && g.w && deadNames[String(g.w)]) { g.w = ''; hitWinners += 1; }
    });

    if (!hitRows && !hitWinners) return { rows: 0, winners: 0 };
    /* 用 rawWrite 而不是 add：这里改的是已有记录，add 会走判重把整条丢掉。
     * 配额满时 rawWrite 会自己裁（返回 trimmed），不影响正确性。 */
    rawWrite(list);
    return { rows: hitRows, winners: hitWinners };
  }

  return {
    KEY: KEY,
    LIMIT: LIMIT,
    DUP_WINDOW_MS: DUP_WINDOW_MS,
    REPLAY_KEEP: REPLAY_KEEP,
    available: available,
    add: add,
    all: all,
    dedupe: dedupe,
    stats: stats,
    clear: clear,
    owners: owners,
    scrubReplays: scrubReplays
  };
});
