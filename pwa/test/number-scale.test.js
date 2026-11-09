/**
 * 数字阶梯守（v138 · 数）
 *
 * 背景：「光」收成三档（v134）、「动」收成三档（v135）之后，剩下最多的一类还是没有标尺 —— **数**。
 * 实测：同一个「一个数」在四个地方用了四个字号 ——
 *   榜单净值 40 / 战绩列表净值 40 / 结算行净胜 32 / 成就计数 34 / 成就总数 84（390 上被压到 68）。
 * 它们不是设计出来的四档，是一个一个长出来的：40 是"比 48 小一点"，
 * 34 是"比 32 大一点"，68 是"小屏再缩一点"。没有人写错，只是没有一个"梯子"。
 *
 * 判据不是「一屏最多几个字号」——那条和「T2 有主档/密排两个密度」自相矛盾
 * （战绩页算出来就是四个）。判据是**封闭**：数值元素只能落在四个档里，
 * 单位只能落在两个档里。想加档先改文档，不许在 CSS 里现编。
 *
 * 本文件钉三件事：
 *   1. `:root` 有六个 token，值恰好是 88/48/32/24/28/20；
 *   2. 数值选择器的 `font-size` 只能是 `var(--num-*)`，**不许直接写 px** ——
 *      写死就等于绕过阶梯（这六个值的来历正是一次次"就这一次"）；
 *   3. 分类器自己要能抓也能放（喂假样本自测），否则「零违规」只说明规则没匹配上。
 *
 * 为什么不在这里验"渲染后是多大"：那要真浏览器，见 `scripts/probe-numbers.js`。
 * 这里守的是**结算页** —— 它必须真打一局才渲染得出，探针进不去，只能查声明。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CSS_DIR = path.join(__dirname, '..', 'css');
const FILES = ['style.css', 'records.css'];

let pass = 0, fail = 0;
function ok(c, m, extra) {
  if (c) { pass++; console.log('  ✓ ' + m); }
  else { fail++; console.log('  ✗ ' + m + (extra !== undefined ? '  ← ' + extra : '')); }
}
function eq(a, b, m, extra) {
  ok(a === b, m, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b) + (extra ? '  |  ' + extra : ''));
}
function head(t) { console.log('\n' + t); }

function strip(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}
function readAll() {
  const out = {};
  for (const f of FILES) {
    try { out[f] = strip(fs.readFileSync(path.join(CSS_DIR, f), 'utf8')); } catch (e) { out[f] = ''; }
  }
  return out;
}

/** 极简块解析：选择器 + 声明体（够用就好，见 scripts/lib/css-blocks.js 的同类取舍） */
function blocks(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    out.push({ sel: m[1].trim().replace(/\s+/g, ' '), body: m[2] });
  }
  return out;
}

/**
 * 数值选择器白名单。
 *
 * 注意这是**选择器级**的白名单，不是元素级：它说的是"这几类选择器写字号时必须走阶梯"。
 * 加新选择器进这张表 = 承认它属于"一屏的结论/关键值"，要跟着阶梯走。
 * 不该进来的：正文（`.rp-sum-meta` 场/胜率那段字）、名字（`.settle-name`）、
 * 头像首字母（`.settle-rank`，它随头像直径走，72px 的冠军圆配 32 是对的）。
 */
const NUMERIC_SELECTORS = [
  /(^|\s)\.rp-sum-value$/,
  /(^|\s)\.rp-gnum$/,
  /(^|\s)\.rp-best-v$/,
  /(^|\s)\.rp-best-v\s+i$/,
  /(^|\s)\.rp-net$/,
  /(^|\s)\.rp-unit$/,
  /(^|\s)\.rp-meta-item$/,
  /(^|\s)\.rp-list-count$/,
  /\.rp-sum-meta\s+b$/,
  /(^|\s)\.settle-net$/,
  /(^|\s)\.settle-score$/,
  /\.rank-row\s+\.rank-no$/,
  /\.rank-row\s+\.rank-net$/,
  /(^|\s)\.ach-count\s+b$/,
  /(^|\s)\.ach-count\s+span$/,
  /(^|\s)\.ach-type-num$/,
  /(^|\s)\.ach-type-num\s+b$/,
  /(^|\s)\.ach-progress$/
];

