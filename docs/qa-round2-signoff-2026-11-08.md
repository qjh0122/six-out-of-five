# 《六选五》第 2 轮 · QA 终态复签报告

| 项 | 值 |
|---|---|
| 版本 | **v2** |
| 日期 | **2026-11-08** |
| 作者 | **质量监管负责人 严过关** |
| 状态 | **QA 终态复签** |
| 基准 | 首轮 [`qa-doc-audit-2026-11-08.md`](./qa-doc-audit-2026-11-08.md)（锚定 `e77ba14`，**只读快照，不改、不追加、不回改任何数值**）；其「不通过」是修改前的正确结论 |
| 复核对象 | 当前工作区，**HEAD 以 `git log -1` 为准**（本机核到提交时间 `2026-11-08 21:05:08 +0800`、标题含「D21 措辞收口」；hash 不写死） |
| 载体性质 | **独立报告，整份从头写**。按 QA 流程裁定，终态复签不是首轮审计文件的 §⑥，也不复用首轮正文改结论 |
| 取证性质 | 只读。未改代码、未改其它文档、未改首轮审计文件、未装依赖、未做 git 写操作、未发版；**唯一产出即本文件** |
| 终态判定 | **通过**（详见四、） |

---

## 〇、取证纪律（先自证，再对他人下结论）

### 〇-A 判定工具自验：21/21 通过

凡用来给他人代码 / 数字定性的正则、枚举清单，使用前先构造已知答案样本自测并报数；每组 ≥3 样本、至少 1 命中 + 至少 1 不命中。跑不崩不等于跑得对。

| 组 | 被验工具 | 样本数 | 命中样本（应为命中） | 不命中样本（应为不命中） | 结果 |
|---|---|---:|---|---|---|
| (a) | 中文数字章节 `^## 六、` ↔ 假判据 `^## ⑥` | 5 | `## 六、验收结论`（正判据命中）、`## ⑥ 差异清单`（假判据命中） | `## 6. 结论`、正文「见 ⑥ 与六、」 | **5/5** |
| (b) | 版本串 `2026110[0-9a-z]*` | 5 | `x 20261108a y`→1、`20261108a 20261108a`→2、`20261102v`→1 | `color:red`、`weile-liuxuanwu-v138` | **5/5** |
| (c) | md 相对链接 `LINK_RE` | 4 | `[a](./a.md) [b](../b.md)`→2、`[c](./c.md#section)`→1 | `[x](#anchor)` + 行内代码 `` `./a.md` ``、`[d](./d.js)` | **4/4** |
| (d) | 首轮 AC5 排除正则口径 | 4 | 真硬编码 `P(37 个探针里只有 1 个在 CI 里。)`（两判据都判违规） | `起初**只有 1 个在 CI 里**` 历史叙事行、`全量实跑…931 秒` 实跑记录 | **4/4** |
| (e) | `CACHE_NAME` 尾号提取 | 3 | `weile-liuxuanwu-v138`→v138、`v9`→v9 | `// CACHE_NAME = old` | **3/3** |
| | **合计** | **21** | | | **21/21 通过，0 失败（EXIT=0）** |

**(a) 直接复现了「假判据教训」**：`grep '^## ⑥'` 对中文数字章节 `## 六、验收结论` **恒不命中**（自测输出 `false`），拿它当「复签未产出」的证据属于没做分类器自证的假判据。本轮所有判据都先过这一步，且 (d) 实证了**首轮自己的 AC5 排除正则漏了「起初」这一历史叙事措辞**——见一、AC5 ⚠️。

**真实命中抽 3 条回原文人工复核（3/3 与原文一致）**：
1. `pwa/index.html:10` `<meta name="app-version" content="20261108a">`、`:22` `./js/storage.js?v=20261108a`、`:181` `./css/style.css?v=20261108a`；
2. `scripts/probes.json:3` `"version": "v138"`；
3. `pwa/css/style.css:89–94` `--num-1..4` / `--num-u1..2` = 88/48/32/24/28/20。

> 临时脚本纪律：本轮只读约束只允许写 1 个报告文件，自验脚本一律以 `node -e` 内联执行、**不落盘**；`tools/qa/` 的落盘与跨轮复用要求本轮 **N/A**（如实留白，不假装已有工具）。

### 〇-B 采信矩阵：上游结论逐条复算（事实 / 归因分格）

三列缺一不可：① 我实际执行的命令 ② 我本机跑出的原始输出摘要 ③ 采信判定。③ 拆成「事实」「归因」两格分别复算——只重跑一遍看数字对得上就采信，会放过「事实为真、因果错配」。

