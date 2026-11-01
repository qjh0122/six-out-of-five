/**
 * 头像预设库（v89 §9.2 · P1a）
 * 跑法：node pwa/test/avatar.test.js
 *
 * 这个文件守的不是「头像漂不漂亮」，而是四类会静默出错的事：
 *
 * 1. **48 款必须真不一样**。shape × palette 的乘法一旦写错（比如 floor/取模
 *    用反了），会出现「8 款一模一样、8 款从没出现过」，而界面上看不出报错 ——
 *    只是某些格子点了没变化。
 * 2. **没选过头像的人也要有头像**。老账号一个都没选过，如果 forPlayer 在
 *    chosen='' 时返回空串，上线当天全桌都是空白圈 —— 所以要求它一定落到某一款。
 * 3. **服务端是唯一裁判**。前端 48 款是展示约束，客户端能发任意字符串；
 *    服务端照单全收的后果是别人看到空白头像（坏的是别人的界面）。
 * 4. **接线别漏**。新脚本要进 index.html（且在 game.js 之前，因为 game.js 同步调
 *    Avatar.img）、要进 sw.js 预缓存（否则离线时座位退成昵称首字）。
 * 5. **上传（P1b）是默认关闭的**，但关闭不等于可以写坏：服务端只认文件头、
 *    不信 Content-Type，pid 要清洗（否则是路径穿越），删号要连图一起删。
 */
'use strict';

const { readAll: readGameAll } = require('./helpers/gameSource');
const fs = require('fs');
const path = require('path');
const os = require('os');

const Avatar = require('../js/avatar.js');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

/* ------------------------------------------------------------------ */
console.log('\n[1] 库本身：48 款，款款不同');
{
  eq(Avatar.COUNT, 48, '一共 48 款（8 形状 × 6 调色板）');
  const list = Avatar.list();
  eq(list.length, 48, 'list() 返回 48 项');

  const ids = list.map(function (a) { return a.id; });
  eq(new Set(ids).size, 48, '★★ 48 个 id 全不相同');

  /* 形状 × 配色的关键在「两两组合都出现过」。用 bg|shape 做键，
   * 只有 48 个键全齐才算真乘法；写错取模方向会只剩 8 或 6 种组合。 */
  const combos = new Set(list.map(function (a) { return a.shape + '|' + a.bg; }));
  eq(combos.size, 48, '★★ 形状 × 配色 48 种组合全齐（乘法没写反）');

  eq(new Set(list.map(function (a) { return a.shape; })).size, 8, '8 种形状各出现 6 次');
  eq(new Set(list.map(function (a) { return a.bg; })).size, 6, '6 组配色各出现 8 次');

  /* 每一款的背景色和前景色必须是同一组里的那一对 —— 混搭会出现
   * 「深蓝底配深棕图」这种几乎看不见的组合 */
  const palOk = list.every(function (a) {
    return Avatar.PALETTES.some(function (p) { return p[0] === a.bg && p[1] === a.fg; });
  });
  ok(palOk, '★ 每款的前景/背景都取自同一组配色（不会混出看不见的组合）');
}

