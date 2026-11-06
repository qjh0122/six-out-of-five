/**
 * 六选五 Service Worker（根路径 scope，静态缓存 + 离线兜底）
 *
 * 缓存策略：
 *  - 导航请求（/ 与页面跳转）：network-first（保证打开最新版，离线回退缓存）
 *  - 脚本/样式（/js/* /css/*）：network-first（改完即生效，无需 bump 版本；
 *    离线回退到忽略 query 的缓存副本，保证断网也能用）
 *  - 静态资源（/icons/* /assets/* /manifest.webmanifest）：cache-first（不常变、省流量）
 *  - /ws（WebSocket）与 /api：不拦截（联机必须在线）
 *
 * CACHE_NAME 每次发布 bump（v1→v2→…），activate 时清理旧缓存。
 */
const CACHE_NAME = 'weile-liuxuanwu-v132';

/* network-first 的超时上限。
 *
 * 原来的写法是 `fetch().then().catch(回落缓存)` —— catch 只在**网络失败**时触发。
 * 弱网下「慢但最终成功」的请求会一直等，页面就是一片白。而这个游戏的主要场景
 * 恰好是「饭桌上扫个链接进来」，饭馆里 4G 拥塞、地铁里信号抖动都很常见，
 * 实测这种环境下 fetch 挂 10-20 秒才开始返回。
 *
 * 所以改成：同时起一个计时器，谁先到听谁的。超时先返回**缓存副本**保证首屏可交互，
 * 同时让原请求继续跑（不 abort），它回来后照常写缓存 —— 下一次打开又是最新的。
 *
 * 两个值的取法：导航是「先让用户看见东西」，4.2 秒；脚本样式是「首屏依赖」，
 * 但缓存里一定有（install 阶段预缓存过），所以可以更激进，2 秒。
 *
 * 导航为什么从 3 秒提到 4.2 秒：线上实测**冷启动**（容器唤醒 / 进程冷启）拿到
 * index.html 首字节要 3.18s，之后 0.4–0.6s。3 秒的阈值恰好卡在这个量级上 ——
 * 服务其实马上就回了，SW 却先抢着给缓存，然后网络回来再刷新一次，
 * 用户看到的是「页面闪一下、内容重排一帧」，最坏还会先看到离线兜底页。
 * 卡在「3.18s 实测值」和「用户开始怀疑卡死」之间取 4.2s：
 * 比实测慢值多 1 秒余量，又没有长到让弱网用户干等。
 * 真正慢到 4 秒还没首字节的网络，给缓存本来就是对的。 */
const NAV_TIMEOUT_MS = 4200;
const ASSET_TIMEOUT_MS = 2000;

/* 访问凭据失效时的兜底页：比浏览器默认的「链接不完整」有用得多 */
const ACCESS_HINT = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<title>需要重新进入</title><style>'
  + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
  + 'background:linear-gradient(160deg,#1E5A44,#0E2A20);color:#FFF7E8;'
  + 'font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;padding:24px}'
  + '.b{max-width:330px;text-align:center}'
  + '.t{font-size:20px;font-weight:700;margin:0 0 14px;color:#F5C15C}'
  + '.d{font-size:14px;line-height:1.8;color:rgba(255,247,232,.72);margin:0}'
  + '</style></head><body><div class="b">'
  + '<p class="t">访问链接已失效</p>'
  + '<p class="d">请让房主重新发一次邀请链接，<br>用新链接打开就能继续玩。</p>'
  /* 已安装到桌面的用户看不到任何「入口」，必须明说怎么办，
   * 否则他们的唯一判断是「这应用坏了」然后删掉。 */
  + '<p class="d" style="margin-top:14px;font-size:12px;opacity:.55">'
  + '已添加到桌面的话，用新链接打开一次，图标会自动恢复。</p>'
  /* 先试着自救，再谈「请找房主」。
   *
   * 桌面图标启动时请求的是 "/"（manifest.start_url），不带 sharecode；
   * 网关只认 30 天的 __wb_rsc cookie，cookie 没了就 403，而拿到 403 的这张页
   * 不是 index.html，index.html 顶部那段「补回 sharecode」的脚本根本不会执行 ——
   * 于是明明 localStorage 里还留着码，用户却只能看到一句「请让房主重发链接」，
   * 而他手里只有一个图标，没有一个能粘链接的地方。
   *
   * 这里补上同一段自救：有码就带着码重新打开一次（顺带刷新网关那 30 天 cookie）。
   * 用 sessionStorage 记一次「已经试过」：万一存的是个过期码，第二轮就别再跳，
   * 老老实实显示这句话 —— 否则就是一个跳不出去的死循环。 */
  + '<script>(function(){try{'
  + 'var KEY="lxw_sharecode_v1",FLAG="lxw_sc_retried";'
  + 'var code=localStorage.getItem(KEY);'
  + 'if(!code)return;'
  + 'try{if(sessionStorage.getItem(FLAG)==="1")return;sessionStorage.setItem(FLAG,"1");}catch(e2){return;}'
  + 'location.replace("/?sharecode="+encodeURIComponent(code));'
  + '}catch(e){}})();</' + 'script>'
  + '</div></body></html>';

