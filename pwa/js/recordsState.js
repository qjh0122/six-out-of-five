/**
 * 战绩页「四态 + 错误三级」的状态机与文案表（build-states v1）
 *
 * ── 为什么单独成文件 ─────────────────────────────────────────────────
 * 施工前这一页**只有一套骨架**（空态那套）在兼职当"所有状态"，靠换一句标题
 * 区分"在等"和"没有"：加载时显示的是「正在读取战绩…」+ 一张 0 分的卡片 +
 * 一个能点的「创建房间」；失败时显示的是空态标题 + 页脚一句没有下文的说明。
 * 那不是文案问题，是**缺了三个态**。
 *
 * 判断"现在是哪个态"原本是 `renderRecords()` 里的四个 if 散着写的。
 * 散着写的代价不是难读，是**加第五个态那天必定漏一个分支** —— 漏一个的表现
 * 就是两个态同屏叠着。所以这里只做一件事：把判断收成一个纯函数。
 *
 * 纯函数是为了能单测（`pwa/test/states.test.js` 直接把 32 组输入钉成表）。
 * 有 DOM 依赖的判断留在 recordsView.js，这个文件不认识 document。
 *
 * ── 三条不可改的口径 ────────────────────────────────────────────────
 *   ① 判定顺序唯一：`offline > fail > loading > empty > data`。
 *      离线压过失败（离线是原因，失败是结果）；失败压过加载（请求有结论了，
 *      转圈就是撒谎）；加载压过空（还没拿到，就不能说"没有"——这是最伤的一条，
 *      `hasData` 在加载期间恒为 false，现状因此摆出过"还没有战绩"）。
 *   ② 错误三级的分界只有一句话：**玩家再点一次，有可能变好吗？**
 *      可能 → 可重试（给具体动词）；没可能 → 不可恢复（禁止「再试一次」）；
 *      玩家不需要知道 → 静默（只上报，页面一个像素都不动）。
 *   ③ 文案逐字来自 `docs/design-states-v1.md §②-b`，**不许改字**。
 *      施工单允许在 14/26 字内自选，但表里已经是定稿，改字要走设计师。
 *
 * 浏览器全局：`window.LXW.recordsState`；Node 里 `module.exports` 直接可用。
 */
