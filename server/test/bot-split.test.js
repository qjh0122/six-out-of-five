/**
 * 机器人拆牌（server/botClient.js 的 split）
 * 跑法：node server/test/bot-split.test.js
 *
 * 为什么单独测这一小块：它决定了「后台模拟出来的数据像不像真人」。
 * 原来的实现按位置硬拆（[0] / [1,2] / [3,4,5]），协议上完全合法 ——
 * 所以任何「能不能跑通」的测试都是绿的，但打出来的数据系统性偏差：
 *   十点半爆点 31% / 牛牛 13% / 单张胜率 50%（见 scripts/analyze-bot-split.js）
 * 这正是使用者反馈「大牌少、小牌多」的来源。所以这里锁三件事：
 *
 *   1. **合法性**：三组/两组张数对、6 张牌不重不漏、键名只给本轮该给的。
 *      不合法会被服务端 SM.submitGroups 直接拒，任务会当场失败。
 *   2. **smart ≠ naive**：默认必须是会挑牌的那个，不是按位置拆。
 *   3. **效果可量化**：智能打法在十点半上的爆点率必须显著低于按位置拆。
 *      这条是「策略真的有用」的证据，而不是「换了个函数名」。
 */
'use strict';

const path = require('path');
const { BotClient } = require('../botClient.js');
const Engine = require(path.join(__dirname, '..', '..', 'pwa', 'js', 'engine.js'));
const Card = require(path.join(__dirname, '..', '..', 'pwa', 'js', 'card.js'));

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

/* 只为了拿到 split()/strategy，不连任何服务：base 给个假地址，
 * 构造函数不发请求（登录/连接都在显式方法里）。 */
function mk(strategy) {
  return new BotClient({ base: 'http://127.0.0.1:1', code: '', account: { name: 'x', password: 'y' }, strategy: strategy });
}

function deal() {
  const d = Card.createDeck();
  Card.shuffle(d);
  return d.splice(0, 6);
}

/* 同一张牌对象只出现一次，且六张全在（按引用比，不按牌面：一副牌里没有重牌）。
 * 注意用 reduce 摊平，不要写 `[].concat(cards)` —— 那样只摊一层，
 * 传进来的是「数组的数组」，内层数组不会被打散（这个坑当场把 8000 次检查判成失败）。 */
function coversAll(hand, cards) {
  const flat = cards.reduce((acc, c) => acc.concat(c), []);
  if (flat.length !== hand.length) return false;
  const seen = new Set(flat);
  if (seen.size !== flat.length) return false;
  return hand.every((c) => seen.has(c));
}

console.log('[策略默认值]');
ok(mk().strategy === 'smart', '不传参时默认 smart（会挑牌）', mk().strategy);
ok(mk('naive').strategy === 'naive', '显式传 naive 才走按位置拆');
ok(mk('whatever').strategy === 'smart', '没见过的值一律落到 smart，不静默退化成不会打牌');

console.log('\n[合法性：张数 / 不重不漏 / 键名]');
{
  let bad = 0, badKey = 0;
  for (let i = 0; i < 2000; i++) {
    const hand = deal();
    for (const s of ['smart', 'naive']) {
      const b = mk(s);

      const r1 = b.split(hand, 1);
      const k1 = Object.keys(r1).sort().join(',');
      if (k1 !== 'piaosanye,single,tenhalf') badKey++;
      if (r1.single.length !== 1 || r1.tenhalf.length !== 2 || r1.piaosanye.length !== 3) bad++;
      if (!coversAll(hand, [r1.single, r1.tenhalf, r1.piaosanye])) bad++;

      const r2 = b.split(hand, 2);
      const k2 = Object.keys(r2).sort().join(',');
      if (k2 !== 'douniu,single') badKey++;
      if (r2.single.length !== 1 || r2.douniu.length !== 5) bad++;
      if (!coversAll(hand, [r2.single, r2.douniu])) bad++;
    }
  }
  ok(bad === 0, '2000 手 × 2 种打法：张数对、6 张不重不漏', bad);
  ok(badKey === 0, '只交本轮该交的键（多交会被服务端拒）', badKey);
}

console.log('\n[naive 确实是按位置拆]');
{
  const hand = deal();
  const b = mk('naive');
  const r1 = b.split(hand, 1);
  ok(r1.single[0] === hand[0] && r1.tenhalf[0] === hand[1] && r1.tenhalf[1] === hand[2] &&
    r1.piaosanye[0] === hand[3] && r1.piaosanye[1] === hand[4] && r1.piaosanye[2] === hand[5],
    '第一轮 = [0] / [1,2] / [3,4,5]');
  const r2 = b.split(hand, 2);
  ok(r2.single[0] === hand[0] && r2.douniu.join(',') === [hand[1], hand[2], hand[3], hand[4], hand[5]].join(','),
    '第二轮 = [0] / [1..5]');
}

console.log('\n[效果：智能打法真的更优（各 3000 手）]');
{
  const N = 3000;
  let smartBust = 0, naiveBust = 0;
  let smartCow = 0, naiveCow = 0, smartNiu = 0, naiveNiu = 0;
  const smart = mk('smart'), naive = mk('naive');
  for (let i = 0; i < N; i++) {
    const hand = deal();
    const s1 = smart.split(hand, 1);
    const n1 = naive.split(hand, 1);
    if (Engine.tenHalfBust(s1.tenhalf)) smartBust++;
    if (Engine.tenHalfBust(n1.tenhalf)) naiveBust++;

    const s2 = smart.split(hand, 2);
    const n2 = naive.split(hand, 2);
    if (Engine.douNiuHasCow(s2.douniu)) smartCow++;
    if (Engine.douNiuHasCow(n2.douniu)) naiveCow++;
    if (Engine.douNiuTypeName(s2.douniu) === '牛牛') smartNiu++;
    if (Engine.douNiuTypeName(n2.douniu) === '牛牛') naiveNiu++;
  }
  const pct = (a) => (a / N * 100).toFixed(1) + '%';
  console.log('    十点半爆点  smart ' + pct(smartBust) + ' / naive ' + pct(naiveBust));
  console.log('    第二轮有牛  smart ' + pct(smartCow) + ' / naive ' + pct(naiveCow));
  console.log('    第二轮牛牛  smart ' + pct(smartNiu) + ' / naive ' + pct(naiveNiu));

  /* 阈值给得宽：这些是概率断言，不能用「刚好等于理论值」那种写法。
   * 实测（6 万手）是 0.5% vs 31%、90% vs 70%、40% vs 13%，这里留足余量。 */
  ok(smartBust < N * 0.03, '智能打法十点半爆点 < 3%（按位置拆约 31%）', pct(smartBust));
  ok(naiveBust > N * 0.2, '对照组按位置拆爆点 > 20%（证明这个对照有意义）', pct(naiveBust));
  ok(smartCow > naiveCow, '智能打法「有牛」率高于按位置拆', pct(smartCow) + ' vs ' + pct(naiveCow));
  ok(smartNiu > naiveNiu * 1.5, '智能打法牛牛率至少是 1.5 倍', pct(smartNiu) + ' vs ' + pct(naiveNiu));
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
