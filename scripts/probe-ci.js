/**
 * 探针的跨平台启动器
 *
 * 为什么需要这一层：41 个脚本里硬编码了 Windows 的 Edge 路径，
 * 而它们直接 `spawn(路径, …)`。逐个去改 41 个文件，风险（改错一个就静默失效）
 * 远大于收益；这里在**进程级别**把 spawn 重定向一次，脚本一行不用动。
 *
 * 用法：
 *   node scripts/probe-ci.js scripts/journey.js
 *   node scripts/probe-ci.js scripts/probe-ui-flow.js   // 参数照旧跟在后面
 *
 * 本地 Windows 上它等价于什么都不做（找不到替代路径时就原样调用），
 * 所以在开发机上跑出来的结果和直接 node scripts/xxx.js 完全一致。
 */
'use strict';

const cp = require('child_process');
const os = require('os');
const path = require('path');
const { findBrowser, extraFlags } = require('./lib/browser.js');

const RE_BROWSER = /(msedge|chrome|chromium)(\.exe)?$/i;
const RE_WIN_ABS = /^[A-Za-z]:[\\/]/;

const target = process.argv[2];
if (!target) {
  console.error('用法：node scripts/probe-ci.js <脚本路径> [脚本参数…]');
  process.exit(2);
}

let browser = null;
let lookupErr = null;

function resolveBrowser() {
  if (browser) return browser;
  if (lookupErr) throw lookupErr;
  try {
    browser = findBrowser();
    /* stderr 而不是 stdout：探针的输出格式被 run-probes 用正则解析，混进去会误判。 */
    console.error('[probe-ci] 浏览器：' + browser);
    return browser;
  } catch (e) {
    lookupErr = e;
    throw e;
  }
}

/** 把 Windows 绝对路径形式的参数换成 tmp 下同名目录（CI 里没有 C:\） */
function fixArg(a) {
  if (typeof a !== 'string') return a;
  if (!RE_WIN_ABS.test(a)) return a;
  const m = /^--([\w-]+)=(.*)$/.exec(a);
  if (!m) return a;
  const name = m[1];
  const val = m[2];
  const base = path.basename(val.replace(/\\/g, '/')) || 'profile';
  return '--' + name + '=' + path.join(os.tmpdir(), 'probe-' + base);
}

function dedupeFlags(args) {
  const out = args.slice();
  extraFlags().forEach((f) => { if (out.indexOf(f) < 0) out.push(f); });
  /* --headless 在旧版和新版写法不同，脚本里已经写好了，别动。 */
  return out;
}

const origSpawn = cp.spawn;
cp.spawn = function patchedSpawn(exe, args, opts) {
  let cmd = exe;
  let argv = Array.isArray(args) ? args : [];
  let options = opts;

  if (typeof exe === 'string' && RE_BROWSER.test(exe.replace(/\\/g, '/'))) {
    cmd = resolveBrowser();
    argv = dedupeFlags(argv).map(fixArg);
  }
  return origSpawn.call(this, cmd, argv, options);
};

/* 少数脚本用 spawnSync（导出截图之类），一并覆盖。 */
const origSpawnSync = cp.spawnSync;
cp.spawnSync = function patchedSpawnSync(exe, args, opts) {
  if (typeof exe === 'string' && RE_BROWSER.test(exe.replace(/\\/g, '/'))) {
    return origSpawnSync.call(this, resolveBrowser(), dedupeFlags(Array.isArray(args) ? args : []).map(fixArg), opts);
  }
  return origSpawnSync.call(this, exe, args, opts);
};

/* 目标脚本后面跟的参数转交给它（有些探针从 process.argv 读视口） */
process.argv = [process.argv[0], target].concat(process.argv.slice(3));

try {
  require(path.resolve(target));
} catch (e) {
  console.error('[probe-ci] 启动失败：' + (e && e.message ? e.message : e));
  process.exit(1);
}
