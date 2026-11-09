/**
 * 平台存储收口 —— 全站唯一的物理键载体
 *
 * ── 为什么要有这个文件 ──────────────────────────────────────────────
 * 改之前：`localStorage` / `sessionStorage` 直连散在 7 个文件、35 处、16 个物理键、
 * 3 套命名（`lxw_*_v1` / `weile_*` / `weile_version_reloaded`）。
 * 三个具体后果，都真实发生过：
 *
 *   1. **同一样东西两个键**：昵称同时写 `lxw_nickname_v1` 与 `weile_nickname`，
 *      其中一处忘了改就出现「设了昵称又变回玩家xxxx」。
 *   2. **键名漂移没人发现**：`weile_*` 是 v0 的命名，谁也不敢删，因为不知道还有谁在读。
 *   3. **排障时看不到存了什么**：localStorage 里堆着十几个键，没有任何地方能列出
 *      「哪些是本应用写的、各占多大」。隐私模式 / 配额满时更是连痕迹都没有。
 *
 * ── 契约（上层只准用这五个）────────────────────────────────────────
 *   read(key, dflt, kind)      → string | dflt
 *   write(key, value, kind)    → true | false（**永不抛**，配额满/隐私模式返回 false）
 *   remove(key, kind)          → true | false
 *   list(kind)                 → [{ key, size }]
 *   migrate()                  → { moved: [], kept: [] }（幂等）
 *
 * `kind` 只有两种：`'local'`（默认，跨标签页/关掉浏览器还在）与 `'session'`
 * （只活在当前标签页）。**会话存储也走这里**，因为「换一个标签页昵称就没了」
 * 和「存储写不进去」是同一类问题，不该有两套降级逻辑。
 *
 * ── 为什么要 create() ──────────────────────────────────────────────
 * 测试不能用真 localStorage（Node 里没有，jsdom 又要额外依赖）。
 * `create(backing)` 让测试塞一个内存桩进来，**跑的是同一份实现** ——
 * 手写一个假 Store 只能证明假的那个对。
 *
 * ── 迁移是单向的 ────────────────────────────────────────────────────
 * 旧键（`weile_*`）在读之前搬到新键并删掉旧键。搬完旧键就没了，
 * 所以**回滚到 v110 之前的前端会读到空**。这是有意的：这套键一共就
 * 分享码 / 昵称 / 本机临时 id / 本地演示房 / 版本重载标记，全是可重建的，
 * 而两套键并存才是真正会咬人的那种债。
 *
 * 浏览器全局：`window.LXW.Store`（同时挂 `window.Store` 兼容老代码）
 */
