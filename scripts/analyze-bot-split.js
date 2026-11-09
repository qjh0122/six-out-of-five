/**
 * 拆牌策略对照实验（一次性分析工具）
 * 跑法：node scripts/analyze-bot-split.js [把数]
 *
 * 要回答的问题：后台机器人打出来的数据为什么「大牌少、小牌多」？
 * 有三种可能，必须分开验证，不能混着猜：
 *   A. 发牌本身有偏置（洗牌算法 / 随机源 / 座位顺序）
 *   B. 机器人拆牌策略差（按位置硬拆，把好牌浪费掉）
 *   C. 结算规则不公平（某个座位有结构优势）
 *
 * 这里做三个实验：
 *   1) 发牌均匀性 —— 52 张牌的出现频次卡方检验 + 三个座位的均值对照
 *   2) 牌型分布 —— 同一批 6 张牌，机器人拆法 vs AI 穷举最优拆法的牌型差异
 *   3) 三人桌对局 —— 全机器人 / 全 AI / 混桌，各打 N 把，比净胜与座位差
 *
 * 用的是仓库里真实的 engine / ai / card，不另写一套规则。
 */
'use strict';

const path = require('path');
const Engine = require(path.join(__dirname, '..', 'pwa', 'js', 'engine.js'));
const AI = require(path.join(__dirname, '..', 'pwa', 'js', 'ai.js'));
const Card = require(path.join(__dirname, '..', 'pwa', 'js', 'card.js'));

const N = Number(process.argv[2]) || 20000;
const SEATS = 3;
const REPEAT = 8;

/* 机器人的拆法：与 server/botClient.js 的 submitRound 完全一致。
 * 那边是按位置取牌，这里必须照抄同一套，否则测的不是线上那个东西。 */
function botSplit(hand) {
  return {
    single: [hand[0]],
    tenhalf: [hand[1], hand[2]],
    piaosanye: [hand[3], hand[4], hand[5]],
    douniu: [hand[1], hand[2], hand[3], hand[4], hand[5]]
  };
}

const CARDS_PER_HAND = 6;

function deal() {
  const deck = Card.createDeck();
  Card.shuffle(deck);
  const hands = [];
  for (let i = 0; i < SEATS; i++) hands.push(deck.splice(0, CARDS_PER_HAND));
  return hands;
}

const pct = (a, b) => (b ? ((a / b) * 100).toFixed(2) : '0.00') + '%';
const f2 = (x) => (Math.round(x * 100) / 100).toFixed(2);

/* ---------------------------- 1. 发牌均匀性 ---------------------------- */

/* 统计量：每张牌在「每把前 18 张」里出现的频次卡方。
 *
 * ★ 这个统计量的理论期望**不是** df=52：每把从 53 张里取 18 张是无放回的，
 *   单张牌的频次方差是 n·p(1−p)（p=18/53），只有泊松假设的 0.66 倍，
 *   所以零假设下的 χ² 大约只有 34，而不是 52。
 *   第一版按 df=52 判，把 27.7 判成「偏置」，其实是判法错了。
 *   正确做法：用**同一个统计量**去测一把已知均匀的洗牌（标准 Fisher-Yates + Math.random），
 *   先量出零分布，再拿引擎的实测值去比。 */
function dealChi(deckFn, trials) {
  const freq = new Map();
  let total = 0;
  for (let t = 0; t < trials; t++) {
    const d = deckFn();
    for (let i = 0; i < SEATS * CARDS_PER_HAND; i++) {
      const c = d[i];
      const k = c.suit + ':' + c.rank;
      freq.set(k, (freq.get(k) || 0) + 1);
      total++;
    }
  }
  const keys = [...freq.keys()];
  const expect = total / keys.length;
  let chi = 0;
  for (const k of keys) chi += Math.pow((freq.get(k) || 0) - expect, 2) / expect;
  return { chi, total, cats: keys.length };
}

/* 已知均匀的洗牌：标准 Fisher-Yates，随机源用 Math.random。
 * 它只用来量零分布，不参与任何游戏逻辑。 */
