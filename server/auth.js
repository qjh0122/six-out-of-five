/**
 * 账号与登录令牌（服务端唯一实现，不依赖任何第三方库）
 *
 * 为什么自己写而不用现成的：
 *   - 只需要「账号名 + 密码 + 无状态令牌」三件事，引一个认证框架反而要带
 *     会话存储、Cookie、CSRF 一堆用不上的东西；
 *   - 密码哈希必须能自己控制参数（scrypt 成本），这是唯一不能妥协的部分。
 *
 * 三条硬约束：
 *   1. **明文密码绝不落盘、绝不进日志**。只存 salt + scrypt 结果。
 *   2. 令牌用 HMAC-SHA256 签名，密钥持久化在数据目录（项目外），
 *      这样部署换代码不会把所有玩家踢下线，进程重启也照样认账。
 *   3. 校验一律 timing-safe，长度不同直接判负——不做逐字符早退。
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/* scrypt 成本参数：N=16384/r=8/p=1 是 Node 官方文档的推荐档，
 * 单次约 50~80ms。登录不是高频操作，这个开销换来的是「拖库也难还原明文」。 */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
/* scrypt 需要 128*N*r = 16MB 工作内存，而 Node 默认 maxmem 是 32MB。
 * 留一点余量，避免将来调高 N 时莫名其妙报 "Invalid scrypt params"。 */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/* 令牌有效期。
 * 这个游戏没有支付也没有隐私数据，重登的代价远大于「令牌被偷」的风险，
 * 所以刻意给得长：90 天。配合 needsRenew() 的半程续期，只要还在玩就永远不用重登；
 * 真正的兜底是「闲置 90 天自动失效」，而不是频繁要求输密码。 */
const TOKEN_TTL_MS = 90 * 24 * 3600 * 1000;

/* ---------------------------- 密码 ---------------------------- */

/**
 * scrypt 的**异步**版本。
 *
 * 以前用的是 scryptSync，代价不是「慢一点」而是「整个进程停住」：
 * 单次约 60ms，而这 60ms 里事件循环是堵死的——所有 WebSocket 帧、
 * 心跳、出牌、广播全部排队等它。实测 4 个人同时登录，
 * 耗时严格串行成 63 / 123 / 183 / 242ms，8 个人同时登就是半秒全站冻结。
 * 改成异步后，哈希计算跑在 libuv 线程池里，主线程照常处理对局。
 */
function scryptHash(password, salt) {
  return new Promise(function (resolve, reject) {
    crypto.scrypt(
      String(password),
      String(salt),
      KEY_LEN,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM },
      function (err, key) {
        if (err) reject(err);
        else resolve(key);
      }
    );
  });
}

/** 生成 salt + 哈希。返回 Promise<{ salt, hash }>，都是 hex 字符串。 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scryptHash(password, salt);
  return { salt: salt, hash: key.toString('hex') };
}

/**
 * 校验密码。参数缺失一律 false（不要抛异常——登录接口不能被脏数据打崩）。
 * 哈希与校验走同一参数，否则参数漂移会导致老密码全部失效。
 */
async function verifyPassword(password, salt, hash) {
  if (!password || !salt || !hash) return false;
  let calc;
  try {
    const key = await scryptHash(password, salt);
    calc = key.toString('hex');
  } catch (e) {
    return false;
  }
  return timingSafeEqualStr(calc, String(hash));
}

/** 定长常量比较：先比长度，再逐字节比 */
function timingSafeEqualStr(a, b) {
  const x = String(a == null ? '' : a);
  const y = String(b == null ? '' : b);
  if (!x || !y || x.length !== y.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(x), Buffer.from(y)); } catch (e) { return false; }
}

