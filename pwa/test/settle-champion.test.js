/**
 * 结算页排名与冠军口径（v104）
 * 跑法：node pwa/test/settle-champion.test.js
 *
 * 守的是两条口径，它们都属于「界面上看着没事、但答案错了」：
 *   ① 中途弃局的人分数在离开那一刻冻结，可能仍是全场最高 ——
 *      老写法直接按分数取首行，于是**走了的人戴皇冠**。
 *   ② 同分时 Array.sort 是稳定的，于是并列第一按**入座顺序**取胜者 ——
 *      同分不同座位，冠军是不同的人，而界面一个字都没说这是并列。
 *
 * 测法：settleRank 是纯函数，直接从 game.js 里取出来单跑（与 render-guards 同一套做法）。
 * 只做静态 grep 是不够的 —— 「排序对不对」只能靠真喂数据。
 */
'use strict';

const { readAll: readGameAll } = require('./helpers/gameSource');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const gameJs = readGameAll();
const css = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

/* 取整个函数声明（含 body），靠大括号配平 —— 比「找下一个 \n  }」稳：
 * 这个函数里有 forEach 回调，回调的收尾大括号也是两格缩进。 */
function fnSrc(name) {
  const start = gameJs.indexOf('function ' + name + '(');
  if (start < 0) return '';
  let i = gameJs.indexOf('{', start), depth = 0;
  for (; i < gameJs.length; i++) {
    if (gameJs[i] === '{') depth++;
    else if (gameJs[i] === '}') { depth--; if (depth === 0) return gameJs.slice(start, i + 1); }
  }
  return '';
}

const src = fnSrc('settleRank');
ok(!!src, 'game.js 里有 settleRank（排名口径只写一处，两个渲染点共用）');
const settleRank = src ? new Function('return (' + src + ')')() : function () { return []; };

/* 造人：只有结算排名用得到的字段 */
function P(id, score, opts) {
  const p = { id: id, nickname: id, score: score };
  if (opts && opts.left) p.left = true;
  if (opts && opts.isBot) p.isBot = true;
  return p;
}

/* ---------- 1. 正常局：名次就是分数顺序 ---------- */
console.log('\n[1] 全员打完');
{
  const rows = settleRank([P('甲', 20), P('乙', 40), P('丙', 30)]);
  ok(rows.map(r => r.p.id).join(',') === '乙,丙,甲', '按分数降序排：乙40 > 丙30 > 甲20', rows.map(r => r.p.id).join(','));
  ok(rows.map(r => r.rank).join(',') === '1,2,3', '名次 1/2/3');
  ok(rows.filter(r => r.champion).length === 1 && rows[0].champion, '冠军只有一个，且是分数最高的那位');
  ok(rows.every(r => r.abandoned === false), '没人弃局时 abandoned 全 false');
}

/* ---------- 2. 弃局者：不参评、沉底 ---------- */
console.log('\n[2] 有人中途弃局（分数冻结，可能仍然最高）');
{
  const rows = settleRank([P('甲', 40, { left: true }), P('乙', 30), P('丙', 10)]);
  ok(rows[0].p.id === '乙', '★ 冠军是打完的乙（30 分），不是走了的甲（40 分）', rows[0].p.id);
  ok(rows[rows.length - 1].p.id === '甲', '★ 弃局者沉到列表末尾');
  const a = rows.find(r => r.p.id === '甲');
  ok(a.rank === 0, '弃局者 rank = 0（不占名次）');
  ok(a.champion === false, '弃局者不可能是冠军');
  ok(a.abandoned === true, 'abandoned = true（渲染据此给「—」角标 + 压暗）');
  ok(rows.filter(r => r.champion).length === 1, '冠军仍然只有一个');
  ok(rows.find(r => r.p.id === '乙').rank === 1, '★ 弃局者不占位：第一名仍然是 1');
  ok(rows.find(r => r.p.id === '丙').rank === 2, '后一名是 2 而不是 3（名次里没有弃局者的位置）');
}

console.log('\n[2b] 多个弃局者之间也按分数降序');
{
  const rows = settleRank([P('甲', 25, { left: true }), P('乙', 30), P('丙', 40, { left: true })]);
  const goneIds = rows.filter(r => r.abandoned).map(r => r.p.id).join(',');
  ok(goneIds === '丙,甲', '弃局者内部按分数降序（丙40 在 甲25 前）', goneIds);
  ok(rows.filter(r => r.rank === 0).length === 2, '两个弃局者都 rank 0');
}

/* ---------- 3. 同分并列 ---------- */
console.log('\n[3] 同分并列（同分不同座位不能决定冠军）');
{
  const rows = settleRank([P('甲', 35), P('乙', 35), P('丙', 20)]);
  ok(rows.filter(r => r.champion).length === 2, '★ 并列第一两人都算冠军');
  ok(rows[0].rank === 1 && rows[1].rank === 1, '两人 rank 都是 1');
  ok(rows[2].rank === 3, '★ 第三名的名次是 3（竞赛式排名 1,1,3），不是 2');
  ok(rows[0].tied && rows[1].tied, '并列的两人 tied = true（角标加「=」）');
  ok(rows[2].tied === false, '没并列的人 tied = false');
}

