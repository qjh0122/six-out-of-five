#!/usr/bin/env bash
# 把本仓库**已跟踪的内容**导出到公开仓库目录并推送。
#
# 为什么需要它：这个项目有两个 git 仓库
#   · 旧私有库（含 202 条历史，历史里有真实玩家数据与密钥）—— 日常开发在这里
#   · 公开库（单条提交，已脱敏）—— 对外展示
# 两者**不能直接同步分支**：一旦把私有库的 origin 改成公开库再 push，
# 202 条历史会整段带上去，密钥和玩家数据就公开了。
#
# 正确做法就是本脚本：用 `git archive HEAD` 只导出**当前跟踪的文件**，
# 天然不带历史、不带未跟踪的真实数据文件。
#
# 用法：
#   bash scripts/publish-public.sh                  # 默认导到 /d/six-out-of-five-public
#   bash scripts/publish-public.sh /path/to/public
#
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DST="${1:-/d/six-out-of-five-public}"
EXPECT_REMOTE_SUBSTR="six-out-of-five"

echo "源仓库：$SRC"
echo "目标仓库：$DST"

# ---- 1. 目标必须是公开库，且不是源仓库自己 ----
if [ "$(cd "$SRC" && pwd -P)" = "$(cd "$DST" 2>/dev/null && pwd -P)" ]; then
  echo "错误：目标目录不能是源仓库本身" >&2
  exit 1
fi
if [ ! -d "$DST/.git" ]; then
  echo "错误：$DST 不是 git 仓库（找不到 .git）" >&2
  exit 1
fi
REMOTE_URL="$(git -C "$DST" remote get-url origin 2>/dev/null || true)"
case "$REMOTE_URL" in
  *"$EXPECT_REMOTE_SUBSTR"*) echo "远程：$REMOTE_URL" ;;
  *) echo "错误：$DST 的 origin 不是公开库（当前：${REMOTE_URL:-无}）" >&2; exit 1 ;;
esac

# ---- 2. 源仓库必须干净（不允许把半成品导出去）----
if [ -n "$(git -C "$SRC" status --porcelain)" ]; then
  echo "错误：源仓库有未提交改动，先提交再导出：" >&2
  git -C "$SRC" status --short >&2
  exit 1
fi

# ---- 3. 导出前先在源仓库做敏感检查（全部基于跟踪文件）----
echo "--- 敏感检查 ---"
FAIL=0
if git -C "$SRC" ls-files | grep -qE '(^|/)profiles\.json$'; then
  echo "  ✗ server/data/profiles.json 被跟踪了（真实账号数据）" >&2; FAIL=1
fi
if git -C "$SRC" ls-files | grep -qE '^\.workbuddy/'; then
  echo "  ✗ .workbuddy/ 被跟踪了（开发日记）" >&2; FAIL=1
fi
if git -C "$SRC" ls-files | grep -qE '(^|/)backup-key\.txt$'; then
  echo "  ✗ backup-key.txt 被跟踪了（密钥）" >&2; FAIL=1
fi
if git -C "$SRC" grep -qE '^[0-9a-fA-F]{48}$|^[0-9a-fA-F]{63,64}$' -- . 2>/dev/null; then
  echo "  ✗ 代码里疑似有单行密钥形态" >&2; FAIL=1
fi
if [ "$FAIL" -ne 0 ]; then
  echo "错误：敏感检查未通过，中止。" >&2
  exit 1
fi
echo "  ✓ 通过"

# ---- 4. 同步：清掉目标工作区（保留 .git），再解包 ----
echo "--- 同步文件 ---"
git -C "$DST" rm -rq --cached . 2>/dev/null || true
find "$DST" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
git -C "$SRC" archive --format=tar HEAD | tar -x -C "$DST"

# ---- 5. 统一行尾（Windows 上 tar 解包可能带 CRLF，会让两条字节级测试假失败）----
python - "$DST" <<'PY'
import os, sys
root = sys.argv[1]
n = 0
for d, _, fs in os.walk(root):
    if '.git' in d.split(os.sep):
        continue
    for f in fs:
        if f.endswith(('.js', '.css', '.html', '.md', '.json', '.yml', '.yaml', '.webmanifest', '.svg')):
            p = os.path.join(d, f)
            b = open(p, 'rb').read()
            if b'\r\n' in b:
                open(p, 'wb').write(b.replace(b'\r\n', b'\n'))
                n += 1
if n:
    print(f'  已把 {n} 个文件的行尾归一为 LF')
PY

# ---- 6. 提交并推送 ----
echo "--- 提交 ---"
git -C "$DST" add -A
if git -C "$DST" diff --cached --quiet; then
  echo "没有内容变化，无需推送。"
  exit 0
fi
git -C "$DST" -c core.quotepath=false diff --cached --stat | tail -3
git -C "$DST" commit -q -m "chore: 同步自私有仓库（$(git -C "$SRC" rev-parse --short HEAD)）"
git -C "$DST" push -q origin main
echo "--- 已推送 ---"
git -C "$DST" log --oneline -2
