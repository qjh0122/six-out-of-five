/**
 * 房间快照（进程重启后把「正在打的那几桌」捞回来）
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 * 房间只活在内存（`hub.rooms`）里，所以进程一重启，所有进行中的对局直接消失：
 * 玩家屏幕上一个「房间已解散 / 你不在该房间」，刚才那几把的分也没落库。
 * 以前唯一的对策是「发布挑没人的时段」—— 那不是设计，那是靠人守。
 *
 * ── 存什么、不存什么 ────────────────────────────────────────────────
 * 存：**房间对象本身**（它本来就是纯 JSON：players / groups / results / history /
 *     dissolve…）＋ 座位令牌（`roomId#playerId → token`，不存的话重启后没人能回座）。
 * 不存：连接、计时器（重启后重新装配）、限流计数（重启清零是对的）。
 *
 * ── 三个必须守住的点 ────────────────────────────────────────────────
 * 1. **原子写**：先写 `.tmp` 再 rename。写到一半断电，rename 之前旧文件仍然完整 ——
 *    直接 `writeFile` 到目标路径，崩一次就得到一个半截 JSON，下次启动全丢。
 * 2. **坏文件不许挡住启动**：读失败/解析失败一律返回 null，按「没有快照」处理。
 *    为了几桌牌卡住整个服务，是最糟的取舍。
 * 3. **失败只记日志**：磁盘满 / 只读挂载时写不进去，游戏必须照常能玩 ——
 *    这条和 `profile.js` 的落盘失败同一条原则（v109 P0-3）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const VERSION = 1;

/** 写快照。返回 true / false，**永不抛**。 */
function save(file, data) {
  if (!file) return false;
  const payload = JSON.stringify({
    v: VERSION,
    at: Date.now(),
    rooms: data && Array.isArray(data.rooms) ? data.rooms : [],
    tokens: data && Array.isArray(data.tokens) ? data.tokens : []
  });
  const tmp = file + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    /* 清理半截临时文件，别让下一次读的人以为它是快照 */
    try { fs.unlinkSync(tmp); } catch (e2) { /* 本来就没写成 */ }
    return false;
  }
}

/** 读快照。文件不存在 / 结构不对 / JSON 坏了 → null（不抛）。 */
function load(file) {
  if (!file) return null;
  let raw = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return null;     // 首次启动就是没有这个文件，属于正常路径
  }
  let obj = null;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return null;     // 半截写入 / 手改坏了：当没有，不要挡住启动
  }
  if (!obj || !Array.isArray(obj.rooms)) return null;
  /* 版本不认识就当没有：新版本可能改了房间结构，硬读会把脏数据喂给状态机。 */
  if (Number(obj.v) !== VERSION) return null;
  return {
    at: Number(obj.at) || 0,
    rooms: obj.rooms.filter(function (r) { return r && typeof r === 'object' && r.roomId; }),
    tokens: (Array.isArray(obj.tokens) ? obj.tokens : []).filter(function (t) {
      return Array.isArray(t) && t.length === 2 && typeof t[0] === 'string' && typeof t[1] === 'string';
    })
  };
}

module.exports = { save: save, load: load, VERSION: VERSION };
