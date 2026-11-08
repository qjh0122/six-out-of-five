#!/usr/bin/env node
/**
 * 文档一致性守（v138 · 2026-11-08）
 *
 * 跑法：node scripts/check-docs.js
 *
 * 为什么要有它：这一轮之前，自称「版本现状的唯一权威」的 release-progress.md
 * 开头写着「当前线上 v133 / 145 文件 5630 断言」，而文件末尾已经追加到 v138。
 * 不是谁写错了，是**没有任何东西会红**：文档漂移不报错、不白屏、不假绿，
 * 它只是让读的人把后面所有条目一起打折。
 *
 * 守的是「会随代码变的那几个量」和「文档之间的引用关系」，不守措辞：
 *   ① INDEX 里的链接必须是真文件（死链 = 0）
 *   ② 唯一事实源：release-progress 顶部「当前状态」卡片 == 代码里的真实版本
 *   ③ 生成式台账 PROBES.md 头部 == scripts/probes.json（不许手改产物）
 *   ④ 现行规格恰好一份，作废旧版不许再自称「唯一来源」
 *   ⑤ 施工单 / 判据 / 规格的状态头不许停留在「待施工」
 *   ⑥ 快照提醒句不许复述当前版本号（否则每发一版它自己就先过期）
 *
 * 和项目里其它守卫一样：先做**分类器自测**，证明判据既能抓也能放 ——
 * 否则「零违规」只说明规则没匹配上。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

/* 文档链接（允许 #锚点）。自测与正式检查**必须共用这一个正则** ——
 * 各写一份的话，自测绿了也证明不了正式检查不漏。 */
const LINK_RE = /\]\((\.\.?\/[^)#]+\.md)(?:#[^)]*)?\)/g;

let pass = 0, fail = 0;
function ok(c, m, extra) {
  if (c) { pass++; console.log('  ✓ ' + m); }
  else { fail++; console.log('  ✗ ' + m + (extra !== undefined ? '  ← ' + extra : '')); }
}
function eq(a, b, m, extra) {
  ok(a === b, m, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b) + (extra ? '  |  ' + extra : ''));
}
function head(t) { console.log('\n' + t); }

/* =================== 分类器自测 =================== */
head('[0] 分类器自测');
{
  const links = (s) => [...s.matchAll(LINK_RE)].map((m) => m[1]);
  eq(links('[a](./a.md) [b](../b.md)').length, 2, '能抓到 md 链接');
  eq(links('[x](#anchor) 和 `./a.md` 反引号里的').length, 0, '锚点 / 行内代码不算链接（别误抓）');
  eq(links('[c](./c.md#section)').length, 1, '带锚点的文件链接仍算');

  const swOf = (s) => { const m = /CACHE_NAME\s*=\s*'([^']+)'/.exec(s); return m ? m[1] : null; };
  eq(swOf("const CACHE_NAME = 'weile-liuxuanwu-v138';"), 'weile-liuxuanwu-v138', '能读出 sw 版本');
  eq(swOf('// CACHE_NAME = old'), null, '注释里的旧值不算（带引号才认）');

  const statusOf = (s) => /\|\s*状态\s*\|\s*\*\*([^*]+)\*\*/.exec(s);
  ok(!!statusOf('| 状态 | **待施工** |'), '能抓到「待施工」状态头');
  /* 反向样本必须真的被判成「不是待施工」——写 `=== false || true` 这种恒真断言，
   * 正是这个项目反复在治的假绿（v134 的分类器 bug、v138 的 emoji 名次格子）。 */
  const done = statusOf('| 状态 | **已施工并发布（v138）** |');
  ok(!!done && !/待施工/.test(done[1]), '能抓到已施工状态，且不误判成待施工', done ? done[1] : 'null');
  ok(/待施工/.test('状态 | **待施工**') && !/待施工/.test('状态 | **已验收（v137）**'),
    '能区分待施工 / 已验收（不是恒真）');
}

/* =================== [1] INDEX 死链 =================== */
head('[1] INDEX 登记的文档链接');
{
  const index = read('docs/INDEX.md');
  const links = [...index.matchAll(LINK_RE)].map((m) => m[1]);
  const missing = links.filter((l) => !exists(path.join('docs', l)));
  ok(links.length >= 40, '真的扫到了文档链接（' + links.length + ' 条）');
  eq(missing.length, 0, '★★ 死链为 0', missing.join(', '));
}

