/**
 * 六选五 服务端入口
 *
 * 单一端口同时提供：
 *   GET  /...        前端静态资源（复用 pwa/ 目录，前后端同源，WS 才能直连）
 *   WS   /ws         对局长连接
 *   GET  /api/health 健康检查（部署探活用）
 *
 * 部署要求：监听 process.env.PORT，绑定 0.0.0.0。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('./ws');
const { ProfileStore } = require('./profile');
const { AvatarStore, MAX_BYTES: AVATAR_MAX_BYTES } = require('./avatars');
const { Hub } = require('./hub');
const auth = require('./auth');
const { cleanNickname } = require('./text');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const STATIC_ROOT = path.join(__dirname, '..', 'pwa');

/* --------------------------- 响应压缩 ---------------------------
 * 之前所有静态文件都是裸传：线上实测 /js/game.js 的 Content-Length 是 144701，
 * 首屏十几个 JS + 2 个 CSS（当时是 11 个 JS）合计约 330KB。弱网下这是 2 秒和 0.6 秒的差别，
 * 而这个游戏的主要场景就是「饭桌上扫个链接进来」，网络很可能很差。
 *
 * 几个刻意的取舍：
 *  - 只压文本类。webp / mp3 本来就压过了，再 gzip 是白烧 CPU，有时还会变大。
 *  - 太小的不压（< 1KB），gzip 头 + 尾部校验会让它反而更大。
 *  - 压完比原文件大就放弃（高熵内容会这样），别为了「有 compression」硬塞。
 *  - 结果按「路径 + mtime + size」缓存，同一个版本只压一次；文件一改缓存自动失效。
 *  - level 6 不是 9：9 级只多省 2-3% 体积，但首屏十几个文件同时压会明显占用事件循环。
 */
const zlib = require('zlib');
const COMPRESSIBLE_RE = /\.(html|css|js|mjs|json|webmanifest|svg|txt|map)$/i;
const GZIP_MIN_BYTES = 1024;
const GZIP_LEVEL = 6;
const GZIP_CACHE_MAX = 96;           // 静态文件就那么几十个，96 足够且不会无限涨
const _gzipCache = new Map();        // filePath -> { mtimeMs, size, buf }

function gzipFor(filePath, stat) {
  const hit = _gzipCache.get(filePath);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.buf;
  let raw;
  try { raw = fs.readFileSync(filePath); } catch (e) { return null; }
  let gz;
  try { gz = zlib.gzipSync(raw, { level: GZIP_LEVEL }); } catch (e) { return null; }
  if (!gz || gz.length >= raw.length) return null;
  // 超上限就整表清空：静态资源数量有限，重建比做 LRU 划算
  if (_gzipCache.size >= GZIP_CACHE_MAX) _gzipCache.clear();
  _gzipCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, buf: gz });
  return gz;
}

/* 只认 gzip：br 需要 Node 的 brotli，压一级文件更慢，收益在这个体量上不明显。
 * q=0 表示客户端明确拒绝，虽然少见但得认。 */
function acceptsGzip(req) {
  const ae = String((req.headers && req.headers['accept-encoding']) || '');
  if (!/\bgzip\b/i.test(ae)) return false;
  return !/\bgzip\s*;\s*q=0\b/i.test(ae);
}


const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2'
};

/* 文件名命中这些就一律 no-store（见 sendFile 里的说明）。
 * 用 basename 匹配而不是全路径，是为了让 `pwa/sw.js` 和 `/sw.js` 两种写法都命中。 */
const SW_NO_CACHE_RE = /^(sw\.js|manifest\.webmanifest)$/;

function log() {
  const args = Array.prototype.slice.call(arguments);
  args.unshift(new Date().toISOString());
  console.log.apply(console, args);
}

// PROFILE_FILE 允许测试指向临时文件，避免测试数据污染生产档案
const profiles = new ProfileStore(Object.assign(
  process.env.PROFILE_FILE ? { file: process.env.PROFILE_FILE } : {},
  // 档案层要能把「主文件损坏、已改名留档」这类事说出口，否则只是静默回退种子
  { log: log }
));

/* 头像照片存储（P1b，默认关闭）。目录跟着 DATA_DIR 走，备份时和 profiles.json
 * 一起搬就够 —— 图片本体不进 JSON（一份档案几十 KB 会把档案文件撑到没法读）。 */
const avatars = new AvatarStore({
  dir: process.env.AVATAR_DIR || undefined,
  log: log
});

/* 备份导出密钥：?full=1 会吐出全部玩家档案（含近 20 场流水），
 * 不能裸奔给外网。密钥放在 server/ 目录里——pwa 才是静态根，
 * server/ 下的文件外网取不到，所以这个文件本身就是秘密。
 * 也可用 BACKUP_KEY 环境变量覆盖（测试用）。 */
const BACKUP_KEY_FILE = path.join(__dirname, 'backup-key.txt');

function readBackupKey() {
  if (process.env.BACKUP_KEY) return String(process.env.BACKUP_KEY).trim();
  try { return fs.readFileSync(BACKUP_KEY_FILE, 'utf8').trim(); } catch (e) { return ''; }
}

/* 定长比较：长度先对齐，再逐字节比，避免用 === 比密钥带来的时序差异 */
function sameSecret(given, expected) {
  const a = String(given == null ? '' : given);
  const b = String(expected == null ? '' : expected);
  if (!a || !b || a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch (e) { return false; }
}
/* 令牌签名密钥。**放数据目录**（项目外）：放项目里的话，每次部署都会被新代码的
 * 密钥覆盖，全员登录态失效。数据目录跨版本存活，进程重启也认旧令牌。 */
const AUTH_SECRET_FILE = path.join(path.dirname(profiles.file), 'auth-secret.txt');
const AUTH_SECRET = auth.loadSecret(AUTH_SECRET_FILE);

/* WS 的身份解析器：连接上来的 auth 消息带登录令牌，这里换成 playerId。
 * Hub 内部不碰签名逻辑，只依赖这个函数——职责分明，也方便单测替换。 */
const hub = new Hub({
  profiles: profiles,
  log: log,
  /* 房间快照放在数据目录（项目外），和 profiles.json 同一个位置：
   * 部署覆盖代码时它不会被动到，重启后正在进行的对局能捞回来（P2-3）。
   *
   * ★ 用 PROFILE_FILE 指档案时**默认不落盘**：那种用法几乎全是测试，
   *   而它们的档案文件通常就放在系统临时目录里 —— 快照会落在同一个 tmp 目录、
   *   跨测试跑累积。第一版没设这个开关，e2e 立刻红了一条「房间已全部回收 →
   *   还是 3 间」：它捡到了上一次跑剩下的桌子。要开就显式给 ROOMS_STATE_FILE。 */
  statePath: process.env.ROOMS_STATE_FILE
    || (process.env.PROFILE_FILE ? '' : path.join(path.dirname(profiles.file), 'rooms-state.json')),
  resolveToken: function (token) {
    const payload = auth.verifyToken(token, AUTH_SECRET);
    if (!payload) return '';
    const pid = String(payload.pid);
    /* WebSocket 这条链路也必须查令牌版本：否则「改密码踢下线」只对 HTTP 生效，
     * 别人拿着旧令牌照样能通过 ws 占用你的座位。 */
    return tokenAlive(pid, payload) ? pid : '';
  }
});

/* ---------------------------- 账号 / 登录 ---------------------------- */

/** 读 JSON 请求体。有上限：不能让一个请求把内存撑爆 */
const BODY_MAX = 16 * 1024;
function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    req.on('data', (c) => {
      size += c.length;
      /* 超限就停止收集，但**不掐连接**。
       * 以前这里是 `req.destroy()`，客户端只会看到 ECONNRESET、拿不到任何状态码；
       * 上游若有重试逻辑，会拿同一个大包反复重发（永远失败、永远重试）。
       * 现在返回 null 由调用方回 400，至少客户端能看到一句人话。
       * 继续保留 data 监听器是为了把剩余字节读走，否则它们会堆在 socket 里。 */
      if (size > BODY_MAX) { chunks.length = 0; finish(null); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return finish({});
      try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { finish(null); }
    });
    req.on('error', () => finish(null));
  });
}

/* 读原始二进制（头像上传用）。为什么不复用 readJsonBody：
 * 那个的硬上限是 16KB（JSON 接口的体积基线），而一张 256×256 的 JPEG 是 12~20KB，
 * base64 之后还要再涨 1/3。这里给独立的、更大的上限，并且**不做 JSON 解析**。 */
