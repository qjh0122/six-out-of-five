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
| [`BACKLOG.md`](./BACKLOG.md) | 已知问题清单。分 C（结构性工程）/ D（需产品决策）/ B（刻意留下）/ N（历次新发现）四档，每条写明「为什么当时不修」。**刻意不写版本号与基线数字**（见文件头说明） | 2026-11-08 / v138 |
| [`ui-audit-2026-11-07.md`](./ui-audit-2026-11-07.md) | UI 质量审计：质感 / 交互 / 友好度 / 体验。12 项实测数字、8 个问题、三批计划与可机检判据。**头部 v133 是审计当时的基线，不是现状**；文末有 v134–v138 逐批进展注 | 2026-11-08 / v138 |
| [`design-states-v1.md`](./design-states-v1.md) | ~~四态 + 错误三级 + 数字三档的设计规格~~ **已作废**：v137/v138 施工中有 7 处口径被实测推翻。**现行规格是 `design-states-v2.md`** | 2026-11-08 / 作废 |
| [`design-states-v2.md`](./design-states-v2.md) | **现行设计规格**（取代 v1）：只登记改判与证据，不复述 v1 已写对的表格。复核一律以本文件为准 | 2026-11-08 / 现行 |
| [`qa-states-v1.md`](./qa-states-v1.md) | 同一批的验收判据（S1–S20）：每条五段式 + 三条最容易假绿的反例。**判据已随 v137 验收**；文内 151 文件 / 5814 断言是当时的外部事实，现状见 `release-progress.md` | 2026-11-08 / 已验收 v137 |
| [`build-states-v1.md`](./build-states-v1.md) | **施工单**（制作人裁定）：载体清单、互斥口径 ≤1、离线的两种形态、文件级改动、必交断言与变异。三份冲突以本文件为准 | 2026-11-08 / 已施工 v137 |
| [`build-numbers-v1.md`](./build-numbers-v1.md) | **施工单**（v138）：数字阶梯六条裁定（阶梯封闭取代「一屏 ≤3 档」、数+量不进阶梯、角标豁免、媒体只能换档、横屏冠军不许变小）+ 逐选择器映射表 + 变异清单 | 2026-11-08 / 已施工 v138 |
| [`qa-doc-audit-2026-11-08.md`](./qa-doc-audit-2026-11-08.md) | **QA 独立审计输入**：19 条差异（D1–D19），取证全部走 `git show HEAD:<path>` 基准提交，含 4 条阻断级、3 条「并行改动引入」的退回补件。**只读快照，不代表处置结果** | 2026-11-08 / 审计结论 |
| [`doc-consistency-2026-11-08.md`](./doc-consistency-2026-11-08.md) | **制作人处置输出**：逐条差异的改法与误伤评估、唯一事实源表、10 条可机检判据。与上一条是「审计输入 → 处置输出」，不是两份重复清单。**D17/D18/D19 补件与 G1 / D20 / D21 均已闭环；§6 记录过一段「制作人代判」，已被终态复签取代** | 2026-11-08 / 已闭环 · QA 终态复签通过 |
| [`qa-round2-signoff-2026-11-08.md`](./qa-round2-signoff-2026-11-08.md) | **QA 第 2 轮终态复签报告**（独立载体，整份从头写，非首轮审计文件的追加）：AC1–AC10 逐条实测、D1–D21 逐条状态、新增缺陷 N1/N2、判定「**通过**」。**这份才是第 2 轮的验收记录**；首轮审计文件保持 180 行原样，其「不通过」是修改前的正确结论 | 2026-11-08 / QA 终态签字 · 通过 |
| [`PROBES.md`](./PROBES.md) | 探针台账：41 个真浏览器探针各守什么、归谁管（`ci` 5 / `manual` 17 / `oneshot` 19）、最近一次确认绿是什么时候。**生成式**，真源 `scripts/probes.json` + 生成器 `scripts/probes.js` | 2026-11-08 / v138 |
| [`release-progress.md`](./release-progress.md) | 每次发布的完整记录：版本号、改动清单、验收数字。**版本现状的唯一权威** | 2026-11-08 / v138 |
| [`compat.md`](./compat.md) | 兼容性矩阵与降级说明：哪些现代 CSS 特性丢了会怎样、老内核能用到什么程度。**v106 时的实测**，v138 未重跑；要现状就跑对应探针 | 2026-11-01 / v106 |
| [`device-support.md`](./device-support.md) | 机型支持矩阵。「支持」的四条硬指标（组槽不溢出 / 牌面 ≥39 CSS px / 表情入口 ≥44 / 昵称 ≥10.4），三族 23 档实测。**v105 时的实测**，v138 只复跑了 6 档 `probe-ui-flow`（ALL PASS） | 2026-11-01 / v105 |
| [`HISTORY.md`](./HISTORY.md) | 迭代史 v0.2 → v112，十五段。**每段都保留当时的判断失误**；v113 起看 `release-progress.md` | 2026-11-02 / v112（快照） |
| [`repo-public-plan.md`](./repo-public-plan.md) | 仓库公开化治理方案：敏感数据清单、密钥轮换、`.gitignore`、历史清洗两条路线、合规补件 | 2026-11-01 |

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
| [`achievements-plan.md`](./achievements-plan.md) | 成就系统：**35 条成就的现行规格**（名称/门槛/计数来源/展示口径）、计数桶结构、v110→v115 变更单 | ✅ **现行**：已实现并上线过一版；以本文为准，旧版 26 条已作废 |

