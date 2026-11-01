#!/usr/bin/env node
/**
 * 全流程 UI 巡检（v105）
 *
 * 跑法：
 *   node scripts/probe-ui-flow.js                     # 全矩阵（12 视口 × 12 屏）
 *   ONLY="iPhone 横" node scripts/probe-ui-flow.js     # 单档
 *   ONLY="360×800" node scripts/probe-ui-flow.js --shots
 *
 * 与 probe-devices.js 的分工：
 *   probe-devices —— **一个屏幕**（牌桌）在 30 个视口下量四条硬指标，判「支不支持」；
 *   本脚本        —— **一个视口的整条流程**（认证→首页→建房→准备→对局→结算→战绩→排行→规则→账号），
 *                    判「每一屏有没有坏」。前者横向铺开，后者纵向走完。
 *
 * 硬问题（写在跑之前，事后不许放宽）：
 *   1. 出界   —— 可见元素矩形超出舞台 > 2 CSS px（被裁掉＝看不见）
 *   2. 溢出   —— 可见元素自身内容超框（scrollHeight−clientHeight > 1）＝「显示不全」的根
 *   3. 遮挡   —— 两个「可点/可读块」矩形相交 > 4px²，且互不包含，且压掉小者 ≥35%
 *   4. 截断   —— overflow:hidden 的纯文本元素 scrollWidth > clientWidth
 *   5. 热区   —— 可见按钮宽或高 < 30 CSS px（真正的点不到）
 *
 * 软问题（记录不判死）：
 *   · 热区 30~44 CSS px —— 常见于 .btn-mini，桌面端没问题，触屏偏小，记账即可
 *   · 留空 —— 内容包围盒到舞台四边的百分比。留空没有普适阈值，硬给一个数是自欺，
 *            所以只量不判，由人看数字决定「设计上就该这样」还是「忘了铺满」。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', 'pwa');
const SHOTS = process.argv.includes('--shots');
const ONLY = process.env.ONLY || '';
const SHOT_DIR = path.join(__dirname, '..', 'tmp-shots', 'flow');
const SRV_PORT = 3042;
const SRV_STATIC = 3043;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.webmanifest': 'application/manifest+json', '.json': 'application/json'
};

/* 只留必须支持的三个族（平板 / 折叠屏按裁定不纳入）。 */
const VIEWPORTS = [
  { g: 'iOS竖', m: '390×844', w: 390, h: 844 },
  { g: 'iOS横', m: '844×390', w: 844, h: 390 },
  { g: 'iOS竖', m: '430×932', w: 430, h: 932 },
  { g: 'iOS横', m: '932×430', w: 932, h: 430 },
  { g: '安卓竖', m: '360×640', w: 360, h: 640 },
  { g: '安卓竖', m: '360×800', w: 360, h: 800 },
  { g: '安卓横', m: '800×360', w: 800, h: 360 },
  { g: '安卓横', m: '915×412', w: 915, h: 412 },
  { g: '电脑', m: '1280×720', w: 1280, h: 720 },
  { g: '电脑', m: '1920×947', w: 1920, h: 947 },
  { g: '电脑', m: '分屏960×1040', w: 960, h: 1040 },
  { g: '电脑', m: '728×348', w: 728, h: 348 }
];

/* ---------------------------- 静态服务 ---------------------------- */
const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  const abs = path.join(ROOT, p);
  if (!abs.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(abs, (e, buf) => {
    if (e) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
    res.end(buf);
  });
});

let serverProc = null;
function startApp() {
  serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(SRV_PORT),
      PROFILE_FILE: path.join(os.tmpdir(), 'lxw-ui-' + Date.now(), 'profiles.json'),
      SEED_FILE: path.join(os.tmpdir(), 'lxw-ui-seed-' + Date.now() + '.json')
    }),
    stdio: 'ignore'
  });
}

function waitApp() {
  return new Promise((resolve, reject) => {
    let tries = 0;
    (function tick() {
      tries += 1;
      http.get('http://127.0.0.1:' + SRV_PORT + '/api/health', (res) => { res.resume(); resolve(); })
        .on('error', () => {
          if (tries > 80) return reject(new Error('服务端没起来'));
          setTimeout(tick, 250);
        });
    })();
  });
}

function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const waiting = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && waiting.has(msg.id)) {
        const w = waiting.get(msg.id);
        waiting.delete(msg.id);
        if (msg.error) w.reject(new Error(JSON.stringify(msg.error)));
        else w.resolve(msg.result);
      }
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => {
      resolve({
        send(method, params) {
          return new Promise((res, rej) => {
            id += 1;
            waiting.set(id, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id, method, params: params || {} }));
          });
        },
        close() { try { ws.close(); } catch (e) {} }
      });
    });
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ===================================================================
 * 页面内助手（与 probe-ten-hands.js 同源：那套已经跑过 20 轮真牌局）
 * =================================================================== */
