# 仓库公开化治理方案 —— 六选五（公开仓库 v1）

- 版本：v1（2026-11-02）
- 作者：柯桥良（技术架构总监）
- 适用仓库：`https://github.com/qjh0122/five-out-of-six.git`（当前 private，HEAD = `69ddb66`，202 个提交，286 个已跟踪文件，`.git` 8.6MB）
- 本文定位：**方案与清单**，不含任何已执行动作。所有命令均由实施者（主程序）执行，本人不落地、不装环境。
- 事实核验方式：全部结论来自对本工作区的只读检查（`git ls-tree` / `git cat-file` / `git rev-list` / 源码阅读）。凡未实测的技术点，统一落在 §8「待实测项」。

---

## 0. 结论先看

1. **不能直接点 "Make public"。** 此刻公开，等于同时公开：一把有「全量导出 + 删库 + 改任意人密码」权限的 admin 密钥（在 14 个提交里，`git show` 一条命令就能取）、8 个真实玩家的 scrypt 盐与哈希、118 场战绩，以及 336KB 内部开发记录。
2. **密钥必须轮换**（不是"建议"）。删文件 ≠ 删历史，历史里那把永远是公开的。
3. **历史里的密钥无法靠"删文件 + .gitignore"补救**，只有两条路：清洗历史（路线 A）或新建干净仓库（路线 B）。**推荐路线 B**（理由见 §4.1：真实昵称散落在 15 个文件**正文里**，路径级清洗清不掉，路线 B 是唯一"可证明干净"的做法）。
4. `profiles.json` **应当出库**，用 `profiles.example.json`（结构样例）+ `SEED_FILE` 环境变量替代；服务端缺种子不会崩（已核实源码），只是首次部署没有历史账号。
5. `.workbuddy/` 12 个文件**应当整目录出库**：5 个 memory 文件是开发日记（含真人昵称与对话细节），2 个探针脚本写死了线上主机与 sharecode 默认值。
6. 公开前还有一道**门禁**卡在素材授权上：`pwa/assets/` 下 6 个 mp3、13+ 个 emoji png 来源未明，第三方素材没有授权就不能公开分发（只能替换或下架，无法降级）。

---

## 1. 敏感数据全清单

### 1.1 主表

