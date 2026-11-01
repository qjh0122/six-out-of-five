/**
 * 牌型特效「真跑」审计（v93）—— 真服务端 / 真发牌 / 真提交 / 真浏览器
 *
 * 回答的问题：**十点半 10.5 点、豹子、牛牛、五花牛，这四种牌型的特效动画
 * 以及它前后那几个场景（组牌 → 提交确认 → 等待 → 结算 → 回桌/交替卡），
 * 在上线的这一版里到底是不是真的会动。**
 *
 * 为什么以前的 probe-big-fx 不算数：
 *   它是**自己拼 DOM** 再量 CSS ——「CSS 会不会画」验到了，
 *   「真实链路会不会走到那段 CSS」完全没验。两条之间隔着：引擎给不给这个名字、
 *   结算数据里带不带 winnerTypeName、`BIG_FX` 的键拼得对不对、
 *   组槽的胶囊会不会被 `slot-meta-main` 的 nowrap 顶掉。
 *
 * 本探针的做法：
 *   唯一被替换的东西是**牌堆顺序**（scripts/rig-deck.js 包一层 Card.shuffle）。
 *   之后全是真的：真 stateMachine 发牌、真 submitGroups 校验（必须用满 6 张、
 *   不能有手牌以外的牌）、真 engine 结算（winnerTypeName 就是它算的）、
 *   真 WebSocket 广播、真 Edge 渲染、真 computedStyle 与真动画。
 *
 * 三把牌覆盖四种牌型（一把 = 两轮，第二轮沿用第一轮的手牌，所以「一把里出现哪个」
 * 是设计好的，不是碰运气）：
 *
 *   把 1  A♠ A♥ A♦ 10♠ J♥ 5♣
 *         第一轮：比大小 5♣ / 十点半 10♠+J♥ = **10.5 点** / 飘三叶 A A A = **豹子**
 *         —— 一场结算里同时出现两个大牌型，顺带验「逐组推进时特效各归各」
 *   把 2  J♠ Q♥ K♦ J♥ Q♠ K♣
 *         第一轮：顺子 / 1 点 / 顺子（都无特效，用作对照）
 *         第二轮：斗牛 五张全是花牌 = **五花牛**
 *   把 3  5♣ 5♦ 10♠ 10♥ J♥ 9♣
 *         第一轮：9♣ / 5+5 = 10 点 / 对子（无特效，对照）
 *         第二轮：斗牛 5+5+10+10+10 = 40 = **牛牛**
 *
 * 四个 AI 的牌固定成 rank 2/3/4/6/7/8：
 *   · 没有 10 也没有 JQK → 凑不出 10.5，也凑不出五花牛；
 *   · 任意五张的和都是 22~28，绝不 ≡0 (mod 10) → 凑不出牛牛；
 *   · 六张 rank 互不相同 → 凑不出豹子。
 *   也就是说：四种牌型只可能出现在「我」这一家，特写挂谁没有歧义。
 *
 * 用法：node scripts/audit-pattern-fx.js [宽] [高]
 *   SHOTS=1 时把每一幕的截图落到系统临时目录（默认开）。
 *   线上地址用 LIVE=<带 sharecode 的完整 URL>，此时不起本地服务端 ——
 *   但注意：线上牌堆改不了，只能验「自然出现的牌型」，见 [0] 的说明。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const Card = require('../pwa/js/card.js');
const Engine = require('../pwa/js/engine.js');

const W = Number(process.argv[2]) || 390;
const H = Number(process.argv[3]) || 844;
const CDP_PORT = 9371;
const SRV_PORT = 3031;
const LIVE = process.env.LIVE || '';
const SHOT_DIR = path.join(os.tmpdir(), 'lxw-pattern-fx');
const TMP = path.join(os.tmpdir(), 'lxw-audit');
const RIG_FILE = path.join(TMP, 'rig.json');
const PROFILE_FILE = path.join(TMP, 'profiles.json');

/* ---------------------------- 三个用例 ---------------------------- */

const BOT_SUITS = ['club', 'diamond', 'heart', 'spade'];
const BOT_RANKS = [2, 3, 4, 6, 7, 8];
const BOT_HANDS = BOT_SUITS.map((s) => BOT_RANKS.map((r) => s + '-' + r));

const CASES = [
  {
    name: '豹子 + 10.5 点（同一场结算里两个大牌型）',
    hand: ['spade-14', 'heart-14', 'diamond-14', 'spade-10', 'heart-11', 'club-5'],
    r1: { single: ['club-5'], tenhalf: ['spade-10', 'heart-11'], piaosanye: ['spade-14', 'heart-14', 'diamond-14'] },
    r2: { single: ['club-5'], douniu: ['spade-14', 'heart-14', 'diamond-14', 'spade-10', 'heart-11'] },
    expect: {
      round1: { tenhalf: '10.5点', piaosanye: '豹子' },
      round2: { douniu: '没牛' }
    },
    big: { round1: { tenhalf: '10.5点', piaosanye: '豹子' }, round2: {} }
  },
  {
    name: '五花牛',
    hand: ['spade-11', 'heart-12', 'diamond-13', 'heart-11', 'spade-12', 'club-13'],
    r1: { single: ['club-13'], tenhalf: ['heart-11', 'spade-12'], piaosanye: ['spade-11', 'heart-12', 'diamond-13'] },
    r2: { single: ['club-13'], douniu: ['spade-11', 'heart-12', 'diamond-13', 'heart-11', 'spade-12'] },
    expect: {
      round1: { tenhalf: '1点', piaosanye: '顺子' },
      round2: { douniu: '五花牛' }
    },
    big: { round1: {}, round2: { douniu: '五花牛' } }
  },
  {
    name: '牛牛',
    hand: ['club-5', 'diamond-5', 'spade-10', 'heart-10', 'heart-11', 'club-9'],
    r1: { single: ['club-9'], tenhalf: ['club-5', 'diamond-5'], piaosanye: ['spade-10', 'heart-10', 'heart-11'] },
    r2: { single: ['club-9'], douniu: ['club-5', 'diamond-5', 'spade-10', 'heart-10', 'heart-11'] },
    expect: {
      round1: { tenhalf: '10点', piaosanye: '对子' },
      round2: { douniu: '牛牛' }
    },
    big: { round1: {}, round2: { douniu: '牛牛' } }
  }
];

const BIG_KIND = { '10.5点': 'jh', '豹子': 'bz', '牛牛': 'nn', '五花牛': 'wh' };
const BIG_COLOR = { '10.5点': '31, 138, 102', '豹子': '224, 87, 43', '牛牛': '184, 134, 43', '五花牛': '139, 92, 199' };

/* ---------------------------- 用例自检（Node 端，真引擎） ---------------------------- */

function cardsOf(ids) {
  const deck = Card.createDeck();
  const map = new Map(deck.map((c) => [c.suit + '-' + c.rank, c]));
  return ids.map((id) => {
    const c = map.get(id);
    if (!c) throw new Error('用例里有不存在的牌：' + id);
    return c;
  });
}