| # | 上游结论 | ① 我实际执行的命令 | ② 本机原始输出（摘要） | ③ 事实采信 | ③ 归因采信 |
|---|---|---|---|---|---|
| 1 | 线上 `20261108a` / sw `v138`；本轮纯文档+接线、**没改游戏逻辑 / 没发版 / 没 bump** | `node scripts/probe-online-smoke.js <url>`；`grep -n CACHE_NAME pwa/sw.js`；`git diff --name-status e77ba14 HEAD`；`git diff --name-only e77ba14 HEAD -- pwa/ \| grep -v '^pwa/test/'`；`git diff e77ba14 HEAD -- pwa/sw.js pwa/index.html` | 15/15 EXIT=0、`state.version=20261108a`、`sw.js:13 v138`；21 个改动文件全为 `docs/` + `COMMITS.md` + `README.md` + `package.json` + `pwa/test/doc-consistency.test.js` + `scripts/{check-docs.js,probes.js,probes.json}`；`NO_GAME_LOGIC_CHANGE`；sw / index diff **空**；基准与 HEAD 均 `38×20261108a` / `v138` | 采信·复现 | **采信·复现**：归因不是听自报，是用 diff 独立复算出来的 |
| 2 | 线上冒烟 15/15（制作人 21:09 补跑） | 同上，本机自跑 | `通过 15 项，失败 0 项` / `ONLINE_SMOKE_EXIT=0`；`JS 异常 0`、`console.error 0`、`HTTP>=400 0`、`sw=controlled` | **采信·复现（升级为本机独立实测）** | 采信·复现 |
| 3 | 直抓 `sw.js` = `v138`、页面 `20261108a` | `git show e77ba14:pwa/sw.js \| grep CACHE_NAME` ↔ HEAD；线上冒烟 `state.version` | 两处一致 | 采信·复现 | 采信·复现 |
| 4 | `npm test` = 155 / 6119 / 0 / EXIT=0（两个 QA 实例此前各实跑） | `npm test`（**本轮唯一一次**，跑前已确认无并发测试进程） | `文件 155 个，通过 155 个，失败 0 个` / `断言 6119 项通过，0 项失败，耗时 107.3s` / `NPM_TEST_EXIT=0`；含 `✓ [21/155] pwa\test\doc-consistency.test.js  39 项` | 采信·复现（本机独立实测） | 采信·复现 |
| 5 | 此后 `git diff --name-only` 只有 `doc-consistency` 措辞变化，代码 / 测试面未变 | `git log --oneline e77ba14..HEAD`；`git show --stat --oneline HEAD` | 6 个提交全为 docs / test 接线；末次提交（以 `git log -1` 为准）**仅** `docs/doc-consistency-2026-11-08.md` `6 insertions(+), 6 deletions(-)` | 采信·复现 | 采信·复现 |
| 6 | `npm run docs:check` = 39 项 / 0 失败 | `npm run docs:check` | `通过 39 项，失败 0 项` / `DOCS_CHECK_EXIT=0` | 采信·复现 | 采信·复现 |
| 7 | 全仓 md 相对链接约 116 条、死链 0 | 自写 `node -e` 只读遍历（两条正则口径） | `MD_FILES=58`、`NARROW(./ ../)=104`、`WIDE(all relative .md)=118`、**两种口径死链均 0**；`check-docs.js [1]` 另报 INDEX 内 53 条 / 死链 0 | 事实「死链 0」采信·复现 | **采信·推断修正**：116 属宽口径的措辞增删波动，本轮实测 118；计数差异是口径差异不是缺陷 |
| 8 | 探针台账 41 条 / `version: v138` / ci 5 | `node -e` 解析 `probes.json`；`npm run probes:check`；`sed -n '36,40p' docs/PROBES.md` | `41 / ci 5 / manual 17 / oneshot 19`；`台账校验通过：41 条，磁盘 41 个探针，CI 里跑 5 个` / EXIT=0；分布表逐格相等 | 采信·复现 | 采信·复现 |
| 9 | CSS 5610 / 1243；`var(--num-*)` 31 处（18/13）；六令牌 88/48/32/24/28/20 | `wc -l`；`grep -o 'var(--num-' … \| wc -l`；`grep -nE -- '--num-…:'` | 全部一致 | 采信·复现 | 采信·复现 |
| 10 | 交付标签三处仍写「制作人代判 / QA 未出终态结论」 | `grep -nE '制作人代判\|QA 未出终态\|代判通过'` 三文件 | `doc-consistency:127`（§6 标题）、`INDEX:39`（状态列）、`REVIEW:304`（§1.13 内） | 采信·复现 | 采信·复现 |
| 11 | AC6 目标值随接线变化（基准 154/6080 → 现 155/6119） | `node -e readdirSync`；`npm test`；`git ls-tree e77ba14` | `103+52=155`、`6119`；基准 `102+52=154` | 采信·复现 | 采信·复现（+1 文件 / +39 断言来自薄包装） |
| 12 | 制作人「变异自证 3 条 + 接线变异第 4 条」（改坏 → 守卫红 → 还原 → 全绿） | **未执行**：只读约束禁止改文件做变异 | 无本机输出 | **未覆盖** | **未覆盖（采信上游·未独立复现）**：仅读 `doc-consistency §5:116-123` / `§6:147` 的文字记录，**只当线索，不当判定依据** |
| 13 | G1 已闭环：守卫接进 `npm test` / CI，失败会让整条链红 | 读执行链 `package.json:9,17`、`run-tests.js:28/38/46-51/69/82/108`、`doc-consistency.test.js:24-38`、`.github/workflows/test.yml:49`；本机 `npm test` | 链路闭合；第 21 个文件 39 项真实计入 6119 | 事实「守卫被调用」采信·复现 | **采信·推断修正**：上游用变异自证，我用「执行链静态复算 + parseCounts + exit 传播」复算；变异本身未本机复现，属推断 |

### 〇-C 门禁执行链（纪律：核退出码之外，必须核到它在 CI 的哪一步被调用）

一个写了但从没被接进 `npm test` 的守卫等于没有守卫，而且它的失败也被一并吞掉。本轮把链路逐环读开：

