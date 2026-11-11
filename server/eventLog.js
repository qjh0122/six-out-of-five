/**
 * 成就原始观测日志（append-only JSONL）
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么要有这个模块
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 档案里的 `ach` 存的是**聚合计数器**（`t.lp = 242`）。聚合是不可逆的：
 * 它告诉你「拿了 242 次豹子」，但不告诉你「哪一把、第几轮、同桌还有谁」。
 * 于是每次改成就口径，涉及重算时都找不到原始数据，历史只能将就 ——
 * 「全操 235 场却有 277 次你咋这幸」那个 bug 就是这么藏了两年的。
 *
 * 这个模块把**原始观测**留下来：每轮结算一条、每场结算一条。
 * 成就从此可以看成「事件日志的 fold 结果」，改口径 = 改 fold + 重放，
 * 不需要动数据。重放器见 `scripts/replay-achievements.js`。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 三条硬约束（改之前先读）
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 1. **写失败绝不影响结算**。append 全程 try/catch，返回 false 就算了。
 *    日志是「以后能不能重算」的问题，结算是「这一局玩家的分对不对」的问题，
 *    后者永远优先。宁可丢一条日志，也不能让一次结算抛异常。
 *
 * 2. **默认关闭**。只有 `configure({enabled:true})` 之后才落盘，
 *    而 `configure` 只在 `server/index.js`（生产入口）里调。
 *    所以跑测试时它是个纯空转的模块，不会往 `~/.lxw-appdata` 里写东西 ——
 *    单测里 `new Hub()` 几百次，每轮都写一条真实日志是不可接受的。
 *
 * 3. **存原始观测，不存判定结果**。牌型存 `typeName` 原文（'10.5' / '豹子'），
 *    不存映射后的短键；分数存净胜，不存「谁是唯一正分」。
 *    如果存了判定结果，那这套日志就只对**当前版本**的口径有意义，
 *    改一次口径就得再改一次日志格式，等于没解决问题。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 两种事件
 * ═══════════════════════════════════════════════════════════════════════
 *
 * `k:'g'` 轮级（group）—— 每一轮结算一条，含该轮所有组、赢家、每人牌型
 *   {"k":"g","v":1,"r":"529580","h":42,"rd":1,"t":1794383790856,
 *    "g":[["tenhalf","p1",[["p1","10.5"],["p2","爆点"],["p3","没牛"]]], ...]}
 *
 * `k:'s'` 场级（settle）—— 每场结算一条，含全场每个人的净胜（**含 AI**）
 *   {"k":"s","v":1,"r":"529580","h":42,"t":1794383790856,
 *    "p":[["p1",24,0],["p2",-11,0],["bot_x",-13,1]]}
 *
 * 为什么场级要带上 AI：`posCount` / `negCount` 是拿**全场所有人**算的，
 * AI 也占一个名额。少存一个 bot，「你咋这幸」（全场只有我一个人正分）
 * 的重放结果就会和线上不一致 —— 重放器的第一职责是和线上对得上。
 *
 * 为什么两种都要：轮级事件能重算所有计数型成就（牌型 / 对撞 / 通吃），
 * 但算不出「这一场全场几正几负」；场级事件反过来。只存一种都会漏。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 存储
 * ═══════════════════════════════════════════════════════════════════════
 *
 * `~/.lxw-appdata/events/YYYY-MM.jsonl`，按月分片，只追加不修改。
 * 不塞进 profiles.json：那个文件是**整份重写**（每 500ms 一次 flush），
 * 往里加几万行会让每次落盘都变慢，而且是全有或全无 —— 写一半失败就全没了。
 *
 * 体积实测（2026-11-11，9 人 1005 场）：约 6 把/场、277 B/把，
 * 当前全量 1.6 MB，按这个速率一年约 9.5 MB。纯文本，gzip 后约 1/5。
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** 事件格式版本。改结构必须加，重放器按版本分别解码。 */
const SCHEMA = 1;

const state = {
  dir: '',
  enabled: false,
  /* 写失败只记第一条，避免一个坏掉的目录把日志刷满 */
  lastError: ''
};

/**
 * 打开/关闭写入。
 * @param {{dir:string, enabled:boolean}} opts
 * @returns {boolean} 实际是否开启
 */
function configure(opts) {
  const o = opts || {};
  const dir = o.dir ? path.resolve(String(o.dir)) : '';
  state.dir = dir;
  state.enabled = !!(o.enabled && dir);
  state.lastError = '';
  if (state.enabled) {
    try {
      fs.mkdirSync(state.dir, { recursive: true });
    } catch (e) {
      state.enabled = false;
      state.lastError = e.message;
    }
  }
  return state.enabled;
}

function isEnabled() { return state.enabled; }
function dir() { return state.dir; }

/** 「2026-11」这种月键。用本地时间：分片只是为了让单文件别无限长，
 *  跨月边界差几个小时不影响任何判定（重放按 t 排序，不按文件顺序）。 */
