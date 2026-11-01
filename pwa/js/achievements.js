/**
 * 成就系统（纯逻辑，无 DOM / 无 IO，双端同源）
 *
 *   前端 pwa/   → <script src="js/achievements.js"> → global.Ach
 *   服务端       → require('../pwa/js/achievements.js') → 统计与落库
 *
 * 为什么只有一份：「哪种牌型算大牌」这种东西，前端页面要显示、
 * 服务端要统计。两边各写一份的结局一定是「页面上写着 7 次、服务器记了 5 次」——
 * 本项目已经被同类问题咬过（hub.js 私抄 MAX_PLAYERS）。
 *
 * ── 口径（改之前先读这三条）──────────────────────────────────────────
 *
 * 1. **只统计大牌型，不统计普通牌型。**
 *    大牌型清单见 BIG_TYPES。十点半只认「10.5点」（typeName 的实际输出，
 *    不是中文「十点半」），斗牛认牛牛与五花牛，飘三叶认同花顺与豹子。
 *
 * 2. **概率的分母是「参与该组的次数」，不是「打了多少把」。**
 *    理由：一把里斗牛只出现 1 次、十点半也只出现 1 次，拿把数做分母会把
 *    概率系统性稀释一半；而飘三叶的大牌型有 2 种、斗牛也有 2 种，
 *    它们必须共用同一个分母才有横向可比性。
 *
 * 3. **对撞（虎口夺食 / 豹落平阳）的分母不是全部对局。**
 *    只有在「自己也拿了大牌型、且同组至少还有一个人也拿了大牌型」时才计入分母。
 *    吃掉一手普通牌不算对撞 —— 那不是运气对撞，那是正常赢。
 *
 * ── 数据从哪来 ──────────────────────────────────────────────────
 *
 * 状态机每轮结算（settleRound）时调 accumulate() 累加到 room.achRun，
 * 整局结束由 hub._persistSettlement 合并进档案。之所以不在结算时读
 * room.history：那个数组只保留最近 4 轮（2 把），打满 10 把的局会被截断。
 */
