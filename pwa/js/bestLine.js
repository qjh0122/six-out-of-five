/**
 * 复盘：这一手牌，如果分得最好的话能拿几分（P1-1 / B1）
 *
 *   前端 pwa/   → <script src="js/bestLine.js"> → global.BestLine
 *   测试         → require('../pwa/js/bestLine.js')
 *
 * ── 这个模块在回答什么问题 ──────────────────────────────────────────
 *
 * 「理论上最高能拿 X 分，你实际拿了 Y 分。」
 *
 * 注意是**事后**最优，不是事前最优：算的时候所有人的牌都摊开了，所以得到的是
 * 确定值，不是期望值。事前最优需要预测对手的牌，那是猜，不是「理论最高」。
 *
 * ── 三条不能破的约束 ────────────────────────────────────────────
 *
 * 1. **只用 Engine.settleGroup 算分，不自己写比较逻辑。**
 *    这个项目所有的「谁赢、赢几分」只有一份实现。如果这里另写一套，某天引擎改规则，
 *    复盘会说「你能拿 6 分」而实际结算给 5 分 —— 那比没有这个功能更糟，
 *    因为玩家会当场发现游戏在胡说。
 *    测试里有一条交叉验证专门钉这个：拿**实际用过的分法**跑一遍，结果必须等于实际净胜。
 *
 * 2. **十点半爆点的分法不参与最优。**
 *    爆点会被弹窗硬挡住、提交不上去（v103 起）。把一个「你根本提交不了的分法」
 *    算成理论最高，等于告诉玩家「你错在没做一件做不到的事」。
 *    唯一的例外：整手牌怎么分都爆（极端烂牌），这时退回全体里取最优 ——
 *    和 ai.js 的 `bestSafe || best` 同一口径，也与爆点弹窗的兜底一致。
 *
 * 3. **两轮分别枚举，结果相加，不相乘。**
 *    第一轮（1+2+3）60 种、第二轮（1+5）6 种。两轮用的是同一副 6 张，但分别结算、
 *    互不约束，所以各自取最优再相加就是整把的最优。相乘会得到 360 种，
 *    多出来的 300 种是「第一轮这么分、第二轮必须那样分」这种不存在的耦合。
 *
 * ── 成本 ─────────────────────────────────────────────────────
 *
 * 第一轮 60 × 3 组 = 180 次 settleGroup，第二轮 6 × 2 = 12 次，合计 192 次。
 * 每次是纯算术加少量排序，本机实测整把 < 30ms。结算页渲染前算一次可以接受；
 * 回放不走这里（打包时算好存进 pack，见 historyKit）。
 */
