/**
 * 云端自动对战（真实账号 · 多人 · 战绩落库）—— 命令行入口
 *
 * 协议实现全在 `server/botClient.js`，后台「模拟对战」页面用的是**同一份**。
 * 这里只负责：读参数 → 登录 → 逐场打 → 核对榜单 → 退出码。
 *
 * 什么时候用命令行、什么时候用后台：
 *   · 命令行：一次性的、需要自己指定账号文件与节奏、要留在 CI 或日志里
 *   · 后台  ：在网页上点几下就能跑，能看进度和逐把明细
 *   两者跑出来的数据完全一样（同一个协议客户端、同一套落库规则）。
 *
 * 用法：
 *   node scripts/cloud-bot-match.js \
 *     --base https://xxx.app.workbuddy.host \
 *     --code <sharecode> \
 *     --accounts accounts.json \
 *     --rooms 4 --hands-per-room 3
 *
 * accounts.json 内容（2~5 个，推荐 3；顺序即座位顺序）：
 *   [{ "name": "账号甲", "password": "..." }, { "name": "账号乙", "password": "..." }]
 *
 * 参数：
 *   --base <url>           线上地址，必填（本地自测可给 http://127.0.0.1:3999）
 *   --code <sharecode>     部署网关的分享口令；本地自测不用给
 *   --accounts <file>      账号文件，必填
 *   --rooms <n>            打几场（一个房间算一场），默认 3
 *   --hands <n>            另一种说法：总共打几把，脚本自己换算成场数
 *   --hands-per-room <n>   每场打几把，只能取 3/5/10/15/30（建房白名单），默认 3
 *   --pace-min/--pace-max  每轮提交前的停顿区间（毫秒），默认 900 / 2600
 *   --gap-min/--gap-max    把与把之间的停顿区间（毫秒），默认 2000 / 6000
 *   --log-dir <dir>        每场流水写到哪，默认 runtime/
 *   --register             账号不存在时先注册（**只给本地自测用**，线上别开）
 *   --dry-run              只登录 + 读排行榜，不进房
 *
 * 退出码：0 全部成功；1 有失败（中途失败会打印失败在哪一步）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { BotClient, CancelledError, createApi, playOneRoom, sleep } = require('../server/botClient.js');

/* ============================ 参数 ============================ */

function argOf(name, dflt) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return dflt;
}

const HAS = (n) => process.argv.includes(n);

const BASE = String(argOf('--base', process.env.LXW_BASE || '')).replace(/\/+$/, '');
const CODE = String(argOf('--code', process.env.LXW_CODE || ''));
const ACC_FILE = argOf('--accounts', '');
const HANDS_PER_ROOM = Number(argOf('--hands-per-room', 3));
const PACE = [Number(argOf('--pace-min', 900)), Number(argOf('--pace-max', 2600))];
const GAP = [Number(argOf('--gap-min', 2000)), Number(argOf('--gap-max', 6000))];
const LOG_DIR = path.resolve(argOf('--log-dir', path.join(__dirname, '..', 'runtime')));
const DO_REGISTER = HAS('--register');
const DRY = HAS('--dry-run');

/** 建房时服务端只认这几个值（`stateMachine.handLimitOptions`） */
const HAND_LIMITS = [3, 5, 10, 15, 30];

const ROOMS = (function () {
  const explicit = Number(argOf('--rooms', 0));
  if (explicit > 0) return Math.floor(explicit);
  const total = Number(argOf('--hands', 0));
  if (total > 0) return Math.max(1, Math.ceil(total / HANDS_PER_ROOM));
  return 3;
})();
const TOTAL_HANDS = ROOMS * HANDS_PER_ROOM;

function fail(msg) {
  console.error('\n✗ ' + msg + '\n');
  process.exit(1);
}
function step(msg) { console.log('\n=== ' + msg + ' ==='); }
function line(msg) { console.log('  ' + msg); }

/* ============================ 主流程 ============================ */

function loadAccounts() {
  if (!ACC_FILE) fail('缺少 --accounts（账号文件）。内容示例：[{"name":"甲","password":"..."}]');
  const p = path.resolve(ACC_FILE);
  if (!fs.existsSync(p)) fail('账号文件不存在：' + p);
  const raw = fs.readFileSync(p, 'utf8');
  let list;
  if (/^\s*\[/.test(raw)) {
    list = JSON.parse(raw);
  } else {
    /* 也接受「账号 密码」一行一个的纯文本，方便手写 */
    list = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).filter((s) => !s.startsWith('#'))
      .map((s) => { const m = s.split(/[\s,]+/); return { name: m[0], password: m[1] }; });
  }
  if (!Array.isArray(list) || list.length < 2) fail('至少需要 2 个账号（服务端 MIN_PLAYERS=2），推荐 3 个');
  if (list.length > 5) fail('最多 5 个账号（服务端 MAX_PLAYERS=5）');
  list.forEach((a, i) => { if (!a || !a.name || !a.password) fail('第 ' + (i + 1) + ' 个账号缺 name 或 password'); });
  return list;
}

function appendLog(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(obj) + '\n');
  } catch (e) { /* 写日志失败不能挡住对局 */ }
}

function fmtScores(o) {
  return Object.keys(o).map((k) => k + ' ' + (o[k] > 0 ? '+' : '') + o[k]).join(' / ');
}

