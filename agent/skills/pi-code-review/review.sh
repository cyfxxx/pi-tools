#!/bin/bash
# pi-code-review review.sh - 确定性代码检查脚本
# 用法:
#   bash review.sh                 # 审查 git diff 变更（HEAD + 未跟踪文件）
#   bash review.sh --all <dir>     # 跳过 git，扫描目录内所有源码文件
#   bash review.sh --help          # 用法说明
#
# 仅检测并报告，不修改任何文件，不执行测试。退出码恒为 0。
# 自检（使用前运行）:
#   bash review.sh --selfcheck   # 检查技能自身是否有更新（本仓库远程 + 参考项目 open-code-review）
# 技能版本: v1.2（2026-08-11：排除第三方大目录 + 扫描预览 + 自检）

set -uo pipefail

MODE="diff"
SCAN_DIR=""
PASS=0; WARN=0; FAIL=0; SKIP=0

say()   { printf '%s\n' "$*"; }
ok()    { say "  [✓] $*"; PASS=$((PASS+1)); }
warn()  { say "  [⚠] $*"; WARN=$((WARN+1)); }
fail()  { say "  [✗] $*"; FAIL=$((FAIL+1)); }
skip()  { say "  [–] $*（未安装 $1）"; SKIP=$((SKIP+1)); }

usage() {
  cat <<'EOF'
pi-code-review 确定性检查
  默认: 审查 git 工作区变更（HEAD 与未跟踪文件）
  --all <dir>   扫描目录内全部源码文件（无需 git）
  --selfcheck   检查技能自身更新（本仓库远程 + 参考项目 alibaba/open-code-review）；距上次检查不足 7 天时跳过远程查询，--force 强制检查
  --help        显示本帮助
注: 大型目录全量扫描耗时（如 ~/.pi 约 40s），建议用 tmux_run 后台执行避免阻塞轮次
   （tmux_run name=review command="bash review.sh --all /root/.pi"；tmux_run 后立即结束回合，进度用 tmux_read 轮询——禁止 tmux_wait 阻塞前台）
EOF
}

for arg in "$@"; do
  case "$arg" in
    --help) usage; exit 0 ;;
    --selfcheck) MODE="selfcheck" ;;
    --force) FORCE_CHECK=1 ;;
    --all) MODE="all" ;;
    --all=*) MODE="all"; SCAN_DIR="${arg#--all=}" ;;
    --*) say "未知参数: $arg（用 --help 查看用法）"; exit 0 ;;
    *) [ "$MODE" = "all" ] && SCAN_DIR="$arg" ;;
  esac
done

