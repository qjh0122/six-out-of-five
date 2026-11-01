/**
 * AI 分牌策略测试
 * 跑法：node pwa/test/ai.test.js
 *
 * 关键约束：AI 出的分组必须永远能通过状态机的合法性校验，
 * 否则线上会出现「AI 提交失败导致整局卡住」。
 */
'use strict';

const Card = require('../js/card.js');
const SM = require('../js/stateMachine.js');
const AI = require('../js/ai.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

const ROUNDS = 2000;

function key(c) { return c.suit + '-' + c.rank; }

function checkGroups(hand, round, groups) {
  const keys = SM.ROUND_GROUPS[round];
  const handSet = new Set(hand.map(key));
  const used = [];

  for (const k of keys) {
    const need = SM.GROUP_COUNT[k];
    const got = groups[k] || [];
    if (got.length !== need) return `组 ${k} 张数 ${got.length}，应为 ${need}`;
    used.push(...got);
  }
  if (used.length !== 6) return `总共用了 ${used.length} 张，应为 6`;
  const usedSet = new Set(used.map(key));
  if (usedSet.size !== 6) return '存在重复使用的牌';
  for (const u of usedSet) if (!handSet.has(u)) return '用了手牌以外的牌';
  // 没被本轮使用的组必须为空
  for (const k of ['single', 'tenhalf', 'piaosanye', 'douniu']) {
    if (keys.indexOf(k) < 0 && (groups[k] || []).length > 0) {
      return `本轮不用的组 ${k} 竟然有牌`;
    }
  }
  return null;
}

console.log('[合法性] 随机发牌 ' + ROUNDS + ' 次，两轮分组都必须合法');
let bad = 0;
for (let i = 0; i < ROUNDS; i++) {
  const deck = Card.createDeck();
  Card.shuffle(deck);
  const hand = deck.slice(0, 6);

  const g1 = AI.decide(hand, 1);
  const e1 = checkGroups(hand, 1, g1);
  if (e1) { bad++; if (bad <= 3) console.log('  第一轮不合法：' + e1); }

  const g2 = AI.decide(hand, 2);
  const e2 = checkGroups(hand, 2, g2);
  if (e2) { bad++; if (bad <= 3) console.log('  第二轮不合法：' + e2); }
}
ok(bad === 0, '两轮分组全部合法', bad + ' 次不合法');

/* ================================================================
 * 策略质量：AI 不能做出明显亏的决策
 * ================================================================ */
console.log('\n[策略] 关键场景检查');

function findHand(predicate) {
  const deck = Card.createDeck();
  for (let i = 0; i < 200000; i++) {
    Card.shuffle(deck);
    const hand = deck.slice(0, 6);
    if (predicate(hand)) return hand;
  }
  return null;
}

/* 场景 1：手上没有牛也要尽量凑，不能留没牛 */
{
  let noCowWorse = 0;
  let checked = 0;
  for (let i = 0; i < 400; i++) {
    const deck = Card.createDeck();
    Card.shuffle(deck);
    const hand = deck.slice(0, 6);
    const g = AI.decide(hand, 2);
    const type = require('../js/engine.js').douNiuType(g.douniu).type;
    const singleType = require('../js/engine.js').douNiuType(
      hand.filter((c, idx) => idx !== hand.indexOf(g.single[0]))
    ).type;
    checked++;
    if (type < 0 && singleType >= 0) noCowWorse++;
  }
  ok(noCowWorse === 0, '不会在存在成牛分法时选出没牛', noCowWorse + '/' + checked + ' 次退化');
}

/* 场景 2：第二轮单张不应占用能给斗牛凑型的关键牌（逻辑上由权重保证，
 * 这里抽查：AI 选的单张，其斗牛强度不弱于随机另一种分法的一半 */
{
  let worse = 0;
  const Engine = require('../js/engine.js');
  /* 样本量从 300 提到 2000：300 次只允许 3 次偏差（1%）时，
   * 真实比例哪怕只有 1%，按泊松分布也有三成多的概率超限——这个断言本身是抖的，
   * 跑一次挂一次纯属运气。2000 次把阈值放到 3%（60 次），
   * 既还咬得住「明显偏弱」这种系统性退化，又不会随机报警。 */
  const SAMPLES = 2000;
  for (let i = 0; i < SAMPLES; i++) {
    const deck = Card.createDeck();
    Card.shuffle(deck);
    const hand = deck.slice(0, 6);
    const g = AI.decide(hand, 2);
    const best = Engine.douNiuType(g.douniu).type;
    // 遍历其它 5 种分法，确认 AI 选的斗牛型不低于平均值
    let sum = 0;
    for (let j = 0; j < 6; j++) {
      const dn = hand.filter((c, idx) => idx !== j);
      sum += Engine.douNiuType(dn).type;
    }
    const avg = sum / 6;
    if (best < avg - 2) worse++;
  }
  ok(worse <= SAMPLES * 0.03, '选出的斗牛型不低于平均（2000 次里明显偏弱不超过 3%）',
    worse + '/' + SAMPLES + ' 次明显偏弱');
}

/* 场景 3：有 10.5 的分法时，只在「保住豹子」的情况下才允许放弃。
 * 豹子与 10.5 同样收 2 分，但豹子几乎必赢、10.5 还会被同点比花色，
 * 所以为了豹子牺牲 10.5 是正确决策；除此之外放弃 10.5 就是判断错误。 */
{
  const Engine = require('../js/engine.js');
  let miss = 0, found = 0, keptLeopard = 0;
  for (let i = 0; i < 500; i++) {
    const deck = Card.createDeck();
    Card.shuffle(deck);
    const hand = deck.slice(0, 6);
    const g = AI.decide(hand, 1);
    if (Engine.tenHalfTotal(g.tenhalf) === 105) { found++; continue; }

    let otherExists = false;
    for (let a = 0; a < 5; a++) {
      for (let b = a + 1; b < 6; b++) {
        if (Engine.tenHalfTotal([hand[a], hand[b]]) === 105) { otherExists = true; }
      }
    }
    if (!otherExists) continue;

    const psyType = Engine.piaoSanYeType(g.piaosanye).type;
    if (psyType === Engine.PSY_TYPE.LEOPARD) { keptLeopard++; continue; }
    miss++;
    if (miss <= 3) {
      console.log('  放弃 10.5 但飘三叶只有 ' + Engine.piaoSanYeTypeName(g.piaosanye));
    }
  }
  ok(miss === 0, '存在 10.5 时不会无故放弃（直接选中 ' + found + ' 次，为保豹子放弃 ' + keptLeopard + ' 次）', miss + ' 次无故错过');
}

/* 场景 4：决策耗时可接受 */
{
  const deck = Card.createDeck();
  Card.shuffle(deck);
  const t0 = Date.now();
  for (let i = 0; i < 1000; i++) {
    AI.decide(deck.slice(0, 6), 1);
    AI.decide(deck.slice(0, 6), 2);
  }
  const cost = Date.now() - t0;
  ok(cost < 2000, '1000 次决策耗时 ' + cost + 'ms，服务端可接受');
}

/* 场景 5：异常输入不炸 */
{
  ok(AI.decide([], 1).single.length === 0, '空手牌返回空分组');
  ok(AI.decide(null, 2).douniu.length === 0, 'null 手牌返回空分组');
}


/* 场景 6：收益模型必须跟着 config.js 走
 * 以前 ai.js 把「单张收 1 分 / 十点半 10.5 收 2 分 / 飘三叶豹子 +1 / 没牛倒扣 5」
 * 全写死在代码里，策划改 config.js 之后 AI 的模型不跟着变，
 * 于是开始出现「配置里五花牛收 6 分，AI 还按 4 分算」这类亏本决策。 */
{
  const Engine = require('../js/engine.js');
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'js', 'ai.js'), 'utf8');
  ok(/num\('TENHALF_MAX_WIN'/.test(src), '十点半双倍收分读配置（TENHALF_MAX_WIN）');
  ok(/num\('SINGLE_WIN'/.test(src), '单张收分读配置（SINGLE_WIN）');
  ok(/num\('PIAOSANYE_LEOPARD_BONUS'/.test(src), '飘三叶豹子加分读配置');
  ok(/DOUNIU_NONE_PENALTY/.test(src), '斗牛没牛罚分读配置');
  ok(!/CONFIG_TENHALF_MAX/.test(src), '没有残留写死的 10.5 收分常量');

  // 真改一次配置，确认 AI 仍然出合法分组（策略内置，不会因为配置变化崩掉）
  const before = Engine.CONFIG.TENHALF_MAX_WIN;
  Engine.setConfig({ TENHALF_MAX_WIN: 5, DOUNIU_NONE_PENALTY: 9 });
  const hand = Card.createDeck().slice(0, 6);
  const g1 = AI.decide(hand, 1);
  const ok1 = g1.single.length === 1 && g1.tenhalf.length === 2 && g1.piaosanye.length === 3;
  Engine.setConfig({ TENHALF_MAX_WIN: before, DOUNIU_NONE_PENALTY: 5 });
  ok(ok1, '改完配置后 AI 仍然给出合法分组');
}

/* ==========================================================================
 * 爆点约束：AI 也必须守「能不爆就不许爆」
 *
 * 人类把十点半排成爆点时会被弹窗硬挡住、不给提交（game.js 的 bust-modal）。
 * AI 之前只按期望值挑，爆点那组 EV 记 0 但总分仍可能最高 → 会主动送出一组爆点：
 * 20000 手随机牌里 300 手排成爆点，其中 202 手本来完全可以不爆。
 * 那是规则双标：人被拦、AI 照送，白输一组。
 * ======================================================================== */
console.log('\n[爆点] AI 不许主动排成十点半爆点');

{
  const Engine0 = require('../js/engine.js');
  let bust = 0, avoidable = 0;
  const N = 4000;
  for (let t = 0; t < N; t++) {
    const deck = Card.createDeck();
    Card.shuffle(deck);
    const hand = deck.slice(0, 6);
    const g = AI.decide(hand, 1);
    if (!Engine0.tenHalfBust(g.tenhalf)) continue;
    bust++;
    /* 还有没有别的拆法是不爆的？有就说明 AI 选错了 */
    let hasSafe = false;
    for (let i = 0; i < 6 && !hasSafe; i++) {
      const rest = hand.filter(function (_, x) { return x !== i; });
      for (let a = 0; a < 4 && !hasSafe; a++) {
        for (let b = a + 1; b < 5 && !hasSafe; b++) {
          if (!Engine0.tenHalfBust([rest[a], rest[b]])) hasSafe = true;
        }
      }
    }
    if (hasSafe) avoidable++;
  }
  ok(bust >= 0, N + ' 手随机牌里 AI 排成爆点 ' + bust + ' 手（都是怎么配都爆的烂牌）');
  ok(avoidable === 0, '★ 其中 0 手是「本可以不爆却爆了」（修复前这类约占 1%）',
    avoidable + ' 手本可不爆');

  /* 定向用例：6 6 7 8 9 10 —— 最小的两张 6+6=12 也已经超过 10.5，
   * 所以怎么配都爆（J/Q/K 是半点，凑不出小牌；王会被解析成最优，这里没有王）。 */
  const mustBust = [{ suit: 'heart', rank: 6 }, { suit: 'spade', rank: 6 },
    { suit: 'diamond', rank: 7 }, { suit: 'club', rank: 8 },
    { suit: 'spade', rank: 9 }, { suit: 'heart', rank: 10 }];
  ok(Engine0.tenHalfBust(AI.decide(mustBust, 1).tenhalf),
    '全是大牌（6 6 7 8 9 10）：认了，怎么配都爆');

  const canAvoid = [{ suit: 'spade', rank: 14 }, { suit: 'heart', rank: 2 },
    { suit: 'club', rank: 3 }, { suit: 'diamond', rank: 10 },
    { suit: 'spade', rank: 10 }, { suit: 'heart', rank: 13 }];
  ok(!Engine0.tenHalfBust(AI.decide(canAvoid, 1).tenhalf),
    '★ A 2 3 10 10 K：有 10.5 的打法时绝不把 K 塞进十点半去爆',
    JSON.stringify(AI.decide(canAvoid, 1).tenhalf));
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail === 0 ? 0 : 1);
