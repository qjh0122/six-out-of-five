# 文档索引

> **这是 `docs/` 下所有文档的地图。** 每份都标了**类型**——类型决定你能怎么用它。
>
> 类型只有三种，别混：
>
> | 类型 | 含义 | 怎么用 |
> |---|---|---|
> | **现行** | 描述「现在是什么样」，维护者会跟着代码更新 | 可以直接当事实引用 |
> | **规格** | 某一条需求的完整推演（方案比选 + 代价评估 + 实施记录） | 决策依据；**结论部分可能已被后续版本覆盖**，以现行文档为准 |
> | **快照** | 写于某个版本的历史记录，之后不再更新 | **不要当现状读**。它的价值是「当时怎么想的、怎么发现的」 |
>
> 判断某条结论是否还开着，**永远以 [`BACKLOG.md`](./BACKLOG.md) 为准**。

---

## 一、入口三份（先读这三个）

| 文档 | 类型 | 回答什么问题 |
|---|---|---|
| [`../README.md`](../README.md) | 现行 | 这是什么游戏、怎么玩、怎么跑起来 |
| [`REVIEW.md`](./REVIEW.md) | 现行 | **现在什么水平、够不够成熟、够不够优秀**（开头就是多维评分表） |
| [`PLAN.md`](./PLAN.md) | 现行 | 接下来做什么、按什么顺序、怎么算做完 |

---

## 二、现行文档（跟着代码更新）

| 文档 | 内容 | 最后核对 |
|---|---|---|
| [`BACKLOG.md`](./BACKLOG.md) | 已知问题清单。分 C（结构性工程）/ D（需产品决策）/ B（刻意留下）/ N（历次新发现）四档，每条写明「为什么当时不修」 | 2026-11-01 / v108 |
| [`release-progress.md`](./release-progress.md) | 每次发布的完整记录：版本号、改动清单、验收数字。**版本现状的唯一权威** | 2026-11-01 / v108 |
| [`compat.md`](./compat.md) | 兼容性矩阵与降级说明：哪些现代 CSS 特性丢了会怎样、老内核能用到什么程度 | 2026-11-01 / v106 |
| [`device-support.md`](./device-support.md) | 机型支持矩阵。「支持」的四条硬指标（组槽不溢出 / 牌面 ≥39 CSS px / 表情入口 ≥44 / 昵称 ≥10.4），三族 23 档实测 | 2026-11-01 / v105 |
| [`HISTORY.md`](./HISTORY.md) | 迭代史 v0.2 → v108，十四段。**每段都保留当时的判断失误** | 2026-11-01 / v108 |
| [`repo-public-plan.md`](./repo-public-plan.md) | 仓库公开化治理方案：敏感数据清单、密钥轮换、`.gitignore`、历史清洗两条路线、合规补件 | 2026-11-01 |
| [`../COMMITS.md`](../COMMITS.md) | 提交信息规范（这个仓库曾经 14 条里 11 条叫 `update`） | 2026-10-30 |

---

## 三、规格文档（某条需求的完整推演）

这类文档的价值是**保存决策依据**：当时比了几个方案、各自代价多少、最后为什么选这个。
**不要当待办清单读**——大部分已实施完。

| 文档 | 需求 | 状态 |
|---|---|---|
| [`hand-limit-plan.md`](./hand-limit-plan.md) | 本局局数上限（`handLimit`） | ✅ 已实施并迭代三轮（v101 建房选局数 → v102 结算统一 → v103 删爆分终止） |
| [`deletion-spec.md`](./deletion-spec.md) | 删号后的数据级联删除 | ⚠️ **三个方案只做了两个**：方案 1+3 已上线（v80），方案 2（对局账本级联删除）**明确没做**，因为选了「只抹身份、不动分数」 |
| [`pattern-fx-audit.md`](./pattern-fx-audit.md) | 牌型特效在哪个阶段可见 | ✅ 已落地（v92–v98）。**本文有两轮，第二轮推翻了第一轮的一个结论** |
| [`circle-table-analysis.md`](./circle-table-analysis.md) | 圆桌化改造的需求分析 | 📌 **快照性质**：设计依据，基线 v81。实际落地状态看归档的 `circle-table-rollout-status` |
| [`achievements-plan.md`](./achievements-plan.md) | 成就系统：数据可行性、22 个成就定义、页面布局、五步实施拆解 | ⏳ **待确认**：需求分析完成，代码未动。文末有 5 个待拍板问题 |