---

## 四、快照文档（历史记录，不要当现状）

| 文档 | 写于 | 覆盖到 | 提醒 |
|---|---|---|---|
| [`circle-table-rollout-status.md`](./circle-table-rollout-status.md) | 2026-10-31 | v104 复核 | **里面写的「线上是 v104 / sw v102」是当时的快照**。现状一律查 [`release-progress.md`](./release-progress.md) —— 本表不复述版本号，否则每发一版这里就过期一次 |
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
| [`review/probe-triage-2026-11-01.md`](./review/probe-triage-2026-11-01.md) | v109 → v110 | **8 个红探针全部查清：都是脚本过期，不是功能坏**（根因 = v103 建房改两步）。§六 是 v110 补的两条结论（`reset-stats` 是断言早于请求、两个「3」是合法并列） |
| [`review/next-hand-design-2026-11-02.md`](./review/next-hand-design-2026-11-02.md) | v110 | 本轮新增。整局结束后继续玩的**体验**评审：场景矩阵 + 3 个递进方向 + 8 条不建议改 |
| [`review/next-hand-qa-2026-11-02.md`](./review/next-hand-qa-2026-11-02.md) | v110 | 本轮新增。同一段的**状态流**审计：15 条风险（2 P0 / 5 P1）、6 条静默失败、手动复现步骤 |
| [`review/next-hand-summary-2026-11-02.md`](./review/next-hand-summary-2026-11-02.md) | v110 | 本轮新增。**先看这一份**：两个域合并成一页 + 制作人口径的建议（先做 A、只改一条就改 R1） |
| [`review/design-2026-11-07.md`](./review/design-2026-11-07.md) | v129 基线 / HEAD `51b6156` | 设计/体验域重评审，只读文档 + 只读代码。头部自述**没跑 npm test、没跑探针**，结论属线索级 |
| [`review/qa-2026-11-07.md`](./review/qa-2026-11-07.md) | v129 基线 / HEAD `51b6156` | 质量域重新评审；与上一份同基线，可与设计域对照读 |
| [`review/tech-2026-11-07.md`](./review/tech-2026-11-07.md) | v129 基线 | 技术架构与发布就绪度复评。发布清单类结论以当时基线为准，**现状查 `release-progress.md`** |
| [`review/arch-2026-11-06.md`](./review/arch-2026-11-06.md) | v123 基线 | 架构风险与技术债评估（`server/` + `pwa/`），只读 |
| [`review/experience-2026-11-06.md`](./review/experience-2026-11-06.md) | v123 基线 | 体验 Review：一局打完 → 再开一局（普通玩家视角，非工程师视角） |
| [`review/qa-2026-11-06.md`](./review/qa-2026-11-06.md) | 2026-11-06 | 测试体系盲区审计：只对已知盲区做**后果定级**，不重复当新发现 |
| [`best-line-spec.md`](./best-line-spec.md) | v110 已实施 | 「理论最高 vs 实际」的需求分析与口径。**顶部有实施结果表**：三处与方案不同，其中一处是实施时才发现的真 bug |