function readRawBody(req, max) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { chunks.length = 0; finish({ tooLarge: true }); return; }
      chunks.push(c);
    });
    req.on('end', () => finish({ buf: Buffer.concat(chunks) }));
    req.on('error', () => finish(null));
  });
}

function sendJson(res, code, obj) {
  let body;
  try { body = Buffer.from(JSON.stringify(obj), 'utf8'); } catch (e) { body = Buffer.from('{"ok":false}'); }
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Vary': 'Accept-Encoding'
  };
  /* res.req 是 Node 给 ServerResponse 挂的原始请求引用，不必改这个函数几十处调用点的签名。
   * 只对体积过阈值的响应压缩：普通的 {ok:true} 只有二十几个字节，
   * 加 gzip 头反而更大，还白烧一次 CPU。真正受益的是 ?full=1 的全量导出。 */
  const req = res.req;
  if (body.length >= GZIP_MIN_BYTES && req && acceptsGzip(req)) {
    try {
      const gz = zlib.gzipSync(body, { level: GZIP_LEVEL });
      if (gz.length < body.length) {
        headers['Content-Encoding'] = 'gzip';
        headers['Content-Length'] = gz.length;
        res.writeHead(code, headers);
        res.end(gz);
        return;
      }
    } catch (e) { /* 压不了就老老实实发原文，绝不让压缩成为失败点 */ }
  }
  headers['Content-Length'] = body.length;
  res.writeHead(code, headers);
  res.end(body);
}

/**
 * 取登录令牌。
 *
 * 首选自定义头 `X-Session-Token`，而不是 `Authorization: Bearer`——线上实测：
 * 部署网关会把 Authorization 当自己的鉴权头消费掉，后端收不到（同一枚令牌
 * 走 WebSocket 消息体却认证成功，可见签名没问题，纯粹是头被拦了）。
 * `x-backup-key` 这类自定义头能正常透传，所以改用自定义头。
 *
 * Authorization 仍保留解析，方便 curl / 老客户端调试，但线上不依赖它。
 */
function bearerToken(req) {
  const custom = String(req.headers['x-session-token'] || '').trim();
  if (custom) return custom;
  const h = String(req.headers.authorization || '');
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : '';
}

/**
 * 解析令牌 → payload（含 iat/exp）。失效返回 null。
 * 需要判断「要不要续期」的地方用这个，只要身份就用 authPlayerId()。
 */
function authPayload(req) {
  return auth.verifyToken(bearerToken(req), AUTH_SECRET);
}

/**
 * 令牌除了「签名对、没过期」之外，还要满足三条活性条件。
 *
 * 这三条以前是散在各接口里各查一半的：改密码接口查了账号是否存在，
 * 其它接口基本只靠验签。结果是**改密码 / 被停用 / 账号被删之后，
 * 旧令牌在 90 天有效期内仍然畅通无阻**——改密码根本没有把人踢下线。
 * 收拢到一处，任何入口（HTTP 与 ws）都不可能漏掉。
 */
function tokenAlive(playerId, payload) {
  const pid = String(playerId || '');
  if (!pid) return false;
  const acct = profiles.accountOf(pid);
  if (!acct) return false;                        // 账号已删除
  if (acct.disabled) return false;                // 已被停用
  return auth.tokenVersionOk(payload, profiles.tokenVersion(pid));
}

/**
 * 解析令牌 → playerId。返回 null 表示未登录/已失效。
 * 所有需要「我是谁」的请求都走这里，绝不看请求体里的 playerId。
 */
function authPlayerId(req) {
  const payload = authPayload(req);
  if (!payload) return null;
  const pid = String(payload.pid);
  return tokenAlive(pid, payload) ? pid : null;
}

/* 登录限流：同一「账号名 + IP」连续失败太多次就冷静一会儿。
 * 内存实现，进程重启即清零——挡的是脚本暴力猜密码，不是持久封禁。 */
const LOGIN_FAIL_MAX = 6;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const loginFails = new Map();

function loginKey(name, ip) {
  return String(name || '').trim().toLowerCase() + '@' + String(ip || '');
}
function loginBlocked(name, ip) {
  const rec = loginFails.get(loginKey(name, ip));
  if (!rec) return 0;
  if (Date.now() > rec.until) { loginFails.delete(loginKey(name, ip)); return 0; }
  return rec.count >= LOGIN_FAIL_MAX ? Math.ceil((rec.until - Date.now()) / 1000) : 0;
}
function noteLoginFail(name, ip) {
  const k = loginKey(name, ip);
  const now = Date.now();
  const rec = loginFails.get(k);
  if (!rec || now > rec.until) {
    loginFails.set(k, { count: 1, until: now + LOGIN_WINDOW_MS });
    return;
  }
  rec.count += 1;
  rec.until = now + LOGIN_WINDOW_MS; // 持续尝试就持续延长
}
function clearLoginFails(name, ip) {
  loginFails.delete(loginKey(name, ip));
}

/* 纯 IP 维度的总闸（P2-10）。
 * 只按「账号名 + IP」计数有两个漏洞：
 *   ① 攻击者换 IP → 同一账号的失败次数清零，按账号锁根本锁不住；
 *   ② 同一 IP 换着账号名试（撞库）→ 每个账号各自独立计数，总量不受限。
 * 所以再加一层「这个 IP 总共失败了多少次」，两层同时生效。
 * 阈值比单账号宽（一个办公室/网吧共用出口 IP 是常态），只挡脚本。 */
const LOGIN_IP_MAX = Number(process.env.LOGIN_IP_MAX) || 30;
const loginIpFails = new Map();

function loginIpBlocked(ip) {
  const k = String(ip || '');
  const rec = loginIpFails.get(k);
  if (!rec) return 0;
  if (Date.now() > rec.until) { loginIpFails.delete(k); return 0; }
  return rec.count >= LOGIN_IP_MAX ? Math.ceil((rec.until - Date.now()) / 1000) : 0;
}
function noteLoginIpFail(ip) {
  const k = String(ip || '');
  if (!k) return;
  const now = Date.now();
  const rec = loginIpFails.get(k);
  if (!rec || now > rec.until) { loginIpFails.set(k, { count: 1, until: now + LOGIN_WINDOW_MS }); return; }
  rec.count += 1;
  rec.until = now + LOGIN_WINDOW_MS;
}
function clearLoginIpFails(ip) {
  loginIpFails.delete(String(ip || ''));
}

/* 注册限流：每次注册都要跑一次 scrypt（~60ms CPU），不限流就是一条
 * 「用一条命令把 CPU 打满」的廉价路径。按 IP 计，10 分钟 10 个号：
 * 熟人局一个人顶多注册几个，脚本则刷不动。 */
const REG_MAX = Number(process.env.REG_MAX) || 12;
const REG_WINDOW_MS = 10 * 60 * 1000;
const regHits = new Map();

function regBlocked(ip) {
  const rec = regHits.get(String(ip || ''));
  if (!rec) return false;
  if (Date.now() > rec.until) { regHits.delete(String(ip || '')); return false; }
  return rec.count >= REG_MAX;
}
function noteReg(ip) {
  const k = String(ip || '');
  const now = Date.now();
  const rec = regHits.get(k);
  if (!rec || now > rec.until) { regHits.set(k, { count: 1, until: now + REG_WINDOW_MS }); return; }
  rec.count += 1;
  rec.until = now + REG_WINDOW_MS;
}
/* 两张限流表都是纯内存、只增不减，长期跑会慢慢堆积。
 * 每 10 分钟扫一次过期项，成本可忽略。 */
setInterval(function () {
  const now = Date.now();
  loginFails.forEach(function (v, k) { if (now > v.until) loginFails.delete(k); });
  loginIpFails.forEach(function (v, k) { if (now > v.until) loginIpFails.delete(k); });
  regHits.forEach(function (v, k) { if (now > v.until) regHits.delete(k); });
}, 10 * 60 * 1000).unref();

/** 登录/注册成功后统一的响应体：令牌 + 我是谁 + 我的档案 */
function sessionPayload(playerId) {
  return {
    ok: true,
    token: auth.signToken(playerId, AUTH_SECRET, { tv: profiles.tokenVersion(playerId) }),
    me: {
      playerId: playerId,
      nickname: (profiles.get(playerId) || {}).nickname || '',
      account: profiles.accountOf(playerId)
    }
  };
}

