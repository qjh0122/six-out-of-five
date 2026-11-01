/**
 * 账号三条防线（全量 review P1-4 / P1-6 / P1-7）
 * 跑法：node server/test/auth-guard.test.js
 *
 * 三件事，都是「测试全绿也照样存在」的洞：
 *
 * ① **改密码接口没有失败限流**（P1-6）
 *    `/api/auth/delete` 早就走了 loginBlocked / noteLoginFail，`/api/auth/password` 却漏了。
 *    于是它变成一条「无视登录限流的密码爆破通道」：令牌能存 90 天，
 *    捡到手机/公用电脑没退出就能拿到令牌，然后以每小时无限次的速度猜旧密码，
 *    猜中即改密码把号彻底拿走 —— 登录接口那边限流再严也拦不住这条路。
 *
 * ② **昵称不唯一**（P1-7）
 *    排行榜、战绩、结算页全都只显示昵称、不显示账号名。撞名 = 可以冒充别人。
 *    判据还必须比显示更宽：`小明` 和 `小明 `（尾随空格）在 HTML 里折叠成同一个样子。
 *
 * ③ **sw.js 被通用静态缓存头缓存 1 小时**（P1-4）
 *    Service Worker 主脚本一旦被 `max-age=3600` 缓存住，发版后最长 1 小时才拿到新版本。
 *    Chrome 更新 SW 时默认绕开 HTTP 缓存，Safari / 旧 WebView 不保证 ——
 *    表现是「首页提示发现新版本，怎么刷都没反应」。
 */
'use strict';

const path = require('path');
const os = require('os');

process.env.PROFILE_FILE = path.join(os.tmpdir(), 'lxw-guard-profiles-' + Date.now() + '.json');
process.env.SEED_FILE = path.join(os.tmpdir(), 'lxw-guard-seed-' + Date.now() + '.json');
process.env.PORT = process.env.PORT || '3211';
const PORT = Number(process.env.PORT);

const { server } = require('../index.js');
const { httpJson, httpAuth, registerPlayer } = require('./helpers/account');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

/** 失败计数是**账号名 + IP** 维度的，同一进程内共享；每个用例用不同账号，互不干扰。 */
async function changePwd(token, oldPassword, newPassword) {
  return httpAuth(PORT, 'POST', '/api/auth/password', token, {
    oldPassword: oldPassword,
    newPassword: newPassword
  });
}