/* ------------------------ 「查无此人」的陪跑 ------------------------
 *
 * 防枚举不能只靠文案一致，**时间也得一致**。
 *
 * scrypt（N=16384）一次约 60ms，而「账号不存在」是查一次 Map 就返回，
 * 差不多 1ms。于是 `time_total` 直接把答案写在了外面：
 *   ~1ms  → 这个账号不存在
 *   ~60ms → 账号存在，只是密码错了
 * 前面费劲统一成「账号或密码不正确」的文案，被一个耗时差异全部抵消。
 *
 * 这里给「查无此人」这条路准备一组**永远对不上**的凭据，唯一用途是把那次 scrypt 跑完。
 * hash 用等长的占位串：`verifyPassword` 先算 scrypt 再比较，长度不等时
 * `timingSafeEqualStr` 直接 false —— 时间已经花掉了，结论永远是「不对」。
 */
const DUMMY_SALT = '0'.repeat(32);
const DUMMY_HASH = '0'.repeat(128);   // 与 scrypt 输出等长（64 字节 → 128 hex）

/** 陪跑一次 scrypt。永远返回 false，调用方按「验证失败」处理即可。 */
async function verifyDummy(password) {
  /* password 为空时 verifyPassword 会在第一行直接 return（耗时又变成 1ms），
   * 所以这里补一个占位密码：我们只要它把 scrypt 跑完。 */
  await verifyPassword(password || '\u0000dummy', DUMMY_SALT, DUMMY_HASH);
  return false;
}

/* ---------------------------- 令牌 ---------------------------- */

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(s, 'base64');
}

/**
 * 签发令牌。payload 里放 playerId、过期时间与**令牌版本号 tv**。
 * 格式：base64url(json).base64url(hmac)，两段，没有 header——
 * 这不是 JWT（不需要跨服务互认），只是一个「服务端能自证的凭据」。
 *
 * 为什么要 tv：令牌是**无状态**的，改密码/停用之后，手里那枚旧令牌在有效期内
 * 照样能通过验签——等于「改密码并不能把别人踢下线」。给账号挂一个版本号，
 * 令牌里带上签发时的版本，服务端每次比对：版本不一致即失效。
 * 改密码、管理员停用都把版本 +1，旧令牌当场作废，不需要任何服务端会话表。
 */
function signToken(playerId, secret, opts) {
  const o = opts || {};
  const now = o.now || Date.now();
  const payload = {
    pid: String(playerId),
    iat: now,
    exp: now + (o.ttlMs || TOKEN_TTL_MS),
    tv: Number(o.tv || 0) || 0
  };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', String(secret)).update(body).digest());
  return body + '.' + sig;
}

/**
 * 校验令牌，返回 payload 或 null。
 * 三种失败都不区分对待（对客户端统一报「登录已失效」）：
 * 格式错、签名错、过期。
 */
function verifyToken(token, secret, opts) {
  const o = opts || {};
  const raw = String(token == null ? '' : token);
  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return null;
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);

  const expect = b64url(crypto.createHmac('sha256', String(secret)).update(body).digest());
  if (!timingSafeEqualStr(sig, expect)) return null;

  let payload;
  try { payload = JSON.parse(unb64url(body).toString('utf8')); } catch (e) { return null; }
  if (!payload || typeof payload !== 'object' || !payload.pid) return null;
  const now = o.now || Date.now();
  if (!payload.exp || now >= payload.exp) return null;
  return payload;
}

/**
 * 令牌版本是否还对得上。
 * 老令牌里没有 tv 字段（本次升级前签发的），按 0 处理；
 * 老账号也没有 tv（同样是 0），于是升级那一刻**不会把任何人踢下线**。
 */
function tokenVersionOk(payload, currentVersion) {
  const a = Number((payload && payload.tv) || 0) || 0;
  const b = Number(currentVersion || 0) || 0;
  return a === b;
}

