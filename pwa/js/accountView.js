/**
 * 账号与设置：登录 / 注册 / 账号卡 / 改密码 / 头像 / 改名 / 注销
 *
 * ── 为什么单独成文件 ────────────────────────────────────────────────
 * 这一整块和「牌桌怎么打」毫无关系，却长在 game.js 正中间（原来在 3600~4100 行），
 * 左边是档案卡、右边是分享图 —— 想改一处密码校验，得在这种邻居里定位。
 * 它是典型的「一个屏一个文件」：这一屏就是「账号」，从登录到销号全在这里。
 *
 * ── 为什么不重写 ────────────────────────────────────────────────
 * 函数体**逐字搬移**，一行没改。改的只有三件事：
 *   1. 外面套了一层 `create(deps)`；
 *   2. 注入项从「闭包里的自由变量」变成 `create` 顶部的局部别名（名字一模一样，
 *      所以函数体里的调用点一个字都没动）；
 *   3. 末尾 `return` 导出本屏对外的入口。
 * 这样「行为不变」是结构上保证的，不是靠人肉比对 —— 比对的只是**边界**，
 * 而边界由 `.tmp-deps.js` 的依赖分析和 `node --check` 两道关守着。
 *
 * ── 为什么在原位置创建（而不是像 utils 那样放文件顶部）───────���───────
 * 注入项里有 `LS_NICK` 这种用 `var` 定义的常量：`var` 不提升**值**。
 * 如果模块在 game.js 顶部就创建，那时 `LS_NICK` 还是 undefined，
 * 传进去的就是个死值。放在原来的位置上创建，前面所有 `var` 都已初始化，
 * 后面所有 `function` 又都被提升 —— 两头都安全。
 *
 * 浏览器全局：`window.LXW.accountView`
 */
