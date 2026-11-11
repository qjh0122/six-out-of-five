/**
 * 成就重放器 —— 用事件日志把历史按**当前口径**重算一遍
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 它到底做了什么
 * ═══════════════════════════════════════════════════════════════════════
 *
 *     ach = 基线(冻结快照) + fold(基线之后的所有事件)
 *
 * fold 用的是 `pwa/js/achievements.js` **这一版**的逻辑。所以：
 *
 *   · 改阈值/改判定（比如把「每组计一次」改成「每把计一次」）→ 重放一遍，
 *     历史自动按新口径重算，不需要碰任何存储；
 *   · 线上数字和重放结果对不上 → 说明这段时间某处写错了（或漏记了事件），
 *     `--dry-run` 的 diff 就是证据。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 用法
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   node scripts/replay-achievements.js                 # 预演，只打 diff
 *   node scripts/replay-achievements.js --apply         # 写回档案
 *   node scripts/replay-achievements.js --player pb9... # 只看一个人
 *   node scripts/replay-achievements.js --json          # 机器可读
 *   PROFILE_FILE=... EVENT_LOG_DIR=... node scripts/...
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 三条安全线
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 1. **默认只预演**。`--apply` 才会写档案，而且写之前会先把 diff 打出来。
 * 2. **没有基线的档案直接跳过**，不从 0 起算。那些人的 `ach` 是全部历史，
 *    拿事件重放等于把他们打过的所有场次抹掉 —— 宁可不动，也不能「算个大概」。
 * 3. **不动 `achBase`**。基线是起点，被改写就等于把历史第二次冻进去，
 *    重放一次涨一次，而且没有任何症状。
 */
'use strict';

const path = require('path');
const { ProfileStore } = require(path.join(__dirname, '..', 'server', 'profile.js'));
const EventLog = require(path.join(__dirname, '..', 'server', 'eventLog.js'));
const Replay = require(path.join(__dirname, '..', 'server', 'achReplay.js'));

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : '';
}
const APPLY = process.argv.indexOf('--apply') >= 0;
const AS_JSON = process.argv.indexOf('--json') >= 0;
const ONLY = arg('--player');

const store = new ProfileStore(Object.assign(
  process.env.PROFILE_FILE ? { file: process.env.PROFILE_FILE } : {},
  { log: function () {} }
));

/* 事件目录默认跟着档案走（与 server/index.js 同一条规则）。 */
const EVENTS_DIR = arg('--events')
  || process.env.EVENT_LOG_DIR
  || path.join(path.dirname(store.file), 'events');

/* ---------- 1. 收集基线 ---------- */
const baseByPid = new Map();
const skipped = [];
store.data.forEach(function (p, id) {
  if (ONLY && id !== ONLY) return;
  if (!p.achBase || !Number(p.achBase.at)) { skipped.push(p); return; }
  baseByPid.set(id, p.achBase);
});

if (!baseByPid.size) {
  console.error('没有可重放的档案：这些人还没有基线。先跑 `node scripts/ach-baseline.js --apply`。');
  process.exit(1);
}

/* ---------- 2. 读事件 ---------- */
const events = EventLog.readAll({ dir: EVENTS_DIR });
if (!events.length) {
  console.error('事件目录里没有事件：' + EVENTS_DIR);
  console.error('（目录不存在 / 还没开启日志 / 被清过。）');
  process.exit(1);
}

/* ---------- 3. 重放 ---------- */
const res = Replay.replay(events, { baseByPid: baseByPid });

/* ---------- 4. 对比 ---------- */
const rows = [];
let changed = 0;
res.byPid.forEach(function (st, pid) {
  const p = store.data.get(pid);
  if (!p) return;
  const d = Replay.diffCounts(p.ach || {}, st.counts);
  const beforeUnlock = countUnlocked(p);
  const afterUnlock = countUnlocked(Object.assign({}, p, { ach: st.counts }));
  if (!Replay.isEmptyDiff(d)) changed += 1;
  rows.push({
    playerId: pid,
    nickname: p.nickname || pid,
    games: p.games || 0,
    before: beforeUnlock,
    after: afterUnlock,
    diff: d
  });
});
rows.sort(function (a, b) { return b.games - a.games; });

function countUnlocked(p) {
  try { return require(path.join(__dirname, '..', 'pwa', 'js', 'achievements.js'))
    .evaluate(p.ach || null, p).unlocked; } catch (e) { return 0; }
}

if (AS_JSON) {
  console.log(JSON.stringify({
    events: { rounds: res.rounds, settles: res.settles },
    cutoff: res.cutoff,
    warns: res.warns,
    players: rows.map(function (r) {
      return { playerId: r.playerId, nickname: r.nickname, games: r.games,
        unlocked: { before: r.before, after: r.after }, diff: r.diff };
    })
  }, null, 2));
  if (!APPLY) process.exit(0);
} else {
  console.log('事件：' + res.rounds + ' 条轮级 / ' + res.settles + ' 条场级，目录 ' + EVENTS_DIR);
  console.log('基线时间戳（最早）：' + res.cutoff + '（' + new Date(res.cutoff).toISOString() + '）');
  res.warns.forEach(function (w) { console.log('⚠ ' + w); });
  if (skipped.length) {
    console.log('⚠ 跳过 ' + skipped.length + ' 份没有基线的档案（不拿事件重放，避免抹掉历史）：'
      + skipped.slice(0, 5).map(function (p) { return p.nickname || p.playerId; }).join(' / ')
      + (skipped.length > 5 ? ' …' : ''));
  }
  console.log('');
  console.log('玩家          场次   解锁       差异');
  rows.forEach(function (r) {
    const mark = Replay.isEmptyDiff(r.diff) ? '一致' : summarize(r.diff);
    const unlock = (r.before === r.after) ? String(r.before) : (r.before + ' → ' + r.after);
    console.log('  ' + String(r.nickname).padEnd(10) + String(r.games).padStart(5)
      + '   ' + String(unlock).padEnd(9) + ' ' + mark);
  });
  console.log('');
  console.log(changed + ' / ' + rows.length + ' 人有差异。');
}

function summarize(diff) {
  const parts = [];
  diff.forEach(function (x) {
    if (x.key === 't') {
      Object.keys(x.types).forEach(function (k) {
        parts.push('t.' + k + ' ' + signed(x.types[k].d));
      });
      return;
    }
    if (x.key === 'n') {
      Object.keys(x.modes).forEach(function (k) {
        parts.push('n.' + k + ' ' + signed(x.modes[k].d));
      });
      return;
    }
    parts.push(x.key + ' ' + signed(x.d));
  });
  return parts.slice(0, 6).join(' · ') + (parts.length > 6 ? ' …' : '');
}
function signed(n) { return (n > 0 ? '+' : '') + n; }

/* ---------- 5. 写回 ---------- */
if (!APPLY) {
  if (!AS_JSON) {
    console.log('');
    console.log('这是预演，档案没有改动。确认 diff 符合预期后加 --apply 写回。');
  }
  process.exit(0);
}

res.byPid.forEach(function (st, pid) {
  const p = store.data.get(pid);
  if (!p) return;
  /* 只换 ach，**不碰 achBase**（见文件头安全线 3）。 */
  p.ach = st.counts;
  p.updatedAt = Date.now();
});
store.dirty = true;
store.flush();
console.log('');
console.log('已写回 ' + res.byPid.size + ' 份档案：' + store.file);
console.log('基线保持不变，可以反复重放（幂等）。');
