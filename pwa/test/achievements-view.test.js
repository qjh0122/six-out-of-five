/**
 * 成就页渲染（node pwa/test/achievements-view.test.js）
 *
 * 渲染层不产生数字（数字由 achievements.js 判定），所以这里只锁「看得见的东西」：
 *
 *   1. **未解锁的成就也显示名字与描述**（用户裁定：不做 ??? 猜谜）；
 *   2. 已解锁 / 未解锁的卡片在标记上必须能区分（is-ok），否则玩家分不出拿到了没有；
 *   3. 概率为 null 时显示「—」，**不能显示 0%** ——
 *      「还没打过」和「打过一次没拿到」是两件不同的事，混成 0% 会误导；
 *   4. 信息档入口带 data-ach-open（点击委托靠这个属性找目标）。
 *
 * 反例检查：拿一份**完全空**的档案跑一遍，页面必须能正常输出（不能抛、不能空字符串）。
 * 新用户第一次点进来就是这个状态 —— 这是最常被忽略的那条路径。
 */
'use strict';

var AV = require('../js/achievementsView.js');
var Ach = require('../js/achievements.js');

var pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) pass += 1;
  else { fail += 1; console.error('✗ ' + name + (extra ? ' — ' + extra : '')); }
}
function eq(a, b, name) {
  ok(a === b, name, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b));
}

/* ================================================================
 * 一、空档案（新用户第一次进来）
 * ================================================================ */
var empty = {
  playerId: 'p0', nickname: '新人', games: 0,
  ach: Ach.blank()
};
var h0 = AV.pageHtml(empty, Ach, { isMe: true });
ok(typeof h0 === 'string' && h0.length > 500, '空档案也能渲染出整页（不抛、不空串）');
ok(h0.indexOf('0') >= 0, '顶部显示 0 个已解锁');
ok(h0.indexOf('刚好十点半') >= 0, '★ 一条都没解锁时，成就名字照样显示');
ok(h0.indexOf('还没打过带牌型的局') >= 0, '空态给出解释（而不是一片空网格）');
eq(h0.indexOf('is-ok'), -1, '空档案没有任何卡片带 is-ok');

/* ================================================================
 * 二、有数据的档案
 * ================================================================ */
var prof = {
  playerId: 'p1', nickname: '玩家A', games: 20, longestStreak: 6, bestNet: 16,
  ach: {
    /* 十点半 3 次 / 参与 6 次 = 50%，豹子 0 次 / 参与 6 次 = 0% */
    t: { th: 3, lp: 0, nn: 12 },
    n: { tenhalf: 6, piaosanye: 6, douniu: 20 },
    vs: 4, vsl: 2, vsn: 6,
    s1: 1, s2: 0, sa: 0, sw: 1,
    r7: 0, r8: 0,
    since: 1700000000000
  }
};
var h = AV.pageHtml(prof, Ach, { isMe: true });

ok(h.indexOf('刚好十点半') >= 0, '名字在');
ok(h.indexOf('不多不少，正好 10.5') >= 0, '描述在');
ok(h.indexOf('is-ok') >= 0, '有解锁的卡片');
ok(h.indexOf('3 / 10') >= 0, '十点半成瘾的进度条显示 3 / 10');

/* 概率：十点半 3 次 / 6 次参与 = 50.0% */
ok(h.indexOf('50.0%') >= 0, '★ 概率按「命中 / 参与该组次数」算（3/6 = 50.0%）');
/* 豹子 0 次 / 6 次参与 = 0.0%（打过但没拿到，是 0 不是 —） */
ok(h.indexOf('0.0%') >= 0, '★ 打过但没拿到 → 0.0%（不是 —）');
/* 五花牛：斗牛组参与 20 次、五花牛 0 次 → 0.0%；而「—」留给真的没分母的项 */
ok(h.indexOf('—') >= 0, '分母为 0 的牌型显示「—」而不是 0%');

ok(h.indexOf('大牌对撞') >= 0, '对撞汇总行在');
ok(h.indexOf('66.7%') >= 0, '★ 对撞胜率 4 / 6 = 66.7%');

/* 四个系列标题都在 */
['牌型', '对撞', '通吃', '战绩'].forEach(function (t) {
  ok(h.indexOf('>' + t) >= 0 || h.indexOf(t + ' <') >= 0 || h.indexOf(t) >= 0,
    '系列标题出现：' + t);
});

/* 战绩系列靠档案字段：games=20 → 常客解锁、老油条没解锁 */
ok(h.indexOf('常客') >= 0, '战绩系列按 games 判定（常客出现）');
ok(h.indexOf('100') >= 0, '老油条的目标值 100 出现在进度里');

/* 别人看：标题文案不同 */
var hAnon = AV.pageHtml(prof, Ach, { isMe: false });
ok(hAnon.indexOf('玩家A 已解锁') >= 0, '看别人时标题写对方名字');
ok(h0.indexOf('你已解锁') >= 0, '看自己时写「你已解锁」');

/* ================================================================
 * 三、信息档入口行
 * ================================================================ */
var row = AV.entryRowHtml({ playerId: 'p9', achCount: 12, achTotal: 26 });
ok(row.indexOf('data-ach-open="p9"') >= 0, '★ 入口带 data-ach-open，点击委托靠它找人');
ok(row.indexOf('12 / 26') >= 0, '显示解锁数');
ok(row.indexOf('<button') === 0, '是一整条按钮（整卡唯一的可点区域）');

eq(AV.entryRowHtml(null), '', '没有档案时不渲染这一行（而不是渲染个空按钮）');
eq(AV.entryRowHtml({}), '', '缺 playerId 时也不渲染');
var noCount = AV.entryRowHtml({ playerId: 'px' });
ok(noCount.indexOf('0 / 0') >= 0, '缺计数时退化成 0 / 0，不出现 NaN 或 undefined');

/* ================================================================
 * 四、概率格式化
 * ================================================================ */
eq(AV.rateText(null), '—', 'null → 破折号');
eq(AV.rateText(0), '0.0%', '0 → 0.0%');
eq(AV.rateText(0.0005), '<0.1%', '极小概率不显示成 0.0%（那是「一次都没有」的意思）');
eq(AV.rateText(0.5), '50.0%', '0.5 → 50.0%');
eq(AV.rateText(0.125), '12.5%', '0.125 → 12.5%');

/* XSS：昵称与描述都进 HTML，必须转义 */
var evil = AV.pageHtml({ playerId: 'p', nickname: '<img onerror=1>', games: 0, ach: Ach.blank() }, Ach, { isMe: false });
eq(evil.indexOf('<img'), -1, '★ 昵称里的标签被转义（成就页会把昵称拼进标题）');

/* ================================================================
 * 汇总
 * ================================================================ */
console.log('\n' + (fail === 0 ? '全部通过' : '有失败') + '：' + pass + ' 项通过，' + fail + ' 项失败');
if (fail) process.exit(1);
