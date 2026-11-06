/**
 * 结账原因只有一个权威源（v130）
 *
 * 背景：`'handLimit' / 'someoneLeft' / 'dissolve' / 'scoreZero'` 这四个字符串
 * 以前以字面量散在五处 —— 状态机、`hub.js` 的 meta 白名单、`settleView` 的文案分支、
 * `historyKit` 的校验、`recordsView` 的中文映射表。
 *
 * 改一条规则要改五处，漏一处就会出现「界面说打满、记录说提前」，
 * 而**没有任何测试会红** —— 玩家读到的字，全仓零守卫。
 *
 * 这条守卫不假装把五处都干掉了（那是一次大重构），它钉的是更小的事：
 * **任何地方出现的这四个值，必须都来自 `END_REASON`**；谁写了一个不在表里的新值 → 红。
 * 再加上服务端与探针两条：服务端不许再写字面量，探针必须读常量。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const JSDIR = path.join(ROOT, 'pwa', 'js');

let pass = 0, fail = 0;
function ok(c, m, extra) {
  if (c) { pass++; console.log('  ✓ ' + m); }
  else { fail++; console.log('  ✗ ' + m + (extra !== undefined ? '  ← ' + extra : '')); }
}
function eq(a, b, m, extra) {
  ok(a === b, m, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b) + (extra ? '  |  ' + extra : ''));
}
function head(t) { console.log('\n' + t); }

const SM = require(path.join(JSDIR, 'stateMachine.js'));
const R = SM.END_REASON || {};
const VALUES = SM.END_REASON_VALUES || [];

function read(p) { return fs.readFileSync(p, 'utf8'); }

/* 把注释抹成等长空格再判断：注释里写「以前这里是 endReason='scoreZero'」是在解释历史，
 * 不是违规。不抹的话守卫会去罚一句解释 —— 而这个仓库已经在「注释骗过守卫」上吃过两次亏。 */
function codeOf(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, function (m) { return m.replace(/[^\n]/g, ' '); })
    .replace(/(^|[^:])\/\/[^\n]*/g, function (m, p1) { return p1 + m.slice(p1.length).replace(/[^\n]/g, ' '); });
}
function jsFiles() { return fs.readdirSync(JSDIR).filter((f) => /\.js$/.test(f)); }

/* =================== [1] 常量本身 =================== */
head('[1] END_REASON 的形状');
{
  eq(Object.keys(R).sort().join(','), 'DISSOLVE,HAND_LIMIT,SCORE_ZERO,SOMEONE_LEFT',
    '四个键齐全（少一个说明有人删了原因）');
  /* 值是对外契约：老战绩里存着这些字符串，改了就读不出来了 */
  eq(R.SCORE_ZERO, 'scoreZero', 'scoreZero 的值不许变（老战绩里存着它）');
  eq(R.SOMEONE_LEFT, 'someoneLeft', 'someoneLeft 的值不许变');
  eq(R.DISSOLVE, 'dissolve', 'dissolve 的值不许变');
  eq(R.HAND_LIMIT, 'handLimit', 'handLimit 的值不许变');
  /* 值列表必须与对象一致 —— 服务端白名单靠它，不一致会静默吞掉某个原因 */
  eq(VALUES.slice().sort().join(','), [R.SCORE_ZERO, R.SOMEONE_LEFT, R.DISSOLVE, R.HAND_LIMIT].sort().join(','),
    '★ END_REASON_VALUES 与对象一致（不一致时服务端会静默把某个原因换成 dissolve）');
}

/* =================== [2] 状态机自己不许再写裸字面量 =================== */
head('[2] 状态机内部');
{
  const src = codeOf(read(path.join(JSDIR, 'stateMachine.js')));
  const bare = (src.match(/endReason\s*=\s*'(handLimit|someoneLeft|dissolve|scoreZero)'/g) || []);
  eq(bare.length, 0, '★ 状态机里没有 `endReason = \'字面量\'`（全部走 END_REASON）', bare.join(','));
  ok(/END_REASON:\s*END_REASON/.test(src), 'END_REASON 已导出（服务端与探针都要用）');
}

/* =================== [3] 服务端不许写字面量 =================== */
head('[3] 服务端白名单');
{
  const src = read(path.join(ROOT, 'server', 'hub.js'));
  const hits = (src.match(/'(handLimit|someoneLeft|dissolve|scoreZero)'/g) || []);
  eq(hits.length, 0, '★ hub.js 里没有这四个字面量（白名单改读 SM.END_REASON_VALUES）', hits.join(','));
  ok(/SM\.END_REASON_VALUES\.indexOf/.test(src), 'hub 用的是值列表，不是抄一遍');
}

/* =================== [4] 视图层：出现即必须来自常量（漂移检测） =================== */
head('[4] pwa/js 其余文件 —— 字面量必须是表里的值');
{
  /* 这条不是「不许写」，而是「写了必须对」：
   * 视图层还在用字面量比较（改写它们的风险高于收益），但任何人**新增**一个
   * 不在 END_REASON 里的原因、或改了常量却漏改视图，都会在这里红。 */
  const allowed = VALUES;
  const offenders = [];
  let seen = 0;
  for (const f of jsFiles()) {
    if (f === 'stateMachine.js') continue;
    const src = codeOf(read(path.join(JSDIR, f)));
    const re = /'(scoreZero|someoneLeft|dissolve|handLimit)'/g;
    let m;
    while ((m = re.exec(src))) {
      seen += 1;
      if (allowed.indexOf(m[1]) < 0) offenders.push(f + ':' + m[1]);
    }
  }
  ok(seen >= 8, 'pwa/js 里共出现 ' + seen + ' 处结账原因字面量（少于 8 说明扫描坏了）');
  eq(offenders.length, 0, '★ 没有一处用到 END_REASON 之外的值', offenders.join(','));
}

/* =================== [5] 中文文案必须覆盖每一个原因 =================== */
head('[5] 文案覆盖');
{
  /* 新增一个原因却忘了加中文 → 界面显示兜底「已结束」，不报错、没人发现。
   * 这条盯的就是「新增原因」这个动作。 */
  const src = read(path.join(JSDIR, 'recordsView.js'));
  const missing = VALUES.filter((v) => src.indexOf(v) < 0);
  eq(missing.length, 0, '★ recordsView 的文案表覆盖了所有原因', missing.join(','));
}

/* =================== [6] 探针必须读常量，不许抄 =================== */
head('[6] 探针侧');
{
  const files = ['probe-ten-hands.js', 'probe-handlimit-settle.js'];
  for (const f of files) {
    const p = path.join(ROOT, 'scripts', f);
    if (!fs.existsSync(p)) { ok(false, f + ' 不存在'); continue; }
    const src = codeOf(read(p));
    ok(/StateMachine\.END_REASON|END_REASON\.HAND_LIMIT/.test(src),
      '★ ' + f + ' 读的是 END_REASON 常量（抄字面量就成了第六处）');
    const bare = (src.match(/===\s*'(handLimit|someoneLeft|dissolve|scoreZero)'/g) || []);
    eq(bare.length, 0, '★ ' + f + ' 里没有裸字面量比较', bare.join(','));
  }
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
