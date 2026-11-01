/**
 * 战绩统计口径的守卫（node pwa/test/stats.test.js）
 *
 * 这份口径以前有两处实现（服务端增量 / 前端整表重算）。两处都能跑、都不报错，
 * 唯一症状是「战绩页说 12 胜，排行榜说 11 胜」—— 玩家不会来报，他只会觉得你算错了。
 *
 * 所以这里的判据分三层，缺一层都守不住：
 *   1. **独立复算**：期望值在测试里手算写成常量，不从被测实现里取（否则常量改错也绿）；
 *   2. **拿旧算法对拍**：用一段**写法完全不同**的实现（正序扫 vs 增量）跑同一批序列，
 *      两边必须逐字段相等 —— 这才证明「换成一份实现没有偷偷改口径」；
 *   3. **结构守卫**：`pwa/js` 里只剩一份 esc、records 不再自己数胜负。
 */
'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

const Stats = require('../js/stats.js');
const ROOT = path.join(__dirname, '..');

function same(a, b) {
  const keys = Object.keys(b);
  for (const k of keys) if (a[k] !== b[k]) return k + ': ' + a[k] + ' != ' + b[k];
  return '';
}

console.log('\n[1] 手算的期望值（不从实现里取）');
{
  /* 旧 → 新：+3 -2 0 +5 -4 */
  const s = Stats.fromNets([3, -2, 0, 5, -4]);
  ok(s.games === 5 && s.wins === 2 && s.losses === 2 && s.flats === 1, '场次/胜负平：5 / 2 胜 2 负 1 平',
    [s.games, s.wins, s.losses, s.flats].join('/'));
  ok(s.totalNet === 2, '净胜累加：3-2+0+5-4 = 2', s.totalNet);
  ok(s.bestNet === 5, '单场最高：5', s.bestNet);
  ok(s.currentStreak === -1, '当前连胜：最后一局是 -4 → -1（连败用负数）', s.currentStreak);
  ok(s.longestStreak === 1 && s.longestLoseStreak === 1, '最长连胜/连败各 1（中间有平局打断）',
    s.longestStreak + '/' + s.longestLoseStreak);
  ok(Stats.rate(s) === 40, '胜率 2/5 = 40%', Stats.rate(s));
}
{
  /* 手算：+1 +1 +1 → 连胜 3；+1 +1 +1 -1 → 最长连胜 3、当前 -1 */
  const s = Stats.fromNets([1, 1, 1, -1]);
  ok(s.longestStreak === 3 && s.currentStreak === -1, '最长连胜 3、当前 -1', s.longestStreak + '/' + s.currentStreak);
  ok(s.bestNet === 1, '单场最高 1（全是小分）', s.bestNet);
}
{
  /* 单场最高的初值：全负的人，最高分是他真实打过的最好那一场，不是 0 */
  const s = Stats.fromNets([-5, -18, -2]);
  ok(s.bestNet === -2, '★ 全负时单场最高是 -2（不是 0：0 会被读成「有一局打平」）', s.bestNet);
  ok(s.longestLoseStreak === 3 && s.currentStreak === -3, '连败 3（当前也是 -3）',
    s.longestLoseStreak + '/' + s.currentStreak);
}
{
  /* 平局必须同时打断两种连胜 */
  const s = Stats.fromNets([2, 2, 0, -3, -3, 0, 4]);
  ok(s.longestStreak === 2 && s.longestLoseStreak === 2, '平局把两种连胜都打断', s.longestStreak + '/' + s.longestLoseStreak);
  ok(s.currentStreak === 1, '最新一局 +4 → 当前连胜 1', s.currentStreak);
}
{
  const s = Stats.fromNets([]);
  const b = Stats.blank();
  ok(same(s, b) === '', '空列表 = blank()', same(s, b));
  ok(Stats.rate(s) === 0, '0 场胜率返回 0（展示层负责显示成「—」）');
  const one = Stats.fromNets([0]);
  ok(one.bestNet === 0 && one.flats === 1, '唯一一局是平局：最高分 0、平 1', one.bestNet + '/' + one.flats);
}
{
  const s = Stats.fromNets([3, 'x', null, 2]);
  ok(!isNaN(s.totalNet) && s.games === 4, '★ 脏数据当平局，不把整份统计算成 NaN', s.totalNet);
}

console.log('\n[2] 纯函数：不改入参');
{
  const prev = Stats.fromNets([1, -1]);
  const snapshot = JSON.stringify(prev);
  Stats.apply(prev, 5);
  ok(JSON.stringify(prev) === snapshot, '★ apply 不改入参（服务端会写回档案，前端会拿去渲染）');
  const next = Stats.apply(prev, 5);
  ok(prev.games === 2 && next.games === 3, '返回新对象，原对象不动');
}

