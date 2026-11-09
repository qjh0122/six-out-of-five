/**
 * 后台「模拟对战」的任务管理器
 *
 * 职责：接一份任务描述（谁打、打几场、每场几把）→ 在服务端进程内跑完 →
 * 把进度与明细暴露给管理页。
 *
 * 三个设计决定，都不是随手定的：
 *
 * 1. **连接走环回地址，不绕公网。**
 *    任务是服务端自己发起的，再走一遍部署网关既没有意义、还要多带一次 sharecode。
 *    但**协议本身完全一样**（同样是 /ws + auth 帧 + submitGroups），
 *    所以这里跑出来的数据和真人、和命令行脚本跑出来的完全同源。
 *    默认 `http://127.0.0.1:${PORT}`，可用 BOT_BASE 覆盖。
 *
 * 2. **密码只活在内存里，绝不落盘。**
 *    `job` 对象里只有账号名。密码在 `_run()` 的局部变量里用完即弃，
 *    任务历史写进 bot-jobs.json 时也就永远不含密码。
 *    这条不是洁癖：后台历史文件是长期保留的，密码一旦写进去就等于明文库存。
 *
 * 3. **同一时刻只允许一个任务。**
 *    两个任务并行会互相干扰：排行榜基线互相污染（A 任务算「场次涨了几」时
 *    B 也在涨），房间与连接数翻倍，出错时也说不清是谁的锅。
 *    第二个请求直接 409，并把正在跑的任务 id 带回去。
 *
 * 出错处理：整个 `_run()` 包在 try/catch 里，**任何异常都不会冒泡成
 * unhandledRejection** —— 服务端对 unhandledRejection 只记日志，
 * 但 uncaughtException 会直接退出进程（见 index.js 末尾），
 * 一个后台任务不该有让整服重启的能力。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { BotClient, CancelledError, createApi, playOneRoom } = require('./botClient.js');

/** 建房时服务端只认这几个值（与 `stateMachine.handLimitOptions` 同一份口径） */
const HAND_LIMITS = [3, 5, 10, 15, 30];
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 5;
const MAX_ROOMS = 200;
const KEEP_JOBS = 40;          // 历史保留多少条（含未完成的）
const MAX_HANDS_KEPT = 800;    // 单个任务最多留多少条逐把流水

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.floor(Number(v));
  if (!isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};

const pairOf = (v, dflt) => {
  if (!Array.isArray(v) || v.length !== 2) return dflt;
  const a = Number(v[0]);
  const b = Number(v[1]);
  if (!isFinite(a) || !isFinite(b)) return dflt;
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.max(0, Math.max(a, b));
  return [lo, Math.min(20000, hi)];
};

class BotRunner {
  /**
   * @param {object} opts
   *   base      函数，返回环回地址（延迟取值，避免构造时 PORT 还没定）
   *   log       日志函数
   *   storeFile 任务历史落盘路径（空字符串 = 不落盘，测试用）
   */
  constructor(opts) {
    const o = opts || {};
    this.base = typeof o.base === 'function' ? o.base : () => String(o.base || '');
    this.log = o.log || function () {};
    this.storeFile = o.storeFile || '';

    this.jobs = new Map();      // id -> job
    this.order = [];            // id，最新在前
    this.runningId = '';        // 当前任务 id（'' = 空闲）
    this._cancel = new Set();   // 被请求取消的 id
    this._load();
  }

  /* ------------------------------ 校验 ------------------------------ */