(function (global, factory) {
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else {
    global.LXW = global.LXW || {};
    global.LXW.recordsState = mod;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 加载态的显示门槛（design §⑤-d）。
   * 本地读常常 200ms 内完成，先闪一下空态再切成有数据是**最坏的闪**：
   * 它闪的是错的结论。所以 0–250ms 内什么都不显示（只留屏背景），
   * 代价是这段时间没有反馈 —— 可接受，因为屏切换本身有入场动画盖住。
   * 落到代码是一个常量，不是散在 if 里的魔法数字。 */
  var STATE_DELAY_MS = 250;
  /* 加载态"慢"的升级线：超过 1 秒把副文案换成一句人话（不加进度条 —— 没有
   * 可信的总量，编一个百分比等于撒谎，而"87% 卡住"比"一直转"更让人焦虑）。 */
  var STATE_SLOW_MS = 1000;

  /* 五个状态值。顺序就是判定优先级（数组本身也是单测与探针的白名单来源，
   * 免得"值域"这件事在三处各写一遍）。 */
  var STATES = ['offline', 'fail', 'loading', 'empty', 'data'];

  /* 四态文案（空 / 加载 / 失败 / 离线）。
   * 注意「失败」的标题与副文案不在这里：它随错误 key 变（见 ERR），
   * 这里只留按钮上的通用动词。
   *
   * ★ 离线有两个副文案（fix2 / F1，制作人裁定 R8）：
   *   sub      —— strip 形态（本机有记录）：横条要说的是"先给你看这台设备上的"。
   *   subPanel —— panel 形态（本机 0 局）：这台设备上**什么都没有**，
   *              再写"先给你看这台设备上的记录"就是假话。
   *   为什么允许一态两文案（原本 §⑤-b 要求一个块共用一套文案）：那条规则的目的
   *   是"两块必然两套文案、迟早不一致"，而这里仍是一个块、一处文案表、按形态取值 ——
   *   坏处没有，假话没有了。**不能因为一条美学规则说假话。** */
  var STATE_TEXT = {
    empty: { title: '还没有战绩，去开一局吧', sub: '打完一局自动记下' },
    loading: { title: '正在读取战绩…', sub: '', slow: '比平时慢一点，再等等' },
    fail: { title: '账号数据没读上来', sub: '这台设备上也没有可显示的战绩' },
    offline: {
      title: '现在没有网络',
      sub: '先把这台设备上的记录给你看',
      subPanel: '连上网就能看到账号里的记录'
    }
  };

  /* 错误三级 + 文案（design §②-a 的 11 个 key，一个不多一个不少）。
   *
   * `actions` 是**动作**不是文案：视图按 act 派发，label 只是它的字。
   * 这样「不可恢复类不许出现『再试一次』」变成一条可机检的事：
   * fatal 的 label 里只要出现 再试/重试 就红（单测 S12）。
   *
   * `report` 是这一条错误的上报口径（kind / message / source），
   * 视图只负责把 extra（status、elapsedMs）合进去再交给 ErrorReport.capture。
   * 不在视图里散写 capture 参数，是为了让"这类错该不该上报"只有一处答案。
   */
  var ERR = {
    /* ── 可重试（L1）：再点一次有可能变好 ───────────────────────── */
    'err.net.offline': {
      level: 'retry',
      title: '现在没有网络',
      sub: '先把这台设备上的记录给你看',
      /* 「重新载入」而不是「再试一次」：这个动词告诉玩家"会重新走一遍"，
       * 泛词做不到（design §②-c）。 */
      actions: [{ label: '重新载入', act: 'reload' }],
      report: { kind: 'net', message: 'err.net.offline', source: 'recordsView.js#offline' }
    },
    'err.net.timeout': {
      level: 'retry',
      title: '账号数据没读上来',
      sub: '这台设备上也没有可显示的战绩',
      actions: [{ label: '再读一次', act: 'retry' }, { label: '先开一局', act: 'create' }],
      report: { kind: 'net', message: 'err.net.timeout', source: 'recordsView.js#loadCloudRecords' }
    },
    'err.net.server': {
      level: 'retry',
      title: '账号数据没读上来',
      /* 5xx 与 429 混成一档会让"服务器炸了"和"人太多"共用一句话，
       * 所以 429 在视图侧换副文案（见 sub429）。 */
      sub: '服务器那边没应声，过一会儿再来',
      sub429: '人有点多，过一会儿就好',
      actions: [{ label: '再读一次', act: 'retry' }, { label: '先开一局', act: 'create' }],
      report: { kind: 'net', message: 'err.net.server', source: 'recordsView.js#loadCloudRecords' }
    },
    'err.net.rank': {
      level: 'retry',
      title: '榜单没读上来',
      sub: '可能网络不稳，过一会儿再看',
      actions: [{ label: '刷新榜单', act: 'refresh' }],
      report: { kind: 'net', message: 'err.net.rank', source: 'recordsView.js#renderRank' }
    },

    /* ── 不可恢复（L2）：再点一次也不会好，只给一条正确出路 ──────── */
    'err.data.no_storage': {
      level: 'fatal',
      title: '这个浏览器存不了战绩',
      /* 把"改条件"说出来，而不是把"再点一次"说出来 */
      sub: '关掉无痕模式，或换个浏览器',
      actions: [{ label: '照样开一局', act: 'create' }],
      report: { kind: 'data', message: 'err.data.no_storage', source: 'recordsView.js#renderRecords' }
    },
    'err.data.auth': {
      level: 'fatal',
      title: '登录已经过期了',
      sub: '重新登录就能看到账号里的记录',
      actions: [{ label: '重新登录', act: 'login' }],
      /* 身份类错误的上下文只留 status：上报里不放任何能认出人的东西 */
      report: { kind: 'data', message: 'err.data.auth', source: 'recordsView.js#loadCloudRecords' }
    },
    'err.data.malformed': {
      level: 'fatal',
      /* 不占标题位：它不独占屏，页面按本机数据继续，只在页脚说一句 */
      title: '',
      sub: '账号数据格式不对，先看本机的',
      actions: [],
      report: { kind: 'data', message: 'err.data.malformed', source: 'recordsView.js#loadCloudRecords' }
    },
    'err.data.quota': {
      level: 'fatal',
      title: '本机存不下了',
      sub: '清掉一些旧记录就能继续记',
      actions: [{ label: '清一下旧记录', act: 'clear' }],
      report: { kind: 'data', message: 'err.data.quota', source: 'recordsView.js#recordSettled' }
    },

    /* ── 静默（L3）：玩家不需要知道，但我们得知道 ────────────────── */
    'err.silent.profile': {
      level: 'silent', title: '', sub: '', actions: [],
      report: { kind: 'net', message: 'err.silent.profile', source: 'recordsView.js#loadCloudRecords' }
    },
    'err.silent.purge': {
      level: 'silent', title: '', sub: '', actions: [],
      report: { kind: 'net', message: 'err.silent.purge', source: 'recordsView.js#purgeDeletedIdentities' }
    },
    'err.silent.prefetch': {
      level: 'silent', title: '', sub: '', actions: [],
      /* 每会话一次：capture 自带 seenKeys 去重与 MAX_PER_SESSION，
       * 所以这里**不写节流** —— 写新节流就是重复造（design §②-a 末行）。 */
      report: { kind: 'net', message: 'err.silent.prefetch', source: 'recordsView.js#prefetch' }
    }
  };

  /* 错误 key → 级别。唯一的来源是 ERR[key].level，这里只是把它读出来，
   * 不另存一张表：两张表必然有一天不一致，而"同一错误码属于两个级别"
   * 正是 QA S11 的负向断言。 */
  function errClassOf(key) {
    var e = ERR[key];
    /* 未知 key 一律按不可恢复处理：这是唯一**不会**骗玩家的默认 ——
     * 把不可恢复说成"再试一次"，只会让他多点一次然后更困惑。 */
    return e && e.level ? e.level : 'fatal';
  }

  /**
   * 现在是哪个态。纯函数，入参全是显式字段（不读全局，便于单测）。
   * @param {object} input
   *   online       是否联网（`navigator.onLine !== false`）
   *   cloudErr     云端档案的失败原因（空串 = 这次打开还没失败过）
   *   cloudLoading 云端档案请求在途
   *   hasData      确实有可显示的数据（本机或云端）
   *   avail        这台设备能不能存战绩（无痕 / 配额 0 时为 false）
   * @returns {'offline'|'fail'|'loading'|'empty'|'data'}
   */
  function recordsStateOf(input) {
    var i = input || {};
    /* ① 离线最高：它是"原因"，玩家该做的是连网，不是点一个注定失败的「再读一次」 */
    if (i.online === false) return 'offline';
    /* ② 失败：云端读挂了，或者这台设备根本存不了（不可恢复类也算失败态）。
     *    ★ 本机还有数据时**不占满屏**：降级为页脚一行（design §①-d / ⑤-c），
     *    所以这里返回 data —— 载体与状态值必须一一映射，"失败"的载体是
     *    #records-fail，它没出现就不该说自己是 fail。 */
    if (i.cloudErr || i.avail === false) return i.hasData ? 'data' : 'fail';
    /* ③ 加载压过空：还不知道的时候不能说"没有" */
    if (i.cloudLoading) return 'loading';
    if (i.hasData) return 'data';
    return 'empty';
  }

  /**
   * 一次云端档案请求的结果 → 错误 key。
   *
   * 以前所有网络异常都被归成一句「网络不太好」，于是"该重试的"和"该重新登录的"
   * 长得一模一样。这条映射就是那次修正：粒度的最小单位是**玩家能采取的动作**。
   *
   * @param {object} res AuthStore.myRecords() 的回包：
   *        { ok, error, status?, offline? }；null 表示连回包都没有
   */
  function errKeyOf(res) {
    if (!res) return 'err.net.timeout';
    /* fetch 本身 reject（断网 / DNS / 超时）：请求没到服务端，再来一次有可能好 */
    if (res.offline) return 'err.net.timeout';
    var status = Number(res.status) || 0;
    if (status === 401 || status === 403 || status === 404) return 'err.data.auth';
    if (status === 429 || status >= 500) return 'err.net.server';
    /* 其余（4xx 里的 400/409、以及业务层 ok:false 但没给状态码）：说得清的是
     * "这次没读到"，再来一次有可能好，所以归可重试。
     * ★ 200 但缺必需字段那种不算这里 —— 它需要看回包体，由
     *   `profileLooksValid()` 在写入缓存前判，归 err.data.malformed。 */
    return 'err.net.timeout';
  }

  /**
   * 成就入口那个数字（`#ach-entry-num`）该写什么：`'n/N'` 还是 `'—/N'`。
   *
   * ── 为什么这不是"文案问题"而是状态问题（fix1 / M3）────────────────
   * 「拿不到确定值」和「一个都没解锁」是两件事，但它们在页面上长得一模一样：
   * 只要写成 `0/N`，玩家读到的是后者。加载中 / 离线 / 失败这三种状态下
   * 我们**没问过账号**，所以那不是"0 个成就"，是"不知道"。
   * 这正是设计 §①-d 明令禁止的那件事（用未知冒充零），也是 QA §3 反例③
   * 的同一类错误：数字真的写出来了，只是它是假的。
   *
   * ── 为什么分母留着 ───────────────────────────────────────────────
   * 分母由成就目录长度决定，是**确定值**；分子才是未知的那个。
   * 保住 `x/N` 的形状有三个好处：不跳版（两行字一样宽）、玩家知道总量、
   * 断言可以只看分子。写成一枚孤零零的 `—` 会让人以为这栏坏了。
   *
   * @param {number|string|null|undefined} value 已解锁数；`null` / `undefined` / `''` = 未知
   * @param {number} total 成就总数（`Ach.TOTAL`）
   * @returns {string} `'3/35'` / `'0/35'`（0 是合法值）/ `'—/35'`（未知）
   */
  function achLabel(value, total) {
    var t = Number(total);
    var hasTotal = isFinite(t) && t > 0;
    var denom = hasTotal ? String(Math.floor(t)) : '';
    /* '' 会被 Number() 悄悄变成 0 —— 先把"空"归到未知，否则空串会伪装成"0 个" */
    var n = (value === null || typeof value === 'undefined' || value === '') ? NaN : Number(value);
    if (!isFinite(n)) return '—' + (denom ? '/' + denom : '');
    /* 负数不是合法计数：宁可按 0 处理，也不让 -1/35 上屏 */
    return Math.max(0, Math.floor(n)) + (denom ? '/' + denom : '');
  }

  /**
   * 云端档案的形状检查：`totalNet` / `games` 为 undefined 就是畸形。
   * 单独一个函数是因为它有两个调用点（写入缓存前、渲染前），
   * 而且单测要能直接喂畸形样本。
   */
  function profileLooksValid(p) {
    if (!p || typeof p !== 'object') return false;
    if (typeof p.totalNet === 'undefined') return false;
    if (typeof p.games === 'undefined') return false;
    return true;
  }

  return {
    STATE_DELAY_MS: STATE_DELAY_MS,
    STATE_SLOW_MS: STATE_SLOW_MS,
    STATES: STATES,
    STATE_TEXT: STATE_TEXT,
    ERR: ERR,
    errClassOf: errClassOf,
    recordsStateOf: recordsStateOf,
    errKeyOf: errKeyOf,
    achLabel: achLabel,
    profileLooksValid: profileLooksValid
  };
});
