/**
 * 数值配置表（策划可直接修改）
 * 说明：斗牛赢分等已在 engine.js 的 Engine.CONFIG 中有默认值，此处覆盖。
 * 本文件在页面中先于 game.js 加载，并调用 Engine.setConfig 同步。
 * 同时支持 Node require（供状态机单测使用）与浏览器全局变量两种方式。
 */
(function (global, factory) {
  var mod = factory(global);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = mod;
  } else {
    global.CONFIG = mod;
  }
})(typeof self !== 'undefined' ? self : this, function (global) {
  'use strict';

  var CONFIG = {
    // 房间与人数
    MIN_PLAYERS: 2,          // 最少开局人数
    MAX_PLAYERS: 5,          // 最多人数
    /* ★ 人数上限只对**新建的房间**生效。
     * 改小上限时，线上已有的房间不能当场被限：8 人房正在打，第 5 个人之后
     * 的座位会在下一帧「画不出来」（slotCount 变小、人还在 players 里）。
     * 所以建房时把上限抄进 room.cap，之后一律读 room.cap ——
     * 老房间继续用老上限，新房间用新上限，两边都不出怪事。
     * 读取一律走 StateMachine.capOf(room)，不要再直接读 MAX_PLAYERS。 */
    ROOM_ID_LENGTH: 6,       // 房间号位数

    /* 本局局数（把数上限）。一把 = 2 轮，所以 10 局 = 20 轮。
     * 建房时从这几档里选一个，写进 room.handLimit；房间内不可改，续局沿用。
     * 白名单只写在这里，stateMachine.normalizeHandLimit 和服务端建房共用它 ——
     * 两处各写一份，迟早会出现"前端能选 15、后端按 10 处理"这种错位。 */
    HAND_LIMITS: [3, 5, 10, 15, 30],
    DEFAULT_HAND_LIMIT: 10,   // 不选其他值时的默认档（产品要求写死 10）

    // 牌局
    DECK_SIZE: 53,
    CARDS_PER_PLAYER: 6,

    /* 分数基准 = 0，**不是设计疏忽，是唯一自洽的值**。
     *
     * v103 删掉「见底出局」之后，这个参数失去了全部功能：
     * 不是筹码池（输光不淘汰）、不是保底（负分照样继续打）、不参与胜负判定
     * （胜负只看牌型）。它剩下的唯一作用，就是给「净胜 = 最终分 − 初始分」
     * 当那个减数 —— 于是玩家看到「最终 27 分 · 净胜 +7」时得自己在脑子里做一次减法。
     *
     * 更要紧的是它会**说错话**：房间卡上写着「起始 20 分」，读起来像是在告诉你
     * 兜里有 20 个筹码、输完了会出局。可这套规则根本不存在。一个人看到
     * 「还剩 3 分」以为自己快死了，其实还有 10 局要打。
     *
     * 归零之后三件事同时变清楚：
     *   · 净胜 = 最终分（27 就是 +27，-8 就是输 8），一眼可读；
     *   · 负分是常态而不是异常（本来就允许负分跨局累计）；
     *   · 房间卡不再暗示一个不存在的机制。
     *
     * ★ 老战绩不受影响：档案里存的是 myStartScore 快照（当时是 20），
     *   回放读快照不读这里。新老记录各自算各自的净胜，都正确。 */
    INITIAL_SCORE: 0,

    // 结算（与 engine 默认一致，集中在此便于改数值）
    SINGLE_WIN: 1,
    TENHALF_WIN: 1,               // 十点半：普通赢家收每人分
    TENHALF_MAX_WIN: 2,           // 十点半：赢家正好 10.5 点（含王撑出来的）收每人分
    PIAOSANYE_WIN: 1,             // 飘三叶：基础分（每个对手必付）
    PIAOSANYE_LEOPARD_BONUS: 1,   // 飘三叶：场上每有一个豹子（含赢家自己），每个对手额外多付 1 分
                                  // 每人付 = 1 + BONUS × 场上豹子总数；4 人 3 豹 → 4 分/人、总收 12
    DOUNIU_WIN_POINTS: {
      WUHUA: 4,   // 五花牛
      NIUNIU: 3,  // 牛牛
      NIU89: 2,   // 牛8/牛9
      NIU17: 1,   // 牛1~牛7
      NONE: 1     // 没牛（全没牛时赢家保底）
    },
    DOUNIU_NONE_PENALTY: 5,

    /* ---------------------------- 功能开关 ----------------------------
     * 只放「能一行翻回去」的开关，不放参数。每个开关都要满足两条：
     *   ① 关掉之后行为与开关上线前完全一致（不是「差不多」）；
     *   ② 关掉不需要发版、不需要清缓存，刷新即生效。
     * 灰度期出问题的第一动作是翻开关，不是回滚版本。 */
    TABLE_READY: true,   // 准备态画在牌桌上（false = 回到独立的 #screen-room）
    /* 表情 / 短语（R4）。关掉同时做两件事：顶栏不出入口、收到别人的表情也不画。
     * 只关一半会留下一个诡异状态：自己发不出去，却能看见别人发 —— 
     * 用户只会以为「我这台手机坏了」。 */
    EMOJI: true,
    /* 头像上传照片（v89 §9.3 · P1b）。**默认关**，而且不建议随手打开。
     *
     * 关掉时：换头像面板里没有「上传」入口，服务端那条 POST 也没有界面能调到它。
     * 打开的前提不是改这一行，而是先具备三样东西：
     *   ① 举报入口（服务端 /api/me/avatar/report 已就绪，日志在 data/avatars/reports.log）
     *   ② 有人真的看那份日志，并且有处置动作（下架 / 封号）
     *   ③ 一句写清楚的用户协议（不得上传他人肖像、违法内容）
     * 三样缺一样，开了就是把风险直接放给全桌 —— 文档 §9.3 自己也是这个结论。 */
    AVATAR_UPLOAD: false,

    /* 圆桌座位环（v87）。关掉 = 回到 v86 的「玻璃顶栏 + 横排座位条」，一个像素都不差。
     *
     * 为什么它是开关而不是参数：这是本项目第一次搬动对局页的**骨架**。
     * 座位环吃掉 450 设计px（顶栏原本 182），组槽因此从 816 压到 ~550、牌面从
     * 139×195 缩到 117×164。这一段里任何一环出问题，玩家看到的是「牌变小了」
     * 或者「对手头像跑到屏幕外」—— 都不是能靠调参数收场的。
     *
     * 只对竖屏生效：横屏的「左桌右盘」重排是 v88 的事，这一版横屏保持 v86 版式
     * （见 game.js 的 seatRingOn()）。所以横屏玩家关不关这个开关都一样。 */
    SEAT_RING: true,

    /* 开局 3 秒倒计时（v90）—— **默认关，而且建议一直关着**。
     *
     * 线上是「全员准备即开」（stateMachine.autoStartIfReady），比倒计时快，
     * 也不会出现「第 3 个人干等第 5 个人点准备」那种尴尬。原型里那 3 秒是给评审和录屏用的
     * （见 docs/circle-table-rollout-status.md §3.3 第 11 项）。
     *
     * 所以它做成 URL 开关：`?startcountdown=1` 打开、`=0` 关掉
     * （参数名与 CONFIG 的键同名，与 ?seatring / ?tableready 是同一套说法）。这一层只是盖在牌桌上的遮罩，
     * **不改变任何时序** —— 牌在服务端已经发了，倒计时结束才看见而已。
     * 房主「现在开局」那个按钮没有做：它要改 canStart 的规则（现在是「全员准备」），
     * 等于把已经删掉的开局按钮再装回来，产品上也确实更快没有更好。 */
    START_COUNTDOWN: false,

    /* 牌型特写幕（v98）—— **默认开**，这是游戏本身的一部分，不是排障工具。
     *
     * 豹子 / 牛牛 / 五花牛 / 10.5 结算之前放一整幕：旋转 conic 金环、
     * 三道冲击波、14 颗粒子、赢家的牌砸下来、108px 牌型大字，
     * 豹子与五花牛还震一下。设计出处见 docs/prototypes/circle-table.html 的 .fx 层。
     *
     * 关掉的两个场合：
     *   · `?fx=0` —— 探针只验结算卡内容时，没必要跟着等这 1.7 秒；
     *   · 系统开了「减少动态效果」—— 代码里另有一道判断，这里只是总闸。
     * 关掉之后结算卡立刻出现，其余行为完全一致（不会丢分数、不会错人）。 */
    PATTERN_FX: true,

    /* 调试侧栏（v91）—— **默认关，只给「在真机上排版式问题」用**。
     *
     * 原型里那套侧栏（三端切换 / 场景 A·B / 播放整局 / 特效演示 / 头像大小档 /
     * `window.__proto` 钩子）是评审工具，文档 §3.3 第 10 项自己写着
     * 「正式实现里不会存在」。这里只保留对排障有用的一半：
     *   ① 现在到底是哪一档版式（圆桌档位 / 舞台 / 组槽 / 牌面）；
     *   ② 三个 URL 开关的一键翻转（省得在手机上打两遍地址）。
     * **不发任何假数据**：场景 A·B、播放整局、`__proto` 钩子都不做 ——
     * 它们一旦进了正式包，就等于在线上留了一个「跳过服务端造局」的入口，
     * 而排查版式问题根本用不上它。
     *
     * 打开方式：`?dev=1`（关掉 `?dev=0`，与其它开关同一套说法）。 */
    DEV_PANEL: false,

    // UI 设计分辨率
    DESIGN_WIDTH: 750,
    DESIGN_HEIGHT: 1624,

    // 牌面绘制尺寸（设计像素，内部按 2x 渲染保证清晰）
    CARD_W: 100,
    CARD_H: 140
  };

  // 同步给引擎。
  // 浏览器：engine.js 已先加载成全局 Engine；
  // Node：engine.js 是 IIFE + module.exports，**不会挂到 global**，所以
  // `global.Engine` 恒为 undefined —— 以前只写前一种，服务端 require 本文件时
  // setConfig 分支永远不执行，于是「改 config.js 双端同时生效」这句承诺是假的：
  // 浏览器用新数值、服务端仍用 engine.js 内置默认值，同一局两边算出来的分数不同。
  var eng = global.Engine || (typeof Engine !== 'undefined' ? Engine : null);
  if (!eng && typeof module !== 'undefined' && module.exports) {
    try { eng = require('./engine.js'); } catch (e) { eng = null; }
  }
  if (eng && eng.setConfig) {
    eng.setConfig({
      INITIAL_SCORE: CONFIG.INITIAL_SCORE,
      SINGLE_WIN: CONFIG.SINGLE_WIN,
      TENHALF_WIN: CONFIG.TENHALF_WIN,
      TENHALF_MAX_WIN: CONFIG.TENHALF_MAX_WIN,
      PIAOSANYE_WIN: CONFIG.PIAOSANYE_WIN,
      PIAOSANYE_LEOPARD_BONUS: CONFIG.PIAOSANYE_LEOPARD_BONUS,
      DOUNIU_WIN_POINTS: CONFIG.DOUNIU_WIN_POINTS,
      DOUNIU_NONE_PENALTY: CONFIG.DOUNIU_NONE_PENALTY
    });
  }

  return CONFIG;
});
