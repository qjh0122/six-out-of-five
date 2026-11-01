/**
 * 测试用的「源码读取」统一入口
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 * v108 把 game.js（8168 行）拆成 1 主 + 8 模块之后，35 个测试文件里的 31 处
 * `readFileSync('js/game.js')` 全部变成假失败 —— 代码本身没坏，只是搬了家。
 *
 * 处理这件事有两条路，选错方向就会把测试换掉：
 *
 *   ✗ 把断言删掉或放宽 —— 看起来立刻全绿，实际是拿测试换结构（BACKLOG C1 记过这个坑）
 *   ✓ 让读取跟上文件布局 —— 断言一个字不改，只是它读的地方变了
 *
 * 本文件走第二条。
 *
 * ── 为什么默认是「全部拼接」而不是「指到具体模块」───────────────
 * 绝大多数守卫问的是「这条规则写没写对」（正则匹配某段实现），而不是
 * 「它必须在哪个文件里」。这类守卫读拼接后的全文，**判别力一点没降**：
 * 匹配的正则还是那条，代码还是那段代码，只是它可能住在 8 个文件之一。
 *
 * 少数确实该指到具体文件的（比如「结算序列的实现」），测试里可以显式用
 * `readOne('settleView.js')` —— 那种情况下精确指向反而比读全文更强，
 * 因为它顺带守住了「这段代码没被搬回 game.js」。
 *
 * ── 拼接时为什么加分隔注释 ──────────────────────────────────────
 * 守卫挂掉时要能一眼看出「它匹配的是哪个文件」，否则对着一坨拼接文本
 * 猜是哪份源码，排查成本比原来还高。
 */
const fs = require('fs');
const path = require('path');

const JS_DIR = path.join(__dirname, '..', '..', 'js');

/* 顺序与 index.html 的 <script> 顺序一致（gameUtils 必须第一）：
 * 读源码的测试有时会做「A 在 B 之前」的判断，顺序对了才和浏览器里一致。 */
const MODULES = [
  'gameUtils.js',
  'cardView.js',
  'modalKit.js',
  'historyKit.js',
  'accountView.js',
  'settleView.js',
  'seatSheetView.js',
  'recordsView.js',
];

function readFileSafe(name) {
  try {
    return fs.readFileSync(path.join(JS_DIR, name), 'utf8');
  } catch (e) {
    /* 读不到就返回空串，让断言自己报「找不到」——
     * 在这里抛异常会把整个测试文件炸掉，看不出是哪条守卫失败。 */
    return '';
  }
}

/** 只读 game.js 本体（主控制器） */
function readMain() {
  return readFileSafe('game.js');
}

/** 只读某一个模块（名字带 .js） */
function readOne(name) {
  return readFileSafe(name);
}

/**
 * game.js + 8 个模块，用分隔注释拼起来。
 * 这是绝大多数源码守卫应该用的那个。
 */
function readAll() {
  const parts = [readFileSafe('game.js')];
  MODULES.forEach(function (m) {
    parts.push('/* ===== ' + m + ' ===== */\n' + readFileSafe(m));
  });
  return parts.join('\n');
}

module.exports = { readAll, readMain, readOne, MODULES };
