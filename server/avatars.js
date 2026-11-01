/**
 * 头像照片存储（v89 §9.3 · P1b，**默认关闭**）
 *
 * 为什么单独一个模块：它是本项目里第一份「用户上传的二进制」。之前所有持久化都是
 * JSON（profiles.json），而图片有三个 JSON 里不存在的麻烦 —— 体积上限、真实格式
 * 校验、以及「换一张」之后旧文件要能被覆盖掉。这些放在 index.js 的路由里写，
 * 会跟请求解析混在一起，也没法单测。
 *
 * 存磁盘而不是数据库/对象存储：一部手机一局最多 5 个人，一局下来几十张 20KB 的图。
 * 引入一个外部依赖的运维成本远大于这点体积。
 *
 * ★ 默认关闭。文档 §9.3 自己写着：没有举报入口、审核与处置流程之前开放上传，
 *   等于把风险直接放给全桌。所以这一版的开关是 CONFIG.AVATAR_UPLOAD = false，
 *   上传入口在界面上根本不渲染 —— 但服务端这套接口是完整的、有测试的，
 *   将来要开只需要翻开关 + 补审核人力。
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* 256×256 的 JPEG 质量 0.82 大约 12~20KB。给 300KB 的余量是留给
 * 「客户端没压缩就传了」那种情况 —— 直接拒掉，而不是把 2MB 的原图落盘。 */
const MAX_BYTES = 300 * 1024;

/* 只认 JPEG 和 PNG 的文件头。
 * 为什么不信 Content-Type：那个头是客户端自己写的，写 image/jpeg 不代表真是 JPEG；
 * 而把任意字节以 .jpg 存下来、再以 image/jpeg 发出去，等于给浏览器喂未知内容。 */
function sniff(buf) {
  if (!buf || buf.length < 8) return '';
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  return '';
}

class AvatarStore {
  /** @param {object} opts { dir, log } */
  constructor(opts) {
    const o = opts || {};
    this.dir = o.dir || defaultDir();
    this.reportFile = path.join(this.dir, 'reports.log');
    this.log = o.log || null;
    this._ready = false;
  }

  _ensure() {
    if (this._ready) return;
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch (e) { /* 已存在 */ }
    this._ready = true;
  }

  /* 文件名只用 pid 本身，但必须清洗 —— pid 是服务端生成的（p_数字），
   * 这里再做一次白名单只是防「将来某个调用点传了别的东西」。 */
  _file(pid) {
    const safe = String(pid || '').replace(/[^A-Za-z0-9_-]/g, '');
    if (!safe) return '';
    return path.join(this.dir, safe + '.img');
  }

  /**
   * 存一张照片。
   * @returns {{ok:boolean, version?:string, error?:string}}
   *   version 是个递增的时间戳串，客户端会拿它当 `?v=` 破缓存 ——
   *   没有它的话「换了头像但看起来没换」会变成一个查不出来的问题。
   */
  save(pid, buf) {
    const file = this._file(pid);
    if (!file) return { ok: false, error: '玩家标识不合法' };
    if (!Buffer.isBuffer(buf) || !buf.length) return { ok: false, error: '没有收到图片' };
    if (buf.length > MAX_BYTES) return { ok: false, error: '图片太大了，请换一张小一点的' };
    const mime = sniff(buf);
    if (!mime) return { ok: false, error: '只支持 JPEG / PNG 图片' };

    this._ensure();
    try {
      fs.writeFileSync(file, buf);
    } catch (e) {
      return { ok: false, error: '存不下这张图，请稍后再试' };
    }
    return { ok: true, version: Date.now().toString(36), mime: mime };
  }

  /** @returns {{buf:Buffer, mime:string}|null} */
  read(pid) {
    const file = this._file(pid);
    if (!file) return null;
    let buf;
    try { buf = fs.readFileSync(file); } catch (e) { return null; }
    const mime = sniff(buf);
    if (!mime) return null;
    return { buf: buf, mime: mime };
  }

  remove(pid) {
    const file = this._file(pid);
    if (!file) return false;
    try { fs.unlinkSync(file); return true; } catch (e) { return false; }
  }

  /** 举报：只追加一行日志，没有人会实时看 —— 它的意义是「有这个入口」+「留痕」。
   *  真正要上线开放上传，得把这份日志接到一个有人处理的地方去。 */
  report(byPid, targetPid, reason) {
    this._ensure();
    const line = [
      new Date().toISOString(),
      'by=' + String(byPid || '-'),
      'target=' + String(targetPid || '-'),
      'reason=' + String(reason || '').slice(0, 200).replace(/[\r\n]+/g, ' ')
    ].join('\t') + '\n';
    try { fs.appendFileSync(this.reportFile, line); } catch (e) { return false; }
    if (this.log) this.log('avatar report', String(targetPid || '-'));
    return true;
  }
}

/** 和数据文件放在一起：备份/迁移只需要搬一个目录 */
function defaultDir() {
  if (process.env.DATA_DIR) return path.join(process.env.DATA_DIR, 'avatars');
  return path.join(__dirname, 'data', 'avatars');
}

module.exports = { AvatarStore, MAX_BYTES, sniff, defaultDir };
