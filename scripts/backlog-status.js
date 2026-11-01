/**
 * BACKLOG 状态行工具
 *
 * 为什么要有：`docs/BACKLOG.md` 里「这条关了没有」以前只能靠标题里写没写「已修 / 已做」，
 * 而实际出现过 **5 种以上**写法（已修 / 已做 / 已解决 / 已定口径 / 归零 / 做成开关 / 已完成）。
 * 于是任何按标题 grep 的统计都必错 —— v108 那份 review 数出「开放 19 条」，
 * 逐条实读是 17 条，差的 2 条就是被写法骗过去的。
 *
 * 用法：
 *   node scripts/backlog-status.js           打印统计（按 status 分组计数 + 开放清单）
 *   node scripts/backlog-status.js --check   有任何条目缺 STATUS 行就退出码 1（可挂 CI）
 *
 * 口径（写死，别再各自解释）：
 *   open    还要做
 *   closed  已关闭（标题里应能看到版本号）
 *   record  实现记录 / 记账，不是待办（例如「某功能已上线，这里是当时的做法」）
 *   watch   刻意接受、只观察（平台限制之类，不值得排期）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'docs', 'BACKLOG.md');
const RE_ITEM = /^### (\S+)\s+(.*)$/;
const RE_STATUS = /<!--\s*STATUS:\s*(open|closed|record|watch)(?:\s*\|\s*([^>]*?))?\s*-->/;

function parse(text) {
  const lines = String(text || '').split('\n');
  const items = [];
  let cur = null;
  lines.forEach((L, i) => {
    const m = RE_ITEM.exec(L);
    if (m) {
      cur = { id: m[1], title: m[2].trim(), line: i + 1, status: null, note: null };
      items.push(cur);
      return;
    }
    if (cur && !cur.status) {
      const s = RE_STATUS.exec(L);
      if (s) { cur.status = s[1]; cur.note = (s[2] || '').trim(); }
    }
  });
  return items;
}

function summarize(items) {
  const by = { open: [], closed: [], record: [], watch: [], unknown: [] };
  items.forEach((it) => { (by[it.status || 'unknown']).push(it); });
  return by;
}

function main() {
  const argv = process.argv.slice(2);
  const text = fs.readFileSync(FILE, 'utf8');
  const items = parse(text);
  const by = summarize(items);

  console.log('BACKLOG 条目 ' + items.length + ' 条');
  ['open', 'closed', 'record', 'watch', 'unknown'].forEach((k) => {
    if (by[k].length) console.log('  ' + k.padEnd(8) + by[k].length + ' 条');
  });

  if (by.open.length) {
    console.log('\n开放中：');
    by.open.forEach((it) => console.log('  ' + it.id + '  ' + it.title.slice(0, 60)));
  }
  if (by.unknown.length) {
    console.log('\n⚠ 缺 STATUS 行的条目（这两个字就是上面说的「按标题猜状态」的老问题）：');
    by.unknown.forEach((it) => console.log('  第 ' + it.line + ' 行  ' + it.id + '  ' + it.title.slice(0, 50)));
  }

  if (argv.includes('--check') && by.unknown.length) {
    console.error('\n✗ ' + by.unknown.length + ' 条缺 STATUS 行');
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { parse, summarize };