const PAGE_HELPERS = `(function(){
  var J = window.__ui = window.__ui || {};
  J.vis = function(id){ var e = document.getElementById(id); return !!(e && !e.classList.contains('hidden')); };
  J.hand = function(){ return document.querySelectorAll('#hand .card-wrap').length; };
  J.chips = function(){
    return [].slice.call(document.querySelectorAll('#group-chips .gchip[data-group]')).map(function(c){
      return { key: c.dataset.group, full: c.classList.contains('is-full'),
               txt: (c.textContent || '').trim() };
    });
  };
  J.closeResult = function(){
    var n = 0;
    for (var i = 0; i < 12; i++) {
      var m = document.getElementById('result-modal');
      if (m && !m.classList.contains('hidden')) {
        var b = document.getElementById('btn-result-close');
        if (b) { b.click(); n++; continue; }
      }
      var k = document.getElementById('round-break-modal');
      if (k && !k.classList.contains('hidden')) {
        var kb = document.getElementById('btn-rb-close');
        if (kb) { kb.click(); n++; continue; }
      }
      break;
    }
    return n;
  };
  J.cardOf = function(wrap){
    var id = wrap && wrap.dataset ? wrap.dataset.cardId : '';
    if (!id) return null;
    var p = id.split('-');
    return { suit: p[0], rank: Number(p[1]) };
  };
  /* 十点半那组不要爆：挑一张「和已落牌凑起来不超过 10.5」的。
   * 不挑的话随机填牌会撞出 #bust-modal，整个流程就卡在那一步 ——
   * 这是探针的噪声，不是产品缺陷，别让它污染 UI 报告。 */
  J.pickFor = function(key){
    var wraps = [].slice.call(document.querySelectorAll('#hand .card-wrap'));
    if (!wraps.length) return null;
    if (key !== 'tenhalf' || typeof StateMachine === 'undefined' || !StateMachine.tenHalfPair) return wraps[0];
    var placed = [].slice.call(document.querySelectorAll('#slots .slot[data-game="tenhalf"] .card-box[data-card-id]'))
      .map(function (b) { var p = b.dataset.cardId.split('-'); return { suit: p[0], rank: Number(p[1]) }; });
    var cards = wraps.map(function (w) { return J.cardOf(w); });
    var k, m, pr;
    if (placed.length === 1) {
      for (k = 0; k < cards.length; k++) {
        if (!cards[k]) continue;
        pr = StateMachine.tenHalfPair([placed[0], cards[k]]);
        if (pr && !pr.bust) return wraps[k];
      }
    }
    for (k = 0; k < cards.length; k++) {
      if (!cards[k]) continue;
      for (m = 0; m < cards.length; m++) {
        if (m === k || !cards[m]) continue;
        pr = StateMachine.tenHalfPair([cards[k], cards[m]]);
        if (pr && !pr.bust) return wraps[k];
      }
    }
    return wraps[0];
  };
  /* 填一张牌进「第一个没满的组」 */
  J.fillStep = function(){
    var cs = [].slice.call(document.querySelectorAll('#group-chips .gchip[data-group]'));
    var t = null;
    for (var i = 0; i < cs.length; i++) if (!cs[i].classList.contains('is-full')) { t = cs[i]; break; }
    if (!t) return { done: true };
    t.click();
    var wrap = J.pickFor(t.dataset.group) || document.querySelector('#hand .card-wrap');
    if (!wrap) return { done: false, stuck: true };
    (wrap.querySelector('img') || wrap).click();
    return { done: false };
  };
  /* ---- 拖拽交换自检（v105）----
   * 单测能证明 stateMachine.swapCards 本身对，但证明不了「手指拖过去真的会换」：
   * 中间隔着 pointerdown/move/up 的一串接线、elementFromPoint 的落点判定、
   * 以及「交换分支必须排在 slotKey 早退之前」这个顺序细节。
   * 这里真的派发一次指针拖拽，然后比对两张牌是不是互换了组。
   * 全满状态下才测 —— 那正是老实现做不到的情形（目标组满 → placeCard 直接拒绝）。 */
  J.trySwap = function(){
    var boxes = [].slice.call(document.querySelectorAll('#slots .card-box[data-card-id]'));
    if (boxes.length < 2) return { ok: false, why: '槽里不足两张牌' };
    var a = boxes[0], b = null;
    for (var i = 1; i < boxes.length; i++) {
      if (boxes[i].dataset.group !== a.dataset.group) { b = boxes[i]; break; }
    }
    if (!b) return { ok: false, why: '找不到分属两组的牌' };

    var aid = a.dataset.cardId, bid = b.dataset.cardId;
    var aKey = a.dataset.group, bKey = b.dataset.group;

    var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    var x0 = ra.left + ra.width / 2, y0 = ra.top + ra.height / 2;
    var x1 = rb.left + rb.width / 2, y1 = rb.top + rb.height / 2;
    var base = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch',
                 isPrimary: true, button: 0, buttons: 1 };
    function pe(type, x, y) {
      var o = {};
      for (var k in base) o[k] = base[k];
      o.clientX = x; o.clientY = y;
      return new PointerEvent(type, o);
    }
    a.dispatchEvent(pe('pointerdown', x0, y0));
    document.dispatchEvent(pe('pointermove', x0 + 14, y0 + 14));  // 越过 10px 拖拽阈值
    document.dispatchEvent(pe('pointermove', x1, y1));
    document.dispatchEvent(pe('pointerup', x1, y1));

    /* render() 在 endDrag 里同步跑完，DOM 已经是新的一份 —— 旧的 a/b 引用失效，要重新查 */
    var moved = document.querySelector('#slots .card-box[data-card-id="' + aid + '"]');
    var back = document.querySelector('#slots .card-box[data-card-id="' + bid + '"]');
    var good = !!(moved && back && moved.dataset.group === bKey && back.dataset.group === aKey);

    /* ★ 验完立刻换回来。不换回来的话，十点半那一组的构成变了 → 点数可能爆 →
     * 下一步「对局·已提交」当场撞上 #bust-modal，整个流程卡死在那里。
     * 那是探针自己制造的噪声，不是产品缺陷；换成原样，两个方向也都顺便验了。 */
    if (good) {
      var ra2 = moved.getBoundingClientRect(), rb2 = back.getBoundingClientRect();
      moved.dispatchEvent(pe('pointerdown',
        ra2.left + ra2.width / 2, ra2.top + ra2.height / 2));
      document.dispatchEvent(pe('pointermove',
        ra2.left + ra2.width / 2 + 14, ra2.top + ra2.height / 2 + 14));
      document.dispatchEvent(pe('pointermove',
        rb2.left + rb2.width / 2, rb2.top + rb2.height / 2));
      document.dispatchEvent(pe('pointerup',
        rb2.left + rb2.width / 2, rb2.top + rb2.height / 2));
      var a3 = document.querySelector('#slots .card-box[data-card-id="' + aid + '"]');
      var b3 = document.querySelector('#slots .card-box[data-card-id="' + bid + '"]');
      good = good && !!(a3 && b3 && a3.dataset.group === aKey && b3.dataset.group === bKey);
    }

    return {
      ok: good,
      detail: aid + '@' + aKey + ' ↔ ' + bid + '@' + bKey,
      after: (moved ? moved.dataset.group : '-') + '/' + (back ? back.dataset.group : '-')
    };
  };
  /* 关掉所有「不该开着」的弹窗。场景之间必须先清场，
   * 否则上一屏漏关的 bust / guide 会飘到下一屏，报告就全成了串味的误报。 */
  J.CLOSE = {
    'result-modal': 'btn-result-close',
    'round-break-modal': 'btn-rb-close',
    'bust-modal': 'btn-bust-fix',
    'share-modal': 'btn-share-close',
    'replay-modal': 'btn-replay-close',
    'prev-result-modal': 'btn-prev-result-close',
    'guide-modal': 'guide-skip',
    'rules-modal': 'btn-rules-close',
    'create-modal': 'btn-create-cancel',
    'confirm-modal': 'btn-confirm-cancel',
    'records-clear-modal': 'btn-records-clear-cancel',
    'account-modal': 'btn-acc-close',
    'rename-modal': 'btn-rename-cancel',
    'avatar-modal': 'btn-av-close'
  };
  J.cleanup = function(keep){
    keep = keep || [];
    var n = 0;
    Object.keys(J.CLOSE).forEach(function (id) {
      if (keep.indexOf(id) >= 0 || !J.vis(id)) return;
      var b = document.getElementById(J.CLOSE[id]);
      if (!b && id === 'guide-modal') b = document.getElementById('guide-next');
      if (b) { b.click(); n++; }
    });
    /* 引导卡是多步的：一关没关掉就再点两下「下一步 / 跳过」 */
    for (var i = 0; i < 4 && J.vis('guide-modal'); i++) {
      var g = document.getElementById('guide-skip') || document.getElementById('guide-next');
      if (!g) break;
      g.click(); n++;
    }
    return n;
  };
  J.submitDisabled = function(){
    var b = document.getElementById('btn-submit');
    return !b ? 'gone' : !!b.disabled;
  };
  J.clickSubmit = function(){
    var b = document.getElementById('btn-submit');
    if (!b || b.disabled) return false;
    b.click(); return true;
  };
  J.finish = function(){
    J.closeResult();
    if (J.vis('screen-settle')) return 'settle';
    if (J.vis('bust-modal')) {
      var bf = document.getElementById('btn-bust-fix');
      if (bf) bf.click();
      return 'bust';
    }
    /* 回合小结卡：每组打完会弹，挡着 #btn-submit。漏了它就会空转到上限
     * （430×932 实测跑满 90 步仍停在 game —— 是探针漏了这一屏，不是界面缺陷）。 */
    if (J.vis('round-break-modal')) {
      var rb = document.getElementById('btn-rb-close');
      if (rb) { rb.click(); return 'break'; }
    }
    var c = document.getElementById('confirm-modal');
    if (c && !c.classList.contains('hidden')) {
      var ok = document.getElementById('btn-confirm-ok');
      if (ok) { ok.click(); return 'confirmed'; }
    }
    if (J.vis('guide-modal')) {
      var g = document.getElementById('guide-skip') || document.getElementById('guide-next');
      if (g) { g.click(); return 'guide'; }
    }
    /* 兜底：还有别的弹窗压着就先清场。放在 confirm 之后，避免把刚弹的确认框
     * 用「取消」关掉。返回 0 说明确实干净，可以填牌。 */
    var n = J.cleanup(['result-modal', 'round-break-modal']);
    if (n) return 'cleanup';
    if (J.vis('screen-game') || J.vis('table-ready')) {
      for (var i = 0; i < 4; i++) { var r = J.fillStep(); if (r.done || r.stuck) break; }
      J.clickSubmit();
      return 'work';
    }
    return 'idle';
  };
  return 'ok';
})()`;