function selfCheck() {
  let bad = 0;
  const check = (cond, msg) => {
    if (!cond) { bad++; console.log('  FAIL  用例自检 · ' + msg); }
  };
  CASES.forEach((c) => {
    /* 1) 期望的牌型名必须是引擎真的会给出的那个，不是我以为的那个 */
    Object.keys(c.expect.round1).forEach((k) => {
      const got = Engine.typeName(k, cardsOf(c.r1[k]));
      check(got === c.expect.round1[k], c.name + ' · 第一轮 ' + k + ' 期望「' + c.expect.round1[k] + '」实际「' + got + '」');
    });
    Object.keys(c.expect.round2).forEach((k) => {
      const got = Engine.typeName(k, cardsOf(c.r2[k]));
      check(got === c.expect.round2[k], c.name + ' · 第二轮 ' + k + ' 期望「' + c.expect.round2[k] + '」实际「' + got + '」');
    });
    /* 2) 大牌型的名字必须真的在 BIG_KIND 里 —— 差一个字就退化成「只有横幅没有粒子」 */
    [c.big.round1, c.big.round2].forEach((grp) => {
      Object.keys(grp).forEach((k) => {
        check(!!BIG_KIND[grp[k]], c.name + ' · ' + grp[k] + ' 不在特写名单里');
      });
    });
    /* 3) 六张牌必须不重复、且与 AI 的牌不冲突 */
    const all = c.hand.concat(...BOT_HANDS);
    check(new Set(all).size === all.length, c.name + ' · 手牌与 AI 牌有重复');
    check(c.hand.length === 6, c.name + ' · 手牌不是 6 张');
  });
  /* 4) AI 绝不可能赢过用例里的牌型 */
  BOT_HANDS.forEach((h, i) => {
    const cards = cardsOf(h);
    for (let a = 0; a < 6; a++) {
      const five = cards.filter((_, k) => k !== a);
      const info = Engine.douNiuType(five);
      check(info.type < 9, 'AI' + (i + 1) + ' 的五张子集判成了 ' + info.name + '（会抢走特写）');
    }
    for (let a = 0; a < 6; a++) {
      for (let b = a + 1; b < 6; b++) {
        const pair = [cards[a], cards[b]];
        check(Engine.tenHalfTotal(pair) !== 105 || Engine.tenHalfBust(pair), 'AI' + (i + 1) + ' 能凑出 10.5 点');
      }
    }
    const three = [];
    for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) for (let c = b + 1; c < 6; c++) three.push([cards[a], cards[b], cards[c]]);
    check(three.every((t) => Engine.piaoSanYeTypeName(t) !== '豹子'), 'AI' + (i + 1) + ' 能凑出豹子');
  });
  return bad;
}

/* ---------------------------- 牌堆顺序 ---------------------------- */

function orderFor(c) {
  return c.hand.concat(...BOT_HANDS);
}

function writeRig(c) {
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(RIG_FILE, JSON.stringify({ order: orderFor(c) }), 'utf8');
}

/* ---------------------------- 服务端 ---------------------------- */

let serverProc = null;
function startApp() {
  const rig = path.join(__dirname, 'rig-deck.js');
  serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(SRV_PORT),
      PROFILE_FILE,
      SEED_FILE: path.join(TMP, 'seed.json'),
      LXW_RIG_FILE: RIG_FILE,
      /* path 必须用正斜杠：NODE_OPTIONS 按 shell 规则解析，反斜杠会被当转义吃掉
       * （报错是 Cannot find module 'D:DocumentsWorkBuddy...'，看着像路径丢了分隔符）。 */
      NODE_OPTIONS: '--require ' + rig.replace(/\\/g, '/')
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProc.stdout.on('data', (d) => { if (process.env.VERBOSE) process.stdout.write('[srv] ' + d); });
  serverProc.stderr.on('data', (d) => process.stdout.write('[srv!] ' + d));
}

function waitApp() {
  return new Promise((resolve, reject) => {
    let n = 0;
    (function tick() {
      n += 1;
      http.get('http://127.0.0.1:' + SRV_PORT + '/api/health', (res) => { res.resume(); resolve(); })
        .on('error', () => {
          if (n > 80) return reject(new Error('服务端没起来'));
          setTimeout(tick, 250);
        });
    })();
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

/* ---------------------------- CDP ---------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const waiting = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && waiting.has(m.id)) {
        const w = waiting.get(m.id); waiting.delete(m.id);
        if (m.error) w.reject(new Error(JSON.stringify(m.error))); else w.resolve(m.result);
      }
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => resolve({
      send(method, params) {
        return new Promise((res, rej) => {
          id += 1;
          waiting.set(id, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id, method, params: params || {} }));
        });
      },
      close() { try { ws.close(); } catch (e) {} }
    }));
  });
}

/* ---------------------------- 断言 ---------------------------- */

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else {
    fail++;
    failures.push(name + (detail ? ' -> ' + detail : ''));
    console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : ''));
  }
}

/* ---------------------------- 页面内工具 ---------------------------- */

