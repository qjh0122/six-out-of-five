#!/usr/bin/env node
/**
 * 清理探针留下的 Edge 用户目录。
 *
 * 为什么必须有这个脚本：每个 probe-*.js 都用
 *   `--user-data-dir=<tmp>/lxw-xxx-<时间戳>`
 * 起一个一次性 headless Edge，跑完 kill 掉进程，**目录从来没删过**。
 * 一个浏览器配置目录 40~120 MB，而一次全量复验要跑十几个探针、调几何时一天跑几十轮 ——
 * 2026-10-31 就是这样攒到 1354 个目录 / 63.5 GB，把 C 盘写满（剩 0 字节），
 * 连工具回写结果都失败，所有断言一起「红」，看起来像代码坏了。
 *
 * 用法：
 *   node scripts/temp-clean.js              # 删掉全部 lxw-* 目录（保留截图目录）
 *   node scripts/temp-clean.js --dry        # 只统计，不删
 *   node scripts/temp-clean.js --hours 12   # 只删 12 小时以前的（正在跑的探针不受影响）
 *
 * 保留名单里是**截图**目录（lxw-table-* 这类平铺文件不在此列，它们很小）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const hi = argv.indexOf('--hours');
const HOURS = hi >= 0 ? Number(argv[hi + 1]) || 0 : 0;

/* 截图目录：这些里面是 .png，删了就得重跑探针才能再看一眼。 */
const KEEP = new Set([
  'lxw-result-seq', 'lxw-viewport-fit', 'lxw-ready', 'lxw-modals',
  'lxw-avatar', 'lxw-emoji', 'lxw-bigfx', 'lxw-table'
]);

const TMP = os.tmpdir();
const cutoff = HOURS > 0 ? Date.now() - HOURS * 3600 * 1000 : Infinity;

function sizeOf(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let ents;
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of ents) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else {
        try { total += fs.statSync(p).size; } catch (e2) { /* 被删了就算了 */ }
      }
    }
  }
  return total;
}

function rm(dir) {
  /* Node 16.14+ 的 rmSync 在 Windows 上对只读文件也能处理；老版本退回 rmdirSync。
   * force 是必须的：Edge 偶尔留下 locked 文件，删不掉也不该让脚本崩。 */
  try {
    if (fs.rmSync) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    else fs.rmdirSync(dir, { recursive: true });
    return true;
  } catch (e) {
    return false;
  }
}

let n = 0, failed = 0, bytes = 0, kept = 0;
let entries;
try { entries = fs.readdirSync(TMP, { withFileTypes: true }); } catch (e) { entries = []; }

for (const e of entries) {
  if (!e.isDirectory() || !/^lxw-/.test(e.name)) continue;
  if (KEEP.has(e.name)) { kept++; continue; }
  const full = path.join(TMP, e.name);
  let st;
  try { st = fs.statSync(full); } catch (err) { continue; }
  if (st.mtimeMs > cutoff) { kept++; continue; }
  const sz = sizeOf(full);
  if (DRY) { bytes += sz; n++; continue; }
  if (rm(full)) { bytes += sz; n++; } else failed++;
}

const gb = (bytes / 1073741824).toFixed(2);
if (DRY) {
  console.log('（dry）可删 ' + n + ' 个探针目录，约 ' + gb + ' GB；保留 ' + kept + ' 个');
} else {
  console.log('已删 ' + n + ' 个探针目录，释放 ' + gb + ' GB' + (failed ? '（' + failed + ' 个删不掉：多半有进程占着）' : '') + '；保留 ' + kept + ' 个');
}
