/**
 * 发布前备份线上榜单 → 写到一个**仓库外**的种子文件（默认 ~/.lxw-appdata/seed/profiles.json）
 *
 * 为什么需要：部署会上传整个项目目录，项目内的种子文件会被覆盖。
 * 如果容器被重建，主数据文件（~/ .lxw-appdata/profiles.json）不存在时，
 * 启动就用这个种子恢复。所以**每次发布前都要跑这个脚本**，
 * 并把产物随部署放到容器里（或让 SEED_FILE 指到挂载卷）。
 *
 * 为什么不再默认写进 server/data/：本仓库已公开，真实档案不能出现在 working tree 里。
 *
 * 用法：
 *   LXW_URL='https://your-host/?sharecode=XXX' node scripts/backup-leaderboard.js
 *   node scripts/backup-leaderboard.js 'https://your-host/?sharecode=XXX'
 *   SEED_FILE=/mnt/data/seed.json node scripts/backup-leaderboard.js ...
 *
 * 退出码：0 = 已备份（或线上为空，安全）；1 = 拉取失败（**不要继续发布**）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/* 线上地址**不写死**：本仓库是公开的，房号（sharecode）相当于进房口令，
 * 一旦写进代码就是「把门开着」。
 * 用法（三选一）：LXW_URL='https://<host>/?sharecode=<口令>' npm run backup
 *                node scripts/backup-leaderboard.js 'https://<host>/?sharecode=<口令>'
 *                （部署侧把 LXW_URL 配进环境变量，CI / 定时任务就不用带参） */
const DEFAULT_URL = process.env.LXW_URL || '';

/* 产物一律**不落进仓库目录**：本仓库是公开的，真实档案与密钥不该出现在 working tree 里
 * （.gitignore 挡得住手滑，挡不住 `git add -f`）。默认放仓库外的 ~/.lxw-appdata/，
 * 用 SEED_FILE / BACKUP_KEY_FILE 可以改到别处（部署时指向挂载卷即可）。 */
const DATA_HOME = path.join(os.homedir(), '.lxw-appdata');
const SEED_FILE = process.env.SEED_FILE || path.join(DATA_HOME, 'seed', 'profiles.json');
const KEY_FILE = process.env.BACKUP_KEY_FILE || path.join(DATA_HOME, 'backup-key.txt');

/**
 * 备份密钥：?full=1 会导出全部玩家档案（含近 20 场流水），服务端要求带 x-backup-key。
 * 密钥文件放在 server/ 下——静态根是 pwa/，所以外网取不到这个文件。
 * 首次运行会自动生成；**生成后必须随部署一起上传**，否则线上服务端没有密钥会拒绝导出。
 */
function ensureKey() {
  if (process.env.BACKUP_KEY) return String(process.env.BACKUP_KEY).trim();
  try {
    const existing = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (existing) return existing;
  } catch (e) { /* 不存在则生成 */ }
  const key = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  fs.writeFileSync(KEY_FILE, key + '\n', 'utf8');
  console.log('已生成备份密钥 → ' + KEY_FILE);
  console.log('部署时请把它作为 BACKUP_KEY 环境变量传给服务端（不要提交、不要打进镜像层）');
  return key;
}

/**
 * 拼 API 地址。关键：页面链接上的 sharecode 必须带到 API 请求上，
 * 裸 /api/* 会被网关直接 403（这个坑第一次跑备份就踩到了）。
 */
function buildApiUrl(input, pathAndQuery) {
  const src = input || DEFAULT_URL;
  if (!src) {
    throw new Error(
      '缺少线上地址。用 LXW_URL 环境变量或第一个参数传入，形如 https://<host>/?sharecode=<口令>'
    );
  }
  let u;
  try {
    u = new URL(src);
  } catch (e) {
    throw new Error('线上地址不是合法 URL：' + src);
  }
  const api = new URL(pathAndQuery, u.origin);
  u.searchParams.forEach(function (v, k) { api.searchParams.set(k, v); });
  return api.toString();
}

