/**
 * 场次过程仓库（整场回放数据层 · 纯 localStorage，零网络请求）
 *
 * 为什么要有这个模块：
 *   `room.history` 是**服务端房间对象上的滚动窗口**，只保留最近 4 条（≈2 把），
 *   因为每次广播都会把它整份下发，放开上限等于让每一帧都多背几十 KB。
 *   于是「看回放」点进去只能看到最后一把 —— 玩家以为数据丢了，
 *   其实前面几把从来没被留下来过。
 *
 * 解决办法不是在服务端加大窗口（那是拿带宽换），而是**每个客户端边看边攒**：
 *   每次房间更新时，把 history 里出现过的 (第几把, 第几轮) 收进本机一份场次档案。
 *   房间对象只发最近两条，但客户端是连续在看的，时间一长整场就齐了。
 *   刷新页面也不会丢（存在 localStorage），这是内存窗口做不到的。
 *
 * 边界（必须写清，别让人以为能回溯到"我加入之前"）：
 *   - 只覆盖**你在线期间**的把次。中途加入、或换了设备，之前那几把本来就没广播给你。
 *   - 场次身份 = roomId + 房间创建时间。同一个 6 位房号被回收后再建房，
 *     createdAt 不同 → 两份档案，不会混成一场。
 *
 * 体积控制是硬要求，而且是**两层**：
 *   ① 结构上限：SESSIONS_MAX 份场次、每场 PACKS_MAX 把、每把 ROUNDS_MAX 轮、
 *      每轮 GROUPS_MAX 组、每组 ROWS_MAX 行、每行 CARDS_MAX 张牌，字段各自截断。
 *   ② 字节预算 BYTES_MAX：结构上限**加起来并不够** —— 四个上限全部拉满时序列化出来
 *      能到 5 MB 以上，直接顶穿 localStorage 配额。所以写完还要按体积再削一遍：
 *      先丢最旧的场次，还不够就把最新那场里最旧的把次丢掉。
 *   丢的都是**过程**，不影响战绩本身；配额真爆了也不抛错（会打断 WebSocket 回调），
 *   只是这一批没存上。
 */
