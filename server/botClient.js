/**
 * 自动对战的协议客户端（命令行脚本与服务端后台**共用同一份**）
 *
 * 为什么抽成模块：这条链路原本只活在 `scripts/cloud-bot-match.js` 里。
 * 后台「模拟对战」要的是同一套动作（登录 → ws 鉴权 → 建房 → 进房 → 准备 →
 * 每轮拆两组牌提交 → 打满 handLimit 落库）。如果复制一份进服务端，
 * 就有两份协议实现：协议一改（比如 reqId 改名、auth 换字段），
 * 命令行还绿着、后台已经悄悄坏了 —— 这正是这个仓库反复踩过的「双实现漂移」。
 *
 * 三条不能省的口径（都是服务端源码里定死的，绕不过去）：
 *
 *   1. **只能真实账号，不能补 AI。** `hub._persistSettlement` 里 `hasBot` 为真时
 *      整局只进 `aiRecent`，排行榜与积分一概不动。所以「用 AI 凑人数刷分」
 *      在榜单上完全看不见。
 *
 *   2. **一个房间 = 一场战绩。** 落库只发生在 `phase === SETTLED`，
 *      而房间要打满 `handLimit` 把才会 SETTLED；没打满就散，那一场一分记录都没有。
 *      于是「打 30 把」和「打 30 场」是两件事。
 *
 *   3. **令牌走 `X-Session-Token`。** 部署网关会把 `Authorization` 头吃掉，
 *      只有自定义头能过（见 `pwa/js/authStore.js` 的注释）。
 *
 * 本模块**不读 process.argv、不 process.exit、不写文件** —— 那些是 CLI 的事。
 * 出错一律 throw，由调用方决定是退出进程还是把错误记进任务状态。
 */
'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => Math.round(a + Math.random() * (b - a));

/* 拆牌策略直接复用 `pwa/js/ai.js` —— 单机模式的 AI 就在做这件事（穷举 60 / 6 种分法，
 * 按引擎口径给每组算强度，加权取最优）。**不另写一套**：另写一套就又有了两份
 * 「什么算好牌」的定义，改规则时必然漂移。
 *
 * 为什么要换掉原来的「按位置拆」：那是**能跑通协议**的最短实现，不是会打牌的实现。
 * 实测 6 万手牌（`scripts/analyze-bot-split.js`）：
 *   · 十点半爆点率  31.1%  → 0.5%（AI 会避开爆点）
 *   · 第二轮牛牛率  13.3%  → 39.7%
 *   · 单张对随机牌胜率 49.9% → 71.2%
 * 也就是说机器人原来每把都在系统性自废三组牌里的两组，造出来的数据不能代表真人。 */
const path = require('path');
const AI = require(path.join(__dirname, '..', 'pwa', 'js', 'ai.js'));

/** 主动取消。调用方靠 `err.cancelled === true` 区分「取消」与「真失败」。 */
class CancelledError extends Error {
  constructor(msg) {
    super(msg || '任务已取消');
    this.name = 'CancelledError';
    this.cancelled = true;
  }
}

/* ============================ HTTP ============================ */

/**
 * 一个绑定了 base / sharecode 的 HTTP 客户端。
 *
 * · **每个请求都要带 sharecode**：部署网关对不带的一律 403（连 /api/health 都是）。
 * · **令牌走 `X-Session-Token`，不要用 `Authorization: Bearer`**（见文件头第 3 条）。
 */