/**
 * 把 `/api/leaderboard?full=1` 的返回转成 ProfileStore 的存储结构 { playerId: profile }。
 *
 * **必须把 `account` 原样带进来**（含 salt / hash）。种子是容器重建时唯一的恢复来源，
 * 少了它，恢复出来的档案没有任何登录凭据：`accountOf()` 返回 null，玩家全部登不进来，
 * 战绩变成没有主人的孤儿记录，而且**没有任何报错**——只是所有人突然"账号不存在"。
 *
 * 这个 bug 真发生过：`profile.js` 的 `dump()` 那边注释明明写着「必须带上 account」，
 * 这里逐字段复制时却漏了它。所以现在把转换单独抽成函数，让测试能直接盯着它。
 */
function buildSeedMap(list) {
  const map = {};
  (Array.isArray(list) ? list : []).forEach(function (p) {
    if (!p || !p.playerId) return;
    /* ★ 这里是**白名单**：新加的字段必须手动补进来，否则备份一次就丢一次。
     * 这个坑踩过两次 —— account（全员登不进来）、
     * 以及 2026-10-30 的 aiGames / aiRecent（备份出来的档案里人机流水全空，
     * 真拿它恢复，战绩页那几行「含人机」就消失了）。longestLoseStreak 也是同一类漏。
     * 所以每加一个档案字段，都要回来改这里 + backup-roundtrip.test.js 加一条断言。 */
    const row = {
      playerId: p.playerId,
      nickname: p.nickname || '',
      games: p.games || 0,
      wins: p.wins || 0,
      losses: p.losses || 0,
      draws: p.draws || 0,
      totalNet: p.totalNet || 0,
      currentStreak: p.currentStreak || 0,
      longestStreak: p.longestStreak || 0,
      longestLoseStreak: p.longestLoseStreak || 0,
      bestNet: p.bestNet || 0,
      recent: Array.isArray(p.recent) ? p.recent.slice(0, 20) : [],
      aiGames: p.aiGames || 0,
      aiRecent: Array.isArray(p.aiRecent) ? p.aiRecent.slice(0, 20) : [],
      updatedAt: p.updatedAt || Date.now()
    };
    if (p.account) row.account = p.account;   // ← 账号能恢复，全靠这一行
    map[p.playerId] = row;
  });
  return map;
}

async function main() {
  const url = buildApiUrl(process.argv[2], '/api/leaderboard?full=1');
  console.log('拉取线上榜单：' + url);

  const key = ensureKey();
  let data;
  try {
    const res = await fetch(url, {
      headers: { 'Cache-Control': 'no-store', 'x-backup-key': key }
    });
    if (res.status === 403) {
      const body = await res.json().catch(function () { return {}; });
      throw new Error('被拒绝（403）：' + ((body && body.error) || '密钥不匹配'));
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.json();
  } catch (e) {
    console.error('拉取失败：' + (e && e.message ? e.message : e));
    console.error('→ 不要发布！否则线上战绩可能丢失。');
    console.error('  403 的两种常见原因：');
    console.error('   ① 线上那版服务端没有带着 server/backup-key.txt 发布过 —— 先发布一次；');
    console.error('   ② 密钥刚轮换过，而线上还是旧密钥 —— 也一样：先发布，或临时用');
    console.error('      BACKUP_KEY=<旧密钥> npm run backup 把这一轮的数据抢下来。');
    process.exit(1);
  }

  const list = (data && data.list) || [];
  if (!list.length) {
    console.log('线上榜单为空，无需备份（种子保持原样，不会覆盖成空）。');
    return;
  }

  const map = buildSeedMap(list);

  const count = Object.keys(map).length;
  if (!count) {
    console.log('榜单里没有可备份的玩家记录（字段不全），保持种子原样。');
    return;
  }

  const dir = path.dirname(SEED_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SEED_FILE + '.tmp', JSON.stringify(map, null, 0), 'utf8');
  fs.renameSync(SEED_FILE + '.tmp', SEED_FILE);

  console.log('已备份 ' + count + ' 位玩家 → ' + SEED_FILE);
  list.slice(0, 5).forEach(function (p, i) {
    console.log('  ' + (i + 1) + '. ' + (p.nickname || p.playerId) + '  ' + p.games + ' 场  净胜 ' + p.totalNet);
  });
  if (list.length > 5) console.log('  …共 ' + list.length + ' 条');
}

/* 只在被当作脚本直接运行时才发请求。
 * 否则测试 require 这个文件就会触发一次真实的线上拉取 + 可能覆盖种子文件。 */
if (require.main === module) main();

module.exports = { buildSeedMap, buildApiUrl };
