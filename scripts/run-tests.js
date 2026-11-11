/**
 * 测试跑批器
 * 跑法：npm test
 *
 * 为什么要它：以前 `npm test` 是一条手写的长链
 *   `node pwa/test/a.test.js && node pwa/test/b.test.js && …`
 * 每加一个测试文件都要手动往链里插。用脚本插入时如果锚点没匹配上，
 * `String.replace` 会静默什么都不做 —— 结果就是 v47/v48 写的 7 套测试
 * （config-sync / double-bust / ws-buffer / leaderboard-cache /
 *   login-ip-limit / nickname / split-reconnect）**从来没被跑过**，
 * 而当时的"通过 1378 项"里根本没算上它们。
 *
 * 改成扫描目录之后，新增测试只要放进 pwa/test 或 server/test 就自动纳入，
 * 不存在"忘了挂进去"这个失败模式。
 *
 * 行为：
 *  - 串行执行（测试会抢端口、写临时档案，并行会互相干扰）
 *  - 单个文件超时 120s，超时算失败并继续跑后面的（别让一个卡死拖垮整轮）
 *  - 通过的只打一行，失败的打完整输出 —— CI 日志里一眼能找到红的那条
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIRS = ['pwa/test', 'server/test'];
const PER_FILE_TIMEOUT_MS = 120000;

function listTests() {
  const out = [];
  for (const d of DIRS) {
    const abs = path.join(ROOT, d);
    let names;
    try { names = fs.readdirSync(abs); } catch (e) { continue; }
    names
      .filter((f) => /\.test\.js$/.test(f))
      .sort()
      .forEach((f) => out.push(path.join(d, f)));
  }
  return out;
}

/** 从输出里取「通过 N 项，失败 M 项」；拿不到就数 PASS/FAIL 行 */
function parseCounts(out) {
  const m = /通过\s*(\d+)\s*项[，,]\s*失败\s*(\d+)\s*项/.exec(out);
  if (m) return { pass: Number(m[1]), fail: Number(m[2]) };
  const p = (out.match(/^\s*PASS\s/gm) || []).length;
  const f = (out.match(/^\s*FAIL\s/gm) || []).length;
  return { pass: p, fail: f };
}

function main() {
  const files = listTests();
  if (!files.length) {
    console.error('没有找到任何测试文件');
    process.exit(1);
  }

  const t0 = Date.now();
  const failed = [];
  let totalPass = 0, totalFail = 0;

  console.log('发现 ' + files.length + ' 个测试文件，开始串行执行\n');

  files.forEach((rel, i) => {
    const label = '[' + String(i + 1).padStart(2, '0') + '/' + files.length + '] ' + rel;
    const r = spawnSync(process.execPath, [path.join(ROOT, rel)], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: PER_FILE_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024
    });

    const out = (r.stdout || '') + (r.stderr || '');
    const c = parseCounts(out);
    totalPass += c.pass;
    totalFail += c.fail;

    const timedOut = r.error && r.error.code === 'ETIMEDOUT';
    /* 「一条断言都没数到」本身就是缺陷，不能算通过。
     *
     * 这个坑真踩过：五个文件把汇总写成「N 项通过」，而 parseCounts 的正则是
     * 「通过 N 项，失败 M 项」，于是它们各自几十条断言在总账里一直是 0。
     * 每一行都显示绿，总数看起来也合理，只是「163 文件 / N 断言」这句话
     * 一直在少算整整一百多条。
     *
     * 没有合法的「0 断言测试文件」—— 那它就不是测试。所以直接判红。 */
    const noCount = r.status === 0 && c.pass === 0 && c.fail === 0;
    const bad = timedOut || r.status !== 0 || c.fail > 0 || noCount;

    if (bad) {
      failed.push({ rel: rel, out: out, status: r.status, timedOut: !!timedOut });
      const why = timedOut ? '超时 ' + PER_FILE_TIMEOUT_MS + 'ms'
        : (noCount ? '一条断言都没数到（汇总行格式不对？应为「通过 N 项，失败 M 项」）'
          : 'exit ' + r.status);
      console.log('  ✗ ' + label + '  (' + why + ')');
    } else {
      console.log('  ✓ ' + label + '  ' + c.pass + ' 项');
    }
  });

  /* 失败详情统一放最后：CI 日志里红的那条永远在最下面 */
  if (failed.length) {
    console.log('\n================ 失败详情 ================\n');
    failed.forEach((f) => {
      console.log('----- ' + f.rel + '  ' + (f.timedOut ? '(超时)' : '(exit ' + f.status + ')') + ' -----');
      console.log(f.out.trim() || '(没有输出)');
      console.log('');
    });
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('========================================');
  console.log('文件 ' + files.length + ' 个，通过 ' + (files.length - failed.length) + ' 个，失败 ' + failed.length + ' 个');
  console.log('断言 ' + totalPass + ' 项通过，' + totalFail + ' 项失败，耗时 ' + secs + 's');
  console.log('========================================');

  process.exit(failed.length ? 1 : 0);
}

main();