async function main() {
  if (!BASE) fail('缺少 --base（线上地址）');
  if (!HAND_LIMITS.includes(HANDS_PER_ROOM)) fail('--hands-per-room 只能取 ' + HAND_LIMITS.join(' / '));
  const accounts = loadAccounts();

  step('参数');
  line('目标   ' + BASE + (CODE ? '（sharecode 已带）' : '（本地，无 sharecode）'));
  line('场次   ' + ROOMS + ' 场 × ' + HANDS_PER_ROOM + ' 把 = ' + TOTAL_HANDS + ' 把');
  line('账号   ' + path.resolve(ACC_FILE) + '（' + accounts.length + ' 个真实账号，不补 AI —— 补了就不进排行榜）');
  line('节奏   每轮停 ' + PACE[0] + '~' + PACE[1] + 'ms，把间停 ' + GAP[0] + '~' + GAP[1] + 'ms');

  const api = createApi({ base: BASE, code: CODE });

  step('登录 + 连 ws');
  const bots = [];
  for (let i = 0; i < accounts.length; i++) {
    const b = new BotClient({
      base: BASE, code: CODE, account: accounts[i], index: i,
      log: line, register: DO_REGISTER, api: api
    });
    await b.login();
    await b.connect();
    bots.push(b);
  }

  const beforeBoard = await api.leaderboard();
  const before = {};
  beforeBoard.forEach((r) => { before[r.playerId] = r; });
  line('排行榜基线：' + bots.map((b) => {
    const r = before[b.playerId];
    return b.nickname + (r ? ' ' + r.games + '场/' + r.totalNet + '分' : ' 未上榜');
  }).join(' · '));

  if (DRY) {
    step('--dry-run：到此为止');
    bots.forEach((b) => b.close());
    return;
  }

  const logFile = path.join(LOG_DIR, 'bot-match-' + new Date().toISOString().slice(0, 10) + '.jsonl');
  const bad = [];

  for (let i = 1; i <= ROOMS; i++) {
    step('第 ' + i + ' / ' + ROOMS + ' 场（' + HANDS_PER_ROOM + ' 把）');
    let res;
    try {
      res = await playOneRoom(bots, HANDS_PER_ROOM, {
        pace: PACE,
        gap: GAP,
        onRoomStart: (e) => line('建房 ' + e.roomId + '（' + e.handLimit + ' 把）'),
        onHand: (e) => console.log('    第 ' + e.handNo + ' 把 · 分数 ' + fmtScores(e.scores) + (e.settled ? ' · 本场结束' : ''))
      });
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      line('这场失败了：' + e.message);
      bad.push({ room: i, error: e.message });
      /* 房间已经崩了就重连一次，别让一场失败拖死后面所有场 */
      for (const b of bots) { try { b.close(); } catch (err) { /* 忽略 */ } }
      await sleep(1200);
      for (const b of bots) { await b.connect(); }
      continue;
    }
    appendLog(logFile, {
      at: new Date().toISOString(), room: res.roomId, hands: res.hands,
      endReason: res.endReason, voided: res.voided, scores: res.scores
    });
    line('本场结束 ' + res.roomId + ' · ' + res.hands + ' 把 · ' + (res.endReason || '—') + (res.voided ? ' · 作废（不落库）' : ''));
    Object.keys(res.scores).forEach((pid) => {
      const s = res.scores[pid];
      line('    ' + s.nickname + ' 累计 ' + s.score + '（本场 ' + (s.delta >= 0 ? '+' : '') + s.delta + '）');
    });
  }

  step('排行榜核对（战绩到底有没有落库）');
  const afterBoard = await api.leaderboard();
  const after = {};
  afterBoard.forEach((r) => { after[r.playerId] = r; });
  let okCount = 0;
  bots.forEach((b) => {
    const a = after[b.playerId];
    const o = before[b.playerId];
    if (!a) { line(b.nickname + ' ✗ 不在排行榜上（这一场没落库）'); return; }
    const dg = a.games - (o ? o.games : 0);
    const dn = a.totalNet - (o ? o.totalNet : 0);
    if (dg > 0) okCount += 1;
    line(b.nickname + ' 场次 ' + (o ? o.games : 0) + ' → ' + a.games + '（+' + dg + '） · 净胜 ' +
      (o ? o.totalNet : 0) + ' → ' + a.totalNet + '（' + (dn >= 0 ? '+' : '') + dn + '） · 胜率 ' + a.winRate + '%' +
      (dg > 0 ? '  ✓' : '  ✗ 场次没涨'));
  });

  line('流水   ' + logFile);

  if (bad.length) {
    step('失败汇总');
    bad.forEach((x) => line('第 ' + x.room + ' 场：' + x.error));
  }
  if (okCount < bots.length) {
    line('有 ' + (bots.length - okCount) + ' 个账号场次没涨 —— 多半是那一场被作废（voided）或没打满把数');
    process.exitCode = 1;
  }

  bots.forEach((b) => b.close());
  console.log('\n完成：' + ROOMS + ' 场 / ' + TOTAL_HANDS + ' 把目标，实际有 ' + okCount + '/' + bots.length + ' 个账号场次上涨。');
}

main().catch((e) => {
  console.error('\n中止：' + e.message);
  process.exit(1);
});