/* ===================================================================
 * 页面内审计
 * =================================================================== */
const AUDIT = `(function(){
  var SEL = {
    /* 注意：不含 .card —— 手牌是**扇形叠放**，相邻两张本来就压在一起，
     * 那是设计不是遮挡。扑克牌的可见性由 .card-wrap 的尺寸与 .slot 的槽位保证。 */
    block: 'button, .btn, .pill, .slot, .seat, .opp, .gt-emo, .gt-me, input, .modal-card, .modal-box, .rp-row, .lb-row, .act-btn, .gchip, label, h1, h2, h3',
    /* 装饰类用「属性包含」匹配：home-deco / auth-glow 这类复合名不能靠精确类名兜住 */
    allow: '[class*="toast"], [class*="confetti"], [class*="sparkle"], [class*="particle"], [class*="deco"], [class*="glow"], [class*="vignette"], [class*="sprinkle"], [class*="bubble"], [class*="fly"], [class*="fx"], [class*="blob"], [class*="grain"], [class*="noise"], [class*="rays"], [class*="ember"]',
    deco: '[class*="deco"], [class*="glow"], [class*="vignette"], [class*="particle"], [class*="sparkle"], [class*="bubble"], [class*="sprinkle"], [class*="blob"], [class*="grain"], [class*="noise"], [class*="bg"]'
  };
  var stage = document.getElementById('stage');
  if (!stage) return { fatal: '没有 #stage' };
  var sr = stage.getBoundingClientRect();
  var TOL = 2, TAP_HARD = 30;
  var out = { w: Math.round(sr.width), h: Math.round(sr.height), issues: [], soft: [], gaps: null, screen: '' };

  function visible(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 0.5 || r.height < 0.5) return false;
    /* 视觉隐藏（sr-only）：1×1 + clip-path: inset(50%)。
     * 那是给读屏软件的标题，本来就该被裁 —— 当成「文字被截」报是噪声。
     *   <h2 id="guide-title" style="position:absolute;width:1px;height:1px;...clip-path:inset(50%)"> */
    if (r.width <= 2 && r.height <= 2) return false;
    var cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    if (parseFloat(cs.opacity) < 0.05) return false;
    if (cs.clipPath && cs.clipPath.indexOf('inset(50%') >= 0) return false;
    return true;
  }
  /* 元素是否在某个「可滚动祖先」里：滚动容器里的内容跑到框外是**能滚到的**，
   * 不是被裁掉。规则弹窗的正文就靠这条从「越界 434px」里摘出来。 */
  function inScroller(el) {
    var n = el.parentElement;
    while (n && n !== document.body) {
      var cs = getComputedStyle(n);
      if (cs.overflowY === 'auto' || cs.overflowY === 'scroll' ||
          cs.overflowX === 'auto' || cs.overflowX === 'scroll') return true;
      n = n.parentElement;
    }
    return false;
  }
  function m(sel, el) { try { return el.matches(sel); } catch (e) { return false; } }
  function name(el) {
    var id = el.id ? '#' + el.id : '';
    var cls = (typeof el.className === 'string' && el.className)
      ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.') : '';
    return el.tagName.toLowerCase() + id + cls;
  }
  function overlapArea(a, b) {
    var w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    var h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return (w > 0 && h > 0) ? w * h : 0;
  }

  var screens = [].slice.call(document.querySelectorAll('#stage .screen'));
  var cur = null;
  for (var i = 0; i < screens.length; i++) if (!screens[i].classList.contains('hidden')) { cur = screens[i]; break; }
  var modals = [].slice.call(document.querySelectorAll('#stage .modal'))
    .filter(function (k) { return !k.classList.contains('hidden'); });
  /* 多个弹窗同时开着时，只审**最上面那层**（z-index 大者，同值取 DOM 靠后者）。
   * 用户看到的就是那一层；下面那层被盖住是设计，不是遮挡。
   * 真出现「两层都开着」多半是探针自己的时序（结果卡晚到），
   * 把它记成遮挡会污染结论 —— 但会单独记一条 stack，方便回看。 */
  var stacked = modals.length;
  if (modals.length > 1) {
    modals.sort(function (a, b) {
      var za = parseInt(getComputedStyle(a).zIndex, 10) || 0;
      var zb = parseInt(getComputedStyle(b).zIndex, 10) || 0;
      if (za !== zb) return za - zb;
      var ia = [].indexOf.call(a.parentNode.children, a);
      var ib = [].indexOf.call(b.parentNode.children, b);
      return ia - ib;
    });
    modals = [modals[modals.length - 1]];
  }
  out.stacked = stacked;
  out.screen = (cur ? cur.id.replace('screen-', '') : '(无屏)')
    + (modals.length ? ' + ' + modals.map(function (k) { return k.id; }).join(',') : '');
  if (!cur && !modals.length) return out;

  /* 弹窗打开时**只审弹窗**：底层屏被遮罩盖住是设计，拿它做「遮挡」检测必全是误报。 */
  var roots = modals.length ? modals : (cur ? [cur] : []);

  roots.forEach(function (root) {
    [].slice.call(root.querySelectorAll('*')).forEach(function (el) {
      if (!visible(el)) return;
      var r = el.getBoundingClientRect();
      var cs = getComputedStyle(el);
      var decor = m(SEL.allow, el);

      if (!decor && !inScroller(el)) {
        var dx = Math.max(0, sr.left - r.left, r.right - sr.right);
        var dy = Math.max(0, sr.top - r.top, r.bottom - sr.bottom);
        if (dx > TOL || dy > TOL) {
          out.issues.push({ k: 'out', who: name(el),
            d: '越界 ' + Math.round(Math.max(dx, dy)) + 'px' });
        }
      }
      /* 「显示不全」只认**真的会被裁**的容器，且用**子元素矩形**去判，不用 scrollHeight。
       * 为什么不用 scrollHeight：绝对定位的 ::after 装饰（战绩汇总区那个光斑）会把
       * scrollHeight 撑高 60~90px，报出来的是假阳性；::after 不在 children 里。 */
      var clipsY = cs.overflowY === 'hidden' || cs.overflowY === 'clip';
      var clipsX = cs.overflowX === 'hidden' || cs.overflowX === 'clip';
      if ((clipsY || clipsX) && !decor && el.children.length) {
        var box = el.getBoundingClientRect();
        /* ★ 必须把 padding 换算到 CSS 坐标：computed style 给的是**设计 px**，
         * 而 getBoundingClientRect 已经是缩放后的 CSS px。390×844 上缩放 0.52，
         * 28 设计px 的 padding 实际只有 14.6 —— 直接相减会凭空多出 13~15px 的
         * 「内容超出」，每个弹窗都会报一条。缩放比由「渲染宽 / 布局宽」反算。 */
        var sc = el.offsetWidth ? (box.width / el.offsetWidth) : 1;
        var padB = (parseFloat(cs.paddingBottom) || 0) * sc;
        var padT = (parseFloat(cs.paddingTop) || 0) * sc;
        var padL = (parseFloat(cs.paddingLeft) || 0) * sc;
        var padR = (parseFloat(cs.paddingRight) || 0) * sc;
        var worstY = 0, worstX = 0, whoY = '', whoX = '';
        for (var ci = 0; ci < el.children.length; ci++) {
          var ch = el.children[ci];
          if (!visible(ch)) continue;
          if (m(SEL.allow, ch)) continue;
          var cr = ch.getBoundingClientRect();
          var oy = cr.bottom - (box.bottom - padB);
          var ox2 = cr.right - (box.right - padR);
          var oy2 = (box.top + padT) - cr.top;
          var ox3 = (box.left + padL) - cr.left;
          if (clipsY && Math.max(oy, oy2) > worstY) { worstY = Math.max(oy, oy2); whoY = name(ch); }
          if (clipsX && Math.max(ox2, ox3) > worstX) { worstX = Math.max(ox2, ox3); whoX = name(ch); }
        }
        if (worstY > TOL) {
          out.issues.push({ k: 'clip', who: name(el), d: '内容超出 ' + Math.round(worstY) + 'px 被 overflow-y:' + cs.overflowY + ' 裁掉（' + whoY + '）' });
        }
        if (worstX > TOL) {
          out.issues.push({ k: 'clip', who: name(el), d: '内容超出 ' + Math.round(worstX) + 'px 被 overflow-x:' + cs.overflowX + ' 裁掉（' + whoX + '）' });
        }
      }
      if ((cs.overflow === 'hidden' || cs.overflowX === 'hidden') && el.children.length === 0) {
        var tx = (el.textContent || '').trim();
        var ox = el.scrollWidth - el.clientWidth;
        if (tx.length > 0 && ox > 1 && el.clientWidth > 2) {
          out.issues.push({ k: 'trunc', who: name(el), d: '文字被截 ' + Math.round(ox) + 'px：「' + tx.slice(0, 10) + '」' });
        }
      }
    });
  });

  /* 可滚动容器「底边切掉大半行」 —— 第三类，前两条都放过它：
   * 不是 out（内容能滚到），也不是 clip（overflow 是 auto 不是 hidden），
   * 但人眼看到的就是「第 5 行被切成半行」，比完全没有更难看。
   * 800×360 结算列表第 5 行就是这么从两条判据的缝里漏掉的。
   * 只记录不判死：滚一下确实能看到，但「差一点点」和「差一大截」是两种体验，
   * 差一点点应该改布局让它一次装下，而不是靠玩家发现能滚。 */
  out.halfCut = [];
  var seenCut = {};
  [].slice.call(document.querySelectorAll('#stage *')).forEach(function (sc2) {
    if (!visible(sc2)) return;
    var cs2 = getComputedStyle(sc2);
    if (!/auto|scroll/.test(cs2.overflowY)) return;
    if (sc2.scrollHeight - sc2.clientHeight <= 2) return;
    var sbox = sc2.getBoundingClientRect();
    [].slice.call(sc2.querySelectorAll('*')).forEach(function (d2) {
      if (m(SEL.allow, d2) || !visible(d2)) return;
      var dr = d2.getBoundingClientRect();
      if (dr.height < 8) return;
      /* 只认「上半截在容器里、下半截被容器底边切掉」 */
      if (!(dr.top >= sbox.top - 1 && dr.top < sbox.bottom)) return;
      if (dr.bottom <= sbox.bottom + TOL) return;
      /* 只报**最外层**跨越者：result-group > result-rows > result-row > result-cards > img
       * 是一条嵌套链，同一次溢出会被报 5 遍，看着像 5 个 bug。父级也跨了就让父级报。 */
      var pe = d2.parentElement;
      if (pe && pe !== sc2) {
        var pr = pe.getBoundingClientRect();
        if (pr.top >= sbox.top - 1 && pr.top < sbox.bottom && pr.bottom > sbox.bottom + TOL) return;
      }
      var nm = name(d2);
      if (seenCut[nm]) return;
      var shown = (sbox.bottom - dr.top) / dr.height;
      /* 只认「差一点点」：露出 ≥80% 才叫**硬切半行**（看着该完整却缺一截）。
       * 露出 20~50% 的长文档（规则正文、战绩列表）是正常滚动中途，
       * 那不是缺陷而是「还没滚到」—— 一开始没设下限，规则页每条都能报一遍。 */
      if (shown < 0.8) return;
      seenCut[nm] = 1;
      out.halfCut.push({ who: nm, shown: Math.round(shown * 100) });
    });
  });

  /* 热区 */
  var taps = [].slice.call(document.querySelectorAll(
    '#screen-auth button, #screen-home button, #screen-room button, #screen-game button, #screen-settle button, ' +
    '#screen-records button, #screen-rank button, #stage .modal:not(.hidden) button'));
  var seen = new Set();
  taps.forEach(function (el) {
    if (seen.has(el) || !visible(el)) return;
    seen.add(el);
    var r = el.getBoundingClientRect();
    if (r.width < TAP_HARD || r.height < TAP_HARD) {
      out.issues.push({ k: 'tap', who: name(el), d: '热区 ' + Math.round(r.width) + '×' + Math.round(r.height) + ' < ' + TAP_HARD });
    } else if (r.width < 44 || r.height < 44) {
      /* 打印用一位小数：Math.round 会把 43.6 显示成「44 < 44」，看着像误报 */
      var fmt = function (n) { return (Math.round(n * 10) / 10).toFixed(1); };
      out.soft.push({ k: 'tap44', who: name(el), d: '热区 ' + fmt(r.width) + '×' + fmt(r.height) + ' < 44' });
    }
  });

  /* 遮挡 */
  var blocks = [];
  roots.forEach(function (root) {
    [].slice.call(root.querySelectorAll(SEL.block)).forEach(function (el) {
      if (!visible(el) || m(SEL.allow, el)) return;
      var r = el.getBoundingClientRect();
      if (r.width * r.height < 200) return;
      blocks.push({ el: el, r: r });
    });
  });
  for (var a = 0; a < blocks.length; a++) {
    for (var b = a + 1; b < blocks.length; b++) {
      var A = blocks[a], B = blocks[b];
      if (A.el.contains(B.el) || B.el.contains(A.el)) continue;
      var ar = overlapArea(A.r, B.r);
      if (ar <= 4) continue;
      var small = Math.min(A.r.width * A.r.height, B.r.width * B.r.height);
      if (ar / small > 0.35) {
        out.issues.push({ k: 'cover', who: name(A.el) + ' × ' + name(B.el),
          d: '重叠 ' + Math.round(ar) + 'px²（占小者 ' + Math.round(ar / small * 100) + '%）' });
      }
    }
  }

  /* 留空：取「内容原子」的并集 —— 可见、非装饰、且自己不再有可见子元素。
   * 为什么不用「所有元素」：.screen 这类满屏容器会瞬间把包围盒撑到整个舞台，
   * 四边留空恒为 0，等于没量。
   * 为什么不用「指定 class 列表」：手写列表必然漏（头像、组槽、标签条各是一套类名），
   * 漏掉的正好是最外侧那一圈内容，量出来的留空就会虚高。 */
  if (!modals.length) {
    var l = Infinity, t = Infinity, rr = -Infinity, bb = -Infinity, n = 0;
    roots.forEach(function (root) {
      [].slice.call(root.querySelectorAll('*')).forEach(function (el) {
        if (!visible(el) || m(SEL.deco, el) || m(SEL.allow, el)) return;
        /* 「有可见子元素」不等于「不是内容」—— <p class="rp-note"><svg/>文字</p>
         * 这种「图标 + 文字」组合，整块曾被跳过，连文字也没人算，于是
         * 排行页空态的留空被虚报成 B51（看着像下半屏全空）。
         * 所以补一条：只要有**自己的直接文本节点**，它就是内容，用它自己的矩形。 */
        var hasVisibleChild = false;
        for (var i = 0; i < el.children.length; i++) {
          if (visible(el.children[i])) { hasVisibleChild = true; break; }
        }
        var ownText = '';
        for (var j = 0; j < el.childNodes.length; j++) {
          var cn = el.childNodes[j];
          if (cn.nodeType === 3 && (cn.textContent || '').trim()) { ownText = cn.textContent.trim(); break; }
        }
        var r = el.getBoundingClientRect();
        if (r.width < 3 || r.height < 3) return;
        var leafContent = !hasVisibleChild && ((el.textContent || '').trim().length > 0
          || el.tagName === 'IMG' || el.tagName === 'CANVAS'
          || el.tagName === 'INPUT' || el.tagName === 'BUTTON');
        if (!leafContent && !ownText) return;
        l = Math.min(l, r.left); t = Math.min(t, r.top);
        rr = Math.max(rr, r.right); bb = Math.max(bb, r.bottom); n++;
      });
    });
    if (n > 0) {
      out.gaps = {
        t: Math.round((t - sr.top) / sr.height * 100),
        b: Math.round((sr.bottom - bb) / sr.height * 100),
        l: Math.round((l - sr.left) / sr.width * 100),
        r: Math.round((sr.right - rr) / sr.width * 100)
      };
      out.atoms = n;
    }
  }
  return out;
})()`;

