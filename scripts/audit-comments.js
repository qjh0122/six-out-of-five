/* 注释断言扫描：找出注释里「可机械核对」的说法，供人工复核。
 *
 * 用法：node scripts/audit-comments.js [--nums]
 *
 * 判据（硬性问题）：
 *   注释里用反引号引用的标识符，在**代码正文**（去掉注释后的源码）里完全找不到
 *   —— 说明这个名字只活在注释里，函数改名/删掉了但注释没跟上。
 *
 * 数字断言（默认不打印，--nums 才输出）：
 *   注释里「N 个/种/条/项/处/行」+ 结构名词（文件/请求/入口/字段…），
 *   这类说法最容易被后续提交冲掉。只收集，交给人工判断。
 *
 * 退出码：有硬性问题 → 1。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIR = new Set(['node_modules', '.git', '.git-rewrite', 'dist', 'build', 'assets', '.workbuddy', 'screenshots']);
const EXT = new Set(['.js', '.html', '.css']);

// 通用词：即使代码正文里没有，也不算「引用不存在」
const BUILTIN = new Set([
  'ok', 'error', 'reason', 'room', 'player', 'players', 'id', 'type', 'name', 'data', 'payload',
  'true', 'false', 'null', 'undefined', 'function', 'return', 'var', 'const', 'let', 'if', 'else',
  'map', 'filter', 'forEach', 'then', 'catch', 'push', 'length', 'slice', 'join', 'setTimeout',
  'localStorage', 'sessionStorage', 'BroadcastChannel', 'WebSocket', 'Promise',
  'console.log', 'process.env', 'pwa/', 'server/', 'scripts/',
  // Node 内置 API：注释里提到它是为了和历史实现做对比，不是本仓符号
  'scryptSync',
  /* 以下三个是**外部世界的名字**，不是本仓符号 —— 这条检查只该抓
   * 「注释引用了本仓已不存在的函数/变量」，不该抓「注释里提到了 CSS 单位」：
   *   dvh / svh —— CSS 视口单位，出现在 iOS 26 那条实测注释里，永远不会有同名函数
   *   time_total — curl `-w` 的输出字段名，出现在一条讲计时攻击的注释里
   * 加白名单而不改注释：注释本身是对的，改它等于为了检查变绿去删信息。 */
  'dvh', 'svh', 'time_total',
]);

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXT.has(path.extname(name))) out.push(full);
  }
  return out;
}

/* 把一行注释从源码里剥掉：返回剩余正文，用于「这个名字还在不在代码里」的判断 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

/* 注释里可读的文本（块注释的 * 前缀去掉，保留内容） */
function commentText(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (/^\/\//.test(t)) out.push({ no: i + 1, text: t });
    else if (/^\*/.test(t) && !/^\*\/$/.test(t)) out.push({ no: i + 1, text: t });
    else if (/^\/\*/.test(t)) out.push({ no: i + 1, text: t });
  });
  return out;
}

const files = walk(ROOT, []);
// 全仓正文（去掉注释）：跨文件引用也要算数——`lastResult` 写在 game.js，注释却在 hub.js
const CODE = files.map((f) => stripComments(fs.readFileSync(f, 'utf8'))).join('\n');

/* 只校验「长得像标识符」的引用：foo / foo.bar / foo() 。
 * 带花括号、方括号、问号、空格的那些是描述（`{"version":"dev"}`、`meta[name=app-version]`），
 * 不是名字引用，硬去匹配代码正文只会刷假警报。 */
const IDENT_RE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*(\(\))?$/;

const TICK_RE = /`([^`\n]{2,60})`/g;

// 结构名词：只有「N + 这些词」才算数字断言
const STRUCT_NOUN = '(?:文件|请求|推送|入口|字段|方法|函数|测试|断言|阶段|步骤|分支|参数|路由|接口|类型|来源|规则|锁|服务|进程|计时器|定时器|玩家|座位|房间|轮次|把手|键|层|屏)';
const NUM_RE = new RegExp('([一二两三四五六七八九十\\d]+)\\s*[个种条项处行张轮把场]\\s*' + STRUCT_NOUN, 'g');

const showNums = process.argv.includes('--nums');
let hard = 0;
const reports = [];

for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const raw = fs.readFileSync(f, 'utf8');
  const body = stripComments(raw);
  const hardOnes = [];
  const nums = [];
  for (const L of commentText(raw)) {
    let t;
    TICK_RE.lastIndex = 0;
    while ((t = TICK_RE.exec(L.text))) {
      const tok = t[1].trim();
      if (!tok || /\s/.test(tok)) continue;
      if (!IDENT_RE.test(tok)) continue;          // 描述性文字，不是名字引用
      if (BUILTIN.has(tok)) continue;
      if (/[\u4e00-\u9fa5]/.test(tok)) continue;
      // 名字或它的「裸名」（去掉括号/点分前缀）只要在正文里出现过就算存在
      const bare = tok.replace(/\(\)$/, '').split('.').pop().split('(')[0].replace(/^\.\//, '');
      const inBody = CODE.indexOf(tok) !== -1 || (bare && bare.length > 1 && CODE.indexOf(bare) !== -1);
      if (inBody) continue;
      hardOnes.push({ no: L.no, tok, text: L.text });
      hard++;
    }
    if (showNums) {
      let n;
      NUM_RE.lastIndex = 0;
      while ((n = NUM_RE.exec(L.text))) {
        nums.push({ no: L.no, tok: n[0], text: L.text });
      }
    }
  }
  if (hardOnes.length || nums.length) reports.push({ rel, hardOnes, nums });
}

for (const r of reports) {
  if (r.hardOnes.length) {
    console.log('\n### ' + r.rel);
    for (const x of r.hardOnes) console.log('  [硬] L' + x.no + ' 「' + x.tok + '」 ← ' + x.text.slice(0, 110));
  }
  if (showNums && r.nums.length) {
    if (!r.hardOnes.length) console.log('\n### ' + r.rel);
    for (const x of r.nums) console.log('  [数] L' + x.no + ' 「' + x.tok + '」 ← ' + x.text.slice(0, 110));
  }
}

console.log('\n---');
console.log('硬性问题（注释引用的名字在代码里已不存在）: ' + hard);
console.log('扫描文件: ' + files.length);
process.exit(hard > 0 ? 1 : 0);