| 环节 | 文件:行 | 复算到的内容 |
|---|---|---|
| CI 那一步 | `.github/workflows/test.yml` 「全量测试」step `:49` | `npm test > /tmp/t.log 2>&1` → `cat` → `exit $code`；CI 用 `npm test` 的退出码判定 |
| npm 入口 | `package.json:9` / `:17` | `"test": "node scripts/run-tests.js"`；另有手动入口 `"docs:check": "node scripts/check-docs.js"` |
| 扫描 | `scripts/run-tests.js:28` `DIRS=['pwa/test','server/test']`；`:38` `/\.test\.js$/` | 新增测试放进目录即自动纳入，**不存在「忘了挂进去」这个失败模式** |
| 执行 / 判红 | `run-tests.js:69` `spawnSync`；`:82` `bad = timedOut \|\| r.status!==0 \|\| c.fail>0`；`:108` `process.exit(failed.length?1:0)` | 子进程退出码与断言失败数都会冒泡到 `npm test` 退出码 |
| 计数 | `run-tests.js:46-51 parseCounts()` | 认「通过 N 项，失败 M 项」，故 39 项真实计入 6119 |
| 薄包装 | `pwa/test/doc-consistency.test.js:24-38` | spawn 真源 `scripts/check-docs.js`、透传输出、失败 `exit 1`、成功 `exit 0`；**不复制任何判据** |
| 真源守卫 | `scripts/check-docs.js:127-130` | `j.version === swVer[1]`，即 `probes.json.version == sw.js` 的 CACHE_NAME 尾号（D1/D18 要求的机检） |
| 本机实测 | `npm test` 日志 | `✓ [21/155] pwa\test\doc-consistency.test.js  39 项` |

**结论**：守卫既被 `npm test` 调用，也被 CI「全量测试」那一步调用，且失败会冒泡到退出码——不是「写了没接」的死守卫。注：制作人的「接线变异第 4 条」本轮未本机复现（见采信矩阵 #12），本判定依据是执行链静态复算 + 本机 `npm test` 实测。

---

## 一、AC 编号沿用不重排（AC1–AC10 逐条一行）

沿用首轮 `qa-doc-audit-2026-11-08.md` §④ 的 AC1–AC10 编号，不重排，便于逐轮 diff。

| 编号 | 首轮判据原文要点 | 本轮实测命令与原始输出 | 判定 | 口径说明（目标值是否随接线变化） |
|---|---|---|---|---|
| **AC1** | `index.html` 唯一版本串且 `grep -c 20261108a`=38；`sw.js` CACHE_NAME 尾号 v138 ↔ 20261108a | `grep -o '2026110[0-9a-z]*' \| sort \| uniq -c` → `38 20261108a`（唯一值 1 个）；`grep -c`=38；`pwa/sw.js:13` `weile-liuxuanwu-v138`；抽 3 条回原文 `:10/:22/:181` 一致 | ✅ | 目标值**不随接线变化**（本轮未改 `pwa/index.html` / `sw.js`）。尾号与页面批次的对应关系由 `release-progress.md:32` 当前状态卡片登记为同一发布批次，非字符串相等 |
| **AC2** | 前 20 行「当前状态」卡片版本 == AC1 值；`grep -c '当前线上：'`=0 | `grep -c '当前线上：'`=0、`grep -c '当前线上'`=0；`release-progress.md:32` `## 当前状态（唯一权威 · 2026-11-08 核对）`，`:40` 写 `` `20261108a` / sw `v138` ``；`docs:check` [2] 组 6/6 全绿，含「★★ 卡片之前没有别的『当前线上』声明」 | ✅ | 不随接线变化 |
| **AC3** | 标「当前 / 现在 / 现状」的行不得出现旧版本串：`INDEX 现在线上是 v108`=0、`INDEX 57 个脚本`=0、`release-progress 当前线上`=0 | 三条 `grep -c` **全部 = 0**；`docs/INDEX.md:68` 已改为「现状一律查 release-progress」「本表不复述版本号」 | ✅ | 不随接线变化 |
| **AC4** | `probes.js --write` 后 `git diff --exit-code -- docs/PROBES.md`=0；`probes.json.version` == sw 尾号（首轮为缺口，须补守卫）；`probe-ledger.test.js` 在 `pwa/test` 且 `run-tests.js:28` 含 `pwa/test`；核执行链 | **子项 `--write`-then-diff 未覆盖**（只读约束禁止写文件，不冒充）→ 三路等价只读复算：① `docs:check` [3] 组 **6/6 绿**（头部版本 / 条数 == 真源、生成器动态化、**★★ 台账 version == sw.js 尾号**）；② `npm test` 内 `probe-ledger.test.js` **33 项绿**（`:48` `L.check({probes,disk,wf})`、r1–r11 自测样本）；③ 只读比对 `docs/PROBES.md:6`「生成于版本 `v138`，共 41 个探针」== `probes.json`。另 `node -e` → `probes.version=v138 / sw.tail=v138 / match=true`；执行链见 〇-C | ✅ | 守卫目标值不随接线变化；首轮「当前无机检，属缺口」本轮已闭环 |
| **AC5** | 写死串排除历史语境后 `wc -l`=0；`probes.json` 41/ci5/manual17/oneshot19 与 `PROBES.md:36-40` 逐格相等 | **字面判据命中 1 行**：`scripts/probes.js:5`「仓库里有一批真浏览器探针，**起初**只有 1 个在 CI 里（probe-ui-flow）」→ 按首轮原排除正则 `wc -l=1` ≠ 0。自验 (d) **4/4** 证明这是**首轮判据排除正则漏了「起初」这一历史叙事措辞**，非产品缺陷；**误伤评估**：改 `:5` 会把「为什么建这个工具」的真实历史缘由写成假的（同 D15 / 首轮反例 2）→ **判据作废/收窄，不改实现**。修正判据（排除正则加 `起初`）实测 `AC5_HITS=0`；生成器 `:163/:172/:176/:204` 已用 `total` / `counts.ci` 动态拼、`docs:check [3]` 两断言守住；`npm run probes:check` → 41 条 / 磁盘 41 / CI 5 / EXIT=0；分布表逐格相等 | ⚠️ | 目标值「0」不随接线变化，但**排除正则需收窄**；这是本轮对**首轮判据本身**的修订，不计缺陷、不改实现 |
| **AC6** | `pwa/test` 102 + `server/test` 52 = **154**；README / REVIEW / release-progress 写 154；**断言 6080 只能 `npm test` 核 → 首轮未覆盖** | `node -e readdirSync` → **103 + 52 = 155**；`npm test`（本轮唯一一次）→ `文件 155 个，通过 155 个，失败 0 个` / `断言 6119 项通过，0 项失败，耗时 107.3s` / `EXIT=0`；活文档 `release-progress.md:42`、`README.md:150` 均写 **155 文件 / 6119 断言**，由 `docs:check [3b]`「★★ README 的计数 == 当前状态卡片」守住 | ✅ | **判据目标值是基准时点值，随接线更新**：新增 1 个薄包装 `pwa/test/doc-consistency.test.js`（+1 文件 / +39 断言）使 154→155、6080→6119，属**预期、有据的变化，不是缺陷**。`154/6080` 的 6 类历史载体（v138 发布验收段 / 审计当时复算值 / 施工单基线 / v2「基线」行 / REVIEW 叙述句 / 首轮审计全文）一律豁免，判据只限定**自称现状的活文档行**。首轮「断言数未覆盖」本轮已补实测 |
| **AC7** | `wc -l` 5610 / 1243（和 6853）；`var(--num-)` 18 + 13 = 31；六行令牌 == 88/48/32/24/28/20 | `5610 / 1243 / 6853 total`；`records=18`、`style=13`；`style.css:89-94` = 88/48/32/24/28/20；抽 3 条回原文一致 | ✅ | 不随接线变化（本轮未改 CSS） |
| **AC8** | `test.yml` 中 `probes:check` 计数允许 0 但须指到 `probes-manual.yml:52`；`probe-ledger.test.js` 必须存在；**写了没接进 `npm test` 的守卫等于没有守卫** | `grep -rn` → `test.yml` 内 `probes:check` 计数 **0**（仅 `:3` 注释提 `npm test`），`.github/workflows/probes-manual.yml:52` `run: node scripts/probes.js --check` 存在；`pwa/test/probe-ledger.test.js` 存在且 `:48` `L.check(...)`；**额外核执行链**：`test.yml:49` → `package.json:9` → `run-tests.js` → 薄包装 → `check-docs.js`，`npm test` 日志 `✓ [21/155] … 39 项` | ✅ | 不随接线变化；「是否真被调用」已核到 **CI 的那一步**，不是只看文件存在 |
| **AC9** | INDEX 对每份 v1 的状态标注与该文档头部「状态」字段不得互相否定；取代者文件真实存在且内容含「取代：v1」 | `INDEX.md:35/36/37` = 已验收 v137 / 已施工 v137 / 已施工 v138；四份 v1 头部 = 已作废 / 已验收 v137 / 已施工并发布 v137 / 已施工并发布 v138，逐对不互相否定；`git ls-tree HEAD -- docs/design-states-v2.md` → `100644 blob 5d1542…`（**已提交**，非 `??`）；`design-states-v2.md:6`「已施工 · 现行规格」、`:7`「**取代：v1**」；`docs:check [4][5]` 8/8 绿 | ✅ | 不随接线变化 |
| **AC10** | `git diff HEAD -- docs/HISTORY.md docs/review/` 为空；`5678 / 20261102v / 147/147` 仍在；把历史段数值改成现值的 diff 一律判红 | `git diff --stat e77ba14 HEAD -- docs/HISTORY.md docs/review/` **空（DIFF_EXIT=0）**；`grep -cE '5678\|20261102v\|147/147' docs/release-progress.md`=**3**，基准 `git show e77ba14:docs/release-progress.md` 同式=**3**（数值未改）；`git status --porcelain` 空；`154/6080` 残留恰好 **6 个文件**，抽查 3 个回原文均带历史标记（`doc-consistency` §1 处置表「文档当时怎么说」栏、`design-states-v2:12` 标「**基线**」、`release-progress` v138 发布段） | ✅ | 判据须限定「自称现状的活文档行」，6 类历史载体豁免；改它们就是把历史写成假的 |