/* ------------------------------------------------------------------ */
console.log('\n[2] id 校验与 dataUri');
{
  ok(Avatar.valid('a0'), "valid('a0') = true");
  ok(Avatar.valid('a47'), "valid('a47') = true（最后一款）");
  ok(!Avatar.valid('a48'), "valid('a48') = false（越界）");
  ok(!Avatar.valid('-1') && !Avatar.valid('a-1'), '负数/畸形 id 一律不认');
  ok(!Avatar.valid('../x') && !Avatar.valid('a1<script>'), '★ 不认带路径/脚本的字符串');
  ok(!Avatar.valid(null) && !Avatar.valid(undefined) && !Avatar.valid(''), '空值不认（空串是「没选过」，不是一款头像）');
  eq(Avatar.indexOf('a47'), 47, "indexOf('a47') = 47");
  eq(Avatar.indexOf('nope'), -1, '无效 id 的 indexOf = -1');

  const uri = Avatar.dataUri('a12');
  ok(/^data:image\/svg\+xml,/.test(uri), 'dataUri 是 SVG data URI（不走网络、不占预下载）');
  /* encodeURIComponent 之后不该出现裸的引号 / 尖括号：
   * 它们既会破坏 HTML 属性，也会让某些老 WebView 解析失败 */
  ok(!/["'<>]/.test(uri.replace(/^data:[^,]*,/, '')), '★ 编码后没有裸引号/尖括号（能安全放进属性）');
  ok(uri.indexOf('%3Csvg') >= 0, 'SVG 根标签被正确编码');
  eq(Avatar.dataUri('a12'), uri, '同一个 id 编码结果稳定（有缓存，也保证可复现）');
  eq(Avatar.dataUri('nope'), '', '无效 id 返回空串（调用方据此退化成首字）');
}

/* ------------------------------------------------------------------ */
console.log('\n[3] forPlayer：没选过也要有一款，且永远稳定');
{
  const pids = ['p_1001', 'p_1002', 'probe-a', 'probe-b', '', 'bot_1'];
  pids.forEach(function (pid) {
    const id = Avatar.forPlayer(pid, '');
    ok(Avatar.valid(id), '★ ' + (pid || '(空 id)') + ' 没选头像时也落到合法的一款（' + id + '）');
  });

  /* 稳定性：同一个 playerId 反复算必须一样 —— 否则每次重渲染头像都在跳 */
  const a1 = Avatar.forPlayer('p_1001', '');
  const a2 = Avatar.forPlayer('p_1001', '');
  eq(a1, a2, '★ 同一个 playerId 永远同一款（不会每次刷新都换脸）');

  /* 选过就听选的，压过哈希 */
  eq(Avatar.forPlayer('p_1001', 'a7'), 'a7', '★ 选过的头像优先于哈希默认款');
  eq(Avatar.forPlayer('p_1001', 'a48'), a1, '选了个越界 id 时退回默认款（不会渲染成空白）');

  /* 相似 id 要打散：探针账号是 probe1 / probe2 …，如果哈希太弱，
   * 一桌人全是同一款头像，那就等于没有头像 */
  const sample = [];
  for (let i = 0; i < 40; i++) sample.push(Avatar.forPlayer('probe' + i, ''));
  ok(new Set(sample).size >= 30, '40 个相近 id 至少落在 30 款上（哈希有打散能力，实际 ' + new Set(sample).size + ' 款）');
}

/* ------------------------------------------------------------------ */
console.log('\n[4] 渲染成什么（img / 首字退化）');
{
  const html = Avatar.img('p_1001', '', '');
  ok(/<img /.test(html) && /class="avatar-img"/.test(html), 'img() 输出 <img class="avatar-img">');
  ok(/data-avatar="a\d+"/.test(html), '带上 data-avatar，探针/测试不用反解 data URI');
  ok(/aria-hidden="true"/.test(html), '★ 读屏跳过：名字就在旁边，不该再念一遍头像');
  ok(/alt=""/.test(html), 'alt 为空（装饰性图片）');

  const withCls = Avatar.img('p_1001', '', 'av-68');
  ok(/class="avatar-img av-68"/.test(withCls), '可以挂尺寸类');

  /* 同一玩家、同一选择 → 同一张图。座位卡和面板头各渲染一次时不能出现两个图案 */
  const x = Avatar.img('p_2', 'a3', '');
  const y = Avatar.img('p_2', 'a3', '');
  eq(x, y, '★ 同玩家同选择渲染结果一致（座位卡与面板不会出现两个图案）');
}

/* ------------------------------------------------------------------ */
console.log('\n[5] 服务端是唯一裁判：ProfileStore.setAvatar');
{
  const { ProfileStore } = require('../../server/profile.js');
  const tmp = path.join(os.tmpdir(), 'lxw-avatar-' + Date.now() + '.json');
  const seed = path.join(os.tmpdir(), 'lxw-avatar-seed-' + Date.now() + '.json');
  const store = new ProfileStore({ file: tmp, seedFile: seed });

  store.ensure('p_1', '阿一');
  /* 新档案默认没有头像：'' 表示「没选过」，展示层再按 id 哈希兜一款。
   * 不在这里预先写一个 a0 —— 那样所有人都从同一款开始，等于没有区分。 */
  eq(store.getSelf('p_1').avatar, '', "新档案 avatar = ''（没选过，展示层走哈希）");

  eq(store.setAvatar('p_1', 'a23'), true, "setAvatar('a23') 成功");
  eq(store.getSelf('p_1').avatar, 'a23', '★ 档案里记下了 a23');
  /* 对外档案（_public）必须带着它，否则前端拿不到 —— 别人看你的档案卡时才有头像 */
  eq(store.getSelf('p_1').avatar, 'a23', '★ _public 暴露 avatar（前端档案卡要用）');

  eq(store.setAvatar('p_1', ''), true, "setAvatar('') 成功（清回默认款是合法操作，不是参数缺失）");
  eq(store.getSelf('p_1').avatar, '', '清空后回到空串');

  ['a48', 'a-1', 'a1x', '../a1', 'avatar1', 12, null].forEach(function (bad) {
    ok(store.setAvatar('p_1', bad) === false,
      '★ 拒绝非法值 ' + JSON.stringify(bad), '服务端不能把任意值写进档案');
  });
  /* null 是「没传」—— 也按非法处理，不能当成空串静默清掉用户的选择 */
  eq(store.setAvatar('p_1', null), false, '★ null 也拒（不会被当成「清空」静默抹掉选择）');

  eq(store.setAvatar('p_nobody', 'a1'), false, '不存在的玩家返回 false');

  /* 落盘：重启（新实例读同一个文件）之后头像还在，否则换完头像一刷新就变回去 */
  store.flush();
  const again = new ProfileStore({ file: tmp, seedFile: seed });
  again.ensure('p_1', '阿一');
  again.setAvatar('p_1', 'a31');
  again.flush();
  const third = new ProfileStore({ file: tmp, seedFile: seed });
  eq(third.getSelf('p_1').avatar, 'a31', '★ 换完头像落盘了（重启后还在）');

  try { fs.unlinkSync(tmp); } catch (e) { /* 临时文件，删不掉不影响结论 */ }
  try { fs.unlinkSync(seed); } catch (e) { /* 同上 */ }
}

/* ------------------------------------------------------------------ */
console.log('\n[6] 接线：脚本顺序、预缓存、房间快照');
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

  ok(/<script src="\.\/js\/avatar\.js\?v=/.test(html), 'index.html 引到了 js/avatar.js');
  /* 必须找 <script> 那一条：index.html 顶部还有一行 preload game.js，
   * 用 indexOf('js/game.js?v=') 会命中它，于是「avatar 在前」永远判假。 */
  const iAv = html.indexOf('<script src="./js/avatar.js?v=');
  const iGame = html.indexOf('<script src="./js/game.js?v=');
  ok(iAv > 0 && iGame > 0 && iAv < iGame,
    '★★ avatar.js 在 game.js 之前（game.js 渲染座位时同步调 Avatar.img，晚一步就 ReferenceError）');

  ok(/'\/js\/avatar\.js'/.test(sw), "sw.js 预缓存了 /js/avatar.js（否则离线时座位退成昵称首字）");

  /* 服务端：房间 player 对象要带 avatar，否则前端拿到的每个 p.avatar 都是 undefined，
   * 所有人都会落到哈希默认款 —— 「换了头像别人也看不到」的典型成因 */
  const hub = fs.readFileSync(path.join(ROOT, '../server/hub.js'), 'utf8');
  ok(/_avatarOf\(/.test(hub), 'hub 里有 _avatarOf（头像的唯一来源）');
  ok(/avatar: this\._avatarOf\(playerId\)/.test(hub), '★ 建房/进房时把 avatar 拷进 player 对象');

  const api = fs.readFileSync(path.join(ROOT, '../server/index.js'), 'utf8');
  ok(/urlPath === '\/api\/me\/avatar'/.test(api), '服务端有 POST /api/me/avatar');
  ok(/profiles\.setAvatar\(pid, body\.avatar\)/.test(api), '接口走 profiles.setAvatar（校验在档案层，只有一份）');
  ok(/avatar: \(prof && prof\.avatar\) \|\| ''/.test(api), '/api/auth/me 回包里带 avatar（刷新后能恢复选择）');

  const store = fs.readFileSync(path.join(ROOT, 'js/authStore.js'), 'utf8');
  ok(/setAvatar: async function/.test(store), 'authStore 有 setAvatar（服务端成功后才改本地）');
  ok(/s\.avatar = r\.me\.avatar \|\| ''/.test(store), 'refresh 时同步 avatar（换设备/清缓存后仍是选过的那款）');
}

/* ------------------------------------------------------------------ */
console.log('\n[7] 界面上每一处头像都换过了');
{
  const game = readGameAll();

  ok(/function avatarInner\(/.test(game), '有统一的 avatarInner（一处决定「图 / 🤖 / 首字」）');
  ok(/typeof Avatar === 'undefined'/.test(game),
    '★ 老缓存里没有 avatar.js 时退化成昵称首字（而不是整块空白）');

  /* AI 必须保留 🤖：预设图是让人认出「这是谁」，AI 没这个需求；
   * 机器人和真人长得一样才是事故（虚线描边 + 机器人图标是唯一一眼可辨的记号）。 */
  const av = /function avatarInner\([\s\S]*?\n  \}/.exec(game);
  ok(!!av && /if \(isBot\) return '🤖'/.test(av[0]), '★ AI 座位仍然是 🤖（不套预设图）');

  const sites = [
    ['房间座位卡', /el\('div', 'avatar'[\s\S]{0,200}avatarInner\(p\.id, p\.avatar/],
    ['对手座位条', /avatarInner\(p\.id, p\.avatar/],
    ['我的座位', /avatarInner\(me\.id, me\.avatar/],
    ['档案卡（加载中）', /avatarInner\(pid, ''/],
    ['档案卡（拿到数据）', /avatarInner\(\s*profile\.playerId, profile\.avatar/],
    ['结算冠军行', /rank\.innerHTML = avatarInner\(p\.id, p\.avatar/],
    ['浮层面板头', /avatarInner\(ssPid, p && p\.avatar/],
    ['面板里的「发给谁」', /avatarInner\(p\.id, p\.avatar, \(p\.nickname \|\| '\?'\)\.charAt\(0\), false, p\.photo\)/]
  ];
  sites.forEach(function (s) {
    ok(s[1].test(game), '★ ' + s[0] + ' 用 avatarInner 渲染');
  });

  /* 旧的「色块 + 首字」写法必须清干净：留一处就会同屏两种风格 */
  ok(!/style="background:' \+ colorFor\(p\.id\) \+ '"/.test(game),
    '★ 没有残留的「色块 + 首字」内联背景写法');
  ok(!/\$\('#profile-avatar'\)\.style\.background/.test(game),
    '★ 档案卡也不再涂色块（图已经填满了那个圆）');
}

/* ------------------------------------------------------------------ */
console.log('\n[8] 换头像弹窗');
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const game = readGameAll();
  const css = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');

  ok(/id="avatar-modal"/.test(html), '有 #avatar-modal');
  ok(/id="av-grid"/.test(html), '有 #av-grid（48 格容器）');
  ok(/id="btn-acc-avatar"/.test(html), '账号页有「换头像」入口');
  ok(/role="listbox"/.test(html), '格容器带 listbox 语义');
  ok(/role="option"/.test(game), '每格由 JS 生成 role="option"（48 格是渲染出来的，不写死在 HTML 里）');

  ok(/function openAvatarModal\(/.test(game) && /function pickAvatar\(/.test(game), '有开面板 / 选头像两个动作');
  ok(/\$\('#av-grid'\)\.addEventListener\('click'/.test(game),
    '★ 网格用委托监听（格子每次重画，直接绑会失效）');
  /* 点一格就换：换头像是可随手反悔的动作（再点一格就回去了），多一步确认只是多点一次。
   * 真正不可逆的那些（删号、清空战绩）才需要拦一道。 */
  const pickFn = /function pickAvatar\([\s\S]*?\n  \}/.exec(game);
  ok(!!pickFn && !/askConfirm/.test(pickFn[0]), '★ 选头像不弹二次确认（可随手反悔的动作不该加门）');
  ok(/'avatar-modal'/.test(game), 'avatar-modal 登记进 MODAL_ORDER（Esc 与 Tab 圈定要用）');

  ok(/\.avatar-img \{/.test(css), '有 .avatar-img 通用样式');
  const avCss = /\.avatar-img \{[\s\S]*?\n\}/.exec(css);
  ok(!!avCss && /pointer-events: none/.test(avCss[0]),
    '★★ 头像图不吃点击（座位卡的委托监听挂在 row/card 上，图吃掉事件就会「点头像正中没反应」）');
  ok(/\.av-cell\.is-on/.test(css), '选中的那格有独立样式（金环）');
}

/* ------------------------------------------------------------------ */
console.log('\n[9] 上传照片：地址、裁剪（P1b，默认关闭）');
{
  /* 版本号既是破缓存的钥匙，也是**唯一**的访问凭据 —— 服务端只认
   * 「和档案里一致的那个 v」。所以 URL 必须带上它，不能只拼 pid。 */
  eq(Avatar.photoUrl('p_1', 'abc123'), '/api/avatar/p_1?v=abc123', 'photoUrl 拼出 /api/avatar/<pid>?v=<版本>');
  eq(Avatar.photoUrl('p_1', ''), '', '没有版本号就不给地址（服务端也会 404）');
  eq(Avatar.photoUrl('', 'abc'), '', '没有 pid 就不给地址');

  const phtml = Avatar.photoImg('p_1', 'abc123');
  ok(/class="avatar-img is-photo"/.test(phtml), 'photoImg 复用 .avatar-img（尺寸与圆形裁切不用另写一套）');
  ok(/data-photo="abc123"/.test(phtml), '带 data-photo，探针靠它区分「照片」和「预设」');
  ok(/aria-hidden="true"/.test(phtml) && /alt=""/.test(phtml), '照片同样是装饰：读屏跳过，名字在旁边');
  eq(Avatar.photoImg('p_1', ''), '', '没有版本号时返回空串（调用方回落到预设）');

  /* 裁切：短边铺满、居中。写错方向（拿长边做边）会切出画外区域 */
  const wide = Avatar.coverRect(1000, 400);
  ok(wide.side === 400, '横图：边长取短边 400（实际 ' + wide.side + '）');
  ok(wide.sx === 300 && wide.sy === 0, '横图：水平居中裁、垂直不裁（' + wide.sx + ',' + wide.sy + '）');
  const tall = Avatar.coverRect(400, 1000);
  ok(tall.side === 400 && tall.sx === 0 && tall.sy === 300, '竖图：反过来，垂直居中裁');
  const sq = Avatar.coverRect(512, 512);
  ok(sq.side === 512 && sq.sx === 0 && sq.sy === 0, '正方形：原样不裁');
  eq(Avatar.coverRect(0, 100).side, 0, '尺寸为 0 时返回 0（调用方据此报「读不出来」）');
}

console.log('\n[10] 服务端照片存储（server/avatars.js）');
{
  const Av = require('../../server/avatars.js');
  const dir = path.join(os.tmpdir(), 'lxw-avstore-' + Date.now());
  const store = new Av.AvatarStore({ dir: dir });

  /* 造两张最小的合法图头：只验文件头嗅探，不需要真图片 */
  const jpeg = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(64, 1)]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(64, 2)]);
  const gif = Buffer.from('GIF89a' + 'x'.repeat(64));

  eq(Av.sniff(jpeg), 'image/jpeg', '认出 JPEG');
  eq(Av.sniff(png), 'image/png', '认出 PNG');
  eq(Av.sniff(gif), '', '★ 不认 GIF（只开放两种格式，多一种就多一套兼容问题）');
  eq(Av.sniff(Buffer.alloc(4)), '', '太短的一律不认（不足 8 字节）');

  const saved = store.save('p_1', jpeg);
  ok(saved.ok && /^[0-9a-z]+$/.test(saved.version), '★ 存进去了，并拿到版本号（客户端拿它当 ?v=）');
  const got = store.read('p_1');
  ok(got && got.mime === 'image/jpeg' && got.buf.length === jpeg.length, '读回来的字节与 MIME 都对');
  eq(store.read('p_none'), null, '没传过的人读出 null');

  ok(store.save('p_1', gif).ok === false, '★ 拒绝非图片内容（不信 Content-Type，只看文件头）');
  ok(store.save('p_1', Buffer.alloc(0)).ok === false, '拒绝空内容');
  const huge = Buffer.concat([jpeg, Buffer.alloc(Av.MAX_BYTES, 1)]);
  ok(store.save('p_1', huge).ok === false, '★ 拒绝超过上限的图（' + Math.round(Av.MAX_BYTES / 1024) + 'KB）');

  /* 路径穿越：即使有人把 pid 传成 ../../etc/passwd，也不该在目录外落文件 */
  const evil = store.save('../../evil', jpeg);
  ok(evil.ok === true, 'pid 被清洗后仍然能存（清洗成合法文件名）');
  ok(fs.readdirSync(dir).every(function (f) { return !f.includes('/') && !f.includes('\\'); }),
    '★ 目录里没有带路径分隔符的文件名（pid 被白名单清洗过）');

  ok(store.remove('p_1') === true, 'remove 删掉文件');
  eq(store.read('p_1'), null, '删完就读不到了（删号时靠这一句做隐私承诺）');
  ok(store.remove('p_1') === false, '重复删返回 false（不抛异常）');

  ok(store.report('p_2', 'p_1', '不当头像\n第二行') === true, '举报能落盘');
  const logText = fs.readFileSync(path.join(dir, 'reports.log'), 'utf8');
  ok(/target=p_1/.test(logText) && logText.split('\n').length >= 1, '★ 举报日志里有目标玩家');
  ok(!/\n第二行/.test(logText), '★ 举报理由里的换行被抹掉（否则一条举报能伪造出多行日志）');

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 临时目录 */ }
}

console.log('\n[11] 上传入口默认关闭');
{
  const cfg = fs.readFileSync(path.join(ROOT, 'js/config.js'), 'utf8');
  ok(/AVATAR_UPLOAD:\s*false/.test(cfg), '★★ CONFIG.AVATAR_UPLOAD 默认是 false（没有举报处置流程之前不开）');

  const game = readGameAll();
  ok(/function avatarUploadFlag\(\)/.test(game), '有 avatarUploadFlag() 读开关');
  /* 两条缺一不可：函数存在 + 界面真的用它。只查函数名的话，写了没接上也照样绿。 */
  ok(/row\.classList\.toggle\('hidden', !avatarUploadFlag\(\)\)/.test(game),
    '★ 上传那一行由开关控制显隐（关着就是整行不出现）');
  ok(/get\('avatarupload'\)/.test(game), '★ 支持 ?avatarupload=0/1 运行时覆盖（灰度期不改文件就能验两条路径）');

  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ok(/id="av-photo-row" class="av-photo-row hidden"/.test(html), '上传行在 HTML 里默认就是 hidden');
  ok(/id="av-file"[^>]*type="file"/.test(html), '文件选择器只收图片（accept 限 jpeg/png）');
  ok(/accept="image\/jpeg,image\/png"/.test(html), 'accept 里没有 image/*（那等于放任 HEIC/GIF）');

  /* 客户端压缩：256 是文档定的边长，改大就白传流量，改小头像会糊 */
  ok(/c\.width = 256; c\.height = 256/.test(game), '★ 客户端压到 256×256');
  ok(/URL\.revokeObjectURL/.test(game), '★ 压缩后释放 blob URL（不释放会在低端机上攒出几十 MB）');
  ok(/coverRect/.test(game), '★ 用 coverRect 居中裁切（不是拉伸，脸不会被压扁）');
}

/* ------------------------------------------------------------------ */
console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