# ---------- 自检模式：检查技能自身更新 ----------
if [ "$MODE" = "selfcheck" ]; then
  say "== pi-code-review 技能自检 =="
  say ""
  # 更新检查节流：距上次远程检查 < 7 天直接跳过（git fetch + GitHub API 查询
  # 每次 ~5-15s，高频自检无必要）。--force 可强制检查。记录文件为运行时数据
  # （不入库）；检查成功后更新时间戳。
  SELFCHECK_META="${PI_HOME:-$HOME/.pi}/logs/pi-code-review-selfcheck.ts"
  NOW_TS=$(date +%s)
  LAST_TS=$(cat "$SELFCHECK_META" 2>/dev/null || echo 0)
  AGE=$((NOW_TS - LAST_TS))
  LAST_STR=$(python3 -c "import sys;from datetime import datetime;ts=int(sys.argv[1]);print(datetime.fromtimestamp(ts).strftime('%F %T'))" "$LAST_TS" 2>/dev/null || echo 未知)
  if [ "${FORCE_CHECK:-0}" != "1" ] && [ "$AGE" -lt 604800 ]; then
    say "  [–] 距上次更新检查不足 7 天（上次: $LAST_STR），跳过远程更新检查。--force 强制重新检查。"
    say ""
    say "自检完成。技能版本: v1.2"
    exit 0
  fi
  say ""
  say "--- 本仓库技能更新 ---"
  if git rev-parse --git-dir >/dev/null 2>&1; then
    git fetch -q origin 2>/dev/null
    REMOTE_AHEAD=$(git rev-list --count HEAD..origin/master 2>/dev/null || echo 0)
    LOCAL_SKILL_HASH=$(git log -1 --format=%h -- agent/skills/pi-code-review/ 2>/dev/null || echo "?")
    REMOTE_SKILL_HASH=$(git log -1 --format=%h origin/master -- agent/skills/pi-code-review/ 2>/dev/null || echo "?")
    if [ "$REMOTE_AHEAD" != "0" ] && [ "$LOCAL_SKILL_HASH" != "$REMOTE_SKILL_HASH" ]; then
      warn "技能在远程仓库有更新（本地 $LOCAL_SKILL_HASH vs 远程 $REMOTE_SKILL_HASH，$REMOTE_AHEAD 个提交待拉取）→ 先 git pull 再使用"
    else
      ok "技能文件与远程仓库一致（$LOCAL_SKILL_HASH）"
    fi
  else
    skip "git 仓库"
  fi
  say ""
  say "--- 参考项目 alibaba/open-code-review ---"
  if command -v curl >/dev/null 2>&1; then
    RESP=$(curl -s --max-time 15 "https://api.github.com/repos/alibaba/open-code-review/releases/latest" 2>/dev/null)
    LATEST=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('tag_name','?'))" 2>/dev/null || echo "?")
    if [ "$LATEST" != "?" ]; then
      BASELINE="v1.9.3"  # 2026-08-15 核对：v1.9.3 均为 Go 核心/Action 功能变更，无涉及技能审查规则
      if [ "$LATEST" != "$BASELINE" ]; then
        warn "参考项目已更新: $BASELINE -> $LATEST -> 查看 https://github.com/alibaba/open-code-review/releases 确认是否吸收新能力"
      else
        ok "参考项目版本与技能基线一致（$LATEST）"
      fi
    else
      warn "无法查询参考项目最新版本（网络/API 不可达），跳过"
    fi
  else
    skip "curl"
  fi
  # 记录本次检查时间（更新检查节流，7 天内重复自检跳过远程查询）
  mkdir -p "$(dirname "$SELFCHECK_META")" 2>/dev/null
  date +%s > "$SELFCHECK_META" 2>/dev/null
  say ""
  say "自检完成。技能版本: v1.2"
  exit 0
fi