---

## 二、上轮每条缺陷当前状态（D1–D21 + G1）

状态口径：**已修 / 未修 / 回归重开**。每条给可复跑的复算依据。

| 编号 | 状态 | 复算依据（命令 / 文件:行） |
|---|---|---|
| D1 | 已修 | `node -e` → `probes.version=v138 / sw.tail=v138 / match=true`；`scripts/check-docs.js:127-130`「★★ 台账 version == sw.js 的版本尾号」守卫存在且 `docs:check [3]` 绿；接链见 〇-C |
| D2 | 已修 | `scripts/probes.js:163` `const total = probes.length`、`:172/:176/:204` 用 `total` / `counts.ci` 动态拼；`docs:check [3]`「生成器没有写死探针数 / 确实改成动态拼接」两断言绿；`:5` 历史叙事句按 AC5 判据口径豁免 |
| D3 | 已修 | `docs/design-states-v1.md:1-8` 作废横幅「⛔ 本文件已作废」+「取代者：`design-states-v2.md`（现行规格）」+「只加作废标记，不改规格正文」；v2 已提交 |
| D4 | 已修 | `docs/qa-states-v1.md` 状态 = **已验收（v137，2026-11-08）**；`:11` / `:26` 的 `151 文件 / 5814 断言` **原样保留**并加「未复算 · 未覆盖」状态注 |
| D5 | 已修 | `docs/build-states-v1.md` 状态 = 已施工并发布 v137；`:14` / `:56` 补 v138 回指（含判据被改判）；`:55`「本批不做」原文保留 |
| D6 | 已修 | `docs/ui-audit-2026-11-07.md` 头部「基线（**审计当时，不是现状**）」「本文是**快照**…永远不更新」；`20261102v` / v133 / 7310 / 5454 / 1118 一字未改 |
| D7 | 已修 | `docs/release-progress.md:3896`「**这一版还没做的**（**v137 当时**）」+ `:3898`「**回指（v138）**：…已由下一版 v138 完成，且**判据被改判**」；`docs/PLAN.md:426` 同类回指 |
| D8 | 已修 | `docs/PLAN.md:402-416` §P8「**分批发版记录**（唯一进度口径）」表（v136 / v137 / v138 三批）+「**B3 仍欠的三项**」+ 一条验证债 |
| D9 | 已修 | `release-progress.md:32` 唯一「当前状态」卡片、`:48`「历史记录：v129 / v133 段落（当时，保留原文数值）」；`grep -c '当前线上'`=0；`docs:check [2]`「★★ 卡片之前没有别的『当前线上』声明」绿 |
| D10 | 已修 | `docs/INDEX.md:68` 改为「现状一律查 release-progress」「本表不复述版本号」；`grep -c '现在线上是 v108'`=0 |
| **D11** | **回归重开** | `ls scripts/*.js \| wc -l` = **63**；`git ls-tree e77ba14 --name-only scripts/ \| grep -c '\.js$'` = **62**；相对基准新增文件 = `check-docs.js`（本轮守卫）；而 `docs/INDEX.md:111` 仍写「**62 个**脚本」；`check-docs.js [3b]` 只守 INDEX 的「41 个真浏览器探针」，**不守这一行**。首轮建议给了「改 62」与「**更稳妥地去掉写死数字**」两案，制作人选了前者 → 本轮新增 1 个脚本即再次过期。同列为本轮新增缺陷 **N1** |
| D12 | 已修 | `docs/INDEX.md:35-37` 状态列 vs 四份 v1 头部状态逐对不互相否定；`docs:check [4][5]` 全绿 |
| D13 | 已修（附建议级留白） | `docs/build-states-v1.md` 状态头已推进、`:192` 的 `151 文件 / 5814 断言` **数值未改**（硬约束达标）；但「标成『施工前基线』」的加标识动作未见（`:192` 仍写「当前基线」）——首轮「一般」级里的说明性动作，不构成缺陷、不阻断 |
| D14 | 已修 | `git ls-tree HEAD -- docs/design-states-v2.md` → `100644 blob 5d154209…`（真实提交）；`design-states-v2.md:7`「取代：v1」；`docs:check [1]` 死链 0 |
| D15 | 已修（附建议级留白） | `.github/workflows/test.yml:3` 的 `51 个测试文件 / 1700+ 项断言` **一字未改**（硬约束达标；首轮 ①-B 自己标注「历史快照需标注（**不算缺陷**）」）；句首「建 CI 当时」四字标识未添加，属建议级、不阻断 |
| D16 | 已修（附建议级留白） | `docs/PLAN.md:40 / :282 / :283` 的 `37` / `ci 1` / `931 秒` **数值未改**（硬约束达标）；`BACKLOG.md:732` 仍把 N18 列在 `open` 4 条内 → `:40`「N18 仍开放」经核为准确；「当时」标识未添加，属建议级、不阻断 |
| D17 | 已修 | `docs/INDEX.md:136` 规则 #4「快照文档永不更新…提醒句里**不许复述当前版本号**」保留；`docs/ui-audit-2026-11-07.md` 头部**已删** v138 / 6853 的现值复述，改为回指唯一权威；`docs:check [6]` 3/3 绿 |
| D18 | 已修 | `docs/INDEX.md:112` 归因改为「生成式一致性由 `pwa/test/probe-ledger.test.js` 在 `npm test` 内校验…`npm run probes:check` 是手动流入口，不是 CI 那一步」；并补 D1 的 version↔sw 守卫（`check-docs.js:127-130`） |
| D19 | 已修 | `COMMITS.md:105` 改为「加一节 + 更新顶部『**当前状态**』卡片」+「`node scripts/check-docs.js` 会核卡片版本 == 代码」；机检由 `docs:check [2]` 承担 |
| D20 | 已修 | `doc-consistency-2026-11-08.md` §5:112 / §6:143,165 现值一律 **155 文件 / 6119 断言**；`grep -nE '154\|6080'` 只剩 §1 处置表 `:30/:32`（「文档当时怎么说 / 代码事实」栏的**补件前**复算值，属豁免历史载体），不再与「守卫 39/39」并列当现状 |
| D21 | 已修 | `doc-consistency-2026-11-08.md:131/:169` 对象改为「QA 第 2 轮终态复签报告（**独立载体**）未产出」；`:137` 明写「不存在『§⑥ 未追加到审计文件』这个缺陷」；`:148/:164` 写「hash 不写死，以 `git log -1` 为准」；全文无写死 HEAD hash |
| **G1** | **已修（单列）** | `package.json:17` `docs:check` 手动入口；`pwa/test/doc-consistency.test.js:24-38` 薄包装（spawn 真源、透传输出 / 退出码、不复制判据）；`npm test` 日志 `✓ [21/155] … 39 项` 计入 6119；执行链核到 `.github/workflows/test.yml:49`，见 〇-C |