const HELPERS = `
window.__pfx = (function () {
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function q(s) { return document.querySelector(s); }
  function hand() {
    return [].slice.call(document.querySelectorAll('#hand .card-wrap img')).map(function (i) { return i.dataset.cardId; });
  }
  function slotOf(key) { return q('#slots .slot[data-game="' + key + '"]'); }
  function slotCards(key) {
    var s = slotOf(key);
    if (!s) return [];
    return [].slice.call(s.querySelectorAll('.card-box[data-card-id]')).map(function (b) { return b.dataset.cardId; });
  }
  /* 采样「刚成手」那一帧：is-new / is-fresh 只存在一帧。
   *
   * ★ 这里必须用 MutationObserver，不能只靠 setInterval 轮询。
   *   轮询有 25ms 的盲区，而「点下最后一张牌」那一刻是**同步**改 DOM 的：
   *   新节点带着 is-new 插进来，紧接着 ResizeObserver / 下一次 render 把
   *   内容相同的那一段又写一遍（这次 typeFresh 已经是 false）——
   *   带 is-new 的那个节点寿命可能不到 1 帧，轮询抓不到就等于「这个功能没做」，
   *   而实际上是我观察不到。第一次跑就是这样把「豹子」误判成了没有脉冲。
   *   MutationObserver 是微任务级回调，addedNodes 里带着刚插入的子树，
   *   就算随后被替换掉也已经留下记录。 */
  var timer = 0, mo = null, seen = {};

  function slotList(root) {
    var out = [];
    if (!root || !root.classList) return out;
    if (root.classList.contains('slot')) out.push(root);
    if (root.querySelectorAll) {
      var inner = root.querySelectorAll('.slot');
      for (var i = 0; i < inner.length; i++) out.push(inner[i]);
    }
    return out;
  }

  /* 从（可能已经 detached 的）子树里把「刚成手」的痕迹捞出来 */
  function harvest(root) {
    slotList(root).forEach(function (s) {
      var k = s.dataset.game;
      if (!k) return;
      if (!seen[k]) seen[k] = {};
      var r = seen[k];
      var t = s.querySelector('.slot-type');
      if (t) {
        r.pillText = t.textContent;
        if (t.classList.contains('is-big')) r.pillBig = true;
        if (t.classList.contains('is-new')) r.pillNew = true;
      }
      if (s.classList.contains('is-fresh')) r.fresh = true;
      var pt = s.querySelector('.slot-point');
      if (pt) {
        r.pointText = pt.textContent.trim();
        if (pt.classList.contains('best')) r.pointBest = true;
        if (pt.classList.contains('bust')) r.pointBust = true;
        if (pt.classList.contains('is-new')) r.pointNew = true;
      }
    });
  }

  /* 从**活着**的节点上读计算样式（detached 节点 getComputedStyle 全是空） */
  function sample() {
    slotList(document.getElementById('slots')).forEach(function (s) {
      var k = s.dataset.game;
      if (!k) return;
      if (!seen[k]) seen[k] = {};
      var r = seen[k];
      var t = s.querySelector('.slot-type');
      if (t) {
        r.pillText = t.textContent;
        r.pillBig = t.classList.contains('is-big');
        if (t.classList.contains('is-new')) {
          r.pillNew = true;
          var cs = getComputedStyle(t);
          r.pillAnim = cs.animationName;
          r.pillDur = cs.animationDuration;
          r.pillBg = cs.backgroundColor;
          r.pillColor = cs.color;
        }
      }
      var pt = s.querySelector('.slot-point');
      if (pt) {
        var ps = getComputedStyle(pt);
        r.pointText = pt.textContent.trim();
        r.pointBest = pt.classList.contains('best');
        r.pointBust = pt.classList.contains('bust');
        r.pointBg = ps.backgroundColor;
        /* ★ animationName 只在这一帧带 is-new 时读。
         * 无条件赋值会被**后面的采样**用「动画已经播完、节点也换了」的 none 覆盖掉 ——
         * 于是明明弹了，报告里却是 none。胶囊那边本来就是这么写的，徽标这里漏了。 */
        if (pt.classList.contains('is-new')) {
          r.pointNew = true;
          r.pointAnim = ps.animationName;
        }
      }
      if (s.classList.contains('is-fresh')) {
        r.fresh = true;
        r.slotAnim = getComputedStyle(s).animationName;
        var fx = getComputedStyle(s).getPropertyValue('--fx-color').trim();
        if (fx) r.fxColor = fx;
      }
      var prog = s.querySelector('.slot-progress');
      if (prog) r.progress = prog.textContent;
    });
  }

  function startSample() {
    seen = {};
    sample();
    if (mo) mo.disconnect();
    mo = new MutationObserver(function (recs) {
      recs.forEach(function (rc) {
        if (rc.type === 'attributes') harvest(rc.target);
        rc.addedNodes.forEach(harvest);
        rc.removedNodes.forEach(harvest);
      });
      sample();
    });
    mo.observe(document.getElementById('slots'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    return true;
  }
  function stopSample() {
    if (mo) { mo.disconnect(); mo = null; }
    sample();
    return seen;
  }

  return {
    sleep: sleep, q: q, hand: hand, slotCards: slotCards,
    startSample: startSample, stopSample: stopSample,
    chip: function (key) {
      var b = q('#group-chips .gchip[data-group="' + key + '"]');
      if (b) b.click();
      return !!b;
    },
    place: async function (key, ids) {
      var b = q('#group-chips .gchip[data-group="' + key + '"]');
      if (b) b.click();
      await sleep(160);
      for (var i = 0; i < ids.length; i++) {
        var im = q('#hand .card-wrap[data-card-id="' + ids[i] + '"] img');
        if (!im) return { ok: false, missing: ids[i], got: slotCards(key) };
        im.click();
        await sleep(190);
      }
      return { ok: true, got: slotCards(key) };
    },
    /* 提交：先看确认框里有没有牌型，再点确定 */
    submit: async function () {
      var b = q('#btn-submit');
      if (!b) return { err: '没有提交按钮' };
      var before = { text: b.textContent, disabled: b.disabled };
      if (b.disabled) return { err: '提交按钮是禁用的', before: before };
      b.click();
      await sleep(420);
      var bust = q('#bust-modal');
      if (bust && !bust.classList.contains('hidden')) {
        return { err: '弹出爆点拦截', bust: (q('#bust-desc') || {}).textContent };
      }
      var m = q('#confirm-modal');
      var open = !!(m && !m.classList.contains('hidden'));
      var desc = q('#confirm-desc');
      return { open: open, desc: desc ? desc.textContent : null, before: before };
    },
    confirm: async function () {
      var b = q('#btn-confirm-ok');
      if (!b) return false;
      b.click();
      await sleep(500);
      return !q('#confirm-modal') || q('#confirm-modal').classList.contains('hidden');
    },
    stepInfo: function () {
      var m = q('#result-modal');
      if (!m || m.classList.contains('hidden')) return { open: false };
      var g = q('#result-groups .result-group');
      var out = {
        open: true, step: Number(m.dataset.step), steps: Number(m.dataset.steps),
        hold: Number(m.dataset.hold), round: Number(m.dataset.round),
        hero: m.dataset.hero === '1',
        next: (q('#result-next') || {}).textContent || null,
        progress: getComputedStyle(m).getPropertyValue('--hold').trim()
      };
      if (g) {
        out.group = g.dataset.game;
        out.big = g.classList.contains('is-big');
        out.kind = g.dataset.big || '';
        var b = g.querySelector('.result-banner');
        out.banner = b ? b.textContent : null;
        out.bannerAnim = b ? getComputedStyle(b).animationName : null;
        var burst = g.querySelector('.fx-burst');
        var pts = burst ? [].slice.call(burst.querySelectorAll('.fx-pt')) : [];
        out.ptCount = pts.length;
        if (pts.length) {
          var cs = getComputedStyle(pts[0]);
          out.ptAnim = cs.animationName;
          out.ptDur = cs.animationDuration;
          out.ptDelay = cs.animationDelay;
          out.ptColor = cs.backgroundColor;
          out.ptAngles = pts.map(function (p) { return p.style.getPropertyValue('--a'); });
        }
        var af = getComputedStyle(g, '::after');
        out.ringAnim = af.animationName;
        out.ringDur = af.animationDuration;
        out.winRows = g.querySelectorAll('.result-row.win-row').length;
        out.types = [].slice.call(g.querySelectorAll('.rt-type')).map(function (t) { return t.textContent; });
        var x2 = g.querySelector('.result-head-x2');
        out.headX2 = x2 ? x2.textContent : null;
        /* 溢出：组底边 vs 滚动容器底边（结算弹窗是滚动容器，超了就是被裁掉） */
        var scroller = g.closest('.modal-card') || g.parentNode;
        var gr = g.getBoundingClientRect(), sr = scroller.getBoundingClientRect();
        out.overflowY = Math.round(Math.max(0, gr.bottom - sr.bottom));
      }
      return out;
    },
    /* 特写幕（v98，原型 .fx 层）。结算卡这时候是 hidden 的 ——
     * 所以采样循环必须先看这一层，否则第一幕就 break 出去了。
     * 尺寸一律读 offsetWidth / computedStyle（**不是** getBoundingClientRect）：
     * #stage 整体 transform:scale(k)，rect 给的是缩放后的 CSS px，
     * 而这里要验的是设计稿上的 920 / 108 / 104 那套数字。 */
    heroInfo: function () {
      var b = q('#pattern-fx');
      if (!b || b.classList.contains('hidden')) return { visible: false };
      var lbl = b.querySelector('.pat-lbl');
      var halo = b.querySelector('.pat-halo');
      var core = b.querySelector('.pat-core');
      var waves = [].slice.call(b.querySelectorAll('.pat-wave'));
      var pts = [].slice.call(b.querySelectorAll('.pat-pt'));
      var cds = [].slice.call(b.querySelectorAll('.pat-cd'));
      var m = q('#result-modal');
      return {
        visible: true,
        step: Number(b.dataset.step),
        kind: b.dataset.kind,
        type: b.dataset.type,
        label: lbl ? { text: lbl.textContent, size: getComputedStyle(lbl).fontSize,
          anim: getComputedStyle(lbl).animationName,
          stroke: getComputedStyle(lbl).webkitTextStrokeColor } : null,
        halo: halo ? { anim: getComputedStyle(halo).animationName,
          dur: getComputedStyle(halo).animationDuration,
          iter: getComputedStyle(halo).animationIterationCount,
          w: halo.offsetWidth, h: halo.offsetHeight } : null,
        waves: waves.length,
        waveAnim: waves.length ? getComputedStyle(waves[0]).animationName : null,
        waveDelays: waves.map(function (w) { return w.style.getPropertyValue('--d'); }),
        pts: pts.length,
        ptAnim: pts.length ? getComputedStyle(pts[0]).animationName : null,
        ptRads: pts.map(function (p) { return p.style.getPropertyValue('--r'); }),
        ptColors: pts.map(function (p) { return p.style.getPropertyValue('--pc'); }),
        cards: cds.length,
        cardAnim: cds.length ? getComputedStyle(cds[0]).animationName : null,
        cardDelays: cds.map(function (c) { return c.style.getPropertyValue('--d'); }),
        cardW: cds.length ? cds[0].offsetWidth : 0,
        mk: cds.filter(function (c) { return c.classList.contains('is-mk'); }).length,
        mkb: [].slice.call(b.querySelectorAll('.pat-mkb')).map(function (x) { return x.textContent; }),
        shake: b.classList.contains('is-shake'),
        coreAnim: core ? getComputedStyle(core).animationName : 'none',
        /* 特写是**盖在结算卡上**的一层幕布，不是「把卡收掉」。
         * （原型的结算明细是牌桌下方常驻列表，收掉中央牌位不影响看分数；
         *   线上结算卡就是那一屏的全部内容，收起再弹会闪。） */
        modalOpen: !!(m && !m.classList.contains('hidden')),
        /* 结算卡在特写期间是 opacity:0（还在 DOM 里，位置和点击区域都不变） */
        cardOpacity: (function () {
          var c = m && m.querySelector('.modal-card');
          return c ? getComputedStyle(c).opacity : null;
        })()
      };
    }
  };
})();
true;
`;