/* ---------------------------- 主流程 ---------------------------- */
let cdp;
let edge;
const bad = [];
const softAll = [];
const halfCutAll = [];
const report = [];
/* 每次「对局·交换」的结果。它不是版式问题，所以不进 bad，
 * 但必须在总结里单独打一行 —— 静默失败等于没测。 */
let lastSwap = null;

async function evaluate(expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    return { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || 'eval error' };
  }
  return r.result.value;
}

function chk(cond, label) { if (!cond) bad.push(label); }

const H = `(function(){ var J = window.__ui; `;

async function cleanup(keep) {
  const k = JSON.stringify(keep || []);
  const a = await evaluate(H + 'return J.cleanup(' + k + ');})()');
  await sleep(220);
  /* 再点一轮：有些弹窗关了会带出下一个（结果卡 → 下一轮提示卡） */
  const b = await evaluate(H + 'return J.cleanup(' + k + ');})()');
  return (a || 0) + (b || 0);
}

async function waitFor(expr, ms) {
  const end = Date.now() + (ms || 8000);
  while (Date.now() < end) {
    if (await evaluate(expr)) return true;
    await sleep(200);
  }
  return false;
}

/* 场景表：go() 走到这一屏；返回 false 表示没走到（照样审计 —— 那本身就是要看的东西） */
const SCENES = [
  {
    /* 引导卡：直接摘掉 .hidden 渲染出来审。
     * 为什么不用应用自己的打开路径 —— 那条路径是「首次进首页 1.2s 后自动弹」，
     * 每个视口都要重走一次登录并等一次定时器，而且会随机压在别的屏上。
     * 这一屏要看的是**版式**（多步骤卡片在矮屏上会不会溢出），静态渲染就够。 */
    id: '引导卡',
    async go() {
      await evaluate(H + "document.getElementById('guide-modal').classList.remove('hidden'); return 1;})()");
      await sleep(300);
      return await evaluate(H + "return J.vis('guide-modal');})()");
    },
    async exit() {
      await evaluate(H + "document.getElementById('guide-modal').classList.add('hidden'); return 1;})()");
      await sleep(200);
    }
  },
  {
    id: 'auth',
    async go() { return await evaluate(H + "return J.vis('screen-auth');})()"); }
  },
  {
    id: 'home',
    async go() {
      await evaluate(H + `
        try { localStorage.setItem('lxw_guide_seen_v1','1'); } catch (e) {}
        if (J.vis('screen-auth')) {
          document.querySelector('[data-auth-tab="register"]').click();
          setTimeout(function(){
            document.getElementById('auth-name').value = 'uif' + Math.floor(Math.random()*100000);
            document.getElementById('auth-pass').value = 'probe123456';
            var nk = document.getElementById('auth-nick');
            if (nk && !nk.closest('.hidden')) nk.value = '巡' + Math.floor(Math.random()*9000 + 1000);
            document.getElementById('btn-auth-submit').click();
          }, 200);
        }
        return 1;})()`);
      const okHome = await waitFor(H + "return J.vis('screen-home');})()", 9000);
      await sleep(400);
      await evaluate(H + `
        var g = document.getElementById('guide-modal');
        if (g && !g.classList.contains('hidden')) {
          var s = document.getElementById('guide-skip') || document.getElementById('guide-next');
          if (s) s.click();
        }
        return 1;})()`);
      await sleep(400);
      return okHome;
    }
  },
  {
    id: 'home·建房弹窗',
    async go() {
      await evaluate(H + "document.getElementById('btn-create').click(); return 1;})()");
      return await waitFor(H + "return J.vis('create-modal');})()", 3000);
    },
    async exit() {
      await evaluate(H + "var b=document.getElementById('btn-create-cancel'); if(b)b.click(); return 1;})()");
      await sleep(350);
    }
  },
  {
    id: '准备中',
    async go() {
      await evaluate(H + "document.getElementById('btn-create').click(); return 1;})()");
      await waitFor(H + "return J.vis('create-modal');})()", 3000);
      await evaluate(H + "document.getElementById('btn-create-confirm').click(); return 1;})()");
      const inRoom = await waitFor(H + "return J.vis('table-ready');})()", 6000);
      /* 补满 4 个 AI */
      await evaluate(H + `
        (function tick(i){
          var b = document.getElementById('btn-add-bot');
          if (!b || b.classList.contains('hidden') || i > 6) return;
          b.click(); setTimeout(function(){ tick(i+1); }, 550);
        })(0);
        return 1;})()`);
      await sleep(3600);
      return inRoom;
    }
  },
  {
    id: '对局·分牌',
    async go() {
      await evaluate(H + "var b=document.getElementById('btn-ready'); if(b)b.click(); return 1;})()");
      const g = await waitFor(H + "return J.vis('screen-game') && !J.vis('table-ready');})()", 9000);
      await sleep(700);
      return g;
    }
  },
  {
    id: '对局·交换',
    async go() {
      /* 六张全入组 → 拖一张到另一组的牌上 → 两张应当互换。
       * 这一步同时是全流程里唯一能证伪「老实现做不到」的地方：
       * 满组状态下 placeCard 一定拒绝，只有真的交换原语才能过。 */
      lastSwap = null;
      for (let i = 0; i < 8; i++) {
        const r = await evaluate(H + "return J.fillStep();})()");
        if (!r || r.done || r.stuck) break;
        await sleep(170);
      }
      await sleep(280);
      const res = await evaluate(H + "return J.trySwap();})()");
      lastSwap = res || { ok: false, why: '没返回' };
      await sleep(250);
      return !!(res && res.ok);
    }
  },
  {
    id: '对局·已提交',
    async go() {
      /* 填满 6 张 → 提交 → 等锁定（btn-submit 回到 disabled 或出现分组锁定） */
      for (let i = 0; i < 8; i++) {
        const r = await evaluate(H + "return J.fillStep();})()");
        if (!r || r.done || r.stuck) break;
        await sleep(180);
      }
      await sleep(300);
      const sub = await evaluate(H + "return J.clickSubmit();})()");
      await sleep(700);
      /* 提交要过一道确认框；点了确定才是真正的「已提交」态 */
      await evaluate(H + `
        if (J.vis('confirm-modal')) {
          var ok = document.getElementById('btn-confirm-ok');
          if (ok) ok.click();
        }
        return 1;})()`);
      await sleep(1000);
      return !!sub;
    }
  },
  {
    id: '结算',
    async go() {
      /* 上限 180 步：每组打完会弹一次回合小结、爆点会弹一次，3 组下来 90 步不够余量。
       * 到上限还没进结算会在下面单独打一行告警 —— 不许静默跳过这一屏。 */
      for (let i = 0; i < 180; i++) {
        if (await evaluate(H + "return J.vis('screen-settle');})()")) {
          await evaluate(H + "return J.closeResult();})()");   // 别让最后一张结果卡压着结算页
          await sleep(500);
          return true;
        }
        const r = await evaluate(H + "return J.finish();})()");
        if (i % 30 === 29) console.log('      … 结算推进中（' + (i + 1) + '/180，上一步 ' + r + '）');
        await sleep(600);
      }
      console.log('      [warn] 180 步仍未进结算 —— 这一屏没被审到，结论里不能算「通过」');
      return false;
    },
    async exit() {
      /* 从结算回首页：结算页没有直接回首页，靠「离开房间」。
       * 先清场 —— 结果卡/回放卡还在的话，下面的按钮点不动。 */
      await cleanup([]);
      await sleep(400);
      await evaluate(H + "var b=document.getElementById('btn-back-room'); if(b)b.click(); return 1;})()");
      await sleep(1400);
    }
  },
  {
    id: '战绩',
    async go() {
      await evaluate(H + "var b=document.getElementById('btn-records-home'); if(b)b.click(); return 1;})()");
      return await waitFor(H + "return J.vis('screen-records');})()", 5000);
    },
    async exit() {
      await evaluate(H + "var b=document.getElementById('btn-records-back'); if(b)b.click(); return 1;})()");
      await sleep(600);
    }
  },
  {
    id: '排行',
    async go() {
      await evaluate(H + "var b=document.getElementById('btn-rank-home'); if(b)b.click(); return 1;})()");
      return await waitFor(H + "return J.vis('screen-rank');})()", 6000);
    },
    async exit() {
      await evaluate(H + "var b=document.getElementById('btn-rank-back'); if(b)b.click(); return 1;})()");
      await sleep(600);
    }
  },
  {
    /* 「玩法规则」按钮打开的是**引导卡**（多步），走到底才切到完整规则层。
     * 所以这一屏要连点到 guide 的最后一页，才审得到 rules-modal。 */
    id: '完整规则',
    async go() {
      await evaluate(H + "var b=document.getElementById('btn-rules'); if(b)b.click(); return 1;})()");
      await waitFor(H + "return J.vis('guide-modal');})()", 2500);
      for (let i = 0; i < 12; i++) {
        if (await evaluate(H + "return J.vis('rules-modal');})()")) break;
        await evaluate(H + "var n=document.getElementById('guide-next'); if(n)n.click(); return 1;})()");
        await sleep(320);
      }
      return await evaluate(H + "return J.vis('rules-modal');})()");
    },
    async exit() {
      await evaluate(H + "var b=document.getElementById('btn-rules-close'); if(b)b.click(); return 1;})()");
      await sleep(400);
    }
  },
  {
    id: '账号弹窗',
    async go() {
      await evaluate(H + "var b=document.getElementById('btn-account'); if(b)b.click(); return 1;})()");
      return await waitFor(H + "return J.vis('account-modal') || !!document.querySelector('#stage .modal:not(.hidden)');})()", 4000);
    },
    async exit() {
      await evaluate(H + "var b=document.getElementById('btn-acc-close'); if(b)b.click(); return 1;})()");
      await sleep(400);
    }
  }
];

