/**
 * 极简 CSS 块解析器（只服务 scripts/ 下的分析工具，不进 pwa/）
 *
 * 为什么自己写：项目零依赖（npm 里没有 postcss），而这里要的只有一件事 ——
 * 「每条规则的选择器、声明体、行号、所在 @media」。为此引一个解析器进来不划算。
 *
 * 能力边界（够用就好）：
 *   · 支持 @media / @supports 嵌套（只用于记录归属，不做条件求值）
 *   · 跳过 @keyframes 内部（from/50%/to 会被误认成规则，且里面的换行会污染行号）
 *   · 不支持 CSS Nesting（本项目没用到，用到的话这里会读错）
 *   · 注释先被抹成空格，行号不漂
 *
 * 行号必须准 —— 生成器要把「哪一处 gap 需要兼容」写到文档里给人核对，
 * 行号偏一行就白写了。
 */
'use strict';

/** 去掉注释但保留换行，行号才不会漂 */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * @param {string} css 已去注释的 CSS
 * @returns {Array<{selector:string, body:string, line:number, media:string}>}
 */
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

      if (prelude.startsWith('@')) {
        const isKeyframes = /^@(-\w+-)?keyframes/.test(prelude);
        stack.push({ type: prelude.startsWith('@media') ? 'media' : 'other', media: prelude });
        i += 1;
        preludeStart = i;
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

      /* 普通规则：找配对的 } */
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
        media: mediaNow()
      });
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

/** 按顶层逗号拆分选择器列表（不会切开 :not(a, b) 里的逗号） */
function splitSelectors(sel) {
  const out = [];
  let depth = 0;
  let buf = '';
  for (const ch of sel) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(buf.trim()); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

/** 取选择器最后一段的类名，用来回溯「同一元素的基础规则」 */
function lastClassOf(selector) {
  const parts = selector.split(/[\s>+~]+/).filter(Boolean);
  const last = parts[parts.length - 1] || '';
  const m = last.match(/\.([A-Za-z_][\w-]*)/);
  return m ? m[1] : '';
}

module.exports = { stripComments, parseBlocks, splitSelectors, lastClassOf };
