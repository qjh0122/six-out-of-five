/**
 * 昵称清洗（服务端唯一实现）
 *
 * 为什么单独抽出来：以前有三个版本，口径不一致——
 *   hub.js 的 cleanNickname  用 Array.from 按**字符**截断（正确）
 *   index.js 注册昵称        用 String.slice(0, 8) 按**码元**截断（会切断 emoji）
 *   profile.js 管理员改昵称  同样是 slice(0, 8)
 *
 * 差别不是理论问题：一个 emoji 占 2 个 UTF-16 码元，slice 切在中间就留下
 * 一个孤立代理项，存进 JSON 后前端渲染成 `�`，而且这个坏字符串会一直留在档案里。
 *
 * 按「字符」（码点）截断才是对的，Array.from 正好做到这一点。
 */
'use strict';

const NICK_MAX = 8;
const DEFAULT_NICK = '玩家';

/**
 * @param {*} input 任意输入
 * @param {number} [max] 最多个字符（默认 8）
 * @param {string} [fallback] 空值时的兜底（默认「玩家」；传 '' 表示允许空串）
 */
function cleanNickname(input, max, fallback) {
  const limit = Number(max) > 0 ? Number(max) : NICK_MAX;
  const fb = fallback === undefined ? DEFAULT_NICK : fallback;
  let s = String(input == null ? '' : input).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!s) s = fb;
  if (!s) return '';
  const chars = Array.from(s);          // 按码点切，emoji / 生僻字不会被切一半
  if (chars.length > limit) s = chars.slice(0, limit).join('');
  return s;
}

module.exports = { cleanNickname, NICK_MAX, DEFAULT_NICK };
