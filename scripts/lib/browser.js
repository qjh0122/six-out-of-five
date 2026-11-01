/**
 * 浏览器定位（探针 / 巡检 / journey 共用）
 *
 * 为什么要有这个文件：41 个脚本里都写死了
 *   `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`
 * 于是它们只能在「装了 Edge 的 Windows」上跑 —— 这就是「45 个探针一个都不在 CI」的
 * 真实原因。不是不想挂，是挂上去必然全红。
 *
 * 探测顺序（先看显式指定，再看平台默认）：
 *   1. 环境变量 PROBE_BROWSER / EDGE_BIN / CHROME_PATH
 *   2. Linux：/usr/bin/google-chrome、/usr/bin/chromium、chromium-browser、snap 路径
 *   3. macOS：Google Chrome 与 Edge 的 app 包内可执行文件
 *   4. Windows：Edge 与 Chrome 的常见安装位置（Program Files / LocalAppData）
 *
 * 找不到就抛错，**不要**回落到一个猜的路径 —— 那样报错会变成
 * 「连不上 CDP（端口被占用？）」这种把人引向错误方向的提示。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function exists(p) {
  try { return !!p && fs.statSync(p).isFile(); } catch (e) { return false; }
}

/** @returns {string[]} 候选路径，按优先级 */
function candidates() {
  const list = [];
  const env = [process.env.PROBE_BROWSER, process.env.EDGE_BIN, process.env.CHROME_PATH];
  env.forEach((p) => { if (p) list.push(p); });

  if (process.platform === 'win32') {
    const bases = [
      process.env['PROGRAMFILES(X86)'],
      process.env.PROGRAMFILES,
      process.env.LOCALAPPDATA
    ].filter(Boolean);
    bases.forEach((b) => {
      list.push(path.join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      list.push(path.join(b, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    });
    list.push('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
    list.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  } else if (process.platform === 'darwin') {
    list.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    list.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    list.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    list.push('/usr/bin/google-chrome');
    list.push('/usr/bin/google-chrome-stable');
    list.push('/usr/bin/chromium');
    list.push('/usr/bin/chromium-browser');
    list.push('/snap/bin/chromium');
    list.push('/usr/lib/chromium/chromium');
  }
  return list;
}

/** 找到就用，找不到抛错（错误信息里带上「试过哪些」） */
function findBrowser() {
  const tried = candidates();
  for (let i = 0; i < tried.length; i++) {
    if (exists(tried[i])) return tried[i];
  }
  throw new Error(
    '找不到可用的浏览器。试过：\n  ' + tried.join('\n  ') +
    '\n请设置环境变量 PROBE_BROWSER 指向 Chrome / Edge / Chromium 的可执行文件。'
  );
}

/**
 * 启动参数里必须补的两项（只在 Linux 上补）：
 *   --no-sandbox         CI 容器里以 root 跑，不关掉会直接崩
 *   --disable-dev-shm-usage  /dev/shm 只有 64MB，不关掉大页面会随机崩
 * 这两个参数在 Windows / macOS 上无效但无害，这里按平台判断，避免无谓改动。
 */
function extraFlags() {
  if (process.platform === 'linux') return ['--no-sandbox', '--disable-dev-shm-usage'];
  return [];
}

module.exports = { findBrowser, extraFlags, candidates, exists };
