/**
 * 分析 style.css / records.css 里每一处 gap 的实际处境。
 *
 * 只做一件事：把「gap 在哪个选择器、值多少、那个容器是不是 flex、方向、是否 wrap」
 * 摊开成一张表。因为迁移方案完全取决于这三个属性：
 *   - grid 容器        → 不动（grid 的 gap 是 Chrome 57 / Safari 10.1，早于本项目底线）
 *   - flex 单行 row    → 子元素 margin-left
 *   - flex 单行 column → 子元素 margin-top
 *   - flex wrap        → 必须负 margin 方案，最容易改错
 * 没有这张表就动手，等于在 104 个地方盲改。
 *
 * 注意：第一版按「行」找含 `{` 的规则，漏掉了所有多行写法
 * （`.x {` / `display:flex;` / `gap:12px;` / `}` 占四行），只数到 28 处就以为只有 28 处。
 * 现在改成真正的块扫描。
 *
 * 用法：node scripts/analyze-gap.js
 */
'use strict';

const fs = require('fs');

const FILES = ['pwa/css/style.css', 'pwa/css/records.css'];

/** 去掉注释但保留换行，行号才不会漂 */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/** 块扫描：返回 [{ selector, body, line, media }] */
function parseBlocks(css) {
  const out = [];
  const stack = [];
  let i = 0;
  let line = 1;
  let preludeStart = 0;

  const mediaNow = () => stack.filter((s) => s.type === 'media').map((s) => s.media).join(' and ');

  while (i < css.length) {
    const ch = css[i];
    if (ch === '\n') { line += 1; i += 1; continue; }

    if (ch === '{') {
      const prelude = css.slice(preludeStart, i).trim().replace(/\s+/g, ' ');

      /* @media / @supports / @keyframes 之类：进入新的嵌套层 */
      if (prelude.startsWith('@')) {
        const isKeyframes = /^@(-\w+-)?keyframes/.test(prelude);
        stack.push({ type: prelude.startsWith('@media') ? 'media' : 'other', media: prelude });
        preludeStart = i + 1;
        i += 1;
        /* keyframes 内部是 from{} 50%{} 这种，逐个跳过整块，避免污染行号 */
        if (isKeyframes) {
          let depth = 1;
          while (i < css.length && depth > 0) {
            if (css[i] === '\n') line += 1;
            if (css[i] === '{') depth += 1;
            if (css[i] === '}') depth -= 1;
            i += 1;
          }
          stack.pop();
          preludeStart = i;
        }
        continue;
      }

      /* 普通规则：找到配对的 } */
      let depth = 1;
      let j = i + 1;
      let bodyLine = line;
      while (j < css.length && depth > 0) {
        if (css[j] === '{') depth += 1;
        else if (css[j] === '}') depth -= 1;
        if (depth > 0 && css[j] === '\n') bodyLine += 1;
        j += 1;
      }
      out.push({
        selector: prelude,
        body: css.slice(i + 1, j - 1),
        line: bodyLine,
        startLine: line,
        media: mediaNow()
      });
      /* 把块内的换行补进行号 */
      for (let k = i; k < j; k += 1) if (css[k] === '\n') line += 1;
      i = j;
      preludeStart = i;
      continue;
    }

    if (ch === '}') {
      if (stack.length) stack.pop();
      i += 1;
      preludeStart = i;
      continue;
    }
    i += 1;
  }
  return out;
}

const rules = [];
for (const f of FILES) {
  const css = stripComments(fs.readFileSync(f, 'utf8'));
  for (const r of parseBlocks(css)) {
    if (!/(^|[^-\w])gap\s*:/.test(r.body)) continue;
    const m = r.body.match(/(?:^|[^-\w])gap\s*:\s*([^;}]+)/);
    rules.push({
      file: f,
      line: r.line,
      selector: r.selector,
      media: r.media,
      value: (m ? m[1] : '').trim(),
      body: r.body.replace(/\s+/g, ' ').trim()
    });
  }
}

function classify(r) {
  const b = r.body;
  const display = /display\s*:\s*(inline-flex|flex)\b/.test(b) ? 'flex'
    : /display\s*:\s*(inline-grid|grid)\b/.test(b) ? 'grid' : '';
  const dir = /flex-direction\s*:\s*column/.test(b) ? 'column' : 'row';
  const wrap = /flex-wrap\s*:\s*wrap/.test(b);
  const nowrap = /flex-wrap\s*:\s*nowrap/.test(b);
  return { display, dir, wrap, nowrap };
}

/* 规则自己没写 display 时，去同选择器的其他规则里找（常见的拆写手法） */
const displayBySelector = new Map();
for (const r of rules) {
  const c = classify(r);
  if (c.display) displayBySelector.set(r.selector, c);
}

const details = rules.map((r) => {
  const c = classify(r);
  let inherit = c;
  if (!c.display) {
    const other = displayBySelector.get(r.selector);
    if (other) inherit = { display: other.display, dir: c.dir === 'row' && /flex-direction/.test(r.body) === false ? other.dir : c.dir, wrap: c.wrap || other.wrap, nowrap: c.nowrap || other.nowrap };
  }
  let kind;
  if (inherit.display === 'grid') kind = 'grid';
  else if (inherit.display === 'flex') kind = inherit.wrap ? 'flexWrap' : (inherit.dir === 'column' ? 'flexCol' : 'flexRow');
  else kind = 'unknown';
  return Object.assign({}, r, { kind, ...inherit, inherited: inherit !== c });
});

const buckets = {};
for (const d of details) (buckets[d.kind] = buckets[d.kind] || []).push(d);

console.log('gap 总处数：' + details.length);
for (const k of Object.keys(buckets).sort()) {
  console.log('  ' + k.padEnd(10) + buckets[k].length);
}

const show = (title, list) => {
  if (!list || !list.length) return;
  console.log('\n=== ' + title + ' (' + list.length + ') ===');
  for (const d of list) {
    console.log('  ' + d.file + ':' + d.line + '  ' + d.selector
      + (d.media ? '   [' + d.media + ']' : '')
      + '   gap:' + d.value + (d.inherited ? '   (display 来自同选择器别处)' : ''));
  }
};

show('grid（不动）', buckets.grid);
show('flexRow', buckets.flexRow);
show('flexCol', buckets.flexCol);
show('flexWrap（危险）', buckets.flexWrap);
show('unknown（需人工确认）', buckets.unknown);

console.log('\n=== 多值 gap（gap: 行 列）===');
const multi = details.filter((d) => d.value.split(/\s+/).length > 1);
if (!multi.length) console.log('  无');
else multi.forEach((d) => console.log('  ' + d.file + ':' + d.line + '  ' + d.selector + '  gap:' + d.value));

fs.writeFileSync('scripts/.gap-report.json', JSON.stringify(details, null, 2));
console.log('\n明细写到 scripts/.gap-report.json');