/* 部署网关要求**每一个请求**都带 ?sharecode=xxx（连 /api/health 都不例外）。
 * 页面是用 ?sharecode=xxx 打开的，而 SW 的脚本 URL 是 /sw.js —— 它自己拿不到页面上的查询串，
 * 所以 register 时就把查询串接在 SW 脚本地址后面（index.html 里做），这里再从 self.location 取。
 *
 * 这一步是必须的：以前 PRECACHE 里全是裸路径，生产环境每一条都被网关 403，
 * 而 install 里的 `.catch(function(){ return null; })` 把失败全吞了 ——
 * 表现是 SW 装得上、离线却什么都打不开，且没有任何一处日志能看出来。 */
const SHARE_QUERY = (function () {
  try { return new URL(self.location.href).search || ''; } catch (e) { return ''; }
})();
function withShare(u) {
  if (!SHARE_QUERY) return u;
  return u + (u.indexOf('?') >= 0 ? '&' : '?') + SHARE_QUERY.slice(1);
}

const PRECACHE = [
  '/',
  '/index.html',
  '/css/style.css',
  '/css/records.css',
  '/css/emoji.css',
  '/js/engine.js',
  '/js/errorReport.js',
  '/js/card.js',
  '/js/config.js',
/* 表情/短语清单：**前端与服务端共用同一份**。不预缓存的话离线打开面板
 * 会显示「表情没加载出来」，而这个清单本身只有几 KB。 */
  '/js/emoji.js',
/* 成就：stateMachine 结算时调 Ach.accumulate() 采集，**必须排在它前面**。
 * 不预缓存的话离线打一局，成就静默不记（Ach 是 undefined，代码里有判空兜底，
 * 所以不会报错、也不会崩 —— 只是白打）。这类「不崩但丢数据」的缺失最难发现。 */
  '/js/achievements.js',
  '/js/bestLine.js',
  '/js/stateMachine.js',
/* 存储收口（v111）：**必须**预缓存，而且是**阻塞加载**（index.html head 里没有 defer）。
 * 它 404 的话连「分享码自愈」和首帧会话判断都会失效 —— 桌面图标打开时的兜底路径
 * 正好就依赖它，而那条路径只有真实安装用户会走到，本地探针很难覆盖。 */
  '/js/storage.js',
  '/js/authStore.js',
  '/js/roomStore.js',
/* 统计口径（v111 收口）：records.js 与 server/profile.js 共用一份。
 * 它 404 的话 records.js 加载后第一次算统计就抛 —— 战绩页整页空，
 * 而且因为是 deferred 脚本，控制台里只有一条与「战绩」看起来无关的错。 */
  '/js/stats.js',
  '/js/records.js',
/* 场次档案（整场回放的数据源）。它不预缓存不会崩 —— game.js 每个调用点都用
 * typeof 判断兜底 —— 但离线时会静默退化成「只能看单把」，
 * 而整场回放正是这个模块的核心功能。所以必须在这里。 */
  '/js/sessionLog.js',
  '/js/sfx.js',
  '/js/slotLayout.js',
  /* 头像预设：离线时缺它整个座位会退成「昵称首字」，不算致命，
   * 但 48 款头像本来就是靠它现场生成 SVG 的（没有图片文件要下载）。 */
  '/js/avatar.js',
  /* 座位环几何：离线时如果它是 404，顶栏会退成「没有座位的空桌」——
   * 比缺一个统计脚本严重得多（玩家看不到任何对手）。 */
  '/js/ringGate.js',
  '/js/seatRing.js',
/* ★ v108 拆出来的 8 个模块。全部**必须**预缓存：
 * game.js 是同步 IIFE，开头就 `window.LXW.utils` 取工具函数 ——
 * 任何一个 404，整页白屏（不是降级，是 ReferenceError）。
 * 顺序与 index.html 保持一致，方便对读。 */
  '/js/gameUtils.js',
  '/js/cardView.js',
  '/js/modalKit.js',
  '/js/nextRoundHints.js',
  '/js/historyKit.js',
  '/js/accountView.js',
  '/js/settleView.js',
  '/js/seatSheetView.js',
  '/js/recordsView.js',
  '/js/achievementsView.js',
  '/js/game.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
/* 13 张表情（共约 190 KB）：**预缓存**而不是「用到再缓存」。
 * 表情面板第一次打开时如果断网，按需缓存就是 13 个碎图 —— 那比不显示更难看；
 * 而玩家开面板往往正是在「没网/网差」的时候。 */
  '/assets/emoji/e0-dizzy.png',
  '/assets/emoji/e1-devil.png',
  '/assets/emoji/e10-rage.png',
  '/assets/emoji/e11-shock.png',
  '/assets/emoji/e12-grit.png',
  '/assets/emoji/e2-money.png',
  '/assets/emoji/e3-confused.png',
  '/assets/emoji/e4-love.png',
  '/assets/emoji/e5-cry.png',
  '/assets/emoji/e6-grin.png',
  '/assets/emoji/e7-angry.png',
  '/assets/emoji/e8-smug.png',
  '/assets/emoji/e9-sweat.png',
  '/assets/home_bg.webp',
  '/assets/table_bg.webp',
  '/assets/card_back.webp',
  '/assets/audio/sfx_deal.mp3',
  '/assets/audio/sfx_select.mp3',
  '/assets/audio/sfx_submit.mp3',
  '/assets/audio/sfx_win.mp3',
  '/assets/audio/sfx_settle.mp3'
  // 注意：bgm_room_loop.mp3 不进 PRECACHE —— BGM 是懒加载（首次手势解锁后才创建 Audio），
  // 预缓存它等于首屏白白下载 155KB 循环背景乐。首次播放时走 cache-first 分支照样会缓存。
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) {
        /* 逐个容错 add：单个资源 404 不能整个 install 失败，否则连 SW 都装不上。
         * 但**失败必须留下痕迹** —— 之前这里是 `.catch(() => null)`，
         * 生产上 30 个资源集体 403 也一声不响，离线能力等于零而没人知道。
         * 现在收集失败项：控制台打一条带 URL 清单的警告，并挂到 self 上供诊断页读取。 */
        return Promise.all(PRECACHE.map(function (u) {
          var url = withShare(u);
          return cache.add(url).then(function () { return null; })
            .catch(function (e) { return { url: url, err: (e && e.message) || 'failed' }; });
        })).then(function (results) {
          var failed = results.filter(Boolean);
          self.__precacheReport = {
            total: PRECACHE.length,
            failed: failed.length,
            detail: failed,
            sharecode: !!SHARE_QUERY,
            at: Date.now()
          };
          if (failed.length) {
            /* 一条警告说清楚：多数情况是 sharecode 没带上（全部失败）或个别资源改名 */
            console.warn('[sw] 预缓存失败 ' + failed.length + '/' + PRECACHE.length
              + ' 条' + (SHARE_QUERY ? '' : '（本次未带 sharecode，生产网关会全部 403）') + '：');
            failed.forEach(function (f) { console.warn('  - ' + f.url + '  ' + f.err); });
          }
        });
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE_NAME; }).map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