  /** 把外部输入收敛成 task 描述；不合法就 throw（由路由转成 400）。 */
  normalize(spec) {
    const s = spec || {};

    const raw = Array.isArray(s.players) ? s.players : [];
    if (raw.length < MIN_PLAYERS) throw new Error('至少需要 ' + MIN_PLAYERS + ' 个玩家（服务端 MIN_PLAYERS=' + MIN_PLAYERS + '）');
    if (raw.length > MAX_PLAYERS) throw new Error('最多 ' + MAX_PLAYERS + ' 个玩家（服务端 MAX_PLAYERS=' + MAX_PLAYERS + '）');

    const seen = {};
    const players = raw.map((p, i) => {
      const name = String((p && p.account) || '').trim();
      const password = String((p && p.password) || '');
      if (!name) throw new Error('第 ' + (i + 1) + ' 个玩家缺账号名');
      if (!password) throw new Error('账号「' + name + '」没填密码');
      if (seen[name]) throw new Error('账号「' + name + '」重复选了两遍');
      seen[name] = true;
      /* 这里统一收敛成 { name, password }：这是协议客户端认的形状。
       * 外面传进来的字段叫 account（页面上的「账号」），两套名字混用会出
       * 「tag 里账号是空的 → 登录失败：账号或密码不正确」这种查起来很绕的错。 */
      return { name: name, password: password };
    });

    const rooms = clampInt(s.rooms, 1, MAX_ROOMS, 1);
    const handsPerRoom = HAND_LIMITS.includes(Number(s.handsPerRoom)) ? Number(s.handsPerRoom) : 3;

    return {
      players: players,
      rooms: rooms,
      handsPerRoom: handsPerRoom,
      pace: pairOf(s.pace, [900, 2600]),
      gap: pairOf(s.gap, [2000, 6000]),
      register: !!s.register,
      /* 打法：smart = 像真人一样挑牌（默认）；naive = 按位置硬拆（对照组）。
       * 只认这两个值，其余一律落到 smart —— 「模拟真人」是这功能的默认语义，
       * 不该因为外部传了个没见过的字符串就悄悄退化成一个不会打牌的机器人。 */
      strategy: s.strategy === 'naive' ? 'naive' : 'smart'
    };
  }

  /* ------------------------------ 启停 ------------------------------ */

  start(spec) {
    if (this.runningId) {
      const err = new Error('已有任务在跑：' + this.runningId + '（同一时刻只允许一个任务）');
      err.code = 'BUSY';
      err.jobId = this.runningId;
      throw err;
    }
    const task = this.normalize(spec);

    const job = {
      id: 'job-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      status: 'running',                 // running | cancelling | done | failed | cancelled | interrupted
      createdAt: Date.now(),
      startedAt: Date.now(),
      endedAt: 0,
      /* 注意：**这里只有账号名，没有密码**（见文件头第 2 条） */
      spec: {
        rooms: task.rooms,
        handsPerRoom: task.handsPerRoom,
        pace: task.pace,
        gap: task.gap,
        register: task.register,
        strategy: task.strategy,
        playerCount: task.players.length
      },
      players: task.players.map((p) => ({ account: p.name, nickname: '', playerId: '' })),
      progress: {
        roomsDone: 0,
        roomsTotal: task.rooms,
        handsDone: 0,
        handsTotal: task.rooms * task.handsPerRoom,
        roomIndex: 0,
        handNo: 0,
        phase: '准备中',
        roomId: '',
        lastEventAt: Date.now()
      },
      baseline: {},
      after: {},
      rooms: [],
      hands: [],
      error: ''
    };

    this.jobs.set(job.id, job);
    this.order.unshift(job.id);
    this.runningId = job.id;
    this._trim();
    this._persist();

    /* 不 await：路由要立刻把 job 回给页面，进度靠轮询看。
     * _run 内部自己兜住所有异常，不会变成 unhandledRejection。 */
    this._run(job, task);

    return this.summary(job);
  }

  cancel(id) {
    const job = this.jobs.get(String(id || ''));
    if (!job) return { ok: false, code: 'NOTFOUND', error: '找不到这个任务' };
    if (job.status !== 'running') return { ok: false, code: 'NOT_RUNNING', error: '任务已经是「' + job.status + '」，不能取消' };
    this._cancel.add(job.id);
    job.status = 'cancelling';
    job.progress.phase = '正在停止…';
    this._persist();
    return { ok: true, job: this.summary(job) };
  }

  /* ------------------------------ 查询 ------------------------------ */

  summary(job) {
    return {
      id: job.id,
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      spec: job.spec,
      /* playerId 必须带出去：baseline / after 是按 playerId 索引的，
       * 摘要里剥掉它就等于让页面没法把「谁的场次涨了几」对上号
       * （第一版就是这里漏了，页面上所有增量都显示 0→0，而榜单其实在涨）。 */
      players: job.players.map((p) => ({
        account: p.account, nickname: p.nickname || p.account, playerId: p.playerId || ''
      })),
      progress: job.progress,
      baseline: job.baseline,
      after: job.after,
      rooms: job.rooms.map((r) => ({
        index: r.index, roomId: r.roomId, status: r.status, hands: r.hands,
        handsTarget: r.handsTarget, endReason: r.endReason, voided: r.voided,
        scores: r.scores, error: r.error
      })),
      error: job.error
    };
  }