(function (global, factory) {
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = mod;
  } else {
    global.LXW = global.LXW || {};
    global.LXW.Store = mod;
    global.Store = mod;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------------------- 物理键（唯一清单） ----------------------------
   * 命名统一为 `lxw_<用途>_v<n>`：
   *   · `lxw_` 前缀 = 这个键属于本应用。清缓存时按前缀清，不会误删同域下的别的东西。
   *   · `_v<N>` = 值的结构版本。改结构就换版本号，旧键由 migrate() 一次性搬走。
   * 加键只能加在这里 —— 别处写字符串字面量就无法被本文件的守卫扫到。 */
  var KEYS = {
    /* 登录态：token + playerId + 昵称（authStore） */
    SESSION: 'lxw_session_v1',
    /* 昵称：local 是权威（iOS 从主屏打开时 session 会被系统回收）；
     * session 只服务 `?mode=local` 演示模式（同浏览器多标签页当多个玩家）。 */
    NICK: 'lxw_nickname_v1',
    NICK_SESSION: 'lxw_nickname_session_v1',
    /* 演示模式下的临时身份（每个标签页一个） */
    MY_ID: 'lxw_myid_v1',
    /* 访问凭据：桌面图标自愈用 */
    SHARE_CODE: 'lxw_sharecode_v1',
    /* 建房时上次选的把数（B8） */
    HAND_LIMIT: 'lxw_hand_limit_v1',
    /* 新手引导看过没有 */
    GUIDE_SEEN: 'lxw_guide_seen_v1',
    /* 首次进结算页的一行策略引导（按设备只一次；§4.2 唯一终值来源）。
     * 与 GUIDE_SEEN 分开：规则是「必须知道才能玩」，策略是「玩过一局才有用」。 */
    STRATEGY_TIP_SEEN: 'lxw_strategy_tip_seen_v1',
    /* 安装引导条关掉的时间戳（一段时间内不再弹） */
    INSTALL_DISMISSED: 'lxw_install_dismissed_v1',
    /* 声音总开关（老键 BGM_LEGACY 只管背景音乐） */
    SOUND: 'lxw_sound_v1',
    BGM_LEGACY: 'lxw_bgm_v1',
    /* 本机战绩兜底 + 判重标记 */
    RECORDS: 'lxw_records_v1',
    RECORDS_DEDUPE: 'lxw_records_deduped_v2',
    /* 本机过程记录（回放用，与服务端无关） */
    SESSIONS: 'lxw_sessions_v1',
    /* 刷新后自动回座的座位令牌 */
    RESUME: 'lxw_resume_v1',
    /* `?mode=local` 演示模式的房间表（BroadcastChannel 同步的那份） */
    ROOMS: 'lxw_rooms_v1',
    ROOMS_TOUCH: 'lxw_rooms_touch_v1',
    /* 版本不一致时只 reload 一次，防死循环 */
    VERSION_RELOADED: 'lxw_version_reloaded_v1'
  };

  /* 旧键 → 新键。只在 migrate() 里用，顺序无关（每个键互不依赖）。
   * `kind` 决定读哪一个 storage —— 搬错 storage 等于凭空造出一条数据。 */
  var LEGACY = [
    { from: 'weile_rooms', to: KEYS.ROOMS, kind: 'local' },
    { from: 'weile_touch', to: KEYS.ROOMS_TOUCH, kind: 'local' },
    { from: 'weile_myid', to: KEYS.MY_ID, kind: 'session' },
    { from: 'weile_nickname', to: KEYS.NICK_SESSION, kind: 'session' },
    { from: 'weile_version_reloaded', to: KEYS.VERSION_RELOADED, kind: 'session' }
  ];

  /* ---------------------------- backing ---------------------------- */

  /* 取全局宿主。
   * ⚠ 这里**不能**用 UMD 外层那个 `global` 形参：工厂函数是在外层 IIFE 的
   * 实参位置求值的，闭包里根本没有那个变量（第一版就是这么写的，
   * 结果 Node 里读到的是全局 global、浏览器里直接 ReferenceError，
   * 于是每次都返回 null —— 所有写入静默变成 false，测试却只报「值没写进去」）。
   * 所以在工厂内部自己解析一次宿主。 */
  var ROOT = (typeof self !== 'undefined' && self)
    || (typeof globalThis !== 'undefined' && globalThis)
    || {};

  function safeGet(name) {
    try {
      var b = ROOT[name];
      return b || null;
    } catch (e) {
      return null; // 隐私模式 / 被策略禁用时连读这个属性都可能抛
    }
  }

  function create(localBacking, sessionBacking) {
    /* 传了 backing 就用传的（测试），没传就每次现取（运行期可能被禁用，
     * 也可能是测试在 require 之后才替换 global.localStorage）。 */
    function backing(kind) {
      if (kind === 'session') {
        return sessionBacking !== undefined ? sessionBacking : safeGet('sessionStorage');
      }
      return localBacking !== undefined ? localBacking : safeGet('localStorage');
    }

    function read(key, dflt, kind) {
      var b = backing(kind);
      if (!b) return dflt === undefined ? null : dflt;
      try {
        var v = b.getItem(key);
        return v === null || v === undefined ? (dflt === undefined ? null : dflt) : v;
      } catch (e) {
        return dflt === undefined ? null : dflt;
      }
    }

    function write(key, value, kind) {
      var b = backing(kind);
      if (!b) return false;
      try {
        b.setItem(key, String(value));
        return true;
      } catch (e) {
        /* 配额满 / 隐私模式 / 被策略禁用。**不抛**是契约的一部分：
         * 调用方全是「记不住就算了」的辅助信息，抛出去会把主流程一起带走。 */
        return false;
      }
    }

    function remove(key, kind) {
      var b = backing(kind);
      if (!b) return false;
      try {
        b.removeItem(key);
        return true;
      } catch (e) {
        return false;
      }
    }

    function readJson(key, dflt, kind) {
      var raw = read(key, null, kind);
      if (!raw) return dflt;
      try {
        var v = JSON.parse(raw);
        return v === null || v === undefined ? dflt : v;
      } catch (e) {
        return dflt; // 结构坏了当没有：坏数据留着只会每读必错
      }
    }

    function writeJson(key, obj, kind) {
      var s;
      try {
        s = JSON.stringify(obj);
      } catch (e) {
        return false;
      }
      return write(key, s, kind);
    }

    function list(kind) {
      var b = backing(kind);
      var out = [];
      if (!b) return out;
      var n = 0;
      try {
        n = b.length || 0;
      } catch (e) {
        return out;
      }
      for (var i = 0; i < n; i++) {
        var k = null;
        try {
          k = b.key(i);
        } catch (e) {
          k = null;
        }
        if (!k) continue;
        var size = 0;
        try {
          size = String(b.getItem(k) || '').length;
        } catch (e) {
          size = 0;
        }
        out.push({ key: k, size: size });
      }
      out.sort(function (a, b2) {
        return b2.size - a.size; // 排障先看谁最大
      });
      return out;
    }

    /* 迁移：搬值 → 删旧键。**目标键已有值时不覆盖**（用户在新版里已经写过一次，
     * 那份更新）；旧键照样删掉，否则两套键并存，下一个读的人又要猜哪个是准的。 */
    function migrate() {
      var moved = [];
      var kept = [];
      for (var i = 0; i < LEGACY.length; i++) {
        var it = LEGACY[i];
        var old = read(it.from, null, it.kind);
        if (old === null) continue;
        var cur = read(it.to, null, it.kind);
        if (cur === null) {
          if (write(it.to, old, it.kind)) moved.push(it.to);
          else kept.push(it.from); // 写不进（配额满）就先留着，下次启动再试
        }
        if (read(it.to, null, it.kind) !== null) remove(it.from, it.kind);
      }
      /* 声音：老键只管背景音乐，值语义是 `'0'` = 关，其余 = 开 */
      var bgm = read(KEYS.BGM_LEGACY, null);
      if (bgm !== null) {
        if (read(KEYS.SOUND, null) === null) {
          write(KEYS.SOUND, bgm === '0' ? '0' : '1');
          moved.push(KEYS.SOUND);
        }
        remove(KEYS.BGM_LEGACY);
      }
      return { moved: moved, kept: kept };
    }

    function available(kind) {
      var b = backing(kind);
      if (!b) return false;
      var probe = '__lxw_probe__';
      try {
        b.setItem(probe, '1');
        b.removeItem(probe);
        return true;
      } catch (e) {
        return false;
      }
    }

    return {
      KEYS: KEYS,
      create: create,
      read: read,
      write: write,
      remove: remove,
      readJson: readJson,
      writeJson: writeJson,
      list: list,
      migrate: migrate,
      available: available
    };
  }

  var store = create(undefined, undefined);
  /* 加载即迁移：只做几次 getItem，读不到就什么也不做，代价可以忽略；
   * 不放在 boot 里是因为 index.html 的内联脚本比任何 defer 脚本都早，
   * 它读的第一个键（分享码）也必须是迁移之后的。 */
  try {
    store.migrate();
  } catch (e) {
    /* 迁移失败不该挡住首屏 */
  }
  return store;
});
