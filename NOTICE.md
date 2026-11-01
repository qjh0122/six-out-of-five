# 第三方素材与授权说明

**代码**以 [MIT](LICENSE) 发布。**本文说明 `pwa/assets/` 与 `pwa/icons/` 下 29 个文件的授权状态。**

---

## 结论

**全部素材（6 个音效 + 13 个表情 + 3 张背景/牌背 + 7 个图标）均为本项目自制或由 AI 工具生成，
随本仓库一起以 MIT 许可发布。**

| 类别 | 文件 | 来源 | 授权 |
|---|---|---|---|
| 音效与背景音乐 | `pwa/assets/audio/*.mp3`（6 个） | 自制 / AI 生成 | MIT |
| 表情 | `pwa/assets/emoji/*.png`（13 个） | 自制 / AI 生成 | MIT |
| 背景与牌背 | `home_bg.webp` / `table_bg.webp` / `card_back.webp` | 自制 / AI 生成 | MIT |
| 应用图标 | `pwa/icons/icon-*.png` / `apple-touch-icon.png`（5 个） | 自制 / AI 生成 | MIT |
| 商店截图 | `pwa/icons/screenshots/*.webp`（2 张） | 应用自身截图 | MIT |

> **更正通道**：若你发现上述任一文件实际来自第三方，请开 issue 指出。
> 核实后会按下面的规则处理——这是版权问题，不能含糊：
> 有授权 → 补进「署名」小节；无授权 → 替换或下架。

---

## 明确不依赖外部素材的部分

这些是代码生成的，不涉及任何第三方版权：

| 内容 | 实现 |
|---|---|
| 头像预设 48 款（8 形状 × 6 调色板） | 代码内联生成的 SVG，见 `pwa/js/avatar.js` |
| 全部 UI 图形 | 纯 CSS（`conic-gradient` / `border-radius` / `box-shadow`），无图片素材 |
| 牌面与牌背图案 | Canvas 绘制，见 `pwa/js/card.js`；字体用系统字体栈 |
| 牌型特写特效 | 纯 CSS 动画 + DOM 粒子，无序列帧 |

---

## 署名

MIT 不要求署名，但如果你要在别处使用这些素材，注明来源即可。

目前：**无需要署名的第三方素材**。
