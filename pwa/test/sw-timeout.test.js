/**
 * Service Worker 的 network-first 超时兜底（P3-3）
 * 跑法：node pwa/test/sw-timeout.test.js
 *
 * 改之前是 `fetch().then().catch(回落缓存)`：catch 只在**网络失败**时触发。
 * 弱网下「慢但最终成功」的请求会一直等，页面就是一片白。
 * 饭馆 4G 拥塞、地铁信号抖动时，fetch 挂十几秒才开始返回是常态。
 *
 * 这个测试用 vm 沙箱加载真的 sw.js，注入假的 caches / fetch / 定时器，
 * 不碰真实浏览器也能验到三个关键行为：
 *  1. 网络快 → 用网络；
 *  2. 网络慢 → 到点先给缓存，**且不 abort**；
 *  3. 迟到的那次响应回来后要**写进缓存**（否则「下次打开是新的」就废了）。
 *
 * 第 3 条最容易漏：超时不 abort 看起来只是"让请求跑完"，
 * 但真正的作用是它能把缓存更新掉。少了这一步，用户会一直看到旧版。
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
  const store = new Map();      // pathname -> Response（忽略 query，等价于 ignoreSearch）
  const timers = [];            // { fn, ms, fired }
  const listeners = {};
  let fetchImpl = async () => new Response('net', { status: 200 });

  /* 字符串参数可能是相对路径（sw.js 里会这样调 caches.match('/index.html')），
   * 所以要带 base 解析，否则 new URL 直接抛 Invalid URL。 */
  const keyOf = (u) => new URL(typeof u === 'string' ? u : u.url, ORIGIN).pathname;

  const caches = {
    open: async () => ({
      put: async (req, res) => { store.set(keyOf(req), res); },
      add: async () => {}
    }),
    match: async (req) => store.get(keyOf(req)),
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
  console.log('\n[1] 网络正常 → 直接用网络响应');
  {
    const env = makeEnv();
    env.store.set('/js/game.js', new Response('cached', { status: 200 }));
    env.setFetch(async () => new Response('fresh', { status: 200 }));
    const res = await env.dispatch(reqOf('/js/game.js'));
    const out = await res;
    eq(await out.text(), 'fresh', '拿到的是网络版本');
    await flush();
    eq(await (await env.store.get('/js/game.js')).text(), 'fresh', '缓存被更新成网络版本');
  }

  /* ---------------------------------------------------------------- */
  console.log('\n[2] ★ 网络卡住 → 到点先给缓存（这是修复的核心）');
  {
    const env = makeEnv();
    env.store.set('/js/game.js', new Response('cached', { status: 200 }));
    let fetchCalled = false;
    env.setFetch(() => { fetchCalled = true; return new Promise(() => {}); });  // 永不返回

    const pending = env.dispatch(reqOf('/js/game.js'));
    ok(!!pending, 'respondWith 拿到了 promise');
    ok(fetchCalled, '网络请求确实发出去了（不是压根没试）');

    /* 2000ms 是 ASSET_TIMEOUT_MS */
    env.elapse(2000);
    const res = await pending;
    eq(await res.text(), 'cached', '★ 2 秒后拿到缓存，页面不会白屏');
  }

  /* ---------------------------------------------------------------- */
  console.log('\n[3] ★ 超时后不 abort，迟到的响应要写回缓存');
  {
    const env = makeEnv();
    env.store.set('/js/game.js', new Response('v1', { status: 200 }));
    let release = null;
    env.setFetch(() => new Promise((r) => { release = r; }));

    const pending = env.dispatch(reqOf('/js/game.js'));
    env.elapse(2000);
    eq(await (await pending).text(), 'v1', '先给了缓存 v1');

    /* 网络最终回来了 */
    release(new Response('v2', { status: 200 }));
    await flush(12);
    eq(await (await env.store.get('/js/game.js')).text(), 'v2',
      '★ 迟到的 v2 已写进缓存（下次打开是新的，不是一直看旧的）');
  }

  /* ---------------------------------------------------------------- */
  console.log('\n[4] 网络失败 + 有缓存 → 回落缓存');
  {
    const env = makeEnv();
    env.store.set('/js/game.js', new Response('cached', { status: 200 }));
    env.setFetch(async () => { throw new Error('offline'); });
    const res = await env.dispatch(reqOf('/js/game.js'));
    eq(await (await res).text(), 'cached', '断网时用的是缓存');
  }

  /* ---------------------------------------------------------------- */
  console.log('\n[5] 网络失败 + 没缓存 → Response.error()，不是 undefined');
  {
    const env = makeEnv();
    env.setFetch(async () => { throw new Error('offline'); });
    const res = await env.dispatch(reqOf('/js/nope.js'));
    ok(res instanceof Response, '拿到的是 Response 对象（respondWith 返回 undefined 会直接报错）');
    eq(await res.status, 0, 'status 0 = 网络错误');
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