function monthKey(ts) {
  const d = new Date(Number(ts) || Date.now());
  const m = d.getMonth() + 1;
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : String(m));
}

function fileOf(ts) {
  return path.join(state.dir, monthKey(ts) + '.jsonl');
}

/** 一行一条。失败返回 false，**绝不抛**（见文件头约束 1）。 */
function append(obj) {
  if (!state.enabled) return false;
  try {
    fs.appendFileSync(fileOf(obj.t), JSON.stringify(obj) + '\n', 'utf8');
    return true;
  } catch (e) {
    if (!state.lastError) state.lastError = e.message;
    return false;
  }
}

/**
 * 把状态机的一轮结算编成事件载荷。
 *
 * 只保留重算需要的东西：组名、赢家、每个出牌人的牌型名。
 * 不存 nickname（改个名不该让历史事件失效）、不存分数（分数由场级事件负责）。
 */
function encodeGroups(results) {
  const list = Array.isArray(results) ? results : [];
  return list.map(function (g) {
    if (!g) return null;
    const entries = (g.entries || [])
      .filter(function (e) { return e && e.id; })
      .map(function (e) { return [String(e.id), String(e.typeName == null ? '' : e.typeName)]; });
    return [String(g.group || ''), String(g.winnerId || ''), entries];
  }).filter(Boolean);
}

/** 同一个 (房间, 场次, 轮) 只写一次。
 *  房间对象上挂的临时表，房间销毁就没了 —— 不需要落盘，
 *  进程重启后最多多写一条重复事件，重放器按 (k,r,h,rd) 去重会吃掉它。 */
function once(room, key) {
  if (!room) return false;
  if (!room._evtSeen || typeof room._evtSeen !== 'object') room._evtSeen = {};
  if (room._evtSeen[key]) return false;
  room._evtSeen[key] = 1;
  return true;
}

/**
 * 轮级事件。签名与状态机的钩子一致：`(room, round, results)`。
 * @returns {boolean} 是否真的写了一条
 */
function appendRound(room, round, results) {
  if (!state.enabled) return false;
  if (!room || !room.roomId) return false;
  const hand = Number(room.handSeq) || 0;
  const rd = Number(round) || 1;
  if (!once(room, 'g#' + hand + '#' + rd)) return false;
  const groups = encodeGroups(results);
  /* 空轮不记：一轮下来一组都没结算（全员弃权 / 中途退出），
   * 记下来也没法重放出任何东西，只会让日志里多一堆空行。 */
  if (!groups.length) return false;
  return append({
    k: 'g', v: SCHEMA,
    r: String(room.roomId),
    h: hand,
    rd: rd,
    t: Date.now(),
    g: groups
  });
}

/**
 * 场级事件。**必须在 `voided` 判定之后调用**（作废的场不落档案，
 * 也不该落事件，否则重放会凭空多出一场）。
 *
 * @param {object} room
 * @param {Array} players [{id, net, bot}] —— 全场所有人，**含 AI**
 * @param {number} [t]
 */
function appendSettlement(room, players, t) {
  if (!state.enabled) return false;
  if (!room || !room.roomId) return false;
  const hand = Number(room.handSeq) || 0;
  if (!once(room, 's#' + hand)) return false;
  const list = (Array.isArray(players) ? players : []).map(function (p) {
    return [String(p.id), Math.round(Number(p.net) || 0), p.bot ? 1 : 0];
  });
  if (!list.length) return false;
  return append({
    k: 's', v: SCHEMA,
    r: String(room.roomId),
    h: hand,
    t: Number(t) || Date.now(),
    p: list
  });
}

/** 列出所有月片（升序）。目录不存在返回空数组。 */
function shards() {
  if (!state.dir) return [];
  let names = [];
  try { names = fs.readdirSync(state.dir); } catch (e) { return []; }
  return names
    .filter(function (n) { return /^\d{4}-\d{2}\.jsonl$/.test(n); })
    .sort()
    .map(function (n) { return path.join(state.dir, n); });
}

/**
 * 同一毫秒内的排序权重。
 *
 * 轮级事件按轮号排（1 在前 2 在后），**场级事件排在这一场所有轮之后**（给 99）。
 * 为什么必须区分：结算事件决定「这一场到此为止」，重放器遇到它就 flush 房间桶、
 * 清掉 `_r1`。如果它排到轮级事件前面，最后那一轮就会被算进下一场去。
 * 而两者常常落在同一毫秒（一轮刚结算完紧接着就是场结算），这不是理论问题。
 */
function roundRank(e) {
  return (e && e.k === 'g') ? (Number(e.rd) || 1) : 99;
}