/* network-first + 超时兜底。
 * 返回 Promise<Response | null>：null 表示「超时或失败」，由调用方回落缓存。
 *
 * 两个刻意的细节：
 *
 * 1. **clone 必须在 then 里立刻做，且在把 res 交给页面之前。**
 *    Response 的 body 只能被读一次，等页面消费过再 clone 会直接抛。
 * 2. **超时后不 abort。** 原请求继续跑，拿到 ok 响应照样写缓存 ——
 *    这正是「首屏快」和「下次打开是新的」能同时成立的原因。
 *    如果 abort 掉，下次打开还是旧缓存，改完代码不生效的锅又回来了。
 */
function networkFirst(req, timeoutMs) {
  const netP = fetch(req).then(function (res) {
    if (!res) return null;
    /* 网关鉴权失败（分享凭据失效）：给一句能看懂的话，别把 403 页面直接丢给玩家。
     * 只对导航做这个替换——脚本/样式拿到 403 时若返回 HTML，
     * 浏览器会把 HTML 当 JS 执行，报一堆语法错，比原来的 403 更难查。 */
    if (res.status === 403 && req.mode === 'navigate') {
      return new Response(ACCESS_HINT, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }
    if (res.ok) {
      try {
        const copy = res.clone();
        caches.open(CACHE_NAME)
          .then(function (c) { return c.put(req, copy); })
          .catch(function () { /* 配额满 / 隐私模式禁用缓存：不该影响页面 */ });
      } catch (e) { /* body 已被消费过，这一份就不缓存了 */ }
    }
    return res;
  }, function () { return null; });

  const timeoutP = new Promise(function (resolve) {
    setTimeout(function () { resolve(null); }, timeoutMs);
  });

  return Promise.race([netP, timeoutP]);
}

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // WebSocket / REST 不走 SW（本游戏无 REST，联机必须在线）
  if (url.pathname.startsWith('/ws') || url.pathname.startsWith('/api')) return;

  const isJsCss = /^\/(js|css)\//.test(url.pathname);
  const isCacheFirst = /^\/(icons|assets)\//.test(url.pathname) || url.pathname === '/manifest.webmanifest';

  if (req.mode === 'navigate') {
    // 导航：network-first + 超时兜底（3 秒没回来先给缓存，离线也能打开）
    event.respondWith(networkFirst(req, NAV_TIMEOUT_MS).then(function (res) {
      if (res) return res;
      /* 离线 / 超时兜底：缓存键里现在带着 sharecode（见 PRECACHE 的说明），
       * 查询串一变就匹配不上，所以一律 ignoreSearch。 */
      return caches.match(req, { ignoreSearch: true })
        .then(function (r) { return r || caches.match('/index.html', { ignoreSearch: true }); })
        .then(function (r) { return r || Response.error(); });
    }));
    return;
  }

  if (isJsCss) {
    // 脚本/样式：network-first（改完即生效，无需 bump 版本）+ 超时兜底
    event.respondWith(networkFirst(req, ASSET_TIMEOUT_MS).then(function (res) {
      if (res) return res;
      return caches.match(req, { ignoreSearch: true })
        .then(function (r) { return r || caches.match(req); })
        .then(function (r) { return r || Response.error(); });
    }));
    return;
  }

  if (isCacheFirst) {
    // 静态资源（图标/图片/音频/manifest）：cache-first（不常变、省流量）
    /* ignoreSearch 与另外两条分支保持一致：缓存键里带着 ?sharecode=xxx
     *（PRECACHE 用的就是 withShare），凭据一换、或者用户从另一条链接进来，
     * 查询串不同就匹配不上 —— 图标和牌桌背景会在有网的情况下也重新下一遍。
     * 这些文件的内容与查询串无关，忽略它才是对的。 */
    event.respondWith(
      caches.match(req, { ignoreSearch: true }).then(function (cached) {
        if (cached) return cached;
        return fetch(req).then(function (res) {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then(function (c) { c.put(req, copy); });
          }
          return res;
        });
      })
    );
  }
});