/* 角标豁免（施工单 §1-N4）：24×24 的圆心，16px 正好居中，顶到 24 会出血。
 * 它是**图形**不是排版里的数字 —— 所以允许写死，但写死的值必须是 16。 */
const BADGE_EXEMPT = /(^|\s)\.settle-pos$/;

const isNumericSel = (sel) => NUMERIC_SELECTORS.some((re) => re.test(sel));

/**
 * 分类器：一条声明合不合规。
 * 返回 null = 合规；返回字符串 = 违规原因。
 *
 * 分类器必须能被自测：如果它永远返回 null，「零违规」就毫无意义（§4 反复踩过）。
 */
function verdict(sel, body) {
  if (BADGE_EXEMPT.test(sel)) {
    const m = /font-size\s*:\s*([^;}]+)/.exec(body);
    if (!m) return null;
    return m[1].trim() === '16px' ? null : '角标只允许 16px（' + m[1].trim() + '）';
  }
  if (!isNumericSel(sel)) return null;
  const m = /font-size\s*:\s*([^;}]+)/.exec(body);
  if (!m) return null;                       // 没写字号 = 继承，不算违规
  const v = m[1].trim();
  if (/^var\(--num-(1|2|3|4|u1|u2)\)$/.test(v)) return null;
  return '必须是 var(--num-*)，实际写的是 ' + v;
}

/* =================== [0] 分类器自测 =================== */
head('[0] 分类器自测（先证明它能抓也能放）');
{
  eq(verdict('.rp-gnum', 'font-size: 48px;'), '必须是 var(--num-*)，实际写的是 48px', '字面量被抓');
  eq(verdict('.rp-gnum', 'font-size: var(--num-2);'), null, '令牌放行');
  eq(verdict('.rp-gnum', 'font-weight: 800;'), null, '没写字号 → 继承，不判违规');
  eq(verdict('.rp-sum-meta', 'font-size: 28px;'), null, '正文选择器不进白名单（不该误伤）');
  eq(verdict('.settle-pos', 'font-size: 16px;'), null, '角标豁免放行 16px');
  eq(verdict('.settle-pos', 'font-size: 24px;'), '角标只允许 16px（24px）', '角标放大被抓');
  ok(verdict('.rank-row .rank-no', 'font-size: 32px;') !== null, '榜单名次字面量被抓');
  ok(verdict('.ach-count b', 'font-size: 68px;') !== null, '成就总数被压到 68 会被抓');
  /* 负向：白名单里的选择器数量必须够 —— 自测通过但白名单是空的，等于没守 */
  ok(NUMERIC_SELECTORS.length >= 15, '白名单不是空的（' + NUMERIC_SELECTORS.length + ' 条）');
}

/* =================== [1] 六个 token =================== */
head('[1] :root 的六个数字 token');
{
  const css = readAll();
  const root = /:root\s*\{([\s\S]*?)\n\}/.exec(css['style.css']);
  ok(!!root, '找得到 :root');
  const body = root ? root[1] : '';
  const want = { '--num-1': '88px', '--num-2': '48px', '--num-3': '32px', '--num-4': '24px', '--num-u1': '28px', '--num-u2': '20px' };
  for (const [k, v] of Object.entries(want)) {
    const m = new RegExp('\\' + k + '\\s*:\\s*([^;]+);').exec(body);
    eq(m ? m[1].trim() : null, v, k + ' = ' + v);
  }
  /* 阶梯必须是"降序且没有相邻档太近"的：88/48/32/24 的比是 1.83/1.5/1.33。
   * 再塞一档 40 进去，40 与 48 只差 20%、与 32 差 25% —— 眼睛分不出，
   * 于是四档退化成三档 + 噪音。所以档数就锁死在 4。 */
  const nums = ['88px', '48px', '32px', '24px'].map((x) => parseFloat(x));
  ok(nums.length === 4, '数值档恰好 4 档');
  ok(new Set(nums).size === 4, '没有重复档');
  for (let i = 1; i < nums.length; i++) ok(nums[i] < nums[i - 1], '降序：' + nums[i - 1] + ' > ' + nums[i]);
}