/**
 * 读回全部事件。
 *
 * @param {{after?:number, dir?:string, dedupe?:boolean}} [opts]
 *   after —— 只要 t > after 的（基线之前的不要）
 *   dir   —— 覆盖目录（脚本用；服务端不传就走 configure 的）
 *   dedupe —— 默认 true，按 (k,r,h,rd) 去重
 * @returns {Array}
 */
function readAll(opts) {
  const o = opts || {};
  let files;
  if (o.dir) {
    const d = path.resolve(String(o.dir));
    try {
      files = fs.readdirSync(d)
        .filter(function (n) { return /^\d{4}-\d{2}\.jsonl$/.test(n); })
        .sort()
        .map(function (n) { return path.join(d, n); });
    } catch (e) { files = []; }
  } else {
    files = shards();
  }

  const after = Number(o.after) || 0;
  const dedupe = o.dedupe !== false;
  const seen = Object.create(null);
  const out = [];
  const bad = [];

  files.forEach(function (file) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
    /* 按 \n 切，末尾空行丢掉。行内不会有换行（JSON.stringify 会转义）。 */
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      let evt;
      try { evt = JSON.parse(line); } catch (e) { bad.push(file + ':' + (i + 1)); continue; }
      if (!evt || (evt.k !== 'g' && evt.k !== 's')) { bad.push(file + ':' + (i + 1)); continue; }
      if (after && Number(evt.t) <= after) continue;
      if (dedupe) {
        const key = evt.k + '#' + evt.r + '#' + evt.h + '#' + (evt.k === 'g' ? evt.rd : '');
        if (seen[key]) continue;
        seen[key] = 1;
      }
      out.push(evt);
    }
  });

  /* 按时间升序。同一毫秒内的顺序对「连败/连胜」这种有状态的判定是有意义的，
   * 所以二级键用 (房间, 场次, 轮) —— 同一场的轮一定在结算之前。 */
  out.sort(function (a, b) {
    const d = Number(a.t) - Number(b.t);
    if (d) return d;
    if (a.r !== b.r) return a.r < b.r ? -1 : 1;
    if (Number(a.h) !== Number(b.h)) return Number(a.h) - Number(b.h);
    return roundRank(a) - roundRank(b);
  });

  return out;
}

/**
 * 把一批事件整份写回月片（备份同步用，**不是**服务端写入路径）。
 *
 * 为什么要整份重写而不是逐条 append：备份是「把线上 + 本地已有」合并去重后落一份镜像，
 * append 会让同一事件在本地出现两次（线上重发 / since 回退一格都会）。
 * 数据量在 MB 级，重写一次比维护增量一致性便宜得多。
 *
 * @param {Array} events
 * @param {string} targetDir
 * @returns {{shards:number, count:number}}
 */
function writeShards(events, targetDir) {
  const dir = path.resolve(String(targetDir));
  fs.mkdirSync(dir, { recursive: true });
  const byMonth = new Map();
  (Array.isArray(events) ? events : []).forEach(function (e) {
    if (!e || (e.k !== 'g' && e.k !== 's')) return;
    const key = monthKey(e.t);
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(e);
  });
  let count = 0;
  byMonth.forEach(function (list, key) {
    list.sort(function (a, b) {
      const d = Number(a.t) - Number(b.t);
      if (d) return d;
      if (a.r !== b.r) return a.r < b.r ? -1 : 1;
      if (Number(a.h) !== Number(b.h)) return Number(a.h) - Number(b.h);
      return roundRank(a) - roundRank(b);
    });
    const file = path.join(dir, key + '.jsonl');
    const body = list.map(function (e) { return JSON.stringify(e); }).join('\n') + '\n';
    fs.writeFileSync(file + '.tmp', body, 'utf8');
    fs.renameSync(file + '.tmp', file);
    count += list.length;
  });
  return { shards: byMonth.size, count: count };
}

/** 统计：给重放器的 --dry-run 摘要和排障用。 */
function stats(opts) {
  const evts = readAll(opts);
  let rounds = 0, settles = 0, bytes = 0, parseErrors = 0;
  evts.forEach(function (e) {
    if (e.k === 'g') rounds += 1; else settles += 1;
    bytes += JSON.stringify(e).length + 1;
  });
  let files = [];
  try {
    const d = (opts && opts.dir) ? path.resolve(String(opts.dir)) : state.dir;
    files = fs.readdirSync(d).filter(function (n) { return /\.jsonl$/.test(n); });
  } catch (e) { files = []; }
  return { rounds: rounds, settles: settles, bytes: bytes, files: files.length, parseErrors: parseErrors };
}

module.exports = {
  SCHEMA,
  configure,
  isEnabled,
  dir,
  monthKey,
  fileOf,
  encodeGroups,
  appendRound,
  appendSettlement,
  readAll,
  writeShards,
  stats,
  /* 只给测试用：把内存里的开关与去重表复位 */
  _reset: function () { state.dir = ''; state.enabled = false; state.lastError = ''; }
};
