/**
 * 成就重放器内核（纯函数，无 IO）
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 它解决什么问题
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 档案里的 `ach` 是聚合计数器，不可逆。所以每次改成就口径、需要重算历史时，
 * 都只能「从今天起重新记」—— 老玩家的真实历史永久作废。
 *
 * 事件日志（`server/eventLog.js`）把原始观测留下来了。这个模块负责把它折回去：
 *
 *     当前值 = 基线（p.achBase）+ fold(基线之后的所有事件)
 *
 * 因为 fold 用的是**当前版本**的 `Ach.accumulate` / `Ach.mergeInto`，
 * 口径一改，重放一遍历史就自动按新口径重算 —— 这才叫「数据不用动，规则可以动」。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么必须按「结算点」切分牌局桶
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 线上 `room.achRun` 的生命周期是**一场**（一个 SETTLED 周期），不是整个房间：
 * `_persistSettlement` 合并完就 `room.achRun = null`。房间里还有 `_r1`
 * 这种「上一轮谁全赢」的临时表，它跟着桶一起清。
 *
 * 所以重放不能「把同房间所有轮次折进一个桶」—— 那会让 `_r1` 跨场泄漏，
 * 多算「五子登科」。必须：轮级事件先攒进房间的桶，**遇到这一场的结算事件就
 * 把桶冲进每个人的计数器并把桶丢掉**，和线上完全同构。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 与线上必须逐位一致的地方
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 场级三条（r9 / r10 / r12）与 r7 的判定逻辑是 `profile.record()` 里抄过来的。
 * 抄的时候要注意三件事，漏一件结果就和线上对不上：
 *
 *   1. `posCount` / `negCount` 是拿**全场所有人**（含 AI）算的；
 *   2. `loseBefore` 取的是**这一场之前**的连胜数，所以必须在更新 streak 之前判；
 *   3. r12 是**严格大于 100**（用户定的边界，100 整不算）。
 *
 * 这三条都有对应的断言（`server/test/ach-replay.test.js`）。
 */
'use strict';

const path = require('path');
const Ach = require(path.join(__dirname, '..', 'pwa', 'js', 'achievements.js'));
const Stats = require(path.join(__dirname, '..', 'pwa', 'js', 'stats.js'));

/** 事件里的紧凑分组 → 状态机 `results` 的形状（`Ach.accumulate` 认这个）。 */
function decodeGroups(evt) {
  const list = (evt && Array.isArray(evt.g)) ? evt.g : [];
  const out = [];
  list.forEach(function (g) {
    /* 坏行（null / 不是数组）直接跳过，不让一条脏数据把整场重放搞崩 ——
     * 这个函数的输入是磁盘上的文件，不是内存里的对象。 */
    if (!g || !Array.isArray(g)) return;
    out.push({
      group: g[0],
      winnerId: g[1],
      entries: (Array.isArray(g[2]) ? g[2] : []).map(function (e) {
        return { id: e[0], typeName: e[1] };
      })
    });
  });
  return out;
}

/** 只有这些键在重放里会被改；用来算 diff 时忽略 `since` / `v` 这类元数据。 */
const DIFF_KEYS = ['vs', 'vsl', 'vsn', 's1', 's2', 'sa', 'sw', 'l1', 'l2', 'la', 'lw',
  'smv', 'sml', 'smn', 'r7', 'r8', 'r9', 'r10', 'r12'];

function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }

/**
 * @param {Array} events  已按时间升序（EventLog.readAll 保证）
 * @param {object} opts
 *   baseByPid  Map<playerId, {at, counts, currentStreak}>
 *   only       Set<playerId>（可选）只重放这些人
 * @returns {{byPid:Map, rounds:number, settles:number, cutoff:number, warns:string[]}}
 */