console.log('\n[3] 与「整表重算」对拍（写法完全不同的第二实现）');
/* 独立实现：先在正序上扫最长连胜，再从末尾往回数当前连胜 —— 与 apply 的增量写法不同 */
function refStats(nets) {
  const out = { games: 0, wins: 0, losses: 0, flats: 0, totalNet: 0, bestNet: 0, currentStreak: 0, longestStreak: 0, longestLoseStreak: 0 };
  out.games = nets.length;
  let winRun = 0, loseRun = 0, first = true;
  for (const raw of nets) {
    const v = Number(raw);
    const n = isFinite(v) ? v : 0;
    out.totalNet += n;
    if (n > 0) out.wins += 1; else if (n < 0) out.losses += 1; else out.flats += 1;
    if (first) { out.bestNet = n; first = false; } else if (n > out.bestNet) out.bestNet = n;
    if (n > 0) { winRun += 1; loseRun = 0; } else if (n < 0) { loseRun += 1; winRun = 0; } else { winRun = 0; loseRun = 0; }
    if (winRun > out.longestStreak) out.longestStreak = winRun;
    if (loseRun > out.longestLoseStreak) out.longestLoseStreak = loseRun;
  }
  /* 当前连胜：从末尾往回数同一符号的那一段（遇到 0 或换符号就停） */
  let cur = 0;
  let sign = 0;
  for (let i = nets.length - 1; i >= 0; i--) {
    const n = Number(nets[i]) || 0;
    if (n === 0) break;
    const s2 = n > 0 ? 1 : -1;
    if (sign === 0) sign = s2;
    else if (sign !== s2) break;
    cur += 1;
  }
  out.currentStreak = cur * sign;
  return out;
}

{
  /* 固定种子随机，跑 200 条序列 —— 这类口径的边界（0 打断、全负、首场初值）
   * 靠手写用例列不全，用对拍兜住。*/
  let seed = 20261102;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let bad = 0, firstBad = '';
  for (let t = 0; t < 200; t++) {
    const n = Math.floor(rnd() * 25);
    const nets = [];
    for (let i = 0; i < n; i++) nets.push(Math.floor(rnd() * 41) - 20);
    const got = Stats.fromNets(nets);
    const want = refStats(nets);
    const diff = same(got, want);
    if (diff) { bad += 1; if (!firstBad) firstBad = JSON.stringify(nets) + ' -> ' + diff; }
  }
  ok(bad === 0, '★ 200 条随机序列与独立实现对拍全等', firstBad);
}

console.log('\n[4] 结构守卫：口径与转义都只剩一份');
{
  const jsDir = path.join(ROOT, 'js');
  const files = fs.readdirSync(jsDir).filter((f) => f.endsWith('.js'));
  /* 判据不是「有没有叫 esc 的函数」—— 去重后其它模块仍可以有一个转发用的同名包装。
   * 真正要守的是**转义表只有一份**：出现 `&amp;` 替换的地方只该有 gameUtils。 */
  const escFiles = files.filter((f) => /'&': '&amp;'/.test(fs.readFileSync(path.join(jsDir, f), 'utf8')));
  ok(escFiles.length === 1 && escFiles[0] === 'gameUtils.js', '★ 转义表只剩 gameUtils.js 一份', escFiles.join(','));

  const rec = fs.readFileSync(path.join(jsDir, 'records.js'), 'utf8');
  ok(/Stats\.fromNets/.test(rec), 'records.js 用共享口径算整表');
  ok(!/var wins = 0, losses = 0/.test(rec), '★ records.js 不再自己数胜负（那正是两份实现的来源）');

  const prof = fs.readFileSync(path.join(ROOT, '..', 'server', 'profile.js'), 'utf8');
  ok(/Stats\.apply/.test(prof), 'profile.js 用共享口径做增量');
  ok(!/p\.currentStreak = p\.currentStreak >= 0 \? p\.currentStreak \+ 1 : 1/.test(prof),
    '★ profile.js 里那条手写连胜规则已删除（留着就会悄悄分岔）');

  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  ok(html.indexOf('js/stats.js') > 0 && html.indexOf('js/stats.js') < html.indexOf('js/records.js'),
    'index.html 里 stats.js 排在 records.js 之前');
  ok(sw.indexOf("'/js/stats.js'") > 0, 'sw.js 预缓存了 stats.js');
}

console.log('\n----------------------------------------');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) process.exit(1);