function uniformDeck() {
  const d = Card.createDeck();
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = d[i]; d[i] = d[j]; d[j] = t;
  }
  return d;
}

function engineDeck() {
  const d = Card.createDeck();
  Card.shuffle(d);
  return d;
}

function testFairness() {
  const REPS = 16;
  const nulls = [];
  for (let i = 0; i < REPS; i++) nulls.push(dealChi(uniformDeck, N).chi);
  const nm = nulls.reduce((a, b) => a + b, 0) / nulls.length;
  const nsd = Math.sqrt(nulls.reduce((a, b) => a + Math.pow(b - nm, 2), 0) / (nulls.length - 1));

  const got = dealChi(engineDeck, N);

  /* 座位侧：每个座位的平均牌力与大牌占比。判据用标准误，不看裸差。 */
  const seatSum = new Array(SEATS).fill(0);
  const seatHigh = new Array(SEATS).fill(0);
  const seatSd = new Array(SEATS).fill(0);
  const seatSq = new Array(SEATS).fill(0);
  const perSeat = new Array(SEATS).fill(0);
  for (let t = 0; t < N; t++) {
    const hands = deal();
    for (let s = 0; s < SEATS; s++) {
      let v = 0;
      for (const c of hands[s]) {
        v += Engine.singleRank(c);
        if (Engine.singleRank(c) >= 12) seatHigh[s]++;
      }
      seatSum[s] += v;
      seatSq[s] += v * v;
      perSeat[s] += CARDS_PER_HAND;
    }
  }
  for (let s = 0; s < SEATS; s++) {
    const m = seatSum[s] / perSeat[s];
    const varr = seatSq[s] / perSeat[s] - m * m;
    seatSd[s] = Math.sqrt(Math.max(0, varr) / perSeat[s]);
  }

  console.log('== 1. 发牌均匀性 ==');
  console.log('  样本：' + N + ' 把 × ' + SEATS + ' 人 × 6 张 = ' + got.total + ' 张，' + got.cats + ' 个牌种');
  console.log('  零分布（标准随机洗牌同统计量，' + REPS + ' 次）：χ² = ' + f2(nm) + ' ± ' + f2(nsd));
  console.log('  引擎实测：χ² = ' + f2(got.chi) +
    '（偏离 ' + f2((got.chi - nm) / nsd) + ' σ）');
  const z = Math.abs((got.chi - nm) / nsd);
  console.log('  判定：' + (z <= 2 ? '与标准随机洗牌不可区分 → 无发牌偏置' : '偏离零分布 2σ 以上，需复查'));
  console.log('  每座位平均牌力 ' + seatSum.map((v, i) => f2(v / perSeat[i])).join(' / ') +
    '（标准误约 ' + f2(seatSd[0]) + '）');
  console.log('  「大牌」（单张 ≥Q）占比 ' +
    seatHigh.map((v, i) => pct(v, perSeat[i])).join(' / '));
  return { chi: got.chi, nullMean: nm, z };
}