function replay(events, opts) {
  const o = opts || {};
  const baseByPid = o.baseByPid instanceof Map ? o.baseByPid : new Map();
  const only = o.only instanceof Set ? o.only : null;
  const warns = [];

  /* 每个玩家一份可变状态：counts（从基线起）+ streak（用于 r7）。 */
  const state = new Map();
  baseByPid.forEach(function (base, pid) {
    if (only && !only.has(pid)) return;
    const b = base || {};
    state.set(pid, {
      baseAt: num(b.at),
      counts: Ach.mergeInto(Ach.blank(), b.counts || {}),
      /*
       * 连胜起点取基线里存的那个值。**不能从 0 起算**：
       * 基线是在半山腰冻的，那时玩家可能已经连输 4 场；从 0 起算会让
       * 「连输 5 场之后赢一场」（r7）在这之后的第一场就判错。
       */
      streak: num(b.currentStreak)
    });
  });

  /* 基线时间戳应当是同一次操作冻的（stampAchBase 一次调用给所有人同一个 now）。
   * 真出现不一致时按最早的算 —— 代价是最晚冻的那几个人会多算一小段，
   * 比「少算」好，因为少算等于凭空抹掉历史。 */
  let cutoff = Infinity;
  state.forEach(function (s) { if (s.baseAt < cutoff) cutoff = s.baseAt; });
  if (!isFinite(cutoff)) cutoff = 0;
  const ats = [];
  state.forEach(function (s) { if (ats.indexOf(s.baseAt) < 0) ats.push(s.baseAt); });
  if (ats.length > 1) {
    warns.push('基线时间戳不一致（' + ats.join(' / ') + '），按最早的 ' + cutoff + ' 重放；'
      + '建议重跑 stampAchBase 之前先确认基线是同一批冻的');
  }

  const runs = new Map();       // roomId → run（与线上 room.achRun 同构）
  let rounds = 0;
  let settles = 0;

  (Array.isArray(events) ? events : []).forEach(function (e) {
    if (!e || !e.r) return;
    if (num(e.t) <= cutoff) return;      // 基线之前：已经在 counts 里了，不能再算一遍

    if (e.k === 'g') {
      rounds += 1;
      runs.set(e.r, Ach.accumulate(runs.get(e.r) || null, num(e.rd) || 1, decodeGroups(e)));
      return;
    }

    /* ---- 场级 ---- */
    settles += 1;
    const run = runs.get(e.r);
    runs.delete(e.r);                     // 线上也是结算完就 null，别让 _r1 跨场泄漏

    const players = Array.isArray(e.p) ? e.p : [];
    /* posCount / negCount 拿**全场**算，AI 也占名额 —— 少一个 bot，
     * 「全场只有我一个人正分」就会被误判成成立。 */
    let posCount = 0;
    let negCount = 0;
    players.forEach(function (row) {
      const v = num(row[1]);
      if (v > 0) posCount += 1;
      else if (v < 0) negCount += 1;
    });

    players.forEach(function (row) {
      const pid = String(row[0]);
      const st = state.get(pid);
      if (!st) return;                    // AI、已注销账号：不影响任何人的档案
      /* 逐人再判一次时间：基线时间戳万一不一致，这里兜住「这个人还没开始记」。 */
      if (num(e.t) <= st.baseAt) return;

      if (run && run.byPid && run.byPid[pid]) {
        st.counts = Ach.mergeInto(st.counts, run.byPid[pid]);
      }

      const n = num(row[1]);
      /* ★ 必须在更新 streak **之前**取：r7 判的是「这一场之前已连败几场」。 */
      const loseBefore = Math.abs(Math.min(0, st.streak));
      const delta = {};
      /* 两人局不算「只有我一个人正分」（v116，与 profile.record 同一条规则）：
       * 零和下赢的那一方天然是唯一正分，那等于「赢了一把」的意思。
       * 人数取 `players.length`（含 AI）—— 与 posCount / negCount 同一口径。 */
      const enough = players.length >= 3;
      if (loseBefore >= 5 && n > 0) delta.r7 = 1;
      if (enough && posCount === 1 && n > 0) delta.r9 = 1;
      if (enough && negCount === 1 && n < 0) delta.r10 = 1;
      if (n > 100) delta.r12 = 1;         // 严格大于：100 整不算
      if (delta.r7 || delta.r9 || delta.r10 || delta.r12) {
        st.counts = Ach.mergeInto(st.counts, delta);
      }

      /* 连胜/连败的推进复用 Stats.apply —— 与 record() 同一份规则，
       * 不在这里另写一遍「赢了 +1、输了 -1」，那是最容易两边走偏的地方。 */
      st.streak = Stats.apply({
        games: 0, wins: 0, losses: 0, flats: 0, totalNet: 0, bestNet: 0,
        currentStreak: st.streak, longestStreak: 0, longestLoseStreak: 0
      }, n).currentStreak;
    });
  });

  return { byPid: state, rounds: rounds, settles: settles, cutoff: cutoff, warns: warns };
}

/** 两次计数器的差（只比 DIFF_KEYS 与 t / n，忽略 since / v）。 */
function diffCounts(before, after) {
  const a = before || {};
  const b = after || {};
  const out = [];
  DIFF_KEYS.forEach(function (k) {
    const x = num(a[k]);
    const y = num(b[k]);
    if (x !== y) out.push({ key: k, before: x, after: y, d: y - x });
  });
  const types = {};
  Object.keys(Object.assign({}, a.t || {}, b.t || {})).forEach(function (k) {
    const x = num((a.t || {})[k]);
    const y = num((b.t || {})[k]);
    if (x !== y) types[k] = { before: x, after: y, d: y - x };
  });
  if (Object.keys(types).length) out.push({ key: 't', types: types });
  const modes = {};
  Object.keys(Object.assign({}, a.n || {}, b.n || {})).forEach(function (k) {
    const x = num((a.n || {})[k]);
    const y = num((b.n || {})[k]);
    if (x !== y) modes[k] = { before: x, after: y, d: y - x };
  });
  if (Object.keys(modes).length) out.push({ key: 'n', modes: modes });
  return out;
}

/** diff 是否为空（没有差异 = 重放结果与线上一致，说明口径没变或数据没问题）。 */
function isEmptyDiff(d) { return !Array.isArray(d) || d.length === 0; }

module.exports = { replay, decodeGroups, diffCounts, isEmptyDiff, DIFF_KEYS };
