/**
 * 云端玩家档案（服务端聚合）
 *
 * 口径：
 *   - 每场结算由服务端为每个在场玩家记一条结果，前端不参与计算
 *   - 例外：**一分没打就结束的局**（room.voided）整场不记，判据在 hub._persistSettlement，
 *     本模块不自己判断。打过分的中途结束照记，分是真赢真输的。
 *   - 净胜 = 终分 − 初始分（20）
 *   - currentStreak 正数为连胜、负数为连败（前端按正负渲染）
 *   - recent 最多留 20 条，前端取前 5 展示
 *
 * 持久化（两层，防止发布把战绩抹掉）：
 *   1. 主文件放**项目目录之外**（默认 ~/.lxw-appdata/profiles.json）。
 *      部署只会上传项目目录，外面这份不被覆盖，容器不重建就能跨版本存活。
 *   2. 项目内的 data/profiles.json 作为**种子**：容器被重建、主文件不存在时
 *      用它恢复。发布前跑 scripts/backup-leaderboard.js 把线上榜单写进种子。
 *   注意：主文件「存在即权威」——哪怕内容是 {}。人工清空不会被种子反向还原。
 */
'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const { cleanNickname } = require('./text.js');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const auth = require('./auth');

/* 这里原本有一份 `const INITIAL_SCORE = 20`，并且从本模块导出。
 * 但全仓没有任何地方 require 它 —— hub.js 算净胜用的是 `CONFIG.INITIAL_SCORE`
 * （来自 pwa/js/config.js），这份副本既没人读、又会在改配置时悄悄变旧。
 * 「同一个数值三处各写一份」是本项目踩过的坑（config-sync.test.js 就是为它写的），
 * 所以直接删掉，别留一个看起来是权威其实没接线的常量。 */
const RECENT_MAX = 20;
/* 人机局流水单独一份：**不进 recent**。
 *
 * 为什么不是「进 recent 再打个 ai 标记」：recent 是所有统计口径的唯一输入
 * （games / wins / totalNet / 连胜 / 单场最高 / 战绩页趋势条 / 榜单），
 * 让它掺进不该计的场次，等于每一个消费方都要自己记得过滤一遍 ——
 * 漏一个就是「含着 AI 的战绩又混进排行榜」。分开存，人类局那条路一行都不用改。
 * 上限比 RECENT_MAX 小：人机局只是给玩家回看「我练了几把」的。 */
const AI_RECENT_MAX = 20;
const FLUSH_DELAY = 500;

/* ---------------------------------------------------------------------------
 * 原子替换：先写 .tmp，再 rename 覆盖。
 *
 * 但 rename 在 Windows 上会被「文件正被占用」打断（EBUSY / EPERM / EACCES）：
 * 索引服务、杀毒软件、另一个终端里开着的编辑器，任何一个碰到目标文件就够了。
 * 老实现遇到这种情况的表现是**静默永远写不进去** —— flush() 的 catch 只把
 * dirty 置回 true，下次还是同一条 rename，还是失败，而调用方以为落盘了。
 * （本地排查时撞到过一次：`flush() → 新实例读同一个文件` 读回来是空的，
 *   而同一路径直接 writeFileSync 完全正常。）
 *
 * 所以这里分三层退让，每一层都比上一层弱，但都保证「内容整份替换」而不是写一半：
 *   1. rename（原子，最理想）
 *   2. copyFile + 删源（覆盖写，不保证原子，但内容是完整的一份）
 *   3. readFile + writeFile（最坏情况；目标被独占时它会抛，由调用方兜底）
 * 生产部署在 Linux 上永远走第 1 层，这一步只是把「偶发写不进去」变成「能写进去」。
 * ------------------------------------------------------------------------- */