/* 版本标识：运维要能用一次请求确认「线上跑的是哪一版」。
 *
 * 以前 /api/health 只读 `process.env.APP_VERSION`，而部署从来没设过这个变量，
 * 于是线上永远返回 `{"version":"dev"}`——前端明明有 `meta[name=app-version]`，
 * 两者却毫无关联，「线上是哪一版」只能靠猜。
 *
 * 现在三层兜底：环境变量 → 静态包自报的 app-version → dev；
 * 并且把 pwa/index.html 里的 app-version 一并读出来（静态资源那一版），
 * 启动时读一次即可（部署必然重启，不存在热更新）。
 *
 * 三个版本号各有各的用处，**不要混**：
 *   version  对外宣称的应用版本（env → meta → dev）
 *   pwa      磁盘上 pwa/index.html 自报的版本  → 静态资源到没到位
 *   server   服务端代码的构建戳（server/*.js 最新 mtime）→ 服务端代码到没到位
 *   uptime   进程已运行秒数 → 进程到底重启过没有
 *
 * 为什么不再拿 `pkg-` + package.json.version 当兜底：package.json 的 version
 * 从 0.2.0 起就没有跟着发版走过，线上会永远报 `pkg-0.2.0`。
 * 这比返回 `dev` 更糟——它**长得就像一个版本号**，没人会怀疑，
 * 「这次发布生效了吗」这个检查于是彻底失效。改成构建戳之后不需要任何纪律：
 * 只要服务端代码变了，mtime 必然变。 */
function readAppVersion() {
  const fromEnv = String(process.env.APP_VERSION || '').trim();
  if (fromEnv) return fromEnv;
  const pwa = readPwaVersion();
  if (pwa) return pwa;
  return 'dev';
}
/* 服务端构建戳：server 目录下所有 .js 里最新的 mtime。
 * 显式排除本进程之外的噪声没必要——这些文件变了就意味着代码变了。 */
function readServerStamp() {
  try {
    const dir = __dirname;
    let latest = 0;
    fs.readdirSync(dir).forEach((f) => {
      if (!/\.js$/.test(f)) return;
      const st = fs.statSync(path.join(dir, f));
      if (st.mtimeMs > latest) latest = st.mtimeMs;
    });
    return latest ? new Date(latest).toISOString() : '';
  } catch (e) { return ''; }
}
function readPwaVersion() {
  try {
    const html = fs.readFileSync(path.join(STATIC_ROOT, 'index.html'), 'utf8');
    const m = /<meta[^>]+name=["']app-version["'][^>]*content=["']([^"']+)["']/i.exec(html);
    if (m) return m[1];
    const m2 = /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']app-version["']/i.exec(html);
    return m2 ? m2[1] : '';
  } catch (e) { return ''; }
}
const APP_VERSION = readAppVersion();
const PWA_VERSION = readPwaVersion();
const SERVER_STAMP = readServerStamp();

/* ---------------------------- 静态资源 ---------------------------- */

function sendFile(res, filePath, req) {
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const isHtml = ext === '.html';
  /* 绝对不能长缓存的静态资源：
   *   · index.html —— 版本自检与 SW 更新都依赖拿到最新页面；
   *   · sw.js      —— Service Worker **主脚本**。Chrome 更新 SW 时默认绕开 HTTP 缓存，
   *                   但 Safari / 旧版 WebView 不保证；一旦被 `max-age=3600` 缓存住，
   *                   发版后最长 1 小时才拿到新 SW，而 index.html 里那句「发现新版本」
   *                   又会让人反复刷新也没反应，看起来就像坏掉了。
   *                   按规范 SW 脚本最多只能缓存 24 小时，稳妥做法是直接 no-store；
   *   · manifest.webmanifest —— 改图标/名字后同样的道理，缓存住就换不掉。 */
  const noStore = isHtml || SW_NO_CACHE_RE.test(path.basename(filePath).toLowerCase());

  let stat;
  try { stat = fs.statSync(filePath); } catch (e) { return notFound(res); }
  if (stat.isDirectory()) return notFound(res);

  const headers = {
    'Content-Type': type,
    'Cache-Control': noStore ? 'no-store, must-revalidate' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    /* Vary 必须带。同一个 URL 会因 Accept-Encoding 返回两种字节，
     * 中间只要有一层缓存没按这个字段区分，就会把 gzip 流塞给不支持的客户端。 */
    'Vary': 'Accept-Encoding'
  };

  let gz = null;
  if (COMPRESSIBLE_RE.test(ext) && stat.size >= GZIP_MIN_BYTES && acceptsGzip(req)) {
    gz = gzipFor(filePath, stat);
  }

  if (gz) {
    headers['Content-Encoding'] = 'gzip';
    /* Content-Length 必须是**压缩后**的长度。写原始长度会让浏览器按原长
     * 等数据，直接卡住或解析出错——压缩实现里最容易踩的一处。 */
    headers['Content-Length'] = gz.length;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    res.end(gz);   // Buffer 一次发完，比再包一层 stream 更省
    return;
  }

  headers['Content-Length'] = stat.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => { try { res.destroy(); } catch (e) {} });
  stream.pipe(res);
}

/* manifest 里单张图标的内联上限。超过就不内联（退回带码路径，或原样），
 * 免得将来有人放一张 2MB 的图进来，把每次页面加载都拖成几百 KB。
 * 现在这四张合计 33KB，base64 后 43KB —— 值得。 */
const MANIFEST_ICON_MAX_BYTES = 256 * 1024;

/* absPath -> data URI（读不出来记 null）。图标是构建产物、运行时不变，
 * 缓存它可以让 manifest 每次请求都不用重新读盘 + base64。 */
const _iconDataUriCache = new Map();

function iconDataUri(absPath) {
  if (_iconDataUriCache.has(absPath)) return _iconDataUriCache.get(absPath);
  let uri = null;
  try {
    const st = fs.statSync(absPath);
    if (st.isFile() && st.size > 0 && st.size <= MANIFEST_ICON_MAX_BYTES) {
      const mime = MIME[path.extname(absPath).toLowerCase()] || 'application/octet-stream';
      uri = 'data:' + mime + ';base64,' + fs.readFileSync(absPath).toString('base64');
    }
  } catch (e) { uri = null; }
  _iconDataUriCache.set(absPath, uri);
  return uri;
}

/**
 * 返回改写过的 manifest：图标内联成 data URI。
 *
 * 为什么必须改写：manifest 里的 icons[].src 是**浏览器自己**逐条抓的，路径是字面量。
 * 而部署网关要求每个请求都带 ?sharecode=，于是这些图全部 403 —— manifest 本身
 * 200 了也没用，表现是「安卓装不出 WebAPK、iOS 加到桌面后图标是页面截图」。
 *
 * 为什么是内联，而不是「给图标 URL 拼上 sharecode」：
 * 先试过拼 query，部署上线后实测**没生效** —— 网关会校验 sharecode，但转发给应用时
 * 把 query 剥掉了，服务端 `queryParam(req.url,'sharecode')` 永远是空。这条路走不通。
 *
 * data URI 则完全不需要网络请求，天然绕开网关。实测（Edge + Page.getAppManifest）
 * 浏览器接受 data URI 图标，且 `Page.getInstallabilityErrors` 为空 —— 是真能装，
 * 不是「解析通过」而已。
 *
 * screenshots **从响应里去掉**：它们是安装弹窗里的展示图，两张 webp 内联后约 150KB，
 * 而浏览器每次加载页面都会抓一次 manifest —— 这个代价换一张装饰图不划算。
 * 留着更糟：它们的 URL 同样拼不上码，只会稳定 403。
 *
 * start_url / id **故意不动**：start_url 会被固化进安装包，而码是会轮换的。
 * 写死旧码之后，桌面启动带着旧码进来，index.html 那段「有 cur 就存 localStorage」
 * 又把新码覆盖回旧的 —— 反而把「轮换后自愈」这条链打断。保持 "/"。
 *
 * 页面那头还有一半：<link rel="manifest"> 与 apple-touch-icon 的 href 是页面注入的
 * （见 index.html head）。只改一处的话，要么 manifest 抓不到，要么抓到了图还是 403。
 */