  /** 列表：不带逐把流水（几十场 × 几十把，列表页用不上） */
  list() {
    return this.order.map((id) => this.summary(this.jobs.get(id))).filter(Boolean);
  }

  /** 详情：带逐把流水 */
  get(id) {
    const job = this.jobs.get(String(id || ''));
    if (!job) return null;
    const o = this.summary(job);
    o.hands = job.hands.map((h) => ({ roomIndex: h.roomIndex, handNo: h.handNo, at: h.at, scores: h.scores }));
    return o;
  }

  /* ------------------------------ 执行 ------------------------------ */

  async _run(job, task) {
    const abort = () => this._cancel.has(job.id);
    let bots = [];
    let api = null;

    try {
      const base = String(this.base() || '').replace(/\/+$/, '');
      if (!base) throw new Error('没有可用的环回地址（BOT_BASE / PORT 都没设置）');
      api = createApi({ base: base, code: '' });

      job.progress.phase = '登录中';
      this._touch(job);

      for (let i = 0; i < task.players.length; i++) {
        const b = new BotClient({
          base: base,
          code: '',
          account: task.players[i],
          index: i,
          register: task.register,
          strategy: task.strategy,
          api: api,
          log: (m) => this.log('[bot ' + job.id + '] ' + m)
        });
        await b.login();
        await b.connect();
        bots.push(b);
        const slot = job.players[i];
        if (slot) { slot.nickname = b.nickname; slot.playerId = b.playerId; }
        job.progress.phase = '已连接 ' + bots.length + '/' + task.players.length;
        this._touch(job);
        if (abort()) throw new CancelledError();
      }

      /* 基线：不只在开始时取一次，每场结束都会重取（见下），
       * 这样即使别人同一时间也在打，本任务的增量也不会被算错。 */
      job.baseline = await this._boardMap(api);
      this._touch(job);

      for (let i = 1; i <= task.rooms; i++) {
        if (abort()) throw new CancelledError();

        const rec = {
          index: i,
          roomId: '',
          status: 'running',
          hands: 0,
          handsTarget: task.handsPerRoom,
          endReason: '',
          voided: false,
          scores: [],
          error: '',
          startedAt: Date.now(),
          endedAt: 0
        };
        job.rooms.push(rec);
        job.progress.roomIndex = i;
        job.progress.handNo = 0;
        job.progress.phase = '第 ' + i + ' / ' + task.rooms + ' 场 · 建房';
        this._touch(job);

        try {
          const res = await playOneRoom(bots, task.handsPerRoom, {
            pace: task.pace,
            gap: task.gap,
            shouldAbort: abort,
            onRoomStart: (e) => {
              rec.roomId = e.roomId;
              job.progress.roomId = e.roomId;
              job.progress.phase = '第 ' + i + ' / ' + task.rooms + ' 场 · 开局';
              this._touch(job);
            },
            onPhase: (e) => {
              job.progress.phase = '第 ' + i + ' / ' + task.rooms + ' 场 · 第 ' + ((e.handNo || 0) + 1) + ' 把';
              this._touch(job);
            },
            onHand: (e) => {
              rec.hands = e.handNo;
              job.progress.handsDone += 1;
              job.progress.handNo = e.handNo;
              job.progress.phase = '第 ' + i + ' / ' + task.rooms + ' 场 · 第 ' + e.handNo + ' 把已完成';
              if (job.hands.length < MAX_HANDS_KEPT) {
                job.hands.push({
                  roomIndex: i,
                  handNo: e.handNo,
                  at: Date.now(),
                  scores: Object.keys(e.scores).map((k) => ({ nickname: k, score: e.scores[k] }))
                });
              }
              this._touch(job);
            }
          });

          rec.status = 'done';
          rec.hands = res.hands;
          rec.endReason = res.endReason;
          rec.voided = res.voided;
          rec.scores = Object.keys(res.scores).map((pid) => ({
            nickname: res.scores[pid].nickname,
            score: res.scores[pid].score
          }));
          job.progress.roomsDone += 1;
          rec.endedAt = Date.now();
          this._touch(job);
        } catch (e) {
          if (e instanceof CancelledError || abort()) throw e;
          /* 单场失败不终止整个任务：房间崩了就重连一次，继续下一场。
           * 这和命令行脚本的行为一致 —— 一场偶发失败不该白扔后面几十场。 */
          rec.status = 'failed';
          rec.error = e.message;
          rec.endedAt = Date.now();
          job.progress.phase = '第 ' + i + ' 场失败：' + e.message;
          this._touch(job);
          this.log('[bot ' + job.id + '] 第 ' + i + ' 场失败：' + e.message);

          for (const b of bots) { try { b.close(); } catch (err) { /* 已断 */ } }
          await new Promise((r) => setTimeout(r, 1200));
          if (abort()) throw new CancelledError();
          for (const b of bots) { await b.connect(); }
        }
      }

      job.after = await this._boardMap(api);
      const failed = job.rooms.filter((r) => r.status === 'failed').length;
      const done = job.rooms.filter((r) => r.status === 'done').length;
      if (!done) throw new Error('一场都没打成（' + failed + ' 场失败）');
      job.status = 'done';
      job.progress.phase = '完成';
      job.error = failed ? ('有 ' + failed + ' 场失败，其余 ' + done + ' 场完成') : '';
    } catch (e) {
      if (e instanceof CancelledError || this._cancel.has(job.id)) {
        job.status = 'cancelled';
        job.progress.phase = '已取消';
        job.error = '';
      } else {
        job.status = 'failed';
        job.progress.phase = '失败';
        job.error = e && e.message ? e.message : String(e);
        this.log('[bot ' + job.id + '] 失败：' + job.error);
      }
      /* 尽量把「跑完的部分」也记下增量，页面才看得出已经产生了多少数据 */
      try { if (api) job.after = await this._boardMap(api); } catch (x) { /* 读不到就算了 */ }
    } finally {
      for (const b of bots) { try { b.close(); } catch (e) { /* 已断 */ } }
      job.endedAt = Date.now();
      job.progress.lastEventAt = Date.now();
      if (job.status === 'running') job.status = 'done';
      this.runningId = '';
      this._cancel.delete(job.id);
      this._persist();
    }
  }

