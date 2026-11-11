/**
 * 小王（jack of small）守卫（2026-11-12）
 *
 * ── 规则来源 ────────────────────────────────────────────────────
 * 用户原文：「除了大王，再增加小王，大王和小王一样都是赖子，一模一样的功能，
 * 小王打不过大王」。追问后补了两条口径：
 *   ① 单张比大小：小王仅次于大王、高于 K。
 *   ② 「打不过」的生效范围 ——「**只有需要用王比大小的时候才由王决胜**，
 *      反例就是对于斗牛，如果都是牛牛，不用王比大小，是用 10JQK 比」。
 *      随后又补：「飘三叶也需要看王大小，比如大王加俩 7 的豹子比小王加俩 7 的豹子大」。
 *
 * 于是四种玩法里「王的位置」并不统一，这正是最容易改错的地方：
 *   单张     王本身就是牌             → 大王(15) > 小王(14.5) > K
 *   十点半   王参与比花色（王压真花色）→ 大王 > 小王 > ♠>♥>♣>♦
 *   飘三叶   王先当替身，替完还平才比王 → 大王 > 小王 > 无王
 *   斗牛     王完全不参与比大小        → 同样牛型比 10/J/Q/K，有王也不决胜
 *
 * ── 这里守什么 ──────────────────────────────────────────────────
 * [1] 牌堆：54 张、两张王都在、id 不重复
 * [2] 单张顺位
 * [3] 十点半：双王要点数（9+双王 = 10.5，不是 11 爆）、大王压小王、王压真 10
 * [4] 飘三叶：大王+77 > 小王+77；小王+77 > 真 777；双王+任意 = 豹子
 * [5] 斗牛：双王必牛牛；王不参与比大小 —— 用「其余全同」的**构造局**证明。
 *     注意这种局真实发牌不可达（一副牌里每张牌只有一张），
 *     所以它只能证明「王不参与」，不能证明「真实牌局会平局」；
 *     平局可达性的完整证明见 douniu-tie-unreachable.test.js
 * [6] 牌名 / AI 估值
 * [7] 源码守卫：别把「是不是王」写成只认大王
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Card = require('../js/card.js');
const Engine = require('../js/engine.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

const ROOT = path.join(__dirname, '..', '..');
const cardSrc = fs.readFileSync(path.join(ROOT, 'pwa', 'js', 'card.js'), 'utf8');
const engineSrc = fs.readFileSync(path.join(ROOT, 'pwa', 'js', 'engine.js'), 'utf8');
const aiSrc = fs.readFileSync(path.join(ROOT, 'pwa', 'js', 'ai.js'), 'utf8');

const c = (suit, rank) => ({ suit: suit, rank: rank });
const BIG = { suit: 'joker', rank: 15 };
const SMALL = { suit: 'joker', rank: 14.5 };

console.log('\n[1] 牌堆：54 张，两张王都在');
const deck = Card.createDeck();
eq(deck.length, 54, '一副牌 54 张');
eq(deck.filter(Card.isJoker).length, 2, '两张王');
eq(deck.filter(Card.isBigJoker).length, 1, '大王 1 张');
eq(deck.filter(Card.isSmallJoker).length, 1, '小王 1 张');
eq(deck.filter((x) => !Card.isJoker(x)).length, 52, '真牌仍是 52 张');
const ids = new Set(deck.map(Card.cardId));
eq(ids.size, 54, '54 张 id 互不相同（小王不能和大王撞 id）');
ok(ids.has('joker-14.5'), '小王的 id 是 joker-14.5', Array.from(ids).filter((x) => x.indexOf('joker') === 0).join(','));

console.log('\n[2] 单张：大王 > 小王 > K > … > A');
ok(Engine.compareSingle(BIG, SMALL) > 0, '大王 > 小王');
ok(Engine.compareSingle(SMALL, c('spade', 13)) > 0, '小王 > K');
ok(Engine.compareSingle(SMALL, c('spade', 14)) > 0, '小王 > A（A 当 1）');
eq(Engine.settleGroup('single', [
  { id: 'a', hand: [BIG] }, { id: 'b', hand: [SMALL] }
]).winnerId, 'a', '结算：大王赢小王');
eq(Engine.settleGroup('single', [
  { id: 'a', hand: [SMALL] }, { id: 'b', hand: [c('spade', 13)] }
]).winnerId, 'a', '结算：小王赢 K');

console.log('\n[3] 十点半：双王分别解析 + 大王压小王');
/* 这条是双王最容易错的：replaceJoker 会把两张王换成同一张牌，
 * 「9 + 王 + 王」统一换成 A 就得 9+1+1 = 11 爆。正确是 1 + 0.5 = 10.5。 */