| # | 路径 | 现状 | 内容性质 | 泄露后果 | 处置动作 |
|---|---|---|---|---|---|
| 1 | `server/data/profiles.json`（15,505B） | **已跟踪**（自初始提交 `4f8262b` 起，202 个提交全含） | 8 个真实玩家：`account{name, salt(32hex), hash(64hex), createdAt, lastLoginAt, disabled}`，其中 7 个带 `tv`；外加 nickname 与完整战绩（`games=118` 合计、`recent` 共 106 条，每条含 `roomId/endedAt/net/playerCount/endReason`） | ① scrypt 盐与哈希可离线爆破（无明文密码，但拿到哈希即靶子）② 玩家身份 + 玩了多久 + 输赢曲线全暴露 ③ `disabled`/`tv` 暴露账号状态与版本 | **出库**：`git rm --cached` + 入 `.gitignore`；新增 `server/data/profiles.example.json`（2 条合成记录）替代；真实种子改由 `SEED_FILE` 指向仓库外（见 §3） |
| 2 | `server/backup-key.txt`（49B blob = 48 字符 key + LF） | **已删除，但留在历史**：精确统计 **14 个提交**含该 blob（`4f8262b` … `8d0d131`；`git log -- path` 只显示 4 条是因为另外 2 条是删除提交，容易误判为"只有 4 个提交") | admin 密钥。权限：`/api/leaderboard?full=1` 全量导出、`/api/admin/{reset,reset-stats,disable,delete,setpass,…}` | **最高危**：等于把「导出全部玩家档案 + 清空线上数据 + 删任意账号 + 改任意人密码」的钥匙贴在墙上。任何 clone 的人 `git show <sha>:server/backup-key.txt` 即得 | **必须轮换**（§2）+ 历史必须清除（§4）+ CI 加密钥形态门禁 |
| 3 | `.live-after.json`（13,106B） | **已删除，但留在历史**：仅 1 个提交 `89f8351`（移除于 `08864af`） | 线上全量快照（playerId / nickname / 战绩聚合） | 与 #1 同级的 PII 外泄 | 历史清除（路线 B 天然不携带；路线 A 需 `--path .live-after.json`） |
| 4 | `.workbuddy/memory/*.md`（5 个，合计 **336,632B**：`2026-10-28` 119,111B / `-29` 38,749B / `-30` 94,550B / `-31` 62,033B / `11-01` 22,189B） | **已跟踪**（初始提交起） | 逐日开发过程记录：内部决策、用户交互细节、真实昵称与账号名（3 个文件命中）、密钥处置过程 | 既是 PII，也是「内部怎么想、哪里出过事」的全量档案 → 对攻击者是路线图 | **出库** + `.workbuddy/` 整目录忽略。文件保留在本机（工作区不删） |
| 5 | `.workbuddy/snapshot/`（6 个：`archive-2026-10-28/` 下 4 个 index.html（1,983 / 36,272 / 946 / 7,973B）+ `remote-e2e.js` + `ws-probe.js`） | **已跟踪** | 线上页面归档快照 + 手工 WS 探针；`remote-e2e.js` 第 14 行写死 `HOST = 'liuxuanwu.app.workbuddy.host'`、第 15 行默认 `SHARECODE='〈房号口令·已脱敏〉'` | 泄露线上主机与进房口令；快照含当时的页面内容 | **出库**（功能性已有 `scripts/probe-*.js` 覆盖，无需保留在仓库） |
| 6 | `.workbuddy/applications.yaml`（76B） | **已跟踪** | 部署标记：`name: 六选五` + `locator: wbapp_aRP2Ax752DwzlnMeUDQ04H` | 低（仅平台 id），但属"本机工具产物" | **出库**。理由：同类 `.wbapp_*.genie` 已在 `.gitignore`，口径应一致 |
| 7 | `REVIEW.md`（**445,780B**） | **已跟踪** | 内部 review 总档。命中 **16 处真实长昵称 + 8 处账号名**；另含密钥处置细节、线上主机、历史安全处置记录 | ① PII ② 「哪里曾经出过安全问题 + 怎么修的」= 给攻击者的操作手册 | **出库**，或脱敏（替换全部真实昵称/账号、删主机与密钥段落）后只留一份精简版 |
| 8 | `REVIEW-FULL-2026-10-30.md` / `REVIEW-v108-2026-11-01.md` / `REVIEW-2026-11-01.md` / `docs/release-progress.md`(114KB) / `docs/BACKLOG.md`(105KB) / `docs/deletion-spec.md` / `docs/circle-table-*.md` | **已跟踪** | 过程文档：发布记录、待办、删除规格、改造分析；`deletion-spec.md` 命中 5 处真实昵称、`circle-table-analysis.md` 命中 3 处 | 中：主机信息、内部决策、部分 PII | 建议整批移入私有归档；若想展示工程过程，另写一篇脱敏的 `docs/engineering-notes.md` |
| 9 | `scripts/probe-records-cloud.js:282` | **已跟踪** | 硬编码真实昵称 + `token: 'fake-token-for-probe'` | token 是假的（无风险），昵称是真 PII | 改为 `玩家A` / `test_acc` |
| 10 | 测试与探针把真实昵称当 fixture：`pwa/test/replay-scrub.test.js`(14) / `pwa/test/session-log.test.js`(5) / `pwa/test/records-replay.test.js`(3) / `pwa/test/{avatar,big-fx,error-report,resubmit,revise,table-layout}.test.js`(各 1) / `scripts/probe-records.js`(7) / `docs/prototypes/circle-table.html`(1) / `pwa/css/*.css`+`server/profile.js`+`server/test/ai-records.test.js`(各 1，疑似短昵称撞词的假阳性) | **已跟踪** | 真实玩家昵称被当作测试数据 | 轻度 PII（可反查到"谁在玩"） | 批量替换为 `玩家A/玩家B/玩家C`；假阳性项顺手核对一眼即可 |
| 11 | `node_modules/.bin/semver{,.cmd,.ps1}` | **已删除，但留在历史** | 依赖 shim（误提交） | 无（仅体积） | 可选：清理历史时一并 `--path node_modules` |
| 12 | `pwa/assets/audio/*.mp3`（6）、`pwa/assets/emoji/*.png`（13+）、`card_back.webp`、`pwa/icons/**` | **已跟踪** | 素材文件，**来源与授权未记录** | **版权风险**：第三方素材不得随公开仓库分发 | **门禁**：公开前逐个确认来源；自制→随 LICENSE；第三方→持授权写入 `NOTICE`，否则替换/下架（无降级路径） |
| 13 | `README.md:7` | **已跟踪** | `线上：https://liuxuanwu.app.workbuddy.host/?sharecode=〈房号口令·已脱敏〉` | sharecode 是**进房口令**，公开等于把口令贴在墙上 | 改为裸域名 `https://liuxuanwu.app.workbuddy.host/`（足以"试玩"，不暴露具体房号） |
| 14 | 本机 `server/backup-key.txt`（当前 64B，**未跟踪**，已被 `.gitignore` 挡住） | **从未跟踪** | 当前生效密钥（注意：历史里是 48 字符，本地已是 63 字符 → v47 已轮换过一次；但 `REVIEW.md` 同时记录"线上还是旧密钥，下次发布后才切换"，**线上当前用哪把必须现场确认**） | 若跟着"整目录拷贝/压缩包"外流，则等于再次泄露 | 内容视为敏感：不进快照、不进压缩包、不贴聊天；轮换见 §2 |
| 15 | `~/.lxw-appdata/profiles.json` / `$DATA_DIR/profiles.json`（线上主数据文件）、`dist/`、`tmp-shots/`、`.wbapp_*.genie`、`*.log` | **从未跟踪**（已被忽略或在仓库外） | 权威数据 / 构建产物 / 日志 | 现状正确 | **保持**。注意 `*.log` 含 `ws connect <ip>`（`server/index.js:1337`），别把日志上传到 issue |

### 1.2 对制作人所给事实的三处纠偏（重要）

| 制作人给的 | 实测 | 影响 |
|---|---|---|
| `backup-key.txt` 出现在 4 个提交：`4f8262b/0c03e26/8d0d131/e67bf12` | **14 个提交含该 blob**（`git rev-list --all` 逐个 `cat-file -e` 得到）；`8d0d131`/`e67bf12` 是**删除**提交，文件已不在树里。危害窗口 = `4f8262b`→`8d0d131` | 只按 4 个 SHA 去清历史会漏掉 10 个提交 → **必须按路径清**，不能按提交清单清 |
| `.workbuddy/` 12 个文件"是否需要你判定" | 全部 **12 个都在初始提交 `4f8262b`** 里，非后续误提交 | 意味着它们存在于全部 202 个提交 → 路线 A 必须 `--path .workbuddy` 整目录清 |
| `server/data/profiles.json` 灾备"靠它恢复账号" | 它只是**种子**；线上权威是 `~/.lxw-appdata/profiles.json` 或 `$DATA_DIR/profiles.json`（`server/profile.js:113-122`） | 出库不会丢线上数据；灾备方案要改成「主文件备份 + SEED_FILE」两件套（§3.4） |

---

## 2. 密钥轮换判定

### 2.1 判定：必须轮换（无条件）

- 事实：blob 存在于 **14 个提交**，`git show <sha>:server/backup-key.txt` 一条命令即得。
- 该密钥的权限（逐条从源码确认）：
  - `GET /api/leaderboard?full=1` → 全量导出所有玩家档案（`server/index.js:752-757`）
  - `POST /api/admin/reset` → 清空（`:795-799`）
  - `POST /api/admin/*`（disable / delete / setpass / reset-stats…）→ `:1187-1188` 统一校验
- 结论：**历史里那把永久作废**。即使工作区本地文件已换过（48→63 字符），只要线上跑的还是历史里那把，"已泄露"就成立且可直接利用 → **本轮再换一把新的**，成本 = 一条环境变量。

### 2.2 落地方式（代码已支持，不需要改读密钥的代码）

