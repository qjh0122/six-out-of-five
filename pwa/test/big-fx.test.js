/**
 * 牌型特写（v83 R5）—— 触发条件与降级
 * 跑法：node test/big-fx.test.js
 *
 * 探针（scripts/probe-big-fx.js）证明的是「特效画得出来」，
 * 这里证明的是「该不该画」—— 两件事缺一条都会翻车：
 *
 *   · 只会画、判错牌型 → 牛 9 赢了放牛牛特写（原型里真实发生过，随机 800 组里 18.5%）；
 *   · 只判对、画不出来 → 代码全绿，屏幕上什么都没有。
 */
'use strict';

const { readAll: readGameAll } = require('./helpers/gameSource');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const game = readGameAll();
const css = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');
const Engine = require(path.join(ROOT, 'js', 'engine.js'));
const SM = require(path.join(ROOT, 'js', 'stateMachine.js'));

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function head(t) { console.log('\n' + t); }
function c(suit, rank) { return { suit: suit, rank: rank }; }

/* 从源码里把 BIG_FX 求值出来。
 * 为什么不用「再写一份 map 做对照」：那等于允许两份配置同时存在，
 * 而「两处配置」这个仓库已经咬过两次（hub.js 私抄 MAX_PLAYERS、原型手抄 engine.js）。 */
/* ★ 结尾花括号的缩进用 \s* 匹配：BIG_FX 现在住在 js/cardView.js 的
 * factory 里（4 空格缩进），而这段正则原来写死了 2 空格。
 * 缩进是实现细节，不是这条守卫要守的东西（它守的是「键集合与 BIG_TYPES 一致」）。 */
function readBigFx() {
  const m = game.match(/var BIG_FX = \{([\s\S]*?)\n\s*\};/);
  if (!m) return null;
  try {
    return new Function('return {' + m[1] + '\n}')();
  } catch (e) { return null; }
}
function readBigTypes() {
  const m = game.match(/var BIG_TYPES = \[([^\]]*)\];/);
  if (!m) return null;
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

const BIG_FX = readBigFx();
const BIG_TYPES = readBigTypes();

