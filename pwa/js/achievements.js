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
  var SERIES_LABEL = { type: '牌型', vs: '对撞', sweep: '通吃 · 通赔', record: '战绩' };

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
      /* 通赔（v114）：与通吃一一对应，只是把「全赢」换成「全输」。
       * 判定要求**每组都参与了且每组都没赢** —— 只看「没赢」是不够的：
       * 中途弃权的人后面几组根本没参与，那不是通赔，那是没打。 */
      l1: 0,           // 第一轮 3 组全输
      l2: 0,           // 第二轮 2 组全输
      la: 0,           // 一把 5 组全输
      lw: 0,           // 通赔总次数（l1 + l2）
      /* 小牌对撞（v112）：全场每个人都是该组的小牌型。
       * 大牌对撞是「两个人各有货」，小牌对撞是「一桌人都没货」—— 分母口径不同，
       * 所以不能塞进 vsn，否则「遇强则强」的胜率会被一群爆点稀释。 */
      smv: 0,          // 全场都是小牌，我赢
      sml: 0,          // 全场都是小牌，我输
      smn: 0,          // 分母：参与「全场都是小牌」的组数
      r7: 0,           // 翻身农奴：连败 5 场以上之后赢一场（v112 改口径，老数据照旧计入）
      /* v116：r8（人间清醒，v112 就删了）从这里删掉。字段从来没被任何地方写过，
       * 留着只会让人以为「还有个键没接上」。老档案里若残留 `r8: 0`，
       * mergeInto 是白名单合并，直接忽略 —— 不需要迁移。 */
      /* 整场级（v112 起口径是「一场一次」）：这三条看的是这一场结束时
       * 全场有几个人正分、我拿了多少，一轮一结算时还看不出结果。 */
      r9: 0,           // 你咋这幸：这一场只有我一个人正分
      r10: 0,          // 我咋这霉：这一场只有我一个人负分
      r12: 0           // 一夜暴富：这一场净胜 > 100（旧判据 net*2>=sumNeg 在零和下恒真，已废）
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

  /* 会进档案、并且会被 mergeInto 白名单合并的计数键。
   * ★ 加键时三处必须同时改：blankCounts()、这里、evaluate 的 ctx。
   *   漏一处不会报错，只会让那个成就永远停在 0 —— 最难查的那类。
   * v116 去掉了 r8：它从 v112 起就没有任何写入点。 */
  var COUNT_KEYS = ['vs', 'vsl', 'vsn', 's1', 's2', 'sa', 'sw', 'l1', 'l2', 'la', 'lw', 'smv', 'sml', 'smn', 'r7', 'r9', 'r10', 'r12'];
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
    var parts = {};  // 每人参与了几组（通赔要求「每组都参与」）
    var losts = {};  // 每人「参与了但没赢」几组

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
        parts[e.id] = num(parts[e.id]) + 1;
        if (e.id !== g.winnerId) losts[e.id] = num(losts[e.id]) + 1;
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
       * 混进同一个 vsn 会让「遇强则强」的胜率被一群爆点稀释。
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

    /* 通赔：这一轮每一组都参与了、且每一组都不是赢家。
     * 与通吃对称，但多一道「参与」校验 —— 通吃不需要它（赢的那组必然参与了），
     * 通赔需要（没参与的组也不可能是赢家，会被误判成「全输」）。 */
    Object.keys(parts).forEach(function (pid) {
      if (num(parts[pid]) !== total) return;
      if (num(losts[pid]) !== total) return;
      var b = bucketOf(pid);
      if (round === 1) {
        run._l1 = run._l1 || {};
        run._l1[pid] = 1;
        b.l1 = num(b.l1) + 1;
        b.lw = num(b.lw) + 1;
      } else {
        b.l2 = num(b.l2) + 1;
        b.lw = num(b.lw) + 1;
        if (run._l1 && run._l1[pid]) b.la = num(b.la) + 1;
      }
    });

    return run;
  }

  /**
   * @deprecated 2026-11-11 起废弃，恒为无操作（保留导出只为不打断老调用方）。
   *
   * ── 为什么废弃（口径纠错，用户裁定）──────────────────────────────
   *
   * 这里原本统计 r9（你咋这幸）/ r10（我咋这霉）/ r12（一夜暴富），
   * 而且是在**每一把**结算后判一次。问题有两个：
   *
   * 1. **口径错了**。这三条的名字和文案说的都是「结算时」，
   *    玩家理解的是「一整场打完后那个决定退出还是下一把的界面」，
   *    实现却按把算。表现是：全操只有 235 场，r9 却有 277 次 ——
   *    玩家拿「277 次」去比「235 场」，必然认为数据错了。
   *    实际上他打了 4031 把（见 ach.n.tenhalf），277/4031 = 6.9%，数字本身没错，
   *    错的是它被当成「场」来读。
   *
   * 2. **一夜暴富的判据近乎恒真**。零和计分下独赢时 net === sumNeg，
   *    于是 `net*2 >= sumNeg` 必然成立 —— 它实际上等价于「你独赢了一把」，
   *    是免费成就（质量监管实测 2 人局 / 5 人局 / 4 人局全部点亮）。
   *
   * 现在这三条全部移到**整场**口径，在 `server/profile.js` 的 `record()` 里判
   * （每场每人调用一次，且能拿到全场正负分人数）。本函数不再参与任何统计。
   *
   * 保留它而不是删掉，是因为 `pwa/js/stateMachine.js` 仍在每把调用一次；
   * 空转无害，删调用属于另一笔改动，不在这次口径修正里。
   */
  function accumulateHand(run) {
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
   *   计数桶 t / n / vs / vsl / vsn / smv / sml / smn / s1 / s2 / sa / sw /
   *          l1 / l2 / la / lw / r7 / r9 / r10 / r12
   *   战绩   games / streak / loseStreak / bestNet（后三个来自档案，不在 ach 桶里）
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

  /* ==================== 比率型成就的门槛（2026-11-11，第 3 批） ====================
   *
   * 背景：这类成就测的是**比率**，不是次数。次数是绝对量，玩得再久也只是变大，
   * 人人都能顶满；比率是相对量，样本越多越贴近真实水平 —— 靠运气的会掉下去，
   * 靠实力的会站住。这是全目录里**唯一「越玩越难」**的一类，也是回答
   * 「大家都玩到上万场之后靠什么区分」的唯一机制。
   *
   * 为什么不是 50%：对撞不是两人对赌。每次大牌对撞有 N 个人拿大牌，必然 1 赢 N−1 输，
   * 个人胜率的**上限就是 1/N**。线上实测 9599 次对撞、平均 2.38 人 → 上限 42.1%，
   * 全局实测胜率 42.06%，完全吻合。所以 50% 不是「难」，是**数学上不可达** ——
   * 旧的 50% 口径下正向成就 0/9、反向成就 9/9，等于没判。
   *
   * 46%：实测 9 人区间 40.2%~46.9%，只有 2 人够到。均值水平的玩家在 100 次对撞时
   * 有 21% 的概率蒙到，1600 次时只剩 0.1%；真实 50% 的强手到 1600 次仍有 99.9%。
   * 这就是「运气被样本量筛掉」—— 门槛不是重点，**配上样本量门槛才是**。
   *
   * 34%：反向那条。均值 42%，34% 是明显低于均值，不是「略差」（否则人人都有，
   * 又会退回 9/9 的免费徽章）。
   */
  var RATE_FWD = 0.46;   // 正向：明显赢多
  var RATE_REV = 0.34;   // 反向：明显输多

  /* 样本量门槛：不到这个次数，比率没有意义 —— 撞一次赢一次就是 100%，
   * 那不叫「运强」，叫「运气好一次」。
   *
   * 两条门槛不一样，是因为两种对撞的**可遇性差了一个数量级**：
   *   · 大牌对撞：线上 9599 次（9 人），头部玩家 360~1996 次
   *   · 小牌对撞：线上只有 783 次（9 人），要一桌人全是小牌才算，头部 236~252 次，
   *     一半玩家不到 20 次。给小牌也用 100 会把 6/9 的人直接挡在门外。
   * 统计上也支持：小牌均值 33%，30 次样本下 46% 的门槛对应约 6.5% 的达成率，
   * 已经足够把运气筛掉；再往上加只是在惩罚「小牌局本来就少」这件事。 */
  var VS_MIN = 100;      // 大牌对撞的样本门槛
  var SM_MIN = 30;       // 小牌对撞的样本门槛（可遇性低，门槛跟着降）

  /** 对撞胜率。分母为 0 时返回 null（页面显示「—」，不是 0%）——
   * 「没撞过」和「撞了但一次没赢」是两件事。
   * 名字不叫 rateOf：目录里 `rateOf: 'vs'` 是「这张卡按哪个分母算胜率」的标记，
   * 两者同名会让人以为是一回事。 */
  function winRate(ctx, winKey, totalKey) {
    var n = g(ctx, totalKey);
    return n > 0 ? g(ctx, winKey) / n : null;
  }

  /* ============================ 成就目录 ============================
   *
   * 两条口径（v112 由项目所有者定）：
   *
   * 1. **大多数成就展示的是「次数」，不是「进度」**。
   *    理由：玩得久的人会把 0/20 顶满，之后那个 20 就再也不会动 ——
   *    玩家看到一个停在 20/20 的数字，会以为系统不记了。
   *    所以除少数「一次性里程碑」外，卡片上的数字就是累计次数，可以一直涨。
   *
   *    v116 之后带 `mode: 'progress'` 的一共九条（它们的语义本来就是「还差多少」）：
   *    常客 10 / 熟面孔 50 / 老油条 100 / 铁人 200 场，
   *    势不可挡 5 / 十连胜 10 / 十五连胜 15 场连胜，
   *    背到极点 5 / 衰神附体 10 场连败。
   *    这个数字不写死在文档里更好，但「哪些该有进度条」是个判断，值值得写下来。
   *
   * 2. **牌型成就与顶部的牌型统计共用一份计数**。
   *    所以卡片上除了次数，还能给出「这种牌型的出现率」——
   *    分母是「参与该组的次数」，不是打了多少把（见 accumulate 里的说明）。
   */
  var CATALOG = [
    /* ---------- 系列一 · 牌型（大牌 5 条 + 小牌 3 条，全部展示次数与概率） ----------
     *
     * 「大牌 10 条」这个说法是旧的（v112 里合并过一轮），实际是 5 条 —— 一个牌型一条。
     * 注释与实现对不上，后面每次读这段都要重新数一遍，所以改准。
     *
     * 每条都带 `countKey`（见下面 evaluate 里的守卫）：它声明「这张卡读的是哪个计数器」，
     * 让「id 和键名对不上」这种问题在测试里就暴露，而不是靠人肉核对。 */
    { id: 'h2', series: 'type', rarity: 'normal', name: '十点半成瘾', typeKey: 'th',
      desc: '不多不少正好 10.5 的那种手气。落到这条线上，你已经知道那半张牌该往哪放',
      cur: function (c) { return tn(c, 'th'); }, need: 10, countKey: 't.th' },
    { id: 'h4', series: 'type', rarity: 'normal', name: '豹子头', typeKey: 'lp',
      desc: '三张一样的牌。牌桌上出了豹子，第一反应是先看是谁的',
      cur: function (c) { return tn(c, 'lp'); }, need: 10, countKey: 't.lp' },
    { id: 'h6', series: 'type', rarity: 'normal', name: '同花顺专业户', typeKey: 'sf',
      desc: '既要同花、又要连号，还得落在同一组里。到这一步，运气已经不是主要解释了',
      cur: function (c) { return tn(c, 'sf'); }, need: 5, countKey: 't.sf' },
    { id: 'h8', series: 'type', rarity: 'normal', name: '牛魔王', typeKey: 'nn',
      /* 斗牛是「三张凑十、剩下两张凑牛」，不是「五张凑整十」——
       * 五张凑整十是错的，照着读会以为要把五张都用上。 */
      desc: '三张凑十，剩下两张凑牛。你大概是靠这个吃饭的',
      cur: function (c) { return tn(c, 'nn'); }, need: 30, countKey: 't.nn' },
    { id: 'h10', series: 'type', rarity: 'legend', name: '花牛成精', typeKey: 'wh',
      desc: '五张全是花牌，全程没让数字出现。见过的人都记住了',
      cur: function (c) { return tn(c, 'wh'); }, need: 5, countKey: 't.wh' },

    /* ---- 小牌型（v112 新增）：三种牌组各有一条「最惨」的记法 ----
     * v116 把这三条的门槛从 1 抬到 5：它们记的是「最差那一档」，
     * 而最差档出现的频率比大牌型高得多 —— 门槛 1 等于「打过一把十点半就点亮」，
     * 实测 9 个打过牌的人全都有。抬到 5 之后它仍然是「迟早会有」，
     * 但不再是「第一把就送」。 */
    { id: 'h11', series: 'type', rarity: 'rare', name: '炸得干脆', typeKey: 'bz',
      desc: '十点半里把自己玩爆。这一组已经没得救，好歹爆得明白',
      cur: function (c) { return tn(c, 'bz'); }, need: 5, countKey: 't.bz' },
    { id: 'h12', series: 'type', rarity: 'normal', name: '一手散珠', typeKey: 'sp',
      desc: '飘三叶三张各管各的，牌型一个都没凑上',
      cur: function (c) { return tn(c, 'sp'); }, need: 5, countKey: 't.sp' },
    { id: 'h13', series: 'type', rarity: 'normal', name: '无牛可牵', typeKey: 'mn',
      desc: '斗牛五张凑不出整十，只能看着别人有牛',
      cur: function (c) { return tn(c, 'mn'); }, need: 5, countKey: 't.mn' },

    /* ---------- 系列二 · 对撞（8 条，四种 × 两档） ----------
     *
     * v115 按用户口径重排成对称的八条：
     *   大牌撞大牌：赢的次数 / 输的次数 / 胜率 ≥50% / 胜率 <50%
     *   小牌撞小牌：赢的次数 / 输的次数 / 胜率 ≥50% / 胜率 <50%
     *
     * 两条胜率成就**不再互斥**（2026-11-11 第 3 批）：正向 ≥46%、反向 <34%，
     * 中间那一段两条都不亮。这是有意的 —— 略高于均值、略低于均值不是本事也不是倒霉，
     * 硬要给个徽章，就等于又发了一枚「参与即得」。
     *
     * 胜率类都带样本量门槛（大牌 100 次 / 小牌 30 次，见上面的 RATE_* 常量）：
     * 不设门槛的话，撞一次赢一次就是 100%，一局就能点亮，那不叫「运强」，
     * 叫「运气好一次」；而且有了样本量，**玩得越久反而越难保持**。
     */
    /* ---- 大牌撞大牌：一条「硬」字线，赢家的名字带刺，输家的名字带软 ----
     * v116：赢/输两条从 need=1 抬到 3。**两边一起抬** ——
     * 只抬赢的一侧，会变成「赢三次才算硬茬子、输一次就是软脚虾」，
     * 那是在用门槛表达「赢比输金贵」，而这套成就的前提恰恰是输赢对称。 */
    { id: 'c4', series: 'vs', rarity: 'normal', name: '硬茬子',
      desc: '硬碰硬赢下来的次数。大牌撞大牌，撞完还站着的那个人是你',
      cur: function (c) { return g(c, 'vs'); }, need: 3, countKey: 'vs' },
    { id: 'c8', series: 'vs', rarity: 'normal', name: '软脚虾',
      desc: '硬碰硬输下来的次数。撞上去才知道对面有多硬',
      cur: function (c) { return g(c, 'vsl'); }, need: 3, countKey: 'vsl' },
    { id: 'c3', series: 'vs', rarity: 'legend', name: '遇强则强',
      desc: '硬碰硬赢下来的比例明显高过随机。对手的牌越好，这两个字越值钱',
      cur: function (c) { return g(c, 'vsn'); }, need: VS_MIN, rateOf: 'vs', countKey: 'vsn',
      extra: function (c) {
        return g(c, 'vsn') >= VS_MIN && winRate(c, 'vs', 'vsn') >= RATE_FWD;
      } },
    { id: 'c7', series: 'vs', rarity: 'legend', name: '外强中干',
      desc: '硬碰硬输下来的比例明显高过随机。看着像有牌，一撞就散',
      cur: function (c) { return g(c, 'vsn'); }, need: VS_MIN, rateOf: 'vs', countKey: 'vsn',
      extra: function (c) {
        return g(c, 'vsn') >= VS_MIN && winRate(c, 'vs', 'vsn') < RATE_REV;
      } },

    /* ---- 小牌撞小牌：一条「鸡」字线。全桌都没货，赢了是鸡头，输了是鸡飞蛋打 ---- */
    { id: 'c5', series: 'vs', rarity: 'epic', name: '宁为鸡头',
      desc: '一桌人全是小牌（爆点 / 散牌 / 没牛）时，你赢下来的次数。烂牌堆里也得有个头',
      cur: function (c) { return g(c, 'smv'); }, need: 3, countKey: 'smv' },
    { id: 'c6', series: 'vs', rarity: 'rare', name: '鸡飞蛋打',
      desc: '全场都是小牌，输的还是你。这种局不体面，但很常见',
      cur: function (c) { return g(c, 'sml'); }, need: 3, countKey: 'sml' },
    { id: 'c9', series: 'vs', rarity: 'legend', name: '矮子里拔将军',
      desc: '小牌局里赢下来的比例明显高过随机。牌烂不烂是一回事，怎么打是另一回事',
      cur: function (c) { return g(c, 'smn'); }, need: SM_MIN, rateOf: 'sm', countKey: 'smn',
      extra: function (c) {
        return g(c, 'smn') >= SM_MIN && winRate(c, 'smv', 'smn') >= RATE_FWD;
      } },
    { id: 'c10', series: 'vs', rarity: 'legend', name: '矬子里垫底',
      desc: '小牌局里输下来的比例明显高过随机。一桌都没牌，垫底的还是你',
      cur: function (c) { return g(c, 'smn'); }, need: SM_MIN, rateOf: 'sm', countKey: 'smn',
      extra: function (c) {
        return g(c, 'smn') >= SM_MIN && winRate(c, 'smv', 'smn') < RATE_REV;
      } },

    /* ---------- 系列三 · 通吃 ----------
     * v116：这一组六条 need=1 的全抬到 3 —— 实测 9 个打过牌的人里
     * 「一巡清场」「双杀」「五子登科」都是 9/9，等于注册礼包。
     * 抬门槛不解决饱和（玩久了总会到 3），但能让「刚开局那几把」不再人手一份。 */
    { id: 'clearr1', series: 'sweep', rarity: 'normal', name: '一巡清场',
      desc: '第一轮三组全赢。这一轮没你的事，只有你的分',
      cur: function (c) { return g(c, 's1'); }, need: 3, countKey: 's1' },
    { id: 'clearr2', series: 'sweep', rarity: 'normal', name: '双杀',
      desc: '第二轮两组全赢。收尾的时候你才动手',
      cur: function (c) { return g(c, 's2'); }, need: 3, countKey: 's2' },
    { id: 'clearall', series: 'sweep', rarity: 'rare', name: '五子登科',
      desc: '一把里五组全赢。别人只能看着你收',
      cur: function (c) { return g(c, 'sa'); }, need: 3, countKey: 'sa' },
    { id: 'sweep10', series: 'sweep', rarity: 'normal', name: '常胜将军',
      desc: '通吃的次数。不管一轮还是两轮，反正都是你的',
      cur: function (c) { return g(c, 'sw'); }, need: 10, countKey: 'sw' },

    /* ---- 通赔（v114）：与上面四条一一对应，把「全赢」换成「全输」 ----
     * 为什么补这一组：通吃是「这一轮全是我的」，通赔是「这一轮全不是我的」。
     * 后者发生的频率比前者高得多（一个人牌差时整轮没戏），而首版只记喜不记悲 ——
     * 牌桌上真正会被拿出来讲的是「我那轮一把没赢」，不是「我又通吃了」。 */
    { id: 'loser1', series: 'sweep', rarity: 'normal', name: '一巡散场',
      desc: '第一轮三组全输。这一轮没你的分，只有你送出去的',
      cur: function (c) { return g(c, 'l1'); }, need: 3, countKey: 'l1' },
    { id: 'loser2', series: 'sweep', rarity: 'normal', name: '双赔',
      desc: '第二轮两组全输。收尾的时候，你一次都没站住',
      cur: function (c) { return g(c, 'l2'); }, need: 3, countKey: 'l2' },
    { id: 'loseall', series: 'sweep', rarity: 'normal', name: '五子皆输',
      desc: '一把里五组全输。别人收你的分，收到手软',
      cur: function (c) { return g(c, 'la'); }, need: 3, countKey: 'la' },
    { id: 'losemany', series: 'sweep', rarity: 'normal', name: '常败将军',
      desc: '通赔的次数。不管一轮还是两轮，反正都不是你的',
      cur: function (c) { return g(c, 'lw'); }, need: 10, countKey: 'lw' },

    /* ---------- 系列四 · 战绩 ----------
     * 只有这几条保留进度条：它们问的是「还差多少」。
     * 其余全部展示次数 —— 一个打了两百把的人，卡片上应该写「37 次」。
     *
     * ★ v116 把 id 从 r1~r12 改成语义名。旧 id 最大的问题是**看起来像计数键**：
     *   旧 id `r9`（一夜暴富）读的是 `r12`，旧 id `r11`（你咋这幸）读的是 `r9` ——
     *   四处交叉，每次读这段都要重新对一遍，还容易被当成 bug 去「修」。
     *   现在 id 不再冒充键名，读哪个计数器由 `countKey` 明说（没有 countKey 的就是
     *   读 stats，用 `statKey` 声明）。测试里有一节专门守这件事。
     *
     * ★ 门槛的语义分两种，别混：
     *   · 里程碑型（场次 / 连胜）—— need 是「要达到多少」，有进度条；
     *   · 计数型（一场一次的那种）—— need 是「发生几次才点亮」，卡片写次数。
     */
    { id: 'first', series: 'record', rarity: 'normal', name: '第一次',
      desc: '你的第一场打完了。往后还有很多场',
      cur: function (c) { return g(c, 'games'); }, need: 1, statKey: 'games' },
    { id: 'regular', series: 'record', rarity: 'normal', name: '常客', mode: 'progress',
      desc: '十场。牌桌上开始有人认得你的名字',
      cur: function (c) { return g(c, 'games'); }, need: 10, statKey: 'games' },
    /* v116 补的一档：10 场到 100 场之间原本有 90 场的空窗，
     * 中间没有任何一张卡会动 —— 玩家会以为系统不记了。 */
    { id: 'familiar', series: 'record', rarity: 'normal', name: '熟面孔', mode: 'progress',
      desc: '五十场。同一个房间里，大半的名字你已经见过',
      cur: function (c) { return g(c, 'games'); }, need: 50, statKey: 'games' },
    { id: 'veteran', series: 'record', rarity: 'epic', name: '老油条', mode: 'progress',
      desc: '一百场。你比大多数人都懂这套规则是怎么转的',
      cur: function (c) { return g(c, 'games'); }, need: 100, statKey: 'games' },
    /* v116 补的超长线：100 场之后原本就没有目标了。
     * 200 场按线上目前的进度只有 1 个人接近 —— 它就是给「还想往上打」的人留的。 */
    { id: 'ironman', series: 'record', rarity: 'legend', name: '铁人', mode: 'progress',
      desc: '两百场。到这个份上，牌桌已经是日常的一部分',
      cur: function (c) { return g(c, 'games'); }, need: 200, statKey: 'games' },
    { id: 'streak5', series: 'record', rarity: 'rare', name: '势不可挡', mode: 'progress',
      desc: '连赢五场。中间任何一场失手都得从头再来',
      cur: function (c) { return g(c, 'streak'); }, need: 5, statKey: 'streak' },
    { id: 'streak10', series: 'record', rarity: 'legend', name: '十连胜', mode: 'progress',
      desc: '连赢十场。这已经不是运气能解释的了',
      cur: function (c) { return g(c, 'streak'); }, need: 10, statKey: 'streak' },
    /* v116 补的加档：十连胜在线上一个人都没有，但 8 连的确实存在 ——
     * 十五连是给「真的打出过那种手感」的人留的记号，不是给所有人留的台阶。 */
    { id: 'streak15', series: 'record', rarity: 'legend', name: '十五连胜', mode: 'progress',
      desc: '连赢十五场。到这一步，对手开始怀疑牌是不是有记忆',
      cur: function (c) { return g(c, 'streak'); }, need: 15, statKey: 'streak' },
    { id: 'lose5', series: 'record', rarity: 'rare', name: '背到极点', mode: 'progress',
      desc: '连输五场。输到这个份上，反而没什么好怕的了',
      cur: function (c) { return g(c, 'loseStreak'); }, need: 5, statKey: 'loseStreak' },
    { id: 'lose10', series: 'record', rarity: 'legend', name: '衰神附体', mode: 'progress',
      desc: '连输十场。牌不认人，认的是这几天你碰过谁',
      cur: function (c) { return g(c, 'loseStreak'); }, need: 10, statKey: 'loseStreak' },
    /* 单场之王：`bestNet` 这个字段从有成就系统那天起就没人用过（白白闲置）。
     *
     * 门槛为什么是 150 而不是 100：`一夜暴富`（r12）已经是「一场净胜 >100」的**次数**，
     * 100 再用一次就是同一件事换个名字。150 是另一个量级 ——
     * 线上最高 142（全操），目前 0 人够到，是留给「一把打穿全桌」的那种局。
     * 两条的区别是「发生过几次」vs「单场上限有多高」，不是同一根轴上的一高一低。 */
    { id: 'bigwin', series: 'record', rarity: 'legend', name: '单场之王',
      desc: '一场里净胜 150 分以上。这一场打完，整桌的分基本都在你手里',
      cur: function (c) { return g(c, 'bestNet'); }, need: 150, statKey: 'bestNet' },
    { id: 'windfall', series: 'record', rarity: 'rare', name: '一夜暴富',
      desc: '一场打完，净胜超过 100 分。这一场基本是你一个人的',
      cur: function (c) { return g(c, 'r12'); }, need: 1, countKey: 'r12' },
    { id: 'comeback', series: 'record', rarity: 'rare', name: '翻身农奴',
      desc: '连输五场以上之后赢一场。赢一场就够了，记的是次数',
      cur: function (c) { return g(c, 'r7'); }, need: 1, countKey: 'r7' },
    { id: 'luckyonly', series: 'record', rarity: 'legend', name: '你咋这幸',
      desc: '一场打完，全场只有你一个人正分。别人一分没赢到，全在你手里',
      cur: function (c) { return g(c, 'r9'); }, need: 1, countKey: 'r9' },
    { id: 'unluckyonly', series: 'record', rarity: 'epic', name: '我咋这霉',
      desc: '一场打完，全场只有你一个人负分。牌不认人，这一场真不认你',
      cur: function (c) { return g(c, 'r10'); }, need: 1, countKey: 'r10' }
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
      l1: num(a.l1), l2: num(a.l2), la: num(a.la), lw: num(a.lw),
      smv: num(a.smv), sml: num(a.sml), smn: num(a.smn),
      r7: num(a.r7), r9: num(a.r9), r10: num(a.r10), r12: num(a.r12),
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
      /* 双条件成就（遇强则强 / 外强中干、矮子里拔将军 / 矬子里垫底）：
       * 进度条按分母走，达不达成还要看 extra 里的胜率 ——
       * 分母够了但胜率不在自己这一侧，就只亮对面那条，两条永不并亮。 */
      if (ok && typeof def.extra === 'function') ok = !!def.extra(ctx);
      if (ok) unlocked += 1;
      if (!bySeries[def.series]) bySeries[def.series] = { total: 0, unlocked: 0 };
      bySeries[def.series].total += 1;
      if (ok) bySeries[def.series].unlocked += 1;
      /* 牌型成就额外带出「出现率」：分母是这个人参与该牌组的次数。
       * 分母为 0 时给 null（页面显示「—」），不是 0% —— 「没打过」和
       * 「打过但一次没拿到」是两件事。
       *
       * rateKind 让页面知道**这个比率该怎么念**：「出现率」和「胜率」是两件事，
       * 都写成裸百分比会让玩家分不清「我拿到过 3 次」和「我赢了 3 次」。 */
      var rate = null;
      var rateKind = null;
      var rateBase = 0;
      if (def.typeKey) {
        rateKind = 'type';
        rateBase = num(ctx.n[TYPE_MODE[def.typeKey]]);
        rate = rateBase > 0 ? num(ctx.t[def.typeKey]) / rateBase : null;
      } else if (def.rateOf === 'vs') {
        rateKind = 'vs';
        rateBase = num(ctx.vsn);
        rate = winRate(ctx, 'vs', 'vsn');
      } else if (def.rateOf === 'sm') {
        rateKind = 'sm';
        rateBase = num(ctx.smn);
        rate = winRate(ctx, 'smv', 'smn');
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
        rate: rate, rateKind: rateKind, rateBase: rateBase,
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