# ---------- 收集待审文件 ----------
declare -a FILES=()
if [ "$MODE" = "diff" ]; then
  if ! git rev-parse --git-dir >/dev/null 2>&1; then
    say "当前目录不是 git 仓库。请进入 git 仓库运行，或用 --all <dir> 扫描目录。"
    exit 0
  fi
  say "== 审查范围: git 变更（HEAD + 未跟踪） =="
  # -z 分隔 + 解析两字段：重命名行（R old -> new）取新路径（$4 在 -z 模式下为第 4 列）、
  # 未跟踪目录（?? dir/）展开为目录内文件（-f 过滤会整体漏掉）；仅取磁盘上存在的文件
  mapfile -t FILES < <(git status --porcelain -z | python3 -c '
import sys, os
data = sys.stdin.buffer.read().split(b"\0")
i = 0
out = []
while i < len(data):
    entry = data[i]
    if not entry:
        i += 1
        continue
    parts = entry.split(b" ", 1)
    xy = parts[0].decode()
    rest = parts[1] if len(parts) > 1 else b""
    if xy.startswith("R"):
        # R  old -> new（-z 模式下 new 是独立字段）
        path = rest
    else:
        path = rest
    i += 1
    if xy.startswith("R"):
        if i < len(data) and data[i]:
            path = data[i]
            i += 1
    p = path.decode()
    if os.path.isdir(p) and not xy.startswith("D"):
        for root, dirs, files in os.walk(p):
            for f in files:
                out.append(os.path.join(root, f))
    elif not xy.startswith("D") and os.path.isfile(p):
        out.append(p)
print("\n".join(out))
' | grep -v '^$')
else
  [ -n "$SCAN_DIR" ] || { say "请指定目录: --all <dir>"; exit 0; }
  [ -d "$SCAN_DIR" ] || { say "目录不存在: $SCAN_DIR"; exit 0; }
  say "== 审查范围: $SCAN_DIR =="
  # 排除第三方依赖与运行时数据（与 node_modules 同级：venv 虚拟环境、SearXNG
  # 第三方源码、日志、记忆提取缓存），避免逐文件语法检查拖垮扫描
  # 审计 2026-08-15：排除 */.pi/* 在扫描根自身是 .pi 目录（如 ~/.pi 仓库）时
  # 会误伤全部文件（249 个源码只审到 1 个）——根为 .pi 时禁用该排除
  local PI_EXCL=()
  [ "$(basename "$SCAN_DIR")" != ".pi" ] && PI_EXCL=(! -path '*/.pi/*')
  mapfile -t FILES < <(find "$SCAN_DIR" -type f \( -name '*.ts' -o -name '*.js' -o -name '*.mjs' -o -name '*.cjs' -o -name '*.py' -o -name '*.sh' -o -name '*.json' -o -name '*.yml' -o -name '*.yaml' -o -name '.env' -o -name '.env.*' -o -name '*.env' \) ! -path '*/node_modules/*' ! -path '*/.git/*' ! -path '*/searxng/venv/*' ! -path '*/searxng/repo/*' ! -path '*/logs/*' ! -path '*/memory/pending-extracts/*' ! -path '*/memory/extract-sessions/*' ! -path '*/memory/checkpoints/*' ! -path '*/tools/*' ! -path '*/pi-global/*' ! -path '*/node/*' ! -path '*/.cloakbrowser/*' "${PI_EXCL[@]}" 2>/dev/null)
  # 扫描预览：先大致查看范围（文件数 + 目录分布），确认无需再排除
  TOTAL_FILES=$(find "$SCAN_DIR" -type f \( -name '*.ts' -o -name '*.js' -o -name '*.mjs' -o -name '*.py' -o -name '*.sh' -o -name '*.json' -o -name '*.yml' -o -name '*.yaml' \) ! -path '*/node_modules/*' ! -path '*/.git/*' ! -path '*/searxng/venv/*' ! -path '*/searxng/repo/*' ! -path '*/logs/*' ! -path '*/memory/pending-extracts/*' ! -path '*/memory/extract-sessions/*' ! -path '*/memory/checkpoints/*' 2>/dev/null | wc -l)
  say "扫描预览: 源码文件 $TOTAL_FILES 个（已排除 node_modules/searxng venv+repo/logs/memory/tools/pi-global 等运行时）"
  if [ "$TOTAL_FILES" -gt 300 ]; then
    say "  目录分布（前 15）:"
    find "$SCAN_DIR" -type f \( -name '*.ts' -o -name '*.js' -o -name '*.mjs' -o -name '*.py' -o -name '*.sh' -o -name '*.json' -o -name '*.yml' -o -name '*.yaml' \) ! -path '*/node_modules/*' ! -path '*/.git/*' ! -path '*/searxng/venv/*' ! -path '*/searxng/repo/*' ! -path '*/logs/*' ! -path '*/memory/*' ! -path '*/tools/*' ! -path '*/pi-global/*' ! -path '*/node/*' ! -path '*/.cloakbrowser/*' "${PI_EXCL[@]}" 2>/dev/null | sed "s|$SCAN_DIR/||" | cut -d/ -f1-2 | sort | uniq -c | sort -rn | head -15
  fi
fi

# 过滤掉删除的文件（仅剩磁盘上存在的）
declare -a EXISTING=()
for f in "${FILES[@]:-}"; do
  [ -f "$f" ] && EXISTING+=("$f")
done
FILES=("${EXISTING[@]:-}")

if [ "${#FILES[@]}" -eq 0 ]; then
  say "没有可审查的文件（无变更或目录为空）。"
  exit 0
fi
say "待审文件: ${#FILES[@]} 个"

file_ext() { echo "${1##*.}"; }
is_shell() {
  case "$1" in
    *.sh|*.bash) return 0 ;;
  esac
  head -c 100 "$1" 2>/dev/null | grep -q '#!/.*\(bash\|sh\)'
}