(function (global, factory) {
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = mod;
  } else {
    global.SessionLog = mod;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ST = (typeof LXW !== 'undefined' && LXW.Store) || null;
  if (!ST && typeof require === 'function') {
    try { ST = require('./storage.js'); } catch (e) { ST = null; }
  }
  var KEY = ST ? ST.KEYS.SESSIONS : 'lxw_sessions_v1';
  var SESSIONS_MAX = 4;    // 留最近 4 场（一场 = 一个人坐下来打到散的那一局）
  var PACKS_MAX = 24;      // 每场最多 24 把
  var ROUNDS_MAX = 4;      // 每把最多 4 轮（现在配置是 2 轮，留余量但不放任）
  var GROUPS_MAX = 6;
  var ROWS_MAX = 12;
  var CARDS_MAX = 6;
  var ID_MAX = 24;
  var NAME_MAX = 20;
  var LABEL_MAX = 10;
  var TYPE_MAX = 12;
  /* 字节预算：按 UTF-16 码元算（localStorage 的配额是这么计的）。
   * 40 万码元 ≈ 上限的 8%，剩下的留给战绩缓存、登录态那些更重要的 key。
   * 这个数字是**量出来的**，不是拍的：session-log.test.js 第 8 节会把四个结构上限
   * 全部拉满，断言削峰之后仍然落在预算内。 */
  var BYTES_MAX = 400 * 1024;

  function num(v, dflt) {
    var n = Number(v);
    return isFinite(n) ? n : dflt;
  }

  function clip(v, max) {
    if (v === null || v === undefined) return '';
    var s = String(v);
    return s.length > max ? s.slice(0, max) : s;
  }

  /* 场次身份：房号 + 房间创建时间。
   * 只用房号是不够的 —— 6 位房号会被回收，同一个人过两天再建房拿到同一个号，
   * 两份完全不相关的过程会拼成一场，看回放时时间线会倒流。 */
  function keyOf(room) {
    if (!room || !room.roomId) return '';
    return String(room.roomId) + '#' + Math.round(num(room.createdAt, 0));
  }

  function readAll() {
    if (!ST) return [];
    var raw = ST.read(KEY, '');
    if (!raw) return [];
    var parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { return []; }
    if (!parsed || !Array.isArray(parsed)) return [];
    return parsed;
  }

  /* 按体积削峰：结构上限不够用的时候（四个上限同时拉满能到 5 MB 以上），
   * 先丢最旧的场次，再把最新那场里最旧的把次丢掉。
   * list 进来时已按 updatedAt 倒序，所以丢末尾 = 丢最旧。 */
  function trimToBudget(list) {
    var s = '';
    try { s = JSON.stringify(list); } catch (e) { return ''; }
    while (s.length > BYTES_MAX && list.length > 1) {
      list.pop();
      try { s = JSON.stringify(list); } catch (e) { return ''; }
    }
    /* 只剩一场还超，就削这一场里最旧的把次（回放还能看到最近那些，
     * 比整场都没有强；「共 N 把」也会跟着变准）。 */
    while (s.length > BYTES_MAX && list[0] && Array.isArray(list[0].packs) && list[0].packs.length > 1) {
      list[0].packs.shift();
      try { s = JSON.stringify(list); } catch (e) { return ''; }
    }
    return s;
  }

  function writeAll(list) {
    if (!ST) return false;
    var payload = trimToBudget(list);
    if (!payload) return false;
    return ST.write(KEY, payload);
  }

  /* 外部传进来的结构一律重新裁一遍：这是一份会被写进 localStorage 的数据，
   * 一个字段漏检查、一场攒下来就能把配额顶满，而配额满了会让整页战绩都读不出来。 */
  function saneGroup(g) {
    if (!g || typeof g !== 'object') return null;
    var rows = [];
    var src = Array.isArray(g.rows) ? g.rows : [];
    for (var i = 0; i < src.length && rows.length < ROWS_MAX; i++) {
      var w = src[i];
      if (!w) continue;
      var cards = [];
      if (Array.isArray(w.c)) {
        for (var j = 0; j < w.c.length && cards.length < CARDS_MAX; j++) cards.push(clip(w.c[j], 6));
      }
      /* i 不能丢：回放里标「我」靠 id（昵称会重名）。 */
      rows.push({ i: clip(w.i, ID_MAX), n: clip(w.n, NAME_MAX), c: cards, d: Math.round(num(w.d, 0)) });
    }
    return { l: clip(g.l, LABEL_MAX), w: clip(g.w, NAME_MAX), t: clip(g.t, TYPE_MAX), rows: rows };
  }

  function saneRound(r) {
    if (!r || typeof r !== 'object') return null;
    var groups = [];
    var src = Array.isArray(r.groups) ? r.groups : [];
    for (var i = 0; i < src.length && groups.length < GROUPS_MAX; i++) {
      var g = saneGroup(src[i]);
      if (g) groups.push(g);
    }
    if (!groups.length) return null;
    return { r: Math.max(1, Math.round(num(r.r, 1)) || 1), groups: groups };
  }

  /* 一把的存档形态：{ hands, no, g, rounds }。
   *
   * hands 是身份（hid），no 是本局第几把（显示用），g 是局号 —— 三者含义不同，
   * 上一版只留了 hands 一个，于是「显示序号」只能借用身份号，房间打第二局时
   * 回放标题从「第 4 把」开始。这里若只留一个字段，那个 bug 会从 localStorage
   * 这一层重新长回来（内存里修好、刷新一次就复发）。
   *
   * 老存档没有 no / g：no 退回 hands（保持原样），g 归 0（不分局）。 */
  function sanePack(p) {
    if (!p || typeof p !== 'object') return null;
    var rounds = [];
    var src = Array.isArray(p.rounds) ? p.rounds : [];
    for (var i = 0; i < src.length && rounds.length < ROUNDS_MAX; i++) {
      var rd = saneRound(src[i]);
      if (rd) rounds.push(rd);
    }
    if (!rounds.length) return null;
    var hands = Math.max(1, Math.round(num(p.hands, 1)) || 1);
    return {
      hands: hands,
      no: Math.max(1, Math.round(num(p.no, hands)) || 1),
      g: Math.max(0, Math.round(num(p.g, 0)) || 0),
      rounds: rounds
    };
  }

  function sortedPacks(packs) {
    packs.sort(function (a, b) { return (a.hands || 1) - (b.hands || 1); });
    for (var i = 0; i < packs.length; i++) {
      packs[i].rounds.sort(function (a, b) { return (a.r || 1) - (b.r || 1); });
    }
    return packs;
  }

  /**
   * 吸收一批过程（幂等：同一 (第几把, 第几轮) 只存第一次见到的那份）。
   *
   * @param {object} entry { key, roomId, startedAt, packs:[{hands, rounds}] }
   * @returns {{added:number, kept:number}}  added = 本轮真正新增的轮次数
   */
  function absorb(entry) {
    if (!entry || !entry.key) return { added: 0, kept: 0 };
    var packs = [];
    var src = Array.isArray(entry.packs) ? entry.packs : [];
    for (var i = 0; i < src.length; i++) {
      var p = sanePack(src[i]);
      if (p) packs.push(p);
    }
    if (!packs.length) return { added: 0, kept: 0 };

    var all = readAll();
    var target = null;
    for (var j = 0; j < all.length; j++) {
      if (all[j] && all[j].key === entry.key) { target = all[j]; break; }
    }
    if (!target) {
      target = { key: String(entry.key), roomId: clip(entry.roomId, 12), startedAt: Math.round(num(entry.startedAt, 0)) || Date.now(), packs: [] };
      all.push(target);
    }
    target.packs = Array.isArray(target.packs) ? target.packs : [];

    var added = 0;
    for (var m = 0; m < packs.length; m++) {
      var pack = packs[m];
      var hit = null;
      for (var n = 0; n < target.packs.length; n++) {
        if (Number(target.packs[n].hands) === pack.hands) { hit = target.packs[n]; break; }
      }
      if (!hit) {
        hit = { hands: pack.hands, no: pack.no, g: pack.g, rounds: [] };
        target.packs.push(hit);
      } else {
        /* 老存档里可能缺 no/g（或者是先被老版本写进去的）。新数据到了就补上，
         * 不用整场清空重来 —— 清空等于把玩家已经攒下的过程丢掉。
         * 判据用 typeof 而不是真值：g = 0 是合法的「第 1 局」，`!0` 会把它当缺失。 */
        if (typeof hit.no !== 'number' && typeof pack.no === 'number') hit.no = pack.no;
        if (typeof hit.g !== 'number' && typeof pack.g === 'number') hit.g = pack.g;
      }
      for (var q = 0; q < pack.rounds.length; q++) {
        var rd = pack.rounds[q];
        var has = false;
        for (var w = 0; w < hit.rounds.length; w++) {
          if (Number(hit.rounds[w].r) === rd.r) { has = true; break; }
        }
        if (!has) { hit.rounds.push(rd); added++; }
      }
    }
    if (!added) return { added: 0, kept: target.packs.length };

    sortedPacks(target.packs);
    if (target.packs.length > PACKS_MAX) target.packs = target.packs.slice(-PACKS_MAX);
    target.updatedAt = Date.now();

    /* 场次之间按「最近写入」排序，超出 SESSIONS_MAX 的从最旧开始丢。 */
    all.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    if (all.length > SESSIONS_MAX) all = all.slice(0, SESSIONS_MAX);
    writeAll(all);
    return { added: added, kept: target.packs.length };
  }

  /** 取一场的过程。没有就返回 null（调用方要能自己兜底到单把 replay）。 */
  function load(key) {
    if (!key) return null;
    var all = readAll();
    for (var i = 0; i < all.length; i++) {
      var s = all[i];
      if (!s || s.key !== key) continue;
      var packs = [];
      var src = Array.isArray(s.packs) ? s.packs : [];
      for (var j = 0; j < src.length; j++) {
        var p = sanePack(src[j]);
        if (p) packs.push(p);
      }
      if (!packs.length) return null;
      sortedPacks(packs);
      return { key: s.key, roomId: s.roomId, startedAt: s.startedAt, packs: packs };
    }
    return null;
  }

  /** 给界面用的一句话摘要：「整场 9 把」。数据缺失时返回空串，别编数字。 */
  function describe(session) {
    if (!session || !session.packs || !session.packs.length) return '';
    return '整场 ' + session.packs.length + ' 把';
  }

  function clear() {
    if (!ST) return false;
    return ST.remove(KEY);
  }

  /** 排查 / 测试用：直接看库存里有几场、各几把。 */
  function inspect() {
    var all = readAll();
    return all.map(function (s) {
      return { key: s && s.key, roomId: s && s.roomId, packs: (s && Array.isArray(s.packs)) ? s.packs.length : 0 };
    });
  }

  /* ======================== 已注销玩家的身份抹除 ========================
   *
   * 删号能覆盖的边界是「服务端 + 本人的设备」。你和别人打过的回放副本存在
   * **对方的手机上**，服务端碰不到 —— 唯一可行的时机是对方下次打开回放时，
   * 由他自己在本地把名字抹掉。这个模块负责那一步的本地部分。
   *
   * 为什么是「抹字段」而不是「删整行」：
   *   整行删掉会破坏回放结构 —— 1v1 局删掉对手那行就只剩一个人，
   *   渲染出来像一副没打完的牌。而回放的价值在于「这把牌怎么走的」，
   *   不在于「对手叫什么」。所以留下牌和分数，只清掉能指向人的那两个字段。
   *
   * 判据统一为「i 和 n 同时为空」= 已注销占位。
   *   正常数据不会两者同时为空：服务端结算的 entries 一定带 id 和昵称。
   *   老数据可能 i 有值而 n 为空，那属于「不知道名字」，不是「已注销」，
   *   两者混起来会让老记录凭空变成「已注销玩家」。
   */

  /* 遍历所有行。回调拿到 (row, group) —— group 也要一起给：
   * 组头的赢家字段 w 存的是昵称，早晚要跟着一起清。 */
  function eachRow(list, fn) {
    (Array.isArray(list) ? list : []).forEach(function (s) {
      if (!s) return;
      (Array.isArray(s.packs) ? s.packs : []).forEach(function (p) {
        if (!p) return;
        (Array.isArray(p.rounds) ? p.rounds : []).forEach(function (rd) {
          if (!rd) return;
          (Array.isArray(rd.groups) ? rd.groups : []).forEach(function (g) {
            if (!g) return;
            (Array.isArray(g.rows) ? g.rows : []).forEach(function (w) {
              if (w) fn(w, g);
            });
          });
        });
      });
    });
  }

  /** 这份存储里出现过的所有 playerId（去重）。调用方拿它去问服务端谁注销了。 */
  function owners() {
    var seen = Object.create(null);
    var out = [];
    eachRow(readAll(), function (w) {
      var id = String(w.i || '');
      if (id && !seen[id]) { seen[id] = 1; out.push(id); }
    });
    return out;
  }

  /**
   * 把已注销的玩家从回放里抹掉，并写回磁盘。
   * @param {string[]} deadIds 服务端说已经不存在了的 playerId
   * @returns {{rows:number, winners:number}}  实际改动数
   */
  function scrub(deadIds) {
    var dead = Object.create(null);
    var src = Array.isArray(deadIds) ? deadIds : [];
    var n = 0;
    for (var d = 0; d < src.length; d++) {
      var id = String(src[d] || '');
      if (id) { dead[id] = 1; n += 1; }
    }
    if (!n) return { rows: 0, winners: 0 };

    var all = readAll();
    if (!all.length) return { rows: 0, winners: 0 };

    /* 第一遍：收集「已注销的人用过的昵称」。
     * 必须在清空 row.n **之前**做 —— 清完就再也对不上组头那个名字了。
     * 昵称在服务端是唯一的（nickKey 去空白 + 忽略大小写），所以这层映射成立。 */
    var deadNames = Object.create(null);
    eachRow(all, function (w) {
      var id = String(w.i || '');
      var nm = String(w.n || '');
      if (id && nm && dead[id]) deadNames[nm] = 1;
    });

    var hitRows = 0;
    var hitWinners = 0;
    eachRow(all, function (w, g) {
      var id = String(w.i || '');
      if (id && dead[id]) {
        w.i = '';
        w.n = '';
        hitRows += 1;
      }
      /* 组头也清：不清的话回放里会出现「已注销玩家出了这些牌，小明赢」——
       * 人抹了、名字还在，等于没抹。 */
      if (g && g.w && deadNames[String(g.w)]) { g.w = ''; hitWinners += 1; }
    });

    if (!hitRows && !hitWinners) return { rows: 0, winners: 0 };
    writeAll(all);     // 写回失败就算了：下次打开还会再抹一遍，不会更糟
    return { rows: hitRows, winners: hitWinners };
  }

  return {
    KEY: KEY,
    SESSIONS_MAX: SESSIONS_MAX,
    PACKS_MAX: PACKS_MAX,
    BYTES_MAX: BYTES_MAX,
    keyOf: keyOf,
    absorb: absorb,
    load: load,
    describe: describe,
    clear: clear,
    inspect: inspect,
    owners: owners,
    scrub: scrub
  };
});