已核实的两处优先级：`process.env.BACKUP_KEY` 优先，为空才读文件。

- `server/index.js:114-120`：`readBackupKey()` → `if (process.env.BACKUP_KEY) return ...; try { readFileSync(BACKUP_KEY_FILE) }`
- `scripts/backup-leaderboard.js:29-31`：同样先读 env

**做法**：密钥只走环境变量，仓库里永远没有它的身影。

1. 生成新密钥（64 hex，比原 48 字符更稳）：
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. 注入部署环境：平台环境变量面板 / 容器 env，键名 `BACKUP_KEY`，值 = 上一步输出。**不要**写进任何文件、不要贴聊天、不要进截图。
3. 重启或发布一次使其生效（进程启动时读一次）。
4. 验收两条（任一不过就是没生效）：
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' \
     -H "x-backup-key: <新密钥>" \
     'https://liuxuanwu.app.workbuddy.host/api/leaderboard?full=1'
   # 期望 200

   curl -s -o /dev/null -w '%{http_code}\n' \
     -H "x-backup-key: <历史里那把旧密钥>" \
     'https://liuxuanwu.app.workbuddy.host/api/leaderboard?full=1'
   # 期望 403
   ```
5. 本机收尾：把 `server/backup-key.txt` 的内容清空或删除（本地不再需要——env 优先），至少确认它仍在 `.gitignore` 里。

### 2.3 怎么避免再入库（三道）

1. `.gitignore` 保留 `server/backup-key.txt`（并追加 `auth-secret.txt`、`*.key`、`.env*`）。
2. **改掉"会自己把密钥写回仓库"的脚本**：`scripts/backup-leaderboard.js:37` 有 `fs.writeFileSync(KEY_FILE, key + '\n')`，等于把密钥重新落进 `server/` 目录 → 必须改成"有 `BACKUP_KEY` 就不写文件，写也只允许写仓库外路径"。
3. CI 门禁（阻断型，无运行时降级，见 §5）：在 `test.yml` 加一步，扫已跟踪文件里的"单行 48/63/64 位十六进制/字母数字串"，命中即 fail。

### 2.4 一句话记住

> **删文件 ≠ 删历史。** `git rm --cached` 只是让"未来"不再包含它；"过去"的 14 个提交里它一字未改地躺着，一个 `git clone` 就是一次完整泄露。

---

## 3. `.gitignore` 重构方案

### 3.1 完整文件全文（直接覆盖现有 `.gitignore`）

```gitignore
# ============================================================================
# 六选五 · 忽略规则（公开仓库版 · v1 · 2026-11-02）
# 原则：凡「只在本机有意义」「含真实玩家数据」「可再生成」的一律不进来。
# 改完自查：git status --ignored --short | head -40
# 设计依据见 docs/repo-public-plan.md §3
# ============================================================================

# ---------- 1. 依赖 ----------
node_modules/
.pnpm-store/

# ---------- 2. 秘密：永不入库，只走环境变量 ----------
# 备份导出密钥：?full=1 全量导出与 /api/admin/* 共用它。
# 历史里曾以 48 字符形态存在于 14 个提交（已确认为泄露），一律轮换 +
# 改用 BACKUP_KEY 环境变量；本机文件仅作兜底，绝不 git add。
server/backup-key.txt
# 令牌签名密钥（默认落在数据目录，即项目外）；这里兜一层防手改路径
auth-secret.txt
.env
.env.*
*.pem
*.key
*.p12
*.pfx