eq(Engine.tenHalfDisplay([c('spade', 9), BIG, SMALL]), '10.5点', '9 + 双王 = 10.5（不是 11 爆）');
eq(Engine.tenHalfDisplay([c('spade', 8), BIG, SMALL]), '10.5点', '8 + 双王 = 10.5');
eq(Engine.tenHalfDisplay([BIG, SMALL]), '10.5点', '双王单独 = 10.5');
eq(Engine.tenHalfDisplay([c('spade', 13), SMALL]), '10.5点', '小王 + K = 10.5（小王完全万能）');
eq(Engine.tenHalfDisplay([c('spade', 7), SMALL]), '10点', '小王 + 7 = 10 点（王只能当 3，再大就爆）');
/* 同 10.5、都是王撑出来的 10 → 大王赢（用户：小王打不过大王） */
eq(Engine.settleGroup('tenhalf', [
  { id: 'a', hand: [c('heart', 10), BIG] }, { id: 'b', hand: [c('heart', 10), SMALL] }
]).winnerId, 'a', '都 10.5、都是王的 10 → 大王赢');
/* 王压真 10（既有规则，不能被小王改坏） */
/* 王当那张 10 才比 10 的花色；王只当半点时，参与决胜的仍是那张真 10。
 * 所以这里必须让王去当 10：[K♥ + 小王] 和 [10♠ + K♥] 都是 10.5，
 * a 的 10 是王（档位 5）、b 的 10 是 ♠（档位 4）→ a 赢。 */
eq(Engine.settleGroup('tenhalf', [
  { id: 'a', hand: [c('heart', 13), SMALL] }, { id: 'b', hand: [c('spade', 10), c('heart', 13)] }
]).winnerId, 'a', '王撑的 10 压真 10（小王也照样压）');

console.log('\n[4] 飘三叶：替完身还平，才由王决胜');
eq(Engine.piaoSanYeTypeName([SMALL, c('spade', 7), c('diamond', 7)]), '豹子', '小王 + 77 = 豹子');
eq(Engine.piaoSanYeTypeName([BIG, SMALL, c('spade', 5)]), '豹子', '双王 + 任意一张 = 豹子（都当成那张的点数）');
eq(Engine.settleGroup('piaosanye', [
  { id: 'big', hand: [BIG, c('spade', 7), c('diamond', 7)] },
  { id: 'small', hand: [SMALL, c('spade', 7), c('diamond', 7)] }
]).winnerId, 'big', '★ 大王 + 77 的豹子 > 小王 + 77 的豹子（用户原话）');
eq(Engine.settleGroup('piaosanye', [
  { id: 'small', hand: [SMALL, c('spade', 7), c('diamond', 7)] },
  { id: 'real', hand: [c('spade', 7), c('diamond', 7), c('club', 7)] }
]).winnerId, 'small', '小王 + 77 的豹子 > 真 777（王比任何真牌大）');
/* 反向：牌力不同时王不能翻盘 —— 小王 + 5♠5♦ 是对子，打不过真 777 豹子 */
eq(Engine.settleGroup('piaosanye', [
  { id: 'w', hand: [SMALL, c('spade', 5), c('diamond', 5)] },
  { id: 'r', hand: [c('spade', 7), c('diamond', 7), c('club', 7)] }
]).winnerId, 'r', '负向：小王凑的对子打不过真豹子（王不许越级）');