function sendManifest(res, filePath, req) {
  let raw;
  try { raw = fs.readFileSync(filePath); } catch (e) { return notFound(res); }

  let body = raw;
  let doc = null;
  try { doc = JSON.parse(raw.toString('utf8')); } catch (e) { doc = null; }
  /* 解析失败就原样发：宁可少一次改写，也不能因为一份格式坏掉的 manifest
   * 让整个安装能力消失（浏览器那边至少还能读到语法错误的原因）。 */
  if (doc) {
    const code = queryParam(req.url, 'sharecode');
    if (Array.isArray(doc.icons)) {
      doc.icons = doc.icons.map((item) => {
        if (!item || typeof item.src !== 'string') return item;
        const u = item.src;
        if (u.charAt(0) !== '/') return item;      // 外链 / 已经是 data URI：不动
        const abs = resolveStatic(u);
        const uri = abs ? iconDataUri(abs) : null;
        if (uri) return Object.assign({}, item, { src: uri });
        /* 内联失败（文件缺失 / 超限）时退回拼 query。
         * 部署网关会剥掉 query，所以这一层在本平台基本没用 —— 但本地与
         * 将来可能换的网关上是有效的，而且不会比不拼更糟。 */
        return code
          ? Object.assign({}, item, { src: u + (u.indexOf('?') >= 0 ? '&' : '?') + 'sharecode=' + encodeURIComponent(code) })
          : item;
      });
    }
    if (doc.screenshots) delete doc.screenshots;
    body = Buffer.from(JSON.stringify(doc, null, 2) + '\n', 'utf8');
  }

  const headers = {
    'Content-Type': 'application/manifest+json; charset=utf-8',
    /* 和 sendFile 里那条一致：manifest 必须 no-store，否则改完名字/图标换不掉 */
    'Cache-Control': 'no-store, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
    'Vary': 'Accept-Encoding'
  };

  let out = body;
  if (body.length >= GZIP_MIN_BYTES && acceptsGzip(req)) {
    try {
      out = zlib.gzipSync(body, { level: GZIP_LEVEL });
      headers['Content-Encoding'] = 'gzip';
    } catch (e) { out = body; }   // 压缩失败就发原文，不能因此 500
  }
  headers['Content-Length'] = out.length;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  res.end(out);
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end('404 Not Found');
}

function resolveStatic(urlPath) {
  // 去掉 query，解码后统一成 POSIX 分隔符
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  // 目录式访问补 index.html
  if (p.endsWith('/')) p += 'index.html';

  const abs = path.resolve(STATIC_ROOT, '.' + path.posix.normalize(p));
  // 防路径穿越：解析后必须仍在静态根目录内
  const rootWithSep = STATIC_ROOT.endsWith(path.sep) ? STATIC_ROOT : STATIC_ROOT + path.sep;
  if (abs !== STATIC_ROOT && !abs.startsWith(rootWithSep)) return null;
  return abs;
}

/* 从原始 URL 里取一个查询参数（不引 URL 解析，路径本来就带 ? 前缀判断） */
function queryParam(rawUrl, name) {
  const q = String(rawUrl || '').indexOf('?');
  if (q < 0) return '';
  const parts = String(rawUrl).slice(q + 1).split('&');
  for (let i = 0; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    const k = eq < 0 ? parts[i] : parts[i].slice(0, eq);
    if (decodeURIComponent(k) !== name) continue;
    try { return decodeURIComponent(eq < 0 ? '' : parts[i].slice(eq + 1)); } catch (e) { return ''; }
  }
  return '';
}

/**
 * 请求总入口。
 *
 * 这里必须整体 catch：以前是 `createServer(async (req,res) => ...)`，
 * 处理函数里任何一个同步异常（比如对 null 取属性）都会让 Promise 静默 reject，
 * **响应永远不发出去**——客户端表现为「请求卡死到超时」，排查时又看不到错误。
 * 实测过一次：账号被删后调改密码接口，6 秒超时也没有任何响应。
 */
const server = http.createServer((req, res) => {
  Promise.resolve()
    .then(() => handleRequest(req, res))
    .catch((e) => {
      log('http handler error', req.method, req.url, (e && e.stack ? e.stack.split('\n')[0] : e));
      if (res.headersSent) { try { res.destroy(); } catch (x) { /* 已断开 */ } return; }
      try { sendJson(res, 500, { ok: false, error: '服务异常，请稍后重试' }); } catch (x) { /* 已断开 */ }
    });
});

/** 带 JSON 体的写接口：统一要求 application/json。
 * 挡住「跨站表单 POST 一个 text/plain 但内容是合法 JSON」这条 CSRF 路径——
 * 表单无法伪造 application/json（那是非简单 Content-Type，会被 CORS 预检拦下）。 */
/* ---------------- 前端错误上报的两个辅助 ----------------
 * 截断不只是"防止日志太长"：不剥控制字符的话，一条精心构造的 message
 * 能在日志里伪造出整行记录（换行注入）。所以除 keepNewline 外一律换成空格。
 */
const CLIENT_ERR_MAX = 40;
const CLIENT_ERR_WINDOW_MS = 60000;
const _clientErrHits = new Map();   // ip -> { count, resetAt }

