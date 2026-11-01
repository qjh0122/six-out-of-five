/**
 * 结算页 ↔ 回放的「这一把」对齐（纯静态解析 + 抽函数求值，不开浏览器）
 * 跑法：node pwa/test/settle-replay.test.js
 *
 * 守的是两件在界面上「看起来都正常」的事：
 *
 * 1) **点结算页的一行，打开的是刚打完的这一把，不是整场第 1 把。**
 *    以前唯一的入口是底部那颗「回放」，它永远从第 1 把开始 —— 打满 9 把的人
 *    想确认「刚才那 3 组为什么这么算」，得自己往下滑 8 屏。
 *    定位失败时整场还是能打开、牌还是那些牌，所以这条错了不会报错，只会难用。
 *
 * 2) **一行里两个手势各归各的**：头像 = 看这个人，其余 = 看过程。
 *    以前整行都是「看档案」。改错成「整行都是回放」的话，想查人的点半天
 *    也进不去档案；改回「整行都是档案」，这次的改动就整个失效了 ——
 *    两种都不会崩，也都不会有人报 bug，只能靠这里钉住。
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

/* 取一个具名函数的源码（从 `function name(` 到下一个两格缩进的收尾大括号）。
 * game.js 全是 ES5 函数声明 + 两格缩进，这个足够稳。 */
function fnSrc(name) {
  const start = gameJs.indexOf('function ' + name + '(');
  if (start < 0) return '';
  const end = gameJs.indexOf('\n  }', start);
  return end < 0 ? '' : gameJs.slice(start, end + 4);
}

/* 把纯函数抠出来直接跑 —— 定位兜底这套逻辑只有 5 行，
 * 但它决定了「点一下到底落在第几把」，值得真跑一遍而不是靠正则。 */
function loadFn(name) {
  const src = fnSrc(name);
  if (!src) return null;
  try { return new Function('return (' + src + ')')(); } catch (e) { return null; }
}