/* ---------------------------- 2. 牌型分布对照 ---------------------------- */
function testHandTypes() {
  let botCow = 0, aiCow = 0, botNiuniu = 0, aiNiuniu = 0;
  let botBust = 0, aiBust = 0;
  let botTenSum = 0, aiTenSum = 0, botTen105 = 0, aiTen105 = 0;
  let botSingle = 0, aiSingle = 0;
  const typeCount = { bot: {}, ai: {} };

  for (let t = 0; t < N; t++) {
    const hands = deal();
    const hand = hands[0];

    const b = botSplit(hand);
    const aiR1 = AI.decideRound1(hand);
    const aiR2 = AI.decideRound2(hand);

    /* 第二轮：5 张斗牛 */
    const bType = Engine.douNiuTypeName(b.douniu);
    const aType = Engine.douNiuTypeName(aiR2.douniu);
    typeCount.bot[bType] = (typeCount.bot[bType] || 0) + 1;
    typeCount.ai[aType] = (typeCount.ai[aType] || 0) + 1;
    if (Engine.douNiuHasCow(b.douniu)) botCow++;
    if (Engine.douNiuHasCow(aiR2.douniu)) aiCow++;
    if (bType === '牛牛') botNiuniu++;
    if (aType === '牛牛') aiNiuniu++;

    /* 第一轮：十点半 */
    const bTen = b.tenhalf;
    const aTen = aiR1.tenhalf && aiR1.tenhalf.length === 2 ? aiR1.tenhalf : b.tenhalf;
    if (Engine.tenHalfBust(bTen)) botBust++;
    if (Engine.tenHalfBust(aTen)) aiBust++;
    botTenSum += Engine.tenHalfTotal(bTen);
    aiTenSum += Engine.tenHalfTotal(aTen);
    if (Math.abs(Engine.tenHalfTotal(bTen) - 105) < 0.01) botTen105++;
    if (Math.abs(Engine.tenHalfTotal(aTen) - 105) < 0.01) aiTen105++;

    /* 单张：用引擎自己的单张比较器量化「谁大」—— 拿它跟随机一张牌比，算胜率 */
    botSingle += Engine.compareSingle(b.single[0], hand[3]) > 0 ? 1 : 0;
    const aiS = (aiR1.single && aiR1.single[0]) || b.single[0];
    aiSingle += Engine.compareSingle(aiS, hand[3]) > 0 ? 1 : 0;
  }

  console.log('\n== 2. 同一批牌，两种拆法的差距 ==');
  console.log('  第二轮（5 张斗牛）：');
  console.log('    机器人  有牛 ' + pct(botCow, N) + ' · 牛牛 ' + pct(botNiuniu, N));
  console.log('    AI 最优 有牛 ' + pct(aiCow, N) + ' · 牛牛 ' + pct(aiNiuniu, N));
  console.log('  第一轮（2 张十点半）：');
  console.log('    机器人  爆点 ' + pct(botBust, N) + ' · 平均点 ' + f2(botTenSum / N / 10) +
    ' · 正好 10.5 ' + pct(botTen105, N));
  console.log('    AI 最优 爆点 ' + pct(aiBust, N) + ' · 平均点 ' + f2(aiTenSum / N / 10) +
    ' · 正好 10.5 ' + pct(aiTen105, N));
  console.log('  单张（对随机一张牌的胜率）：');
  console.log('    机器人 ' + pct(botSingle, N) + ' · AI 最优 ' + pct(aiSingle, N));

  const top = Object.entries(typeCount.bot).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const topAi = Object.entries(typeCount.ai).sort((a, b) => b[1] - a[1]).slice(0, 4);
  console.log('  机器人牌型 Top4：' + top.map(([k, v]) => k + ' ' + pct(v, N)).join(' / '));
  console.log('  AI 牌型 Top4   ：' + topAi.map(([k, v]) => k + ' ' + pct(v, N)).join(' / '));
  return { botCow, aiCow, botBust, aiBust };
}

/* ---------------------------- 3. 三人桌对局 ---------------------------- */
function playTable(kinds, handsLimit) {
  /* kinds: ['bot'|'ai', ...] 三个座位 */
  const ids = ['a', 'b', 'c'];
  const score = { a: 0, b: 0, c: 0 };
  const wins = { a: 0, b: 0, c: 0 };

  for (let h = 0; h < handsLimit; h++) {
    const hands = deal();
    const decide = (seat) => (kinds[seat] === 'ai' ? AI : { decideRound1: botSplit, decideRound2: botSplit });
    const r1 = ids.map((id, i) => {
      const d = decide(i).decideRound1(hands[i]);
      return { id, split: d };
    });
    const r2 = ids.map((id, i) => {
      const d = decide(i).decideRound2(hands[i]);
      return { id, split: d };
    });

    /* 第一轮三组 */
    for (const key of ['single', 'tenhalf', 'piaosanye']) {
      const entries = r1.map((x) => ({ id: x.id, hand: x.split[key] || [] }));
      const r = Engine.settleGroup(key, entries);
      for (const pid in r.deltas) score[pid] += r.deltas[pid];
      wins[r.winnerId] = (wins[r.winnerId] || 0) + 1;
    }
    /* 第二轮两组 */
    for (const key of ['single', 'douniu']) {
      const entries = r2.map((x) => ({ id: x.id, hand: x.split[key] || [] }));
      const r = Engine.settleGroup(key, entries);
      for (const pid in r.deltas) score[pid] += r.deltas[pid];
      wins[r.winnerId] = (wins[r.winnerId] || 0) + 1;
    }
  }
  return { score, wins, handsLimit };
}