console.log('\n[5] 斗牛：王不参与比大小（构造局证明）');
eq(Engine.douNiuTypeName([BIG, SMALL, c('spade', 3), c('heart', 7), c('club', 9)]), '牛牛', '双王 + 三张真牌 = 牛牛');
/* 下面这对手牌**共用同一批真牌**（Q 10 3 2 两边各来一遍）—— 真实发牌写不出来，
 * 因为一副牌里每张牌只有一张。它存在的唯一目的是证明「王不参与比大小」：
 * 若王参与，大王手会凭 rank 15 赢；判 0 说明王被剔出了比较材料。
 * 真实牌局里的两手含王牛牛必然分得出胜负（最大牌不可能一样），
 * 见 douniu-tie-unreachable.test.js 的 20 万局抽样。 */
const niuSmall = [SMALL, c('spade', 12), c('heart', 10), c('club', 3), c('diamond', 2)];
const niuBig = [BIG, c('spade', 12), c('heart', 10), c('club', 3), c('diamond', 2)];
eq(Engine.compareDouNiu(niuSmall, niuBig), 0,
  '★ 共用同一批真牌的构造局判平 → 王被剔出比较材料（真实发牌不可达）');
eq(Engine.douNiuTypeName([SMALL, c('spade', 9), c('heart', 9), c('club', 2), c('diamond', 3)]), '牛牛',
  '单小王能补进剩下的两张凑牛牛');
/* 真牌更大的一方照样赢 —— 王不能替这手牌翻盘 */
ok(Engine.compareDouNiu(
  [c('spade', 13), c('heart', 10), c('club', 3), c('diamond', 2), c('spade', 5)],
  [SMALL, c('heart', 9), c('club', 3), c('diamond', 2), c('spade', 5)]
) > 0, '没有王的一手只要真牌更大就赢（王不参与）');

console.log('\n[6] 牌名与 AI 估值');
eq(Engine.cardLabel(BIG), '大王', 'cardLabel 大王');
eq(Engine.cardLabel(SMALL), '小王', 'cardLabel 小王');
const U = require('../js/gameUtils.js');
eq(U.cardText({ suit: 'joker', rank: 15 }), '大王', 'cardText 大王');
eq(U.cardText({ suit: 'joker', rank: 14.5 }), '小王', 'cardText 小王');
eq(U.cardText({ suit: 'spade', rank: 14 }), 'A♠', 'cardText 普通牌不受影响');
ok(/card\.rank >= 15 \? 13 : 12\.5/.test(aiSrc), 'AI 把小王估成 12.5（不是和大王等价的 13）');

console.log('\n[7] 源码守卫：别把「是不是王」写成只认大王');
/* 这是本次改动最重要的结构性约束：只要有一处写成 `rank === 15`，
 * 小王在那里就不是王了，而那种 bug 只在摸到小王时出现 —— 线上极难复现。 */
ok(!/rank === 15/.test(engineSrc.replace(/\/\*[\s\S]*?\*\//g, '')),
  'engine.js 里没有裸写 rank === 15 的判断（都应走 isJoker/isBigJoker）');
ok(/function isBigJoker/.test(engineSrc) && /function isSmallJoker/.test(engineSrc),
  'engine 同时导出大小王判定');
ok(/SMALL_JOKER_RANK/.test(cardSrc) && /deck\.push\(\{ suit: 'joker', rank: SMALL_JOKER_RANK \}\)/.test(cardSrc),
  'card.createDeck 真的把小王推进牌堆了');
/* 双王解析必须走组合枚举，不能复用「全换成同一张」的 replaceJoker */
ok(/JOKER_TENHALF_POINTS/.test(engineSrc), '十点半有双王点数集合');
ok(/jokerCount\(hand\) >= 2/.test(engineSrc), '斗牛有双王分支');

console.log('\n' + (fail === 0 ? '全部通过' : fail + ' 项失败') + ' —— ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail === 0 ? 0 : 1);
