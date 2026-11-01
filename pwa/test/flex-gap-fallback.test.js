/**
 * flex gap 兼容层的守卫测试
 *
 * 这个文件守的不是「功能对不对」（它没有功能），而是三件容易慢慢烂掉的事：
 *
 * 1. **生成物过期。** flex-gap-fallback.css 是从 style.css / records.css 推导出来的。
 *    以后有人在某个 flex 容器上加 `gap: 14px` 却忘了跑生成脚本，老内核上那处就没间距 ——
 *    而现代浏览器一切正常，谁都不会发现。所以这里直接重跑一遍生成逻辑做比对。
 *
 * 2. **规则泄漏到全局。** 每条规则都必须挂在 `html.no-flex-gap` 下面。少写一个前缀，
 *    现代浏览器就会同时吃 gap 和 margin，间距翻倍 —— 这比不支持 gap 更难看，
 *    而且会立刻影响所有人（不是少数老内核用户）。这是这份文件里最严重的失败模式。
 *
 * 3. **生成出死规则。** 生成器按选择器字符串拼接，一旦某处选择器写错，
 *    规则照样生成、照样"看起来对"，但永远匹配不到任何元素。所以每条选择器都要
 *    能回到源 CSS 里找到对应的 gap 声明。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const CSS_OUT = path.join(ROOT, 'pwa', 'css', 'flex-gap-fallback.css');
const HTML = path.join(ROOT, 'pwa', 'index.html');

let pass = 0;
let fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

console.log('[1] 生成物存在且是最新的');
{
  ok(fs.existsSync(CSS_OUT), 'flex-gap-fallback.css 存在');
  const css = fs.readFileSync(CSS_OUT, 'utf8');

  /* 重跑一次生成器（--check 模式），它会比对文件内容是否与当前源 CSS 推导结果一致。
   * 不用 require 那份生成脚本 —— 它顶部有副作用（读文件、写文件），
   * 子进程跑一遍最干净，也顺带验证了脚本本身还能跑。 */
  let upToDate = true;
  let detail = '';
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'gen-flex-gap-fallback.js'), '--check'],
      { cwd: ROOT, stdio: 'pipe' });
  } catch (e) {
    upToDate = false;
    detail = String(e.stdout || '') + String(e.stderr || '');
  }
  ok(upToDate, '★ 兼容层与源 CSS 同步（改了 gap 必须重跑 gen-flex-gap-fallback.js）',
    detail.trim().slice(0, 200));

  ok(/由 scripts\/gen-flex-gap-fallback\.js 生成/.test(css), '文件头标明是生成物，不给人手改的错觉');
}

console.log('\n[2] 每条规则都必须挂在 html.no-flex-gap 下');
{
  const css = fs.readFileSync(CSS_OUT, 'utf8');
  /* 去掉注释后按 } 切块，逐块看选择器 */
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = body.split('}').map((b) => b.trim()).filter(Boolean);

  let leaked = [];
  let badProp = [];
  let count = 0;

  for (const b of blocks) {
    const brace = b.indexOf('{');
    if (brace < 0) continue;
    const sel = b.slice(0, brace).trim();
    const decl = b.slice(brace + 1).trim();
    count += 1;

    for (const one of sel.split(',').map((s) => s.trim())) {
      if (!one) continue;
      /* ★ 前缀少一个字母，现代浏览器就会吃双重间距。这条是本文最关键的一条断言。 */
      if (one.indexOf('html.no-flex-gap ') !== 0) leaked.push(one);
      if (!/>\s*\*\s*\+\s*\*\s*$/.test(one)) leaked.push(one + '（没用 > * + * 相邻选择器）');
    }
    /* 只允许出现 margin-*（不允许顺手加 padding / transform 之类） */
    const props = decl.split(';').map((d) => d.trim()).filter(Boolean);
    for (const p of props) {
      if (!/^margin-(left|top)\s*:/.test(p)) badProp.push(sel + ' { ' + p + ' }');
    }
  }

  ok(count > 50, '规则数量合理（当前 ' + count + ' 条，源 CSS 有 76 处可补的 flex gap）');
  ok(leaked.length === 0, '★ 所有选择器都带 html.no-flex-gap 前缀且用相邻选择器', leaked.slice(0, 5).join(' | '));
  ok(badProp.length === 0, '★ 只写了 margin-left / margin-top，没混进别的属性', badProp.slice(0, 5).join(' | '));
}

