/**
 * 生成 flex gap 的老内核兼容层：pwa/css/flex-gap-fallback.css
 *
 * 为什么是「加兼容层」而不是「原地改 76 处」
 * ------------------------------------------
 * REVIEW 6.1 的原话是「104 处 gap 迁 margin」。真动手前先算了一遍，发现硬迁有两个坑：
 *
 * 1. **`space-between` 语义不等价。** 有 7 个容器同时用了 `justify-content: space-*`
 *    和 `gap`。space-between 的分配逻辑是「先用 gap 保证最小间距，剩余空间再均分」；
 *    换成子元素 margin 后，margin 会先吃掉空间，第二个元素被往里推 G，布局直接变。
 *    这 7 处无法用 margin 等价表达。
 *
 * 2. **改错没有声音。** 76 处散落在 4 个媒体查询、十几个断点里，改错一处只是
 *    「某块在某个尺寸下偏移几个像素」，单元测试一条都抓不到，只能靠人眼比截图。
 *
 * 而真正的目标只有一个：**老内核不要挤成一团。** 现代浏览器本来就好好的。
 * 所以改成「运行时检测 + 条件生效」：
 *
 *   · 现代浏览器：`html.no-flex-gap` 这个 class 永远不会被加上，本文件全部规则不生效，
 *     布局与改动前逐像素一致，零回归风险；
 *   · 老内核：检测到不支持 flex gap，挂上 class，这些 margin 规则接管间距。
 *
 * 代价是老内核上 `space-*` 那 7 处维持原样（不补间距），
 * wrap 的那 3 处换行后行首会多一个 G 的缩进 —— 都比「全黏在一起」好，
 * 也都记录在 docs/compat.md 里。
 *
 * 用法：
 *   node scripts/gen-flex-gap-fallback.js          # 生成
 *   node scripts/gen-flex-gap-fallback.js --check  # 只校验生成物是否最新（给测试用）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { stripComments, parseBlocks, splitSelectors, lastClassOf } = require('./lib/css-blocks');

const ROOT = path.join(__dirname, '..');
const SOURCES = ['pwa/css/style.css', 'pwa/css/records.css'];
const OUT = path.join(ROOT, 'pwa/css/flex-gap-fallback.css');
const CHECK_ONLY = process.argv.includes('--check');

/* ---------------------------------------------------------------- 读取 */

const allRules = [];
for (const rel of SOURCES) {
  const css = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  for (const r of parseBlocks(css)) {
    allRules.push(Object.assign({ file: rel }, r, { flat: r.body.replace(/\s+/g, ' ') }));
  }
}

/** 同选择器（或同末尾类名）上的 flex 属性回溯 */
function baseFlex(selector) {
  const cls = lastClassOf(selector);
  const re = cls ? new RegExp('\\.' + cls.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&') + '(?![\\w-])') : null;
  let display = '';
  let dir = '';
  for (const r of allRules) {
    if (r.selector === selector || (re && re.test(r.selector))) {
      if (!display) {
        if (/display\s*:\s*(inline-flex|flex)\b/.test(r.flat)) display = 'flex';
        else if (/display\s*:\s*(inline-grid|grid)\b/.test(r.flat)) display = 'grid';
      }
      if (!dir && /flex-direction\s*:\s*column/.test(r.flat)) dir = 'column';
      if (!dir && /flex-direction\s*:\s*row/.test(r.flat)) dir = 'row';
    }
  }
  return { display, dir };
}

/* ---------------------------------------------------------------- 归类 */

const rows = [];
for (const r of allRules) {
  if (!/(^|[^-\w])gap\s*:/.test(r.body)) continue;
  const m = r.body.match(/(?:^|[^-\w])gap\s*:\s*([^;}]+)/);
  const rawValue = (m ? m[1] : '').trim();

  const own = /display\s*:\s*(inline-flex|flex)\b/.test(r.flat) ? 'flex'
    : /display\s*:\s*(inline-grid|grid)\b/.test(r.flat) ? 'grid' : '';
  const ownDir = /flex-direction\s*:\s*column/.test(r.flat) ? 'column'
    : /flex-direction\s*:\s*row/.test(r.flat) ? 'row' : '';

  const base = own ? { display: own, dir: ownDir } : baseFlex(r.selector);
  const display = own || base.display;

  let dir = ownDir || base.dir || 'row';   // flex 默认 row
  const wrap = /flex-wrap\s*:\s*wrap/.test(r.flat);
  const spaced = /justify-content\s*:\s*space-/.test(r.flat);
  const px = parseFloat(rawValue);

  let skip = '';
  if (!(px > 0)) skip = '值为 0，无需补间距';
  else if (display === 'grid') skip = 'grid 的 gap 从 Chrome 57 / Safari 10.1 就支持，早于本项目底线';
  else if (display !== 'flex') skip = '推断不出容器是 flex（display 写在无法回溯的地方），不敢乱加';
  else if (spaced) skip = 'justify-content: space-* 与 margin 语义不等价，加了会改变元素位置';

  rows.push(Object.assign({}, r, {
    value: rawValue, px, dir, wrap, display, skip,
    multi: rawValue.split(/\s+/).length > 1
  }));
}