### 单列说明：D20 / D21 / G1

- **D20（事实为真、归因错配）**：处置输出曾并列写「154 文件 / 6080 断言」与「守卫 39/39」，接线后应为 155 / 6119。本轮 `grep -nE '154\|6080\|155\|6119'` 逐行核：§5「本轮结果」与 §6「代判依据 / 最终核验」全部为 155/6119；§1 表格里剩下的两处是「文档当时怎么说 / 代码事实」对照栏的**补件前**复算值，位于处置清单、不是自称现状卡片。按「判据限定到自称现状的活文档行」，这两处属 6 类豁免载体之一，**已修**。
- **D21（会诱导后来者回改只读审计快照）**：曾写「审计文件 §⑥ 未落盘」。本轮核到 §6 已改为「QA 第 2 轮终态复签报告（独立载体）未产出」，并在 `:137` 显式否定那个旧说法、`:148/:164` 去掉写死 hash。**已修**；本报告正是取代该代判标签的独立载体。
- **G1（严重：守卫写了没接进执行链）**：`scripts/check-docs.js` 真源写在 `scripts/`，而 `run-tests.js` 只扫 `pwa/test` + `server/test` 的 `*.test.js` → CI 既看不见红也看不见绿。本轮核到薄包装 + `package.json` 手动入口 + 执行链闭合 + `npm test` 日志实证。**已修**。但「接线变异第 4 条」（改 INDEX 探针数 41→40 → 整个 `npm test` exit 1）本轮只读约束**未本机复现**，属采信上游·未独立复现（采信矩阵 #12）；本判定依据是「执行链静态复算 + 本机 `npm test` 实测」，不是变异自证。

