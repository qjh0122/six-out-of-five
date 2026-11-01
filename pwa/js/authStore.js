/**
 * 账号与登录态（前端唯一入口）
 *
 * 设计要点：
 *   - 登录态存 localStorage（token + playerId + 昵称）。关掉浏览器再开还在，
 *     30 天内不用重登。清浏览器数据 = 退出登录，但账号还在服务端，
 *     换个浏览器重新登录即可拿回战绩——这正是做账号取代「设备码」的原因。
 *   - 所有请求都带 sharecode：部署网关要求每一个请求都带它，
 *     裸 /api/* 一律 403（详见 game.js 里同一处说明）。
 *   - 接口失败一律 resolve 成 { ok:false, error }，不抛异常：
 *     登录页只需要在按钮上方显示一行字，不想让调用方到处 try/catch。
 */
(function (global) {
  'use strict';

  var LS_KEY = 'lxw_session_v1';
  var cache = null;
  var lastError = '';

  function readSession() {
    if (cache) return cache;
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (!s || !s.token || !s.playerId) return null;
      cache = s;
      return cache;
    } catch (e) {
      return null;
    }
  }

  function writeSession(s) {
    cache = s;
    try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) { /* 隐私模式写不进去 */ }
  }

  function clearSession() {
    cache = null;
    try { localStorage.removeItem(LS_KEY); } catch (e) { /* 忽略 */ }
  }

  /** 拼 API 地址：把页面 URL 上的 sharecode 带过去，否则网关 403 */
  function apiURL(path) {
    var p = '/api' + path;
    try {
      var sc = new URLSearchParams(location.search || '').get('sharecode');
      if (sc) p += (p.indexOf('?') >= 0 ? '&' : '?') + 'sharecode=' + encodeURIComponent(sc);
    } catch (e) { /* 老浏览器没有 URLSearchParams，就当没有 sharecode */ }
    return p;
  }

  /**
   * 发请求。
   * @param {string} path   以 / 开头，如 '/auth/login'
   * @param {object} opts   { method, body, auth }
   */
  async function request(path, opts) {
    var o = opts || {};
    var headers = {};
    var body;
    if (o.blob !== undefined) {
      /* 裸二进制（头像照片上传）：不 JSON 编码、不加 base64 ——
       * 一张 256×256 的 JPEG 是 12~20KB，走 base64 会多 1/3 体积，
       * 而且 JSON 接口的 BODY_MAX 只有 16KB，根本塞不下。 */
      headers['Content-Type'] = o.type || 'application/octet-stream';
      body = o.blob;
    } else if (o.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(o.body);
    }
    if (o.auth !== false) {
      var s = readSession();
      /* 用自定义头，不用 `Authorization: Bearer`：线上部署网关会把 Authorization
       * 当自己的鉴权头拦下来，后端根本收不到 → 刷新页面就判「登录已失效」。
       * 同一枚令牌走 WebSocket 消息体是好的，所以问题只在头。 */
      if (s && s.token) headers['X-Session-Token'] = s.token;
    }
    var res;
    try {
      res = await fetch(apiURL(path), {
        method: o.method || 'GET',
        headers: headers,
        body: body,
        cache: 'no-store'
      });
    } catch (e) {
      return { ok: false, error: '网络不太好，再试一次', offline: true };
    }

    var data = null;
    try { data = await res.json(); } catch (e) { /* 非 JSON */ }

    if (data && typeof data === 'object') {
      if (res.status >= 200 && res.status < 300 && data.ok !== false) return data;
      return { ok: false, error: (data.error || '操作失败'), status: res.status };
    }
    return { ok: false, error: '服务返回异常（' + res.status + '）', status: res.status };
  }

  /** 把登录/注册接口的回包落成本地会话 */
  function adopt(payload) {
    if (!payload || !payload.token || !payload.me) return null;
    var s = {
      token: payload.token,
      playerId: payload.me.playerId,
      nickname: payload.me.nickname || '',
      avatar: payload.me.avatar || '',
      photo: payload.me.photo || '',
      name: (payload.me.account && payload.me.account.name) || '',
      joinedAt: (payload.me.account && payload.me.account.createdAt) || 0
    };
    writeSession(s);
    return s;
  }

  var AuthStore = {
    /** 当前会话；没有登录返回 null */
    session: function () { return readSession(); },
    token: function () { var s = readSession(); return s ? s.token : ''; },
    playerId: function () { var s = readSession(); return s ? s.playerId : ''; },
    nickname: function () { var s = readSession(); return s ? (s.nickname || '') : ''; },
    /** 选过的头像 id（a0~a47）；'' = 没选过，展示时按 playerId 哈希落到默认款 */
    avatar: function () { var s = readSession(); return s ? (s.avatar || '') : ''; },
    /** 上传照片的版本号（P1b）；'' = 没传过照片，用预设头像 */
    photo: function () { var s = readSession(); return s ? (s.photo || '') : ''; },
    accountName: function () { var s = readSession(); return s ? (s.name || '') : ''; },
    isLoggedIn: function () { return !!readSession(); },

    /** 本地改昵称（牌桌改名后同步，免得下次进来又变回旧名） */
    setNickname: function (nick) {
      var s = readSession();
      if (!s) return;
      s.nickname = String(nick || '');
      writeSession(s);
    },

    /** 本地记下头像（服务端成功后才调；失败不留痕，免得本地和服务端不一致） */
    setAvatarLocal: function (id) {
      var s = readSession();
      if (!s) return;
      s.avatar = String(id == null ? '' : id);
      writeSession(s);
    },

    /** 本地记下照片版本号 */
    setPhotoLocal: function (v) {
      var s = readSession();
      if (!s) return;
      s.photo = String(v == null ? '' : v);
      writeSession(s);
    },

    /**
     * 上传头像照片（P1b）。传的是**已经压好的** blob（256×256 JPEG），
     * 压缩在 game.js 里用 canvas 做（见 pickAvatarPhoto）。
     * @param {Blob} blob
     */
    uploadPhoto: async function (blob) {
      var r = await request('/me/avatar/photo', { method: 'POST', blob: blob, type: blob && blob.type || 'image/jpeg' });
      if (r.ok && r.version) AuthStore.setPhotoLocal(r.version);
      return r;
    },

    /** 举报某人的头像（P1b 的合规配套） */
    reportAvatar: async function (target, reason) {
      return request('/me/avatar/report', { method: 'POST', body: { target: target, reason: reason || '' } });
    },

    /** 换头像：服务端是唯一裁判（只认预设 id），本地跟着改 */
    setAvatar: async function (id) {
      var r = await request('/me/avatar', { method: 'POST', body: { avatar: String(id == null ? '' : id) } });
      if (r.ok) {
        AuthStore.setAvatarLocal(id);
        /* 服务端选了预设就会清掉照片（「最后一次动作生效」），本地必须同步 ——
         * 不同步的话，刷新前座位还在显示旧照片、刷新后突然变成预设款。 */
        AuthStore.setPhotoLocal('');
      }
      return r;
    },

    logout: function () { clearSession(); },

    register: async function (name, password, nickname) {
      var r = await request('/auth/register', { method: 'POST', body: { name: name, password: password, nickname: nickname || '' } });
      if (r.ok) adopt(r);
      return r;
    },

    login: async function (name, password) {
      var r = await request('/auth/login', { method: 'POST', body: { name: name, password: password } });
      if (r.ok) adopt(r);
      return r;
    },

    /**
     * 校验本地令牌是否还有效，顺便续期。
     * 返回 'ok' | 'expired' | 'offline'：
     *   - offline 时**不要**踢人下线（弱网下把人踢去登录页最招人烦）
     *   - expired 时**立刻清掉本地会话**：不清的话下次启动还会先闪一下首页再弹登录，
     *     而且那个死令牌还会被继续塞进每个请求的鉴权头
     *   - 服务端在令牌寿命过半时会顺带下发新令牌（滑动续期），这里接住就换掉，
     *     所以只要还在玩，就一直不用重新登录
     */
    refresh: async function () {
      var s = readSession();
      if (!s) return 'expired';
      lastError = '';
      var r = await request('/auth/me', { method: 'GET' });
      if (r.ok && r.me) {
        if (r.token) s.token = r.token;              // 续期成功 → 换成新令牌
        s.playerId = r.me.playerId || s.playerId;
        s.nickname = r.me.nickname || s.nickname;
        s.avatar = r.me.avatar || '';
        s.photo = r.me.photo || '';
        s.name = (r.me.account && r.me.account.name) || s.name;
        if (r.me.account && r.me.account.createdAt) s.joinedAt = r.me.account.createdAt;
        writeSession(s);
        return 'ok';
      }
      if (r.status === 401 || r.status === 403) {
        lastError = r.error || '';                    // 「该账号已被停用」这类原因要能带到登录页
        clearSession();
        return 'expired';
      }
      return 'offline';
    },

    /** 上一次 refresh 失败的原因（给登录页说人话用），没有则为空 */
    lastError: function () { return lastError; },

    changePassword: async function (oldPassword, newPassword) {
      var r = await request('/auth/password', { method: 'POST', body: { oldPassword: oldPassword, newPassword: newPassword } });
      if (r.ok) adopt(r);   // 服务端会下发新令牌，直接换掉
      return r;
    },

    /** 删号必须带密码：只有本地令牌就能删号太轻了（令牌能存 90 天） */
    deleteAccount: async function (password) {
      var r = await request('/auth/delete', { method: 'POST', body: { password: password } });
      if (r.ok) clearSession();
      return r;
    },

    /**
     * 我的云端战绩（与排行榜同一份档案）。
     *
     * 战绩页原来只读本机 localStorage，和排行榜是两套数据，于是
     * 「删了战绩排行榜还在」「换号后战绩里是别人的局」都成立。
     * 现在战绩页以这份数据为准，本机记录退化为「离线兜底 + 回放仓库」。
     */
    myRecords: async function () {
      return request('/me/records', { method: 'GET' });
    },

    /** 清空我的云端战绩（账号保留）。排行榜会同步归零。 */
    resetMyStats: async function () {
      return request('/me/reset-stats', { method: 'POST', body: {} });
    },

    /**
     * 批量查「这些 playerId 里哪些已经注销了」。
     *
     * 用途：删号能覆盖的边界是「服务端 + 本人的设备」。你和别人打过的回放副本
     * 存在**对方的手机上**，服务端碰不到 —— 只能在对方下次打开回放时，
     * 拿这份名单把本地那份里的名字抹掉（见 docs/deletion-spec.md 方案 3）。
     *
     * ★ 必须走 request：它会拼 sharecode、带 X-Session-Token。
     *   裸 fetch('/api/...') 在线上会被部署网关判 403（网关要求每个请求带 sharecode），
     *   本地却是一切正常的 —— 这类「本地绿、线上红」只有真发布过才会发现。
     */
    playersAlive: async function (ids) {
      var list = (Array.isArray(ids) ? ids : []).filter(function (x) { return !!x; });
      if (!list.length) return { ok: true, dead: [], checked: 0 };
      return request('/players/alive?ids=' + encodeURIComponent(list.join(',')), { method: 'GET' });
    }
  };

  global.AuthStore = AuthStore;
})(typeof window !== 'undefined' ? window : this);