(function (global, factory) {
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = mod;
  } else {
    global.Ach = mod;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 大牌型清单：mode → typeName 白名单。
   *
   * ★ 这些字符串必须与 engine.js 里 typeName() 的输出**逐字一致**。
   *   十点半输出的是点数（'10.5点' / '爆牌' / '9点'），不是「十点半」这三个字；
   *   斗牛输出 '牛牛' / '牛9' … / '没牛' / '五花牛'。
   *   写错一个字的后果不是报错，是「这个成就永远拿不到」——最难查的那类 bug。
   *   下面 test 里有一条断言直接对着 Engine.typeName 核，改 engine 命名会被它拦住。 */
  var BIG_TYPES = {
    tenhalf: ['10.5点'],
    piaosanye: ['同花顺', '豹子'],
    douniu: ['牛牛', '五花牛']
  };

  /* typeKey：大牌型的稳定短 id。存库用短键，因为 profiles.json 里
   * 每个玩家都会带一份，而 MAX_PROFILES 是 20 万（见 profile.js）。 */
  var TYPE_KEY = {
    'tenhalf:10.5点': 'th',
    'piaosanye:同花顺': 'sf',
    'piaosanye:豹子': 'lp',
    'douniu:牛牛': 'nn',
    'douniu:五花牛': 'wh'
  };

  /* 展示用的牌型表（顺序是有意的：按「稀有度从高到低」排，页面第一眼看到的是最难的那个） */
  var TYPE_ROWS = [
    { key: 'wh', label: '五花牛', mode: 'douniu', rarity: 'legend' },
    { key: 'sf', label: '同花顺', mode: 'piaosanye', rarity: 'legend' },
    { key: 'lp', label: '豹子', mode: 'piaosanye', rarity: 'epic' },
    { key: 'nn', label: '牛牛', mode: 'douniu', rarity: 'normal' },
    { key: 'th', label: '十点半', mode: 'tenhalf', rarity: 'rare' }
  ];

  var RARITY_LABEL = { normal: '普通', rare: '稀有', epic: '史诗', legend: '传说' };
  var SERIES_LABEL = { type: '牌型', vs: '对撞', sweep: '通吃', record: '战绩' };

  function num(v) { return Number(v) || 0; }

  /** 纯计数（不含 v / since）。房间里的增量桶用它：
   * 一个房间有 N 个人，就 N 份，各自独立 —— 合并到一起就分不清是谁拿的了。 */
  function blankCounts() {
    return {
      t: {},           // 牌型命中次数：{ th, sf, lp, nn, wh }
      n: {},           // 分母：这个人参与该模式组的次数 { tenhalf, piaosanye, douniu }
      vs: 0,           // 对撞赢（自己大牌型、对手也大牌型，我吃）
      vsl: 0,          // 对撞输（被更大的吃）
      vsn: 0,          // 对撞分母（大牌撞大牌的次数）
      s1: 0,           // 第一轮 3 组全赢
      s2: 0,           // 第二轮 2 组全赢
      sa: 0,           // 一把 5 组全赢
      sw: 0,           // 通吃总次数（s1+s2，不含 sa 额外加权）
      r7: 0,           // 连败 3 把后赢出新的单场最高
      r8: 0            // 打满 30 把的把数
    };
  }

  /** 档案里的成就桶：计数 + 结构版本 + 起始时刻。
   * **新增计数字段必须同时加到 blankCounts() 与 mergeInto()**，
   * 否则新成就会永远停在 0（mergeInto 不认的键不会被落库）。 */
  function blank() {
    var b = blankCounts();
    b.v = 1;
    b.since = 0;       // 首次统计时刻（毫秒）。页面要显示「从哪天起记录」
    return b;
  }

  /**
   * 把「本轮增量」合并进「档案累计」。
   *
   * ★ 这是**白名单合并**，不是 Object.assign：
   *   room.achRun 上有 _r1 这种只在房间内临时用的字段（记录上一轮谁全赢，
   *   用来判「一把五组全胜」），它不该进档案 —— 它只对当前这把有意义，
   *   落进档案后下一页就成了脏数据，而且永远清不掉。
   */
  function mergeInto(dst, run) {
    if (!run) return dst;
    if (!dst || typeof dst !== 'object') dst = blank();
    if (!dst.t || typeof dst.t !== 'object') dst.t = {};
    if (!dst.n || typeof dst.n !== 'object') dst.n = {};
    if (!num(dst.since)) dst.since = num(run.since) || Date.now();

    COUNT_KEYS.forEach(function (k) {
      if (run[k] == null) return;
      dst[k] = num(dst[k]) + num(run[k]);
    });
    Object.keys(run.t || {}).forEach(function (k) {
      /* 只认目录里有的键：老版本写的野字段（比如以后改了 typeKey）
       * 不带进新档案，否则会一直跟着这个人走 */
      if (!TYPE_KEY_KNOWN[k]) return;
      dst.t[k] = num(dst.t[k]) + num(run.t[k]);
    });
    Object.keys(run.n || {}).forEach(function (k) {
      if (!MODE_KNOWN[k]) return;
      dst.n[k] = num(dst.n[k]) + num(run.n[k]);
    });
    return dst;
  }

  var COUNT_KEYS = ['vs', 'vsl', 'vsn', 's1', 's2', 'sa', 'sw', 'r7', 'r8'];
  var TYPE_KEY_KNOWN = { th: 1, sf: 1, lp: 1, nn: 1, wh: 1 };
  var MODE_KNOWN = { tenhalf: 1, piaosanye: 1, douniu: 1 };

  /**
   * 累加一轮结算。
   *
   * @param {object} run   room.achRun（不存在就传 null）
   *        形状：`{ byPid: { [playerId]: blankCounts() }, _r1: { [playerId]: 1 } }`
   *        ★ **按玩家分桶**是这个数据结构存在的唯一理由。第一版写成「一个房间一个桶」，
   *          结果甲拿的豹子记到了乙头上 —— 落库时两个人拿到同一份数。
   *          跑一个两人局的端到端测试就看得见（achievements-e2e.test.js 就是为它写的）。
   * @param {number} round 1 或 2
   * @param {Array}  groups 状态机 settleRound 里的 results：
   *        [{ group:'douniu', winnerId, entries:[{id,typeName}] }]
   * @returns {object} 就地修改后的 run（同时返回，方便 `run = accumulate(...)`）
   */
  function accumulate(run, round, groups) {
    if (!run || typeof run !== 'object' || !run.byPid) run = { byPid: {}, _r1: {} };
    if (!run._r1 || typeof run._r1 !== 'object') run._r1 = {};

    function bucketOf(pid) {
      if (!run.byPid[pid]) run.byPid[pid] = blankCounts();
      var b = run.byPid[pid];
      if (!b.t || typeof b.t !== 'object') b.t = {};
      if (!b.n || typeof b.n !== 'object') b.n = {};
      return b;
    }

    var list = Array.isArray(groups) ? groups : [];
    if (!list.length) return run;

    var wins = {};   // 本轮各组赢家 → 赢了几组

    list.forEach(function (g) {
      if (!g) return;
      var mode = g.group;
      var entries = (g.entries || []).filter(function (e) {
        /* 弃权（手牌为空）不算参与：他没出牌，不该进任何分母。
         * typeName 是 '弃权' 正是 engine 对手牌为空的判定。 */
        return e && e.id && e.typeName && e.typeName !== '弃权';
      });
      if (!entries.length) return;

      var bigIds = [];
      entries.forEach(function (e) {
        var b = bucketOf(e.id);
        /* 分母按**人**计：每参与一次该模式组 +1。
         * 所以「十点半出现率 50%」的含义是「我打过的十点半里有一半拿到 10.5」，
         * 而不是「全场有一半的十点半是 10.5」。 */
        if (MODE_KNOWN[mode]) b.n[mode] = num(b.n[mode]) + 1;
        var k = TYPE_KEY[mode + ':' + e.typeName];
        if (k) { b.t[k] = num(b.t[k]) + 1; bigIds.push(e.id); }
      });

      /* 对撞：至少两个人拿大牌型才计入 */
      if (bigIds.length >= 2) {
        bigIds.forEach(function (id) {
          var b = bucketOf(id);
          b.vsn = num(b.vsn) + 1;
          if (id === g.winnerId) b.vs = num(b.vs) + 1;
          else b.vsl = num(b.vsl) + 1;
        });
      }

      if (g.winnerId) wins[g.winnerId] = num(wins[g.winnerId]) + 1;
    });

    /* 通吃：本轮所有组都赢。
     * 用 list.length 而不是写死 3 / 2 —— 组数由 ROUND_GROUPS 决定，
     * 哪天改成分组数量，这里不该跟着改。 */
    var total = list.length;
    Object.keys(wins).forEach(function (pid) {
      if (num(wins[pid]) !== total) return;
      var b = bucketOf(pid);
      if (round === 1) {
        /* 记下这一轮谁全赢，第 2 轮结算时才有办法判「一把五组全胜」 */
        run._r1[pid] = 1;
        b.s1 = num(b.s1) + 1;
        b.sw = num(b.sw) + 1;
      } else {
        b.s2 = num(b.s2) + 1;
        b.sw = num(b.sw) + 1;
        if (run._r1[pid]) b.sa = num(b.sa) + 1;
      }
    });

    return run;
  }

  /** 从房间增量里取某个人的桶（落库用）。取不到返回 null。 */
  function runOf(run, playerId) {
    if (!run || !run.byPid) return null;
    return run.byPid[String(playerId)] || null;
  }

  /* ============================ 成就目录 ============================
   *
   * 判定函数统一签名 (ctx) => boolean，ctx 里是：
   *   t / n / vs / vsl / vsn / s1 / s2 / sa / sw / r7 / r8 / games / streak / bestNet
   *
   * 每个成就同时给 cur / need，页面就能画进度条（「7 / 10」而不是只有「未达成」）。
   * 只给布尔判定的话，玩家永远不知道自己差多少 —— 这是这类系统最常见的浪费。
   */
  function g(ctx, k) { return num(ctx && ctx[k]); }
  function tn(ctx, k) { return num(ctx && ctx.t && ctx.t[k]); }

  var CATALOG = [
    /* ---------- 系列一 · 牌型 ---------- */
    { id: 'h1', series: 'type', rarity: 'rare', name: '刚好十点半',
      desc: '不多不少，正好 10.5。多一点是爆，少一点是输',
      cur: function (c) { return tn(c, 'th'); }, need: 1 },
    { id: 'h2', series: 'type', rarity: 'epic', name: '十点半成瘾',
      desc: '十次卡在这条线上，你已经知道那半张牌该往哪放',
      cur: function (c) { return tn(c, 'th'); }, need: 10 },
    { id: 'h3', series: 'type', rarity: 'rare', name: '豹纹加身',
      desc: '三张一样的牌。第一次穿上这件外套',
      cur: function (c) { return tn(c, 'lp'); }, need: 1 },
    { id: 'h4', series: 'type', rarity: 'epic', name: '豹子头',
      desc: '十次豹子，牌桌上有人开始怕你了',
      cur: function (c) { return tn(c, 'lp'); }, need: 10 },
    { id: 'h5', series: 'type', rarity: 'epic', name: '一气呵成',
      desc: '同花顺——既要同花，又要连号，还得是同一组牌',
      cur: function (c) { return tn(c, 'sf'); }, need: 1 },
    { id: 'h6', series: 'type', rarity: 'legend', name: '同花顺专业户',
      desc: '五次同花顺。到这一步，运气已经不是主要解释了',
      cur: function (c) { return tn(c, 'sf'); }, need: 5 },
    { id: 'h7', series: 'type', rarity: 'normal', name: '牛气冲天',
      desc: '五张凑出一个整十，剩下两张再凑出个牛',
      cur: function (c) { return tn(c, 'nn'); }, need: 1 },
    { id: 'h8', series: 'type', rarity: 'epic', name: '牛魔王',
      desc: '三十次牛牛。你大概是靠这个吃饭的',
      cur: function (c) { return tn(c, 'nn'); }, need: 30 },
    { id: 'h9', series: 'type', rarity: 'legend', name: '五朵金花',
      desc: '五张全是花牌，全程没让数字出现',
      cur: function (c) { return tn(c, 'wh'); }, need: 1 },
    { id: 'h10', series: 'type', rarity: 'legend', name: '花牛成精',
      desc: '五次五花牛。见过的人都记住了',
      cur: function (c) { return tn(c, 'wh'); }, need: 5 },

    /* ---------- 系列二 · 对撞 ---------- */
    { id: 'c1', series: 'vs', rarity: 'epic', name: '虎口夺食',
      desc: '对方也拿着大牌型，你还是把他吃了',
      cur: function (c) { return g(c, 'vs'); }, need: 1 },
    { id: 'c2', series: 'vs', rarity: 'rare', name: '豹落平阳',
      desc: '你拿着大牌，遇上了更大的那一手。输得不冤',
      cur: function (c) { return g(c, 'vsl'); }, need: 1 },
    { id: 'c4', series: 'vs', rarity: 'epic', name: '牌桌屠夫',
      desc: '二十次硬碰硬赢下来。你专挑有牌的人下手',
      cur: function (c) { return g(c, 'vs'); }, need: 20 },
    { id: 'c3', series: 'vs', rarity: 'legend', name: '强者运强',
      desc: '大牌对撞十次以上，还赢下六成。运气这次站在强的那边',
      cur: function (c) { return g(c, 'vsn'); }, need: 10,
      /* 双条件成就：把「胜率」塞进 extra 里单独判，
       * 页面上的进度条按分母走（撞够 10 次），达不达成看 extra */
      extra: function (c) { return g(c, 'vsn') > 0 && g(c, 'vs') / g(c, 'vsn') >= 0.6; } },

    /* ---------- 系列三 · 通吃 ---------- */
    { id: 's1', series: 'sweep', rarity: 'epic', name: '一巡清场',
      desc: '第一轮三组全赢。这一轮没你的事，只有你的分',
      cur: function (c) { return g(c, 's1'); }, need: 1 },
    { id: 's2', series: 'sweep', rarity: 'rare', name: '双杀',
      desc: '第二轮两组全赢。收尾的时候你才动手',
      cur: function (c) { return g(c, 's2'); }, need: 1 },
    { id: 's3', series: 'sweep', rarity: 'legend', name: '五子登科',
      desc: '一把里五组全赢。别人只能看着你收',
      cur: function (c) { return g(c, 'sa'); }, need: 1 },
    { id: 's4', series: 'sweep', rarity: 'epic', name: '常胜将军',
      desc: '通吃十次。不管一轮还是两轮，反正都是你的',
      cur: function (c) { return g(c, 'sw'); }, need: 10 },

    /* ---------- 系列四 · 战绩（全部基于已有字段） ---------- */
    { id: 'r1', series: 'record', rarity: 'normal', name: '第一次',
      desc: '你的第一把牌打完了。往后还有很多把',
      cur: function (c) { return g(c, 'games'); }, need: 1 },
    { id: 'r2', series: 'record', rarity: 'normal', name: '常客',
      desc: '十场。牌桌上开始有人认得你的名字',
      cur: function (c) { return g(c, 'games'); }, need: 10 },
    { id: 'r3', series: 'record', rarity: 'epic', name: '老油条',
      desc: '一百场。你比大多数人都懂这套规则是怎么转的',
      cur: function (c) { return g(c, 'games'); }, need: 100 },
    { id: 'r4', series: 'record', rarity: 'rare', name: '势不可挡',
      desc: '连赢五把。中间任何一把失手都得从头再来',
      cur: function (c) { return g(c, 'streak'); }, need: 5 },
    { id: 'r5', series: 'record', rarity: 'legend', name: '十连胜',
      desc: '连赢十把。这已经不是运气能解释的了',
      cur: function (c) { return g(c, 'streak'); }, need: 10 },
    { id: 'r6', series: 'record', rarity: 'rare', name: '一夜暴富',
      desc: '单把净胜 15 分以上。这一把够别人打三把',
      cur: function (c) { return g(c, 'bestNet'); }, need: 15 },
    { id: 'r7', series: 'record', rarity: 'epic', name: '翻身农奴',
      desc: '连输三把之后，下一把赢出你个人的单场最高',
      cur: function (c) { return g(c, 'r7'); }, need: 1 },
    { id: 'r8', series: 'record', rarity: 'rare', name: '人间清醒',
      desc: '陪一桌人打满 30 把。全场最长的那一档，你走完了',
      cur: function (c) { return g(c, 'r8'); }, need: 1 }
  ];

  /**
   * 把「档案 + 战绩」摊平成判定上下文，逐条算进度。
   *
   * @param {object} ach    档案里的 ach
   * @param {object} stats  { games, longestStreak, bestNet }
   * @returns {{list:Array, unlocked:number, total:number, bySeries:object}}
   */
  function evaluate(ach, stats) {
    stats = stats || {};
    var a = ach && typeof ach === 'object' ? ach : blank();
    var ctx = {
      t: a.t || {}, n: a.n || {},
      vs: num(a.vs), vsl: num(a.vsl), vsn: num(a.vsn),
      s1: num(a.s1), s2: num(a.s2), sa: num(a.sa), sw: num(a.sw),
      r7: num(a.r7), r8: num(a.r8),
      games: num(stats.games), streak: num(stats.longestStreak), bestNet: num(stats.bestNet)
    };

    var unlocked = 0;
    var bySeries = {};
    var list = CATALOG.map(function (def) {
      var cur = Math.max(0, num(def.cur(ctx)));
      var need = def.need || 1;
      var ok = cur >= need;
      /* 双条件成就（强者运强）：进度条按分母走，达不达成还要看 extra */
      if (ok && typeof def.extra === 'function') ok = !!def.extra(ctx);
      if (ok) unlocked += 1;
      if (!bySeries[def.series]) bySeries[def.series] = { total: 0, unlocked: 0 };
      bySeries[def.series].total += 1;
      if (ok) bySeries[def.series].unlocked += 1;
      return {
        id: def.id, series: def.series, rarity: def.rarity,
        seriesLabel: SERIES_LABEL[def.series] || '',
        rarityLabel: RARITY_LABEL[def.rarity] || '',
        name: def.name, desc: def.desc,
        cur: Math.min(cur, need), raw: cur, need: need,
        ok: ok
      };
    });

    return { list: list, unlocked: unlocked, total: list.length, bySeries: bySeries };
  }

  /**
   * 牌型 / 对撞的统计表（页面顶部的「你的牌型」区）。
   * 概率一律是 `命中 / 参与该组次数`，分母为 0 时返回 null（不是 0%）——
   * 「还没打过」和「打过但从没拿到」是两件不同的事，用 0% 会把它们混成一件。
   */
  function typeStats(ach) {
    var a = ach && typeof ach === 'object' ? ach : blank();
    var t = a.t || {}, n = a.n || {};
    var rows = TYPE_ROWS.map(function (r) {
      var hit = num(t[r.key]);
      var seen = num(n[r.mode]);
      return {
        key: r.key, label: r.label, rarity: r.rarity,
        rarityLabel: RARITY_LABEL[r.rarity] || '',
        hit: hit, seen: seen,
        rate: seen > 0 ? hit / seen : null
      };
    });
    var vsn = num(a.vsn);
    return {
      types: rows,
      vs: {
        win: num(a.vs), lose: num(a.vsl), total: vsn,
        rate: vsn > 0 ? num(a.vs) / vsn : null
      },
      sweep: { s1: num(a.s1), s2: num(a.s2), sa: num(a.sa), total: num(a.sw) },
      since: num(a.since)
    };
  }

  /** 「2026-11-01」这种日期串（页面写「从 X 起记录」）。传 0 返回空串。 */
  function sinceText(ms) {
    var v = num(ms);
    if (!v) return '';
    var d = new Date(v);
    if (isNaN(d.getTime())) return '';
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }

  /** 只取已解锁的数量（点头像看别人时用，不需要整份列表） */
  function countOf(ach, stats) {
    return evaluate(ach, stats).unlocked;
  }

  return {
    BIG_TYPES: BIG_TYPES,
    TYPE_ROWS: TYPE_ROWS,
    CATALOG: CATALOG,
    RARITY_LABEL: RARITY_LABEL,
    SERIES_LABEL: SERIES_LABEL,
    TOTAL: CATALOG.length,

    blank: blank,
    blankCounts: blankCounts,
    mergeInto: mergeInto,
    accumulate: accumulate,
    runOf: runOf,
    evaluate: evaluate,
    typeStats: typeStats,
    sinceText: sinceText,
    countOf: countOf
  };
});