**读旧 review 的四个坑**（详见 [`REVIEW.md`](./REVIEW.md) §5.1）：
① 快照不等于现状 ② BACKLOG 条数不能 grep（有五种关闭写法）③ 标题可能比内容旧 ④ 「测试全绿」不等于「能用」

---

## 六、其他

| 路径 | 内容 |
|---|---|
| [`prototypes/circle-table.html`](./prototypes/circle-table.html) | 圆桌原型（单文件，450K）。是设计稿的权威出处，**不是线上代码** |
| [`../scripts/`](../scripts/) | 脚本目录：探针 / 模拟 / 构建 / 审计。**条数不在此复述**（以 `ls scripts/*.js \| wc -l` 为准）—— 这里曾写死「62 个」，本轮新增 `check-docs.js` 就把它击穿了，正是 D11 的老毛病。探针清单查 [`PROBES.md`](./PROBES.md) |
| [`../.github/workflows/test.yml`](../.github/workflows/test.yml) | CI：语法检查 → 全量测试 → `journey` 端到端旅途 → `probe-states` / `probe-undo` / `probe-motion` / 「数字阶梯」两档各一行真执行。**生成式一致性由 `pwa/test/probe-ledger.test.js` 在 `npm test` 内校验**（核 PROBES.md == 台账渲染、ci 登记真的在 workflow 里）；`npm run probes:check` 是手动流入口，不是 CI 那一步（QA 审计 D18） |
| [`../scripts/probes.json`](../scripts/probes.json) | **探针台账真源**：41 条、`version: v138`。改台账改这里，再 `npm run probes:doc` 重生成 `PROBES.md`（产物禁止手改） |
| [`../COMMITS.md`](../COMMITS.md) | 提交信息规范（这个仓库曾经 14 条里 11 条叫 `update`）。**规范类，不含版本事实**，所以不放在「现行文档」表 |
| [`../NOTICE.md`](../NOTICE.md) / [`../SECURITY.md`](../SECURITY.md) | 第三方声明 / 安全披露流程。**规范类，不含版本事实** |
| [`../scripts/check-docs.js`](../scripts/check-docs.js) | **文档一致性守**：`npm run docs:check` 单跑；`pwa/test/doc-consistency.test.js` 是薄包装，让它进 `npm test` 的执行链（39 项真实计入总断言）。判据：死链 / review 档案登记 / 当前状态卡片与代码版本 / 生成式台账与真源 / 复述计数锚定 / 现行规格唯一 / 状态头已推进 |

---

## 七、维护规则

1. **同一事实只有一个载体**。例如「线上是哪个版本」只写在 `release-progress.md`，
   其他文档一律引用不复述——过去就因为复述导致四处声明互相矛盾（v104 时查出 7 处矛盾）。
   会随代码变的量（版本号 / 断言数 / 探针数 / CSS 行数 / B3 进度）都按这张表找唯一出处：

   | 量 | 唯一出处 | 怎么复算 |
   |---|---|---|
   | 版本号 / sw | `release-progress.md` 最新一段 | `grep 'CACHE_NAME' pwa/sw.js`；`grep -o 2026110[0-9a-z]* pwa/index.html` |
   | 测试文件数 / 断言数 | `release-progress.md` 最新一段 | `npm test` |
   | 探针条数 / ci 条数 | `scripts/probes.json` | `node scripts/probes.js --check`（= `npm run probes:check`） |
   | 数字阶梯档位值 | `pwa/css/style.css` 的 `:root` | `grep -o 'var(--num-[a-z0-9]*)' pwa/css/*.css \| wc -l` |
   | B3 进度 | `PLAN.md` §P8 | 看每批的 ✅ / ⏳ 标记 |
2. **新增文档必须在这里登记**，否则等于不存在。
3. **规格文档实施完后不要删**，把状态从「待实施」改成「已实施」并写清落地与方案的差异；
   被后续版本取代的标 **作废** 并写出取代者（现行规格同一时刻只能有一份）。
4. **快照文档永不更新**，只在发现被误读时加一句「本文已过期，见 XXX」——
   提醒句里**不许复述当前版本号**，否则每发一版它自己就先过期。
5. **生成式文档改真源不改产物**：`PROBES.md` 由 `scripts/probes.json` + `scripts/probes.js` 生成，
   `npm test` 会校验两边一致；手改产物会被下一次 `npm run probes:doc` 覆盖。