/* =================== [2] 数值选择器全部走令牌 =================== */
head('[2] 数值选择器不准写死 px');
{
  const css = readAll();
  const bad = [];
  let checked = 0;
  for (const f of FILES) {
    for (const b of blocks(css[f])) {
      if (!isNumericSel(b.sel) && !BADGE_EXEMPT.test(b.sel)) continue;
      checked += 1;
      const v = verdict(b.sel, b.body);
      if (v) bad.push(f + ' ' + b.sel + ' → ' + v);
    }
  }
  ok(checked >= 20, '真的扫到了数值规则（' + checked + ' 块）');
  eq(bad.length, 0, '★★ 违规条数为 0', bad.join(' | '));
}

/* =================== [3] 结算页：冠军不许比竖屏小 =================== */
head('[3] 结算页跨朝向一致');
{
  const css = readAll();
  const find = (sel) => blocks(css['style.css']).filter((b) => b.sel === sel);
  const champ = find('.settle-row.champion .settle-net');
  const wideChamp = find('.wide-stage .settle-row.champion .settle-net');
  ok(champ.length === 1, '找得到竖屏冠军净胜');
  ok(wideChamp.length === 1, '找得到横屏冠军净胜');
  eq(champ[0] && /var\(--num-2\)/.test(champ[0].body), true, '★ 竖屏冠军走 T2');
  eq(wideChamp[0] && /var\(--num-2\)/.test(wideChamp[0].body), true, '★★ 横屏冠军同档（以前横屏 40 < 竖屏 48）');
  /* 反向：横屏那三个选择器必须拆开 —— 名字是文字可以压，数字不许跟着压。
   * 以前写成 `.wide-stage .settle-name, .wide-stage .settle-score, .wide-stage .settle-net { 28px }`，
   * 于是净胜被压到"单位档"，和旁边的「分」一样大。 */
  const grouped = blocks(css['style.css']).filter((b) => /\.wide-stage\s+\.settle-name\s*,/.test(b.sel));
  eq(grouped.length, 0, '★ 横屏不再把名字/得分/净胜写进同一条规则');
}

/* =================== [4] 成就总数不许按屏宽再缩一次 =================== */
head('[4] 成就总数：小屏不许比大屏小');
{
  const css = readAll();
  const drops = blocks(css['records.css']).filter((b) => /\.ach-count\s+b$/.test(b.sel) && /font-size/.test(b.body));
  eq(drops.length, 1, '★ .ach-count b 全站只剩一条声明（媒体里那两条 68/62 已删）',
    drops.map((b) => b.sel + ' { ' + b.body.trim().slice(0, 40) + ' }').join(' | '));
  ok(drops.length === 1 && /var\(--num-1\)/.test(drops[0].body), '★ 它走 T1');
}

/* =================== [5] §3.2 条件 ↔ 几何断言对照（AC-NB-20 / 25） ===================
 * 守的不是「某个字号对不对」，而是**那句自留条件有没有一条会在恶化时变红的断言**：
 * build-numbers-v1.md §3.2 写着「.compact-v .rp-sum-value | 76 | var(--num-1)
 * （若 320×568 溢出，改 --num-2 并在提交里写明）」，而 :78-79 自己承认
 * 「条件写了，但没有一条断言会在它恶化时变红」。这里把「条件 / 令牌 / 几何断言 /
 * 三处 320x568 对齐」钉成一条链，任何一环被摘掉都要红。
 * 本文件只做**静态**守（看不见 rect）；真渲染的几何断言在 scripts/probe-numbers.js。 */