  /** 排行榜 → { playerId: {games,totalNet,nickname} } */
  async _boardMap(api) {
    const list = await api.leaderboard();
    const map = {};
    (list || []).forEach((r) => {
      map[r.playerId] = { games: r.games, totalNet: r.totalNet, nickname: r.nickname };
    });
    return map;
  }

  _touch(job) {
    job.progress.lastEventAt = Date.now();
  }

  /* ------------------------------ 落盘 ------------------------------ */

  _trim() {
    while (this.order.length > KEEP_JOBS) {
      const id = this.order[this.order.length - 1];
      if (id === this.runningId) break;
      this.order.pop();
      this.jobs.delete(id);
    }
  }

  _persist() {
    if (!this.storeFile) return;
    try {
      const payload = {
        savedAt: Date.now(),
        jobs: this.order.map((id) => this.jobs.get(id)).filter(Boolean).map((j) => ({
          id: j.id,
          status: j.status,
          createdAt: j.createdAt,
          startedAt: j.startedAt,
          endedAt: j.endedAt,
          spec: j.spec,
          players: j.players,
          progress: j.progress,
          baseline: j.baseline,
          after: j.after,
          rooms: j.rooms,
          hands: j.hands.slice(-MAX_HANDS_KEPT),
          error: j.error
        }))
      };
      fs.mkdirSync(path.dirname(this.storeFile), { recursive: true });
      const tmp = this.storeFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload));
      fs.renameSync(tmp, this.storeFile);
    } catch (e) {
      /* 历史写不进去不能影响对局本身 */
      this.log('[bot] 任务历史写盘失败：' + (e && e.message ? e.message : e));
    }
  }

  _load() {
    if (!this.storeFile) return;
    let raw;
    try { raw = fs.readFileSync(this.storeFile, 'utf8'); } catch (e) { return; }
    let data;
    try { data = JSON.parse(raw); } catch (e) { return; }
    const list = Array.isArray(data && data.jobs) ? data.jobs : [];
    list.forEach((j) => {
      if (!j || !j.id) return;
      /* 进程重启前还在 running 的任务，实际已经没人推进了。
       * 标成 interrupted 而不是假装还在跑 —— 否则页面会一直转圈等一个不存在的进度。 */
      if (j.status === 'running' || j.status === 'cancelling') {
        j.status = 'interrupted';
        j.endedAt = j.endedAt || Date.now();
        if (j.progress) j.progress.phase = '服务重启，任务中断';
      }
      this.jobs.set(j.id, j);
      this.order.push(j.id);
    });
    this._trim();
  }
}

module.exports = { BotRunner, HAND_LIMITS, MIN_PLAYERS, MAX_PLAYERS, MAX_ROOMS };