/**
 * 令牌是否需要续期（滑动过期）。
 *
 * 只在「寿命过半」时才续：每次打开页面都换一个新令牌会让令牌数量无意义地膨胀，
 * 而过半才续意味着常用玩家手里永远握着至少半程有效的令牌，
 * 等于「只要还在玩就永不失效」。不常用的人到期自然失效，也符合预期。
 */
function needsRenew(payload, opts) {
  const o = opts || {};
  if (!payload || !payload.exp) return false;
  const now = o.now || Date.now();
  const ttl = o.ttlMs || TOKEN_TTL_MS;
  return (payload.exp - now) < ttl / 2;
}

/* ---------------------------- 密钥持久化 ---------------------------- */
/**
 * 读或生成签名密钥。
 * **必须放数据目录**（项目外）：部署只上传项目目录，密钥在里面就会被换掉，
 * 后果是全体玩家下次打开时登录态失效。放外面则跨版本存活。
 * 文件权限 0600：同机其他用户读不到。
 */
function loadSecret(file) {
  if (!file) throw new Error('loadSecret 需要文件路径');
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    if (s.length >= 32) return s;
  } catch (e) { /* 不存在 → 下面生成 */ }
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, secret, { encoding: 'utf8', mode: 0o600 });
    return secret;
  } catch (e) {
    /* 落盘失败（只读容器）也要能跑：退回内存密钥，
     * 代价是重启后登录态失效，但比整个服务起不来强。 */
    return secret;
  }
}

/* ---------------------------- 输入校验 ---------------------------- */

/**
 * 账号名校验。允许中文（这个游戏的用户是中文昵称习惯），
 * 统一小写做唯一性键——「Abc」和「abc」视为同一账号。
 * 下限取 2：中文两字名（小明、老王）很常见，卡 3 位会把它们全挡掉；
 * 真正挡撞库的是密码强度和登录限流，不是账号名长度。
 */
function accountNameProblem(name) {
  const n = String(name == null ? '' : name).trim();
  if (!n) return '请输入账号名';
  if (Array.from(n).length < 2) return '账号名至少 2 个字符';
  if (Array.from(n).length > 16) return '账号名最多 16 个字符';
  if (!/^[A-Za-z0-9_\u4e00-\u9fa5]+$/.test(n)) return '账号名只能用中文、字母、数字和下划线';
  return null;
}

/* 密码下限：**新设的密码 8 位，老账号 6 位继续能登录**。
 *
 * 为什么不是一把改成 8 位：现存的 6 位密码是用户当初被允许设的，
 * 登录时再拦一次等于把这些人锁在门外 —— 他们并没有做错什么，
 * 是规则变了。所以下限只作用在「产生新密码」的两个入口（注册、改密码、管理员重置），
 * 登录路径根本不校验长度（见 /api/auth/login）。
 *
 * 6 位下限仍在 passwordProblem 里保留，因为它还要回答另一个问题：
 * 「这条密码能不能通过校验」—— 老密码得能。
 * 两个常量分开写，是为了将来上层能一眼看出哪个是当下标准、哪个是历史包袱。 */
const MIN_PASSWORD_LEN = 8;
const LEGACY_MIN_PASSWORD_LEN = 6;

/** 密码策略故意定得低：这是熟人游戏，不是网银。8 位下限挡住「123456」这类 */
function passwordProblem(pw, minLen) {
  const s = String(pw == null ? '' : pw);
  const min = minLen || MIN_PASSWORD_LEN;
  if (!s) return '请输入密码';
  if (s.length < min) return '密码至少 ' + min + ' 位';
  if (s.length > 64) return '密码最多 64 位';
  return null;
}

module.exports = {
  hashPassword,
  verifyPassword,
  verifyDummy,
  signToken,
  verifyToken,
  tokenVersionOk,
  needsRenew,
  loadSecret,
  accountNameProblem,
  passwordProblem,
  MIN_PASSWORD_LEN,
  LEGACY_MIN_PASSWORD_LEN,
  timingSafeEqualStr,
  TOKEN_TTL_MS
};