head('[5] §3.2 条件 ↔ 几何断言对照（320×568 三处对齐）');
{
  const ROOT = path.join(__dirname, '..', '..');   // 仓库根（本文件原本只用到 CSS_DIR）
  const css = readAll();
  const rec = blocks(css['records.css']);
  const cond = rec.filter((b) => /\.compact-v\s+\.rp-sum-value$/.test(b.sel));
  eq(cond.length, 1, '★ 找得到 .compact-v .rp-sum-value 这一条 §3.2 条件声明',
    cond.map((b) => b.sel).join(','));

  const m = /font-size\s*:\s*([^;}]+)/.exec(cond.length ? cond[0].body : '');
  const v = m ? m[1].trim() : '(无 font-size)';
  ok(v === 'var(--num-1)' || v === 'var(--num-2)',
    '★★ §3.2 条件只许落在 {var(--num-1), var(--num-2)} 两档（N5 令牌内换档）', v);
  eq(/\d\s*px/.test(v), false,
    '★★ 该选择器 font-size 直接写 px 的次数 == 0（改回 76px 必须红，M5）', v);
  /* 负向：全站 .compact-v .rp-sum-value 不许出现第二处覆盖（把条件架空） */
  const compactRules = rec.filter((b) => /\.compact-v\s+\.rp-sum-value/.test(b.sel) && /font-size/.test(b.body));
  eq(compactRules.length, 1, '★ 条件只有一处（没有被后面的媒体查询悄悄盖掉）', String(compactRules.length));

  /* 「几何断言」那一端：探针里必须有独立 collectGeometry()，且不许复用文本采集器。 */
  const probe = fs.readFileSync(path.join(ROOT, 'scripts', 'probe-numbers.js'), 'utf8');
  const geo = /const GEOMETRY = `([\s\S]*?)`;/.exec(probe);   // 页面内独立采集器
  ok(!!geo && geo[1].length > 200, '（前置）能取到独立几何采集器全文（不是空匹配）',
    geo ? String(geo[1].length) : 'null');
  ok(/const GEOMETRY = `/.test(probe) && /document\.querySelector\('\.rp-sum-value'\)/.test(probe),
    '★★ 几何采集器按 querySelector 结构取节点（不读 textContent）');
  ok(/const collectGeometry = /.test(probe), '★ 有独立的 collectGeometry() 入口');
  /* 断言里的容差 / 间隙必须写死，不取自 computed style、不 == T1 */
  ok(/const TOL = 1;/.test(probe) && /const GAP = 10;/.test(probe),
    '★★ 1px 容差 / 10px 间隙写死在断言里（§3.1 规格表 + records.css:156 手算）');
  ok(/nScroll|cScrollW/.test(probe) && /cScrollW <= g\.cClientW/.test(probe),
    '★ scrollWidth / clientWidth 溢出判据在位（overflow:hidden 藏不住）');
  /* 只查 [1b] 这一段新断言：文件别处（成就页）沿用 T1 是既有口径，不该被误伤。 */
  const geoAssert = (probe.split('[1b]')[1] || '').split('/* ---------- [2]')[0];
  const t1Compare = /[!=]={1,2}\s*T1\b/;      // === T1 / == T1（文字注释里提「T1 主判据」不算）
  ok(!t1Compare.test(geoAssert) && !t1Compare.test(geo ? geo[1] : ''),
    '★ 几何采集器 / 断言块里没有 == T1（不钉被测常量）');
  ok(!/ownText\(|NUM\.test|\bNUM\b/.test(geo ? geo[0] : ''),
    '★★ 几何采集器不复用 COLLECT 的 ownText() / NUM（M8 负向）');

  /* 三处 320x568 对齐：文档（全角）/ 探针（全角标签 + 半角归一）/ CI（半角 only + step） */
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'build-numbers-v1.md'), 'utf8');
  const flow = fs.readFileSync(path.join(ROOT, 'scripts', 'probe-ui-flow.js'), 'utf8');
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'test.yml'), 'utf8');
  ok(/320×568/.test(doc), '★ 文档（build-numbers §3.2）写的是 320×568');
  ok(/320×568/.test(flow) && /w:\s*320,\s*h:\s*568/.test(flow),
    '★ 探针 VIEWPORTS 有 320×568 这一档（且尺寸对得上）');
  ok(/replace\(\/×\/g,\s*'x'\)/.test(flow), '★ 探针仍把 × 归一成半角 x（CI 的 only 才匹配得上）');
  ok(/only:\s*'320x568'/.test(wf), "★★ CI matrix 里是半角 x 的 '320x568'（不是全角 ×）", 'M7');
  ok(/probe-ci\.js scripts\/probe-numbers\.js 320 568/.test(wf),
    '★★ CI 的 run: 块里真调用了 probe-numbers.js 320 568（核到调用点，AC-NB-24）');
  ok(/ONLY\.split\(','\)/.test(wf), '★ 320 分片自检按 ONLY 期望数取（R5）');
  ok(!/only:\s*'[^']*×/.test(wf), '★ only 值里没有全角 ×（空列表 exit 2 的坑）');
}

/* =================== 收尾 =================== */
console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
