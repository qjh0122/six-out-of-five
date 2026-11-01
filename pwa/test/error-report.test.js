/**
 * 前端错误上报（P3-5）
 * 跑法：node pwa/test/error-report.test.js
 *
 * 用 vm 沙箱把真的 errorReport.js 加载进来，注入假的 window / navigator / fetch，
 * 这样能验到 install() 到底有没有把事件真正接上 —— 只读源码看不出来。
 *
 * 重点不是「能发出请求」，而是三条容易出事的边界：
 *  1. **去重与上限**：一个渲染循环里的异常一秒能抛几百次，不节流会把服务端打满；
 *  2. **不能自己抛**：上报逻辑在错误处理路径上，它一抛就把原始错误吞了；
 *  3. **必须带 sharecode**：网关缺了参数直接 403，上报会静默全丢。
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

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'errorReport.js'), 'utf8');

function makeEnv(opts) {
  const o = opts || {};
  const handlers = {};
  const beacons = [];
  const fetches = [];
  const metaVersion = o.version === undefined ? '20261029e' : o.version;

  const self = {
    addEventListener(type, fn) { (handlers[type] = handlers[type] || []).push(fn); }
  };

  const navigator = {
    userAgent: 'test-agent/1.0',
    sendBeacon(url, blob) {
      beacons.push({ url: url, blob: blob });
      return o.beacon === undefined ? true : o.beacon;
    }
  };

  const document = {
    querySelector(sel) {
      if (sel.indexOf('app-version') >= 0 && metaVersion) {
        return { getAttribute: () => metaVersion };
      }
      return null;
    }
  };

  const location = {
    search: o.search === undefined ? '?sharecode=ABC123' : o.search,
    pathname: '/'
  };

  const sandbox = {
    self, navigator, document, location,
    Blob, URLSearchParams, JSON, Promise, String, Number, Object, Array, console, Error,
    fetch(url, init) {
      fetches.push({ url: url, init: init });
      return Promise.resolve({ ok: true });
    }
  };
  sandbox.self.navigator = navigator;

  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'errorReport.js' });

  return {
    api: sandbox.self.ErrorReport,
    handlers, beacons, fetches,
    fire(type, ev) { (handlers[type] || []).forEach((fn) => fn(ev)); },
    /** 取最后一次上报的 payload。Blob.text() 是异步的，这里也只好异步 */
    async lastPayload() {
      if (beacons.length) {
        const b = beacons[beacons.length - 1];
        const txt = b.blob && typeof b.blob.text === 'function' ? await b.blob.text() : '{}';
        return JSON.parse(txt);
      }
      if (fetches.length) return JSON.parse(fetches[fetches.length - 1].init.body);
      return null;
    }
  };
}

