/**
 * 声音开关测试
 * 跑法：node pwa/test/audio.test.js
 *
 * 这个开关最初只管 BGM（只 pause 了背景音乐），`play()` 完全不看开关。
 * 于是出现了真实反馈：「进游戏关闭声音后，进到游戏桌面还有声音」——
 * 玩家点的是「声音」，听到的却是发牌声、选牌声、结算声一样不少。
 *
 * 所以这个文件现在锁两件事：
 *   1. 记忆（关过就别再自动响）
 *   2. **总开关语义**（关掉之后 BGM 和 5 种音效一声都不能出）
 * 第 2 条是这次修 bug 加的，也是唯一能防止它再回来的东西：
 * 只改文案、只换图标而音频照响，是这类功能最常见的假实现。
 *
 * 用 vm 起沙箱跑真实的 sfx.js（不是复制一份逻辑），
 * Audio / localStorage 都是假对象，只用来观察「有没有被调用」。
 */
'use strict';

const { readAll: readGameAll } = require('./helpers/gameSource');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'sfx.js'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

/* ---------- 假存储：跨「重新加载」共用同一份 ---------- */
function makeStore(init) {
  const data = Object.assign({}, init);
  return {
    data: data,
    getItem: function (k) { return k in data ? data[k] : null; },
    setItem: function (k, v) { data[k] = String(v); },
    removeItem: function (k) { delete data[k]; }
  };
}

/* ---------- 假 Audio：记录 play/pause 调用次数 ---------- */
function makeAudioLog() {
  const log = { created: 0, play: 0, pause: 0, lastSrc: null, instances: [] };
  function FakeAudio(src) {
    log.created++;
    log.lastSrc = src;
    const self = this;
    this.src = src;
    this.loop = false;
    this.muted = false;
    this.volume = 1;
    this.currentTime = 0;
    this.playbackRate = 1;
    this.play = function () { log.play++; self.playing = true; return Promise.resolve(); };
    this.pause = function () { log.pause++; self.playing = false; };
    this.addEventListener = function () {};
    log.instances.push(this);
  }
  return { log: log, Audio: FakeAudio };
}

/* 只数 BGM 元素：模块加载时本来就会建 5 个音效元素（deal/select/...），别混在一起数 */
function bgms(log) {
  return log.instances.filter(function (a) { return a.src && a.src.indexOf('bgm') >= 0; });
}

/* 起一个沙箱，跑一遍 sfx.js，返回 Sfx + 观察日志 */
function boot(store) {
  const al = makeAudioLog();
  const timers = [];
  const sandbox = {
    localStorage: store,
    Audio: al.Audio,
    setTimeout: function (fn) { timers.push(fn); return timers.length; },
    clearTimeout: function () {}
  };
  sandbox.self = sandbox;   // sfx.js 结尾用的是 `typeof self !== 'undefined' ? self : this`
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return {
    Sfx: sandbox.Sfx,
    log: al.log,
    flush: function () { while (timers.length) timers.shift()(); }
  };
}

/* 解锁一次（模拟用户第一次点屏幕），返回解锁之后的 play 计数基线 */
function unlockedBoot(store) {
  const app = boot(store);
  app.Sfx.unlock();
  app.flush();
  return app;
}

console.log('\n[默认与记忆]');

let store = makeStore({});
let app = boot(store);

ok(typeof app.Sfx.setSoundEnabled === 'function', 'Sfx 暴露 setSoundEnabled');
ok(typeof app.Sfx.isSoundEnabled === 'function', 'Sfx 暴露 isSoundEnabled（前端要靠它同步图标）');
eq(app.Sfx.isSoundEnabled(), true, '首次进入默认是开着');

app.Sfx.setSoundEnabled(false);
eq(store.data['lxw_sound_v1'], '0', '关掉会写进 localStorage');

// 模拟重开 App：同一份存储，重新加载模块
app = boot(store);
eq(app.Sfx.isSoundEnabled(), false, '重开之后还记得上次关过（否则每次进房又响一遍）');

app = boot(store);
app.Sfx.setSoundEnabled(true);
eq(store.data['lxw_sound_v1'], '1', '打开同样会记下来');
app = boot(store);
eq(app.Sfx.isSoundEnabled(), true, '重开之后记得是开的');

