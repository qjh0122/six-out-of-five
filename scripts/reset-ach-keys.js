/**
 * 成就键定点清零（线上运维脚本）—— 默认只预演
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 什么时候用它
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 某个成就的**判定写错了**，攒下一批数学上不可能成立的数字。
 * 实例：r9 / r10 / r12 判据错位，全操一个人 235 场却有 801 次「你咋这幸」
 * （那条要求「全场只有我一个人正分」）。
 *
 * 它做两件事，**必须一起做**：
 *   1. 把 `ach` 里这几个键清零 —— 页面上立刻变暗；
 *   2. 把 `achBase.counts` 里同样的键清零 —— 否则下次重放以基线为起点，
 *      那个 801 又被叠回来，看起来像「修了没用」。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 用法
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   LXW_URL='https://<host>/?sharecode=XXX' \
 *     node scripts/reset-ach-keys.js --keys r9,r10,r12          # 预演，打原值
 *
 *   LXW_URL='...' node scripts/reset-ach-keys.js --keys r9,r10,r12 --apply
 *
 * 密钥默认读 `~/.lxw-appdata/backup-key.txt`，也可以用 BACKUP_KEY 环境变量给。
 *
 * 为什么不是「拉备份 → 本地改 → restore 推回去」：restore 是整份覆盖，
 * 拉取到推送之间任何人打的牌都会被冲掉。这条路由只动指定的计数器。
 *
 * 退出码：0 = 完成（预演也算完成）；1 = 失败，**不要在当前状态继续下一步**。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_HOME = path.join(os.homedir(), '.lxw-appdata');
/* 密钥位置按优先级找：显式指定的 → 数据目录 → 仓库里的 server/backup-key.txt。
 * 最后那个是历史默认位置（gitignore 里挡着），运维跑过 backup-leaderboard.js 的本机
 * 一般只有它 —— 少列一处就是「脚本说缺密钥，但密钥明明在」，白折腾一轮。 */
const KEY_FILES = [
  process.env.BACKUP_KEY_FILE,
  path.join(DATA_HOME, 'backup-key.txt'),
  path.join(__dirname, '..', 'server', 'backup-key.txt')
].filter(Boolean);

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : '';
}
function has(name) {
  return process.argv.indexOf(name) >= 0;
}

const APPLY = has('--apply');
const KEYS = String(arg('--keys') || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const RAW_URL = process.env.LXW_URL || (process.argv[2] && /^https?:/.test(process.argv[2]) ? process.argv[2] : '');

function readKey() {
  if (process.env.BACKUP_KEY) return String(process.env.BACKUP_KEY).trim();
  for (let i = 0; i < KEY_FILES.length; i += 1) {
    try {
      const k = fs.readFileSync(KEY_FILES[i], 'utf8').trim();
      if (k) return k;
    } catch (e) { /* 换下一个位置 */ }
  }
  return '';
}

function fail(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

(async function main() {
  if (!RAW_URL) fail('缺少线上地址：LXW_URL=\'https://<host>/?sharecode=XXX\' node scripts/reset-ach-keys.js --keys ...');
  if (!KEYS.length) fail('必须显式给 --keys r9,r10,r12（不给就全清等于删数据，接口也不接受）');
  const key = readKey();
  if (!key) fail('缺少备份密钥：找过 ' + KEY_FILES.join(' / ') + '，也没有 BACKUP_KEY 环境变量');

  /* 地址这样拼：**保留 query，只换 path**。
   * 直接 `base + '/api/...'` 会拼成 `/?sharecode=X/api/...` —— 路径跑到 query 后面去了，
   * 网关拿不到它认的路径，回 403，看起来像「密钥不对」，其实是 URL 拼错。 */
  let url;
  try {
    const u = new URL(RAW_URL);
    u.pathname = '/api/admin/ach-reset';
    url = u.toString();
  } catch (e) {
    fail('线上地址不合法：' + RAW_URL);
  }

  async function post(dryRun) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-backup-key': key },
      body: JSON.stringify({ keys: KEYS, dryRun: dryRun })
    });
    let j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    if (!j || j.ok !== true) {
      fail('接口返回失败（HTTP ' + r.status + '）：' + ((j && j.error) || '无法解析响应'));
    }
    return j;
  }

  /* 预演：把每个人的原值打出来。要看见「谁、哪个键、多少」——
   * 只说「会影响 9 份档案」不够，那是笔没法对账的账。 */
  const plan = await post(true);
  console.log('预演：' + plan.keys.join(',') + ' → 涉及 ' + plan.profiles + ' 份档案 / '
    + plan.cells + ' 格，基线里另有 ' + plan.baseCells + ' 格');
  if (plan.skipped && plan.skipped.length) {
    console.log('白名单外、已忽略：' + plan.skipped.join(','));
  }
  (plan.detail || []).forEach((row) => {
    const cells = Object.keys(row.keys).map((k) => k + '=' + row.keys[k]).join('  ');
    console.log('  · ' + row.id + '  ' + cells);
  });

  if (!APPLY) {
    console.log('\n这是预演。加 --apply 才会真的清零（清零不可撤销，想留着就先跑一次备份）。');
    return;
  }

  const done = await post(false);
  console.log('\n已清零：' + done.keys.join(',') + ' → ' + done.profiles + ' 份档案 / '
    + done.cells + ' 格（基线 ' + done.baseCells + ' 格）');
  console.log('下一步：让客户端刷新一次成就页，数字应当立刻变暗；'
    + '之后新打的牌从 0 开始重新累计。');
})().catch((e) => fail(e && e.message ? e.message : String(e)));