console.log('\n[3] 选择器都能回到源 CSS 找到对应的 gap');
{
  /* 用真正的解析器找「选择器完全相等且有 gap 声明」的规则，而不是靠正则猜。
   * 第一版按「末尾类名」回溯，结果 .ls #records-data / .auth-field label /
   * .guide-facts li 这些以 id 或标签结尾的选择器全被判成死规则 —— 是判定太窄，不是生成物有问题。 */
  const { stripComments, parseBlocks } = require('../../scripts/lib/css-blocks');
  const srcRules = [];
  for (const rel of ['pwa/css/style.css', 'pwa/css/records.css']) {
    const css = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    for (const r of parseBlocks(css)) {
      if (/(^|[^-\w])gap\s*:/.test(r.body)) srcRules.push(r.selector);
    }
  }

  const css = fs.readFileSync(CSS_OUT, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const sels = [];
  for (const b of css.split('}')) {
    const brace = b.indexOf('{');
    if (brace < 0) continue;
    b.slice(0, brace).split(',').forEach((s) => {
      const t = s.trim().replace(/^html\.no-flex-gap\s+/, '').replace(/\s*>\s*\*\s*\+\s*\*\s*$/, '');
      if (t) sels.push(t);
    });
  }

  const dead = sels.filter((s) => srcRules.indexOf(s) < 0);
  ok(dead.length === 0, '★ 没有生成出来却匹配不到元素的死规则', dead.slice(0, 5).join(' | '));
  ok(sels.length > 0, '从生成物里解出 ' + sels.length + ' 个容器选择器');
}

console.log('\n[4] index.html 的检测与加载');
{
  const html = fs.readFileSync(HTML, 'utf8');

  ok(/no-flex-gap/.test(html), '★ 页面里挂了 .no-flex-gap 这个 class');
  ok(/row-gap\s*:\s*2px/.test(html), '★ 检测用的是真实渲染探测（造 column flex + row-gap），不是 UA 判断');
  ok(/getBoundingClientRect\(\)\.height/.test(html), '用实测高度判定，不猜');

  /* 检测失败要按「支持」处理：否则现代浏览器也可能被误判，
   * gap 和 margin 双重生效 —— 那是所有人一起坏，不是少数老内核。 */
  ok(/catch\s*\(e\)\s*\{\s*\/\*[^]*?支持/.test(html) || /catch[\s\S]{0,200}?return;/.test(html),
    '★ 检测抛异常时按「支持」处理（宁可老内核没间距，也不要全体双重间距）');

  /* 注意这里查的是 HTML 里的**属性写法**，不是 CSS 选择器语法（第一版写成了
   * meta[name="app-version"]，那是 querySelector 的写法，在 HTML 源码里当然找不到）。 */
  const verAt = html.indexOf('name="app-version"');
  const detectAt = html.indexOf('no-flex-gap');
  ok(verAt > 0, '页面里有 app-version meta');
  ok(verAt > 0 && detectAt > verAt, '★ 检测脚本在 app-version 之后（要读它拼版本号）',
    'meta@' + verAt + ' 检测@' + detectAt);

  ok(/flex-gap-fallback\.css/.test(html), '页面会加载兼容层');
  ok(/link\.href\s*=\s*'\.\/css\/flex-gap-fallback\.css'\s*\+\s*\(ver/.test(html),
    '★ 兼容层的 URL 跟随 app-version，不会因为漏改而让老内核一直吃旧缓存');

  /* 兼容层是动态插入的，不能被 preload —— preload 会强制所有浏览器都下载它，
   * 那就等于「现代浏览器白下 5KB」，正好抵消掉这个方案的全部好处。 */
  ok(!/preload[^>]*flex-gap-fallback/.test(html), '★ 兼容层没有被 preload（它只该给需要的人下）');
}

console.log('\n[5] 不预缓存：它只服务少数内核');
{
  const sw = fs.readFileSync(path.join(ROOT, 'pwa', 'sw.js'), 'utf8');
  const precache = sw.slice(sw.indexOf('const PRECACHE'), sw.indexOf('];', sw.indexOf('const PRECACHE')));
  ok(precache.indexOf('flex-gap-fallback') < 0,
    '★ 兼容层不在 PRECACHE 里（现代浏览器占 99%，预缓存等于让它白下一份用不到的 CSS）');
}

console.log('\n========================================');
console.log(fail === 0 ? '全部通过' : '有失败');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
