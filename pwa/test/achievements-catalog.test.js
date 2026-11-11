/**
 * 成就目录的结构守卫（node pwa/test/achievements-catalog.test.js）
 *
 * 这个文件只回答一个问题：**CATALOG 里每条成就读的键，是不是真的存在？**
 *
 * 为什么必须有它：
 *
 *   成就的计数走两道白名单 —— `COUNT_KEYS`（数字键）和 `TYPE_KEY_KNOWN`（牌型短键）。
 *   `mergeInto` 只认白名单里的键，认不到的**静默丢弃**，不抛错、不告警。
 *   于是「新增一条成就但忘了把新计数登记进 COUNT_KEYS」的结果是：
 *   那条成就永远是 0，测试全绿，线上也看不出异常，直到有人手工核对才发现。
 *
 *   这不是假想：v112 加小牌对撞时，就靠一条「点名校验这七个新字段」的人肉清单兜底，
 *   而那份清单只覆盖那一次新增的键，覆盖面不会随着 CATALOG 长大。
 *
 * 判据独立：键集合**从源码正则提取**，不引用任何运行时导出 —— 用导出值当期望，
 * 就等于拿被测对象证明自己没错（改错了也一起错）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SRC_PATH = path.join(__dirname, '..', 'js', 'achievements.js');
const src = fs.readFileSync(SRC_PATH, 'utf8');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) pass += 1;
  else { fail += 1; console.error('✗ ' + name + (extra ? ' — ' + extra : '')); }
}

/* ================================================================
 * 一、从 evaluate 的 ctx 里提取「判定能读到的键」
 * ================================================================ */
const ctxMatch = src.match(/var ctx = \{([\s\S]*?)\n    \};/);
ok(!!ctxMatch, '★ 能在源码里定位到 evaluate 的 ctx 字面量');

const ctxKeys = new Set();
if (ctxMatch) {
  /* 先剥离块注释再取键：ctx 里 `loseStreak` 前面紧跟着一段跨行注释，
   * 不剥离的话它前面的字符是 `*​/` 而不是逗号，会被漏掉 ——
   * 第一版就是这么漏的，结果「守卫自己报了一个假警」。 */
  const body = ctxMatch[1].replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([a-zA-Z0-9_]+)\s*:/g;
  let m;
  while ((m = re.exec(body)) !== null) ctxKeys.add(m[1]);
}

/* 这几个是嵌套对象（t / n 各自又是一个 map），它们本身也是合法键 */
['t', 'n'].forEach(function (k) { ctxKeys.add(k); });

ok(ctxKeys.size >= 20, '★ ctx 至少解析出 20 个键（防止正则失效后静默放行）',
  'keys=' + Array.from(ctxKeys).join(','));

/* ================================================================
 * 二、CATALOG 里每条 cur 读的键，必须都在 ctx 里
 * ================================================================ */
const gCalls = [];
const gRe = /g\(c,\s*'([a-zA-Z0-9_]+)'\)/g;
let gm;
while ((gm = gRe.exec(src)) !== null) gCalls.push(gm[1]);

ok(gCalls.length > 0, '★ 源码里能提取到 cur 读的键（正则没失效）', 'count=' + gCalls.length);

const missing = gCalls.filter(function (k) { return !ctxKeys.has(k); });
ok(missing.length === 0,
  '★★ CATALOG 里 cur 读的每个键，evaluate 的 ctx 都必须提供',
  '这些键读了但 ctx 没有：' + missing.join(',') + '（新增成就时漏加 ctx 字段 → 永远为 0）');

/* ================================================================
 * 三、tn(c,'x') 读的牌型短键必须在 TYPE_KEY_KNOWN 里
 * ================================================================ */
const tnCalls = [];
const tnRe = /tn\(c,\s*'([a-zA-Z0-9_]+)'\)/g;
let tm;
while ((tm = tnRe.exec(src)) !== null) tnCalls.push(tm[1]);

const typeKeyBlock = src.match(/var TYPE_KEY_KNOWN = \{([\s\S]*?)\};/);
ok(!!typeKeyBlock, '★ 能定位到 TYPE_KEY_KNOWN');
if (typeKeyBlock) {
  const known = new Set();
  const kre = /([a-zA-Z0-9_]+)\s*:\s*1/g;
  let km;
  while ((km = kre.exec(typeKeyBlock[1])) !== null) known.add(km[1]);
  const badType = tnCalls.filter(function (k) { return !known.has(k); });
  ok(badType.length === 0,
    '★★ 牌型成就读的短键必须在 TYPE_KEY_KNOWN 里',
    '不认识的键：' + badType.join(','));
}

/* ================================================================
 * 四、COUNT_KEYS 必须覆盖所有「会被 mergeInto 写入」的数字键
 *
 *    CATALOG 读的数字键 ⊆ COUNT_KEYS，否则 mergeInto 会把增量丢掉。
 * ================================================================ */
const countBlock = src.match(/var COUNT_KEYS = \[([\s\S]*?)\];/);
ok(!!countBlock, '★ 能定位到 COUNT_KEYS');
if (countBlock) {
  const countKeys = new Set();
  const cre = /'([a-zA-Z0-9_]+)'/g;
  let cm;
  while ((cm = cre.exec(countBlock[1])) !== null) countKeys.add(cm[1]);

  /* 这些是「存档里的数字计数器」，cur 通过 g(c,'x') 读。
   * 排除 ctx 里来自 stats 的实时字段（它们不落 ach 桶）。 */
  const LIVE_KEYS = new Set(['games', 'streak', 'loseStreak', 'bestNet']);
  const needCount = Array.from(new Set(gCalls)).filter(function (k) {
    return !LIVE_KEYS.has(k);
  });
  const notInCount = needCount.filter(function (k) { return !countKeys.has(k); });
  ok(notInCount.length === 0,
    '★★ 从 ach 桶读的计数器必须登记在 COUNT_KEYS 里（否则 mergeInto 静默丢弃）',
    '没登记的：' + notInCount.join(','));
}