# ---------- 阶段 A: Git 卫生 ----------
say ""
say "== 阶段 A: Git 卫生 =="
if [ "$MODE" = "diff" ]; then
  if git diff --check >/dev/null 2>&1; then
    ok "git diff --check 无空白错误"
  else
    fail "git diff --check 发现空白错误（行尾空格/尾随空白行）:"
    git diff --check 2>&1 | sed 's/^/      /' | head -20
  fi

  tracked_env=0
  for f in "${FILES[@]:-}"; do
    case "$f" in
      *.env|*/.env|*/.env.*)
        if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
          tracked_env=1
          fail ".env 文件已被 git 跟踪: $f"
        fi ;;
    esac
  done
  [ "$tracked_env" = "0" ] && ok "无 .env 文件被 git 跟踪"

  big=0
  for f in "${FILES[@]:-}"; do
    [ -f "$f" ] || continue
    size=$(stat -c%s "$f" 2>/dev/null || echo 0)
    if [ "$size" -gt 1048576 ]; then
      big=1
      warn "大文件（>1MB, ${size} 字节）: $f"
    fi
    if file "$f" 2>/dev/null | grep -q 'binary'; then
      big=1
      warn "二进制文件: $f"
    fi
  done
  [ "$big" = "0" ] && ok "无大文件/二进制文件入库"
else
  say "  [–] git（--all 模式跳过 git 卫生检查）"
fi

