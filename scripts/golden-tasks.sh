#!/usr/bin/env bash
# golden-tasks — 防退化基准（VISION P3 / ROADMAP 4.3，2026-08-26）
#
# 目的：自主进化（记忆治理/提示词调整/扩展改动）的最大风险是"退化"——错误教训
#       自我强化污染后续行为。本脚本提供改动前后的最小回归安全网。
#
# 两档：
#   --fast（默认）纯确定性、零 LLM 成本：
#     F1 task-metrics.mjs 可运行且 ok:true（遥测管线健康）
#     F2 lesson-miner.mjs / usage-stats.mjs 可运行（分析面健康）
#     F3 entries.json 完整性：合法 JSON、非空、无明文密钥（scrubSecrets 兜底验证）
#     F4 interventions.jsonl 结构完整（若存在）：每行含 id/ts/type
#   --full 追加无头 pi 会话（真实模型，少量确定性断言；产生 provider 费用）：
#     G1 纯文本响应断言（回复包含固定标记）
#     G2 工具执行断言（在 tmp 目录写文件并校验内容）
#
# 用法：
#   bash scripts/golden-tasks.sh            # fast 档
#   bash scripts/golden-tasks.sh --fast     # 同上
#   bash scripts/golden-tasks.sh --full     # fast + 无头会话两任务
#   PI_BIN=... 覆盖 pi 可执行路径（默认 command -v pi）
set -u
FAILED=0

cyn() { printf "\033[36m%s\033[0m\n" "$1"; }
grn() { printf "\033[32m✓ %s\033[0m\n" "$1"; }
red() { printf "\033[31m✗ %s\033[0m\n" "$1"; FAILED=$((FAILED+1)); }

SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPTS")"
MODE="fast"
[ "${1:-}" = "--full" ] && MODE="full"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---------- Fast 档 ----------
if TM_JSON="$TMP/tm.json" node "$SCRIPTS/task-metrics.mjs" --json > "$TMP/tm.json" 2>/dev/null && TM_JSON="$TMP/tm.json" python3 -c "
import json
import os as _os
d=json.load(open(_os.environ['TM_JSON']))
assert d.get('ok') is True, 'ok!=true'
" 2>/dev/null; then
  grn "F1 task-metrics 管线健康"
else
  red "F1 task-metrics 管线异常"
fi

if node "$SCRIPTS/lesson-miner.mjs" --limit 1 >/dev/null 2>&1; then
  grn "F2a lesson-miner 可运行"
else
  red "F2a lesson-miner 异常"
fi
if node "$ROOT/scripts/usage-stats.mjs" >/dev/null 2>&1 || node "$SCRIPTS/usage-stats.mjs" >/dev/null 2>&1; then
  grn "F2b usage-stats 可运行"
else
  red "F2b usage-stats 异常"
fi

python3 - << 'PYEOF' 2>/dev/null
import json, os, re, sys
root = os.environ.get('PI_HOME') or os.path.expanduser('~/.pi')
path = os.path.join(root, 'memory', 'entries.json')
data = json.load(open(path))
entries = data['entries'] if isinstance(data, dict) else data
assert len(entries) > 0, 'entries empty'
live = [e for e in entries if not e.get('deleted')]
blob = json.dumps(entries, ensure_ascii=False)
patterns = [
    r'gh[pousr]_[A-Za-z0-9]{20,}', r'github_pat_[A-Za-z0-9_]{20,}',
    r'sk-(proj-)?[A-Za-z0-9_-]{20,}', r'AKIA[A-Z0-9]{16}',
]
hits = [p for p in patterns if re.search(p, blob)]
assert not hits, f'plaintext secrets detected: {hits}'
print(f'F3 entries.json 完整: {len(live)} 条有效 / 无明文密钥')
PYEOF
if [ $? -eq 0 ]; then grn "F3 entries.json 完整性与脱敏"; else red "F3 entries.json 异常（损坏或含密钥）"; fi

python3 - << 'PYEOF' 2>/dev/null
import json, os, sys
root = os.environ.get('PI_HOME') or os.path.expanduser('~/.pi')
path = os.path.join(root, 'memory', 'interventions.jsonl')
if not os.path.exists(path):
    print('F4 interventions.jsonl 不存在（扩展尚未捕获数据，跳过）'); sys.exit(0)
n = 0
for line in open(path):
    line = line.strip()
    if not line: continue
    r = json.loads(line)
    assert r.get('id') and r.get('ts') and r.get('type'), f'bad record: {line[:80]}'
    n += 1
print(f'F4 interventions.jsonl 结构完整: {n} 条')
PYEOF
if [ $? -eq 0 ]; then grn "F4 干预快照结构"; else red "F4 干预快照结构异常"; fi

# ---------- Full 档 ----------
if [ "$MODE" = "full" ]; then
  PI_BIN="${PI_BIN:-$(command -v pi)}"
  if [ -z "$PI_BIN" ]; then
    red "G* 找不到 pi 可执行（PI_BIN 覆盖）"
  else
    cyn "== G1 纯文本响应断言 =="
    OUT_G1="$(timeout 180 "$PI_BIN" --print --no-session "Reply with exactly this token and nothing else: GOLDEN-OK-7391" 2>/dev/null || true)"
    if echo "$OUT_G1" | grep -q "GOLDEN-OK-7391"; then
      grn "G1 文本响应含标记"
    else
      red "G1 文本响应未含标记（前120字符: $(echo "$OUT_G1" | head -c 120)）"
    fi

    cyn "== G2 工具执行断言 =="
    GDIR="$TMP/golden-tool"
    mkdir -p "$GDIR"
    ( cd "$GDIR" && timeout 240 "$PI_BIN" --print --no-session \
        "用 write 工具创建文件 golden.txt，内容恰好为 GOLDEN-CONTENT-2468（无其他文字），然后停止。" >/dev/null 2>&1 )
    if [ -f "$GDIR/golden.txt" ] && grep -q "GOLDEN-CONTENT-2468" "$GDIR/golden.txt"; then
      grn "G2 工具写入文件正确"
    else
      red "G2 工具未按指令写入（golden.txt 缺失或内容不符）"
    fi
  fi
fi

echo ""
if [ "$FAILED" -eq 0 ]; then
  printf "\033[32m══ golden-tasks [%s] 全绿 ══\033[0m\n" "$MODE"
  exit 0
else
  printf "\033[31m══ golden-tasks [%s] 失败 %d 项 ══\033[0m\n" "$MODE" "$FAILED"
  exit 1
fi