function createApi(opts) {
  const base = String((opts && opts.base) || '').replace(/\/+$/, '');
  const code = String((opts && opts.code) || '');
  if (!base) throw new Error('createApi 缺少 base');

  async function call(pathname, o) {
    const opt = o || {};
    const url = new URL(base + pathname);
    if (code) url.searchParams.set('sharecode', code);
    const headers = { 'Content-Type': 'application/json' };
    if (opt.token) headers['X-Session-Token'] = opt.token;
    const res = await fetch(url, {
      method: opt.method || 'GET',
      headers: headers,
      body: opt.body ? JSON.stringify(opt.body) : undefined
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = { ok: false, error: '非 JSON 响应 HTTP ' + res.status + '：' + text.slice(0, 120) };
    }
    if (!res.ok && (data == null || data.ok === undefined)) data = { ok: false, error: 'HTTP ' + res.status };
    return data;
  }

  return {
    call: call,
    async leaderboard() {
      const r = await call('/api/leaderboard');
      if (!r.ok) throw new Error('读排行榜失败：' + r.error);
      return r.list || [];
    }
  };
}

/* ============================ 一个机器人 ============================ */

class BotClient {
  /**
   * @param {object} o
   *   base / code   与 createApi 一致
   *   account       { name, password }
   *   index         座位序号（0 起），只用于日志与任务明细
   *   log           (msg) => void，可为空
   *   register      账号不存在时尝试注册（**只给本地自测与测试用**，线上别开）
   *   api           复用外部 createApi（可选，省一个实例）
   */
  constructor(o) {
    const opt = o || {};
    this.base = String(opt.base || '').replace(/\/+$/, '');
    this.code = String(opt.code || '');
    this.name = (opt.account && opt.account.name) || '';
    this.password = (opt.account && opt.account.password) || '';
    this.idx = Number(opt.index) || 0;
    this.tag = '[#' + (this.idx + 1) + ' ' + this.name + ']';
    this.log = opt.log || function () {};
    this.register = !!opt.register;
    /* 'smart' | 'naive'。默认 smart —— 后台模拟的是「真人怎么打」，
     * 而真人会挑牌。naive 只作对照，见 split() 的注释。 */
    this.strategy = opt.strategy === 'naive' ? 'naive' : 'smart';

    this.api = opt.api || createApi({ base: this.base, code: this.code });

    this.token = '';
    this.playerId = '';
    this.nickname = '';
    this.room = null;
    this.roomId = '';
    this.ws = null;
    this.reqSeq = 0;
    this.pending = new Map();
    this.dead = false;
    this.lastDeleted = null;
  }

  /* ---- 登录：拿令牌 ---- */
  async login() {
    let r = await this.api.call('/api/auth/login', {
      method: 'POST',
      body: { name: this.name, password: this.password }
    });
    /* 登录失败时服务端**故意不区分**「账号不存在」和「密码错」（防账号枚举），
     * 所以不能靠错误文案判断，只能「登录失败就试一次注册」：已存在会被注册接口
     * 挡回来，那时把原始登录错误一并带出来，免得把真相盖掉。 */
    if (!r.ok && this.register) {
      const reg = await this.api.call('/api/auth/register', {
        method: 'POST',
        body: { name: this.name, password: this.password, nickname: this.name }
      });
      if (reg.ok) {
        r = reg;
        this.log(this.tag + ' 账号不存在 → 已注册');
      } else {
        this.log(this.tag + ' 注册没成：' + reg.error + '（原始登录错误：' + r.error + '）');
      }
    }
    if (!r.ok) throw new Error(this.tag + ' 登录失败：' + r.error);
    this.token = r.token;
    this.playerId = r.me.playerId;
    this.nickname = r.me.nickname || this.name;
    this.log(this.tag + ' 登录成功 playerId=' + this.playerId + ' 昵称=' + this.nickname);
    return this;
  }

  /* ---- 连 WebSocket 并出示令牌 ---- */
  async connect() {
    /* ws 也必须带 sharecode（网关对 /ws 一样要求），
     * 不带的话握手直接被拒成「非 101」，症状是「连不上但没有任何报错」。 */
    const wsBase = this.base.replace(/^http/, 'ws') + '/ws';
    const url = this.code ? wsBase + '?sharecode=' + encodeURIComponent(this.code) : wsBase;
    if (typeof WebSocket === 'undefined') {
      throw new Error('当前 Node 没有内置 WebSocket（需要 Node 22+）');
    }
    const ws = new WebSocket(url);
    this.ws = ws;
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(this.tag + ' ws 连接超时')), 15000);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(t); reject(new Error(this.tag + ' ws 连接失败（网关/网络）')); }, { once: true });
    });
    ws.addEventListener('message', (ev) => this._onMessage(ev.data));
    ws.addEventListener('close', () => { this.dead = true; });

    const a = await this.request('auth', { token: this.token });
    this.playerId = a.playerId || this.playerId;
    this.log(this.tag + ' ws 已鉴权');
    return this;
  }

  _onMessage(raw) {
    let d;
    try { d = JSON.parse(typeof raw === 'string' ? raw : raw); } catch (e) { return; }
    if (!d) return;
    if (d.type === 'room') {
      const room = d.payload && d.payload.room;
      if (room) {
        this.room = room;
        this.roomId = (d.payload && d.payload.roomId) || this.roomId;
      }
    } else if (d.type === 'roomDeleted') {
      this.room = null;
      this.lastDeleted = d.payload || {};
    } else if (d.type === 'ok') {
      const p = this.pending.get(d.reqId);
      if (p) { this.pending.delete(d.reqId); p.resolve(d.payload || {}); }
    } else if (d.type === 'error') {
      const p = this.pending.get(d.reqId);
      if (p) { this.pending.delete(d.reqId); p.reject(new Error((d.payload && d.payload.error) || '请求失败')); }
      else if (d.reqId == null) this.log(this.tag + ' 连接级错误：' + ((d.payload && d.payload.error) || ''));
    }
  }

  request(type, payload) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new Error(this.tag + ' 连接已断开'));
      const reqId = ++this.reqSeq;
      const timer = setTimeout(() => {
        if (this.pending.has(reqId)) { this.pending.delete(reqId); reject(new Error(this.tag + ' ' + type + ' 超时')); }
      }, 12000);
      this.pending.set(reqId, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      this.ws.send(JSON.stringify({ type: type, payload: payload || {}, reqId: reqId }));
    });
  }

  me() {
    if (!this.room) return null;
    return (this.room.players || []).find((p) => p.id === this.playerId) || null;
  }

  /* 等房间满足某个条件。轮询 80ms —— 广播本来就是这个量级，
   * 用事件回调会在「状态早就满足但广播还没到」时卡住，反而更脆。 */
  async waitFor(pred, timeout, label, shouldAbort) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      /* 取消请求在这里也要能立刻生效。只在「每把开头」检查的话，
       * 一次 25 秒的等结算会让后台的「停止」按下去半分钟没反应 ——
       * 用户只会以为按钮坏了，然后反复点。 */
      if (shouldAbort && shouldAbort()) throw new CancelledError();
      if (this.room && pred(this.room, this)) return this.room;
      if (this.dead) throw new Error(this.tag + ' 连接已断开（等 ' + label + ' 时）');
      await sleep(80);
    }
    const st = this.room
      ? 'phase=' + this.room.phase + ' round=' + this.room.round + ' hand=' + (this.room.handCount || 0)
      : '没有房间视图';
    throw new Error(this.tag + ' 等超时：' + label + '（' + timeout + 'ms，' + st + '）');
  }

  /** 按当前轮把 6 张牌拆成两组交上去。
   *
   *  两种打法：
   *    smart（默认）—— 交给 `pwa/js/ai.js` 穷举最优。它和单机 AI 是同一份实现，
   *                    所以「机器人打出来的牌」与「真人在单机里遇到的 AI」同源。
   *    naive        —— 按位置硬拆（[0] / [1,2] / [3,4,5]）。这是最早那版，只保证
   *                    **协议合法**：张数与手牌一一对应。留着当对照组，用来复现
   *                    「策略差 → 数据难看」这件事，不再作为默认。
   *
   *  无论哪种，都只动**自己的 6 张牌**的分组，不碰发牌、不碰别人 —— 发牌是服务端的，
   *  客户端连牌序都影响不了（见 card.js 为什么不用 Math.random）。 */
  async submitRound(round) {
    const me = this.me();
    if (!me) throw new Error(this.tag + ' 不在房间名单里');
    if (me.benched) return;                       // 旁听这一把没牌
    const hand = me.hand || [];
    if (hand.length !== 6) throw new Error(this.tag + ' 手牌不是 6 张（实际 ' + hand.length + '）');
    const groups = this.split(hand, round);
    await this.request('submitGroups', { groups: groups });
  }

  /** 拆牌：返回**只含本轮合法键**的对象（服务端会拒掉多余的键）。 */
  split(hand, round) {
    if (this.strategy === 'naive') {
      return round === 1
        ? { single: [hand[0]], tenhalf: [hand[1], hand[2]], piaosanye: [hand[3], hand[4], hand[5]] }
        : { single: [hand[0]], douniu: [hand[1], hand[2], hand[3], hand[4], hand[5]] };
    }
    const d = round === 1 ? AI.decideRound1(hand) : AI.decideRound2(hand);
    if (round === 1) {
      /* AI 会返回四个键（douniu 为空数组）；第一轮只准交三个，多交会被校验挡住。 */
      return { single: d.single, tenhalf: d.tenhalf, piaosanye: d.piaosanye };
    }
    return { single: d.single, douniu: d.douniu };
  }

  close() {
    try { if (this.ws) this.ws.close(); } catch (e) { /* 已经断了 */ }
  }
}

