/**
 * 界面装配测试
 * 跑法：node pwa/test/ui.test.js
 *
 * 只测「静态结构是否自洽」，不启动浏览器：
 *   - 每个 .screen 容器都必须在 showScreen 的切换列表里
 *     （漏登记 = 点进去整屏空白，排行榜就这样白屏过）
 *   - 切换列表里的 id 必须在 HTML 里真实存在
 *   - 排行榜的空状态 / 加载态 / 列表态三件套齐全且默认隐藏
 */
'use strict';

const { readAll: readGameAll } = require('./helpers/gameSource');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const gameJs = readGameAll();
const engineJs = fs.readFileSync(path.join(ROOT, 'js', 'engine.js'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

/* ---------- 解析 HTML 里的 screen 容器 ---------- */
const screenIds = [];
const screenRe = /<section[^>]*id="(screen-[a-z-]+)"[^>]*class="[^"]*\bscreen\b/g;
let m;
while ((m = screenRe.exec(html)) !== null) screenIds.push(m[1]);

/* ---------- 解析 showScreen 的切换列表 ---------- */
const listMatch = gameJs.match(/var screens\s*=\s*\[([^\]]+)\]/);
const listedIds = listMatch
  ? listMatch[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  : [];

console.log('\n[页面清单]');
console.log('  HTML 中 ' + screenIds.length + ' 个：' + screenIds.join(', '));
console.log('  切换表  ' + listedIds.length + ' 个：' + listedIds.join(', '));

ok(listMatch !== null, 'game.js 里能定位到 showScreen 的页面列表');
ok(screenIds.length >= 5, 'HTML 里至少有 5 个页面容器（实际 ' + screenIds.length + '）');

console.log('\n[登记完整性：漏一个就白屏]');
screenIds.forEach(function (id) {
  ok(listedIds.indexOf(id) >= 0, id + ' 已登记在切换列表里');
});

console.log('\n[反查：列表里不能有虚地址]');
listedIds.forEach(function (id) {
  ok(screenIds.indexOf(id) >= 0, id + ' 在 HTML 中真实存在');
});

console.log('\n[排行榜三态]');
['rank-loading', 'rank-list', 'rank-empty'].forEach(function (id) {
  ok(html.indexOf('id="' + id + '"') >= 0, '存在 #' + id);
});
ok(/id="rank-list"[^>]*class="[^"]*\bhidden\b/.test(html), '#rank-list 默认隐藏');
ok(/id="rank-empty"[^>]*class="[^"]*\bhidden\b/.test(html), '#rank-empty 默认隐藏');
ok(/id="rank-loading"[^>]*class="[^"]*\brank-tip\b/.test(html), '#rank-loading 是可见的提示态');

console.log('\n[排行榜交互元素]');
ok(html.indexOf('id="btn-rank-home"') >= 0, '首页有排行榜入口');
ok(html.indexOf('id="btn-rank-back"') >= 0, '排行榜有返回按钮');
ok(gameJs.indexOf("$('#btn-rank-home').addEventListener") >= 0, '入口已绑定点击');
ok(gameJs.indexOf("$('#btn-rank-back').addEventListener") >= 0, '返回已绑定点击');
ok(/function renderRank\(\)/.test(gameJs), '存在 renderRank 渲染函数');
ok(gameJs.indexOf('/api/leaderboard') >= 0, 'renderRank 走 /api/leaderboard');