---

## 三、本轮新增缺陷

**共 2 条**，均为首轮 D1–D19 未覆盖、**本轮独立扩大扫描面**发现的文档计数漂移；**都不是**四条闭环条件的缺口，**都不是** D1–D19 的未闭环项，**不阻断本次交付**。

**我是怎么找的（可复跑，不写「看起来没问题」）**：① 把首轮「自称现状的活文档行」判据外推到首轮未扫的两个载体——`README.md` 目录结构段与 `docs/INDEX.md` 第六节脚本计数；② 对每一个写死的计数用本机 `ls … | wc -l` / `wc -l` **独立算期望值**（不引用文档里的数、不引用被测函数）；③ 与 `git ls-tree e77ba14` 对比，定位是哪一轮的哪个新增文件击穿了写死值；④ 逐条做**误伤评估**（是不是带「当时 / 基线 / 快照」标记的历史载体）与**负向断言**（守卫是否覆盖这一行）；⑤ 读 `check-docs.js [3b]` 源码确认这两处不在守卫内。

| 编号 | 描述 | 复现步骤 | 级别 | 建议处理 |
|---|---|---|---|---|
| **N1** | `docs/INDEX.md:111` 自称现状写「**62 个**脚本」，本机实测 `scripts/*.js` = **63**（= 基准 62 + 本轮新增 `scripts/check-docs.js`）；D11 的修复值被本轮变更击穿（**回归重开**）；`check-docs.js [3b]` 不守这一行，故不会变红 | `ls scripts/*.js \| wc -l` → 63；`grep -n '62 个' docs/INDEX.md` → 111；`comm -13 <(git ls-tree e77ba14 --name-only scripts/ \| grep '\.js$' \| sed 's#scripts/##' \| sort) <(ls scripts/*.js \| sed 's#scripts/##' \| sort)` → `check-docs.js` | **一般** | 按首轮 D11 的「更稳妥」方案**去掉写死数字**、改为回指 `PROBES.md`；或补一条 `[3b]` 机检把目录数锚到真源。**不阻断**：不在四条条件内、不影响功能 / 线上 / 守卫 |
| **N2** | `README.md` 目录结构代码块多处写死计数与实测不符：`js/ 30 个模块`→33、`style.css 单文件 5138 行`→5610、`test/ 78 个测试文件`→103、`scripts/ 58 个脚本`→63；该段无「当时 / 基线 / 快照」标识，属自称现状的活文档行，首轮未覆盖、本轮未改、无守卫；与同文件 `:150` 的「155 文件 / 6119 断言」并列易被误读 | `ls pwa/js/*.js \| wc -l`=33；`wc -l pwa/css/style.css`=5610；`ls pwa/test/*.test.js \| wc -l`=103；`ls scripts/*.js \| wc -l`=63；对照 `sed -n '160,179p' README.md` | **建议** | 后续批次更新为现值，或按 `INDEX.md` 规则 #4 加「当时快照」标识并回指唯一权威。**不阻断** |

**明确不计为缺陷的四项**（区分「缺陷」与「判据 / 口径 / 主张」）：

1. **AC5 首轮排除正则漏「起初」** → 是**首轮判据自身的缺陷**，不是产品缺陷；自验 (d) 4/4 已证，按误伤评估「判据作废/收窄，不改实现」，修正后实测命中 0。
2. **全仓链接计数 116（上游）vs 本机 118** → 口径差异（窄 104 / 宽 118），两种口径**死链均 0**；事实采信复现，计数属推断修正。
3. **D13 / D15 / D16 的「加标识」动作未落地** → 三条的硬约束「不改数值」全部达标；首轮 D15 自己标注「不算缺陷」；属建议级留白，不计缺陷。
4. **`154/6080` 在 6 个文件里残留** → 抽查 3 个回原文均带历史标记，属任务明确豁免的 6 类历史载体；写「全仓不得出现 154/6080」这种判据本身就是**会把历史写成假的**错误判据。

---

## 四、可交付判定

# **通过**

首轮「有条件通过」的四条条件**逐条闭环**：