function replaceFileSync(from, to) {
  try {
    fs.renameSync(from, to);
    return;
  } catch (e) {
    if (e.code !== 'EBUSY' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
  }
  try {
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
    return;
  } catch (e2) {
    fs.writeFileSync(to, fs.readFileSync(from));
    fs.unlinkSync(from);
  }
}

async function replaceFileAsync(from, to) {
  try {
    await fsp.rename(from, to);
    return;
  } catch (e) {
    if (e.code !== 'EBUSY' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
  }
  try {
    await fsp.copyFile(from, to);
    await fsp.unlink(from);
    return;
  } catch (e2) {
    await fsp.writeFile(to, await fsp.readFile(from));
    await fsp.unlink(from);
  }
}
/* 档案数量护栏：每记满这么多次就扫一次「零战绩僵尸档案」。
 * 零战绩 = 只 ensure 过、从未 record（进房但一局没打完/纯路过），
 * 不入榜、不展示、不承载任何数据，直接淘汰零损失。 */
const PRUNE_INTERVAL = 100;
const MAX_PROFILES = 200000; // 极端护栏：档案数超过这个就强制清零战绩僵尸

/** 目录可写探测：容器里 home 不一定可写，写不进就换下一个 */
function canWrite(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-probe');
    fs.writeFileSync(probe, '1');
    fs.unlinkSync(probe);
    return true;
  } catch (e) {
    return false;
  }
}

/** 主数据文件：优先 DATA_DIR，其次用户目录（项目外），最后退回项目内 */
function defaultDataFile() {
  if (process.env.DATA_DIR) return path.join(process.env.DATA_DIR, 'profiles.json');
  const candidates = [];
  try { candidates.push(path.join(os.homedir(), '.lxw-appdata')); } catch (e) { /* 取不到 home */ }
  for (let i = 0; i < candidates.length; i++) {
    if (canWrite(candidates[i])) return path.join(candidates[i], 'profiles.json');
  }
  return path.join(__dirname, 'data', 'profiles.json'); // 兜底：至少能落盘
}

/**
 * 种子文件：随代码包上传，容器重建时用来恢复。
 * SEED_FILE 环境变量可以指到别处——测试必须指走：种子是容器重建时唯一的恢复来源，
 * 让测试往里写东西（哪怕事后还原）等于把线上数据的命根子拿去当草稿纸。
 */
const DEFAULT_SEED_FILE = path.join(__dirname, 'data', 'profiles.json');
function defaultSeedFile() {
  return process.env.SEED_FILE ? path.resolve(process.env.SEED_FILE) : DEFAULT_SEED_FILE;
}

class ProfileStore {
  constructor(options) {
    const opts = options || {};
    this.file = opts.file || defaultDataFile();
    this.seedFile = opts.seedFile || defaultSeedFile();
    this.data = new Map();
    /* 账号名（小写）→ playerId 的索引。数据量小，但每次登录都全表扫一遍没必要，
     * 而且登录是唯一需要「按名字找人」的地方。加载时就重建，不额外持久化。 */
    this._byName = new Map();
    /* 正在注册中的账号名占位。scrypt 改成异步之后，「检查名字没被占」和
     * 「真正写进索引」之间隔了几十毫秒，两个并发注册会都通过检查。
     * 用这个 Set 占位，防止同名账号被建出两份。 */
    this._pendingNames = new Set();
    /* 正在注册中的昵称占位，理由同上：昵称也要唯一，而它的检查同样跨着一次 await */
    this._pendingNicks = new Set();
    this.dirty = false;
    this.flushTimer = null;
    /* 异步写盘队列：同一时刻只允许一个写在飞，避免两次写抢同一个 tmp 文件 */
    this._writeQueue = Promise.resolve();
    /* 写入代数：同步 flush() 每写一次 +1，队列里的旧快照据此作废。
     * 没有它的话，flush 完之后排队中的旧内容可能反过来覆盖新内容。 */
    this._writeGen = 0;
    this.restoredFromSeed = false;
    this._recordCount = 0;   // 累计记场次数，用于低频触发 prune
    this.log = opts.log || null;
    this._load();
  }

  /**
   * 读一个档案文件。
   * 返回值区分三种情况——**不能把「文件坏了」当成「文件不存在」**：
   * 后者会静默回退种子，等于把玩家发布之后新写的战绩无声丢掉，还没有任何痕迹。
   * @returns {{status:'ok'|'missing'|'corrupt', data?:object}}
   */
  _readFile(file) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      return { status: 'missing' };      // 不存在 / 无权限读
    }
    if (!raw.trim()) return { status: 'corrupt', reason: '文件为空' };
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { status: 'ok', data: parsed };
      }
      return { status: 'corrupt', reason: '顶层不是对象' };
    } catch (e) {
      return { status: 'corrupt', reason: (e && e.message) || 'JSON 解析失败' };
    }
  }

  /**
   * 把坏掉的数据文件改名留档，再用种子恢复。
   * 直接覆盖等于毁掉唯一可能人工修复的副本——真出过一次手滑清库，
   * 就是因为文件被空对象盖掉、连抢救的余地都没有。
   */
  _quarantine(file, reason) {
    const bak = file + '.corrupt-' + Date.now();
    try {
      fs.renameSync(file, bak);
      this.error('数据文件损坏（' + reason + '），已改名保留：' + bak);
    } catch (e) {
      this.error('数据文件损坏（' + reason + '），且改名失败：' + (e && e.message));
    }
  }

  error(msg) {
    if (this.log) { this.log('PROFILE ' + msg); return; }
    if (typeof console !== 'undefined' && console.error) console.error('[profile] ' + msg);
  }

  _load() {
    const fromMain = this._readFile(this.file);
    if (fromMain.status === 'ok') {
      // 主文件存在即权威，哪怕内容是 {}（尊重人工清空，不用种子反向覆盖）
      Object.keys(fromMain.data).forEach((id) => this.data.set(id, fromMain.data[id]));
      this._rebuildNameIndex();
      /* 存量档案补新字段（longestLoseStreak）。补过就立刻落盘，
       * 否则每次启动都要重算一遍，而且这个值会一直是 undefined。 */
      let derived = false;
      this.data.forEach((p) => { if (this._ensureDerived(p)) derived = true; });
      if (derived) { this.dirty = true; this._scheduleFlush(); }
      return;
    }
    if (fromMain.status === 'corrupt') {
      // 损坏：先留档再走种子，绝不静默覆盖
      this._quarantine(this.file, fromMain.reason || '损坏');
    }
    // 主文件不存在：容器被重建 / 首次上线 → 用随包上传的种子恢复
    const seedRes = this._readFile(this.seedFile);
    if (seedRes.status === 'corrupt') this.error('种子文件损坏：' + (seedRes.reason || ''));
    const seed = seedRes.status === 'ok' ? seedRes.data : null;
    if (seed && Object.keys(seed).length) {
      Object.keys(seed).forEach((id) => this.data.set(id, seed[id]));
      this._rebuildNameIndex();
      this.data.forEach((p) => { this._ensureDerived(p); });
      this.restoredFromSeed = true;
      this.dirty = true;
      this._scheduleFlush(); // 立刻写回主文件，下次就不依赖种子了
    }
  }

  /** 账号名索引：从当前数据重建（加载、删除、清空后都要调） */
  _rebuildNameIndex() {
    this._byName.clear();
    this.data.forEach((p, id) => {
      if (p && p.account && p.account.name) {
        this._byName.set(String(p.account.name).toLowerCase(), id);
      }
    });
  }

  _scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this._flushAsync();          // 定时路径走异步写，别堵事件循环
    }, FLUSH_DELAY);
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  /**
   * 序列化成 JSON 文本。`_seen`（幂等键）不写进文件：它是「同一场别记两次」的
   * 会话内去重，房间本身只活在内存里，重启后这些键永远匹配不上，留着只会让文件变大。
   * **主文件与种子文件必须同一口径**，否则出问题时判断不了是哪边多写了东西。
   */
  _serialize() {
    const obj = {};
    this.data.forEach((v, k) => { obj[k] = v; });
    return JSON.stringify(obj, function (key, value) {
      return key === '_seen' ? undefined : value;
    });
  }

  /**
   * 同步落盘。
   *
   * 只留给「必须要立刻看到文件」的场景：进程退出前、单测里刷完立刻读。
   * 定时路径（每 500ms）走 `_flushAsync`——档案到几万条时，一次 writeFileSync
   * 会让事件循环停住几十毫秒，和当初的 `scryptSync` 是同一类问题，只是阈值更高。
   */
  flush() {
    /* ★ 不能因为 dirty=false 就返回。
     *
     * dirty 的含义是「有改动还没被**排队**」，不是「磁盘上已经是最新的」：
     * 500ms 的定时路径会先把 dirty 清掉，再把写操作塞进异步队列。
     * 在这个窗口里调 flush()，旧实现直接 return —— 磁盘上还是上一次的内容，
     * 而调用方以为自己刚刚同步落盘了。
     *
     * 表现（真实撞到过）：`record(...) → flush() → new ProfileStore(同一个文件)`
     * 读回来是空的，ai-records / me-records / reset 等几组测试**偶发**失败 ——
     * 概率取决于那 500ms 有没有被机器负载挤出来，所以单跑复现不了、并发跑才红。
     *
     * 调用点本来就少（进程退出前、几处「必须立刻看到文件」），
     * 多写一次的代价远低于「以为写了其实没写」。
     *
     * _writeGen：同步写完之后，队列里排着的**旧快照**不许再覆盖它。
     * 没有这一条的话，flush 先写入新内容、旧队列随后 rename 覆盖回旧内容，
     * 单测里就变成「刚写完立刻读，读到的是上一版」。 */
    this.dirty = false;
    this._writeGen = (this._writeGen || 0) + 1;
    try {
      const dir = path.dirname(this.file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, this._serialize(), 'utf8');
      replaceFileSync(tmp, this.file); // 原子替换，避免写一半断电留坏文件
    } catch (e) {
      this.dirty = true; // 留着下次再试
    }
  }

  /**
   * 异步落盘，串成一条队列：同一时刻只有一个写在飞。
   *
   * 为什么要队列：两次写并发落到同一个 tmp 文件会互相覆盖，
   * 后写的那次 rename 可能搬走半截内容。串行之后「写的顺序 = 快照产生的顺序」，
   * 最终落在磁盘上的永远是最新的那一次快照。
   */
  _flushAsync() {
    if (!this.dirty) return;
    this.dirty = false;
    let json;
    try {
      json = this._serialize();
    } catch (e) {
      this.dirty = true;
      return;
    }
    /* 快照这一刻的代数。写的时候如果代数已经变了，说明中间有人调过同步 flush()
     * 并且写了更新的内容 —— 这一份旧快照必须作废，否则它会把新内容覆盖回去。 */
    const gen = this._writeGen || 0;
    this._writeQueue = this._writeQueue
      .then(() => this._writeOnce(json, gen))
      .catch(() => { this.dirty = true; });   // 失败留到下一轮再试
    return this._writeQueue;
  }

  async _writeOnce(json, gen) {
    /* 排队期间有人同步 flush 过 → 这份快照已经过期，直接丢掉。
     * 不丢的话，磁盘上的最终内容取决于「谁后 rename」，与写入顺序无关。 */
    if (gen !== undefined && gen !== (this._writeGen || 0)) return;
    const dir = path.dirname(this.file);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = this.file + '.tmp';
    await fsp.writeFile(tmp, json, 'utf8');
    await replaceFileAsync(tmp, this.file);
  }

  _blank(playerId, nickname) {
    return {
      playerId: playerId,
      nickname: nickname || '',
      /* 头像预设 id（a0~a47）。空串 = 没选过，客户端按 playerId 哈希兜一款 ——
       * 老账号不用去设置页点一次才有头像。 */
      avatar: '',
      /* 上传照片的版本号（P1b，默认关闭）。空串 = 没有照片，用预设头像。
       * 有值时客户端去 GET /api/avatar/<pid>?v=<photo> 取图 —— 版本号只用来破缓存，
       * 图片本体在服务端的 avatars 目录里，不进 JSON（一份档案几十 KB 会把
       * profiles.json 撑到没法读）。 */
      photo: '',
      games: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      totalNet: 0,
      currentStreak: 0,
      longestStreak: 0,
      longestLoseStreak: 0,     // 与 longestStreak 对称：只记「连负」最长，战绩页要用
      bestNet: 0,
      /* 含 AI 的对局：只留流水与场次，**不参与上面任何一个统计字段**。
       * 分成两个字段而不是一个，是因为它们会被分别用到：
       *   aiGames  —— 战绩页那句「人机对局 N 局 · 不计入战绩」，
       *               以及 prune 判断「这份档案是不是空的」；
       *   aiRecent —— 战绩页列表里那几行「含人机」的记录。 */
      aiGames: 0,
      aiRecent: [],
      recent: [],
      updatedAt: 0
    };
  }

  /**
   * 老档案补派生字段。
   *
   * longestLoseStreak 是这次新加的，存量档案没有。不能靠 `|| 0` 兜底了事：
   * 一个当前正处在 3 连负的人，页面会显示「最长连败 0」——比不显示更糟。
   * currentStreak 为负时它必然 ≥ |currentStreak|，用它做下限补一次，
   * 之后由 record() 正常维护。只在加载/ensure 时跑，不在读路径上反复算。
   */
  _ensureDerived(p) {
    if (!p) return false;
    const loseNow = Math.abs(Math.min(0, Number(p.currentStreak) || 0));
    let changed = false;
    if (!(Number(p.longestLoseStreak) >= 0)) { p.longestLoseStreak = loseNow; changed = true; }
    else if (p.longestLoseStreak < loseNow) { p.longestLoseStreak = loseNow; changed = true; }
    /* 老档案没有这两个字段（人机局分账是这一版才加的）。
     * 不能用 `|| []` 糊过去：下面 record 里会 `p.aiRecent.unshift`，
     * 拿到 undefined 就是一次 TypeError，而它发生在结算路径上 —— 一场牌白打。 */
    if (!Array.isArray(p.aiRecent)) { p.aiRecent = []; changed = true; }
    if (!(Number(p.aiGames) >= 0)) { p.aiGames = 0; changed = true; }
    return changed;
  }

  ensure(playerId, nickname) {
    let p = this.data.get(playerId);
    if (!p) {
      p = this._blank(playerId, nickname);
      this.data.set(playerId, p);
    } else {
      this._ensureDerived(p);
    }
    if (nickname && nickname !== p.nickname) { p.nickname = nickname; this._invalidateStandings(); }
    return p;
  }

  /**
   * 记一场结果。
   * @param {string} playerId
   * @param {string} nickname
   * @param {number} net  终分 − 20
   * @param {number} endedAt  服务端给的稳定结算时间
   * @param {string} roomId
   * @param {number} handSeq  房间内场次序号，用于幂等（同房间同场次不重复记）
   * @param {object} [meta]   { playerCount, endReason, hasBot }
   *        playerCount / endReason —— 战绩页每行要显示「3人 / 分数见底结束」
   *        **hasBot —— 这一局有 AI 参与**。传 true 时整局只进 aiRecent，
   *        对场次与积分零影响（见函数内的提前返回）。
   */
  record(playerId, nickname, net, endedAt, roomId, handSeq, meta) {
    const p = this.ensure(playerId, nickname);
    /* 幂等键 = 房间 + 场次 (+ 结算时刻)。
     *
     * 原来只有 `房间#场次`，已知代价（REVIEW P5-3）：房间号是 6 位且会回收，
     * **同一房间号 + 同一场次号**在 40 条窗口内撞上，第二场会被当成重复静默丢掉 ——
     * 玩家打了一整场，档案里什么都没有。
     *
     * 加 `endedAt` 是安全的，因为它在 `markSettled()` 里**只写一次**
     * （`if (!room.settledAt)` 内部），同一场的重复广播拿到的必然是同一个值。
     * 以前担心「时间一漂就重记一次」，那是把「结算时刻」和「广播时刻」搞混了：
     * 这里用的是结算时刻，不是当前时刻。
     *
     * 兜底：`endedAt` 缺失时退回旧的两段式键 —— 宁可保留原来的重记窗口，
     * 也不要让「传了 undefined 的调用方」变成每广播一次就记一场。 */
    const hasEndedAt = typeof endedAt === 'number' && isFinite(endedAt) && endedAt > 0;
    const key = String(roomId) + '#' + String(handSeq) + (hasEndedAt ? '#' + String(endedAt) : '');
    // 幂等：同一房间的同一场只记一次（重连/重复广播都可能触发）
    if (p._seen && p._seen[key]) return { recorded: false, reason: 'duplicate' };
    if (!p._seen) p._seen = {};
    p._seen[key] = endedAt || Date.now();
    // 只保留最近 40 个幂等键，防止无限增长
    const seenKeys = Object.keys(p._seen);
    if (seenKeys.length > 40) {
      seenKeys
        .sort((a, b) => p._seen[a] - p._seen[b])
        .slice(0, seenKeys.length - 40)
        .forEach((k) => { delete p._seen[k]; });
    }

    const n = Math.round(Number(net) || 0);

    /* ---- 含 AI 的对局：只记「打过」，不记输赢 ----
     *
     * 用户口径（原话）：「含 AI 的对局不计入战绩和排行榜，不影响积分和数据等，
     * 但在我的战绩页面上要能看出是人机对战」。
     *
     * 所以这里**提前返回**，一个统计字段都不动：场次、胜、负、平、净胜、当前连胜、
     * 最长连胜/连败、单场最高全部不碰。排行榜按 games>0 入榜，因此人机局自然也不入榜。
     *
     * 幂等键已经在上一步写过了：同一把被重复广播时仍然只算一次。
     * 之所以连 `_recordCount`（僵尸清扫计数器）也不加：人机局不会新建档案。
     */
    if (meta && meta.hasBot) {
      const aiItem = { endedAt: endedAt || Date.now(), net: n, roomId: roomId, ai: true };
      if (Number(meta.playerCount) > 0) aiItem.playerCount = Math.round(Number(meta.playerCount));
      if (meta.endReason) aiItem.endReason = String(meta.endReason).slice(0, 16);
      p.aiGames = (Number(p.aiGames) || 0) + 1;
      if (!Array.isArray(p.aiRecent)) p.aiRecent = [];
      p.aiRecent.unshift(aiItem);
      if (p.aiRecent.length > AI_RECENT_MAX) p.aiRecent.length = AI_RECENT_MAX;
      p.updatedAt = Date.now();
      this.dirty = true;
      this._scheduleFlush();
      return { recorded: true, ai: true };
    }

    p.games += 1;
    p.totalNet += n;
    if (n > 0) {
      p.wins += 1;
      p.currentStreak = p.currentStreak >= 0 ? p.currentStreak + 1 : 1;
    } else if (n < 0) {
      p.losses += 1;
      p.currentStreak = p.currentStreak <= 0 ? p.currentStreak - 1 : -1;
    } else {
      p.draws += 1;
      p.currentStreak = 0;
    }
    const absStreak = Math.abs(p.currentStreak);
    if (p.currentStreak > 0 && absStreak > p.longestStreak) p.longestStreak = absStreak;
    if (p.currentStreak < 0 && absStreak > p.longestLoseStreak) p.longestLoseStreak = absStreak;
    /* 第一场直接做初值，不能用 `n > 0` 起算：
     * 一个全负的人，「单场最高」应该是那个负数（-18 也是他真实的最好成绩），
     * 而不是 0 —— 0 是「平局」的语义，摆在那里会让人以为某一局打平了。 */
    if (p.games === 1) p.bestNet = n;
    else if (n > p.bestNet) p.bestNet = n;

    /* 流水里带上人数与结束原因：战绩页每行要显示「3 人 · 分数见底结束」，
     * 没有这两个字段就只能从本机记录里猜，而本机记录正是这次要绕开的东西。 */
    const item = { endedAt: endedAt || Date.now(), net: n, roomId: roomId };
    if (meta && Number(meta.playerCount) > 0) item.playerCount = Math.round(Number(meta.playerCount));
    if (meta && meta.endReason) item.endReason = String(meta.endReason).slice(0, 16);
    p.recent.unshift(item);
    if (p.recent.length > RECENT_MAX) p.recent.length = RECENT_MAX;
    p.updatedAt = Date.now();

    this.dirty = true;
    this._invalidateStandings();
    this._scheduleFlush();
    // 低频扫一次僵尸档案（每 PRUNE_INTERVAL 场），防止 profiles.json 无限膨胀
    this._recordCount += 1;
    if (this._recordCount % PRUNE_INTERVAL === 0 || this.data.size > MAX_PROFILES) {
      this.prune();
    }
    return { recorded: true };
  }

  /**
   * 淘汰「零战绩僵尸档案」：只 ensure 过、从未 record（games === 0），
   * 不进榜单、不展示、不承载任何数据，删了零损失。
   * **但注册账号必须豁免**：刚注册还没开局的新玩家 games 也是 0，
   * 按老规则会被扫掉——表现为「注册完打一局，账号没了」。
   * **只打过人机局的也要豁免**：他们的 games 同样是 0（人机局不计入场次），
   * 抹掉这份档案等于把「我一个人练了三把」的战绩页一起抹了 ——
   * 而这类玩家恰恰最可能是第一次打开这个游戏的人。
   * 返回被删的 playerId 列表（供测试/日志）。
   */
  prune() {
    const removed = [];
    this.data.forEach((p, id) => {
      if (!p) { removed.push(id); this.data.delete(id); return; }
      if ((p.games || 0) > 0) return;         // 有战绩的保留
      if ((p.aiGames || 0) > 0) return;       // 只打过人机局的保留（见上）
      if (p.account) return;                  // 有账号的保留（还没开局也一样）
      removed.push(id);
      this.data.delete(id);
    });
    if (removed.length) { this.dirty = true; this._invalidateStandings(); }
    return removed;
  }

  /**
   * 删除单个玩家的云端档案（用户主动「删除我的数据」）。
   * 与 prune 不同：这里**无论是否有战绩都删**——是用户的「被遗忘权」诉求。
   * 返回是否真的删掉了（false = 本来就没有档案）。
   */
  remove(playerId) {
    const id = String(playerId == null ? '' : playerId);
    if (!id) return false;
    const had = this.data.has(id);
    if (had) {
      const p = this.data.get(id);
      if (p && p.account && p.account.name) {
        this._byName.delete(String(p.account.name).toLowerCase());
      }
      this.data.delete(id);
      this.dirty = true;
      this._invalidateStandings();
      this._scheduleFlush();
    }
    return had;
  }

  /**
   * 档案还在不在。**只看有没有这条记录，不管有没有账号。**
   *
   * `/api/players/alive` 用它回答「这个人是不是注销了」，所以必须是便宜的
   * Map 查询 —— 不要在这里构造对外对象（`get()` 会做一次 _public 拷贝，
   * 而这个是按 50 个 id 批量调的）。
   *
   * 已经删号的返回 false；被 prune 掉的零战绩僵尸也返回 false。
   * 后者不影响判断：僵尸档案从来没进过回放（没打过牌就不会有对局记录）。
   */
  has(playerId) {
    return this.data.has(String(playerId == null ? '' : playerId));
  }

  /**
   * 把当前内存数据整体写回**种子文件**。
   *
   * 为什么删号之后必须立刻做这一下：种子是容器重建时唯一的恢复来源，
   * 而 `remove()` 只写主文件。于是存在一个窗口 ——
   * **A 删号之后、下一次 `npm run backup` 之前，只要容器重建一次**，
   * 种子就会把刚被删掉的档案原样带回来：账号能登录、战绩全在，删号等于没删。
   * 正常发布流程里 backup 会用线上数据重写种子、窗口自然关闭，
   * 但「必然会发生一次的事情迟早会发生」，不值得赌。
   *
   * 口径与主文件完全一致（都用 `_serialize()`，只差文件名），
   * 这样出问题时不必判断是哪个文件多写了东西。
   *
   * **失败不影响删号本身**：种子写不进去，最坏是那个窗口重新打开；
   * 而删号失败会让用户以为没删成、反复重试。
   */
  writeSeed() {
    try {
      const json = this._serialize();
      const dir = path.dirname(this.seedFile);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = this.seedFile + '.tmp';
      fs.writeFileSync(tmp, json, 'utf8');
      replaceFileSync(tmp, this.seedFile);   // 原子替换：写一半断电不会留下坏种子
      return true;
    } catch (e) {
      this.error('写种子失败（删号已完成，仅备份窗口重新打开）：' + (e && e.message));
      return false;
    }
  }

  /**
   * 清空全部档案（运维用：抹掉人机测试留下的榜单）。
   * 与 remove / prune 不同：不看有没有战绩，一律清掉。
   * ⚠️ 接入账号后这条会**连账号一起清掉**（玩家全部被登出且无法再登录），
   * 只应在测试数据清理时用；管理后台的界面上标注了这一点。
   * **必须立刻落盘**——平时靠 500ms 延迟 flush，进程若在这 500ms 内被重启，
   * 内存清了、文件没清，重启后种子/主文件又把旧数据带回来。
   * 返回被清掉的档案数。
   */
  reset() {
    const n = this.data.size;
    this.data.clear();
    this._byName.clear();
    this.dirty = true;
    this._invalidateStandings();
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.flush();
    return n;
  }

  /**
   * 清空**战绩**，保留账号（赛季重置 / 「清空排行榜」）。
   *
   * 和上面 reset() 的区别必须记牢，拿错一个是灾难：
   *   reset()       清掉全部档案，**连账号一起** → 所有人登不进来，必须重新注册
   *   resetStats()  只把战绩归零 → 账号、密码、昵称都在，大家照常登录，榜单从零开始
   *
   * 想「清空排行榜」的人要的是后者。前者只在测试数据彻底清场时用。
   *
   * 战绩字段的唯一定义处是 _blank()，这里直接复用它的键——
   * 将来加新字段（比如连败次数）不必记得回来改第二处。
   * account 不在 _blank 里，所以天然被保留。
   *
   * _seen 也一起清：它是「同一场别记两次」的幂等键，记录的都是已经不存在的旧场次，
   * 留着只会白占截断名额（record 里按时间排序只留一部分）。
   *
   * **必须立刻落盘**，理由同 reset()：500ms 的延迟窗口里进程一重启，
   * 内存清空了、文件还是满的，重启后旧战绩原样回来。
   * 返回被重置的档案数。
   */
  resetStats() {
    const n = this.data.size;
    this.data.forEach((p) => {
      const blank = this._blank(p.playerId, p.nickname);
      Object.keys(blank).forEach((k) => {
        // 身份与显示名不属于战绩，保留
        if (k === 'playerId' || k === 'nickname') return;
        p[k] = blank[k];
      });
      delete p._seen;
      p.updatedAt = Date.now();
    });
    this.dirty = true;
    this._invalidateStandings();
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.flush();
    return n;
  }

  /* ============================ 账号 ============================ */

  /** 生成账号的 playerId。与旧的设备 id 同格式（p 开头），房间逻辑完全不用改 */
  static newPlayerId() {
    return 'p' + crypto.randomBytes(8).toString('hex');
  }

  /** 按账号名找记录（大小写不敏感） */
  findByAccountName(name) {
    const pid = this._byName.get(String(name == null ? '' : name).trim().toLowerCase());
    if (!pid) return null;
    return this.data.get(pid) || null;
  }

  /**
   * 注册。账号名唯一性在这里判（不区分大小写），密码只存 salt + scrypt 结果。
   *
   * 哈希已经是异步的（scrypt 放到线程池，避免登录/注册把整个对局系统冻住），
   * 于是这里出现一个**新的竞态**：两次同名注册可以同时通过 `_byName` 检查，
   * 因为检查之后要 await 几十毫秒才写入。所以先用 `_pendingNames` 占位，
   * 并且 await 之后再复查一次索引——否则会出现两个同号账号。
   *
   * @returns {Promise<{ok:boolean, playerId?:string, error?:string}>}
   */
  async createAccount(name, password, nickname) {
    const display = String(name == null ? '' : name).trim();
    const key = display.toLowerCase();
    if (this._byName.has(key) || this._pendingNames.has(key)) {
      return { ok: false, error: '这个账号名已经被用了，换一个吧' };
    }
    /* 昵称必须唯一：排行榜/战绩/结算页都只显示昵称，撞名 = 可以冒充别人。
     * 不填昵称时用账号名顶上（与 index.js 的兜底一致），所以这里也按同一口径判。 */
    const nick = cleanNickname(nickname, 8, display) || display;
    const nickKey = ProfileStore.nickKey(nick);
    if (this.isNicknameTaken(nick, null) || this._pendingNicks.has(nickKey)) {
      return { ok: false, error: '这个昵称已经被别人用了，换一个吧' };
    }
    this._pendingNames.add(key);
    this._pendingNicks.add(nickKey);
    try {
      const hp = await auth.hashPassword(password);
      if (this._byName.has(key)) return { ok: false, error: '这个账号名已经被用了，换一个吧' };
      if (this.isNicknameTaken(nick, null)) return { ok: false, error: '这个昵称已经被别人用了，换一个吧' };

      const playerId = ProfileStore.newPlayerId();
      const p = this._blank(playerId, nick);
      p.account = {
        name: display,
        salt: hp.salt,
        hash: hp.hash,
        createdAt: Date.now(),
        lastLoginAt: 0,
        disabled: false,
        tv: 0   // 令牌版本号：改密码 / 被停用时 +1，旧令牌当场作废
      };
      this.data.set(playerId, p);
      this._byName.set(key, playerId);
      this.dirty = true;
      this._scheduleFlush();
      return { ok: true, playerId: playerId };
    } finally {
      this._pendingNames.delete(key);
      this._pendingNicks.delete(nickKey);
    }
  }

  /**
   * 登录校验。
   * 账号不存在与密码错误返回**同一句**错误，避免被用来枚举账号名。
   * 停用单独给一句话：管理员主动停的账号，用户有权知道原因。
   * 异步：verifyPassword 期间账号可能被管理员删掉，await 之后必须重新取一次记录。
   */
  async login(name, password) {
    const p = this.findByAccountName(name);
    if (!p || !p.account) {
      /* 「查无此人」这条路也要把 scrypt 跑完，否则耗时就变成了答案：
       * 1ms = 账号不存在，60ms = 账号存在但密码错。文案统一了、时间没统一，
       * 防枚举等于没做。见 auth.verifyDummy 的说明。 */
      await auth.verifyDummy(password);
      return { ok: false, error: '账号或密码不正确' };
    }
    if (p.account.disabled) return { ok: false, error: '该账号已被停用，请联系管理员' };
    const okPw = await auth.verifyPassword(password, p.account.salt, p.account.hash);
    const cur = this.data.get(p.playerId);   // 校验期间可能被删/被改
    if (!cur || !cur.account) return { ok: false, error: '账号或密码不正确' };
    if (!okPw) return { ok: false, error: '账号或密码不正确' };
    cur.account.lastLoginAt = Date.now();
    // 昵称兜底：老档案可能只有空昵称（注册时没填），用账号名顶上
    if (!cur.nickname && cur.account.name) cur.nickname = cur.account.name;
    this.dirty = true;
    this._scheduleFlush();
    return { ok: true, playerId: cur.playerId };
  }

  /**
   * 改密码。**同时把令牌版本 +1**：改密码的动机往往就是「怀疑别人上过我的号」，
   * 如果旧令牌还能用 90 天，改密码就等于没改。
   * 调用方负责先验旧密码或确认管理员身份。返回 Promise<boolean>。
   */
  async setPassword(playerId, password) {
    const p = this.data.get(String(playerId));
    if (!p || !p.account) return false;
    const hp = await auth.hashPassword(password);
    const cur = this.data.get(String(playerId));
    if (!cur || !cur.account) return false;  // 哈希期间被删了
    cur.account.salt = hp.salt;
    cur.account.hash = hp.hash;
    cur.account.passwordChangedAt = Date.now();
    cur.account.tv = (Number(cur.account.tv) || 0) + 1;
    this.dirty = true;
    this._scheduleFlush();
    return true;
  }

  /**
   * 昵称去重口径：去掉首尾空白、全角空格，忽略大小写。
   *
   * 排行榜和战绩页**只显示昵称、不显示账号名**，所以昵称撞了就等于可以冒充别人：
   * 「小明」和「小明 」在榜上是两个行，玩家看着一模一样（HTML 里连续空白还会被折叠成
   * 一个）。所以撞名判据必须比显示更宽 —— 宽一点最多是「这个昵称被占了」，窄一点就是安全洞。
   */
  static nickKey(nickname) {
    return String(nickname == null ? '' : nickname)
      .replace(/[\s\u3000]+/g, '')   // 所有空白（含全角空格）都不算数
      .toLowerCase();
  }

  /** 昵称是否已被别人占用。exceptId 用于「改自己的昵称」时排除自己 */
  isNicknameTaken(nickname, exceptId) {
    const key = ProfileStore.nickKey(nickname);
    if (!key) return false;          // 空昵称不参与占用判定（读取时会兜底成账号名）
    const skip = exceptId == null ? null : String(exceptId);
    let taken = false;
    this.data.forEach((p, id) => {
      if (taken || !p || id === skip) return;
      if (ProfileStore.nickKey(p.nickname) === key) taken = true;
    });
    return taken;
  }

  /** 管理员改昵称：只动展示名，不动账号名（账号名是登录凭据，改了人就登不进来了）
   *  @returns {boolean|string} true = 成功；字符串 = 失败原因（撞名） */
  setNickname(playerId, nickname) {
    const p = this.data.get(String(playerId));
    if (!p) return false;
    const next = cleanNickname(nickname);
    if (this.isNicknameTaken(next, playerId)) return '这个昵称已经被别人用了';
    p.nickname = next;
    this._invalidateStandings();
    this.dirty = true;
    this._scheduleFlush();
    return true;
  }

  /** 换头像：只认预设 id（a0~a47），不接受任意字符串。
   *  为什么服务端也要校验：前端那套 48 款是**展示**约束，客户端可以随便发；
   *  服务端如果照单全收，别人拿到一个不存在的 id 时头像会变空白 —— 那是别人看到的坏。
   *  @returns {boolean} */
  setAvatar(playerId, avatarId) {
    const p = this.data.get(String(playerId));
    if (!p) return false;
    /* 只认字符串。null / undefined / 数字都是「客户端没按约定传」，
     * 不能当成空串——那等于一个写错的客户端把用户挑好的头像静默抹掉，
     * 而用户看到的只是「头像自己变回去了」。
     * 空串本身是合法的主动选择（回到按 id 哈希的默认款）。 */
    if (typeof avatarId !== 'string') return false;
    if (avatarId !== '' && !/^a([0-9]|[1-3][0-9]|4[0-7])$/.test(avatarId)) return false;
    p.avatar = avatarId;
    /* 选了预设就清掉照片：产品规则是「最后一次动作生效」。
     * 两套头像同时存在时，界面上必须有一条优先级 —— 说不清哪张在生效，
     * 用户就会反复点、以为没换成。 */
    p.photo = '';
    this.dirty = true;
    this._scheduleFlush();
    return true;
  }

  /** 记下上传照片的版本号（P1b）。文件本身由 server/avatars.js 管。
   *  @returns {boolean} */
  setPhoto(playerId, version) {
    const p = this.data.get(String(playerId));
    if (!p) return false;
    /* 只认 36 进制时间戳这种短串。它会被拼进 URL 和 HTML 属性，
     * 放任任意字符串等于给自己开一个注入口。 */
    const v = String(version == null ? '' : version);
    if (v !== '' && !/^[0-9a-z]{1,16}$/.test(v)) return false;
    p.photo = v;
    this.dirty = true;
    this._scheduleFlush();
    return true;
  }

  /**
   * 停用 / 恢复。停用后登录被拒，但档案与战绩原样保留（可恢复）。
   * 停用要**立刻**把在线的人踢下去，光拒下次登录不够——
   * 所以停用时把令牌版本 +1，手里那枚令牌当场失效（hub 会按版本判连接）。
   */
  setDisabled(playerId, disabled) {
    const p = this.data.get(String(playerId));
    if (!p || !p.account) return false;
    const next = !!disabled;
    if (next && !p.account.disabled) p.account.tv = (Number(p.account.tv) || 0) + 1;
    p.account.disabled = next;
    this.dirty = true;
    this._scheduleFlush();
    return true;
  }

  /** 当前令牌版本号。没有账号返回 0（与令牌里缺省值一致） */
  tokenVersion(playerId) {
    const p = this.data.get(String(playerId));
    if (!p || !p.account) return 0;
    return Number(p.account.tv) || 0;
  }

  /** 账号公开信息（绝不含 salt / hash） */
  accountOf(playerId) {
    const p = this.data.get(String(playerId));
    if (!p || !p.account) return null;
    return {
      name: p.account.name,
      createdAt: p.account.createdAt || 0,
      lastLoginAt: p.account.lastLoginAt || 0,
      disabled: !!p.account.disabled
    };
  }

  /** 管理后台列表：账号 + 战绩摘要。按最后登录倒序，最近活跃的在前 */
  accountList() {
    const out = [];
    this.data.forEach((p) => {
      if (!p || !p.account) return;
      out.push({
        playerId: p.playerId,
        account: p.account.name,
        nickname: p.nickname,
        games: p.games || 0,
        wins: p.wins || 0,
        totalNet: p.totalNet || 0,
        createdAt: p.account.createdAt || 0,
        lastLoginAt: p.account.lastLoginAt || 0,
        disabled: !!p.account.disabled
      });
    });
    out.sort((a, b) => (b.lastLoginAt || b.createdAt) - (a.lastLoginAt || a.createdAt));
    return out;
  }

  /** 对外档案：剥掉内部幂等键 _seen
   * @param {number} [recentLimit] 流水条数，默认 5（看别人的档案卡只需要 5 条）
   * @param {boolean} [withAi] 是否带上人机局流水。
   *        只有「自己看自己」需要 —— 看别人的档案卡里列一堆人机局没有意义，
   *        而且那是几 KB 的额外体积。aiGames 这个数字则一律带上（它是无害的总数）。
   */
  _public(p, withRecent, recentLimit, withAi) {
    const o = {
      playerId: p.playerId,
      nickname: p.nickname,
      avatar: p.avatar || '',
      photo: p.photo || '',
      games: p.games,
      wins: p.wins,
      losses: p.losses,
      draws: p.draws,
      winRate: p.games ? Math.round(p.wins / p.games * 100) : 0,
      totalNet: p.totalNet,
      currentStreak: p.currentStreak,
      longestStreak: p.longestStreak,
      longestLoseStreak: Number(p.longestLoseStreak) || 0,
      bestNet: p.bestNet,
      /* 含 AI 的场次数。**不参与任何统计**，只用来在战绩页写一句
       * 「人机对局 N 局 · 不计入战绩」，以及判断空态要不要说「你只打过人机局」。 */
      aiGames: Number(p.aiGames) || 0,
      updatedAt: p.updatedAt
    };
    if (withRecent !== false) {
      const n = recentLimit > 0 ? recentLimit : 5;
      o.recent = p.recent.slice(0, n);
    }
    if (withAi) o.aiRecent = (p.aiRecent || []).slice(0, AI_RECENT_MAX);
    return o;
  }

  /**
   * 自己的档案：流水给足（战绩页要 10 条趋势 + 一屏列表）。
   *
   * 为什么别人的只给 5 条：recent 里带 roomId 和逐场净胜，
   * 给多了等于把别人的完整流水抄出来。自己看自己没这个顾虑。
   */
  getSelf(playerId) {
    const p = this.data.get(String(playerId));
    if (!p) return null;
    this._ensureDerived(p);
    return this._public(p, true, RECENT_MAX, true);
  }

  /**
   * 只清**一个人**的战绩，保留账号与昵称（/api/me/reset-stats 用）。
   *
   * 名字刻意不叫 resetStats：那个是管理端「清空全部榜单单、保留所有账号」，
   * 同名两个方法在 class 里后者会静默覆盖前者 —— 第一版就踩了这个坑，
   * 结果连「清空排行榜」都返回「账号不存在」。改名的成本远低于再踩一次。
   *
   * 「战绩页删了数据，排行榜还在」这件事的解法不是提示用户两边不同步，
   * 而是让两边**是同一份数据**——所以删除必须能落到服务器。
   *
   * 刻意不清 _seen：清了之后，一个仍在内存里的结算房间只要再广播一次，
   * 就会把刚删掉的那场重新写回来。留着幂等键，删除才真的是删除。
   */
  resetStatsOf(playerId) {
    const p = this.data.get(String(playerId));
    if (!p) return { ok: false, error: '账号不存在' };
    /* 字段表从 _blank 拿，别在这里手抄一份：
     * 将来加新战绩字段（这次就加了 longestLoseStreak），漏改这里的后果是
     * 「重置后旧值残留」，而它只会在下一次重置时才被发现。 */
    const blank = this._blank(p.playerId, p.nickname);
    Object.keys(blank).forEach((k) => {
      if (k === 'playerId' || k === 'nickname') return;
      p[k] = blank[k];
    });
    p.updatedAt = Date.now();
    this.dirty = true;
    this._invalidateStandings();
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.flush();                      // 立刻落盘：别让 500ms 窗口里的重启把战绩带回来
    return { ok: true };
  }

  /** 对外档案（单条） */
  get(playerId) {
    const p = this.data.get(String(playerId));
    if (!p) return null;
    return this._public(p, true);
  }

  /**
   * 全量导出：备份脚本用。带完整 recent，且**不含** _seen（与 flush 口径一致），
   * 写回种子文件后可以直接被下次启动加载。
   * **必须带上 account**（含 salt/哈希）：否则发布前备份一次，
   * 所有账号的密码就被洗掉了，玩家第二天全部登不进来。
   * 落点仍是 server/data 或用户目录，都在静态根之外，外网取不到。
   */
  dump() {
    const out = [];
    this.data.forEach((p) => {
      const o = this._public(p, true, undefined, true);
      o.recent = (p.recent || []).slice(0, RECENT_MAX);
      if (p.account) o.account = p.account;
      out.push(o);
    });
    return out;
  }

  /* ============================ 人机局：重算与历史修正 ============================
   *
   * 为什么需要「重算」这个方法：口径从「一律记」改成「含 AI 不记」之后，
   * 历史数据里那一批已经混进 games / totalNet 的人机局必须能退回来。
   * 退回来了还不够 —— 场次减了，胜率、连胜、单场最高全部要跟着重算，
   * 而这些字段是增量写入的（record 里 +=1），没有历史基数就回不去。
   * 唯一的办法是拿 recent 重新算一遍：recent 就是「每一场」的原始流水，
   * 它够用，前提是它本身没被 AI 污染（所以先搬走，再重算）。
   */

  /** 把一组流水聚合成统计（不改档案）。升序扫一遍，返回新对象。 */
  _aggregate(list) {
    const asc = (Array.isArray(list) ? list.slice() : [])
      .sort((a, b) => (Number(a.endedAt) || 0) - (Number(b.endedAt) || 0));   // 旧 → 新
    const o = {
      games: asc.length, wins: 0, losses: 0, draws: 0, totalNet: 0,
      bestNet: 0, longestStreak: 0, longestLoseStreak: 0, currentStreak: 0
    };
    let winRun = 0, loseRun = 0;
    asc.forEach((it, i) => {
      const n = Math.round(Number(it.net) || 0);
      o.totalNet += n;
      if (n > 0) { o.wins += 1; winRun += 1; loseRun = 0; }
      else if (n < 0) { o.losses += 1; loseRun += 1; winRun = 0; }
      else { o.draws += 1; winRun = 0; loseRun = 0; }
      if (winRun > o.longestStreak) o.longestStreak = winRun;
      if (loseRun > o.longestLoseStreak) o.longestLoseStreak = loseRun;
      /* 与 record() 同一口径：第一场直接做初值（全负的人也有一场「最好的」），
       * 不能从 0 起算 —— 0 是平局的语义。 */
      if (i === 0) o.bestNet = n;
      else if (n > o.bestNet) o.bestNet = n;
    });
    if (!o.games) o.bestNet = 0;
    /* currentStreak 的符号与 record() 一致：正 = 连胜，负 = 连败 */
    o.currentStreak = winRun > 0 ? winRun : (loseRun > 0 ? -loseRun : 0);
    return o;
  }

  /**
   * 「流水窗口之外那一截」的统计残值 = 改动前的档案汇总 − **改动前** recent 的汇总。
   *
   * ★ 必须传改动前的 recent。传改动后的会把「刚要搬走的那几条」也算进残值，
   * 于是搬走 1 场、重算之后场次反而没变 —— 第一版就是这么写错的，
   * 测试里「场次 24 → 23」直接红成 24。
   *
   * 为什么必须有残值：recent 只留 20 条，而 games 可以远大于 20（玩家A 24 场）。
   * 重算如果只按 recent 走，多出来的那 4 场就直接从统计里消失了 ——
   * 一次「修正人机局」顺手抹掉了真实战绩，而且没有任何提示。
   * 残值只可能因为「改动」而变小，所以逐项取非负：负数说明档案与流水本来就不一致
   * （历史脏数据），那种情况宁可少算，也绝不把负的尾巴加回去。
   *
   * @param {object} prev 改动前的档案汇总快照
   * @param {Array} recentBefore 改动前的 recent
   */
  _residual(prev, recentAfter) {
    const now = this._aggregate(recentAfter);    const tail = {
      games: (Number(prev.games) || 0) - now.games,
      wins: (Number(prev.wins) || 0) - now.wins,
      losses: (Number(prev.losses) || 0) - now.losses,
      draws: (Number(prev.draws) || 0) - now.draws,
      totalNet: (Number(prev.totalNet) || 0) - now.totalNet,
      bestNet: (Number(prev.bestNet) || 0) - now.bestNet,
      longestStreak: (Number(prev.longestStreak) || 0) - now.longestStreak,
      longestLoseStreak: (Number(prev.longestLoseStreak) || 0) - now.longestLoseStreak
    };
    Object.keys(tail).forEach((k) => { if (!(tail[k] > 0)) tail[k] = 0; });
    return tail;
  }

  /**
   * 用 recent 重建全部派生统计。recent 必须是「只含人类局」的那一份。
   * @param {object} [tail] 窗口外那截的残值（见 _residual）。不传 = 纯按 recent 算。
   */
  _recompute(p, tail) {
    const o = this._aggregate(p.recent);
    const t = tail || {};
    p.games = o.games + (t.games || 0);
    p.wins = o.wins + (t.wins || 0);
    p.losses = o.losses + (t.losses || 0);
    p.draws = o.draws + (t.draws || 0);
    p.totalNet = o.totalNet + (t.totalNet || 0);
    /* 这三项是「取最大」语义，残值只能兜底、不能相加 */
    p.bestNet = Math.max(o.bestNet, t.bestNet || 0);
    p.longestStreak = Math.max(o.longestStreak, t.longestStreak || 0);
    p.longestLoseStreak = Math.max(o.longestLoseStreak, t.longestLoseStreak || 0);
    /* 当前连胜只能从**最近**那几场看出来；recent 空了又确实还有更早的场次时，
     * 沿用旧值（不知道就别改），而不是武断地归零。 */
    if (!o.games && (t.games || 0) > 0) p.currentStreak = Number(p.currentStreak) || 0;
    else p.currentStreak = o.currentStreak;
    if (!p.games) p.bestNet = 0;
    p.aiGames = Number(p.aiGames) || 0;
    return p;
  }

  /** 改动前的汇总快照（给 _residual 用） */
  _snapshot(p) {
    return {
      games: Number(p.games) || 0,
      wins: Number(p.wins) || 0,
      losses: Number(p.losses) || 0,
      draws: Number(p.draws) || 0,
      totalNet: Number(p.totalNet) || 0,
      bestNet: Number(p.bestNet) || 0,
      longestStreak: Number(p.longestStreak) || 0,
      longestLoseStreak: Number(p.longestLoseStreak) || 0
    };
  }

  /**
   * 搬完流水之后统一收尾：重算（带残值）、落盘由调用方做。
   * @param {object} prev 改动前的汇总快照
   * @param {object} tail 窗口外那截的残值 —— **必须在改动前算**（见 _residual 的说明）
   */
  _afterMove(p, prev, tail) {
    this._recompute(p, tail);
    p.updatedAt = Date.now();
  }

  /**
   * 把指定的场次从「人类战绩」挪进「人机流水」并重算统计。
   *
   * @param {string[]} keys 形如 "452203#1793326812656"（roomId#endedAt）
   * @returns {{moved:number, profiles:number}}
   *
   * 幂等：已经搬走的不在 recent 里，再调一次移动 0 条。
   *
   * ★ 但这个幂等**只管同一批 keys**。`suggestAiGames()` 的推断在数据被改过之后
   * 会漂移（搬走一行会让那个人的「最老流水」变新，于是原来能被截断解释的缺口
   * 变成解释不了），所以「重新推一遍候选再 apply」不是幂等的 ——
   * 2026-10-30 就是这样多搬了 12 条真实战绩（15 条里有 4 条无辜）。
   * 因此候选必须**先冻结成一份 key 列表**再执行，接口层也改成必须显式给 keys。
   */
  markAiGames(keys) {
    const set = new Set((keys || []).map(String));
    let moved = 0;
    let touched = 0;
    if (!set.size) return { moved: 0, profiles: 0 };
    this.data.forEach((p) => {
      if (!Array.isArray(p.recent) || !p.recent.length) return;
      const prev = this._snapshot(p);
      const tail = this._residual(prev, p.recent);   // ★ 改动前算残值
      const keep = [];
      const take = [];
      p.recent.forEach((it) => {
        const k = String(it.roomId) + '#' + String(it.endedAt);
        if (set.has(k)) { it.ai = true; take.push(it); } else keep.push(it);
      });
      if (!take.length) return;
      p.recent = keep;
      if (!Array.isArray(p.aiRecent)) p.aiRecent = [];
      take.forEach((it) => p.aiRecent.push(it));
      p.aiRecent.sort((a, b) => (Number(b.endedAt) || 0) - (Number(a.endedAt) || 0));
      if (p.aiRecent.length > AI_RECENT_MAX) p.aiRecent.length = AI_RECENT_MAX;
      p.aiGames = (Number(p.aiGames) || 0) + take.length;
      this._afterMove(p, prev, tail);
      moved += take.length;
      touched += 1;
    });
    if (moved) {
      this.dirty = true;
      this._invalidateStandings();
      if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
      this.flush();                 // 立刻落盘：历史修正不该停在一个 500ms 窗口里
    }
    return { moved: moved, profiles: touched };
  }

  /**
   * 撤销上面的修正：把这些场次从 aiRecent 搬回 recent，并重算。
   *
   * 为什么必须有：推断就是推断，判错了要能一键退回去 ——
   * 而这正是 2026-10-30 真实发生过的事（见 markAiGames 的注释）。
   * 注意它**不能凭空变回**已经被上一次重算吃掉的窗口外历史（那需要 restoreFrom）。
   */
  unmarkAiGames(keys) {
    const set = new Set((keys || []).map(String));
    let moved = 0;
    let touched = 0;
    if (!set.size) return { moved: 0, profiles: 0 };
    this.data.forEach((p) => {
      if (!Array.isArray(p.aiRecent) || !p.aiRecent.length) return;
      const prev = this._snapshot(p);
      const tail = this._residual(prev, p.recent);   // ★ 改动前算残值
      const keep = [];
      const back = [];
      p.aiRecent.forEach((it) => {
        const k = String(it.roomId) + '#' + String(it.endedAt);
        if (set.has(k)) { delete it.ai; back.push(it); } else keep.push(it);
      });
      if (!back.length) return;
      p.aiRecent = keep;
      if (!Array.isArray(p.recent)) p.recent = [];
      back.forEach((it) => p.recent.push(it));
      p.recent.sort((a, b) => (Number(b.endedAt) || 0) - (Number(a.endedAt) || 0));
      /* 塞回窗口后如果超了上限，被挤出去的那几条要并进残值 ——
       * 直接 length = 20 等于把它们从统计里删掉（和「重算只按 recent」同一个坑）。 */
      if (p.recent.length > RECENT_MAX) {
        const cut = p.recent.slice(RECENT_MAX);
        p.recent.length = RECENT_MAX;
        const c = this._aggregate(cut);
        tail.games += c.games;
        tail.wins += c.wins;
        tail.losses += c.losses;
        tail.draws += c.draws;
        tail.totalNet += c.totalNet;
        tail.bestNet = Math.max(tail.bestNet, c.bestNet);
        tail.longestStreak = Math.max(tail.longestStreak, c.longestStreak);
        tail.longestLoseStreak = Math.max(tail.longestLoseStreak, c.longestLoseStreak);
      }
      p.aiGames = Math.max(0, (Number(p.aiGames) || 0) - back.length);
      this._afterMove(p, prev, tail);
      moved += back.length;
      touched += 1;
    });
    if (moved) {
      this.dirty = true;
      this._invalidateStandings();
      if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
      this.flush();
    }
    return { moved: moved, profiles: touched };
  }

  /**
   * 用一份完整档案快照覆盖当前数据（灾备 / 误操作回滚）。
   *
   * 只接受 dump() 那种形状（数组，每项有 playerId）。刻意**保留** _seen 幂等键：
   * 它不在 dump 里，所以覆盖时按 playerId 继承旧的 —— 否则恢复之后，
   * 一个还在内存里的结算房间再广播一次，就会把刚恢复掉的场次又写回来。
   */
  restoreFrom(list) {
    if (!Array.isArray(list) || !list.length) return { ok: false, error: '快照为空' };
    const next = new Map();
    let skipped = 0;
    list.forEach((raw) => {
      if (!raw || !raw.playerId) { skipped += 1; return; }
      const p = this._blank(String(raw.playerId), String(raw.nickname || '玩家'));
      Object.keys(raw).forEach((k) => {
        if (k === 'playerId' || k === 'nickname' || k === 'account') return;
        p[k] = raw[k];
      });
      if (raw.account) p.account = raw.account;
      const old = this.data.get(p.playerId);
      if (old && old._seen) p._seen = old._seen;
      this._ensureDerived(p);
      next.set(p.playerId, p);
    });
    if (!next.size) return { ok: false, error: '快照里没有可用档案' };
    this.data = next;
    this._rebuildNameIndex();
    this.dirty = true;
    this._invalidateStandings();
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.flush();
    return { ok: true, count: next.size, skipped: skipped };
  }

  /**
   * 在历史流水里找「几乎可以断定含 AI」的场次。
   *
   * 判据（能用的证据只有这么多，必须说清）：
   *   服务端从来没有存过「这一局有哪几个人」——房间是内存对象，结算完就回收了。
   *   唯一留下的痕迹是流水里的 playerCount（含 AI 的全座人数）
   *   与「有多少个真实档案记了这一场」之间的差。
   *
   *   差额本身不等于有 AI：一个真人如果后来删了账号，或者他那一场掉出了
   *   recent 的 20 条窗口，也会造成同样的差额。所以还要排除这两种解释：
   *     · 被截断的人只可能「藏」比自己最老一条更早的场次
   *       （recent 是滚动窗口，丢的永远是最旧的）；
   *     · 因此只有当所有可能藏人的场次都**晚于**那个人的最老流水时，
   *       这个差额才是无法解释的 —— 那就是 AI 座位。
   *
   * 返回候选（供人工确认后再 apply），不直接改数据。
   */
  suggestAiGames() {
    const games = new Map();     // key → { roomId, endedAt, playerCount, humans:Set }
    const trunc = new Map();     // playerId → 该玩家「被窗口丢掉的最早一条」的上界
    this.data.forEach((p, id) => {
      const rec = Array.isArray(p.recent) ? p.recent : [];
      let oldest = 0;
      rec.forEach((it) => { if (!oldest || it.endedAt < oldest) oldest = it.endedAt; });
      const cut = (Number(p.games) || 0) - rec.length;
      if (cut > 0 && oldest) trunc.set(id, oldest);
      rec.forEach((it) => {
        const key = String(it.roomId) + '#' + String(it.endedAt);
        let g = games.get(key);
        if (!g) {
          g = { key: key, roomId: it.roomId, endedAt: it.endedAt, playerCount: Number(it.playerCount) || 0, humans: new Set() };
          games.set(key, g);
        }
        g.humans.add(id);
        if (!g.playerCount && it.playerCount) g.playerCount = Number(it.playerCount) || 0;
      });
    });

    const out = [];
    games.forEach((g) => {
      if (!g.playerCount || g.playerCount <= g.humans.size) return;   // 没有空座位
      let explained = false;
      trunc.forEach((oldest, id) => {
        if (explained || g.humans.has(id)) return;
        if (g.endedAt < oldest) explained = true;   // 这个人的流水被截断了，可能就是他
      });
      if (explained) return;
      out.push({
        key: g.key,
        roomId: g.roomId,
        endedAt: g.endedAt,
        playerCount: g.playerCount,
        humans: g.humans.size,
        gap: g.playerCount - g.humans.size,
        nicknames: Array.from(g.humans).map((id) => (this.data.get(id) || {}).nickname || id)
      });
    });
    out.sort((a, b) => a.endedAt - b.endedAt);
    return out;
  }

  /**
   * 完整榜单（按净胜倒序）：top / rankOf 共用同一套排序，避免两处口径不一致。
   *
   * **带缓存**：`/api/leaderboard` 是每次打开榜单页都会打的接口，
   * 而档案上到几万条时，每次请求都全表遍历 + sort 是白白烧 CPU。
   * 缓存靠写入点显式失效（`_invalidateStandings`），所以任何改分数/改昵称/删档
   * 的路径都必须调到它——`server/test/leaderboard-cache.test.js` 逐条验过。
   *
   * `p.games > 0` 是入榜门槛：含 AI 的对局不计入 games，
   * 于是「只跟 AI 打过」的人不会出现在榜上——这正是用户要的口径。
   */
  _standings() {
    if (this._standingsCache) return this._standingsCache;
    const list = [];
    this.data.forEach((p) => {
      if (p.games > 0) {
        list.push({
          playerId: p.playerId,
          nickname: p.nickname,
          games: p.games,
          wins: p.wins,
          winRate: p.games ? Math.round(p.wins / p.games * 100) : 0,
          totalNet: p.totalNet
        });
      }
    });
    list.sort((a, b) => b.totalNet - a.totalNet || b.wins - a.wins);
    this._standingsCache = list;
    return list;
  }

  /** 榜单一有变化就调它。忘记调 = 榜单显示旧数据，属于「查起来很痛」的那类 bug。 */
  _invalidateStandings() {
    this._standingsCache = null;
  }

  /** 排行榜：按净胜排（v0.2 先用净胜做口径，榜单页上线时再定稿） */
  top(limit) {
    return this._standings().slice(0, limit || 50);
  }

  /**
   * 某个玩家在完整榜单里的名次（1-based）+ 自己的那行摘要。
   * 榜单页只给 top 50，51 名开外的人原本看不到自己——「榜上没我」比「第几」伤得多。
   * 没打过牌（不入榜）返回 null。
   */
  rankOf(playerId) {
    const id = String(playerId == null ? '' : playerId);
    if (!id) return null;
    const all = this._standings();
    for (let i = 0; i < all.length; i++) {
      if (String(all[i].playerId) === id) {
        return Object.assign({ rank: i + 1, total: all.length }, all[i]);
      }
    }
    return null;
  }
}

module.exports = { ProfileStore };
