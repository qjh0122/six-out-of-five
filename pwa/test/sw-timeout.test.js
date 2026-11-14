/**
 * Service Worker 的缓存策略（导航 network-first 超时兜底 + 脚本样式 cache-first）
 * 跑法：node pwa/test/sw-timeout.test.js
 *
 * 这个文件护两套语义完全相反的规则，改任何一边都要先看清是哪一边：
 *
 * ① 导航（HTML）仍是 network-first + 4200ms 超时兜底。
 *    改之前是 `fetch().then().catch(回落缓存)`：catch 只在**网络失败**时触发，
 *    弱网下「慢但最终成功」的请求会一直等，页面就是一片白。
 *
 * ② 脚本/样式（/js/ /css/）是 **cache-first，且只认 URL 全等**。
 *    2026-11-14 之前它们是 network-first，代价是每次打开 32 个脚本 + 3 个样式
 *    全部先过一遍网络：HTTP 缓存 1 小时内还好，隔夜就是全量重下，首屏卡在下载上。
 *    现在同版本第二次打开一条脚本请求都不发。
 *
 *    为什么敢 cache-first：`?v=` 就是 app-version，是内容指纹。版本一变 URL 就变，
 *    缓存必然 miss，自然去拿新的。所以「URL 全等才命中」这一条**同时**保证了
 *    「快」和「不会拿旧代码」，两个目标不冲突。
 *
 * 这个测试用 vm 沙箱加载真的 sw.js，注入假的 caches / fetch / 定时器。
 * 假 cache 的键**包含查询串**（真 Cache API 就是这样），否则「精确匹配」测不出来。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

const SW_SRC = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
const ORIGIN = 'https://x.test';

/** 建一个能跑 sw.js 的沙箱，返回控制句柄 */
function makeEnv() {
  /* 键 = pathname + search。**必须带查询串**：脚本/样式分支靠「URL 全等」来
   * 保证版本一致，假缓存如果忽略 query，这条规则就等于没测。
   * ignoreSearch 由 match() 的第二个参数显式实现（真 Cache API 的行为）。 */
  const store = new Map();
  const timers = [];            // { fn, ms, fired }
  const listeners = {};
  let fetchImpl = async () => new Response('net', { status: 200 });

  /* 字符串参数可能是相对路径（sw.js 里会这样调 caches.match('/index.html')），
   * 所以要带 base 解析，否则 new URL 直接抛 Invalid URL。 */
  const keyOf = (u) => {
    const x = new URL(typeof u === 'string' ? u : u.url, ORIGIN);
    return x.pathname + x.search;
  };

  const caches = {
    open: async () => ({
      put: async (req, res) => { store.set(keyOf(req), res); },
      add: async () => {}
    }),
    match: async (req, opts) => {
      const exact = store.get(keyOf(req));
      if (exact) return exact;
      if (!opts || !opts.ignoreSearch) return undefined;
      const wantPath = new URL(typeof req === 'string' ? req : req.url, ORIGIN).pathname;
      for (const k of store.keys()) {
        if (k.split('?')[0] === wantPath) return store.get(k);
      }
      return undefined;
    },
    keys: async () => [],
    delete: async () => true
  };

  const selfObj = {
    location: { href: ORIGIN + '/sw.js', origin: ORIGIN },
    addEventListener: (t, fn) => { listeners[t] = fn; },
    skipWaiting: () => {},
    clients: { claim: () => {} }
  };

  const sandbox = {
    self: selfObj,
    caches,
    fetch: (...a) => fetchImpl(...a),
    Response, Request, URL, Promise, console, Date, JSON, Math,
    Object, Array, String, Number, RegExp, Error, TypeError,
    setTimeout: (fn, ms) => { timers.push({ fn: fn, ms: ms, fired: false }); return timers.length; },
    clearTimeout: (id) => { const t = timers[id - 1]; if (t) t.fired = true; }
  };
  vm.createContext(sandbox);
  vm.runInContext(SW_SRC, sandbox);

  return {
    store,
    timers,
    setFetch(fn) { fetchImpl = fn; },
    /** 触发所有 ms <= 给定值的定时器（模拟时间流逝） */
    elapse(ms) {
      timers.forEach((t) => {
        if (!t.fired && t.ms <= ms) { t.fired = true; t.fn(); }
      });
    },
    /** 派发一个 fetch 事件，返回 respondWith 收到的 promise */
    dispatch(req) {
      let captured = null;
      listeners.fetch({ request: req, respondWith: (p) => { captured = p; } });
      return captured;
    }
  };
}