/* =================== [1b] review 档案登记完整性 =================== */
head('[1b] review/ 下每份档案都在 INDEX 登记（QA 审计 D11）');
{
  const idx = fs.readFileSync(path.join(ROOT, 'docs/INDEX.md'), 'utf8');
  const linked = new Set([...idx.matchAll(/\]\(\.\/review\/([^)#]+\.md)(?:#[^)]*)?\)/g)].map((m) => m[1]));
  const actual = fs.readdirSync(path.join(ROOT, 'docs/review')).filter((f) => f.endsWith('.md'));
  const miss = actual.filter((f) => !linked.has(f));
  const dead = [...linked].filter((f) => !actual.includes(f));
  ok(actual.length >= 15, '真的扫到了 review 档案（' + actual.length + ' 份）');
  eq(miss.length, 0, '★ 没有漏登记的档案', miss.join(', '));
  eq(dead.length, 0, '★ 没有指向不存在档案的链接', dead.join(', '));
}

/* =================== [2] 唯一事实源：当前状态卡片 =================== */
head('[2] 当前状态卡片 == 代码里的真实版本');
{
  const sw = /CACHE_NAME\s*=\s*'([^']+)'/.exec(read('pwa/sw.js'));
  const html = read('pwa/index.html');
  const pageVer = /(\d{8}[a-z])/.exec(html);
  const rp = read('docs/release-progress.md');
  /* 只取文件顶部「当前状态」卡片到下一个 ## 之间，避免误抓历史段里的旧版本号 */
  const card = /## 当前状态[^\n]*\n([\s\S]*?)\n### /.exec(rp);
  ok(!!sw, '从 pwa/sw.js 读到了 CACHE_NAME');
  ok(!!pageVer, '从 pwa/index.html 读到了页面版本号');
  ok(!!card, 'release-progress.md 有「当前状态」卡片');
  if (sw && card) ok(card[1].includes('sw `' + sw[1].replace('weile-liuxuanwu-', '') + '`'),
    '★ 卡片里的 sw 版本 == 代码', sw[1]);
  if (pageVer && card) ok(card[1].includes('`' + pageVer[1] + '`'),
    '★ 卡片里的页面版本 == 代码', pageVer[1]);
  /* 反向：卡片之前不许再出现自称「当前线上」的旧句子 —— 这一轮的真实缺陷 */
  const before = rp.slice(0, rp.indexOf('## 当前状态'));
  ok(!/\*\*当前线上[:：]/.test(before), '★★ 卡片之前没有别的「当前线上」声明（防止两个现状打架）');
}

/* =================== [3] 生成式台账 =================== */
head('[3] PROBES.md 头部 == 真源');
{
  const j = JSON.parse(read('scripts/probes.json'));
  const doc = read('docs/PROBES.md');
  const head6 = doc.slice(0, 400);
  ok(head6.includes('生成于版本 `' + j.version + '`'), '★ 头部版本 == probes.json 的 version', j.version);
  ok(head6.includes('共 ' + j.probes.length + ' 个探针'), '★ 头部条数 == probes.length', String(j.probes.length));
  ok(head6.includes('**这份文件是生成的，不要手改。**'), '★ 产物自带「别手改」声明');
  /* 生成器里不许再写死探针总数 —— 真源过期比产物过期更难发现 */
  const gen = read('scripts/probes.js');
  ok(!/P\('\d+ 个探针里只有 \d+ 个在 CI 里/.test(gen), '★ 生成器没有写死探针数（用 total / counts 拼）');
  ok(/total \+ ' 个探针里只有 ' \+ counts\.ci/.test(gen), '★ 生成器确实改成动态拼接');
  /* QA 审计 AC4 / D1：v130-review 在 6080 断言全绿下活了 8 个版本，
   * 因为 `probes.json.version` 与 `sw.js` 是两条互不校验的真源。把它们的等号钉死。 */
  const swVer = /CACHE_NAME\s*=\s*'weile-liuxuanwu-(v\d+)'/.exec(read('pwa/sw.js'));
  ok(!!swVer && j.version === swVer[1],
    '★★ 台账 version == sw.js 的版本尾号（防止它再落后 8 版）',
    j.version + ' vs ' + (swVer ? swVer[1] : '?'));
}

/* =================== [3b] 复述的计数必须锚到真源 =================== */
head('[3b] 活文档里复述的计数 == 唯一事实源（QA 指出的最后一处漂移）');
{
  const j = JSON.parse(read('scripts/probes.json'));
  const index = read('docs/INDEX.md');
  const readme = read('README.md');
  const rp = read('docs/release-progress.md');
  const card = /## 当前状态[^\n]*\n([\s\S]*?)\n### /.exec(rp);
  const c = card ? card[1] : '';

  /* 探针条数：真源是 probes.json，INDEX 只是复述 */
  const m = /(\d+) 个真浏览器探针/.exec(index);
  ok(!!m && Number(m[1]) === j.probes.length,
    '★ INDEX 里的探针条数 == probes.json', m ? m[1] + ' vs ' + j.probes.length : '未找到复述');

  /* 测试计数：唯一权威是 release-progress 的「当前状态」卡片，README 只是复述。
   * 不跑 npm test（100 秒），改为核「两个复述必须逐字一致」。 */
  const cardCount = /\*\*(\d+) 文件 \/ (\d+) 断言/.exec(c);
  const readmeCount = /(\d+) 个文件 \/ (\d+) 条断言/.exec(readme);
  ok(!!cardCount && !!readmeCount, '两边都写明了测试计数');
  if (cardCount && readmeCount) {
    eq(readmeCount[1] + '/' + readmeCount[2], cardCount[1] + '/' + cardCount[2],
      '★★ README 的计数 == 当前状态卡片（改一处忘另一处会红）');
  }
}

/* =================== [4] 现行规格唯一 =================== */
head('[4] 同一专业域只有一份现行规格');
{
  const files = fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => /^design-states-v\d+\.md$/.test(f));
  /* 只认文件头 600 字里**显式**的「取代：v1」或「现行规格」状态行。
   * 不能全文搜「现行」——旧版作废横幅里也会提到取代者的名字，那样会把 v1 也数进来。 */
  const current = files.filter((f) => {
    const h = read('docs/' + f).slice(0, 600);
    return /取代[：:]\s*v1/.test(h) || /\*\*状态\*\*[^\n]*现行规格/.test(h) || /状态\s*\|\s*\*\*[^*]*现行规格/.test(h);
  });
  ok(files.length >= 2, '确实存在新旧两版规格（' + files.join(', ') + '）');
  eq(current.length, 1, '★★ 自称「现行」的恰好一份', current.join(', ') || '无');
  if (current.length === 1) ok(current[0] === 'design-states-v2.md', '★ 现行的是 v2', current[0]);
  const v1 = exists('docs/design-states-v1.md') ? read('docs/design-states-v1.md') : '';
  if (v1) ok(/已作废|作废[\s\S]{0,40}取代/.test(v1.slice(0, 900)), '★ v1 头部已标作废并指向取代者');
}

/* =================== [5] 状态头不许停在「待施工」 =================== */
head('[5] 已上线的规格 / 施工单 / 判据，状态头已推进');
{
  const targets = [
    'docs/design-states-v1.md', 'docs/qa-states-v1.md',
    'docs/build-states-v1.md', 'docs/build-numbers-v1.md'
  ];
  for (const f of targets) {
    const s = read(f).slice(0, 1600);
    const stale = /\*\*待施工\*\*|状态\s*\|\s*待施工/.test(s);
    ok(!stale, '★ ' + path.basename(f) + ' 头部不再是「待施工」');
  }
}

/* =================== [6] 快照提醒句不许复述当前版本 =================== */
head('[6] 快照提醒句不写死当前版本号（否则每发一版它自己就过期）');
{
  const index = read('docs/INDEX.md');
  const row = index.split('\n').find((l) => l.includes('circle-table-rollout-status.md')) || '';
  const sw = /CACHE_NAME\s*=\s*'weile-liuxuanwu-(v\d+)'/.exec(read('pwa/sw.js'));
  const ver = sw ? sw[1] : 'v138';
  ok(row.length > 0, '找得到快照表那一行');
  ok(!row.includes('现在线上是 ' + ver), '★ 提醒句里没有写「现在线上是 ' + ver + '」');
  ok(/现状一律查|唯一权威|见\s*\[?`?release-progress/.test(row), '★ 改为指向唯一权威，而不是复述数字');
}

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