/* 多值 gap（gap: 行 列）本项目目前没有，一旦出现必须人工决定，不能默默按单值处理 */
const multi = rows.filter((r) => r.multi && !r.skip);
if (multi.length) {
  console.error('发现多值 gap，需要人工处理：');
  multi.forEach((r) => console.error('  ' + r.file + ':' + r.line + '  ' + r.selector + '  gap:' + r.value));
  process.exit(1);
}

/* ---------------------------------------------------------------- 生成 */

const live = rows.filter((r) => !r.skip);
const skipped = rows.filter((r) => r.skip);

/* 按 @media 分组，保持原文件里的媒体条件 */
const byMedia = new Map();
for (const r of live) {
  const key = r.media || '';
  if (!byMedia.has(key)) byMedia.set(key, []);
  byMedia.get(key).push(r);
}

/* 同一个选择器可能在多条规则里出现（基础 + 媒体查询覆盖），
 * 这在 CSS 里是「后者覆盖前者」，在兼容层里必须保持同样的顺序与条件，
 * 所以直接按原文件顺序输出，不合并、不去重。 */
function ruleFor(sel, r) {
  const prop = r.dir === 'column' ? 'margin-top' : 'margin-left';
  const targets = splitSelectors(sel).map((s) => 'html.no-flex-gap ' + s + ' > * + *');
  return targets.join(',\n') + ' {\n  ' + prop + ': ' + r.value + ';\n}';
}

const chunks = [];
chunks.push('/* ---------------------------------------------------------------------------');
chunks.push(' * flex gap 老内核兼容层 —— 由 scripts/gen-flex-gap-fallback.js 生成，请勿手改');
chunks.push(' *');
chunks.push(' * 生效条件：<html> 上有 .no-flex-gap（由 index.html 里的检测脚本挂上）。');
chunks.push(' * 现代浏览器永远不会有这个 class，所以本文件对它们是**完全惰性**的。');
chunks.push(' *');
chunks.push(' * ' + live.length + ' 条规则，另有 ' + skipped.length + ' 处刻意不处理，原因见 docs/compat.md。');
chunks.push(' * ------------------------------------------------------------------------- */');
chunks.push('');

for (const [media, list] of byMedia) {
  if (media) {
    chunks.push('@media ' + media.replace(/^@media\s*/, '') + ' {');
    for (const r of list) {
      for (const sel of splitSelectors(r.selector)) {
        chunks.push('  ' + ruleFor(sel, r).split('\n').map((l, i) => (i === 0 ? l : '  ' + l)).join('\n'));
      }
    }
    chunks.push('}');
  } else {
    for (const r of list) {
      for (const sel of splitSelectors(r.selector)) {
        chunks.push(ruleFor(sel, r));
      }
    }
  }
  chunks.push('');
}

const content = chunks.join('\n');

if (CHECK_ONLY) {
  const now = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (now !== content) {
    console.error('flex-gap-fallback.css 已过期，请跑：node scripts/gen-flex-gap-fallback.js');
    process.exit(1);
  }
  console.log('flex-gap-fallback.css 是最新的（' + live.length + ' 条规则）');
  process.exit(0);
}

fs.writeFileSync(OUT, content);
console.log('写出 ' + path.relative(ROOT, OUT));
console.log('  生成规则 ' + live.length + ' 条');
console.log('  跳过 ' + skipped.length + ' 处：');
for (const r of skipped) {
  console.log('    ' + r.file + ':' + r.line + '  ' + r.selector + '  gap:' + r.value + '  —— ' + r.skip);
}