console.log('\n[★ 关掉之后，音效一声都不能响（本次修复的核心）]');

// 这就是「关了声音进牌桌还有声」的复现场景：先解锁、再关、再打牌
store = makeStore({});
app = unlockedBoot(store);
const beforeMute = app.log.play;
app.Sfx.setSoundEnabled(false);
['deal', 'select', 'submit', 'win', 'settle'].forEach(function (n) { app.Sfx.play(n); });
eq(app.log.play, beforeMute, '关着的时候 5 种音效一次都没有真正播（以前是全播）');

app.Sfx.setSoundEnabled(true);
const resumeBase = app.log.play;
app.Sfx.play('deal');
eq(app.log.play, resumeBase + 1, '再打开以后音效恢复（不是一关就永久哑掉）');

// 玩到一半点关：用户真实操作顺序就是「进牌桌 → 嫌吵 → 点关」
store = makeStore({});
app = unlockedBoot(store);
app.Sfx.play('select');
const midBase = app.log.play;
app.Sfx.setSoundEnabled(false);
app.Sfx.play('select');
eq(app.log.play, midBase, '玩到一半点关，后续音效立刻停（不用重开页面）');

// 关的那一下，正在响的音效也要掐掉，否则「点完它还响一下」的观感跟没修一样
const pauseBase = app.log.pause;
app.Sfx.setSoundEnabled(false);
ok(app.log.pause >= pauseBase + 5, '关闭时把 5 个音效元素一起 pause（正在响的那一下也不留）',
  'pause 增量 ' + (app.log.pause - pauseBase));

console.log('\n[关掉的时候真的别放]');

store = makeStore({ lxw_sound_v1: '0' });
app = boot(store);
app.Sfx.startBgm();
eq(bgms(app.log).length, 0, '关着的时候连 BGM 元素都不创建（省流量，不是放静音）');
eq(app.log.play, 0, '一次 play 都没发生');

console.log('\n[开着的时候要放，关掉要暂停]');

store = makeStore({});
app = boot(store);
app.Sfx.startBgm();
eq(bgms(app.log).length, 1, '开着时会创建 BGM 元素');
eq(app.log.play, 1, '并且播放');
ok(app.log.lastSrc.indexOf('bgm_room_loop.mp3') >= 0, '放的是房间循环 BGM', app.log.lastSrc);

app.Sfx.setSoundEnabled(false);
/* 这里不能数 pause 总数：关声音会连带把 5 个音效元素一起 pause（那是另一条断言的事）。
 * 只问「BGM 那个元素停了没」，断言才指向它声称要验的东西。 */
const bgmEl = bgms(app.log)[0];
ok(bgmEl && bgmEl.playing === false, '点关闭立刻暂停 BGM（不是等下一首才停）');

app.Sfx.setSoundEnabled(true);
eq(app.log.play, 2, '再点开能接着放');
eq(bgms(app.log).length, 1, '复用同一个音频元素，不重复加载');

console.log('\n[解锁流程里也要尊重开关]');

// 手机浏览器必须靠用户手势解锁；解锁时不能趁机把已关掉的声音打开
store = makeStore({ lxw_sound_v1: '0' });
app = boot(store);
app.Sfx.unlock();
app.flush();
eq(app.Sfx.isUnlocked(), true, '手势解锁生效');
const bgmPlayed = app.log.instances.some(function (a) {
  return a.src && a.src.indexOf('bgm') >= 0 && a.playing;
});
ok(!bgmPlayed, '解锁不会偷偷把关掉的 BGM 拉起来');

store = makeStore({});
app = boot(store);
app.Sfx.unlock();
app.flush();
const bgmPlaying = app.log.instances.some(function (a) {
  return a.src && a.src.indexOf('bgm') >= 0 && a.playing;
});
ok(bgmPlaying, '开着的时候解锁后正常起 BGM');

console.log('\n[老版本的键要迁移，不能把人关过的声音又打开]');

