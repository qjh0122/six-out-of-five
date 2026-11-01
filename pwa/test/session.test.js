/**
 * 登录态与「记住登录」
 * 跑法：node pwa/test/session.test.js
 *
 * 不启浏览器：用 vm 把 authStore.js 放进一个假页面里跑，只给它三样东西
 * —— localStorage、location、fetch。
 *
 * 关键手法：**每次「重新打开页面」都新建一个沙箱，但共用同一份存储**。
 * 这正好对应真实情况（进程没了、内存没了，只剩 localStorage），
 * 能证明「关掉浏览器再进来还是登录状态」靠的是存储，而不是某个还活着的变量。
 */
'use strict';

const { readAll: readGameAll } = require('./helpers/gameSource');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const authStoreSrc = fs.readFileSync(path.join(ROOT, 'js', 'authStore.js'), 'utf8');
const storageSrc = fs.readFileSync(path.join(ROOT, 'js', 'storage.js'), 'utf8');
const roomStoreSrc = fs.readFileSync(path.join(ROOT, 'js', 'roomStore.js'), 'utf8');
const gameJs = readGameAll();
const serverAuthSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'auth.js'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
const eq = (a, b, name) => ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));

/** 一块「磁盘」：所有页面沙箱共用它 */
function makeDisk() {
  const data = new Map();
  return {
    data,
    storage: {
      getItem: (k) => (data.has(k) ? data.get(k) : null),
      setItem: (k, v) => { data.set(k, String(v)); },
      removeItem: (k) => { data.delete(k); },
      clear: () => data.clear(),
      key: (i) => Array.from(data.keys())[i] || null,
      get length() { return data.size; }
    }
  };
}