---

## 四、快照文档（历史记录，不要当现状）

| 文档 | 写于 | 覆盖到 | 提醒 |
|---|---|---|---|
| [`circle-table-rollout-status.md`](./circle-table-rollout-status.md) | 2026-10-31 | v104 复核 | **里面写的「线上是 v104 / sw v102」已过期**，现在线上是 v108 / sw v108 |
| [`circle-table-upgrade-review.md`](./circle-table-upgrade-review.md) | 2026-10-30 | 原型阶段 | 对象是原型 `docs/prototypes/circle-table.html`，**不是线上代码** |
| [`v82-implementation-plan.md`](./v82-implementation-plan.md) | — | v82 | 已全部执行并上线，保留为执行清单原件 |
| [`v89-landscape-plan.md`](./v89-landscape-plan.md) | — | v89 | 已上线；落地与方案的唯一差异：迷你牌另做了一档（88×124 → 74×98） |

---

## 五、Review 档案（[`review/`](./review/)）

所有历史 review 原件，**一份没删**。每份头部都写了证据等级与可复跑脚本。

| 档案 | 覆盖 | 结论是否仍成立 |
|---|---|---|
| [`review/archive-v44-v81.md`](./review/archive-v44-v81.md) | v44–v81 | 部分过期。445KB 持续追加日志，价值在「怎么发现的」 |
| [`review/2026-10-30-full.md`](./review/2026-10-30-full.md) | 到 v86 前 | 部分过期。73 个测试全绿前提下仍存在的 73 个问题 |
| [`review/2026-11-01-balance.md`](./review/2026-11-01-balance.md) | v103 | **数值结论全部仍有效** |
| [`review/2026-11-01-v108.md`](./review/2026-11-01-v108.md) | v108 | 主体成立。**但它的 BACKLOG 统计错了**（说 42 条/开 19，实际 46 条/开 17） |
| [`review/2026-11-01-v108-gamejs-split.md`](./review/2026-11-01-v108-gamejs-split.md) | v108 | 成立。`game.js` 8168 → 4710 行拆分的完整记录 |
| [`review/design-maturity-v109.md`](./review/design-maturity-v109.md) | v108 基线 | 本轮新增。设计域 5 维评分 + 8 处规则不一致 |
| [`review/code-analysis-v109.md`](./review/code-analysis-v109.md) | v108 基线 | 本轮新增。工程域全量分析 + 技术债 21 条 |
| [`review/qa-maturity-v109.md`](./review/qa-maturity-v109.md) | v108 基线 | 本轮新增。质量域 14 域盘点 + 9 条盲区 |

**读旧 review 的四个坑**（详见 [`REVIEW.md`](./REVIEW.md) §5.1）：
① 快照不等于现状 ② BACKLOG 条数不能 grep（有五种关闭写法）③ 标题可能比内容旧 ④ 「测试全绿」不等于「能用」

---

## 六、其他

| 路径 | 内容 |
|---|---|
| [`prototypes/circle-table.html`](./prototypes/circle-table.html) | 圆桌原型（单文件，450K）。是设计稿的权威出处，**不是线上代码** |
| [`../scripts/`](../scripts/) | 57 个脚本：探针 / 模拟 / 构建 / 审计。**没有索引**，用前先读文件头注释 |
| [`../.github/workflows/test.yml`](../.github/workflows/test.yml) | CI：语法检查 → 全量测试 → 残留检查 |

---

## 七、维护规则

1. **同一事实只有一个载体**。例如「线上是哪个版本」只写在 `release-progress.md`，
   其他文档一律引用不复述——过去就因为复述导致四处声明互相矛盾（v104 时查出 7 处矛盾）。
2. **新增文档必须在这里登记**，否则等于不存在。
3. **规格文档实施完后不要删**，把状态从「待实施」改成「已实施」并写清落地与方案的差异。
4. **快照文档永不更新**，只在发现被误读时加一句「本文已过期，见 XXX」。