/* ================================================================
 * 五、反向自检：如果正则失效，上面几条会「全绿但什么都没检查」
 * ================================================================ */
ok(gCalls.length >= 20, '★ 提取到的 g() 调用数量合理（≥20，防止正则只剩一条还判绿）',
  'count=' + gCalls.length);

/* ================================================================
 * 六、每条成就必须**声明**自己读的是哪个键（v116）
 *
 * 起因：旧目录里 id 长成 rN，看起来就是计数键，但实际是交叉的 ——
 *   旧 id `r9`（一夜暴富）读 `r12`、旧 id `r11`（你咋这幸）读 `r9`。
 * 四处交叉，每次读这段都要重新对一遍，还容易被当成 bug 去「修」。
 * 现在：id 不再冒充键名，读哪个键由 `countKey` / `statKey` 明说，
 * 并且**必须与 cur 实际读的键一致** —— 不一致就在这里红。
 * ================================================================ */
const catStart = src.indexOf('var CATALOG = [');
const catEnd = src.indexOf('\n  ];', catStart);
ok(catStart > 0 && catEnd > catStart, '★ 能在源码里定位到 CATALOG 区块');

const entries = [];
if (catStart > 0 && catEnd > catStart) {
  const block = src.slice(catStart, catEnd);
  /* 以 `{ id: '` 切块；每块到下一个 id 或结尾 */
  const parts = block.split(/\n\s*\{ id: '/).slice(1);
  parts.forEach(function (p) {
    const idm = /^([a-zA-Z0-9_]+)'/.exec(p);
    if (!idm) return;
    entries.push({ id: idm[1], body: p });
  });
}

ok(entries.length >= 35, '★ 解析到 ≥35 条成就（防止切块正则失效后静默放行）',
  'count=' + entries.length);

{
  const ids = entries.map(function (e) { return e.id; });
  const dup = ids.filter(function (x, i) { return ids.indexOf(x) !== i; });
  ok(dup.length === 0, '★★ id 唯一', '重复的：' + dup.join(','));

  /* id 不许与任何**计数键 / 实时字段**同名：
   * 交叉就是从「id 冒充键名」开始的（旧 id `r9` 读 `r12`、旧 id `r11` 读 `r9`）。
   * 注意 h2 / c4 / s1 这种不算问题 —— 它们和键名集合没有交集。 */
  const RESERVED = new Set(
    ((countBlock ? countBlock[1] : '').match(/'([a-zA-Z0-9_]+)'/g) || [])
      .map(function (x) { return x.replace(/'/g, ''); })
      .concat(['games', 'streak', 'loseStreak', 'bestNet', 't', 'n', 'v', 'since'])
  );
  const keyish = ids.filter(function (x) { return RESERVED.has(x); });
  ok(keyish.length === 0,
    '★★ id 不许与计数键 / 实时字段同名（否则又会「id 看着像键、实际读的是别的」）',
    '违规：' + keyish.join(','));
}

{
  const noDecl = [];
  const both = [];
  const mismatch = [];
  entries.forEach(function (e) {
    const b = e.body;
    const ck = /countKey: '([^']+)'/.exec(b);
    const sk = /statKey: '([^']+)'/.exec(b);
    if (!ck && !sk) { noDecl.push(e.id); return; }
    if (ck && sk) { both.push(e.id); return; }

    /* cur 读的键：g(c,'x') 或 tn(c,'x') */
    const gc = /g\(c, '([^']+)'\)/.exec(b);
    const tc = /tn\(c, '([^']+)'\)/.exec(b);
    const read = tc ? 't.' + tc[1] : (gc ? gc[1] : null);
    const declared = ck ? ck[1] : sk[1];
    if (!read || read !== declared) {
      mismatch.push(e.id + '（声明 ' + declared + '，实际读 ' + (read || '解析不到') + '）');
    }
  });

  ok(noDecl.length === 0,
    '★★ 每条成就都要声明 countKey 或 statKey',
    '没声明的：' + noDecl.join(','));
  ok(both.length === 0,
    'countKey 与 statKey 不能同时出现（一个是桶里计数，一个是档案实时值）',
    '同时声明的：' + both.join(','));
  ok(mismatch.length === 0,
    '★★★ 声明的键必须与 cur 实际读的键一致（这条就是防「id/声明/实现」三者走偏）',
    mismatch.join(' / '));
}

/* ================================================================
 * 七、r8 必须真的不存在了（v116 删掉的废弃字段）
 * ================================================================ */
{
  const r8Hits = [];
  if (/\br8\b/.test(src)) {
    /* 允许出现的地方：只有「说明它被删了」的注释 */
    const lines = src.split('\n');
    lines.forEach(function (ln, i) {
      if (!/\br8\b/.test(ln)) return;
      const isComment = /^\s*(\*|\/\/|\/\*)/.test(ln);
      if (!isComment) r8Hits.push((i + 1) + ': ' + ln.trim().slice(0, 60));
    });
  }
  ok(r8Hits.length === 0,
    '★★ r8（人间清醒）已从 COUNT_KEYS / ctx / 目录里彻底删除，只在注释里留念',
    r8Hits.join(' | '));
}

console.log('\n----------------------------------------');
if (fail) {
  console.error('失败 ' + fail + ' 项，通过 ' + pass + ' 项');
  process.exit(1);
} else {
  console.log('通过 ' + pass + ' 项，失败 0 项');
}
