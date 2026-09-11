#!/usr/bin/env bash
# pi-bench.sh — 用量基准聚合报告（dsh BENCHMARK 借鉴，2026-08-14）
#
# 守护缓存友好优化不回退：本次缓存修复（72K→40 token）后，后续改动可能
# 悄悄破坏注入稳定性。本脚本基于 usage-diag.jsonl（每轮真实 token 记录）
# 输出可对比的基准报告。
#
# 用法：
#   pi-bench.sh usage [--since=ISO时间]   # 聚合 usage-diag 输出用量报告
#   pi-bench.sh timing                     # 关键操作计时（lib 加载/注入构建）
#   pi-bench.sh compare <基准报告文件>     # 对比当前与历史基准
#
# 输出为文本报告；compare 模式输出关键指标增减，退出码 1 表示退化。

set -uo pipefail
PI_HOME="${PI_HOME:-$HOME/.pi}"
DIAG="$PI_HOME/agent/.usage-diag.jsonl"

usage_report() {
  local since="${1:-}"
  python3 - "$DIAG" "$since" << 'PYEOF'
import json, sys, datetime, statistics

diag, since = sys.argv[1], sys.argv[2] or None
rows = []
for line in open(diag):
    try:
        d = json.loads(line)
        if 'cacheRead' in d and d.get('input') is not None:
            rows.append(d)
    except Exception:
        pass
if since:
    cutoff = datetime.datetime.fromisoformat(since).timestamp() * 1000
    rows = [r for r in rows if r['ts'] >= cutoff]
if not rows:
    print('（无记录）')
    sys.exit(0)

def rate(r):
    i = r.get('input', 0) or 0; c = r.get('cacheRead', 0) or 0
    return (c / (i + c) * 100) if i + c else 100.0

inputs = [r.get('input', 0) or 0 for r in rows]
caches = [r.get('cacheRead', 0) or 0 for r in rows]
ctxs = [r.get('contextTokens', 0) or 0 for r in rows]
rates = [rate(r) for r in rows]
low = [r for r in rows if rate(r) < 90]

t0 = datetime.datetime.fromtimestamp(rows[0]['ts']/1000).strftime('%m-%d %H:%M')
t1 = datetime.datetime.fromtimestamp(rows[-1]['ts']/1000).strftime('%m-%d %H:%M')
p = lambda xs, q: sorted(xs)[int(len(xs)*q)] if xs else 0

print(f'== 用量基准报告 ==')
print(f'范围: {t0} → {t1} | 记录 {len(rows)} 轮')
print(f'缓存命中率: 均值 {statistics.mean(rates):.1f}% | 中位 {statistics.median(rates):.1f}% | 低命中(<90%) {len(low)} 轮 ({len(low)/len(rows)*100:.0f}%)')
print(f'input/轮: 均值 {statistics.mean(inputs):.0f} | P50 {p(inputs,0.5)} | P90 {p(inputs,0.9)} | 最大 {max(inputs)} | >5K {sum(1 for x in inputs if x>5000)} 轮')
print(f'cacheRead/轮: 均值 {statistics.mean(caches):.0f}')
print(f'上下文: 起点 {ctxs[0]} → 终点 {ctxs[-1]} | 峰值 {max(ctxs)}')
print(f'compacted: {sum(1 for r in rows if r.get("compacted"))} 次')
if len(low) >= 3:
    # 低命中段的断裂点位置（cacheRead 分布）——辅助定位
    low_caches = sorted(r.get('cacheRead', 0) or 0 for r in low)
    print(f'低命中轮 cacheRead 中位 ≈ {statistics.median(low_caches)}（断裂点位置线索，≈system prompt 尾部 = 拼入式注入）')
print(f'-- 基准参考（2026-08-14 修复后稳态）: 命中率 >97% | input P50 <500 | 低命中占比 <5%')
PYEOF
}

timing_report() {
  echo "== 关键操作计时 =="
  # 1. lib 加载 + 注入块构建（pi-memory 空库）
  local t0=$(date +%s%N)
  node --experimental-strip-types -e "
    import('$PI_HOME/agent/extensions/pi-memory/inject.ts').then(async (m) => {
      const r = m.buildInjectionBlock([], [], 500, 'linux')
      return r.block.length
    }).catch(() => 0)
  " > /dev/null 2>&1
  local t1=$(date +%s%N)
  echo "注入块构建(空库): $(( (t1-t0)/1000000 )) ms"

  # 2. estimateTokens 调用
  t0=$(date +%s%N)
  node --experimental-strip-types -e "
    import('$PI_HOME/agent/lib/context-budget.ts').then((m) => { m.estimateTokens('x'.repeat(2000)); })
  " > /dev/null 2>&1
  t1=$(date +%s%N)
  echo "estimateTokens(2K字符): $(( (t1-t0)/1000000 )) ms"

  # 3. pi-context 套件启动（vitest 冷启动，代理测试基础设施开销）
  t0=$(date +%s%N)
  (cd "$PI_HOME/agent/extensions/pi-context" && ./node_modules/.bin/vitest run tests/registry.test.ts > /dev/null 2>&1)
  t1=$(date +%s%N)
  echo "vitest 单文件套件: $(( (t1-t0)/1000000 )) ms"
}

compare_report() {
  local ref="$1"
  local cur
  cur=$(mktemp)
  usage_report > "$cur"
  # 提取关键指标
  local ref_rate cur_rate ref_p50 cur_p50 ref_low cur_low
  ref_rate=$(grep -oP '命中率: 均值 \K[0-9.]+' "$ref" | head -1)
  cur_rate=$(grep -oP '命中率: 均值 \K[0-9.]+' "$cur" | head -1)
  ref_p50=$(grep -oP 'P50 \K[0-9.]+' "$ref" | head -1)
  cur_p50=$(grep -oP 'P50 \K[0-9.]+' "$cur" | head -1)
  ref_low=$(grep -oP '低命中\(<90%\) \K[0-9]+' "$ref" | head -1)
  cur_low=$(grep -oP '低命中\(<90%\) \K[0-9]+' "$cur" | head -1)
  echo "== 与基准对比（$ref）=="
  echo "命中率: $ref_rate% → $cur_rate%"
  echo "input P50: $ref_p50 → $cur_p50"
  echo "低命中轮: $ref_low → $cur_low"
  # 判定退化
  local degraded=0
  python3 - "$ref_rate" "$cur_rate" "$ref_low" "$cur_low" << 'PYEOF'
import sys
try:
    a, b, c, d = (float(x) if x else 0 for x in sys.argv[1:5])
except Exception:
    sys.exit(0)
if b < a - 1.0 or d > c + 2:
    print('⚠ 检测到退化（命中率↓ 或 低命中轮↑）——检查最近改动')
    sys.exit(1)
print('✓ 无退化（命中率/低命中轮在容差内）')
PYEOF
  # 审计 MEDIUM 修复：此前退出码被丢弃（函数以 rm -f 的退出码返回），
  # 头注释承诺的"退出码 1 表示退化"不生效，自动化判定会漏报
  degraded=$?
  rm -f "$cur"
  return $degraded
}

case "${1:-}" in
  usage) since="${2:-}"; since="${since#--since=}"; usage_report "$since" ;;
  timing) timing_report ;;
  compare) [ -n "${2:-}" ] || { echo "用法: pi-bench.sh compare <基准报告文件>"; exit 2; }; compare_report "$2" ;;
  -h|--help) sed -n '1,16p' "$0"; exit 0 ;;
  *) echo "未知子命令: ${1:-}（usage / timing / compare）"; exit 2 ;;
esac