async function main() {
  /* ---------------------------------------------------------------- */
  console.log('\n[1] 加载后能 install，error 事件被接上');
  {
    const env = makeEnv();
    ok(env.api && typeof env.api.capture === 'function', '导出了 capture');
    eq(env.handlers.error ? env.handlers.error.length : 0, 0, '默认不自动装（沙箱里没有 window）');
    eq(env.api.install(), true, 'install() 返回 true');
    ok(env.handlers.error && env.handlers.error.length === 1, 'error 监听已注册');
    ok(env.handlers.unhandledrejection && env.handlers.unhandledrejection.length === 1,
      'unhandledrejection 监听已注册');
  }

  /* ---------------------------------------------------------------- */
  console.log('\n[2] 上报带 sharecode（漏了就是 403，等于全丢）');
  {
    const env = makeEnv();
    env.api.install();
    env.fire('error', { message: 'boom', filename: 'game.js', lineno: 12, colno: 3, error: { stack: 'at x' } });
    eq(env.beacons.length, 1, '走的是 sendBeacon');
    ok(env.beacons[0].url.indexOf('sharecode=ABC123') > 0, '★ URL 带上了 sharecode');
    const p = await env.lastPayload();
    eq(p.message, 'boom', 'message 正确');
    eq(p.lineno, 12, '行号正确');
    eq(p.version, '20261029e', '带了版本号（能把报错和发版对上）');
  }

  /* ---------------------------------------------------------------- */
  console.log('\n[3] 去重：同一条只报一次');
  {
    const env = makeEnv();
    env.api.install();
    for (let i = 0; i < 5; i++) {
      env.fire('error', { message: 'same error', filename: 'a.js', lineno: i + 1 });
    }
    eq(env.beacons.length, 1, '★ 5 次同样的错误只发 1 条');
  }

  /* ---------------------------------------------------------------- */
  console.log('\n[4] 上限：一个会话最多 10 条');
  {
    const env = makeEnv();
    env.api.install();
    for (let i = 0; i < 30; i++) {
      env.fire('error', { message: 'err-' + i });
    }
    eq(env.beacons.length, 10, '★ 30 条不同的错误只发 10 条（否则会把服务端打满）');
    eq(env.api._stats().sent, 10, '内部计数也是 10');
  }

  /* ---------------------------------------------------------------- */
  console.log('\n[5] 字段截断：超长 message / stack 不会把请求撑爆');
  {
    const env = makeEnv();
    env.api.install();
    env.fire('error', {
      message: 'x'.repeat(2000),
      /* 真实浏览器里 stack 挂在 ev.error 上，不是 ev.stack —— 这里照实给，
       * 写错这个字段的话前面的断言会「通过」，但线上 stack 永远是空的 */
      error: { stack: 'y'.repeat(5000) },
      filename: 'z'.repeat(500)
    });
    const p = await env.lastPayload();
    eq(p.message.length, 300, 'message 截到 300');
    eq(p.stack.length, 800, 'stack 截到 800');
    eq(p.source.length, 160, 'source 截到 160');
  }

  /* ---------------------------------------------------------------- */
  console.log('\n[6] sendBeacon 不可用 / 返回 false → 回退 fetch');
  {
    const env = makeEnv({ beacon: false });
    env.api.install();
    env.fire('error', { message: 'fallback' });
    eq(env.beacons.length, 1, 'beacon 被调用过');
    eq(env.fetches.length, 1, '★ beacon 返回 false 时退回 fetch');
    eq(env.fetches[0].init.method, 'POST', 'fetch 是 POST');
    eq(env.fetches[0].init.keepalive, true, 'keepalive 保证卸载时也能发出去');
  }

  /* ---------------------------------------------------------------- */
  console.log('\n[7] 资源加载失败（没有 message，只有 target）');
  {
    const env = makeEnv();
    env.api.install();
    const img = { tagName: 'IMG', src: 'https://x/a.png' };
    env.fire('error', { target: img });
    const p = await env.lastPayload();
    ok(p && p.kind === 'resource', '★ 归为 resource 类型');
    ok(p && p.message.indexOf('a.png') > 0, 'message 里带上了资源地址');
  }

  /* ---------------------------------------------------------------- */
  console.log('\n[8] unhandledrejection');
  {
    const env = makeEnv();
    env.api.install();
    env.fire('unhandledrejection', { reason: { message: 'promise failed', stack: 'at p' } });
    const p = await env.lastPayload();
    eq(p.kind, 'rejection', '类型是 rejection');
    eq(p.message, 'promise failed', '取出 reason.message');
  }

  /* ---------------------------------------------------------------- */
  console.log('\n[9] ★ 上报自己抛异常时不能影响原流程');
  {
    const env = makeEnv();
    let threw = false;
    let result;
    try {
      /* 构造一个取 source 就抛的 extra —— 模拟调用方传了奇怪的 getter。
       * capture 跑在错误处理路径上，它一抛就把原始错误吞了，所以必须自己兜住。 */
      result = env.api.capture('error', 'x', {
        get source() { throw new Error('getter boom'); }
      });
    } catch (e) { threw = true; }
    ok(!threw, '★ capture 内部异常不会往外抛');
    eq(result, false, '失败时返回 false 而不是 undefined');
  }

  /* ---------------------------------------------------------------- */
  console.log('\n[10] 没有 sharecode 时不拼多余参数');
  {
    const env = makeEnv({ search: '' });
    env.api.install();
    env.fire('error', { message: 'no share' });
    eq(env.beacons[0].url, '/api/client-error', 'URL 是裸的 /api/client-error');
  }

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('测试异常：', e && e.stack || e);
  process.exit(1);
});