function clipText(v, max, keepNewline) {
  let s = String(v == null ? '' : v);
  s = keepNewline
    ? s.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')   // 留 \n（stack 要缩进后读）
    : s.replace(/[\u0000-\u001f\u007f]/g, ' ');
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function noteClientErr(ip) {
  const now = Date.now();
  let slot = _clientErrHits.get(ip);
  if (!slot || now > slot.resetAt) {
    slot = { count: 0, resetAt: now + CLIENT_ERR_WINDOW_MS };
    _clientErrHits.set(ip, slot);
  }
  slot.count++;
  // Map 不能无限涨：超过 500 个来源就顺手清一遍过期的
  if (_clientErrHits.size > 500) {
    for (const [k, v] of _clientErrHits) {
      if (now > v.resetAt) _clientErrHits.delete(k);
    }
  }
  return slot.count <= CLIENT_ERR_MAX;
}

function requireJson(req, res) {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (ct.indexOf('application/json') === 0) return true;
  sendJson(res, 415, { ok: false, error: '请求必须使用 application/json' });
  return false;
}

async function handleRequest(req, res) {

  const urlPath = req.url || '/';
  /* ---------------- 前端错误上报（P3-5） ----------------
   * 线上玩家 JS 抛异常，服务端此前毫无感知。PWA 让这件事更糟：SW 缓存了旧版 JS 时，
   * 错误只在用户端复现、每次打开都发生，而服务端日志一片安静。
   *
   * 安全上的三个取舍：
   *  1. **不要求登录**。报错最可能发生在启动阶段，要求令牌等于把最该看的那批丢掉；
   *  2. 因此**必须限流**，否则"上报接口"自己就是攻击面（按 IP 40 条/分钟，超了静默丢）；
   *  3. 所有字段截断 + 剥控制字符，日志里不会出现超长行或换行注入。
   */
  if (urlPath === '/api/client-error' || urlPath.startsWith('/api/client-error?')) {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' });
    const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
    if (!noteClientErr(ip)) return sendJson(res, 429, { ok: false, error: '上报太频繁' });
    if (!requireJson(req, res)) return;
    const body = await readJsonBody(req);
    if (!body) return sendJson(res, 400, { ok: false, error: '请求格式不正确' });

    const head = clipText(body.message, 300)
      + (body.source ? '  @ ' + clipText(body.source, 160) + ':' + (Number(body.lineno) || 0) : '')
      + (body.version ? '  [' + clipText(body.version, 24) + ']' : '')
      + (body.path ? '  ' + clipText(body.path, 80) : '');
    log('[client-error] ' + clipText(body.kind, 20) + ' ' + head);
    /* stack 保留换行（缩进后）才读得懂，所以单独用 keepNewline 模式过一遍 */
    if (body.stack) log(clipText(body.stack, 800, true).replace(/\n/g, '\n    '));
    sendJson(res, 200, { ok: true });
    return;
  }

  if (urlPath === '/api/health' || urlPath.startsWith('/api/health?')) {
    const s = hub.stats();
    /* 走 sendJson 而不是自己 writeHead：这样压缩协商、Vary、Content-Length
     * 三件事跟其他所有 API 走同一套代码。以前这里手写响应头，
     * 结果是全站唯一一个不带 Vary 的 JSON 接口。 */
    sendJson(res, 200, {
      ok: true,
      uptime: Math.round(process.uptime()),
      rooms: s.rooms,
      conns: s.conns,            // 连接数（含尚未进房、以及还没被心跳清掉的僵尸连接）
      online: s.online,          // 真的坐在房间里、连接还在的真人（去重、不含 AI）
      version: APP_VERSION,      // 对外宣称的应用版本
      pwa: PWA_VERSION,          // 静态资源版本（pwa/index.html 的 app-version）
      server: SERVER_STAMP       // 服务端代码构建戳（server/*.js 最新 mtime）
    });
    return;
  }

  // 排行榜。默认给 top(50) 摘要（榜单页用）；?full=1 给全量完整档案，
  // 供 scripts/backup-leaderboard.js 在发布前把线上数据备份进种子文件。
  // full=1 会带出每个玩家的近 20 场流水，必须带密钥才能取。
  if (urlPath === '/api/leaderboard' || urlPath.startsWith('/api/leaderboard?')) {
    const wantsFull = /[?&]full=1/.test(urlPath);
    let list;
    let me = null;

    if (!wantsFull) {
      list = profiles.top(50);
      // ?me=<playerId>：榜单只给 top50，排在外面的人得能看见自己第几
      const meId = queryParam(urlPath, 'me');
      if (meId) me = profiles.rankOf(meId);
    } else {
      const expected = readBackupKey();
      if (!expected) {
        sendJson(res, 403, {
          ok: false,
          error: '备份导出未启用：服务端缺少 server/backup-key.txt，或未设置 BACKUP_KEY'
        });
        return;
      }
      if (!sameSecret(req.headers['x-backup-key'], expected)) {
        sendJson(res, 403, { ok: false, error: '无权导出：缺少或错误的 x-backup-key' });
        return;
      }
      list = profiles.dump();
    }

    /* ★ 必须走 sendJson 而不是自己 writeHead：
     *   full=1 是全站最大的一个响应（每个人的完整档案 + 近 20 场流水），
     *   sendJson 注释里那句「真正受益的是 ?full=1 的全量导出」说的就是它 ——
     *   但这里原来自行 writeHead，把压缩整个绕过去了，等于那句注释从没生效过。
     *   和数据量有关：档案越多、越该压，而它偏偏不压。 */
    sendJson(res, 200, { ok: true, list: list, me: me });
    return;
  }

  // 运维清空：人机测试跑出来的榜单要能一键抹掉。
  // 线上主数据文件在项目目录之外，改种子文件清不掉它（主文件「存在即权威」），
  // 所以必须有一个能在运行时真正落空的入口。
  // 鉴权沿用备份导出的同一把密钥：那把钥匙本来就能读走全部档案，
  // 再给它清空权限不扩大风险面；只接受 POST，避免被链接预取/爬虫误触。
  //
  // 两个入口，语义**不一样**，别拿错：
  //   /api/admin/reset        连账号一起清 → 所有人登不进来，必须重新注册
  //   /api/admin/reset-stats  只清战绩     → 账号照旧可用，榜单从零开始（「清空排行榜」要的是这个）
  // 以前只有前者，想「清空排行榜」就只能连账号一起删——两者混为一谈的代价是
  // 所有人无法登录，所以拆成两个，并在回包里带 mode 让人能确认自己调对没。
  if (urlPath === '/api/admin/reset' || urlPath.startsWith('/api/admin/reset?') ||
      urlPath === '/api/admin/reset-stats' || urlPath.startsWith('/api/admin/reset-stats?')) {
    const expected = readBackupKey();
    const json = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    if (req.method !== 'POST') {
      json(405, { ok: false, error: '只接受 POST' });
      return;
    }
    if (!expected) {
      json(403, { ok: false, error: '清空未启用：服务端缺少 server/backup-key.txt，或未设置 BACKUP_KEY' });
      return;
    }
    if (!sameSecret(req.headers['x-backup-key'], expected)) {
      json(403, { ok: false, error: '无权清空：缺少或错误的 x-backup-key' });
      return;
    }
    const onlyStats = urlPath.indexOf('/api/admin/reset-stats') === 0;
    const cleared = onlyStats ? profiles.resetStats() : profiles.reset();
    log('admin ' + (onlyStats ? 'reset-stats（保留账号）' : 'reset（含账号）') + ': ' + cleared + ' 份档案');
    json(200, { ok: true, cleared: cleared, mode: onlyStats ? 'stats' : 'all' });
    return;
  }

  /* ---------------------------- 注册 / 登录 ---------------------------- */

  if (urlPath === '/api/auth/register' || urlPath.startsWith('/api/auth/register?')) {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' });
    if (!requireJson(req, res)) return;

    const ip = (req.socket && req.socket.remoteAddress) || '';
    if (regBlocked(ip)) return sendJson(res, 429, { ok: false, error: '注册太频繁了，请过一会儿再试' });

    const body = await readJsonBody(req);
    if (!body) return sendJson(res, 400, { ok: false, error: '请求格式不正确' });

    const nameErr = auth.accountNameProblem(body.name);
    if (nameErr) return sendJson(res, 400, { ok: false, error: nameErr });
    const pwErr = auth.passwordProblem(body.password);
    if (pwErr) return sendJson(res, 400, { ok: false, error: pwErr });

    noteReg(ip);
    /* 昵称按**字符**截断（走公共 cleanNickname）：以前用 slice(0,8) 按码元切，
     * 一个 emoji 占 2 个码元，切在中间就成了孤立代理项，前端显示成 。 */
    const nickname = cleanNickname(body.nickname, 8, String(body.name).trim());
    const resReg = await profiles.createAccount(body.name, body.password, nickname || String(body.name).trim());
    if (!resReg.ok) return sendJson(res, 409, { ok: false, error: resReg.error });

    log('register', String(body.name).trim(), resReg.playerId);
    return sendJson(res, 200, sessionPayload(resReg.playerId));
  }

  if (urlPath === '/api/auth/login' || urlPath.startsWith('/api/auth/login?')) {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' });
    if (!requireJson(req, res)) return;
    const body = await readJsonBody(req);
    if (!body) return sendJson(res, 400, { ok: false, error: '请求格式不正确' });

    const ip = (req.socket && req.socket.remoteAddress) || '';
    const wait = loginBlocked(body.name, ip) || loginIpBlocked(ip);
    if (wait) return sendJson(res, 429, { ok: false, error: '密码错误次数太多，请 ' + Math.ceil(wait / 60) + ' 分钟后再试' });

    const r = await profiles.login(body.name, body.password);
    if (!r.ok) {
      // 账号不存在也算失败一次：否则可以靠「是否被限流」反推账号存不存在
      noteLoginFail(body.name, ip);
      noteLoginIpFail(ip);
      return sendJson(res, 401, { ok: false, error: r.error });
    }
    clearLoginFails(body.name, ip);
    clearLoginIpFails(ip);
    return sendJson(res, 200, sessionPayload(r.playerId));
  }

  if (urlPath === '/api/auth/me' || urlPath.startsWith('/api/auth/me?')) {
    const pay = authPayload(req);
    if (!pay) return sendJson(res, 401, { ok: false, error: '登录已失效，请重新登录' });
    const pid = String(pay.pid);
    const acct = profiles.accountOf(pid);
    if (!acct) return sendJson(res, 401, { ok: false, error: '账号不存在，请重新注册' });
    if (acct.disabled) return sendJson(res, 403, { ok: false, error: '该账号已被停用，请联系管理员' });
    if (!auth.tokenVersionOk(pay, profiles.tokenVersion(pid))) {
      // 密码在别处被改过：这枚令牌作废，必须重新登录
      return sendJson(res, 401, { ok: false, error: '密码已修改，请重新登录' });
    }
    const prof = profiles.get(pid);
    const out = {
      ok: true,
      me: {
        playerId: pid,
        nickname: (prof && prof.nickname) || acct.name,
        avatar: (prof && prof.avatar) || '',
        account: acct
      }
    };
    /* 滑动续期：寿命过半才换新令牌。前端每次启动都会调这个接口，
     * 于是只要还在玩，手里的令牌就永远是「至少半程有效」的，不会突然过期。 */
    if (auth.needsRenew(pay)) out.token = auth.signToken(pid, AUTH_SECRET, { tv: profiles.tokenVersion(pid) });
    return sendJson(res, 200, out);
  }

  if (urlPath === '/api/auth/password' || urlPath.startsWith('/api/auth/password?')) {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' });
    if (!requireJson(req, res)) return;
    const pid = authPlayerId(req);
    if (!pid) return sendJson(res, 401, { ok: false, error: '登录已失效，请重新登录' });

    /* 令牌是**无状态**的：账号被自己删掉、或被管理员删掉之后，
     * 手里的令牌在有效期内照样能通过验签。所以这里必须先确认账号还在，
     * 不能直接对 accountOf() 的结果取 .name —— 那是一次真实发生过的挂死：
     * 对 null 取属性抛异常，整个响应再也发不出去（现在外层有兜底了，但也不该靠兜底）。 */
    const acct = profiles.accountOf(pid);
    if (!acct) return sendJson(res, 401, { ok: false, error: '账号不存在，请重新注册' });
    if (acct.disabled) return sendJson(res, 403, { ok: false, error: '该账号已被停用，请联系管理员' });

    const body = await readJsonBody(req);
    if (!body) return sendJson(res, 400, { ok: false, error: '请求格式不正确' });

    /* 改密码必须先验旧密码：令牌可能留在别人的设备上。
     *
     * ★ 这里必须和登录、删号走**同一套失败计数**。之前漏了，于是
     * `/api/auth/password` 变成一条「无视登录限流的密码爆破通道」：
     * 拿到一枚令牌（捡到手机、公用电脑没退出）就能以每小时无限次的速度猜旧密码，
     * 猜中了就改密码把号彻底拿走，而登录接口那边限流再严也拦不住这条路。 */
    const ip = (req.socket && req.socket.remoteAddress) || '';
    const wait = loginBlocked(acct.name, ip) || loginIpBlocked(ip);
    if (wait) return sendJson(res, 429, { ok: false, error: '密码错误次数太多，请 ' + Math.ceil(wait / 60) + ' 分钟后再试' });

    const v = await profiles.login(acct.name, body.oldPassword);
    if (!v.ok) {
      noteLoginFail(acct.name, ip);
      noteLoginIpFail(ip);
      return sendJson(res, 403, { ok: false, error: '原密码不正确' });
    }
    clearLoginFails(acct.name, ip);
    clearLoginIpFails(ip);
    const pwErr = auth.passwordProblem(body.newPassword);
    if (pwErr) return sendJson(res, 400, { ok: false, error: pwErr });

    await profiles.setPassword(pid, body.newPassword);
    log('password changed', pid);
    /* setPassword 会把账号的令牌版本 +1，于是**所有旧令牌当场失效**（包括别的设备上
     * 那枚），这就是「改密码 = 把别人踢下线」。这里下发的新令牌带的是新版本号，
     * 当前设备无缝继续用；其它设备下次请求就会收到 401，回登录页。 */
    return sendJson(res, 200, sessionPayload(pid));
  }

  if (urlPath === '/api/auth/delete' || urlPath.startsWith('/api/auth/delete?')) {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' });
    if (!requireJson(req, res)) return;
    const pid = authPlayerId(req);
    if (!pid) return sendJson(res, 401, { ok: false, error: '登录已失效，请重新登录' });

    /* 删号是**不可恢复**的操作，只凭一枚本地令牌就执行太轻了：
     * 令牌能存 90 天，手机丢了/借人用一下/浏览器没锁，对方点两下就能把你连账号带战绩全删了。
     * 所以要求当场输入密码。同时复用登录失败计数——否则这里会变成
     * 一条「无视登录限流的密码爆破通道」。 */
    const body = await readJsonBody(req);
    if (!body) return sendJson(res, 400, { ok: false, error: '请求格式不正确' });

    const acct = profiles.accountOf(pid);
    if (!acct) return sendJson(res, 401, { ok: false, error: '账号不存在，请重新注册' });

    const ip = (req.socket && req.socket.remoteAddress) || '';
    const wait = loginBlocked(acct.name, ip) || loginIpBlocked(ip);
    if (wait) return sendJson(res, 429, { ok: false, error: '密码错误次数太多，请 ' + Math.ceil(wait / 60) + ' 分钟后再试' });

    const v = await profiles.login(acct.name, body.password);
    if (!v.ok) {
      noteLoginFail(acct.name, ip);
      noteLoginIpFail(ip);
      return sendJson(res, 403, { ok: false, error: body.password ? '密码不正确' : '请输入登录密码' });
    }
    clearLoginFails(acct.name, ip);
    clearLoginIpFails(ip);

    /* 只删自己的：pid 来自令牌，请求体里给别人的 id 一律无视 */
    /* 踢连接要**在删档案之前**：hub 的 kickPlayer 只遍历连接表、不看档案，
     * 顺序其实无所谓；但管理端那条路（/api/admin/delete）是先踢后删，
     * 两条删号路径必须长得一样，否则改一处忘一处是迟早的事。 */
    hub.kickPlayer(pid, '账号已删除');
    /* 删号要连照片一起删：档案删了图还在，等于用户的照片留在了服务器上 —— 这是隐私承诺里
     * 最不能含糊的一条。两条删号路径（用户自助 / 管理端）都必须走这一句。 */
    avatars.remove(pid);
    const removed = profiles.remove(pid);
    /* 种子也要跟着删。不删的话存在一个窗口：A 删号后、下一次 `npm run backup`
     * 之前，容器一旦重建，种子会把 A 的档案原样恢复 —— 账号能登录、战绩全在，
     * 用户以为没删掉。详见 profile.writeSeed() 的注释。 */
    const seeded = profiles.writeSeed();
    log('account deleted', pid, removed, 'seed=' + seeded);
    return sendJson(res, 200, { ok: true, removed: removed });
  }

  /* ---------------------------- 已注销玩家批量查询 ----------------------------
   *
   * 给前端一份「这些 playerId 里哪些已经不在了」的名单。
   *
   * 为什么需要它：删号能覆盖的边界是「服务端 + 本人的设备」。你和别人打过的
   * 回放副本存在**对方的手机上**，服务端碰不到。唯一可行的清理时机是
   * 对方下次打开回放的那一刻 —— 那时他需要知道名单里谁已经不在了，
   * 才能在本地把自己的那份副本里的名字抹掉。
   *
   * 为什么不存一张墓碑表：多一张表就多一处「必须和删除保持同步」的地方，
   * 而「档案还在不在」本身就是答案，天然不会和删除动作脱节。
   * 代价是区分不了「注销了」和「这个 id 从没存在过」；但调用方传上来的 id
   * 全都来自真实回放，不存在后者。
   *
   * 隐私：**只回 dead，不回任何存活者的信息**。否则这个接口就变成
   * 「给一个 id 就能探测有没有这个人」的枚举通道。
   */
  if (urlPath === '/api/players/alive' || urlPath.startsWith('/api/players/alive?')) {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只接受 GET' });
    const pid = authPlayerId(req);
    if (!pid) return sendJson(res, 401, { ok: false, error: '登录已失效，请重新登录' });

    const raw = String(queryParam(urlPath, 'ids') || '');
    const ids = [];
    const seen = {};
    raw.split(',').forEach((s) => {
      const v = s.trim().slice(0, 32);
      if (!v || seen[v]) return;
      seen[v] = 1;
      ids.push(v);
    });
    /* 上限 50：一份回放最多几场、每场最多 6 座，正常远低于这个数。
     * 卡上限是为了不让它变成「一次请求扫全库」的入口。 */
    if (ids.length > 50) return sendJson(res, 400, { ok: false, error: '一次最多查 50 个' });

    return sendJson(res, 200, {
      ok: true,
      dead: ids.filter((id) => !profiles.has(id)),
      checked: ids.length
    });
  }

  /* ---------------------------- 我的战绩（与排行榜同源） ----------------------------
   *
   * 为什么要有这两个接口：
   * 战绩页原来读的是本机 localStorage，排行榜读的是 profiles.json。两套数据互不相干，
   * 于是「删了战绩排行榜还在」「换号后战绩里是别人的局」「断线那局排行榜有、战绩没有」
   * 全都成立。根治办法不是加提示，是让战绩页读**同一份**服务器档案。
   *
   * 走 HTTP 而不复用 WS 的 getProfile：战绩页从首页就能打开，那时可能压根没有
   * 活着的长连接，靠 WS 会让「打开战绩」偶发失败——而它是最该稳定的一页。
   */
  if (urlPath === '/api/me/records' || urlPath.startsWith('/api/me/records?')) {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只接受 GET' });
    /* authPlayerId 内部走 tokenAlive：账号被删 / 被停用 / 改过密码导致令牌版本过期，
     * 都会在这里直接落空，不需要下面再查一遍账号。 */
    const pid = authPlayerId(req);
    if (!pid) return sendJson(res, 401, { ok: false, error: '登录已失效，请重新登录' });

    const prof = profiles.getSelf(pid);   // 从没打过的人返回 null，由前端走空态
    /* serverTime 给客户端核时钟用：本机时间不对时，「10-29 09:08」这类显示整体错位，
     * 看起来就像「数据还在昨天」。 */
    return sendJson(res, 200, { ok: true, profile: prof, serverTime: Date.now() });
  }

  if (urlPath === '/api/me/reset-stats' || urlPath.startsWith('/api/me/reset-stats?')) {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' });
    /* 不读请求体（这个动作不需要参数），但也不能不管：没人消费的请求流会把
     * 这条 keep-alive 连接吊在那儿。resume() 是最轻的正确做法——
     * 比加一个 requireJson 更合适，否则用 curl 不带 body 调会被 415 拦掉。 */
    req.resume();
    const pid = authPlayerId(req);
    if (!pid) return sendJson(res, 401, { ok: false, error: '登录已失效，请重新登录' });

    /* 不清账号、不清昵称，只把战绩归零。账号照旧能登、房间照旧能进，
     * 排行榜上这个人会从榜单消失（games=0 不进榜），这正是「清空战绩」的语义。 */
    const r = profiles.resetStatsOf(pid);
    if (!r.ok) return sendJson(res, 400, { ok: false, error: r.error || '清除失败' });
    log('stats reset', pid);
    return sendJson(res, 200, { ok: true, profile: profiles.getSelf(pid) });
  }

  /* 换头像（v89 §9.2 P1a）。
   *
   * 只收预设 id（a0~a47），不收文件、不收 URL —— 上传要配举报入口 + 审核 + 处置，
   * 三样都没有之前开上传等于把风险直接放给全桌，所以 P1b 另开一档（默认关闭）。
   *
   * 校验放服务端而不是只信前端：48 款是**展示**约束，客户端能随便发；
   * 照单全收的后果是别人拿不到图时头像整块空白 —— 坏的是别人的界面。
   */
  if (urlPath === '/api/me/avatar' || urlPath.startsWith('/api/me/avatar?')) {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' });
    if (!requireJson(req, res)) return;
    const pid = authPlayerId(req);
    if (!pid) return sendJson(res, 401, { ok: false, error: '登录已失效，请重新登录' });

    const body = await readJsonBody(req);
    if (!body) return sendJson(res, 400, { ok: false, error: '请求格式不正确' });

    /* 传 '' 表示「恢复成按 id 哈希的默认款」，是合法的主动选择，
     * 所以这里不能把空串当参数缺失拒掉。 */
    const ok = profiles.setAvatar(pid, body.avatar);
    if (!ok) return sendJson(res, 400, { ok: false, error: '没有这款头像' });
    return sendJson(res, 200, { ok: true, profile: profiles.getSelf(pid) });
  }

  /* 头像照片（P1b，默认关闭 —— 界面上的上传入口见 CONFIG.AVATAR_UPLOAD）。
   *
   * GET /api/avatar/<pid>?v=<version>
   *   v 必须和档案里的 photo 版本号一致才给图。这不是「额外校验」而是**唯一**的
   *   访问控制：不带 v 一律 404，于是「谁传过头像」没法被枚举出来。
   *   带 v 时给一年强缓存 —— 版本号变了 URL 就变了，缓存不会发霉。
   */
  /* 注意 urlPath 是**带查询串**的原始 req.url，所以这里按路径部分匹配 ——
   * 直接对 urlPath 匹配的话，凡是带 ?v= 的请求一条都进不来（全部落到静态 404）。 */
  const avatarGet = /^\/api\/avatar\/([A-Za-z0-9_-]{1,40})$/.exec(urlPath.split('?')[0]);
  if (avatarGet) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { ok: false, error: '只接受 GET' });
    }
    const target = avatarGet[1];
    const want = String((req.url.split('?')[1] || '').split('&').reduce(function (acc, kv) {
      const i = kv.indexOf('=');
      return i > 0 && kv.slice(0, i) === 'v' ? decodeURIComponent(kv.slice(i + 1)) : acc;
    }, '') || '');
    if (!want) { res.writeHead(404); res.end('404'); return; }

    const prof = profiles.get(target);
    if (!prof || !prof.photo || prof.photo !== want) { res.writeHead(404); res.end('404'); return; }

    const img = avatars.read(target);
    if (!img) { res.writeHead(404); res.end('404'); return; }

    res.writeHead(200, {
      'Content-Type': img.mime,
      'Content-Length': img.buf.length,
      /* immutable + 一年：URL 里有版本号，换头像就换 URL，不存在「缓存了旧的还显示旧的」。
       * no-transform 让运营商的图片压缩别插手（那会把人脸糊掉）。 */
      'Cache-Control': 'public, max-age=31536000, immutable, no-transform',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(req.method === 'HEAD' ? undefined : img.buf);
    return;
  }

  /* 上传头像照片。收的是**裸二进制**（Content-Type: image/jpeg|png），不是 base64：
   * base64 会多 1/3 体积，还要再撞一次 JSON 接口的 16KB 上限。 */
  if (urlPath === '/api/me/avatar/photo' || urlPath.startsWith('/api/me/avatar/photo?')) {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' });
    const pid = authPlayerId(req);
    if (!pid) { req.resume(); return sendJson(res, 401, { ok: false, error: '登录已失效，请重新登录' }); }

    const got = await readRawBody(req, AVATAR_MAX_BYTES);
    if (!got) return sendJson(res, 400, { ok: false, error: '请求读不出来' });
    if (got.tooLarge) return sendJson(res, 413, { ok: false, error: '图片太大了，请换一张小一点的' });

    const saved = avatars.save(pid, got.buf);
    if (!saved.ok) return sendJson(res, 400, { ok: false, error: saved.error });
    if (!profiles.setPhoto(pid, saved.version)) {
      avatars.remove(pid);
      return sendJson(res, 500, { ok: false, error: '保存失败，请重试' });
    }
    log('avatar photo', pid, got.buf.length + 'B', saved.mime);
    return sendJson(res, 200, { ok: true, version: saved.version, profile: profiles.getSelf(pid) });
  }

  /* 举报头像。默认关闭的那一版里没有上传入口，但接口先留着 ——
   * 将来开上传时，「举报」这一环不能是临时补的（补出来的通常没有留痕）。 */
  if (urlPath === '/api/me/avatar/report' || urlPath.startsWith('/api/me/avatar/report?')) {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' });
    if (!requireJson(req, res)) return;
    const pid = authPlayerId(req);
    if (!pid) return sendJson(res, 401, { ok: false, error: '登录已失效，请重新登录' });
    const body = await readJsonBody(req);
    if (!body) return sendJson(res, 400, { ok: false, error: '请求格式不正确' });
    const target = String(body.target || '');
    if (!target || target === pid) return sendJson(res, 400, { ok: false, error: '举报对象不正确' });
    if (!profiles.get(target)) return sendJson(res, 404, { ok: false, error: '找不到这个玩家' });
    avatars.report(pid, target, body.reason);
    return sendJson(res, 200, { ok: true });
  }

  /* ---------------------------- 管理端 ---------------------------- */

  /* 管理端路由用**精确匹配**，不用 startsWith 前缀。
   * 之前是 `urlPath.startsWith('/api/admin/')`，于是 /api/admin/usersXYZ 也命中，
   * 返回 200 和完整用户列表。虽然还有密钥兜底，但路由本身不该这么宽松——
   * 前缀匹配等于把「将来某个新路径」的语义提前借给了未知 URL。 */
  const adminPath = urlPath.split('?')[0];
  const ADMIN_PATHS = {
    '/api/admin/users': true,
    '/api/admin/password': true,
    '/api/admin/nickname': true,
    '/api/admin/disable': true,
    '/api/admin/delete': true,
    /* 人机局的历史修正：战绩口径改成「含 AI 不计」之后，
     * 旧数据里混进 games/totalNet 的那几局要能退回来。
     * 服务端从没存过「这一局有哪几个人」，所以候选是**推断**出来的，
     * 必须先 dry-run 看一眼再决定 apply —— 这条路由因此支持两段式。
     * 另外两条是同一次事故补的（2026-10-30 多搬了 12 条真实战绩）：
     *   unmark-ai-games 撤销修正、restore 用备份快照整体覆盖。 */
    '/api/admin/mark-ai-games': true,
    '/api/admin/unmark-ai-games': true,
    '/api/admin/restore': true
  };

  if (ADMIN_PATHS[adminPath] === true) {
    const expected = readBackupKey();
    if (!expected) return sendJson(res, 403, { ok: false, error: '管理端未启用：服务端缺少密钥' });
    if (!sameSecret(req.headers['x-backup-key'], expected)) {
      return sendJson(res, 403, { ok: false, error: '无权访问：缺少或错误的 x-backup-key' });
    }

    const target = (b) => {
      // 管理与脚本都按账号名或 playerId 指人，两者都收
      if (b && b.playerId) return profiles.get(b.playerId) ? b.playerId : null;
      if (b && b.account) {
        const p = profiles.findByAccountName(b.account);
        return p ? p.playerId : null;
      }
      return null;
    };

    if (adminPath === '/api/admin/users') {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只接受 GET' });
      return sendJson(res, 200, { ok: true, list: profiles.accountList() });
    }

    if (adminPath === '/api/admin/mark-ai-games') {
      /* 两段式，因为候选是**推断**的（判据见 profile.suggestAiGames）：
       *   GET              → 只列候选，一个字节都不改
       *   POST {apply:true, keys:[...]} → 只搬这几条
       *
       * ★ POST **必须显式给 keys**，不再「不给就重算全部候选」。
       * 原因是一次真实事故：候选是按「playerCount − 落库人数」推的，而搬走一行会让
       * 那个人的最老流水变新，原来能被「窗口截断」解释的缺口于是变成解释不了 ——
       * 也就是说**重算出来的候选会越来越多**。当时连着 POST 两次，
       * 第二次的 4 个新 key 把 9 条真实战绩挪进了人机流水。
       * 现在把「算候选」和「执行」彻底分开：候选只能从 GET 拿、由人确认后写死成 keys。
       * 不给 keys 直接 400，宁可让调用方多写一行，也不让接口自己再推一遍。 */
      if (req.method === 'GET') {
        return sendJson(res, 200, { ok: true, dryRun: true, candidates: profiles.suggestAiGames() });
      }
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 GET / POST' });
      if (!requireJson(req, res)) return;
      const aiBody = await readJsonBody(req);
      if (!aiBody) return sendJson(res, 400, { ok: false, error: '请求格式不正确' });
      if (!aiBody.apply) {
        return sendJson(res, 200, { ok: true, dryRun: true, candidates: profiles.suggestAiGames() });
      }
      const keys = Array.isArray(aiBody.keys) ? aiBody.keys.map(String).filter(Boolean) : [];
      if (!keys.length) {
        return sendJson(res, 400, {
          ok: false,
          error: '必须显式给 keys：候选会随数据变化而漂移，接口不替你重算（先 GET 拿候选）'
        });
      }
      const done = profiles.markAiGames(keys);
      log('admin mark-ai-games: ' + done.moved + ' 条流水 / ' + done.profiles + ' 份档案');
      return sendJson(res, 200, {
        ok: true, dryRun: false, keys: keys.length,
        moved: done.moved, profiles: done.profiles
      });
    }

    /* 撤销修正：把这几条从人机流水搬回人类战绩。判错了要能一键退回去。 */
    if (adminPath === '/api/admin/unmark-ai-games') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' });
      if (!requireJson(req, res)) return;
      const unBody = await readJsonBody(req);
      if (!unBody) return sendJson(res, 400, { ok: false, error: '请求格式不正确' });
      const unKeys = Array.isArray(unBody.keys) ? unBody.keys.map(String).filter(Boolean) : [];
      if (!unKeys.length) return sendJson(res, 400, { ok: false, error: '必须给 keys' });
      const undo = profiles.unmarkAiGames(unKeys);
      log('admin unmark-ai-games: ' + undo.moved + ' 条流水 / ' + undo.profiles + ' 份档案');
      return sendJson(res, 200, { ok: true, keys: unKeys.length, moved: undo.moved, profiles: undo.profiles });
    }

    /* 灾备回滚：用 dump() 形状的完整快照覆盖当前档案。
     * 只用于「改错了要退回发布前备份」这种场景，不做合并。 */
    if (adminPath === '/api/admin/restore') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' });
      if (!requireJson(req, res)) return;
      const rsBody = await readJsonBody(req);
      if (!rsBody) return sendJson(res, 400, { ok: false, error: '请求格式不正确' });
      const list = Array.isArray(rsBody.profiles) ? rsBody.profiles
        : (Array.isArray(rsBody) ? rsBody : null);
      if (!list) return sendJson(res, 400, { ok: false, error: 'profiles 必须是数组' });
      const rr = profiles.restoreFrom(list);
      if (!rr.ok) return sendJson(res, 400, { ok: false, error: rr.error || '恢复失败' });
      log('admin restore: ' + rr.count + ' 份档案（跳过 ' + rr.skipped + '）');
      return sendJson(res, 200, { ok: true, count: rr.count, skipped: rr.skipped });
    }

    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' });
    if (!requireJson(req, res)) return;
    const body = await readJsonBody(req);
    if (!body) return sendJson(res, 400, { ok: false, error: '请求格式不正确' });
    const pid = target(body);
    if (!pid) return sendJson(res, 404, { ok: false, error: '找不到这个玩家' });

    if (adminPath === '/api/admin/password') {
      const pwErr = auth.passwordProblem(body.password);
      if (pwErr) return sendJson(res, 400, { ok: false, error: pwErr });
      await profiles.setPassword(pid, body.password);
      log('admin set password', pid);
      return sendJson(res, 200, { ok: true });
    }

    if (adminPath === '/api/admin/nickname') {
      const nick = String(body.nickname == null ? '' : body.nickname).trim();
      if (!nick) return sendJson(res, 400, { ok: false, error: '昵称不能为空' });
      // setNickname 撞名时返回原因字符串（昵称在排行榜上是唯一身份，不能撞）
      const rn = profiles.setNickname(pid, nick);
      if (rn !== true) return sendJson(res, 409, { ok: false, error: typeof rn === 'string' ? rn : '改名失败' });
      return sendJson(res, 200, { ok: true });
    }

    if (adminPath === '/api/admin/disable') {
      const off = body.disabled !== false;
      profiles.setDisabled(pid, off);
      // 停用要**当场**把人从桌上的连接里踢掉，不能等他下次登录
      if (off) hub.kickPlayer(pid, '该账号已被停用，请联系管理员');
      log('admin disable', pid, off);
      return sendJson(res, 200, { ok: true });
    }

    if (adminPath === '/api/admin/delete') {
      hub.kickPlayer(pid, '账号已被删除');
      avatars.remove(pid);
      const removed = profiles.remove(pid);
      log('admin delete', pid, removed);
      return sendJson(res, 200, { ok: true, removed: removed });
    }

    return sendJson(res, 404, { ok: false, error: '未知管理操作' });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('405 Method Not Allowed');
    return;
  }

  const abs = resolveStatic(urlPath);
  if (!abs) return notFound(res);
  /* manifest 里还有一批 URL（icons / screenshots），是浏览器按**字面 src** 去抓的，
   * 同样不经过 Service Worker。这里按当前请求的 code 逐条改写，否则 manifest 自己
   * 200 了、图还是 403 —— 等于没修。详见 sendManifest 的注释。 */
  if (path.basename(abs).toLowerCase() === 'manifest.webmanifest') {
    return sendManifest(res, abs, req);
  }
  sendFile(res, abs, req);
}