/** 让微任务队列跑干净（缓存写入是几个 then 之后才发生） */
function flush(n) {
  let p = Promise.resolve();
  for (let i = 0; i < (n || 8); i++) p = p.then(() => new Promise((r) => setImmediate(r)));
  return p;
}

const reqOf = (p, mode) => ({
  method: 'GET',
  url: ORIGIN + p,
  mode: mode || 'no-cors',
  headers: {}
});
const navReq = (p) => reqOf(p || '/', 'navigate');

async function main() {
  /* ---------------------------------------------------------------- */
  console.log('\n[1] 脚本有缓存（URL 全等）→ 直接返回，**不发网络请求**');
  {
    const env = makeEnv();
    env.store.set('/js/game.js?v=A', new Response('cached-A', { status: 200 }));
    let called = 0;
    env.setFetch(async () => { called++; return new Response('net', { status: 200 }); });
    const res = await env.dispatch(reqOf('/js/game.js?v=A'));
    eq(await (await res).text(), 'cached-A', '拿到缓存版本');
    eq(called, 0, '★ 一次网络请求都没发（这就是「每次打开卡一会儿」的修法）');
  }

  /* ---------------------------------------------------------------- */
  console.log('\n[2] 脚本没缓存 → 走网络，并把结果写进缓存');
  {
    const env = makeEnv();
    env.setFetch(async () => new Response('fresh-B', { status: 200 }));
    const res = await env.dispatch(reqOf('/js/game.js?v=B'));
    eq(await (await res).text(), 'fresh-B', '拿到网络版本');
    await flush();
    const hit = env.store.get('/js/game.js?v=B');
    ok(!!hit, '★ 已按**完整 URL**写进缓存');
    eq(await hit.text(), 'fresh-B', '缓存里是新版本');
  }

  /* ---------------------------------------------------------------- */
  console.log('\n[3] ★ 缓存里只有旧版本 → 新版本的请求必须 miss（防「HTML 新、JS 旧」）');
  {
    /* 这是 2026-11-12 那个 bug 的根：旧实现用 ignoreSearch 兜底，把 ?v= 一起忽略，
     * 于是新版 HTML 拿到的是上一版 game.js。现在只做精确匹配，URL 差一个字就当没有。 */
    const env = makeEnv();
    env.store.set('/js/game.js?v=OLD', new Response('old-code', { status: 200 }));
    let called = 0;
    env.setFetch(async () => { called++; return new Response('new-code', { status: 200 }); });
    const res = await env.dispatch(reqOf('/js/game.js?v=NEW'));
    eq(await (await res).text(), 'new-code', '拿到的是新版本，不是缓存里的旧版本');
    eq(called, 1, '★ 缓存 miss 才会去网络（说明它确实没把旧条目当命中）');
  }

  /* ---------------------------------------------------------------- */
  console.log('\n[4] 没缓存 + 断网 → Response.error()，不是 undefined');
  {
    const env = makeEnv();
    env.setFetch(async () => { throw new Error('offline'); });
    const res = await env.dispatch(reqOf('/js/nope.js?v=A'));
    ok(res instanceof Response, '拿到的是 Response 对象（respondWith 返回 undefined 会直接报错）');
    eq(await res.status, 0, 'status 0 = 网络错误');
  }

  /* ---------------------------------------------------------------- */
  console.log('\n[5] 有缓存 + 断网 → 照样给缓存（cache-first 的自然结果）');
  {
    const env = makeEnv();
    env.store.set('/js/game.js?v=A', new Response('cached', { status: 200 }));
    env.setFetch(async () => { throw new Error('offline'); });
    const res = await env.dispatch(reqOf('/js/game.js?v=A'));
    eq(await (await res).text(), 'cached', '断网时用的是缓存');
  }

  /* ---------------------------------------------------------------- */
  console.log('\n[6] 导航超时 → 回落 index.html');
  {
    /* 阈值 4200ms 是有实测依据的：线上冷启动首字节 3.18s，而这一支一旦抢跑，
     * 用户会先看到缓存页、再被刷新一次。所以这里同时锁「到点会回落」和
     * 「不会早于 4 秒回落」两件事 —— 只锁前者的话，有人把值调回 3 秒测试照样绿。 */
    const env = makeEnv();
    env.store.set('/index.html', new Response('<html>cached home</html>', { status: 200 }));
    env.setFetch(() => new Promise(() => {}));
    const pending = env.dispatch(navReq('/?sharecode=ABC'));
    env.elapse(3999);
    let early = false;
    pending.then(() => { early = true; });
    await Promise.resolve();
    ok(early === false, '★ 3.999 秒时还没有抢跑（冷启动 3.18s 的那一次不该被截断）');

    /* 注意 elapse(ms) 是「触发所有 ms <= 参数 的定时器」的绝对阈值，不累加。 */
    env.elapse(4200);   // = NAV_TIMEOUT_MS
    const txt = await (await pending).text();
    ok(txt.indexOf('cached home') >= 0, '★ 到 4.2 秒才回落到缓存的首页');
  }

  /* ---------------------------------------------------------------- */
  console.log('\n[7] 网关 403：导航给友好页，脚本保持 403');
  {
    const env = makeEnv();
    env.setFetch(async () => new Response('forbidden', { status: 403 }));
    const res = await (await env.dispatch(navReq('/')));
    eq(res.status, 200, '导航 403 转成 200（否则玩家看到浏览器的"链接不完整"）');
    const hintHtml = await res.text();
    ok(hintHtml.indexOf('访问链接已失效') >= 0, '文案是给人看的');
    /* 桌面图标启动时请求的是 "/"，没有 sharecode；cookie 过期就是 403。
     * 这张兜底页必须自己先试着用 localStorage 里的码重新打开 ——
     * 它是 index.html 之外唯一会渲染的文档，那段自救脚本不会替它跑。 */
    ok(hintHtml.indexOf('lxw_sharecode_v1') >= 0, '★ 兜底页会读本地记住的 sharecode');
    ok(hintHtml.indexOf('location.replace') >= 0, '★ 读出码就带码重开（顺带刷新网关 cookie）');
    ok(hintHtml.indexOf('lxw_sc_retried') >= 0, '★ 只重试一次（过期码不会跳成死循环）');

    const env2 = makeEnv();
    env2.setFetch(async () => new Response('forbidden', { status: 403 }));
    const jsRes = await (await env2.dispatch(reqOf('/js/game.js')));
    eq(jsRes.status, 403, '★ 脚本的 403 保持原样（替换成 HTML 会被当 JS 执行，报语法错）');
  }

  /* ---------------------------------------------------------------- */
  console.log('\n[8] 图片走 cache-first，不进超时逻辑');
  {
    const env = makeEnv();
    env.store.set('/assets/card_back.webp', new Response('img', { status: 200 }));
    let called = 0;
    env.setFetch(async () => { called++; return new Response('netimg', { status: 200 }); });
    const res = await (await env.dispatch(reqOf('/assets/card_back.webp')));
    eq(await res.text(), 'img', '命中缓存直接返回');
    eq(called, 0, '★ 没有发起网络请求（cache-first 的意义）');
  }

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('测试异常：', e && e.stack || e);
  process.exit(1);
});