console.log('\n[3b] 并列不在第一名也要标出来');
{
  const rows = settleRank([P('甲', 50), P('乙', 20), P('丙', 20)]);
  ok(rows[0].tied === false, '冠军没并列 → tied false');
  ok(rows[1].tied && rows[2].tied && rows[1].rank === 2 && rows[2].rank === 2,
    '第二、三名并列 → 都是 rank 2、都 tied');
}

console.log('\n[3c] 全员同分');
{
  const rows = settleRank([P('甲', 20), P('乙', 20), P('丙', 20)]);
  ok(rows.every(r => r.rank === 1), '三个人都 rank 1');
  ok(rows.filter(r => r.champion).length === 3, '三个人都是冠军（并列第一）');
}

/* ---------- 4. 边界 ---------- */
console.log('\n[4] 边界');
{
  const rows = settleRank([P('甲', 40, { left: true }), P('乙', 30, { left: true })]);
  ok(rows.every(r => r.rank === 0) && rows.filter(r => r.champion).length === 0,
    '★ 全员弃局 → 一个冠军都没有（不能给走了的人发皇冠）');

  const one = settleRank([P('甲', 12)]);
  ok(one.length === 1 && one[0].rank === 1 && one[0].champion, '单人局：他就是冠军');

  const neg = settleRank([P('甲', -10), P('乙', -3)]);
  ok(neg[0].p.id === '乙' && neg[0].rank === 1, 'v103 起分数可以为负 → -3 排在 -10 前面', neg[0].p.id);
  ok(neg[1].rank === 2, '负分也能正常给名次');

  const zero = settleRank([P('甲', 0), P('乙', 0), P('丙', -5)]);
  ok(zero[0].rank === 1 && zero[1].rank === 1 && zero[2].rank === 3,
    '0 分并列照常（prevScore 不能拿 0 当「还没有上一名」）');
}

console.log('\n[4b] 不改入参');
{
  const players = [P('甲', 10), P('乙', 30), P('丙', 20)];
  const before = players.map(p => p.id).join(',');
  settleRank(players);
  ok(players.map(p => p.id).join(',') === before, '原数组顺序不变（内部先 filter 再 sort，不就地排原数组）');
  ok(players.every(p => p.rank === undefined), '不给原对象挂 rank（渲染读的是包装对象）');
}

/* ---------- 5. 渲染层：口径必须真的被用上 ---------- */
console.log('\n[5] 渲染层接线');
{
  const start = gameJs.indexOf('function settleListEl(');
  const body = gameJs.slice(start, gameJs.indexOf('\n  /* 结算尾注拆成两段', start));
  ok(/var rows = settleRank\(room\.players\)/.test(body), 'settleListEl 用 settleRank 拿排名');
  ok(!/room\.players\.slice\(\)\.sort/.test(body), '★ 渲染层不再自己排序（两份排序迟早跑偏）');
  ok((body.match(/classList\.add\('champion'\)/g) || []).length === 1,
    'champion 判定仍然只有一处');
  ok(/if \(r\.champion\) row\.classList\.add\('champion'\)/.test(body),
    '★ 冠军由 rank === 1 决定，不再看「是不是第一行」');
  ok(!/i === 0\) \{[\s\S]{0,40}crown/.test(body), '皇冠不再挂在「第 0 行」上');
  ok(/r\.abandoned.*settle-pos is-out.*—/s.test(body) || /is-out', '—'/.test(body),
    '弃局者的角标是「—」而不是数字');
  ok(/settle-pos' \+ \(r\.tied \? ' is-tie' : ''\)/.test(body), '并列角标由 r.tied 决定');
  ok(/championCount > 1/.test(body), '并列冠军靠 championCount 判（不是猜）');
  ok(/settle-tie', '并列'/.test(body), '并列冠军挂「并列」胶囊');
  ok(/并列第 1 名/.test(body), 'aria 念「并列第 1 名」（读屏用户看不到皇冠）');
  ok(/已离开，不计名次/.test(body), '弃局者的 aria 明说「不计名次」');
  ok(/String\(r\.rank\)/.test(body), '角标数字取 r.rank（并列时两人一样）');
}

console.log('\n[6] 样式');
{
  ok(/\.settle-row\.is-abandoned \{[^}]*opacity/.test(css), '弃局行压暗（否则会被读成「垫底」）');
  ok(/\.settle-rank\.is-gone \{/.test(css), '弃局者头像圈换成中性色（金色 = 冠军/名次）');
  ok(/\.settle-pos\.is-out \{/.test(css), '「—」角标有自己的底色');
  ok(/\.settle-pos\.is-tie::before \{ content: '='/.test(css), '并列角标用「=」前缀');
  ok(/\.settle-tie \{[^}]*border-radius: 999px/.test(css), '「并列」胶囊与「我」胶囊同一套圆角');
}

console.log('\n————————————————————————————');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
