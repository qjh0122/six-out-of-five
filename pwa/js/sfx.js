/**
 * 音效模块（已接入音效师提供的真实音频文件 assets/audio/*.mp3）
 * - 移动端自动播放限制：必须在用户首次触摸手势内解锁（unlock），
 *   做法：手势回调里静音播放一次所有音频元素，随后恢复并启动 BGM。
 * - 若音频文件缺失/加载失败（如 file:// 下个别浏览器限制），自动回退到 Web Audio 合成音。
 * - BGM 在解锁后循环播放（音量较低），首页/房间页各有一个开关，选择记在 localStorage。
 *
 * 关于那个开关的语义：**它是「声音」总开关，不是「背景音乐」开关。**
 * 早先它只 pause 了 BGM，play() 却完全不看开关——于是玩家在房间页点了「关」，
 * 一进牌桌发牌声/选牌声/提示声照旧全响，看起来就是「关了还有声」。
 * 用户点的是「声音」，那就要真的静音全部；要只关 BGM 是产品决策，得另给一个入口。
 */
(function (global) {
  'use strict';

  var FILES = {
    deal: 'assets/audio/sfx_deal.mp3',
    select: 'assets/audio/sfx_select.mp3',
    submit: 'assets/audio/sfx_submit.mp3',
    win: 'assets/audio/sfx_win.mp3',
    settle: 'assets/audio/sfx_settle.mp3',
    bgm: 'assets/audio/bgm_room_loop.mp3'
  };
  var SFX_NAMES = ['deal', 'select', 'submit', 'win', 'settle'];

  var audioPool = {};   // name -> Audio（null 表示加载失败，走合成回退）
  var bgm = null;
  var SOUND_KEY = 'lxw_sound_v1';       // 新键：声音总开关
  var LEGACY_BGM_KEY = 'lxw_bgm_v1';    // 老键：当时只管背景音乐，值要迁移过来

  /* 记住开关：默认开着，关过一次以后每次进来都别再吵人。
   * 只有明确的 '0' 才算关——存储里是脏值（老版本、手改过）时按默认走，不要静默变哑。 */
  function readSoundPref() {
    try {
      var v = global.localStorage.getItem(SOUND_KEY);
      if (v === '0') return false;
      if (v === '1') return true;
      /* 没有新键 → 沿用老版本的 BGM 开关。
       * 当时玩家点「关」的本意就是「别再响了」，升级后不该突然又开始响；
       * 反过来如果按默认开处理，等于把人家关过的声音又打开一遍。 */
      return global.localStorage.getItem(LEGACY_BGM_KEY) !== '0';
    } catch (e) { return true; }
  }
  function writeSoundPref(on) {
    try { global.localStorage.setItem(SOUND_KEY, on ? '1' : '0'); } catch (e) {}
  }

  var soundEnabled = readSoundPref();
  var unlocked = false;
  var ctx = null;       // 合成回退用 AudioContext

  function makeAudio(src, loop, volume) {
    try {
      var a = new global.Audio(src);
      a.loop = !!loop;
      a.preload = 'auto';
      if (volume != null) a.volume = volume;
      return a;
    } catch (e) { return null; }
  }

  /* ---------- 初始化音频元素，加载失败的标记为 null ---------- */
  (function init() {
    SFX_NAMES.forEach(function (name) {
      var a = makeAudio(FILES[name], false, 1);
      if (!a) { audioPool[name] = null; return; }
      a.addEventListener('error', function () { audioPool[name] = null; });
      audioPool[name] = a;
    });
  })();

  /* ---------- Web Audio 合成回退（素材缺失时仍有反馈音） ---------- */
  function ensureCtx() {
    if (!ctx) {
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    return ctx;
  }
  function synth(name, pitch) {
    var c = ensureCtx();
    if (!c) return;
    if (c.state === 'suspended') { try { c.resume(); } catch (e) {} }
    var spec = {
      deal:   { freq: 520, dur: 0.08, type: 'triangle', gain: 0.12 },
      select: { freq: 760, dur: 0.06, type: 'sine',    gain: 0.10 },
      submit: { freq: 440, dur: 0.10, type: 'square',  gain: 0.08 },
      win:    { freq: 880, dur: 0.18, type: 'triangle', gain: 0.14 },
      settle: { freq: 660, dur: 0.25, type: 'sine',    gain: 0.14 },
      error:  { freq: 200, dur: 0.15, type: 'sawtooth', gain: 0.08 }
    }[name] || { freq: 600, dur: 0.08, type: 'sine', gain: 0.1 };
    try {
      var t = c.currentTime;
      var osc = c.createOscillator();
      var g = c.createGain();
      osc.type = spec.type;
      osc.frequency.value = spec.freq * (pitch || 1);
      g.gain.setValueAtTime(spec.gain, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + spec.dur);
      osc.connect(g); g.connect(c.destination);
      osc.start(t); osc.stop(t + spec.dur + 0.02);
    } catch (e) {}
  }

  /* ---------- 首次用户手势解锁 ---------- */
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    // 在手势回调内静音播放一次，解除 iOS/安卓的自动播放限制
    SFX_NAMES.forEach(function (name) {
      var a = audioPool[name];
      if (!a) return;
      try {
        a.muted = true;
        var p = a.play();
        if (p && p.catch) p.catch(function () {});
      } catch (e) {}
    });
    setTimeout(function () {
      SFX_NAMES.forEach(function (name) {
        var a = audioPool[name];
        if (!a) return;
        try { a.pause(); a.currentTime = 0; a.muted = false; } catch (e) {}
      });
      startBgm();
    }, 150);
  }

  function startBgm() {
    if (!soundEnabled) return;
    if (!bgm) bgm = makeAudio(FILES.bgm, true, 0.22);
    if (!bgm) return;
    try {
      bgm.muted = false;
      var p = bgm.play();
      if (p && p.catch) p.catch(function () { /* 被拦截则等下次手势 */ });
    } catch (e) {}
  }

  /* ---------- 播放 ---------- */
  /* pitch：变调系数（1=原调；>1 升调、<1 降调）。MP3 用 playbackRate，合成回退用频率缩放。 */
  function play(name, pitch) {
    if (!unlocked) return;
    /* 开关关着就一声都别出。这一行是「关了还在响」那个 bug 的修复点：
     * 以前这里不判断开关，只有 BGM 受控，发牌/选牌/提交/胜负音效全都是「想响就响」。 */
    if (!soundEnabled) return;
    var rate = pitch || 1;
    var a = audioPool[name];
    if (a) {
      try {
        a.currentTime = 0;
        a.playbackRate = rate;
        var p = a.play();
        if (p && p.catch) p.catch(function () { synth(name, rate); });
      } catch (e) { synth(name, rate); }
      return;
    }
    synth(name, rate);
  }

  global.Sfx = {
    unlock: unlock,
    play: play,
    startBgm: startBgm,
    /** 声音总开关：BGM 和音效一起受控 */
    setSoundEnabled: function (on) {
      soundEnabled = !!on;
      writeSoundPref(soundEnabled);
      if (!soundEnabled) {
        if (bgm) { try { bgm.pause(); } catch (e) {} }
        /* 音效都很短（<0.3s），但正在响的那一下也要掐掉——
         * 否则「点完关它还响一下」的观感跟没修一样。 */
        SFX_NAMES.forEach(function (n) {
          var a = audioPool[n];
          if (!a) return;
          try { a.pause(); a.currentTime = 0; } catch (e) {}
        });
      } else {
        startBgm();
      }
      return soundEnabled;
    },
    isSoundEnabled: function () { return soundEnabled; },
    /* 旧名字保留：语义已经从「只关背景音乐」扩到「关掉全部声音」。
     * 留着是为了让还没改名的调用方继续能关，而不是静默失效变成永远关不掉。 */
    setBgmEnabled: function (on) { return global.Sfx.setSoundEnabled(on); },
    isBgmEnabled: function () { return soundEnabled; },
    isUnlocked: function () { return unlocked; }
  };
})(typeof self !== 'undefined' ? self : this);
