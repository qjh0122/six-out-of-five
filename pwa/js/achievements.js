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

  /* 小牌型清单（v112 新增）：每种牌组的**最差**那一档。
   *
   * 为什么要单独列：大牌型是「拿到就高兴」，小牌型是「拿到就知道这组没了」。
   * 玩家对后者的记忆点更强（一桌人全爆的场面比一个豹子更常被提起），
   * 而原来的成就系统只统计高光，等于只记喜不记悲。
   *
   * 注意字符串同样是 engine 的 typeName 输出，逐字一致：
   *   十点半爆了叫「爆牌」，飘三叶最低叫「散牌」，斗牛没凑出来叫「没牛」。 */
  var SMALL_TYPES = {
    tenhalf: ['爆牌'],
    piaosanye: ['散牌'],
    douniu: ['没牛']
  };

  /* typeKey：牌型的稳定短 id。存库用短键，因为 profiles.json 里
   * 每个玩家都会带一份，而 MAX_PROFILES 是 20 万（见 profile.js）。 */
  var TYPE_KEY = {
    'tenhalf:10.5点': 'th',
    'piaosanye:同花顺': 'sf',
    'piaosanye:豹子': 'lp',
    'douniu:牛牛': 'nn',
    'douniu:五花牛': 'wh',
    /* 小牌型（v112） */
    'tenhalf:爆牌': 'bz',
    'piaosanye:散牌': 'sp',
    'douniu:没牛': 'mn'
  };

  /* 展示用的牌型表（顺序是有意的：按「稀有度从高到低」排，页面第一眼看到的是最难的那个） */
  var TYPE_ROWS = [
    { key: 'wh', label: '五花牛', mode: 'douniu', rarity: 'legend' },
    { key: 'sf', label: '同花顺', mode: 'piaosanye', rarity: 'legend' },
    { key: 'lp', label: '豹子', mode: 'piaosanye', rarity: 'epic' },
    { key: 'nn', label: '牛牛', mode: 'douniu', rarity: 'normal' },
    { key: 'th', label: '十点半', mode: 'tenhalf', rarity: 'rare' },
    /* 小牌型（v112）：同一张表、同一条分母，只是口味反过来 */
    { key: 'bz', label: '爆点', mode: 'tenhalf', rarity: 'normal', small: true },
    { key: 'sp', label: '散牌', mode: 'piaosanye', rarity: 'normal', small: true },
    { key: 'mn', label: '没牛', mode: 'douniu', rarity: 'normal', small: true }
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
      /* 小牌对撞（v112）：全场每个人都是该组的小牌型。
       * 大牌对撞是「两个人各有货」，小牌对撞是「一桌人都没货」—— 分母口径不同，
       * 所以不能塞进 vsn，否则「强者运强」的胜率会被一群爆点稀释。 */
      smv: 0,          // 全场都是小牌，我赢
      sml: 0,          // 全场都是小牌，我输
      smn: 0,          // 分母：参与「全场都是小牌」的组数
      r7: 0,           // 翻身农奴：连败 5 把以上之后赢一把（v112 改口径，老数据照旧计入）
      r8: 0,           // 已废弃：人间清醒（v112 删除）。字段留着只为老档案不丢
      /* 整把级（v112）：这三个看的是「这一把一个小时内全场的分数分布」，
       * 一轮一结算时还看不出结果，所以由 stateMachine 在第二把结束时单独算。 */
      r9: 0,           // 你咋这幸：全场只有一个人正分，而且是我
      r10: 0,          // 我咋这霉：全场只有我一个人负分
      r12: 0           // 一夜暴富：我的净胜 ≥ 所有输家负分绝对值总和的一半
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

  var COUNT_KEYS = ['vs', 'vsl', 'vsn', 's1', 's2', 'sa', 'sw', 'smv', 'sml', 'smn', 'r7', 'r8', 'r9', 'r10', 'r12'];
  var TYPE_KEY_KNOWN = { th: 1, sf: 1, lp: 1, nn: 1, wh: 1, bz: 1, sp: 1, mn: 1 };
  var MODE_KNOWN = { tenhalf: 1, piaosanye: 1, douniu: 1 };
  /* 大牌型 / 小牌型的键集合分开存：TYPE_KEY 是两者的合集（计数时都要认），
   * 但「对撞」只认大牌 —— 用错一个集合，一群爆点也会被算成硬碰硬。 */
  var BIG_KEY_KNOWN = { th: 1, sf: 1, lp: 1, nn: 1, wh: 1 };
  var SMALL_KEY_KNOWN = { bz: 1, sp: 1, mn: 1 };

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
      var smallIds = [];
      entries.forEach(function (e) {
        var b = bucketOf(e.id);
        /* 分母按**人**计：每参与一次该模式组 +1。
         * 所以「十点半出现率 50%」的含义是「我打过的十点半里有一半拿到 10.5」，
         * 而不是「全场有一半的十点半是 10.5」。
         * 小牌型（爆点 / 散牌 / 没牛）用的是**同一条分母** —— 它们和大牌型
         * 是同一个池子里的两端，各有各的分母就没法互相参照了。 */
        if (MODE_KNOWN[mode]) b.n[mode] = num(b.n[mode]) + 1;
        var k = TYPE_KEY[mode + ':' + e.typeName];
        if (k) b.t[k] = num(b.t[k]) + 1;
        if (BIG_KEY_KNOWN[k]) bigIds.push(e.id);
        if (SMALL_KEY_KNOWN[k]) smallIds.push(e.id);
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

      /* 小牌对撞（v112）：这一组**所有出牌的人**都是该组的小牌型。
       * 和大牌对撞的分母分开算 —— 两者的「可遇性」完全不同，
       * 混进同一个 vsn 会让「强者运强」的胜率被一群爆点稀释。
       * 要求 entries ≥ 2：一个人自己爆点不算对撞。 */
      if (entries.length >= 2 && smallIds.length === entries.length) {
        entries.forEach(function (e) {
          var b = bucketOf(e.id);
          b.smn = num(b.smn) + 1;
          if (e.id === g.winnerId) b.smv = num(b.smv) + 1;
          else b.sml = num(b.sml) + 1;
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

  /**
   * 整把结算后的一次性统计（v112）。
   *
   * 为什么不能塞进 accumulate：那一层一次只看一轮（3 组或 2 组），
   * 而下面这三条判的是「这一把打完之后全场的分数分布」——
   * 第二轮结算完才成立，而且必须一把只算一次。
   *
   * @param run     room.achRun
   * @param players 房间玩家数组（每人的 score 就是**这一把**的净胜，
   *                因为每把开局都会把分归 0；left 的人不参与）
   */
  function accumulateHand(run, players) {
    /* 桶不存在就新建：正常路径上 accumulate 先跑过，一定已经有了；
     * 但「一轮都没有组」的极端局（全员弃权）会走到这里，那时也该有一个空桶。 */
    if (!run || typeof run !== 'object') run = { byPid: {} };
    var list = (players || []).filter(function (p) {
      return p && p.id && !p.left;
    });
    if (list.length < 2) return run;

    var winners = [];
    var losers = [];
    var sumNeg = 0;
    list.forEach(function (p) {
      var net = num(p.score);
      if (net > 0) winners.push(p.id);
      else if (net < 0) { losers.push(p.id); sumNeg += -net; }
    });

    if (!run.byPid) run.byPid = {};
    list.forEach(function (p) {
      var b = run.byPid[p.id];
      if (!b) { b = blankCounts(); run.byPid[p.id] = b; }
      var net = num(p.score);

      /* 你咋这幸：全场只有一个人正分，而且是我。
       * 「一个人赢所有人」——不是「我赢得最多」，是「别人一分没赢到」。 */
      if (winners.length === 1 && net > 0) b.r9 = num(b.r9) + 1;

      /* 我咋这霉：全场只有我一个人负分（别人都赢或平）。 */
      if (losers.length === 1 && net < 0) b.r10 = num(b.r10) + 1;

      /* 一夜暴富（v112 改口径）：我的净胜 ≥ 所有输家负分绝对值总和的**一半**。
       * 老口径是「≥ 15 分」，那是个绝对阈值 —— 2 人局的 15 分和 5 人局的 15 分
       * 完全不是一回事，而且稍微改一下分值表就失效。新版看的是「我在这一把里
       * 分走了多少」，人和人之间可比。
       *   · sumNeg = 0（没人输）时不算：那说明大家都平，谈不上「暴富」。
       *   · 除 2 用乘法比较（net*2 >= sumNeg），避免浮点误差。 */
      if (net > 0 && sumNeg > 0 && net * 2 >= sumNeg) b.r12 = num(b.r12) + 1;
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

  /* 牌型短键 → 所属牌组。用来算「这一种牌型的出现率」。
   * 从 TYPE_ROWS 反推，避免再手写一份表（两份表一定会分岔）。 */
  var TYPE_MODE = {};
  TYPE_ROWS.forEach(function (r) { TYPE_MODE[r.key] = r.mode; });

  /* ============================ 成就目录 ============================
   *
   * 两条口径（v112 由项目所有者定）：
   *
   * 1. **大多数成就展示的是「次数」，不是「进度」**。
   *    理由：玩得久的人会把 0/20 顶满，之后那个 20 就再也不会动 ——
   *    玩家看到一个停在 20/20 的数字，会以为系统不记了。
   *    所以除少数「一次性里程碑」外，卡片上的数字就是累计次数，可以一直涨。
   *    只有这六个保留进度条（它们的语义本来就是「差多少」）：
   *    常客 / 老油条 / 势不可挡 / 十连胜 / 背到极点 / 衰神附体。
   *
   * 2. **牌型成就与顶部的牌型统计共用一份计数**。
   *    所以卡片上除了次数，还能给出「这种牌型的出现率」——
   *    分母是「参与该组的次数」，不是打了多少把（见 accumulate 里的说明）。
   */
  var CATALOG = [
    /* ---------- 系列一 · 牌型（大牌 10 条 + 小牌 3 条，全部展示次数与概率） ---------- */
    { id: 'h1', series: 'type', rarity: 'rare', name: '刚好十点半', typeKey: 'th',
      desc: '不多不少，正好 10.5。多一点是爆，少一点是输',
      cur: function (c) { return tn(c, 'th'); }, need: 1 },
    { id: 'h2', series: 'type', rarity: 'epic', name: '十点半成瘾', typeKey: 'th',
      desc: '十次卡在这条线上，你已经知道那半张牌该往哪放',
      cur: function (c) { return tn(c, 'th'); }, need: 10 },
    { id: 'h3', series: 'type', rarity: 'rare', name: '豹纹加身', typeKey: 'lp',
      desc: '三张一样的牌。第一次穿上这件外套',
      cur: function (c) { return tn(c, 'lp'); }, need: 1 },
    { id: 'h4', series: 'type', rarity: 'epic', name: '豹子头', typeKey: 'lp',
      desc: '十次豹子，牌桌上有人开始怕你了',
      cur: function (c) { return tn(c, 'lp'); }, need: 10 },
    { id: 'h5', series: 'type', rarity: 'epic', name: '一气呵成', typeKey: 'sf',
      desc: '同花顺——既要同花，又要连号，还得是同一组牌',
      cur: function (c) { return tn(c, 'sf'); }, need: 1 },
    { id: 'h6', series: 'type', rarity: 'legend', name: '同花顺专业户', typeKey: 'sf',
      desc: '五次同花顺。到这一步，运气已经不是主要解释了',
      cur: function (c) { return tn(c, 'sf'); }, need: 5 },
    { id: 'h7', series: 'type', rarity: 'normal', name: '牛气冲天', typeKey: 'nn',
      desc: '五张凑出一个整十，剩下两张再凑出个牛',
      cur: function (c) { return tn(c, 'nn'); }, need: 1 },
    { id: 'h8', series: 'type', rarity: 'epic', name: '牛魔王', typeKey: 'nn',
      desc: '三十次牛牛。你大概是靠这个吃饭的',
      cur: function (c) { return tn(c, 'nn'); }, need: 30 },
    { id: 'h9', series: 'type', rarity: 'legend', name: '五朵金花', typeKey: 'wh',
      desc: '五张全是花牌，全程没让数字出现',
      cur: function (c) { return tn(c, 'wh'); }, need: 1 },
    { id: 'h10', series: 'type', rarity: 'legend', name: '花牛成精', typeKey: 'wh',
      desc: '五次五花牛。见过的人都记住了',
      cur: function (c) { return tn(c, 'wh'); }, need: 5 },

    /* ---- 小牌型（v112 新增）：三种牌组各有一条「最惨」的记法 ---- */
    { id: 'h11', series: 'type', rarity: 'normal', name: '炸得干脆', typeKey: 'bz',
      desc: '十点半里把自己玩爆。这一组已经没得救，好歹爆得明白',
      cur: function (c) { return tn(c, 'bz'); }, need: 1 },
    { id: 'h12', series: 'type', rarity: 'normal', name: '一手散珠', typeKey: 'sp',
      desc: '飘三叶五张各管各的，牌型一个都没凑上',
      cur: function (c) { return tn(c, 'sp'); }, need: 1 },
    { id: 'h13', series: 'type', rarity: 'normal', name: '无牛可牵', typeKey: 'mn',
      desc: '斗牛五张凑不出整十，只能看着别人有牛',
      cur: function (c) { return tn(c, 'mn'); }, need: 1 },

    /* ---------- 系列二 · 对撞（大牌撞大牌 4 条 + 小牌撞小牌 2 条） ---------- */
    { id: 'c1', series: 'vs', rarity: 'epic', name: '虎口夺食',
      desc: '对方也拿着大牌型，你还是把他吃了。记的是次数',
      cur: function (c) { return g(c, 'vs'); }, need: 1 },
    { id: 'c2', series: 'vs', rarity: 'rare', name: '豹落平阳',
      desc: '你拿着大牌，遇上了更大的那一手。输得不冤，也记一笔',
      cur: function (c) { return g(c, 'vsl'); }, need: 1 },
    { id: 'c4', series: 'vs', rarity: 'epic', name: '牌桌屠夫',
      desc: '硬碰硬赢下来的次数。你专挑有牌的人下手',
      cur: function (c) { return g(c, 'vs'); }, need: 20 },
    { id: 'c3', series: 'vs', rarity: 'legend', name: '强者运强',
      desc: '大牌对撞十次以上，还赢下六成。运气这次站在强的那边',
      cur: function (c) { return g(c, 'vsn'); }, need: 10,
      /* 双条件成就：把「胜率」塞进 extra 里单独判，
       * 页面上的进度条按分母走（撞够 10 次），达不达成看 extra */
      extra: function (c) { return g(c, 'vsn') > 0 && g(c, 'vs') / g(c, 'vsn') >= 0.6; } },

    /* ---- 小牌对撞（v112）：全场每个人都是该组的小牌型 ----
     * 和大牌对撞正好相反：大牌对撞是「两个人各有货」，小牌对撞是「一桌人都没货」。
     * 后者的场面更难得 —— 一桌人十点半同时爆掉，比一个人拿豹子更容易被记住。 */
    { id: 'c5', series: 'vs', rarity: 'epic', name: '矮子里拔将军',
      desc: '一桌人全是小牌（爆点 / 散牌 / 没牛），你那张最不惨的够用了。记的是次数',
      cur: function (c) { return g(c, 'smv'); }, need: 1 },
    { id: 'c6', series: 'vs', rarity: 'rare', name: '一窝比惨',
      desc: '全场都是小牌，比到最后还是你垫底。这种场面躲不掉，记着就好',
      cur: function (c) { return g(c, 'sml'); }, need: 1 },

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
      desc: '通吃的次数。不管一轮还是两轮，反正都是你的',
      cur: function (c) { return g(c, 'sw'); }, need: 10 },

    /* ---------- 系列四 · 战绩 ----------
     * 只有这六条保留进度条：它们问的是「还差多少」。
     * 其余全部展示次数 —— 一个打了两百把的人，卡片上应该写「37 次」。 */
    { id: 'r1', series: 'record', rarity: 'normal', name: '第一次',
      desc: '你的第一把牌打完了。往后还有很多把',
      cur: function (c) { return g(c, 'games'); }, need: 1 },
    { id: 'r2', series: 'record', rarity: 'normal', name: '常客', mode: 'progress',
      desc: '十场。牌桌上开始有人认得你的名字',
      cur: function (c) { return g(c, 'games'); }, need: 10 },
    { id: 'r3', series: 'record', rarity: 'epic', name: '老油条', mode: 'progress',
      desc: '一百场。你比大多数人都懂这套规则是怎么转的',
      cur: function (c) { return g(c, 'games'); }, need: 100 },
    { id: 'r4', series: 'record', rarity: 'rare', name: '势不可挡', mode: 'progress',
      desc: '连赢五把。中间任何一把失手都得从头再来',
      cur: function (c) { return g(c, 'streak'); }, need: 5 },
    { id: 'r5', series: 'record', rarity: 'legend', name: '十连胜', mode: 'progress',
      desc: '连赢十把。这已经不是运气能解释的了',
      cur: function (c) { return g(c, 'streak'); }, need: 10 },
    { id: 'r6', series: 'record', rarity: 'rare', name: '背到极点', mode: 'progress',
      desc: '连输五把。输到这个份上，反而没什么好怕的了',
      cur: function (c) { return g(c, 'loseStreak'); }, need: 5 },
    { id: 'r7', series: 'record', rarity: 'epic', name: '衰神附体', mode: 'progress',
      desc: '连输十把。牌不认人，认的是这几天你碰过谁',
      cur: function (c) { return g(c, 'loseStreak'); }, need: 10 },
    { id: 'r9', series: 'record', rarity: 'rare', name: '一夜暴富',
      desc: '单把净胜 ≥ 在场所有输家负分总和的一半。这一把基本是你一个人的',
      cur: function (c) { return g(c, 'r12'); }, need: 1 },
    { id: 'r10', series: 'record', rarity: 'epic', name: '翻身农奴',
      desc: '连输五把以上之后赢一把。赢一把就够了，记的是次数',
      cur: function (c) { return g(c, 'r7'); }, need: 1 },
    { id: 'r11', series: 'record', rarity: 'legend', name: '你咋这幸',
      desc: '结算时全场只有你一个人正分。别人一分没赢到，全在你手里',
      cur: function (c) { return g(c, 'r9'); }, need: 1 },
    { id: 'r12', series: 'record', rarity: 'epic', name: '我咋这霉',
      desc: '结算时全场只有你一个人负分。牌不认人，这一把真不认你',
      cur: function (c) { return g(c, 'r10'); }, need: 1 }
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
      smv: num(a.smv), sml: num(a.sml), smn: num(a.smn),
      r7: num(a.r7), r8: num(a.r8), r9: num(a.r9), r10: num(a.r10), r12: num(a.r12),
      games: num(stats.games),
      streak: num(stats.longestStreak),
      /* 连败的「最长」不是在 ach 桶里，而在档案的 longestLoseStreak（Stats 算的）。
       * 两个连胜成就都读同一条来源，避免「连胜从档案取、连败从桶取」这种不对称。 */
      loseStreak: num(stats.longestLoseStreak),
      bestNet: num(stats.bestNet)
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
      /* 牌型成就额外带出「出现率」：分母是这个人参与该牌组的次数。
       * 分母为 0 时给 null（页面显示「—」），不是 0% —— 「没打过」和
       * 「打过但一次没拿到」是两件事。 */
      var rate = null;
      if (def.typeKey) {
        var seenN = num(ctx.n[TYPE_MODE[def.typeKey]]);
        rate = seenN > 0 ? num(ctx.t[def.typeKey]) / seenN : null;
      }
      return {
        id: def.id, series: def.series, rarity: def.rarity,
        seriesLabel: SERIES_LABEL[def.series] || '',
        rarityLabel: RARITY_LABEL[def.rarity] || '',
        name: def.name, desc: def.desc,
        /* mode：'progress' 画进度条（还差多少），'count' 只写次数（可以一直涨）。
         * 默认 count —— 因为绝大多数成就的语义是「干了多少次」，
         * 不是「离目标差多少」。 */
        mode: def.mode === 'progress' ? 'progress' : 'count',
        cur: Math.min(cur, need), raw: cur, need: need,
        rate: rate,
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
    accumulateHand: accumulateHand,
    runOf: runOf,
    evaluate: evaluate,
    typeStats: typeStats,
    sinceText: sinceText,
    countOf: countOf
  };
});
