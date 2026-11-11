/**
 * 成就解锁率实测（用于**标定稀有度**，不是给玩家看的）
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么需要它
 * ═══════════════════════════════════════════════════════════════════════
 *
 * `rarity: 'legend' | 'epic' | 'rare' | 'normal'` 是**标签**，不是数值 ——
 * 它唯一的职责是「让玩家扫一眼就知道这条难不难」。而难不难只有实测能回答：
 * 靠猜的结果就是倒挂（打着 legend 的徽章人人都有，打着 normal 的只有一个人拿到），
 * 那比不标还糟，因为它给了错误预期。
 *
 * 用法：
 *   node scripts/ach-unlock-stats.js                       # 读 ~/.lxw-appdata/seed/profiles.json
 *   PROFILE_FILE=... node scripts/ach-unlock-stats.js       # 读别的档案
 *   node scripts/ach-unlock-stats.js --json                 # 机器可读
 *
 * 只看**解锁人数**，不看次数：稀有度标的是「多少人拿到了」，
 * 不是「拿了多少次」。一个人通吃 500 次和通吃 3 次，对「难不难」的贡献是同一个。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Ach = require('../pwa/js/achievements.js');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : '';
}

const FILE = process.env.PROFILE_FILE
  || arg('--file')
  || path.join(os.homedir(), '.lxw-appdata', 'seed', 'profiles.json');
const AS_JSON = process.argv.indexOf('--json') >= 0;
/* 只看真正打过牌的人。线上 18 份档案里有一半是「注册了但一场没打」的空账号，
 * 把它们算进分母，每条成就的解锁率都会被系统性砍半 —— 1/2 这种假天花板
 * 会让人误判「这条居然只有一半人有」。默认门槛 1 场。 */
const MIN_GAMES = Number(arg('--min-games')) || 1;
/* 刚被「定点清零」过的键：它们的 0 是人为的，不是难度。
 * 参与标定就会得出「这几条最难」的荒谬结论。 */
const ZEROED = (process.env.ZEROED_KEYS || 'r9,r10,r12').split(',').filter(Boolean);

/* 稀有度 → 「应当有多稀有」的期望区间（解锁率）。
 * 这几个数字是标定时的依据，改它们等于改刻度，先想清楚再动。 */
const EXPECT = {
  legend: [0, 0.20],
  epic: [0.21, 0.50],
  rare: [0.51, 0.80],
  normal: [0.81, 1.01]
};

let raw;
try {
  raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch (e) {
  console.error('读不到档案：' + FILE + '（' + (e && e.message) + '）');
  process.exit(1);
}

const list = Array.isArray(raw) ? raw : Object.keys(raw).map((k) => raw[k]);
const people = list.filter((p) => p && typeof p === 'object' && (Number(p.games) || 0) >= MIN_GAMES);

if (!people.length) {
  console.error('没有满足 --min-games ' + MIN_GAMES + ' 的档案：' + FILE);
  process.exit(1);
}

const stat = new Map();
const total = Ach.CATALOG.length;
let sumUnlocked = 0;
/* evaluate() 返回的是摊平后的展示对象，里面没有 countKey；
 * 要判断「这条读的是不是被清零过的键」必须回到目录原文。 */
const DEF_BY_ID = {};
Ach.CATALOG.forEach((d) => { DEF_BY_ID[d.id] = d; });

people.forEach((p) => {
  const ach = p.ach && typeof p.ach === 'object' ? p.ach : Ach.blank();
  const res = Ach.evaluate(ach, p);
  sumUnlocked += res.unlocked;
  res.list.forEach((it) => {
    if (!stat.has(it.id)) stat.set(it.id, { def: it, n: 0, rates: [] });
    const s = stat.get(it.id);
    if (it.ok) s.n += 1;
    if (it.rate != null) s.rates.push(it.rate);
  });
});

const rows = [];
stat.forEach((s, id) => {
  /* 读的是刚被定点清零过的计数器 → 这条的 0 是人为的，不参与标定。
   * 判据来自目录里的 countKey（v116 起每条读计数器的成就都必须声明）。 */
  const def = DEF_BY_ID[id] || {};
  const ck = def.countKey && String(def.countKey).indexOf('t.') !== 0
    ? String(def.countKey) : '';
  rows.push({
    id: id,
    name: s.def.name,
    series: s.def.series,
    rarity: s.def.rarity,
    unlocked: s.n,
    rate: people.length ? s.n / people.length : 0,
    zeroed: !!(ck && ZEROED.indexOf(ck) >= 0)
  });
});
rows.sort((a, b) => (a.zeroed - b.zeroed) || a.rate - b.rate || (a.id < b.id ? -1 : 1));

const pct = (v) => (v * 100).toFixed(1) + '%';

if (AS_JSON) {
  console.log(JSON.stringify({
    file: FILE, people: people.length, total: total,
    avgUnlocked: sumUnlocked / people.length / total,
    rows: rows
  }, null, 2));
} else {
  console.log('档案：' + FILE);
  console.log('样本：' + people.length + ' 人 · 目录 ' + total + ' 条 · '
    + '平均解锁 ' + (sumUnlocked / people.length).toFixed(2) + ' / ' + total
    + ' = ' + pct(sumUnlocked / people.length / total));
  console.log('');
  console.log('解锁率  人数  稀有度   编号        名字');
  rows.forEach((r) => {
    console.log(
      pct(r.rate).padStart(6) + '  '
      + String(r.unlocked).padStart(4) + '  '
      + r.rarity.padEnd(7) + '  '
      + r.id.padEnd(10) + '  '
      + r.name
    );
  });

  /* 倒挂检测：标签说的稀有度必须落在实测区间里，否则「标签在骗人」。
   * 被清零过的（zeroed）不参与 —— 它们的 0 不是难度。 */
  const bad = rows.filter((r) => {
    if (r.zeroed) return false;
    const e = EXPECT[r.rarity];
    return e && (r.rate < e[0] - 0.001 || r.rate > e[1]);
  });
  console.log('');
  if (bad.length) {
    console.log('标签与实测不符（' + bad.length + ' 条）：');
    bad.forEach((r) => {
      const e = EXPECT[r.rarity];
      console.log('  · ' + r.id.padEnd(12) + r.name.padEnd(8)
        + ' 标 ' + r.rarity + '（期望 ' + pct(e[0]) + '~' + pct(Math.min(e[1], 1)) + '）'
        + ' 实测 ' + pct(r.rate));
    });
  } else {
    console.log('标签与实测一致（清零过的 ' + rows.filter((r) => r.zeroed).length + ' 条已排除）。');
  }
}
