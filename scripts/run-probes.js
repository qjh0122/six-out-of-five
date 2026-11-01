#!/usr/bin/env node
/**
 * 探针跑批器（P0-2 的基础设施）
 *
 * 37 个真浏览器探针以前只能靠人记着一个个跑，结果是「10 个红的跨 9 个版本没人发现」。
 * 这个脚本把它们串起来，输出一份能贴进 review 的清单。
 *
 * 用法：
 *   node scripts/run-probes.js                # 全跑（约 20 分钟）
 *   node scripts/run-probes.js leave tenhalf  # 只跑名字含 leave / tenhalf 的
 *   node scripts/run-probes.js --list         # 只列清单
 *
 * 判读：
 *   ✓  绿（探针自己打印「通过 N 项，失败 0 项」）
 *   ✗  红（失败数 > 0，或进程非 0 退出）
 *   ‼  崩（异常退出且没有断言汇总 —— 这类最可疑，多半是脚本自己被改坏了）
 *
 * ★ 为什么不并行：每个探针都会起一个独立的 Edge 实例 + HTTP 服务 + WS 端口，
 *   并行跑会抢端口（CDP 端口在 93xx 区间，两个探针撞上就开始互相串消息）。
 *   串行的代价是 20 分钟，值得。
 *
 * ★ 为什么不传视口参数：各探针的参数格式不统一（有的是 `390x844`，有的是
 *   `390 844`，有的不认参数直接写死）。传错格式会让宽高变成 NaN、断言全乱。
 *   这里一律不传，用各自文件里的默认值 —— 想跑特定视口请直接调单个探针。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = __dirname;
/* 默认 4 分钟。全流程巡检（probe-ui-flow 要跑 6 个视口）会超，跑它时设
 * PROBE_TIMEOUT=600000 node scripts/run-probes.js ui-flow */
const PER_PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT) || 240000;

const args = process.argv.slice(2);
const all = fs.readdirSync(DIR)
  .filter((f) => /^probe-.*\.js$/.test(f))
  .sort();

if (args[0] === '--list') {
  all.forEach((f) => console.log(f));
  process.exit(0);
}

const picked = args.length
  ? all.filter((f) => args.some((k) => f.indexOf(k) >= 0))
  : all;

if (!picked.length) {
  console.error('没有匹配的探针：' + args.join(' '));
  process.exit(2);
}

/** 从输出里取「通过 N 项，失败 M 项」 */
function parse(out) {
  const m = /通过\s*(\d+)\s*项[，,]\s*失败\s*(\d+)\s*项/.exec(out);
  if (m) return { pass: Number(m[1]), fail: Number(m[2]) };
  return null;
}

/**
 * 判定一个探针的结果。
 *
 * ★ 不能只认「通过 N 项，失败 M 项」这一种格式 —— 37 个探针里有一批
 *   （table / type-scale / prev-result / devices / landscape 等）根本不打印汇总行，
 *   它们要么用 `process.exitCode = 1`，要么只打 FAIL 行。
 *   第一版只认汇总格式，把这 8 个正常跑完的探针全判成了「崩溃」——
 *   跑批器自己制造假红，比没有跑批器更糟。
 */
function judge(out, status) {
  const stat = parse(out);
  if (stat) return { kind: stat.fail === 0 ? 'ok' : 'fail', stat };

  const fails = (out.match(/^\s*(FAIL|✗)/gm) || []).length;
  if (fails > 0) return { kind: 'fail', stat: { pass: 0, fail: fails } };
  if (status !== 0) {
    /* 「缺少参数」这类是**故意的**：probe-online-smoke 现在必须显式传线上地址
     * （默认地址里带 sharecode，公开仓库里不能留）。它退出 2 是在告诉你怎么用，
     * 不是坏了 —— 单独归一类，别混进红里。 */
    if (/缺少线上地址|用法：node/.test(out)) return { kind: 'skip', stat: null };
    return { kind: 'crash', stat: null };
  }
  /* 没有汇总、没有 FAIL、退出码 0：跑通了，只是这个探针不打汇总。
   * 记为 ok，但打上 noSummary，免得让人以为它有统计数字。 */
  return { kind: 'ok', stat: null };
}

const rows = [];
const t0 = Date.now();

picked.forEach((file, i) => {
  const label = file.replace(/\.js$/, '');
  process.stdout.write('[' + (i + 1) + '/' + picked.length + '] ' + label + ' … ');
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(DIR, file)], {
    timeout: PER_PROBE_TIMEOUT_MS,
    encoding: 'utf8',
    env: process.env,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const secs = Math.round((Date.now() - started) / 1000);
  const verdict = judge(out, r.status);
  const kind = verdict.kind;
  const stat = verdict.stat;

  rows.push({ label, kind, stat, secs, out });
  console.log(
    kind === 'ok' ? '✓ ' + (stat ? stat.pass + ' 项' : '跑通（无汇总）') + ' (' + secs + 's)'
      : kind === 'fail' ? '✗ ' + (stat ? stat.pass + ' 通过 / ' + stat.fail + ' 失败' : '有 FAIL') + ' (' + secs + 's)'
        : kind === 'skip' ? '－ 跳过（需要参数） (' + secs + 's)'
          : '‼ 崩溃 (' + secs + 's) exit=' + r.status
  );
});

const ok = rows.filter((r) => r.kind === 'ok');
const bad = rows.filter((r) => r.kind === 'fail' || r.kind === 'crash');
const skipped = rows.filter((r) => r.kind === 'skip');

console.log('\n========================================');
console.log('探针 ' + rows.length + ' 个：绿 ' + ok.length + ' / 红 ' + bad.length
  + '（其中崩溃 ' + rows.filter((r) => r.kind === 'crash').length + '）'
  + (skipped.length ? ' / 跳过 ' + skipped.length : ''));
console.log('断言 ' + ok.reduce((s, r) => s + (r.stat ? r.stat.pass : 0), 0) + ' 项（只统计全绿的那些）');
console.log('耗时 ' + Math.round((Date.now() - t0) / 1000) + 's');
console.log('========================================');

if (bad.length) {
  console.log('\n================ 未通过 ================');
  bad.forEach((r) => {
    console.log('\n----- ' + r.label + ' (' + (r.kind === 'crash' ? '崩溃' : (r.stat ? r.stat.fail + ' 项失败' : '有 FAIL')) + ') -----');
    /* 只打最后 40 行：探针输出动辄几百行，CI 日志里全打出来会把别的都刷掉，
     * 而失败原因几乎总在最后几行（断言顺序是「先跑通的在前」）。 */
    const lines = r.out.trim().split('\n');
    console.log(lines.slice(-40).join('\n'));
  });
}

process.exit(bad.length ? 1 : 0);