(function (global, factory) {
  var Engine = (typeof require === 'function')
    ? require('./engine.js')
    : global.Engine;
  var mod = factory(Engine);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = mod;
  } else {
    global.BestLine = mod;
  }
})(typeof self !== 'undefined' ? self : this, function (Engine) {
  'use strict';

  /* 同上：分组形状必须与 stateMachine 的 ROUND_GROUPS 一致。
   * 这里抄一份常量而不是 require 状态机，是因为状态机依赖 Card/Config，
   * 而复盘只需要「有哪些组、每组几张」。哪天分组改了，两边会不同步 ——
   * 所以测试里有一条拿 ROUND_GROUPS 与这里交叉比对的守卫。 */
  var ROUND_GROUPS = {
    1: ['single', 'tenhalf', 'piaosanye'],
    2: ['single', 'douniu']
  };

  /* 我在 settleGroup 里的临时 id。
   * 不能用 'me' 之类可能与真实 id 撞车的值 —— 真实 id 形如 `p-k3j9` / `bot_3`，
   * 万一撞上，deltas 会把两个人的分记到同一个人头上。加双下划线前缀并保持全库唯一。 */
  var ME = '__bestline_me';

  function isBust(hand) {
    try { return !!Engine.tenHalfBust(hand); } catch (e) {
      /* 引擎没有这个方法（老版本缓存）时不能假装「不爆」—— 那会静默算错。
       * 抛出去让调用方决定（结算页会整块不显示），比给一个假数字强。 */
      throw new Error('bestLine: Engine.tenHalfBust 缺失，无法判断爆点');
    }
  }

  /**
   * 按给定分法算我这一轮的净得。
   *
   * ★ v130 修正：`others` 必须是**按组切好的**，不能是整手 6 张。
   *
   * 以前的签名是 `netOf(round, others, split)`，`others` 里每人是整手 6 张，
   * 然后原样拼进每一个组 —— 于是「单张组」变成我 1 张 vs 对手 6 张、
   * 「斗牛组」变成我 5 张 vs 对手 6 张。对手的牌被当成了不属于那个组的形状，
   * 而这是**每把结算都显示给玩家看的数字**。
   *
   * 为什么没被发现：`best-line.test.js` 的「交叉验证」把被测函数抄了一遍当期望值
   * （同一个 `.concat(others)` 表达式、同一份整手夹具），两边用同一个错前提，恒绿。
   * 现在期望值改成从**真实结算记录**里取（`ofHand` 的 cross-check），不再抄实现。
   *
   * @param {number} round   1 或 2
   * @param {object} othersByMode  { single:[{id,hand}], tenhalf:[...], piaosanye:[...], douniu:[...] }
   *                               **每组只放该组的那几张**，不含我
   * @param {object} split   { single:[], tenhalf:[], piaosanye:[], douniu:[] }
   * @returns {number} 我在这一轮的净分数变化（可负）
   */
  function netOf(round, othersByMode, split) {
    var keys = ROUND_GROUPS[round];
    if (!keys) throw new Error('bestLine: 未知轮次 ' + round);
    var net = 0;
    for (var i = 0; i < keys.length; i++) {
      var mode = keys[i];
      var theirs = (othersByMode && othersByMode[mode]) || [];
      var entries = [{ id: ME, hand: (split && split[mode]) || [] }].concat(theirs);
      var r = Engine.settleGroup(mode, entries);
      net += (r && r.deltas && r.deltas[ME]) || 0;
    }
    return net;
  }

  /* 第一轮：6 张拆成 1 / 2 / 3。i 选单张，rest 里选 2 张给十点半，剩 3 张给飘三叶。 */
  function eachSplit1(hand, fn) {
    for (var i = 0; i < 6; i++) {
      var rest = [];
      for (var x = 0; x < 6; x++) if (x !== i) rest.push(hand[x]);
      for (var a = 0; a < 4; a++) {
        for (var b = a + 1; b < 5; b++) {
          var tenhalf = [rest[a], rest[b]];
          var psy = [];
          for (var y = 0; y < 5; y++) if (y !== a && y !== b) psy.push(rest[y]);
          fn({ single: [hand[i]], tenhalf: tenhalf, piaosanye: psy, douniu: [] }, tenhalf);
        }
      }
    }
  }

  /* 第二轮：6 张拆成 1 / 5。 */
  function eachSplit2(hand, fn) {
    for (var i = 0; i < 6; i++) {
      var douniu = [];
      for (var x = 0; x < 6; x++) if (x !== i) douniu.push(hand[x]);
      fn({ single: [hand[i]], tenhalf: [], piaosanye: [], douniu: douniu }, null);
    }
  }

  /**
   * 这一轮的最优分法与它能拿到的净分数。
   *
   * @param {number} round
   * @param {Array}  myHand    我的 6 张（弃权/不足 6 张 → 返回 null）
   * @param {object} othersByMode  按组切好的对手手牌（见 netOf 的说明）
   * @returns {{net:number, split:object, busted:boolean, tried:number}|null}
   *          busted=true 表示整手牌怎么分十点半都会爆（只能退回全体取最优）
   */
  function bestOf(round, myHand, othersByMode) {
    var keys = ROUND_GROUPS[round];
    if (!keys) throw new Error('bestLine: 未知轮次 ' + round);
    if (!myHand || myHand.length !== 6) return null;

    var best = null;          // 全体最优
    var bestSafe = null;      // 「十点半不爆」里的最优
    var tried = 0;

    function consider(split, tenhalf) {
      tried += 1;
      var net = netOf(round, othersByMode, split);
      var bust = tenhalf ? isBust(tenhalf) : false;
      if (!best || net > best.net) best = { net: net, split: split, busted: bust };
      if (!bust && (!bestSafe || net > bestSafe.net)) {
        bestSafe = { net: net, split: split, busted: false };
      }
    }

    if (round === 1) eachSplit1(myHand, consider);
    else eachSplit2(myHand, consider);

    if (!best) return null;
    /* 优先不爆的分法；全都爆才退回全体最优（与 ai.js / 爆点弹窗的兜底同口径）。 */
    var pick = bestSafe || best;
    return { net: pick.net, split: pick.split, busted: !bestSafe, tried: tried };
  }

  /**
   * 整把（两轮）的最优净胜 = 第一轮最优 + 第二轮最优。
   *
   * @param {object} rounds  { 1: { myHand, others }, 2: { myHand, others } }
   * @returns {{net:number, byRound:object, missing:boolean}}
   *          missing=true 表示至少一轮缺少手牌（弃权/离开），此时 net 只是已有轮次的和
   */
  function bestOfHand(rounds) {
    var byRound = {};
    var total = 0;
    var missing = false;
    [1, 2].forEach(function (r) {
      var input = rounds && rounds[r];
      if (!input) { missing = true; return; }
      var one = bestOf(r, input.myHand, input.others);
      if (!one) { missing = true; return; }
      byRound[r] = one;
      total += one.net;
    });
    return { net: total, byRound: byRound, missing: missing };
  }

  /* ── 从 history 的已结算记录里还原 ──────────────────────────────
   *
   * 结算页拿到的是 `room.history`（状态机在 settleRound 里归档的），
   * 而不是 `p.groups`。原因有两个：
   *   1. 下一把 dealAll 会把 groups 覆盖掉，结算页那时候已经读不到了；
   *   2. history 是**唯一**同时带「手牌 + 每组 deltas」的地方，两样都算最优缺一不可。
   *
   * 一手 6 张牌在 history 里是被切成组的（第一轮 1+2+3、第二轮 1+5），
   * 所以还原时要把同一个人在各组里的 hand 拼回去。拼出来不够 6 张就说明
   * 有组缺了（弃权 / 老数据），这时不猜，直接当作算不了。
   */

  /** 从一轮结算记录里拼出某人的完整手牌 */
  function handFromRound(roundObj, pid) {
    var out = [];
    var groups = (roundObj && roundObj.groups) || [];
    for (var i = 0; i < groups.length; i++) {
      var rows = groups[i].entries || [];
      for (var j = 0; j < rows.length; j++) {
        if (rows[j].id === pid && rows[j].hand && rows[j].hand.length) {
          out = out.concat(rows[j].hand);
        }
      }
    }
    return out;
  }

  /** 某人这一轮实际拿到的净分（就是各组 deltas 的累加） */
  function actualOfRound(roundObj, pid) {
    var sum = 0;
    var groups = (roundObj && roundObj.groups) || [];
    for (var i = 0; i < groups.length; i++) {
      var d = groups[i].deltas && groups[i].deltas[pid];
      if (d) sum += d;
    }
    return sum;
  }

  /**
   * 从一轮结算记录里，**按组**取出别人的手牌。
   *
   * ★ v130 的修复点就在这个函数的存在本身。
   *
   * 以前的做法是 `handFromRound(h, oid)` 把某人三个组的手牌拼成整手 6 张，
   * 然后整手塞进每一个组的结算 —— 单张组变成「我 1 张 vs 他 6 张」。
   *
   * 而 history 的每组 entries 里本来就有「这个人在这一组用的那几张」
   * （`stateMachine.settleRound` 归档时写进去的 `hand`）。按组取，才是引擎
   * 结算时看到的东西。这也是 history 值得留 4 条的理由 —— 它是唯一同时带
   * 「每组手牌」与「每组 deltas」的地方。
   */
  function othersByModeFrom(roundObj, pid) {
    var by = {};
    var groups = (roundObj && roundObj.groups) || [];
    for (var i = 0; i < groups.length; i++) {
      var mode = groups[i].group;
      if (!mode) continue;
      var rows = groups[i].entries || [];
      var list = by[mode] || (by[mode] = []);
      for (var j = 0; j < rows.length; j++) {
        var r = rows[j];
        if (!r || !r.id || r.id === pid) continue;
        if (!r.hand || !r.hand.length) continue;   // 空手牌 = 弃权，不参与选赢家
        list.push({ id: r.id, hand: r.hand });
      }
    }
    return by;
  }

  /**
   * 一「局」（= 一次发牌，正常两轮）的复盘。
   *
   * 口径（v130 按负责人要求定下）：
   *   · **两轮都打到** → 给这一局合并后的一个数字（理论最高 = 两轮最优之和）；
   *   · **只打到一轮**（中途解散 / 有人离开 / 归档丢了）→ `complete=false`，
   *     调用方改用 `byRound` 按轮分别显示。**不许把单轮的数字说成「整局」。**
   *
   * @param {Array}  rounds  同一局（同一 hid）的轮次记录（stateMachine 归档的那种结构）
   * @param {string} pid     看谁的视角
   * @returns {{best:number, actual:number, diff:number, rounds:number,
   *            complete:boolean, byRound:Array}|null}
   *          null = 数据不足（手牌拼不齐 / 不是 6 张），调用方应整块不显示
   */
  function ofHand(rounds, pid) {
    var list = (rounds || []).filter(function (h) { return h && h.groups && h.groups.length; });
    if (!list.length || !pid) return null;

    var totalBest = 0;
    var totalActual = 0;
    var byRound = [];
    var seen = {};

    for (var k = 0; k < list.length; k++) {
      var h = list[k];
      var my = handFromRound(h, pid);
      /* 只认正好 6 张的轮次：拼出 5 张或 7 张说明数据有问题，
       * 硬算会得出一个「理论上最高」比实际还低的荒谬数字。 */
      if (my.length !== 6) continue;

      var one = bestOf(h.round || 1, my, othersByModeFrom(h, pid));
      if (!one) continue;
      var act = actualOfRound(h, pid);
      totalBest += one.net;
      totalActual += act;
      seen[h.round || 1] = 1;
      byRound.push({
        round: h.round || 1, best: one.net, actual: act,
        diff: one.net - act, busted: one.busted
      });
    }

    if (!byRound.length) return null;
    /* 正常两轮都有；只有一轮 → 这一局没打完，别把单轮说成整局 */
    var complete = !!seen[1] && !!seen[2];
    return {
      best: totalBest,
      actual: totalActual,
      diff: totalBest - totalActual,
      rounds: byRound.length,
      complete: complete,
      byRound: byRound
    };
  }

  /**
   * 从 history 里取出「刚打完的那一把」的所有轮次。
   *
   * ★ 为什么不能用 `room.handId` 过滤（实测踩过）：结算页读到 handId=2，
   *   而 history 里那两条记录的 hid 都是 1 —— 按 handId 过滤得到 0 条，
   *   复盘行整块消失，页面其余部分完全正常、没有任何报错。
   *
   *   原因：handId 属于「当前这一把」，结算页展示的是「上一把的结果」。
   *   打完一把 → 归档进 history（hid=1）→ 开下一把 dealAll 把 handId 加到 2。
   *   结算页在这两步之间渲染过、也在之后渲染过，两次 handId 不同，
   *   但 history 的最后一条始终指向那把打完的牌。
   *
   * 「最后一条」而不是「最大 hid」：history 是 append-only 的，末位就是最近一次结算。
   *
   * @param {Array} hist  room.history
   * @returns {Array} 同一把的轮次记录（可能为空）
   */
  function lastHandRounds(hist) {
    var list = Array.isArray(hist) ? hist : [];
    if (!list.length) return [];
    var last = list[list.length - 1];
    var hid = last.hid || last.hand || 1;
    return list.filter(function (h) {
      return (h.hid || h.hand || 1) === hid;
    });
  }

  /**
   * **整场**的复盘（v131 用户裁决：只在对局结束后，给整场合并的一个数）。
   *
   * 口径：把每一把（两轮）的最优与实得分**分别求和**，再给一次总数。
   *   理论最高（整场） = Σ 每把的最优
   *   你拿了（整场）   = Σ 每把的实际
   * 不相乘、不取平均 —— 玩家读到的是「这十把加起来，你本可以多拿几分」。
   *
   * 「按把求和」而不是「拿整场的历史重新枚举」：每一把的对手分法只在那把有效，
   * 跨把比较没有意义（牌不同、人也可能换）。所以逐把算、再相加。
   *
   * @param {Array}  hist  room.history（整场的轮次记录；调用前应已确认对局结束）
   * @param {string} pid   看谁的视角
   * @returns {{best:number, actual:number, diff:number, hands:number, partial:number}|null}
   *          partial = 有几把只打到一轮（中途解散 / 有人离开），单独报出来，
   *          免得玩家以为整场都算全了
   */
  function ofMatch(hist, pid) {
    var list = Array.isArray(hist) ? hist : [];
    if (!list.length || !pid) return null;

    /* 按 hid 分组，保持出现顺序（history 是 append-only 的，顺序就是时间顺序） */
    var order = [];
    var byHid = {};
    for (var i = 0; i < list.length; i++) {
      var h = list[i];
      if (!h || !h.groups || !h.groups.length) continue;
      var hid = h.hid || h.hand || 1;
      if (!byHid[hid]) { byHid[hid] = []; order.push(hid); }
      byHid[hid].push(h);
    }

    var totalBest = 0;
    var totalActual = 0;
    var hands = 0;
    var partial = 0;
    for (var k = 0; k < order.length; k++) {
      var rec = ofHand(byHid[order[k]], pid);
      if (!rec) continue;            // 这一把的数据不全 → 不计入，也不拿半份假数据凑数
      totalBest += rec.best;
      totalActual += rec.actual;
      hands += 1;
      if (!rec.complete) partial += 1;
    }
    if (!hands) return null;
    return {
      best: totalBest,
      actual: totalActual,
      diff: totalBest - totalActual,
      hands: hands,
      partial: partial
    };
  }

  return {
    ME: ME,
    ROUND_GROUPS: ROUND_GROUPS,
    netOf: netOf,
    bestOf: bestOf,
    bestOfHand: bestOfHand,
    handFromRound: handFromRound,
    othersByModeFrom: othersByModeFrom,
    actualOfRound: actualOfRound,
    lastHandRounds: lastHandRounds,
    ofHand: ofHand,
    ofMatch: ofMatch
  };
});