/* ---------------------------- 主流程 ---------------------------- */

async function main() {
  const matrix = [];
  const allShots = [];
  console.log('===== 牌型特效「真跑」审计 · ' + W + '×' + H + ' =====');
  console.log('\n[0] 用例自检（Node 端真引擎）');
  const bad = selfCheck();
  ok(bad === 0, '三个用例的牌型名与「AI 抢不走特写」都被引擎确认过', bad ? bad + ' 条不符' : '');
  if (bad) { console.log('\n用例本身不成立，不启动浏览器。'); process.exit(1); }

  let edge = null;
  let cdp = null;
  try {
    if (LIVE) {
      console.log('\n[0b] 线上模式：' + LIVE);
      console.log('  ⚠ 线上牌堆改不了，本模式只能验「自然出现的牌型」，不作为四种牌型的证据。');
    } else {
      console.log('\n[0b] 起服务端（真 server/index.js + 牌堆注入）');
      writeRig(CASES[0]);
      startApp();
      await waitApp();
      console.log('  OK  127.0.0.1:' + SRV_PORT);
    }

    edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
      '--headless=new', '--remote-debugging-port=' + CDP_PORT, '--no-first-run',
      '--disable-gpu', '--autoplay-policy=no-user-gesture-required',
      '--user-data-dir=' + path.join(TMP, 'edge-' + Date.now()),
      'about:blank'
    ], { stdio: 'ignore' });

    let page = null;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      try {
        const list = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
        page = (list || []).find((t) => t.type === 'page');
        if (page) break;
      } catch (e) { /* 还没起来 */ }
    }
    if (!page) throw new Error('连不上 Edge CDP');

    cdp = await cdpConnect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });

    const ev = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) {
        const t = r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text;
        return { __error: String(t || r.exceptionDetails.text) };
      }
      return r.result && r.result.value;
    };
    const shot = async (name) => {
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      const p = path.join(SHOT_DIR, name + '.png');
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
      return p;
    };
    const waitFor = async (expr, ms, label) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (await ev(expr)) return true;
        await sleep(60);
      }
      if (label) console.log('  ⏱ 等超时：' + label);
      return false;
    };

    const PAGE_URL = LIVE || ('http://127.0.0.1:' + SRV_PORT + '/');
    console.log('\n[1] 打开 ' + PAGE_URL);
    await cdp.send('Page.navigate', { url: PAGE_URL });
    await sleep(1500);
    await waitFor('document.readyState === "complete"', 8000, 'load');
    await waitFor('typeof window.Engine === "object" && typeof window.Sfx === "object"', 12000, 'app boot');

    await ev(HELPERS);
    /* 声音观测：把 Sfx.play 包一层记日志。headless 里可能没有真实音频设备，
     * 但「该响的那一下有没有被调用、用的什么音高」是纯 JS 层的事实。 */
    await ev(`(function(){
      window.__sfx = [];
      var o = Sfx.play;
      Sfx.play = function (n, rate) {
        window.__sfx.push([n, rate == null ? 1 : rate, Date.now()]);
        try { return o.apply(Sfx, arguments); } catch (e) { return null; }
      };
      return true;
    })()`);
    try { await ev(`localStorage.setItem('lxw_guide_seen_v1','1')`); } catch (e) {}

    /* ---------------------------- 登录 / 建房 ---------------------------- */
    console.log('\n[2] 登录 → 建房 → 补 4 个 AI → 开局');
    const reg = await ev(`(async function(){
      function click(s){ var b=document.querySelector(s); if(b){ b.click(); return true; } return false; }
      var tab = document.querySelector('[data-auth-tab="register"]');
      if (tab) tab.click();
      await new Promise(function(r){ setTimeout(r, 260); });
      var name = 'fx' + Math.floor(Math.random()*90000 + 10000);
      /* ★ 昵称是**全局唯一**的。第一版固定写「我」，于是第一次跑成功、第二次开始
       *   全部注册失败（「这个昵称已经被别人用了」），而聚合报错只表现为
       *   「补 AI 0 个 / 进不去牌桌」，看起来像布局探针坏了。带上随机后缀。 */
      var nick = '我' + Math.floor(Math.random()*900 + 100);
      document.getElementById('auth-name').value = name;
      document.getElementById('auth-pass').value = 'probe123456';
      var nb = document.getElementById('auth-nick');
      if (nb && !nb.closest('.hidden')) nb.value = nick;
      click('#btn-auth-submit');
      await new Promise(function(r){ setTimeout(r, 2200); });
      return { account: name, nick: nick,
        home: !document.getElementById('screen-home').classList.contains('hidden'),
        auth: !document.getElementById('screen-auth').classList.contains('hidden'),
        err: (document.getElementById('auth-err')||{}).textContent||null };
    })()`);
    console.log('  ' + JSON.stringify(reg));
    if (reg && reg.auth) {
      /* 注册限流（单 IP 12 次 / 10 分钟）会把人卡在登录屏 —— 换固定账号登录。
       * 账号库是持久化的（PROFILE_FILE 固定在临时目录），所以上一轮的账号还在。 */
      const login = await ev(`(async function(){
        function click(s){ var b=document.querySelector(s); if(b){ b.click(); return true; } return false; }
        var tab = document.querySelector('[data-auth-tab="login"]');
        if (tab) tab.click();
        await new Promise(function(r){ setTimeout(r, 260); });
        document.getElementById('auth-name').value = 'auditfx9001';
        document.getElementById('auth-pass').value = 'probe123456';
        click('#btn-auth-submit');
        await new Promise(function(r){ setTimeout(r, 2200); });
        return { home: !document.getElementById('screen-home').classList.contains('hidden'),
          auth: !document.getElementById('screen-auth').classList.contains('hidden'),
          err: (document.getElementById('auth-err')||{}).textContent||null };
      })()`);
      console.log('  登录兜底 ' + JSON.stringify(login));
      if (login && login.auth) {
        /* 第一次跑时固定账号还不存在：注册一个固定名，后续都走这条。 */
        const create = await ev(`(async function(){
          function click(s){ var b=document.querySelector(s); if(b){ b.click(); return true; } return false; }
          var tab = document.querySelector('[data-auth-tab="register"]');
          if (tab) tab.click();
          await new Promise(function(r){ setTimeout(r, 260); });
          document.getElementById('auth-name').value = 'auditfx9001';
          document.getElementById('auth-pass').value = 'probe123456';
          var nick = document.getElementById('auth-nick');
          if (nick && !nick.closest('.hidden')) nick.value = '审计' + Math.floor(Math.random()*9000 + 1000);
          click('#btn-auth-submit');
          await new Promise(function(r){ setTimeout(r, 2200); });
          return { home: !document.getElementById('screen-home').classList.contains('hidden'), err: (document.getElementById('auth-err')||{}).textContent||null };
        })()`);
        console.log('  建固定账号 ' + JSON.stringify(create));
      }
    }

    const boot = await ev(`(async function(){
      function click(id){ var b=document.getElementById(id); if(b){ b.click(); return true; } return false; }
      var nick = document.getElementById('nickname-input');
      if (nick) { nick.value = '我'; nick.dispatchEvent(new Event('input',{bubbles:true})); }
      var r = { create: click('btn-create') };
      await new Promise(function(s){ setTimeout(s, 600); });
      r.botClicks = 0;
      for (var i = 0; i < 6; i++) {
        var b = document.getElementById('btn-add-bot');
        if (!b || b.classList.contains('hidden')) break;
        b.click(); r.botClicks += 1;
        await new Promise(function(s){ setTimeout(s, 700); });
      }
      var g = document.getElementById('guide-modal');
      if (g && !g.classList.contains('hidden')) { var s = document.getElementById('guide-skip'); if (s) s.click(); await new Promise(function(r2){ setTimeout(r2, 350); }); }
      r.ready = click('btn-ready');
      await new Promise(function(s){ setTimeout(s, 1600); });
      r.game = !document.getElementById('screen-game').classList.contains('hidden');
      return r;
    })()`);
    console.log('  ' + JSON.stringify(boot));
    ok(boot && boot.game === true, '进入牌桌（补 AI ' + (boot ? boot.botClicks : '?') + ' 个）');

    /* ---------------------------- 逐把审计 ---------------------------- */

    for (let ci = 0; ci < CASES.length; ci++) {
      const c = CASES[ci];
      console.log('\n[3.' + (ci + 1) + '] 第 ' + (ci + 1) + ' 把 · ' + c.name);

      /* 手牌核对 —— 注入有没有真的生效，这是整份审计的地基 */
      const handOk = await waitFor('__pfx.hand().length === 6', 12000, '第一轮手牌');
      const hand = await ev('__pfx.hand()');
      const same = Array.isArray(hand) && hand.length === 6 && c.hand.every((id) => hand.indexOf(id) >= 0);
      ok(handOk && same, '手牌 == 注入的那 6 张（牌堆注入生效）', JSON.stringify(hand));
      if (!same) {
        console.log('  ⚠ 手牌对不上，这一把不继续（后面全都会串）。实际：' + JSON.stringify(hand));
        break;
      }

      for (const round of [1, 2]) {
        const plan = round === 1 ? c.r1 : c.r2;
        const exp = round === 1 ? c.expect.round1 : c.expect.round2;
        const bigPlan = round === 1 ? c.big.round1 : c.big.round2;
        console.log('\n  --- 第 ' + round + ' 轮 ---');

        /* 等这一轮的分牌阶段：第一轮有 piaosanye 组，第二轮有 douniu 组 */
        const marker = round === 1 ? 'piaosanye' : 'douniu';
        await waitFor('!!document.querySelector(\'#slots .slot[data-game="' + marker + '"]\') && __pfx.hand().length === 6', 15000, '第 ' + round + ' 轮分牌');

        await ev('__pfx.startSample()');
        for (const key of Object.keys(plan)) {
          const res = await ev('__pfx.place(' + JSON.stringify(key) + ',' + JSON.stringify(plan[key]) + ')');
          if (!res || !res.ok) { ok(false, '放牌 · ' + key, JSON.stringify(res)); continue; }
          const want = plan[key].slice().sort().join(',');
          const got = (res.got || []).slice().sort().join(',');
          ok(want === got, '放牌 · ' + key + ' 落在正确的组里', '期望 ' + want + ' 实际 ' + got);
        }
        const sampled = await ev('__pfx.stopSample()');
        await sleep(260);   // 让脉冲播完，看清最终态

        /* S1：组牌阶段的牌型反馈 */
        for (const key of Object.keys(plan)) {
          const s = (sampled || {})[key] || {};
          const label = '第' + round + '轮 ' + key;
          const want = exp[key];
          if (key === 'single') {
            ok(!s.pillText, label + ' 单张组不出牌型胶囊（牌面即答案）', JSON.stringify(s.pillText));
            continue;
          }
          if (key === 'tenhalf') {
            /* 十点半的「牌型」是点数：slot-point 常驻，爆点红、10.5 绿 */
            ok(!!s.pointText, label + ' 有实时点数徽标');
            if (String(want).indexOf('10.5') === 0) {
              ok(s.pointBest === true, '★ ' + label + ' 10.5 点用了「满分绿」而不是普通金', JSON.stringify(s));
              ok(s.pointNew === true, '★ ' + label + ' 刚凑到 10.5 那一帧徽标有 is-new', JSON.stringify(s.pointNew));
              ok(s.pointAnim === 'slotTypePop', '★ ' + label + ' 10.5 徽标脉冲动画真的在跑（与另外三个大牌型同一支）', JSON.stringify(s.pointAnim));
              ok(s.fresh === true && s.slotAnim === 'slotFreshGlow', '★ ' + label + ' 10.5 成手时整组也亮了', JSON.stringify({ fresh: s.fresh, anim: s.slotAnim }));
              ok(String(s.fxColor || '').toUpperCase().indexOf('1F8A66') >= 0, '★ ' + label + ' 组光晕用的是 10.5 那支绿（--fx-color）', JSON.stringify(s.fxColor));
              matrix.push({
                stage: 'S1 组牌', pattern: '10.5点',
                what: '满分绿徽标 + 成手脉冲 + 组光晕',
                value: s.pointBg + ' / ' + s.pointAnim + ' / ' + s.slotAnim,
                pass: s.pointBest === true && s.pointNew === true && s.pointAnim === 'slotTypePop'
              });
            }
            continue;
          }
          /* 飘三叶 / 斗牛：胶囊 + 大牌型上色 + 一次脉冲 */
          ok(s.pillText === want, label + ' 胶囊文字 == 引擎牌型名「' + want + '」', JSON.stringify(s.pillText));
          const isBig = !!BIG_KIND[want];
          if (isBig) {
            ok(s.pillBig === true, '★ ' + label + ' 「' + want + '」挂了 is-big（牌型色）', JSON.stringify(s.pillBg));
            ok(s.pillNew === true, '★ ' + label + ' 「' + want + '」刚成手那一帧有 is-new', JSON.stringify(s.pillNew));
            ok(s.pillAnim === 'slotTypePop', '★ ' + label + ' 胶囊脉冲动画真的挂上了（slotTypePop）', JSON.stringify(s.pillAnim));
            const wantRgb = BIG_COLOR[want];
            ok(String(s.pillBg).indexOf(wantRgb) >= 0, '★ ' + label + ' 胶囊底色 == BIG_FX 里那一支的颜色', '期望含 ' + wantRgb + ' 实际 ' + s.pillBg);
            ok(s.fresh === true && s.slotAnim === 'slotFreshGlow', '★ ' + label + ' 组本身也亮了（slotFreshGlow）', JSON.stringify({ fresh: s.fresh, anim: s.slotAnim }));
            matrix.push({ stage: 'S1 组牌', pattern: want, what: '胶囊 + is-big + 脉冲 + 组光晕', value: s.pillBg + ' / ' + s.slotAnim, pass: s.pillNew === true && s.fresh === true });
          } else {
            ok(s.pillBig !== true, label + ' 普通牌型「' + want + '」不上牌型色', JSON.stringify(s.pillBig));
            /* is-new 类名对所有「刚成手」的牌型都会挂，**动画**只给 is-big。
             * 断言看动画（最终观感），不看类名（实现细节）。 */
            const cs = s.pillAnim || 'none';
            ok(cs === 'none', label + ' 普通牌型「' + want + '」不跑脉冲动画（不抢眼）', JSON.stringify(cs));
          }
        }
        allShots.push(await shot('s1-r' + round + '-p' + (ci + 1) + '-' + W + 'x' + H));

        /* S2：提交确认 */
        const sub = await ev('__pfx.submit()');
        ok(sub && sub.open === true, '第' + round + '轮 提交弹了确认框', JSON.stringify(sub));
        if (sub && sub.desc) {
          const wants = Object.keys(exp).filter((k) => k !== 'single' && BIG_KIND[exp[k]]);
          /* 确认框里每一行是「牌名 · 牌型名」。要求：大牌型那一组的牌型名必须出现。 */
          wants.forEach((k) => {
            ok(sub.desc.indexOf(exp[k]) >= 0, '★ 确认框里能看到「' + exp[k] + '」', sub.desc.replace(/\n/g, ' | '));
            matrix.push({ stage: 'S2 提交确认', pattern: exp[k], what: '确认框文字', value: sub.desc.indexOf(exp[k]) >= 0 ? '含牌型名' : '缺', pass: sub.desc.indexOf(exp[k]) >= 0 });
          });
          if (!wants.length) ok(sub.desc.indexOf('·') >= 0, '第' + round + '轮 确认框每行带牌型名（无大牌型时也照常）', sub.desc.replace(/\n/g, ' | '));
        } else {
          ok(false, '确认框有描述文字', JSON.stringify(sub));
        }
        await ev('__pfx.confirm()');

        /* S4：结算幕 —— 逐幕采样 */
        const opened = await waitFor('!document.getElementById("result-modal").classList.contains("hidden")', 15000, '结算弹窗');
        ok(opened, '第' + round + '轮 结算弹窗自动弹出');
        if (!opened) continue;

        const steps = [];
        const heroes = [];
        let lastStep = -1;
        const t0 = Date.now();
        while (Date.now() - t0 < 30000) {
          const info = await ev('__pfx.stepInfo()');
          if (!info || !info.open) break;
          if (info.step !== lastStep) {
            lastStep = info.step;
            await sleep(230);                 // 等牌落下来、大字砸进来、粒子飞开
            const detail = await ev('__pfx.stepInfo()');
            detail.at = Date.now() - t0;
            steps.push(detail);
            /* 特写幕和结算卡是**同一步**的两层：卡在下面，幕布压在上面。
             * 所以这里在同一个窗口里两样都采，不是「先采幕再等卡」。 */
            const hero = await ev('__pfx.heroInfo()');
            if (hero && hero.visible) {
              hero.at = detail.at;
              heroes.push(hero);
              /* 截图要晚一点：牌是 0.09s 一张错峰落下的（5 张 = 0.36s 延迟 + 0.42s 动画），
               * 230ms 时最后一张还在 opacity:0 的 `from` 帧上 —— 拍出来会少一张牌。 */
              await sleep(700);
              const hs = await ev('__pfx.heroInfo()');
              allShots.push(await shot('s4-fx-' + (hs.kind || hero.kind) + '-p' + (ci + 1) + 'r' + round + '-' + W + 'x' + H));
            }
            if (detail.big) {
              allShots.push(await shot('s4-' + detail.kind + '-p' + (ci + 1) + 'r' + round + '-' + W + 'x' + H));
            }
          }
          await sleep(70);
        }
        const total = steps.length;
        const wantSteps = Object.keys(plan).length;
        ok(total === wantSteps, '第' + round + '轮 逐组推进了 ' + wantSteps + ' 幕（不是一次铺满）', '实际 ' + total + ' 幕');

        steps.forEach((st, i) => {
          const gname = st.group;
          const wantType = exp[gname];
          const isBig = !!BIG_KIND[wantType];
          const label = '第' + round + '轮 第' + (i + 1) + '幕 ' + gname;
          /* 有特写这一幕的停留 = 节奏 + 特写时长（多出来的那 1.6 秒就是幕布） */
          const wantHold = isBig ? 3000 + 1600 : 3000;
          ok(st.hold === wantHold, label + ' 停留 ' + wantHold + 'ms（' + (isBig ? '3s + 1.6s 特写' : '默认节奏') + '）', JSON.stringify(st.hold));
          ok(st.progress === wantHold + 'ms', label + ' 进度条读到的也是 ' + wantHold + 'ms（--hold 挂在弹窗上）', JSON.stringify(st.progress));
          if (gname === 'single') {
            ok(st.big !== true, label + ' 比大小不放特写');
            return;
          }
          ok((st.types || []).indexOf(wantType) >= 0 || gname === 'tenhalf', label + ' 行里写着牌型名「' + wantType + '」', JSON.stringify(st.types));
          if (!isBig) {
            ok(st.big !== true, label + ' 「' + wantType + '」不是大牌型，不放特写', JSON.stringify({ big: st.big, banner: st.banner }));
            matrix.push({ stage: 'S4 结算', pattern: wantType, what: '特写', value: '按设计不放', pass: true });
            return;
          }
          /* ★ 大牌型四件套：横幅 / 12 粒子 / 光环 / 只挂赢家 */
          ok(st.big === true, '★ ' + label + ' 「' + wantType + '」真的有 is-big', JSON.stringify(st.group));
          ok(st.kind === BIG_KIND[wantType], '★ ' + label + ' data-big == ' + BIG_KIND[wantType], JSON.stringify(st.kind));
          ok(st.banner === wantType + '！', '★ ' + label + ' 横幅文字 == 「' + wantType + '！」', JSON.stringify(st.banner));
          ok(st.bannerAnim === 'bannerIn', '★ ' + label + ' 横幅入场动画真的在跑', JSON.stringify(st.bannerAnim));
          ok(st.ptCount === 12, '★ ' + label + ' 粒子 12 颗', JSON.stringify(st.ptCount));
          /* 横屏走 fxBurstTight（半径收窄，避免粒子串到相邻那一组），竖屏走 fxBurst。
           * 断言两种都认，但必须是「有动画」—— 写成恒等于某一个会在地形切换时误报。 */
          ok(st.ptAnim === 'fxBurst' || st.ptAnim === 'fxBurstTight',
            '★ ' + label + ' 粒子动画真的在跑（fxBurst / fxBurstTight）', JSON.stringify(st.ptAnim));
          ok(Number(String(st.ptDelay).replace('s', '')) >= 0.18, '★ ' + label + ' 粒子延迟 ≥0.18s（错峰没被吞）', JSON.stringify(st.ptDelay));
          ok(String(st.ptColor).indexOf(BIG_COLOR[wantType]) >= 0, '★ ' + label + ' 粒子颜色 == 牌型色', '期望含 ' + BIG_COLOR[wantType] + ' 实际 ' + st.ptColor);
          ok(new Set(st.ptAngles || []).size === 12, '★ ' + label + ' 12 颗粒子角度互不相同（绕圈炸开，不是一条线）', JSON.stringify(st.ptAngles));
          ok(st.ringAnim && st.ringAnim !== 'none', '★ ' + label + ' 毡面光环动画在跑', JSON.stringify(st.ringAnim));
          ok(st.winRows === 1, '★ ' + label + ' 只有赢家那一行是金底', JSON.stringify(st.winRows));
          ok(!st.overflowY, '★ ' + label + ' 特写没有把内容顶出滚动容器', JSON.stringify(st.overflowY));
          matrix.push({
            stage: 'S4 结算', pattern: wantType, what: '横幅 + 12 粒子 + 光环 + 音效',
            value: '横幅「' + st.banner + '」/ 粒子 ' + st.ptCount + ' / ' + st.ptAnim + ' / 光环 ' + st.ringAnim,
            pass: st.big === true && st.ptCount === 12
          });
        });

        /* ★ 特写幕（v98）：原型 .fx 层到底有没有真的跑起来。
         * 这一节是「玩家说看不到动画」的直接对照 —— 少了它，
         * v83~v97 五个版本都是绿的，因为绿的那套断言只看结算卡里的组内提示。 */
        /* 按**提交顺序**（= 结算幕顺序 = 特写播放顺序）挑出要有特写的组。
         * 不能用 c.big 那个对象：它是「组 → 牌型名」，没有顺序语义。 */
        const heroGroups = Object.keys(plan).filter((k) => BIG_KIND[exp[k]]);
        ok(heroes.length === heroGroups.length,
          '第' + round + '轮 大牌型 ' + heroGroups.length + ' 组 → 放了 ' + heroGroups.length + ' 幕特写',
          '实际 ' + heroes.length + ' 幕');
        heroes.forEach((h, i) => {
          const gname = heroGroups[i] || '?';
          const want = exp[gname] || '?';
          const kind = BIG_KIND[want];
          const pl = plan[gname] || [];
          const L = '第' + round + '轮 特写「' + want + '」';
          ok(h.kind === kind, '★ ' + L + ' data-kind == ' + kind, JSON.stringify(h.kind));
          ok(h.modalOpen === true, '★ ' + L + ' 结算卡还在（特写是盖在它上面的一层幕布，不是把它收掉）', JSON.stringify(h.modalOpen));
          ok(Number(h.cardOpacity) < 0.02, '★ ' + L + ' 结算卡在特写期间是透明的（暖白卡一旦透出来就是一块发光的背板）', JSON.stringify(h.cardOpacity));
          ok(h.step === Object.keys(plan).indexOf(gname),
            '★ ' + L + ' 特写和这一组的结算卡是同一步（不是插进来的额外一幕）',
            JSON.stringify([h.step, Object.keys(plan).indexOf(gname)]));
          ok(!!h.label && h.label.text === (want === '10.5点' ? '10.5' : want),
            '★ ' + L + ' 大字文字 == 牌型名', JSON.stringify(h.label && h.label.text));
          ok(!!h.label && h.label.anim === 'patLblIn', '★ ' + L + ' 大字从 2.3 倍砸进来（patLblIn）', JSON.stringify(h.label && h.label.anim));
          ok(!!h.label && h.label.size === (kind === 'jh' ? '96px' : '108px'),
            '★ ' + L + ' 大字 ' + (kind === 'jh' ? 96 : 108) + ' 设计 px', JSON.stringify(h.label && h.label.size));
          ok(!!h.halo && h.halo.anim === 'patSpin' && h.halo.dur === '7s' && String(h.halo.iter) === 'infinite',
            '★ ' + L + ' 金环无限旋转（patSpin 7s）', JSON.stringify(h.halo));
          ok(!!h.halo && h.halo.w === 920 && h.halo.h === 920,
            '★ ' + L + ' 金环 920×920 设计 px', JSON.stringify(h.halo && [h.halo.w, h.halo.h]));
          ok(h.waves === 3 && h.waveAnim === 'patWave', '★ ' + L + ' 三道扩散冲击波（patWave）', JSON.stringify([h.waves, h.waveAnim]));
          ok(JSON.stringify(h.waveDelays) === JSON.stringify(['0s', '0.14s', '0.28s']),
            '★ ' + L + ' 三波错峰 0/0.14/0.28s', JSON.stringify(h.waveDelays));
          ok(h.pts === 14 && h.ptAnim === 'patBurst', '★ ' + L + ' 14 颗粒子炸开（patBurst）', JSON.stringify([h.pts, h.ptAnim]));
          ok(new Set(h.ptRads).size === 4, '★ ' + L + ' 粒子四档半径 170/215/260/305', JSON.stringify(h.ptRads));
          ok(new Set(h.ptColors).size === 2, '★ ' + L + ' 粒子两色交错', JSON.stringify(h.ptColors));
          ok(h.cards === pl.length, '★ ' + L + ' 赢家的 ' + pl.length + ' 张牌都重画了', JSON.stringify(h.cards));
          ok(h.cardAnim === 'patCardDrop', '★ ' + L + ' 牌逐张砸下来（patCardDrop）', JSON.stringify(h.cardAnim));
          const wantW = pl.length >= 5 ? 84 : (pl.length === 3 ? 94 : 104);
          ok(h.cardW === wantW, '★ ' + L + ' 牌宽 ' + wantW + ' 设计 px', JSON.stringify(h.cardW));
          ok(new Set(h.cardDelays).size === h.cards, '★ ' + L + ' 每张牌错峰 0.09s', JSON.stringify(h.cardDelays));
          const wantMk = kind === 'wh' ? 5 : (kind === 'nn' ? 3 : 0);
          ok(h.mk === wantMk, '★ ' + L + ' 金圈高亮 ' + wantMk + ' 张', JSON.stringify(h.mk));
          ok(kind === 'nn' ? (h.mkb.length === 3 && h.mkb.every((t) => t === '10')) : h.mkb.length === 0,
            '★ ' + L + (kind === 'nn' ? ' 三张上挂「10」徽标' : ' 不挂「10」徽标'), JSON.stringify(h.mkb));
          const wantShake = kind === 'bz' || kind === 'wh';
          ok(h.shake === wantShake, '★ ' + L + (wantShake ? ' 震屏（豹子/五花牛）' : ' 不震屏'), JSON.stringify([h.shake, h.coreAnim]));
          if (wantShake) ok(h.coreAnim === 'patShake', '★ ' + L + ' 震屏动画真的在跑', JSON.stringify(h.coreAnim));
          matrix.push({
            stage: 'S4 特写幕', pattern: want,
            what: '金环 / 三冲击波 / 14 粒子 / 牌落下 / 大字' + (wantShake ? ' / 震屏' : ''),
            value: h.halo.anim + ' · ' + h.pts + ' 粒子 · ' + h.cards + ' 牌 · ' + (h.label && h.label.text) + ' · ' + h.cardW + 'px',
            pass: h.modalOpen === true && h.halo.anim === 'patSpin' && h.pts === 14
          });
        });

        /* 时间轴：这一幕的停留 = 节奏(3000) + 有没有特写(1600) */
        for (let i = 1; i < steps.length; i++) {
          const gap = steps[i].at - steps[i - 1].at;
          const want = steps[i - 1].hero ? 4600 : 3000;
          ok(Math.abs(gap - want) < 900,
            '第' + round + '轮 第' + i + '→' + (i + 1) + '幕 间隔 ≈' + want + 'ms'
            + (steps[i - 1].hero ? '（含 1.6s 特写）' : ''),
            gap + 'ms');
        }

        /* 音效：大牌型那一幕要额外响一声固定音高 1.12 的 win */
        const sfx = await ev('window.__sfx');
        const fixed = (sfx || []).filter((x) => x[0] === 'win');
        if (steps.some((s) => BIG_KIND[exp[s.group] || ''])) {
          ok(fixed.some((x) => Math.abs(x[1] - 1.12) < 0.001), '★ 大牌型那一幕响了固定音高 1.12 的 win', JSON.stringify(fixed));
          ok((sfx || []).some((x) => x[0] === 'settle'), '★ 结算第一幕响了 settle', JSON.stringify((sfx || []).map((x) => x[0])));
        }
        await ev('window.__sfx = []');

        /* S5：收尾 —— 第一轮走交替卡，第二轮回桌并开下一把 */
        if (round === 1) {
          const brk = await waitFor('!document.getElementById("round-break-modal").classList.contains("hidden")', 8000, '交替卡');
          ok(brk, '第一轮结束插了轮次交替卡');
          if (brk) {
            const rb = await ev(`(function(){
              var t = document.getElementById('rb-title'), n = document.getElementById('rb-next');
              return { title: t ? t.textContent : null, next: n ? n.textContent : null,
                rows: document.querySelectorAll('#rb-body .rb-row').length };
            })()`);
            ok(!!rb && rb.rows >= 2, '交替卡按「本轮净得」列了所有人', JSON.stringify(rb));
            allShots.push(await shot('s5-break-p' + (ci + 1) + '-' + W + 'x' + H));
          }
        } else {
          /* 第二轮的收尾有两种结局，都要走通：
           *   a) 没人见底 → 服务端立刻 dealAll 下一把，直接回牌桌；
           *   b) 有人掉到 0 分 → 进结账页（#screen-settle），要我自己点
           *      「开始下一局」→ 回房间 → 再点准备，才会发下一把。
           * 五花牛一轮收 4 分/人，很容易把 20 分起步的 AI 打到 0 ——
           * 第一版只等 (a)，于是在第 2 把卡死，第 3 把彻底接不上。 */
          let back = false;
          const t1 = Date.now();
          let clickedNext = 0, clickedReady = 0;
          while (Date.now() - t1 < 30000) {
            const st = await ev(`(function(){
              function vis(id){ var e=document.getElementById(id); return !!(e && !e.classList.contains('hidden')); }
              return {
                hand: __pfx.hand().length,
                result: vis('result-modal'),
                settle: vis('screen-settle'),
                room: vis('screen-room'),
                ready: vis('btn-ready'),
                next: (document.getElementById('btn-next')||{}).disabled === false && vis('screen-settle')
              };
            })()`);
            if (st && st.hand === 6 && !st.result) { back = true; break; }
            if (st && st.settle && clickedNext < 1) {
              await ev('(function(){ var b=document.getElementById("btn-next"); if(b) b.click(); return true; })()');
              clickedNext += 1;
              await sleep(900);
              continue;
            }
            if (st && st.ready && clickedReady < 3) {
              await ev('(function(){ var b=document.getElementById("btn-ready"); if(b) b.click(); return true; })()');
              clickedReady += 1;
              await sleep(900);
              continue;
            }
            await sleep(350);
          }
          ok(back, '第二轮收尾后回到了能接着打的牌桌（见底则走结账页 → 开始下一局）',
            JSON.stringify({ settle跳转: clickedNext, 点准备: clickedReady }));
        }

        /* ★ 下一把的牌堆必须在「第二轮结算」之前写好 —— 结算一落地服务端就 dealAll 了。
         * 第一版写在整把结束之后，结果第二把拿到的还是第一把的牌
         * （探针自己的断言当场抓到：「手牌 == 注入的那 6 张」红）。 */
        if (round === 1 && ci + 1 < CASES.length) writeRig(CASES[ci + 1]);
      }
      await sleep(300);
    }

    console.log('\n[4] 截图');
    allShots.filter(Boolean).forEach((p) => console.log('  ' + p));
  } catch (e) {
    console.error('\n审计中断：' + (e && e.stack || e));
    ok(false, '审计跑完没有异常', String(e && e.message || e));
  } finally {
    try { if (cdp) cdp.close(); } catch (e) {}
    try { if (edge) edge.kill(); } catch (e) {}
    try { if (serverProc) serverProc.kill(); } catch (e) {}
  }

  console.log('\n===== 结果 =====');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (failures.length) {
    console.log('\n失败清单：');
    failures.forEach((f) => console.log('  · ' + f));
  }
  if (matrix.length) {
    console.log('\n矩阵（stage / 牌型 / 验的是什么 / 实测 / 结论）');
    matrix.forEach((m) => {
      console.log('  ' + (m.pass ? '✅' : '❌') + '  ' + m.stage + '  ' + m.pattern + '  ' + m.what + '  →  ' + m.value);
    });
  }
  process.exit(fail ? 1 : 0);
}

main();
