/**
 * 冻结成就基线（重放起点）——一次性操作，幂等
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么需要它
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 事件日志只从**开启那天**开始有数据。之前的历史追不回来 ——
 * 档案里只存了聚合计数器（`t.lp = 242`），没存「哪一把、第几轮、同桌有谁」，
 * 聚合是不可逆的。这不是实现偷懒，是当时的数据结构决定的，只能接受。
 *
 * 但「从今天起可重算」是能做到的，前提是留一个起点：
 *
 *     当前值 = 基线 + fold(基线之后的所有事件)
 *
 * 这个脚本就是给每个档案冻一份基线。它**不改任何计数器**，只是多存一份快照，
 * 所以可以放心在发布前跑。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 用法
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   node scripts/ach-baseline.js                    # 预演，只报告会冻几个人
 *   node scripts/ach-baseline.js --apply            # 真的写进档案
 *   PROFILE_FILE=/path/to/profiles.json node scripts/ach-baseline.js --apply
 *
 * 顺序很重要，但理由和直觉相反：**基线越晚越安全**。
 *
 * 重放器会把 `t <= 基线时刻` 的事件全部跳过（那些已经算进基线 counts 里了），
 * 所以「基线晚于第一条事件」只是重复一段、不会双计。
 * 真正危险的是反过来 —— **基线早于日志**：那段时间打的牌既不在基线的 counts 里、
 * 也没有事件，重放时会凭空抹掉一段。
 *
 * 所以：**先开事件日志（发布），再冻基线**。而线上没有远程 shell，
 * 真正生效的那次冻结在 `server/index.js` 里自动做（启动即冻，幂等）；
 * 这个脚本是给「离线补冻 / 演练 / 换机恢复」用的。
 */
'use strict';

const path = require('path');
const { ProfileStore } = require(path.join(__dirname, '..', 'server', 'profile.js'));

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : '';
}
const APPLY = process.argv.indexOf('--apply') >= 0;

const store = new ProfileStore(Object.assign(
  process.env.PROFILE_FILE ? { file: process.env.PROFILE_FILE } : {},
  { log: function () {} }
));

const total = store.data.size;
const pending = [];
const already = [];
store.data.forEach(function (p, id) {
  if (p.achBase && Number(p.achBase.at) > 0) already.push(p);
  else pending.push(p);
});

console.log('档案总数 ' + total);
console.log('已有基线 ' + already.length + '（跳过，幂等）');
console.log('待冻基线 ' + pending.length);

if (!APPLY) {
  pending.slice(0, 10).forEach(function (p) {
    const a = p.ach || {};
    console.log('  · ' + (p.nickname || p.playerId)
      + '  场次=' + (p.games || 0)
      + '  当前连胜=' + (p.currentStreak || 0)
      + '  牌型命中=' + Object.keys(a.t || {}).reduce(function (s, k) { return s + (Number(a.t[k]) || 0); }, 0));
  });
  if (pending.length > 10) console.log('  … 其余 ' + (pending.length - 10) + ' 人略');
  console.log('');
  console.log('这是预演。加 --apply 才会真的写进档案（只加 achBase，不动任何计数器）。');
  process.exit(0);
}

const at = Date.now();
const n = store.stampAchBase(at);
store.flush();
console.log('已冻结 ' + n + ' 份基线，时间戳 ' + at + '（' + new Date(at).toISOString() + '）');
console.log('文件：' + store.file);
console.log('事件日志必须 ≥ 这个时间戳之后的都留着，否则重放会缺一段。');