// 老版本只有 lxw_bgm_v1；当时点过「关」的人，升级后不该突然响
store = makeStore({ lxw_bgm_v1: '0' });
app = boot(store);
eq(app.Sfx.isSoundEnabled(), false, '老键是「关」→ 升级后仍然是关的');

store = makeStore({ lxw_bgm_v1: '1' });
app = boot(store);
eq(app.Sfx.isSoundEnabled(), true, '老键是「开」→ 保持开');

store = makeStore({ lxw_bgm_v1: '1', lxw_sound_v1: '0' });
app = boot(store);
eq(app.Sfx.isSoundEnabled(), false, '两个键都在时以新键为准，不被老键覆盖');

store = makeStore({ lxw_bgm_v1: '0' });
app = boot(store);
app.Sfx.setSoundEnabled(true);
eq(store.data['lxw_sound_v1'], '1', '切换后只写新键');
eq(store.data['lxw_bgm_v1'], '0', '老键不再改动（留着做兼容，不回写）');

console.log('\n[旧 API 名字还在，别让老调用方静默失效]');

store = makeStore({});
app = boot(store);
eq(typeof app.Sfx.setBgmEnabled, 'function', 'setBgmEnabled 仍然存在（别名，转给 setSoundEnabled）');
app.Sfx.setBgmEnabled(false);
eq(app.Sfx.isSoundEnabled(), false, '调旧名字也能真的关掉声音');
eq(app.Sfx.isBgmEnabled(), false, '旧查询名返回的也是总开关状态');

console.log('\n[存储不可用 / 脏值不能把 App 搞崩]');

// 隐私模式 / 禁用 storage：getItem 直接抛
const brokenStore = {
  getItem: function () { throw new Error('SecurityError'); },
  setItem: function () { throw new Error('SecurityError'); }
};
let booted = false;
try { app = boot(brokenStore); booted = true; } catch (e) { booted = false; }
ok(booted, 'localStorage 抛异常时模块仍能加载');
eq(app.Sfx.isSoundEnabled(), true, '读不到偏好就按默认开（宁可响一下，也不要静默失败）');
let threw = false;
try { app.Sfx.setSoundEnabled(false); } catch (e) { threw = true; }
ok(!threw, '写入失败也不抛到界面上');
eq(app.Sfx.isSoundEnabled(), false, '写不进存储时，本次会话内依然生效');

// 有人手动改过 storage，或老版本的脏值
store = makeStore({ lxw_sound_v1: 'yes' });
app = boot(store);
eq(app.Sfx.isSoundEnabled(), true, '脏值不当成「关」，回退为开');

console.log('\n[契约：两处图标 + 记忆键名 + play 必须过开关]');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const gameJs = readGameAll();

eq((html.match(/data-audio-toggle/g) || []).length, 2, '首页 + 房间页各一个开关节点');
ok(gameJs.indexOf('syncAudioToggles') >= 0, 'game.js 有状态同步函数');
ok(gameJs.indexOf('onToggleAudio') >= 0, 'game.js 有切换处理');

/* 静态守住修复点本身：以后谁把这一行删了，这里当场红，
 * 不用等玩家再报一次「关了还有声音」。 */
ok(/function play\([^)]*\) \{[\s\S]{0,400}?if \(!soundEnabled\) return;/.test(SRC),
  '★ play() 里第一段就拦住 soundEnabled 为假的情况（bug 的修复点，不许被删）');
ok(/setSoundEnabled: function/.test(SRC), 'Sfx 对外暴露的是 setSoundEnabled（总开关），不是只关 BGM');
eq((html.match(/aria-label="声音"/g) || []).length, 2, '两个开关的 aria-label 都叫「声音」（读屏读出来也是总开关）');
ok(/setSoundEnabled\s*\(\s*!?\s*Sfx\.isSoundEnabled\(\)/.test(gameJs),
  '★ game.js 的切换走的是 setSoundEnabled（不是还在调只关 BGM 的旧名字）');
ok(gameJs.indexOf('背景音乐已') === -1 && gameJs.indexOf('背景音乐（开）') === -1,
  '界面文案里不再出现「背景音乐」字样（说背景音乐，玩家就会以为只管音乐）');

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
if (fail > 0) process.exitCode = 1;