1. **D1–D19 建议动作逐条落地、不改任何历史段数值** → 逐条见二；AC10 实证 `git diff --stat e77ba14 HEAD -- docs/HISTORY.md docs/review/` 为空，`5678 / 20261102v / 147/147` 基准与 HEAD 均 3 处，`git status --porcelain` 为空。
2. **清掉 D17/D18/D19 三条并行改动自引入的不一致，并真正提交 `design-states-v2.md`** → 见二；`git ls-tree HEAD` 返回 `100644 blob`（不是未跟踪的 `??`）。
3. **补上 D1/D18 的 `probes.json.version ↔ sw.js CACHE_NAME` 尾号机检守卫，并确认接在 `npm test` 执行链里** → `check-docs.js:127-130`、`docs:check [3]` 绿、`npm test` `[21/155] 39 项` 计入 6119；**核到它在 CI 的哪一步被调用**：`test.yml:49` → `npm test` → `run-tests.js` → 薄包装 → 真源，失败冒泡到退出码（〇-C）。
4. **第 2 轮按五块结构整份重写；AC6 断言数与线上 15/15 补实测** → 本文件；AC6 = **6119**（本机 `npm test`）、线上 = **15/15**（本机 `probe-online-smoke`），**均不再标「未覆盖」**。

**本机独立实测汇总**：`npm test` 155/155/6119/0/EXIT=0；`npm run docs:check` 39/0/EXIT=0；`npm run probes:check` 41 条/EXIT=0；线上冒烟 15/15/EXIT=0（版本 `20261108a` == 本地、SW 接管、JS 异常 / console.error / HTTP≥400 全 0）；判定工具自验 21/21；采信矩阵 13 条中「未覆盖」仅 1 条（变异自证，采信上游）。

> **交付标签可从「制作人代判 / QA 未出终态结论」升级为「QA 已验收通过」，三处（`docs/doc-consistency-2026-11-08.md` §6 标题、`docs/INDEX.md` 状态列、`docs/REVIEW.md` §1.13）由制作人翻转。**

**条件**：无技术性条件。唯一**流程性**动作是上述三处标签翻转（由制作人执行；本轮 QA 只读，不改其它文档）。N1 / N2 两条范围外缺陷列为**后续批次处置项**，不是交付前置条件；代判留痕「不构成 QA 验收记录」的效力，自本报告签字起终止。

**必须显式写出的一点**：本报告只有自动化结果与一次 headless 线上核对，**没有真人试玩**。155 文件 / 6119 断言 / 39 项文档守 / 15/15 冒烟全绿只证明「没崩」，**证明不了「好用」**；「全绿」与「玩家能玩」之间没有任何关系。本轮纯文档 + 测试接线变更、未改游戏逻辑、未发版，故手感三判据本轮 N/A，不得据本轮全绿推断手感达标。

---

## 五、取证限制与未覆盖项（如实留白，不脑补补齐）

### 五-A 只读约束与变更范围

未改代码、未改其它文档、未改首轮审计文件、未装依赖、未做 git 写操作（无 commit / add / checkout）、未发版；唯一产出即本文件。`git diff --name-status e77ba14 HEAD` 共 21 个改动文件，`pwa/` 除 `pwa/test/` 外 **零改动**，sw.js / index.html 版本行 diff 为空 → 「纯文档 + 测试接线」这个归因是独立复算出来的，不是采信自报。

### 五-B 真人冷启动与实际渲染帧验收 N/A

- 本轮**没有新的可玩交付**，因此没有「关掉一切、从浏览器地址栏冷启动、不点文件、不看 README、不用任何调试钩子，走到第一个决策点」的**真人路径**；也没有真人试玩录屏、没有 Movie Maker 帧。只走调试钩子 / 注入式脚本的验收一律不算数。
- 线上冒烟由脚本 spawn headless Edge 走 CDP，产出一帧 390×844 自动化渲染截图（`%TEMP%\lxw-smoke\online-390x844.png`），并以 `state.auth='flex'` / `loginBtn='登录'` / `bodyText` 非空判「不是白屏」。**它是自动化渲染帧，不是真人试玩录屏**，不能替代视觉交付所要求的实际真人帧；本轮不据此宣称视觉验收通过。
- **三条手感判据（操作响应 / 消除时机 / 穿模）本轮 N/A，非「通过」**：这三类缺陷只有在「能玩的东西」上才测得出来。历史教训是 `tsc` 0 错 / 11 守卫全绿 / 9/9 阳性对照 / 24 项浏览器验收全过，仍漏掉「上下左右操作不顺畅」「炸弹爆炸后不消失」「角色还能在墙上跑」；且那 24 项**全部通过调试钩子主动调 API**——玩家没有那个钩子。本轮无新可玩版本，故不判这三项。

### 五-C 未覆盖子项

1. **AC4 的 `node scripts/probes.js --write` + `git diff --exit-code -- docs/PROBES.md` 子项**：只读约束禁止 `--write`，**未亲自跑**；以 `docs:check [3]` / `probe-ledger.test.js` / 只读比对三路等价复算替代（见一、AC4）。
2. **制作人的「变异自证 3 条 + 接线变异第 4 条」**：需改文件，禁止；**采信上游·未独立复现**（`doc-consistency §5:116-123`、§6:147），只作线索不作判定依据。
3. **`tools/qa/` 落盘与跨轮工具复用**：本轮只允许写 1 个报告文件，自验脚本 `node -e` 内联未落盘；**N/A**，不假装已有工具。
4. **线上冒烟只覆盖 1 个视口（390×844）与 1 个 sharecode**；12 视口 UI 巡检 / journey / 四态 / 数字阶梯两档属 CI 的 `ui-probe` / `journey` job，本轮**未本机复跑**（读 `.github/workflows/test.yml` 确认其步骤存在，但实跑结果采信 CI 配置之外的记录，未独立复现）。
5. **真人试玩录屏 / Movie Maker 帧 / 冷启动真人路径**：见五-B，N/A。

### 五-D 我自己实际跑过的命令（区分「本机独立实测」与「采信上游回传」）

**本机独立实测**（每条都有本轮原始输出，见对应小节）：