async function main() {
  server.listen(SRV_STATIC);
  startApp();
  await waitApp();

  edge = spawn(process.env.EDGE_BIN || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
    '--headless=new', '--remote-debugging-port=9357',
    '--user-data-dir=' + path.join(os.tmpdir(), 'lxw-ui-edge-' + Date.now()),
    '--no-first-run', '--disable-gpu', 'about:blank'
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 80 && !wsUrl; i++) {
    await sleep(250);
    try {
      const list = await getJson('http://127.0.0.1:9357/json/list');
      const page = list.find((t) => t.type === 'page');
      if (page) wsUrl = page.webSocketDebuggerUrl;
    } catch (e) { /* 还没起来 */ }
  }
  if (!wsUrl) throw new Error('Edge 没起来');
  cdp = await cdpConnect(wsUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  /* 首次打开 1.2s 后会自动弹玩法引导（game.js 里那个 setTimeout）。
   * 整条流程每个视口都要重来一遍，不预置标记的话它会随机压在某一屏上，
   * 报告里就分不清「这一屏坏了」还是「引导卡刚好盖上来」。
   * 引导卡本身单列一屏审计（见 SCENES 里那条）。 */
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try{localStorage.setItem('lxw_guide_seen_v1','1')}catch(e){}"
  });

  console.log('静态 :' + SRV_STATIC + ' / 应用 :' + SRV_PORT + '\n');

  const list = VIEWPORTS.filter((v) => !ONLY || (v.g + v.m).indexOf(ONLY) >= 0);

  for (let vi = 0; vi < list.length; vi++) {
    const v = list[vi];
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: v.w, height: v.h, deviceScaleFactor: 1, mobile: true
    });
    await evaluate("try{localStorage.clear()}catch(e){}");
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + SRV_PORT + '/' });
    let stable = 0;
    for (let i = 0; i < 40 && stable < 2; i++) {
      await sleep(250);
      stable = (await evaluate('document.readyState')) === 'complete' ? stable + 1 : 0;
    }
    await evaluate(PAGE_HELPERS);

    const tag = v.g + ' ' + v.m;
    console.log('===== ' + tag + '（' + v.w + '×' + v.h + '）');

    for (let si = 0; si < SCENES.length; si++) {
      const sc = SCENES[si];
      let reached = true;
      await cleanup([]);              // 上一屏漏关的弹窗不许飘到这一屏
      await sleep(250);
      try { reached = await sc.go(); } catch (e) { reached = false; }
      await sleep(450);
      await evaluate(PAGE_HELPERS);

      const a = await evaluate(AUDIT);
      if (!a || a.__err || a.fatal) {
        chk(false, tag + ' / ' + sc.id + ' / audit / ' + ((a && (a.__err || a.fatal)) || '空结果'));
        console.log('  ' + sc.id.padEnd(12) + ' 审计自身报错');
        continue;
      }
      const issues = a.issues || [];
      const soft = a.soft || [];
      const halfCut = a.halfCut || [];
      report.push({ tag, scene: sc.id, reached, screen: a.screen, issues, soft, gaps: a.gaps, halfCut });

      console.log('  ' + sc.id.padEnd(12) + (reached ? '  ' : '✗ ') + (a.screen || '').padEnd(30)
        + ' 留空 T' + (a.gaps ? a.gaps.t : '-') + ' B' + (a.gaps ? a.gaps.b : '-')
        + ' L' + (a.gaps ? a.gaps.l : '-') + ' R' + (a.gaps ? a.gaps.r : '-')
        + '  问题 ' + issues.length + (soft.length ? '（软 ' + soft.length + '）' : ''));
      if (!reached) console.log('      [nav] 没走到这一屏（后续步骤可能连带失败）');
      /* 交换自检不是版式问题，单独打一行 —— 但它失败了必须能被看见，
       * 而且必须进 bad（拖不动就是功能坏了，不能算「版式 OK」）。 */
      if (sc.id === '对局·交换') {
        const sw = lastSwap || { ok: false, why: '没跑' };
        if (sw.ok) {
          console.log('      [交换] OK  ' + (sw.detail || '') + ' → ' + (sw.after || ''));
        } else {
          console.log('      [交换] FAIL ' + (sw.why || '') + '  ' + (sw.detail || '') + ' → ' + (sw.after || ''));
          chk(false, tag + ' / 对局·交换 / 拖拽没能互换（' + (sw.why || sw.after || '未知') + '）');
        }
      }
      halfCut.forEach(function (it) {
        console.log('      [半行] ' + it.who + ' — 只露出 ' + it.shown + '%，下半截被滚动容器底边切掉');
        halfCutAll.push(tag + ' / ' + sc.id + ' / ' + it.who + ' — 只露出 ' + it.shown + '%');
      });
      issues.forEach(function (it) {
        console.log('      [' + it.k + '] ' + it.who + ' — ' + it.d);
        chk(false, tag + ' / ' + sc.id + ' / ' + it.k + ' / ' + it.who + ' — ' + it.d);
      });
      soft.forEach(function (it) { softAll.push(tag + ' / ' + sc.id + ' / ' + it.who + ' — ' + it.d); });

      if (SHOTS) {
        try {
          if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
          const cs = await cdp.send('Page.captureScreenshot', { format: 'png' });
          const slug = (v.g + '-' + v.m + '-' + sc.id).replace(/[^\w\u4e00-\u9fa5]+/g, '_');
          fs.writeFileSync(path.join(SHOT_DIR, slug + '.png'), Buffer.from(cs.data, 'base64'));
        } catch (e) { /* 截图失败不影响数据 */ }
      }

      if (sc.exit) { try { await sc.exit(); } catch (e) {} }
    }
    console.log('');
  }

  const outFile = path.join(os.tmpdir(), 'lxw-ui-flow.json');
  fs.writeFileSync(outFile, JSON.stringify({ report, bad, soft: softAll }, null, 2));
  console.log('\n完整数据: ' + outFile);

  const byKind = {};
  bad.forEach(function (b) {
    const k = (b.split(' / ')[2] || '?').trim();
    byKind[k] = (byKind[k] || 0) + 1;
  });
  console.log('\n===== 全流程 UI 巡检 =====');
  if (bad.length === 0) {
    console.log('ALL PASS  ' + list.length + ' 个视口 × ' + SCENES.length + ' 屏');
  } else {
    console.log('FAILED  ' + bad.length + ' 项  ' + JSON.stringify(byKind));
    const seen = new Set();
    bad.forEach(function (b) {
      const key = b.split(' / ').slice(2).join(' / ');
      if (seen.has(key)) return;
      seen.add(key);
      console.log('  - ' + b);
    });
  }
  if (halfCutAll.length) {
    console.log('\n半行硬切登记 ' + halfCutAll.length + ' 条（滚动容器底边切掉元素，滚一下能看到）');
    const seen3 = new Set();
    halfCutAll.forEach(function (s) {
      const key = s.split(' / ').slice(2).join(' / ');
      if (seen3.has(key)) return;
      seen3.add(key);
      console.log('  ‡ ' + s);
    });
  }
  if (softAll.length) {
    console.log('\n软问题登记 ' + softAll.length + ' 条（热区 30~44，桌面无关，触屏偏小）');
    const seen2 = new Set();
    softAll.forEach(function (s) {
      const key = s.split(' / ').slice(2).join(' / ');
      if (seen2.has(key)) return;
      seen2.add(key);
      console.log('  · ' + s);
    });
  }

  try { cdp.close(); } catch (e) {}
  edge.kill();
  if (serverProc) serverProc.kill();
  setTimeout(() => process.exit(bad.length === 0 ? 0 : 1), 500);
}

main().catch((e) => {
  console.error(e);
  try { cdp && cdp.close(); } catch (x) {}
  try { edge && edge.kill(); } catch (x) {}
  try { serverProc && serverProc.kill(); } catch (x) {}
  process.exit(1);
});
