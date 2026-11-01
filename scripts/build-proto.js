/**
 * 原型单文件构建
 *
 * 为什么需要它：原型现在 `<script src="../../pwa/js/engine.js">`，规则只有一份、
 * 永远不会和线上漂移 —— 但代价是不能"拷一个 html 就发出去"。给设计/产品/外部
 * 同事看的时候，缺了 engine.js 会直接白屏。
 *
 * 这个脚本做的不是"再抄一份规则"，而是把**同一份**engine.js 的文本内联进产物：
 *   - 源仍然只有 pwa/js/engine.js 一份，产物是它的一个副本；
 *   - 表情位图一起内联成 data URI，产物可以单独发邮件、丢进 IM；
 *   - 产物是生成物，**不要手改**，改原型请改 circle-table.html 再重新构建。
 *
 * 用法：
 *   node scripts/build-proto.js            生成 dist/circle-table-single.html
 *   node scripts/build-proto.js --check    只校验产物是否与源同步（CI 用，不写文件）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'docs', 'prototypes', 'circle-table.html');
const ENGINE = path.join(ROOT, 'pwa', 'js', 'engine.js');
const ASSET_DIR = path.join(ROOT, 'docs', 'prototypes');
const OUT_DIR = path.join(ROOT, 'dist');
const OUT = path.join(OUT_DIR, 'circle-table-single.html');

const CHECK_ONLY = process.argv.includes('--check');

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' };

function dataUri(rel) {
  const abs = path.join(ASSET_DIR, rel);
  if (!fs.existsSync(abs)) throw new Error('素材不存在：' + rel + '（先跑 scripts/crop-emoji.py）');
  const buf = fs.readFileSync(abs);
  const ext = path.extname(rel).slice(1).toLowerCase();
  const mime = MIME[ext];
  if (!mime) throw new Error('不认识的素材类型：' + rel);
  return 'data:' + mime + ';base64,' + buf.toString('base64');
}

function build() {
  let html = fs.readFileSync(SRC, 'utf8');
  let engine = fs.readFileSync(ENGINE, 'utf8');

  /* engine.js 里没有 </script>，但内联进 <script> 前还是把这种情况挡掉，
   * 否则以后引擎里加了一句字符串就会把整个页面截断。 */
  if (/<\/script/i.test(engine)) throw new Error('engine.js 里出现 </script，不能直接内联');

  /* ① 引擎：src 换成内联。锚点找不到就直接报错，不静默产出半成品。 */
  const tag = '<script src="../../pwa/js/engine.js"></script>';
  if (html.indexOf(tag) < 0) throw new Error('找不到引擎引用（原型是不是又改回手抄规则了？）');
  html = html.replace(tag,
    '<script>\n/* ===== 内联自 pwa/js/engine.js（同一份文件，由 scripts/build-proto.js 复制，勿手改）===== */\n'
    + engine
    + '\n/* ===== 内联结束 ===== */\n</script>');

  /* ② 表情位图：13 张 PNG 一起内联，产物可以单独外发 */
  const referenced = new Set();
  html = html.replace(/assets\/emoji\/[A-Za-z0-9._-]+\.png/g, (m) => {
    referenced.add(m);
    return dataUri(m);
  });

  /* ③ 收尾：确认没有残留的本地文件引用。
   * 只查「会真的去磁盘找文件」的两种：相对路径的 script/img，和 assets/ 下的位图。
   * 不查所有 src="..."——原型正文里有 `src="' + cardURL(...) + '"` 这种源码片段
   * 和 `/api/avatar` 这类占位注释，它们不是资源引用。 */
  const leftAsset = html.match(/assets\/emoji\/[A-Za-z0-9._-]+\.png/g) || [];
  if (leftAsset.length) throw new Error('产物里还有未内联的位图：' + leftAsset.slice(0, 5).join(', '));
  const leftScript = html.match(/<script[^>]+src="(?!data:)[^"]*"/g) || [];
  if (leftScript.length) throw new Error('产物里还有外链脚本：' + leftScript.join(', '));

  const banner = '<!--\n'
    + '  生成物 —— 请勿手改。\n'
    + '  源文件：docs/prototypes/circle-table.html + pwa/js/engine.js\n'
    + '  重新生成：node scripts/build-proto.js\n'
    + '  这个文件可以单独打开、单独发出去：规则引擎和 13 张表情位图都已内联。\n'
    + '-->\n';
  html = banner + html;

  return { html, referenced: referenced.size };
}

function main() {
  const { html, referenced } = build();
  const kb = (Buffer.byteLength(html) / 1024).toFixed(0);

  if (CHECK_ONLY) {
    if (!fs.existsSync(OUT)) {
      console.error('产物不存在：' + path.relative(ROOT, OUT) + '（跑 node scripts/build-proto.js）');
      process.exit(1);
    }
    const cur = fs.readFileSync(OUT, 'utf8');
    if (cur !== html) {
      console.error('产物与源不同步：' + path.relative(ROOT, OUT) + ' 需要重新构建');
      process.exit(1);
    }
    console.log('产物与源同步（' + kb + ' KB）');
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, html);
  console.log('已生成 ' + path.relative(ROOT, OUT));
  console.log('  体积 ' + kb + ' KB · 内联表情 ' + referenced + ' 张 · 引擎 ' + (Buffer.byteLength(fs.readFileSync(ENGINE)) / 1024).toFixed(0) + ' KB');
  console.log('  可以直接双击打开，也可以单独发给别人');
}

main();