1. `git log -1 --oneline` / `git log -1 --format='%H%n%ad%n%s' --date=iso` / `git status --short` / `git status --porcelain` / `ls docs/`
2. `grep -o '2026110[0-9a-z]*' pwa/index.html | sort | uniq -c`；`grep -c 20261108a pwa/index.html`；`grep -n CACHE_NAME pwa/sw.js`
3. 三条旧现状串 `grep -c`（`当前线上：` / `当前线上` / `现在线上是 v108` / `57 个脚本`）；AC5 写死串与修正判据 `grep … | grep -v … | wc -l`
4. `node -e`（`readdirSync` 数 `.test.js` = 103 / 52；解析 `probes.json` = 41 / 5 / 17 / 19；`version↔sw` 尾号 `match=true`）
5. `wc -l pwa/css/style.css pwa/css/records.css`；`grep -o 'var(--num-' … | wc -l`；`grep -nE -- '--num-[1-4u][0-9]*:' pwa/css/style.css`
6. `cat .github/workflows/test.yml`；`grep -rn 'probes:check|probes.js --check' .github/workflows/`；各文档 `sed -n` / `grep -n` 落点
7. `git ls-tree HEAD -- docs/design-states-v2.md`；`git cat-file -t e77ba14`；`git show e77ba14:<path>`；`git log --oneline e77ba14..HEAD`；`git show --stat --oneline HEAD`
8. `git diff --name-status e77ba14 HEAD`；`git diff --name-only e77ba14 HEAD -- pwa/ | grep -v '^pwa/test/'`；`git diff e77ba14 HEAD -- pwa/sw.js pwa/index.html`；`git diff --stat e77ba14 HEAD -- docs/HISTORY.md docs/review/`
9. 判定工具自验 `node -e`（21/21，EXIT=0）；全仓链接计数 `node -e`（58 / 104 / 118 / 死链 0，EXIT=0）；README 目录树各项 `ls … | wc -l` / `wc -l`
10. `node scripts/probe-online-smoke.js "https://your-app.app.workbuddy.host/?sharecode=REDACTED"` → 15/15 / `ONLINE_SMOKE_EXIT=0`
11. `npm test`（**本轮唯一一次**，跑前 `ps -W` + PowerShell `Get-CimInstance Win32_Process` 确认无并发测试进程）→ 155/155/6119/0/107.3s/`NPM_TEST_EXIT=0`
12. `npm run docs:check` → 39/0/`DOCS_CHECK_EXIT=0`；`npm run probes:check` → 41 条 / 磁盘 41 / CI 5 / `PROBES_CHECK_EXIT=0`
13. PowerShell `Test-Path 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'` → `EDGE_EXISTS=True`
14. Grep 工具：交付标签三处、`REVIEW.md` §1.13 定位、`回指（v138）|N18` 补核、`154/6080` 残留分布

**采信上游·未独立复现**（不冒充自己实跑）：

- 制作人 21:09 的线上冒烟 15/15 → **已本机自跑，升级为独立实测**（不列入此项）
- 两个 QA 实例此前在旧提交附近的 `npm test` → 已本机自跑，采信·复现
- **变异自证 3 条 + 接线变异第 4 条 → 未覆盖**（只读约束）
- CI 的 `ui-probe` 12 视口 / `journey` / 四态 / 数字阶梯两档实跑结果 → 本轮未本机复跑
- 首轮审计 `docs/qa-doc-audit-2026-11-08.md` 的 19 条差异与「不通过」结论 → 只作为**只读基准载体**采信；其数值本轮一律独立复算，**未直接引用作判定依据**

---

> 本报告取代 `doc-consistency-2026-11-08.md` §6 的「制作人代判」标签，成为第 2 轮终态验收记录。首轮审计文件保持 180 行原样——那是**修改前**的正确结论，按流程就该原样保留。
> 再强调一次：**「文档一致」与「能玩」之间没有任何关系；门禁全绿只证明没崩，证明不了好用。**

---

## 六、签字后处置（制作人执行，2026-11-08 21:35）

本报告签字的时点快照：`docs/INDEX.md` 写「62 个脚本」（实测 63）、`README.md` 目录树写
`js/ 30`、`style.css 5138 行`、`test/ 78`、`scripts/ 58`。签字后制作人按 §三 的 N1 / N2 做了处置。
**本报告的一至五节一字未改**，判定与证据保持签字时的原样；下面只记录签字后的动作，
避免「报告里的实测值」与「提交后的文件」对不上。

| 缺陷 | 签字时 | 处置 | 为什么不是直接把数字改成现值 |
|---|---|---|---|
| N1 | `INDEX.md:111`「62 个脚本」 | 改为「**条数不在此复述**（以 `ls scripts/*.js \| wc -l` 为准）」，并写明它曾被本轮新增的 `check-docs.js` 击穿 | 改成 63 只是把下一次漂移推到下一个新增脚本 —— D11 的教训正是「写死值必然被下一轮变更击穿」 |
| N2 | `README.md` 目录树四处 | 四处一并去掉写死计数：`js/` 只写职责、`css/` 只写主文件、`test/` 指向 `npm test` 那一行、`scripts/` 指向 `PROBES.md` | 同上；且 README 是新人入口，过期的规模数字比不写更有害 |

**处置后复验**：`npm run docs:check` 39/39；全仓 md 相对链接死链 0；`git diff --name-only` 只涉
`README.md` / `docs/INDEX.md` / `docs/REVIEW.md` / `docs/doc-consistency-2026-11-08.md` / 本报告
共 5 个 markdown 文件，**未改 `pwa/`、未改测试、未 bump 版本**。

**本附录不改变「通过」的判定**：N1 / N2 在你签字时已明确定性为「范围外、不阻断」，
处置方式（去写死而非改现值）也与你 §三 的建议一致。