/** 开一个「页面」。disk 不传就是全新设备 */
function openPage(disk, opts) {
  const o = opts || {};
  const pageFetch = [];
  const sandbox = {
    localStorage: disk.storage,
    sessionStorage: {
      _d: new Map(),
      getItem(k) { return this._d.has(k) ? this._d.get(k) : null; },
      setItem(k, v) { this._d.set(k, String(v)); },
      removeItem(k) { this._d.delete(k); }
    },
    location: { search: o.search === undefined ? '?sharecode=abc123' : o.search },
    URLSearchParams: URLSearchParams,
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    fetch: async (url, init) => {
      pageFetch.push({ url, init });
      const h = o.handler ? o.handler(url, init) : { status: 200, body: { ok: true } };
      return {
        status: h.status === undefined ? 200 : h.status,
        json: async () => h.body
      };
    }
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  /* 存储收口（v111）：authStore 的物理键与降级逻辑都在 js/storage.js。
   * 沙箱里必须先把它跑起来，否则 authStore 拿不到 Store，写的是空实现 ——
   * 那时「登录态写进 localStorage」这条会以「什么都没写」的方式红。 */
  vm.runInContext(storageSrc, sandbox, { filename: 'storage.js' });
  vm.runInContext(authStoreSrc, sandbox, { filename: 'authStore.js' });
  return { AuthStore: sandbox.AuthStore, fetchCalls: pageFetch, sandbox };
}

const REG_BODY = {
  ok: true,
  token: 'TOK-A',
  me: {
    playerId: 'pAAA',
    nickname: '阿测',
    account: { name: 'ceshi', createdAt: 1700000000000 }
  }
};

async function main() {
  /* ==================== 一、记住登录 ==================== */
  console.log('\n[记住登录：关掉再进来还在]');
  {
    const disk = makeDisk();
    const p1 = openPage(disk, { handler: () => ({ status: 200, body: REG_BODY }) });
    const r = await p1.AuthStore.register('ceshi', 'pass123456', '阿测');
    ok(r.ok === true, '注册成功');
    ok(p1.AuthStore.isLoggedIn() === true, '注册后立刻是登录态');

    // 关键：登录态必须落在 localStorage（跨浏览器会话），不能只落 sessionStorage
    ok(disk.data.has('lxw_session_v1'), '登录态写进 localStorage');
    ok(!p1.sandbox.sessionStorage._d.has('lxw_session_v1'), '没有写进 sessionStorage（那是关标签页就没的）');

    const saved = JSON.parse(disk.data.get('lxw_session_v1'));
    eq(saved.token, 'TOK-A', '存下了令牌');
    eq(saved.playerId, 'pAAA', '存下了 playerId');
    eq(saved.name, 'ceshi', '存下了账号名');
    eq(saved.nickname, '阿测', '存下了昵称');

    // 「关掉浏览器再打开」：新沙箱 + 同一块盘，内存里什么都没有
    const p2 = openPage(disk, { handler: () => ({ status: 200, body: { ok: true, me: REG_BODY.me } }) });
    ok(p2.AuthStore.isLoggedIn() === true, '重开页面仍然是登录态（不用再登一次）');
    eq(p2.AuthStore.playerId(), 'pAAA', '重开后还是同一个 playerId');
    eq(p2.AuthStore.token(), 'TOK-A', '重开后拿得到原令牌');

    // 换一台设备 / 另一个浏览器：没有那块盘 → 必须重新登录
    const p3 = openPage(makeDisk());
    ok(p3.AuthStore.isLoggedIn() === false, '换一台设备要重新登录（符合预期）');
  }

  /* ==================== 二、滑动续期 ==================== */
  console.log('\n[滑动续期：只要还在玩就一直不用重登]');
  {
    const disk = makeDisk();
    // 先制造一个已登录的旧令牌
    disk.data.set('lxw_session_v1', JSON.stringify({
      token: 'TOK-OLD', playerId: 'pAAA', nickname: '阿测', name: 'ceshi', joinedAt: 1
    }));

    const p = openPage(disk, {
      handler: () => ({
        status: 200,
        body: { ok: true, token: 'TOK-NEW', me: { playerId: 'pAAA', nickname: '阿测', account: { name: 'ceshi', createdAt: 1 } } }
      })
    });
    const st = await p.AuthStore.refresh();
    eq(st, 'ok', '续期请求成功');
    eq(p.AuthStore.token(), 'TOK-NEW', '服务端下发的新令牌被接住了');
    eq(JSON.parse(disk.data.get('lxw_session_v1')).token, 'TOK-NEW', '新令牌也落了盘');
    ok(p.fetchCalls[0].url.indexOf('sharecode=abc123') > 0, '续期请求带上了 sharecode（否则网关 403）');
    ok(p.fetchCalls[0].init.headers['X-Session-Token'] === 'TOK-OLD', '续期请求带的是旧令牌（走自定义头）');
    /* 线上网关会消费掉 Authorization 头，后端收不到 → 必须走自定义头。
     * 这条锁住的是真实线上故障，不是风格偏好。 */
    ok(!p.fetchCalls[0].init.headers.Authorization, '不能用 Authorization 头（部署网关会拦掉它）');

    // 服务端没给新令牌（寿命没过半）时不能把旧令牌弄丢
    const p2 = openPage(disk, {
      handler: () => ({ status: 200, body: { ok: true, me: { playerId: 'pAAA', nickname: '阿测' } } })
    });
    await p2.AuthStore.refresh();
    eq(p2.AuthStore.token(), 'TOK-NEW', '没下发新令牌时保留原令牌');
  }

  /* ==================== 三、什么情况才踢人 ==================== */
  console.log('\n[只有明确失效才踢人，弱网不踢]');
  {
    // 401：令牌真失效 → 清本地会话
    const disk = makeDisk();
    disk.data.set('lxw_session_v1', JSON.stringify({ token: 'T', playerId: 'p1', name: 'a' }));
    const p = openPage(disk, {
      handler: () => ({ status: 401, body: { ok: false, error: '登录已失效，请重新登录' } })
    });
    eq(await p.AuthStore.refresh(), 'expired', '401 → expired');
    ok(p.AuthStore.isLoggedIn() === false, '401 时清掉本地会话（不留下一个死令牌继续发请求）');
    ok(!disk.data.has('lxw_session_v1'), '存储里也删干净了');

    // 403：账号被停用 → 同样踢，但要说清原因
    const disk2 = makeDisk();
    disk2.data.set('lxw_session_v1', JSON.stringify({ token: 'T', playerId: 'p1', name: 'a' }));
    const p2 = openPage(disk2, {
      handler: () => ({ status: 403, body: { ok: false, error: '该账号已被停用，请联系管理员' } })
    });
    eq(await p2.AuthStore.refresh(), 'expired', '403 → expired');
    eq(p2.AuthStore.lastError(), '该账号已被停用，请联系管理员', '把服务端的原因带出来，别只说「登录已失效」');

    // 网络断了：绝不能被踢
    const disk3 = makeDisk();
    disk3.data.set('lxw_session_v1', JSON.stringify({ token: 'T', playerId: 'p1', name: 'a' }));
    const p3 = openPage(disk3, {
      handler: () => { throw new Error('offline'); }
    });
    eq(await p3.AuthStore.refresh(), 'offline', '断网 → offline');
    ok(p3.AuthStore.isLoggedIn() === true, '断网时不踢人，登录态留着');
  }

  /* ==================== 四、退出登录 ==================== */
  console.log('\n[退出登录]');
  {
    const disk = makeDisk();
    disk.data.set('lxw_session_v1', JSON.stringify({ token: 'T', playerId: 'p1', name: 'a' }));
    const p = openPage(disk);
    ok(p.AuthStore.isLoggedIn() === true, '退出前是登录态');
    p.AuthStore.logout();
    ok(p.AuthStore.isLoggedIn() === false, '退出后不是登录态');
    ok(!disk.data.has('lxw_session_v1'), '退出后存储已清空');
    ok(p.AuthStore.playerId() === '' && p.AuthStore.token() === '', '退出后取不到身份');
  }

  /* ==================== 五、退出时必须做的事（静态契约） ==================== */
  console.log('\n[退出/删号要清干净：连接、房间、昵称缓存]');
  {
    // 门面上必须真的挂着 disconnect —— 这一条曾经加在内部 ws 对象上，外部调不到，
    // 退出后那条 WS 仍然以上一个账号的身份挂在服务端。
    const facade = roomStoreSrc.slice(roomStoreSrc.lastIndexOf('return {'));
    ok(/disconnect:\s*function/.test(facade), 'RoomStore 门面上暴露了 disconnect（不是只挂在内部 ws 上）');
    ok(/if \(MODE === 'ws'\) \{ ws\.disconnect\(\); return; \}/.test(facade), '门面把调用转给 ws 实现');
    ok(/local\.disconnect\(\)/.test(facade), '本地演示模式也有对应实现，不留 undefined');

    ok(/function leaveAccountState/.test(gameJs), '有一个统一的「清干净这个人」的函数');
    const leave = gameJs.slice(gameJs.indexOf('function leaveAccountState'), gameJs.indexOf('function leaveAccountState') + 700);
    ok(/RoomStore\.disconnect\(\)/.test(leave), '退出/删号时断开长连接');
    ok(/cleanupRoom\(\)/.test(leave), '退出/删号时清掉房内状态');
    ok(/AuthStore\.logout\(\)/.test(leave), '退出/删号时清掉本地会话');
    /* v111 起存储调用统一走 ST（js/storage.js），所以判据从 removeItem(LS_NICK)
     * 改成 ST.remove(LS_NICK) —— 守的是同一件事：昵称缓存被清掉了。 */
    ok(/ST\.remove\(LS_NICK\)/.test(leave), '退出/删号时清掉昵称缓存（否则下一个人看到上一个人的名字）');
    ok(/onLogout[\s\S]{0,200}leaveAccountState/.test(gameJs), '退出登录走的是这套清理');
    /* 断言从「调了这个函数」升级成「**传了 purge**」：
     * 删号后必须连本机战绩与整场回放一起清，只清会话等于只删了一半。
     * 窗口放宽到 900 是因为 onDeleteAccount 里现在有一段说明
     * 「pid 必须在删号请求之前取」的注释 —— 注释该长就长，
     * 但断言要盯住行为，而不是被注释挤红。 */
    ok(/onDeleteAccount[\s\S]{0,900}leaveAccountState\(true/.test(gameJs),
      '删号走的是这套清理，并且传了 purge');
    /* 反向：退出登录绝不能传 —— 那会把用户的离线历史反复抹掉 */
    ok(!/onLogout[\s\S]{0,400}leaveAccountState\(true/.test(gameJs),
      '退出登录不清本机战绩（战绩要留着下次登录看）');
  }

  /* ==================== 六、令牌寿命 ==================== */
  console.log('\n[令牌寿命]');
  {
    const m = /const TOKEN_TTL_MS = (\d+) \* 24 \* 3600 \* 1000/.exec(serverAuthSrc);
    const days = m ? Number(m[1]) : 0;
    ok(days >= 90, '有效期至少 90 天（' + days + ' 天），配合续期等于「一直在玩就一直不用登」');
    ok(/function needsRenew/.test(serverAuthSrc), '有滑动续期判定');
    ok(/ttl \/ 2|ttl\/2/.test(serverAuthSrc), '寿命过半才续（不是每次都换新令牌）');
  }

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('脚本失败', e && e.stack); process.exit(1); });