/* ---------- 1. 结算行结构：每行都是头像 + 名次 ---------- */
console.log('\n[1] 结算行（结算页与「上一局结算」共用 settleListEl）');
const settleList = fnSrc('settleListEl');
ok(!!settleList, '有 settleListEl');
ok(/var rank = el\('div', 'settle-rank'/.test(settleList),
  '★ 每一行都渲染头像容器（不再只有冠军有）');
ok(/avatarInner\(p\.id, p\.avatar/.test(settleList),
  '★ 头像走 avatarInner（和牌桌座位、档案卡同一套）');
ok(/champion-rank/.test(settleList) && /settle-pos/.test(settleList),
  '★ 第 1 名挂皇冠、第 2 名起挂数字角标');
ok(/'settle-pos' \+ \(r\.tied \? ' is-tie' : ''\), String\(r\.rank\)/.test(settleList),
  '★ 角标数字 = 名次（r.rank，并列两人一样），不是列表序号');
/* v104：名次来自 settleRank，**不能再用 i + 1** —— 弃局者沉到末尾后，
 * 「第几行」和「第几名」是两件事：第 4 行可能是「已离开」，第 3 名还没出现。 */
ok(!/String\(i \+ 1\)/.test(settleList),
  '★ 列表序号不再被当成名次（弃局者沉底后 i+1 会撒谎）');
ok(/if \(r\.champion\) \{[\s\S]{0,80}crown/.test(settleList)
  && /else if \(r\.abandoned\) \{[\s\S]{0,300}'settle-pos is-out', '—'/.test(settleList),
  '皇冠与角标互斥（冠军不再多一个「1」，弃局者给「—」）');
ok(/row\.appendChild\(el\('span', 'settle-go', '›'\)\)/.test(settleList),
  '★ 每行有「可点」的箭头提示');

/* ---------- 2. 行的可点性对键盘也成立 ---------- */
console.log('\n[2] 无障碍：头像是个能聚焦的按钮');
ok(/rank\.setAttribute\('role', 'button'\)/.test(settleList), '头像 role=button');
ok(/rank\.setAttribute\('tabindex', '0'\)/.test(settleList), '头像 tabindex=0（能 Tab 到）');
/* v104：名次文案改由 rankText 拼（名次 / 并列第 1 名 / 已离开，不计名次）。
 * 守的还是同一件事：读屏用户看不到角标和皇冠，只能靠这句话知道自己是第几。 */
ok(/var rankText;[\s\S]{0,260}rankText \+ ' ' \+ \(p\.nickname/.test(settleList),
  '★ aria-label 由 rankText 拼成（含名次 + 名字）');
ok(/'第 ' \+ r\.rank \+ ' 名'/.test(settleList) && /'并列第 1 名'/.test(settleList),
  '名次文案取 r.rank，并列第一单独念「并列第 1 名」');
ok(/body\.addEventListener\('keydown'/.test(gameJs) && /e\.key !== 'Enter' && e\.key !== ' '/.test(gameJs),
  '★ 回车/空格等价于点头像');
ok(/e\.preventDefault\(\);   \/\/ 空格不滚屏/.test(gameJs), '空格被拦住（不然按一下页面滚走）');

/* ---------- 3. 定位到「这一把」 ---------- */
console.log('\n[3] 点结算行 → 打开的是这一把');
const openHere = fnSrc('openReplayHere');
ok(!!openHere, '有 openReplayHere');
ok(/targetHand: room\.handId \|\| room\.handCount \|\| 0/.test(openHere),
  '★ 用 handId 定位（dealAll 里递增，不受重启影响）');
ok(/if \(!packs\.length\) \{ flash\(/.test(openHere),
  '★ 一盘过程都没留下时明说，不开空弹窗（空弹窗会被当成加载失败）');
ok(!/openReplay\(\{ prev: true/.test(openHere),
  '结算页上写「这一局」，不写「上一局」（这一局刚打完）');

const openReplay = fnSrc('openReplay');
ok(!!openReplay, '有 openReplay');
ok(/replayTargetOf\(packs, \(opts && opts\.targetHand\) \|\| 0\)/.test(openReplay),
  '★ openReplay 接受 targetHand');
ok(/renderReplay\(packs, \{ targetHand: target \}\)/.test(openReplay),
  '★ 目标传给 renderReplay（高亮 + 定位都靠它）');
ok(/replayTargetOf\(again, target\)/.test(openReplay),
  '★ 清理过程记录后重画仍保留目标（否则清理完停在整场开头）');

/* 定位兜底：真跑 */
console.log('\n[4] 定位兜底（replayTargetOf 真跑）');
const targetOf = loadFn('replayTargetOf');
ok(typeof targetOf === 'function', 'replayTargetOf 可独立求值');
if (typeof targetOf === 'function') {
  const packs = [{ hands: 3 }, { hands: 4 }, { hands: 5 }];
  ok(targetOf(packs, 4) === 4, '★ 第 4 把在 → 定位第 4 把');
  ok(targetOf(packs, 5) === 5, '最后一把也能定位');
  ok(targetOf(packs, 9) === 5,
    '★ 找不到（别人抢先开了下一把 / 历史被裁）→ 退回最后一把，而不是停在整场开头');
  ok(targetOf(packs, 0) === 0, '没给目标 → 0（行为和改造前一致：不定位不滚）');
  ok(targetOf([], 3) === 0, '没有过程数据 → 0（由 openReplayHere 提前拦掉）');
  ok(targetOf(null, 3) === 0, 'packs 为 null 不抛');
  ok(targetOf([{ hands: 0 }], 7) === 0, '最后一个 pack 没有 hands 也不给脏目标');
}

/* ---------- 5. 两个入口读的是同一份数据 ---------- */
console.log('\n[5] 数据同源（不许各读一遍）');
ok(/function replayPacksOf\(room\)/.test(gameJs), '有 replayPacksOf');
const packsOf = fnSrc('replayPacksOf');
ok(/SessionLog\.load\(SessionLog\.keyOf\(room\)\)/.test(packsOf), '整场档案优先');
ok(/packHistory\(\(room && room\.history\) \|\| \[\]\)/.test(packsOf), '退回服务端滚动窗口');
ok((gameJs.match(/packHistory\(\(room && room\.history\)/g) || []).length === 1,
  '★ packHistory 的回落只在 replayPacksOf 里写一次（两处各写一遍迟早不一致）',
  '出现次数 ' + (gameJs.match(/packHistory\(\(room && room\.history\)/g) || []).length);

/* ---------- 6. 点击分工 ---------- */
console.log('\n[6] 一行里两个手势各归各的');
ok(/bindSettleRowTap\('#settle-body'\)/.test(gameJs) && /bindSettleRowTap\('#prev-result-body'\)/.test(gameJs),
  '★ 结算页和「上一局结算」弹窗共用同一个绑定函数');
const tapSrc = fnSrc('bindSettleRowTap');
ok(!!tapSrc, '有 bindSettleRowTap');
ok(/var rank = e\.target\.closest\('\.settle-rank'\)/.test(tapSrc),
  '★ 先判头像（顺序不能反：先判行就永远进不了档案）');
ok(/if \(rank && row\.dataset\.pid\) \{ openProfile\(row\.dataset\.pid\); return; \}/.test(tapSrc),
  '★ 头像 → 玩家档案');
ok(/openReplayHere\(\);/.test(tapSrc), '★ 行的其他地方 → 这一把的回放');
/* 同一个 body 上不许再有一条只做 openProfile 的旧监听：
 * 两条都挂上时头像会连开两次档案（第二次把第一次的滚动位置重置）。 */
ok((gameJs.match(/\$\('#prev-result-body'\)\.addEventListener/g) || []).length === 0,
  '★ 旧的 #prev-result-body 单独监听已删（否则头像会连开两次档案）');

/* ---------- 7. 样式 ---------- */
console.log('\n[7] 样式');
const goCss = /\.settle-go \{([\s\S]*?)\}/.exec(css);
ok(!!goCss, '有 .settle-go');
if (goCss) {
  ok(/position: absolute/.test(goCss[1]),
    '★ 箭头绝对定位（塞进 grid 会多一列，名字列被挤窄）');
  ok(/pointer-events: none/.test(goCss[1]),
    '★ 箭头不吃点击（不然正对着它点会「什么都没发生」）');
}
ok(/\.settle-row \{[\s\S]{0,700}?position: relative/.test(css),
  '★ .settle-row 是定位基准（否则箭头会跑到视口边上）');
const posCss = /\.settle-pos \{([\s\S]*?)\}/.exec(css);
ok(!!posCss, '有 .settle-pos');
if (posCss) {
  ok(/position: absolute/.test(posCss[1]) && /left:/.test(posCss[1]) && /bottom:/.test(posCss[1]),
    '角标挂在头像左下角（皇冠占了上面那个角）');
  ok(/background: rgba\(26, 29, 35/.test(posCss[1]),
    '★ 角标用深底白字：结算页是墨绿、上一局弹窗是暖白纸，只有这一档在两种底上都读得清');
  ok(!/color: var\(--gold\)/.test(posCss[1]),
    '★ 角标不用金色（金色落在暖白纸上约 1.5:1，等于没写）');
}
ok(/\.settle-rank \{[\s\S]{0,900}?border: 2px solid/.test(css),
  '头像有描边（和牌桌座位、档案卡同一圈）');
ok(/\.prev-result-body \.settle-row:not\(\.champion\) \.settle-go \{ color: rgba\(26, 29, 35/.test(css),
  '★ 浅底上的箭头换成墨色（白色 28% 在暖白纸上 1.05:1，等于没有）');
ok(/\.prev-result-body \.settle-rank \{ border-color: rgba\(26, 29, 35/.test(css),
  '★ 浅底上的头像描边也换成墨色');
ok(/@media \(hover: hover\) \{[\s\S]{0,300}?\.settle-row:hover/.test(css),
  '悬停反馈只在有 hover 的设备上（触摸屏 :hover 会粘住不散）');

/* ---------- 8. 回放层本身没被改坏 ---------- */
console.log('\n[8] 回放弹窗（原有能力不回退）');
ok(/class="replay-pack' \+ \(isTarget \? ' is-target' : ''\)/.test(gameJs),
  '目标那一把仍会带 is-target 高亮');
ok(/你点的这把/.test(gameJs), '高亮那把有「你点的这把」文字标记');
ok(/function scrollReplayToTarget/.test(gameJs), '保留滚动定位');
ok(/if \(!hit\) return;/.test(gameJs), '定位不到就不滚（不报错、不跳到顶上）');

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