# ---------- 阶段 A2: 密钥扫描（脱敏） ----------
say ""
say "== 阶段 A2: 疑似密钥扫描（仅报告位置） =="
SECRET_PAT='(sk-[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|gho_[A-Za-z0-9]{20,}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|password[[:space:]]*[:=][[:space:]]*[^[:space:]]+|api[_-]?key[[:space:]]*[:=][[:space:]]*[^[:space:]]+|secret[[:space:]]*[:=][[:space:]]*[^[:space:]]+)'
found=0
for f in "${FILES[@]:-}"; do
  case "$f" in
    *.lock|*package-lock.json|*pnpm-lock.yaml) continue ;;
  esac
  [ -f "$f" ] || continue
  # 排除明显示例/测试文件
  case "$f" in
    *test*|*spec*|*/examples/*|*/docs/*|*/tests/*) continue ;;
  esac
  if grep -qE "$SECRET_PAT" "$f" 2>/dev/null; then
    found=1
    while IFS= read -r line; do
      num=${line%%:*}
      content=${line#*:}
      # 脱敏：只显示匹配关键字位置，不显示值
      hit=$(echo "$content" | grep -oE 'sk-[A-Za-z0-9]+|ghp_[A-Za-z0-9]+|AKIA[A-Z0-9]+|gho_[A-Za-z0-9]+|BEGIN [A-Z ]*PRIVATE KEY|password|api[_-]?key|secret' | head -1)
      fail "$f:$num: [已脱敏] 疑似密钥/凭据（$hit********）"
    done < <(grep -nE "$SECRET_PAT" "$f" 2>/dev/null | head -5)
  fi
done
[ "$found" = "0" ] && ok "未发现疑似密钥/凭据"

# ---------- 阶段 B: 语法/类型检查 ----------
say ""
say "== 阶段 B: 语法检查 =="
node_err=0
for f in "${FILES[@]:-}"; do
  case "$f" in
    *.js|*.mjs|*.cjs)
      if command -v node >/dev/null 2>&1; then
        if ! node --check "$f" >/dev/null 2>&1; then
          node_err=1
          fail "JS 语法错误: $f"
        fi
      else
        skip "node"
      fi
      ;;
  esac
done
[ "$node_err" = "0" ] && ok "JS 语法检查通过（${#FILES[@]} 文件中）"

py_err=0
for f in "${FILES[@]:-}"; do
  case "$f" in
    *.py)
      if command -v python3 >/dev/null 2>&1; then
        if ! python3 -m py_compile "$f" >/dev/null 2>&1; then
          py_err=1
          fail "Python 语法错误: $f"
        fi
      else
        skip "python3"
      fi
      ;;
  esac
done
[ "$py_err" = "0" ] && ok "Python 语法检查通过"

sh_err=0
for f in "${FILES[@]:-}"; do
  if is_shell "$f"; then
    if command -v bash >/dev/null 2>&1; then
      if ! bash -n "$f" >/dev/null 2>&1; then
        sh_err=1
        fail "Shell 语法错误: $f"
      fi
    else
      skip "bash"
    fi
  fi
done
[ "$sh_err" = "0" ] && ok "Shell 语法检查通过"

json_err=0
for f in "${FILES[@]:-}"; do
  case "$f" in
    *.json)
      if command -v python3 >/dev/null 2>&1; then
        if ! python3 -c "import json,sys; json.load(open(sys.argv[1], encoding='utf-8'))" "$f" >/dev/null 2>&1; then
          json_err=1
          fail "JSON 解析错误: $f"
        fi
      else
        skip "python3"
      fi
      ;;
  esac
done
[ "$json_err" = "0" ] && ok "JSON 解析通过"

if command -v python3 >/dev/null 2>&1; then
  yaml_err=0
  for f in "${FILES[@]:-}"; do
    case "$f" in
      *.yml|*.yaml)
        if ! python3 -c "
import sys
try:
    import yaml
except ImportError:
    sys.exit(0)
yaml.safe_load(open(sys.argv[1]))
" "$f" >/dev/null 2>&1; then
          yaml_err=1
          fail "YAML 解析错误: $f"
        fi
        ;;
    esac
  done
  [ "$yaml_err" = "0" ] && ok "YAML 解析通过"
else
  skip "python3"
fi

# TS 类型检查：若存在 tsconfig 则报告命令（不执行）
if [ -f tsconfig.json ] && command -v npx >/dev/null 2>&1; then
  say "  [i] 检测到 tsconfig.json — 建议运行类型检查: npx tsc --noEmit（由审查者决定）"
fi

# ---------- 阶段 C: 可疑模式 ----------
say ""
say "== 阶段 C: 可疑模式标记（供人工判断） =="
c_found=0
for f in "${FILES[@]:-}"; do
  [ -f "$f" ] || continue
  hits=$(grep -nE '(console\.log|debugger|TODO|FIXME|HACK|\beval\(|innerHTML|dangerouslySetInnerHTML|child_process[^A-Za-z]|exec\(|os\.system|rm[[:space:]]+-rf)' "$f" 2>/dev/null | head -5)
  if [ -n "$hits" ]; then
    c_found=1
    say "  [i] $f:"
    echo "$hits" | sed 's/^/      /'
  fi
done
[ "$c_found" = "0" ] && ok "未发现可疑残留标记"

# ---------- 阶段 D: 验证命令检测（只检测不执行） ----------
say ""
say "== 阶段 D: 可用验证命令（由审查者决定是否运行） =="
d_found=0
if [ -f package.json ]; then
  scripts=$(python3 -c "
import json
d = json.load(open('package.json'))
scripts = d.get('scripts', {})
for k, v in scripts.items():
    if any(pat in (k + ' ' + v).lower() for pat in ['test', 'lint', 'typecheck', 'check', 'build']):
        print(f'{k}: {v}')
" 2>/dev/null)
  if [ -n "$scripts" ]; then
    d_found=1
    say "  package.json 可用脚本:"
    echo "$scripts" | sed 's/^/      /'
  fi
fi
if [ -f pytest.ini ] || [ -f pyproject.toml ] && grep -q pytest pyproject.toml 2>/dev/null || [ -d tests ] && ls tests/*.py >/dev/null 2>&1; then
  d_found=1
  say "  检测到 pytest 工程: pytest （运行: python3 -m pytest）"
fi
if [ "$d_found" = "0" ]; then
  say "  未检测到测试/检查脚本（无 package.json 脚本、pytest 或 Makefile）"
fi

# ---------- 汇总 ----------
say ""
say "== 汇总 =="
say "  通过: $PASS | 警告: $WARN | 失败: $FAIL | 跳过: $SKIP"
if [ "$FAIL" = "0" ]; then
  say "结论: 确定性检查全部通过。请继续按 SKILL.md 检查清单进行人工审查。"
else
  say "结论: 存在 $FAIL 项确定性失败，请优先处理后再进行人工审查。"
fi
exit 0