/* ---------------------------- WebSocket ---------------------------- */

const wss = new WebSocketServer(server, { path: '/ws' });
wss.on('connection', (client, req) => {
  log('ws connect', client.remoteAddress);
  hub.attach(client);
});

/* ---------------------------- 启动与退出 ---------------------------- */

server.listen(PORT, HOST, () => {
  log('listening on ' + HOST + ':' + PORT + '  static=' + STATIC_ROOT);
});

function shutdown(signal) {
  log('shutting down (' + signal + ')');
  try { profiles.flush(); } catch (e) {}
  try { server.close(); } catch (e) {}
  setTimeout(() => process.exit(0), 300).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (e) => {
  /* 以前只记日志、继续跑。但 Node 官方明确说：uncaughtException 之后**进程状态不可信**，
   * 继续服务可能出现「写了一半」这类更隐蔽的数据错误，而错误现场已经过去了。
   * 房间都在内存里，重启的代价只是当前几局作废——比带着不一致状态跑下去安全得多。
   * 所以：先把档案刷盘（不能丢战绩），再关服务，最后退出交给进程管理器拉起。 */
  log('uncaughtException', e && e.stack ? e.stack : e);
  try { profiles.flush(); } catch (x) { /* 刷不动也只能走 */ }
  try { server.close(); } catch (x) {}
  setTimeout(() => process.exit(1), 100).unref();
});
process.on('unhandledRejection', (e) => {
  log('unhandledRejection', e && e.message ? e.message : e);
});

module.exports = { server, hub, profiles };