console.log('\n[sharecode 必须带到请求上：裸 /api 会被网关 403]');
// 这条曾经导致排行榜长期「加载失败」：页面是 ?sharecode= 打开的，
// 但 fetch 发了裸路径，网关直接拦掉，用 curl 带参数手动测根本发现不了。
// 裸调用 = 引号直收尾，后面紧跟 , 或 ) ；拼接版本是 '...' + apiQuery()，不算
const bareApi = /fetch\(\s*['"]\/api\/[^'"]*['"]\s*[,)]/.test(gameJs);
ok(!bareApi, 'game.js 里没有裸 /api fetch（必须拼 apiQuery）', bareApi ? '存在裸调用' : '');
ok(/fetch\('\/api\/leaderboard' \+ apiQuery\(/.test(gameJs), '排行榜请求拼了 apiQuery(...)');
ok(/function apiQuery\(/.test(gameJs), '存在 apiQuery 辅助函数');
// 榜单只给 top50，必须把自己的 id 带上去，否则 51 名开外看不见自己
ok(gameJs.indexOf('apiQuery({ me: state.myId })') >= 0, '排行榜请求带上自己的 playerId（查「我的排名」用）');

const htmlHasSharecode = /withSharecode\(\s*['"]\/index\.html/.test(html);
ok(htmlHasSharecode, '版本自检 fetch 带 sharecode（否则会静默失败）');
ok(!/fetch\(\s*['"]\/index\.html['"]/.test(html), '没有裸的 /index.html fetch');

console.log('\n[解散弹窗元素]');
['dissolve-modal', 'dissolve-title', 'dissolve-desc', 'btn-dissolve-agree', 'btn-dissolve-reject'].forEach(function (id) {
  ok(html.indexOf('id="' + id + '"') >= 0, '存在 #' + id);
});
ok(/dissolveVoters/.test(gameJs), '票数分母使用 dissolveVoters（只算真人）');

console.log('\n[刷新回座]');
ok(/RoomStore\.resume\(/.test(gameJs), 'init 会尝试回座');
ok(/function tryResumeRoom\(/.test(gameJs), '存在 tryResumeRoom');
ok(/if \(readInviteRoom\(\)\) \{ handleInvite\(\); return; \}/.test(gameJs),
  '邀请链接优先于回座（朋友拉我去新房间，不能把我拽回旧房间）');
const roomStoreJs = require('fs').readFileSync(require('path').join(__dirname, '..', 'js', 'roomStore.js'), 'utf8');
ok(roomStoreJs.indexOf("require('./stateMachine.js')") >= 0, 'roomStore 的 stateMachine 路径正确（曾写成不存在的 ../core/）');
ok(roomStoreJs.indexOf("require('../core/") < 0, '没有残留的错误 require 路径');

console.log('\n[背景音乐开关]');
// BGM 是循环播放的，没有入口就等于「关不掉」。这里锁三件事：
//   1. 首页和房间页各有一个可点节点（房间页才是真正会待着听音乐的地方）
//   2. 图标有开/关两态（只换颜色的话关掉后看不出状态）
//   3. 选择要落到 localStorage，否则每次重开又响
const sfxJs = fs.readFileSync(path.join(ROOT, 'js', 'sfx.js'), 'utf8');
const cssJs = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');
const recordsCss = fs.readFileSync(path.join(ROOT, 'css', 'records.css'), 'utf8');
const styleCss = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');
const audioBtns = html.match(/data-audio-toggle/g) || [];
ok(audioBtns.length >= 2, '首页 + 房间页各有一个声音开关（实际 ' + audioBtns.length + ' 个）');
ok(html.indexOf('id="screen-home"') >= 0 && /<section id="screen-home"[\s\S]*?data-audio-toggle/.test(html),
  '首页那个开关在 #screen-home 里（开关要在进房前就能按）');
ok(/class="room-top-right"[\s\S]{0,300}?data-audio-toggle/.test(html), '房间页那个开关在顶栏右侧');
ok(/class="au-on"/.test(html) && /class="au-off hidden"/.test(html), '开着是 au-on，关着是 au-off（默认显示开）');
ok(cssJs.indexOf('.audio-toggle') >= 0, '样式表里有 .audio-toggle');
ok(/\.audio-toggle[^}]*width:\s*88px/.test(cssJs), '开关热区 88px（设计像素，够手指点）');
/* 这两条原来锁的是 isBgmEnabled / setBgmEnabled —— 那正是「只关背景音乐」的旧语义。
 * 玩家报「关了声音进牌桌还有声」，根因就是这个开关只管 BGM。
 * 现在开关是总开关，契约跟着改成 sound，并额外要求 play() 也受控（见 audio.test.js）。 */
ok(sfxJs.indexOf("lxw_sound_v1") >= 0, '声音开关存 localStorage（lxw_sound_v1；老键 lxw_bgm_v1 只在读取时做迁移）');
ok(/isSoundEnabled/.test(sfxJs) && /isSoundEnabled/.test(gameJs), 'Sfx 暴露 isSoundEnabled 且前端在用');
ok(gameJs.indexOf('function syncAudioToggles(') >= 0, '存在 syncAudioToggles');
ok(gameJs.indexOf('syncAudioToggles();') >= 0, 'init 时同步一次图标状态');
ok(/setSoundEnabled\(!Sfx\.isSoundEnabled\(\)\)/.test(gameJs), '点击是「切换」而不是「打开」');
ok(gameJs.indexOf('背景音乐已') === -1, '界面提示说的是「声音」，不是「背景音乐」（说背景音乐玩家会以为只管音乐）');

console.log('\n[分牌：标签选组 + 点牌直落]');
// 原来的「点牌选中 → 手伸到屏幕上方点空槽」在 390×844 上单手够不到。
// 现在靠一条贴着拇指的标签条选组，点手牌直接落进去，拖拽作为第二条路。
ok(html.indexOf('id="group-chips"') >= 0, '存在 #group-chips 标签条');
ok(/id="group-chips"[^>]*class="[^"]*\bhidden\b/.test(html), '标签条默认隐藏（只在分牌时可编辑态出现）');
const chipsPos = html.indexOf('id="group-chips"');
const handPos = html.indexOf('id="hand"');
ok(chipsPos > 0 && handPos > chipsPos, '标签条在手牌上方（顺序错了就等于没解决够不到的问题）');
ok(/id="group-chips"[\s\S]{0,400}?id="hand"/.test(html), '两者紧挨着，中间没别的区块');
ok(gameJs.indexOf('function renderGroupChips(') >= 0, '存在 renderGroupChips');
ok(gameJs.indexOf('function setActiveGroup(') >= 0, '存在 setActiveGroup');
ok(gameJs.indexOf('function onClearGroups(') >= 0, '存在 onClearGroups（清空重排）');
ok(gameJs.indexOf('data-clear') >= 0, '清空按钮走 data-clear');
ok(gameJs.indexOf('StateMachine.placeCard(') >= 0, '落牌走 StateMachine.placeCard（组名/张数不在这里重复抄）');
ok(gameJs.indexOf('StateMachine.nextOpenGroup(') >= 0, '满组自动顺延用 nextOpenGroup');
ok(!/state\.selected/.test(gameJs), '旧的「选中手牌」状态已清干净（残留会两套交互互相打架）');

console.log('\n[分牌：拖拽]');
ok(gameJs.indexOf('function onHandPointerDown(') >= 0, '存在 pointerdown 处理');
ok(gameJs.indexOf('function endDrag(') >= 0, '存在 endDrag');
ok(gameJs.indexOf('state.suppressTap') >= 0, '拖完要压掉浏览器补发的 click（否则一手放两张）');
ok(gameJs.indexOf('document.elementFromPoint') >= 0, '用 elementFromPoint 判定落点组');
ok(/\.card-wrap\s*\{[^}]*touch-action:\s*none/.test(cssJs), '.card-wrap 关掉 touch-action（拖动时不被页面滚动/缩放抢走）');
ok(cssJs.indexOf('.drag-ghost') >= 0, '有跟随手指的幽灵牌样式');
ok(cssJs.indexOf('.slot.drop-hover') >= 0, '有落点高亮样式');
ok(cssJs.indexOf('.slot.is-active') >= 0, '当前组有强调样式（四组同时发光就分不清该点哪）');
ok(/\.gchip\s*\{[^}]*min-height:\s*88px/.test(cssJs), '标签热区 88 设计px（≈44 物理px）');

console.log('\n[#id 契约：引用不存在的节点 = 点了没反应 / 白屏]');
// bindEvents 里每一个 $('#x').addEventListener 在节点缺失时都会抛 TypeError，
// 后面所有绑定就全废了（历史上漏登记 screen 就是这么白屏的）。
const refIds = new Set();
const idRe = /\$\('#([a-zA-Z0-9_-]+)'\)/g;
let idm;
while ((idm = idRe.exec(gameJs)) !== null) refIds.add(idm[1]);
const missingIds = Array.from(refIds).filter(function (id) {
  if (html.indexOf('id="' + id + '"') >= 0) return false;
  /* 有些节点是 JS 动态生成的（顶栏整块由 renderTopBar 用 innerHTML 重建），
   * 它们本来就不在 index.html 里。判据：game.js 自己的模板里写没写 id="x"。
   * 不放过这类就会逼着人往 HTML 里塞一个用不上的死节点 —— 那才是真的藏问题。 */
  return gameJs.indexOf('id="' + id + '"') < 0;
});
ok(refIds.size > 60, "game.js 里提取到足够多的 $('#id') 调用（实际 " + refIds.size + " 个）");
ok(missingIds.length === 0, "game.js 引用的每个 #id 在 HTML 里都真实存在", missingIds.join(', '));

console.log('\n[弱网：断网提示 + 按钮忙碌态]');
// 之前这两个都没有：断网后界面毫无变化，点了没反应就再点，最后四个请求一起排队。
ok(html.indexOf('id="net-banner"') >= 0, '存在 #net-banner 断网提示条');
ok(/id="net-banner"[^>]*class="[^"]*\bhidden\b/.test(html), '提示条默认隐藏（联网时不打扰）');
ok(html.indexOf('role="status"') >= 0 && html.indexOf('aria-live="polite"') >= 0, '提示条带 role/aria-live（读屏能播报）');
ok(cssJs.indexOf('.net-banner') >= 0, '样式表里有 .net-banner');
ok(gameJs.indexOf("window.addEventListener('offline'") >= 0, '监听了 offline');
ok(gameJs.indexOf("window.addEventListener('online'") >= 0, '监听了 online（恢复后收起）');
ok(gameJs.indexOf('navigator.onLine') >= 0, '真的用了 navigator.onLine');
ok(gameJs.indexOf('function blockedOffline(') >= 0, '断网时先拦下请求，不让玩家干等 8 秒超时');
ok(gameJs.indexOf('function pressBusy(') >= 0, '存在 pressBusy（按钮忙碌态）');
ok(cssJs.indexOf('.btn.is-busy') >= 0, '忙碌态有样式（转圈 + 变暗）');
// 每个会发网络请求的按钮都要走忙碌态，漏一个就等于留了个「点了没反应」的坑
// btn-start / btn-restart 已随「全员准备即开局」和「结算页报名制」下线，
// 换成结算页人人可见的 btn-next（开始下一局）
['btn-create', 'btn-join', 'btn-ready', 'btn-submit', 'btn-next', 'btn-add-bot', 'btn-next-back']
  .forEach(function (id) {
    ok(gameJs.indexOf("pressBusy($('#" + id + "')") >= 0, '#' + id + ' 走忙碌态');
  });
/* 另有两个按钮的忙碌态是**拿变量传的**，上面那种固定字符串断言扫不到：
 *   onLeave          —— 房间页 #btn-leave 和对局页 #btn-leave-game 共用一个处理函数
 *   onProposeDissolve —— 同理，#btn-dissolve / #btn-dissolve-game
 * 之前这两处做对了但没人守：谁把 pressBusy 删掉，测试照样全绿，
 * 而线上表现就是「点两下离开，弹一句『你不在这个房间里』」。 */
['onLeave', 'onProposeDissolve'].forEach(function (fn) {
  var at = gameJs.indexOf('function ' + fn + '(');
  var body = at < 0 ? '' : gameJs.slice(at, gameJs.indexOf('\n  }', at));
  ok(at >= 0, '能找到 ' + fn);
  ok(/pressBusy\(/.test(body), '★ ' + fn + ' 里调了 pressBusy（按钮是变量传的，只能看函数体）');
  ok(/if \(!restore\) return/.test(body), '★ ' + fn + ' 连点时短路，不发第二个请求');
});

console.log('\n[分享图保存：不谎报]');
// 之前 iOS/微信里点「保存」会无条件弹「已保存，去相册看看」，但 <a download> 在这些环境根本不生效，
// 用户去相册找不到图。现在必须按平台分支、如实反馈。
ok(gameJs.indexOf('function isIOS(') >= 0, '有 isIOS 平台探测');
ok(gameJs.indexOf('function isWeChat(') >= 0, '有 isWeChat 探测');
ok(gameJs.indexOf('function supportsDownload(') >= 0, '有 supportsDownload 能力探测');
ok(gameJs.indexOf("已保存，去相册看看") < 0, '不再出现「已保存，去相册看看」这句谎报文案');
ok(gameJs.indexOf('请长按图片保存到相册') >= 0, '微信/老 iOS 明确引导长按保存');
ok(gameJs.indexOf('长按图片即可保存到相册') >= 0, 'Web Share 不可用时引导长按保存');
ok(gameJs.indexOf('navigator.share') >= 0, '现代 iOS 优先走系统分享面板（Web Share）');
ok(gameJs.indexOf('navigator.canShare') >= 0, '分享前先 canShare 探测是否支持文件分享');

console.log('\n[复制邀请链接：校验结果]');
// 之前 writeText 不 await、execCommand 返回值不查，无条件弹「已复制」——复制失败用户也不知道。
ok(/async function onCopy\(/.test(gameJs), 'onCopy 是 async（能 await 到真实结果）');
ok(gameJs.indexOf('await navigator.clipboard.writeText') >= 0, 'Clipboard API 有 await');
ok(/ok\s*=\s*document\.execCommand\('copy'\)/.test(gameJs), 'execCommand 的返回值被接住（false = 真没复制成功）');
ok(gameJs.indexOf('复制失败，房间号') >= 0, '复制失败有兜底提示（带房间号，不会干瞪眼）');
ok(gameJs.indexOf('已复制') >= 0, '成功仍提示已复制（成功路径保留）');

console.log('\n[房内改昵称]');
// 原来昵称只在建房/加入时定，进房后改不了，想改名只能退房重进。
ok(html.indexOf('id="rename-modal"') >= 0, '存在 #rename-modal 改名弹窗');
ok(html.indexOf('id="rename-input"') >= 0, '改名弹窗里有输入框');
ok(gameJs.indexOf('function openRename(') >= 0, '存在 openRename');
ok(gameJs.indexOf('function onRenameOk(') >= 0, '存在 onRenameOk');
ok(gameJs.indexOf('RoomStore.rename(') >= 0, '改名前端调 RoomStore.rename');
/* v81 起口径统一：座位卡只有一种点击 —— 点谁看谁的战绩，**包括自己**。
 * 以前「点自己 = 改名、点别人 = 看战绩」是同一张卡两种行为，玩家点自己的名字
 * 想看战绩却弹出改名框。改名挪到卡角那支铅笔（.player-edit）。
 * 这条断言是反向重写的：旧字符串必须消失，新入口必须存在。 */
ok(gameJs.indexOf('row.dataset.pid === state.myId') < 0,
  '★ 点自己的座位卡不再触发改名（统一成看战绩）');
ok(gameJs.indexOf("closest('.player-edit')") >= 0 && gameJs.indexOf('openRename()') >= 0,
  '★ 改名走座位卡角落的铅笔（独立热区，不和卡片点击抢）');
ok(/openProfile\(row\.dataset\.pid\)/.test(gameJs), '点座位卡一律看战绩（含自己）');
ok(/gt-me" data-pid="/.test(gameJs), '★ 对局页右上角「我的座位」也带 data-pid（点自己要看得到战绩）');
ok(gameJs.indexOf("'.gt-opp, .gt-me'") >= 0, '对手座位卡与自己座位共用同一套点击判定');
ok(roomStoreJs.indexOf('function (roomId, playerId, nickname)') >= 0 && roomStoreJs.indexOf("type: 'rename'") >= 0,
  'roomStore 有 rename 的 ws 实现');
ok(gameJs.indexOf('setNickname(nickname)') >= 0, '改名后同步本地持久化昵称（防重进变回旧名）');

console.log('\n[账号：登录 / 注册 / 我的账号]');
// 身份从「浏览器里的随机 id」改成「服务端账号」：换浏览器、换手机重新登录还是同一个人。
ok(html.indexOf('id="screen-auth"') >= 0, '有独立的登录页');
ok(html.indexOf('data-auth-tab="login"') >= 0 && html.indexOf('data-auth-tab="register"') >= 0,
  '登录 / 注册双态可在同一页切换');
ok(html.indexOf('id="auth-name"') >= 0 && html.indexOf('id="auth-pass"') >= 0, '有账号名与密码输入');
ok(/id="auth-pass"[^>]*type="password"/.test(html), '密码框 type=password（不明文显示）');
ok(html.indexOf('id="auth-err"') >= 0, '错误就地显示一行（不弹 alert，手机上 alert 会锁死页面）');
ok(gameJs.indexOf('AuthStore.login(') >= 0 && gameJs.indexOf('AuthStore.register(') >= 0,
  '登录与注册都走 AuthStore');
ok(gameJs.indexOf('AuthStore.deleteAccount(') >= 0, '删档走 HTTP 接口（带 Bearer 令牌）');
ok(gameJs.indexOf('无法恢复') >= 0, '删号前有不可恢复的二次确认提示');
/* 老流程「向 WS 要删除令牌 → 凭令牌删除」已下线：
 * 签发令牌时不校验请求者身份，等于谁拿到 playerId 都能删别人的数据。 */
ok(roomStoreJs.indexOf('requestDeleteToken') < 0, 'WS 侧「要删除令牌」的流程已移除');
ok(roomStoreJs.indexOf('deleteProfile') < 0, 'WS 侧 deleteProfile 已移除');
ok(html.indexOf('id="account-modal"') >= 0, '有「我的账号」弹窗');
ok(html.indexOf('id="btn-account"') >= 0, '首页有「我的账号」入口');
ok(html.indexOf('id="btn-acc-logout"') >= 0, '能退出登录');
ok(html.indexOf('id="pwd-modal"') >= 0 && gameJs.indexOf('AuthStore.changePassword(') >= 0,
  '能改密码（服务端先验旧密码）');
/* 未登录不能让玩家点到「创建房间」才发现没身份 */
ok(gameJs.indexOf("if (!AuthStore.session())") >= 0 && gameJs.indexOf("showScreen('screen-auth')") >= 0,
  '没有登录态时首屏直接是登录页');
ok(gameJs.indexOf("st === 'expired'") >= 0, '令牌失效才踢回登录页（断网不踢人）');
ok(gameJs.indexOf("state.screen === 'auth'") >= 0, '登录页不被残留的房间广播顶回首页');
/* 令牌要跟着 WebSocket 一起出示，服务端才认身份 */
ok(roomStoreJs.indexOf("type: 'auth'") >= 0, 'WS 连接后先发 auth 出示令牌');
ok(roomStoreJs.indexOf('AuthStore.token()') >= 0, '令牌取自 AuthStore');
/* 网关要求每个请求都带 sharecode，否则 403 */
ok(gameJs.indexOf('sharecode') >= 0, 'API 请求带 sharecode（否则网关 403）');

console.log('\n[首屏性能：defer + 预缓存精简]');
// 8 个同步 script 阻塞首屏渲染；bgm 155KB 不该进 PRECACHE（懒加载，首屏白下载）。
const swJs = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const scriptTags = html.match(/<script[^>]*src=/g) || [];
const deferCount = html.match(/<script[^>]*\bdefer\b/g) || [];
ok(scriptTags.length >= 8, '有 8 个外链 script（实际 ' + scriptTags.length + '）');
/* v111 起唯一允许的非 defer 外链脚本是 js/storage.js：
 * 它必须在 head 里**同步**执行完 —— 下面两段内联脚本（分享码自愈、首帧会话判断）
 * 比任何 defer 都早，晚一步就拿不到 Store。这是唯一的例外，别再加第二个。 */
const blockingOk = (html.match(/<script[^>]*src="[^"]*"[^>]*>/g) || []).filter((t) => !/\bdefer\b/.test(t));
ok(blockingOk.length === 1 && blockingOk[0].indexOf('storage.js') >= 0,
  '★ 只有 storage.js 是阻塞加载（其余都必须 defer）', blockingOk.join(' | '));
ok(swJs.indexOf("'/assets/audio/bgm_room_loop.mp3'") < 0, 'BGM 已移出 PRECACHE（懒加载，省 155KB 首屏）');
ok(swJs.indexOf("'/assets/audio/sfx_settle.mp3'") >= 0, '音效仍进 PRECACHE（离线也要能响）');

console.log('\n[代码卫生：不遮蔽 el 工具函数]');
// game.js 顶部有 el(tag,cls,text) 造 DOM 的工具函数；局部 var el 会遮蔽它，
// 将来在那些作用域里误调 el() 会报「el is not a function」。已全部改名。
ok(gameJs.indexOf('function el(tag, cls, text)') >= 0, '存在 el 工具函数（造 DOM）');
ok(!/\bvar el\b/.test(gameJs), '没有局部 var el 遮蔽 el 工具函数');

console.log('\n[排行榜：我在哪一名]');
ok(recordsCss.indexOf('.rank-row.is-me') >= 0, '自己那一行有高亮样式');
ok(recordsCss.indexOf('.rank-gap') >= 0, '榜单末尾有省略号分隔样式');
ok(gameJs.indexOf('function rankRowHtml(') >= 0, '榜单行有统一渲染函数（榜内高亮和榜尾补行复用同一套）');
ok(gameJs.indexOf('data.me') >= 0, '读取接口返回的 me（我的名次）');
ok(gameJs.indexOf('mineInList') >= 0, '在榜内就不再重复贴一行');

console.log('\n[我的战绩：纪录条（单场最高 / 最长连胜 / 最长连败）]');
// 三项都是「历史最好」，用一块整面板 + 发丝线分栏，和上面三张独立的场次卡区分开。
const recordsJs = fs.readFileSync(path.join(ROOT, 'js', 'records.js'), 'utf8');
ok(html.indexOf('id="rp-bests"') >= 0, '有 #rp-bests 纪录条容器');
['rp-best-net', 'rp-best-win', 'rp-best-lose'].forEach(function (id) {
  ok(html.indexOf('id="' + id + '"') >= 0, '纪录条里有 #' + id);
});
ok(html.indexOf('>单场最高<') >= 0 && html.indexOf('>最长连胜<') >= 0 && html.indexOf('>最长连败<') >= 0,
  '三个标签文案齐全（单场最高 / 最长连胜 / 最长连败）');
ok(/\.rp-bests\s*\{[^}]*grid-template-columns:\s*repeat\(3,/.test(recordsCss), '纪录条是三等分栅格');
ok(/\.rp-bests\s*\{[^}]*rgba\(245, 193, 92, 0\.16\)/.test(recordsCss), '金色描边与「我的战绩」标题同色系');
ok(/\.rp-best\s*\+\s*\.rp-best\s*\{[^}]*inset 1px 0 0/.test(recordsCss), '栏与栏之间是发丝线（不是三张独立卡）');
ok(/\.rp-best-v\s*\{[^}]*font-variant-numeric:\s*tabular-nums/.test(recordsCss), '数字等宽（位数变化不跳版）');
ok(/\.rp-best-v\.up\s*\{[^}]*var\(--up-red\)/.test(recordsCss) && /\.rp-best-v\.down\s*\{[^}]*var\(--down-green\)/.test(recordsCss),
  '数字沿用全站的「红=赢 / 绿=输」口径');
ok(recordsJs.indexOf('longestLoseStreak') >= 0, '数据层算出最长连败');
ok(gameJs.indexOf("$('#rp-best-win').textContent = st.longestStreak") >= 0, '渲染时写入最长连胜');
ok(gameJs.indexOf("$('#rp-best-lose').textContent = st.longestLoseStreak") >= 0, '渲染时写入最长连败');
ok(gameJs.indexOf("$('#rp-best-net').textContent = netText(bestNet)") >= 0, '单场最高复用 netText（带 +/- 号）');
ok(gameJs.indexOf("$('#rp-best-net-wrap').className = 'rp-best-v ' + netCls(bestNet)") >= 0,
  '单场最高的颜色跟着数值走（+ 红 / - 绿 / 0 灰）');

console.log('\n[换手不串场：草稿按「场次:把:轮」作废]');
// 只用 round 判重会在换手时撞键（round 回到 1），导致牌区留着上一把的牌、点不动也放不进。
ok(gameJs.indexOf('StateMachine.handKey(room)') >= 0, 'ensureDraft 用 handKey 判重，不再只看 round');
ok(!/\bstate\.draftRound\b/.test(gameJs), '旧的 state.draftRound（只看轮次）已彻底移除');
ok(gameJs.indexOf('function pruneStaleDraft(') >= 0, '有 pruneStaleDraft 兜底（草稿里不允许出现手牌没有的牌）');
ok(gameJs.indexOf('lastSlotsHtml = null') >= 0 && gameJs.indexOf('lastTopHtml = null') >= 0,
  '换手时作废「内容没变不重绘」缓存（否则可能沿用上一把的牌区 DOM）');

console.log('\n[首页底部入口：等分栅格 + 标签绝不竖排]');
// 旧版是 flex 文字链：4 项最小宽度合计 835 > 容器 620，被挤到 88px 后 CJK 逐字换行，
// 整排变成竖排文字，「删除我的云端数据」还被撕成三列。
ok(styleCss.indexOf('grid-template-columns: repeat(4, minmax(0, 1fr))') >= 0, '入口用 4 等分栅格（不再靠 flex 挤压）');
ok(/\.entry-label\s*\{[^}]*white-space:\s*nowrap/.test(styleCss), '标签 white-space: nowrap（宁可留白也不竖排）');
ok(html.indexOf('entry-vsep') < 0, '删掉了竖分隔线（栅格布局里它会占掉一个格子）');
ok(styleCss.indexOf('.entry-vsep') < 0, '对应的 .entry-vsep 样式也清掉了');
ok(html.indexOf('class="entry-label">我的账号') >= 0, '第四项是「我的账号」（删档挪进账号弹窗，不再占一个首页入口）');
ok(html.indexOf('aria-label="我的账号"') >= 0, '第四项有完整无障碍名称');
['btn-rules', 'btn-records-home', 'btn-rank-home', 'btn-account'].forEach(function (id) {
  ok(html.indexOf('id="' + id + '"') >= 0, '入口 ' + id + ' 仍然存在（改版没弄丢绑定）');
});

console.log('\n[登录页与游戏同一套视觉]');
// 不做白底表单：那会立刻变成「网页里嵌了个第三方登录框」的观感。
/* 半径 34 并到 32：圆角收成 8/12/16/20/24/28/32/48 八档后，34 是唯一一档孤值。
 * 断言仍是「大圆角玻璃卡」这个意图，只是跟着刻度走。 */
ok(/\.auth-card\s*\{[^}]*border-radius:\s*32px/.test(styleCss), '登录面板是圆角玻璃卡');
ok(/\.auth-card\s*\{[^}]*rgba\(245, 193, 92, 0\.18\)/.test(styleCss), '面板描边用金色（与首页四入口同一配方）');
ok(/\.auth-title\s*\{[^}]*linear-gradient\(180deg, var\(--gold-light\), var\(--gold-deep\)\)/.test(styleCss),
  '标题用金色渐变（与首页 title 一致）');
ok(styleCss.indexOf('.auth-tab.is-on') >= 0, '登录 / 注册选中态有独立样式');
ok(/\.auth-tabs\s*\{[^}]*grid-template-columns:\s*1fr 1fr/.test(styleCss), '两态等分（窄屏不挤）');
ok(/\.auth-err\s*\{[^}]*rgba\(214, 40, 40, 0\.16\)/.test(styleCss), '错误条用暗红底（不是刺眼的纯红块）');
ok(styleCss.indexOf('#btn-auth-submit') >= 0, '主按钮满宽（和「创建房间」同一红）');

console.log('\n[对局页顶部：桌沿（对手头像条 + 我的座位）]');
// 旧版：串灰字 + 金分隔线 + 原生滚动条；座位卡里「✓已提交」气泡和「●已提交」文字说两遍。
// 现在座位直接贴在毡面上，状态改用「头像描边色 + 角标符号」，顶栏从 184 压到 ~153。
ok(/\.game-top\s*\{[^}]*border-radius:\s*24px/.test(styleCss), '顶部是一块圆角玻璃面板（不是分隔线 + 灰字）');
ok(/\.game-top\s*\{[^}]*linear-gradient\(180deg, rgba\(255, 255, 255, 0\.09\)/.test(styleCss),
  '面板用与首页入口同一套顶部高光渐变');
ok(styleCss.indexOf('.gt-phase') >= 0 && styleCss.indexOf('.gt-sub') >= 0, '主信息与次要信息分成两级（阶段大、把数/房号小）');
ok(gameJs.indexOf("'<span class=\"gt-phase\">'") >= 0, '阶段文案用 gt-phase 渲染');
ok(gameJs.indexOf('class="gt-sub"') >= 0, '把数/房号用 gt-sub 渲染');
// 原生滚动条是旧版顶栏最扎眼的一处
ok(/\.gt-opps\s*\{[^}]*scrollbar-width:\s*none/.test(styleCss), '座位条隐藏原生滚动条（Firefox/新 Chrome）');
ok(/\.gt-opps::-webkit-scrollbar\s*\{[^}]*display:\s*none/.test(styleCss), '座位条隐藏原生滚动条（WebKit）');
ok(styleCss.indexOf('.gt-opps.can-scroll') >= 0, '内容超宽时仍有右缘渐隐提示可滑');
// 座位搬到桌面上：没有卡片底，只有头像 + 名字 + 分数
ok(/\.gt-opp\s*\{[^}]*border-radius:\s*999px/.test(styleCss), '座位是贴在桌沿上的胶囊，不再是独立卡片');
ok(/\.gt-opp\s*\{[^}]*background:\s*rgba\(0, 0, 0, 0\.22\)/.test(styleCss), '座位底色只压暗一点，露出毡面');
ok(/\.gt-opp\s*\{[^}]*min-width:\s*150px/.test(styleCss), '座位有足够最小宽度（4 个字的昵称不被截断）');
ok(/\.gt-opp\s*\{[^}]*flex:\s*1 1 0/.test(styleCss), '座位自适应：2 人局宽一些、3 人等分、更多人横滑');
ok(styleCss.indexOf('.opp-score') >= 0 && /\.opp-score\s*\{[^}]*tabular-nums/.test(styleCss), '分数用等宽数字（像记分牌）');
// 状态只留一处：头像描边色 + 右下角角标（颜色之外再给符号，色弱也能区分）
ok(gameJs.indexOf('opp-submit-bubble') < 0 && styleCss.indexOf('.opp-submit-bubble') < 0, '删掉了压在描边上的「已提交」气泡');
ok(gameJs.indexOf('opp-state') < 0 && styleCss.indexOf('.opp-state') < 0, '删掉了占一整行的状态文字');
ok(gameJs.indexOf('class="opp-badge"') >= 0, '状态用 .opp-badge 角标渲染');
['st-thinking', 'st-submitted', 'st-forfeit', 'st-off', 'st-left', 'st-ready'].forEach(function (c) {
  ok(styleCss.indexOf('.' + c + ' .opp-avatar') >= 0, '头像描边状态色齐全：' + c);
});
['✓', '✕', '!', '—'].forEach(function (g) {
  /* v87：状态判定收进 oppSeatState()，角标从「赋值给 badge」变成「对象里的 badge 字段」。
   * 断言跟着改口径，但守的还是同一件事：四种状态各有自己的符号，不靠颜色区分。 */
  ok(gameJs.indexOf("badge: '" + g + "'") >= 0, '状态角标符号存在：' + g);
});
ok(gameJs.indexOf('title="\' + esc((p.nickname') >= 0 || /title="' \+ esc\(\(p\.nickname/.test(gameJs),
  '角标不占位，但完整状态文字进了 title（可读可读屏）');
// 牌背 ×6 纯装饰（每家人数恒定 6，3 张牌背还会误导成 3 张），还挤掉名字宽度
ok(gameJs.indexOf('opp-back') < 0 && styleCss.indexOf('.opp-back') < 0, '删掉了 3 张牌背 + ×6 的装饰块');
ok(gameJs.indexOf('getCardBackImg') < 0, '顺带删掉了只为牌背存在的 getCardBackImg');
// AI 座位与房间页同一套语言：虚线描边 + 机器人图标
ok(gameJs.indexOf("'🤖'") >= 0, '顶栏里 AI 用机器人图标');
ok(/\.opp-avatar\.is-bot\s*\{[^}]*dashed/.test(styleCss), 'AI 头像是虚线描边（与房间页一致）');
// 我也在桌边：自己的座位用同一套头像语言，金色描边
ok(gameJs.indexOf('opp-avatar is-me') >= 0, '顶栏里有「我的座位」头像');
ok(/\.opp-avatar\.is-me\s*\{[^}]*245, 193, 92/.test(styleCss), '我的座位用金色描边标出');
ok(gameJs.indexOf('我的分') >= 0 && /\.gt-me \.gt-score\s*\{[^}]*font-size:\s*40px/.test(styleCss),
  '我的分仍是顶栏里最大的数字（记分锚点没丢）');

console.log('\n[对局页牌区：满宽桌带（左牌右标）]');
// 旧版每组 width:max-content，飘三叶 3 张只占 406/670，右边 264px 是没来由的空毡面。
ok(/\.slot\s*\{[^}]*width:\s*100%/.test(styleCss), '每一条桌带吃满宽度（不再是 max-content 挤在左边）');
ok(/\.slot\s*\{[^}]*border-left:\s*4px solid var\(--slot-color\)/.test(styleCss), '桌带左侧用组色竖条标识');
ok(/\.slot\s*\{[^}]*background:\s*transparent/.test(styleCss), '桌带不画方框（空出来的那半边就是毡面）');
ok(/\.slots\s*\{[^}]*justify-content:\s*space-evenly/.test(styleCss), '桌带在竖直方向均分（2 组时也不会挤在顶部）');
ok(/\.slot-meta\s*\{[^}]*align-items:\s*flex-end/.test(styleCss), '组信息右对齐成一列（不同张数的桌带右边缘也齐）');
ok(gameJs.indexOf('class="slot-meta-main"') >= 0, '组名与完成度合成一行渲染');
// 桌带右边原来是空白，现在写这组怎么算赢
ok(gameJs.indexOf('var SLOT_HINT') >= 0 && /\.slot-hint\s*\{[^}]*font-size/.test(styleCss),
  '桌带右下角有一句话规则（填空 + 新玩家不用翻规则页）');
['single', 'tenhalf', 'piaosanye', 'douniu'].forEach(function (k) {
  ok(new RegExp(k + ":\\s*'").test(gameJs.slice(gameJs.indexOf('var SLOT_HINT'))), '规则提示覆盖：' + k);
});
// 牌的大小随组内张数自适应：1~3 张用最大尺寸，斗牛 5 张按剩余宽度均分
ok(gameJs.indexOf('function slotCardSize') >= 0 && gameJs.indexOf('var BAND_INNER_W') >= 0,
  '牌尺寸按组内张数计算（不会把 5 张牌挤出桌带）');
ok(/var SLOT_CARD_W = 144/.test(gameJs), '桌带里的牌放大到 144（原 120，纵向空间从顶栏省出来的）');
// 空位不该抢注意力：原来按组色染成蓝/金/红的三个大虚线框
ok(/\.card-box\.empty\s*\{[^}]*rgba\(255, 255, 255, 0\.15\)/.test(styleCss), '空位改成淡中性虚线（不再按组色抢眼）');
ok(styleCss.indexOf('.slot-head') < 0, '删掉了旧的组标题行（信息已并入右下角）');

console.log('\n[结算面板：同分时显示「比哪张」]');
// 用户报过「都 10.5 凭什么他赢」「牛牛为什么不是我」——光看「10.5点」「牛牛」看不出差别，
// 所以结算行要把真正参与比牌的那张牌写出来。
ok(gameJs.indexOf("el('span', 'rt-cmp', '比 ' + en.decider)") >= 0, '结算行渲染决胜牌徽标（比 10♠）');
ok(/if \(en\.decider && \(g\.group === 'tenhalf' \|\| g\.group === 'douniu'\)\)/.test(gameJs),
  '只在十点半 / 斗牛显示决胜牌（比大小、飘三叶不显示）');
ok(/\.rt-cmp\s*\{[^}]*white-space:\s*nowrap/.test(styleCss), '决胜牌徽标不折行（不会在「比」和牌面之间断开）');
ok(/decider:\s*deciderLabel\(mode, e\.hand\)/.test(engineJs), '结算结果里带 decider 字段');
ok(engineJs.indexOf('function deciderLabel') >= 0 && engineJs.indexOf('tenHalfDecider') >= 0
  && engineJs.indexOf('douNiuDecider') >= 0, '十点半 / 斗牛各有一个决胜牌取值函数');

console.log('\n[回放：就位态不能丢入口]');
/* 报了名、回到房间之后，结算页连同它的「本场过程」一起消失。
 * 如果房间页没有自己的入口，这一局的复盘就只剩战绩页能翻到 —— 而战绩页
 * 是「退房之后」才去的地方，人还在房间里根本想不到。 */
ok(html.indexOf('id="btn-prev-replay"') >= 0, '房间页有「看上一局过程」按钮');
ok(/id="btn-prev-replay"[^>]*class="[^"]*\bhidden\b/.test(html), '默认隐藏（非就位态不出现）');
ok(/openReplay\(\{ prev: true \}\)/.test(gameJs), '点它是打开回放弹窗');
ok(gameJs.indexOf("isPrev ? '上一局' : '这一局'") >= 0, '就位态标题写「上一局」（这一局已经打完了）');
ok(/if \(nextWait && !meLate\) \{\s*\n\s*canPrev = packHistory/.test(gameJs),
  '只有就位态才算「有东西可看」，且结算期才进来的人不算（他没打上一局）');
ok(gameJs.indexOf("prevBtn.classList.toggle('hidden', !canPrev)") >= 0, '没内容就不显示（不留点了没反应的按钮）');
ok(styleCss.indexOf('.room-prev') >= 0, '样式表里有 .room-prev');

console.log('\n[结束本局：名字、出口、口径]');
/* 三件事必须一起成立，少一件就露馅：
 *   名字   —— 它不散房，所以不能叫「解散」
 *   出口   —— 就位态的「结束本局」必然被状态机拒，得换成「回结算页」
 *   口径   —— 作废的一局不许进战绩（见 server/test/dissolve-archive.test.js） */
ok(html.indexOf('>结束本局<') >= 0, '房间页与对局页的按钮都叫「结束本局」');
ok(html.indexOf('>发起解散<') < 0 && html.indexOf('>同意解散<') < 0,
  '不再有「解散」字样的按钮（名字和实际作用不一致）');
ok(gameJs.indexOf('这一局一分还没打，结束后不计入战绩') >= 0,
  '★ 投票弹窗：一分没打时明说不计入战绩');
ok(gameJs.indexOf('按当前分数结账，照常计入战绩') >= 0,
  '★ 投票弹窗：真打过就说清照常计入（不能一概说「不计入」骗人）');
ok(gameJs.indexOf("room.endReason === 'dissolve'") >= 0, '结算页有「中途结束」的说明分支');
ok(gameJs.indexOf('本局一分还没打就结束了') >= 0 && gameJs.indexOf('本局提前结束，按当前分数结账') >= 0,
  '★ 结算页按同样口径分两种说法');
ok(gameJs.indexOf('if (room.voided) return;') >= 0, '★ 本机战绩也跳过作废的一局（和云端同一口径）');

console.log('\n[就位态：反悔的出口]');
/* 「开始下一局」以前是单向门：误点之后除了退房重进没别的办法。
 * 同一屏上「准备」能取消、「报名」不能取消，本身就不对称。 */
ok(html.indexOf('id="btn-next-back"') >= 0, '房间页有「回结算页」按钮');
ok(/id="btn-next-back"[^>]*class="[^"]*\bhidden\b/.test(html), '默认隐藏（只在就位态出现）');
ok(/disBtn\.classList\.toggle\('hidden', nextWait\)/.test(gameJs), '★ 就位态把「结束本局」藏起来（否则点了必报错）');
ok(/backBtn\.classList\.toggle\('hidden', !nextWait\)/.test(gameJs), '就位态才露出「回结算页」');
ok(gameJs.indexOf('RoomStore.unWantNext') >= 0, '点它真的调了撤回接口');

console.log('\n[规则页：把平局怎么比写清楚]');
ok(html.indexOf('就比那张 <b>10</b> 的花色') >= 0, '十点半写明「都是 10.5 比那张 10 的花色」');
ok(html.indexOf('同牛型比五张里最大的那张') >= 0, '斗牛写明「同牛型比五张里最大的那张」');
ok(html.indexOf('王不参与</b>，取除王以外最大的那张') >= 0, '斗牛写明「有大王时王不参与比大小」');
ok(html.indexOf('J/Q/K 只是半点、牌面不比大小') >= 0, '十点半写明 J/Q/K 的牌面不参与比牌');

console.log('\n[弹窗层级：确认框必须永远在最上层]');
/* 用户报过「点退出登录 / 删除账号没反应，停在操作界面」。
 * 根因：所有 .modal 都是 z-index:50，而账号弹窗、改密码弹窗写在确认框之后，
 * 同层级时 DOM 靠后的画在上面 → 确认框被整个盖住，看起来像没响应。
 * 这类问题静态测一遍就能拦住，不用等人工点。 */
function zOf(sel) {
  const re = new RegExp(sel.replace(/[.#]/g, '\\$&') + '\\s*\\{[^}]*z-index:\\s*(\\d+)');
  const mm = re.exec(styleCss);
  return mm ? Number(mm[1]) : null;
}
const zBase = zOf('.modal');
const zConfirm = zOf('#confirm-modal');
ok(zBase !== null, '.modal 有基础层级');
ok(zConfirm !== null && zConfirm > zBase, '确认框层级高于基础弹窗（' + zConfirm + ' > ' + zBase + '）');
const zPwd = zOf('#pwd-modal');
ok(zPwd !== null && zConfirm > zPwd, '确认框也高于改密码弹窗（' + zConfirm + ' > ' + zPwd + '）');
const docConfirmAt = html.indexOf('id="confirm-modal"');
const docAccountAt = html.indexOf('id="account-modal"');
ok(docAccountAt > docConfirmAt, '账号弹窗确实写在确认框之后（当初就是这么被盖住的）');
ok((zOf('#account-modal') || zBase) < zConfirm, '账号弹窗层级仍低于确认框（否则会再次盖住它）');
/* 返回键：账号弹窗是最后加的，一度漏在 popstate 里 → 手机上按返回关不掉 */
ok(/addEventListener\('popstate',[\s\S]{0,400}?closeAccount\(\)/.test(gameJs), '返回键会关掉账号弹窗');

console.log('\n[交互：离开对局、进度反馈、文案准确性]');

/* 「发起解散」和「自己想走」是两件事：解散要全员同意，离开只需自己决定。
 * 以前对局页根本没有离开入口，想退出只能关页面等 90 秒被判弃局。 */
ok(html.indexOf('id="btn-leave-game"') >= 0, '对局页有独立的「离开」按钮');
ok(/btn-leave-game'\)\.addEventListener\('click', onLeave\)/.test(gameJs), '这个按钮绑的是 onLeave');
/* 三个「离开」入口共用一个 onLeave，忙碌态必须给到**玩家真正点的那个**。
 * 以前按 phase 猜（phase !== WAITING 就取 #btn-leave-game），
 * 但结算页和就位态都是 SETTLED —— 人在结算页时猜出来的是对局页那颗，
 * 忙碌态加到一个 display:none 的按钮上，点的那个毫无反馈，人只会再点一次。 */
ok(/function firstShown\(/.test(gameJs), '有 firstShown（按祖先链上的 .hidden 判可见性）');
ok(/firstShown\(\['btn-leave', 'btn-leave-game', 'btn-back-room'\]\)/.test(gameJs),
  '★ onLeave 按可见性选按钮，三个入口都在候选里');
ok(!/state\.room\.phase !== StateMachine\.PHASE\.WAITING\) \{\s*btn = \$\('#btn-leave-game'\)/.test(gameJs),
  '★ 不再按 phase 猜是哪个页面');
ok(/btn-leave-game[^>]*>离开房间</.test(html), '对局页文案也是「离开房间」（和另外两个入口一致）');
ok(gameJs.indexOf('弃局离开？') >= 0, '对局中离开的确认框标题写明「弃局」');
/* 文案要说清三件事，缺一件都可能让人误点：
 *   ① 现在走算弃局（不是免费退出）
 *   ② 第几轮（让人知道赔的是哪一局）
 *   ③ 现在多少分（让人算得出赔多少）
 * 「按你现在的分数」这种抽象说法以前就够，但玩家看不出具体数字。 */
ok(/现在离开算弃局/.test(gameJs), '文案点了「算弃局」');
ok(/第 ' \+ roundNo \+ ' 轮正在进行/.test(gameJs), '文案带上了第几轮');
ok(/现在 ' \+ me\.score \+ ' 分/.test(gameJs), '文案带上了当前分数');
ok(/其他人这局也会就此结束/.test(gameJs), '文案说明了会连累其他人');

/* 判定「算不算弃局」不能只看本地 phase：手机上切后台再回来，
 * 本地可能还停在 WAITING，服务端其实已经在分牌了。 */
ok(/function fetchRoomSnapshot/.test(gameJs), '离开前会向服务端要一次最新快照');
ok(/RoomStore\.peekRoom\(/.test(gameJs), '走的是只读的 peekRoom');
/* 不能用 reconnect 来读：它会补分牌时限，反复点「离开 / 取消」就能无限续命 */
ok(!/RoomStore\.reconnect\(state\.roomId/.test(gameJs), '没有拿 reconnect 当只读接口用');
ok(/snap = await fetchRoomSnapshot\(\)/.test(gameJs), 'onLeave 真的等了这个快照');
ok(/pressBusy\(btn, '核对中…'\)/.test(gameJs), '核对期间按钮有「核对中…」反馈（不是点了没反应）');
ok(/var fresh = !!snap/.test(gameJs) && /没连上服务端核对最新进度/.test(gameJs),
  '拿不到快照时明确告知「没核对上」，不假装确认过');
ok(/RoomStore\.getMode\(\) === 'ws'/.test(gameJs), '本地演示模式不会报「没连上服务端」');

/* 确认框以前「点一下就先关、再执行回调」，删账号这种要走网络的操作于是变成
 * 弹窗立刻消失 + 十几秒无反馈，人只会反复点。 */
ok(/async function onConfirmOk/.test(gameJs), '确认框改成等回调跑完再关');
ok(/删除中…/.test(gameJs), '删账号时按钮显示「删除中…」而不是立刻消失');

/* 两处过期的文案：接入账号、数据挪出项目目录之后就不再成立了 */
ok(html.indexOf('不用登录') < 0, '战绩页不再写「不用登录」（现在必须登录）');
ok(gameJs.indexOf('没有登录') < 0 || gameJs.indexOf("'不用登录'") < 0, '同上，脚本里也不再拼这句');
ok(gameJs.indexOf('重新发布会重置') < 0, '云端档案不再写「重新发布会重置」（数据在项目外，跨部署存活）');

console.log('\n[容错：连接级致命错误的去处]');
/* 被管理员停用/删号后，服务端会踢掉连接。以前前端把「没有 reqId 的 error」
 * 直接丢弃 → 不停重连、永远失败、界面一句话都不说。 */
ok(/onFatal: function/.test(fs.readFileSync(path.join(ROOT, 'js', 'roomStore.js'), 'utf8')),
  'RoomStore 有 onFatal（连接级致命错误）');
ok(/RoomStore\.onFatal\(/.test(gameJs), '主控订阅了 onFatal');
ok(/authFatalMsg/.test(gameJs) && /gotoAuth\(msg\)/.test(gameJs), '身份类错误会把人送回登录页，不只弹一句 toast');

console.log('\n[无障碍]');
const styleCssAll = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');
ok(/@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(styleCssAll),
  '尊重系统「减弱动态效果」（以前 0 处，发牌/飞牌/分数滚动全都关不掉）');
ok(/:focus-visible/.test(styleCssAll), '键盘焦点可见（以前只有 input:focus，按钮走 Tab 完全看不见）');
ok(/id="room-input"[^>]*aria-label=/.test(html), '房间号输入框有可读标签');
/* ★ 立场翻转（2026-10-29）：这两条原来是 `ok(!/user-scalable=no/…)` ——
 * 断言「**不**禁止缩放」，理由写的是「1.0 倍浏览器里连字都看不清」。
 * 现在反过来。原因不是那句理由错了，是**前提变了**：
 *   牌桌改成整体按 750 设计空间缩放（#stage 的 transform）之后，手牌尺寸、组槽位置、
 *   拖拽命中区全部按那套像素算死。浏览器再叠一层页面缩放，牌会变小、命中区整体偏移，
 *   拖牌时点不中——真机实测反馈就是这个。而且缩放状态会一直留着，玩家得自己捏回去。
 * 代价必须跟着写出来：**这牺牲了页面级缩放的无障碍能力**，视力不好的用户没法把字放大。
 * 正确的补偿是一个「牌面放大」设置项，不是把缩放开关放回去（尚未做，见 REVIEW P10-3）。
 * 三处一起的细验在 pwa/test/zoom-lock.test.js。 */
ok(/user-scalable=no/.test(html), '禁止页面级缩放（牌桌自带整体缩放，叠两层会拖不准）');
ok(/maximum-scale=1\.0/.test(html), '同时锁 maximum-scale=1.0');

console.log('\n[Service Worker 更新不能打断分牌]');
ok(/window\.LXWBusy\s*=/.test(gameJs), '页面暴露了「正忙」判据给 SW 用');
ok(/reloadWhenIdle/.test(html), 'SW 接管/版本不一致时先等空闲再刷新');
ok(/LXWBusy\(\)/.test(html), '刷新前确实问了这一句');

console.log('\n[Web Share：邀请与战绩图都要走系统面板]');
/* 邀请链接是这类游戏唯一的传播路径，每多一步都会掉人。
 * iOS 复制链接后还要切微信、找群、粘贴，一共四步；系统面板两步到位。 */
ok(/navigator\.share\s*\(/.test(gameJs), '调用了 navigator.share');
ok(/onCopy[\s\S]{0,1200}navigator\.share/.test(gameJs), '★ 邀请好友（onCopy）里就用了 Web Share');
ok(/AbortError/.test(gameJs), '★ 用户取消（AbortError）被当成正常结束，不弹「已复制」');
/* 必须在第一个 await 之前调用：Safari 会把 await 之后的 share() 当成非用户手势拒绝。
 * 这里校验 share 出现在 onCopy 里第一个 await 之前。 */
(function () {
  var body = gameJs.slice(gameJs.indexOf('async function onCopy('));
  body = body.slice(0, body.indexOf('\n  }'));
  /* 必须先剥注释：这段代码的注释里就写着「这里在第一个 await 之前」，
   * 不剥的话检查会命中注释里的那个词，把自己判成失败。 */
  var code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  var shareAt = code.indexOf('navigator.share');
  var firstAwait = code.indexOf('await');
  ok(shareAt > 0, 'onCopy 里有 share');
  ok(firstAwait < 0 || shareAt < firstAwait,
    '★ share 在第一个 await 之前（否则 Safari 判定非用户手势直接拒）');
})();
/* 战绩图分享以前卡了 isIOS()，Android Chrome 明明支持却掉进「长按保存」 */
ok(!/if \(isIOS\(\) && !isWeChat\(\) && navigator\.canShare\)/.test(gameJs),
  '★ 不再用 isIOS() 卡死文件分享（Android Chrome 也支持 canShare）');
ok(/!isWeChat\(\) && navigator\.canShare/.test(gameJs), '改为只排除微信内置浏览器');
ok(/canShare\(\{\s*files:/.test(gameJs), '调 share 前先用 canShare 探测，不硬试');

console.log('\n[安装包里的访问凭据不能写死]');
/* manifest 的 start_url 一旦带上 sharecode，这个凭据就被固化进安装包。
 * 轮换后所有已安装的桌面图标立刻 403，而失败页只会说「让房主重发链接」——
 * 已经装到桌面的人没有入口去拿新链接。 */
(function () {
  var fs = require('fs');
  var path = require('path');
  var mf = fs.readFileSync(path.join(__dirname, '..', 'manifest.webmanifest'), 'utf8');
  var manifest = JSON.parse(mf);
  ok(manifest.start_url === '/', '★ start_url 是 "/"，没有把 sharecode 固化进安装包');
  /* 不查具体某个值，查「sharecode」这个参数名有没有渗进安装包 ——
   * 否则换个房号这条断言就失去意义（旧写法绑死了那一个 sharecode）。 */
  ok(mf.indexOf('sharecode') < 0, 'manifest 里没有任何 sharecode 参数');
  ok(manifest.scope === '/', 'scope 仍是整站');

  /* ------------------------------------------------------------------
   * id：写错了会让**已安装的用户**被识别成另一个应用
   *
   * 不填 id 时，浏览器把 start_url 解析后的结果当默认身份。这里 start_url 是 "/"，
   * 默认身份就是 "https://<host>/"。显式写 "/" 解析后是同一个值 → 老用户平滑。
   * 但如果哪天有人写成 "/?app=lxw" 或带上 sharecode，身份就变了：
   * 桌面图标还在，点开却是「另一个应用」，两套 storage、两套 SW 缓存。
   * 所以这条断言锁的是「id 必须恒等于 /」，不是「有个 id 就行」。
   * ------------------------------------------------------------------ */
  ok(manifest.id === '/', '★ id 是 "/"（与不填时的默认身份一致，老用户不会被当成新应用）',
    JSON.stringify(manifest.id));

  /* ------------------------------------------------------------------
   * maskable：必须是**另一张图**，且内容要落在安全圆内
   *
   * purpose:"maskable" 的语义是「系统会拿任意形状来裁你」，安全区是
   * 以中心为圆心、直径 = 边长 80% 的圆。原图是一张带金色圆角边框的设计稿，
   * 边框角点距中心 325px > 安全半径 205px → 圆形裁切必断四角。
   * 复用同一张图就是「假装声明了 maskable」，装了桌面反而更难看。
   * ------------------------------------------------------------------ */
  (function () {
    var fs = require('fs');
    var path = require('path');
    var dir = path.join(__dirname, '..', 'icons');
    var any = manifest.icons.filter(function (i) { return /(^|\s)any(\s|$)/.test(i.purpose || ''); });
    var maskable = manifest.icons.filter(function (i) { return /maskable/.test(i.purpose || ''); });

    ok(any.length >= 2, 'any 图标至少两档尺寸', any.length + ' 个');
    ok(maskable.length >= 1, '★ 声明了 maskable 图标（安卓会按各种形状裁切）', maskable.length + ' 个');

    var anySrc = any.map(function (i) { return i.src; });
    var reused = maskable.filter(function (i) { return anySrc.indexOf(i.src) >= 0; });
    ok(reused.length === 0, '★ maskable 没有复用 any 那张图（复用 = 声明了却会被裁坏）',
      reused.map(function (i) { return i.src; }).join(','));

    /* Chrome 的安装门槛：至少一个 192 和一个 512，且 purpose 里得有 any 或 maskable */
    var sizes = (any.concat(maskable)).map(function (i) { return i.sizes; });
    ok(sizes.indexOf('192x192') >= 0, '有 192×192（Chrome 安装门槛之一）');
    ok(sizes.indexOf('512x512') >= 0, '有 512×512（Chrome 安装门槛之一）');

    /* 文件必须真实存在 —— manifest 里写了个不存在的路径，浏览器只会静默跳过该图标 */
    var missing = manifest.icons.filter(function (i) {
      return !fs.existsSync(path.join(dir, path.basename(i.src)));
    });
    ok(missing.length === 0, '★ manifest 里引用的每个图标文件都真实存在',
      missing.map(function (i) { return i.src; }).join(' '));

    /* 尺寸字段要和文件实际像素一致：写 512 但图是 256，Chrome 会按 512 排版（变模糊） */
    var wrong = [];
    manifest.icons.forEach(function (i) {
      var f = path.join(dir, path.basename(i.src));
      if (!fs.existsSync(f)) return;
      var buf = fs.readFileSync(f);
      /* PNG 头：8 字节签名后是 IHDR，宽高各 4 字节大端，偏移 16 和 20 */
      if (buf.length > 24 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
        var w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
        if (i.sizes !== w + 'x' + h) wrong.push(i.src + ' 声明' + i.sizes + ' 实际' + w + 'x' + h);
      }
    });
    ok(wrong.length === 0, '★ 图标的 sizes 字段与文件实际像素一致', wrong.join('; '));
  })();

  /* ------------------------------------------------------------------
   * screenshots：安卓安装提示里的应用预览图
   *
   * 不是必填项，填错也不影响安装 —— 浏览器只会静默忽略。正因为「错了没声音」，
   * 才需要断言：文件不存在、sizes 写错、form_factor 标错都会让它白写。
   * ------------------------------------------------------------------ */
  (function () {
    var fs = require('fs');
    var path = require('path');
    var shots = manifest.screenshots || [];
    ok(shots.length >= 2, '★ 提供了至少两张安装预览图', shots.length + ' 张');

    var dir = path.join(__dirname, '..', 'icons', 'screenshots');
    var miss = shots.filter(function (s) { return !fs.existsSync(path.join(dir, path.basename(s.src))); });
    ok(miss.length === 0, '★ 预览图文件都存在',
      miss.map(function (s) { return s.src; }).join(' '));

    /* 从 WebP 文件头里读真实像素。三种容器格式位置不一样，都要认：
     *   VP8X（带扩展信息，Pillow 存 RGB 常用这个）→ 宽高各 3 字节在 24/27
     *   VP8 （有损单帧）→ 同步码后 2 字节各 14 位
     *   VP8L（无损）→ 1 字节签名后一个 32 位里挤着两个 14 位
     * 读不出来就返回 null，由断言报错，不静默放过。 */
    function webpSize(buf) {
      if (buf.length < 30) return null;
      if (buf.toString('ascii', 0, 4) !== 'RIFF') return null;
      if (buf.toString('ascii', 8, 12) !== 'WEBP') return null;
      var fourcc = buf.toString('ascii', 12, 16);
      if (fourcc === 'VP8X') {
        return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
      }
      if (fourcc === 'VP8 ') {
        return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      }
      if (fourcc === 'VP8L') {
        var bits = buf.readUInt32LE(21);
        return { w: 1 + (bits & 0x3fff), h: 1 + ((bits >> 14) & 0x3fff) };
      }
      return null;
    }

    var bad = [];
    shots.forEach(function (s) {
      var f = path.join(dir, path.basename(s.src));
      if (!fs.existsSync(f)) return;
      var size = webpSize(fs.readFileSync(f));
      if (!size) { bad.push(s.src + ' 读不出尺寸'); return; }
      if (s.sizes !== size.w + 'x' + size.h) {
        bad.push(s.src + ' 声明' + s.sizes + ' 实际' + size.w + 'x' + size.h);
      }
      /* 竖屏图必须比宽高，否则真机上会被装进横向的预览框里压扁 */
      if (s.form_factor === 'narrow' && size.h <= size.w) {
        bad.push(s.src + ' 标了 narrow 却是横图');
      }
    });
    ok(bad.length === 0, '★ 预览图的 sizes / form_factor 与文件实际一致', bad.join('; '));
  })();

  var storageJs = fs.readFileSync(path.join(__dirname, '..', 'js', 'storage.js'), 'utf8');
  ok(/Store\.write\(KEY,\s*cur\)/.test(html), '★ 首页会把当前 sharecode 存起来');
  ok(/var KEY = Store\.KEYS\.SHARE_CODE/.test(html), 'key 从唯一清单取（v111 收口，不在页面里写死）');
  ok(/SHARE_CODE:\s*'lxw_sharecode_v1'/.test(storageJs), '用的独立 key，不和登录态混在一起');
  ok(/history\.replaceState/.test(html), '★ 补全用 replaceState（不往用户历史里塞记录）');
  /* 补全必须早于 defer 脚本，否则它们读 location.search 时还是空的 */
  var fillAt = html.indexOf('Store.write(KEY, cur)');
  var firstScriptAt = html.indexOf('js/engine.js');
  ok(fillAt > 0 && fillAt < firstScriptAt, '★ 补全脚本在首个 defer 脚本之前执行');

  var sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
  ok(/已添加到桌面的话/.test(sw), '★ 失效页给了「已安装用户怎么办」的指引');
})();

console.log('\n[新手引导：分步，不是一屏文字]');
(function () {
  ok(html.indexOf('id="guide-modal"') > 0, '有独立的分步引导弹窗');
  var steps = (html.match(/class="guide-step"/g) || []).length;
  ok(steps === 4, '★ 4 步（实际 ' + steps + '）');
  ok(html.indexOf('id="guide-dots"') > 0, '有进度点');
  ok(html.indexOf('id="guide-skip"') > 0, '可以跳过');
  ok(html.indexOf('id="guide-prev"') > 0 && html.indexOf('id="guide-next"') > 0, '有上一步/下一步');

  /* 第一步之外都要带 hidden，否则进去会看到 4 屏文字叠在一起 */
  var firstHidden = /data-step="0"[^>]*hidden/.test(html) === false;
  ok(firstHidden, '第一步默认可见');
  var laterHidden = (html.match(/data-step="[123]"[^>]*hidden/g) || []).length;
  ok(laterHidden === 3, '★ 其余 3 步默认隐藏（实际 ' + laterHidden + '）');

  ok(/function renderGuide\(/.test(gameJs), '有渲染函数');
  ok(/function openGuide\(/.test(gameJs), '有打开函数');
  ok(/\$\('#btn-rules'\)\.addEventListener\('click', openGuide\)/.test(gameJs),
    '★ 「玩法规则」现在打开的是引导，不是直接甩一整屏文字');
  ok(/看完整规则/.test(gameJs), '★ 最后一步给「看完整规则」的出口（引导与查细节分工）');
  ok(/ST\.KEYS\.GUIDE_SEEN/.test(gameJs), '★ 记「看过」，不然每次进来都弹（键在 storage.js 的唯一清单里）');
  ok(/\$\('#guide-modal'\)\.classList\.contains\('hidden'\)\)\s*\{\s*closeGuide\(\)/.test(gameJs),
    '★ Esc 能关引导');
  /* 这条以前写的是 /closeGuide\(\);\s*\n\s*\$\('#rules-modal'\)/，看着像在验 popstate，
   * 实际匹配到的是「引导最后一屏跳规则」那段（那里紧跟的是 showModalEl）。
   * 更糟的是它反过来逼着产品代码里留一行没意义的 $('#rules-modal').classList.add('hidden')。
   * 现在直接验 popstate 处理函数里到底是哪几个关闭函数被调用。 */
  ok(/closeGuide\(\);[\s\S]{0,120}hideModalEl\('rules-modal'\)/.test(gameJs),
    '返回键（popstate）里引导和规则都能关掉');
})();

/* ---------- 分牌倒计时：60 秒到点会被判弃权，界面必须让人看得见还剩多久 ---------- */
console.log('\n[分牌倒计时]');
ok(gameJs.indexOf('id="gt-timer"') >= 0, '顶栏里有倒计时元素 #gt-timer');
ok(/function syncSplitTimer\(/.test(gameJs), '存在 syncSplitTimer（按最新房间状态刷新倒计时）');
ok(gameJs.indexOf('room.splitEndsAt') >= 0, '倒计时截止时刻来自服务端下发的 splitEndsAt');
ok(/var skew = \(Number\(room\.now\) \|\| Date\.now\(\)\) - Date\.now\(\)/.test(gameJs),
  '★ 用服务端时间扣掉本机时钟偏差（手机时间不准时倒计时不会整体偏掉）');
ok(/is-warn/.test(gameJs) && /left <= 15/.test(gameJs), '最后 15 秒有警示态');
ok(gameJs.indexOf("if (id !== 'screen-game') stopSplitTick()") >= 0,
  '离开对局页就停表（不留一个每秒空跑的 interval）');
ok(/function tickSplitTimer\(/.test(gameJs) && /tabular-nums/.test(
  fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8')),
  '数字用等宽字体（tabular-nums），每秒跳动不会左右抖');

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