async function run() {
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });

  /* ================================================================= */
  console.log('\n[1] 改密码接口必须纳入登录失败限流（P1-6）');

  {
    const acc = await registerPlayer(PORT, '限流甲');

    /* LOGIN_FAIL_MAX = 6：前 6 次记失败，第 7 次起 429 */
    let firstSixAllRejected = true;
    for (let i = 0; i < 6; i++) {
      const r = await changePwd(acc.token, 'definitely-wrong-' + i, 'newpw-123456');
      // 第 7 次之前都应该是「原密码不正确」而不是 429
      if (r.status !== 403) firstSixAllRejected = false;
    }
    ok(firstSixAllRejected, '连续 6 次错误旧密码 → 都是 403（还没到阈值）');

    /* 关键：此时**换成正确密码也必须被挡住** —— 限流的意义就在这，
     * 不然攻击者只要在猜中的那一次之前不被拦，就等于没限流。 */
    const blocked = await changePwd(acc.token, acc.password, 'newpw-123456');
    eq(blocked.status, 429, '★ 第 7 次即使旧密码正确也被 429（限流生效）');
    ok(/次数太多/.test(String(blocked.json && blocked.json.error)), '错误信息说明是次数太多',
      JSON.stringify(blocked.json));

    /* 旧密码仍然可用：被限流的只是这个接口，密码没被改掉 */
    const stillValid = await httpJson(PORT, 'POST', '/api/auth/login', { name: acc.name, password: acc.password });
    ok(stillValid.status === 200 || stillValid.status === 429,
      '账号本身没被改坏（密码还是原来那个）', 'status=' + stillValid.status);
  }

  {
    /* 反向：只要中间成功过一次，计数要清零。
     * 否则「白天打错两次、晚上再打错四次」就会在毫无提示的情况下被锁 10 分钟。 */
    const acc = await registerPlayer(PORT, '限流乙');
    await changePwd(acc.token, 'wrong-1', 'x');
    await changePwd(acc.token, 'wrong-2', 'x');

    const good = await changePwd(acc.token, acc.password, 'newpw-abcdef');
    eq(good.status, 200, '打错两次后猜对 → 成功改密码');
    ok(!!(good.json && good.json.token), '返回了新令牌（旧令牌因版本号 +1 全部失效）');

    /* 改完之后用新密码再改一次：证明计数清零了（否则这里会是 429） */
    const again = await changePwd(good.json.token, 'newpw-abcdef', 'newpw-abcdef2');
    eq(again.status, 200, '★ 成功一次后失败计数被清零（不是越积越多）');
  }

  /* ================================================================= */
  console.log('\n[2] 昵称必须唯一（P1-7）');

  const nickA = await registerPlayer(PORT, '小明');
  eq(nickA.nickname, '小明', '第一个「小明」注册成功');

  {
    /* 直接同名 */
    const r = await httpJson(PORT, 'POST', '/api/auth/register', {
      name: 'u' + Math.random().toString(36).slice(2, 9),
      password: 'pw-123456789',
      nickname: '小明'
    });
    eq(r.status, 409, '★ 同名昵称被拒（409）');
    ok(/昵称/.test(String(r.json && r.json.error)), '错误信息指向昵称', JSON.stringify(r.json));
  }

  {
    /* 首尾空白：显示上完全一样，必须算撞名。
     * （英文大小写那一组单独测 —— 混在一个循环里会先把 XiaoMing 注册掉。） */
    const cases = ['小明 ', ' 小明'];
    for (const nick of cases) {
      const r = await httpJson(PORT, 'POST', '/api/auth/register', {
        name: 'u' + Math.random().toString(36).slice(2, 9),
        password: 'pw-123456789',
        nickname: nick
      });
      eq(r.status, 409, '★ 昵称「' + nick + '」被识别为撞名（首尾空白不计）');
    }
  }

  {
    const first = await httpJson(PORT, 'POST', '/api/auth/register', {
      name: 'u' + Math.random().toString(36).slice(2, 9),
      password: 'pw-123456789',
      nickname: 'XiaoMing'
    });
    eq(first.status, 200, '英文昵称 XiaoMing 注册成功');
    const second = await httpJson(PORT, 'POST', '/api/auth/register', {
      name: 'u' + Math.random().toString(36).slice(2, 9),
      password: 'pw-123456789',
      nickname: 'xiaoming'
    });
    eq(second.status, 409, '★ 大小写不同的同一昵称也撞名（榜上看起来一样）');
  }

  {
    const okAcc = await registerPlayer(PORT, '小红');
    eq(okAcc.nickname, '小红', '不同昵称照常注册');
    /* 不填昵称 → 用账号名兜底，这条路径不能被唯一性检查搞挂 */
    const noNick = await httpJson(PORT, 'POST', '/api/auth/register', {
      name: 'noNick' + Math.random().toString(36).slice(2, 7),
      password: 'pw-123456789'
    });
    eq(noNick.status, 200, '不填昵称仍然能注册（默认用账号名）');
  }

  /* ================================================================= */
  console.log('\n[3] Service Worker / manifest 不许被 HTTP 缓存（P1-4）');

  {
    const sw = await httpJson(PORT, 'GET', '/sw.js');
    eq(sw.status, 200, '/sw.js 能取到');
    ok(/no-store/.test(String(sw.headers && sw.headers['cache-control'] || '')),
      '★ /sw.js 是 no-store（发版后立刻拿到新 SW）', sw.headers && sw.headers['cache-control']);

    const mf = await httpJson(PORT, 'GET', '/manifest.webmanifest');
    eq(mf.status, 200, '/manifest.webmanifest 能取到');
    ok(/no-store/.test(String(mf.headers && mf.headers['cache-control'] || '')),
      '★ manifest 也是 no-store（改图标/名字立刻生效）', mf.headers && mf.headers['cache-control']);

    const js = await httpJson(PORT, 'GET', '/js/engine.js');
    eq(js.status, 200, '/js/engine.js 能取到');
    ok(/max-age=3600/.test(String(js.headers && js.headers['cache-control'] || '')),
      '普通静态资源仍然是 1 小时缓存（没有一刀切）', js.headers && js.headers['cache-control']);

    const page = await httpJson(PORT, 'GET', '/');
    ok(/no-store/.test(String(page.headers && page.headers['cache-control'] || '')),
      'index.html 仍然是 no-store', page.headers && page.headers['cache-control']);
  }

  /* ================================================================= */
  console.log('\n[4] 登录耗时不泄露账号是否存在（时间侧信道）');

  {
    /* 文案早就统一成「账号或密码不正确」了，但耗时没统一：
     * 不存在的账号是查一次 Map 就返回（~1ms），存在的账号要跑 scrypt（~60ms）。
     * 于是 time_total 比任何文案都诚实 → 防枚举白做。
     *
     * 断言用**最慢的几次取最小**（min of 3）而不是平均：CI 里的偶发卡顿只会把
     * 某个样本顶高，取最小最稳；两条路本来就该差不多，比例阈值放到 0.5 已经很宽松 ——
     * 修之前这个比值是 0.01 量级，一眼就能分开。 */
    const name = 'timing' + Math.random().toString(36).slice(2, 8);
    const pw = 'pw-123456789';
    const reg = await httpJson(PORT, 'POST', '/api/auth/register', { name: name, password: pw });
    eq(reg.status, 200, '准备一个真实账号');

    async function minMs(times, fn) {
      let best = Infinity;
      for (let i = 0; i < times; i++) {
        const t0 = Date.now();
        await fn();
        const dt = Date.now() - t0;
        if (dt < best) best = dt;
      }
      return best;
    }

    const tExists = await minMs(3, () => httpJson(PORT, 'POST', '/api/auth/login', { name: name, password: pw }));
    const tMissing = await minMs(3, () => httpJson(PORT, 'POST', '/api/auth/login', { name: 'ghost' + Date.now(), password: pw }));

    ok(tMissing >= tExists * 0.5,
      '★ 「账号不存在」的耗时与「账号存在」同量级（不再 1ms vs 60ms）',
      'exists=' + tExists + 'ms missing=' + tMissing + 'ms');
    ok(tExists >= tMissing * 0.5,
      '★ 反向也成立（没有把「存在」那条路意外弄慢）',
      'exists=' + tExists + 'ms missing=' + tMissing + 'ms');
  }

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('========================================');
  server.close();
  process.exit(fail ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