/* ============================ 一场（一个房间） ============================ */

function snapshot(room) {
  const o = {};
  (room.players || []).forEach((p) => { o[p.nickname || p.id] = Number(p.score) || 0; });
  return o;
}

/**
 * 开一场并打完它。
 *
 * @param {BotClient[]} bots 已登录且已连 ws，bots[0] 当房主
 * @param {number} handLimit 这一场打几把（3/5/10/15/30）
 * @param {object} [opts]
 *   pace      [min,max] 每轮提交前的随机停顿
 *   gap       [min,max] 把与把之间的随机停顿
 *   onRoomStart({roomId, handLimit})
 *   onPhase({phase, handNo})
 *   onHand({handNo, scores, settled})
 *   shouldAbort()  返回真则抛 CancelledError（在每把的边界检查，不打断已发出的提交）
 * @returns {{roomId,hands,scores,endReason,voided}}
 */
async function playOneRoom(bots, handLimit, opts) {
  const o = opts || {};
  const pace = o.pace || [900, 2600];
  const gap = o.gap || [2000, 6000];
  const onRoomStart = o.onRoomStart || function () {};
  const onPhase = o.onPhase || function () {};
  const onHand = o.onHand || function () {};
  const shouldAbort = o.shouldAbort || function () { return false; };

  const abortCheck = () => { if (shouldAbort()) throw new CancelledError(); };
  const host = bots[0];

  /* ---- 建房 / 进房 ---- */
  abortCheck();
  const created = await host.request('createRoom', { handLimit: handLimit });
  const roomId = created.room && created.room.roomId;
  if (!roomId) throw new Error('建房没拿到房间号');
  onRoomStart({ roomId: roomId, handLimit: handLimit });

  for (let i = 1; i < bots.length; i++) {
    await bots[i].request('joinRoom', { roomId: roomId });
  }
  /* 全员到齐 + 全员准备 → 服务端 `autoStartIfReady` 自动开局。
   * 注意「准备」是开局前的事；一旦开局，后续把与把之间**不需要再点准备** ——
   * 打第二把是 `settleRound` 里直接发牌（同一次调用里 phase 已经变回 ROUND1_SPLIT），
   * 这也是为什么这里看不到 wantNext。 */
  for (const b of bots) await b.request('ready', { ready: true });

  const any = bots[0];
  await any.waitFor((r) => r.phase === 'ROUND1_SPLIT', 20000, '开局发牌', shouldAbort);
  onPhase({ phase: 'ROUND1_SPLIT', handNo: any.room.handCount || 0 });

  /* ---- 逐把打 ---- */
  let hands = 0;
  let guard = 0;
  const seen = {};   // handNo -> true，防止同一把被重复计数

  while (true) {
    abortCheck();
    if (++guard > (handLimit + 2) * 4) throw new Error('把数推进异常（guard 触发），提前中止');

    const room = any.room;
    if (room.phase === 'SETTLED') break;

    if (room.phase === 'ROUND1_SPLIT') {
      const handNo = room.handCount || 0;
      onPhase({ phase: 'ROUND1_SPLIT', handNo: handNo });
      await sleep(rand(pace[0], pace[1]));
      abortCheck();
      for (const b of bots) { await b.submitRound(1); }
      /* 等第二轮：全员交完，服务端 `settleIfAllIn` 立刻结算第一轮并翻轮 */
      await any.waitFor((r) => r.phase === 'ROUND2_SPLIT' || r.phase === 'SETTLED', 25000, '第一轮结算', shouldAbort);
      if (any.room.phase === 'SETTLED') continue;
      onPhase({ phase: 'ROUND2_SPLIT', handNo: handNo });

      await sleep(rand(pace[0], pace[1]));
      abortCheck();
      for (const b of bots) { await b.submitRound(2); }

      /* 第二轮结算后有两种落点：
       *   · 还没打满 → 同一次调用里发下一把，phase 直接回到 ROUND1_SPLIT（handCount+1）
       *   · 打满了   → SETTLED，并触发落库
       * 所以这里等的是「phase 变了」，不是「出现结算屏」。 */
      await any.waitFor(
        (r) => r.phase === 'SETTLED' || (r.phase === 'ROUND1_SPLIT' && (r.handCount || 0) > handNo),
        25000,
        '第二轮结算',
        shouldAbort
      );

      if (!seen[handNo]) {
        seen[handNo] = true;
        hands += 1;
        onHand({
          handNo: hands,
          scores: snapshot(any.room),
          settled: any.room.phase === 'SETTLED'
        });
      }
      if (any.room.phase === 'SETTLED') break;
      await sleep(rand(gap[0], gap[1]));
      continue;
    }

    /* 中间态（ROUND1_SETTLE 之类）等一拍再看 */
    await sleep(120);
  }

  const final = any.room;
  const scores = {};
  for (const b of bots) {
    const p = (final.players || []).find((x) => x.id === b.playerId);
    const cur = p ? Number(p.score) || 0 : 0;
    /* 「本场」增量一律以 0 为基准（CONFIG.INITIAL_SCORE=0）。
     * 这里**不能**拿上一场的终局分当基准 —— 新房间的分数是从 0 重新发牌的，
     * 而玩家 id 不变；拿上一场去减，会出现「本场 +20」这种把上场亏损倒补回来的假数字。 */
    scores[b.playerId] = { nickname: p ? p.nickname : b.nickname, score: cur, delta: cur };
  }
  return { roomId: roomId, hands: hands, scores: scores, endReason: final.endReason || '', voided: !!final.voided };
}

module.exports = {
  BotClient: BotClient,
  CancelledError: CancelledError,
  createApi: createApi,
  playOneRoom: playOneRoom,
  snapshot: snapshot,
  sleep: sleep,
  rand: rand
};