head('[1] 名单对得上');
{
  ok(!!BIG_FX, '能从 game.js 里取出 BIG_FX');
  ok(!!BIG_TYPES, '能取出 BIG_TYPES');
  const fxKeys = Object.keys(BIG_FX || {}).sort();
  const typeKeys = (BIG_TYPES || []).slice().sort();
  ok(JSON.stringify(fxKeys) === JSON.stringify(typeKeys),
    '★ BIG_FX 的键与 BIG_TYPES 完全一致（少一个 = 少一段动画，多一个 = 死代码）',
    'fx=' + fxKeys.join('/') + ' types=' + typeKeys.join('/'));

  Object.keys(BIG_FX || {}).forEach((k) => {
    const it = BIG_FX[k];
    ok(/^#[0-9A-F]{6}$/i.test(it.color), k + ' 的粒子色是 6 位十六进制（' + it.color + '）');
    ok(/^rgba\(/.test(it.ring), k + ' 的光晕是半透明 rgba（' + it.ring + '）');
    ok(/^[a-z]{2}$/.test(it.kind), k + ' 的 kind 是两位短码（' + it.kind + '）');
  });
}

head('[2] 每个键都是引擎真的会输出的名字');
{
  /* 这一组是「规则只该有一份实现」的落脚点：
   * 名字全部由 Engine.typeName 产出，测试只负责造出手牌。 */
  const samples = [
    { mode: 'piaosanye', hand: [c('spade', 8), c('heart', 8), c('club', 8)], want: '豹子' },
    { mode: 'piaosanye', hand: [c('heart', 5), c('heart', 6), c('heart', 7)], want: '同花顺' },
    { mode: 'douniu', hand: [c('spade', 10), c('heart', 6), c('club', 4), c('diamond', 8), c('spade', 2)], want: '牛牛' },
    { mode: 'douniu', hand: [c('club', 11), c('club', 12), c('club', 13), c('heart', 11), c('heart', 12)], want: '五花牛' },
    { mode: 'tenhalf', hand: [c('spade', 10), c('heart', 13)], want: '10.5点' }
  ];
  samples.forEach((s) => {
    const name = Engine.typeName(s.mode, s.hand);
    ok(name === s.want, s.mode + ' 的样例输出「' + s.want + '」（引擎给的是「' + name + '」）');
    ok(!!(BIG_FX || {})[name], '★「' + name + '」在特效名单里（否则这一手没有特写）');
  });

  /* 反例：牛 9 不能放牛牛特写 —— 原型里那条 18.5% 的错就是这么来的 */
  const niu9 = [c('spade', 10), c('heart', 6), c('club', 3), c('diamond', 8), c('spade', 2)];
  const niu9name = Engine.typeName('douniu', niu9);
  ok(niu9name !== '牛牛', '牛 9 的名字不是牛牛（' + niu9name + '）');
  ok(!(BIG_FX || {})[niu9name] || niu9name === '牛牛', '牛 9 不会误触牛牛特写');
}

head('[3] 只看赢家的牌型，不看「这组里有特殊牌」');
{
  ok(/BIG_FX\[g\.winnerTypeName\]/.test(game), '用 g.winnerTypeName 查表（引擎输出的名字）');
  ok(game.indexOf('specialOf') === -1, '没有另起一套牌型判定（那是第二份规则实现）');
  ok(/var big = BIG_FX\[g\.winnerTypeName\] \|\| null;/.test(game), '查不到就是 null，不抛错');
  /* 一局要结算 3~5 次，每次放两三个特写就没法看了 */
  ok(/只有「赢家的牌型属于这几种」才放/.test(game), '注释写明了「只对赢家」这个前提');
}

head('[4] DOM：类名、粒子、错峰');
{
  ok(/div\.classList\.add\('is-big'\)/.test(game), '命中时给这一组挂 is-big');
  ok(/el\('div', 'fx-burst'\)/.test(game), '建了粒子容器');
  ok(/for \(var bi = 0; bi < 12; bi\+\+\)/.test(game), '12 颗粒子');
  ok(/bi \* 30/.test(game), '12 个角度均分 360°');
  ok(/var burstAt = gi \* 0\.35 \+ 0\.18;/.test(game),
    '★ 粒子延迟把「逐组错峰」算进去了（不算的话第 3 组在屏幕外就炸完了）');
  ok(/Sfx\.play\('win', 1\.12\)/.test(game), '大牌型有独立音高（不新增音源）');
  /* 降级：名字在名单里但没映射时，横幅还得在 */
  ok(/else if \(BIG_TYPES\.indexOf\(g\.winnerTypeName\) >= 0\)/.test(game),
    '★ 有名单没映射的新牌型仍然画静态横幅（不会整段消失）');
}

head('[5] CSS：动画真的存在，且横屏收窄');
{
  ok(/\.result-group\.is-big \{/.test(css), '有 is-big 的边框/发光样式');
  ok(/@keyframes fxHalo/.test(css), '有光晕动画');
  ok(/@keyframes fxBurst/.test(css), '有粒子动画');
  ok(/@keyframes fxBurstTight/.test(css), '有横屏收窄版本');
  ok(/\.ls \.fx-pt \{\s*animation-name: fxBurstTight/.test(css), '横屏（.ls）真的切到收窄版');
  ok(/animation-delay: var\(--d, 0s\)/.test(css), '粒子延迟读 --d');
  ok(/background: var\(--fx-color/.test(css), '粒子色来自 --fx-color（不在 CSS 里硬编码牌型色）');
  /* 浅底可见性：6px 太小、浅金在暖白底上看不见 */
  ok(/width: 10px;[\s\S]{0,40}height: 10px;/.test(css), '粒子 10 设计 px（6px 在手机上只有 3 CSS px）');
}

head('[6] 组数不全时要说「哪些组没进行」（v103 起只为老数据兜底）');
{
  /* ★ v103：结算一定把本轮所有组算完，skipped 恒为 0，这段在日常对局里走不到。
   * 留着是为了老战绩回放 —— 服务端存的历史 groups 可能真的是短的。
   * 文案同步改成中性：不再指名「有人见底」（那条规则已经删了，说它等于撒谎）。 */
  ok(/本轮剩下 ' \+ skipped \+ ' 组没有进行/.test(game), '有「剩下 N 组没有进行」那句');
  ok(game.indexOf('有人见底，本轮剩下') < 0, '★ 文案里不再指名「有人见底」（规则已删）');
  ok(/\(StateMachine\.ROUND_GROUPS \|\| \{\}\)\[result\.round\]/.test(game), '组总数从状态机读，不写死 3/2');
  /* v118（C-3b）：标记从两种变成三种 —— 弃局（人走了）/ 旁听（在房间里但没打这一局）/
   * 见底（老的 out 标记，只为老战绩回放保留）。三者互斥，顺序不能反：
   * benched 的人 left 恒为 false，但 out 可能还是老的 true，先判旁听才是真相。 */
  ok(/p\.left \? '（弃局）' : \(r\.benched \? '（旁听）' : \(p\.out \? '（见底）' : ''\)\)/.test(game),
    '结账页区分弃局 / 旁听 / 见底三个标记（见底是给老数据留的）');
  ok(/\.result-abort-note \{/.test(css), '这句说明有独立样式（不然挤在卡片堆里像漏字）');

  /* 状态机侧的字段：少了它前端就没有依据判断「该不该说这句」 */
  const room = SM.newRoom('600001', { id: 'z', nickname: '丙', ready: false, left: false, connected: true });
  ok(Array.isArray(room.bustedIds) && room.bustedIds.length === 0, '新房间 bustedIds 是空数组（不是 undefined）');
  ok(room.groupsDone === 0, '新房间 groupsDone = 0');
}

head('[7] 减弱动态效果时不能还在炸');
{
  /* 全局那条 media query 已经把所有动画压到 0.01ms，
   * 这里只确认它仍然存在 —— 它被删掉的话，整套特效会变成「无法关闭」的动效。 */
  ok(/@media \(prefers-reduced-motion: reduce\)/.test(css), '有 reduced-motion 兜底');
  ok(/animation-duration: 0\.01ms !important/.test(css), '把动画时长压到 0.01ms（不是 none，收尾事件仍会触发）');
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
