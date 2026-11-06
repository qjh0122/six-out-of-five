/**
 * 历史与战绩的「数据成形」层：从 live 房间对象 → 存档 → 本机记录
 *
 * ── 为什么单独成文件 ────────────────────────────────────────────────
 * 这一块是**纯数据转换**，一行 DOM 都不碰。它原来和「结算弹窗怎么画」「战绩页
 * 怎么排版」混在一起，于是想确认「存进去的到底有哪些字段」得穿过几百行 innerHTML。
 *
 * ── 一份数据三种形态（改之前必须先看懂这张表）───────────────────────
 *   1) live —— 服务端房间对象上的 room.history，每轮一条，手牌是牌对象；
 *      只保留最近 4 条（≈ 2 把），因为每次广播都会整份下发，放开上限就是拿带宽换。
 *   2) 场次档案 —— 本机 SessionLog，按「房号 + 房间创建时间」攒整场；
 *      客户端边看边攒，所以不受服务端窗口限制，刷新也不丢。
 *   3) 单把 replay —— 战绩记录里那一小份，老数据只有它，作为兜底。
 *
 * `slimRound` 是三者之间**唯一**的转换点：牌对象在这里就转成字符串
 * （牌对象存进 localStorage 体积是字符串的三倍）。
 *
 * ── 注入 ──────────────────────────────────────────────────────────
 *   state       —— 只为两个「本页会话内的记忆」字段：absorbSig / recordKey
 *   getMe       —— 从房间对象里找我自己
 *   recordsPid  —— 记录归属哪个账号
 *   flash       —— 写失败时提示一次
 * 这四个都在 game.js 里且都是 function 声明（提升），所以能直接传引用。
 *
 * 浏览器全局：`window.LXW.historyKit`
 */