# ---------- 3. 真实玩家数据 ----------
# 真实档案一律不入库：profile.js 支持 DATA_DIR / SEED_FILE 指向项目外。
# 结构样例 profiles.example.json 必须保留（下面有 ! 例外），它是
# 「这个文件长什么样」的唯一公开答案，也是 persist.test.js 的校验目标。
server/data/*.json
!server/data/profiles.example.json
# 损坏留档（profile.js 会改名成 *.corrupt-<ts>）、写盘中间文件
*.corrupt-*
server/data/*.tmp
# 头像照片目录（P1b，默认关闭）
server/data/avatars/

# ---------- 4. 线上快照 / 探针输出：含账号盐与哈希 ----------
.live-*.json
*.live.json
tmp-shots/
probe-out/

# ---------- 5. 内部工作台记录：开发日记 + 平台标记 + 线上快照 ----------
# 含真人昵称、对话细节、线上主机与 sharecode 默认值，公开仓库一律不要
.workbuddy/
.wbapp_*.genie

# ---------- 6. 构建产物 ----------
# 原型单文件产物（scripts/build-proto.js 生成，450K）：需要时跑一次即可，
# CI 用 build-proto.js --check 保证产物与源不漂
dist/
*.tgz

# ---------- 7. 日志 ----------
*.log
npm-debug.log*
logs/

# ---------- 8. 编辑器 / 操作系统临时文件 ----------
.DS_Store
Thumbs.db
desktop.ini
.idea/
.vscode/
*.swp
*.swo
*~
```

**为什么保留现有几条**：`node_modules/`、`.wbapp_*.genie`、`*.log`、`.DS_Store`、`dist/`、`tmp-shots/`、`.live-*.json`、`server/backup-key.txt` 这 8 条是上一轮已经吃过教训（`node_modules/.bin` 误提交、`.live-after.json` 误提交）的产物，一条都不能删。

**新增的关键两条**：`server/data/*.json`（配 `!profiles.example.json` 例外）与 `.workbuddy/`。注意写法——只有 `server/data/*.json` 过滤文件、不写 `server/data/` 目录，`!` 例外才生效。

### 3.2 数据目录取舍策略

| 文件 | 结论 | 理由 |
|---|---|---|
| `server/data/profiles.json` | **出库**（`git rm --cached`，本地保留） | 8 个真实账号 + 118 场战绩（§1 #1）；公开 = PII 泄露 |
| `server/data/profiles.example.json` | **入库**（新建） | 结构样例：2 条纯合成记录，`salt` 用 `0000…`(32)、`hash` 用 `ffff…`(64) 这种一眼假的形态，昵称用 `玩家A/玩家B`；同时充当 `persist.test.js` 的新校验目标 |
| `server/data/avatars/` | 忽略 | 用户上传照片 |
| 真实种子 | **仓库外**，`SEED_FILE` 指过去 | `server/profile.js:130-132` 已支持 `process.env.SEED_FILE` |

### 3.3 忽略 `profiles.json` 之后，服务端会怎样（已核实源码，非推测）

`server/profile.js:207-236` `_load()` 的判定链：

1. 主文件 `ok` → 主文件即为权威（哪怕内容是 `{}`，也不拿种子反向覆盖）；
2. 主文件 `corrupt` → 先改名留档（`*.corrupt-<ts>`）再走种子；
3. 主文件 `missing` → 读种子文件：
   - 种子 `ok` 且非空 → 载入 + `restoredFromSeed = true` + 立刻写回主文件（`:232-234`）；
   - 种子 `missing` → `seed = null` → **不载入、不报错、不抛异常**，store 为空，服务正常启动（`:225-235`）。

**结论**：忽略种子不会让服务起不来，**只会让首次部署没有任何历史账号与榜单**。所以真实数据必须靠 `SEED_FILE` 或"部署后手工导入"补上——这不是可选项。

### 3.4 灾备替代方案（三条缺一不可）

| # | 做法 | 口径 |
|---|---|---|
| ① | 线上主文件才是权威：`~/.lxw-appdata/profiles.json` 或 `$DATA_DIR/profiles.json` | 备份动作 = `npm run backup`（走 `?full=1` 拉全量）→ 但**输出必须落到仓库外**（见 §3.5 改动 1） |
| ② | 仓库外存档：`/d/backup/profiles-live-YYYYMMDD.json` + 一份异地（私有仓库/网盘） | 建议纳入发布流程：每次发布前存一份，保留最近 7 份；文件本身按"秘密"对待 |
| ③ | 容器重建恢复：`SEED_FILE` 指向挂载卷里的存档 | 不挂卷 = 重建即空库。恢复时机在首个请求之前（`_load()` 同步完成） |

### 3.5 配套代码改动清单（**交主程序**，共 4 条，都是小改）

| 文件:行 | 改成 | 不改的后果 |
|---|---|---|
| `scripts/backup-leaderboard.js:21` + `:143` | 输出目标改为 `process.env.SEED_FILE \|\| <仓库外默认路径>`，不再默认写 `server/data/profiles.json` | 每跑一次备份就把真实数据重新灌回仓库目录（虽被忽略，但一次 `git add -f` 就进去了） |
| `scripts/backup-leaderboard.js:37` | 有 `BACKUP_KEY` 环境变量时不写 key 文件 | 备份动作本身会把密钥重新落进 `server/` |
| `server/test/persist.test.js:30` | `REAL_SEED` 指向 `data/profiles.example.json` | `hashFile()` 缺文件返回 `null`（`:34-37`），第 137 行断言退化成 `null === null` → **测试照绿但保护失效**（最坏的一种失败） |
| `server/test/gzip.test.js:119-122` | 改为先读 `process.env.BACKUP_KEY`，再读文件 | 密钥走 env 后这段会静默跳过，`full=1` 的 gzip 断言失去覆盖 |

---

## 4. GitHub 公开化执行方案

### 4.1 两条路线对比与推荐

| 维度 | 路线 A：filter-repo 清洗历史 + force push | 路线 B：新建干净仓库（单提交） |
|---|---|---|
| 保住 202 条提交历史 | ✅ | ❌（只有 1 条） |
| 能清掉**路径级**秘密（密钥、快照、profiles.json） | ✅ | ✅（天然没有） |
| 能清掉**正文里**的真实昵称（15 个文件、约 60 处） | ⚠️ 需额外 `--replace-text` + 一份**穷举**的替换名单（漏一个就白做） | ✅（导出后直接替换/删除，改动可见可审） |
| "干净"是否可证明 | ⚠️ 需要逐提交 + 逐 blob 审计才能证明 | ✅ 单提交，`git grep HEAD` 一条命令即可证明 |
| GitHub 旧对象处置 | **必须**联系 Support 或删库重建 | 删旧库即可 |
| 操作风险 | 高（force push、SHA 全变、操作不可回滚除 bundle 外） | 中（本仓库 202 提交历史会留在本地 bundle 里，不丢） |
| 前置依赖 | 需装 `git-filter-repo`（本机未装） | 无新增依赖 |

**推荐：路线 B。** 决定性理由不是"省事"，而是**可证明性**：本项目的 PII 主要不是"某几个文件"，而是散在 `REVIEW.md`(16+8 处)、`.workbuddy/memory`(3 个文件)、`docs/`(8 处)、10 个测试/探针文件里的真实昵称。路径级清洗清不掉正文；要靠 `--replace-text` 就必须先穷举名单——而"穷举"正是最容易漏的环节。路线 B 把"历史是否干净"变成一个**单提交可穷举审计**的问题。

> 若制作人坚持保留历史：走路线 A 也必须**额外**做 `--replace-text`，并在完成后接受"旧 SHA 需 GitHub Support 清理"的尾巴。

---

### 4.2 路线 B（推荐）完整命令序列

#### B0 前置备份（三份，缺一不可，**先做完再动任何东西**）

```bash
cd /d/Documents/WorkBuddy/six_out_of_five

# ① 全历史单文件备份：坏了能 git clone 回来（含所有 ref）
git bundle create /d/backup/six-$(date +%Y%m%d).bundle --all
git bundle verify /d/backup/six-$(date +%Y%m%d).bundle      # 期望：The bundle contains ... / records a complete history

# ② 目录级拷贝（含 .git 与本地那份未跟踪的 backup-key.txt）
cp -r /d/Documents/WorkBuddy/six_out_of_five /d/backup/six-worktree-$(date +%Y%m%d)

# ③ 线上真实数据存档（唯一一份真实档案，必须在动仓库前拿到）
BACKUP_KEY=<现行密钥> npm run backup
cp server/data/profiles.json /d/backup/profiles-live-$(date +%Y%m%d).json

# ④ 记录备份指纹，写进 review 文档
sha256sum /d/backup/six-*.bundle
```

> 若 `BACKUP_KEY` 尚未就位（§2 没做完），**先做 §2 再做 B0**，否则 ③ 会因 403 拿不到数据。

#### B1 导出干净快照（关键：只导出**已跟踪**文件）

```bash
mkdir -p /d/tmp/six-public
git -C /d/Documents/WorkBuddy/six_out_of_five archive --format=zip -o /d/tmp/six-public.zip HEAD
unzip -q /d/tmp/six-public.zip -d /d/tmp/six-public
ls /d/tmp/six-public
```

`git archive` 只打包**已跟踪**内容 → 本地未跟踪的 `server/backup-key.txt`、`dist/`、`tmp-shots/`、`node_modules/` 天然不会跟过去（比 `cp -r` 安全）。

#### B2 在快照里删掉不该公开的已跟踪内容（**只删快照，不动原仓库**）

```bash
cd /d/tmp/six-public
rm -rf .workbuddy
rm -f  server/data/profiles.json
rm -f  REVIEW.md REVIEW-FULL-2026-10-30.md REVIEW-v108-2026-11-01.md REVIEW-2026-11-01.md
ls server/data        # 此刻应只剩（下一步创建的）profiles.example.json
```

> `REVIEW*.md` 与 `docs/release-progress.md`、`docs/BACKLOG.md` 的去留见 §1 #7/#8。**若制作人想展示工程过程**，就把它们留下但先做脱敏（替换全部真实昵称/账号、删主机与密钥段落），这一步的判定人是主理人，不是我。

#### B3 补件（内容见 §3.1 与 §5）

```bash
cd /d/tmp/six-public
# ① 用 §3.1 的全文覆盖 .gitignore
# ② 新建 server/data/profiles.example.json（2 条合成记录，salt/hash 用 0000…/ffff…）
# ③ 新建 LICENSE（MIT，§5）、SECURITY.md、CONTRIBUTING.md（可选）
# ④ 改 README.md:7 为裸域名（去掉 ?sharecode=...）
# ⑤ 批量替换真实昵称 → 玩家A/玩家B（含 scripts/probe-records-cloud.js:282 等）
# ⑥ 确认 pwa/assets 素材授权（门禁，见 §5）
```

#### B4 初始化并提交

```bash
cd /d/tmp/six-public
git init -b main
git add -A
git status --short | wc -l          # 记录文件数，作为基线
git commit -m "chore: 首次公开 —— 从私有仓库导出，去除真实玩家数据与内部工作记录"
```

#### B5 在 GitHub 上新建**空**仓库并推送

界面操作：New repository → 名称建议 **`six-out-of-five`**（与旧库 `five-out-of-six` 区分，便于新旧并存验证）→ **不要**勾 README / .gitignore / license（否则要先 pull 一次）。

```bash
cd /d/tmp/six-public
git remote add origin https://github.com/qjh0122/six-out-of-five.git
git push -u origin main
```

#### B6 验证「历史里真的没有了」（单提交，可穷举证明）

```bash
cd /d/tmp/six-public

# ① 路径级：不该有任何敏感路径
git log --all --pretty=format: --name-only | sort -u \
  | grep -Ei 'profiles\.json|backup-key|\.live-|\.workbuddy|REVIEW'
# 期望：无输出（grep 退出码 1）

# ② 密钥形态：48 位（历史形态）与 63/64 位十六进制单行
git grep -n -E '^[0-9a-fA-F]{48}$|^[0-9a-fA-F]{63,64}$' HEAD || echo "OK：无密钥形态残留"

# ③ 真实 salt 形态（32 hex 作为独立值出现）
git grep -n -E '"salt"[[:space:]]*:[[:space:]]*"[0-9a-f]{32}"' HEAD \
  | grep -v '00000000000000000000000000000000' || echo "OK：无真实 salt"

# ④ PII（名单从 /d/backup/profiles-live-*.json 里取，**不要**写进仓库）
NAMES='真实昵称1|真实昵称2|账号名1|账号名2'   # 用 | 分隔，从备份文件里手工抄
git grep -n -E "$NAMES" HEAD || echo "OK：历史里没有真实昵称/账号"

# ⑤ 仓库规模体检
git rev-list --all --count                        # 期望 1
git count-objects -vH | grep size-pack            # 期望远小于旧库的 8.6MB
```

四项都打印 `OK` 才算通过；任何一条有输出 → 回到 B2/B3 补，重新走 B4（`rm -rf .git` 后重来，反正是快照）。

#### B7 旧仓库处置（决定成败的一步）

| 做法 | 后果 | 建议 |
|---|---|---|
| **删掉旧私有仓库** `five-out-of-six`（Settings → 底部 Delete this repository；需输入仓库名确认） | 旧 SHA 直链变 404，GitHub 后台回收对象；泄露源消失 | ✅ **推荐**。删前确认 B0 的 bundle 与目录拷贝都在 |
| 保留旧库但**保持 private** | 私有仓库对象不外泄，但"密钥已泄露"这件事对它依然成立 | 可接受的折中：作为私有归档，README 顶部标注 deprecated + 指向新库 |
| 保留旧库并 **Make public** | ❌ **绝对不行**：等于把 §1 全部内容一次性公开 | 禁止 |
| 删旧库后用**同名**重建 | `five-out-of-six` 这个 URL 能保住；同账号通常可立即重建，但存在短窗口不确定性 | 不在意 URL 时不必冒这个不确定性 |

**提醒**：私有仓库没有公开 fork（fork 公开化需要额外动作），所以 B7 不需要处理"下游 fork 仍留着旧对象"这类问题——这是选 B 的一个额外红利。

---

### 4.3 路线 A（备选）：filter-repo 清洗历史

#### A0 前置备份

同 §4.2 B0（bundle + 目录拷贝 + 线上数据存档）。**路线 A 的备份要求比 B 更硬**：force push 之后本地是唯一副本。

#### A1 安装 `git-filter-repo`

本机现状（已核实）：`git 2.55.0`、`Python 3.13.14`、`pip 26.1.2` 可用；**`pipx` 未安装**、`git-filter-repo` 未安装、`gh` 未安装。

```bash
python -m pip install --user git-filter-repo
python -m pip show git-filter-repo | head -3        # 期望：Name: git-filter-repo / Version: 2.x

# 二选一，取能跑通的那条（Windows 上 pip --user 的 Scripts 目录可能不在 PATH）
git filter-repo --version
python -m git_filter_repo --version
```

> 若两条都失败：把 `C:\Users\<你>\AppData\Roaming\Python\Python313\Scripts` 加进 `PATH`，或永远用 `python -m git_filter_repo` 这种写法。**这一条列为待实测项**（§8 #1）——我没装，不保证你的 PATH 下 `git filter-repo` 直接可用。

#### A2 在克隆副本上清洗（filter-repo 要求"新鲜克隆"，不要在原工作区直接跑）

```bash
git clone --no-local /d/Documents/WorkBuddy/six_out_of_five /d/tmp/six-filtered
cd /d/tmp/six-filtered

# ① 路径级清洗（按路径，不按提交清单 —— 见 §1.2 的纠偏）
git filter-repo --invert-paths \
  --path server/data/profiles.json \
  --path server/backup-key.txt \
  --path .live-after.json \
  --path .workbuddy \
  --path node_modules

# ② 正文级清洗（真实昵称/账号名，replace-text 格式为：旧串==>新串）
#    expressions.txt 放仓库外（/d/backup/expressions.txt），用完删掉
cat > /d/backup/expressions.txt <<'EOF'
真实昵称1==>玩家A
真实昵称2==>玩家B
账号名1==>player_a
EOF
git filter-repo --replace-text /d/backup/expressions.txt
```

#### A3 验证（路线 A 必须**逐提交**验，不能只验 HEAD）

```bash
cd /d/tmp/six-filtered

# ① 提交数不变、SHA 全变
git rev-list --all --count                 # 期望 202（历史条数保留）
git rev-parse HEAD                         # 必须 ≠ 69ddb66（证明已改写）

# ② 路径级：全历史无敏感路径
git log --all --pretty=format: --name-only | sort -u \
  | grep -Ei 'backup-key|\.live-|\.workbuddy|profiles\.json'
# 期望：无输出

# ③ blob 级：全历史扫密钥形态（路线 A 必做，因为对象不止一个）
git rev-list --all --objects | awk '{print $1}' | sort -u \
  | while read -r o; do
      git cat-file -p "$o" 2>/dev/null | grep -q -E '^[A-Za-z0-9_-]{48}$' && echo "可疑 blob: $o"
    done
# 期望：无输出

# ④ PII 级：全历史 grep（路线 A 的软肋 —— 漏一个就是漏）
git grep -n -E '真实昵称1|账号名1' $(git rev-list --all) || echo "OK：全历史无真实昵称"

# ⑤ 旧提交确实取不到内容了
git cat-file -e 4f8262b:server/backup-key.txt 2>/dev/null && echo "❌ 仍有残留" || echo "OK：旧提交已无该文件"
```

#### A4 force push

```bash
cd /d/tmp/six-filtered
git remote add origin https://github.com/qjh0122/five-out-of-six.git   # filter-repo 会移除原 remote
git push --force --all origin
git push --force --tags origin
```

#### A5 GitHub 侧旧对象失效（**force push 不等于清干净**）

- GitHub 上那些**未被任何 ref 引用**的旧对象不会立刻消失；`/commit/<旧 SHA>` 这类直链在清理前仍可能返回内容（尤其是 private→public 之后被缓存/被索引）。
- 两条收尾路径：
  1. **联系 GitHub Support** 请求对指定仓库做 unreachable object 清理（说明：历史重写已移除敏感数据，请求 GC）。优点：保住仓库、stargazer/issue；缺点：有等待期、需要英文沟通。
  2. **删库重建**（与路线 B 的 B7 同）：最彻底，但丢失 issue/star/URL。
- 无论哪条：**别假设"force push 完就没事了"**。在 Support 回复确认前，不要把仓库切成 public。

---

### 4.4 明确风险清单（两路线共有 / 各自特有）

| 风险 | 说明 | 缓解 |
|---|---|---|
| **force push 改写全部 commit hash**（路线 A） | `69ddb66` 之后所有 SHA 变化；任何外部书签、issue 引用、本地旧 clone 全部对不上 | 提前公告 + `git bundle` 备份 + B0 的目录拷贝 |
| **GitHub 旧 SHA 直链仍可能可访问**（路线 A） | 未被引用的对象在清理前可通过 SHA 直链取到 | Support 清理 或 删库重建；**先不发 public** |
| **本地旧 clone 会把旧对象带回来**（路线 A） | 你自己机器上 `D:/Documents/WorkBuddy/six_out_of_five` 仍是旧历史；有人从它 push 一次就把旧对象全带回去 | 改完后**废弃旧工作区**，只用新克隆；或删旧工作区 `.git` |
| **`--replace-text` 名单漏项**（路线 A） | PII 是 60 处散落文本，漏一个等于没做 | 用 §1 的扫描口径重建名单；路线 B 无此风险 |
| **删错文件 / 删库手滑** | 删 `five-out-of-six` 不可撤销 | B0 三份备份 + 删库前截图确认仓库名 |
| 素材版权（两条共有） | `pwa/assets` 来源未记录 | §5 门禁：核来源 → 授权或替换 |
| sharecode 仍出现在代码里（两条共有） | 去掉 `.workbuddy` 后，仍需确认 `pwa/js`、`README.md` 里没有硬编码房号 | `git grep -n -F '<把 README 里那串 10 位口令现场贴进来，别写进本文件>'` 应为空 |

---

## 5. 公开仓库合规补件清单

### 5.1 LICENSE —— 结论：**MIT**

| 候选 | 结论 | 理由 |
|---|---|---|
| **MIT** | ✅ 推荐 | 最短（200 字）、GitHub 自动识别、零运行时依赖的项目无专利/贡献者协议负担、"公开了大家随便看随便改"的意图最匹配 |
| Apache-2.0 | ❌ | 专利授权 + `NOTICE` + 变更声明流程，对 2~5 人好友房项目是纯仪式成本；除非打算公司化或接受外部大贡献 |
| GPL-3.0 / AGPL-3.0 | ❌ | 传染性义务与"朋友间分享"的意图冲突；AGPL 还会覆盖联网服务 |
| 不放 LICENSE | ❌ **最差** | 公开但无许可证 = 默认"保留所有权利"，别人连 fork 都可能侵权 → "公开"失去意义 |

**配套动作（必须）**：`pwa/assets/**` 素材单独核权（§1 #12）。自制素材随 MIT；第三方素材需要授权凭证并写进 `NOTICE`；无法确认来源的一律替换。**这一项是门禁，只有"确认"与"替换/下架"两种出口，没有降级路径。**

### 5.2 `SECURITY.md` —— **必须**

理由：有账号系统、有一把已确认泄露过的 admin 密钥、有 `?full=1` 全量导出接口。内容五段：

1. 支持范围：只支持最新 `main`；
2. 私密披露渠道：邮箱（或 GitHub Security Advisories 的私密报告），**不要开公开 issue**；
3. 明确范围内：`/api/admin/*`、`?full=1`、WS 鉴权、登录/进房限流、令牌吊销；
4. 明确要求：**不要把真实账号数据、线上截图、`x-backup-key` 值放进 issue/PR**；
5. SLA 口径：尽力而为，非承诺（个人项目要写明，否则等于给自己签 SLA）。

### 5.3 `CONTRIBUTING.md` —— **建议，可延后**

结论：不阻塞公开。10 行足够：`npm test`（零依赖、Node>=18）、PR 前跑 `node scripts/build-proto.js --check`、**禁止提交 `server/data/*.json`**、禁止在测试里用真实昵称。等真有外部 PR 再补。

### 5.4 README 该放什么 / 不放什么

| 放 | 不放 |
|---|---|
| 玩法规则（现有内容质量很高，保留） | ❌ `?sharecode=〈房号口令·已脱敏〉`（进房口令）→ 改裸域名 `https://liuxuanwu.app.workbuddy.host/` |
| 本地怎么跑：`npm start`、Node>=18、零依赖、`npm test` | ❌ 任何 `x-backup-key` 的值（连脱敏形态都不必出现） |
| 一句话架构 + 目录树（`pwa/` 静态 + `server/` 零依赖 Node） | ❌ 真实玩家昵称/账号（含截图里的） |
| 一段**隐私说明**（§5.5） | ❌ 部署主机细节、平台 env 面板截图、内部 review 链接 |
| 素材来源/授权（`NOTICE` 链接） | ❌ 内部过程文档（`REVIEW*.md`、`docs/release-progress.md`） |

### 5.5 隐私说明（写进 README 或独立 `PRIVACY.md`）

**收集什么**（逐项从源码核实）：

- 账号名 + scrypt 盐/哈希（`account.salt` 32hex、`account.hash` 64hex）——**不存明文密码**；
- 昵称（唯一）、可选头像（`CONFIG.AVATAR_UPLOAD` 默认关；emoji 或上传照片）；
- 对局记录：局数/胜/负/和/净胜/连胜、最近 20 场（`roomId`、`endedAt`、`net`、`playerCount`、`endReason`）；
- 时间戳（`createdAt`/`lastLoginAt`）、`disabled`、`tv`。

**不收集（已核实）**：IP 只在内存里做登录/进房限流（`server/index.js:316-324`、`:699`），不写进档案；但日志里会出现 `ws connect <ip>`（`:1337`）→ 部署侧要把日志当敏感数据处理。

**保留期**：无战绩的空档案由 `prune()` 定期清理（`server/profile.js:515-533`，每 100 场触发一次扫描）；有战绩的长期保留，直到用户删号。

**删除权**：管理端 `/api/admin/delete` 与用户自助删号（`profile.js:549` 注释明确写了"被遗忘权"）→ README 要写清"怎么删掉我的数据"。

**公开口径（硬要求）**：公开仓库中**不出现任何真实玩家的昵称、账号名、战绩**；示例与测试一律 `玩家A/玩家B/test_acc`。

### 5.6 CI 门禁（阻断型，无运行时降级）

在 `.github/workflows/test.yml` 的"语法检查"后追加一步：

```yaml
      - name: 敏感形态门禁（阻断）
        run: |
          fail=0
          # ① 密钥形态：单行 48 / 63 / 64 位 hex 或字母数字串
          if git grep -n -E '^[A-Za-z0-9_-]{48}$|^[A-Za-z0-9_-]{63,64}$' -- . ':!*.md' ':!package.json'; then
            echo "::error::疑似密钥被提交"; fail=1
          fi
          # ② 真实数据文件
          if git ls-files | grep -E 'server/data/(?!profiles\.example\.json).*\.json'; then
            echo "::error::server/data 下出现非样例 JSON"; fail=1
          fi
          # ③ 内部工作台 / 快照
          if git ls-files | grep -E '^\.workbuddy/|\.live-.*\.json$'; then
            echo "::error::内部记录或线上快照被跟踪"; fail=1
          fi
          exit $fail
```

**归类依据（为什么是门禁而非自动降级）**：这三条检测的是"仓库里存在某类内容"，属于**入库前的静态事实**，运行时不产生任何可降级的量（没有阈值可调、没有功能可关），只能在 PR/push 环节阻断。触发点 = 每次 push 与 PR；判定人 = CI 机器；不达标的后果 = 构建红、禁止合并。**因此按门禁卡点入表，不属未绑定。**

---

## 6. 平台 / 合规维度评分

评分口径：0-10，每维给依据。**现状**=今天这个仓库；**执行后**=按本方案做完的预估。

| 维度 | 现状 | 依据（现状） | 执行后 | 依据（执行后） |
|---|---|---|---|---|
| **可公开性** | **3** | 14 个提交含 48 字符 admin 密钥；202 个提交含 8 个真实账号的 salt/hash；336KB 内部日记；真实昵称散落 15 个文件 | **9** | 单提交、密钥零残留、无真实账号、样例数据、CI 门禁兜底。扣 1 分：素材授权仍未核（外生依赖） |
| **安全** | **4** | 密钥可一条 `git show` 取得，权限覆盖"导出全量/清空/删号/改密"；但服务端本身底子在：scrypt、`timingSafeEqual` 定长比较（`index.js:123-128`）、登录/进房限流、令牌吊销 | **8** | 密钥轮换 + env 注入 + CI 形态门禁 + SECURITY.md 披露通道。扣 2 分：`/api/admin/*` 仍是**单密钥无 MFA、无审计日志**，这是设计层面的欠账（不在本方案范围内） |
| **可维护性** | **7** | 零运行时依赖、CI 全分支触发（node --check + `npm test` + 残留检查）、109 个测试文件、注释密度与解释质量高（源码里记录了踩坑原因）。扣分：`REVIEW.md` 445KB + `docs/` 300KB+ 过程文档与源码树混放 | **8** | 出库过程文档、`.gitignore` 分组清晰、目录职责单一（`pwa/` + `server/` + `scripts/` + `docs/`）。扣 2 分：仍无 `package-lock`（零依赖下可接受）、无版本 changelog 机器化 |
| **发布就绪度** | **6** | CI 在跑、PWA 有 SW、线上可用；但缺 LICENSE/SECURITY、README 带 sharecode、无隐私说明、无素材授权记录 | **9** | 补件齐、README 口径干净、隐私说明落地、发布流程含数据备份步骤。扣 1 分：删库/重建那一步不可撤销，属流程风险 |
| **综合（等权）** | **5.0** | — | **8.5** | — |

---

## 7. 执行顺序与责任人

| # | 动作 | 责任人 | 卡点 / 完成判据 |
|---|---|---|---|
| 1 | 现场确认线上用的是哪把密钥 | 主程序 | 用历史旧 key 打 `?full=1`：403 = 线上已换（仍需再换），200 = 线上正用泄露密钥（最高优先级） |
| 2 | §2 轮换密钥 + env 注入 + 两条 curl 验收 | 主程序 | 新 key→200、旧 key→403 |
| 3 | B0 三份备份（bundle / 目录 / 线上数据） | 主程序 | `git bundle verify` 通过 + `profiles-live-*.json` 存在且大小 ≈ 15KB+ |
| 4 | §3.1 `.gitignore` 全文落地 + `profiles.example.json` | 主程序 | `git status --ignored` 里出现 `server/data/profiles.json`、`.workbuddy/` |
| 5 | §3.5 四条代码改动 | 主程序 | `npm test` 全绿；`persist.test.js` 断言不再退化 |
| 6 | §5.2 素材授权核查 | 主理人（找来源） | 每个 mp3/png 有来源结论；无授权项列出替换清单 |
| 7 | 内部文档出库决策（`REVIEW*.md` / `docs/release-progress.md` 留删脱敏） | 主理人 | 决策落纸（谁判定：主理人；不达标后果：公开后 PII/路线图外泄） |
| 8 | §4.2 路线 B 执行（B1→B5） | 主程序 | 新仓库首次 push 成功 |
| 9 | B6 四项验证 | 主程序 + QA | 四项全 `OK` |
| 10 | B7 删旧仓库 | 主程序 | 旧 URL 变 404；bundle 备份在手 |
| 11 | 公开后 24h 自查（GitHub 搜索真实昵称、`?full=1` 匿名 403、admin 路由匿名 403） | 我 + QA | 三项全过；任一不过 → 立刻把仓库切回 private |

---

## 8. 待实测项（四字段，交实施阶段验证）

| # | 验证问题 | 预期结论 | 验证方法（一句话） | 由谁 / 哪个阶段 |
|---|---|---|---|---|
| 1 | `python -m pip install --user git-filter-repo` 后，`git filter-repo --version` 与 `python -m git_filter_repo --version` 哪个可用 | 至少一条返回版本号 | 装完立刻各跑一次（仅路线 A 需要） | 主程序 / 实施阶段 |
| 2 | `git archive --format=zip HEAD` 导出的快照确实不含未跟踪文件 | zip 里没有 `server/backup-key.txt`、`dist/`、`tmp-shots/` | `unzip -l /d/tmp/six-public.zip \| grep -E 'backup-key\|dist/\|tmp-shots'` 应为空 | 主程序 / B1 |
| 3 | 移除 `profiles.json` 后 `npm test` 全绿 | 109 个测试文件全过 | `npm test` | 主程序 + CI |
| 4 | 服务端在"主文件缺失 + 种子缺失"时能正常起、榜单为空、无异常栈 | 起得来，返回空榜单 | `DATA_DIR=/tmp/x SEED_FILE=/tmp/none node server/index.js` 后 `curl localhost:<port>/api/leaderboard` | 主程序 / 实施阶段 |
| 5 | 密钥走 env 后 `?full=1` 仍工作、旧 key 失效 | 新 200 / 旧 403 | §2.2 的两条 curl | 主程序 / 发布后 |
| 6 | 新仓库全历史 grep 不到真实昵称/账号 | 无输出 | §4.2 B6 的第 ④ 条 | QA / 公开前 |
| 7 | `.workbuddy/` 出库后无功能依赖 | 无引用 | `git grep -n '\.workbuddy'` 应为空 | 主程序 / B2 后 |
| 8 | `README`/代码里不再有硬编码 sharecode | 无输出 | `git grep -n -F '<把 README 里那串 10 位口令现场贴进来，别写进本文件>'` | QA / 公开前 |

---

## 9. 前提假设（假设变了结论要重估）

1. 旧仓库当前 **private 且无公开 fork**（私有仓库的 fork 默认不公开）——若已有公开 fork，路线 B 的"删旧库即干净"不再成立，需逐个处理下游 fork。
2. 线上部署**能注入环境变量**（`BACKUP_KEY` / `SEED_FILE` / `DATA_DIR`）——若平台只能打包文件、不能设 env，则 §2 的轮换要退化为"发布一个只在部署侧存在的新密钥文件"，且必须确保它被 `.gitignore` 拦住。
3. 制作人**接受丢掉 202 条提交历史**（路线 B 的代价）——若不接受，改走路线 A，且必须补 `--replace-text`（漏一项即失败）。
4. `pwa/assets` 素材可确权或可替换——若两者都做不到，这个仓库不具备公开条件（版权是硬约束，不是工程问题）。
5. 项目仍由 1~3 人维护，无外部贡献者——若将来开放贡献，`CONTRIBUTING.md` 与 Apache-2.0 的性价比会翻转。