(function (global) {
  'use strict';

  function create(deps) {
    deps = deps || {};
    var U = global.LXW.utils;
    var $ = U.$, el = U.el, esc = U.esc;
    var pad2 = U.pad2, fmtTime = U.fmtTime, netText = U.netText, netCls = U.netCls;
    var short = U.short, colorFor = U.colorFor, cardText = U.cardText;

    /* ---- 注入（全部来自 game.js，名字与原来闭包里的完全一致）---- */
    var LS_NICK = deps.LS_NICK;
    var state = deps.state;
    var flash = deps.flash, showScreen = deps.showScreen, renderRoom = deps.renderRoom;
    var getMe = deps.getMe, getMyId = deps.getMyId, setNickname = deps.setNickname;
    var recordsPid = deps.recordsPid, cleanupRoom = deps.cleanupRoom;
    var handleInvite = deps.handleInvite, readInviteRoom = deps.readInviteRoom;
    var tryResumeRoom = deps.tryResumeRoom, blockedOffline = deps.blockedOffline;
    var showModalEl = deps.showModalEl, hideModalEl = deps.hideModalEl;
    var pushModalState = deps.pushModalState, askConfirm = deps.askConfirm;

  /* ---------------------------- 登录 / 注册 ---------------------------- */

  var authMode = 'login';   // 'login' | 'register'

  function setAuthMode(mode) {
    authMode = mode === 'register' ? 'register' : 'login';
    var isReg = authMode === 'register';

    var tabs = document.querySelectorAll('[data-auth-tab]');
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute('data-auth-tab') === authMode;
      tabs[i].classList.toggle('is-on', on);
      tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    $('#auth-nick-field').classList.toggle('hidden', !isReg);
    $('#btn-auth-submit').textContent = isReg ? '注册并进入' : '登录';
    $('#auth-pass').setAttribute('autocomplete', isReg ? 'new-password' : 'current-password');
    /* 占位提示跟着模式走：登录时不写「至少 N 位」—— 老账号的 6 位密码是合法的，
     * 在登录框上写「至少 8 位」会让人以为自己进不去。 */
    $('#auth-pass').setAttribute('placeholder', isReg ? '至少 8 位' : '请输入密码');
    // 底部提示用整句替换，其中的按钮靠 #screen-auth 上的事件委托接住（不用重新绑）
    $('#auth-hint').innerHTML = isReg
      ? '已经有账号了？<button class="auth-link" type="button" data-auth-tab="login">直接登录</button>'
      : '还没有账号？<button class="auth-link" type="button" data-auth-tab="register">立即注册</button>';
    /* 「忘记密码」只在登录态出现 —— 注册的时候没有旧密码可忘。
     * 底注也跟着换：注册前把「不绑手机号、忘了只能找管理员」明说一次，
     * 比事后在登录页解释有用得多（review P1-8：原先两处都一个字没提）。 */
    $('#btn-forgot').classList.toggle('hidden', isReg);
    $('#auth-forgot-note').classList.add('hidden');
    var note = $('#auth-note');
    if (note) {
      note.textContent = isReg
        ? '不绑手机号，也没有自助找回 —— 密码请记牢，忘了只能找管理员重置'
        : '账号只用来保存战绩，不绑手机号';
    }
    hideAuthError();
  }

  function showAuthError(msg) {
    var box = $('#auth-err');
    box.textContent = msg || '操作失败';
    box.classList.remove('hidden');
  }
  function hideAuthError() { $('#auth-err').classList.add('hidden'); }

  /* 进登录页。reason 用来解释「为什么被踢回来」（令牌失效 / 账号被停用），
   * 不解释的话用户只会看到「突然要重新登录」。 */
  function gotoAuth(reason) {
    if (state.roomId || state.room) cleanupRoom();
    try { RoomStore.disconnect(); } catch (e) { /* 断不开也不影响换号 */ }
    state.myId = getMyId();
    $('#auth-pass').value = '';
    setAuthMode('login');
    showScreen('screen-auth');
    if (reason) showAuthError(reason);
  }

  /** 登录成功后进首页（有邀请链接就直接进房，有上次房间就回座） */
  function enterApp() {
    state.myId = getMyId();
    var nick = (AuthStore.nickname() || '').trim();
    /* 刚登录完，账号里的昵称是权威值：输入框一律按它重置，
     * 不能只在「输入框为空时」才填，否则换账号（或新号没设昵称）会残留上一个人的名字。 */
    if (nick) setNickname(nick);
    $('#nickname-input').value = nick;
    showScreen('screen-home');
    if (readInviteRoom()) { handleInvite(); return; }
    tryResumeRoom();
  }

  async function submitAuth() {
    if (blockedOffline()) return;
    var name = ($('#auth-name').value || '').trim();
    var pass = $('#auth-pass').value || '';
    var nick = ($('#auth-nick').value || '').trim();

    if (!name) { showAuthError('请输入账号名'); $('#auth-name').focus(); return; }
    if (!pass) { showAuthError('请输入密码'); $('#auth-pass').focus(); return; }
    /* 8 位只在**注册**时要求。登录不校验长度 —— 早期注册的 6 位密码照样能进，
     * 否则规则一改就把老玩家锁在门外。服务端同样只在注册/改密码两处把关。 */
    if (authMode === 'register' && pass.length < 8) { showAuthError('密码至少 8 位'); $('#auth-pass').focus(); return; }

    hideAuthError();
    var btn = $('#btn-auth-submit');
    btn.disabled = true;
    btn.classList.add('is-busy');   // 弱网下按钮必须看得出「正在处理」
    var res;
    try {
      res = authMode === 'register'
        ? await AuthStore.register(name, pass, nick)
        : await AuthStore.login(name, pass);
    } finally {
      btn.disabled = false;
      btn.classList.remove('is-busy');
    }
    if (!res || !res.ok) {
      showAuthError((res && res.error) || '登录失败，稍后再试');
      Sfx.play('error');
      return;
    }
    Sfx.play('submit');
    $('#auth-pass').value = '';
    /* 先把连接换成带令牌的，再进首页。
     * 注意别照老注释理解成「打开页面那条连接是未鉴权的」——首次打开的访客根本不会建连
     * （init() 见到无 session 就直接进登录页）。真正的风险是「连接建立时令牌为空」：
     * ensureConnected 的 open 回调只有 `if (tk)` 才发 auth，漏发就是未鉴权连接，
     * 服务端 30 秒后一律踢掉，而 ensureConnected 又会复用现成连接、不补发 auth。
     * 所以这里无条件换一条新连接：不管当前有没有连接、连接是什么状态。
     * 此前到底是哪个入口先建了连接，没有被完全证实，别按某条路径去推理。 */
    try { if (typeof RoomStore !== 'undefined' && RoomStore.reauth) await RoomStore.reauth(); } catch (e) { /* 连不上不影响进首页 */ }
    enterApp();
    flash(authMode === 'register' ? '账号已创建，开打吧' : '欢迎回来');
  }

  /* ---------------------------- 我的账号 ---------------------------- */

  function fmtJoin(ts) {
    var d = new Date(Number(ts) || 0);
    if (!ts || isNaN(d.getTime())) return '—';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function fillAccountInfo() {
    var s = AuthStore.session();
    if (!s) return;
    $('#acc-name').textContent = s.name || '—';
    $('#acc-nick').textContent = s.nickname || '—';
    $('#acc-since').textContent = fmtJoin(s.joinedAt);
  }

  function openAccount() {
    if (blockedOffline()) return;
    if (!AuthStore.session()) { gotoAuth(); return; }
    fillAccountInfo();
    showModalEl('account-modal');
    $('#stage').classList.add('modal-open');
    pushModalState();
    Sfx.play('select');
    // 顺手和云端对一次：账号被停用或令牌过期时，这里就该把话说清楚
    AuthStore.refresh().then(function (st) {
      if (st === 'expired') {
        closeAccount();
        gotoAuth(AuthStore.lastError() || '登录已失效，请重新登录');
        return;
      }
      fillAccountInfo();
    });
  }

  function closeAccount() {
    hideModalEl('account-modal');
    $('#stage').classList.remove('modal-open');
  }

  function openPwdModal() {
    $('#pwd-old').value = '';
    $('#pwd-new').value = '';
    $('#pwd-err').classList.add('hidden');
    showModalEl('pwd-modal');
    pushModalState();
    setTimeout(function () { $('#pwd-old').focus(); }, 60);
  }
  function closePwdModal() { hideModalEl('pwd-modal'); }

  /* ---------------------- 换头像（v89 §9.2 P1a） ----------------------
   * 只给预设，不给上传。上传的门槛不是技术而是治理：要配举报入口、审核、
   * 处置流程，三样都没有之前把任意图片放到全桌上，成本是别人来付（§9.3）。
   *
   * 48 款全是内联 SVG（js/avatar.js）：不产生 48 个请求、不占预缓存、
   * 任何 dpr 都清晰。所以这张弹窗能一次铺满又不拖慢首屏。 */

  /* 上传照片开关（P1b）。和 emojiFlag 同一套写法：CONFIG 缺省当关，
   * 另给 ?avatarupload=0/1 的运行时覆盖 —— 灰度期要能在**不改文件**的前提下
   * 验两条路径（见 rollback-contract 测试）。
   *
   * 默认是「缺省当关」而不是「缺省当开」：这个开关打开意味着把用户上传的图片
   * 放给全桌看，没有举报处置流程之前，缺省值只能是关。 */
  function avatarUploadFlag() {
    var q = '';
    try { q = new URLSearchParams(location.search || '').get('avatarupload') || ''; } catch (e) { q = ''; }
    if (q === '1') return true;
    if (q === '0') return false;
    /* 写 `=== true` 而不是 `!== false`：这个开关的缺省值必须是**关**，
     * 配置缺失、拼错、还是老版本缓存里没有这个字段，一律当关。 */
    return CONFIG.AVATAR_UPLOAD === true;
  }

  /* 我「现在实际用哪一款」：选过就是选的，没选过按 playerId 哈希。
   * 必须和 Avatar.img 用同一个判定，否则弹窗里高亮的那格和座位上的不是同一款。 */
  function myAvatarId() {
    if (typeof Avatar === 'undefined') return '';
    var pid = (AuthStore.session() || {}).playerId || '';
    return Avatar.forPlayer(pid, AuthStore.avatar());
  }

  function renderAvatarGrid() {
    var grid = $('#av-grid');
    if (!grid || typeof Avatar === 'undefined') return;
    var cur = myAvatarId();
    var html = '';
    Avatar.list().forEach(function (a) {
      var on = a.id === cur;
      html += '<button class="av-cell' + (on ? ' is-on' : '') + '" type="button"'
        + ' role="option" aria-selected="' + (on ? 'true' : 'false') + '"'
        + ' data-av="' + a.id + '" aria-label="头像 ' + (Avatar.indexOf(a.id) + 1) + '">'
        + '<img class="avatar-img" src="' + a.src + '" alt="" aria-hidden="true" draggable="false">'
        + '</button>';
    });
    grid.innerHTML = html;

    var pid = (AuthStore.session() || {}).playerId || '';
    var photo = AuthStore.photo();
    var now = $('#av-current');
    /* 预览优先显示照片：有照片时预设款并不在生效，高亮任何一格都是骗人的 */
    if (now) now.innerHTML = photo ? Avatar.photoImg(pid, photo, '') : Avatar.img(pid, cur, '');

    var row = $('#av-photo-row');
    if (row) row.classList.toggle('hidden', !avatarUploadFlag());
    var drop = $('#btn-av-drop');
    if (drop) drop.classList.toggle('hidden', !photo);
  }

  function openAvatarModal() {
    if (blockedOffline()) return;
    if (!AuthStore.session()) { gotoAuth(); return; }
    if (typeof Avatar === 'undefined') { flash('头像组件没加载出来，请刷新页面'); return; }
    $('#av-err').classList.add('hidden');
    renderAvatarGrid();
    showModalEl('avatar-modal');
    $('#stage').classList.add('modal-open');
    pushModalState();
    Sfx.play('select');
  }

  function closeAvatarModal() {
    hideModalEl('avatar-modal');
    $('#stage').classList.remove('modal-open');
  }

  /* 点一格就换 —— 不给「确定」按钮。
   * 换头像是个可以随手反悔的动作（再点一格就回去了），多一步确认只是让人多点一次；
   * 而真正不可逆的那些（删号、清空战绩）才需要拦一道。 */
  async function pickAvatar(id) {
    if (blockedOffline()) return;
    var err = $('#av-err');
    err.classList.add('hidden');
    var r = await AuthStore.setAvatar(id);
    if (!r || !r.ok) {
      err.textContent = (r && r.error) || '换不了，请稍后再试';
      err.classList.remove('hidden');
      Sfx.play('error');
      return;
    }
    renderAvatarGrid();
    syncLocalAvatar(id);
    Sfx.play('select');
  }

  /* 房间里的 player 是**快照**（服务端建房/进房时拷一份），换头像不会广播过来。
   * 本地这份跟着改，回到房间就不用等下一次状态推送才看到自己新头像。
   * 只重画「房间等待页」：牌桌重画会把手上的排布和特效一起重置，
   * 为了一个头像闪一下不值得 —— 牌桌本来每次服务端推送都会重画。 */
  /* ---------------------- 上传照片（v89 §9.3 · P1b，默认关闭） ----------------------
   * 三件事按顺序：本地压到 256×256 → 传裸二进制 → 成功后把本地会话里的版本号换掉。
   * 为什么本地压：原图 3~5MB，服务端上限 300KB。传上去再被拒，用户等的是十几秒的
   * 失败；本地 200ms 压完只传 15KB。
   * 为什么不用 base64：多 1/3 体积，而且 /api 的 JSON 体上限只有 16KB，根本塞不下。 */

  function loadImage(url) {
    return new Promise(function (res, rej) {
      var im = new Image();
      im.onload = function () { res(im); };
      im.onerror = function () { rej(new Error('decode')); };
      im.src = url;
    });
  }

  /** 把用户选的文件压成 256×256 的 JPEG blob。短边铺满 + 居中裁切（不拉伸）。 */
  async function compressAvatar(file) {
    if (typeof Avatar === 'undefined' || !Avatar.coverRect) return null;
    var url = URL.createObjectURL(file);
    try {
      var im = await loadImage(url);
      var w = im.naturalWidth || im.width;
      var h = im.naturalHeight || im.height;
      var r = Avatar.coverRect(w, h);
      if (!r.side) return null;
      var c = document.createElement('canvas');
      c.width = 256; c.height = 256;
      var ctx = c.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(im, r.sx, r.sy, r.side, r.side, 0, 0, 256, 256);
      return await new Promise(function (res) {
        /* toBlob 在极老的 WebView 上没有 —— 那种环境连 canvas 都是软的，
         * 直接放弃并提示，比传一张走样的图好。 */
        if (typeof c.toBlob !== 'function') return res(null);
        c.toBlob(function (b) { res(b); }, 'image/jpeg', 0.82);
      });
    } catch (e) {
      return null;
    } finally {
      /* 一定要释放：不释放的话每换一次头像就多留一份原图的 blob 在内存里，
       * 连着换十几次在低端机上就是几十 MB。 */
      try { URL.revokeObjectURL(url); } catch (e) { /* 忽略 */ }
    }
  }

  async function pickAvatarPhoto(file) {
    if (blockedOffline()) return;
    var err = $('#av-err');
    err.classList.add('hidden');
    if (!file) return;
    if (!/^image\/(jpeg|png)$/.test(file.type || '')) {
      err.textContent = '只支持 JPG / PNG 图片';
      err.classList.remove('hidden');
      return;
    }
    var blob = await compressAvatar(file);
    if (!blob) {
      err.textContent = '这张图读不出来，换一张试试';
      err.classList.remove('hidden');
      return;
    }
    var r = await AuthStore.uploadPhoto(blob);
    if (!r || !r.ok) {
      err.textContent = (r && r.error) || '上传失败，请稍后再试';
      err.classList.remove('hidden');
      Sfx.play('error');
      return;
    }
    renderAvatarGrid();
    syncLocalAvatar(AuthStore.avatar());
    flash('头像换好了');
    Sfx.play('select');
  }

  /* 换回预设：把照片版本号清空即可。服务端不用单独接口 ——
   * 点任意一格预设本来就会清照片，所以「换回预设」= 点当前高亮那一格。 */
  async function dropAvatarPhoto() {
    var r = await AuthStore.setAvatar(AuthStore.avatar() || '');
    if (!r || !r.ok) {
      var err = $('#av-err');
      err.textContent = (r && r.error) || '换不了，请稍后再试';
      err.classList.remove('hidden');
      return;
    }
    renderAvatarGrid();
    syncLocalAvatar(AuthStore.avatar());
    Sfx.play('select');
  }

  function syncLocalAvatar(id) {
    var room = state.room;
    if (!room || !room.players) return;
    var hit = false;
    var photo = AuthStore.photo();
    room.players.forEach(function (p) {
      if (p.id !== state.myId) return;
      if (p.avatar !== id) { p.avatar = id || ''; hit = true; }
      if (p.photo !== photo) { p.photo = photo; hit = true; }
    });
    if (hit && !$('#screen-room').classList.contains('hidden')) renderRoom(room);
  }


  async function submitPwd() {
    if (blockedOffline()) return;
    var oldPw = $('#pwd-old').value || '';
    var newPw = $('#pwd-new').value || '';
    var err = $('#pwd-err');
    var fail = function (m) { err.textContent = m; err.classList.remove('hidden'); };
    err.classList.add('hidden');

    if (!oldPw) return fail('请输入当前密码');
    if (newPw.length < 8) return fail('新密码至少 8 位');

    var btn = $('#btn-pwd-ok');
    btn.disabled = true; btn.classList.add('is-busy');
    var res;
    try { res = await AuthStore.changePassword(oldPw, newPw); }
    finally { btn.disabled = false; btn.classList.remove('is-busy'); }

    if (!res || !res.ok) { fail((res && res.error) || '修改失败，稍后再试'); Sfx.play('error'); return; }
    closePwdModal();
    flash('密码已修改');
    Sfx.play('submit');
  }

  /* 退出登录：本地会话、长连接、房内状态三样一起清。
   * 只清 localStorage 是不够的——WS 在连上时就用当时的令牌认证过了，
   * 那条连接会继续以「上一个账号」的身份挂在服务端；换人接手这台设备时，
   * 对方点一下就还在替前一个人的号打牌。 */
  function onLogout() {
    askConfirm('退出登录', '战绩留在账号里，下次登录就能拿回来。', function () {
      leaveAccountState();
      flash('已退出登录');
      gotoAuth();
    });
  }

  /** 清干净「当前这个人」的所有痕迹，退出和删号共用。
   *
   * @param {boolean} [purge] true = 删号，连**本机战绩与整场回放**一起清。
   * @param {string} [ownerPid] 要清的账号 id。**删号时必须显式传**：
   *        AuthStore.deleteAccount() 成功后会先 clearSession()，等走到这里
   *        再从会话里取 pid 只能拿到空串，而 Records.clear('') 匹配的是
   *        「没有归属的老记录」——结果是一条都没删，还把「已清空」写在了脸上。
   *        （这个洞是端到端探针抓到的：回放清了、登录态清了，唯独战绩还在。)
   *
   * 退出登录**绝不能**传 purge：战绩是留在本机方便离线看的东西，
   * 每次退出登录都清一遍等于把用户的历史反复抹掉，而他并没有要求删。
   * 这两件事在代码里只差一个布尔值，但语义上差着一次不可逆操作 ——
   * 所以参数名写成 purge 而不是 clear（clear 听起来像"清理一下"）。
   */
  function leaveAccountState(purge, ownerPid) {
    /* 账号 id 要在 AuthStore.logout() 之前落到手里。 */
    var pid = ownerPid || recordsPid();
    RoomStore.disconnect();
    if (state.room || state.roomId) cleanupRoom();
    /* 昵称是独立缓存的（LS_NICK），不清的话下一个登录的人会看到上一个人的名字，
     * 而且首页输入框非空时不会被新账号的昵称覆盖，等于拿旧昵称去开房。 */
    try { localStorage.removeItem(LS_NICK); } catch (e) { /* 忽略 */ }
    try { sessionStorage.removeItem('weile_nickname'); } catch (e) { /* 忽略 */ }
    $('#nickname-input').value = '';
    AuthStore.logout();
    state.myId = '';
    /* 删号才清本机两份副本。清的顺序无所谓，但都必须清：
     *   · lxw_records_v1  —— 本机战绩，含每条自带的那把回放副本
     *   · lxw_sessions_v1 —— 整场回放，里面有**所有对手**的 id 与昵称
     * 只清前者的话，回放页里自己的牌和对手的名字全在，删号等于只删了一半。
     *
     * ★ SessionLog.clear() 是**全清**：它没有账号归属字段（只按 roomId+创建时间存），
     * 区分不了是谁的。所以同一台手机上如果先后登过两个号，A 删号会把 B 的回放
     * 一起清掉。这是已知且可接受的代价 —— 回放是过程数据，不是战绩，
     * 而做到"只清自己的"需要先给 SessionLog 加 owner 字段（另一件事）。
     * 记录在此，免得以后被当成新 bug 查一遍。 */
    if (purge) {
      try { if (typeof Records !== 'undefined') Records.clear(pid); } catch (e) { /* 配额/隐私模式：清不掉就算了 */ }
      try { if (typeof SessionLog !== 'undefined') SessionLog.clear(); } catch (e) { /* 同上 */ }
    }
    closeAccount();
  }

  /* 删账号：不可恢复，必须二次确认 + **当场输密码**。
   * 只凭本地令牌就能删号太轻了：令牌存在浏览器里 90 天，手机借人用一下
   * 或者没锁屏，对方点两下就能把你连账号带战绩一起删掉。
   * 文案里要说清楚「想回来只能重新注册」，以及**删到什么程度** ——
   * 不能只说"删号"，用户有权知道自己的哪几份副本会被清、哪一份不会。 */
  function onDeleteAccount() {
    if (blockedOffline()) return;
    var s = AuthStore.session();
    var name = (s && s.name) || '当前账号';
    /* ★ 账号 id 必须在发删除请求**之前**取。
     * AuthStore.deleteAccount() 成功后会立刻 clearSession()，
     * 之后再问「我是谁」只能得到空串 —— 而 Records.clear('') 只会清掉
     * 「没有归属的老记录」，自己这个号的一条都不会动。
     * 结果是删号看起来成功了，战绩却完整留在手机上（探针抓到过一次）。 */
    var gonePid = recordsPid();
    askConfirm(
      '删除账号',
      '账号「' + name + '」及其全部战绩、本机记录和回放会被永久删除，无法恢复。'
      + '重新注册会是一个全新的号。'
      + '你参与过的对局会留在其他玩家的设备上，他们下次打开该回放时其中的名字会被清理。'
      + '为确认是你本人，请输入登录密码。',
      async function (password) {
        var res = await AuthStore.deleteAccount(password);
        if (!res || !res.ok) { flash((res && res.error) || '删除失败，请稍后重试'); Sfx.play('error'); return; }
        leaveAccountState(true, gonePid);   // ← purge：连本机战绩与整场回放一起清
        flash('账号已删除');
        gotoAuth();
      },
      { busyText: '删除中…', secret: true }
    );
  }

  /* ---------------------------- 房内改昵称 ---------------------------- */
  function openRename() {
    var me = state.room ? getMe(state.room) : null;
    if (!me) return;
    var input = $('#rename-input');
    input.value = me.nickname || '';
    showModalEl('rename-modal');
    $('#stage').classList.add('modal-open');
    pushModalState();
    Sfx.play('select');
    setTimeout(function () { input.focus(); input.select(); }, 60);
  }

  function closeRename() {
    hideModalEl('rename-modal');
    $('#stage').classList.remove('modal-open');
  }

  async function onRenameOk() {
    if (!state.room) return;
    var nickname = ($('#rename-input').value || '').trim();
    if (!nickname) { flash('昵称不能为空'); return; }
    var res = await RoomStore.rename(state.roomId, state.myId, nickname);
    if (!res || !res.ok) { flash((res && res.error) || '改名失败'); Sfx.play('error'); return; }
    closeRename();
    flash('昵称已改为「' + nickname + '」');
    // 同步本地持久化的昵称，避免重进房间又变回旧名
    setNickname(nickname);
  }
    return {
      setAuthMode: setAuthMode,
      showAuthError: showAuthError,
      hideAuthError: hideAuthError,
      gotoAuth: gotoAuth,
      enterApp: enterApp,
      submitAuth: submitAuth,
      fmtJoin: fmtJoin,
      fillAccountInfo: fillAccountInfo,
      openAccount: openAccount,
      closeAccount: closeAccount,
      openPwdModal: openPwdModal,
      closePwdModal: closePwdModal,
      avatarUploadFlag: avatarUploadFlag,
      myAvatarId: myAvatarId,
      renderAvatarGrid: renderAvatarGrid,
      openAvatarModal: openAvatarModal,
      closeAvatarModal: closeAvatarModal,
      pickAvatar: pickAvatar,
      loadImage: loadImage,
      compressAvatar: compressAvatar,
      pickAvatarPhoto: pickAvatarPhoto,
      dropAvatarPhoto: dropAvatarPhoto,
      syncLocalAvatar: syncLocalAvatar,
      submitPwd: submitPwd,
      onLogout: onLogout,
      leaveAccountState: leaveAccountState,
      onDeleteAccount: onDeleteAccount,
      openRename: openRename,
      closeRename: closeRename,
      onRenameOk: onRenameOk
    };
  }

  global.LXW = global.LXW || {};
  global.LXW.accountView = create;

})(typeof self !== 'undefined' ? self : this);