(function (global) {
  'use strict';

  function create(deps) {
    deps = deps || {};
    var state = deps.state;
    var cardText = global.LXW.utils.cardText;
    var api = {};

    function endedAtOf(room) {
      // 优先 settledAt；老房间没有该字段（兼容）才回退 endedAt / updatedAt
      return Math.round(room.settledAt || room.endedAt || room.updatedAt || Date.now());
    };
    function endReasonOf(room) {
      // 状态机/服务端给了就用；没给就是「有人主动收手」这一条（需求 §4）
      var r = room.endReason;
      if (r === 'scoreZero' || r === 'someoneLeft' || r === 'dissolve' || r === 'handLimit') return r;
      return 'dissolve';
    };

    function slimRound(h) {
      return {
        r: h.round || 1,
        groups: (h.groups || []).map(function (g) {
          return {
            l: g.label || g.group || '',
            w: g.winnerNickname || '',
            t: g.winnerTypeName || '',
            rows: (g.entries || []).map(function (e) {
              return {
                /* i 不能省：回放里标「我」靠的是 id，不是昵称。
                 * 昵称可以重名，重名时会把别人标成我。 */
                i: e.id || '',
                n: e.nickname || '',
                c: (e.hand || []).map(cardText),
                d: (g.deltas && g.deltas[e.id]) || 0
              };
            })
          };
        })
      };
    };

    /* history → 按把分组的 packs：[{hands, no, g, rounds:[...]}]，按把次升序。
     *
     * 三个字段各管一件事，谁也不能替代谁：
     *   · hands —— **身份**。用 hid（handId），它在 dealAll 里递增、永不重置，
     *     所以「开下一把」后 restart 也不会把它撞回 1（handCount 会）。
     *     回放定位（targetHand）、本地存档去重、pack 合并全按它。
     *   · no —— **显示序号**。用 handCount，它每局归 1，也就是「本局第几把」。
     *   · g —— **局号**。用 handSeq，用来把同一个房间里前后两局分开。
     *
     * ★ v124 修的 bug：`hands` 被同时当成显示序号用了。
     *   房间打两局时 hid 连续递增（第一局 1~3、第二局 4~6），于是第二局的
     *   回放标题写着「第 4 把 / 第 5 把」—— 数字越往后越大，跟屏幕上这一局的
     *   实际把数完全对不上。身份可以连续，序号不能。 */
    function packHistory(hist) {
      var byHand = {};
      var order = [];
      for (var i = 0; i < (hist || []).length; i++) {
        var h = hist[i];
        var hn = h.hid || h.hand || 1;
        if (!byHand[hn]) {
          byHand[hn] = {
            hands: hn,
            /* 老数据没有 seq：一律归到第 0 局（等于「不分局」），
             * 显示上退回原来的样子，不会比修之前更差。 */
            no: Math.max(1, Math.round(Number(h.hand) || 1)),
            g: Math.max(0, Math.round(Number(h.seq) || 0)),
            rounds: []
          };
          order.push(hn);
        }
        byHand[hn].rounds.push(slimRound(h));
      }
      order.sort(function (a, b) { return a - b; });
      var out = [];
      for (var k = 0; k < order.length; k++) {
        var pack = byHand[order[k]];
        pack.rounds.sort(function (a, b) { return (a.r || 1) - (b.r || 1); });
        out.push(pack);
      }
      return out;
    };

    /* 把 history 里出现过的轮次收进本机场次档案。
     *
     * 幂等靠 (hid, round)：同一轮被广播很多次（每次房间更新都会带上 history），
     * SessionLog 只认第一次。这里再加一道签名短路，避免每次渲染都去读一遍
     * localStorage（一场攒下来能到几十 KB，读一次就是一次 JSON.parse）。
     *
     * 为什么要防「读太频繁」而不是「写太频繁」：写只在新轮次出现时发生（每把两次），
     * 而读如果跟着渲染节奏走，就是每秒几次。 */
    function absorbHistory(room) {
      if (!room || typeof SessionLog === 'undefined') return;
      var hist = room.history || [];
      if (!hist.length) return;
      var last = hist[hist.length - 1] || {};
      var sig = hist.length + '|' + (last.hid || 0) + ':' + (last.round || 0);
      if (state.absorbSig === sig) return;
      state.absorbSig = sig;
      var entry = null;
      try {
        entry = {
          key: SessionLog.keyOf(room),
          roomId: room.roomId,
          startedAt: room.createdAt,
          packs: packHistory(hist)
        };
        SessionLog.absorb(entry);
      } catch (e) { /* 存档失败绝不影响对局 */ }
    };

    /* 这一把的单把副本（写进战绩记录，给 SessionLog 被清 / 老数据兜底用）。 */
    function slimReplay(room) {
      if (!room) return null;
      var packs = packHistory(room.history);
      if (!packs.length) return null;
      var want = room.handId || room.handCount || 1;
      var hit = null;
      for (var i = 0; i < packs.length; i++) {
        if (packs[i].hands === want) { hit = packs[i]; break; }
      }
      /* 找不到就取最后一把：房间历史被裁掉时，宁可给「最近那把」也别给空。 */
      return hit || packs[packs.length - 1];
    };

    /* 本把有没有 AI 参与。
     *
     * 两个来源取「或」：
     *   · room.handHadBot —— 服务端权威（开局快照 + 结算时并集，见状态机）；
     *   · 座位表里还有 isBot 的人。
     * 为什么不能只看座位表：中途被移除的 AI 不在座位上了，但这一把确实有 AI 参与过。
     * 为什么不能只看 handHadBot：本地演示模式（?mode=local）走的是同一份状态机，
     * 字段在，但老房间对象可能还没带上——座位表是兜底。
     */
    function roomHasBot(room) {
      if (!room) return false;
      if (room.handHadBot === true) return true;
      var ps = room.players || [];
      for (var i = 0; i < ps.length; i++) if (ps[i] && ps[i].isBot) return true;
      return false;
    };

    function recordSettled(room) {
      if (!room || room.phase !== StateMachine.PHASE.SETTLED) return;
      /* 作废的一把（指的是**一分没打**就结束的局，不是所有中途结束的局）不进本机战绩。
       * 判据由状态机写进 room.voided，前端不自己算 —— 打过分就照记。
       * 这和云端档案是同一个口径：服务端 _persistSettlement 也会跳过，
       * 两处只要有一处记了，战绩页和排行榜就会各说一套。 */
      if (room.voided) return;
      if (typeof Records === 'undefined') return;
      if (!Records.available()) return;        // 隐私模式 / 不可写：静默跳过
      var me = deps.getMe(room);
      if (!me) return;                          // 已不在房间里，没有完整结果
      if (me.left) return;                      // 中途自己离开的局不记（需求 §4）
      var endedAt = endedAtOf(room);
      var key = room.roomId + '#' + endedAt;
      if (state.recordKey === key) return;
      state.recordKey = key;
      var wrote = null;
      try {
        wrote = Records.add({
          id: room.roomId + '-' + endedAt,
          /* 归属账号：这一条是「换号后战绩里混进别人的局」的修法。
           * v50 之前本机记录没有这个字段，同一台手机先后登两个号，
           * 两个号的局会排在同一个列表里，谁也分不清哪条是谁的。 */
          playerId: state.myId || deps.recordsPid(),
          roomId: room.roomId,
          endedAt: endedAt,
          playerCount: room.players.length,
          myStartScore: CONFIG.INITIAL_SCORE,
          myEndScore: me.score,
          myNet: me.score - CONFIG.INITIAL_SCORE,
          endReason: endReasonOf(room),
          // 场次序号：handSeq 在房间内永不重置，是战绩判重的可靠身份；
          // handCount 会在「开下一把」时归 1，只能兜底。
          rounds: room.handSeq || room.handCount || 1,
          /* 把次身份 + 场次身份：「看回放」要能找到整场的那份归档。
           * sessionKey 对应 SessionLog 里的一场（房号 + 房间创建时间）；
           * handId 告诉回放层「你点的是第几把」，用来高亮。 */
          handId: room.handId || room.handCount || 1,
          /* 含 AI 的局：本机这份兜底记录也要带同一个标记。
           * 不然离线/本地模式下战绩页会把它们算进统计 —— 口径就分成了两套。 */
          ai: roomHasBot(room),
          sessionKey: (typeof SessionLog !== 'undefined') ? SessionLog.keyOf(room) : '',
          // 单把副本：场次归档被清掉、或老记录后面的兜底
          replay: slimReplay(room)
        });
      } catch (e) { /* 记录失败绝不影响对局 */ }
      noticeRecordsWrite(wrote);
    };

    /* 本机战绩写不进 / 被裁剪时，必须让玩家知道一次。
     * 为什么是「一次」：同一个原因会在每一局结算时重复触发，每局弹一次就成了噪音，
     * 反而让人以为是新问题。一局之内说清楚就够了 —— 页面上「战绩」那一栏
     * 会因此少掉这一条，玩家至少知道该去哪儿归因。
     * 云端档案由服务端落盘，不走这条路，所以提示里要写明「不受影响」，
     * 否则玩家会以为整场战绩都丢了。 */
    var recordsWarned = false;
    function noticeRecordsWrite(res) {
      if (!res || recordsWarned) return;
      if (!res.added && res.reason === 'writeFailed') {
        recordsWarned = true;
        deps.flash('手机存储已满，这局没存到本机战绩（云端记录不受影响）');
      } else if (res.added && res.trimmed) {
        recordsWarned = true;
        deps.flash('手机存储紧张，只保留了最近的战绩');
      }
    };

      api.endedAtOf = endedAtOf;
  api.endReasonOf = endReasonOf;
  api.slimRound = slimRound;
  api.packHistory = packHistory;
  api.absorbHistory = absorbHistory;
  api.slimReplay = slimReplay;
  api.roomHasBot = roomHasBot;
  api.recordSettled = recordSettled;
  api.noticeRecordsWrite = noticeRecordsWrite;

  return api;
  }

  global.LXW = global.LXW || {};
  global.LXW.historyKit = create;

})(typeof self !== 'undefined' ? self : this);