function testTables(hands) {
  const cases = [
    { name: '全机器人（= 后台模拟对战）', kinds: ['bot', 'bot', 'bot'] },
    { name: '全 AI（会挑牌）', kinds: ['ai', 'ai', 'ai'] },
    { name: '1 AI + 2 机器人', kinds: ['ai', 'bot', 'bot'] }
  ];
  console.log('\n== 3. 三人桌实测（每人 ' + hands + ' 把） ==');
  for (const c of cases) {
    const r = playTable(c.kinds, hands);
    const vals = ['a', 'b', 'c'].map((k) => r.score[k]);
    const sum = vals.reduce((x, y) => x + y, 0);
    console.log('  ' + c.name);
    console.log('    净胜 ' + vals.map((v) => (v > 0 ? '+' : '') + v).join(' / ') +
      '（合计 ' + sum + (sum === 0 ? ' ✓ 零和' : ' ✗') + '）');
    console.log('    每组胜场 ' + ['a', 'b', 'c'].map((k) => r.wins[k] || 0).join(' / ') +
      '（每把共 5 组，全场合计 ' + (r.wins.a + r.wins.b + r.wins.c) + '）');
    if (c.name.indexOf('1 AI') === 0) {
      console.log('    座位差：AI 座位 ' + (vals[0] > 0 ? '+' : '') + vals[0] +
        '，两个机器人座位 ' + vals[1] + ' / ' + vals[2]);
    }
  }

  /* 座位偏置必须用重复实验判，不能看单次 —— 单次差几百是方差，不是偏置。
   * 这里把同一张桌子跑 K 次，看每个座位的均值是否稳定偏离 0。 */
  console.log('\n== 4. 座位偏置（同一张桌子重复 ' + REPEAT + ' 次 × ' + hands + ' 把） ==');
  for (const c of [{ name: '全机器人', kinds: ['bot', 'bot', 'bot'] }]) {
    const per = [[], [], []];
    for (let i = 0; i < REPEAT; i++) {
      const r = playTable(c.kinds, hands);
      per[0].push(r.score.a); per[1].push(r.score.b); per[2].push(r.score.c);
    }
    const stat = per.map((arr) => {
      const m = arr.reduce((x, y) => x + y, 0) / arr.length;
      const sd = Math.sqrt(arr.reduce((x, y) => x + Math.pow(y - m, 2), 0) / (arr.length - 1));
      return { m, sd, se: sd / Math.sqrt(arr.length) };
    });
    console.log('  ' + c.name + '（每格：均值 ± 标准误）');
    stat.forEach((s, i) => {
      console.log('    座位' + (i + 1) + ' ' + f2(s.m) + ' ± ' + f2(s.se) +
        '（单次标准差 ' + f2(s.sd) + '，t=' + f2(s.se ? s.m / s.se : 0) + '）');
    });
    const maxT = Math.max(...stat.map((s) => Math.abs(s.se ? s.m / s.se : 0)));
    console.log('    判定：|t|max = ' + f2(maxT) + (maxT < 2 ? ' → 无座位偏置（差在噪声内）' : ' → 需复查'));
  }
}

/* ---------------------------- 主流程 ---------------------------- */
console.log('引擎 ' + (Engine.CONFIG ? '已加载' : '未加载') + '，AI ' + (typeof AI.decideRound1 === 'function' ? '已加载' : '未加载'));
testFairness();
testHandTypes();
testTables(Math.max(500, Math.round(N / 10)));
